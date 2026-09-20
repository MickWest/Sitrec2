/**
 * Same-time matching of acceleration vectors with the observing platform.
 * A wrong range can imprint platform motion on a candidate, but correlation
 * alone does not establish a wrong range or identify an object. In particular,
 * detrended POSITION correlation can mistake an independent speed step for a
 * platform manoeuvre. Only acceleration patterns are used here.
 */

/**
 * Least-squares removal of uniform motion (a + b*t, per axis) from a packed
 * xyz track. Frames flagged invalid by `valid` are excluded from the fit and
 * returned as zero, so a held or clipped frame contributes nothing either way.
 */
export function detrendUniformMotion(A, n, valid = null) {
    const out = new Float64Array(n * 3);
    // Normalised time keeps the normal equations well conditioned regardless of
    // clip length; the fit is invariant to the scaling either way.
    let count = 0, st = 0, stt = 0;
    for (let f = 0; f < n; f++) {
        if (valid && !valid[f]) continue;
        const t = f / Math.max(1, n - 1);
        count++; st += t; stt += t * t;
    }
    const den = count * stt - st * st;
    if (!(count > 2) || !(Math.abs(den) > 0)) return out;
    for (let c = 0; c < 3; c++) {
        let sy = 0, sty = 0;
        for (let f = 0; f < n; f++) {
            if (valid && !valid[f]) continue;
            const y = A[f * 3 + c];
            if (!Number.isFinite(y)) return out;      // refuse rather than invent
            const t = f / Math.max(1, n - 1);
            sy += y; sty += t * y;
        }
        const b = (count * sty - st * sy) / den;
        const a = (sy - b * st) / count;
        for (let f = 0; f < n; f++) {
            if (valid && !valid[f]) continue;
            out[f * 3 + c] = A[f * 3 + c] - (a + b * (f / Math.max(1, n - 1)));
        }
    }
    return out;
}

export const PLATFORM_MIRROR_METHOD = "acceleration-pattern-v2";
export const MIRROR_FULL_SHARE = 0.85;
export const MIRROR_PARTIAL_SHARE = 0.5;
export const MIRROR_MIN_SNR = 3;
export const MIRROR_SCALE_TOLERANCE = 0.25;
export const MIRROR_VECTOR_TOLERANCE = 0.5;
export const MIRROR_MIN_CHANGE_FIT = 0.5;
export const MIRROR_MIN_PLATFORM_CHANGE_G = 0.01;
const G_ACCEL = 9.81;
const MIRROR_MIN_ANGLE_DEG = 0.01;

function median(values) {
    const sorted = values.slice().sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Compare same-time acceleration VECTORS with one fixed signed scale. A
 * steady turn has constant acceleration magnitude but a rotating direction:
 * magnitude-only correlation loses exactly the pattern we need to test.
 *
 * At each scale, estimate beta robustly as the median of aX.aP / |aP|^2.
 * A few independent acceleration spikes must not determine the whole fit.
 * Count frames whose vector residual |aX - beta*aP| is at most half of
 * |beta*aP|. Share is the fraction of active platform-acceleration frames that match,
 * not variance explained or probability. Straight cruising frames add no evidence.
 * No time shifts, arbitrary rotations or frame-specific gains are fitted.
 *
 * The matching frames must also follow actual changes: on those frames the
 * scaled platform must remove at least half the error of a constant candidate
 * acceleration. Thus a constant vector similar to the middle of a turn cannot
 * count as following the turn. Platform vector variation must exceed 0.01 g.
 *
 * All tests use common interior samples at 1, 2 and 4 s half-windows (reduced
 * together for short clips). Use the minimum time share; require the same sign
 * and gains within 25% of their median. The coarse matched acceleration must
 * resolve a second-difference displacement 3 times sqrt(6) times the positional
 * scale range*LOS residual (floored at 0.01 degrees and 1 m). These are explicit
 * heuristic guards, not a calibrated probability or proof of a wrong range.
 */
export function platformMirrorStat(track, platform, n, {fps, rangeM, errDeg} = {}) {
    if (!track || !platform || !(n >= 17) || !(fps > 0) || !Number.isFinite(fps)
        || track.length < n * 3 || platform.length < n * 3
        || !Number.isFinite(rangeM) || !(rangeM > 0) || !Number.isFinite(errDeg) || errDeg < 0) return null;
    for (let i = 0; i < n * 3; i++) {
        if (!Number.isFinite(track[i]) || !Number.isFinite(platform[i])) return null;
    }
    const half = Math.min(4, (n - 1) / fps / 4);
    const steps = [0.25, 0.5, 1].map(scale => Math.round(half * scale * fps));
    if (steps[0] < 1 || new Set(steps).size !== 3) return null;
    const trim = steps[2], count = n - 2 * trim;
    const resolvingM = Math.max(1, rangeM * Math.max(errDeg, MIRROR_MIN_ANGLE_DEG) * Math.PI / 180);
    const minPlatformAccel = MIRROR_MIN_PLATFORM_CHANGE_G * G_ACCEL;
    const scales = steps.map(step => {
        const seconds = step / fps, denom = seconds * seconds;
        const P = new Float64Array(count * 3), X = new Float64Array(count * 3);
        const meanP = [0, 0, 0], coefficients = [], active = new Uint8Array(count);
        let platformPower = 0;
        for (let f = trim; f < n - trim; f++) {
            let pp = 0, xp = 0;
            const i = f - trim;
            for (let c = 0; c < 3; c++) {
                const k = f * 3 + c, j = i * 3 + c;
                P[j] = ((platform[k + 3 * step] - platform[k]) - (platform[k] - platform[k - 3 * step])) / denom;
                X[j] = ((track[k + 3 * step] - track[k]) - (track[k] - track[k - 3 * step])) / denom;
                meanP[c] += P[j] / count;
                pp += P[j] * P[j]; xp += X[j] * P[j];
            }
            platformPower += pp;
            if (pp >= minPlatformAccel * minPlatformAccel) {
                active[i] = 1; coefficients.push(xp / pp);
            }
        }
        const beta = coefficients.length ? median(coefficients) : 0;
        let variation = 0, matched = 0, residualPower = 0;
        const meanMatchedX = [0, 0, 0], matches = new Uint8Array(count);
        for (let i = 0; i < count; i++) {
            let pp = 0, error = 0;
            for (let c = 0; c < 3; c++) {
                const j = i * 3 + c;
                pp += P[j] * P[j];
                error += (X[j] - beta * P[j]) ** 2;
                variation += (P[j] - meanP[c]) ** 2;
            }
            if (active[i] && beta !== 0 && error <= MIRROR_VECTOR_TOLERANCE ** 2 * beta ** 2 * pp) {
                matched++; matches[i] = 1; residualPower += error;
                for (let c = 0; c < 3; c++) meanMatchedX[c] += X[i * 3 + c];
            }
        }
        let constantError = 0;
        if (matched) {
            for (let c = 0; c < 3; c++) meanMatchedX[c] /= matched;
            for (let i = 0; i < count; i++) if (matches[i]) {
                for (let c = 0; c < 3; c++) constantError += (X[i * 3 + c] - meanMatchedX[c]) ** 2;
            }
        }
        const changeFit = constantError > 1e-12 ? Math.max(0, 1 - residualPower / constantError) : 0;
        const matchedAccel = Math.abs(beta) * Math.sqrt(platformPower / count);
        return {windowSeconds: 2 * seconds, beta, activeFrames: coefficients.length,
            share: coefficients.length >= 6 ? matched / coefficients.length : 0, changeFit,
            platformVariationAccel: Math.sqrt(variation / count), matchedAccel,
            snr: matchedAccel * denom / (Math.sqrt(6) * resolvingM)};
    });
    if (scales.some(s => ![s.share, s.beta, s.changeFit, s.snr].every(Number.isFinite))) return null;
    const assessable = scales.every(s => s.activeFrames >= 6 && s.platformVariationAccel >= minPlatformAccel);
    const beta = median(scales.map(s => s.beta));
    const scaleStable = beta !== 0 && scales.every(s => Math.sign(s.beta) === Math.sign(beta)
        && Math.abs(s.beta - beta) <= MIRROR_SCALE_TOLERANCE * Math.abs(beta));
    const coarse = scales[2];
    return {method: PLATFORM_MIRROR_METHOD, assessable, beta, share: Math.min(...scales.map(s => s.share)),
        scaleStable, temporalMatch: scales.every(s => s.changeFit >= MIRROR_MIN_CHANGE_FIT),
        snr: coarse.snr, matchedAccel: coarse.matchedAccel,
        platformVariationG: Math.min(...scales.map(s => s.platformVariationAccel / G_ACCEL)),
        scales, framesUsed: count,
        startSeconds: trim / fps, endSeconds: (n - trim - 1) / fps};
}

/** Earlier position-only or magnitude-only records must be recalculated. */
export function platformMirrorAssessed(stat) {
    return stat?.method === PLATFORM_MIRROR_METHOD && stat.assessable === true && Number.isFinite(stat.share)
        && Number.isFinite(stat.snr) && Number.isFinite(stat.beta);
}

export function platformMirrorSignificant(stat) {
    return platformMirrorAssessed(stat) && stat.scaleStable === true && stat.temporalMatch === true
        && stat.snr >= MIRROR_MIN_SNR && stat.share >= MIRROR_PARTIAL_SHARE;
}

export function platformMirrorRank(stat) {
    if (!platformMirrorSignificant(stat)) return 3;
    return stat.share >= MIRROR_FULL_SHARE ? 1 : 2;
}

export function platformMirrorCardSummary(stat) {
    if (!platformMirrorAssessed(stat)) return "Not assessable: insufficient platform acceleration changes or timing. No penalty.";
    if (!platformMirrorSignificant(stat)) return "No sustained match to the platform's changing acceleration. No penalty.";
    return `${(stat.share * 100).toFixed(1)}% of assessed time matches the platform's changing acceleration`
        + ` (scale ${stat.beta >= 0 ? "+" : ""}${stat.beta.toFixed(2)}×). Consistent across smoothing windows.`;
}

/** Details shared by criterion tooltips, comparison gates and rank reasons. */
export function platformMirrorExplanation(stat) {
    if (!platformMirrorAssessed(stat)) {
        return stat?.method === PLATFORM_MIRROR_METHOD && !stat.assessable
            ? `Not assessable: platform acceleration-vector variation is below ${MIRROR_MIN_PLATFORM_CHANGE_G.toFixed(2)} g RMS. No penalty.`
            : "Not assessed: acceleration samples or timing are insufficient, or this result needs recalculation. No penalty applied.";
    }
    const windows = stat.scales?.map(s => s.windowSeconds.toFixed(1)).join(", ");
    const intro = `${(stat.share * 100).toFixed(1)}% of assessed time matches a fixed scaled platform acceleration vector at the same timestamps`
        + ` (minimum across ${windows || "three"}${windows ? " s" : ""} windows; only frames with platform acceleration ≥0.01 g; vector error within 50% of the scaled platform acceleration).`;
    if (!platformMirrorSignificant(stat)) {
        const reasons = [];
        if (stat.share < MIRROR_PARTIAL_SHARE) reasons.push("less than half the assessed time matches");
        if (!stat.temporalMatch) reasons.push("the matching frames do not establish shared acceleration changes");
        if (!stat.scaleStable) reasons.push("the signed scale changes with smoothing");
        if (stat.snr < MIRROR_MIN_SNR) reasons.push("the matched motion is too small at the LOS resolving scale");
        return `${intro} No penalty: ${reasons.join("; ")}.`;
    }
    return `${intro} Consistent signed scale ${stat.beta >= 0 ? "+" : ""}${stat.beta.toFixed(2)}×`
        + ` (${stat.beta < 0 ? "opposite" : "same"} direction). The match follows changing acceleration, including a steady turn.`
        + " This is a range-ambiguity or coordinated-motion caution, not proof of a wrong range.";
}

export function platformMirrorSummary(stat) {
    return platformMirrorSignificant(stat) ? platformMirrorExplanation(stat) : null;
}

/**
 * Grade a whole hypothesis set: attach the per-scene residual scale and the
 * platform-mirror record to every candidate that a track-based judgement
 * applies to.
 *
 * ONE FUNCTION, CALLED FROM EVERY PATH THAT BUILDS HYPOTHESES, and that is the
 * point rather than tidiness. These fields have to be on the hypotheses BEFORE
 * anything reads them, and there are two independent readers — the ranking the
 * gallery renders, and the executive assessment frozen alongside it. Attached
 * in a caller instead, the assessment was computed from ungraded hypotheses and
 * could declare a class viable while its own tile rejected it; and the
 * benchmark's verdict runner, which builds hypotheses without the battery, saw
 * no grading at all — so blind evaluation would have measured a different
 * ranking from the one it exists to measure.
 *
 * `fitKindOf` is injected rather than imported to keep this module free of the
 * ranking's dependency graph; callers pass hypothesisFitKind.
 *
 * @param hypotheses  the built set, mutated in place
 * @param dataset     needs S (sensor positions), n (frame count) and fps
 * @param fitKindOf   hypothesisFitKind, or any predicate-compatible equivalent
 */
export function gradeHypotheses(hypotheses, dataset, fitKindOf) {
    if (!hypotheses || !dataset) return hypotheses;
    // The scene residual scale: the generic reference residual carried by the
    // fitted hypotheses — a free constant-acceleration trajectory, no object
    // assumption, not tied to the rays. It measures how much of these
    // sightlines ordinary smooth motion cannot explain, so grading residuals as
    // multiples of it stops an absolute ladder from sorting noise on a scene
    // where every candidate already sits inside the reference. TraverseRanking
    // clamps it at both ends, and falls back to the absolute ladder when the
    // reference fit did not produce one.
    const sceneScaleDeg = hypotheses
        .map((h) => h.params?.errFloor)
        .find((v) => Number.isFinite(v) && v > 0);
    for (const h of hypotheses) {
        if (Number.isFinite(sceneScaleDeg)) h.fitScaleDeg = sceneScaleDeg;
        // Skip the hypotheses whose track is not a claim about where an object
        // was: a catalogue identification is judged on angle alone, and an
        // at-infinity check carries a helper track whose range — and so whose
        // whole platform-correlated component — is an arbitrary drawing
        // convenience.
        if (!h.track || h.atInfinity) { delete h.platformMirror; continue; }
        if (fitKindOf) {
            const kind = fitKindOf(h);
            if (kind === "identity" || kind === "directional-geometry") { delete h.platformMirror; continue; }
        }
        h.platformMirror = platformMirrorStat(h.track, dataset.S, dataset.n, {
            fps: dataset.fps, rangeM: h.metricsFull?.range?.mean,
            errDeg: h.errDeg,
        });
    }
    return hypotheses;
}
