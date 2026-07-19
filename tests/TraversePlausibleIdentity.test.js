/**
 * Bit-identity guard for `traversePlausible`.
 *
 * That function is the innermost solver of the traverse analysis — the constant
 * air-speed sweep calls it once per (range, speed) grid cell, so it runs tens of
 * thousands of times per analysis and is the dominant cost. It is therefore a
 * standing target for optimization, and optimizations there are exactly the kind
 * that "look" safe while quietly moving results: this is an iteratively
 * reweighted least-squares solve, so reordering a floating-point accumulation
 * can change the last bits, which changes the reweighting, which can converge
 * somewhere else. A score surface that shifts silently would re-tune the
 * slow-vs-fast regime gate that reads it.
 *
 * These hashes were captured from the implementation before the allocation
 * rework and must not change for a PERFORMANCE change. If one of these fails,
 * the change altered the numbers, not just the speed — that may still be
 * desirable, but it is a science change and has to be argued and re-validated
 * against both testbeds, not landed as an optimization.
 *
 * The cases deliberately span the option-gated branches (range floor, strided
 * acceleration, speed prior, output smoothing) because they take different
 * paths through the row assembly.
 */

import {traversePlausible} from "../src/TraverseAnalysis";

const KNOTS = 0.514444;

function makeDataset(n = 240, fps = 30) {
    const S = new Float64Array(n * 3), D = new Float64Array(n * 3), W = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        const sx = -4000 + 90 * t, sy = -2500 + 12 * t, sz = 2200 + 3 * t;
        S[f * 3] = sx; S[f * 3 + 1] = sy; S[f * 3 + 2] = sz;
        const tx = 800 + 40 * t + 300 * Math.sin(t / 5);
        const ty = 600 + 18 * t;
        const tz = 3000 + 9 * t + 120 * Math.sin(t / 7);
        let dx = tx - sx, dy = ty - sy, dz = tz - sz;
        const L = Math.hypot(dx, dy, dz);
        D[f * 3] = dx / L; D[f * 3 + 1] = dy / L; D[f * 3 + 2] = dz / L;
        W[f * 3] = 2.5; W[f * 3 + 1] = -1.5; W[f * 3 + 2] = 0;
    }
    return {n, fps, S, D, W};
}

// FNV-1a over the raw float64 bytes: sensitive to a single changed bit,
// unlike a tolerance comparison.
function hashFloats(arr) {
    let h = 0x811c9dc5;
    const bytes = new Uint8Array(Float64Array.from(arr).buffer);
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
}

const CASES = [
    {label: "default sweep cell", opts: {K: 25, iters: 3, minDist: 120}},
    {label: "with range floor", opts: {K: 25, iters: 3, minDist: 120, rangeFloor: true}},
    {label: "slow speed prior", opts: {K: 25, iters: 6, vTarget: 5 * KNOTS, vSigma: 20 * KNOTS}},
    {label: "strided acceleration", opts: {K: 18, iters: 4, accelStride: 3, rangeFloor: true}},
    {label: "smoothed output", opts: {K: 25, iters: 3, smoothOutput: true, smoothSpacingSec: 2}},
];

describe("traversePlausible is bit-stable across refactors", () => {
    const dataset = makeDataset();

    test.each(CASES)("$label", ({opts}) => {
        const r = traversePlausible(dataset, 4200, opts);
        expect(r).toBeTruthy();
        expect(Number.isFinite(r.lam[0])).toBe(true);
        // Snapshot both the ray ranges and the resulting track.
        expect({lam: hashFloats(r.lam), track: hashFloats(r.track)}).toMatchSnapshot();
    });

    test("the solver actually engages (a flat result would make the hashes vacuous)", () => {
        // Guards the guard: if traversePlausible degenerated to "return the
        // anchor range at every frame", the hashes above would still be stable
        // and would pin nothing at all.
        const r = traversePlausible(dataset, 4200, {K: 25, iters: 3, minDist: 120});
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < r.lam.length; i++) {
            if (r.lam[i] < min) min = r.lam[i];
            if (r.lam[i] > max) max = r.lam[i];
        }
        expect(max - min).toBeGreaterThan(1);   // the ranges genuinely vary
    });
});
