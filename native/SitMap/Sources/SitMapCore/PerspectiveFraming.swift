import Foundation

/// Pure camera rotation from the same eye. Coordinates are centered, Y-up,
/// measured in half-image-heights (so horizontal edges are ±aspect).
public struct PerspectiveFraming {
    public let a: Double, b: Double, c: Double
    public let d: Double, e: Double, f: Double
    public let g: Double = 0, h: Double, i: Double
    public let fullyCovered: Bool
    public let sourceProjectable: Bool
    public let minimumSourceAspect: Double
    public let coverageFraction: Double
    private let sourceFocal: Double, targetFocal: Double
    private let cosinePitch: Double, sinePitch: Double
    private let cosineRoll: Double, sineRoll: Double

    public init(nativeFov: Double, requestedFov: Double, nativePitch: Double,
                requestedPitch: Double, roll: Double, aspect: Double, sourceAspect: Double? = nil) {
        sourceFocal = 1 / tan(nativeFov * .pi / 360)
        targetFocal = 1 / tan(requestedFov * .pi / 360)
        let pitch = (requestedPitch - nativePitch) * .pi / 180
        cosinePitch = cos(pitch); sinePitch = sin(pitch)
        cosineRoll = cos(roll * .pi / 180); sineRoll = sin(roll * .pi / 180)
        let scale = targetFocal / sourceFocal
        a = scale * cosineRoll; b = -scale * sineRoll * cosinePitch
        c = targetFocal * sineRoll * sinePitch
        d = scale * sineRoll; e = scale * cosineRoll * cosinePitch
        f = -targetFocal * cosineRoll * sinePitch
        h = sinePitch / sourceFocal; i = cosinePitch
        sourceProjectable = i - abs(h) > 1e-9
        // Evaluate the inverse rays without needing an initialized self.
        var covered = true
        var minimumAspect = 0.0
        for x in [-aspect, aspect] {
            for y in [-1.0, 1.0] {
                let u = x / targetFocal, v = y / targetFocal
                let xr = cosineRoll*u + sineRoll*v
                let yr = -sineRoll*u + cosineRoll*v
                let z = -sinePitch*yr + cosinePitch
                let sx = sourceFocal*xr/z
                let sy = sourceFocal*(cosinePitch*yr + sinePitch)/z
                minimumAspect = z > 1e-9 ? max(minimumAspect, abs(sx)) : .infinity
                if z <= 1e-9 || abs(sx) > (sourceAspect ?? aspect) + 1e-8 || abs(sy) > 1 + 1e-8 { covered = false }
            }
        }
        fullyCovered = covered
        minimumSourceAspect = minimumAspect
        var polygon: [(Double, Double)] = []
        let sa = sourceAspect ?? aspect
        if sourceProjectable {
            for (x, y) in [(-sa, -1.0), (sa, -1.0), (sa, 1.0), (-sa, 1.0)] {
                let w = h*y + i
                polygon.append(((a*x + b*y + c)/w, (d*x + e*y + f)/w))
            }
        }
        coverageFraction = Self.coverage(polygon, aspect: aspect)
    }

    private static func coverage(_ source: [(Double, Double)], aspect: Double) -> Double {
        var polygon = source
        for (axis, sign, limit) in [(0, 1.0, aspect), (0, -1.0, aspect), (1, 1.0, 1.0), (1, -1.0, 1.0)] {
            let input = polygon; polygon = []
            guard var previous = input.last else { return 0 }
            func distance(_ p: (Double, Double)) -> Double { limit - sign * (axis == 0 ? p.0 : p.1) }
            for current in input {
                let a = distance(previous), b = distance(current)
                if (a >= 0) != (b >= 0) {
                    let t = a / (a-b)
                    polygon.append((previous.0 + t * (current.0-previous.0), previous.1 + t * (current.1-previous.1)))
                }
                if b >= 0 { polygon.append(current) }
                previous = current
            }
        }
        guard let last = polygon.last else { return 0 }
        var previous = last, area = 0.0
        for p in polygon { area += previous.0*p.1 - p.0*previous.1; previous = p }
        return min(1, max(0, abs(area) / (8*aspect)))
    }

    public func project(x: Double, y: Double) -> (x: Double, y: Double)? {
        let w = g*x + h*y + i
        guard w > 1e-9 else { return nil }
        return ((a*x + b*y + c)/w, (d*x + e*y + f)/w)
    }

    public func source(x: Double, y: Double) -> (x: Double, y: Double)? {
        let u = x / targetFocal, v = y / targetFocal
        let xr = cosineRoll*u + sineRoll*v
        let yr = -sineRoll*u + cosineRoll*v
        let z = -sinePitch*yr + cosinePitch
        guard z > 1e-9 else { return nil }
        return (sourceFocal*xr/z, sourceFocal*(cosinePitch*yr + sinePitch)/z)
    }
}

/// Preserve the requested projection whenever it contains an image. At a hard
/// native cutoff, display the nearest covered angle and explicitly report it,
/// instead of silently moving the entire source image outside the viewport.
public struct ProjectionSelection {
    public let requested: PerspectiveFraming
    public let displayed: PerspectiveFraming
    public let displayedPitch: Double
    public let limited: Bool
    public init(nativeFov: Double, requestedFov: Double, nativePitch: Double,
                requestedPitch: Double, roll: Double, aspect: Double, sourceAspect: Double) {
        func framing(_ pitch: Double) -> PerspectiveFraming {
            PerspectiveFraming(nativeFov: nativeFov, requestedFov: requestedFov, nativePitch: nativePitch,
                requestedPitch: pitch, roll: roll, aspect: aspect, sourceAspect: sourceAspect)
        }
        requested = framing(requestedPitch)
        limited = requested.coverageFraction < 0.01
        if !limited { displayed = requested; displayedPitch = requestedPitch; return }
        var fraction = 0.0
        if framing(nativePitch).fullyCovered {
            var high = 1.0
            for _ in 0..<24 {
                let mid = (fraction+high)/2
                if framing(nativePitch + mid*(requestedPitch-nativePitch)).fullyCovered { fraction = mid }
                else { high = mid }
            }
        }
        displayedPitch = nativePitch + fraction*(requestedPitch-nativePitch)
        displayed = framing(displayedPitch)
    }
}
