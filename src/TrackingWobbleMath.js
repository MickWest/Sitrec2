// Pure math for the Tracking Wobble camera controller
// (CNodeControllerTrackingWobble). No node-graph or Three.js dependencies, so
// Jest can unit-test the offset series directly.

import {mulberry32} from "./DifferentialEvolution";

// Pure offset-series generator.
//
// params: {seed, amplitude (deg), driftSpeed (deg/s), reactionTime (s),
//          correctionSpeed (deg/s), accuracy (0..1)}
// Returns an array of {pan, tilt} in DEGREES, one entry per frame.
//
// Operator model per time step dt = 1/fps (video time — an operator reacts
// in playback seconds, independent of the sitch's simSpeed):
//   drift:   velocity relaxes toward a wander target that re-randomizes
//            every ~0.4-1.2 s, magnitude ~driftSpeed. Error integrates.
//   notice:  when |error| exceeds amplitude, schedule a correction after
//            reactionTime (with ±30% jitter).
//   correct: slew straight toward an aim point near center — missing by up
//            to (1-accuracy)*amplitude — at ~correctionSpeed, then drift
//            resumes with a fresh wander direction.
//
// Deterministic: same (params, frames, fps) → identical output, always.
export function generateWobbleOffsets(params, frames, fps) {
    const p = params;
    const rand = mulberry32((p.seed >>> 0) || 1);
    const dt = 1 / fps;
    const out = new Array(frames);

    let ex = 0, ey = 0;            // pointing error (deg): x=pan, y=tilt
    let vx = 0, vy = 0;            // drift velocity (deg/s)
    let tvx = 0, tvy = 0;          // wander target velocity
    let nextDirChange = 0;         // seconds
    let reactAt = null;            // seconds — when the correction begins
    let correcting = false;
    let aimX = 0, aimY = 0;
    let corrSpeed = 0;

    for (let f = 0; f < frames; f++) {
        // record the error at this frame, THEN integrate the step toward the
        // next — so frame 0 is exactly centered (operator starts on target)
        out[f] = {pan: ex, tilt: ey};
        const tNow = f * dt;
        if (!correcting) {
            if (tNow >= nextDirChange) {
                const ang = rand() * 2 * Math.PI;
                const mag = p.driftSpeed * (0.5 + rand());
                tvx = Math.cos(ang) * mag;
                tvy = Math.sin(ang) * mag;
                nextDirChange = tNow + 0.4 + rand() * 0.8;
            }
            // relax toward the wander target for a smooth, human-looking drift
            const k = Math.min(1, dt * 3);
            vx += (tvx - vx) * k;
            vy += (tvy - vy) * k;
            ex += vx * dt;
            ey += vy * dt;

            if (reactAt === null && Math.hypot(ex, ey) > p.amplitude) {
                reactAt = tNow + p.reactionTime * (0.7 + 0.6 * rand());
            }
            if (reactAt !== null && tNow >= reactAt) {
                correcting = true;
                reactAt = null;
                const missR = Math.max(0, 1 - p.accuracy) * p.amplitude * rand();
                const missA = rand() * 2 * Math.PI;
                aimX = Math.cos(missA) * missR;
                aimY = Math.sin(missA) * missR;
                // per-correction speed jitter; floor keeps a degenerate
                // correctionSpeed slider value from freezing the state machine
                corrSpeed = Math.max(0.05, p.correctionSpeed * (0.75 + 0.5 * rand()));
            }
        } else {
            const dx = aimX - ex, dy = aimY - ey;
            const dist = Math.hypot(dx, dy);
            const step = corrSpeed * dt;
            if (step >= dist) {
                ex = aimX;
                ey = aimY;
                correcting = false;
                vx = 0;
                vy = 0;
                nextDirChange = tNow;   // fresh wander direction next frame
            } else {
                ex += (dx / dist) * step;
                ey += (dy / dist) * step;
            }
        }
    }
    return out;
}
