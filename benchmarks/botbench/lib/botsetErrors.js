// botsetErrors.js — the shared botset error ladder: OPERATOR POINTING ERROR IN
// DEGREES, nine rungs from a perfect operator to a two-degree wobble.
//
//   0.0 / 0.01 / 0.02 / 0.05 / 0.1 / 0.2 / 0.5 / 1.0 / 2.0 deg   ->  <E>deg/
//
// A rung is the deadband AMPLITUDE of the operator model in
// src/TrackingWobbleMath.js: the aim drifts off the target as a random walk,
// the operator notices once the error exceeds the amplitude and, after a
// reaction delay, slews back to (nearly) centre; then the drift resumes. That
// is what a human on a joystick does. It is zero-mean and it recentres, which
// separates it from the one-way drift ramp (observation.js kind "drift") that
// an earlier balloon ladder used. Both families now share this one ladder, so
// a balloon result and a maneuver result at the same rung mean the same
// pointing accuracy, and the nine angles match the sets other groups publish.
//
// THE OPERATOR IS SELF-SIMILAR. The drift speed and the recentring slew are
// scaled WITH the amplitude (at the fixed ratios below), while the reaction
// time and the recentring accuracy stay put. A joystick operator works in
// SCREEN space: on a narrower field the same hand motion is a smaller angle,
// and the same on-screen excursion is noticed at a smaller angle. Keeping the
// rates in degrees per second while the amplitude fell to 0.01 deg would have
// let the reaction delay dominate — measured: realized RMS 0.028 deg at the
// "0.01 deg" rung, 0.047 at "0.05", 0.066 at "0.1" — so three rungs would have
// been one error. With the rates scaled, the realized error is proportional to
// the rung at every level: RMS 0.64 x amplitude over 20 s (0.66 x over 300 s),
// peak 1.55-1.6 x amplitude (private/probes/BotsetWobbleScale.test.js).
//
// WHY DEGREES AND NOT PERCENT OF THE FIELD OF VIEW. An earlier ladder (0 / 5 /
// 20 pct of the frame) kept the error frame-relative because angularSize.js
// sizes the maneuver sets' field of view per scenario (0.46-3.82 deg), so one
// angle was a different fraction of the frame in every variant. Absolute
// degrees read directly as a pointing accuracy and compare across sets from
// other groups; the price is that one rung is a different fraction of the
// frame in different scenarios. Every manifest row records the field of view
// beside the rung so a reader can recover that fraction.
//
// FIELD OF VIEW. A frame that cannot hold the wobble masks the target out
// (exportInterchange.invalidFrames), and a set about what the FIT does with
// the error must not turn into a set about lost targets. Each rung therefore
// observes through the family's field of view or WOBBLE_FRAME_FACTOR x the
// amplitude, whichever is wider: the half-frame is then at least 2 x amplitude
// against the measured 1.6 x peak. The balloon family's 3 deg field first
// widens at the 1.0 deg rung (to 4 deg); the maneuver family's narrowest field
// (0.46 deg) at the 0.2 deg rung (to 0.8 deg). The clean rung and every rung
// the family field can hold are unchanged. The field of view lives in
// spec.observation, outside the truth key, so widening never changes truth;
// it does widen the published angular-diameter bound (one IFOV per pixel),
// which the manifest shows.

export const BOTSET_ERROR_DEG = [0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0];

/**
 * Folder name for a rung: 0.0deg, 0.01deg, 0.02deg, 0.05deg, 0.1deg, 0.2deg,
 * 0.5deg, 1.0deg, 2.0deg. Always at least one decimal, so "0" and "1" read as
 * angles rather than as counts.
 */
export function botsetErrorLabel(deg) {
    const s = Number.isInteger(deg) ? deg.toFixed(1) : String(deg);
    return `${s}deg`;
}

// Aguadilla-style operator, shape only: the two rates are multiples of the
// amplitude per second. At an amplitude of 0.15 deg they give the fixed values
// the earlier ladders used (drift 0.10 deg/s, slew 1.0 deg/s), so the operator
// at that amplitude is the one those ladders were calibrated on. Not a measured
// calibration; chosen to resemble the operator behaviour seen in that clip. The
// live wobble controller's defaults differ (src/nodes/CNodeControllerTrackingWobble.js).
const WOBBLE_SHAPE = {
    driftSpeedPerAmplitude: 0.10 / 0.15,        // (deg/s) per deg of amplitude
    correctionSpeedPerAmplitude: 1.0 / 0.15,    // (deg/s) per deg of amplitude
    reactionTime: 0.4,                           // s, fixed
    accuracy: 0.8,                               // 0..1, fixed
};

/** The field of view is at least this many amplitudes wide (see header). */
export const WOBBLE_FRAME_FACTOR = 4;

/** The wobble-model parameters for a rung's amplitude, in degrees. */
export function botsetWobbleParams(amplitudeDeg) {
    return {
        amplitude: amplitudeDeg,
        driftSpeed: amplitudeDeg * WOBBLE_SHAPE.driftSpeedPerAmplitude,
        reactionTime: WOBBLE_SHAPE.reactionTime,
        correctionSpeed: amplitudeDeg * WOBBLE_SHAPE.correctionSpeedPerAmplitude,
        accuracy: WOBBLE_SHAPE.accuracy,
    };
}

/** The field of view a rung is observed through: the family's, or wider. */
export function botsetFovForRung(familyFovDeg, amplitudeDeg) {
    return Math.max(familyFovDeg, WOBBLE_FRAME_FACTOR * amplitudeDeg);
}

/**
 * The ladder. `observation(familyFovDeg)` builds the spec.observation section
 * for a rung; the clean rung keeps the family's field exactly.
 */
export const BOTSET_ERROR_LEVELS = BOTSET_ERROR_DEG.map((deg) => ({
    label: botsetErrorLabel(deg),
    deg,
    kind: deg === 0 ? "clean" : "wobble",
    fovFor: (familyFovDeg) => (deg === 0 ? familyFovDeg : botsetFovForRung(familyFovDeg, deg)),
    observation: (familyFovDeg) => (deg === 0
        ? {kind: "clean", fovFullDeg: familyFovDeg}
        : {kind: "wobble", fovFullDeg: botsetFovForRung(familyFovDeg, deg),
            wobble: botsetWobbleParams(deg)}),
}));

/** Batch folder name for a clip length: batch_20s, batch_300s. */
export function botsetBatchLabel(durationSeconds) {
    return `batch_${durationSeconds}s`;
}
