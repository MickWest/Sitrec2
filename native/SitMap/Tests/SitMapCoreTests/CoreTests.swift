import XCTest
@testable import SitMapCore

final class CoreTests: XCTestCase {
    func testGroundDatumAndFixedEyeTarget() throws {
        let view = ViewRequest(latitude: 0, longitude: 0, altitudeMSL: 1500,
                               groundAltitudeMSL: 500, heading: 90, elevation: -45)
        try view.validate()
        XCTAssertEqual(view.heightAboveGround, 1000)
        XCTAssertEqual(view.target(pitch: 0), view.eye)
        XCTAssertEqual(view.target(pitch: 45).longitude, 0.00898315284, accuracy: 1e-9)
        XCTAssertEqual(view.target(pitch: 45).latitude, 0, accuracy: 1e-9)
        XCTAssertEqual(Coordinate(0, 179.999).destination(meters: 1000, heading: 90).longitude,
                       -179.992016847, accuracy: 1e-8)
    }
    func testCropPreservesPerspectiveAndReportsMissingCoverage() {
        let crop = Framing(nativeFov: 30, requestedFov: 10, roll: 0, aspect: 16.0/9)
        XCTAssertEqual(crop.scale, tan(.pi/12)/tan(.pi/36), accuracy: 1e-12)
        XCTAssertTrue(crop.fullyCovered)
        XCTAssertFalse(Framing(nativeFov: 30, requestedFov: 60, roll: 0, aspect: 1).fullyCovered)
        XCTAssertFalse(Framing(nativeFov: 30, requestedFov: 30, roll: 45, aspect: 16.0/9).fullyCovered)
        XCTAssertTrue(Framing(nativeFov: 30, requestedFov: 10, roll: 45, aspect: 16.0/9).fullyCovered)
    }
    func testSlopingTerrainUsesTheLookTargetInsteadOfGroundBeneathTheEye() throws {
        let target = GroundTarget(latitude: 0, longitude: 0.00898315284,
                                  altitudeMSL: 1000, distance: sqrt(2) * 1000)
        var view = ViewRequest(latitude: 0, longitude: 0, altitudeMSL: 2000,
            groundAltitudeMSL: 1500, heading: 90, elevation: -45, groundTarget: target)
        try view.validate()
        XCTAssertEqual(view.heightAboveGround, 500)
        XCTAssertEqual(view.heightAboveTarget, 1000)
        XCTAssertEqual(view.target(pitch: 45), Coordinate(target.latitude, target.longitude))
        XCTAssertEqual(view.centerDistance(pitch: 45), sqrt(2) * 1000, accuracy: 1e-9)
        // A clamped tilt rebuilds target and range around the original eye.
        XCTAssertEqual(view.centerDistance(pitch: 30), 1000 / cos(.pi/6), accuracy: 1e-9)
        XCTAssertEqual(view.target(pitch: 30).longitude, 0.00518642571, accuracy: 1e-9)
        view.sourceGroundTarget = GroundTarget(latitude: 0, longitude: 0.004,
            altitudeMSL: 1200, distance: 930, pitch: 30)
        try view.validate()
        XCTAssertEqual(view.target(pitch: 30), Coordinate(0, 0.004))
        XCTAssertEqual(view.centerDistance(pitch: 30), 930)
        XCTAssertEqual(view.centerDistance(pitch: 45), target.distance)
        view.groundTarget?.altitudeMSL = 2100
        XCTAssertThrowsError(try view.validate())
    }
    func testCameraValidation() {
        var view = ViewRequest(latitude: 37, longitude: -122, altitudeMSL: 1000, heading: 0, elevation: -20)
        view.requireExact = true
        XCTAssertThrowsError(try view.validate())
        view.requireExact = false; view.verticalFov = .nan
        XCTAssertThrowsError(try view.validate())
        view.verticalFov = 20; view.groundAltitudeMSL = 1100
        XCTAssertThrowsError(try view.validate())
    }
    func testAdaptiveRenderSurfaceLiftsPitchClampAndKeepsTheWorkingSize() {
        var attempts: [Double] = []
        let measure: (Double) -> RenderScaleFitting.Measurement = { scale in
            attempts.append(scale)
            return .init(pitchError: scale < 1.25 ? 12.76 : 0, centerError: 0, rangeError: 0)
        }
        let fit = RenderScaleFitting.fit(width: 1614, height: 730.5, initialScale: 1, measure: measure)
        XCTAssertEqual(attempts, [1, 1.25])
        XCTAssertEqual(fit.scale, 1.25); XCTAssertTrue(fit.measurement.fits)
        attempts = []
        _ = RenderScaleFitting.fit(width: 1614, height: 730.5, initialScale: fit.scale, measure: measure)
        XCTAssertEqual(attempts, [1.25]) // A moving camera need not resize on every tick.
    }
    func testAdaptiveRenderSurfaceShrinksWhenZoomMovesTheEye() {
        let fit = RenderScaleFitting.fit(width: 1614, height: 730.5, initialScale: 2) { scale in
            .init(pitchError: 0, centerError: scale > 1 ? 39.14 * scale : 0,
                  rangeError: scale > 1 ? 52.82 * scale : 0)
        }
        XCTAssertEqual(fit.scale, 1); XCTAssertTrue(fit.measurement.fits)
    }
    func testAdaptiveRenderSurfaceRestoresBestPoseWhenLimitsConflict() {
        var activeScale = 0.0
        let fit = RenderScaleFitting.fit(width: 1614, height: 730.5, initialScale: 1) { scale in
            activeScale = scale
            return .init(pitchError: scale > 1 ? 0 : 12,
                         centerError: scale > 1 ? 40 : 0, rangeError: scale > 1 ? 50 : 0)
        }
        XCTAssertEqual(fit.scale, 1); XCTAssertEqual(activeScale, 1)
        XCTAssertTrue(fit.measurement.positionFits); XCTAssertFalse(fit.measurement.fits)
        XCTAssertEqual(fit.attempts, 3)
    }
    func testAdaptiveRenderSurfaceStopsAtItsResourceBudget() {
        let fit = RenderScaleFitting.fit(width: 1614, height: 730.5, initialScale: 1) { _ in
            .init(pitchError: 20, centerError: 0, rangeError: 0)
        }
        XCTAssertFalse(fit.measurement.fits)
        XCTAssertLessThanOrEqual(fit.attempts, 8)
        XCTAssertEqual(fit.scale, RenderScaleFitting.scales(width: 1614, height: 730.5).last)
        for scale in RenderScaleFitting.scales(width: 3000, height: 2200) {
            XCTAssertLessThanOrEqual(3000 * scale, 4096)
            XCTAssertLessThanOrEqual(3000 * 2200 * scale * scale, 8_388_608 + 0.01)
        }
    }
    func testRenderAspectIgnoresNoiseAndDoesNotOscillateAtBucketEdges() {
        let shapes = (0..<100).map { step in
            RenderScaleFitting.sourceAspect(required: 1.49 + Double(step)*0.00001, output: 2.2)
        }
        XCTAssertEqual(Set(shapes), [1.5])
        XCTAssertEqual(RenderScaleFitting.sourceAspect(required: 1.51, output: 2.2), 1.625)
        XCTAssertFalse(RenderScaleFitting.shouldCompactAspect(current: 1.625, candidate: 1.5))
        XCTAssertTrue(RenderScaleFitting.shouldCompactAspect(current: 1.75, candidate: 1.5))
    }
    func testPerspectiveCompensationKeepsTheRequestedRayAtImageCenter() throws {
        let delta = 12.75884 * Double.pi / 180
        let framing = PerspectiveFraming(nativeFov: 30, requestedFov: 20,
            nativePitch: 35, requestedPitch: 47.75884, roll: 0, aspect: 2.2)
        let sourceY = tan(delta) / tan(Double.pi/12)
        let point = try XCTUnwrap(framing.project(x: 0, y: sourceY))
        XCTAssertEqual(point.x, 0, accuracy: 1e-12)
        XCTAssertEqual(point.y, 0, accuracy: 1e-12)
        XCTAssertFalse(framing.fullyCovered) // The missing upper rays cannot be invented.
        XCTAssertTrue(framing.sourceProjectable)
        let originalCenter = try XCTUnwrap(framing.project(x: 0, y: 0))
        XCTAssertLessThan(originalCenter.y, 0)
    }
    func testPerspectiveInverseAndRollAgreeWithTheProjection() throws {
        let framing = PerspectiveFraming(nativeFov: 30, requestedFov: 10,
            nativePitch: 45, requestedPitch: 49, roll: 12, aspect: 1.7)
        XCTAssertTrue(framing.fullyCovered)
        for x in [-1.7, 0, 1.7] {
            for y in [-1.0, 0, 1.0] {
                let source = try XCTUnwrap(framing.source(x: x, y: y))
                let output = try XCTUnwrap(framing.project(x: source.x, y: source.y))
                XCTAssertEqual(output.x, x, accuracy: 1e-12)
                XCTAssertEqual(output.y, y, accuracy: 1e-12)
            }
        }
        let straight = PerspectiveFraming(nativeFov: 30, requestedFov: 20,
            nativePitch: 35, requestedPitch: 35, roll: 0, aspect: 2)
        let scale = tan(Double.pi/12) / tan(Double.pi/18)
        let point = try XCTUnwrap(straight.project(x: 0.2, y: -0.4))
        XCTAssertEqual(point.x, 0.2 * scale, accuracy: 1e-12)
        XCTAssertEqual(point.y, -0.4 * scale, accuracy: 1e-12)
        XCTAssertFalse(PerspectiveFraming(nativeFov: 30, requestedFov: 20,
            nativePitch: 0, requestedPitch: 100, roll: 0, aspect: 2).sourceProjectable)
    }
    func testDifferentSourceAspectPreservesProjectionAndChecksHorizontalCoverage() throws {
        let projection = PerspectiveFraming(nativeFov: 30, requestedFov: 20, nativePitch: 60,
            requestedPitch: 60, roll: 0, aspect: 2.2, sourceAspect: 1.5)
        XCTAssertTrue(projection.fullyCovered)
        XCTAssertEqual(projection.coverageFraction, 1, accuracy: 1e-10)
        XCTAssertEqual(projection.minimumSourceAspect, 2.2*tan(Double.pi/18)/tan(Double.pi/12), accuracy: 1e-10)
        let ray = try XCTUnwrap(projection.source(x: 2.2, y: 1))
        let pixel = try XCTUnwrap(projection.project(x: ray.x, y: ray.y))
        XCTAssertEqual(pixel.x, 2.2, accuracy: 1e-10)
        XCTAssertEqual(pixel.y, 1, accuracy: 1e-10)
        XCTAssertFalse(PerspectiveFraming(nativeFov: 30, requestedFov: 20, nativePitch: 60,
            requestedPitch: 60, roll: 0, aspect: 2.2, sourceAspect: 1).fullyCovered)
    }
    func testHardPitchCutoffUsesAnExplicitVisibleFallbackAndRecovers() {
        let blocked = ProjectionSelection(nativeFov: 30, requestedFov: 20, nativePitch: 35,
            requestedPitch: 66.63, roll: 0, aspect: 2.2, sourceAspect: 2.2)
        XCTAssertEqual(blocked.requested.coverageFraction, 0, accuracy: 1e-10)
        XCTAssertTrue(blocked.limited)
        XCTAssertTrue(blocked.displayed.fullyCovered)
        XCTAssertEqual(blocked.displayedPitch, 40, accuracy: 1e-4)
        let restored = ProjectionSelection(nativeFov: 30, requestedFov: 20, nativePitch: 60,
            requestedPitch: 66.63, roll: 0, aspect: 2.2, sourceAspect: 1.6)
        XCTAssertFalse(restored.limited)
        XCTAssertEqual(restored.displayedPitch, 66.63)
        XCTAssertGreaterThan(restored.requested.coverageFraction, 0.8)
    }
    func testCoverageDistinguishesWideLensFromAnEmptyFrame() {
        let projection = PerspectiveFraming(nativeFov: 30, requestedFov: 60,
            nativePitch: 35, requestedPitch: 35, roll: 0, aspect: 2.2)
        let scale = tan(Double.pi/12)/tan(Double.pi/6)
        XCTAssertEqual(projection.coverageFraction, scale*scale, accuracy: 1e-10)
    }
    func testHTTPFragmentsAndAuthorization() throws {
        let start = "POST /v1/view HTTP/1.1\r\nHost: 127.0.0.1:9876\r\nContent-Type: application/json\r\nX-SitMap-Client: SitrecBridge-v1\r\nContent-Length: 2\r\n\r\n"
        XCTAssertNil(try HTTPRequest.parse(Data((start + "{").utf8)))
        let request = try XCTUnwrap(HTTPRequest.parse(Data((start + "{}").utf8)))
        try request.authorize(port: 9876)
        XCTAssertEqual(request.path, "/v1/view")
        XCTAssertThrowsError(try HTTPRequest.parse(Data((start + "{}extra").utf8)))
        let foreign = "GET /v1/status HTTP/1.1\r\nHost: evil.test:9876\r\n\r\n"
        XCTAssertThrowsError(try HTTPRequest.parse(Data(foreign.utf8))?.authorize(port: 9876))
        let origin = "GET /v1/status HTTP/1.1\r\nHost: localhost:9876\r\nOrigin: https://evil.test\r\n\r\n"
        XCTAssertThrowsError(try HTTPRequest.parse(Data(origin.utf8))?.authorize(port: 9876))
        XCTAssertThrowsError(try HTTPRequest.parse(Data("POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n{}".utf8)))
    }
}
