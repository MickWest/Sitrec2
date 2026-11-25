import Foundation
import simd

/// Local east/north/up meters, with the navigation ground plane at z = 0.
/// Screen coordinates are centered, Y-up, in half-viewport-heights.
public struct NavigationPose {
    public var eye: SIMD3<Double>
    public var heading, pitch, roll: Double
    public init(eye: SIMD3<Double>, heading: Double, pitch: Double, roll: Double = 0) {
        self.eye = eye; self.heading = heading; self.pitch = pitch; self.roll = roll
    }
    public init(distance: Double, nativePitch: Double, heading: Double, pitch: Double, roll: Double) {
        let h = heading * .pi / 180, p = nativePitch * .pi / 180
        self.init(eye: SIMD3(-distance * sin(p) * sin(h), -distance * sin(p) * cos(h), distance * cos(p)),
                  heading: heading, pitch: pitch, roll: roll)
    }
    public var forward: SIMD3<Double> {
        let h = heading * .pi / 180, p = pitch * .pi / 180
        return SIMD3(sin(h) * sin(p), cos(h) * sin(p), -cos(p))
    }
    public var right: SIMD3<Double> {
        let h = heading * .pi / 180, p = pitch * .pi / 180, r = roll * .pi / 180
        return SIMD3(cos(h), -sin(h), 0) * cos(r) - SIMD3(sin(h) * cos(p), cos(h) * cos(p), sin(p)) * sin(r)
    }
    public var up: SIMD3<Double> { simd_cross(right, forward) }
    public func target(nativePitch: Double? = nil) -> (point: SIMD3<Double>, distance: Double)? {
        var source = self; source.pitch = nativePitch ?? pitch
        guard source.pitch >= 0, source.pitch <= 85, eye.z >= 1 else { return nil }
        let distance = -eye.z / source.forward.z
        guard distance.isFinite, (1...2_000_000).contains(distance) else { return nil }
        return (eye + source.forward * distance, distance)
    }
    public func groundHit(screen: SIMD2<Double>, fov: Double, maximumDistance: Double) -> SIMD3<Double>? {
        let scale = tan(fov * .pi / 360)
        let ray = forward + (right * screen.x + up * screen.y) * scale
        guard ray.z < -1e-6 else { return nil }
        let hit = eye - ray * (eye.z / ray.z)
        guard hit.x.isFinite, hit.y.isFinite, simd_distance(eye, hit) <= maximumDistance else { return nil }
        return hit
    }
    public func project(_ point: SIMD3<Double>, fov: Double) -> SIMD2<Double>? {
        let v = point - eye, depth = simd_dot(v, forward)
        guard depth > 0 else { return nil }
        let scale = depth * tan(fov * .pi / 360)
        return SIMD2(simd_dot(v, right) / scale, simd_dot(v, up) / scale)
    }
}

public struct NavigationGesture {
    public enum Mode: String { case pan, orbit, look }
    public let mode: Mode
    public let initial: NavigationPose
    public let start: SIMD2<Double>
    public let pivot: SIMD3<Double>?
    public let fov: Double
    private let maximumDistance: Double

    public init?(mode: Mode, pose: NavigationPose, screen: SIMD2<Double>, fov: Double) {
        guard (0.1...120).contains(fov), screen.x.isFinite, screen.y.isFinite,
              let target = pose.target() else { return nil }
        self.mode = mode; self.initial = pose; self.start = screen; self.fov = fov
        maximumDistance = min(2_000_000, max(1000, target.distance * 20))
        pivot = pose.groundHit(screen: screen, fov: fov, maximumDistance: maximumDistance)
        if mode != .look && pivot == nil { return nil }
    }

    /// Every movement is relative to mouse-down, never the clamped native
    /// camera returned by the preceding event. Event cadence cannot amplify it.
    public func pose(at screen: SIMD2<Double>) -> NavigationPose? {
        guard screen.x.isFinite, screen.y.isFinite else { return nil }
        var result = initial
        let delta = screen - start
        switch mode {
        case .pan:
            guard let hit = initial.groundHit(screen: screen, fov: fov, maximumDistance: maximumDistance),
                  let pivot else { return nil }
            result.eye += pivot - hit
        case .orbit:
            guard let pivot else { return nil }
            let speed = 90 * min(1, fov / 30)
            let yaw = delta.x * speed
            result.heading = wrapDegrees(initial.heading + yaw)
            result.pitch = min(85, max(0, initial.pitch + delta.y * speed))
            let offset = initial.eye - pivot
            let yawed = simd_quatd(angle: -yaw * .pi / 180, axis: SIMD3(0, 0, 1)).act(offset)
            let h = result.heading * .pi / 180
            let axis = SIMD3(cos(h), -sin(h), 0)
            result.eye = pivot + simd_quatd(angle: (result.pitch - initial.pitch) * .pi / 180, axis: axis).act(yawed)
        case .look:
            result.heading = wrapDegrees(initial.heading - delta.x * fov / 2)
            result.pitch = min(85, max(0, initial.pitch - delta.y * fov / 2))
        }
        guard result.target() != nil else { return nil }
        return result
    }
}
