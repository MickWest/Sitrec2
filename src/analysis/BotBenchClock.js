/**
 * BotBenchClock.js — deciding what a frame is worth in seconds.
 *
 * Pure arithmetic, no imports. That is the point: this is the most-revised
 * logic in the BotBench ingest, it decides the scale that every reported speed,
 * acceleration and g-load is expressed in, and until it lived here it was
 * reachable only through a file reader and a node graph — so it was verified by
 * hand each time it changed and by nothing at all afterwards. It now has
 * tests/BotBenchClock.test.js.
 *
 * Two questions, deliberately kept apart, because conflating them is what most
 * of the revisions were about:
 *
 *   WHICH FRAMES ARE CONTIGUOUS   longestUniformRun. A dropout must not be
 *                                 stitched over: the fits index time as
 *                                 frame/rate, so closing a gap silently
 *                                 rewrites when every later sample happened.
 *
 *   WHAT A FRAME IS WORTH         measureAnchorRate. Wall-clock stamps measure
 *                                 real seconds; a presentation timebase need
 *                                 not run at real time at all.
 */

/** Largest value. NOT Math.max(...array): the spread form passes every element
 * as an argument and throws RangeError past ~65k of them, and these arrays hold
 * one entry per frame. */
export function maxOf(values) {
    let m = -Infinity;
    for (let i = 0; i < values.length; i++) if (values[i] > m) m = values[i];
    return m;
}

/** Smallest value, for the same reason. */
export function minOf(values) {
    let m = Infinity;
    for (let i = 0; i < values.length; i++) if (values[i] < m) m = values[i];
    return m;
}

export function median(values) {
    if (!values.length) return NaN;
    const s = Float64Array.from(values).sort();
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Mean of the middle (1 - 2*trim) of the values.
 *
 * A RATE is an average — total elapsed over intervals — so the mean is the
 * right estimator, and the median is not: on a bimodally jittering clock whose
 * steps alternate 0.09 s and 0.1101 s the median IS one of the two modes,
 * reporting 11.1 Hz for a clock running at exactly 10.
 *
 * The forced one-from-each-end only applies once the sample can afford it. At
 * five samples a forced cut discards 40% of them, and on balanced jitter that
 * lands asymmetrically and shifts the mean enough to invent a disagreement.
 */
export function trimmedMean(values, trim = 0.1) {
    if (!values.length) return NaN;
    const s = Array.from(values).sort((a, b) => a - b);
    const cut = s.length >= 10
        ? Math.max(1, Math.floor(s.length * trim))
        : Math.floor(s.length * trim);
    const kept = s.length - 2 * cut >= 1 ? s.slice(cut, s.length - cut) : s;
    let sum = 0;
    for (const v of kept) sum += v;
    return sum / kept.length;
}

/** Uniformity of a timestamp series (seconds). */
export function timingStats(times) {
    const d = [];
    for (let i = 1; i < times.length; i++) {
        const dt = times[i] - times[i - 1];
        if (Number.isFinite(dt) && dt > 0) d.push(dt);
    }
    if (!d.length) return {meanDt: NaN, cv: NaN, gaps: 0, maxDt: NaN};
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const varr = d.reduce((a, b) => a + (b - mean) * (b - mean), 0) / d.length;
    const med = median(d);
    const gaps = d.filter((x) => x > 3 * med).length;
    return {meanDt: mean, cv: mean > 0 ? Math.sqrt(varr) / mean : NaN,
        gaps, maxDt: maxOf(d)};
}

/**
 * The longest run of items that is UNIFORMLY SAMPLED IN TIME.
 *
 * CONTINUITY IS A PROPERTY OF THE TIMESTAMPS, NOT OF THE ARRAY. Array adjacency
 * is equivalent only when the array holds exactly one entry per source frame,
 * and that is false in every case that matters: a KLV stream that drops packets
 * simply has FEWER records, a CSV can omit a row outright, and an interleaved
 * multi-track file means one track's samples are never array-adjacent at all.
 *
 * A run BREAKS on a dropout — an interval more than `gapFactor` times the
 * expected step — and not on ordinary jitter, which is measured separately.
 * `expectedDt`, when supplied AND corroborated by the data, is the declared
 * step; deriving it from the observed median alone is circular when the drops
 * are REGULAR (lose every other sample and the median becomes 2x nominal, so no
 * gap is ever detected).
 */
export function longestUniformRun(items, timeOf, gapFactor = 1.5, expectedDt = null) {
    if (items.length <= 1) {
        return {items: items.slice(), medianDt: NaN, breaks: 0, observedDt: NaN,
            degenerateClock: true, declaredMismatch: false};
    }

    const deltas = [];
    for (let i = 1; i < items.length; i++) {
        const dt = timeOf(items[i]) - timeOf(items[i - 1]);
        if (Number.isFinite(dt) && dt > 0) deltas.push(dt);
    }
    if (!deltas.length) {
        return {items: items.slice(), medianDt: NaN, breaks: 0, observedDt: NaN,
            degenerateClock: true,
            declaredMismatch: Number.isFinite(expectedDt) && expectedDt > 0};
    }
    const observedDt = median(deltas);
    // The declared rate is authoritative only if the timestamps AGREE with it,
    // in BOTH directions: a one-sided check catches samples arriving too slowly
    // and silently accepts a stream arriving twice as fast, which is then
    // replayed at the slower nominal rate — halving every speed.
    const declaredUsable = Number.isFinite(expectedDt) && expectedDt > 0
        && observedDt > 0 && Math.abs(observedDt / expectedDt - 1) <= 0.1;
    const medianDt = declaredUsable ? expectedDt : observedDt;
    const limit = medianDt * gapFactor;

    let bestStart = 0, bestLen = 1, start = 0, breaks = 0;
    for (let i = 1; i <= items.length; i++) {
        let contiguous = false;
        if (i < items.length) {
            const dt = timeOf(items[i]) - timeOf(items[i - 1]);
            contiguous = Number.isFinite(dt) && dt > 0 && dt <= limit;
        }
        if (!contiguous) {
            if (i - start > bestLen) { bestLen = i - start; bestStart = start; }
            if (i < items.length) { breaks++; start = i; }
        }
    }
    return {
        items: items.slice(bestStart, bestStart + bestLen),
        medianDt, breaks, observedDt,
        declaredMismatch: Number.isFinite(expectedDt) && expectedDt > 0 && !declaredUsable,
    };
}

/**
 * Real seconds per frame, measured from the wall-clock stamps themselves.
 *
 * @param anchorIndices frame indices carrying a wall-clock stamp, ascending
 * @param timeAt        (frameIndex) -> wall-clock seconds
 * @param cadenceDt     seconds per frame implied by the cadence timebase, used
 *                      only as a broad sanity bound (a genuine 2x encoder error
 *                      must still pass; an hour per frame must not)
 * @returns {realDt, pairsUsed, pairsTotal, epochAnchor, stepDetected,
 *           inconsistent, reason}
 *
 * `epochAnchor` is -1 when no absolute time can be established. A rate and an
 * epoch are SEPARATE findings: a majority agreeing on the step size is a real
 * measurement of the rate, while a clock that has jumped an unknown amount at
 * an unknown time has no recoverable absolute offset at all.
 */
export function measureAnchorRate(anchorIndices, timeAt, cadenceDt) {
    const out = {realDt: NaN, pairsUsed: 0, pairsTotal: 0, epochAnchor: -1,
        stepDetected: false, inconsistent: false, reason: null};
    if (anchorIndices.length < 2) return out;

    // EVERY interval counts toward the denominator, including the ones that do
    // not advance. Discarding backward resets and duplicate stamps before
    // counting let a clock that is mostly broken look unanimous: eight
    // duplicates and one good step scored 1-of-1 rather than 1-of-9.
    const pairs = [];
    let nonAdvancing = 0;
    for (let k = 1; k < anchorIndices.length; k++) {
        const i = anchorIndices[k - 1], j = anchorIndices[k];
        const dt = timeAt(j) - timeAt(i);
        const df = j - i;
        if (Number.isFinite(dt) && dt > 0 && df > 0) pairs.push({dt, df, i, rate: dt / df});
        else nonAdvancing++;
    }
    const total = pairs.length + nonAdvancing;
    out.pairsTotal = total;

    if (!pairs.length) {
        out.inconsistent = true;
        out.reason = "no interval between the wall-clock stamps advances";
        return out;
    }

    const weighted = (ps) => {
        let sumDt = 0, sumDf = 0;
        for (const pp of ps) { sumDt += pp.dt; sumDf += pp.df; }
        return sumDf > 0 ? sumDt / sumDf : NaN;
    };
    const plausible = (r) => Number.isFinite(cadenceDt) && cadenceDt > 0
        && r / cadenceDt > 0.25 && r / cadenceDt < 4;

    if (total >= 3) {
        // A MAJORITY MUST AGREE. A band around a centre detects an outlier
        // among agreeing samples; it cannot detect disagreement itself. The
        // median of an odd sample is one of the samples and always passes its
        // own band, and on an even split the median lands between two
        // populations and keeps whichever it drifts toward.
        const mid = median(pairs.map((pp) => pp.rate));
        const good = pairs.filter((pp) => Number.isFinite(mid) && mid > 0
            && pp.rate / mid > 0.5 && pp.rate / mid < 2);
        const majority = good.length >= Math.ceil(total * 0.6);
        const r = good.length ? weighted(good) : NaN;
        if (!majority || !Number.isFinite(r) || !plausible(r)) {
            out.inconsistent = true;
            out.reason = `only ${good.length} of ${total} wall-clock intervals agree`
                + (Number.isFinite(r) && !plausible(r)
                    ? `, and their combined rate is far from the cadence timeline` : "");
            return out;
        }
        out.realDt = r;
        out.pairsUsed = good.length;
        out.stepDetected = good.length < total;
        // minOf, not Math.min(...): these arrays are one entry per anchor and
        // the spread form throws RangeError on a long clip.
        out.epochAnchor = out.stepDetected ? -1 : minOf(good.map((pp) => pp.i));
        return out;
    }

    // ONE OR TWO PAIRS CANNOT OUTVOTE EACH OTHER, and must not be averaged
    // BEFORE they are checked: 0.1 s and 0.4 s average to 0.25 s, which sits
    // inside a broad sanity band against a 0.1 s cadence. Two measurements that
    // disagree are not evidence for their mean — they are evidence that one is
    // wrong.
    // AGREEMENT IS ONLY MEANINGFUL BETWEEN COMPARABLE MEASUREMENTS. Two pairs
    // spanning 1 frame and 100 frames are not two opinions of equal weight: the
    // short one is a single noisy sample, the long one averages a hundred. So
    // demand mutual agreement only when the spans are within a factor of four;
    // beyond that the weighted estimate is dominated by the longer span, which
    // is the right answer, and the plausibility bound is what guards against a
    // long span that is itself a clock step.
    const spans = pairs.map((pp) => pp.df);
    const comparableEvidence = maxOf(spans) <= minOf(spans) * 4;
    const allPlausible = pairs.every((pp) => plausible(pp.rate));
    const agree = pairs.length === 1 || !comparableEvidence
        || pairs.every((pp) => pp.rate / pairs[0].rate > 0.5 && pp.rate / pairs[0].rate < 2);
    // With unequal evidence the individual short pair may be off; the combined
    // estimate is the thing that has to stand up.
    const combined = weighted(pairs);
    const passes = comparableEvidence ? allPlausible : plausible(combined);
    if (!passes || !agree || nonAdvancing) {
        out.inconsistent = true;
        out.reason = nonAdvancing
            ? `${nonAdvancing} of ${total} wall-clock intervals do not advance`
            : (agree ? "the wall-clock interval disagrees with the cadence timeline"
                : "the two wall-clock intervals disagree with each other");
        return out;
    }
    out.realDt = combined;
    out.pairsUsed = pairs.length;
    out.epochAnchor = pairs[0].i;
    return out;
}
