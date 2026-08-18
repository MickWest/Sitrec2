// Angular-size ranging.
//
// Two points a known physical distance apart subtend an angle at the camera, and
// that angle gives the range. This is the same known-reference-length idea used by
// https://github.com/demusis/fotogrametria (applied to the Malvern Hills object on
// Metabunk), reduced to the simple broadside case: we assume the measured segment
// is perpendicular to the line of sight, so its full physical length is visible.
//
// A foreshortened segment subtends a SMALLER angle than it would broadside, so it
// reads as a LONGER range - and therefore a higher speed. Results from this are
// upper estimates under that assumption, not hard bounds: FOV error, endpoint
// marking, motion blur and a wrong assumed size can all push either way.
//
// Deliberately a leaf module, like FOVUtils: it imports nothing, so it stays
// Jest-testable. Importing anything that reaches three/addons would break that.

// Vertical FOV in degrees -> pinhole focal length in pixels, for an image whose
// full height spans heightPx pixels.
export function focalLengthPixels(vFOVDegrees, heightPx) {
    return heightPx / (2 * Math.tan(vFOVDegrees * Math.PI / 180 / 2));
}

function normalize3(v) {
    const len = Math.hypot(v[0], v[1], v[2]);
    if (!(len > 0)) return null;
    return [v[0] / len, v[1] / len, v[2] / len];
}

// Angle in radians between two vectors, each given as [x, y, z]. Not required to
// be unit length.
//
// Uses the chord form rather than acos(dot). At the angles this gets used at - a
// 20 pixel separation at a 2700 pixel focal length is 7 milliradians - dot is
// 1 - 3e-5, and acos there throws away half the mantissa.
export function angleBetween(a, b) {
    const ua = normalize3(a);
    const ub = normalize3(b);
    if (ua === null || ub === null) return NaN;
    const chord = Math.hypot(ua[0] - ub[0], ua[1] - ub[1], ua[2] - ub[2]);
    return 2 * Math.asin(Math.min(1, chord / 2));
}

// Range to either ENDPOINT of a segment of length sizeM whose two endpoints lie on
// rays separated by theta, the segment being perpendicular to the angular bisector:
//
//      A .
//        |\   theta/2
//    S/2 | \
//        |  \            endpoint range = (S/2) / sin(theta/2)
//      M +---\-------- camera
//        |   /          midpoint range = (S/2) / tan(theta/2)
//    S/2 | /
//      B ./
//
// The two differ by a factor of cos(theta/2), which is negligible at small angles
// but they are not the same quantity. Sitrec's tracked point is the A endpoint and
// startDistance is measured along A's line of sight, so the endpoint form is the
// one that matches how the range gets used.
export function endpointRangeFromAngularSize(theta, sizeM) {
    if (!(theta > 0) || !isFinite(theta) || !(sizeM > 0)) return Infinity;
    return (sizeM / 2) / Math.sin(theta / 2);
}

// Range to the MIDPOINT of that same segment, along the bisector.
export function midpointRangeFromAngularSize(theta, sizeM) {
    if (!(theta > 0) || !isFinite(theta) || !(sizeM > 0)) return Infinity;
    return (sizeM / 2) / Math.tan(theta / 2);
}

// Inverse of endpointRangeFromAngularSize: the angle a segment of length sizeM
// subtends when its endpoints are at range rangeM.
export function angularSizeFromRange(rangeM, sizeM) {
    if (!(rangeM > 0) || !(sizeM > 0)) return NaN;
    const halfSin = (sizeM / 2) / rangeM;
    if (halfSin > 1) return NaN;   // segment longer than the diameter it would span
    return 2 * Math.asin(halfSin);
}

// Speed in m/s between two positions given as [x, y, z] in metres.
export function speedBetween(a, b, dtSeconds) {
    if (!isFinite(dtSeconds) || dtSeconds === 0) return NaN;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    return d / Math.abs(dtSeconds);
}

// Unit ray through an image pixel, in a camera frame given by orthonormal
// heading/right/up vectors (each [x, y, z]).
//
// This is a true rectilinear pinhole projection: the image plane sits fpx pixels
// in front of the camera, so the ray is simply the vector from the camera to that
// pixel. dx and dy are pixel offsets from the image centre, with dy measured
// DOWNWARD in the usual image convention.
//
// Note that this is NOT separable into independent yaw and pitch angles. Building
// the ray as "yaw by atan(dx/fpx), then pitch by atan(dy/fpx)" gives an
// equirectangular mapping instead, in which a vertical pixel step subtends the
// same angle everywhere. A real lens compresses it away from the vertical centre
// line, because the ray to an off-axis pixel is longer: the effective focal
// length in that plane is hypot(fpx, dx), not fpx.
export function pinholeRay(heading, right, up, fpx, dx, dy) {
    return normalize3([
        heading[0] * fpx + right[0] * dx - up[0] * dy,
        heading[1] * fpx + right[1] * dx - up[1] * dy,
        heading[2] * fpx + right[2] * dx - up[2] * dy,
    ]);
}
