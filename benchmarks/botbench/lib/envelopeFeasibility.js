// envelopeFeasibility.js — the emerging-threats CONSTRAINED-ENVELOPE EXISTENCE
// test (Codex-designed unified S1'/S2, replacing the retired range-family
// verdict).
//
// THE SOUND QUESTION. Bearings-only data constrains the object to the rays:
// X(f) = S(f) + λ(f)·D(f) for ANY positive range profile λ(f). There is no
// prior-free range interval. So "did the vehicle exceed its envelope?" is
// ill-posed as stated. The well-posed version is an EXISTENCE test:
//
//   α* = min over all smooth on-ray range profiles λ(f) of the PEAK
//        envelope-violation ratio (speed/maxSpeed, |climb|/limit,
//        loadFactor/gMax) over the whole trajectory. α* is the TRUE (unknown)
//        family minimum; the solver returns α̂, an optimizer UPPER-BOUND
//        estimate (α̂ ≥ α*). Every reported/measured value is α̂, never α*.
//
//   α* ≤ 1  ⟹  an in-envelope trajectory explains the sightlines: exceedance
//             is NOT forced (correct abstention, incl. weak geometry where a
//             slow/near explanation always exists).
//   α* > 1  ⟹  EVERY consistent trajectory exceeds the envelope: exceedance is
//             FORCED. Because only α̂ (an upper bound) is observed, α̂ > 1 is
//             EVIDENCE — not proof — of forced exceedance, which is why the
//             binary claim needs a calibrated threshold, not the nominal 1.
//
// The acceptance statistic is HARD catalog limits over the complete
// trajectory. Plausibility preferences (cruise speed, calm wind, straight
// flight) MUST NOT enter — they would bias toward the slow/near reading and
// hide real exceedance. The only regularization is a BANDWIDTH LIMIT on λ(f):
// a smooth spline whose control-point spacing matches the vehicle's maneuver
// timescale, so pointing NOISE cannot masquerade as capability while genuine
// sustained maneuvers survive.
//
// LIMITATION (must be disclosed): the peak ratio uses the smoothed on-ray
// kinematics of a bandwidth-limited spline family. Rejecting it proves "no
// in-envelope trajectory EXISTS IN THIS SMOOTH FAMILY", a strong but not
// absolute statement; a genuinely adversarial control history outside the
// bandwidth could differ. Report α̂ as a model-class feasibility bound, and
// the binding dimension, not an identification.

import {trackMetrics, bsplineBasis, traverseMinSpeed} from "../../../src/TraverseAnalysis";

const G = 9.80665;

// Bump ANY time the α̂ estimator math changes (cost, kinematics, seeds, spline) —
// it invalidates every prior calibration, since the null distribution moves.
// v3.1: metric now horizontal (not 3-D) speed; objective is pure peak (soft
// curvature penalty removed) so objective == reported metric.
export const DETECTOR_VERSION = "alpha-v3.1";

// The resolved detector configuration — the SINGLE SOURCE OF TRUTH used both
// to run the solver and to key a calibration artifact. A calibration is valid
// only against the exact config it was computed under (see configKey).
export function resolveDetectorConfig(options = {}) {
    return {
        detectorVersion: DETECTOR_VERSION,
        bandwidthSec: options.bandwidthSec ?? 3,
        minRange: options.minRange ?? 80,
        maxIter: options.maxIter ?? 800,
        smoothSeconds: 0.5,
        seedRangesM: [200, 800, 3200, 12800, 40000],
        useMinSpeedSeed: true,
    };
}

// Stable, order-independent key for a resolved config — the binding token an
// artifact must match. (n/fps are NOT part of it: bandwidthSec is expressed in
// seconds, so K adapts to clip length by design and the null is comparable.)
export function configKey(cfg) {
    const keys = Object.keys(cfg).sort();
    return keys.map((k) => `${k}=${JSON.stringify(cfg[k])}`).join("|");
}

// Evaluate the on-ray track for a log-range control vector c (λ = exp(B·c)),
// and its peak envelope-violation ratio against a catalog envelope.
function evalRatio(dataset, B, c, envelope, family, minRange) {
    const {n, S, D} = dataset;
    const track = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const [seg, w] = B[f];
        let logLam = 0;
        for (let j = 0; j < 4; j++) logLam += w[j] * c[seg + j];
        const lam = Math.max(minRange, Math.exp(logLam));
        const b = f * 3;
        track[b] = S[b] + lam * D[b];
        track[b + 1] = S[b + 1] + lam * D[b + 1];
        track[b + 2] = S[b + 2] + lam * D[b + 2];
    }
    const km = trackMetrics(dataset, track, {smoothSeconds: 0.5});
    // Hard limits, matching the catalog's own definitions (Codex correctness
    // fix): the catalog maxSpeed/tasMax are HORIZONTAL limits, so the metric
    // must use HORIZONTAL speed — km.airSpeed.max is 3-D and overcounts for a
    // climbing/descending track, inflating α̂ toward false forced-
    // exceedance. Vertical is scored separately against the ascent/descent
    // limit; load factor hypot(1, maneuverG) against structural g.
    const speedLimit = family === "quad" ? envelope.maxSpeed : envelope.tasMax;
    const climbUp = family === "quad" ? envelope.maxAscent : envelope.climbMax;
    const climbDn = family === "quad" ? envelope.maxDescent : envelope.climbMax;
    const horizSpeedMax = peakHorizontalSpeed(track, dataset);
    const speedRatio = horizSpeedMax / speedLimit;
    const climbRatio = Math.max(km.verticalSpeed.max / climbUp,
        Math.max(0, -km.verticalSpeed.min) / climbDn);
    const gRatio = family === "quad" ? 0 : Math.hypot(1, km.gLoad.max) / envelope.gMax;
    const dims = [["speed", speedRatio], ["climb", climbRatio], ["g", gRatio]];
    let peak = 0, binding = "speed";
    for (const [name, r] of dims) if (r > peak) { peak = r; binding = name; }
    return {peak, binding, track, km,
        speedRatio, climbRatio, gRatio};
}

// Peak HORIZONTAL (2-D) speed over a 0.5 s central-difference window — matches
// the catalog's horizontal speed limit (the target's wind is zero in these
// scenarios, so air-relative == ground). Trimmed of the smoothing ends.
function peakHorizontalSpeed(track, dataset) {
    const {n, fps} = dataset;
    const h = Math.max(1, Math.round(0.25 * fps));
    let peak = 0;
    for (let f = h; f < n - h; f++) {
        const dt = 2 * h / fps;
        const vx = (track[(f + h) * 3] - track[(f - h) * 3]) / dt;
        const vy = (track[(f + h) * 3 + 1] - track[(f - h) * 3 + 1]) / dt;
        const s = Math.hypot(vx, vy);
        if (s > peak) peak = s;
    }
    return peak;
}

// Soft-max surrogate of the peak over the three dimensions AND over frames is
// The objective IS the reported metric (Codex correctness fix): minimize the
// peak envelope-violation ratio directly, with NO soft curvature penalty. The
// bandwidth limit is enforced STRUCTURALLY by the B-spline knot count K (one
// knot per ~bandwidthSec), which already prevents the range profile from
// chasing sub-bandwidth pointing jitter. The earlier objective (peak + curvW*
// curvature) traded peak against smoothness, so the reported peak sat ABOVE
// the minimized objective — inflating α̂ toward false forced-exceedance.
// Now min(objective) == min(peak) == α̂, matching the stated feasibility
// test exactly.
export async function minEnvelopeScale(dataset, envelope, family, options = {}) {
    const {n} = dataset;
    // Control-point count from the bandwidth: one knot per ~bandwidthSec, so a
    // 60 s clip at 3 s bandwidth => ~20 knots. Clamped to [6, 30].
    // Resolve the config once (single source of truth for run + key).
    const cfg = options._resolvedConfig ?? resolveDetectorConfig(options);
    const bandwidthSec = cfg.bandwidthSec;
    const fps = dataset.fps;
    const K = Math.max(6, Math.min(30, Math.round(n / (bandwidthSec * fps)) + 3));
    const B = bsplineBasis(n, K);
    const minRange = cfg.minRange;

    const cost = (c) => evalRatio(dataset, B, c, envelope, family, minRange).peak;

    // Seeds: constant range at several distances + the min-speed solution's
    // range profile (the slowest consistent object — a strong feasibility
    // candidate). Each seed is a length-K log-range control vector.
    const seeds = [];
    for (const R of [200, 800, 3200, 12800, 40000]) {
        seeds.push(new Array(K).fill(Math.log(R)));
    }
    try {
        const ms = traverseMinSpeed(dataset, {});
        if (ms && ms.lam) {
            // sample the min-speed range at the K control knots
            const c = new Array(K);
            for (let j = 0; j < K; j++) {
                const f = Math.min(n - 1, Math.round((j / (K - 1)) * (n - 1)));
                c[j] = Math.log(Math.max(minRange, ms.lam[f]));
            }
            seeds.push(c);
        }
    } catch { /* min-speed optional */ }

    const {nelderMead} = require("../../../src/NelderMead");
    let best = null;
    for (const seed of seeds) {
        const res = await nelderMead(cost, seed, {maxIter: cfg.maxIter});
        if (!best || res.cost < best.cost) best = res;
    }
    const final = evalRatio(dataset, B, best.params, envelope, family, minRange);
    return {
        alphaStar: final.peak,             // α̂: optimizer estimate of the min feasible envelope scale α*
        bindingDimension: final.binding,   // which limit forces it
        feasibleInEnvelope: final.peak <= 1,
        speedRatio: final.speedRatio,
        climbRatio: final.climbRatio,
        gRatio: family === "quad" ? null : final.gRatio,
        K, bandwidthSec,
        config: cfg,
        configKey: configKey(cfg),
        optimizerCost: best.cost,
    };
}
