// CNodeControllerCameraNudge.js
//
// "Nudge camera at": a deterministic damped-spring camera jolt. At nudgeTime
// the camera receives an angular impulse and bounces around before settling —
// the impulse response of an underdamped torsion spring (a bumped tripod),
// with a second slightly detuned axis so the bounce wanders rather than
// oscillating along a line.
//
// Pure function of frame time (no RNG, no wall clock): regression-safe, and
// the Long Exposure renderer (LongExposure.js) re-evaluates nudgeOffsetAngles()
// analytically at sub-frame times to draw smooth light trails. The rotation
// composition contract is intrinsic rotateY(yaw) THEN rotateX(pitch) applied
// after the base pose — the offline splat projection must match exactly.
//
// The controller is attached to the look camera permanently (added last, so it
// applies after the pose controllers) and is a no-op when magnitude is 0 or
// t < nudgeTime. Params live in the shared `nudgeParams` singleton, owned and
// serialized by the Long Exposure manager.

import {CNodeController} from "./CNodeController";
import {Sit} from "../Globals";
import {radians} from "../mathUtils";
import {Quaternion} from "three";

// Shared, GUI-edited parameters (the Long Exposure menu mutates this object).
export const nudgeParams = {
    enabled: false,
    time: 5,          // seconds (sitch time = frame / fps)
    magnitude: 1,     // degrees — PEAK deflection (amplitude is normalized)
    frequency: 3,     // Hz — natural frequency ("elasticity")
    damping: 0.15,    // dimensionless damping ratio ζ (underdamped < 1)
    direction: 0,     // degrees — rotates the yaw/pitch bounce basis
};

export function defaultNudgeParams() {
    return {enabled: false, time: 5, magnitude: 1, frequency: 3, damping: 0.15, direction: 0};
}

// Nudge offset {yaw, pitch} in radians at time t (seconds), pure & deterministic.
// Underdamped impulse response: e^(-ζωn·dt)·sin(ωd·dt), ωd = ωn·sqrt(1-ζ²),
// normalized so the first (largest) swing peaks at exactly `magnitude` degrees.
export function nudgeOffsetAngles(t, p = nudgeParams) {
    if (!p.enabled || !p.magnitude) return null;
    const dt = t - p.time;
    if (dt <= 0) return null;
    const zeta = Math.min(0.99, Math.max(0.005, p.damping));
    const wn = 2 * Math.PI * Math.max(0.01, p.frequency);
    const lambda = zeta * wn;
    const wd = wn * Math.sqrt(1 - zeta * zeta);
    const env = Math.exp(-lambda * dt);
    if (env < 1e-4) return null;     // fully settled
    // normalize amplitude so the analytic peak equals the requested magnitude
    const tPeak = Math.atan(wd / lambda) / wd;
    const peak = Math.exp(-lambda * tPeak) * Math.sin(wd * tPeak);
    const A = radians(p.magnitude) / peak;
    const yaw0 = A * env * Math.sin(wd * dt);
    const pitch0 = 0.8 * A * env * Math.sin(wd * 1.37 * dt + Math.PI / 3);
    const dir = radians(p.direction || 0);
    const c = Math.cos(dir), s = Math.sin(dir);
    return {yaw: c * yaw0 - s * pitch0, pitch: s * yaw0 + c * pitch0};
}

// The nudge offset as a quaternion (local-space, rotateY then rotateX order).
const _qYaw = new Quaternion();
const _qPitch = new Quaternion();
const _Y = {x: 0, y: 1, z: 0};
const _X = {x: 1, y: 0, z: 0};
export function nudgeQuaternion(t, p = nudgeParams) {
    const a = nudgeOffsetAngles(t, p);
    if (!a) return null;
    _qYaw.setFromAxisAngle(_Y, a.yaw);
    _qPitch.setFromAxisAngle(_X, a.pitch);
    return _qYaw.clone().multiply(_qPitch);   // rotateY(yaw) then rotateX(pitch)
}

export class CNodeControllerCameraNudge extends CNodeController {
    constructor(v) {
        super(v);
        this.params = nudgeParams;
        // last quaternion we left the camera with, to detect whether a pose
        // controller has run since (see apply)
        this._postQuat = null;
        this._preQuat = null;
    }

    apply(f, objectNode) {
        const camera = objectNode.camera ?? objectNode._object;
        if (!camera) return;

        // applyControllers can run several times per frame (CNodeLOSFromCamera,
        // re-applies on deserialize, etc.), and some cameras have no pose
        // controller at all. If the camera quaternion is exactly what we left
        // it at, nothing reset the pose since our last apply — un-apply the
        // previous offset first so the nudge can never accumulate.
        if (this._postQuat && camera.quaternion.equals(this._postQuat)) {
            camera.quaternion.copy(this._preQuat);
        }
        this._postQuat = null;

        const a = nudgeOffsetAngles(f / Sit.fps, this.params);
        if (!a) return;

        this._preQuat = camera.quaternion.clone();
        camera.rotateY(a.yaw);
        camera.rotateX(a.pitch);
        camera.updateMatrix();
        this._postQuat = camera.quaternion.clone();
    }
}
