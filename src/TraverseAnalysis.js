import {angularSizeFitEnabled, compileAngularSizeFit, remapAngularSize} from "./AngularSize";
/**
 * TraverseAnalysis.js — physically-motivated analysis of LOS traversals.
 *
 * Given a set of lines of sight (a moving sensor looking at an unknown object),
 * these tools search for and score *physically plausible* trajectories that are
 * consistent with the LOS data. Fit criteria are deliberately soft "targets"
 * (a preferred speed, roughly level flight, low maneuvering g) rather than
 * exact constraints — LOS-only data never uniquely determines a trajectory,
 * so the interesting output is the FAMILY of plausible solutions and how
 * implausible everything else is.
 *
 * Analyzers:
 *   sweepConstAirSpeed  — grid search over (start distance, speed) for the
 *                         constant-air-speed traverse, scored by smoothness.
 *   traversePlausible   — for a given start range, the smoothest LOS-riding
 *                         trajectory with a soft speed target (spline QP + IRLS).
 *   rangeProfile        — traversePlausible swept over range: how much
 *                         maneuvering does each assumed distance REQUIRE?
 *   fitAircraft         — parametric fixed-wing fit (constant horizontal airspeed, slowly
 *                         varying turn rate, constant climb, wind advection)
 *                         via differential evolution + pattern-search polish.
 *   trackMetrics        — per-track physical metrics (speeds, g-load, turn
 *                         rate, altitude, range) used for all scoring.
 *
 * Pure math on flat arrays — no three.js, no DOM, no node graph. The caller
 * builds the dataset (see TraverseAnalysisData.js) in a local ENU frame:
 *
 *   dataset = {
 *     n,   // frame count
 *     fps, // frames per second
 *     S,   // Float64Array(n*3) sensor positions, ENU meters [E,N,U]
 *     D,   // Float64Array(n*3) LOS unit directions, ENU
 *     W,   // Float64Array(n*3) wind displacement per FRAME, ENU meters
 *   }
 *
 * All returned tracks are Float64Array(n*3) of ENU positions.
 */

import {differentialEvolution, mulberry32, patternSearchPolish} from "./DifferentialEvolution";
import {assessBoundPins} from "./BoundedFit";
import {metricSmoothingWindow, trajectorySmoothingSettings} from "./SmoothingPolicy";
import {gpuDifferentialEvolution, resolveGpuBudget} from "./gpu/GpuDifferentialEvolution";
import {buildAircraftKernel, GPU_AIRCRAFT_BUDGET} from "./gpu/AircraftCostKernel";
import {RollingAveragePolyEdge} from "./smoothing";
import {windPriorCost, WIND_PRIOR_SIGMA_MS, datasetWithConstantWind} from "./TraverseWind";

export const KNOTS_TO_MS = 0.514444;
export const METERS_PER_NM = 1852;
const G_ACCEL = 9.81;

// Minimum horizontal speed (m/s), through the air or over the ground, for a
// heading — and therefore a turn rate — to mean anything. See the note in
// trackMetrics: below this, atan2 returns numerical noise and its frame-to-frame
// difference becomes a large fictitious turn rate that feeds
// straightFlightScore, i.e. the search objective.
// Deliberately much lower than compareTrackToTruth's 0.5 m/s display guard,
// because a threshold that high erases real wander on genuinely slow objects
// and makes them read as implausibly straight.
const HEADING_MIN_HORIZ_SPEED = 0.05;
// Mean Earth radius for the tangent-plane curvature corrections (the exact
// local radius differs <0.4%, negligible relative to the correction itself).
export const EARTH_RADIUS_M = 6371000;
const TRACK_METRICS_WORKSPACE = Symbol("track metrics workspace");
const _trackMetricsSupport = new WeakMap();

function trackMetricsSupport(dataset, h) {
    const prior = _trackMetricsSupport.get(dataset);
    if (prior && prior.n === dataset.n && prior.fps === dataset.fps && prior.h === h && prior.W === dataset.W) return prior;
    const {n, fps, W} = dataset;
    const f0 = new Int32Array(n), f1 = new Int32Array(n), dt = new Float64Array(n);
    const wind = new Float64Array(n * 3);
    let wx = 0, wy = 0, wz = 0;
    for (let f = 0; f < n; f++) {
        f0[f] = Math.max(0, f - h);
        f1[f] = Math.min(n - 1, f + h);
        dt[f] = (f1[f] - f0[f]) / fps;
        const b = f * 3;
        wind[b] = wx; wind[b + 1] = wy; wind[b + 2] = wz;
        wx += W[b]; wy += W[b + 1]; wz += W[b + 2];
    }
    const support = {n, fps, h, W, f0, f1, dt, wind};
    _trackMetricsSupport.set(dataset, support);
    return support;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Physical metrics for a candidate track.
 * Velocities are estimated with a central difference over ~smoothFrames so the
 * g-load numbers reflect real maneuvering, not frame-to-frame solver noise.
 * "Air" quantities subtract the cumulative wind drift (i.e. motion through the
 * air mass); heading/turn rate are computed on the air track.
 */
export function trackMetrics(dataset, track, options = {}) {
    const {n, fps, S} = dataset;
    // Differentiate over a physical-time window, not a fixed frame count.  A
    // fixed 15-frame window made the same continuous trajectory produce
    // different g/turn metrics (and therefore a different rank) at 15, 30 and
    // 60 fps.  Preserve the historical ~0.5 s window at 30 fps.

    const h = metricSmoothingWindow(n, fps, options);
    const support = trackMetricsSupport(dataset, h);
    const workspace = options[TRACK_METRICS_WORKSPACE];
    const scratch = (name, length) => {
        if (!workspace) return new Float64Array(length);
        const value = workspace[name];
        if (value?.length === length) return value;
        return (workspace[name] = new Float64Array(length));
    };
    const air = scratch("air", n * 3);
    for (let f = 0; f < n; f++) {
        const b = f * 3;
        air[b] = track[b] - support.wind[b];
        air[b + 1] = track[b + 1] - support.wind[b + 1];
        air[b + 2] = track[b + 2] - support.wind[b + 2];
    }

    // Clamp the half-window so short (but supported, >=10-frame) A-B windows
    // keep a non-empty trimmed stats range below: with h > (n-5)/2 the
    // [h+2, n-h-2) range collapses and every stat silently read as zero, so a
    // violent trajectory "passed the broad screen" at 0 kt / 0.00 g. Short
    // windows now differentiate over the longest window that still leaves
    // interior samples.
    const groundSpeed = scratch("groundSpeed", n), airSpeed = scratch("airSpeed", n);
    const horizontalAirSpeed = scratch("horizontalAirSpeed", n);
    const heading = scratch("heading", n), verticalSpeed = scratch("verticalSpeed", n);
    const groundHeading = scratch("groundHeading", n);
    const altitude = scratch("altitude", n), range = scratch("range", n);
    // G-load differentiates the already-smoothed air velocity below. Keep that
    // velocity from this first pass instead of evaluating the same central
    // differences twice more for every frame. The constant-air sweep calls
    // trackMetrics thousands of times, so those duplicate reads and temporary
    // vector arrays were several seconds of a long-track run.
    const airVX = scratch("airVX", n), airVY = scratch("airVY", n), airVZ = scratch("airVZ", n);
    for (let f = 0; f < n; f++) {
        const f0 = support.f0[f], f1 = support.f1[f], dt = support.dt[f];
        const vg0 = (track[f1 * 3] - track[f0 * 3]) / dt;
        const vg1 = (track[f1 * 3 + 1] - track[f0 * 3 + 1]) / dt;
        const vg2 = (track[f1 * 3 + 2] - track[f0 * 3 + 2]) / dt;
        const va0 = (air[f1 * 3] - air[f0 * 3]) / dt;
        const va1 = (air[f1 * 3 + 1] - air[f0 * 3 + 1]) / dt;
        const va2 = (air[f1 * 3 + 2] - air[f0 * 3 + 2]) / dt;
        airVX[f] = va0; airVY[f] = va1; airVZ[f] = va2;
        groundSpeed[f] = Math.hypot(vg0, vg1, vg2);
        airSpeed[f] = Math.hypot(va0, va1, va2);
        horizontalAirSpeed[f] = Math.hypot(va0, va1);
        // Heading is undefined when there is no horizontal motion to have a
        // heading in: atan2 of two near-zero components returns whatever the
        // numerical noise happens to point at, and since turnRate below is the
        // frame-to-frame difference of this, that noise becomes enormous
        // spurious turn rates on a nearly-stationary candidate. straightFlightScore
        // consumes turnRate.std, so this reaches the SEARCH OBJECTIVE, not just
        // the display. compareTrackToTruth already guards the same computation.
        //
        // The threshold is deliberately far below that sibling's 0.5 m/s: at
        // 0.5 a genuinely wandering slow object (measured: 0.4 m/s air-relative,
        // turnRate.std 9.16) has every frame discarded and reads as perfectly
        // straight — which flatters slow candidates, the exact bias this review
        // is guarding against. 0.05 m/s sits below any real wander and above
        // the numerical floor. NaN (not 0) so stat() skips these frames.
        const horizAir = Math.hypot(va0, va1);
        heading[f] = horizAir > HEADING_MIN_HORIZ_SPEED
            ? Math.atan2(va0, va1) * 180 / Math.PI
            : NaN;
        // The same direction over the ground: the object's absolute horizontal
        // motion, wind included. This is the True heading the analysis
        // reports, because a wind drifter (a balloon) has no heading through
        // the air but a clear one over the ground. Display only: turn rate,
        // and so the search objective, stays on the air heading above.
        const horizGround = Math.hypot(vg0, vg1);
        groundHeading[f] = horizGround > HEADING_MIN_HORIZ_SPEED
            ? Math.atan2(vg0, vg1) * 180 / Math.PI
            : NaN;
        const x = track[f * 3], y = track[f * 3 + 1];
        // Geodetic altitude, not raw ENU z: the tangent plane sits ABOVE the
        // curved Earth away from the origin, so a far point's true altitude is
        // z + rho^2/(2R) (paraboloid approximation of the ellipsoid — exact to
        // centimetres at these ranges). Raw z understated altitude by ~90 ft at
        // 19 km and ~780 ft at 55 km. Vertical speed is the matching derivative.
        altitude[f] = track[f * 3 + 2] + (x * x + y * y) / (2 * EARTH_RADIUS_M);
        verticalSpeed[f] = vg2 + (x * vg0 + y * vg1) / EARTH_RADIUS_M;
        range[f] = Math.hypot(
            track[f * 3] - S[f * 3],
            track[f * 3 + 1] - S[f * 3 + 1],
            track[f * 3 + 2] - S[f * 3 + 2]);
    }

    // maneuvering g from the change in smoothed air velocity
    const gLoad = scratch("gLoad", n);
    for (let f = 0; f < n; f++) {
        const f0 = support.f0[f], f1 = support.f1[f], dt = support.dt[f];
        gLoad[f] = Math.hypot(airVX[f1] - airVX[f0], airVY[f1] - airVY[f0], airVZ[f1] - airVZ[f0])
            / dt / G_ACCEL;
    }

    const turnRate = scratch("turnRate", n);
    for (let f = 1; f < n; f++) {
        // Both endpoints must have a defined heading, or the difference is
        // meaningless. NaN propagates naturally and stat() skips it.
        let dh = heading[f] - heading[f - 1];
        while (dh > 180) dh -= 360;
        while (dh < -180) dh += 360;
        turnRate[f] = dh * fps;
    }
    turnRate[0] = turnRate[1];

    const stat = (arr, lo, hi) => {
        let mn = Infinity, mx = -Infinity, sum = 0, sum2 = 0, c = 0;
        for (let f = lo; f < hi; f++) {
            const v = arr[f];
            if (!isFinite(v)) continue;
            if (v < mn) mn = v;
            if (v > mx) mx = v;
            sum += v; sum2 += v * v; c++;
        }
        // An empty range must read as INVALID (non-finite), never as zeros:
        // zeros are optimistic ("0.00 g passes the broad screen") and the
        // ranking's invalid-metrics guard only trips on non-finite values.
        if (c === 0) return {min: NaN, max: NaN, mean: NaN, rms: NaN, std: NaN};
        const mean = sum / c;
        return {
            min: mn, max: mx, mean,
            rms: Math.sqrt(sum2 / c),
            std: Math.sqrt(Math.max(0, sum2 / c - mean * mean)),
        };
    };
    // trim the smoothing windows at the ends
    const lo = Math.min(h + 2, n >> 1), hi = Math.max(n - h - 2, n >> 1);
    // How much of the window had a defined heading. A true hover legitimately
    // has none, and must not be scored as "invalid metrics" for it: an object
    // that never moves horizontally has a turn rate of zero, not an unknown
    // one. Anything partial keeps the NaN-skipping statistics.
    let headingValid = 0, headingTotal = 0;
    for (let f = lo; f < hi; f++) { headingTotal++; if (isFinite(heading[f])) headingValid++; }
    const turnRateStat = stat(turnRate, lo, hi);
    if (headingTotal > 0 && headingValid === 0) {
        turnRateStat.min = 0; turnRateStat.max = 0; turnRateStat.mean = 0;
        turnRateStat.rms = 0; turnRateStat.std = 0;
    }
    return {
        groundSpeed: stat(groundSpeed, lo, hi),
        airSpeed: stat(airSpeed, lo, hi),
        horizontalAirSpeed: stat(horizontalAirSpeed, lo, hi),
        verticalSpeed: stat(verticalSpeed, lo, hi),
        gLoad: stat(gLoad, lo, hi),
        turnRate: turnRateStat,
        headingValidFrac: headingTotal > 0 ? headingValid / headingTotal : 0,
        groundHeading: headingStats(groundHeading, lo, hi),
        altitude: stat(altitude, lo, hi),
        range: stat(range, lo, hi),
        series: {groundSpeed, airSpeed, heading, groundHeading, verticalSpeed, gLoad, turnRate, altitude, range},
        // Let annotations use exactly the samples used by the summary stats.
        sampleWindow: {lo, hi, frameOffset: 0},
    };
}

/**
 * Track metrics over the longest contiguous run selected by `valid`.
 *
 * Truth tracks can cover only part of the analysis window. Their nodes hold a
 * position outside that interval, so measuring the full array would invent
 * zero-speed ends and acceleration spikes at the validity boundaries. Slice
 * both the evidence and the track to the real overlap before applying the same
 * filtering used for candidate metrics.
 */
export function trackMetricsForValidRun(dataset, track, valid, options = {}) {
    if (!dataset || !track || !valid || valid.length < dataset.n) return null;

    let bestLo = -1, bestHi = -1, bestLength = 0, runLo = -1;
    for (let f = 0; f <= dataset.n; f++) {
        if (f < dataset.n && valid[f]) {
            if (runLo < 0) runLo = f;
            continue;
        }
        if (runLo >= 0 && f - runLo > bestLength) {
            bestLo = runLo;
            bestHi = f - 1;
            bestLength = f - runLo;
        }
        runLo = -1;
    }
    // trackMetrics needs an interior sample after trimming both filtering
    // windows. Seven frames is the smallest run that provides one.
    if (bestLo < 0 || bestHi - bestLo + 1 < 7) return null;
    if (bestLo === 0 && bestHi === dataset.n - 1) return trackMetrics(dataset, track, options);

    const n = bestHi - bestLo + 1;
    const copy3 = (src) => {
        const out = new Float64Array(n * 3);
        for (let i = 0; i < n * 3; i++) out[i] = src[bestLo * 3 + i];
        return out;
    };
    const slicedDataset = {
        ...dataset,
        n,
        S: copy3(dataset.S),
        D: copy3(dataset.D),
        W: copy3(dataset.W),
    };
    const metrics = trackMetrics(slicedDataset, copy3(track), options);
    metrics.sampleWindow.frameOffset = bestLo;
    return metrics;
}

/**
 * Circular mean and range of a compass-heading series, in degrees, over
 * frames [lo, hi). NaN frames (no horizontal motion) are skipped.
 *
 * Headings wrap at 360, so the ordinary mean and min/max are wrong for a path
 * that crosses north: 350° and 010° would average to 180° and span 340°. The
 * mean here is the direction of the summed unit vectors, and the range comes
 * from each frame's signed offset from that mean, wrapped to ±180°, so a
 * heading that wanders across north reads as the narrow band it is.
 *
 * Returns {mean, min, max, spread, resultant, validFrac}: mean/min/max are
 * compass headings in [0, 360), spread is the width of the range in degrees,
 * and resultant is the length of the mean unit vector, from 0 to 1 — at
 * constant speed, the net travel as a share of the path length. Near 1 the
 * headings agree; near 0 they cancel out (a circling or back-and-forth
 * object), the mean is whatever direction the rounding left, and a caller
 * must not show it as a direction of travel. validFrac is the share of the
 * frames that had a heading. All but validFrac are NaN when no frame has one.
 */
export function headingStats(heading, lo, hi) {
    let sumE = 0, sumN = 0, count = 0;
    for (let f = lo; f < hi; f++) {
        if (!isFinite(heading[f])) continue;
        const rad = heading[f] * Math.PI / 180;
        sumE += Math.sin(rad);
        sumN += Math.cos(rad);
        count++;
    }
    if (count === 0) return {mean: NaN, min: NaN, max: NaN, spread: NaN, resultant: NaN, validFrac: 0};
    const mean = Math.atan2(sumE, sumN) * 180 / Math.PI;
    let lowOffset = Infinity, highOffset = -Infinity;
    for (let f = lo; f < hi; f++) {
        if (!isFinite(heading[f])) continue;
        let offset = heading[f] - mean;
        offset -= 360 * Math.round(offset / 360);
        if (offset < lowOffset) lowOffset = offset;
        if (offset > highOffset) highOffset = offset;
    }
    const compass = (deg) => ((deg % 360) + 360) % 360;
    return {
        mean: compass(mean),
        min: compass(mean + lowOffset),
        max: compass(mean + highOffset),
        spread: highOffset - lowOffset,
        resultant: Math.hypot(sumE, sumN) / count,
        validFrac: count / (hi - lo),
    };
}

/**
 * Mean angular error (radians) between a track and the camera LOS rays. An
 * optional `valid` mask (truthy per frame) restricts the average to the frames
 * the track actually covers — a track that does not span the whole analysis
 * window holds/clamps its missing frames, and those held positions would
 * otherwise contribute garbage angles to the mean.
 */
export function meanAngularError(dataset, track, valid = null) {
    // S = sensor (camera) position per frame, D = OBSERVED sightline per frame
    // as a unit vector.  Both are flat Float64Array(n*3) in the dataset's local
    // ENU metres (origin at the clip's mean sensor position), same layout and
    // frame grid as `track`.
    const {n, S, D} = dataset;
    // MEAN of absolute per-frame angles, not RMS.  This deliberately matches
    // the fitters' cost function (LOSFitting: meanAngularErrorDegrees/errSigma)
    // — scoring a solution on a different statistic than the search minimised
    // would let one candidate win the search and lose the report.
    //
    // Frames therefore combine L1 (least-absolute-deviations, median-like)
    // rather than L2/least-squares: a lost-lock frame 50x the typical error
    // costs 50x a normal frame, not 50^2.  So a single bad tracking frame
    // neither drags the fit nor dominates the number.  Note that
    // fitConstAltitude squares the value returned here, so that a
    // smooth-but-off-ray path is penalised sharply enough to lose; that shapes
    // how the term trades against the rest of its score, but reweights no
    // individual frame, since the averaging has already happened.
    let sum = 0, count = 0;
    for (let f = 0; f < n; f++) {
        // skip invalid frames
        if (valid && !valid[f]) continue;
        // Flat xyz triples, so frame f starts at 3f.
        const b = f * 3;
        // The sightline this candidate IMPLIES: sensor -> where the candidate
        // says the object was, at this same frame.  Compared against D below,
        // the angle between them is this frame's residual.
        let rx = track[b] - S[b], ry = track[b + 1] - S[b + 1], rz = track[b + 2] - S[b + 2];
        const rl = Math.hypot(rx, ry, rz);
        // Counted BEFORE the degeneracy check so a degenerate frame still
        // divides into the mean — otherwise a track that collapses onto the
        // camera could score well simply by contributing fewer frames.
        count++;
        // Candidate sits on the camera: the implied direction is undefined, so
        // there is no angle to measure.  Charge the worst possible error (PI)
        // rather than skipping, which keeps such a track from ranking at all.
        if (rl < 1e-9) { sum += Math.PI; continue; }
        rx /= rl; ry /= rl; rz /= rl;
        // Both unit vectors now, so the dot product is the cosine of the angle
        // between them.  Clamp because rounding can push it a few ulp outside
        // [-1, 1], where acos returns NaN and poisons the whole mean.
        const dot = Math.min(1, Math.max(-1, rx * D[b] + ry * D[b + 1] + rz * D[b + 2]));
        // acos amplifies input error by ~1/sqrt(1-dot^2) near dot=1, which at
        // typical residuals (~0.05 deg) is a factor of ~1000.  Harmless here:
        // against a double's ~1e-16 that is ~1e-13 rad of noise on a ~1e-3 rad
        // signal.  It would NOT be harmless in float32.
        sum += Math.acos(dot);
    }
    // NaN rather than 0 when nothing was counted — an empty average is "no
    // measurement", and 0 would read as a perfect fit.
    return count > 0 ? sum / count : NaN;
}


/**
 * Compare a candidate track against a ground-truth reference track, both as
 * flat Float64Array(n*3) ENU positions on the SAME dataset frame grid.
 *
 * truth = {track: Float64Array(n*3), valid?: Uint8Array(n)} — `valid` marks
 * frames where the truth source actually has data (e.g. the truth track's
 * time span may not cover the whole analysis window); omitted = all valid.
 *
 * Speeds/headings are differentiated over the same ~0.5 s physical window as
 * trackMetrics so the comparison reflects real motion, not frame noise.
 * Headings are compared only where BOTH tracks move horizontally (>0.5 m/s);
 * a hovering truth object has no meaningful heading.
 *
 * Returns {comparable:false, ...} with fewer than 5 usable frames, else a
 * record whose `score` (mean 3D separation, meters — lower is better) is the
 * truth-mode rank driver, plus per-aspect aggregates for the prose.
 */
export function compareTrackToTruth(dataset, track, truth, options = {}) {
    const {n, fps, S} = dataset;
    const T = truth.track;
    const valid = truth.valid || null;
    const ok = (f) => !valid || valid[f] === 1;

    const smoothFrames = Math.max(3, Math.round((options.smoothSeconds ?? 0.5) * fps));
    const h = Math.max(1, Math.min(Math.floor(smoothFrames / 2), Math.floor((n - 1) / 2)));
    const vel = (arr, f0, f1) => {
        const dt = (f1 - f0) / fps;
        return [
            (arr[f1 * 3] - arr[f0 * 3]) / dt,
            (arr[f1 * 3 + 1] - arr[f0 * 3 + 1]) / dt,
            (arr[f1 * 3 + 2] - arr[f0 * 3 + 2]) / dt,
        ];
    };

    let count = 0, sumSep = 0, maxSep = 0, sumHoriz = 0;
    let sumAltAbs = 0, sumAltSigned = 0, sumRange = 0;
    let velCount = 0, sumSpeedAbs = 0, sumTruthSpeed = 0;
    let hdgCount = 0, sumHdgAbs = 0;

    for (let f = 0; f < n; f++) {
        if (!ok(f)) continue;
        const b = f * 3;
        const dx = track[b] - T[b];
        const dy = track[b + 1] - T[b + 1];
        const dz = track[b + 2] - T[b + 2];
        const sep = Math.hypot(dx, dy, dz);
        if (!isFinite(sep)) continue;
        count++;
        sumSep += sep;
        if (sep > maxSep) maxSep = sep;
        sumHoriz += Math.hypot(dx, dy);
        sumAltAbs += Math.abs(dz);
        sumAltSigned += dz;
        sumRange += Math.hypot(T[b] - S[b], T[b + 1] - S[b + 1], T[b + 2] - S[b + 2]);

        // velocity window: truth validity is a contiguous time range, so valid
        // endpoints imply a valid interior
        const f0 = Math.max(0, f - h), f1 = Math.min(n - 1, f + h);
        if (f1 > f0 && ok(f0) && ok(f1)) {
            const vT = vel(T, f0, f1), vH = vel(track, f0, f1);
            const sT = Math.hypot(vT[0], vT[1], vT[2]);
            const sH = Math.hypot(vH[0], vH[1], vH[2]);
            if (isFinite(sT) && isFinite(sH)) {
                velCount++;
                sumSpeedAbs += Math.abs(sH - sT);
                sumTruthSpeed += sT;
                if (Math.hypot(vT[0], vT[1]) > 0.5 && Math.hypot(vH[0], vH[1]) > 0.5) {
                    const hdgT = Math.atan2(vT[0], vT[1]) * 180 / Math.PI;
                    const hdgH = Math.atan2(vH[0], vH[1]) * 180 / Math.PI;
                    const d = ((hdgH - hdgT + 540) % 360) - 180;
                    hdgCount++;
                    sumHdgAbs += Math.abs(d);
                }
            }
        }
    }

    if (count < 5) {
        return {
            comparable: false,
            framesUsed: count,
            note: "truth track does not usefully overlap the analysis window",
        };
    }
    return {
        comparable: true,
        framesUsed: count,
        frames: n,
        score: sumSep / count,                       // mean 3D separation, m
        sep3D: {mean: sumSep / count, max: maxSep},
        horizontal: {mean: sumHoriz / count},
        altitude: {meanAbs: sumAltAbs / count, meanSigned: sumAltSigned / count},
        speed: velCount
            ? {meanAbsDiff: sumSpeedAbs / velCount, truthMean: sumTruthSpeed / velCount}
            : null,
        heading: hdgCount ? {meanAbsDiff: sumHdgAbs / hdgCount, frames: hdgCount} : null,
        meanTruthRange: sumRange / count,
    };
}

/**
 * Compare a REQUIRED horizontal-wind series (the wind a free-wind balloon fit
 * needs at each sample in order to drift as fitted) against an OBSERVED series
 * (an external wind reference sampled at the same places/times), as full E/N
 * VECTORS — never as mean speeds or a single correlation, which both hide
 * real disagreement (equal speeds in opposite directions; time-varying errors
 * cancelling into a matching mean).
 *
 * required / observed: arrays of {u, v} in m/s (E, N), or null/non-finite for
 * samples with no data — such samples are skipped and reported via coverage.
 *
 * Pure metric only: no wind-source classification, no verdict wording, no
 * thresholds beyond the calm cutoff. The caller owns interpretation, because
 * "3 m/s RMSE" means different things against a nearby sounding versus a
 * hand-set constant.
 *
 * Returns {comparable:false, reason, count, total, coverage, minPairs} with
 * fewer than minPairs usable pairs — structured rather than null, so a caller
 * freezing evidence can still record HOW it failed. Else comparable:true plus:
 *   count / coverage        usable pairs, and their fraction of the series
 *   vectorRMSE              sqrt(mean |required - observed|^2), m/s
 *   meanRequiredSpeed, meanObservedSpeed, speedBias (required - observed), m/s
 *   alignment               magnitude-weighted mean cosine, computed ONLY over
 *                           pairs where BOTH winds exceed calmThresholdMs — a
 *                           calm vector has no meaningful direction, so calm
 *                           pairs must not be allowed to claim agreement.
 *                           null when no such pair exists (dirSamples === 0)
 *   meanAbsDirDiffDeg       mean |direction difference| over those same
 *                           above-calm pairs; null if none
 *   dirSamples              how many samples the direction stats used
 *   bothMeanCalm            true when both series' MEAN speeds are below the
 *                           calm threshold. Means only — individual gusts may
 *                           still exceed it (check dirSamples), so this alone
 *                           never proves "both stayed calm"
 *   temporalCorrelation     centered Pearson correlation of the E/N components
 *                           over time, reported ONLY when both series actually
 *                           vary (else null) — a static profile must not be
 *                           presented as measured temporal agreement
 *   requiredVaries / observedVaries   whether each centered series varies
 *                           enough for that statistic: pooled-component RMS of
 *                           the centered E and N series (energy spread over
 *                           both axes, so one-axis variation needs ~1.4x the
 *                           floor) must exceed varianceFloorMs
 */
export function compareWindVectorSeries(required, observed, options = {}) {
    // Options are clamped to sane values: a negative or NaN threshold must not
    // silently turn constants into "varying" series or admit empty comparisons.
    const nonneg = (v, dflt) => (Number.isFinite(v) && v >= 0 ? v : dflt);
    const calmMs = nonneg(options.calmThresholdMs, 2);
    const minPairs = Math.max(1, Math.round(nonneg(options.minPairs, 3)));
    const varianceFloorMs = nonneg(options.varianceFloorMs, 0.5);
    const total = Math.max(required?.length ?? 0, observed?.length ?? 0);
    const n = Math.min(required?.length ?? 0, observed?.length ?? 0);

    let count = 0, sumSq = 0;
    let sumReqSpeed = 0, sumObsSpeed = 0;
    let sumDot = 0, sumMag = 0;
    let dirCount = 0, sumAbsDirDiff = 0;
    const reqU = [], reqV = [], obsU = [], obsV = [];

    for (let i = 0; i < n; i++) {
        const r = required[i], o = observed[i];
        if (!r || !o || !Number.isFinite(r.u) || !Number.isFinite(r.v)
            || !Number.isFinite(o.u) || !Number.isFinite(o.v)) continue;
        count++;
        const du = r.u - o.u, dv = r.v - o.v;
        sumSq += du * du + dv * dv;
        const rs = Math.hypot(r.u, r.v), os = Math.hypot(o.u, o.v);
        sumReqSpeed += rs;
        sumObsSpeed += os;
        if (rs > calmMs && os > calmMs) {
            // Direction-bearing stats (alignment included) come ONLY from
            // pairs where both vectors are strong enough to HAVE a direction —
            // otherwise a series of matched calms reads as perfect agreement.
            sumDot += r.u * o.u + r.v * o.v;
            sumMag += rs * os;
            let d = (Math.atan2(r.u, r.v) - Math.atan2(o.u, o.v)) * 180 / Math.PI;
            d = ((d + 540) % 360) - 180;
            dirCount++;
            sumAbsDirDiff += Math.abs(d);
        }
        reqU.push(r.u); reqV.push(r.v);
        obsU.push(o.u); obsV.push(o.v);
    }
    if (count < minPairs) {
        return {
            comparable: false,
            reason: "insufficient-pairs",
            count, total,
            coverage: count / Math.max(1, total),
            minPairs,
        };
    }

    const meanRequiredSpeed = sumReqSpeed / count;
    const meanObservedSpeed = sumObsSpeed / count;

    // Centered temporal-pattern correlation over the concatenated E and N
    // component series. Guarded on BOTH series varying: correlating against a
    // constant is undefined, and a static sounding correlating at 1.0 with a
    // static fit would falsely read as "measured temporal agreement".
    const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    const center = (a) => { const m = mean(a); return a.map((x) => x - m); };
    const rc = [...center(reqU), ...center(reqV)];
    const oc = [...center(obsU), ...center(obsV)];
    const std = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
    const requiredVaries = std(rc) > varianceFloorMs;
    const observedVaries = std(oc) > varianceFloorMs;
    let temporalCorrelation = null;
    if (requiredVaries && observedVaries) {
        let dot = 0, r2 = 0, o2 = 0;
        for (let i = 0; i < rc.length; i++) {
            dot += rc[i] * oc[i];
            r2 += rc[i] * rc[i];
            o2 += oc[i] * oc[i];
        }
        temporalCorrelation = dot / Math.sqrt(r2 * o2);
    }

    return {
        comparable: true,
        count,
        total,
        coverage: count / Math.max(1, total),
        vectorRMSE: Math.sqrt(sumSq / count),
        meanRequiredSpeed,
        meanObservedSpeed,
        speedBias: meanRequiredSpeed - meanObservedSpeed,
        alignment: (dirCount && sumMag > 0) ? sumDot / sumMag : null,
        meanAbsDirDiffDeg: dirCount ? sumAbsDirDiff / dirCount : null,
        dirSamples: dirCount,
        bothMeanCalm: meanRequiredSpeed <= calmMs && meanObservedSpeed <= calmMs,
        temporalCorrelation,
        requiredVaries,
        observedVaries,
        // Every threshold the numbers depended on, frozen with them.
        calmThresholdMs: calmMs,
        minPairs,
        varianceFloorMs,
    };
}

// ---------------------------------------------------------------------------
// Constant-speed traverse (mirrors CNodeLOSTraverseConstantSpeed)
// ---------------------------------------------------------------------------

/**
 * Constant air- (or ground-) speed traverse: walk the LOS rays keeping the
 * per-frame step (minus wind, for air speed) equal to speed/fps.
 * speedMs > 0 starts moving away from the sensor.
 * Returns {track, badFrames} — badFrames counts frames where constant speed
 * could not be maintained (no ray-sphere intersection).
 */
export function traverseConstSpeed(dataset, startDist, speedMs, options = {}) {
    const {n, fps, S, D, W} = dataset;
    const airSpeed = options.airSpeed ?? true;
    const track = new Float64Array(n * 3);
    const perFrameMotion = Math.abs(speedMs) / fps;
    const movingAway = speedMs > 0;
    let badFrames = 0;
    let px = S[0] + D[0] * startDist,
        py = S[1] + D[1] * startDist,
        pz = S[2] + D[2] * startDist;
    track[0] = px; track[1] = py; track[2] = pz;
    for (let f = 1; f < n; f++) {
        const b = f * 3;
        const ox = S[b], oy = S[b + 1], oz = S[b + 2];
        const dx = D[b], dy = D[b + 1], dz = D[b + 2];
        const wx = W[b], wy = W[b + 1], wz = W[b + 2];
        const lx = px, ly = py, lz = pz;
        let t = (lx - ox) * dx + (ly - oy) * dy + (lz - oz) * dz;
        if (t < 0) t = 0;
        const cx = ox + dx * t, cy = oy + dy * t, cz = oz + dz * t;
        // binary search the step length (same scheme as the traverse node)
        let A = perFrameMotion / 8, B = perFrameMotion * 8 + 1;
        let bad = false;
        let qx = cx, qy = cy, qz = cz;
        while (Math.abs(A - B) > 0.00001) {
            const mid = (A + B) / 2;
            const mx = ox - lx, my = oy - ly, mz = oz - lz;
            const bq = mx * dx + my * dy + mz * dz;
            const cq = mx * mx + my * my + mz * mz - mid * mid;
            const disc = bq * bq - cq;
            if (disc >= 0) {
                const sq = Math.sqrt(disc);
                const s = movingAway ? (-bq + sq) : (-bq - sq);
                qx = ox + dx * s; qy = oy + dy * s; qz = oz + dz * s;
                bad = false;
            } else {
                qx = cx; qy = cy; qz = cz;
                bad = true;
            }
            let vx = qx - lx, vy = qy - ly, vz = qz - lz;
            if (airSpeed) { vx -= wx; vy -= wy; vz -= wz; }
            if (Math.hypot(vx, vy, vz) < perFrameMotion) A = mid; else B = mid;
        }
        if (bad) badFrames++;
        px = qx; py = qy; pz = qz;
        track[b] = px; track[b + 1] = py; track[b + 2] = pz;
    }
    return {track, badFrames};
}

/**
 * Constant-altitude traverse: the object stays at a fixed height (ENU up = z),
 * so each frame's position is where that LOS ray crosses the plane z = altZ.
 * (Over these local ranges the tangent-plane z is a good stand-in for geodetic
 * altitude — curvature drop is metres.) badFrames counts near-horizontal rays
 * that don't reach the plane at a positive range.
 */
export function traverseConstAltitude(dataset, altZ) {
    // Intersect each ray with the CURVED constant-geodetic-altitude surface
    // z(x,y) = altZ - (x^2+y^2)/(2R) (paraboloid approximation of the
    // constant-HAE shell — exact to centimetres at these ranges). The old flat
    // z = altZ plane sits ~28 m above the true shell at 19 km and ~237 m at
    // 55 km, which both skewed the fitted altitude and made this track diverge
    // from the applied live method (CNodeLOSTraverseConstantAltitude rides the
    // true ellipsoid shell). Quadratic in ray parameter t:
    //   t^2 (Dx^2+Dy^2) + 2t (Sx Dx + Sy Dy + R Dz) + (Sx^2+Sy^2 + 2R (Sz - altZ)) = 0
    const {n, S, D} = dataset;
    const R = EARTH_RADIUS_M;
    const track = new Float64Array(n * 3);
    let badFrames = 0;
    let lastT = null;
    for (let f = 0; f < n; f++) {
        const b = f * 3;
        const sx = S[b], sy = S[b + 1], sz = S[b + 2];
        const dx = D[b], dy = D[b + 1], dz = D[b + 2];
        const a = dx * dx + dy * dy;
        const bq = 2 * (sx * dx + sy * dy + R * dz);
        const cq = sx * sx + sy * sy + 2 * R * (sz - altZ);
        let t = null;
        if (a < 1e-12) {
            // vertical ray: linear equation
            if (Math.abs(bq) > 1e-9) t = -cq / bq;
        } else {
            const disc = bq * bq - 4 * a * cq;
            if (disc >= 0) {
                const sq = Math.sqrt(disc);
                const t1 = (-bq - sq) / (2 * a);
                const t2 = (-bq + sq) / (2 * a);
                // nearest intersection IN FRONT of the sensor
                t = t1 > 0 ? t1 : (t2 > 0 ? t2 : null);
            }
        }
        if (t === null || t <= 0) { t = lastT ?? 0; badFrames++; }
        lastT = t;
        track[b] = sx + dx * t;
        track[b + 1] = sy + dy * t;
        track[b + 2] = sz + dz * t;
    }
    return {track, badFrames};
}

/**
 * Find the constant altitude whose LOS-riding track requires the least
 * horizontal maneuvering. Sweeps the altitude band spanned by the plausible
 * range window (at the mid frame), then bisection-refines.
 *
 * Scoring rides a lightly SMOOTHED copy of the exact-ray track (the
 * traverseMinSpeed recipe): the exact-ray track inherits LOS pointing jitter
 * as range- and fps^2-amplified fake g-load, which used to poison the score
 * at the CORRECT altitude and hand the win to a smoother wrong-altitude
 * corkscrew. A residual-LOS term ((errDeg/sigmaLOSDeg)^2) keeps the smoothed
 * copy honest — a smooth-but-off-ray path can't win either.
 *
 * options: {rangeMin (m), rangeMax (m), samples, sigmaLOSDeg}
 * Returns {altZ, startDist (m), track (smoothed), trackExact (on-ray twin),
 *          errDeg, score, badFrames, failed, metrics}. `failed` is the
 *          degenerate-geometry guard: near-horizontal sightlines never cross
 *          a constant-altitude plane, so the hypothesis is meaningless.
 *          startDist is measured on the EXACT-ray track so applyHypothesis's
 *          startDistance -> live-node altitude round-trip stays exact.
 */
export function fitConstAltitude(dataset, options = {}) {
    const sizeCost = compileAngularSizeFit(dataset);
    const {n, fps, S, D} = dataset;
    const rangeMin = options.rangeMin ?? 0.5 * METERS_PER_NM;
    const rangeMax = options.rangeMax ?? 60 * METERS_PER_NM;
    const samples = options.samples ?? 24;
    const sigmaLOSDeg = options.sigmaLOSDeg ?? 0.05;
    const mid = Math.floor(n / 2);
    // altitude reached at the mid-frame for the range-band endpoints
    // geodetic altitude reached at range R along the mid ray (matches the
    // curved-shell semantics of traverseConstAltitude)
    const altAt = (R) => {
        const x = S[mid * 3] + D[mid * 3] * R;
        const y = S[mid * 3 + 1] + D[mid * 3 + 1] * R;
        return S[mid * 3 + 2] + D[mid * 3 + 2] * R + (x * x + y * y) / (2 * EARTH_RADIUS_M);
    };
    let zA = altAt(rangeMin), zB = altAt(rangeMax);
    if (zA > zB) { const t = zA; zA = zB; zB = t; }

    const {K: smoothK, curvature} = trajectorySmoothingSettings(n, fps);
    const evalZ = (z) => {
        const {track, badFrames} = traverseConstAltitude(dataset, z);
        const smooth = smoothTrackBspline(track, n, smoothK, curvature);
        const errDeg = meanAngularError(dataset, smooth) * 180 / Math.PI;
        const wind = options.fitWind ? fitScoringWind(dataset, smooth) : undefined;
        const score = straightFlightScore(trackMetrics(datasetForFittedWind(dataset, {wind}), smooth), badFrames)
            + (errDeg / sigmaLOSDeg) ** 2 + sizeCost(smooth);
        return {z, track, smooth, badFrames, errDeg, score, ...(wind ? {wind} : {})};
    };
    let best = null;
    for (let i = 0; i < samples; i++) {
        const z = zA + (zB - zA) * i / (samples - 1);
        const r = evalZ(z);
        if (!best || r.score < best.score) best = r;
    }
    // bisection descent around the best grid sample (a parabolic refine
    // stalls thousands of meters short on sharp score valleys)
    const step = (zB - zA) / (samples - 1);
    for (let pass = 1; pass <= 8; pass++) {
        const h = step / 2 ** pass;
        if (h <= 0) break;
        const a = evalZ(Math.max(zA, best.z - h));
        const c = evalZ(Math.min(zB, best.z + h));
        if (a.score < best.score) best = a;
        if (c.score < best.score) best = c;
    }
    // start range along the FIRST RAY of the exact-ray track (see JSDoc)
    const startDist = Math.hypot(best.track[0] - S[0], best.track[1] - S[1], best.track[2] - S[2]);
    const failed = best.badFrames > 0.2 * n;
    const edgeTol = Math.max(1e-6, step / 128);
    const boundarySide = best.z <= zA + edgeTol ? "lo" : best.z >= zB - edgeTol ? "hi" : null;
    return {
        altZ: best.z, startDist, track: best.smooth, trackExact: best.track,
        errDeg: best.errDeg, score: best.score, badFrames: best.badFrames, failed,
        boundaryLimited: boundarySide !== null,
        boundarySide,
        metrics: summarizeMetrics(trackMetrics(datasetForFittedWind(dataset, best), best.smooth)),
        ...(best.wind ? {wind: best.wind} : {}),
    };
}

// ---------------------------------------------------------------------------
// Horizontal constant-speed manoeuvres
// ---------------------------------------------------------------------------

/**
 * Broadly smooth a constant-altitude ray-intersection track, then measure its
 * horizontal-speed consistency with RMS, robust, and temporal-block scores.
 * This deliberately allows turns: heading can change freely, while speed
 * magnitude is the fitted invariant.
 *
 * The defaults reproduce the diagnostic that exposed the altitude valley on
 * 120-second drone clips: a 12-second moving average and a 5-second velocity
 * baseline. Short clips scale both durations down with the clip length.
 */
export function horizontalConstantSpeedScore(dataset, track, options = {}) {
    const {n, fps} = dataset;
    if (!track || n < 20 || !(fps > 0)) return null;
    const duration = (n - 1) / fps;
    const smoothSeconds = options.smoothSeconds ?? Math.max(2, Math.min(12, duration / 10));
    const velocitySeconds = options.velocitySeconds
        ?? Math.max(0.4, Math.min(5, smoothSeconds * 5 / 12));
    let window = Math.max(5, Math.round(smoothSeconds * fps));
    window = Math.min(window, n - 3);
    const xs = new Array(n), ys = new Array(n), zs = new Array(n);
    for (let f = 0; f < n; f++) {
        xs[f] = track[f * 3];
        ys[f] = track[f * 3 + 1];
        zs[f] = track[f * 3 + 2];
    }
    const sx = RollingAveragePolyEdge(xs, window, 1, 2, window);
    const sy = RollingAveragePolyEdge(ys, window, 1, 2, window);
    const includeTrack = options.includeTrack ?? true;
    const sz = includeTrack ? RollingAveragePolyEdge(zs, window, 1, 2, window) : null;
    let smoothed = null;
    if (includeTrack) {
        smoothed = new Float64Array(n * 3);
        for (let f = 0; f < n; f++) {
            smoothed[f * 3] = sx[f];
            smoothed[f * 3 + 1] = sy[f];
            smoothed[f * 3 + 2] = sz[f];
        }
    }

    const h = Math.max(1, Math.round(velocitySeconds * fps / 2));
    // Both endpoints of the centered velocity baseline must themselves have a
    // complete position-average window. Otherwise the first/last h samples are
    // dominated by polynomial edge extrapolation and can move or erase the
    // broad altitude valley.
    const trim = Math.max(Math.floor(window / 2) + h, h + 2);
    const speeds = [];
    const dt = 2 * h / fps;
    for (let f = trim; f < n - trim; f++) {
        const x0 = sx[f - h], y0 = sy[f - h];
        const vx = (sx[f + h] - x0) / dt;
        const vy = (sy[f + h] - y0) / dt;
        const speed = Math.hypot(vx, vy);
        if (Number.isFinite(speed)) speeds.push(speed);
    }
    if (speeds.length < 10) return null;
    const ordered = speeds.slice().sort((a, b) => a - b);
    const medianSpeed = ordered[Math.floor(ordered.length / 2)];
    if (!(medianSpeed > 0.05)) return null;
    let sum = 0, sum2 = 0;
    const deviations = new Array(speeds.length);
    for (let i = 0; i < speeds.length; i++) {
        const speed = speeds[i];
        sum += speed;
        const d = speed - medianSpeed;
        sum2 += d * d;
        deviations[i] = Math.abs(d);
    }
    deviations.sort((a, b) => a - b);
    const madScore = deviations[Math.floor(deviations.length / 2)] / medianSpeed;
    const blockCount = Math.min(8, Math.max(2, Math.floor(speeds.length / 10)));
    const blockMedians = [];
    for (let block = 0; block < blockCount; block++) {
        const lo = Math.floor(block * speeds.length / blockCount);
        const hi = Math.floor((block + 1) * speeds.length / blockCount);
        const values = speeds.slice(lo, hi).sort((a, b) => a - b);
        blockMedians.push(values[Math.floor(values.length / 2)]);
    }
    const orderedBlocks = blockMedians.slice().sort((a, b) => a - b);
    const medianBlock = orderedBlocks[Math.floor(orderedBlocks.length / 2)];
    let blockSum2 = 0;
    for (const value of blockMedians) blockSum2 += (value - medianBlock) ** 2;
    const blockMedianScore = Math.sqrt(blockSum2 / blockMedians.length)
        / Math.max(Math.abs(medianBlock), 1e-9);
    const rmsScore = Math.sqrt(sum2 / speeds.length) / medianSpeed;
    return {
        score: rmsScore,
        rmsScore,
        madScore,
        blockMedianScore,
        meanSpeed: sum / speeds.length,
        medianSpeed,
        smoothSeconds,
        velocitySeconds,
        samples: speeds.length,
        speeds: Float64Array.from(speeds),
        track: smoothed,
    };
}

function medianFinite(values, fallback = 1) {
    const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!finite.length) return fallback;
    const value = finite[Math.floor(finite.length / 2)];
    return value > 1e-12 ? value : fallback;
}

function normalizedSpeedWaveform(speed) {
    const row = new Float64Array(speed.speeds.length);
    for (let i = 0; i < row.length; i++) row[i] = speed.speeds[i] / speed.medianSpeed - 1;
    return row;
}

// Leading right-singular vector of the altitude-by-time speed matrix. A full
// SVD would be excessive for this one component; power iteration performs the
// same multiplication by Y'Y without ever constructing that large matrix.
function dominantSpeedMode(rows) {
    if (!rows.length || !rows[0]?.length) return null;
    const width = rows[0].length;
    let vector = new Float64Array(width);
    let seedRow = rows[0], seedEnergy = -1;
    for (const row of rows) {
        let energy = 0;
        for (let t = 0; t < width; t++) energy += row[t] * row[t];
        if (energy > seedEnergy) { seedEnergy = energy; seedRow = row; }
    }
    vector.set(seedRow);
    const normalize = (v) => {
        let norm2 = 0;
        for (let t = 0; t < v.length; t++) norm2 += v[t] * v[t];
        const norm = Math.sqrt(norm2);
        if (!(norm > 1e-12)) return false;
        for (let t = 0; t < v.length; t++) v[t] /= norm;
        return true;
    };
    if (!normalize(vector)) return null;
    const coefficients = new Float64Array(rows.length);
    for (let pass = 0; pass < 10; pass++) {
        const next = new Float64Array(width);
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            let coefficient = 0;
            for (let t = 0; t < width; t++) coefficient += row[t] * vector[t];
            coefficients[i] = coefficient;
            for (let t = 0; t < width; t++) next[t] += coefficient * row[t];
        }
        if (!normalize(next)) return null;
        vector = next;
    }
    let projectedEnergy = 0, totalEnergy = 0;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        let coefficient = 0;
        for (let t = 0; t < width; t++) {
            coefficient += row[t] * vector[t];
            totalEnergy += row[t] * row[t];
        }
        coefficients[i] = coefficient;
        projectedEnergy += coefficient * coefficient;
    }
    return {
        vector,
        coefficients,
        explainedFraction: totalEnergy > 0 ? projectedEnergy / totalEnergy : 0,
    };
}

function interiorLocalMinima(values) {
    const minima = [];
    for (let i = 2; i < values.length - 2; i++) {
        if (Number.isFinite(values[i - 1]) && Number.isFinite(values[i]) && Number.isFinite(values[i + 1])
            && values[i] < values[i - 1] && values[i] <= values[i + 1]) minima.push(i);
    }
    return minima;
}

function lowestMinimum(values, minima = interiorLocalMinima(values)) {
    if (!minima.length) return null;
    return minima.reduce((best, i) => values[i] < values[best] ? i : best, minima[0]);
}

function minimumBasin(values, minima, chosen) {
    const prior = minima.filter(i => i < chosen);
    const previous = prior.length ? prior[prior.length - 1] : undefined;
    const next = minima.find(i => i > chosen);
    const peak = (lo, hi) => {
        let best = lo;
        for (let i = lo + 1; i <= hi; i++) if (values[i] > values[best]) best = i;
        return best;
    };
    const lo = previous === undefined ? 2 : peak(previous, chosen);
    const hi = next === undefined ? values.length - 3 : peak(chosen, next);
    const prominence = Math.max(0, Math.min(values[lo], values[hi]) - values[chosen]);
    const halfProminence = values[chosen] + prominence / 2;
    let coreLo = chosen, coreHi = chosen;
    while (coreLo > lo && values[coreLo - 1] <= halfProminence) coreLo--;
    while (coreHi < hi && values[coreHi + 1] <= halfProminence) coreHi++;
    // A sampled minimum represents at least its immediate grid cell even when
    // one side of the score curve is nearly flat at machine precision.
    coreLo = Math.max(lo, Math.min(coreLo, chosen - 1));
    coreHi = Math.min(hi, Math.max(coreHi, chosen + 1));
    return {lo, hi, coreLo, coreHi, prominence};
}

function xorshift32(state) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
}

// Moving-block bootstrap of the two signals that determine the basin: broad
// relative speed variation and the dominant altitude-dependent speed mode.
// The same sampled time blocks are used at every altitude, preserving their
// paired comparison. The result is deterministic so reloads and BOTBench cache
// replays report the same confidence.
function bootstrapSpeedBasin(grid, scoreValues, minima, chosen, mode, modeWeight, options, fps) {
    const trials = Math.max(0, Math.round(options.bootstrapTrials ?? 24));
    const rows = grid.map(candidate => candidate.waveform);
    const width = rows[0]?.length ?? 0;
    if (!trials || !width || !mode) return {
        trials, resolvedTrials: 0, confidence: null, altitudes: [],
    };
    const basin = minimumBasin(scoreValues, minima, chosen);
    const seconds = options.bootstrapBlockSeconds ?? 5;
    const block = Math.max(4, Math.min(width, Math.round(seconds * fps)));
    let state = (options.bootstrapSeed ?? 0x6d2b79f5) >>> 0;
    let hits = 0, resolvedTrials = 0;
    const altitudes = [];
    for (let trial = 0; trial < trials; trial++) {
        const indices = new Int32Array(width);
        let used = 0;
        while (used < width) {
            state = xorshift32(state);
            const start = Math.floor((state / 0x100000000) * Math.max(1, width - block + 1));
            for (let k = 0; k < block && used < width; k++) indices[used++] = start + k;
        }
        const rms = new Float64Array(grid.length);
        const projection = new Float64Array(grid.length);
        for (let i = 0; i < grid.length; i++) {
            let sum2 = 0, dot = 0;
            const row = rows[i];
            for (let k = 0; k < width; k++) {
                const t = indices[k];
                sum2 += row[t] * row[t];
                dot += row[t] * mode.vector[t];
            }
            rms[i] = Math.sqrt(sum2 / width);
            projection[i] = Math.abs(dot);
        }
        const rmsScale = medianFinite(Array.from(rms));
        const modeScale = medianFinite(Array.from(projection));
        const scores = new Float64Array(grid.length);
        for (let i = 0; i < grid.length; i++) {
            scores[i] = (1 - modeWeight) * rms[i] / rmsScale
                + modeWeight * projection[i] / modeScale;
        }
        const picked = lowestMinimum(scores, interiorLocalMinima(scores));
        if (picked === null) continue;
        resolvedTrials++;
        altitudes.push(grid[picked].altitude);
        if (picked >= basin.coreLo && picked <= basin.coreHi) hits++;
    }
    altitudes.sort((a, b) => a - b);
    const quantile = (p) => altitudes.length
        ? altitudes[Math.min(altitudes.length - 1, Math.floor(p * altitudes.length))] : null;
    return {
        trials,
        resolvedTrials,
        confidence: trials ? hits / trials : null,
        basinLoIndex: basin.lo,
        basinHiIndex: basin.hi,
        basinCoreLoIndex: basin.coreLo,
        basinCoreHiIndex: basin.coreHi,
        altitudes,
        altitudeP10: quantile(0.10),
        altitudeMedian: quantile(0.50),
        altitudeP90: quantile(0.90),
        blockSeconds: seconds,
    };
}

/**
 * Solve for a level target that may turn and manoeuvre but holds horizontal
 * speed. For each altitude, intersect every LOS with that constant-geodetic-
 * altitude shell. Combine speed-consistency scores across smoothing scales
 * with the zero crossing of the leading altitude-dependent speed waveform.
 * A moving-block bootstrap measures whether the selected basin survives when
 * different portions of the observed motion receive more weight.
 *
 * A false global minimum always exists at platform altitude: the intersections
 * collapse onto the platform's own usually-smooth track. The upper 20% of the
 * ground-to-platform band is therefore excluded, and only INTERIOR score
 * valleys are eligible. No interior valley means the altitude is unresolved.
 */
/** Resolve the altitude search band shared by the CPU and WebGPU paths. */
export function horizontalConstantSpeedSetup(dataset, options = {}) {
    const {n, S, D} = dataset;
    const groundAltitude = options.groundAltitude ?? dataset.groundLevelM ?? 0;
    const platformAltitudes = [];
    const down = [];
    for (let f = 0; f < n; f++) {
        const x = S[f * 3], y = S[f * 3 + 1];
        platformAltitudes.push(S[f * 3 + 2] + (x * x + y * y) / (2 * EARTH_RADIUS_M));
        down.push(D[f * 3 + 2]);
    }
    platformAltitudes.sort((a, b) => a - b);
    down.sort((a, b) => a - b);
    const platformAltitude = platformAltitudes[Math.floor(platformAltitudes.length / 2)];
    const medianDown = down[Math.floor(down.length / 2)];
    const platformGuard = options.platformGuard ?? 0.20;
    const altitudeMin = options.altitudeMin ?? groundAltitude;
    const altitudeMax = options.altitudeMax
        ?? groundAltitude + (platformAltitude - groundAltitude) * (1 - platformGuard);
    const samples = Math.max(25, Math.round(options.samples ?? 161));
    const base = {altitudeMin, altitudeMax, platformAltitude, platformGuard, samples};
    const failed = (reason) => ({
        failed: true, failureReason: reason, altitudeMin, altitudeMax,
        platformAltitude, platformGuard,
        ...(options.computeBackend ? {backend: options.computeBackend} : {}),
    });
    if (n < 20) return failed("too few frames");
    if (!(altitudeMax > altitudeMin)) return failed("no altitude band below the platform");
    if (!(medianDown < -1e-4)) return failed("the median sightline is not looking down");
    return {failed: false, ...base};
}

/** Score one altitude in the CPU path and during final GPU-result refinement. */
export function horizontalConstantSpeedCandidate(dataset, altitude, options = {}) {
    const exact = traverseConstAltitude(dataset, altitude);
    if (exact.badFrames > 0.02 * dataset.n) return {altitude, score: Infinity, exact};
    const speed = horizontalConstantSpeedScore(dataset, exact.track, options);
    if (!speed) return {altitude, score: Infinity, exact};
    const duration = (dataset.n - 1) / dataset.fps;
    const requestedScales = options.consensusSmoothSeconds ?? [
        Math.max(1, speed.smoothSeconds / 2),
        speed.smoothSeconds,
        Math.min(Math.max(2, duration / 6), speed.smoothSeconds * 5 / 3),
    ];
    const scales = [...new Set(requestedScales.map(value => Number(value.toFixed(6))))];
    const scaleScores = [];
    for (const smoothSeconds of scales) {
        if (Math.abs(smoothSeconds - speed.smoothSeconds) < 1e-6) {
            scaleScores.push(speed.rmsScore);
            continue;
        }
        const atScale = horizontalConstantSpeedScore(dataset, exact.track, {
            ...options,
            smoothSeconds,
            velocitySeconds: speed.velocitySeconds,
            includeTrack: false,
        });
        if (atScale) scaleScores.push(atScale.rmsScore);
    }
    const multiscaleScore = scaleScores.length
        ? scaleScores.reduce((sum, value) => sum + value, 0) / scaleScores.length
        : speed.rmsScore;
    return {
        altitude,
        score: speed.score,
        exact,
        speed,
        waveform: normalizedSpeedWaveform(speed),
        components: {
            rms: speed.rmsScore,
            mad: speed.madScore,
            block: speed.blockMedianScore,
            multiscale: multiscaleScore,
        },
        scaleScores,
        smoothScales: scales,
    };
}

/** Complete selection, bootstrap, and f64 refinement from an altitude score grid. */
export function finishHorizontalConstantSpeedFit(dataset, options, setup, grid) {
    if (setup.failed) return setup;
    const {S} = dataset;
    const {altitudeMin, altitudeMax, platformAltitude, platformGuard} = setup;
    const failed = (reason) => ({
        failed: true, failureReason: reason, altitudeMin, altitudeMax,
        platformAltitude, platformGuard,
        ...(options.computeBackend ? {backend: options.computeBackend} : {}),
    });
    const evalAltitudeRaw = altitude => horizontalConstantSpeedCandidate(dataset, altitude, options);
    const componentKeys = ["rms", "mad", "block", "multiscale"];
    const componentNorms = {};
    for (const key of componentKeys) {
        componentNorms[key] = medianFinite(grid.map(candidate => candidate.components?.[key]));
    }
    for (const candidate of grid) {
        if (!candidate.components) { candidate.consensusScore = Infinity; continue; }
        candidate.consensusScore = componentKeys.reduce((sum, key) =>
            sum + candidate.components[key] / componentNorms[key], 0) / componentKeys.length;
    }

    const finiteGrid = grid.filter(candidate => candidate.waveform);
    const mode = dominantSpeedMode(finiteGrid.map(candidate => candidate.waveform));
    if (!mode || finiteGrid.length !== grid.length) {
        return failed("the altitude speed waveforms are not finite");
    }
    const modeScale = medianFinite(Array.from(mode.coefficients, Math.abs));
    const modeWeight = Math.max(0, Math.min(1, options.modeWeight ?? 0.20));
    const selectionMode = options.selectionMode ?? "combined";
    const sizeCost = compileAngularSizeFit(dataset);
    const scoreCandidate = (candidate) => {
        if (!candidate?.components || !candidate.waveform) return candidate;
        candidate.consensusScore = componentKeys.reduce((sum, key) =>
            sum + candidate.components[key] / componentNorms[key], 0) / componentKeys.length;
        let coefficient = 0;
        for (let t = 0; t < candidate.waveform.length; t++) {
            coefficient += candidate.waveform[t] * mode.vector[t];
        }
        candidate.modeCoefficient = coefficient;
        candidate.modeScore = Math.abs(coefficient) / modeScale;
        if (selectionMode === "rms") candidate.score = candidate.components.rms;
        else if (selectionMode === "consensus") candidate.score = candidate.consensusScore;
        else if (selectionMode === "mode") candidate.score = candidate.modeScore;
        else candidate.score = (1 - modeWeight) * candidate.consensusScore + modeWeight * candidate.modeScore;
        candidate.score += sizeCost(candidate.speed.track);
        return candidate;
    };
    for (const candidate of grid) scoreCandidate(candidate);

    const scoreValues = grid.map(candidate => candidate.score);
    const consensusValues = grid.map(candidate => candidate.consensusScore);
    const modeValues = grid.map(candidate => candidate.modeScore);
    const minima = interiorLocalMinima(scoreValues);
    if (!minima.length) return failed("no interior constant-speed altitude valley");
    const chosen = lowestMinimum(scoreValues, minima);
    const consensusMinima = interiorLocalMinima(consensusValues);
    const modeMinima = interiorLocalMinima(modeValues);
    const consensusChosen = lowestMinimum(consensusValues, consensusMinima);
    const modeChosen = lowestMinimum(modeValues, modeMinima);
    // This bootstrap resamples speed alone. It cannot estimate stability of
    // the combined speed/size objective until size observations are resampled too.
    const bootstrapUnavailableReason = angularSizeFitEnabled(dataset)
        ? "Not assessed with angular-size fitting: the bootstrap resamples speed only" : null;
    const bootstrap = bootstrapUnavailableReason
        ? {confidence: null, trials: 0, resolvedTrials: 0}
        : bootstrapSpeedBasin(grid, scoreValues, minima, chosen, mode, modeWeight, options, dataset.fps);

    // Golden-section refinement stays inside the selected grid valley. It cannot
    // jump to the platform collapse or another local minimum.
    let lo = grid[chosen - 1].altitude, hi = grid[chosen + 1].altitude;
    const phi = (Math.sqrt(5) - 1) / 2;
    const evalAltitude = altitude => scoreCandidate(evalAltitudeRaw(altitude));
    let x1 = hi - phi * (hi - lo), x2 = lo + phi * (hi - lo);
    let r1 = evalAltitude(x1), r2 = evalAltitude(x2);
    for (let pass = 0; pass < 12; pass++) {
        if (r1.score <= r2.score) {
            hi = x2; x2 = x1; r2 = r1;
            x1 = hi - phi * (hi - lo); r1 = evalAltitude(x1);
        } else {
            lo = x1; x1 = x2; r1 = r2;
            x2 = lo + phi * (hi - lo); r2 = evalAltitude(x2);
        }
    }
    let best = evalAltitude(grid[chosen].altitude);
    for (const candidate of [r1, r2, evalAltitude((lo + hi) / 2)]) {
        if (candidate.score < best.score) best = candidate;
    }
    const startDist = Math.hypot(
        best.exact.track[0] - S[0],
        best.exact.track[1] - S[1],
        best.exact.track[2] - S[2]);
    const otherScores = minima.filter(i => i !== chosen).map(i => grid[i].score).sort((a, b) => a - b);
    const basin = minimumBasin(scoreValues, minima, chosen);
    const basinLowAltitude = grid[basin.coreLo].altitude;
    const basinHighAltitude = grid[basin.coreHi].altitude;
    const valleyProminence = basin.prominence;
    return {
        failed: false,
        altZ: best.altitude,
        startDist,
        track: best.speed.track,
        trackExact: best.exact.track,
        errDeg: meanAngularError(dataset, best.speed.track) * 180 / Math.PI,
        score: best.score,
        rmsScore: best.components.rms,
        madScore: best.components.mad,
        blockMedianScore: best.components.block,
        multiscaleScore: best.components.multiscale,
        consensusScore: best.consensusScore,
        modeScore: best.modeScore,
        modeCoefficient: best.modeCoefficient,
        modeWeight,
        selectionMode,
        dominantModeExplainedFraction: mode.explainedFraction,
        consensusAltitude: consensusChosen === null ? null : grid[consensusChosen].altitude,
        modeAltitude: modeChosen === null ? null : grid[modeChosen].altitude,
        modeAgreementM: consensusChosen === null || modeChosen === null ? null
            : Math.abs(grid[consensusChosen].altitude - grid[modeChosen].altitude),
        valleyProminence,
        basinLowAltitude,
        basinHighAltitude,
        bootstrapConfidence: bootstrap.confidence,
        bootstrapUnavailableReason,
        bootstrapTrials: bootstrap.trials,
        bootstrapResolvedTrials: bootstrap.resolvedTrials,
        bootstrapAltitudeP10: bootstrap.altitudeP10,
        bootstrapAltitudeMedian: bootstrap.altitudeMedian,
        bootstrapAltitudeP90: bootstrap.altitudeP90,
        bootstrapBlockSeconds: bootstrap.blockSeconds,
        meanSpeed: best.speed.meanSpeed,
        medianSpeed: best.speed.medianSpeed,
        smoothSeconds: best.speed.smoothSeconds,
        velocitySeconds: best.speed.velocitySeconds,
        speedSamples: best.speed.samples,
        badFrames: best.exact.badFrames,
        altitudeMin,
        altitudeMax,
        platformAltitude,
        platformGuard,
        ...(options.computeBackend ? {backend: options.computeBackend} : {}),
        localMinima: minima.map(i => ({
            altitude: grid[i].altitude,
            score: grid[i].score,
            consensusScore: grid[i].consensusScore,
            modeScore: grid[i].modeScore,
        })),
        alternativeScore: otherScores[0] ?? null,
        metrics: summarizeMetrics(trackMetrics(dataset, best.speed.track)),
    };
}

export function fitHorizontalConstantSpeed(dataset, options = {}) {
    const setup = horizontalConstantSpeedSetup(dataset, options);
    if (setup.failed) return setup;
    const {altitudeMin, altitudeMax, samples} = setup;
    const grid = new Array(samples);
    for (let i = 0; i < samples; i++) {
        const altitude = altitudeMin + (altitudeMax - altitudeMin) * i / (samples - 1);
        grid[i] = horizontalConstantSpeedCandidate(dataset, altitude, options);
    }
    return finishHorizontalConstantSpeedFit(dataset, options, setup, grid);
}

// ---------------------------------------------------------------------------
// Fixed-object hypotheses (stationary point, ground light, fixed direction)
// ---------------------------------------------------------------------------

/**
 * Best-fit constant LOS DIRECTION (an object at infinity — a star/planet has a
 * parallax-free, essentially fixed direction over a short clip). Returns the
 * direction that the sightlines cluster around and the mean angular error to
 * it. A large errDeg means the sightline sweeps too much to be a fixed
 * astronomical direction.
 *
 * Direction = dominant eigenvector of sum(D_f D_f^T) (power iteration).
 * Returns {dir:[ex,ey,ez] ENU unit, errDeg}.
 */
export function fitFixedDirection(dataset) {
    const {n, D} = dataset;
    // covariance-like matrix C = sum D D^T
    const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    let mx = 0, my = 0, mz = 0;
    for (let f = 0; f < n; f++) {
        const x = D[f * 3], y = D[f * 3 + 1], z = D[f * 3 + 2];
        C[0] += x * x; C[1] += x * y; C[2] += x * z;
        C[4] += y * y; C[5] += y * z; C[8] += z * z;
        mx += x; my += y; mz += z;
    }
    C[3] = C[1]; C[6] = C[2]; C[7] = C[5];
    // power iteration seeded at the mean direction
    let ux = mx, uy = my, uz = mz;
    let ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    for (let it = 0; it < 40; it++) {
        const vx = C[0] * ux + C[1] * uy + C[2] * uz;
        const vy = C[3] * ux + C[4] * uy + C[5] * uz;
        const vz = C[6] * ux + C[7] * uy + C[8] * uz;
        const vl = Math.hypot(vx, vy, vz) || 1;
        ux = vx / vl; uy = vy / vl; uz = vz / vl;
    }
    // orient toward the mean direction
    if (ux * mx + uy * my + uz * mz < 0) { ux = -ux; uy = -uy; uz = -uz; }
    let sum = 0;
    for (let f = 0; f < n; f++) {
        const dot = Math.min(1, Math.max(-1, ux * D[f * 3] + uy * D[f * 3 + 1] + uz * D[f * 3 + 2]));
        sum += Math.acos(dot);
    }
    return {dir: [ux, uy, uz], errDeg: (sum / n) * 180 / Math.PI};
}

/**
 * Best-fit single STATIONARY 3D point that the sightlines pass closest to
 * (least squares of perpendicular distance). options.z, when given, pins the
 * point's ENU up-coordinate (a light on the ground / at a known altitude).
 *
 * (sum M_f) P = sum M_f S_f, with M_f = I - D_f D_f^T. For a pinned z the
 * system reduces to 2x2 in (x,y). A near-parallel sightline bundle (narrow
 * baseline) makes the unconstrained range weakly determined — that's expected
 * and reflected in the reported distance.
 *
 * Returns {point:[x,y,z] ENU, errDeg (mean angular residual), distance (mean
 * range from sensor), badFrames} plus a stationary track (same point each frame).
 */
export function fitFixedPoint(dataset, options = {}) {
    const {n, S, D} = dataset;
    const zPin = options.z ?? null;
    // accumulate A = sum M_f, b = sum M_f S_f  (M_f = I - d d^T)
    const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const b = [0, 0, 0];
    for (let f = 0; f < n; f++) {
        const dx = D[f * 3], dy = D[f * 3 + 1], dz = D[f * 3 + 2];
        const m00 = 1 - dx * dx, m01 = -dx * dy, m02 = -dx * dz;
        const m11 = 1 - dy * dy, m12 = -dy * dz, m22 = 1 - dz * dz;
        A[0] += m00; A[1] += m01; A[2] += m02;
        A[4] += m11; A[5] += m12; A[8] += m22;
        const sx = S[f * 3], sy = S[f * 3 + 1], sz = S[f * 3 + 2];
        b[0] += m00 * sx + m01 * sy + m02 * sz;
        b[1] += m01 * sx + m11 * sy + m12 * sz;
        b[2] += m02 * sx + m12 * sy + m22 * sz;
    }
    A[3] = A[1]; A[6] = A[2]; A[7] = A[5];

    let px, py, pz;
    if (zPin !== null) {
        // solve 2x2 for (x,y) with z = zPin: [A00 A01; A10 A11][x;y] = b012 - A..z*zPin
        const b0 = b[0] - A[2] * zPin;
        const b1 = b[1] - A[5] * zPin;
        const det = A[0] * A[4] - A[1] * A[3];
        if (Math.abs(det) < 1e-9) { px = S[0] + D[0] * 20000; py = S[1] + D[1] * 20000; }
        else { px = (b0 * A[4] - b1 * A[1]) / det; py = (A[0] * b1 - A[3] * b0) / det; }
        pz = zPin;
    } else {
        const sol = solve3(A, b);
        if (sol) { px = sol[0]; py = sol[1]; pz = sol[2]; }
        else { px = S[0] + D[0] * 20000; py = S[1] + D[1] * 20000; pz = S[2] + D[2] * 20000; }
    }

    const track = new Float64Array(n * 3);
    let sumAng = 0, sumDist = 0;
    for (let f = 0; f < n; f++) {
        track[f * 3] = px; track[f * 3 + 1] = py; track[f * 3 + 2] = pz;
        let rx = px - S[f * 3], ry = py - S[f * 3 + 1], rz = pz - S[f * 3 + 2];
        const rl = Math.hypot(rx, ry, rz) || 1;
        sumDist += rl;
        const dot = Math.min(1, Math.max(-1, (rx * D[f * 3] + ry * D[f * 3 + 1] + rz * D[f * 3 + 2]) / rl));
        sumAng += Math.acos(dot);
    }
    return {
        point: [px, py, pz], track,
        errDeg: (sumAng / n) * 180 / Math.PI,
        distance: sumDist / n, badFrames: 0,
    };
}

/**
 * Ground Vehicle: where each sightline meets a curved constant-elevation shell at height
 * groundZ (ENU up, metres). A moving surface point — distinct from the
 * stationary fitFixedPoint({z}). Sightlines at/above the horizon have no
 * intersection: the last valid horizontal position is held so metrics stay
 * finite, and fracValid reports how much of the clip actually reached the
 * ground. Shared verbatim by the analysis gallery and the live
 * "Ground Vehicle" traverse method so applying the tile reproduces it.
 */
export function fitGroundVehicle(dataset, groundZ) {
    // Intersect each ray with the CURVED ground surface z(x,y) = groundZ -
    // (x^2+y^2)/(2R) (the real surface falls away from the ENU tangent plane
    // by d^2/2R — 65 m at 29 km; at grazing ray depressions of ~1-2 deg a flat
    // plane shifted the intersection range by KILOMETRES, corrupting the
    // implied ground speed this candidate is judged by). Same quadratic as
    // traverseConstAltitude.
    const S = dataset.S, D = dataset.D, n = dataset.n;
    const R = EARTH_RADIUS_M;
    const track = new Float64Array(n * 3);
    let valid = 0, lastX = S[0], lastY = S[1],
        lastZ = groundZ - (S[0] * S[0] + S[1] * S[1]) / (2 * R);
    for (let f = 0; f < n; f++) {
        const sx = S[f * 3], sy = S[f * 3 + 1], sz = S[f * 3 + 2];
        const dx = D[f * 3], dy = D[f * 3 + 1], dz = D[f * 3 + 2];
        const a = dx * dx + dy * dy;
        const bq = 2 * (sx * dx + sy * dy + R * dz);
        const cq = sx * sx + sy * sy + 2 * R * (sz - groundZ);
        let t = null;
        if (a < 1e-12) {
            if (Math.abs(bq) > 1e-9) t = -cq / bq;
        } else {
            const disc = bq * bq - 4 * a * cq;
            if (disc >= 0) {
                const sq = Math.sqrt(disc);
                const t1 = (-bq - sq) / (2 * a);
                const t2 = (-bq + sq) / (2 * a);
                t = t1 > 0 ? t1 : (t2 > 0 ? t2 : null);
            }
        }
        if (t !== null && t > 0) {
            lastX = sx + dx * t;
            lastY = sy + dy * t;
            lastZ = sz + dz * t;
            valid++;
        }
        track[f * 3] = lastX; track[f * 3 + 1] = lastY; track[f * 3 + 2] = lastZ;
    }
    return {track, fracValid: n ? valid / n : 0};
}

/**
 * Ground Object: the stationary point pinned to the CURVED local surface.
 * Two-pass: pin to the tangent-plane height, then re-pin to the curved
 * surface height at the solved horizontal position (the surface falls d^2/2R
 * below the plane — a genuine surface light 29 km out sits ~65 m below the
 * flat pin, a systematic ~0.13 deg residual that used to demote the true
 * answer). Shared by the analysis gallery and the live "Global Fit: Ground
 * Object" method so applying the tile reproduces it exactly.
 *
 * Also returns visibleFraction (groundPointVisibleFraction): the share of
 * frames from which the solved point could be seen at all. The gallery rejects
 * the candidate when that is not essentially every frame.
 */
export function fitGroundPoint(dataset, groundZ) {
    // fixed-point iteration: pin z to the surface height at the previous
    // solution's horizontal position (the z error couples back into x,y with
    // gain ~range/sensor-height, so a single refinement can under-converge
    // by metres at long range — iterate to millimetres instead)
    let fit = fitFixedPoint(dataset, {z: groundZ});
    for (let pass = 0; pass < 6; pass++) {
        const px = fit.point[0], py = fit.point[1];
        const zCurved = groundZ - (px * px + py * py) / (2 * EARTH_RADIUS_M);
        if (Math.abs(zCurved - fit.point[2]) < 0.005) break;
        fit = fitFixedPoint(dataset, {z: zCurved});
    }
    return {...fit, visibleFraction: groundPointVisibleFraction(dataset, fit.point, groundZ)};
}

// Standard atmospheric refraction carries the visible horizon about 8% further
// than the geometric horizon, so a surface point this much past the geometric
// horizon distance still counts as visible.
const HORIZON_REFRACTION_ALLOWANCE = 1.1;

/**
 * The share of frames from which a point on the ground can be seen: it lies in
 * front of the sensor along that frame's sightline, and no further away than the
 * horizon at the sensor's height above the curved surface (groundZ is the
 * surface's tangent-plane height, as in fitGroundPoint).
 *
 * fitFixedPoint fits whole sightlines, which run behind the sensor too, so it
 * can return a point nobody could see. Upward sightlines put a pinned ground
 * point behind the sensor. Sightlines that keep one bearing within about 2
 * degrees of horizontal (a sensor flying straight at or away from the object)
 * leave the point fixed only by where a near-flat line meets the ground, and the
 * curved-surface passes then push it out without limit: 1e20 m and more,
 * measured. A point like that scores 0 here.
 */
export function groundPointVisibleFraction(dataset, point, groundZ) {
    const {n, S, D} = dataset;
    const [px, py, pz] = point;
    if (!n || !Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return 0;
    let visible = 0;
    for (let f = 0; f < n; f++) {
        const sx = S[f * 3], sy = S[f * 3 + 1], sz = S[f * 3 + 2];
        const rx = px - sx, ry = py - sy, rz = pz - sz;
        if (!(rx * D[f * 3] + ry * D[f * 3 + 1] + rz * D[f * 3 + 2] > 0)) continue;   // behind the sensor
        const height = sz - (groundZ - (sx * sx + sy * sy) / (2 * EARTH_RADIUS_M));
        if (!(height > 0)) continue;
        const horizonM = Math.sqrt(height * height + 2 * height * EARTH_RADIUS_M) * HORIZON_REFRACTION_ALLOWANCE;
        if (Math.hypot(rx, ry, rz) <= horizonM) visible++;
    }
    return visible / n;
}

// 3x3 solve (row-major), returns null if singular
function solve3(A, b) {
    const m = [A[0], A[1], A[2], A[3], A[4], A[5], A[6], A[7], A[8]];
    const v = [b[0], b[1], b[2]];
    for (let col = 0; col < 3; col++) {
        let piv = col, mx = Math.abs(m[col * 3 + col]);
        for (let r = col + 1; r < 3; r++) {
            const a = Math.abs(m[r * 3 + col]);
            if (a > mx) { mx = a; piv = r; }
        }
        if (mx < 1e-12) return null;
        if (piv !== col) {
            for (let k = 0; k < 3; k++) { const t = m[col * 3 + k]; m[col * 3 + k] = m[piv * 3 + k]; m[piv * 3 + k] = t; }
            const t = v[col]; v[col] = v[piv]; v[piv] = t;
        }
        for (let r = col + 1; r < 3; r++) {
            const fct = m[r * 3 + col] / m[col * 3 + col];
            for (let k = col; k < 3; k++) m[r * 3 + k] -= fct * m[col * 3 + k];
            v[r] -= fct * v[col];
        }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) {
        let s = v[i];
        for (let k = i + 1; k < 3; k++) s -= m[i * 3 + k] * x[k];
        x[i] = s / m[i * 3 + i];
    }
    return x;
}

/**
 * Smoothness/plausibility score for an essentially-straight-flying object.
 * Lower is better. Weights chosen so ~0.1g of sustained maneuvering ≈ 0.4.
 */
export const MOTION_SCORE_WEIGHTS = Object.freeze({rmsG: 4, peakG: 1, turn: 0.05, climb: 0.02, climbFreeMS: 5});

export function straightFlightScore(metrics, badFrames = 0) {
    return (
        MOTION_SCORE_WEIGHTS.rmsG * metrics.gLoad.rms +
        MOTION_SCORE_WEIGHTS.peakG * metrics.gLoad.max +
        MOTION_SCORE_WEIGHTS.turn * Math.abs(metrics.turnRate.std) +
        MOTION_SCORE_WEIGHTS.climb * Math.max(0, Math.abs(metrics.verticalSpeed.mean) - MOTION_SCORE_WEIGHTS.climbFreeMS) +
        badFrames * 0.1
    );
}

/**
 * Stride-downsample a dataset to ~targetN frames for cheaper per-combo solves.
 * W (per-FRAME wind displacement) is SUMMED over each stride window so the
 * total wind drift is preserved; fps scales by the stride.
 */
export function downsampleDataset(ds, targetN = 2500) {
    const {n, fps, S, D, W} = ds;
    const stride = Math.max(1, Math.round(n / targetN));
    if (stride === 1) return {ds: {...ds}, stride};
    const n2 = Math.floor((n - 1) / stride) + 1;
    const S2 = new Float64Array(n2 * 3), D2 = new Float64Array(n2 * 3), W2 = new Float64Array(n2 * 3);
    for (let f2 = 0; f2 < n2; f2++) {
        const f = f2 * stride, b = f * 3, b2 = f2 * 3;
        S2[b2] = S[b]; S2[b2 + 1] = S[b + 1]; S2[b2 + 2] = S[b + 2];
        D2[b2] = D[b]; D2[b2 + 1] = D[b + 1]; D2[b2 + 2] = D[b + 2];
        if (f2 < n2 - 1) {
            let wx = 0, wy = 0, wz = 0;
            for (let g = f; g < Math.min(n, f + stride); g++) { wx += W[g * 3]; wy += W[g * 3 + 1]; wz += W[g * 3 + 2]; }
            W2[b2] = wx; W2[b2 + 1] = wy; W2[b2 + 2] = wz;
        }
    }
    return {ds: {...ds, n: n2, fps: fps / stride, S: S2, D: D2, W: W2,
        angularSize: remapAngularSize(ds.angularSize, Array.from({length: n2}, (_, i) => i * stride))}, stride};
}

// A heuristic tolerance in score units, not a confidence interval. Bad grid
// cells must not widen this band and turn a poor fit into an equivalent one.
function constAirFamilyMargin(bestScore) {
    return Math.max(0.05, 0.15 * Math.abs(bestScore));
}

/**
 * Grid search over (start distance, air speed) for the constant-air-speed
 * traverse. Returns every combo scored, sorted best-first, plus the grid
 * dimensions for heatmap rendering.
 *
 * Each combo is solved as a spline QP (traversePlausible with a TIGHT speed
 * sigma) on a downsampled dataset, then lightly smoothed before scoring. The
 * old per-frame ray-walk was a shooting method: on scenes where the sensor
 * maneuvers it exploded into corkscrews at the correct combo (jitter + branch
 * flapping), so the truth could LOSE the sweep. The QP finds the smoothest
 * path that holds the requested speed; a speed-fidelity term marks down
 * combos whose "constant speed" the QP could not actually hold (this replaces
 * badFrames as the infeasibility signal — badFrames is kept as 0 in the
 * result shape for compatibility).
 *
 * The smoothness score valley is typically sharp in range but very flat in
 * speed, so with smoothness alone the "best" lands arbitrarily at a grid
 * edge. options.speedTarget (m/s) adds a mild soft-target term
 * 0.2*((v-target)/250kt)^2 that picks the middle of the plausible band
 * without changing which ranges score well.
 *
 * options: {ranges: number[] (m), speeds: number[] (m/s),
 *           speedTarget (m/s|null), targetN, spdFidSigma (m/s), progress}
 * progress(frac) is awaited if provided (once per range row).
 */
export async function sweepConstAirSpeed(dataset, options = {}) {
    let ranges = (options.ranges ?? defaultRangeList(dataset)).slice();
    const speeds = (options.speeds ?? defaultSpeedList()).slice().sort((a, b) => a - b);
    const speedTarget = options.speedTarget ?? null;
    const vSigma = options.vSigma ?? 3 * KNOTS_TO_MS;
    const spdFidSigma = options.spdFidSigma ?? 10 * KNOTS_TO_MS;
    const speedSigma = 250 * KNOTS_TO_MS;
    const {ds} = downsampleDataset(dataset, angularSizeFitEnabled(dataset) ? dataset.n : options.targetN ?? 2500);
    const sizeCost = compileAngularSizeFit(ds);
    const {K: smoothK, curvature} = trajectorySmoothingSettings(ds.n, ds.fps);
    const results = [];

    const workspace = {};
    const metricsWorkspace = {};
    const sweepRanges = async (rangeList, progressBase, progressSpan) => {
        for (let ri = 0; ri < rangeList.length; ri++) {
            for (const speedMs of speeds) {
                // minDist keeps the QP's range-on-ray positive: without a floor
                // it can drive lambda toward or through zero (a collapsed or
                // behind-the-sensor "path") in some geometries, and the
                // post-smoothing metrics would hide it.
                //
                // rangeFloor is REQUIRED for minDist to do anything —
                // traversePlausible gates the floor rows on it and defaults it
                // to false, so passing minDist alone was a no-op here and the
                // whole score surface below was read off an unfloored solve.
                // This is a declared near-field prior: solutions closer than
                // 120 m are pushed out, not forbidden (the penalty is soft).
                const {track, wind} = traversePlausible(ds, rangeList[ri],
                    {fitWind: options.fitWind, vTarget: speedMs, vSigma, iters: 3, K: 25, minDist: 120, rangeFloor: true, [PLAUSIBLE_WORKSPACE]: workspace});
                const sm = smoothTrackBspline(track, ds.n, smoothK, curvature);
                const m = trackMetrics(datasetForFittedWind(ds, {wind}), sm, {[TRACK_METRICS_WORKSPACE]: metricsWorkspace});
                let score = straightFlightScore(m, 0) + sizeCost(sm);
                if (speedTarget !== null) {
                    score += 0.2 * ((speedMs - speedTarget) / speedSigma) ** 2;
                }
                const spdErr = Math.hypot(m.airSpeed.mean - speedMs, m.airSpeed.std);
                score += (spdErr / spdFidSigma) ** 2;
                const windCost = wind ? windPriorCost(wind.windE, wind.windN) : 0;
                score += windCost;
                results.push({
                    startDist: rangeList[ri],
                    speed: speedMs,
                    ...(wind ? {wind} : {}),
                    score,
                    badFrames: 0,
                    spdErr,
                    windCost,
                    metrics: summarizeMetrics(m),
                });
            }
            if (options.progress) {
                // The dataset is the fit's immutable snapshot. Keep the
                // acceleration normal equations across the UI yield as well as
                // across cells; rebuilding them once per range row was a large
                // fraction of this sweep's CPU time.
                await options.progress(progressBase + progressSpan * (ri + 1) / rangeList.length);
            }
        }
    };

    await sweepRanges(ranges, 0, options.expand ? 0.8 : 1);

    // Bracket expansion: an argmin sitting ON the grid edge means the search
    // never bracketed the optimum (PR48's default grid was 0.3-8 NM, centred
    // on a 1 NM slider, and reported the 8.0 NM EDGE cell as the winner while
    // every other fit clustered at 9-10 NM). Extend geometrically past the
    // touched edge, up to twice, and flag the result if it STILL touches.
    let boundaryLimited = false;
    if (options.expand) {
        for (let ex = 0; ex < 2; ex++) {
            const sortedNow = results.slice().sort((a, b) => a.score - b.score);
            const bestNow = sortedNow[0];
            const marginNow = constAirFamilyMargin(bestNow.score);
            const familyNow = sortedNow.filter((r) => r.score <= bestNow.score + marginNow);
            const lo = Math.min(...ranges), hi = Math.max(...ranges);
            // Expand when any currently supported family member reaches an
            // edge, not only the knife-edge raw argmin.
            const atLow = familyNow.some((r) => r.startDist <= lo * 1.001);
            const atHigh = familyNow.some((r) => r.startDist >= hi * 0.999);
            if (!atLow && !atHigh) break;
            const extra = [];
            const seen = new Set(ranges.map((r) => r.toFixed(6)));
            for (let i = 1; i <= 8; i++) {
                if (atHigh) {
                    const candidate = hi * Math.pow(2.5, i / 8);
                    const key = candidate.toFixed(6);
                    if (!seen.has(key)) { seen.add(key); extra.push(candidate); }
                }
                if (atLow && lo > 200 * 1.001) {
                    const candidate = Math.max(200, lo / Math.pow(2.5, i / 8));
                    const key = candidate.toFixed(6);
                    if (!seen.has(key)) { seen.add(key); extra.push(candidate); }
                }
            }
            // The low-range search has reached its physical/numerical floor.
            // Do not append eight duplicate 200 m rows; the final edge check
            // below will report the solution as boundary-limited.
            if (extra.length === 0) break;
            ranges = ranges.concat(extra).sort((a, b) => a - b);
            await sweepRanges(extra, 0.8 + ex * 0.1, 0.1);
        }
    }

    const sorted = results.slice().sort((a, b) => a.score - b.score);
    const bestRaw = sorted[0];

    // Heuristic family band: cells close to the winner under the displayed score. The valley is
    // often flat (near-degenerate scenes tie a 3x speed span), so a strict
    // argmin is a knife-edge — last-bit input changes teleported the headline
    // 24 kt -> 82 kt. Report the BAND, and pick a deterministic representative
    // from it: the member closest to the speed target (the user's stated
    // prior), tie-broken by lower range.
    const margin = constAirFamilyMargin(bestRaw.score);
    const family = sorted.filter((r) => r.score <= bestRaw.score + margin);
    let best = bestRaw;
    if (family.length > 1 && speedTarget !== null) {
        best = family.slice().sort((a, b) =>
            Math.abs(a.speed - speedTarget) - Math.abs(b.speed - speedTarget)
            || a.startDist - b.startDist)[0];
    }
    const lo = Math.min(...ranges), hi = Math.max(...ranges);
    const speedLo = speeds[0], speedHi = speeds[speeds.length - 1];
    const touchesRangeEdge = (row) => row.startDist <= lo * 1.001
        || row.startDist >= hi * 0.999;
    // Completeness applies to the reported representative AND its supported
    // family, not just the raw argmin. It also applies when the user supplied
    // explicit bounds: an edge result is a bound, never a converged optimum.
    const touchesSpeedEdge = (row) => row.speed <= speedLo * 1.001
        || row.speed >= speedHi * 0.999;
    const rangeBoundaryLimited = touchesRangeEdge(best) || family.some(touchesRangeEdge);
    const speedBoundaryLimited = touchesSpeedEdge(best) || family.some(touchesSpeedEdge);
    boundaryLimited = rangeBoundaryLimited || speedBoundaryLimited;
    const familyBand = {
        rangeLo: Math.min(...family.map((r) => r.startDist)),
        rangeHi: Math.max(...family.map((r) => r.startDist)),
        speedLo: Math.min(...family.map((r) => r.speed)),
        speedHi: Math.max(...family.map((r) => r.speed)),
        count: family.length,
        total: results.length,
    };

    // Consumers render `results` as a range-major heatmap indexed against the
    // sorted ranges/speeds arrays. Expansion appends rows out of order (low-end
    // expansion is descending), so restore canonical grid order before return.
    results.sort((a, b) => a.startDist - b.startDist || a.speed - b.speed);
    return {
        ranges, speeds, results, best, bestRaw, sorted, familyBand, boundaryLimited, speedTarget,
        ...(options.fitWind ? {fitWind: true} : {}),
        boundaryAxes: {
            range: rangeBoundaryLimited,
            speed: speedBoundaryLimited,
        },
    };
}

/**
 * Full-resolution display/apply track for a sweep combo: solve the QP on the
 * downsample, linearly upsample its range profile (lambda) onto the full-res
 * rays, then smooth. (Re-solving the QP at full n/fps re-amplifies the
 * per-frame jitter terms and skews the held speed — measured 45.8±9.7 kt vs
 * 43.5±0.4 kt on a 43.4 kt truth — so upsampling lambda is the right way.)
 */
export function constAirSpeedTrack(dataset, startDist, speedMs, options = {}) {
    const {ds: d2, stride} = downsampleDataset(dataset, options.targetN ?? 2500);
    const vSigma = options.vSigma ?? 3 * KNOTS_TO_MS;
    // rangeFloor is what actually activates minDist (see sweepConstAirSpeed).
    const {lam, wind} = traversePlausible(d2, startDist,
        {fitWind: options.fitWind, vTarget: speedMs, vSigma, iters: 3, K: 25, minDist: 120, rangeFloor: true});
    const {n, fps, S, D} = dataset;
    const raw = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const u = Math.min(f / stride, d2.n - 1);
        const i = Math.min(Math.floor(u), d2.n - 2);
        const t = u - i;
        const L = lam[i] * (1 - t) + lam[i + 1] * t;
        raw[f * 3] = S[f * 3] + D[f * 3] * L;
        raw[f * 3 + 1] = S[f * 3 + 1] + D[f * 3 + 1] * L;
        raw[f * 3 + 2] = S[f * 3 + 2] + D[f * 3 + 2] * L;
    }
    const {K: smoothK, curvature} = trajectorySmoothingSettings(n, fps);
    const track = smoothTrackBspline(raw, n, smoothK, curvature);
    return {track, badFrames: 0, ...(wind ? {wind} : {})};
}

function defaultRangeList(dataset) {
    // 2..45 NM in 1 NM steps — reasonable envelope for air encounters
    const out = [];
    for (let nm = 2; nm <= 45; nm += 1) out.push(nm * METERS_PER_NM);
    return out;
}

function defaultSpeedList() {
    // Log-spaced 15..650 kt: proportional resolution everywhere, so slow
    // objects (a 43 kt drifter) are representable, not just the jet band —
    // the old linear 100..650 kt grid could not express slow truths at all.
    const out = [];
    const lo = 15, hi = 650, count = 32;
    for (let i = 0; i < count; i++) {
        out.push(lo * Math.pow(hi / lo, i / (count - 1)) * KNOTS_TO_MS);
    }
    return out;
}

/** Compact copy of metrics without the per-frame series (for result tables). */
export function summarizeMetrics(m) {
    const pick = (s) => ({min: s.min, max: s.max, mean: s.mean, rms: s.rms, std: s.std});
    return {
        groundSpeed: pick(m.groundSpeed),
        airSpeed: pick(m.airSpeed),
        verticalSpeed: pick(m.verticalSpeed),
        gLoad: pick(m.gLoad),
        turnRate: pick(m.turnRate),
        altitude: pick(m.altitude),
        range: pick(m.range),
        groundHeading: {...m.groundHeading},
    };
}

// ---------------------------------------------------------------------------
// Plausible traverse: spline QP with soft speed target (IRLS)
// ---------------------------------------------------------------------------

// Small cache for bsplineBasis. The basis depends ONLY on (n, K), and the
// sweep rebuilds the identical one for every grid cell — 44 ranges x N speeds x
// IRLS iterations, all with the same frame count and control-point count. Every
// read site destructures it read-only (`const [seg, w] = B[fr]`, then `w[q]`);
// verified nothing writes to the returned structure, which is what makes
// sharing it safe. If you ever need to mutate a basis, clone it first.
//
// Capped, and keyed on both parameters, because a run legitimately uses a few
// different (n, K) pairs: full-resolution and downsampled datasets, and the
// smoothing pass with its own K.
const _bsplineCache = new Map();
const _speedBasisCache = new WeakMap();
const PLAUSIBLE_WORKSPACE = Symbol("plausible workspace");
const BSPLINE_CACHE_MAX = 8;

/** Uniform cubic B-spline basis over n frames with K control points. */
export function bsplineBasis(n, K) {
    const key = n + ":" + K;
    const hit = _bsplineCache.get(key);
    if (hit) return hit;
    const B = [];
    const nSeg = K - 3;
    for (let f = 0; f < n; f++) {
        const u = (f / (n - 1)) * nSeg;
        const seg = Math.min(nSeg - 1, Math.floor(u));
        const t = u - seg;
        B.push([seg, [
            (1 - t) ** 3 / 6,
            (3 * t ** 3 - 6 * t ** 2 + 4) / 6,
            (-3 * t ** 3 + 3 * t ** 2 + 3 * t + 1) / 6,
            t ** 3 / 6,
        ]]);
    }
    if (_bsplineCache.size >= BSPLINE_CACHE_MAX) {
        // Cheap FIFO eviction — the working set is 2-3 entries in practice.
        _bsplineCache.delete(_bsplineCache.keys().next().value);
    }
    _bsplineCache.set(key, B);
    return B;
}

// Consecutive speed rows always visit the first frame's four columns, then
// any new columns from the next frame. Cache this symbolic layout with the
// immutable basis; it contains no observations or iteration-dependent values.
function speedBasis(B) {
    let rows = _speedBasisCache.get(B);
    if (rows) return rows;
    rows = [];
    for (let f = 0; f < B.length - 1; f++) {
        const [a, wa] = B[f], [b, wb] = B[f + 1];
        const offset = Math.min(4, b - a);
        const cols = [a, a + 1, a + 2, a + 3];
        for (let q = 4 - offset; q < 4; q++) cols.push(b + q);
        rows.push({cols, offset, previous: wa.map(w => -1 * w), next: wb});
    }
    _speedBasisCache.set(B, rows);
    return rows;
}

// Constant horizontal wind bounds for the sightline fitters, in m/s.
export const SIGHTLINE_WIND_LIMIT = 40;
export function datasetForFittedWind(dataset, fit) {
    return fit?.wind?.unconstrained ? datasetWithConstantWind(dataset, 0, 0)
        : fit?.wind ? datasetWithConstantWind(dataset, fit.wind.windE, fit.wind.windN) : dataset;
}

// The final two coordinates are constant wind displacements per frame. Solve
// their box-constrained least squares exactly by checking the nine active sets.
// The unconstrained solve usually suffices; bounds never get silently clipped
// while leaving the range coordinates inconsistent with the chosen wind.
function solveWindNormalEquations(A, rhs, K, fps) {
    const limit = SIGHTLINE_WIND_LIMIT / fps;
    const initial = solveDense(A.map(row => row.slice()), rhs);
    if (Math.abs(initial[K]) <= limit && Math.abs(initial[K + 1]) <= limit) return initial;
    let best = null, bestCost = Infinity;
    for (const e of [null, -limit, limit]) for (const n of [null, -limit, limit]) {
        if (e === null && n === null) continue;
        const matrix = A.map(row => row.slice()), b = rhs.slice();
        for (const [index, value] of [[K, e], [K + 1, n]]) {
            if (value === null) continue;
            for (let i = 0; i < b.length; i++) {
                if (i !== index) { b[i] -= matrix[i][index] * value; matrix[i][index] = 0; }
            }
            matrix[index].fill(0); matrix[index][index] = 1; b[index] = value;
        }
        const c = solveDense(matrix.map(row => row.slice()), b);
        if (Math.abs(c[K]) > limit + 1e-9 || Math.abs(c[K + 1]) > limit + 1e-9) continue;
        let cost = 0;
        for (let i = 0; i < c.length; i++) {
            cost -= 2 * rhs[i] * c[i];
            for (let j = 0; j < c.length; j++) cost += c[i] * A[i][j] * c[j];
        }
        if (cost < bestCost) { best = c; bestCost = cost; }
    }
    if (!best) throw new Error("Wind-constrained range solve failed");
    return best;
}

// Geometry and constant-wind acceleration do not determine atmospheric wind.
// Use ground motion for the wind-independent comparison; never optimize a
// reporting score by inventing a large constant air-mass velocity.
function fitScoringWind() {
    return {unconstrained: true};
}

/**
 * The smoothest LOS-riding trajectory that starts at range startDist.
 *
 * Range along each ray is a smooth B-spline lambda(f); minimizes
 *     sum (|accel| in g)^2
 *   + wSpd  * sum ((airSpeed - vTarget)/vSigma)^2     [if vTarget given, IRLS]
 *   + wClimb* sum (verticalSpeed/vSigma)^2            [if wClimb > 0]
 * with a soft anchor lambda(0) = startDist (meters-scale slop).
 *
 * The speed term is the "loose target" that resolves the fundamental LOS
 * ambiguity: without it the least-maneuvering solution family is nearly
 * degenerate in range rate — for NARROW-BASELINE sightlines. When the sensor
 * itself maneuvers (an orbit), geometry alone pins the range and the speed
 * target should be dropped (see fitPlausibleBestRange). vTarget=null uses a
 * tiny |v|^2 ridge instead.
 *
 * Three option-gated behaviors, all DEFAULT OFF (existing callers byte-identical):
 *   accelStride h — the acceleration rows use a strided second difference
 *     [r-h, r, r+h]/h^2. The per-frame stencil is dominated by frame-scale LOS
 *     jitter (amplified by range and fps^2): on noisy rays the exact truth
 *     path can cost MORE than a close-in whirling one, so the QP dives toward
 *     the sensor. Striding measures acceleration over ~h frames and restores
 *     the real signal.
 *   rangeFloor (+minDist=120) — soft range floor, same pattern as
 *     traverseMinSpeed; without it the QP can drive lambda NEGATIVE (object
 *     behind the sensor) at close anchor ranges.
 *   smoothOutput (+smoothSpacingSec=2, smoothK, smoothCurvature) — post-smooth
 *     the returned track (control point every ~spacing seconds) so the track
 *     and anything scored from it shed exact-ray jitter; loop-scale motion
 *     (tens of seconds) stays visible.
 *
 * options: {K=25, vTarget (m/s|null), vSigma (m/s), wSpd=1, wClimb=0,
 *           iters=6, anchorFrame=0, accelStride=1, rangeFloor=false,
 *           minDist=120, smoothOutput=false, smoothSpacingSec=2, fitWind=false}
 * fitWind solves bounded constant E/N wind alongside the speed-constrained
 * range curve. Without a speed term, wind is reported as undetermined.
 * Returns {track, lam}.
 */
export function traversePlausible(dataset, startDist, options = {}) {
    const {n, fps, S, D} = dataset;
    const W = options.fitWind ? new Float64Array(n * 3) : dataset.W;
    const K = options.K ?? 25;
    const vTarget = options.vTarget ?? null;
    const freeWind = options.fitWind && vTarget !== null;
    const dim = K + (freeWind ? 2 : 0);
    let windE = 0, windN = 0;
    const vSigma = options.vSigma ?? 50 * KNOTS_TO_MS;
    const wSpd = options.wSpd ?? 1;
    const wClimb = options.wClimb ?? 0;
    const iters = options.iters ?? 6;
    const anchorFrame = Math.max(0, Math.min(n - 1, Math.round(options.anchorFrame ?? 0)));
    const hA = Math.max(1, Math.min(Math.round(options.accelStride ?? 1), Math.floor((n - 1) / 2)));
    const minDist = options.minDist ?? 120;
    const useFloor = options.rangeFloor ?? false;
    const floorW = new Float64Array(n);

    const B = bsplineBasis(n, K);
    const speedRows = vTarget !== null ? speedBasis(B) : null;
    const speedWeights = new Float64Array(freeWind ? 10 : 8);
    const accelScale = fps * fps / G_ACCEL / (hA * hA);
    const lam = new Float64Array(n).fill(startDist);
    let c = null;

    // Scratch for the row assembly in `stencil` below — allocated once per
    // solve instead of once per row. scratchSeen is a membership flag reset
    // only for the entries actually touched, so clearing is O(touched).
    const scratchVal = new Float64Array(K);
    const scratchSeen = new Uint8Array(K);
    const scratchIdx = new Int32Array(K);

    // Acceleration is independent of the IRLS iterate. Copy its completed
    // prefix of the normal equations; adding separately summed matrices here
    // would reorder floating-point additions and perturb the optimizer.
    const workspace = options[PLAUSIBLE_WORKSPACE];
    let acceleration = workspace?.acceleration;
    if (acceleration && (acceleration.dataset !== dataset || acceleration.K !== K
        || acceleration.hA !== hA || acceleration.fps !== fps || acceleration.dim !== dim)) acceleration = null;
    const maxIters = useFloor ? iters + 5 : iters;
    const A = Array.from({length: dim}, () => new Float64Array(dim));
    const rhs = new Float64Array(dim);
    for (let iter = 0; iter < maxIters; iter++) {
        for (const row of A) row.fill(0);
        rhs.fill(0);
        const addRow = (cols, weights, constTerm, w2 = 1) => {
            for (let i = 0; i < cols.length; i++) {
                rhs[cols[i]] -= w2 * weights[i] * constTerm;
                for (let j = 0; j < cols.length; j++) {
                    A[cols[i]][cols[j]] += w2 * weights[i] * weights[j];
                }
            }
        };
        // one least-squares row per (frame stencil, xyz component)
        //
        // This is the hottest code in the analysis: once per (range, speed)
        // grid cell, per IRLS iteration, per frame, per component. It used to
        // build a `new Map()` and two spread arrays here, which on a full sweep
        // is tens of millions of Map allocations. The scratch buffers below do
        // the same accumulation without allocating.
        //
        // ORDER IS LOAD-BEARING, not just the arithmetic. The Map version
        // iterated keys in FIRST-INSERTION order, and the outer/inner loops in
        // addRow accumulate into A in that order — so `touched` must record the
        // same first-touch order or the floating-point sums differ in their last
        // bits. Those bits feed the reweighting, so "close enough" is not
        // enough here. tests/TraversePlausibleIdentity.test.js pins this.
        //
        // Column indices are NOT contiguous in general: with accelStride the
        // stencil frames are far apart, so their b-spline segments can be
        // disjoint. Hence a full-width scratch plus an explicit touched list,
        // rather than a sliding window.
        const stencil = (frames, cs, scale, compW) => {
            for (let comp = 0; comp < 3; comp++) {
                if (compW && compW[comp] === 0) continue;
                let constTerm = 0;
                let nTouched = 0;
                for (let i = 0; i < frames.length; i++) {
                    const fr = frames[i];
                    constTerm += cs[i] * S[fr * 3 + comp];
                    const [seg, w] = B[fr];
                    const dcomp = D[fr * 3 + comp];
                    for (let q = 0; q < 4; q++) {
                        const k = seg + q;
                        if (!scratchSeen[k]) {
                            scratchSeen[k] = 1;
                            scratchIdx[nTouched++] = k;
                            scratchVal[k] = 0;
                        }
                        scratchVal[k] += cs[i] * w[q] * dcomp;
                    }
                }
                const sc = scale * (compW ? compW[comp] : 1);
                const cTerm = constTerm * sc;
                // Inlined addRow over the scratch, in first-touch order.
                for (let a = 0; a < nTouched; a++) {
                    const ca = scratchIdx[a];
                    const wa = scratchVal[ca] * sc;
                    rhs[ca] -= wa * cTerm;
                    const Aa = A[ca];
                    for (let b = 0; b < nTouched; b++) {
                        const cb = scratchIdx[b];
                        Aa[cb] += wa * (scratchVal[cb] * sc);
                    }
                }
                for (let a = 0; a < nTouched; a++) scratchSeen[scratchIdx[a]] = 0;
            }
        };

        // acceleration rows, in g (strided second difference when accelStride > 1)
        if (acceleration) {
            for (let k = 0; k < K; k++) A[k].set(acceleration.A[k]);
            rhs.set(acceleration.rhs);
        } else {
            for (let r = hA; r <= n - 1 - hA; r++) stencil([r - hA, r, r + hA], [1, -2, 1], accelScale);
            acceleration = {dataset, K, hA, fps, dim, A: A.map(row => row.slice()), rhs: rhs.slice()};
            if (workspace) workspace.acceleration = acceleration;
        }

        // soft anchor lambda(anchorFrame) = startDist (weight 10 => centimeter-to-meter
        // slop; a hard/huge weight wrecks the conditioning of the dense solve)
        {
            const [seg, w] = B[anchorFrame];
            addRow([seg, seg + 1, seg + 2, seg + 3], w, -startDist, 10);
        }

        if (vTarget !== null) {
            // IRLS speed target: linearize |v_air| about the current estimate's
            // direction u: residual = u . v_air - vTarget/fps
            const wv = Math.sqrt(wSpd) * fps / vSigma;
            for (let f = 0; f < n - 1; f++) {
                const a0 = S[(f + 1) * 3] + lam[f + 1] * D[(f + 1) * 3] - (S[f * 3] + lam[f] * D[f * 3]) - (freeWind ? windE : W[f * 3]);
                const a1 = S[(f + 1) * 3 + 1] + lam[f + 1] * D[(f + 1) * 3 + 1] - (S[f * 3 + 1] + lam[f] * D[f * 3 + 1]) - (freeWind ? windN : W[f * 3 + 1]);
                const a2 = S[(f + 1) * 3 + 2] + lam[f + 1] * D[(f + 1) * 3 + 2] - (S[f * 3 + 2] + lam[f] * D[f * 3 + 2]) - W[f * 3 + 2];
                const al = Math.hypot(a0, a1, a2) || 1;
                const u0 = a0 / al, u1 = a1 / al, u2 = a2 / al;
                let constTerm = -(u0 * W[f * 3] + u1 * W[f * 3 + 1] + u2 * W[f * 3 + 2]) - vTarget / fps;
                const b = f * 3, next = b + 3;
                constTerm += -1 * S[b] * u0;
                constTerm += -1 * S[b + 1] * u1;
                constTerm += -1 * S[b + 2] * u2;
                constTerm += S[next] * u0;
                constTerm += S[next + 1] * u1;
                constTerm += S[next + 2] * u2;
                const dot0 = D[b] * u0 + D[b + 1] * u1 + D[b + 2] * u2;
                const dot1 = D[next] * u0 + D[next + 1] * u1 + D[next + 2] * u2;
                const row = speedRows[f];
                const {offset, previous, next: nextWeights} = row;
                const cols = freeWind ? [...row.cols, K, K + 1] : row.cols;
                // Keep the original zero-add and falsy reset, including signed
                // zero, and combine overlapping columns in first-touch order.
                for (let q = 0; q < 4; q++) speedWeights[q] = 0 + previous[q] * dot0;
                for (let q = 4; q < cols.length; q++) speedWeights[q] = 0;
                for (let q = 0; q < 4; q++) {
                    const k = offset + q;
                    speedWeights[k] = (speedWeights[k] || 0) + nextWeights[q] * dot1;
                }
                if (freeWind) { speedWeights[cols.length - 2] = -u0; speedWeights[cols.length - 1] = -u1; }
                for (let q = 0; q < cols.length; q++) speedWeights[q] *= wv;
                const cTerm = constTerm * wv;
                for (let a = 0; a < cols.length; a++) {
                    const ca = cols[a], wa = speedWeights[a];
                    rhs[ca] -= wa * cTerm;
                    const Aa = A[ca];
                    Aa[ca] += wa * wa;
                    // Only this row's products are symmetric. Add to each
                    // existing entry separately: weighted anchor/floor rows
                    // can leave the accumulated matrix slightly asymmetric.
                    for (let b = a + 1; b < cols.length; b++) {
                        const cb = cols[b], product = wa * speedWeights[b];
                        Aa[cb] += product;
                        A[cb][ca] += product;
                    }
                }
            }
        } else {
            // tiny velocity ridge to regularize the near-degenerate smooth modes
            const wv = 0.002 * fps / (350 * KNOTS_TO_MS);
            for (let f = 0; f < n - 1; f++) stencil([f, f + 1], [-1, 1], wv);
        }

        if (wClimb > 0) {
            const wc = Math.sqrt(wClimb) * fps / vSigma;
            for (let f = 0; f < n - 1; f++) stencil([f, f + 1], [-1, 1], wc, [0, 0, 1]);
        }

        // soft floor rows where lambda dipped below minDist on a prior iterate
        if (useFloor) {
            for (let f = 0; f < n; f++) {
                if (floorW[f] > 0) {
                    const [seg, w] = B[f];
                    addRow([seg, seg + 1, seg + 2, seg + 3], w, -minDist, floorW[f]);
                }
            }
        }

        for (let k = 0; k < dim; k++) A[k][k] += 1e-10 * (A[k][k] || 1);
        if (freeWind) {
            const precision = (n - 1) * (fps / WIND_PRIOR_SIGMA_MS) ** 2;
            A[K][K] += precision; A[K + 1][K + 1] += precision;
        }
        c = freeWind ? solveWindNormalEquations(A, rhs, K, fps) : solveDense(A, rhs);
        if (freeWind) { windE = c[K]; windN = c[K + 1]; }
        for (let f = 0; f < n; f++) {
            const [seg, w] = B[f];
            lam[f] = c[seg] * w[0] + c[seg + 1] * w[1] + c[seg + 2] * w[2] + c[seg + 3] * w[3];
        }
        let viol = false;
        if (useFloor) {
            for (let f = 0; f < n; f++) if (lam[f] < minDist) { floorW[f] = (floorW[f] || 1) * 8; viol = true; }
        }
        if (vTarget === null && !viol) break;
        if (vTarget !== null && iter >= iters - 1 && !viol) break;
    }

    let track = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        track[f * 3] = S[f * 3] + D[f * 3] * lam[f];
        track[f * 3 + 1] = S[f * 3 + 1] + D[f * 3 + 1] * lam[f];
        track[f * 3 + 2] = S[f * 3 + 2] + D[f * 3 + 2] * lam[f];
    }
    // Report whether the soft range floor SHAPED this solution. Two
    // conditions, BOTH required: some frame tripped the soft-floor rows
    // during the solve, AND the final solution actually rides the floor.
    // Rows alone over-report — a transient dip on an early iterate that the
    // final solve corrects leaves floorW set while the answer is genuinely
    // floor-free, and that misbranding routed real close passes to the
    // speed prior. Proximity alone also over-reported, from the other side:
    // measured on the SMOOTHED lambda, whose B-spline overshoot dips below
    // the raw closest approach, it falsely condemned a legitimate ~130 m
    // flyby — which is why this runs HERE, on the raw solve, before
    // smoothing rewrites lam.
    let floorActive = false;
    if (useFloor) {
        let rows = false, riding = false;
        for (let f = 0; f < n; f++) {
            if (floorW[f] > 0) rows = true;
            if (lam[f] <= minDist * 1.02) riding = true;
            if (rows && riding) { floorActive = true; break; }
        }
    }
    // Optional post-smoothing: LIGHT (control point every smoothSpacingSec
    // seconds) — sheds frame-scale LOS jitter, keeps real loops visible.
    if (options.smoothOutput) {
        const {K: smoothK, curvature} = trajectorySmoothingSettings(n, fps, {
            spacing: options.smoothSpacingSec ?? 2, maxK: 400,
            K: options.smoothK, curvature: options.smoothCurvature,
        });
        track = smoothTrackBspline(track, n, smoothK, curvature);
        for (let f = 0; f < n; f++) {
            lam[f] = Math.hypot(track[f * 3] - S[f * 3], track[f * 3 + 1] - S[f * 3 + 1], track[f * 3 + 2] - S[f * 3 + 2]);
        }
    }
    const wind = options.fitWind
        ? (freeWind ? {windE: windE * fps, windN: windN * fps} : fitScoringWind(dataset, track)) : undefined;
    return {track, lam, floorActive, ...(wind ? {wind} : {})};
}

// Smoothing-spline fit: a low-order uniform cubic B-spline fit to a track
// (independent least squares per axis) with a second-difference curvature
// penalty on the control points. Used to shed sensor jitter from a min-speed
// path: fewer control points and a curvature penalty => smoother => lower
// spurious g-load. The curvature penalty also tames the classic B-spline
// boundary overshoot (the endpoint control points are otherwise data-starved
// and can spike the g-load in the first/last fraction of a second).
const _smoothSystemCache = new Map();

function smoothTrackBspline(pts, n, K, curvature = 0) {
    K = Math.max(4, Math.min(K, n));
    const B = bsplineBasis(n, K);
    const key = `${n}:${K}:${curvature}`;
    let system = _smoothSystemCache.get(key);
    if (!system) {
        const A = Array.from({length: K}, () => new Float64Array(K));
        for (let f = 0; f < n; f++) {
            const [seg, w] = B[f];
            for (let i = 0; i < 4; i++) {
                for (let j = 0; j < 4; j++) A[seg + i][seg + j] += w[i] * w[j];
            }
        }
        if (curvature > 0) {
            for (let k = 1; k < K - 1; k++) {
                const cols = [k - 1, k, k + 1], cs = [1, -2, 1];
                for (let i = 0; i < 3; i++) {
                    for (let j = 0; j < 3; j++) A[cols[i]][cols[j]] += curvature * cs[i] * cs[j];
                }
            }
        }
        for (let k = 0; k < K; k++) A[k][k] += 1e-9 * (A[k][k] || 1);
        system = factorDense(A);
        if (_smoothSystemCache.size >= BSPLINE_CACHE_MAX) {
            _smoothSystemCache.delete(_smoothSystemCache.keys().next().value);
        }
        _smoothSystemCache.set(key, system);
    }
    const out = new Float64Array(n * 3);
    for (let a = 0; a < 3; a++) {
        const rhs = new Float64Array(K);
        for (let f = 0; f < n; f++) {
            const [seg, w] = B[f];
            const p = pts[f * 3 + a];
            for (let i = 0; i < 4; i++) rhs[seg + i] += w[i] * p;
        }
        const c = solveFactoredDense(system, rhs);
        for (let f = 0; f < n; f++) {
            const [seg, w] = B[f];
            out[f * 3 + a] = c[seg] * w[0] + c[seg + 1] * w[1] + c[seg + 2] * w[2] + c[seg + 3] * w[3];
        }
    }
    return out;
}

/**
 * The SLOWEST LOS-riding trajectory — the minimum-(air-)speed object consistent
 * with the sightlines. Range along each ray is a smooth B-spline lambda(f)
 * chosen to minimize the summed squared per-frame AIR displacement
 *     sum | X(f+1) - X(f) - W(f) |^2 ,   X(f) = S(f) + lambda(f) D(f)
 * (W = per-frame wind drift, so with wind on this is minimum AIR speed: a
 * balloon or lantern moving with the air reads ~0). A soft floor keeps
 * lambda >= minDist so the object can't fall behind the camera, and a light
 * curvature ridge conditions the near-parallel-ray null modes.
 *
 * Riding the rays EXACTLY, though, inherits the jet-track and FLIR pointing
 * jitter as spurious speed/g spikes (tens of kt, several g) even where lambda is
 * smooth — so the final path is smoothed with a low-order B-spline that keeps
 * the slow range profile but sits a few hundredths of a degree off the noisy
 * rays, exactly as a real drifting object (or an analyst's hand-drawn spline)
 * does. That drops the g-load to a fraction of a g at ~0.03 deg LOS residual.
 *
 * Where traversePlausible minimizes MANEUVERING (and lands fast and smooth),
 * this minimizes SPEED. For a sensor orbiting a slow, close object the apparent
 * motion is mostly the sensor's own parallax, so the slowest consistent object
 * is a near-static drifter — the Aguadilla / GoFast lantern answer.
 *
 * options: {K=30, minDist=120, floorIters=5, accelReg=0.15, smoothK, fitWind=false}
 * fitWind adds bounded E/N wind coordinates to the same least-squares system.
 * Returns {track, lam} (lam = the smoothed track's slant range along each ray).
 */
export function traverseMinSpeed(dataset, options = {}) {
    const {n, fps, S, D} = dataset;
    const freeWind = options.fitWind === true;
    const W = freeWind ? new Float64Array(n * 3) : dataset.W;
    const K = Math.max(4, Math.min(options.K ?? 30, n));
    const dim = K + (freeWind ? 2 : 0);
    let windE = 0, windN = 0;
    const minDist = options.minDist ?? 120;
    const floorIters = Math.max(1, options.floorIters ?? 5);
    const accelReg = options.accelReg ?? 0.15;   // tiny curvature ridge, position units
    // End-level pull: after the floor converges, a few IRLS iterations add
    // speed-level rows over the first/last levelEndsFrac of frames, pulling
    // the air speed there toward the interior median of the FIRST converged
    // iterate (vRef, frozen — recomputing it each iteration ratchets the
    // target). The B-spline endpoints are data-starved, so the raw solution
    // over/undershoots speed at the clip ends (a constant-speed truth read
    // 35-45 kt); the level rows fix the boundary without touching the
    // interior objective.
    const levelW = options.levelW ?? 0.2;
    const levelIters = Math.max(0, options.levelIters ?? 3);
    const levelEndsFrac = options.levelEndsFrac ?? 0.15;

    const B = bsplineBasis(n, K);
    const lam = new Float64Array(n).fill(1000);
    const floorW = new Float64Array(n);   // per-frame soft-floor weight (0 until violated)
    let c = null;

    // current iterate positions + unit air velocities (IRLS linearization)
    const pos = new Float64Array(n * 3);
    const updatePos = () => {
        for (let f = 0; f < n; f++) {
            pos[f * 3] = S[f * 3] + D[f * 3] * lam[f];
            pos[f * 3 + 1] = S[f * 3 + 1] + D[f * 3 + 1] * lam[f];
            pos[f * 3 + 2] = S[f * 3 + 2] + D[f * 3 + 2] * lam[f];
        }
    };
    const u = new Float64Array((n - 1) * 3);
    let vRef = 0, vRefFrozen = false;
    const updateU = () => {
        const spds = [];
        for (let f = 0; f < n - 1; f++) {
            const b = f * 3, d = (f + 1) * 3;
            const vx = pos[d] - pos[b] - (freeWind ? windE : W[b]), vy = pos[d + 1] - pos[b + 1] - (freeWind ? windN : W[b + 1]), vz = pos[d + 2] - pos[b + 2] - W[b + 2];
            const vl = Math.hypot(vx, vy, vz) || 1;
            u[b] = vx / vl; u[b + 1] = vy / vl; u[b + 2] = vz / vl;
            spds.push(vl * fps);
        }
        if (vRefFrozen) return;
        const trim = Math.min(Math.floor(spds.length / 4), Math.round(10 * fps));
        const inner = spds.slice(trim, spds.length - trim).sort((a, b2) => a - b2);
        vRef = inner[Math.floor(inner.length / 2)];
        vRefFrozen = true;
    };

    const useLevel = levelW > 0 && levelIters > 0;
    const totalIters = floorIters + (useLevel ? levelIters : 0);
    let irlsOn = false;

    for (let iter = 0; iter < totalIters; iter++) {
        const A = [];
        for (let k = 0; k < dim; k++) A.push(new Float64Array(dim));
        const rhs = new Float64Array(dim);
        const addRow = (cols, weights, constTerm, w2 = 1) => {
            for (let i = 0; i < cols.length; i++) {
                rhs[cols[i]] -= w2 * weights[i] * constTerm;
                for (let j = 0; j < cols.length; j++) A[cols[i]][cols[j]] += w2 * weights[i] * weights[j];
            }
        };
        // add a least-squares row: sum_i cs[i] * X(frames[i])[comp], per component
        const stencilRow = (frames, cs, sBase, w2, fitWindRow = false) => {
            for (let comp = 0; comp < 3; comp++) {
                let constTerm = 0;
                const colW = new Map();
                for (let i = 0; i < frames.length; i++) {
                    const fr = frames[i];
                    constTerm += cs[i] * S[fr * 3 + comp];
                    const bf = B[fr], dc = D[fr * 3 + comp];
                    for (let q = 0; q < 4; q++) {
                        const k = bf[0] + q;
                        colW.set(k, (colW.get(k) || 0) + cs[i] * bf[1][q] * dc);
                    }
                }
                if (freeWind && fitWindRow && comp < 2) colW.set(K + comp, -1);
                constTerm += sBase[comp];   // extra constant (e.g. -wind) per component
                addRow([...colW.keys()], [...colW.values()], constTerm, w2);
            }
        };

        // minimum-air-speed rows: X(f+1) - X(f) - W(f)
        for (let f = 0; f < n - 1; f++) {
            stencilRow([f, f + 1], [-1, 1], [-W[f * 3], -W[f * 3 + 1], -W[f * 3 + 2]], 1, true);
        }
        // light trajectory-curvature ridge (conditions null modes; too small to bias speed)
        if (accelReg > 0) {
            const w2 = accelReg * accelReg;
            for (let r = 1; r <= n - 2; r++) stencilRow([r - 1, r, r + 1], [1, -2, 1], [0, 0, 0], w2);
        }
        // soft range floor: pull lambda(f) toward minDist only where it dipped below
        for (let f = 0; f < n; f++) {
            if (floorW[f] > 0) {
                const bf = B[f];
                addRow([bf[0], bf[0] + 1, bf[0] + 2, bf[0] + 3], bf[1], -minDist, floorW[f]);
            }
        }

        // end-level rows: (u_f . v_air(f)) = vRef over the boundary windows,
        // linearized about the previous iterate's unit air velocity u_f
        if (irlsOn) {
            const w = levelW * fps;
            const endF = Math.round(levelEndsFrac * n);
            for (let f = 0; f < n - 1; f++) {
                if (f >= endF && f < n - 1 - endF) continue;
                const b = f * 3;
                const uf0 = u[b], uf1 = u[b + 1], uf2 = u[b + 2];
                let constTerm = -(uf0 * W[b] + uf1 * W[b + 1] + uf2 * W[b + 2]) - vRef / fps;
                const colW = new Map();
                const frames = [f, f + 1], cs = [-1, 1];
                for (let i = 0; i < 2; i++) {
                    const fr = frames[i];
                    constTerm += cs[i] * (uf0 * S[fr * 3] + uf1 * S[fr * 3 + 1] + uf2 * S[fr * 3 + 2]);
                    const bf = B[fr];
                    const dDotU = D[fr * 3] * uf0 + D[fr * 3 + 1] * uf1 + D[fr * 3 + 2] * uf2;
                    for (let q = 0; q < 4; q++) {
                        const k = bf[0] + q;
                        colW.set(k, (colW.get(k) || 0) + cs[i] * bf[1][q] * dDotU);
                    }
                }
                if (freeWind) { colW.set(K, -uf0); colW.set(K + 1, -uf1); }
                addRow([...colW.keys()], [...colW.values()].map(v => v * w), constTerm * w);
            }
        }

        for (let k = 0; k < dim; k++) A[k][k] += 1e-9 * (A[k][k] || 1);
        if (freeWind) {
            const precision = (n - 1) / WIND_PRIOR_SIGMA_MS ** 2;
            A[K][K] += precision; A[K + 1][K + 1] += precision;
        }
        c = freeWind ? solveWindNormalEquations(A, rhs, K, fps) : solveDense(A, rhs);
        if (freeWind) { windE = c[K]; windN = c[K + 1]; }
        for (let f = 0; f < n; f++) {
            const bf = B[f];
            lam[f] = c[bf[0]] * bf[1][0] + c[bf[0] + 1] * bf[1][1] + c[bf[0] + 2] * bf[1][2] + c[bf[0] + 3] * bf[1][3];
        }
        let viol = false;
        for (let f = 0; f < n; f++) if (lam[f] < minDist) { floorW[f] = (floorW[f] || 1) * 8; viol = true; }
        updatePos();
        if (!viol && !irlsOn && useLevel) {
            irlsOn = true;      // floor pass converged; switch on the level rows
            updateU();
            continue;
        }
        if (irlsOn) updateU();
        if (!viol && !irlsOn) break;
    }

    // exact-ray min-speed track (smooth range, but rides the jittery rays)
    const raw = Float64Array.from(pos);
    // Smooth off the sensor jitter with ~6 s control-point spacing plus a light
    // curvature penalty (scaled by data-per-knot so the smoothness is consistent
    // across clip lengths). Kept loose enough to still track the sightlines to a
    // few hundredths of a degree, but smooth enough that the peak g-load sits
    // near a real drifting object's (a few tenths of a g, mostly residual sensor
    // jitter) rather than the tens-of-kt / several-g an exactly-on-ray path shows.
    const {K: smoothK, curvature} = trajectorySmoothingSettings(n, fps, {
        K: options.smoothK, curvature: options.smoothCurvature,
    });
    const track = smoothTrackBspline(raw, n, smoothK, curvature);
    // report the smoothed track's actual slant range along each sightline
    for (let f = 0; f < n; f++) {
        lam[f] = Math.hypot(track[f * 3] - S[f * 3], track[f * 3 + 1] - S[f * 3 + 1], track[f * 3 + 2] - S[f * 3 + 2]);
    }
    return {track, lam, ...(freeWind ? {wind: {windE: windE * fps, windN: windN * fps}} : {})};
}

/**
 * Sweep traversePlausible over a list of start ranges: the "how much
 * maneuvering does each distance require" profile.
 * options: {ranges (m), vTarget, vSigma, wClimb, K, progress}
 * Returns [{startDist, metrics, score, track?}] (tracks omitted unless keepTracks).
 */
export async function rangeProfile(dataset, options = {}) {
    const sizeCost = compileAngularSizeFit(dataset);
    const ranges = (options.ranges ?? defaultRangeList(dataset)).slice().sort((a, b) => a - b);
    const vTarget = options.vTarget ?? null;
    const vSigma = options.vSigma ?? 50 * KNOTS_TO_MS;
    const scoreSpeedWeight = options.scoreSpeedWeight ?? 0;
    const out = [];
    for (let i = 0; i < ranges.length; i++) {
        const {track, lam, wind} = traversePlausible(dataset, ranges[i], options);
        const m = trackMetrics(datasetForFittedWind(dataset, {wind}), track);
        let score = straightFlightScore(m) + sizeCost(track);
        const windCost = wind ? windPriorCost(wind.windE, wind.windN) : 0;
        score += windCost;
        if (vTarget !== null && scoreSpeedWeight > 0) {
            score += scoreSpeedWeight * ((m.airSpeed.mean - vTarget) / vSigma) ** 2;
        }
        const row = {
            startDist: ranges[i],
            ...(wind ? {wind} : {}),
            endDist: lam[dataset.n - 1],
            minDist: Math.min(...lam),
            score,
            windCost,
            metrics: summarizeMetrics(m),
        };
        if (options.keepTracks) row.track = track;
        out.push(row);
        if (options.progress) await options.progress((i + 1) / ranges.length);
    }
    if (out.length) {
        let bestIndex = 0;
        for (let i = 1; i < out.length; i++) if (out[i].score < out[bestIndex].score) bestIndex = i;
        const sortedScores = out.map((row) => row.score).sort((a, b) => a - b);
        const median = sortedScores[Math.floor(sortedScores.length / 2)];
        const threshold = out[bestIndex].score + 0.5 * (median - out[bestIndex].score);
        let familyLo = bestIndex, familyHi = bestIndex;
        while (familyLo > 0 && out[familyLo - 1].score <= threshold) familyLo--;
        while (familyHi < out.length - 1 && out[familyHi + 1].score <= threshold) familyHi++;
        out.bestIndex = bestIndex;
        out.familyLoIndex = familyLo;
        out.familyHiIndex = familyHi;
        out.boundaryLimited = familyLo === 0 || familyHi === out.length - 1;
        out.boundarySides = {lo: familyLo === 0, hi: familyHi === out.length - 1};
    }
    return out;
}

/**
 * Autonomous plausible fit: find the START RANGE whose smoothest LOS-riding
 * trajectory is the least implausible, then return the full-quality solution
 * there.
 *
 * Two-stage search:
 *   Stage 1 scores a PURE-smoothness (vTarget:null) coarse log sweep — when
 *   the sensor itself maneuvers (an orbit, a hard turn), geometry alone pins
 *   the range and this valley is DECISIVE (measured: median-best score margin
 *   ~2.4-2.8 on orbit/Aguadilla-like scenes vs 0.000 on a straight-flying
 *   sensor). The speed prior would only poison it (a 320 kt target drags the
 *   QP off a 43 kt truth into 2+ g loops).
 *   Stage 2, only when the pure valley is flat (narrow-baseline scenes like
 *   Gimbal, where range is unobservable from geometry): fall back to the
 *   speed-target-driven sweep — there it is the SPEED TARGET that makes the
 *   plausibility-vs-range curve have a real minimum.
 *
 * All solves run with the noise-robust traversePlausible options (strided
 * acceleration stencil, soft range floor, light output smoothing) — without
 * them frame-scale LOS jitter dominates the objective and the QP dives toward
 * the sensor (and can even push lambda negative: a track BEHIND the camera).
 *
 * options: {vTarget (m/s), vSigma, rangeMin (m), rangeMax (m), coarse (count),
 *           searchK, searchIters, finalK, finalIters, decisiveMargin=0.5}
 * Returns {track, lam, startDist (m), score, profile: [{startDist, score}],
 *          usedSpeedTarget, decisiveness}.
 */
// Vertex of the parabola through (xa,fa), (xb,fb), (xc,fc) — the standard
// successive-parabolic-interpolation step, centered on the current best xb:
//   xv = xb - 0.5 * [(xb-xa)^2 (fb-fc) - (xb-xc)^2 (fb-fa)]
//              / [(xb-xa)   (fb-fc) - (xb-xc)   (fb-fa)]
// Returns null when the points are (near-)collinear or the result is not
// finite. Exported for unit tests: an earlier version mixed (xa-xc) terms
// into the xb-centered formula, which proposed out-of-bracket vertices even
// for a perfectly symmetric bracket, silently disabling the range refine.
export function parabolicVertex(xa, fa, xb, fb, xc, fc) {
    const d1 = (xb - xa) * (fb - fc);
    const d2 = (xb - xc) * (fb - fa);
    const denom = d1 - d2;
    if (!isFinite(denom) || Math.abs(denom) < 1e-12) return null;
    const xv = xb - 0.5 * ((xb - xa) * d1 - (xb - xc) * d2) / denom;
    return isFinite(xv) ? xv : null;
}

export function fitPlausibleBestRange(dataset, options = {}) {
    const sizeCost = compileAngularSizeFit(dataset);
    const vTarget = options.vTarget ?? 300 * KNOTS_TO_MS;
    const vSigma = options.vSigma ?? 60 * KNOTS_TO_MS;
    const rangeMin = options.rangeMin ?? 0.5 * METERS_PER_NM;
    const rangeMax = options.rangeMax ?? 55 * METERS_PER_NM;
    const coarse = options.coarse ?? 18;
    const decisiveMargin = options.decisiveMargin ?? 0.5;
    const common = {
        fitWind: options.fitWind,
        accelStride: Math.max(1, Math.round(dataset.fps / 2)),
        smoothOutput: true,
        smoothSpacingSec: 4,
        rangeFloor: true,
        // This search is synchronous; all its ranges share the observation
        // prefix. traversePlausible refreshes it when the final K changes.
        [PLAUSIBLE_WORKSPACE]: {},
    };
    const mk = (vt, K, iters) => ({...common, vTarget: vt, vSigma, K, iters});
    const searchK = options.searchK ?? 15, searchIters = options.searchIters ?? 3;
    const finalK = options.finalK ?? 25, finalIters = options.finalIters ?? 6;

    const scoreAt = (R, o) => {
        const {track, floorActive, wind} = traversePlausible(dataset, R, o);
        const windCost = wind ? windPriorCost(wind.windE, wind.windN) : 0;
        return {R, score: straightFlightScore(trackMetrics(datasetForFittedWind(dataset, {wind}), track)) + sizeCost(track) + windCost,
            track, floorActive, ...(wind ? {wind} : {})};
    };

    const coarseSweep = (o) => {
        const logLo = Math.log(rangeMin), logHi = Math.log(rangeMax);
        const profile = [];
        let best = null;
        for (let i = 0; i < coarse; i++) {
            const R = Math.exp(logLo + (logHi - logLo) * i / (coarse - 1));
            const s = scoreAt(R, o);
            profile.push({startDist: R, score: s.score});
            if (!best || s.score < best.score) best = s;
        }
        return {profile, best};
    };

    // Stage 1: pure smoothness — let the geometry speak
    const pureSweep = coarseSweep(mk(null, searchK, searchIters));
    const scoresSorted = pureSweep.profile.map(p => p.score).sort((a, b) => a - b);
    const med = scoresSorted[Math.floor(scoresSorted.length / 2)];
    const decisiveness = med - pureSweep.best.score;
    // best-vs-median alone always reads "decisive" on far-field scenes: the
    // close half of the log grid scores terribly and inflates the median even
    // when the far valley is FLAT (Gimbal — the canonical range-unobservable
    // scene — read 12.9 and returned an arbitrary 843 kt valley member). So a
    // LOCAL flatness gate is also required — but it must measure the VALLEY,
    // not the grid. The old gate (famCount <= 3 cells under the family
    // threshold) made the decision a function of sweep resolution: the same
    // physical valley read "decisive" on a 5-cell grid and "flat" on a
    // 72-cell one, and a fine grid handed slow/close scenes to the speed
    // prior, dragging them to several times the true range (P1). Instead,
    // walk outward from the winner in FIXED log-range steps until the score
    // crosses the family threshold: the sweep grid finds the valley, the walk
    // measures its width at a resolution that never changes with `coarse`.
    const famThresh = pureSweep.best.score + 0.5 * Math.max(1e-9, decisiveness);
    const famCount = pureSweep.profile.filter(p => p.score <= famThresh).length;
    // The valley walls are defined by a FIXED score rise above the floor —
    // the same margin that says the floor is meaningfully below the field.
    // Scaling the wall threshold with decisiveness (as famThresh does for the
    // reported family count) measures decisive scenes as WIDER, which is
    // backwards for a sharpness test.
    const walkOpts = mk(null, searchK, searchIters);
    // The coarse cell nearest the floor can sit half a grid step up the wall
    // — on a 5-cell grid that offset alone reads as ~0.5 nats of spurious
    // width, because the walk's downhill side keeps passing until it climbs
    // the FAR wall. Re-center on the valley floor before measuring, so the
    // width is the valley's and not the grid's. The floor is BRACKETED by
    // the best cell's neighbours (a discrete minimum always lies between
    // them); successive parabolic steps shrink the bracket. One vertex alone
    // is not enough: through cells 0.9 nats apart (a 5-cell grid) it can
    // land more than a walk step off the floor, which read as spurious width
    // and re-created the resolution dependence at the coarse end — the
    // mirror of the original bug.
    let centerLog = Math.log(pureSweep.best.R);
    let centerScore = pureSweep.best.score;
    let centerBest = null;   // full scoreAt result at the refined floor
    if (decisiveness > decisiveMargin) {
        const prof = pureSweep.profile;
        const cell = (i) => ({x: Math.log(prof[i].startDist), s: prof[i].score});
        const bi = prof.findIndex((p) => p.startDist === pureSweep.best.R);
        let lo = null, mid = null, hi = null;
        if (bi > 0 && bi < prof.length - 1) {
            lo = cell(bi - 1); mid = cell(bi); hi = cell(bi + 1);
        } else if (prof.length >= 2) {
            // The winner is an EDGE cell — at very coarse grids the nearest
            // cell to an interior floor can be the boundary one, and refusing
            // to refine there re-created the resolution dependence at
            // coarse=4. Probe the (log) midpoint toward the lone neighbour:
            // better than the edge means the floor is interior and bracketed;
            // worse means the score rises away from the boundary, the floor
            // is at or beyond it, and the walk's boundary rule should decide.
            const nb = bi === 0 ? 1 : prof.length - 2;
            const edge = cell(bi), other = cell(nb);
            // Bisect TOWARD the edge: an interior floor can hug the boundary
            // closer than the first midpoint (review case: a 0.704 NM floor
            // against a 0.5 NM rangeMin at coarse=4 — the midpoint probe read
            // worse than the edge cell and a real interior minimum was
            // abandoned). Each failed probe halves the interval; a floor
            // closer to the boundary than ~1/8 of a cell is then genuinely
            // indistinguishable from a boundary minimum and correctly defers.
            // Five halvings resolve a floor ~1/32 of a cell from the edge —
            // needed so a legitimate minimum hugging the boundary (a 19.16 NM
            // floor against rangeMax=20 on a 4-cell grid) is found at EVERY
            // resolution, not just fine ones; the squeezed-wall rule below
            // requires a strictly interior floor, so failing to find one
            // must not depend on the grid.
            let far = other;
            for (let k = 0; k < 5 && !mid; k++) {
                const v = scoreAt(Math.exp((edge.x + far.x) / 2), walkOpts);
                const probe = {x: Math.log(v.R), s: v.score};
                if (probe.s < edge.s) {
                    lo = edge.x < far.x ? edge : far;
                    hi = edge.x < far.x ? far : edge;
                    mid = probe;
                    centerBest = v;
                } else {
                    far = probe;
                }
            }
        }
        if (mid) {
            for (let pass = 0; pass < 3; pass++) {
                const xv = parabolicVertex(lo.x, lo.s, mid.x, mid.s, hi.x, hi.s);
                if (xv === null || xv <= lo.x || xv >= hi.x) break;
                const v = scoreAt(Math.exp(xv), walkOpts);
                const pt = {x: Math.log(v.R), s: v.score};
                if (pt.s < mid.s) {
                    if (pt.x < mid.x) hi = mid; else lo = mid;
                    mid = pt;
                    centerBest = v;
                } else if (pt.x < mid.x) {
                    lo = pt;
                } else {
                    hi = pt;
                }
            }
            if (mid.s < centerScore) {
                centerLog = mid.x;
                centerScore = mid.s;
            }
        }
    }
    const wallThresh = centerScore + decisiveMargin;
    const logBest = centerLog;
    const VALLEY_WALK_STEP = 0.26;  // nats per step (~1.30x in range)
    const VALLEY_WALK_MAX = 4;      // past ~2.8x total the valley is broad regardless
    // Walk one side of the valley. `crossed` records that the wall actually
    // ROSE past the threshold inside the walk — a side that ran into the
    // range boundary (or the cap) without rising is an UNPROVEN wall, and an
    // unproven wall means no interior minimum on that side (the tilted-flat
    // far-field valley whose "best" is just the last cell before the
    // boundary: the arbitrary-member case this gate exists to catch).
    // The walls are measured on the VALLEY's own scale — OUTSIDE the
    // caller's [rangeMin, rangeMax] if that is where they stand. The range
    // bracket constrains the ANSWER, never the measurement: a genuinely
    // interior minimum sitting near a boundary proves its wall just beyond
    // the bracket, while noisy range-unobservable data — whose
    // closer-is-smoother minimum parks ON the boundary (or digs a
    // noise-scale dip just inside it) — keeps descending out there and no
    // wall ever appears. Two review rounds of "squeezed wall" heuristics
    // tried to certify near-boundary floors from inside the bracket alone;
    // both were defeated by constructions at noise scale. Measuring through
    // the boundary is the version with nothing to exploit.
    const valleySide = (dir) => {
        let extent = 0;
        for (let s = 1; s <= VALLEY_WALK_MAX; s++) {
            const R = Math.exp(logBest + dir * s * VALLEY_WALK_STEP);
            if (R < 30) return {extent, crossed: false};   // physical floor, not the bracket
            const sample = scoreAt(R, walkOpts);
            if (sample.score > wallThresh) {
                if (dir < 0 && sample.floorActive) {
                    // The floor engaged at this crossing. The decisive
                    // question — independent of where the caller put
                    // rangeMin, which is user-settable and defeated every
                    // proxy gate — is whether the LANDSCAPE keeps descending
                    // through this "wall" once the guardrail is removed.
                    // Re-score floor-free and compare to the valley floor
                    // itself: a bare score BELOW the center's means the
                    // supposed minimum only exists because the floor stopped
                    // a descent (the closer-is-smoother slide: 1.2 bare vs
                    // ~3.3 at the certified "floor"), so the wall is the
                    // penalty talking. A real close-pass wall's bare solve,
                    // even cheating through the physically-excluded region,
                    // stays WORSE than the true minimum (0.578 vs 0.122 on
                    // the 121 m flyby) and the crossing stands.
                    const bare = scoreAt(R, {...walkOpts, rangeFloor: false});
                    if (bare.score < centerScore) return {extent, crossed: false};
                }
                return {extent, crossed: true};
            }
            extent = s * VALLEY_WALK_STEP;
        }
        return {extent, crossed: false};
    };
    // ~0.55 nats (3 of 18 log cells) is what the old rule INTENDED at its
    // default grid; past that the geometry is not pinning a single range.
    const VALLEY_WIDTH_MAX = 0.6;
    let lo = {extent: 0, crossed: false}, hi = lo;
    let valleyWidthLog = 0, multimodal = false, valleyFloorShaped = false;
    let geometryDecisive = false;
    let usedSpeedTarget = true;
    if (decisiveness > decisiveMargin) {
        lo = valleySide(-1);
        hi = valleySide(+1);
        valleyWidthLog = lo.extent + hi.extent;
        // A sweep cell within the wall threshold OUTSIDE the measured valley
        // (with one walk step of slack) is a second competing range family —
        // geometry is ambiguous however narrow the primary valley is.
        multimodal = pureSweep.profile.some((p) => {
            if (p.score > wallThresh) return false;
            const d = Math.log(p.startDist) - logBest;
            return d < -(lo.extent + VALLEY_WALK_STEP)
                || d > hi.extent + VALLEY_WALK_STEP;
        });
        // The valley FLOOR itself must also be floor-free: a minimum whose
        // own solution rides the soft range floor is floor-shaped end to
        // end, whatever its walls look like.
        valleyFloorShaped = (centerBest ?? pureSweep.best).floorActive === true;
        geometryDecisive = !valleyFloorShaped && lo.crossed && hi.crossed
            && valleyWidthLog <= VALLEY_WIDTH_MAX && !multimodal;
        usedSpeedTarget = !geometryDecisive;
    }
    // Speed sanity: a decisive pure valley whose implied speed exceeds twice
    // the target still falls back to the prior — but that is a DISTINCT
    // state from "geometry left range ambiguous", and it is reported as one:
    // geometryDecisive stays true (geometry DID pin a range; the fit chose
    // not to trust the extreme speed it implies) with speedSanityOverride
    // recording the fallback.
    let speedSanityOverride = false;
    if (!usedSpeedTarget && vTarget) {
        const mPure = trackMetrics(datasetForFittedWind(dataset, pureSweep.best), pureSweep.best.track);
        if (mPure.airSpeed.mean > 2 * vTarget) {
            usedSpeedTarget = true;
            speedSanityOverride = true;
        }
    }

    const vt = usedSpeedTarget ? vTarget : null;
    const searchOpts = mk(vt, searchK, searchIters);
    const finalOpts = mk(vt, finalK, finalIters);

    let {profile, best} = usedSpeedTarget ? coarseSweep(searchOpts) : pureSweep;
    // When geometry decides, continue from the REFINED floor, not the coarse
    // cell: at a very coarse grid the winning cell can sit a full grid step
    // from the valley floor, outside the +-1.5x bracket the refine below
    // searches — the gate then chose geometry while the returned range never
    // reached it.
    if (!usedSpeedTarget && centerBest && centerBest.score < best.score) {
        best = centerBest;
    }

    // parabolic refine in log-range around the coarse minimum (2 passes)
    let loR = Math.max(rangeMin, best.R / 1.5);
    let hiR = Math.min(rangeMax, best.R * 1.5);
    for (let pass = 0; pass < 2; pass++) {
        const a = scoreAt(loR, searchOpts), b = best, c = scoreAt(hiR, searchOpts);
        const xv = parabolicVertex(
            Math.log(a.R), a.score,
            Math.log(b.R), b.score,
            Math.log(c.R), c.score);
        if (xv === null) break;
        const Rv = Math.min(rangeMax, Math.max(rangeMin, Math.exp(xv)));
        const v = scoreAt(Rv, searchOpts);
        if (v.score < best.score) best = v;
        loR = Math.max(rangeMin, best.R / 1.2);
        hiR = Math.min(rangeMax, best.R * 1.2);
    }

    // full-quality solve at the winning range
    const finalSolve = traversePlausible(dataset, best.R, finalOpts);
    const orderedProfile = profile.slice().sort((a, b) => a.startDist - b.startDist);
    let profileBest = 0;
    for (let i = 1; i < orderedProfile.length; i++) {
        if (orderedProfile[i].score < orderedProfile[profileBest].score) profileBest = i;
    }
    const profileScores = orderedProfile.map((row) => row.score).sort((a, b) => a - b);
    const profileMedian = profileScores[Math.floor(profileScores.length / 2)];
    const supportThreshold = orderedProfile[profileBest].score
        + 0.5 * (profileMedian - orderedProfile[profileBest].score);
    let supportLo = profileBest, supportHi = profileBest;
    while (supportLo > 0 && orderedProfile[supportLo - 1].score <= supportThreshold) supportLo--;
    while (supportHi < orderedProfile.length - 1
        && orderedProfile[supportHi + 1].score <= supportThreshold) supportHi++;
    const boundarySides = {
        lo: supportLo === 0 || best.R <= rangeMin * 1.001,
        hi: supportHi === orderedProfile.length - 1 || best.R >= rangeMax * 0.999,
    };
    return {
        track: finalSolve.track,
        ...(finalSolve.wind ? {wind: finalSolve.wind} : {}),
        lam: finalSolve.lam,
        startDist: best.R,
        score: straightFlightScore(trackMetrics(datasetForFittedWind(dataset, finalSolve), finalSolve.track))
            + (finalSolve.wind ? windPriorCost(finalSolve.wind.windE, finalSolve.wind.windN) : 0),
        profile: orderedProfile,
        usedSpeedTarget,
        decisiveness,
        flatFamilyCount: famCount,
        valleyWidthLog,
        valleyMultimodal: multimodal,
        valleyWalls: {loCrossed: lo.crossed, hiCrossed: hi.crossed},
        valleyFloorShaped,
        geometryDecisive,
        speedSanityOverride,
        boundaryLimited: boundarySides.lo || boundarySides.hi,
        boundarySides,
    };
}

// Gaussian elimination with partial pivoting (small dense systems, K ~ 25)
function solveDense(A, b) {
    const {M, x} = factorDense(A, b);
    return backSubstituteDense(M, x);
}

// The same elimination for changing and constant systems. Store the actual
// pivots and multipliers, then replay RHS operations in their original order.
// Inverting A or multiplying by an inverse would change rounding.
function factorDense(A, b = null) {
    // Consumes A. Callers assemble it for this solve and keep any reusable
    // prefix in a separate copy before passing it here.
    const nn = A.length;
    const M = A;
    // Ordinary solves need no elimination log. Only constant systems retain
    // the pivots/factors for additional right-hand sides.
    const x = b === null ? null : Float64Array.from(b);
    const pivots = x ? null : new Int32Array(nn);
    const factors = x ? null : Array.from({length: nn}, () => new Float64Array(nn));
    for (let col = 0; col < nn; col++) {
        let maxV = Math.abs(M[col][col]), maxR = col;
        for (let r = col + 1; r < nn; r++) {
            if (Math.abs(M[r][col]) > maxV) { maxV = Math.abs(M[r][col]); maxR = r; }
        }
        if (pivots) pivots[col] = maxR;
        [M[col], M[maxR]] = [M[maxR], M[col]];
        if (x) { const t = x[col]; x[col] = x[maxR]; x[maxR] = t; }
        for (let r = col + 1; r < nn; r++) {
            const f = M[r][col] / M[col][col];
            if (factors) factors[col][r] = f;
            if (f === 0) continue;
            for (let k = col; k < nn; k++) M[r][k] -= f * M[col][k];
            if (x) x[r] -= f * x[col];
        }
    }
    return {M, pivots, factors, x};
}

function solveFactoredDense({M, pivots, factors}, b) {
    const nn = b.length;
    const x = Float64Array.from(b);
    for (let col = 0; col < nn; col++) {
        const maxR = pivots[col];
        const t = x[col]; x[col] = x[maxR]; x[maxR] = t;
        for (let r = col + 1; r < nn; r++) {
            const f = factors[col][r];
            if (f !== 0) x[r] -= f * x[col];
        }
    }
    return backSubstituteDense(M, x);
}

function backSubstituteDense(M, x) {
    const nn = x.length;
    for (let i = nn - 1; i >= 0; i--) {
        let s = x[i];
        for (let k = i + 1; k < nn; k++) s -= M[i][k] * x[k];
        x[i] = s / M[i][i];
    }
    return x;
}

// ---------------------------------------------------------------------------
// Parametric fixed-wing aircraft fit
// ---------------------------------------------------------------------------

/**
 * Integrate the simple flight model.
 * params: [R0 (m along first ray), heading0 (deg in origin ENU), horizontal airspeed (m/s),
 *          turnRate0 (deg/s), turnAccel (deg/s^2), climb (m/s)]
 * Constant horizontal airspeed through the air mass, heading integrates the (linearly varying)
 * turn rate, constant climb, position advected by the per-frame wind.
 * Six parameters use dataset.W. Eight append constant windE/windN (m/s),
 * replacing the supplied wind. Returns Float64Array(n*3).
 */
export function simulateAircraft(dataset, params) {
    const {n, fps, S, D, W} = dataset;
    const [R0, h0, V, w0, wd, climb, windE, windN] = params;
    const freeWind = params.length === 8;
    const track = new Float64Array(n * 3);
    let px = S[0] + D[0] * R0, py = S[1] + D[1] * R0, pz = S[2] + D[2] * R0;
    let psi = h0 * Math.PI / 180;
    const dt = 1 / fps;
    track[0] = px; track[1] = py; track[2] = pz;
    for (let f = 1; f < n; f++) {
        const t = f * dt;
        psi += (w0 + wd * t) * Math.PI / 180 * dt;
        const airVX = V * Math.sin(psi), airVY = V * Math.cos(psi);
        // W is a full local-horizontal ECEF displacement rotated into this
        // fixed ENU frame, so Wz already carries wind's curvature component.
        // Correct only the air velocity in supplied mode. Free wind is defined
        // in the local horizontal plane, so its curvature is included here.
        pz += (climb - (px * (airVX + (freeWind ? windE : 0))
            + py * (airVY + (freeWind ? windN : 0))) / EARTH_RADIUS_M) * dt
            + (freeWind ? 0 : W[(f - 1) * 3 + 2]);
        px += airVX * dt + (freeWind ? windE * dt : W[(f - 1) * 3]);
        py += airVY * dt + (freeWind ? windN * dt : W[(f - 1) * 3 + 1]);
        track[f * 3] = px; track[f * 3 + 1] = py; track[f * 3 + 2] = pz;
    }
    return track;
}

// Full-resolution mean angular error (degrees) of the aircraft model vs the
// LOS rays — per-frame forward integration. Used once for the final reported
// fit quality. For the optimizer inner loop use aircraftCostErrDeg (strided,
// O(n/stride)) instead.
function aircraftAngErrDeg(dataset, params, stride) {
    if (params.length === 8) {
        return meanAngularError(dataset, simulateAircraft(dataset, params)) * 180 / Math.PI;
    }
    const {n, S, D, fps, W} = dataset;
    const [R0, h0, V, w0, wd, climb] = params;
    let px = S[0] + D[0] * R0, py = S[1] + D[1] * R0, pz = S[2] + D[2] * R0;
    let psi = h0 * Math.PI / 180;
    const dt = 1 / fps;
    let sum = 0, count = 1; // frame 0 has zero error by construction
    for (let f = 1; f < n; f++) {
        const t = f * dt;
        psi += (w0 + wd * t) * Math.PI / 180 * dt;
        const airVX = V * Math.sin(psi), airVY = V * Math.cos(psi);
        pz += (climb - (px * airVX + py * airVY) / EARTH_RADIUS_M) * dt
            + W[(f - 1) * 3 + 2];
        px += airVX * dt + W[(f - 1) * 3];
        py += airVY * dt + W[(f - 1) * 3 + 1];
        if (f % stride !== 0 && f !== n - 1) continue;
        const b = f * 3;
        let rx = px - S[b], ry = py - S[b + 1], rz = pz - S[b + 2];
        const rl = Math.hypot(rx, ry, rz);
        if (rl < 1) return 1e9;
        rx /= rl; ry /= rl; rz /= rl;
        const dot = Math.min(1, Math.max(-1, rx * D[b] + ry * D[b + 1] + rz * D[b + 2]));
        sum += Math.acos(dot);
        count++;
    }
    return sum / count * 180 / Math.PI;
}

// Cumulative per-frame wind displacement: cumW[f*3+c] = sum of W[0..f-1].
// Lets the strided cost advance the wind term over a whole block in O(1).
export function cumulativeWind(dataset) {
    const {n, W} = dataset;
    const cumW = new Float64Array(n * 3);
    for (let f = 1; f < n; f++) {
        cumW[f * 3] = cumW[(f - 1) * 3] + W[(f - 1) * 3];
        cumW[f * 3 + 1] = cumW[(f - 1) * 3 + 1] + W[(f - 1) * 3 + 1];
        cumW[f * 3 + 2] = cumW[(f - 1) * 3 + 2] + W[(f - 1) * 3 + 2];
    }
    return cumW;
}

// Fast optimizer cost: integrate the model block-by-block over `costFrames`
// (midpoint heading per block — 2nd order, more accurate than the full-res
// forward Euler, and O(costFrames) instead of O(n)). cumW is cumulativeWind().
export function aircraftCostErrDeg(dataset, params, costFrames, cumW, incumbent, errSigma, scoreError) {
    const {S, D, fps} = dataset;
    const [R0, h0, V, w0, wd, climb, windE, windN] = params;
    const freeWind = params.length === 8;
    let px = S[0] + D[0] * R0, py = S[1] + D[1] * R0, pz = S[2] + D[2] * R0;
    let psi = h0 * Math.PI / 180;
    const dtF = 1 / fps;
    let prevF = 0;
    let sum = 0, count = 1; // frame 0 exact by construction
    for (let ci = 1; ci < costFrames.length; ci++) {
        const f = costFrames[ci];
        const ta = prevF * dtF, tb = f * dtF;
        // heading change over the block: integral of (w0 + wd*t) dt (deg->rad)
        const dPsi = (w0 * (tb - ta) + 0.5 * wd * (tb * tb - ta * ta)) * Math.PI / 180;
        const psiMid = psi + 0.5 * dPsi;
        const dtB = tb - ta;
        const airVX = V * Math.sin(psiMid), airVY = V * Math.cos(psiMid);
        pz += (climb - (px * (airVX + (freeWind ? windE : 0))
            + py * (airVY + (freeWind ? windN : 0))) / EARTH_RADIUS_M) * dtB
            + (freeWind ? 0 : cumW[f * 3 + 2] - cumW[prevF * 3 + 2]);
        px += airVX * dtB + (freeWind ? windE * dtB : cumW[f * 3] - cumW[prevF * 3]);
        py += airVY * dtB + (freeWind ? windN * dtB : cumW[f * 3 + 1] - cumW[prevF * 3 + 1]);
        psi += dPsi;
        prevF = f;
        const b = f * 3;
        let rx = px - S[b], ry = py - S[b + 1], rz = pz - S[b + 2];
        const rl = Math.hypot(rx, ry, rz);
        if (rl < 1) return 1e9;
        rx /= rl; ry /= rl; rz /= rl;
        const dot = Math.min(1, Math.max(-1, rx * D[b] + ry * D[b + 1] + rz * D[b + 2]));
        sum += Math.acos(dot);
        count++;
        // Each remaining angular error and every aircraft prior is nonnegative.
        // Divide the partial sum by the FINAL count, in the original arithmetic
        // order, to bound the eventual cost from below. Never rearrange this as
        // a precomputed threshold: rounding at a tie could reject a winner.
        // The near-sensor sentinel above can return 1e9, so only prune against
        // incumbents below it. Invalid/nonpositive scales take the full path.
        if ((ci & 7) === 0 && incumbent < 1e9 && errSigma > 0
            && scoreError(sum / costFrames.length * 180 / Math.PI, params) > incumbent) return Infinity;
    }
    return sum / count * 180 / Math.PI;
}

/**
 * Fit the fixed-wing model to the LOS data with soft plausibility targets.
 *
 * The cost is LOS angular error PLUS loose penalties expressing the
 * hypothesis ("a conventional aircraft in roughly straight, roughly level
 * cruise") — without them the pure-error fit is wildly ambiguous: nearly
 * perfect fits exist across a huge family of turning solutions.
 *
 * options:
 *   tasTarget/tasSigma   preferred speed (default 380 +- 150 kt)
 *   turnSigma            straightness looseness (default 0.5 deg/s)
 *   climbSigma           level-flight looseness (default 8 m/s)
 *   errSigma             LOS fit weight (default 0.02 deg per unit cost)
 *   rangeMin/rangeMax    search bounds for R0 (default 1..45 NM)
 *   runs, pop, gens      DE effort (defaults 3, 60, 150)
 *   progress(frac)       awaited on a wall-clock budget between evaluations
 *   shouldCancel()       checked between optimizer evaluations
 *   fitWind              fit constant E/N wind (±40 m/s) instead of dataset.W;
 *                        adds windE/windN to the returned parameters
 *   boundedCost          skip provably losing evaluations (default true);
 *                        false runs the full objective for comparison
 *   gpu                  true or {instances, pop, gens}: search on the GPU
 *                        (WebGPU) instead of the CPU DE runs, then polish the
 *                        best `runs` instance results on the CPU. Falls back
 *                        to the CPU search when WebGPU is unavailable. Finds
 *                        different (usually better) basins, so results differ.
 *
 * Returns {params: {startDist, heading, tas, turnRate, turnAccel, climb},
 *          cost, errDeg, track, metrics, runs: [per-run summaries]}
 */
export async function fitAircraft(dataset, options = {}) {
    const freeWind = options.fitWind === true;
    const sizeFit = angularSizeFitEnabled(dataset);
    const sizeCost = compileAngularSizeFit(dataset);
    const tasTarget = options.tasTarget ?? 380 * KNOTS_TO_MS;
    const tasSigma = options.tasSigma ?? 150 * KNOTS_TO_MS;
    const turnSigma = options.turnSigma ?? 0.5;
    const climbSigma = options.climbSigma ?? 8;
    const errSigma = options.errSigma ?? 0.02;
    const rangeMin = options.rangeMin ?? 1 * METERS_PER_NM;
    const rangeMax = options.rangeMax ?? 45 * METERS_PER_NM;
    const nRuns = options.runs ?? 3;
    const pop = options.pop ?? 60;
    const gens = options.gens ?? 150;
    const boundedCost = options.boundedCost ?? true;
    const T = Math.max(0, dataset.n - 1) / dataset.fps;

    // Strided cost integration (block midpoint) keeps the many DE/polish
    // evaluations O(n/costStride) instead of O(n) — dominant cost at long clips.
    const costStride = Math.max(1, Math.floor(options.costStride ?? 5));
    const cumW = cumulativeWind(dataset);
    const costFrames = [];
    for (let f = 0; f < dataset.n; f += costStride) costFrames.push(f);
    if (costFrames[costFrames.length - 1] !== dataset.n - 1) costFrames.push(dataset.n - 1);

    // Optional soft ground-contact prior (from the analysis ground modes):
    // pull the START altitude (frame-0 ray at range p[0]) and/or the END
    // altitude (start + climb·T) toward a ground reference. Gated — undefined
    // leaves the cost unchanged. NOTE p = [R0, headingDeg, V, w0, wd, climb]:
    // there is no altitude parameter — altitude is implied by the range along
    // the first sightline, so the prior must derive it from p[0], not p[1]
    // (p[1] is the HEADING; penalizing it toward a ground height was a bug).
    const groundPrior = options.groundPrior || null;
    const gpS0 = [dataset.S[0], dataset.S[1], dataset.S[2]];   // frame-0 ray
    const gpD0 = [dataset.D[0], dataset.D[1], dataset.D[2]];

    const scoreError = (e, p) => {
        const wEnd = p[3] + p[4] * T;
        let c = (
            e / errSigma +
            (p[3] / turnSigma) ** 2 + (wEnd / turnSigma) ** 2 +
            (p[5] / climbSigma) ** 2 +
            ((p[2] - tasTarget) / tasSigma) ** 2
        );
        if (freeWind) c += windPriorCost(p[6], p[7]);
        if (groundPrior) {
            const sig = groundPrior.sigma ?? 40;
            // Compare geodetic altitude h≈z+(x²+y²)/2R. Model `climb`
            // is geodetic dh/dt, so endpoint height is h0+climb*T.
            const x0 = gpS0[0] + p[0] * gpD0[0];
            const y0 = gpS0[1] + p[0] * gpD0[1];
            const z0 = gpS0[2] + p[0] * gpD0[2];
            const h0 = z0 + (x0 * x0 + y0 * y0) / (2 * EARTH_RADIUS_M);
            if (groundPrior.startZ !== undefined && groundPrior.startZ !== null) {
                c += ((h0 - groundPrior.startZ) / sig) ** 2;
            }
            if (groundPrior.endZ !== undefined && groundPrior.endZ !== null) {
                c += ((h0 + p[5] * T - groundPrior.endZ) / sig) ** 2;
            }
        }
        return Number.isFinite(c) ? c : Infinity;
    };

    const cost = (p, incumbent = Infinity) => {
        // Score zero error in the SAME addition order as the final objective.
        // This is a lower bound even at floating-point ties; subtracting a
        // separately summed prior from the incumbent would not be equivalent.
        if (incumbent < 1e9 && errSigma > 0 && scoreError(0, p) > incumbent) return Infinity;
        const e = aircraftCostErrDeg(dataset, p, costFrames, cumW, incumbent, errSigma, scoreError);
        if (e > 1e8) return e;
        return scoreError(e, p) + (sizeFit ? sizeCost(simulateAircraft(dataset, p)) : 0);
    };

    // Generic horizontal-speed floor. It is intentionally low enough to keep
    // slow scenes in the search, but it is a model/search bound—not a universal
    // stall-speed claim. A result at the floor is boundary-limited.
    const lo = [rangeMin, 0, 25 * KNOTS_TO_MS, -4, -0.3, -40];
    const hi = [rangeMax, 360, 700 * KNOTS_TO_MS, 4, 0.3, 40];
    const polishScales = [200, 0.5, 2, 0.02, 0.002, 0.5];
    if (freeWind) {
        lo.push(-40, -40);
        hi.push(40, 40);
        polishScales.push(2, 2);
    }
    const runs = [];
    // Each run reports progress inside its own [p0, p1] window so the bar is
    // MONOTONIC across the whole fit: the default runs share [0, 0.85] and
    // escalation, when it fires, owns the reserved [0.85, 1] tail — it must
    // never rewind a bar that already reported the defaults nearly done.
    const doRun = async (popN, gensN, seed, p0, p1) => {
        const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
        let lastYield = clock();
        let stage = "de";
        let stageEvaluations = 0;
        const expectedDEEvaluations = popN * (gensN + 1);
        const expectedPolishEvaluations = 1 + 300 * lo.length * 2;
        const optimizerPulse = () => {
            stageEvaluations++;
            if (options.shouldCancel && options.shouldCancel()) return false;
            if (!options.progress || clock() - lastYield <= 60) return true;
            const local = stage === "de"
                ? 0.9 * Math.min(1, stageEvaluations / expectedDEEvaluations)
                : 0.9 + 0.1 * Math.min(1, stageEvaluations / expectedPolishEvaluations);
            return Promise.resolve(options.progress(p0 + local * (p1 - p0))).then(() => {
                lastYield = clock();
                return !(options.shouldCancel && options.shouldCancel());
            });
        };
        const de = await differentialEvolution(cost, lo, hi, {
            pop: popN, gens: gensN,
            boundedCost,
            // Deterministic per-run seed: identical inputs give identical
            // fits (run-to-run variance was user-visible); distinct seeds per
            // run preserve the independent-restart diversity.
            rng: mulberry32(seed),
            // A long generation contains `pop` full-clip integrations. Yield and
            // check Cancel between candidates rather than waiting for all of them.
            onEvaluation: optimizerPulse,
        });
        if (de.cancelled || (options.shouldCancel && options.shouldCancel())) {
            throw new Error("cancelled");
        }
        // polish on the same strided cost (still 2nd-order accurate)
        stage = "polish";
        stageEvaluations = 0;
        const pol = await patternSearchPolish(
            cost, de.params, polishScales,
            {lo, hi, onEvaluation: optimizerPulse, boundedCost});
        if (pol.cancelled || (options.shouldCancel && options.shouldCancel())) {
            throw new Error("cancelled");
        }
        pol.de = {
            seed: seed >>> 0,
            pop: popN,
            gens: gensN,
            generations: de.generations,
            evaluations: de.evaluations,
            stopReason: de.stopReason,
        };
        return pol;
    };
    // GPU SEARCH (opt-in, options.gpu). Many independent DE instances with large
    // populations run on the GPU at once, in f32 (see AircraftCostKernel.js for
    // why f32 is accurate enough here). The best `nRuns` instance results are then
    // polished on the CPU with the same f64 objective and pattern search as doRun,
    // so every cost and parameter reported below is f64. The search budget is far
    // above the escalation run's, so escalation does not follow a GPU search.
    // Returns null — use the CPU runs — when WebGPU is unavailable or fails.
    const gpuRuns = async () => {
        if (!(errSigma > 1e-4) || !Number.isFinite(errSigma)) return null;
        const budget = resolveGpuBudget(options.gpu, GPU_AIRCRAFT_BUDGET);
        const seed = 0x51F17A;
        const GPU_SHARE = 0.6;
        let search;
        try {
            search = await gpuDifferentialEvolution({
                kernel: buildAircraftKernel({dataset, costFrames, cumW, T, errSigma, turnSigma, climbSigma,
                    tasTarget, tasSigma, groundPrior, earthRadius: EARTH_RADIUS_M, freeWind}),
                instances: Array.from({length: budget.instances}, () => ({lo, hi})),
                pop: budget.pop, gens: budget.gens, seed,
                shouldCancel: options.shouldCancel,
                onProgress: options.progress ? (frac) => options.progress(GPU_SHARE * frac) : null,
            });
        } catch (e) {
            if (e && e.message === "cancelled") throw e;
            console.warn("GPU fixed-wing search failed; using the CPU search:", e);
            return null;
        }
        if (!search) return null;
        const ranked = search.instances.map((inst, instance) => ({...inst, instance}))
            .sort((a, b) => a.cost - b.cost);
        const polishCount = Math.min(nRuns, ranked.length);
        const out = [];
        for (let r = 0; r < polishCount; r++) {
            const p0 = GPU_SHARE + (1 - GPU_SHARE) * r / polishCount;
            const p1 = GPU_SHARE + (1 - GPU_SHARE) * (r + 1) / polishCount;
            const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
            let lastYield = clock();
            let evaluations = 0;
            const expected = 1 + 300 * lo.length * 2;
            const pulse = () => {
                evaluations++;
                if (options.shouldCancel && options.shouldCancel()) return false;
                if (!options.progress || clock() - lastYield <= 60) return true;
                return Promise.resolve(options.progress(p0 + Math.min(1, evaluations / expected) * (p1 - p0)))
                    .then(() => {
                        lastYield = clock();
                        return !(options.shouldCancel && options.shouldCancel());
                    });
            };
            const pol = await patternSearchPolish(
                cost, ranked[r].params, polishScales,
                {lo, hi, onEvaluation: pulse, boundedCost});
            if (pol.cancelled || (options.shouldCancel && options.shouldCancel())) {
                throw new Error("cancelled");
            }
            pol.de = {
                backend: "webgpu",
                seed,
                instance: ranked[r].instance,
                instances: budget.instances,
                pop: budget.pop,
                gens: budget.gens,
                generations: search.generations,
                evaluations: search.evaluations,
                stopReason: "generation_limit",
            };
            out.push(pol);
        }
        return out;
    };

    const ESC_RESERVE = 0.15;
    const fromGpu = options.gpu && !sizeFit ? await gpuRuns() : null;
    if (fromGpu) {
        runs.push(...fromGpu);
    } else {
        for (let r = 0; r < nRuns; r++) {
            runs.push(await doRun(pop, gens, 0x51F17A + r * 0x9E3779,
                (1 - ESC_RESERVE) * r / nRuns, (1 - ESC_RESERVE) * (r + 1) / nRuns));
        }
    }
    runs.sort((a, b) => a.cost - b.cost);

    // ADAPTIVE BASIN VERIFICATION (P2). The deterministic default-budget
    // runs can all converge on the same wrong basin: the benchmark scenario
    // bb-2af6154e returned cost 13.69 from every default run while a 9.97
    // basin existed in-bounds, and denser search — not more restarts — was
    // what found it. One escalated higher-density run triggers when the
    // independent runs DISAGREE (they found different basins, so coverage is
    // clearly incomplete) or when the best cost is mediocre but not hopeless
    // (a plausibly-wrong basin worth one deeper look; a hopeless fit stays
    // hopeless at any budget and is not worth doubling the latency for).
    // Thresholds are in cost units, dominated by errDeg/errSigma: 6 is
    // ~0.12 deg of pure residual — a fit no better than that has room to be
    // wrong — and 300 is far past anything a real aircraft interpretation
    // survives.
    const runSpread = runs.length > 1 && Number.isFinite(runs[0].cost) && runs[0].cost > 0
        ? (runs[runs.length - 1].cost - runs[0].cost) / runs[0].cost
        : 0;
    let escalated = false;
    if (options.escalate !== false && !fromGpu
        && (runSpread > 0.10 || (runs[0].cost > 6 && runs[0].cost < 300))) {
        escalated = true;
        // A latency-bounded RECOVERY pass, not full basin verification: on
        // the reference case 120/300 recovered cost 10.10 where 180/500
        // reaches 8.83 (and much better truth separation) at ~1.6x the added
        // time. The budget is a deliberate trade; escalatePop/escalateGens
        // let a caller buy more.
        const esc = await doRun(
            options.escalatePop ?? 120, options.escalateGens ?? 300,
            0xE5CA1A7, 1 - ESC_RESERVE, 1);
        esc.escalated = true;
        runs.push(esc);
        runs.sort((a, b) => a.cost - b.cost);
    }
    const best = runs[0];
    if (!best || !Number.isFinite(best.cost)
        || !Array.isArray(best.params) || best.params.some((value) => !Number.isFinite(value))) {
        throw new Error("fixed-wing optimizer produced no finite solution");
    }
    const track = simulateAircraft(dataset, best.params);
    for (let i = 0; i < track.length; i++) {
        if (!Number.isFinite(track[i])) {
            throw new Error("fixed-wing optimizer produced a non-finite trajectory");
        }
    }
    const metricDataset = freeWind ? datasetWithConstantWind(dataset, best.params[6], best.params[7]) : dataset;
    const metrics = trackMetrics(metricDataset, track);
    const [R0, h0, V, w0, wd, climb] = best.params;
    // Diagnose coordinates near a search bound.  Heading is excluded because
    // its 0/360 bounds are circular and arbitrary.  A bound only counts as a
    // capability warning when an inward probe materially worsens the objective;
    // flat/inactive coordinates are retained as unresolved metadata.
    const pinNames = ["startDist", "heading", "tas", "turnRate", "turnAccel", "climb"];
    if (freeWind) pinNames.push("windE", "windN");
    const pinned = assessBoundPins(best.params, lo, hi, pinNames, cost,
        {baseCost: best.cost, excludeIndices: [1]});

    // Itemise the soft priors at the solution, in DEGREES of fit budget (each
    // cost term × errSigma), matching the physics models' {total, terms} schema
    // so the fixed-wing tile can disclose the assumptions that shaped it (TA-08).
    const wEndBest = best.params[3] + best.params[4] * T;
    const priorTerms = {};
    const addPrior = (name, unitCost) => {
        const deg = unitCost * errSigma;
        if (Number.isFinite(deg) && deg > 0) priorTerms[name] = deg;
    };
    addPrior("start turn rate toward straight", (best.params[3] / turnSigma) ** 2);
    addPrior("end turn rate toward straight", (wEndBest / turnSigma) ** 2);
    addPrior("climb toward level", (best.params[5] / climbSigma) ** 2);
    addPrior("cruise-speed target", ((best.params[2] - tasTarget) / tasSigma) ** 2);
    if (freeWind) addPrior("shared wind prior", windPriorCost(best.params[6], best.params[7]));
    if (groundPrior) {
        const sig = groundPrior.sigma ?? 40;
        const gx = gpS0[0] + best.params[0] * gpD0[0];
        const gy = gpS0[1] + best.params[0] * gpD0[1];
        const gz = gpS0[2] + best.params[0] * gpD0[2];
        const gh0 = gz + (gx * gx + gy * gy) / (2 * EARTH_RADIUS_M);
        if (groundPrior.startZ !== undefined && groundPrior.startZ !== null) {
            addPrior("ground contact (start)", ((gh0 - groundPrior.startZ) / sig) ** 2);
        }
        if (groundPrior.endZ !== undefined && groundPrior.endZ !== null) {
            addPrior("ground contact (end)", ((gh0 + best.params[5] * T - groundPrior.endZ) / sig) ** 2);
        }
    }
    let priorTotal = 0;
    for (const k in priorTerms) priorTotal += priorTerms[k];
    const priors = priorTotal > 0 ? {total: priorTotal, terms: priorTerms} : null;

    const errDeg = aircraftAngErrDeg(dataset, best.params, 1);
    if (!Number.isFinite(errDeg)) {
        throw new Error("fixed-wing optimizer produced a non-finite residual");
    }
    return {
        pinned,
        params: {
            startDist: R0,
            heading: ((h0 % 360) + 360) % 360,
            tas: V,
            turnRate: w0,
            turnAccel: wd,
            climb,
            priors,
            ...(freeWind ? {windE: best.params[6], windN: best.params[7]} : {}),
        },
        cost: best.cost,
        errDeg,
        track,
        metrics: summarizeMetrics(metrics),
        series: metrics.series,
        escalated,
        runSpread,
        runs: runs.map(r => ({
            cost: r.cost,
            startDist: r.params[0], heading: ((r.params[1] % 360) + 360) % 360,
            tas: r.params[2], turnRate: r.params[3], turnAccel: r.params[4], climb: r.params[5],
            ...(freeWind ? {windE: r.params[6], windN: r.params[7]} : {}),
            polishIterations: r.iterations, polishStopReason: r.stopReason,
            escalated: r.escalated === true,
            de: r.de,
        })),
    };
}

// ---------------------------------------------------------------------------
// Sensor-motion observability and cross-regime scoring
// ---------------------------------------------------------------------------

/**
 * Aggregate sensor (LOS origin) motion over the dataset window.
 * Bearings-only range recovery needs parallax: with a (near-)static sensor,
 * every range along the ray fan admits a trajectory and no free-range method
 * can determine distance from the evidence.
 *
 * Returns {pathLen, span, n}: pathLen is the summed frame-to-frame sensor
 * travel; span is the bounding-box diagonal of the sensor positions — the
 * honest parallax baseline (GPS jitter inflates pathLen but not span).
 */
export function sensorMotionStats(dataset) {
    const {n, S} = dataset;
    let pathLen = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let f = 0; f < n; f++) {
        const b = f * 3;
        const x = S[b], y = S[b + 1], z = S[b + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        if (f > 0) {
            pathLen += Math.hypot(x - S[b - 3], y - S[b - 2], z - S[b - 1]);
        }
    }
    const span = n > 0 ? Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) : 0;
    return {pathLen, span, n};
}

/**
 * True when the sensor baseline is too small for the evidence to constrain
 * range at the working distance. anchorDist is the analysis start-distance
 * prior (meters): at 20 NM a 30 m baseline still resolves nothing, while a
 * drone filmed from 200 m away can triangulate off a few meters of motion.
 */
export function isRangeUnobservable(stats, anchorDist) {
    if (!stats || !Number.isFinite(stats.span)) return false;
    const threshold = Math.max(2, 1e-3 * (Number.isFinite(anchorDist) ? anchorDist : 0));
    return stats.span < threshold;
}

/**
 * Regime-neutral score for a candidate ray-constrained track: the same
 * smoothness metric the gallery ranking uses (straightFlightScore) plus the
 * Raw LOS residual, in 0.05-degree units.
 * The fast sweep and the slow range profile score with different priors and
 * different smoothing/downsampling, so their internal scores must never be
 * compared directly — this is the common yardstick.
 */
export function neutralTrackScore(dataset, track, rayAllowanceDeg = 0.05) {
    const metrics = trackMetrics(dataset, track);
    const errDeg = meanAngularError(dataset, track) * 180 / Math.PI;
    const scoredErr = Math.max(0, errDeg - rayAllowanceDeg);
    const score = straightFlightScore(metrics) + scoredErr / 0.05;
    return {score: Number.isFinite(score) ? score : Infinity, metrics, errDeg};
}

/**
 * Decide whether the slow-drift candidate should replace the fast-sweep
 * representative for the Constant Air Speed hypothesis. The margin demands a
 * DECISIVE win: on narrow-baseline scenes (Gimbal/GoFast) a slow near-field
 * drifter rides the rays about as smoothly as the fast solution, and a raw
 * comparison would wrongly flip the headline to a ~10 kt near-field track.
 */
export function slowRegimeWins(fastScore, slowScore, margin = 0.8) {
    if (!Number.isFinite(slowScore)) return false;
    if (!Number.isFinite(fastScore)) return true;
    return slowScore < fastScore * margin;
}

// ~100 kt: above this a candidate is not a "slow drift" answer, whatever the
// slow profile's argmin says — flat-family scenes can park the argmin on a
// fast row despite the 5-kt prior.
export const SLOW_REGIME_MAX_SPEED_MS = 52;
// Required sharpness of the slow range valley before its argmin means anything.
export const SLOW_REGIME_MIN_CONTRAST = 2.5;

/**
 * Sharpness of the slow range-profile valley: upper-quartile score over the
 * minimum. A decisive scene (real parallax pinning a slow object's range)
 * scores its wrong ranges much worse than its valley (contrast >> 1); a
 * degenerate narrow-baseline scene rides the rays smoothly at EVERY range
 * (contrast ~1), and its argmin row is an arbitrary member of a flat family —
 * promoting it would replace the honest ambiguity answer with a confident
 * wrong one.
 */
export function slowValleyContrast(profile) {
    if (!profile || profile.length < 4) return 1;
    const scores = profile.map((r) => r.score).filter(Number.isFinite).sort((a, b) => a - b);
    if (!scores.length) return 1;
    const min = Math.max(scores[0], 1e-9);
    const p75 = scores[Math.min(scores.length - 1, Math.floor(scores.length * 0.75))];
    return p75 / min;
}

/**
 * Decide which regime the "Constant Air Speed" hypothesis represents: the fast
 * sweep's prior-anchored family representative, or an honest constant-speed
 * track at the slow range-profile valley. The swap requires ALL of:
 *  - a genuinely slow candidate (<= maxSlowSpeed),
 *  - a DECISIVE slow valley (slowValleyContrast >= minContrast — flat-valley
 *    narrow-baseline scenes keep the fast representative and its family-
 *    ambiguity language),
 *  - a decisive neutral-score win (slowRegimeWins margin).
 * Returns {useSlow, fast: {track, scored}, slow: null|{row, speed, track, scored, contrast}}.
 */
export function pickConstAirRegime(dataset, sweep, slowProfile, opts = {}) {
    const margin = opts.margin ?? 0.8;
    const maxSlowSpeed = opts.maxSlowSpeed ?? SLOW_REGIME_MAX_SPEED_MS;
    const minContrast = opts.minContrast ?? SLOW_REGIME_MIN_CONTRAST;
    const fastFit = constAirSpeedTrack(dataset, sweep.best.startDist, sweep.best.speed, {fitWind: sweep.fitWind});
    const fast = {...fastFit, scored: neutralTrackScore(datasetForFittedWind(dataset, fastFit), fastFit.track)};
    if (fastFit.wind) fast.scored.score += windPriorCost(fastFit.wind.windE, fastFit.wind.windN);
    let slow = null, useSlow = false;
    if (slowProfile && slowProfile.length) {
        const row = slowProfile.reduce((a, b) => (b.score < a.score ? b : a));
        const speed = row?.metrics?.airSpeed?.mean;
        const contrast = slowValleyContrast(slowProfile);
        if (Number.isFinite(speed) && Number.isFinite(row.startDist)
            && speed > 0.1 && speed <= maxSlowSpeed && contrast >= minContrast) {
            const slowFit = constAirSpeedTrack(dataset, row.startDist, speed, {fitWind: sweep.fitWind});
            const scored = neutralTrackScore(datasetForFittedWind(dataset, slowFit), slowFit.track);
            if (slowFit.wind) scored.score += windPriorCost(slowFit.wind.windE, slowFit.wind.windN);
            slow = {row, speed, ...slowFit, scored, contrast};
            useSlow = slowRegimeWins(fast.scored.score, scored.score, margin);
        }
    }
    return {useSlow, fast, slow};
}
