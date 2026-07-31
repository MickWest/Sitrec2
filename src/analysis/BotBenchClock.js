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
    let staleStarts = 0;
    let backwardResets = 0;

    // A STALL AND A BACKWARD RESET ARE NOT THE SAME FAULT, and treating both as
    // "non-advancing" discarded good data.
    //
    //   dt === 0  the clock FROZE. The later anchor still reports the earlier
    //             instant, so it is STALE and any interval measured from it
    //             spans more real time than its timestamps admit — it reads
    //             high, and must be dropped.
    //
    //   dt < 0    the clock JUMPED BACKWARD. The later anchor is not stale at
    //             all; it is the first reading on a new, self-consistent
    //             timeline, and intervals measured from it are perfectly good
    //             RATE evidence. Only the absolute offset is destroyed.
    //
    // Marking the anchor after a reset stale threw away its healthy following
    // interval too: [100, 0, 1, 2, 3] lost half its intervals and was rejected
    // 2-of-4 instead of recovering the 0.1 rate it plainly contains.
    const stale = new Set();
    for (let k = 1; k < anchorIndices.length; k++) {
        const dt = timeAt(anchorIndices[k]) - timeAt(anchorIndices[k - 1]);
        if (Number.isFinite(dt) && dt === 0) stale.add(anchorIndices[k]);
    }
    for (let k = 1; k < anchorIndices.length; k++) {
        const i = anchorIndices[k - 1], j = anchorIndices[k];
        const dt = timeAt(j) - timeAt(i);
        const df = j - i;
        if (!Number.isFinite(dt) || df <= 0) { nonAdvancing++; continue; }
        if (dt === 0) { nonAdvancing++; continue; }
        if (dt < 0) { backwardResets++; continue; }
        if (stale.has(i)) { staleStarts++; continue; }
        pairs.push({dt, df, i, rate: dt / df});
    }
    const total = pairs.length + nonAdvancing + staleStarts + backwardResets;
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

    // A PAIR WHOSE IMPLIED RATE IS NOWHERE NEAR THE CADENCE IS A CLOCK STEP,
    // whatever its span. Filtering these out FIRST is what stops a short pair
    // from poisoning a weighted estimate: anchors [0, 1, 101] with times
    // [0, 30, 40] hold a 30-second jump across one frame and an honest 0.1 s
    // rate across a hundred, and the weighted mean of the two is 0.396 s/frame
    // — which slipped under a 4x sanity bound and rescaled a 10 Hz clip to
    // 2.5 Hz. Unequal spans meant the agreement test was skipped, so nothing
    // else was looking.
    const sane = pairs.filter((pp) => plausible(pp.rate));
    const stepPairs = pairs.length - sane.length;
    if (!sane.length) {
        out.inconsistent = true;
        out.reason = `none of the ${total} wall-clock intervals implies a rate near the cadence `
            + `timeline`;
        return out;
    }

    // A MAJORITY OF ALL INTERVALS MUST BE USABLE — applied in EVERY branch, so
    // there is one rule rather than a veto in one path and a threshold in
    // another. `total` counts non-advancing intervals too, so a mostly-stalled
    // clock cannot look unanimous by having its duplicates quietly dropped
    // first: one good step among eight duplicates is 1-of-9, not 1-of-1.
    //
    // This replaces a blanket "any non-advancing interval rejects" rule in the
    // two-pair path. That veto was doing the majority test's job badly: two
    // agreeing 0.1 s intervals beside a single repeated timestamp are a
    // two-thirds majority and a perfectly good rate, and were being thrown away
    // for the duplicate alone.
    // The denominator counts intervals the CLOCK failed to provide — stalls,
    // and intervals measured from a stale anchor — but NOT steps we identified
    // and removed. Excising a known step is a correction; counting it against
    // the survivors would reject a clip for the very fault we just repaired,
    // which is what threw away a lone honest interval beside one relock.
    const reliability = sane.length + nonAdvancing + staleStarts;
    const majorityOf = (k) => k >= Math.ceil(reliability * 0.6);
    // A FEW steps are a correction; MANY are a verdict on the clock. Excluding
    // them from the denominator entirely let one honest interval among
    // arbitrarily many out-of-band ones pass as 1-of-1 and rescale every
    // derived quantity. Requiring the honest intervals to at least match the
    // steps keeps the two-interval repair (one relock beside one good reading)
    // while refusing a clock that is more jump than measurement.
    const steps = stepPairs + backwardResets;
    if (sane.length < steps) {
        out.inconsistent = true;
        out.reason = `${steps} of the wall-clock intervals are clock jumps and only `
            + `${sane.length} are usable measurements`;
        return out;
    }
    if (!majorityOf(sane.length)) {
        out.inconsistent = true;
        out.reason = `only ${sane.length} of ${reliability} wall-clock intervals are usable`
            + (nonAdvancing ? ` (${nonAdvancing} do not advance)` : "")
            + (stepPairs ? ` (${stepPairs} imply a rate far from the cadence timeline)` : "");
        return out;
    }

    // BRANCH ON THE NUMBER OF USABLE MEASUREMENTS, not on how many intervals
    // happened to advance. Keying this on the raw pair count let a discarded
    // step inflate the branch: rates [0.1, 0.25, 10] drop the 10 as a step and
    // leave TWO conflicting survivors, which then took the lenient majority
    // path — they fitted a band around their own median and returned
    // 0.175 s/frame, silently rescaling 10 Hz to 5.7 Hz. Two measurements
    // cannot outvote each other however many were discarded to reach them.
    if (sane.length >= 3) {
        // A MAJORITY MUST AGREE. A band around a centre detects an outlier
        // among agreeing samples; it cannot detect disagreement itself. The
        // median of an odd sample is one of the samples and always passes its
        // own band, and on an even split the median lands between two
        // populations and keeps whichever it drifts toward.
        const mid = median(sane.map((pp) => pp.rate));
        const good = sane.filter((pp) => Number.isFinite(mid) && mid > 0
            && pp.rate / mid > 0.5 && pp.rate / mid < 2);
        const r = good.length ? weighted(good) : NaN;
        if (!majorityOf(good.length) || !Number.isFinite(r) || !plausible(r)) {
            out.inconsistent = true;
            out.reason = `only ${good.length} of ${reliability} wall-clock intervals agree`;
            return out;
        }
        out.realDt = r;
        out.pairsUsed = good.length;
        out.stepDetected = steps > 0 || good.length < sane.length;
        out.epochAnchor = epochAnchorFor(out.stepDetected, good, anchorIndices[0]);
        return out;
    }

    // ONE OR TWO USABLE MEASUREMENTS CANNOT OUTVOTE EACH OTHER, and must not be
    // averaged BEFORE they are checked: 0.1 s and 0.4 s average to 0.25 s,
    // which sits inside a broad sanity band against a 0.1 s cadence. Two
    // measurements that disagree are not evidence for their mean — they are
    // evidence that one is wrong.
    //
    // AGREEMENT IS ONLY MEANINGFUL BETWEEN COMPARABLE MEASUREMENTS. Two pairs
    // spanning 1 frame and 100 frames are not two opinions of equal weight: the
    // short one is a single noisy sample, the long one averages a hundred. So
    // demand mutual agreement only when the spans are within a factor of four —
    // the plausibility filter above has already removed anything that is a step
    // rather than a difference of precision.
    const spans = sane.map((pp) => pp.df);
    const comparableEvidence = maxOf(spans) <= minOf(spans) * 4;
    const agree = sane.length === 1 || !comparableEvidence
        || sane.every((pp) => pp.rate / sane[0].rate > 0.5 && pp.rate / sane[0].rate < 2);
    const combined = weighted(sane);
    if (!agree || !Number.isFinite(combined) || !plausible(combined)) {
        out.inconsistent = true;
        out.reason = agree ? "the wall-clock interval disagrees with the cadence timeline"
            : "the two wall-clock intervals disagree with each other";
        return out;
    }
    out.realDt = combined;
    out.pairsUsed = sane.length;
    out.stepDetected = steps > 0;
    out.epochAnchor = epochAnchorFor(out.stepDetected, sane, anchorIndices[0]);
    return out;
}

/**
 * Which anchor frame zero's time may be projected from, or -1 for none.
 *
 * BACK-PROJECTION CROSSES GROUND, and the ground has to be sound. Projecting
 * from an anchor at frame i assumes the elapsed time to it really is i * realDt
 * — which is false if a stall or a reset sits in between, because that is
 * exactly where the clock stopped telling the truth about elapsed time. A run
 * beginning [0, 0, 1, 2, ...] has its first usable interval starting at frame
 * 20; projecting back through the stall put frame zero at -1 s instead of 0,
 * shifting every date-dependent result.
 *
 * So the only anchor that may be used is the run's FIRST — where no projection
 * happens at all and the clock's own reading is taken directly. If the first
 * usable interval does not start there, the offset is unknowable.
 *
 * A detected STEP disqualifies it outright: a clock that jumped is direct
 * evidence its absolute readings are unreliable somewhere in this clip, and
 * there is no way to tell whether frame zero sits on the good side. A STALL
 * does not — a frozen clock has not lied about where it was, only about how
 * much time passed after.
 */
function epochAnchorFor(stepDetected, usablePairs, firstAnchor) {
    if (stepDetected || !usablePairs.length) return -1;
    const firstUsableStart = minOf(usablePairs.map((pp) => pp.i));
    return firstUsableStart === firstAnchor ? firstUsableStart : -1;
}
