/**
 * BOT Bench conditioning-stack tests (fast; runs in normal `npm test`).
 *
 * Guards the two properties the triage statistic is worthless without:
 *
 *  1. PARAMETERIZATION INVARIANCE. A condition number belongs to a
 *     parameterization, not to a geometry, so a design built on raw t with
 *     un-equilibrated columns reports the analyst's choice of seconds-versus-
 *     milliseconds and the epoch of the clip. The shipped statistic centers
 *     and span-normalizes time and equilibrates the columns; the naive
 *     reference below does neither, and the tests assert the CONTRAST — the
 *     naive number moves by decades where the shipped one does not move at all.
 *
 *  2. ORDER COVERAGE. CV conditioning is necessary but not sufficient for a
 *     maneuvering target, so conditioningStack walks CV -> CA -> jerk and
 *     reports the highest order the geometry supports.
 *
 * Plus determinism, and the anchoring relation between the legacy
 * cvDesignLog10Rcond field and the new stack's CV rung.
 */

import {setSit} from "../../src/Globals";
import {generateScenario} from "../../benchmarks/botbench/lib/generateScenario";
import {
    conditioningStack,
    cvDesignConditioning,
    symmetricEigenvalues,
    OBSERVABLE_LOG10_RCOND,
} from "../../benchmarks/botbench/lib/diagnostics";

beforeAll(() => {
    setSit({name: "botbench-conditioning-test", frames: 1000, fps: 10,
        simSpeed: 1, lat: 40, lon: -105});
});

// The formulation the shipped statistic deliberately avoids: the same normal
// matrix G = sum B_i^T B_i with B_i = P_i [I, t_i I], but on RAW time and with
// no column equilibration. Kept here (never in lib/) purely as the negative
// control for the invariance tests.
function naiveDesignLog10Rcond(dirENU, times, active) {
    const G = new Float64Array(36);
    for (const f of active) {
        const b = f * 3;
        const dx = dirENU[b], dy = dirENU[b + 1], dz = dirENU[b + 2];
        const t = times[f];
        const P = [
            1 - dx * dx, -dx * dy, -dx * dz,
            -dy * dx, 1 - dy * dy, -dy * dz,
            -dz * dx, -dz * dy, 1 - dz * dz,
        ];
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                const p = P[i * 3 + j];
                G[i * 6 + j] += p;
                G[i * 6 + (j + 3)] += t * p;
                G[(i + 3) * 6 + j] += t * p;
                G[(i + 3) * 6 + (j + 3)] += t * t * p;
            }
        }
    }
    const ev = symmetricEigenvalues(G, 6);
    const rcond = Math.sqrt(Math.max(0, ev[0]) / ev[5]);
    return Math.log10(Math.max(rcond, Number.MIN_VALUE));
}

// A sensor arcing past a fixed point: enough direction spread that every
// statistic is finite, so a change of time units cannot hide in a floor value.
function arcScene({n = 120, dtSeconds = 0.5, t0 = 0, timeScale = 1} = {}) {
    const dirENU = new Float64Array(n * 3);
    const times = new Float64Array(n);
    const radius = 2000, speed = 70, alt = 3000, rangeM = 5000;
    for (let f = 0; f < n; f++) {
        const t = f * dtSeconds;
        times[f] = t0 + t * timeScale;
        const w = speed / radius;
        const sx = radius * Math.cos(w * t), sy = radius * Math.sin(w * t);
        const vx = rangeM - sx, vy = -sy, vz = 500 - alt;
        const L = Math.hypot(vx, vy, vz);
        dirENU[f * 3] = vx / L;
        dirENU[f * 3 + 1] = vy / L;
        dirENU[f * 3 + 2] = vz / L;
    }
    return {dirENU, times, active: Array.from({length: n}, (_, f) => f)};
}

const baseSpec = (over = {}) => ({
    durationSeconds: 30,
    fps: 10,
    initialHorizontalRangeM: 5000,
    siteId: "flat-reference",
    platform: {kind: "orbit-point", speedMS: 70, altitudeAGL: 3000},
    target: {kind: "party-neutral", family: "balloon", parameters: {startAGL: 500}},
    wind: {kind: "fixed"},
    observation: {kind: "white", fovFullDeg: 0.5, gaussianSigmaDeg: 0.03},
    ...over,
});

describe("botbench conditioning stack", () => {
    test("time units: shipped statistics are invariant, the naive design is not", () => {
        const sec = arcScene();
        const ms = arcScene({timeScale: 1000});   // the same clip, timed in ms

        const legacySec = cvDesignConditioning(sec.dirENU, sec.times, sec.active).log10Rcond;
        const legacyMs = cvDesignConditioning(ms.dirENU, ms.times, ms.active).log10Rcond;
        const stackSec = conditioningStack(sec.dirENU, sec.times, sec.active);
        const stackMs = conditioningStack(ms.dirENU, ms.times, ms.active);

        expect(legacyMs).toBeCloseTo(legacySec, 9);
        expect(stackMs.cv).toBeCloseTo(stackSec.cv, 9);
        expect(stackMs.ca).toBeCloseTo(stackSec.ca, 9);
        expect(stackMs.jerk).toBeCloseTo(stackSec.jerk, 9);
        expect(stackMs.maxObservableOrder).toBe(stackSec.maxObservableOrder);

        // The contrast: the same geometry, very nearly three decades of
        // "conditioning" (one per decade of the unit change) manufactured out
        // of nothing but the unit of the time column.
        const naiveSec = naiveDesignLog10Rcond(sec.dirENU, sec.times, sec.active);
        const naiveMs = naiveDesignLog10Rcond(ms.dirENU, ms.times, ms.active);
        expect(Math.abs(naiveMs - naiveSec)).toBeGreaterThan(2.5);
    });

    test("time origin: shipped statistics are invariant, the naive design is not", () => {
        const atZero = arcScene();
        const shifted = arcScene({t0: 86400});   // same clip, next day's epoch

        const legacyZero = cvDesignConditioning(atZero.dirENU, atZero.times, atZero.active).log10Rcond;
        const legacyShifted = cvDesignConditioning(shifted.dirENU, shifted.times, shifted.active).log10Rcond;
        const stackZero = conditioningStack(atZero.dirENU, atZero.times, atZero.active);
        const stackShifted = conditioningStack(shifted.dirENU, shifted.times, shifted.active);

        expect(legacyShifted).toBeCloseTo(legacyZero, 9);
        expect(stackShifted.cv).toBeCloseTo(stackZero.cv, 9);
        expect(stackShifted.ca).toBeCloseTo(stackZero.ca, 9);
        expect(stackShifted.jerk).toBeCloseTo(stackZero.jerk, 9);

        const naiveZero = naiveDesignLog10Rcond(atZero.dirENU, atZero.times, atZero.active);
        const naiveShifted = naiveDesignLog10Rcond(shifted.dirENU, shifted.times, shifted.active);
        expect(Math.abs(naiveShifted - naiveZero)).toBeGreaterThan(1);
    });

    test("an isotropic direction set scores near zero at EVERY rung", () => {
        // The basis check. Raw monomials on [-1,1] overlap each other
        // (<1, tau^2> = 2/3), which would drag the jerk rung to about -0.68 on
        // a geometry that is in fact perfectly observable. The sample-
        // orthonormal basis has to leave all three rungs at ~0.
        const n = 400;
        const dirENU = new Float64Array(n * 3);
        const times = new Float64Array(n);
        let s = 7 >>> 0;
        const rnd = () => {
            s = (s * 1664525 + 1013904223) >>> 0;
            return s / 4294967296;
        };
        for (let f = 0; f < n; f++) {
            times[f] = f * 0.1;
            const z = 2 * rnd() - 1, a = 2 * Math.PI * rnd(), h = Math.sqrt(1 - z * z);
            dirENU[f * 3] = h * Math.cos(a);
            dirENU[f * 3 + 1] = h * Math.sin(a);
            dirENU[f * 3 + 2] = z;
        }
        const st = conditioningStack(dirENU, times, Array.from({length: n}, (_, f) => f));
        expect(st.cv).toBeGreaterThan(-0.2);
        expect(st.ca).toBeGreaterThan(-0.2);
        expect(st.jerk).toBeGreaterThan(-0.2);
        expect(st.maxObservableOrder).toBe(3);
    });

    test("maxObservableOrder rises with sensor maneuver and collapses on a straight path", () => {
        const orbit = generateScenario(baseSpec(), {scenarioSeed: 101});
        const straight = generateScenario(
            baseSpec({platform: {kind: "straight", speedMS: 70, altitudeAGL: 3000}}),
            {scenarioSeed: 101});

        expect(straight.diagnostics.maxObservableOrder).toBe(0);
        expect(orbit.diagnostics.maxObservableOrder)
            .toBeGreaterThan(straight.diagnostics.maxObservableOrder);
        // Every rung of the straight-path clip sits below the floor: a
        // straight sensor watching a straight target is degenerate at CV
        // already, so no higher order can be claimed.
        expect(straight.diagnostics.conditioningStack.cv)
            .toBeLessThan(OBSERVABLE_LOG10_RCOND);
        expect(orbit.diagnostics.conditioningStack.cv)
            .toBeGreaterThan(straight.diagnostics.conditioningStack.cv);
    });

    test("longer sensor maneuver unlocks higher orders", () => {
        // Two full orbits reveal the acceleration and jerk terms that a
        // quarter arc cannot separate from position and velocity.
        const shortArc = generateScenario(baseSpec({durationSeconds: 30}), {scenarioSeed: 101});
        const twoOrbits = generateScenario(
            baseSpec({durationSeconds: 360, fps: 2, observation:
                {kind: "white", fovFullDeg: 2.0, gaussianSigmaDeg: 0.03}}),
            {scenarioSeed: 101});
        expect(twoOrbits.diagnostics.maxObservableOrder)
            .toBeGreaterThan(shortArc.diagnostics.maxObservableOrder);
    });

    test("the stack is nested: no rung is claimed above a failed rung", () => {
        for (const platform of ["orbit-point", "straight", "curve"]) {
            const sc = generateScenario(
                baseSpec({platform: {kind: platform, speedMS: 70, altitudeAGL: 3000,
                    ...(platform === "curve" ? {bankDeg: 10} : {})}}),
                {scenarioSeed: 202});
            const {cv, ca, jerk} = sc.diagnostics.conditioningStack;
            const rungs = [cv, ca, jerk];
            const order = sc.diagnostics.maxObservableOrder;
            for (let k = 1; k <= order; k++) {
                expect(rungs[k - 1]).toBeGreaterThanOrEqual(OBSERVABLE_LOG10_RCOND);
            }
            if (order < 3 && rungs[order] != null) {
                expect(rungs[order]).toBeLessThan(OBSERVABLE_LOG10_RCOND);
            }
        }
    });

    test("deterministic: identical inputs give bit-identical stack values", () => {
        const s = arcScene();
        const a = conditioningStack(s.dirENU, s.times, s.active);
        const b = conditioningStack(s.dirENU, s.times, s.active);
        expect(b).toEqual(a);

        const g1 = generateScenario(baseSpec(), {scenarioSeed: 303});
        const g2 = generateScenario(baseSpec(), {scenarioSeed: 303});
        expect(g2.diagnostics.conditioningStack).toEqual(g1.diagnostics.conditioningStack);
        expect(g2.diagnostics.maxObservableOrder).toBe(g1.diagnostics.maxObservableOrder);
        expect(g2.diagnostics.cvDesignLog10RcondEquilibrated)
            .toBe(g1.diagnostics.cvDesignLog10RcondEquilibrated);
    });

    test("the legacy fields keep their definition, and the CV rung anchors to them", () => {
        const sc = generateScenario(baseSpec(), {scenarioSeed: 404});
        const d = sc.diagnostics;
        // Legacy names still present and still the ORIGINAL statistic.
        expect(typeof d.cvDesignRcondObserved).toBe("number");
        expect(d.cvDesignLog10RcondObserved)
            .toBeCloseTo(Math.log10(d.cvDesignRcondObserved), 12);
        // Anchoring: with the whole clip active the two scales coincide at the
        // CV rung (the orthonormal basis differs from the centered monomials
        // only by a scaling there), which is what lets the legacy -3 band be
        // carried over to OBSERVABLE_LOG10_RCOND. It does NOT license reading
        // that band on the ca/jerk rungs.
        const allActive = sc.observation.inFov.every((v) => v);
        expect(allActive).toBe(true);
        expect(d.cvDesignLog10RcondEquilibrated)
            .toBeCloseTo(d.cvDesignLog10RcondObserved, 8);
    });
});

