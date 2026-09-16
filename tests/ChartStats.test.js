// ChartStats.test.js — pins the JavaScript statistics to the Python reference.
//
// Every expected value in the first three blocks was produced by numpy and
// scipy, by the same calls private/probes/RockV3Charts.py makes, and pasted in
// here. That is the point of the file: the browser charts and the matplotlib
// figures must not disagree about a median or a confidence interval, and the
// only way to be sure is to compare against the library the reference uses.
//
// Generated with:
//   np.percentile(v, [25, 50, 75])
//   beta.ppf(0.025, k, n-k+1) / beta.ppf(0.975, k+1, n-k)

import {
    quantile, median, boxStatsLog, boxStatsLinear, clopperPearson, wilson,
    betaCdf, betaInv, equalCountMedians, tally, jitterOffsets, finiteSorted,
} from "../src/analysis/charts/ChartStats";

const SAMPLES = {
    odd: [3, 1, 2, 5, 4],
    even: [10, 2, 8, 4],
    one: [7.5],
    dupes: [1, 1, 1, 2, 100, 100],
};

// numpy.percentile(v, p), default "linear" method
const NUMPY_QUANTILES = {
    odd: {25: 2.0, 50: 3.0, 75: 4.0},
    even: {25: 3.5, 50: 6.0, 75: 8.5},
    one: {25: 7.5, 50: 7.5, 75: 7.5},
    dupes: {25: 1.0, 50: 1.5, 75: 75.5},
};

// scipy.stats.beta.ppf, 95% Clopper-Pearson
const SCIPY_CLOPPER_PEARSON = {
    "0/100": [0.0, 0.03621669264517641],
    "1/100": [0.00025314603297742064, 0.054459385392080645],
    "47/100": [0.3694051641943945, 0.5724185151099547],
    "72/100": [0.6213329952827327, 0.8052063725088185],
    "99/100": [0.9455406146079194, 0.9997468539670226],
    "100/100": [0.9637833073548235, 1.0],
    "3/7": [0.09898827844250786, 0.8159484323599169],
    "5/10": [0.18708602844739855, 0.8129139715526015],
};

describe("quantiles match numpy", () => {
    for (const [name, values] of Object.entries(SAMPLES)) {
        for (const p of [25, 50, 75]) {
            test(`${name} p${p}`, () => {
                expect(quantile(values, p / 100)).toBeCloseTo(NUMPY_QUANTILES[name][p], 12);
            });
        }
    }
    test("median of an even count is the mean of the two middle values", () => {
        expect(median([1, 2, 3, 4])).toBe(2.5);
    });
    test("empty and all-rubbish inputs give null, not NaN", () => {
        expect(median([])).toBeNull();
        expect(median([NaN, Infinity, null, undefined, "7", true])).toBeNull();
    });
    test("finiteSorted rejects the lookalikes a JSON row can carry", () => {
        expect(finiteSorted([3, "2", null, true, NaN, 1, Infinity])).toEqual([1, 3]);
    });
});

describe("Clopper-Pearson matches scipy", () => {
    for (const [key, [lo, hi]] of Object.entries(SCIPY_CLOPPER_PEARSON)) {
        const [k, n] = key.split("/").map(Number);
        test(`${k} of ${n}`, () => {
            const got = clopperPearson(k, n);
            expect(got.lo).toBeCloseTo(lo, 9);
            expect(got.hi).toBeCloseTo(hi, 9);
            expect(got.p).toBeCloseTo(k / n, 12);
        });
    }
    test("n of zero gives NaN rather than dividing by zero", () => {
        const got = clopperPearson(0, 0);
        expect(Number.isNaN(got.lo)).toBe(true);
        expect(Number.isNaN(got.p)).toBe(true);
    });
    test("the interval always contains the point estimate", () => {
        for (let n = 1; n <= 40; n += 7) {
            for (let k = 0; k <= n; k++) {
                const {lo, hi, p} = clopperPearson(k, n);
                expect(lo).toBeLessThanOrEqual(p + 1e-12);
                expect(hi).toBeGreaterThanOrEqual(p - 1e-12);
            }
        }
    });
    test("Clopper-Pearson is wider than Wilson, which is what conservative means", () => {
        for (const [k, n] of [[5, 20], [10, 40], [1, 15]]) {
            const exact = clopperPearson(k, n);
            const score = wilson(k, n);
            expect(exact.hi - exact.lo).toBeGreaterThan(score.hi - score.lo);
        }
    });
});

describe("the incomplete beta function", () => {
    test("betaCdf and betaInv are inverses", () => {
        for (const [a, b] of [[2, 5], [0.5, 0.5], [40, 61], [1, 1]]) {
            for (const p of [0.025, 0.5, 0.975]) {
                expect(betaCdf(betaInv(p, a, b), a, b)).toBeCloseTo(p, 9);
            }
        }
    });
    test("betaCdf(x, 1, 1) is x, the uniform case", () => {
        for (const x of [0.1, 0.35, 0.9]) expect(betaCdf(x, 1, 1)).toBeCloseTo(x, 12);
    });
    test("the ends are pinned", () => {
        expect(betaCdf(0, 3, 4)).toBe(0);
        expect(betaCdf(1, 3, 4)).toBe(1);
    });
});

describe("box statistics", () => {
    // Same input and same rule as the matplotlib reference.
    const INPUT = [0.001, 0.002, 0.004, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 40.0];
    test("quartiles on raw values, fence in log space when requested", () => {
        const box = boxStatsLog(INPUT, {whiskerSpace: "axis"});
        expect(box.q1).toBeCloseTo(0.007, 12);
        expect(box.median).toBeCloseTo(0.05, 12);
        expect(box.q3).toBeCloseTo(0.35, 12);
        expect(box.lowerFence).toBeCloseTo(0.001, 12);
        expect(box.upperFence).toBeCloseTo(40.0, 12);
        expect(box.nOutside).toBe(0);
        expect(box.n).toBe(11);
    });
    test("the log fence keeps a value a linear fence would throw out", () => {
        // 40 is 40x the upper quartile: on a raw 1.5*IQR fence it is an outlier,
        // on a log fence it is not. That difference is the reason for the rule.
        expect(boxStatsLog(INPUT, {whiskerSpace: "axis"}).nOutside).toBe(0);
        expect(boxStatsLinear(INPUT).nOutside).toBeGreaterThan(0);
    });
    test("a log chart defaults to the raw-value fence used by standard plotting packages", () => {
        const raw = boxStatsLog(INPUT);
        const linear = boxStatsLinear(INPUT);
        expect(raw).toMatchObject({q1: linear.q1, median: linear.median, q3: linear.q3,
            lowerFence: linear.lowerFence, upperFence: linear.upperFence, nOutside: linear.nOutside});
        expect(raw.upperFence).toBeLessThan(40);
    });
    test("the central percentage and whisker multiplier are configurable", () => {
        const wide = boxStatsLinear(INPUT, {boxPercent: 80, whiskerK: 0});
        expect(wide.q1).toBeCloseTo(0.002, 12);
        expect(wide.q3).toBeCloseTo(1, 12);
        expect(wide.lowerFence).toBeGreaterThanOrEqual(wide.q1);
        expect(wide.upperFence).toBeLessThanOrEqual(wide.q3);
        expect(boxStatsLinear(INPUT, {boxPercent: 80, whiskerK: 3}).lowerFence).toBeLessThan(wide.lowerFence);
    });
    test("an empty side of a narrow fence ends at the interpolated box edge", () => {
        const box = boxStatsLinear([1, 2, 3, 4], {whiskerK: 0});
        expect(box).toMatchObject({q1: 1.75, lowerFence: 1.75, q3: 3.25, upperFence: 3.25});
    });
    test("zero and negative values are kept out of the fence but counted", () => {
        const box = boxStatsLog([0, -1, 0.01, 0.02, 0.03, 0.04], {whiskerSpace: "axis"});
        expect(box.nonPositive).toBe(2);
        expect(box.n).toBe(6);
        expect(box.lowerFence).toBeGreaterThan(0);
    });
    test("all non-positive still returns a box rather than throwing", () => {
        const box = boxStatsLog([0, -1, -2]);
        expect(box.n).toBe(3);
        expect(box.nonPositive).toBe(3);
    });
    test("empty gives null", () => {
        expect(boxStatsLog([])).toBeNull();
        expect(boxStatsLinear([])).toBeNull();
    });
});

describe("equal-count medians", () => {
    test("every bin holds the same count, give or take one", () => {
        const xs = Array.from({length: 100}, (unused, i) => i + 1);
        const ys = xs.map((x) => x * 2);
        const bins = equalCountMedians(xs, ys, {bins: 5, minPerBin: 5});
        expect(bins.length).toBe(5);
        for (const bin of bins) expect(bin.n).toBe(20);
        // y = 2x, so each bin's medians must satisfy it
        for (const bin of bins) expect(bin.y).toBeCloseTo(bin.x * 2, 9);
    });
    test("bins are dropped rather than drawn on too few points", () => {
        expect(equalCountMedians([1, 2, 3], [1, 2, 3], {bins: 8, minPerBin: 5})).toEqual([]);
    });
    test("non-finite pairs are skipped", () => {
        const xs = [1, 2, NaN, 4, 5, 6, 7, 8, 9, 10];
        const ys = [1, 2, 3, null, 5, 6, 7, 8, 9, 10];
        const bins = equalCountMedians(xs, ys, {bins: 2, minPerBin: 2});
        expect(bins.reduce((sum, bin) => sum + bin.n, 0)).toBe(8);
    });
});

describe("tally and jitter", () => {
    test("tally counts and sorts by frequency", () => {
        const rows = [{v: "a"}, {v: "b"}, {v: "a"}, {v: null}, {v: "a"}, {v: "b"}];
        expect(tally(rows, "v")).toEqual([
            {name: "a", n: 3}, {name: "b", n: 2}, {name: "null", n: 1},
        ]);
    });
    test("jitter is reproducible, bounded and centred", () => {
        const a = jitterOffsets(500, 0.26, 805);
        const b = jitterOffsets(500, 0.26, 805);
        expect(a).toEqual(b);
        expect(jitterOffsets(500, 0.26, 806)).not.toEqual(a);
        for (const v of a) expect(Math.abs(v)).toBeLessThanOrEqual(0.26);
        const mean = a.reduce((sum, v) => sum + v, 0) / a.length;
        expect(Math.abs(mean)).toBeLessThan(0.03);
    });
});
