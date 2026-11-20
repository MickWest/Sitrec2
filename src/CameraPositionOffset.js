import {getLocalNorthVector, getLocalUpVector} from "./SphericalMath";

// A cabin offset follows the path, independently of where the camera pans.
// X is right, Y is up from the path, and Z is forward. A stopped endpoint uses
// its nearest moving segment, so scrubbing gives the same pose as playback.
export function getTrackPositionBasis(track, frame, position) {
    const vertical = getLocalUpVector(position);
    let forward = getLocalNorthVector(position);
    const last = (track?.frames ?? 0) - 1;
    if (last > 0) {
        const f = Math.max(0, Math.min(last, frame));
        for (let span = 1; ; span = Math.min(last, span * 2)) {
            const delta = track.p(Math.min(last, f + span)).sub(track.p(Math.max(0, f - span)));
            if (delta.lengthSq() > 1e-10) {
                forward = delta.normalize();
                break;
            }
            if (span >= last) break;
        }
    }
    let right = forward.clone().cross(vertical);
    if (right.lengthSq() < 1e-12) {
        right = getLocalNorthVector(position).cross(vertical);
    }
    right.normalize();
    const up = right.clone().cross(forward).normalize();
    return {right, up, forward};
}

export function offsetCameraPosition(position, track, frame, x = 0, y = 0, z = 0) {
    if (x === 0 && y === 0 && z === 0) return position;
    const {right, up, forward} = getTrackPositionBasis(track, frame, position);
    return position.clone().addScaledVector(right, x).addScaledVector(up, y).addScaledVector(forward, z);
}
