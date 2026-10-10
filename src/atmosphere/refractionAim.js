// Aim a camera at where a point is DRAWN.
//
// The scene is drawn lofted by terrestrial refraction, so a camera aimed at a
// point's geometric position looks below the point it shows. The aim is for the
// picture only. Line-of-sight calculations stay geometric: the rotation that takes
// the aim back to the geometric direction goes with the camera
// (camera.userData.geometricAim), and CNodeLOSFromCamera applies it, so a traverse
// along that line still passes through the point. With refraction off, this is a
// plain lookAt and the rotation is null.
//
// Used by the controllers that point a camera at a track (CNodeControllerVarious)
// and by the camera's ground-track switch (CNodeCamera).

import {Quaternion, Vector3} from "three";
import {currentTerrestrialLiftContext} from "./refractionSettings";
import {liftWorldPoint} from "./terrestrialRefraction";

const _drawn = new Vector3();
const _toDrawn = new Vector3();
const _toTarget = new Vector3();

export function lookAtDrawnPosition(camera, targetPos) {
    const context = currentTerrestrialLiftContext(camera.position);
    if (!context) {
        camera.lookAt(targetPos);
        camera.userData.geometricAim = null;
        return;
    }
    liftWorldPoint(context, targetPos, _drawn);
    camera.lookAt(_drawn);
    if (_drawn.equals(targetPos)) {
        camera.userData.geometricAim = null;
        return;
    }
    _toDrawn.subVectors(_drawn, camera.position).normalize();
    _toTarget.subVectors(targetPos, camera.position).normalize();
    camera.userData.geometricAim = (camera.userData.geometricAim ?? new Quaternion())
        .setFromUnitVectors(_toDrawn, _toTarget);
}

/**
 * Turn what was taken from a camera's orientation — world directions (its forward,
 * up, right) or its quaternion — from where the camera is aimed to its geometric line
 * of sight, in place. A camera aimed with lookAtDrawnPosition carries that rotation;
 * any other camera, and every camera with refraction off, carries none, and nothing
 * changes. For the readers that need the line of sight rather than the picture: the
 * line-of-sight node, the ground-track switch, the KML and MISB camera export, and the
 * copy of the camera's angles into the PTZ controller.
 *
 * @param {Camera} camera
 * @param {...(Vector3|Quaternion)} items
 */
export function turnToGeometricAim(camera, ...items) {
    const aim = camera.userData.geometricAim;
    if (!aim) return;
    for (const item of items) {
        if (item.isQuaternion) item.premultiply(aim);
        else item.applyQuaternion(aim);
    }
}
