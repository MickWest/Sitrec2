// diagnostics.js — the observable regime diagnostics (PLAN.md "Conditioning
// diagnostic"). The headline feature is cvDesignRcond: the reciprocal
// condition number of the COLUMN-EQUILIBRATED constant-velocity design matrix
// over the active frames, computed as sqrt(lambdaMin/lambdaMax) of
// C = D^-1/2 G D^-1/2 with G = sum B_i^T B_i, B_i = P_i [I, tau_i I],
// P_i = I - d_i d_i^T, and tau centered/normalized time. Dimensionless,
// invariant to units and time origin, comparable across 5-120 s clips, and —
// unlike sensorMotionStats — it DOES see the straight-CV sensor degeneracy.
// Never thresholded at generation time; kept continuous for the classifier.
//
// WHY the centering and the equilibration are not optional. A condition
// number is a property of a PARAMETERIZATION, not of a geometry:
// cond(A D) != cond(A) for a diagonal D, so a design matrix whose columns
// carry different physical units (metres against metre-seconds) reports the
// analyst's choice of second-versus-millisecond as if it were observability,
// and a design built on raw t rather than t - tmid reports the epoch. Both
// defects are removed here at the source: tau is centered on the active span
// and normalized to [-1, 1] (so any affine change of time variable leaves
// every entry untouched), and the normal matrix is symmetrically scaled to
// unit diagonal, which is exactly scaling each design COLUMN to unit norm.
// conditioningStack.test.js pins both invariances against a deliberately
// naive raw-basis reference that fails them by orders of magnitude. Both were
// original to this file rather than a later repair, so the legacy cvDesign*
// values are bit-for-bit what the 855-run calibration saw; the shared helpers
// below were factored out of the CV path without moving a single result.
//
// SECOND feature (design review, program step 1): a nested per-order stack.
// The CV design tests ONE dynamics order, and Fogel & Gavish 1988 is explicit
// that the CV observability conditions are necessary but not sufficient for a
// maneuvering target — a clip can pass CV conditioning and still be blind to
// the acceleration the anomaly arm exists to find. conditioningStack() walks
// CV -> CA -> jerk over the same frames and emits maxObservableOrder.

// Eigenvalues of a symmetric m x m matrix (flat row-major) by cyclic Jacobi.
export function symmetricEigenvalues(A, m) {
    const a = A.slice();
    for (let sweep = 0; sweep < 64; sweep++) {
        let off = 0;
        for (let p = 0; p < m - 1; p++)
            for (let q = p + 1; q < m; q++) off += a[p * m + q] * a[p * m + q];
        if (off < 1e-24) break;
        for (let p = 0; p < m - 1; p++) {
            for (let q = p + 1; q < m; q++) {
                const apq = a[p * m + q];
                if (Math.abs(apq) < 1e-30) continue;
                const app = a[p * m + p], aqq = a[q * m + q];
                const theta = (aqq - app) / (2 * apq);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;
                for (let k = 0; k < m; k++) {
                    const akp = a[k * m + p], akq = a[k * m + q];
                    a[k * m + p] = c * akp - s * akq;
                    a[k * m + q] = s * akp + c * akq;
                }
                for (let k = 0; k < m; k++) {
                    const apk = a[p * m + k], aqk = a[q * m + k];
                    a[p * m + k] = c * apk - s * aqk;
                    a[q * m + k] = s * apk + c * aqk;
                }
            }
        }
    }
    const ev = [];
    for (let i = 0; i < m; i++) ev.push(a[i * m + i]);
    ev.sort((x, y) => x - y);
    return ev;
}

// Centered, span-normalized time over the active frames. tau in [-1, 1] is
// what makes every statistic here immune to the units and epoch of `times`:
// an affine t -> a t + b cancels in both the centering and the scaling.
export function centeredTau(times, active) {
    let tMin = Infinity, tMax = -Infinity;
    for (const f of active) {
        if (times[f] < tMin) tMin = times[f];
        if (times[f] > tMax) tMax = times[f];
    }
    const mid = (tMin + tMax) / 2;
    const halfSpan = (tMax - tMin) / 2 || 1;
    const tau = new Float64Array(active.length);
    for (let i = 0; i < active.length; i++) tau[i] = (times[active[i]] - mid) / halfSpan;
    return tau;
}

// Equilibrate a symmetric normal matrix G (m x m, flat row-major) to
// C = D^-1/2 G D^-1/2 — i.e. scale every design COLUMN to unit norm — and
// report the design-matrix rcond sqrt(lambdaMin/lambdaMax). One code path for
// the CV field and for every stack rung, so the rungs stay comparable.
function equilibratedRcond(G, m) {
    const dinv = new Float64Array(m);
    for (let i = 0; i < m; i++) {
        const dii = G[i * m + i];
        dinv[i] = dii > 0 ? 1 / Math.sqrt(dii) : 0;
    }
    const C = new Float64Array(m * m);
    for (let i = 0; i < m; i++)
        for (let j = 0; j < m; j++) C[i * m + j] = G[i * m + j] * dinv[i] * dinv[j];

    const ev = symmetricEigenvalues(C, m);
    const lambdaMax = ev[m - 1];
    if (!(lambdaMax > 0)) {
        return {rcond: 0, log10Rcond: Math.log10(Number.MIN_VALUE), effectiveRank: 0};
    }
    const lambdaMin = Math.max(0, ev[0]);
    const rcond = Math.sqrt(lambdaMin / lambdaMax);
    return {
        rcond,
        log10Rcond: Math.log10(Math.max(rcond, Number.MIN_VALUE)),
        effectiveRank: ev.filter((e) => e > 1e-10 * lambdaMax).length,
    };
}

// dirENU: Float64Array(3n) unit directions; times: seconds; active: frame
// index iterable (post-FOV-exclusion for the observed variant).
export function cvDesignConditioning(dirENU, times, activeFrames) {
    const active = Array.from(activeFrames);
    if (active.length < 2) {
        return {rcond: null, log10Rcond: null, effectiveRank: null, lambdaMinOverTrace: null};
    }
    const taus = centeredTau(times, active);

    // G blocks: G00 = sum P, G01 = sum tau P, G11 = sum tau^2 P (P symmetric).
    const G = new Float64Array(36);
    for (let k = 0; k < active.length; k++) {
        const b = active[k] * 3;
        const dx = dirENU[b], dy = dirENU[b + 1], dz = dirENU[b + 2];
        const tau = taus[k];
        const P = [
            1 - dx * dx, -dx * dy, -dx * dz,
            -dy * dx, 1 - dy * dy, -dy * dz,
            -dz * dx, -dz * dy, 1 - dz * dz,
        ];
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                const p = P[i * 3 + j];
                G[i * 6 + j] += p;
                G[i * 6 + (j + 3)] += tau * p;
                G[(i + 3) * 6 + j] += tau * p;
                G[(i + 3) * 6 + (j + 3)] += tau * tau * p;
            }
        }
    }

    // Un-equilibrated secondary: lambdaMin(G)/trace(G).
    const evG = symmetricEigenvalues(G, 6);
    let trace = 0;
    for (let i = 0; i < 6; i++) trace += G[i * 6 + i];
    const lambdaMinOverTrace = trace > 0 ? Math.max(0, evG[0]) / trace : null;

    return {...equilibratedRcond(G, 6), lambdaMinOverTrace};
}

// --- nested per-order conditioning stack ---------------------------------
//
// Rung k models the target as a degree-k polynomial in tau: CV is k=1
// (position + velocity, 6 parameters), CA is k=2 (+ acceleration, 9), jerk is
// k=3 (+ cubic, 12). Residual block per frame B_i = P_i [phi_0(tau_i) I ...
// phi_k(tau_i) I], and the rung's statistic is the equilibrated rcond of
// G = sum B_i^T B_i exactly as for CV.
//
// The temporal basis phi_j is NOT the raw monomials. Monomials on [-1, 1] are
// strongly correlated with each other (<1, tau^2> = 2/3), so even a perfect
// isotropic geometry would score log10 rcond about -0.68 at the jerk rung
// purely from the Vandermonde overlap — the basis, not the observability.
// Column equilibration cannot fix that: it is diagonal, and this is an
// off-diagonal defect. So the monomials are orthonormalized against the ACTUAL
// active sample times first, which is a block change of variables on the
// parameter vector: it maps null spaces bijectively (a degenerate rung stays
// degenerate) while removing both the basis overlap and any sampling-density
// asymmetry, leaving a number that responds only to the direction geometry.
// An isotropic 400-sample control then measures -0.03 / -0.05 / -0.08 across
// the three rungs instead of trailing off to -0.68, which is what makes ONE
// threshold meaningful for all three.
const STACK_MAX_ORDER = 3;

// ANCHORING (2026-08-15), not a recalibration. The 855-run fit sweep behind
// the legacy -3 / -2 / -1 => 84% / 8% / 0% collapse bands cannot be re-run
// here, so no outcome was refitted and no band was moved. What WAS measured is
// the relation between the two scales, over the 26 tractability scenarios
// (10 real-segment case geometries, the 10 maneuver shapes, the 6-cell
// GEO-DURATION ladder) regenerated through generateScenario:
//
//   CV rung vs the legacy field: identical. |cv - cvDesignLog10RcondObserved|
//   had median 5.8e-14 and max 1.0e-10 across all 26. That is not a
//   coincidence — with a uniformly sampled active span the sample-orthonormal
//   basis differs from the centered monomials only by a per-column scale,
//   which equilibration then divides out. The two part company only when the
//   ACTIVE samples are asymmetrically distributed in tau: a 211-of-601
//   mid-gap FOV mask on the 60 s ladder cell gave legacy -2.1998 against
//   cv -2.1867, the legacy number paying 0.013 for a constant/linear column
//   correlation that is an artifact of the mask, not of the geometry. None of
//   the 26 exercise that (all had every frame in FOV).
//   => the legacy CV band transfers to the cv rung unchanged, which is why
//      the floor below is -3.
//
//   Higher rungs sit LOWER on the same clip, by a scenario-dependent amount
//   that is nothing like a constant: ca - cv spanned -1.604 to -0.001
//   (median -0.307) and jerk - cv spanned -2.024 to -0.015 (median -0.508).
//   => there is no offset that converts a legacy band into a ca or jerk band.
//      Applying -3 to those rungs, as the ladder below does, is an assumption
//      resting on the shared orthonormal footing, NOT a measured collapse
//      rate. It is provisional until a per-order fit sweep exists.
//
// The resulting order histogram over the 26 was {0: 6, 1: 3, 2: 2, 3: 15}, and
// it separates cases the CV number alone could not: the 60 s orbit ladder cell
// is comfortably observable at CV (-1.94) and dead at CA (-3.14), which is the
// Fogel & Gavish necessary-but-not-sufficient result showing up in this data.
export const OBSERVABLE_LOG10_RCOND = -3;

// Modified Gram-Schmidt of 1, tau, tau^2, ... over the active samples, with
// the classic second orthogonalization pass (one sweep loses orthogonality on
// the near-dependent high monomials). Stops early when the sample times
// cannot support the next degree at all — three distinct instants can carry a
// quadratic and nothing above it — so the caller learns the highest order the
// SAMPLING admits before any geometry enters.
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
        // Monomial columns start with norm <= sqrt(n) since |tau| <= 1, so the
        // tolerance is relative to that.
        if (!(nrm > 1e-10 * Math.sqrt(n))) break;
        for (let i = 0; i < n; i++) v[i] /= nrm;
        cols.push(v);
    }
    return cols;
}

// Returns {cv, ca, jerk} as log10 rcond per rung (null where the sampling
// cannot support the order) plus maxObservableOrder: the highest rung that
// passes OBSERVABLE_LOG10_RCOND with every rung below it also passing. It is
// a LADDER by construction: Cauchy interlacing makes the RAW Gram's rcond
// monotone non-increasing in the order (each rung's Gram is the leading
// principal block of the next), but equilibration is applied afterwards and
// does not preserve that ordering, so a higher rung scoring above a failed
// lower one is scaling noise, not evidence of observability. 0 means "not even
// constant velocity"; null means the frames were too few to say anything.
export function conditioningStack(dirENU, times, activeFrames) {
    const active = Array.from(activeFrames);
    const unknown = {cv: null, ca: null, jerk: null, maxObservableOrder: null};
    if (active.length < 2) return unknown;

    const cols = orthonormalTimeBasis(centeredTau(times, active), STACK_MAX_ORDER);
    const K = cols.length - 1;
    if (K < 1) return unknown;

    // Moments M[j][l] = sum_i phi_j(i) phi_l(i) P_i, one symmetric 3x3 per
    // basis pair. Because the basis is nested, the order-k Gram is literally
    // the leading (k+1)x(k+1) block of the order-K one — accumulate once.
    const M = [];
    for (let j = 0; j <= K; j++) {
        M.push([]);
        for (let l = 0; l <= K; l++) M[j].push(new Float64Array(9));
    }
    for (let i = 0; i < active.length; i++) {
        const b = active[i] * 3;
        const dx = dirENU[b], dy = dirENU[b + 1], dz = dirENU[b + 2];
        const P = [
            1 - dx * dx, -dx * dy, -dx * dz,
            -dy * dx, 1 - dy * dy, -dy * dz,
            -dz * dx, -dz * dy, 1 - dz * dz,
        ];
        for (let j = 0; j <= K; j++) {
            for (let l = j; l <= K; l++) {
                const w = cols[j][i] * cols[l][i];
                const acc = M[j][l];
                for (let e = 0; e < 9; e++) acc[e] += w * P[e];
            }
        }
    }

    const log10 = [null, null, null, null];
    for (let k = 1; k <= K; k++) {
        const m = 3 * (k + 1);
        const G = new Float64Array(m * m);
        for (let j = 0; j <= k; j++) {
            for (let l = 0; l <= k; l++) {
                // Block (l,j) equals block (j,l): the weights commute and P is
                // symmetric, so no transpose is needed.
                const blk = j <= l ? M[j][l] : M[l][j];
                for (let r = 0; r < 3; r++)
                    for (let c = 0; c < 3; c++) G[(j * 3 + r) * m + (l * 3 + c)] = blk[r * 3 + c];
            }
        }
        log10[k] = equilibratedRcond(G, m).log10Rcond;
    }

    let maxObservableOrder = 0;
    for (let k = 1; k <= K; k++) {
        if (log10[k] == null || !(log10[k] >= OBSERVABLE_LOG10_RCOND)) break;
        maxObservableOrder = k;
    }
    return {cv: log10[1], ca: log10[2], jerk: log10[3], maxObservableOrder};
}

// Observable LOS-series features (classifier inputs — computed from the
// OBSERVED sightlines over active frames only; no truth anywhere):
//  - losSweepDeg: total angle between first and last active direction
//  - losMeanRateDegPerS: mean per-step angular rate
//  - losLag1Autocorr: lag-1 Pearson autocorrelation of the step magnitudes —
//    white pointing error decorrelates steps; operator wobble correlates them.
export function losSeriesFeatures(dirENU, times, activeFrames) {
    const active = Array.from(activeFrames);
    if (active.length < 3) {
        return {losSweepDeg: null, losMeanRateDegPerS: null, losLag1Autocorr: null};
    }
    const RAD2DEG = 180 / Math.PI;
    const ang = (a, b) => {
        const dot = Math.max(-1, Math.min(1,
            dirENU[a * 3] * dirENU[b * 3]
            + dirENU[a * 3 + 1] * dirENU[b * 3 + 1]
            + dirENU[a * 3 + 2] * dirENU[b * 3 + 2]));
        return Math.acos(dot) * RAD2DEG;
    };
    const steps = [];
    for (let i = 1; i < active.length; i++) {
        const dt = times[active[i]] - times[active[i - 1]];
        if (dt > 0) steps.push(ang(active[i - 1], active[i]) / dt);
    }
    let lag1 = null;
    if (steps.length >= 3) {
        const m = steps.reduce((a, b) => a + b, 0) / steps.length;
        let num = 0, den = 0;
        for (let i = 0; i < steps.length; i++) {
            den += (steps[i] - m) ** 2;
            if (i > 0) num += (steps[i] - m) * (steps[i - 1] - m);
        }
        lag1 = den > 1e-20 ? num / den : null;
    }
    return {
        losSweepDeg: ang(active[0], active[active.length - 1]),
        losMeanRateDegPerS: steps.length
            ? steps.reduce((a, b) => a + b, 0) / steps.length : null,
        losLag1Autocorr: lag1,
    };
}

export function sensorPathStats(positionENU, n) {
    let len = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let f = 0; f < n; f++) {
        const b = f * 3;
        const x = positionENU[b], y = positionENU[b + 1], z = positionENU[b + 2];
        if (f > 0) {
            len += Math.hypot(x - positionENU[b - 3], y - positionENU[b - 2], z - positionENU[b - 1]);
        }
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return {
        sensorPathLengthM: len,
        sensorSpanM: Math.hypot(maxX - minX, maxY - minY, maxZ - minZ),
    };
}
