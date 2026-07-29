import {CNodeController} from "./CNodeController";
import {NodeMan, Sit} from "../Globals";
import {par} from "../par";
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
/**
 * Coordinated-turn bank angle, in RADIANS, derived from a track's curvature:
 *     bank = atan(angularVelocity * speed / g)
 * Positive = right wing down. Matches CNodeControllerObjectTilt's "banking" mode.
 *
 * Extracted so the MX-style turret roll (CNodeControllerMXRoll) derives the
 * aircraft's attitude from exactly the same signal this controller does — two
 * different bank numbers driving the same camera would be a subtle and very
 * confusing bug.
 *
 * @param {CNodeTrack} smoothedTrack a SMOOTHED position track; raw tracks make the
 *        finite differences below far too noisy to differentiate twice
 * @param {number} f frame
 * Two DIFFERENT failure outcomes, and the distinction is load-bearing:
 *   null : no usable estimate at all (missing/duplicate samples). Callers should
 *          leave the roll alone — snapping it to level would be a visible jolt.
 *   0    : the wide-baseline samples are unavailable but the track is moving, so
 *          "no measurable turn" is the honest answer. Callers should apply it.
 * This mirrors the original inline code exactly: its early `return`s left the roll
 * untouched, while its `let bankAngle = 0` fallback was applied.
 *
 * @returns {number|null} bank in radians, 0 for "no measurable turn", or null for
 *        "cannot estimate — do not touch the roll"
 */
export function coordinatedTurnBankAngle(smoothedTrack, f) {
    if (!Number.isFinite(f) || f < 0) return null;
    const c0 = smoothedTrack.p(f);
    const c1 = smoothedTrack.p(f + 1);
    if (!c0 || !c1) return null;
    const v0 = c1.clone().sub(c0);
    // NOTE the comparisons below are written as `!(x >= k)` rather than `x < k`.
    // A NaN coordinate (a corrupt or interpolated-off-the-end sample) makes every
    // `<` comparison false, so it would sail through a naive guard and propagate
    // NaN into the camera pose, which is far harder to diagnose than a missing
    // roll. `!(x >= k)` rejects NaN as well as the small values.
    const v0LenSq = v0.lengthSq();
    if (!(v0LenSq >= 0.5)) return null;      // duplicate/stationary, or NaN

    const halfFps = Math.floor((Sit.fps || 30) / 2);
    const a0 = smoothedTrack.p(f - halfFps);
    const a1 = smoothedTrack.p(f - halfFps + 1);
    const b0 = smoothedTrack.p(f + halfFps);
    const b1 = smoothedTrack.p(f + halfFps + 1);
    // Beyond this point the ORIGINAL code fell back to a bank of zero and still
    // applied it, so return 0 rather than null to preserve that behaviour.
    if (!a0 || !a1 || !b0 || !b1) return 0;

    const vA = a1.clone().sub(a0);
    const vB = b1.clone().sub(b0);
    if (!(vA.lengthSq() >= 0.5) || !(vB.lengthSq() >= 0.5)) return 0;

    const speed = v0.length() * Sit.fps;
    if (!(speed >= 0.01)) return 0;

    let angV = vA.angleTo(vB);
    const cross = V3().crossVectors(vA, vB);
    if (cross.dot(getLocalUpVector(c0)) > 0) angV = -angV;
    const bank = Math.atan(angV * speed / 9.77468);
    // Final backstop: never hand a NaN to the camera.
    return Number.isFinite(bank) ? bank : null;
}

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

        // We write into `ptzAngles.roll` (or `.rotation`) as a side channel for
        // the next controller pass to consume. That makes the call non-pure:
        // anything that walks the timeline by calling `camera.update(f)` at
        // arbitrary frames (CNodeLOSFromCamera does this for every LOS sample)
        // would leave the slot holding bank-for-some-other-frame, which then
        // pollutes the live render until the next live-frame apply rewrites it.
        // Skip non-live calls so this controller stays a no-op for queries.
        if (f !== par.frame) return;

        const ptz = NodeMan.list.ptzAngles?.data;
        if (!ptz || ptz.roll === undefined) return;

        // Shared with CNodeControllerMXRoll — see coordinatedTurnBankAngle above.
        // null means "cannot estimate": return WITHOUT writing, leaving the previous
        // roll in place. Mapping it to 0 instead would snap the horizon level on a
        // duplicate track sample, which is exactly what the original inline code
        // avoided by returning early.
        const bankAngle = coordinatedTurnBankAngle(this.smoothedTrack, f);
        if (bankAngle === null) return;

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
