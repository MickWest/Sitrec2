/**
 * BOT Bench residualized-incremental-information tests (fast; runs in normal
 * `npm test`).
 *
 * conditioningStack's cv/ca/jerk rungs are JOINT conditioning numbers of the
 * whole order-0..k design. incrementalLog10 answers the other question: after
 * projecting the order-k design columns onto the span of every lower-order
 * column, how much information is left over — the Schur complement S_k of the
 * order-k diagonal block, reported as log10 of lambdaMin(S_k) / (tr(N_k)/3).
 *
 * What is guarded here:
 *
 *  1. BASIS-SCALE INVARIANCE, against an INDEPENDENT oracle. The reference
 *     below reaches the same quantity by a different route — accumulate the
 *     full design Gram, then eliminate the lower block by Cholesky — and does
 *     it on a design whose order-2 and order-3 columns have been artificially
 *     rescaled by 1e4 and 1e-3. The analytic property under test is that
 *     phi_k -> s phi_k sends S_k and N_k both to s^2 times themselves, so the
 *     ratio cannot move; the un-equilibrated rung rcond on the SAME rescaled
 *     design moves by decades, which is what makes the invariance a claim
 *     about the statistic rather than about the scene.
 *
 *  2. THAT IT IS NOT INVARIANCE BY NORMALIZATION. The fully basis-invariant
 *     alternative — anything of the form "what fraction of N_k survives into
 *     S_k" — is measured here on a static line of sight, a geometry that
 *     constrains no coefficient of any order. Those two matrices are equal
 *     there to machine precision, so that alternative scores the dead
 *     geometry at 1.0, ABOVE an isotropic control. The shipped statistic
 *     bottoms out instead. This is the discriminating test: a quantity that
 *     passed test 1 and failed this one would be worthless.
 *
 *  3. That maxObservableOrder is still the ladder over cv/ca/jerk and is not
 *     fed by the new field, and that the legacy cvDesign* fields are untouched.
 *
 * Plus presence on scenario.diagnostics, and determinism.
 */

import {setSit} from "../../src/Globals";
import {generateScenario} from "../../benchmarks/botbench/lib/generateScenario";
import {
    conditioningStack,
    centeredTau,
    symmetricEigenvalues,
    OBSERVABLE_LOG10_RCOND,
} from "../../benchmarks/botbench/lib/diagnostics";

beforeAll(() => {
    setSit({name: "botbench-incremental-test", frames: 1000, fps: 10,
        simSpeed: 1, lat: 40, lon: -105});
});

const MAX_ORDER = 3;

// --- independent oracle ---------------------------------------------------
// Deliberately NOT the shipped algorithm. The library residualizes the design
// COLUMNS by Gram-Schmidt; this accumulates the (3K+3)-square design Gram and
// takes the Schur complement by Cholesky elimination, which is a different
// numerical path with different error behavior (forming the Gram squares the
// condition number). Agreement between the two is therefore evidence, not a
// tautology.

// Modified Gram-Schmidt on 1, tau, tau^2, ... over the active samples.
function orthonormalTimeBasis(taus, maxOrder) {
    const n = taus.length;
    const cols = [];
    for (let j = 0; j <= maxOrder; j++) {
        const v = new Float64Array(n);
        for (let i = 0; i < n; i++) v[i] = j === 0 ? 1 : taus[i] ** j;
        for (let pass = 0; pass < 2; pass++) {
            for (const u of cols) {
                let d = 0;
                for (let i = 0; i < n; i++) d += u[i] * v[i];
                for (let i = 0; i < n; i++) v[i] -= d * u[i];
            }
        }
        let nrm = 0;
        for (let i = 0; i < n; i++) nrm += v[i] * v[i];
        nrm = Math.sqrt(nrm);
        if (!(nrm > 1e-10 * Math.sqrt(n))) break;
        for (let i = 0; i < n; i++) v[i] /= nrm;
        cols.push(v);
    }
    return cols;
}

// Full design Gram with block k scaled by blockScale[k] — the artificial
// rescaling of the higher-order columns. G block (j,l) is
// sum_i s_j s_l phi_j(i) phi_l(i) P_i, using P_i^T P_i = P_i.
function designGram(dirENU, times, active, blockScale) {
    const cols = orthonormalTimeBasis(centeredTau(times, active), MAX_ORDER);
    const K = cols.length - 1;
    const m = 3 * (K + 1);
    const G = new Float64Array(m * m);
    for (let i = 0; i < active.length; i++) {
        const b = active[i] * 3;
        const dx = dirENU[b], dy = dirENU[b + 1], dz = dirENU[b + 2];
        const P = [
            1 - dx * dx, -dx * dy, -dx * dz,
            -dy * dx, 1 - dy * dy, -dy * dz,
            -dz * dx, -dz * dy, 1 - dz * dz,
        ];
        for (let j = 0; j <= K; j++) {
            for (let l = 0; l <= K; l++) {
                const w = cols[j][i] * cols[l][i] * blockScale[j] * blockScale[l];
                for (let r = 0; r < 3; r++)
                    for (let c = 0; c < 3; c++)
                        G[(j * 3 + r) * m + (l * 3 + c)] += w * P[r * 3 + c];
            }
        }
    }
    return {G, m, K};
}

// Solve A X = B for symmetric positive definite A (p x p) by Cholesky.
function choleskySolve(A, p, B, k) {
    const L = new Float64Array(p * p);
    for (let i = 0; i < p; i++) {
        for (let j = 0; j <= i; j++) {
            let s = A[i * p + j];
            for (let q = 0; q < j; q++) s -= L[i * p + q] * L[j * p + q];
            if (i === j) {
                if (!(s > 0)) return null;      // singular lower block
                L[i * p + i] = Math.sqrt(s);
            } else {
                L[i * p + j] = s / L[j * p + j];
            }
        }
    }
    const X = new Float64Array(p * k);
    for (let c = 0; c < k; c++) {
        const y = new Float64Array(p);
        for (let i = 0; i < p; i++) {
            let s = B[i * k + c];
            for (let q = 0; q < i; q++) s -= L[i * p + q] * y[q];
            y[i] = s / L[i * p + i];
        }
        for (let i = p - 1; i >= 0; i--) {
            let s = y[i];
            for (let q = i + 1; q < p; q++) s -= L[q * p + i] * X[q * k + c];
            X[i * k + c] = s / L[i * p + i];
        }
    }
    return X;
}

// Per order k: the raw added-block Gram N_k, its residual S_k after the lower
// orders are eliminated, and the ratio the library reports.
function oracleIncremental(dirENU, times, active, blockScale = [1, 1, 1, 1]) {
    const {G, m, K} = designGram(dirENU, times, active, blockScale);
    const out = [];
    for (let k = 0; k <= K; k++) {
        const p = 3 * k;
        const N = new Float64Array(9);
        for (let r = 0; r < 3; r++)
            for (let c = 0; c < 3; c++) N[r * 3 + c] = G[(p + r) * m + (p + c)];
        const S = N.slice();
        if (p > 0) {
            const A = new Float64Array(p * p);
            for (let i = 0; i < p; i++)
                for (let j = 0; j < p; j++) A[i * p + j] = G[i * m + j];
            const B = new Float64Array(p * 3);
            for (let i = 0; i < p; i++)
                for (let c = 0; c < 3; c++) B[i * 3 + c] = G[i * m + (p + c)];
            const X = choleskySolve(A, p, B, 3);
            if (X) {
                for (let r = 0; r < 3; r++)
                    for (let c = 0; c < 3; c++) {
                        let s = 0;
                        for (let i = 0; i < p; i++) s += B[i * 3 + r] * X[i * 3 + c];
                        S[r * 3 + c] -= s;
                    }
            }
        }
        const traceN = N[0] + N[4] + N[8];
        const rho = Math.max(0, symmetricEigenvalues(S, 3)[0]) / (traceN / 3);
        out.push({N, S, traceN, rho, log10: Math.log10(Math.max(rho, Number.MIN_VALUE))});
    }
    return out;
}

// The naive per-rung conditioning number: rcond of the rung's design Gram with
// NO column equilibration — the quantity the rescaling is supposed to move.
function naiveRungLog10Rcond(dirENU, times, active, blockScale) {
    const {G, m, K} = designGram(dirENU, times, active, blockScale);
    const out = [null, null, null, null];
    for (let k = 1; k <= K; k++) {
        const q = 3 * (k + 1);
        const sub = new Float64Array(q * q);
        for (let i = 0; i < q; i++)
            for (let j = 0; j < q; j++) sub[i * q + j] = G[i * m + j];
        const ev = symmetricEigenvalues(sub, q);
        const rcond = Math.sqrt(Math.max(0, ev[0]) / ev[q - 1]);
        out[k] = Math.log10(Math.max(rcond, Number.MIN_VALUE));
    }
    return out;
}

// --- scenes ---------------------------------------------------------------

function makeScene(kind, n = 400) {
    const dirENU = new Float64Array(n * 3);
    const times = new Float64Array(n);
    let s = 7 >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let f = 0; f < n; f++) {
        times[f] = f * 0.1;
        if (kind === "isotropic") {
            const z = 2 * rnd() - 1, a = 2 * Math.PI * rnd(), h = Math.sqrt(1 - z * z);
            dirENU[f * 3] = h * Math.cos(a);
            dirENU[f * 3 + 1] = h * Math.sin(a);
            dirENU[f * 3 + 2] = z;
        } else if (kind === "static") {
            // One fixed sightline for the whole clip: no parallax at all, so
            // no coefficient of any order is constrained.
            dirENU[f * 3] = 1;
        } else {                                    // "arc"
            const t = f * 0.1, radius = 2000, w = 70 / radius;
            const vx = 5000 - radius * Math.cos(w * t);
            const vy = -radius * Math.sin(w * t);
            const vz = 500 - 3000;
            const L = Math.hypot(vx, vy, vz);
            dirENU[f * 3] = vx / L;
            dirENU[f * 3 + 1] = vy / L;
            dirENU[f * 3 + 2] = vz / L;
        }
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

describe("botbench residualized incremental information", () => {
    test("computed for all three rungs and present on scenario.diagnostics", () => {
        const sc = generateScenario(baseSpec(), {scenarioSeed: 404});
        const inc = sc.diagnostics.conditioningStack.incrementalLog10;
        expect(inc).toBeDefined();
        for (const rung of ["cv", "ca", "jerk"]) {
            expect(typeof inc[rung]).toBe("number");
            expect(Number.isFinite(inc[rung])).toBe(true);
            // log10 of a ratio in [0, 1]: it cannot exceed the isotropic
            // reference by more than rounding.
            expect(inc[rung]).toBeLessThan(1e-9);
        }
    });

    test("matches an independent Schur-complement oracle", () => {
        const s = makeScene("arc");
        const shipped = conditioningStack(s.dirENU, s.times, s.active).incrementalLog10;
        const oracle = oracleIncremental(s.dirENU, s.times, s.active);
        expect(shipped.cv).toBeCloseTo(oracle[1].log10, 6);
        expect(shipped.ca).toBeCloseTo(oracle[2].log10, 5);
        expect(shipped.jerk).toBeCloseTo(oracle[3].log10, 5);
    });

    test("rescaling the higher-order columns moves the naive rung number, not this one", () => {
        const s = makeScene("arc");
        const unit = [1, 1, 1, 1];
        const scaled = [1, 1, 1e4, 1e-3];    // acceleration and jerk columns

        const plain = oracleIncremental(s.dirENU, s.times, s.active, unit);
        const rescaled = oracleIncremental(s.dirENU, s.times, s.active, scaled);

        // The analytic property: phi_k -> s phi_k scales S_k and N_k alike.
        for (let k = 1; k <= 3; k++) {
            expect(rescaled[k].log10).toBeCloseTo(plain[k].log10, 4);
        }
        // ... and it is the shipped number, not just an internally consistent one.
        const shipped = conditioningStack(s.dirENU, s.times, s.active).incrementalLog10;
        expect(rescaled[2].log10).toBeCloseTo(shipped.ca, 4);
        expect(rescaled[3].log10).toBeCloseTo(shipped.jerk, 4);

        // The contrast: the same geometry, the same frames, decades of
        // "conditioning" manufactured out of the column scale alone.
        const naivePlain = naiveRungLog10Rcond(s.dirENU, s.times, s.active, unit);
        const naiveScaled = naiveRungLog10Rcond(s.dirENU, s.times, s.active, scaled);
        expect(Math.abs(naiveScaled[2] - naivePlain[2])).toBeGreaterThan(2);
        expect(Math.abs(naiveScaled[3] - naivePlain[3])).toBeGreaterThan(2);
    });

    test("a geometry that constrains nothing scores at the floor, where a ratio-to-N normalization scores it perfect", () => {
        const dead = makeScene("static");
        const good = makeScene("isotropic");

        const deadInc = conditioningStack(dead.dirENU, dead.times, dead.active).incrementalLog10;
        const goodInc = conditioningStack(good.dirENU, good.times, good.active).incrementalLog10;

        // The shipped statistic separates them by hundreds of decades.
        for (const rung of ["cv", "ca", "jerk"]) {
            expect(deadInc[rung]).toBeLessThan(-100);
            expect(goodInc[rung]).toBeGreaterThan(-0.2);
        }

        // The refused alternative. Any statistic that reports the FRACTION of
        // N_k surviving into S_k reads off ||S_k - N_k|| / ||N_k||: zero means
        // "all of it is new information". On the dead geometry that residual
        // is machine zero, so such a statistic calls it perfectly informative
        // — and STRICTLY BETTER than the isotropic control, which has a real
        // (small) overlap between orders. That inversion is the trap.
        const rel = (pair) => {
            let dn = 0, nn = 0;
            for (let e = 0; e < 9; e++) {
                dn += (pair.S[e] - pair.N[e]) ** 2;
                nn += pair.N[e] * pair.N[e];
            }
            return Math.sqrt(dn / nn);
        };
        const deadPairs = oracleIncremental(dead.dirENU, dead.times, dead.active);
        const goodPairs = oracleIncremental(good.dirENU, good.times, good.active);
        for (let k = 1; k <= 3; k++) {
            expect(rel(deadPairs[k])).toBeLessThan(1e-12);
            expect(rel(goodPairs[k])).toBeGreaterThan(rel(deadPairs[k]));
        }
    });

    test("the denominator is inert: it cancels units and nothing else", () => {
        // The whole anti-trap argument rests on tr(N_k) being a CONSTANT.
        // Every design column has unit temporal norm and tr(P_i) = 2 for a
        // unit direction, so tr(N_k) = 2 whatever the geometry does — which
        // makes the shipped statistic 1.5 * lambdaMin(S_k), an absolute
        // information floor, not a ratio that could divide the geometry out.
        // A denominator that tracked the geometry (tr(S_k), lambdaMin(N_k),
        // ...) would buy the same rescaling invariance and lose exactly that.
        for (const kind of ["arc", "isotropic", "static"]) {
            const s = makeScene(kind);
            const oracle = oracleIncremental(s.dirENU, s.times, s.active);
            const shipped = conditioningStack(s.dirENU, s.times, s.active).incrementalLog10;
            for (let k = 0; k <= 3; k++) expect(oracle[k].traceN).toBeCloseTo(2, 10);
            for (const [rung, k] of [["cv", 1], ["ca", 2], ["jerk", 3]]) {
                const lambdaMinS = Math.max(0, symmetricEigenvalues(oracle[k].S, 3)[0]);
                if (lambdaMinS <= 0) continue;                  // the static case floors
                expect(shipped[rung]).toBeCloseTo(Math.log10(1.5 * lambdaMinS), 5);
            }
        }
    });

    test("it can disagree with the rung beside it: the two measure different things", () => {
        // The joint rung keeps falling from ca to jerk on this arc because the
        // WHOLE design gets harder to invert, while the incremental number
        // says the cubic term adds nearly as much new information as the
        // quadratic did. Neither reading substitutes for the other.
        const s = makeScene("arc");
        const st = conditioningStack(s.dirENU, s.times, s.active);
        const rungDrop = st.ca - st.jerk;
        const incDrop = st.incrementalLog10.ca - st.incrementalLog10.jerk;
        expect(rungDrop).toBeGreaterThan(1);
        expect(incDrop).toBeLessThan(rungDrop / 2);
    });

    test("maxObservableOrder is still the cv/ca/jerk ladder and is not fed by the new field", () => {
        for (const platform of ["orbit-point", "straight", "curve"]) {
            const sc = generateScenario(
                baseSpec({platform: {kind: platform, speedMS: 70, altitudeAGL: 3000,
                    ...(platform === "curve" ? {bankDeg: 10} : {})}}),
                {scenarioSeed: 202});
            const {cv, ca, jerk} = sc.diagnostics.conditioningStack;
            let expected = 0;
            for (const v of [cv, ca, jerk]) {
                if (v == null || !(v >= OBSERVABLE_LOG10_RCOND)) break;
                expected++;
            }
            expect(sc.diagnostics.maxObservableOrder).toBe(expected);
        }
    });

    test("the legacy cvDesign* fields are untouched", () => {
        const sc = generateScenario(baseSpec(), {scenarioSeed: 404});
        const d = sc.diagnostics;
        expect(d.cvDesignLog10RcondObserved)
            .toBeCloseTo(Math.log10(d.cvDesignRcondObserved), 12);
        expect(d.cvDesignLog10RcondEquilibrated)
            .toBe(d.conditioningStack.cv);
        expect(typeof d.cvDesignEffectiveRank).toBe("number");
        expect(typeof d.cvDesignRcondCleanOracle).toBe("number");
        expect(typeof d.cvNormalLambdaMinOverTrace).toBe("number");
    });

    test("deterministic: identical inputs give bit-identical values", () => {
        const s = makeScene("arc");
        const a = conditioningStack(s.dirENU, s.times, s.active);
        const b = conditioningStack(s.dirENU, s.times, s.active);
        expect(b.incrementalLog10).toEqual(a.incrementalLog10);

        const g1 = generateScenario(baseSpec(), {scenarioSeed: 303});
        const g2 = generateScenario(baseSpec(), {scenarioSeed: 303});
        expect(g2.diagnostics.conditioningStack.incrementalLog10)
            .toEqual(g1.diagnostics.conditioningStack.incrementalLog10);
    });

    test("too few frames: nulls rather than a throw", () => {
        const s = makeScene("arc");
        const inc = conditioningStack(s.dirENU, s.times, [0]).incrementalLog10;
        expect(inc).toEqual({cv: null, ca: null, jerk: null});
    });
});
