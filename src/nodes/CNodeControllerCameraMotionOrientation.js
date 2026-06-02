import {CNodeController} from "./CNodeController";
import {getLocalUpVector, getLocalNorthVector} from "../SphericalMath";
import {V3} from "../threeUtils";
import {radians} from "../utils";

// CNodeControllerCameraMotionOrientation
//
// Orients a camera using rotation recovered from video-background egomotion. Reads the
// per-frame accumulated background image rotation (imageRot) from a CNodeCameraMotionTrack
// and applies the corresponding camera roll. Runs after the camera's other controllers, so
// it overrides their orientation when enabled.
//
//   mode "off"   : do nothing (controller disabled).
//   mode "roll"  : keep the camera's existing aim (set by earlier controllers) and add the
//                  recovered roll about the optical axis.
//   mode "fixed" : keep the existing horizontal heading but force a fixed DEPRESSION angle
//                  below the horizon (this.depression, degrees; 90 = straight down/nadir),
//                  then apply the recovered roll.
//
// Absolute pitch/heading are NOT recoverable from background motion, so only roll is "measured";
// depression is a user assumption (defaults to the sitch's real line-of-sight elevation).
// Camera roll is the negative of the background's image rotation (rollSign default -1).
export class CNodeControllerCameraMotionOrientation extends CNodeController {
    constructor(v) {
        super(v);
        this.input("motionTrack");
        this.mode = v.mode ?? "roll";
        this.depression = v.depression ?? 25;   // degrees below horizon (used in "fixed" mode)
        this.rollSign = v.rollSign ?? 1;         // +1 makes the look-camera roll match the video
        this.enabled = v.enabled ?? false;
        this.addSimpleSerial("mode");
        this.addSimpleSerial("depression");
        this.addSimpleSerial("rollSign");
    }

    apply(f, objectNode) {
        if (this.mode === "off") return;
        const cam = objectNode.camera;
        const track = this.in.motionTrack;
        // Clamp the frame index — the motion array length may differ from Sit.frames, and an
        // out-of-range index would throw. Guard imageRot so one bad frame can't bake NaN into the
        // camera matrix (which would corrupt rendering for the rest of the session).
        const maxF = (track.frames || 1) - 1;
        const fi = Math.max(0, Math.min(maxF, Math.floor(f)));
        const m = track.v(fi);
        const imageRot = (m && Number.isFinite(m.imageRot)) ? m.imageRot : 0;
        const roll = this.rollSign * imageRot;

        if (this.mode === "fixed" || this.mode === "nadir") {
            const dep = this.mode === "nadir" ? 90 : this.depression;
            const pos = cam.position;
            const up = getLocalUpVector(pos);

            // Keep the horizontal heading the prior controllers chose (e.g. toward the target).
            cam.updateMatrixWorld();
            const e = cam.matrixWorld.elements;
            const fwd = V3(-e[8], -e[9], -e[10]);
            let fwdH = fwd.sub(up.clone().multiplyScalar(fwd.dot(up)));
            if (fwdH.lengthSq() < 1e-9) fwdH = getLocalNorthVector(pos); // looking straight up/down
            fwdH.normalize();

            const d = radians(dep);
            const newFwd = fwdH.multiplyScalar(Math.cos(d)).sub(up.clone().multiplyScalar(Math.sin(d)));
            cam.up.copy(dep > 85 ? getLocalNorthVector(pos) : up); // avoid lookAt degeneracy at nadir
            cam.lookAt(pos.clone().add(newFwd));
        }

        if (roll !== 0) cam.rotateZ(roll);
        cam.updateMatrixWorld();
    }
}
