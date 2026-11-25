import Foundation

/// MapKit's pitch and maximum-zoom restrictions depend on render dimensions.
/// Grow the surface for a clamped pitch, shrink it for a displaced eye, and
/// prefer the best undistorted pose when the two limits cannot both be met.
public enum RenderScaleFitting {
    /// Camera noise and small rotations must not reallocate the render surface.
    /// Widen in discrete steps; compact only after two steps of spare width.
    public static func sourceAspect(required: Double, output: Double) -> Double {
        min(output, max(0.5, ceil(required * 8) / 8))
    }
    public static func shouldCompactAspect(current: Double, candidate: Double) -> Bool {
        current - candidate >= 0.25 - 1e-9
    }
    public struct Measurement {
        public let pitchError, centerError, rangeError: Double
        public init(pitchError: Double, centerError: Double, rangeError: Double) {
            self.pitchError = abs(pitchError)
            self.centerError = abs(centerError)
            self.rangeError = abs(rangeError)
        }
        public var positionFits: Bool { centerError <= 1 && rangeError <= 1 }
        public var fits: Bool { positionFits && pitchError <= 0.05 }
        private var displacement: Double { max(centerError, rangeError) }
        func better(than other: Measurement) -> Bool {
            if positionFits != other.positionFits { return positionFits }
            if positionFits { return pitchError < other.pitchError - 0.01 }
            return displacement < other.displacement - 0.01
        }
    }
    public struct Result {
        public let scale: Double
        public let measurement: Measurement
        public let attempts: Int
    }

    /// Limits are in logical points; MapKit adds the screen's Retina backing.
    public static func scales(width: Double, height: Double) -> [Double] {
        let limit = max(0.5, min(4, 4096 / max(1, max(width, height)),
                                 sqrt(8_388_608 / max(1, width * height))))
        var values = [0.5, 0.625, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4].filter { $0 <= limit }
        if limit - (values.last ?? 0) > 0.01 { values.append(limit) }
        return values
    }

    /// Retain the previous working scale to avoid resizing on every sync tick.
    /// The callback applies and measures the real camera at each candidate size.
    public static func fit(width: Double, height: Double, initialScale: Double,
                           measure: (Double) -> Measurement) -> Result {
        let candidates = scales(width: width, height: height)
        var index = candidates.indices.min { abs(candidates[$0] - initialScale) < abs(candidates[$1] - initialScale) }!
        var visited = Set<Int>(), bestIndex = index, best: Measurement?
        var lastIndex = index, attempts = 0
        while !visited.contains(index) {
            visited.insert(index); lastIndex = index; attempts += 1
            let result = measure(candidates[index])
            let equivalentLargerSurface = best.map {
                result.positionFits && $0.positionFits && abs(result.pitchError - $0.pitchError) <= 0.01
                    && candidates[index] > candidates[bestIndex]
            } ?? false
            if best == nil || result.better(than: best!) || equivalentLargerSurface { best = result; bestIndex = index }
            if result.fits { break }
            let next = index + (result.positionFits ? 1 : -1)
            guard candidates.indices.contains(next) else { break }
            index = next
        }
        // Never leave the renderer at a rejected candidate.
        if bestIndex != lastIndex { attempts += 1; best = measure(candidates[bestIndex]) }
        return Result(scale: candidates[bestIndex], measurement: best!, attempts: attempts)
    }
}
