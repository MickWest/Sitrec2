/**
 * The dossier's kinematic profile (benchmarks/botbench/lib/dossier.mjs).
 *
 * WHY THIS EXISTS. The first escalation pilot missed every spliced velocity
 * impulse: a smooth model still fits a spliced track to 0.075-0.151 deg, and
 * the dossier reported only that scalar, so analysts read "small residual" as
 * "ordinary motion". The profile publishes the sightlines over TIME instead.
 * These tests pin the two properties that make it useful:
 *
 *   1. a velocity step raises the rate-jump ratio far above a smooth track's,
 *      so the number discriminates rather than merely existing;
 *   2. the peak frame survives decimation, because a one-frame impulse that is
 *      averaged away reintroduces exactly the defect the section was added to
 *      fix.
 *
 * The series here are built analytically, so the test does not depend on the
 * scenario generators or on any recorded data.
 */

import {kinematicProfile} from "../../benchmarks/botbench/lib/dossier.mjs";

const DEG = Math.PI / 180;

// Sightlines from a sensor at the origin to a target moving in a straight
// line: unit vectors, no noise. Optionally apply a velocity STEP at stepAtS.
function makeDirections({n, fps, startE, startN, alt, vE, vN, stepAtS = null, dvE = 0}) {
    const out = new Float64Array(n * 3);
    let e = startE, north = startN;
    const dt = 1 / fps;
    for (let f = 0; f < n; f++) {
        const t = f * dt;
        const vEff = stepAtS !== null && t >= stepAtS ? vE + dvE : vE;
        if (f > 0) { e += vEff * dt; north += vN * dt; }
        const m = Math.hypot(e, north, alt);
        out[f * 3] = e / m;
        out[f * 3 + 1] = north / m;
        out[f * 3 + 2] = alt / m;
    }
    return out;
}

const base = {n: 301, fps: 10, startE: 0, startN: 5000, alt: 1000, vE: 60, vN: 0};
const RANGES = [2000, 10000, 50000];

describe("kinematicProfile", () => {
    test("reports a rate series and one row per assumed range", () => {
        const dirs = makeDirections(base);
        const p = kinematicProfile(dirs, base.n, base.fps, RANGES);
        expect(p.rows.length).toBeGreaterThan(5);
        // ~24 decimated rows (n=301, stride=12 gives 26) plus at most one
        // spliced-in peak row.
        expect(p.rows.length).toBeLessThanOrEqual(27);
        for (const r of p.rows) {
            expect(r.speeds.length).toBe(3);
            // speed = range * rate: the far column must read faster than the near one
            expect(r.speeds[2]).toBeGreaterThan(r.speeds[0]);
        }
    });

    test("implied speed scales with the assumed range — the fast-far ambiguity", () => {
        const dirs = makeDirections(base);
        const p = kinematicProfile(dirs, base.n, base.fps, RANGES);
        const mid = p.rows[Math.floor(p.rows.length / 2)];
        // 25x the range reads as 25x the speed on the same sightlines.
        expect(mid.speeds[2] / mid.speeds[0]).toBeCloseTo(RANGES[2] / RANGES[0], 6);
    });

    test("a velocity step raises the jump ratio far above a smooth track", () => {
        const smooth = kinematicProfile(makeDirections(base), base.n, base.fps, RANGES);
        const stepped = kinematicProfile(
            makeDirections({...base, stepAtS: 15, dvE: 100}), base.n, base.fps, RANGES);
        // Measured on these series: smooth 0.001, this step 0.86, a larger
        // late step 2.35. The smooth track's rate changes only through
        // geometry, so its frame-to-frame jump is a rounding error beside the
        // median rate; a discontinuity is three orders of magnitude above it.
        expect(smooth.jumpRatio).toBeLessThan(0.01);
        expect(stepped.jumpRatio).toBeGreaterThan(0.5);
        expect(stepped.jumpRatio / smooth.jumpRatio).toBeGreaterThan(100);
    });

    test("the ratio self-normalizes, which partly masks an early step", () => {
        // Worth pinning because it bounds what the statistic can claim: the
        // jump is divided by the MEDIAN rate, and a step early in a clip
        // raises that median for the rest of the clip. So the same physical
        // discontinuity scores LOWER the earlier it happens. The statistic is
        // a flag to weigh, never a calibrated detector.
        const early = kinematicProfile(
            makeDirections({...base, stepAtS: 5, dvE: 150}), base.n, base.fps, RANGES);
        const late = kinematicProfile(
            makeDirections({...base, stepAtS: 25, dvE: 150}), base.n, base.fps, RANGES);
        expect(late.jumpRatio).toBeGreaterThan(early.jumpRatio);
        // Both still clear a smooth track by a wide margin.
        expect(early.jumpRatio).toBeGreaterThan(0.1);
    });

    test("locates the step in time", () => {
        const p = kinematicProfile(
            makeDirections({...base, stepAtS: 15, dvE: 100}), base.n, base.fps, RANGES);
        expect(p.maxJumpT).toBeGreaterThan(14.5);
        expect(p.maxJumpT).toBeLessThan(15.6);
    });

    test("keeps the peak frame through decimation", () => {
        // A one-frame impulse in a long clip: decimation must not drop it.
        const p = kinematicProfile(
            makeDirections({...base, stepAtS: 22.7, dvE: 150}), base.n, base.fps, RANGES);
        const peaks = p.rows.filter((r) => r.peak);
        expect(peaks.length).toBe(1);
        expect(peaks[0].t).toBeGreaterThan(22.5);
        expect(peaks[0].t).toBeLessThan(23.0);
        // rows stay in time order after the peak is spliced in
        for (let i = 1; i < p.rows.length; i++) {
            expect(p.rows[i].t).toBeGreaterThan(p.rows[i - 1].t);
        }
    });

    test("is deterministic", () => {
        const dirs = makeDirections(base);
        const a = kinematicProfile(dirs, base.n, base.fps, RANGES);
        const b = kinematicProfile(dirs, base.n, base.fps, RANGES);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
});
