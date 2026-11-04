import {getAzElFromPositionAndForward, getLocalUpVector} from "./SphericalMath";

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
