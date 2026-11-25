import Foundation

public struct SitMapError: LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public struct Coordinate: Codable, Equatable {
    public var latitude: Double
    public var longitude: Double
    public init(_ latitude: Double, _ longitude: Double) {
        self.latitude = latitude; self.longitude = longitude
    }
    public func destination(meters: Double, heading: Double) -> Coordinate {
        let arc = meters / 6_378_137
        let lat = latitude * .pi / 180, lon = longitude * .pi / 180
        let bearing = heading * .pi / 180
        let nextLat = asin(sin(lat) * cos(arc) + cos(lat) * sin(arc) * cos(bearing))
        let nextLon = lon + atan2(sin(bearing) * sin(arc) * cos(lat), cos(arc) - sin(lat) * sin(nextLat))
        return Coordinate(nextLat * 180 / .pi, wrapDegrees(nextLon * 180 / .pi + 180) - 180)
    }
}

public func wrapDegrees(_ degrees: Double) -> Double {
    let value = degrees.truncatingRemainder(dividingBy: 360)
    return value < 0 ? value + 360 : value
}

/// The visible surface under the center of Sitrec's rendered camera, not the
/// terrain beneath the eye. Distance is the measured 3D eye-to-hit range.
public struct GroundTarget: Codable, Equatable {
    public var latitude: Double
    public var longitude: Double
    public var altitudeMSL: Double
    public var distance: Double
    public var pitch: Double?
    public init(latitude: Double, longitude: Double, altitudeMSL: Double, distance: Double, pitch: Double? = nil) {
        self.latitude = latitude; self.longitude = longitude; self.altitudeMSL = altitudeMSL; self.distance = distance
        self.pitch = pitch
    }
}

/// Eye altitude and ground datum are separate: MapKit exposes height above ground,
/// whereas Sitrec uses an absolute camera altitude. The ground value is an estimate
/// supplied by the caller; MapKit does not expose its terrain elevation samples.
public struct ViewRequest: Codable, Equatable {
    public var latitude: Double
    public var longitude: Double
    public var altitudeMSL: Double
    public var groundAltitudeMSL: Double?
    public var groundTarget: GroundTarget?
    public var sourceGroundTarget: GroundTarget?
    public var heading: Double
    public var elevation: Double
    public var roll: Double?
    public var verticalFov: Double?
    public var aspect: Double?
    public var renderScale: Double?
    public var style: String?
    public var requireExact: Bool?

    public init(latitude: Double, longitude: Double, altitudeMSL: Double,
                groundAltitudeMSL: Double? = nil, heading: Double, elevation: Double,
                roll: Double? = nil, verticalFov: Double? = nil, aspect: Double? = nil, style: String? = nil,
                requireExact: Bool? = nil, groundTarget: GroundTarget? = nil, renderScale: Double? = nil,
                sourceGroundTarget: GroundTarget? = nil) {
        self.latitude = latitude; self.longitude = longitude; self.altitudeMSL = altitudeMSL
        self.groundAltitudeMSL = groundAltitudeMSL; self.heading = heading; self.elevation = elevation
        self.roll = roll; self.verticalFov = verticalFov; self.aspect = aspect; self.style = style; self.requireExact = requireExact
        self.groundTarget = groundTarget
        self.renderScale = renderScale
        self.sourceGroundTarget = sourceGroundTarget
    }
    public var eye: Coordinate { Coordinate(latitude, longitude) }
    public var heightAboveGround: Double { altitudeMSL - (groundAltitudeMSL ?? 0) }
    public var heightAboveTarget: Double { altitudeMSL - (groundTarget?.altitudeMSL ?? groundAltitudeMSL ?? 0) }
    public func validate() throws {
        let values = [latitude, longitude, altitudeMSL, groundAltitudeMSL ?? 0, heading,
                      elevation, roll ?? 0, verticalFov ?? 30, aspect ?? 1, renderScale ?? 1]
        guard values.allSatisfy({ $0.isFinite }) else { throw SitMapError("Camera values must be finite numbers.") }
        guard (-85...85).contains(latitude), (-180...180).contains(longitude) else {
            throw SitMapError("Latitude must be within ±85°, longitude within ±180°.")
        }
        guard (1...2_000_000).contains(heightAboveGround) else {
            throw SitMapError("The camera must be 1 to 2,000,000 meters above the supplied ground altitude.")
        }
        guard (-90...90).contains(elevation), (-180...180).contains(roll ?? 0),
              (0.1...120).contains(verticalFov ?? 30) else {
            throw SitMapError("Elevation must be ±90°, roll ±180°, and verticalFov 0.1° to 120°.")
        }
        guard (0.1...10).contains(aspect ?? 1) else { throw SitMapError("aspect must be between 0.1 and 10.") }
        guard (0.5...2).contains(renderScale ?? 1) else { throw SitMapError("renderScale must be between 0.5 and 2.") }
        if let target = groundTarget {
            guard [target.latitude, target.longitude, target.altitudeMSL, target.distance].allSatisfy({ $0.isFinite }),
                  (-85...85).contains(target.latitude), (-180...180).contains(target.longitude),
                  (1...2_000_000).contains(target.distance), heightAboveTarget > 0, elevation < 0 else {
                throw SitMapError("groundTarget must be a finite, valid surface point below the camera, 1–2,000,000 meters away.")
            }
        }
        if let target = sourceGroundTarget {
            guard let pitch = target.pitch,
                  [target.latitude, target.longitude, target.altitudeMSL, target.distance, pitch].allSatisfy({ $0.isFinite }),
                  (-85...85).contains(target.latitude), (-180...180).contains(target.longitude),
                  (1...2_000_000).contains(target.distance), target.altitudeMSL < altitudeMSL, (0...85).contains(pitch) else {
                throw SitMapError("sourceGroundTarget must include a valid downward surface hit and its native pitch.")
            }
        }
        if let style, !["imagery", "hybrid", "standard"].contains(style) {
            throw SitMapError("style must be imagery, hybrid, or standard.")
        }
        if requireExact == true {
            throw SitMapError("MapKit cannot guarantee an exact eye position over its terrain or an unrestricted projection. Use requireExact:false and inspect fidelity in the response.")
        }
    }

    /// A local tangent-ground approximation. Keep the eye fixed while changing
    /// pitch: distance and target must change together, unlike a MapKit orbit.
    public func target(pitch: Double) -> Coordinate {
        if let target = sourceGroundTarget, let sourcePitch = target.pitch, abs(sourcePitch - pitch) < 0.05 {
            return Coordinate(target.latitude, target.longitude)
        }
        if let target = groundTarget, abs(pitch - (90 + elevation)) < 0.05 {
            return Coordinate(target.latitude, target.longitude)
        }
        return eye.destination(meters: heightAboveTarget * tan(pitch * .pi / 180), heading: heading)
    }
    public func centerDistance(pitch: Double) -> Double {
        if let target = sourceGroundTarget, let sourcePitch = target.pitch, abs(sourcePitch - pitch) < 0.05 { return target.distance }
        if let target = groundTarget, abs(pitch - (90 + elevation)) < 0.05 { return target.distance }
        return heightAboveTarget / cos(pitch * .pi / 180)
    }
}

public struct Framing: Equatable {
    public let scale: Double
    public let effectiveFov: Double
    public let fullyCovered: Bool
    public init(nativeFov: Double, requestedFov: Double, roll: Double, aspect: Double) {
        scale = tan(nativeFov * .pi / 360) / tan(requestedFov * .pi / 360)
        effectiveFov = requestedFov
        let angle = roll * .pi / 180
        // Four viewport corners must fit in the source after inverse scale/roll.
        let requiredWidth = abs(cos(angle)) + abs(sin(angle)) / aspect
        let requiredHeight = abs(cos(angle)) + abs(sin(angle)) * aspect
        fullyCovered = scale >= max(requiredWidth, requiredHeight) - 1e-8
    }
}
