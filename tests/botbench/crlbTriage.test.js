/**
 * crlbTriage.test.js — the properties that make a predicted-precision score
 * safe to triage on.
 *
 * The claims are geometric, so the geometries are built here from closed-form
 * sensor paths rather than from the scenario generator: an orbit (the decisive
 * case), a constant-velocity straight-line pass (the classic bearings-only
 * degeneracy) and a shallow dogleg (a real but weak maneuver). Sightlines are
 * exact; sigma enters the bound as a DECLARED number, and the module never sees
 * a noise realization or a truth track.
 *
 * The headline number is also checked against an independent finite-difference
 * Fisher information built in this file from the measurement function itself,
 * so a wrong 1/r, a dropped tangent projection or a sigma-vs-RMS mix-up cannot
 * hide behind tests that only compare one geometry with another.
 */

import {
    makeLosGeometry, crlbTriage, crlbTriageByClass,
    LIMIT_NOISE, LIMIT_GEOMETRY, LIMIT_NONE, PREDICTION_CAVEAT,
} from "../../benchmarks/botbench/lib/crlbTriage";

const DEG = Math.PI / 180;
const SIGMA = 0.1 * DEG;                 // per-axis pointing sigma
const BRACKET = {minRangeM: 2000, maxRangeM: 80000};

// Sample a sensor path and a target over [0, durationS] and build the observed
// sightline set. jitterRad adds a deterministic (incommensurate-frequency)
// pointing error, which is not a noise model — it is there to show that the
// bound depends on the sightlines only through the trajectory family they
// anchor, so a realization cannot move a degeneracy.
function losSet(sensorAt, targetAt, {durationS = 60, dt = 1, jitterRad = 0} = {}) {
    const n = Math.round(durationS / dt) + 1;
    const times = new Float64Array(n);
    const sensorPositionENU = new Float64Array(n * 3);
    const observedDirectionENU = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const t = f * dt;
        times[f] = t;
        const s = sensorAt(t);
        const x = targetAt(t);
        let d = [x[0] - s[0], x[1] - s[1], x[2] - s[2]];
        let L = Math.hypot(d[0], d[1], d[2]);
        d = [d[0] / L, d[1] / L, d[2] / L];
        if (jitterRad) {
            d = [d[0] + jitterRad * Math.sin(1.7 * t), d[1] + jitterRad * Math.cos(2.3 * t),
                d[2] + jitterRad * Math.sin(0.9 * t)];
            L = Math.hypot(d[0], d[1], d[2]);
            d = [d[0] / L, d[1] / L, d[2] / L];
        }
        for (let c = 0; c < 3; c++) {
            sensorPositionENU[f * 3 + c] = s[c];
            observedDirectionENU[f * 3 + c] = d[c];
        }
    }
    return {sensorPositionENU, observedDirectionENU, times, sigmaRad: SIGMA};
}

// A constant-velocity target 20 km east, drifting north at 50 m/s.
const target = (t) => [20000, 50 * t, 3000];

// Range from a sensor path to the target, for the one test that needs to line a
// grid point up with the truth. The module is never told either.
const rangeAt = (sensorAt, t) => {
    const s = sensorAt(t), x = target(t);
    return Math.hypot(x[0] - s[0], x[1] - s[1], x[2] - s[2]);
};

// Two thirds of a 2 km-radius turn in the clip: the geometry an operator flies
// when range matters, and the one the tractability study measured as the best
// track recovery.
const orbit = (t) => {
    const w = 2 * Math.PI * t / 90;
    return [2000 * Math.cos(w), 2000 * Math.sin(w), 3000];
};

// Constant velocity, constant heading: scaling the whole scene about the sensor
// reproduces every bearing exactly, so range is unobservable by algebra.
const straight = (t) => [0, -1500 + 100 * t, 3000];

// The same speed and duration, taken as two legs with a 5 degree turn at
// mid-clip: a real maneuver, but one whose cross-track baseline is a couple of
// hundred metres rather than kilometres.
const TURN = 5 * DEG;
const dogleg = (t) => (t <= 30
    ? [0, -1500 + 100 * t, 3000]
    : [100 * (t - 30) * Math.sin(TURN), 1500 + 100 * (t - 30) * Math.cos(TURN), 3000]);

const geo = (path, opts) => makeLosGeometry(losSet(path, target, opts));

// --- independent bound, from finite differences of the measurement ----------

// Solve A x = b for a small dense system (Gauss-Jordan, partial pivoting).
function solve(A, b, m) {
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < m; c++) {
        let piv = c;
        for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
        [M[c], M[piv]] = [M[piv], M[c]];
        for (let r = 0; r < m; r++) {
            if (r === c) continue;
            const w = M[r][c] / M[c][c];
            for (let k = c; k <= m; k++) M[r][k] -= w * M[c][k];
        }
    }
    return M.map((row, i) => row[m] / row[i]);
}

/**
 * sigma_r / r at the reference frame for a constant-velocity target, built the
 * long way: numerically differentiate the two tangent-plane angle components of
 * every predicted sightline with respect to (position at the epoch, velocity),
 * stack, scale by 1/sigma^2, invert, and read off the range variance. Shares no
 * code with the module under test.
 */
function finiteDifferenceFraction(sensorAt, targetAt, {durationS = 60, dt = 1} = {}) {
    const n = Math.round(durationS / dt) + 1;
    const ref = n >> 1;
    const tRef = ref * dt;
    const p0 = targetAt(tRef);
    const v = [(targetAt(tRef + 1)[0] - p0[0]), (targetAt(tRef + 1)[1] - p0[1]),
        (targetAt(tRef + 1)[2] - p0[2])];
    const theta = [...p0, ...v];
    const step = [1, 1, 1, 1 / durationS, 1 / durationS, 1 / durationS];

    // Nominal sightlines and a fixed tangent basis at each frame.
    const dirs = [], b1 = [], b2 = [], S = [];
    const dirAt = (th, f) => {
        const t = f * dt;
        const s = sensorAt(t);
        const d = [th[0] + th[3] * (t - tRef) - s[0], th[1] + th[4] * (t - tRef) - s[1],
            th[2] + th[5] * (t - tRef) - s[2]];
        const L = Math.hypot(d[0], d[1], d[2]);
        return [d[0] / L, d[1] / L, d[2] / L];
    };
    for (let f = 0; f < n; f++) {
        const u = dirAt(theta, f);
        dirs.push(u);
        S.push(sensorAt(f * dt));
        let a = [-u[1], u[0], 0];
        let L = Math.hypot(a[0], a[1], a[2]);
        if (L < 1e-9) { a = [1, 0, 0]; L = 1; }
        a = a.map((c) => c / L);
        b1.push(a);
        b2.push([u[1] * a[2] - u[2] * a[1], u[2] * a[0] - u[0] * a[2], u[0] * a[1] - u[1] * a[0]]);
    }

    const J = Array.from({length: 6}, () => new Array(6).fill(0));
    const rows = [];
    for (let j = 0; j < 6; j++) {
        const plus = [...theta], minus = [...theta];
        plus[j] += step[j]; minus[j] -= step[j];
        const col = [];
        for (let f = 0; f < n; f++) {
            const up = dirAt(plus, f), um = dirAt(minus, f);
            const du = [up[0] - um[0], up[1] - um[1], up[2] - um[2]].map((c) => c / (2 * step[j]));
            col.push([
                b1[f][0] * du[0] + b1[f][1] * du[1] + b1[f][2] * du[2],
                b2[f][0] * du[0] + b2[f][1] * du[1] + b2[f][2] * du[2],
            ]);
        }
        rows.push(col);
    }
    for (let j = 0; j < 6; j++) {
        for (let k = 0; k < 6; k++) {
            let sum = 0;
            for (let f = 0; f < n; f++) {
                sum += rows[j][f][0] * rows[k][f][0] + rows[j][f][1] * rows[k][f][1];
            }
            J[j][k] = sum / (SIGMA * SIGMA);
        }
    }
    // r at the epoch depends on the position block only: dr/dp = u_ref.
    const g = [...dirs[ref], 0, 0, 0];
    const Jinvg = solve(J, g, 6);
    let varR = 0;
    for (let j = 0; j < 6; j++) varR += g[j] * Jinvg[j];
    const r = Math.hypot(p0[0] - S[ref][0], p0[1] - S[ref][1], p0[2] - S[ref][2]);
    return Math.sqrt(varR) / r;
}

describe("predicted range precision", () => {
    test("the bound matches an independent finite-difference Fisher information", () => {
        // Collapse the bracket onto the true range so the module's assumed
        // trajectory is the one the finite-difference bound differentiates
        // about; with exact sightlines the implied-velocity fit recovers it.
        const refRange = rangeAt(orbit, 30);       // the middle of a 0-60 s clip
        const s = crlbTriage(geo(orbit), {
            minRangeM: refRange, maxRangeM: refRange, gridCount: 2,
        });
        const fd = finiteDifferenceFraction(orbit, target);
        expect(s.grid[0].impliedSpeedMS).toBeCloseTo(50, 6);
        expect(s.sigmaROverR.median / fd).toBeCloseTo(1, 5);
    });

    test("an orbit is decisive where a straight-line pass is degenerate", () => {
        const orbitScore = crlbTriage(geo(orbit), {...BRACKET});
        const straightScore = crlbTriage(geo(straight), {...BRACKET});

        // The straight pass is not "very imprecise", it is unbounded: the
        // Fisher information is singular along the range direction, and that is
        // exact algebra rather than a large finite number.
        expect(straightScore.sigmaROverR.median).toBe(Infinity);
        expect(straightScore.kappa.max).toBe(Infinity);
        expect(straightScore.rangeObservable).toBe(false);

        // The orbit predicts a fraction of a percent to a few percent of range.
        expect(Number.isFinite(orbitScore.sigmaROverR.median)).toBe(true);
        expect(orbitScore.sigmaROverR.median).toBeLessThan(0.05);
    });

    test("the degeneracy is a property of the geometry, not of the sightline noise", () => {
        // The information is evaluated at the ASSUMED trajectory, so 0.3 degrees
        // of pointing error — three times the declared sigma — cannot turn an
        // unobservable range into an observable one, and does not meaningfully
        // move a well-conditioned bound either.
        const jitterRad = 5e-3;
        const straightJittered = crlbTriage(makeLosGeometry(
            losSet(straight, target, {jitterRad})), {...BRACKET});
        expect(straightJittered.sigmaROverR.median).toBe(Infinity);
        expect(straightJittered.limit).toBe(LIMIT_GEOMETRY);

        const clean = crlbTriage(geo(orbit), {...BRACKET});
        const jittered = crlbTriage(makeLosGeometry(
            losSet(orbit, target, {jitterRad})), {...BRACKET});
        expect(jittered.limit).toBe(LIMIT_NOISE);
        expect(jittered.sigmaROverR.median / clean.sigmaROverR.median).toBeCloseTo(1, 1);

        // The conditioning that separates the two cases, reported per point so
        // "singular" can be told from "merely awful" by the reader.
        expect(straightJittered.grid[0].rcond).toBeLessThan(1e-10);
        expect(clean.grid[0].rcond).toBeGreaterThan(1e-6);
    });

    test("a weak maneuver is finite but hundreds of times worse than the orbit", () => {
        const orbitScore = crlbTriage(geo(orbit), {...BRACKET});
        const doglegScore = crlbTriage(geo(dogleg), {...BRACKET});
        expect(Number.isFinite(doglegScore.sigmaROverR.median)).toBe(true);
        expect(doglegScore.sigmaROverR.median)
            .toBeGreaterThan(100 * orbitScore.sigmaROverR.median);
        // Over 100% of range: the class is not excluded, its range just is not
        // recoverable here.
        expect(doglegScore.sigmaROverR.median).toBeGreaterThan(1);
    });

    test("the bound is reported as a bound, not as a precision guarantee", () => {
        const s = crlbTriage(geo(orbit), {...BRACKET});
        expect(s.isLowerBound).toBe(true);
        expect(s.caveat).toBe(PREDICTION_CAVEAT);
        expect(s.caveat).toMatch(/lower bound/i);
        expect(s.caveat).toMatch(/not a precision guarantee/i);
    });

    test("min/median/max span the bracket, and the far end is the worst", () => {
        const s = crlbTriage(geo(orbit), {...BRACKET});
        expect(s.grid).toHaveLength(s.gridCount);
        expect(s.sigmaROverR.min).toBeLessThanOrEqual(s.sigmaROverR.median);
        expect(s.sigmaROverR.median).toBeLessThanOrEqual(s.sigmaROverR.max);
        // A 40x bracket is a 20x+ spread in predicted precision, which is why
        // three numbers are reported and not one. The profile is not monotone
        // at the near end — a near candidate has to fly fast to explain the same
        // bearing sweep, and that costs conditioning — but the far end, where
        // the sensor's baseline is smallest relative to range, is always worst.
        expect(s.kappa.max).toBeGreaterThan(20 * s.kappa.min);
        expect(s.grid[s.gridCount - 1].kappa).toBe(s.kappa.max);
        // kappa carries the geometry alone: sigma_r/r = kappa * sigma/sqrt(N).
        expect(s.sigmaROverR.median)
            .toBeCloseTo(s.kappa.median * SIGMA / Math.sqrt(s.nActive), 12);
    });
});

describe("noise-limited vs geometry-limited", () => {
    test("more data is actionable on the orbit and useless on the straight pass", () => {
        const orbitScore = crlbTriage(geo(orbit), {...BRACKET});
        const straightScore = crlbTriage(geo(straight), {...BRACKET});
        expect(orbitScore.limit).toBe(LIMIT_NOISE);
        expect(orbitScore.sampleGrowthForTarget).toBeLessThan(orbitScore.maxSampleGrowth);
        expect(orbitScore.sigmaROverRAsNInfinite).toBe(0);

        expect(straightScore.limit).toBe(LIMIT_GEOMETRY);
        expect(straightScore.sampleGrowthForTarget).toBe(Infinity);
        expect(straightScore.sigmaROverRAsNInfinite).toBe(Infinity);
        expect(straightScore.limitReason).toMatch(/no sample count helps/);
    });

    test("a weak maneuver is geometry-limited without being degenerate", () => {
        // The distinction the label exists for: range IS observable here, but
        // reaching a useful precision would take a sample count nobody can buy,
        // so "collect more data" is not the recommendation.
        const s = crlbTriage(geo(dogleg), {...BRACKET});
        expect(s.rangeObservable).toBe(true);
        expect(s.limit).toBe(LIMIT_GEOMETRY);
        expect(s.sampleGrowthForTarget).toBeGreaterThan(s.maxSampleGrowth);
        expect(s.limitReason).toMatch(/more samples/);
    });

    test("doubling N shrinks the noise-limited bound by sqrt(2) and the degenerate one not at all", () => {
        // Same path, same window, twice the sample rate.
        const oneX = crlbTriage(geo(orbit, {dt: 1}), {...BRACKET});
        const twoX = crlbTriage(geo(orbit, {dt: 0.5}), {...BRACKET});
        expect(twoX.nActive).toBe(2 * oneX.nActive - 1);
        const ratio = oneX.sigmaROverR.median / twoX.sigmaROverR.median;
        expect(ratio).toBeCloseTo(Math.sqrt(twoX.nActive / oneX.nActive), 2);
        expect(ratio).toBeGreaterThan(1.4);
        expect(ratio).toBeLessThan(1.42);
        // The geometry factor is what did NOT change.
        expect(twoX.kappa.median / oneX.kappa.median).toBeCloseTo(1, 2);

        // On the degenerate geometry the bound is unbounded at both sample
        // counts: the honest form of "unchanged" when the limit is algebraic
        // rather than statistical.
        const degOne = crlbTriage(geo(straight, {dt: 1}), {...BRACKET});
        const degTwo = crlbTriage(geo(straight, {dt: 0.5}), {...BRACKET});
        expect(degOne.sigmaROverR.median).toBe(Infinity);
        expect(degTwo.sigmaROverR.median).toBe(Infinity);
        expect(degTwo.limit).toBe(LIMIT_GEOMETRY);

        // On the weak maneuver the bound does shrink — it is a CRLB, not a
        // wall — but the geometry factor and the verdict do not move.
        const weakOne = crlbTriage(geo(dogleg, {dt: 1}), {...BRACKET});
        const weakTwo = crlbTriage(geo(dogleg, {dt: 0.5}), {...BRACKET});
        expect(weakTwo.kappa.median / weakOne.kappa.median).toBeCloseTo(1, 1);
        expect(weakTwo.limit).toBe(LIMIT_GEOMETRY);
    });
});

describe("class conditioning", () => {
    test("a class that may accelerate pays for its extra parameters", () => {
        const g = geo(orbit);
        const cv = crlbTriage(g, {...BRACKET, dynamicsOrder: 1});
        const ca = crlbTriage(g, {...BRACKET, dynamicsOrder: 2});
        expect(cv.parameterCount).toBe(6);
        expect(ca.parameterCount).toBe(9);
        expect(ca.sigmaROverR.median).toBeGreaterThan(cv.sigmaROverR.median);
    });

    test("a speed envelope removes the candidate ranges the class cannot fly", () => {
        const g = geo(orbit);
        const open = crlbTriage(g, {...BRACKET});
        const slow = crlbTriage(g, {...BRACKET, className: "balloon",
            speedEnvelopeMS: {maxMS: 60}});
        expect(slow.admissibleCount).toBeGreaterThan(0);
        expect(slow.admissibleCount).toBeLessThan(open.admissibleCount);
        // The excluded candidates are the ones a balloon could not be flying.
        for (const p of slow.grid) {
            if (p.admissible) expect(p.peakImpliedSpeedMS).toBeLessThanOrEqual(60);
            else expect(p.reason).toMatch(/class envelope|sensor/);
        }
        // Dropping candidates can only shrink the reported spread.
        expect(slow.sigmaROverR.max).toBeLessThanOrEqual(open.sigmaROverR.max);
        expect(slow.sigmaROverR.min).toBeGreaterThanOrEqual(open.sigmaROverR.min);
    });

    test("a class no candidate range can satisfy is excluded, not scored", () => {
        const s = crlbTriage(geo(orbit), {...BRACKET, className: "hover",
            speedEnvelopeMS: {maxMS: 0.001}});
        expect(s.admissibleCount).toBe(0);
        expect(s.limit).toBe(LIMIT_NONE);
        expect(s.sigmaROverR.median).toBeNull();
        expect(s.rangeObservable).toBeNull();
    });

    test("several classes over one geometry keep their input order", () => {
        const out = crlbTriageByClass(geo(orbit), [
            {className: "balloon", speedEnvelopeMS: {maxMS: 60}},
            {className: "fixedWing", speedEnvelopeMS: {minMS: 60, maxMS: 300}},
            {className: "maneuvering", dynamicsOrder: 2},
        ], {...BRACKET});
        expect(out.map((r) => r.className)).toEqual(["balloon", "fixedWing", "maneuvering"]);
        expect(out[2].dynamicsOrder).toBe(2);
        expect(out[0].admissibleCount).toBeGreaterThan(0);
    });
});

describe("no truth, structurally", () => {
    test("the geometry constructor rejects any key it does not know", () => {
        const fields = losSet(orbit, target);
        expect(() => makeLosGeometry({...fields, truthPositionENU: new Float64Array(9)}))
            .toThrow(/unexpected key "truthPositionENU"/);
        expect(() => makeLosGeometry({...fields, initialHorizontalRangeM: 20000}))
            .toThrow(/never accepts truth/);
    });

    test("the score rejects any option it does not know", () => {
        const g = geo(orbit);
        expect(() => crlbTriage(g, {...BRACKET, truthRangeM: 20000}))
            .toThrow(/unexpected key "truthRangeM"/);
        expect(() => crlbTriageByClass(g, [{className: "x", truthRangeM: 1}], {...BRACKET}))
            .toThrow(/unexpected key "truthRangeM"/);
    });

    test("repeated evaluation is bit-identical", () => {
        const a = crlbTriage(geo(orbit), {...BRACKET});
        const b = crlbTriage(geo(orbit), {...BRACKET});
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
});
