// ChartStats.js — the statistics behind the BOT Bench result charts.
//
// Pure functions over plain arrays. NOTHING here imports a charting library or
// touches the DOM, so the same code runs in the browser module, in the Node
// command-line renderer, and under Jest.
//
// These reproduce private/probes/RockV3Charts.py, which stays as the reference
// implementation. Two conventions are load-bearing and easy to get wrong:
//
//   * QUANTILES MATCH NUMPY. numpy.percentile's default "linear" method puts the
//     p-th quantile at index (n-1)*p/100 and interpolates linearly between the
//     two neighbouring order statistics. A median from it is the mean of the two
//     middle values for an even count. Several other definitions are in common
//     use and none of them agrees with numpy on small samples, so a chart drawn
//     with the wrong one silently disagrees with the Python figures.
//
//   * BOX STATISTICS DEFAULT TO RAW-VALUE QUARTILES AND A RAW-VALUE FENCE.
//     The chart UI can vary the central interval and fence multiplier, and can
//     switch a logarithmic chart to a log-space fence for a visually symmetric
//     comparison. Raw-value fences match Matplotlib, Plotly and base R when a
//     logarithmic axis is used only as the drawing transform.

// ---------------------------------------------------------------------------
// order statistics
// ---------------------------------------------------------------------------

/** Finite numbers only, ascending. Rejects NaN, Infinity, null and booleans. */
export function finiteSorted(values) {
    const out = [];
    for (const v of values) {
        if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    }
    return out.sort((a, b) => a - b);
}

/**
 * The p-th quantile (p in 0..1) of an ALREADY SORTED array, numpy's linear
 * method. Returns null for an empty array.
 */
export function quantileSorted(sorted, p) {
    const n = sorted.length;
    if (n === 0) return null;
    if (n === 1) return sorted[0];
    const pos = (n - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Convenience: quantile of an unsorted array of mixed values. */
export function quantile(values, p) {
    return quantileSorted(finiteSorted(values), p);
}

/** Median, numpy's definition: the mean of the two middle values for even n. */
export function median(values) {
    return quantile(values, 0.5);
}

// ---------------------------------------------------------------------------
// box statistics
// ---------------------------------------------------------------------------

/**
 * The whisker on each side ends at the most extreme observation between that
 * box edge and its mathematical fence. If interpolation leaves no observation
 * in that interval, the whisker stays at the box edge, as Matplotlib does. This
 * also guarantees the precomputed values satisfy Plotly's lower <= Q1 and
 * upper >= Q3 requirements.
 */
function whiskersInside(sorted, q1, q3, lowerLimit, upperLimit) {
    const lower = sorted.filter((v) => v >= lowerLimit && v <= q1);
    const upper = sorted.filter((v) => v >= q3 && v <= upperLimit);
    const lowerFence = lower.length ? lower[0] : q1;
    const upperFence = upper.length ? upper[upper.length - 1] : q3;
    return {
        lowerFence,
        upperFence,
        nOutside: sorted.filter((v) => v < lowerFence || v > upperFence).length,
    };
}

/**
 * A centered raw-value percentile box and median; whiskers at the last value
 * inside a configurable fence. Defaults to quartiles and Tukey's 1.5*IQR fence
 * computed on the raw values. `whiskerSpace: "axis"` instead computes the fence
 * on log10 for a visually symmetric comparison on a logarithmic axis.
 *
 * With the optional axis-space fence, values at or below zero cannot be logged,
 * so they are held back from that fence calculation and reported in
 * `nonPositive`. The raw-value default and the quartiles see every value.
 *
 * @returns {null | {q1, median, q3, lowerFence, upperFence, n, nOutside, nonPositive, min, max}}
 *          lowerFence/upperFence are the extreme values still INSIDE the fence,
 *          which is what a whisker is drawn to (never the fence line itself).
 */
export function boxStatsLog(values, {boxPercent = 50, whiskerK = 1.5, whiskerSpace = "raw"} = {}) {
    const sorted = finiteSorted(values);
    if (sorted.length === 0) return null;
    const central = Number.isFinite(boxPercent) ? Math.min(99, Math.max(1, boxPercent)) / 100 : 0.5;
    const k = Number.isFinite(whiskerK) ? Math.max(0, whiskerK) : 1.5;
    const tail = (1 - central) / 2;
    const q1 = quantileSorted(sorted, tail);
    const med = quantileSorted(sorted, 0.5);
    const q3 = quantileSorted(sorted, 1 - tail);

    if (whiskerSpace === "raw") {
        const span = q3 - q1;
        const whiskers = whiskersInside(sorted, q1, q3, q1 - k * span, q3 + k * span);
        return {q1, median: med, q3, ...whiskers,
            n: sorted.length,
            nonPositive: sorted.filter((v) => v <= 0).length, min: sorted[0], max: sorted[sorted.length - 1]};
    }

    const positive = sorted.filter((v) => v > 0);
    const nonPositive = sorted.length - positive.length;
    if (positive.length === 0) {
        return {q1, median: med, q3, lowerFence: sorted[0], upperFence: sorted[sorted.length - 1],
            n: sorted.length, nOutside: 0, nonPositive, min: sorted[0], max: sorted[sorted.length - 1]};
    }
    const logs = positive.map(Math.log10);
    const lq1 = quantileSorted(logs, tail);
    const lq3 = quantileSorted(logs, 1 - tail);
    const iqr = lq3 - lq1;
    const loFence = lq1 - k * iqr;
    const hiFence = lq3 + k * iqr;
    const whiskers = whiskersInside(positive, q1, q3, 10 ** loFence, 10 ** hiFence);
    return {
        q1, median: med, q3,
        lowerFence: whiskers.lowerFence,
        upperFence: whiskers.upperFence,
        n: sorted.length,
        nOutside: whiskers.nOutside,
        nonPositive,
        min: sorted[0],
        max: sorted[sorted.length - 1],
    };
}

/** The same on raw values, used by a linear axis and optional on a log axis. */
export function boxStatsLinear(values, {boxPercent = 50, whiskerK = 1.5} = {}) {
    const sorted = finiteSorted(values);
    if (sorted.length === 0) return null;
    const central = Number.isFinite(boxPercent) ? Math.min(99, Math.max(1, boxPercent)) / 100 : 0.5;
    const k = Number.isFinite(whiskerK) ? Math.max(0, whiskerK) : 1.5;
    const tail = (1 - central) / 2;
    const q1 = quantileSorted(sorted, tail);
    const med = quantileSorted(sorted, 0.5);
    const q3 = quantileSorted(sorted, 1 - tail);
    const iqr = q3 - q1;
    const whiskers = whiskersInside(sorted, q1, q3, q1 - k * iqr, q3 + k * iqr);
    return {q1, median: med, q3, ...whiskers,
        n: sorted.length, nonPositive: 0,
        min: sorted[0], max: sorted[sorted.length - 1]};
}

// ---------------------------------------------------------------------------
// binomial confidence intervals
// ---------------------------------------------------------------------------
//
// The Python reference uses scipy's beta.ppf for Clopper-Pearson. There is no
// scipy here, so the regularized incomplete beta function and its inverse are
// implemented below: the continued fraction from Numerical Recipes for the
// forward function, and bisection for the inverse. Bisection rather than
// Newton because it cannot diverge, and 200 halvings of [0,1] is far below
// double precision anyway — the cost is nothing at the handful of calls a
// chart makes.

const LOG_GAMMA_COF = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
];

/** log(Gamma(x)) for x > 0, Lanczos approximation. */
export function logGamma(x) {
    let y = x;
    let tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += LOG_GAMMA_COF[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
}

/** Continued fraction for the incomplete beta, evaluated by Lentz's method. */
function betaContinuedFraction(a, b, x) {
    const FPMIN = 1e-300, EPS = 3e-16, MAXIT = 300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1;
    let d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
        const m2 = 2 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c;
        if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        h *= d * c;
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c;
        if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < EPS) break;
    }
    return h;
}

/** The regularized incomplete beta function I_x(a, b), i.e. the beta CDF. */
export function betaCdf(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b)
        + a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return front * betaContinuedFraction(a, b, x) / a;
    return 1 - Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b)
        + b * Math.log(1 - x) + a * Math.log(x)) * betaContinuedFraction(b, a, 1 - x) / b;
}

/** Inverse beta CDF: the x with betaCdf(x, a, b) === p. Bisection, 200 steps. */
export function betaInv(p, a, b) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let lo = 0, hi = 1;
    for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        if (betaCdf(mid, a, b) < p) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

/**
 * Exact (Clopper-Pearson) confidence interval for k successes in n trials.
 * Conservative by construction: its true coverage is at least `level`.
 *
 * @returns {{lo: number, hi: number, p: number}} all in 0..1; NaN when n is 0.
 */
export function clopperPearson(k, n, level = 0.95) {
    if (!(n > 0)) return {lo: NaN, hi: NaN, p: NaN};
    const alpha = 1 - level;
    const lo = k === 0 ? 0 : betaInv(alpha / 2, k, n - k + 1);
    const hi = k === n ? 1 : betaInv(1 - alpha / 2, k + 1, n - k);
    return {lo, hi, p: k / n};
}

/** Wilson score interval, for comparison and for very large n. */
export function wilson(k, n, level = 0.95) {
    if (!(n > 0)) return {lo: NaN, hi: NaN, p: NaN};
    const z = level === 0.95 ? 1.959963984540054 : Math.SQRT2 * inverseErf(level);
    const p = k / n;
    const d = 1 + z * z / n;
    const centre = p + z * z / (2 * n);
    const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return {lo: (centre - half) / d, hi: (centre + half) / d, p};
}

/** Inverse error function, Giles' rational approximation. Used only by wilson(). */
function inverseErf(x) {
    const w = -Math.log((1 - x) * (1 + x));
    if (w < 5) {
        const v = w - 2.5;
        let p = 2.81022636e-08;
        for (const c of [3.43273939e-07, -3.5233877e-06, -4.39150654e-06, 0.00021858087,
            -0.00125372503, -0.00417768164, 0.246640727, 1.50140941]) p = p * v + c;
        return p * x;
    }
    const v = Math.sqrt(w) - 3;
    let p = -0.000200214257;
    for (const c of [0.000100950558, 0.00134934322, -0.00367342844, 0.00573950773,
        -0.0076224613, 0.00943887047, 1.00167406, 2.83297682]) p = p * v + c;
    return p * x;
}

// ---------------------------------------------------------------------------
// aggregation helpers
// ---------------------------------------------------------------------------

/**
 * Median of y over EQUAL-COUNT bins of x, so every point on the trend line
 * rests on the same number of observations whatever the density along x.
 * Equal-width bins would put one point on four hundred tracks and the next on
 * three, and the eye reads them as equally reliable.
 *
 * @returns {Array<{x: number, y: number, n: number}>}
 */
export function equalCountMedians(xs, ys, {bins = 8, minPerBin = 5} = {}) {
    const pairs = [];
    for (let i = 0; i < xs.length; i++) {
        if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pairs.push([xs[i], ys[i]]);
    }
    if (pairs.length < minPerBin) return [];
    pairs.sort((a, b) => a[0] - b[0]);
    const count = Math.max(1, Math.min(bins, Math.floor(pairs.length / (minPerBin * 2)) || 1));
    const out = [];
    for (let b = 0; b < count; b++) {
        const from = Math.floor(b * pairs.length / count);
        const to = Math.floor((b + 1) * pairs.length / count);
        if (to - from < minPerBin) continue;
        const slice = pairs.slice(from, to);
        out.push({
            x: median(slice.map((pair) => pair[0])),
            y: median(slice.map((pair) => pair[1])),
            n: slice.length,
        });
    }
    return out;
}

/** Counts per distinct value of `key`, most common first. */
export function tally(rows, key) {
    const counts = new Map();
    for (const row of rows) {
        const value = row?.[key] ?? null;
        const name = value === null || value === undefined ? "null" : String(value);
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({name, n}));
}

/**
 * Reproducible jitter offsets in [-amount, +amount].
 *
 * Seeded on purpose: a chart redrawn on a filter change must not reshuffle its
 * dots, or the reader sees movement that means nothing. Same generator as the
 * Python reference in spirit, not in bits, so the two figures scatter their
 * points differently while every statistic matches.
 */
export function jitterOffsets(count, amount = 0.26, seed = 805) {
    let state = seed >>> 0;
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
        // xorshift32: cheap, no dependency, and stable across engines
        state ^= state << 13; state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5; state >>>= 0;
        out[i] = ((state / 4294967296) * 2 - 1) * amount;
    }
    return out;
}

/** Value clamped to a positive floor, for drawing on a log axis. */
export const atLeast = (value, floor) => (Number.isFinite(value) ? Math.max(value, floor) : null);
