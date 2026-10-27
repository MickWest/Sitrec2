// MotionTrackScale.js
//
// Pixel-to-meter scale for "Create Track from Motion" (createTrackFromMotion in
// CMotionAnalysisUI.js): which vertical FOV and which distance to use, and the
// meters per pixel they give.
//
// Deliberately a leaf module (it imports only FOVUtils), so Jest can test the
// choice without loading the Motion Analysis UI. The caller looks the nodes up
// and passes them in.

import {extractFOV} from "./FOVUtils";

export const MOTION_TRACK_DEFAULT_FOV = 30;          // degrees, vertical
export const MOTION_TRACK_DEFAULT_DISTANCE = 1000;   // meters
const MIN_DISTANCE = 1;                              // meters; a shorter range is not a real range

function isValidFOV(fov) {
    return Number.isFinite(fov) && fov > 0 && fov < 180;
}

// Vertical FOV in degrees. The sitch's FOV source at frame 0 first (custom sitches:
// "fovSwitch", the same node the Point Track LOS reads), then the look camera's own
// vertical FOV (its value now, not at frame 0), then the default.
function chooseFOV(fovNode, lookCamera) {
    if (fovNode) {
        try {
            const fov = extractFOV(fovNode.getValueFrame(0));
            if (isValidFOV(fov)) return {fovDegrees: fov, fovSource: `${fovNode.id} at frame 0`};
        } catch (e) { /* not a usable FOV value - fall through */ }
    }
    // camera.fov, not renderedFOV: renderedFOV is widened to fill the look VIEW when the
    // view is taller than the video (CNodeView3D fovOverride), so it is not the video's FOV.
    const cameraFOV = lookCamera?.camera?.fov;
    if (isValidFOV(cameraFOV)) return {fovDegrees: cameraFOV, fovSource: `${lookCamera.id} camera`};
    return {fovDegrees: MOTION_TRACK_DEFAULT_FOV, fovSource: "default"};
}

// Camera-to-origin range at frame 0, i.e. the distance to the thing the track starts from.
// Not usable when the origin IS the camera track (range 0), or the range is not finite or
// shorter than MIN_DISTANCE; the default is used then.
function chooseDistance(originNode, cameraNode) {
    if (originNode && cameraNode && originNode !== cameraNode) {
        try {
            const o = originNode.p(0);
            const c = cameraNode.p(0);
            const range = Math.hypot(o.x - c.x, o.y - c.y, o.z - c.z);
            if (Number.isFinite(range) && range >= MIN_DISTANCE) {
                return {distance: range, distanceSource: `|${originNode.id} - ${cameraNode.id}| at frame 0`};
            }
        } catch (e) { /* no position at frame 0 - fall through */ }
    }
    return {distance: MOTION_TRACK_DEFAULT_DISTANCE, distanceSource: "default"};
}

/**
 * Choose the FOV and distance for a motion track and return the meters per pixel.
 *
 * Sitrec FOV values are VERTICAL, so the FOV spans the image HEIGHT:
 *   metersPerPixel = 2 * distance * tan(vFOV / 2) / imageHeight
 *
 * @param {Object} p
 * @param {Object|null} p.fovNode     the sitch's FOV source ("fovSwitch"), or null
 * @param {Object|null} p.lookCamera  the lookCamera node (fallback FOV), or null
 * @param {Object|null} p.originNode  the node the motion track starts from
 * @param {Object|null} p.cameraNode  the camera position track, or null
 * @param {number} p.imageHeight      height in pixels of the image the motion was measured in
 * @returns {{fovDegrees:number, fovSource:string, distance:number, distanceSource:string, metersPerPixel:number}}
 */
export function motionTrackScale({fovNode, lookCamera, originNode, cameraNode, imageHeight}) {
    const fov = chooseFOV(fovNode, lookCamera);
    const dist = chooseDistance(originNode, cameraNode);
    const fovRadians = fov.fovDegrees * Math.PI / 180;
    const metersPerPixel = 2 * dist.distance * Math.tan(fovRadians / 2) / imageHeight;
    return {...fov, ...dist, metersPerPixel};
}
