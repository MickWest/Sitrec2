import {CNodeController} from "./CNodeController";
import {NodeMan, Sit} from "../Globals";
import {V3} from "../threeUtils";
import {getLocalUpVector} from "../SphericalMath";
import {CNodeSmoothedPositionTrack} from "./CNodeSmoothedPositionTrack";

// Drives the PTZ controller's `roll` parameter (in degrees) with a coordinated-
// turn bank angle derived from a track. PTZ's existing roll-application path
// already overrides anything else trying to set camera roll, so writing into
// `ptzAngles.roll` is the cleanest way to make "physics-based bank" survive
// the rest of the controller stack — physics replaces the manual roll the
// user typed in until they toggle this off.
//
// Inputs:
//   track   : position track to derive bank from (the flight-sim camera's
//             smoothed track).
//   enabled : GUIFlag. When false this is a no-op, leaving whatever roll
//             the user has set in PTZ untouched.
//
// Bank-angle formula matches CNodeControllerObjectTilt's "banking" mode:
//   bank = atan(angularVelocity · speed / g) — coordinated-turn assumption.
// Sign is negated when written to PTZ.roll so the camera physically leans
// the same direction as the simulated aircraft (right turn → right side
// down), which renders the horizon tilted opposite the bank — what a pilot
// would see.
export class CNodeControllerCameraBankRoll extends CNodeController {
    constructor(v) {
        super(v);
        this.input("track");
        this.optionalInputs(["enabled"]);

        this.smoothedTrack = new CNodeSmoothedPositionTrack({
            id: this.id + "Smoothed",
            source: this.in.track,
            method: "sliding",
            window: 200,
        });
        this.addInput("smoothedTrack", this.smoothedTrack);
    }

    apply(f, objectNode) {
        if (this.in.enabled !== undefined && !this.in.enabled.getValueFrame(f)) return;
        if (f < 0) return;

        const ptz = NodeMan.list.ptzAngles?.data;
        if (!ptz || ptz.roll === undefined) return;

        const sm = this.smoothedTrack;
        const c0 = sm.p(f);
        const c1 = sm.p(f + 1);
        if (!c0 || !c1) return;
        const v0 = c1.clone().sub(c0);
        if (v0.lengthSq() < 0.5) return;

        let bankAngle = 0;
        const halfFps = Math.floor((Sit.fps || 30) / 2);
        const a0 = sm.p(f - halfFps);
        const a1 = sm.p(f - halfFps + 1);
        const b0 = sm.p(f + halfFps);
        const b1 = sm.p(f + halfFps + 1);
        if (a0 && a1 && b0 && b1) {
            const vA = a1.clone().sub(a0);
            const vB = b1.clone().sub(b0);
            if (vA.lengthSq() >= 0.5 && vB.lengthSq() >= 0.5) {
                const speed = v0.length() * Sit.fps;
                if (speed >= 0.01) {
                    let angV = vA.angleTo(vB);
                    const cross = V3().crossVectors(vA, vB);
                    if (cross.dot(getLocalUpVector(c0)) > 0) angV = -angV;
                    bankAngle = Math.atan(angV * speed / 9.77468);
                }
            }
        }

        // PTZ has two different parameters that look like "roll" depending on
        // the satellite-mode flag:
        //   satellite=false : `roll` is screen-space — applied via
        //                     `camera.rotateZ(radians(roll))` after lookAt.
        //                     Drive that.
        //   satellite=true  : `roll` is the *heading* (Z in the ZXY euler used
        //                     to build the satQuat in the nadir frame).
        //                     Screen-space spin lives in `rotation`. Drive
        //                     that, and mark _satQuatDirty so satQuat gets
        //                     rebuilt from the new value on the next render.
        // Sign: negate so "right turn → right wing down" matches both PTZ
        // application paths and produces a horizon that tilts opposite the
        // bank (pilot-view convention).
        const bankDeg = -bankAngle * 180 / Math.PI;
        if (ptz.satellite) {
            if (ptz.rotation !== undefined) {
                ptz.rotation = bankDeg;
                ptz._satQuatDirty = true;
            }
        } else {
            ptz.roll = bankDeg;
        }
    }
}
