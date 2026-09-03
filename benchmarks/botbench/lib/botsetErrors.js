// botsetErrors.js — the shared botset error ladder, expressed as a PERCENTAGE
// OF THE FIELD OF VIEW rather than as an absolute angle.
//
// WHY PERCENT AND NOT DEGREES. The field of view is no longer constant across a
// set. angularSize.js sizes it from the target and its range, so the maneuver
// sets span 0.46 deg (a 12 m vehicle at 100 km) to 3.82 deg (a 5 m shape at
// 5 km) — a factor of eight. A fixed 0.15 deg error is therefore 33% of the
// frame in one scenario and 3.9% of it in another. Such a ladder sweeps
// difficulty and geometry together, and no column downstream can separate them
// again.
//
// Percent of frame is also the more honest model of the error itself. An
// operator holds a target near the centre of a display; a tracker's residual
// scales with the pixel. Both quantities are frame-relative, so a frame-relative
// ladder is what a real sensor actually produces.
//
// The absolute angle is not hidden. scenario.json records losError in degrees,
// and every manifest row records the percentage AND the degrees it resolved to.

// The three rungs. 0 is the clean observation — a perfect operator — so the
// ladder starts from no error at all rather than from a small one.
export const BOTSET_ERROR_PCT = [0, 5, 20];

/** Folder name for a rung: 0pct, 5pct, 20pct. */
export function botsetErrorLabel(pct) {
    return `${pct}pct`;
}

// Aguadilla-style operator wobble. Only the amplitude moves with the rung; the
// drift speed, reaction delay and correction behaviour stay at the fixed values
// below, chosen to resemble the operator behaviour seen in that clip. They are
// not a measured calibration, and they differ from the live wobble controller's
// defaults (src/nodes/CNodeControllerTrackingWobble.js).
const WOBBLE_BASE = {driftSpeed: 0.10, reactionTime: 0.4,
    correctionSpeed: 1.0, accuracy: 0.8};

/**
 * WOBBLE ladder — for the maneuver sets. A seeded random walk that recentres,
 * so the error is zero-mean: the kind a fit absorbs best.
 */
export const BOTSET_WOBBLE_LEVELS = BOTSET_ERROR_PCT.map((pct) => ({
    label: botsetErrorLabel(pct),
    pct,
    kind: pct === 0 ? "clean" : "wobble",
    /** The absolute angle this rung reaches at a given field of view. */
    degreesFor: (fovFullDeg) => fovFullDeg * pct / 100,
    observation: (fovFullDeg) => (pct === 0
        ? {kind: "clean", fovFullDeg}
        : {kind: "wobble", fovFullDeg, pctOfFov: pct,
            wobble: {amplitude: fovFullDeg * pct / 100, ...WOBBLE_BASE}}),
}));

/**
 * DRIFT ladder — for the balloon sets. A slow one-way slide off the target.
 * Not zero-mean, and therefore the error a short-clip fit cannot absorb: over
 * 20 s it is indistinguishable from the target genuinely drifting, which is
 * precisely the question a buoyant set exists to ask.
 */
export const BOTSET_DRIFT_LEVELS = BOTSET_ERROR_PCT.map((pct) => ({
    label: botsetErrorLabel(pct),
    pct,
    kind: pct === 0 ? "clean" : "drift",
    degreesFor: (fovFullDeg) => fovFullDeg * pct / 100,
    observation: (fovFullDeg) => (pct === 0
        ? {kind: "clean", fovFullDeg}
        : {kind: "drift", fovFullDeg, pctOfFov: pct,
            driftDeg: fovFullDeg * pct / 100}),
}));

/** Batch folder name for a clip length: batch_20s, batch_300s. */
export function botsetBatchLabel(durationSeconds) {
    return `batch_${durationSeconds}s`;
}
