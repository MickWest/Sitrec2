import {Vector3} from "three";
import {getAzElFromPositionAndForward, getLocalEastVector, getLocalUpVector} from "./SphericalMath";

// The two ends of a measurement stay at least this far apart horizontally (one foot), so a
// measurement always has a length, a heading and a circle, also after the display has put
// both ends at the higher end's altitude.
export const MEASURE_MIN_SEPARATION = 0.3048;

// A unit horizontal direction at `position`: east, or along the prime meridian at a pole, where
// east is undefined (the local north vector is zero there, so east is too).
function horizontalDirection(position, up) {
    const east = getLocalEastVector(position);
    if (east.lengthSq() > 1e-12) return east.normalize();
    return new Vector3(1, 0, 0).addScaledVector(up, -up.x).normalize();
}

// `moving` is the end being placed or dragged; `fixed` is the other end. The moving end is
// returned as is when the ends are far enough apart horizontally, and otherwise pushed out to
// the minimum horizontal separation on the same bearing from the fixed end, keeping its own
// height above or below it. Horizontal rather than 3D because the display projects both ends
// to one altitude, which would collapse an end straight above the other onto it. Coincident
// ends separate eastward.
export function separatedMeasurePoint(moving, fixed, minSeparation = MEASURE_MIN_SEPARATION) {
    const up = getLocalUpVector(fixed);
    const offset = moving.clone().sub(fixed);
    const vertical = offset.dot(up);
    const horizontal = offset.addScaledVector(up, -vertical);
    const distance = horizontal.length();
    if (distance >= minSeparation) return moving.clone();
    // Below a millimetre no bearing means anything. This also covers float noise from ~6e6 m
    // coordinates and the small difference, above the surface, between this up vector and the
    // geodetic vertical that moving an end to another altitude follows.
    const direction = distance > 1e-3 ? horizontal.divideScalar(distance) : horizontalDirection(fixed, up);
    return fixed.clone().addScaledVector(direction, minSeparation).addScaledVector(up, vertical);
}

// Horizontal distance between two ends, in the tangent plane at `a`.
export function horizontalSeparation(a, b) {
    const up = getLocalUpVector(a);
    const offset = b.clone().sub(a);
    return offset.addScaledVector(up, -offset.dot(up)).length();
}

// Whether the ends sit at the minimum separation, which is where an end dropped onto the other
// is held. Releasing the key there removes the measurement.
export function measureEndsTouching(a, b, minSeparation = MEASURE_MIN_SEPARATION) {
    return horizontalSeparation(a, b) <= minSeparation * 1.001;
}

// An end of the V/B measurement that has not been placed. A new sitch holds both ends at the
// ECEF origin, the Earth's center, and a sitch saved while an end was NaN restores it as null.
// Neither has a latitude, so neither may reach altitudeHAE or pointOnSphereBelow:
// ECEFToLLA_radii evaluates atan(0/0) at the origin and returns NaN.
export function isUnplacedMeasurePoint(p) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return true;
    return p.x === 0 && p.y === 0 && p.z === 0;
}

// True heading from A to B, clockwise from local north. Coincident points have no heading.
export function measurementHeading(A, B) {
    const direction = B.clone().sub(A);
    const horizontal = direction.clone().projectOnPlane(getLocalUpVector(A));
    return horizontal.lengthSq() < 1e-10 ? null : getAzElFromPositionAndForward(A, direction)[0];
}

// Offsets from A for a circle with radius |AB|. Its plane contains AB and the local horizontal
// perpendicular to AB, so it passes through B even when the endpoints differ in elevation.
// Keeping the geometry relative to A preserves small measurements in float32 GPU buffers.
export function measurementCircleOffsets(A, B, segments = 256) {
    const radius = B.clone().sub(A);
    const sideways = radius.clone().cross(getLocalUpVector(A));
    if (radius.lengthSq() < 1e-10 || sideways.lengthSq() < 1e-10) return [];
    sideways.normalize().multiplyScalar(radius.length());
    return Array.from({length: segments}, (_, i) => {
        const angle = i * 2 * Math.PI / segments;
        return radius.clone().multiplyScalar(Math.cos(angle)).addScaledVector(sideways, Math.sin(angle));
    });
}
