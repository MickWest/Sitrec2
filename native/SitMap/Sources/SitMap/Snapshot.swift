import AppKit
import MapKit
import SitMapCore
import CoreImage

final class SnapshotService {
    private var active: MKMapSnapshotter?
    private let imageContext = CIContext()
    func capture(canvas: MapCanvas, width: Int, height: Int, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard active == nil else { completion(.failure(SitMapError("A snapshot is already rendering."))); return }
        guard (64...4096).contains(width), (64...4096).contains(height), width * height <= 8_388_608 else {
            completion(.failure(SitMapError("Snapshot dimensions must be 64–4096 pixels, at most 8 megapixels."))); return
        }
        let camera = canvas.map.camera.copy() as! MKMapCamera
        let desiredFov = canvas.desiredFov, roll = canvas.desiredRoll
        let desiredPitch = canvas.displayedPitch
        var state = canvas.state()
        let options = MKMapSnapshotter.Options()
        options.camera = camera
        options.preferredConfiguration = canvas.map.preferredConfiguration.copy() as! MKMapConfiguration
        // Bound source points even for telephoto requests. MapKit adds the
        // display backing scale (normally 2x on Retina) when rendering pixels.
        let supersample = min(2.0, 4096.0 / Double(max(width, height)), sqrt(8_388_608.0 / Double(width * height)))
        let sourceAspect = canvas.map.bounds.width / max(1, canvas.map.bounds.height)
        let maximumHeight = min(4096 / max(1, sourceAspect), sqrt(8_388_608 / sourceAspect))
        // A small output still needs the render height that admitted this pitch
        // in the live map. Downsample afterwards instead of reintroducing its clamp.
        let minimumHeight = min(canvas.map.bounds.height, maximumHeight)
        let sourceHeight = min(maximumHeight, max(Double(height) * supersample, minimumHeight))
        options.size = NSSize(width: sourceHeight * sourceAspect, height: sourceHeight)
        var finished = false
        let finish: (Result<[String: Any], Error>) -> Void = { [weak self] result in
            guard !finished else { return }; finished = true; self?.active = nil; completion(result)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 40) { [weak self] in
            if !finished { self?.active?.cancel(); finish(.failure(SitMapError("MapKit snapshot timed out waiting for imagery."))) }
        }
        func render(_ retriesRemaining: Int) {
            guard !finished else { return }
            let snapshotter = MKMapSnapshotter(options: options); active = snapshotter
            snapshotter.start(with: .main) { snapshot, error in
                guard !finished else { return }
                if let error { finish(.failure(error)); return }
                guard let snapshot, let source = snapshot.image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                    finish(.failure(SitMapError("MapKit did not return an image."))); return
                }
                let center = Coordinate(camera.centerCoordinate)
                let centerPoint = snapshot.point(for: center.cl)
                let centerError = hypot(centerPoint.x - snapshot.image.size.width/2,
                                        centerPoint.y - snapshot.image.size.height/2)
                // Snapshotter has the same maximum-zoom constraint as a live map.
                // A big output request can silently change its target. Retry at a
                // smaller source size, then report any upsampling in the metadata.
                guard centerError.isFinite else { finish(.failure(SitMapError("Snapshot projection is unavailable."))); return }
                if centerError > 0.75 {
                    if retriesRemaining > 0 && options.size.height > minimumHeight + 1 {
                        let height = max(minimumHeight, options.size.height/2)
                        options.size = NSSize(width: height * sourceAspect, height: height)
                        render(retriesRemaining - 1)
                    } else {
                        finish(.failure(SitMapError("MapKit moved the snapshot camera at its zoom limit; an aligned snapshot is unavailable.")))
                    }
                    return
                }
                let baseline = max(1, min(100, camera.centerCoordinateDistance * 0.01))
                let left = center.destination(meters: baseline, heading: camera.heading-90)
                let right = center.destination(meters: baseline, heading: camera.heading+90)
                let a = snapshot.point(for: left.cl), b = snapshot.point(for: right.cl)
                let baselineMeters = MKMapPoint(left.cl).distance(to: MKMapPoint(right.cl))
                let focal = hypot(a.x-b.x, a.y-b.y) * camera.centerCoordinateDistance / baselineMeters
                let fov = 2 * atan(snapshot.image.size.height / (2*focal)) * 180 / .pi
                guard fov.isFinite, (5...100).contains(fov) else {
                    finish(.failure(SitMapError("Could not calibrate snapshot FOV."))); return
                }
                let aspect = Double(width)/Double(height)
                let crop = Framing(nativeFov: fov, requestedFov: desiredFov ?? fov, roll: roll, aspect: aspect)
                let framing = PerspectiveFraming(nativeFov: fov, requestedFov: desiredFov ?? fov,
                    nativePitch: Double(camera.pitch), requestedPitch: desiredPitch, roll: roll, aspect: aspect,
                    sourceAspect: sourceAspect)
                guard framing.sourceProjectable else {
                    finish(.failure(SitMapError("The requested orientation is beyond MapKit's captured image."))); return
                }
                func corner(_ x: Double, _ y: Double) -> CIVector {
                    let point = framing.project(x: x, y: y)!
                    return CIVector(x: Double(width)/2 + point.x * Double(height)/2,
                                    y: Double(height)/2 + point.y * Double(height)/2)
                }
                let warped = CIImage(cgImage: source).applyingFilter("CIPerspectiveTransform", parameters: [
                    "inputTopLeft": corner(-sourceAspect, 1), "inputTopRight": corner(sourceAspect, 1),
                    "inputBottomLeft": corner(-sourceAspect, -1), "inputBottomRight": corner(sourceAspect, -1)])
                guard warped.extent.intersects(CGRect(x: 0, y: 0, width: width, height: height)) else {
                    finish(.failure(SitMapError("MapKit's accepted pitch captures no part of this requested frame. Lower the viewing angle or camera altitude."))); return
                }
                guard let projectedImage = self.imageContext.createCGImage(warped, from: CGRect(x: 0, y: 0, width: width, height: height)) else {
                    finish(.failure(SitMapError("Could not reproject the snapshot."))); return
                }
                guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
                      let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else {
                    finish(.failure(SitMapError("Could not allocate output image."))); return
                }
                NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = graphics
                let context = graphics.cgContext
                context.setFillColor(NSColor.black.cgColor); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
                context.interpolationQuality = .high
                context.draw(projectedImage, in: CGRect(x: 0, y: 0, width: width, height: height))
                // A crop can remove MapKit's built-in attribution; keep attribution in
                // the returned image and provide the legal link alongside it.
                let label = (state["fidelity"] as? [String: Any])?["angleLimited"] as? Bool == true
                    ? "Apple Maps · viewing angle limited" as NSString : "Apple Maps" as NSString
                label.draw(at: NSPoint(x: 12, y: 10), withAttributes: [.font: NSFont.systemFont(ofSize: 12, weight: .medium),
                    .foregroundColor: NSColor.white, .backgroundColor: NSColor.black.withAlphaComponent(0.65)])
                NSGraphicsContext.restoreGraphicsState()
                guard let png = bitmap.representation(using: .png, properties: [:]) else {
                    finish(.failure(SitMapError("Could not encode PNG."))); return
                }
                state["imageData"] = png.base64EncodedString(); state["mimeType"] = "image/png"
                state["width"] = width; state["height"] = height
                state["snapshot"] = ["nativeVerticalFov": fov, "verticalFov": desiredFov ?? fov,
                                     "displayedPitch": desiredPitch,
                                     "fullyCovered": framing.fullyCovered,
                                     "centerErrorPoints": centerError, "resolutionReduced": retriesRemaining < 3,
                                     "sourceWidthPixels": source.width, "sourceHeightPixels": source.height,
                                     "pitchCompensationDegrees": desiredPitch - Double(camera.pitch),
                                     "sourcePixelsPerOutputPixel": Double(source.height)/Double(height)/crop.scale,
                                     "renderer": "MKMapSnapshotter", "note": "MapKit snapshots may differ from the live 3D view."]
                finish(.success(state))
            }
        }
        render(3)
    }
}
