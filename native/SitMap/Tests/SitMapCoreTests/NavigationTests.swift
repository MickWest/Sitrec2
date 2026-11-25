import XCTest
import simd
@testable import SitMapCore

final class NavigationTests: XCTestCase {
    private let pose = NavigationPose(distance: 513.296, nativePitch: 70, heading: 269.46,
                                      pitch: 71.2418, roll: -0.00007)
    func testPanKeepsTheGrabbedPointUnderTheCursorWithoutChangingHeightOrDirection() throws {
        let gesture = try XCTUnwrap(NavigationGesture(mode: .pan, pose: pose, screen: SIMD2(0.4, -0.2), fov: 20))
        for point in [SIMD2(0.41, -0.19), SIMD2(-0.6, -0.5), SIMD2(0.4, -0.2)] {
            let next = try XCTUnwrap(gesture.pose(at: point))
            let projected = try XCTUnwrap(next.project(try XCTUnwrap(gesture.pivot), fov: 20))
            XCTAssertEqual(projected.x, point.x, accuracy: 1e-10)
            XCTAssertEqual(projected.y, point.y, accuracy: 1e-10)
            XCTAssertEqual(next.eye.z, pose.eye.z, accuracy: 1e-10)
            XCTAssertEqual(next.heading, pose.heading); XCTAssertEqual(next.pitch, pose.pitch)
        }
    }
    func testOrbitKeepsTheClickedPivotAndRadiusAtHighPitch() throws {
        let start = SIMD2(0.5, -0.4)
        let gesture = try XCTUnwrap(NavigationGesture(mode: .orbit, pose: pose, screen: start, fov: 20))
        let pivot = try XCTUnwrap(gesture.pivot), radius = simd_distance(pose.eye, pivot)
        for point in [SIMD2(0.51, -0.39), SIMD2(1.2, -0.1), SIMD2(-0.6, 0.2), start] {
            let next = try XCTUnwrap(gesture.pose(at: point))
            XCTAssertEqual(simd_distance(next.eye, pivot), radius, accuracy: 1e-9)
            let projected = try XCTUnwrap(next.project(pivot, fov: 20))
            XCTAssertEqual(projected.x, start.x, accuracy: 1e-10)
            XCTAssertEqual(projected.y, start.y, accuracy: 1e-10)
        }
        let smallMove = try XCTUnwrap(gesture.pose(at: SIMD2(0.51, -0.39)))
        XCTAssertLessThan(simd_distance(pose.eye, smallMove.eye), 10)
    }
    func testReturningMouseToStartRestoresThePoseRegardlessOfIntermediateEvents() throws {
        for mode in [NavigationGesture.Mode.pan, .orbit, .look] {
            let gesture = try XCTUnwrap(NavigationGesture(mode: mode, pose: pose, screen: .zero, fov: 20))
            for step in 0..<1000 { _ = gesture.pose(at: SIMD2(Double(step) / 2000, -0.1)) }
            let restored = try XCTUnwrap(gesture.pose(at: .zero))
            XCTAssertLessThan(simd_distance(restored.eye, pose.eye), 1e-10)
            XCTAssertEqual(restored.pitch, pose.pitch); XCTAssertEqual(restored.heading, pose.heading)
        }
    }
    func testOrbitDirectionAndRateMatchSitrecMouseControls() throws {
        // Sitrec: rotateSpeed=0.5, 2*pi*pixelDelta/height, scaled by FOV/30.
        // Drag 10 pixels right/down in a 1000-pixel-high view at 20 degrees.
        let gesture = try XCTUnwrap(NavigationGesture(mode: .orbit, pose: pose, screen: .zero, fov: 20))
        let next = try XCTUnwrap(gesture.pose(at: SIMD2(0.02, -0.02)))
        XCTAssertEqual(next.heading, pose.heading + 1.2, accuracy: 1e-10)
        XCTAssertEqual(next.pitch, pose.pitch - 1.2, accuracy: 1e-10)
    }
    func testDraggingOntoSkyOrNonfiniteCoordinatesDoesNotProduceADistantCamera() throws {
        let gesture = try XCTUnwrap(NavigationGesture(mode: .pan, pose: pose, screen: .zero, fov: 20))
        XCTAssertNil(gesture.pose(at: SIMD2(0, 100)))
        XCTAssertNil(gesture.pose(at: SIMD2(Double.nan, 0)))
        XCTAssertNil(NavigationGesture(mode: .orbit, pose: pose, screen: SIMD2(0, 100), fov: 20))
    }
}
