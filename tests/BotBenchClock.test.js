/**
 * Regression tests for the BotBench clock logic.
 *
 * This code decides what a frame is worth in seconds, which is the scale every
 * reported speed, acceleration and g-load is expressed in. It was revised six
 * times across successive reviews, and each revision was verified by hand and
 * then protected by nothing — so a later fix could and did reintroduce an
 * earlier fault. Every case below is one that was actually WRONG at some point,
 * with the value it produced then, so a regression names itself.
 */

import {
    longestUniformRun, maxOf, measureAnchorRate, median, minOf, timingStats, trimmedMean,
} from "../src/analysis/BotBenchClock";

// Frame indices -> wall-clock seconds, from an explicit list of per-pair rates.
// Anchors sit `spacing` frames apart, so pair k has rate rates[k].
function anchorsFromRates(rates, spacing = 10) {
    const idx = [0];
    const times = [0];
    let t = 0;
    rates.forEach((r, k) => {
        t += r * spacing;
        idx.push((k + 1) * spacing);
        times.push(t);
    });
    return {idx, timeAt: (f) => times[idx.indexOf(f)]};
}

describe("maxOf / minOf", () => {
    test("handle arrays far past the spread-argument limit", () => {
        // Math.max(...a) throws RangeError here — the limit on this runtime is
        // about 125k, so a smaller array would pass either way and prove
        // nothing. One entry per frame means a 30 fps clip passes 125k in a
        // little over an hour.
        const a = new Float64Array(200000);
        a[123456] = 5;
        a[7] = -3;
        expect(maxOf(a)).toBe(5);
        expect(minOf(a)).toBe(-3);
    });
});

describe("trimmedMean", () => {
    test("is unbiased on bimodal jitter, where the median is not", () => {
        // A correct 10 Hz clock alternating 0.09 / 0.1101 s. With an ODD count
        // — which is what 200 frames give: 199 steps — the median IS one of the
        // two modes, and reported 11.111 Hz for a 10 Hz clock. (With an even
        // count it lands between them and the fault hides, which is why this
        // uses the real shape.)
        const steps = [];
        for (let i = 0; i < 199; i++) steps.push(i % 2 ? 0.09 : 0.1101);
        expect(median(steps)).toBeCloseTo(0.1101, 4);          // the old, wrong answer
        expect(trimmedMean(steps)).toBeCloseTo(0.1, 2);        // ~10 Hz
    });

    test("does not force a cut on a sample too small to afford one", () => {
        // A forced cut at 5 samples discards 40% of them and, landing
        // asymmetrically on balanced jitter, invented rate disagreements.
        expect(trimmedMean([1, 1, 1, 1, 1])).toBe(1);
        expect(trimmedMean([0.09, 0.1101, 0.09, 0.1101, 0.09])).toBeCloseTo(0.0980, 3);
    });

    test("rejects a single outlier once the sample is large enough", () => {
        const v = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 3600];
        expect(trimmedMean(v)).toBeCloseTo(0.1, 6);
    });
});

describe("longestUniformRun", () => {
    const at = (arr) => (i) => arr[i];

    test("keeps a clean series whole", () => {
        const t = Array.from({length: 50}, (_, i) => i * 0.1);
        const r = longestUniformRun(t.map((_, i) => i), at(t));
        expect(r.items.length).toBe(50);
        expect(r.breaks).toBe(0);
    });

    test("breaks on a dropout rather than stitching across it", () => {
        // Frames 0..19 then a two-frame hole then 22..49. Closing the gap would
        // silently rewrite when every later sample happened.
        const t = [];
        for (let i = 0; i < 50; i++) t.push(i < 20 ? i * 0.1 : (i + 2) * 0.1);
        const r = longestUniformRun(t.map((_, i) => i), at(t));
        expect(r.breaks).toBe(1);
        expect(r.items.length).toBe(30);
    });

    test("uses timestamps, not array adjacency", () => {
        // Array-adjacent entries whose TIMES jump: a KLV stream that drops
        // packets has fewer records, with no placeholder to notice.
        const t = [0, 0.1, 0.2, 5.0, 5.1, 5.2, 5.3];
        const r = longestUniformRun(t.map((_, i) => i), at(t));
        expect(r.breaks).toBe(1);
        expect(r.items.length).toBe(4);
    });

    test("a declared rate contradicted by the data is not used", () => {
        // Uniformly FASTER than declared. A one-sided gap test accepts this and
        // replays at the slower nominal rate, halving every speed.
        const t = Array.from({length: 30}, (_, i) => i * 0.05);
        const r = longestUniformRun(t.map((_, i) => i), at(t), 1.5, 0.1);
        expect(r.declaredMismatch).toBe(true);
        expect(r.observedDt).toBeCloseTo(0.05, 6);
    });

    test("a non-advancing clock is degenerate, not a rate of zero", () => {
        const t = new Array(30).fill(7);
        const r = longestUniformRun(t.map((_, i) => i), at(t));
        expect(r.degenerateClock).toBe(true);
    });
});

describe("measureAnchorRate", () => {
    const CADENCE = 0.1;

    test("measures a clean set of anchors", () => {
        const {idx, timeAt} = anchorsFromRates([0.1, 0.1, 0.1, 0.1]);
        const r = measureAnchorRate(idx, timeAt, CADENCE);
        expect(r.realDt).toBeCloseTo(0.1, 6);
        expect(r.inconsistent).toBe(false);
        expect(r.epochAnchor).toBe(0);
    });

    test("weights by span — unequal spans averaged unweighted gave 6.689 Hz", () => {
        // Anchors at frames 0, 1, 101: spans of 1 and 100 frames, true rate 10 Hz.
        const times = {0: 0, 1: 0.2, 101: 10.1};
        const r = measureAnchorRate([0, 1, 101], (f) => times[f], CADENCE);
        expect(1 / r.realDt).toBeCloseTo(10, 1);
    });

    test("one relock among many is excluded, and costs the epoch", () => {
        const {idx, timeAt} = anchorsFromRates([0.1, 0.1, 0.1, 450]);
        const r = measureAnchorRate(idx, timeAt, CADENCE);
        expect(r.realDt).toBeCloseTo(0.1, 6);
        expect(r.stepDetected).toBe(true);
        // The rate survives a step; the absolute offset does not.
        expect(r.epochAnchor).toBe(-1);
    });

    test("an even split of steps and honest intervals recovers the rate, not the epoch", () => {
        // [0.1, 0.1, 450, 450] once reported 0.0022 Hz: a median-centred band
        // landed between the two populations and kept the wrong half. The 450s
        // intervals are now identified positively as steps — 4500x the cadence
        // — so they are excised and the honest rate survives. Two jumps of
        // unknown size mean the absolute offset does not.
        const {idx, timeAt} = anchorsFromRates([0.1, 0.1, 450, 450]);
        const r = measureAnchorRate(idx, timeAt, CADENCE);
        expect(1 / r.realDt).toBeCloseTo(10, 1);
        expect(r.stepDetected).toBe(true);
        expect(r.epochAnchor).toBe(-1);
    });

    test("two pairs that disagree are not averaged into a plausible middle", () => {
        // 0.1 and 0.4 s/frame. Averaging them gives 0.25, which slips under a
        // broad sanity band against a 0.1 cadence and rescaled 10 Hz to 4 Hz.
        // The 0.4 pair is now recognised as a step and dropped, leaving the
        // honest one — the true rate, rather than either the bad average or a
        // blanket refusal.
        const times = {0: 0, 10: 1, 20: 5};
        const r = measureAnchorRate([0, 10, 20], (f) => times[f], CADENCE);
        expect(r.realDt).not.toBeCloseTo(0.25, 2);   // never the average
        expect(1 / r.realDt).toBeCloseTo(10, 1);
        expect(r.stepDetected).toBe(true);
        expect(r.epochAnchor).toBe(-1);
    });

    test("non-advancing intervals count against the majority", () => {
        // Eight duplicate stamps and one good step scored 1-of-1, not 1-of-9.
        const idx = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
        const times = {0: 0, 10: 1};
        for (const f of [20, 30, 40, 50, 60, 70, 80, 90]) times[f] = 1;
        const r = measureAnchorRate(idx, (f) => times[f], CADENCE);
        expect(r.inconsistent).toBe(true);
        expect(r.pairsTotal).toBe(9);
    });

    test("a lone pair spanning a relock is refused, not trusted", () => {
        const times = {0: 0, 100: 3600};
        const r = measureAnchorRate([0, 100], (f) => times[f], CADENCE);
        expect(r.inconsistent).toBe(true);
    });

    test("a lone plausible pair is accepted", () => {
        const times = {0: 0, 100: 10};
        const r = measureAnchorRate([0, 100], (f) => times[f], CADENCE);
        expect(r.realDt).toBeCloseTo(0.1, 6);
        expect(r.epochAnchor).toBe(0);
    });

    test("a short pair spanning a clock step cannot poison the weighted rate", () => {
        // Anchors [0, 1, 101] at times [0, 30, 40]: a 30 s jump across ONE
        // frame beside an honest 0.1 s rate across a hundred. Their weighted
        // mean is 0.396 s/frame, which slipped under the 4x sanity bound and
        // rescaled a 10 Hz clip to 2.5 Hz — the unequal spans meant the
        // agreement test was skipped, so nothing else was looking.
        const times = {0: 0, 1: 30, 101: 40};
        const r = measureAnchorRate([0, 1, 101], (f) => times[f], 0.1);
        expect(1 / r.realDt).toBeCloseTo(10, 1);
        expect(r.stepDetected).toBe(true);
        expect(r.epochAnchor).toBe(-1);   // a step costs the epoch
    });

    test("a duplicate does not let two conflicting pairs take the lenient path", () => {
        // [0, 1, 2, 9] at times [0, 0, 0.2, 0.9]: one non-advancing interval
        // plus two disagreeing pairs. Counting the duplicate toward the branch
        // THRESHOLD sent this down the majority path, where both pairs fitted a
        // band around their own median, and returned 0.1125 s/frame.
        const times = {0: 0, 1: 0, 2: 0.2, 9: 0.9};
        const r = measureAnchorRate([0, 1, 2, 9], (f) => times[f], 0.1);
        expect(r.inconsistent).toBe(true);
    });

    test("a discarded step does not inflate the branch past the strict check", () => {
        // Rates [0.1, 0.25, 10]. The 10 is dropped as a step, leaving TWO
        // conflicting survivors — which took the lenient majority path because
        // the branch keyed on the raw pair count, fitted a band around their
        // own median and returned 0.175 s/frame: 10 Hz silently rescaled to
        // 5.7 Hz. Two measurements cannot outvote each other however many were
        // discarded to reach them.
        const {idx, timeAt} = anchorsFromRates([0.1, 0.25, 10]);
        const r = measureAnchorRate(idx, timeAt, CADENCE);
        expect(r.inconsistent).toBe(true);
    });

    test("one stall in a long healthy run does not veto the clock", () => {
        // A blanket "any non-advancing interval rejects" rule threw a whole
        // clip away for a single repeated stamp. It is now a majority test:
        // one stall costs TWO intervals (the stall itself, and the one measured
        // from the stale anchor after it), which a long run absorbs easily.
        const idx = [], times = {};
        for (let k = 0; k <= 10; k++) { idx.push(k * 10); times[k * 10] = k * 1; }
        times[50] = times[40];               // frame 50 repeats frame 40's stamp
        const r = measureAnchorRate(idx, (f) => times[f], CADENCE);
        expect(r.inconsistent).toBe(false);
        expect(r.realDt).toBeCloseTo(0.1, 6);
        expect(r.epochAnchor).toBeGreaterThanOrEqual(0);
    });

    test("a stall-heavy clock is still rejected", () => {
        // The same rule in the other direction: when stalls are most of what
        // the clock produced, one surviving interval is not a measurement.
        const idx = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
        const times = {0: 0, 10: 1};
        for (const f of [20, 30, 40, 50, 60, 70, 80, 90]) times[f] = 1;
        const r = measureAnchorRate(idx, (f) => times[f], CADENCE);
        expect(r.inconsistent).toBe(true);
    });

    test("fewer than two anchors yields nothing, without throwing", () => {
        expect(measureAnchorRate([], () => 0, CADENCE).realDt).toBeNaN();
        expect(measureAnchorRate([5], () => 0, CADENCE).realDt).toBeNaN();
    });

    test("many anchors do not blow the argument limit", () => {
        // minOf over the surviving pairs. Math.min(...) throws past ~125k on
        // this runtime, so the count has to clear that with margin — an
        // earlier version of this test used 80k and would have passed with the
        // spread call still in place.
        const idx = [], times = {};
        for (let k = 0; k <= 200000; k++) { idx.push(k); times[k] = k * 0.1; }
        const r = measureAnchorRate(idx, (f) => times[f], CADENCE);
        expect(r.realDt).toBeCloseTo(0.1, 6);
        expect(r.epochAnchor).toBe(0);
    });
});

describe("timingStats", () => {
    test("reports jitter and counts dropouts", () => {
        const t = [0, 0.1, 0.2, 0.9, 1.0];
        const s = timingStats(t);
        expect(s.gaps).toBe(1);
        expect(s.cv).toBeGreaterThan(0);
    });
});
