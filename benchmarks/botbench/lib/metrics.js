// metrics.js — all per-run metrics (PLAN.md "BotBenchRunRecord" + "Anomaly
// metrics"). One shared clamped dot-angle reducer supplies every cross-solver
// angular residual; native fitter residuals (mixed units) are never used.
//
// Truth-space and LOS-space numbers are reported SEPARATELY throughout — their
// divergence is a headline result (design law 2).

import {compareTrackToTruth, trackMetrics} from "../../../src/TraverseAnalysis";
import {toTraverseDataset} from "./adapters";

const RAD2DEG = 180 / Math.PI;
const G = 9.80665;

// An estimate within this distance of the sensor has no defined apparent
// direction — the solution is DEGENERATE (collapsed onto the sensor). Frames
// like this score a conventional 180 deg residual — the SAME convention the
// repo's shared meanAngularError uses (TraverseAnalysis.js:215, PI for
// on-sensor points) — rather than NaN: a NaN series silently dropped whole
// runs from the anomaly AUC pool, and the dropped runs were precisely the
// most-collapsed ones (selection bias). A fully-collapsed run contributes a
// flat 180 deg series — robust-Z 0, no anomaly signal — i.e. it is COUNTED
// as a non-detection, and flagged via estimateSummary.onSensorFraction /
// failureFlags.collapsedOnSensor. (Non-finite frames are a different failure
// and stay NaN/excluded.)
const ON_SENSOR_EPS_M = 1e-6;
const ON_SENSOR_RESIDUAL_DEG = 180;

function percentile(sorted, p) {
    if (!sorted.length) return null;
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarize(values) {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return {mean: null, p95: null, max: null};
    let sum = 0;
    for (const x of v) sum += x;
    return {mean: sum / v.length, p95: percentile(v, 0.95), max: v[v.length - 1]};
}

// Per-frame angular residual series (degrees) between the estimate's apparent
// direction and a direction set; NaN outside the active mask (or where the
// estimate sits on the sensor).
export function residualSeriesDeg(scenario, estimate, which) {
    const n = scenario.n;
    const S = scenario.platform.positionENU;
    const D = which === "clean"
        ? scenario.observation.cleanDirectionENU
        : scenario.observation.observedDirectionENU;
    const out = new Float64Array(n).fill(NaN);
    for (let f = 0; f < n; f++) {
        if (!scenario.observation.inFov[f]) continue;
        const b = f * 3;
        let ex, ey, ez;
        if (estimate.kind === "direction") {
            [ex, ey, ez] = estimate.directionENU;
        } else {
            ex = estimate.positions[b] - S[b];
            ey = estimate.positions[b + 1] - S[b + 1];
            ez = estimate.positions[b + 2] - S[b + 2];
            const L = Math.hypot(ex, ey, ez);
            // Non-finite estimate frames are a DIFFERENT failure (solver
            // garbage): they stay NaN/excluded and are flagged via nonFinite —
            // the 90 deg convention applies only to a genuine on-sensor collapse.
            if (!Number.isFinite(L)) continue;
            if (L <= ON_SENSOR_EPS_M) {
                out[f] = ON_SENSOR_RESIDUAL_DEG;   // degenerate: see header note
                continue;
            }
            ex /= L; ey /= L; ez /= L;
        }
        const dot = Math.max(-1, Math.min(1, ex * D[b] + ey * D[b + 1] + ez * D[b + 2]));
        out[f] = Math.acos(dot) * RAD2DEG;
    }
    return out;
}

function activeValues(series, inFov) {
    const out = [];
    for (let f = 0; f < series.length; f++) {
        if (inFov[f] && Number.isFinite(series[f])) out.push(series[f]);
    }
    return out;
}

// LSQ line fit of position vs time over the given frame list -> velocity [3].
function lineFitVelocity(positions, times, frames) {
    if (frames.length < 5) return null;
    let st = 0, stt = 0;
    const sp = [0, 0, 0], spt = [0, 0, 0];
    for (const f of frames) {
        const t = times[f];
        st += t; stt += t * t;
        for (let k = 0; k < 3; k++) {
            sp[k] += positions[f * 3 + k];
            spt[k] += positions[f * 3 + k] * t;
        }
    }
    const m = frames.length;
    const det = m * stt - st * st;
    if (Math.abs(det) < 1e-12) return null;
    return [0, 1, 2].map((k) => (m * spt[k] - st * sp[k]) / det);
}

function framesInWindow(scenario, t0, t1, activeOnly = true) {
    const out = [];
    for (let f = 0; f < scenario.n; f++) {
        const t = scenario.times[f];
        if (t >= t0 && t < t1 && (!activeOnly || scenario.observation.inFov[f])) out.push(f);
    }
    return out;
}

function windowStats(series, frames, minCount) {
    const vals = frames.map((f) => series[f]).filter(Number.isFinite);
    if (vals.length < minCount) return {count: vals.length, mean: null, rms: null, p95: null, max: null};
    const sorted = vals.slice().sort((a, b) => a - b);
    let sum = 0, sum2 = 0;
    for (const v of vals) { sum += v; sum2 += v * v; }
    return {
        count: vals.length,
        mean: sum / vals.length,
        rms: Math.sqrt(sum2 / vals.length),
        p95: percentile(sorted, 0.95),
        max: sorted[sorted.length - 1],
    };
}

function median(vals) {
    if (!vals.length) return null;
    const s = vals.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function windowedResidualMetrics(scenario, series, ev, minCount) {
    const {onsetSeconds: onset, endSeconds: end} = ev;
    const w = {
        pre: framesInWindow(scenario, onset - 2, onset),
        event: framesInWindow(scenario, onset, end),
        post: framesInWindow(scenario, end, end + 2),
    };
    w.local = [...w.pre, ...w.event, ...w.post];
    const stats = {};
    for (const k of ["pre", "event", "post", "local"]) stats[k] = windowStats(series, w[k], minCount);

    const dt = 1 / scenario.fps;
    let excessArea = null, localPeakRobustZ = null, peakDelaySeconds = null;
    let eventMeanLift = null, postMeanLift = null, localPeakLift = null;
    if (stats.pre.mean !== null) {
        if (stats.event.mean !== null) eventMeanLift = stats.event.mean - stats.pre.mean;
        if (stats.post.mean !== null) postMeanLift = stats.post.mean - stats.pre.mean;
        if (stats.local.max !== null) localPeakLift = stats.local.max - stats.pre.mean;
        excessArea = 0;
        for (const f of [...w.event, ...w.post]) {
            const v = series[f];
            if (Number.isFinite(v)) excessArea += Math.max(0, v - stats.pre.mean) * dt;
        }
        const preVals = w.pre.map((f) => series[f]).filter(Number.isFinite);
        const med = median(preVals);
        if (med !== null && stats.local.max !== null) {
            const mad = median(preVals.map((v) => Math.abs(v - med))) ?? 0;
            const scale = Math.max(1.4826 * mad, 1e-4);
            localPeakRobustZ = (stats.local.max - med) / scale;
        }
        let peakT = null, peakV = -Infinity;
        for (const f of w.local) {
            const v = series[f];
            if (Number.isFinite(v) && v > peakV) { peakV = v; peakT = scenario.times[f]; }
        }
        if (peakT !== null) peakDelaySeconds = peakT - onset;
    }
    return {
        windows: stats,
        eventMeanLift, postMeanLift, localPeakLift,
        excessAreaDegSeconds: excessArea,
        localPeakRobustZ,
        peakDelaySeconds,
    };
}

// Event-blind whole-clip anomaly summary from a residual series.
function eventBlindSummary(scenario, series) {
    const vals = activeValues(series, scenario.observation.inFov);
    if (vals.length < 5) return null;
    const med = median(vals);
    const mad = median(vals.map((v) => Math.abs(v - med))) ?? 0;
    const scale = Math.max(1.4826 * mad, 1e-4);
    let peak = -Infinity, peakT = null;
    for (let f = 0; f < scenario.n; f++) {
        const v = series[f];
        if (Number.isFinite(v) && v > peak) { peak = v; peakT = scenario.times[f]; }
    }
    // max 2-second excess area over a sliding window
    const dt = 1 / scenario.fps;
    const win = Math.max(1, Math.round(2 * scenario.fps));
    let best = 0;
    for (let f0 = 0; f0 < scenario.n; f0 += Math.max(1, win >> 2)) {
        let area = 0;
        for (let f = f0; f < Math.min(scenario.n, f0 + win); f++) {
            const v = series[f];
            if (Number.isFinite(v)) area += Math.max(0, v - med) * dt;
        }
        if (area > best) best = area;
    }
    return {
        globalPeakRobustZ: (peak - med) / scale,
        maxExcessArea2sDegSeconds: best,
        largestExcursionTimeSeconds: peakT,
    };
}

// Kinematic recovery around one event (track truth + track estimate only).
function kinematicRecovery(scenario, estimate, ev, truthKin, estKin) {
    const {onsetSeconds: onset, endSeconds: end} = ev;
    const beforeFrames = framesInWindow(scenario, onset - 1.0, onset - 0.2);
    const afterFrames = framesInWindow(scenario, end + 0.2, end + 1.0);
    const truthPos = scenario.target.positionENU;
    const isImpulse = ev.family === "impulse" && ev.anomalous;

    const vB_t = lineFitVelocity(truthPos, scenario.times, beforeFrames);
    const vA_t = lineFitVelocity(truthPos, scenario.times, afterFrames);
    const vB_e = lineFitVelocity(estimate.positions, scenario.times, beforeFrames);
    const vA_e = lineFitVelocity(estimate.positions, scenario.times, afterFrames);

    const dv = (a, b) => (a && b) ? [a[0] - b[0], a[1] - b[1], a[2] - b[2]] : null;
    const truthDv = isImpulse
        ? (ev.parameters.deltaVENU ?? null)
        : dv(vA_t, vB_t);
    const estDv = dv(vA_e, vB_e);
    const mag = (v) => v ? Math.hypot(v[0], v[1], v[2]) : null;
    const truthDvMag = mag(truthDv), estDvMag = mag(estDv);

    let dvDirErr = null;
    if (truthDv && estDv && truthDvMag > 1e-6 && estDvMag > 1e-6) {
        const dot = (truthDv[0] * estDv[0] + truthDv[1] * estDv[1] + truthDv[2] * estDv[2])
            / (truthDvMag * estDvMag);
        dvDirErr = Math.acos(Math.max(-1, Math.min(1, dot))) * RAD2DEG;
    }

    const headingOf = (v) => (v && Math.hypot(v[0], v[1]) > 0.5)
        ? Math.atan2(v[0], v[1]) * RAD2DEG : null;
    const wrap = (d) => ((d + 540) % 360) - 180;
    const hB_t = headingOf(vB_t), hA_t = headingOf(vA_t);
    const hB_e = headingOf(vB_e), hA_e = headingOf(vA_e);
    const truthHeadingChange = (hB_t !== null && hA_t !== null) ? wrap(hA_t - hB_t) : null;
    const estHeadingChange = (hB_e !== null && hA_e !== null) ? wrap(hA_e - hB_e) : null;

    // Peak g and half-max width from the common 0.5 s-smoothed series over the
    // local window, FOV-ACTIVE frames only (contract: every event statistic
    // uses the active mask; the smoothing window may still SPAN excluded
    // frames — that is differentiation support, not statistics inclusion).
    // Impulse truth peak-g/width are null (contract): the declared
    // discontinuous delta-v IS the truth metric.
    const localFrames = framesInWindow(scenario, onset - 2, end + 2, true);
    const peakOf = (kin) => {
        if (!kin) return {peakG: null, peakT: null, halfWidth: null};
        let peakG = -Infinity, peakT = null;
        for (const f of localFrames) {
            const g = kin.series.gLoad[f];
            if (Number.isFinite(g) && g > peakG) { peakG = g; peakT = scenario.times[f]; }
        }
        if (!Number.isFinite(peakG)) return {peakG: null, peakT: null, halfWidth: null};
        const half = peakG / 2;
        let t0 = peakT, t1 = peakT;
        for (const f of localFrames) {
            const g = kin.series.gLoad[f];
            if (Number.isFinite(g) && g >= half) {
                t0 = Math.min(t0, scenario.times[f]);
                t1 = Math.max(t1, scenario.times[f]);
            }
        }
        return {peakG, peakT, halfWidth: t1 - t0};
    };
    const tPk = isImpulse ? {peakG: null, peakT: null, halfWidth: null} : peakOf(truthKin);
    const ePk = peakOf(estKin);

    return {
        truthPeakG: tPk.peakG,
        estimatedPeakG: ePk.peakG,
        peakGRatio: (tPk.peakG && ePk.peakG !== null) ? ePk.peakG / tPk.peakG : null,
        truthDeltaVENU: truthDv,
        estimatedDeltaVENU: estDv,
        truthDeltaVMagnitudeMS: truthDvMag,
        estimatedDeltaVMagnitudeMS: estDvMag,
        deltaVMagnitudeRatio: (truthDvMag > 1e-6 && estDvMag !== null) ? estDvMag / truthDvMag : null,
        deltaVDirectionErrorDeg: dvDirErr,
        truthHeadingChangeDeg: truthHeadingChange,
        estimatedHeadingChangeDeg: estHeadingChange,
        headingChangeErrorDeg: (truthHeadingChange !== null && estHeadingChange !== null)
            ? wrap(estHeadingChange - truthHeadingChange) : null,
        estimatedHalfMaximumWidthSeconds: ePk.halfWidth,
        peakTimingErrorSeconds: (ePk.peakT !== null)
            ? ePk.peakT - (isImpulse || tPk.peakT === null ? ev.onsetSeconds : tPk.peakT)
            : null,
    };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function computeMetrics(scenario, estimate) {
    const n = scenario.n;
    const S = scenario.platform.positionENU;
    const cleanD = scenario.observation.cleanDirectionENU;
    const inFov = scenario.observation.inFov;
    const activeCount = n - scenario.observation.outOfFrameCount;
    const minWindowCount = Math.max(5, Math.ceil(0.5 * scenario.fps));

    // ---- angular residuals (shared reducer) -----------------------------
    const obsSeries = residualSeriesDeg(scenario, estimate, "observed");
    const cleanSeries = residualSeriesDeg(scenario, estimate, "clean");
    const obsStats = summarize(activeValues(obsSeries, inFov));
    const cleanStats = summarize(activeValues(cleanSeries, inFov));
    const angular = {
        observedMeanDeg: obsStats.mean, cleanMeanDeg: cleanStats.mean,
        observedP95Deg: obsStats.p95, observedMaxDeg: obsStats.max,
        cleanP95Deg: cleanStats.p95, cleanMaxDeg: cleanStats.max,
    };

    // ---- estimate summary -------------------------------------------------
    let estimateSummary, nonFinite = false, behindSensorFraction = 0;
    let onSensorFraction = 0;
    if (estimate.kind === "track") {
        let finiteCount = 0, behind = 0, onSensor = 0;
        const rangeAt = (f) => {
            const b = f * 3;
            return Math.hypot(estimate.positions[b] - S[b],
                estimate.positions[b + 1] - S[b + 1],
                estimate.positions[b + 2] - S[b + 2]);
        };
        let rangeSum = 0, rangeCount = 0;
        for (let f = 0; f < n; f++) {
            const b = f * 3;
            const ok = Number.isFinite(estimate.positions[b])
                && Number.isFinite(estimate.positions[b + 1])
                && Number.isFinite(estimate.positions[b + 2]);
            if (!ok) { nonFinite = true; continue; }
            finiteCount++;
            if (rangeAt(f) <= ON_SENSOR_EPS_M) onSensor++;
            // signed along-ray range against the CLEAN direction: behind-sensor
            // solutions are explicit, not hidden in a Euclidean distance.
            const lambda = (estimate.positions[b] - S[b]) * cleanD[b]
                + (estimate.positions[b + 1] - S[b + 1]) * cleanD[b + 1]
                + (estimate.positions[b + 2] - S[b + 2]) * cleanD[b + 2];
            if (lambda < 0) behind++;
            rangeSum += rangeAt(f);
            rangeCount++;
        }
        behindSensorFraction = finiteCount ? behind / finiteCount : 0;
        onSensorFraction = finiteCount ? onSensor / finiteCount : 0;
        const mid = n >> 1;
        estimateSummary = {
            kind: "track",
            finiteFrameFraction: finiteCount / n,
            behindSensorFraction,
            onSensorFraction,
            rangeStartM: Number.isFinite(rangeAt(0)) ? rangeAt(0) : null,
            rangeMidM: Number.isFinite(rangeAt(mid)) ? rangeAt(mid) : null,
            rangeEndM: Number.isFinite(rangeAt(n - 1)) ? rangeAt(n - 1) : null,
            rangeMeanM: rangeCount ? rangeSum / rangeCount : null,
            parameterSummary: estimate.parameterSummary ?? {},
        };
    } else {
        nonFinite = !estimate.directionENU.every(Number.isFinite);
        estimateSummary = {
            kind: "direction",
            directionENU: [...estimate.directionENU],
            parameterSummary: estimate.parameterSummary ?? {},
        };
    }

    // ---- truth metrics ------------------------------------------------------
    let truth;
    let relativeRangeErrorAbove50Pct = null;
    if (scenario.target.kind === "track" && estimate.kind === "track") {
        const trav = toTraverseDataset(scenario);
        const cmp = compareTrackToTruth(trav, estimate.positions,
            {track: scenario.target.positionENU, valid: scenario.target.valid});
        const truthRangeAt = (f) => {
            const b = f * 3;
            return Math.hypot(scenario.target.positionENU[b] - S[b],
                scenario.target.positionENU[b + 1] - S[b + 1],
                scenario.target.positionENU[b + 2] - S[b + 2]);
        };
        const estRangeAt = (f) => {
            const b = f * 3;
            return Math.hypot(estimate.positions[b] - S[b],
                estimate.positions[b + 1] - S[b + 1],
                estimate.positions[b + 2] - S[b + 2]);
        };
        const mid = n >> 1;
        const rangeErrAt = (f) => {
            const tr = truthRangeAt(f), er = estRangeAt(f);
            if (!Number.isFinite(tr) || !Number.isFinite(er) || tr <= 0) return [null, null];
            return [er - tr, (er - tr) / tr];
        };
        const [sM, sF] = rangeErrAt(0);
        const [mM, mF] = rangeErrAt(mid);
        const [eM, eF] = rangeErrAt(n - 1);
        // Precise ">50% range error" statistic (predeclared): the MEDIAN over
        // frames of |estRange - truthRange| / truthRange. Never applied to
        // direction truth.
        const relErrs = [];
        for (let f = 0; f < n; f++) {
            const tr = truthRangeAt(f), er = estRangeAt(f);
            if (Number.isFinite(tr) && Number.isFinite(er) && tr > 0) {
                relErrs.push(Math.abs(er - tr) / tr);
            }
        }
        const medRel = median(relErrs);
        relativeRangeErrorAbove50Pct = medRel !== null ? medRel > 0.5 : null;

        truth = cmp.comparable ? {
            kind: "track",
            comparable: true,
            reason: null,
            framesUsed: cmp.framesUsed,
            meanSeparationM: cmp.sep3D.mean,
            maxSeparationM: cmp.sep3D.max,
            meanHorizontalSeparationM: cmp.horizontal.mean,
            meanAbsAltitudeErrorM: cmp.altitude.meanAbs,
            meanSignedAltitudeErrorM: cmp.altitude.meanSigned,
            meanSpeedAbsErrorMS: cmp.speed ? cmp.speed.meanAbsDiff : null,
            meanHeadingAbsErrorDeg: cmp.heading ? cmp.heading.meanAbsDiff : null,
            meanTruthRangeM: cmp.meanTruthRange,
            medianRelativeRangeError: medRel,
            rangeError: {startM: sM, startFraction: sF, midM: mM, midFraction: mF,
                endM: eM, endFraction: eF},
        } : {
            kind: "track", comparable: false, reason: cmp.note ?? "not comparable",
            framesUsed: cmp.framesUsed ?? 0,
            meanSeparationM: null, maxSeparationM: null, meanHorizontalSeparationM: null,
            meanAbsAltitudeErrorM: null, meanSignedAltitudeErrorM: null,
            meanSpeedAbsErrorMS: null, meanHeadingAbsErrorDeg: null,
            meanTruthRangeM: null, medianRelativeRangeError: null,
            rangeError: {startM: null, startFraction: null, midM: null,
                midFraction: null, endM: null, endFraction: null},
        };
    } else if (scenario.target.kind === "direction") {
        // Direction truth: per-frame apparent-direction error. No 3D
        // separation / speed / pseudo-range accuracy is invented; finite-solver
        // fitted ranges are recorded only as instability diagnostics.
        const T = scenario.target.directionENU;
        const errs = [];
        for (let f = 0; f < n; f++) {
            if (!inFov[f]) continue;
            const b = f * 3;
            let ex, ey, ez;
            if (estimate.kind === "direction") {
                [ex, ey, ez] = estimate.directionENU;
            } else {
                ex = estimate.positions[b] - S[b];
                ey = estimate.positions[b + 1] - S[b + 1];
                ez = estimate.positions[b + 2] - S[b + 2];
                const L = Math.hypot(ex, ey, ez);
                if (!Number.isFinite(L)) continue;   // solver garbage: excluded, flagged nonFinite
                if (L <= ON_SENSOR_EPS_M) {
                    errs.push(ON_SENSOR_RESIDUAL_DEG);   // degenerate: counted, not dropped
                    continue;
                }
                ex /= L; ey /= L; ez /= L;
            }
            const dot = Math.max(-1, Math.min(1, ex * T[b] + ey * T[b + 1] + ez * T[b + 2]));
            errs.push(Math.acos(dot) * RAD2DEG);
        }
        const st = summarize(errs);
        let fittedRange = null;
        if (estimate.kind === "track" && estimateSummary.rangeMeanM !== null) {
            fittedRange = {
                startM: estimateSummary.rangeStartM,
                midM: estimateSummary.rangeMidM,
                endM: estimateSummary.rangeEndM,
                meanM: estimateSummary.rangeMeanM,
            };
        }
        truth = {
            kind: "direction", body: "Venus", framesUsed: errs.length,
            meanDirectionErrorDeg: st.mean, p95DirectionErrorDeg: st.p95,
            maxDirectionErrorDeg: st.max, fittedRange,
        };
    } else {
        // direction estimate vs track truth: classification hypothesis, not
        // rankable by 3D error (contract) — report non-comparable.
        truth = {
            kind: "track", comparable: false,
            reason: "direction estimate has no 3D track to compare",
            framesUsed: 0,
            meanSeparationM: null, maxSeparationM: null, meanHorizontalSeparationM: null,
            meanAbsAltitudeErrorM: null, meanSignedAltitudeErrorM: null,
            meanSpeedAbsErrorMS: null, meanHeadingAbsErrorDeg: null,
            meanTruthRangeM: null, medianRelativeRangeError: null,
            rangeError: {startM: null, startFraction: null, midM: null,
                midFraction: null, endM: null, endFraction: null},
        };
    }

    // ---- kinematics -----------------------------------------------------------
    let kinematics = null;
    let estKin = null;
    if (estimate.kind === "track" && !nonFinite) {
        estKin = trackMetrics(toTraverseDataset(scenario), estimate.positions,
            {smoothSeconds: 0.5});
        const pick = ({min, max, mean, rms, std}) => ({min, max, mean, rms, std});
        kinematics = {
            groundSpeed: pick(estKin.groundSpeed),
            airSpeed: pick(estKin.airSpeed),
            verticalSpeed: pick(estKin.verticalSpeed),
            gLoad: pick(estKin.gLoad),
            turnRate: pick(estKin.turnRate),
            altitude: pick(estKin.altitude),
            range: pick(estKin.range),
        };
    }

    // ---- anomaly metrics ---------------------------------------------------
    let anomaly = null;
    if (scenario.events.length > 0) {
        let truthKin = null;
        if (scenario.target.kind === "track") {
            truthKin = trackMetrics(toTraverseDataset(scenario),
                scenario.target.positionENU, {smoothSeconds: 0.5});
        }
        const events = scenario.events.map((ev) => {
            const truthErrSeries = new Float64Array(n).fill(NaN);
            if (scenario.target.kind === "track" && estimate.kind === "track") {
                for (let f = 0; f < n; f++) {
                    if (!inFov[f]) continue;
                    const b = f * 3;
                    truthErrSeries[f] = Math.hypot(
                        estimate.positions[b] - scenario.target.positionENU[b],
                        estimate.positions[b + 1] - scenario.target.positionENU[b + 1],
                        estimate.positions[b + 2] - scenario.target.positionENU[b + 2]);
                }
            }
            const wTruth = (t0, t1) => {
                const fr = framesInWindow(scenario, t0, t1);
                const vals = fr.map((f) => truthErrSeries[f]).filter(Number.isFinite);
                if (vals.length < minWindowCount) return {mean: null, max: null};
                let sum = 0, mx = -Infinity;
                for (const v of vals) { sum += v; if (v > mx) mx = v; }
                return {mean: sum / vals.length, max: mx};
            };
            const pre = wTruth(ev.onsetSeconds - 2, ev.onsetSeconds);
            const evt = wTruth(ev.onsetSeconds, ev.endSeconds);
            const post = wTruth(ev.endSeconds, ev.endSeconds + 2);
            const local = wTruth(ev.onsetSeconds - 2, ev.endSeconds + 2);
            return {
                eventId: ev.eventId,
                pairId: ev.pairId,
                family: ev.family,
                anomalous: ev.anomalous,
                onsetSeconds: ev.onsetSeconds,
                endSeconds: ev.endSeconds,
                coverage: {
                    pre: framesInWindow(scenario, ev.onsetSeconds - 2, ev.onsetSeconds).length,
                    event: framesInWindow(scenario, ev.onsetSeconds, ev.endSeconds).length,
                    post: framesInWindow(scenario, ev.endSeconds, ev.endSeconds + 2).length,
                    local: framesInWindow(scenario, ev.onsetSeconds - 2, ev.endSeconds + 2).length,
                },
                observedResidualDeg: windowedResidualMetrics(scenario, obsSeries, ev, minWindowCount),
                cleanResidualDeg: windowedResidualMetrics(scenario, cleanSeries, ev, minWindowCount),
                truthError: {
                    kind: "track",
                    preMeanM: pre.mean, eventMeanM: evt.mean, eventMaxM: evt.max,
                    postMeanM: post.mean, localMaxM: local.max,
                },
                kinematicRecovery: (estimate.kind === "track" && scenario.target.kind === "track")
                    ? kinematicRecovery(scenario, estimate, ev, truthKin, estKin)
                    : null,
            };
        });
        anomaly = {global: eventBlindSummary(scenario, obsSeries), events};
    }

    return {
        samples: {
            totalFrames: n,
            activeFrames: activeCount,
            excludedFrames: scenario.observation.outOfFrameCount,
            outOfFrameFraction: scenario.observation.outOfFrameFraction,
            analysisMask: "native-fov",
        },
        estimateSummary,
        metrics: {angular, truth, kinematics, anomaly},
        failureFlags: {
            solverFailed: false,
            nonFinite,
            behindSensor: behindSensorFraction > 0,
            collapsedOnSensor: onSensorFraction > 0.5,
            activeCoverageBelow50Pct: activeCount / n < 0.5,
            relativeRangeErrorAbove50Pct,
        },
    };
}
