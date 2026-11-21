import {getLocalNorthVector, getLocalUpVector} from "./SphericalMath";
import {getTrackAltitudeLock, isAGLLockActive} from "./AltitudeLock";
import {isRoadTrackActive} from "./TrackGround";

// A cabin offset follows the path, independently of where the camera pans.
// X is right, Y is up from the path, and Z is forward. A stopped endpoint uses
// its nearest moving segment, so scrubbing gives the same pose as playback.
// level keeps the heading but ignores the path's slope: Y is then local up.
export function getTrackPositionBasis(track, frame, position, level = false) {
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
    if (level) return {right, up: vertical, forward: vertical.clone().cross(right)};
    const up = right.clone().cross(forward).normalize();
    return {right, up, forward};
}

// A ground lock without Road Track has raw ground heights, so its one-frame slope is
// noise. Its offsets stay level. Road Track smooths the road, so they follow its slope.
function hasLevelOffsets(track) {
    const lock = getTrackAltitudeLock(track);
    return !!lock && isAGLLockActive(lock) && !isRoadTrackActive(lock);
}

export function offsetCameraPosition(position, track, frame, x = 0, y = 0, z = 0) {
    if (x === 0 && y === 0 && z === 0) return position;
    const {right, up, forward} = getTrackPositionBasis(track, frame, position, hasLevelOffsets(track));
    return position.clone().addScaledVector(right, x).addScaledVector(up, y).addScaledVector(forward, z);
}
