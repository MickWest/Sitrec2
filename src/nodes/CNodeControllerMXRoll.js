import {CNodeController} from "./CNodeController";
import {NodeMan} from "../Globals";

import {V3} from "../threeUtils";
import {getLocalUpVector} from "../SphericalMath";
import {CNodeSmoothedPositionTrack} from "./CNodeSmoothedPositionTrack";
import {coordinatedTurnBankAngle} from "./CNodeControllerCameraBankRoll";
import {aircraftUpVector, azElTurretImageRoll, PARALLEL_EPSILON} from "../TurretRoll";

// Rolls the look camera to match an MX-STYLE (azimuth-elevation) ball turret.
//
// WHAT PROBLEM THIS SOLVES
// Sitrec's ATFLIR machinery models a ROLL-NOD pod, whose first gimbal axis is the
// aircraft's longitudinal (nose-tail) axis. A WESCAM MX-style turret is an AZ-EL
// mount: its first axis is the aircraft's VERTICAL, which tilts with bank and pitch.
// Because the turret is bolted to the aircraft the rotations COMPOUND, so the image
// roll is a combined result of the jet's bank and pitch AND the turret's own
// azimuth and elevation — not the bank alone.
//
// The previous approximation (CNodeControllerCameraBankRoll) applied only the bank.
// That happens to agree when looking straight ahead, but it is wrong everywhere
// else — and wrong by a lot: an independent check found the two gimbal types differ
// by ~92 degrees of image roll for one banked, off-axis line of sight.
//
// WHY THE MATHS HERE IS SO SHORT
// An az-el mount's image "up" is always in the plane containing the line of sight
// and the aircraft's vertical — the same thing you see turning your head in a
// cockpit. So no gimbal chain and no inverse solve is needed at run time; see
// src/TurretRoll.js, which documents the derivation and its verification.
//
// IMPORTANT: this is the IDEAL TWO-AXIS geometry. A real MX-10 is a four-axis
// STABILISED turret and may hold its horizon partly or fully level. That is exactly
// why `scale` exists: 1 = a fully unstabilised two-axis mount, 0 = perfectly
// stabilised (no roll at all), in between = partial stabilisation. Match it against
// the actual video rather than assuming 1 is right.
//
// Inputs:
//   track       : the camera/aircraft position track (the platform). The LINE OF
//                 SIGHT is NOT an input - it is read from wherever the heading
//                 controllers have already aimed the camera, so this changes roll only.
//   enabled     : GUIFlag - when false this is a no-op
//   scale       : GUIValue multiplier on the computed roll (see above)
export class CNodeControllerMXRoll extends CNodeController {
    constructor(v) {
        super(v);
        this.input("track");
        this.optionalInputs(["enabled", "scale"]);

        // The bank estimate differentiates position twice, so it needs a smoothed
        // track or it is pure noise. Same window as CNodeControllerCameraBankRoll,
        // so both derive the same attitude from the same signal.
        this.smoothedTrack = new CNodeSmoothedPositionTrack({
            id: this.id + "Smoothed",
            source: this.in.track,
            method: "sliding",
            window: 200,
        });
        this.addInput("smoothedTrack", this.smoothedTrack);

        // Enabled-transition bookkeeping, so switching this off restores the roll the
        // user had before it took over. See the note at the top of apply().
        this.wasEnabled = false;
        this.savedPtzRoll = undefined;
        this.savedPtzRotation = undefined;
    }

    apply(f, objectNode) {
        const enabled = this.in.enabled === undefined || !!this.in.enabled.getValueFrame(f);

        // Turning this OFF has to actually turn it off, which takes explicit work.
        // CNodeControllerPTZUI.syncFromCamera reads the rendered camera back into
        // ptzAngles.roll after every pass, so once we have rolled the camera, OUR
        // roll is sitting in ptz.roll — and TrackToTrack keeps applying it forever,
        // even with this controller disabled. It has also overwritten whatever manual
        // roll the user had set. So on the enabled -> disabled transition, put the
        // user's value back.
        // Restoring ptz.roll alone does NOT work and it is worth saying why: our apply
        // runs before syncFromCamera, which then re-reads the still-rolled camera and
        // puts our roll straight back. The CAMERA has to be levelled on the transition
        // pass; sync then picks up the levelled value and ptz.roll settles by itself.
        // So on disable we run the normal path once with an effective scale of zero.
        // Only the REAL look camera drives the enable/disable bookkeeping.
        // CNodeLOSFromCamera updates a DUMMY camera to sample lines of sight, and if
        // one of those passes consumed the disable transition the real camera would
        // never get its cleanup and would stay rolled with the toggle off.
        const liveCamera = NodeMan.get("lookCamera", false)?.camera;
        const isRealCamera = liveCamera !== undefined && objectNode.camera === liveCamera;

        const disabling = !enabled && this.wasEnabled && isRealCamera;
        if (!enabled && !disabling) return;

        const camera = objectNode.camera;

        if (disabling) {
            // The disable path deliberately needs NOTHING from the track — not the
            // bank, not the smoothed samples. A stationary track, the last frame, or
            // persistently singular geometry must never be able to strand the
            // transition "pending" and leave the camera rolled forever.
            //
            // Restore the roll the user had BEFORE this controller took over, rather
            // than levelling to zero. TrackToTrack applies rotateZ(radians(ptz.roll))
            // after its lookAt, and H(M . Rz(d)) === H(M) - d, so an image roll of
            // -savedPtzRoll is exactly the pose that ptz.roll === savedPtzRoll
            // produces. syncFromCamera then reads that back and lands on the user's
            // own value instead of clobbering it with zero.
            const ptzOff = NodeMan.list.ptzAngles?.data;
            const savedDeg = this.savedPtzRoll ?? 0;
            const losD = V3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
            const upD = getLocalUpVector(camera.position);
            const lrD = V3().crossVectors(losD, upD);
            if (lrD.length() >= PARALLEL_EPSILON * losD.length() * upD.length()) {
                lrD.normalize();
                const luD = V3().crossVectors(lrD, losD).normalize();
                camera.up.copy(luD.applyAxisAngle(losD, -savedDeg * Math.PI / 180));
                camera.lookAt(camera.position.clone().add(losD));
            }
            // Clear the latch even if the pose could not be rebuilt (looking straight
            // up or down): the toggle is off, so we must stop intervening regardless.
            this.wasEnabled = false;
            if (ptzOff && this.savedPtzRoll !== undefined) {
                ptzOff.roll = this.savedPtzRoll;
                if (ptzOff.satellite && ptzOff.rotation !== undefined) {
                    ptzOff.rotation = this.savedPtzRotation ?? ptzOff.rotation;
                    ptzOff._satQuatDirty = true;
                }
            }
            return;
        }

        if (f < 0) return;

        // Capture the user's roll once, on the way in, so it can be restored above.
        if (enabled && isRealCamera && !this.wasEnabled) {
            const ptzOn = NodeMan.list.ptzAngles?.data;
            if (ptzOn) {
                this.savedPtzRoll = ptzOn.roll;
                this.savedPtzRotation = ptzOn.rotation;
            }
            this.wasEnabled = true;
        }

        // IDEMPOTENCE IS MANDATORY HERE. CNode3D.applyControllers may run the whole
        // controller chain many times for a single frame (its runaway guard only
        // trips at 1000). Two earlier attempts failed on this and are worth recording
        // so nobody repeats them:
        //
        //   1. camera.rotateZ(-roll) — a RELATIVE rotation. Re-applying it spun the
        //      view continuously even with playback paused.
        //   2. Writing ptzAngles.roll, as CNodeControllerCameraBankRoll does, and
        //      letting TrackToTrack apply it. That is idempotent, but the value does
        //      not survive: CNodeControllerPTZUI.syncFromCamera runs afterwards from
        //      postApplyControllers and overwrites ptz.roll with the angle it reads
        //      back off the camera. ptz.roll is a round-tripped OUTPUT here, not a
        //      stable input channel.
        //
        // So set the camera's orientation ABSOLUTELY instead: aim along the direction
        // the camera already has, with the up vector the turret would have. Nothing
        // accumulates and nothing downstream can clobber it, because it is recomputed
        // from scratch every pass. This is also why the controller keeps no retained
        // roll: an off-frame probe recomputes the same answer from the same inputs
        // rather than disturbing state a later live frame would read.
        // Aircraft forward: the direction it is actually travelling. Taken from the
        // smoothed track so it agrees with the bank estimate below.
        const sm = this.smoothedTrack;
        const c0 = sm.p(f);
        const c1 = sm.p(f + 1);
        if (!c0 || !c1) return;
        const forward = c1.clone().sub(c0);

        // World vertical AT THE AIRCRAFT. This is why the maths lives in TurretRoll
        // rather than reusing the legacy helpers: we are in ECEF, so "up" varies with
        // position and is emphatically not (0,1,0).
        const worldUp = getLocalUpVector(c0);

        // Aircraft's own up: level-up rotated about forward by the bank. Pitch needs
        // no separate term - it is already carried by `forward`.
        const bank = coordinatedTurnBankAngle(sm, f);
        if (bank === null) return;
        const acUp = aircraftUpVector(forward, worldUp, bank, V3());
        if (acUp === null) return;              // vertical flight; bank is meaningless

        // Line of sight: read the camera's CURRENT forward, i.e. wherever the heading
        // controllers have already aimed it.
        //
        // This deliberately does NOT use a target track. An earlier version took the
        // LOS as (targetTrack - cameraPos) and finished with lookAt(targetPos), which
        // silently re-aimed the camera at the target and so overrode every other
        // heading mode: Manual/PTZ, Celestial Lock, Custom Az/El, the "Stop At" frame
        // freeze in TrackToTrack, and Tracking Wobble's perturbation. This controller
        // must change the ROLL ONLY and leave the aim exactly as it found it.
        //
        // Taken from the quaternion rather than getWorldDirection() because
        // matrixWorld may not have been refreshed since the previous controller wrote
        // the orientation.
        const los = V3(0, 0, -1).applyQuaternion(camera.quaternion);

        // STATELESS BY DESIGN. An earlier version held the last good roll to bridge
        // singular frames, which needed a "is this the live frame?" test to stop
        // exporters and LOS probes from writing to it — and `f === par.frame` is not
        // that test, because the panorama and video exporters set par.frame before
        // updating nodes. Rather than chase a reliable liveness signal, there is no
        // retained value to protect: at a singularity the camera is left exactly as
        // the heading controllers set it. That only happens looking within a fraction
        // of a degree of straight up or straight down, where the roll is genuinely
        // undefined and there is no horizon to align to.
        const roll = azElTurretImageRoll(los, acUp, worldUp);
        if (roll === null) return;

        // Zero on the disabling pass: that levels the camera, which is what lets
        // syncFromCamera settle ptz.roll back down instead of latching our roll.
        const scale = disabling ? 0
            : (this.in.scale !== undefined ? this.in.scale.getValueFrame(f) : 1);

        // Rebuild the camera's up vector directly. Start from the LEVEL up for this
        // line of sight (horizon flat), then rotate it about the line of sight by the
        // turret's roll. Rotating about the LOS cannot change where the camera points,
        // only how the image is oriented around that direction.
        //
        // Rotating levelUp about the LOS by +roll lands exactly on the turret's up:
        //   cross(losN, levelUp) === levelRight, and roll was defined as
        //   atan2(turretUp . levelRight, turretUp . levelUp).
        //
        // `scale` therefore becomes exact rather than a fudge: 1 = the unstabilised
        // two-axis turret, 0 = a perfectly roll-stabilised one (level horizon), and
        // anything between is a real partial rotation, not a blend of two vectors.
        const losN = los.normalize();
        const levelRight = V3().crossVectors(losN, worldUp);
        // A world-vertical line of sight leaves this cross product at zero length, so
        // levelUp and desiredUp would be (0,0,0) — and lookAt() with a zero up vector
        // yields a non-unit quaternion that MOVES the boresight, breaking the
        // roll-only contract this controller exists to honour. There is also no
        // meaningful horizon to roll relative to when looking straight up or down, so
        // the only correct action is to leave the camera exactly as we found it.
        // Use the SAME threshold azElTurretImageRoll applies (~0.05 deg from
        // vertical). A tighter guard here would leave a band where that function has
        // already declared the geometry unusable but this one still normalises a
        // near-degenerate vector, producing wildly unstable roll near zenith/nadir.
        if (levelRight.length() < PARALLEL_EPSILON * losN.length() * worldUp.length()) return;
        levelRight.normalize();
        const levelUp = V3().crossVectors(levelRight, losN).normalize();
        const desiredUp = levelUp.applyAxisAngle(losN, roll * scale);

        // Re-aim along the SAME direction we just read, with the new up. That changes
        // the roll and nothing else: lookAt cannot move the boresight when the point
        // it is given lies on the existing forward ray. Absolute, so it is idempotent
        // however many times the controller chain is re-run.
        //
        // Runs last in the chain, so it supersedes the bank-only approximation in
        // CNodeControllerCameraBankRoll when both are enabled — the intended
        // precedence, since that one is this one's wings-level special case.
        camera.up.copy(desiredUp);
        camera.lookAt(camera.position.clone().add(losN));
    }
}
