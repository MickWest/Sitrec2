/**
 * Throughput of `traversePlausible`, the innermost solver of the traverse
 * analysis. Excluded from the default test run; invoke with:
 *
 *     npx jest benchmarks/traversePlausible.bench.test.js \
 *       --testPathIgnorePatterns /node_modules/ --forceExit
 *
 * The sweep calls this once per (range, speed) grid cell — 44 ranges x N speeds
 * per analysis — so its per-call cost sets the wall time of the whole battery,
 * and a 15-minute analysis is itself a barrier to reaching a confident verdict.
 * Read the numbers as RATIOS between runs on one machine; Babel makes the
 * absolute values meaningless compared with the shipped bundle.
 *
 * Correctness of any change here is pinned separately and much more strictly by
 * tests/TraversePlausibleIdentity.test.js, which hashes the raw float64 output.
 */

import {traversePlausible} from "../src/TraverseAnalysis";

const KNOTS = 0.514444;

function makeDataset(n, fps = 30) {
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

describe("traversePlausible throughput", () => {
    jest.setTimeout(300000);

    test("times a representative sweep workload", () => {
        // A sweep cell as sweepConstAirSpeed actually calls it.
        const CELLS = 220;             // ~ a 44-range x 5-speed slice
        for (const n of [600, 2400]) {
            const ds = makeDataset(n);
            const opts = {K: 25, iters: 3, minDist: 120, rangeFloor: true,
                vTarget: 60 * KNOTS, vSigma: 40 * KNOTS};
            // warm up the JIT so the first cells don't dominate
            for (let i = 0; i < 10; i++) traversePlausible(ds, 3000 + i, opts);

            const t0 = Date.now();
            for (let i = 0; i < CELLS; i++) traversePlausible(ds, 3000 + i * 7, opts);
            const ms = Date.now() - t0;
            console.log(`  n=${String(n).padStart(5)} frames   ${CELLS} cells   `
                + `${String(ms).padStart(6)} ms total   ${(ms / CELLS).toFixed(2)} ms/cell`);
            expect(ms).toBeGreaterThan(0);
        }
    });
});
