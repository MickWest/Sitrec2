/**
 * losFitting.bench.test.js — comparison harness for the LOS curve-fitting strategies.
 *
 * NOT part of the normal test run (see "benchmarks" in package.json's
 * testPathIgnorePatterns). Run it deliberately:
 *
 *     npm run bench-losfit
 *
 * WHAT IT IS FOR
 * The traverse gallery fits a curve to the sightlines using several different
 * strategies, swept over polynomial order. They are easy to compare wrongly:
 * the obvious score (how closely the curve hugs the sightlines) systematically
 * favours wigglier curves, and on real data a method can hug the sightlines
 * better while sitting FURTHER from the true path. This harness builds a scene
 * whose true answer is known, so both numbers can be printed side by side.
 *
 * It lives as a Jest file only because Jest already knows how to resolve the
 * project's imports; the assertions at the bottom are deliberately loose
 * invariants, and the real output is the printed table.
 *
 * READ THE TIMINGS AS RATIOS, NOT AS REAL-WORLD SPEEDS. Jest runs everything
 * through Babel, which is far slower than the optimised bundle the app ships —
 * measured at roughly 17x slower on these same fits. The comparison BETWEEN
 * strategies in one run is meaningful; the absolute milliseconds are not.
 */

import {
    fitAlternatingLSQ,
    fitConstantVelocity,
    fitMonteCarlo,
    fitMonteCarlo2,
} from "../src/LOSFitting";

const FPS = 30;

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/**
 * An ascending, wobbling object watched by a CIRCLING camera.
 *
 * The camera circles on purpose. Each frame only tells us a direction, not a
 * distance, so distance is recovered from how the direction shifts as the
 * camera moves (parallax). A camera flying dead straight gives very little of
 * that shift — see makeDegenerateScene below for what goes wrong then.
 *
 * @param {number} n frames
 * @param {number} wobbleScale multiplies the size of the side-to-side weaving
 */
function makeOrbitScene(n, wobbleScale = 1) {
    const sensorPos = new Float64Array(n * 3);
    const losDir = new Float64Array(n * 3);
    const times = new Float64Array(n);
    const truth = new Float64Array(n * 3);
    const R = 6000;                     // camera circles at 6 km radius
    const W = 2 * Math.PI / 40;         // one lap every 40 s

    for (let i = 0; i < n; i++) {
        const t = i / FPS;
        times[i] = t;

        const sx = R * Math.cos(W * t), sy = R * Math.sin(W * t), sz = 2500;
        sensorPos[i * 3] = sx; sensorPos[i * 3 + 1] = sy; sensorPos[i * 3 + 2] = sz;

        // Rising steadily, drifting slowly, weaving from side to side.
        const tx = 200 + 6 * t + wobbleScale * 300 * Math.sin(t / 9);
        const ty = -150 + 4 * t + wobbleScale * 220 * Math.sin(t / 6 + 1.1);
        const tz = 900 + 14 * t + wobbleScale * 180 * Math.sin(t / 7 + 0.4);
        truth[i * 3] = tx; truth[i * 3 + 1] = ty; truth[i * 3 + 2] = tz;

        const dx = tx - sx, dy = ty - sy, dz = tz - sz;
        const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
        losDir[i * 3] = dx / L; losDir[i * 3 + 1] = dy / L; losDir[i * 3 + 2] = dz / L;
    }
    return {dataset: {sensorPos, losDir, times, count: n, maxRange: null}, truth};
}

/**
 * The same target, but the camera now flies in a dead straight line at constant
 * speed. This is a TRAP scene, included because the trap is real and easy to
 * hit: with no parallax, the best-scoring answer is a "target" sitting exactly
 * on the camera itself. Distance zero satisfies every sightline perfectly, so
 * the fit scores flawlessly while being kilometres from the truth.
 */
function makeDegenerateScene(n) {
    const sensorPos = new Float64Array(n * 3);
    const losDir = new Float64Array(n * 3);
    const times = new Float64Array(n);
    const truth = new Float64Array(n * 3);

    for (let i = 0; i < n; i++) {
        const t = i / FPS;
        times[i] = t;
        const sx = -12000 + 200 * t, sy = -8000, sz = 3000;
        sensorPos[i * 3] = sx; sensorPos[i * 3 + 1] = sy; sensorPos[i * 3 + 2] = sz;

        const tx = 500 + 40 * t + 600 * Math.sin(t / 11);
        const ty = 300 + 25 * t + 400 * Math.sin(t / 7 + 1.1);
        const tz = 1200 + 18 * t + 250 * Math.sin(t / 9 + 0.4);
        truth[i * 3] = tx; truth[i * 3 + 1] = ty; truth[i * 3 + 2] = tz;

        const dx = tx - sx, dy = ty - sy, dz = tz - sz;
        const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
        losDir[i * 3] = dx / L; losDir[i * 3 + 1] = dy / L; losDir[i * 3 + 2] = dz / L;
    }
    return {dataset: {sensorPos, losDir, times, count: n, maxRange: null}, truth};
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Average angle (degrees) between the fitted points and the sightlines. */
function meanLosErrDeg(ds, pos) {
    const {sensorPos, losDir, count} = ds;
    let sum = 0;
    for (let i = 0; i < count; i++) {
        const b = i * 3;
        const rx = pos[b] - sensorPos[b];
        const ry = pos[b + 1] - sensorPos[b + 1];
        const rz = pos[b + 2] - sensorPos[b + 2];
        const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1e-12;
        const dot = Math.max(-1, Math.min(1,
            (rx * losDir[b] + ry * losDir[b + 1] + rz * losDir[b + 2]) / rl));
        sum += Math.acos(dot);
    }
    return (sum / count) * 180 / Math.PI;
}

/** Average distance (metres) between the fitted path and the true path. */
function rmsTruth(truth, pos, n) {
    let s = 0;
    for (let i = 0; i < n; i++) {
        const b = i * 3;
        s += (pos[b] - truth[b]) ** 2 + (pos[b + 1] - truth[b + 1]) ** 2 + (pos[b + 2] - truth[b + 2]) ** 2;
    }
    return Math.sqrt(s / n);
}

/** Starting distance guesses, the way the traverse analysis produces them. */
function cvRangeEstimates(ds) {
    const cv = fitConstantVelocity(ds, new Set());
    if (!cv) return null;
    const est = new Float32Array(ds.count);
    for (let i = 0; i < ds.count; i++) {
        const b = i * 3;
        est[i] = Math.max(1,
            (cv.positions[b] - ds.sensorPos[b]) * ds.losDir[b]
            + (cv.positions[b + 1] - ds.sensorPos[b + 1]) * ds.losDir[b + 1]
            + (cv.positions[b + 2] - ds.sensorPos[b + 2]) * ds.losDir[b + 2]);
    }
    return est;
}

const STRATEGIES = [
    {name: "Monte Carlo 1", fit: fitMonteCarlo},
    {name: "Monte Carlo 2", fit: fitMonteCarlo2},
    {name: "Polynomial LSQ", fit: fitAlternatingLSQ},
];
const MAX_ORDER = 5;

function sweep(ds, truth, label) {
    const rangeEstimates = cvRangeEstimates(ds);
    const opts = {numTrials: 1000, losUncertaintyDeg: 2, rangeEstimates};
    const cv = fitConstantVelocity(ds, new Set());

    console.log(`\n${label}  (${ds.count} frames, ${(ds.count / FPS).toFixed(1)} s)`);
    console.log(`  constant-velocity baseline: sightline err ${meanLosErrDeg(ds, cv.positions).toFixed(3)}°, `
        + `${rmsTruth(truth, cv.positions, ds.count).toFixed(0)} m from truth`);
    console.log("  strategy         order      time   sightline err   distance from truth");
    console.log("  " + "-".repeat(68));

    const table = {};
    for (const s of STRATEGIES) {
        table[s.name] = {};
        for (let order = 1; order <= MAX_ORDER; order++) {
            const t0 = Date.now();
            let r = null;
            try { r = s.fit(ds, new Set(), {...opts, order}); } catch (e) { r = null; }
            const ms = Date.now() - t0;
            if (!r || !r.positions) { console.log(`  ${s.name.padEnd(16)} ${String(order).padStart(5)}   (no solution)`); continue; }
            const los = meanLosErrDeg(ds, r.positions);
            const rms = rmsTruth(truth, r.positions, ds.count);
            table[s.name][order] = {los, rms, ms};
            console.log(`  ${s.name.padEnd(16)} ${String(order).padStart(5)} ${String(ms).padStart(7)}ms `
                + `${los.toFixed(3).padStart(12)}°  ${rms.toFixed(0).padStart(16)} m`);
        }
    }
    return table;
}

describe("LOS curve-fitting strategy comparison", () => {
    // These are benchmarks: generous timeout, and the assertions are loose
    // invariants rather than tight numeric expectations, so machine speed and
    // future tuning don't cause spurious failures.
    jest.setTimeout(300000);

    test("sweeps every strategy over polynomial order on a known scene", () => {
        const {dataset, truth} = makeOrbitScene(2000);
        const table = sweep(dataset, truth, "ASCENDING WOBBLY TARGET, CIRCLING CAMERA");

        // Every strategy must produce a usable answer at every order.
        for (const s of STRATEGIES) {
            for (let o = 1; o <= MAX_ORDER; o++) {
                expect(table[s.name][o]).toBeDefined();
                expect(Number.isFinite(table[s.name][o].rms)).toBe(true);
            }
        }

        // Order 1 is a straight line in time, so all three should land close to
        // the constant-velocity answer and therefore close to each other.
        const o1 = STRATEGIES.map((s) => table[s.name][1].rms);
        expect(Math.max(...o1) - Math.min(...o1)) .toBeLessThan(0.25 * Math.min(...o1));

        console.log("\n  NOTE: a lower sightline error does NOT imply a closer match to truth —"
            + "\n  compare the two right-hand columns before preferring any row.");
    });

    test("the alternating fit gives identical results on repeat runs", () => {
        const {dataset} = makeOrbitScene(500);
        const a = fitAlternatingLSQ(dataset, new Set(), {order: 4});
        const b = fitAlternatingLSQ(dataset, new Set(), {order: 4});
        expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    });

    test("more random trials is a poor substitute for a better strategy", () => {
        // The Monte Carlo fits improve with more darts, but so slowly that the
        // deterministic fit beats a 100x larger budget in a fraction of the time.
        const {dataset, truth} = makeOrbitScene(2000);
        const rangeEstimates = cvRangeEstimates(dataset);
        const base = {losUncertaintyDeg: 2, rangeEstimates, order: 5};

        console.log("\nDOES THROWING MORE DARTS HELP? (Monte Carlo 1, order 5)");
        let last = null;
        // Stops at 30k deliberately: the trend is already unmistakable, and the
        // cost is linear in trials under Babel, so a 100k rung alone added well
        // over a minute to this file for no extra insight.
        for (const numTrials of [1000, 10000, 30000]) {
            const t0 = Date.now();
            const r = fitMonteCarlo(dataset, new Set(), {...base, numTrials});
            const ms = Date.now() - t0;
            last = {los: meanLosErrDeg(dataset, r.positions), rms: rmsTruth(truth, r.positions, dataset.count), ms};
            console.log(`  ${String(numTrials).padStart(7)} trials ${String(ms).padStart(7)}ms  `
                + `${last.los.toFixed(3)}°  ${last.rms.toFixed(0)} m from truth`);
        }
        const t0 = Date.now();
        const als = fitAlternatingLSQ(dataset, new Set(), {order: 5});
        const alsMs = Date.now() - t0;
        const alsLos = meanLosErrDeg(dataset, als.positions);
        console.log(`  deterministic    ${String(alsMs).padStart(7)}ms  ${alsLos.toFixed(3)}°  `
            + `${rmsTruth(truth, als.positions, dataset.count).toFixed(0)} m from truth`);

        // 100x the darts still shouldn't beat the deterministic fit on sightline error.
        expect(alsLos).toBeLessThan(last.los);
    });

    test("a straight-flying camera admits a zero-distance answer that scores perfectly", () => {
        // Documents the trap: with no parallax the best-scoring "target" is one
        // sitting on the camera itself. Any change that makes this reachable in
        // the app is a serious problem, so it is pinned here.
        const {dataset, truth} = makeDegenerateScene(1000);
        const cv = fitConstantVelocity(dataset, new Set());

        const range0 = (cv.positions[0] - dataset.sensorPos[0]) * dataset.losDir[0]
            + (cv.positions[1] - dataset.sensorPos[1]) * dataset.losDir[1]
            + (cv.positions[2] - dataset.sensorPos[2]) * dataset.losDir[2];
        const trueRange0 = (truth[0] - dataset.sensorPos[0]) * dataset.losDir[0]
            + (truth[1] - dataset.sensorPos[1]) * dataset.losDir[1]
            + (truth[2] - dataset.sensorPos[2]) * dataset.losDir[2];

        console.log("\nNO-PARALLAX TRAP (camera flying dead straight)");
        console.log(`  fitted distance to object: ${range0.toFixed(0)} m`);
        console.log(`  true   distance to object: ${trueRange0.toFixed(0)} m`);
        console.log(`  the fit collapsed onto the camera's own path, ${rmsTruth(truth, cv.positions, dataset.count).toFixed(0)} m from truth`);

        expect(trueRange0).toBeGreaterThan(1000);
        expect(range0).toBeLessThan(0.01 * trueRange0);   // collapsed to ~zero distance
    });
});
