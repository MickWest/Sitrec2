import AppKit
import MapKit
import QuartzCore
import SitMapCore
import simd

extension Coordinate {
    var cl: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }
    init(_ coordinate: CLLocationCoordinate2D) { self.init(coordinate.latitude, coordinate.longitude) }
}

/// Own the mouse gestures; leave MapKit responsible for its native Metal renderer.
final class MapCanvas: NSView, MKMapViewDelegate {
    let map = MKMapView(frame: .zero)
    private let host = NSView(frame: .zero)
    private let clip = NSView(frame: .zero)
    private let limitationNotice = NSTextField(wrappingLabelWithString: "")
    private var desiredAspect: Double?
    var viewport: NSRect {
        guard let aspect = desiredAspect else { return bounds }
        var size = bounds.size
        if size.width / max(1, size.height) > aspect { size.width = size.height * aspect }
        else { size.height = size.width / aspect }
        return NSRect(x: (bounds.width-size.width)/2, y: (bounds.height-size.height)/2, width: size.width, height: size.height)
    }
    var changed: (() -> Void)?
    var request: ViewRequest?
    var nativeFov: Double?
    var sourceScale: CGFloat = 1
    private var sourceAspect: Double?
    private var renderAspect: Double { sourceAspect ?? viewport.width / max(1, viewport.height) }
    var cropScale: Double = 1
    var desiredRoll: Double = 0
    var desiredFov: Double?
    var desiredPitch: Double?
    private var framing: PerspectiveFraming?
    private var projectionSelection: ProjectionSelection?
    var displayedPitch: Double { projectionSelection?.displayedPitch ?? desiredPitch ?? Double(map.camera.pitch) }
    var warnings: [String] = []
    var renderComplete = false
    var style = "imagery"
    private var gesture: NavigationGesture?
    private var gestureOrigin: Coordinate?
    private var gestureViewport = NSRect.zero
    private var navigationDetails: [String: Any] = [:]
    private var refreshing = false
    private var applying = false
    private var lastSize: NSSize = .zero
    private var fitAttempts = 0
    private var surfaceResizeCount = 0
    private var applyMilliseconds = 0.0

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor(calibratedWhite: 0.07, alpha: 1).cgColor
        layer?.masksToBounds = true
        host.wantsLayer = true
        clip.wantsLayer = true; clip.layer?.masksToBounds = true
        addSubview(clip); clip.addSubview(host); host.addSubview(map)
        limitationNotice.isHidden = true; limitationNotice.drawsBackground = true
        limitationNotice.backgroundColor = NSColor.black.withAlphaComponent(0.8)
        limitationNotice.textColor = .white; limitationNotice.alignment = .center
        limitationNotice.font = .systemFont(ofSize: 12, weight: .medium)
        addSubview(limitationNotice)
        map.delegate = self
        map.showsBuildings = true
        map.isPitchEnabled = true
        map.isRotateEnabled = true
        map.isZoomEnabled = true
        map.showsCompass = false
        map.showsScale = false
        map.showsZoomControls = false
        map.showsPitchControl = false
        setStyle("imagery")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
    override var acceptsFirstResponder: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { bounds.contains(convert(point, from: superview)) ? self : nil }
    override func layout() {
        super.layout()
        guard bounds.size != lastSize, bounds.width > 0, bounds.height > 0 else { return }
        lastSize = bounds.size
        let camera = map.camera.copy() as! MKMapCamera
        layoutRenderSurface()
        if !applying {
            // Window resizing can change the pitch limit with no new Sitrec pose.
            if let request { try? apply(request) }
            else { map.setCamera(camera, animated: false) }
        }
        updateFraming()
    }

    /// Apply source geometry synchronously, including when called from layout().
    /// A nested layoutSubtreeIfNeeded() does not lay this view out again. Using
    /// it while fitting a camera measured the old surface, then left the new
    /// scale paired with stale bounds after a sidebar/window resize.
    private func layoutRenderSurface() {
        let height = viewport.height * sourceScale, width = height * renderAspect
        let size = NSSize(width: width, height: height)
        guard clip.frame != viewport || host.bounds.size != size || map.bounds.size != size else { return }
        surfaceResizeCount += 1
        CATransaction.begin(); CATransaction.setDisableActions(true)
        host.layer?.transform = CATransform3DIdentity
        clip.frame = viewport
        host.frame = NSRect(x: (viewport.width - width)/2, y: (viewport.height - height)/2, width: width, height: height)
        host.bounds = NSRect(x: 0, y: 0, width: width, height: height)
        host.layer?.anchorPoint = CGPoint(x: 0.5, y: 0.5)
        host.layer?.position = CGPoint(x: viewport.width/2, y: viewport.height/2)
        map.frame = host.bounds
        let noticeWidth = min(560, max(1, viewport.width - 32))
        limitationNotice.frame = NSRect(x: viewport.midX-noticeWidth/2, y: viewport.maxY-64, width: noticeWidth, height: 48)
        CATransaction.commit()
    }
    func setStyle(_ value: String) {
        style = value
        switch value {
        case "standard":
            let config = MKStandardMapConfiguration(elevationStyle: .realistic, emphasisStyle: .muted)
            config.pointOfInterestFilter = .excludingAll
            map.preferredConfiguration = config
        case "hybrid":
            let config = MKHybridMapConfiguration(elevationStyle: .realistic)
            config.pointOfInterestFilter = .excludingAll
            map.preferredConfiguration = config
        default: map.preferredConfiguration = MKImageryMapConfiguration(elevationStyle: .realistic)
        }
    }

    func apply(_ value: ViewRequest) throws {
        try value.validate()
        let start = CFAbsoluteTimeGetCurrent()
        applying = true
        defer {
            applying = false; updateFraming()
            applyMilliseconds = (CFAbsoluteTimeGetCurrent()-start)*1000
            changed?()
        }
        // MapKit needs a ground target. An above-horizon ray has none; report the
        // approximation instead of sending infinity through the camera initializer.
        let pitch = min(85, max(0, 90 + value.elevation))
        request = value; desiredFov = value.verticalFov; desiredRoll = value.roll ?? 0
        desiredPitch = 90 + value.elevation
        if desiredAspect != value.aspect {
            desiredAspect = value.aspect
        }
        warnings = []
        if value.groundTarget != nil {
            warnings.append("Target elevation and range come from Sitrec's visible surface. Apple's surface may differ.")
        } else {
            if value.groundAltitudeMSL == nil { warnings.append("Ground altitude was not supplied; sea level is assumed.") }
            warnings.append("No look-target elevation supplied; eye position uses a local ground-plane estimate.")
        }
        if pitch != 90 + value.elevation { warnings.append("Requested elevation is outside the native ground-facing camera range.") }
        if let style = value.style, style != self.style { setStyle(style) }
        renderComplete = false
        let measure: (Double) -> RenderScaleFitting.Measurement = { scale in
            self.sourceScale = scale
            self.layoutRenderSurface()
            self.applyCamera(value, pitch: pitch)
            let c = self.map.camera, accepted = Double(c.pitch)
            return RenderScaleFitting.Measurement(pitchError: accepted - pitch,
                centerError: MKMapPoint(value.target(pitch: accepted).cl).distance(to: MKMapPoint(c.centerCoordinate)),
                rangeError: c.centerCoordinateDistance - value.centerDistance(pitch: accepted))
        }
        if let scale = value.renderScale {
            sourceAspect = nil
            _ = measure(scale); fitAttempts = 1
        } else {
            let outputAspect = viewport.width / max(1, viewport.height)
            // Retain the working shape, but widen it when the requested lens or
            // roll needs more horizontal coverage. Source and output aspect are
            // independent: the homography uses each surface's actual dimensions.
            func requiredAspect() -> Double {
                let projection = PerspectiveFraming(nativeFov: measureFov() ?? nativeFov ?? 30,
                    requestedFov: value.verticalFov ?? 30, nativePitch: Double(map.camera.pitch),
                    requestedPitch: desiredPitch!, roll: desiredRoll, aspect: outputAspect)
                return RenderScaleFitting.sourceAspect(required: projection.minimumSourceAspect * 1.02, output: outputAspect)
            }
            if let current = sourceAspect { sourceAspect = min(outputAspect, max(current, requiredAspect())) }
            func fitSurface() -> RenderScaleFitting.Result {
                RenderScaleFitting.fit(width: viewport.height * renderAspect, height: viewport.height,
                    initialScale: sourceScale, measure: measure)
            }
            var fit = fitSurface()
            fitAttempts = fit.attempts
            // A wide source wastes the surface budget on pixels outside a
            // telephoto crop. Reallocate them to height before accepting a
            // lower native pitch; this avoids the 60° -> 35° zoom-out cutoff.
            for _ in 0..<2 {
                let candidate = requiredAspect()
                guard fit.measurement.pitchError > 0.05,
                      RenderScaleFitting.shouldCompactAspect(current: renderAspect, candidate: candidate) else { break }
                let oldAspect = sourceAspect, oldScale = sourceScale, oldFit = fit
                sourceAspect = candidate
                fit = fitSurface(); fitAttempts += fit.attempts
                if !fit.measurement.positionFits || fit.measurement.pitchError > oldFit.measurement.pitchError + 0.05 {
                    sourceAspect = oldAspect; _ = measure(oldScale); fitAttempts += 1
                    break
                }
            }
        }
    }

    private func applyCamera(_ value: ViewRequest, pitch: Double) {
        let camera = MKMapCamera(lookingAtCenter: value.target(pitch: pitch).cl,
            fromDistance: value.centerDistance(pitch: pitch), pitch: pitch, heading: wrapDegrees(value.heading))
        map.setCamera(camera, animated: false)
        // Clamping the tilt alone moves the eye away from the requested site.
        // Rebuild the target/distance at the accepted pitch to retain the same
        // estimated eye. Keep the original request for fidelity reporting.
        var requestedPitch = pitch
        for _ in 0..<3 {
            let acceptedPitch = Double(map.camera.pitch)
            guard acceptedPitch < requestedPitch - 0.05 else { break }
            requestedPitch = acceptedPitch
            let corrected = MKMapCamera(lookingAtCenter: value.target(pitch: acceptedPitch).cl,
                fromDistance: value.centerDistance(pitch: acceptedPitch),
                pitch: acceptedPitch, heading: wrapDegrees(value.heading))
            map.setCamera(corrected, animated: false)
        }
    }

    /// Measure focal length from two nearby ground projections at equal depth.
    /// This is a local calibration, not an undocumented constant (often ~30°).
    func measureFov() -> Double? {
        let camera = map.camera, size = map.bounds.size
        guard size.height > 1, size.width > 1, camera.centerCoordinateDistance > 1,
              camera.centerCoordinateDistance < 1_000_000 else { return nil }
        let center = map.convert(camera.centerCoordinate, toPointTo: map)
        guard center.x.isFinite, center.y.isFinite,
              abs(center.y - size.height / 2) < 2 else { return nil }
        // Use forward projection, as Snapshotter does. Inverse screen-to-ground
        // conversion is not a stable lens measurement over realistic terrain:
        // a close hillside after a pitch change produced a spurious 5.5° lens.
        let origin = Coordinate(camera.centerCoordinate)
        let baseline = max(1, min(100, camera.centerCoordinateDistance * 0.01))
        let left = origin.destination(meters: baseline, heading: camera.heading-90)
        let right = origin.destination(meters: baseline, heading: camera.heading+90)
        let a = map.convert(left.cl, toPointTo: map), b = map.convert(right.cl, toPointTo: map)
        let baselineMeters = MKMapPoint(left.cl).distance(to: MKMapPoint(right.cl))
        let focal = hypot(a.x-b.x, a.y-b.y) * camera.centerCoordinateDistance / baselineMeters
        let result = 2 * atan(size.height / (2 * focal)) * 180 / .pi
        return result.isFinite && (5...100).contains(result) ? result : nil
    }

    func updateFraming() {
        guard !refreshing, !applying else { return }
        refreshing = true
        defer { refreshing = false }
        nativeFov = measureFov()
        cropScale = 1
        if let fov = nativeFov, let requested = desiredFov {
            cropScale = Framing(nativeFov: fov, requestedFov: requested, roll: desiredRoll,
                                aspect: max(0.1, viewport.width / max(1, viewport.height))).scale
        }
        projectionSelection = nativeFov.map { ProjectionSelection(nativeFov: $0, requestedFov: desiredFov ?? $0,
            nativePitch: Double(map.camera.pitch), requestedPitch: desiredPitch ?? Double(map.camera.pitch),
            roll: desiredRoll, aspect: max(0.1, viewport.width / max(1, viewport.height)),
            sourceAspect: map.bounds.width / max(1, map.bounds.height)) }
        framing = projectionSelection?.displayed
        limitationNotice.isHidden = projectionSelection?.limited != true
        if projectionSelection?.limited == true {
            limitationNotice.stringValue = String(format: "MapKit angle limit — showing the closest supported view\nRequested elevation %.1f° · displayed %.1f°", (desiredPitch ?? 0)-90, displayedPitch-90)
        }
        // Scale the chosen render surface back to the requested viewport.
        CATransaction.begin(); CATransaction.setDisableActions(true)
        var transform = CATransform3DIdentity
        if let framing {
            let ratio = viewport.height / max(1, map.bounds.height)
            let half = viewport.height / 2, sourceHalf = max(1, map.bounds.height / 2)
            transform.m11 = ratio * framing.a; transform.m21 = ratio * framing.b; transform.m41 = half * framing.c
            transform.m12 = ratio * framing.d; transform.m22 = ratio * framing.e; transform.m42 = half * framing.f
            transform.m14 = framing.g / sourceHalf; transform.m24 = framing.h / sourceHalf; transform.m44 = framing.i
        } else {
            transform = CATransform3DMakeScale(1/sourceScale, 1/sourceScale, 1)
        }
        host.isHidden = framing?.sourceProjectable == false
        host.layer?.transform = transform
        CATransaction.commit()
    }

    /// Read-only screen/coordinate samples for camera alignment diagnostics.
    /// Input/output x/y are normalized to the displayed viewport, from top left.
    func projectionSamples(_ points: [CGPoint]) throws -> [[String: Any]] {
        guard points.count <= 256, let framing else { throw SitMapError("Projection unavailable, or more than 256 points supplied.") }
        return try points.map { point in
            guard point.x.isFinite, point.y.isFinite, (0...1).contains(point.x), (0...1).contains(point.y),
                  let source = framing.source(x: (point.x*2-1)*viewport.width/max(1, viewport.height), y: 1-point.y*2) else {
                throw SitMapError("Projection points must be finite viewport coordinates between 0 and 1.")
            }
            let sourcePoint = CGPoint(x: map.bounds.midX + source.x*map.bounds.height/2,
                y: map.bounds.midY + source.y*map.bounds.height/2*(map.isFlipped ? -1 : 1))
            let coordinate = map.convert(sourcePoint, toCoordinateFrom: map)
            guard CLLocationCoordinate2DIsValid(coordinate) else { throw SitMapError("The projection ray does not reach the map.") }
            let back = map.convert(coordinate, toPointTo: map)
            let output = framing.project(x: (back.x-map.bounds.midX)/(map.bounds.height/2),
                y: (back.y-map.bounds.midY)/(map.bounds.height/2)*(map.isFlipped ? -1 : 1))
            return ["x":point.x,"y":point.y,"latitude":coordinate.latitude,"longitude":coordinate.longitude,
                "roundTripX":output.map { 0.5+$0.x*viewport.height/(2*viewport.width) } as Any? ?? NSNull(),
                "roundTripY":output.map { 0.5-$0.y/2 } as Any? ?? NSNull()]
        }
    }

    func state() -> [String: Any] {
        let c = map.camera
        var notes = warnings
        var projection: [String: Any] = [:]
        if let request {
            let pitch = min(85, max(0, 90 + request.elevation))
            let expected = request.target(pitch: pitch)
            let point = map.convert(expected.cl, toPointTo: map)
            let centerError = MKMapPoint(expected.cl).distance(to: MKMapPoint(c.centerCoordinate))
            let rangeError = c.centerCoordinateDistance - request.centerDistance(pitch: pitch)
            let sourceCenter = request.target(pitch: Double(c.pitch))
            let sourceCenterError = MKMapPoint(sourceCenter.cl).distance(to: MKMapPoint(c.centerCoordinate))
            let sourceRangeError = c.centerCoordinateDistance - request.centerDistance(pitch: Double(c.pitch))
            projection = ["requestedTargetX": point.x.isFinite ? point.x / max(1, map.bounds.width) as Any : NSNull(),
                          "requestedTargetY": point.y.isFinite ? point.y / max(1, map.bounds.height) as Any : NSNull(),
                          "centerErrorMeters": centerError, "rangeErrorMeters": rangeError,
                          "sourceCenterErrorMeters": sourceCenterError, "sourceRangeErrorMeters": sourceRangeError,
                          "sourceWidth": map.bounds.width, "sourceHeight": map.bounds.height,
                          "sourceAspect": renderAspect,
                          "expectedSourceWidth": viewport.height * sourceScale * renderAspect,
                          "expectedSourceHeight": viewport.height * sourceScale,
                          "mapCoordinatesFlipped": map.isFlipped, "renderScale": sourceScale,
                          "renderScaleMode": request.renderScale == nil ? "adaptive" : "fixed",
                          "fitAttempts": fitAttempts]
            projection["surfaceResizeCount"] = surfaceResizeCount
            projection["applyMilliseconds"] = applyMilliseconds
            if let framing, point.x.isFinite, point.y.isFinite,
               let output = framing.project(x: (point.x-map.bounds.midX) / max(1, map.bounds.height/2),
                    y: (point.y-map.bounds.midY) / max(1, map.bounds.height/2) * (map.isFlipped ? -1 : 1)) {
                projection["requestedTargetOutputX"] = 0.5 + output.x * viewport.height / max(1, 2*viewport.width)
                projection["requestedTargetOutputY"] = 0.5 - output.y/2
            }
            if abs(sourceRangeError) > 1 || sourceCenterError > 1 {
                notes.append(String(format: "MapKit displaced the source camera: target error %.1f m, range error %.1f m.", sourceCenterError, sourceRangeError))
            }
        }
        let pitchError = Double(c.pitch) - (desiredPitch ?? Double(c.pitch))
        if abs(pitchError) > 0.05 { notes.append("MapKit clamped the native pitch; the image is reprojected to the requested direction within source coverage.") }
        if abs(pitchError) > 0.05 && request?.sourceGroundTarget == nil {
            notes.append("Source terrain is estimated until Sitrec supplies the clamped-angle surface hit.")
        }
        if desiredFov != nil && nativeFov == nil { notes.append("FOV calibration unavailable; native framing is shown.") }
        let full = projectionSelection?.requested.fullyCovered ?? false
        if projectionSelection?.limited == true {
            notes.append("MapKit cannot capture this viewing angle. The closest covered angle is displayed; it does not match Sitrec's orientation.")
        } else if !full && nativeFov != nil { notes.append("The requested frame extends beyond MapKit's image; uncovered pixels remain dark.") }
        if cropScale > sourceScale { notes.append("Requested magnification exceeds source resolution; output is upsampled.") }
        let requested: Any = request.flatMap { try? JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) } ?? NSNull()
        return ["app": "SitMap", "apiVersion": 1, "requested": requested,
                "applied": ["centerLatitude": c.centerCoordinate.latitude, "centerLongitude": c.centerCoordinate.longitude,
                            "centerCoordinateDistance": c.centerCoordinateDistance, "pitch": Double(c.pitch),
                            "mapPlaneAltitude": c.altitude,
                            "displayedPitch": displayedPitch,
                            "heading": c.heading, "roll": desiredRoll, "nativeVerticalFov": nativeFov as Any? ?? NSNull(),
                            "verticalFov": nativeFov.map { desiredFov ?? $0 } as Any? ?? NSNull(), "style": style],
                "fidelity": ["exact": false, "fovMethod": "calibrated projection", "fullyCovered": full,
                             "angleLimited": projectionSelection?.limited ?? false,
                             "requestedCoverageFraction": projectionSelection?.requested.coverageFraction ?? 0,
                             "displayedCoverageFraction": framing?.coverageFraction ?? 0,
                             "pitchCompensationDegrees": (desiredPitch ?? Double(c.pitch)) - Double(c.pitch),
                             "projectionMethod": "camera rotation homography",
                             "groundReference": request?.groundTarget == nil ? "eye-ground-plane" : "sitrec-look-target",
                             "pitchErrorDegrees": pitchError, "sourcePixelsPerOutputPixel": Double(sourceScale) / cropScale,
                             "warnings": notes],
                "renderComplete": renderComplete,
                "navigation": navigationDetails,
                "projection": projection,
                "viewport": ["width": Int(viewport.width), "height": Int(viewport.height),
                             "backingScale": window?.backingScaleFactor ?? 1],
                "attribution": "Apple Maps", "legalURL": "https://www.apple.com/legal/internet-services/maps/"]
    }

    func mapViewDidChangeVisibleRegion(_ mapView: MKMapView) {
        guard !applying else { return }
        updateFraming(); changed?()
    }
    func mapViewWillStartRenderingMap(_ mapView: MKMapView) { renderComplete = false }
    func mapViewDidFinishRenderingMap(_ mapView: MKMapView, fullyRendered: Bool) {
        renderComplete = fullyRendered; updateFraming(); changed?()
    }
    func mapViewDidFailLoadingMap(_ mapView: MKMapView, withError error: Error) {
        warnings.append("Map loading failed: \(error.localizedDescription)"); changed?()
    }

    private func sourcePoint(_ point: NSPoint) -> NSPoint? {
        if let framing {
            let half = max(1, viewport.height/2)
            guard let source = framing.source(x: (point.x-bounds.midX)/half, y: (point.y-bounds.midY)/half),
                  abs(source.x) <= map.bounds.width / max(1, map.bounds.height), abs(source.y) <= 1 else { return nil }
            return NSPoint(x: map.bounds.midX + source.x * map.bounds.height/2,
                           y: map.bounds.midY + source.y * map.bounds.height/2 * (map.isFlipped ? -1 : 1))
        }
        let x = point.x - bounds.midX, y = point.y - bounds.midY
        let angle = -desiredRoll * .pi / 180, scale = sourceScale / cropScale
        // The canvas uses AppKit's upward Y axis, while MKMapView's projection
        // uses a flipped view. Undo image rotation first, then change Y basis.
        let mapY = (x*sin(angle)+y*cos(angle))*scale * (map.isFlipped ? -1 : 1)
        return NSPoint(x: map.bounds.midX + (x*cos(angle)-y*sin(angle))*scale,
                       y: map.bounds.midY + mapY)
    }
    private func gesturePoint(_ point: NSPoint) -> SIMD2<Double> {
        let half = max(1, gestureViewport.height/2)
        return SIMD2((point.x-gestureViewport.midX)/half, (point.y-gestureViewport.midY)/half)
    }
    @discardableResult
    func beginNavigation(mode: NavigationGesture.Mode, at point: NSPoint) -> Bool {
        endNavigation()
        let c = map.camera
        guard viewport.contains(point), sourcePoint(point) != nil,
              (1...2_000_000).contains(c.centerCoordinateDistance) else { return false }
        gestureViewport = viewport
        let pose = NavigationPose(distance: c.centerCoordinateDistance, nativePitch: Double(c.pitch),
            heading: c.heading, pitch: displayedPitch, roll: desiredRoll)
        gesture = NavigationGesture(mode: mode, pose: pose, screen: gesturePoint(point), fov: desiredFov ?? nativeFov ?? 30)
        gestureOrigin = Coordinate(c.centerCoordinate)
        navigationDetails = ["mode": mode.rawValue, "active": gesture != nil]
        return gesture != nil
    }
    func endNavigation() {
        gesture = nil; gestureOrigin = nil
        navigationDetails["active"] = false
    }
    @discardableResult
    func moveNavigation(to point: NSPoint) -> Bool {
        guard let gesture, let origin = gestureOrigin, let pose = gesture.pose(at: gesturePoint(point)) else { return false }
        let accepted = applyNavigation(pose, origin: origin)
        navigationDetails["accepted"] = accepted
        if let pivot = gesture.pivot {
            navigationDetails["initialPivotRadius"] = simd_distance(gesture.initial.eye, pivot)
            navigationDetails["pivotRadius"] = simd_distance(pose.eye, pivot)
            if let projected = pose.project(pivot, fov: gesture.fov) {
                navigationDetails["pivotScreenX"] = 0.5 + projected.x / (2 * gestureViewport.width / gestureViewport.height)
                navigationDetails["pivotScreenY"] = 0.5 - projected.y/2
            }
        }
        return accepted
    }

    private func applyNavigation(_ pose: NavigationPose, origin: Coordinate) -> Bool {
        let old = map.camera
        // Recreate the distance-based camera explicitly. Mutating a readback
        // camera can inherit MapKit's legacy altitude-based pitch behavior.
        let previousCamera = MKMapCamera(lookingAtCenter: old.centerCoordinate,
            fromDistance: old.centerCoordinateDistance, pitch: old.pitch, heading: old.heading)
        let previousScale = sourceScale, previousPitch = desiredPitch, previousRequest = request
        let previousWarnings = warnings
        applying = true
        defer { applying = false; updateFraming(); changed?() }
        request = nil; desiredPitch = pose.pitch; warnings = []; renderComplete = false
        func source(_ pitch: Double) -> MKMapCamera? {
            guard let target = pose.target(nativePitch: pitch) else { return nil }
            let coordinate = origin.destination(meters: hypot(target.point.x, target.point.y),
                heading: atan2(target.point.x, target.point.y) * 180 / .pi)
            guard abs(coordinate.latitude) < 85 else { return nil }
            return MKMapCamera(lookingAtCenter: coordinate.cl, fromDistance: target.distance,
                               pitch: pitch, heading: pose.heading)
        }
        let result = RenderScaleFitting.fit(width: viewport.height * renderAspect, height: viewport.height,
            initialScale: sourceScale) { scale in
            self.sourceScale = scale; self.layoutRenderSurface()
            guard let camera = source(pose.pitch) else {
                return .init(pitchError: 180, centerError: .infinity, rangeError: .infinity)
            }
            self.map.setCamera(camera, animated: false)
            var pitch = pose.pitch
            for _ in 0..<3 {
                let accepted = Double(self.map.camera.pitch)
                guard accepted < pitch - 0.05, let corrected = source(accepted) else { break }
                pitch = accepted; self.map.setCamera(corrected, animated: false)
            }
            let actual = self.map.camera
            guard let expected = source(Double(actual.pitch)), CLLocationCoordinate2DIsValid(actual.centerCoordinate) else {
                return .init(pitchError: 180, centerError: .infinity, rangeError: .infinity)
            }
            return .init(pitchError: Double(actual.pitch) - pose.pitch,
                centerError: MKMapPoint(expected.centerCoordinate).distance(to: MKMapPoint(actual.centerCoordinate)),
                rangeError: actual.centerCoordinateDistance - expected.centerCoordinateDistance)
        }
        fitAttempts = result.attempts
        navigationDetails["sourceCenterErrorMeters"] = result.measurement.centerError.isFinite ? result.measurement.centerError as Any : NSNull()
        navigationDetails["sourceRangeErrorMeters"] = result.measurement.rangeError.isFinite ? result.measurement.rangeError as Any : NSNull()
        guard result.measurement.positionFits else {
            sourceScale = previousScale; layoutRenderSurface()
            map.setCamera(previousCamera, animated: false)
            desiredPitch = previousPitch; request = previousRequest; warnings = previousWarnings
            warnings.append("MapKit reached a navigation limit; the last valid camera was retained.")
            return false
        }
        return true
    }

    private func begin(_ event: NSEvent) {
        window?.makeFirstResponder(self)
        let mode: NavigationGesture.Mode
        if event.buttonNumber == 2 { mode = .orbit }
        else if event.buttonNumber == 1 || event.modifierFlags.contains(.command) || event.modifierFlags.contains(.control) { mode = .look }
        else if event.modifierFlags.contains(.shift) { mode = .orbit }
        else { mode = .pan }
        beginNavigation(mode: mode, at: convert(event.locationInWindow, from: nil))
    }
    override func mouseDown(with event: NSEvent) { begin(event) }
    override func rightMouseDown(with event: NSEvent) { begin(event) }
    override func otherMouseDown(with event: NSEvent) { begin(event) }
    override func mouseUp(with event: NSEvent) { endNavigation() }
    override func rightMouseUp(with event: NSEvent) { endNavigation() }
    override func otherMouseUp(with event: NSEvent) { endNavigation() }
    override func mouseDragged(with event: NSEvent) { drag(event) }
    override func rightMouseDragged(with event: NSEvent) { drag(event) }
    override func otherMouseDragged(with event: NSEvent) { drag(event) }

    private func drag(_ event: NSEvent) {
        moveNavigation(to: convert(event.locationInWindow, from: nil))
    }
    override func scrollWheel(with event: NSEvent) {
        let delta = event.scrollingDeltaY != 0 ? event.scrollingDeltaY : (event.modifierFlags.contains(.shift) ? event.scrollingDeltaX : 0)
        guard gesture == nil, delta != 0 else { return }
        let factor = exp(min(0.4, max(-0.4, -delta * (event.hasPreciseScrollingDeltas ? 0.008 : 0.08))))
        if event.modifierFlags.contains(.shift) {
            let c = map.camera
            let pose = NavigationPose(distance: c.centerCoordinateDistance, nativePitch: Double(c.pitch),
                heading: c.heading, pitch: displayedPitch, roll: desiredRoll)
            desiredFov = min(120, max(0.1, (desiredFov ?? nativeFov ?? 30) * factor))
            sourceAspect = nil
            _ = applyNavigation(pose, origin: Coordinate(c.centerCoordinate))
        } else {
            let c = map.camera
            map.setCamera(MKMapCamera(lookingAtCenter: c.centerCoordinate,
                fromDistance: min(2_000_000, max(5, c.centerCoordinateDistance * factor)),
                pitch: c.pitch, heading: c.heading), animated: false)
        }
        request = nil; warnings = []; updateFraming(); changed?()
    }
    override func magnify(with event: NSEvent) {
        guard gesture == nil else { return }
        let c = map.camera
        request = nil
        map.setCamera(MKMapCamera(lookingAtCenter: c.centerCoordinate,
            fromDistance: min(2_000_000, max(5, c.centerCoordinateDistance * exp(-event.magnification))),
            pitch: c.pitch, heading: c.heading), animated: false)
    }
}
