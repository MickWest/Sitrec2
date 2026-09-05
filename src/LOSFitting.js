/**
 * LOSFitting.js — Global LOS Trajectory Fitting Algorithms
 *
 * Ported from lostool/web/js/trajectory.js.
 * The fitters themselves are pure math. The Sitrec adapter functions near the
 * end of the file depend on Three.js and Sitrec's coordinate/time globals.
 *
 * The math functions operate on flat Float32Array or Float64Array data in a
 * local Cartesian coordinate system (typically ENU). LOS directions must be
 * unit vectors; callers supplying raw data are responsible for conversion and
 * normalization. Frame indices in `excluded` are relative to this dataset,
 * not necessarily to the source video's absolute frame numbers.
 *
 * Dataset format:
 *   {
 *     sensorPos: Float32Array|Float64Array, // stride-3 sensor positions
 *     losDir:    Float32Array|Float64Array, // stride-3 unit direction vectors
 *     times:     Float64Array,  // per-frame timestamps (seconds)
 *     count:     number,        // number of frames
 *     minRange:  number|null,    // optional common minimum range (metres)
 *     maxRange:  Float32Array|Float64Array|null, // optional per-frame maximum
 *   }
 *
 * Most fits return {positions, residuals, params, activeCount}. Positions are
 * stride-3 local coordinates for every dataset frame; excluded frames are
 * still populated but have NaN residuals. Residual units are family-specific:
 * CV, CA, and Kalman use perpendicular metres, while Monte Carlo, alternating
 * LSQ, and physics fits use angular radians. Callers must not compare these raw
 * arrays without converting to a common metric.
 *
 * Glossary (terms have their meaning in this module):
 *
 *   Active frame — A frame whose observation participates in a fit; an
 *     `excluded` frame is still given an output position but has no influence
 *     on the fitted parameters and normally keeps a NaN residual.
 *   Batch fit — A fit that uses the complete set of active observations at
 *     once, rather than updating an estimate as each frame arrives.
 *   Bound / pinned parameter — A bound is an allowed minimum or maximum. A
 *     fitted parameter is pinned when the best result presses against one and
 *     moving inward makes the fit materially worse.
 *   CA (constant acceleration) — Motion with one fixed 3D acceleration vector:
 *     P(t)=P0+Vt+0.5At^2. It has nine fitted components: P0, V, and A.
 *   Conditioning / rcond — How sensitive a linear solution is to small input
 *     errors. `rcond` is an estimated reciprocal condition number: values near
 *     zero mean weak geometry and a potentially unstable range solution.
 *   Covariance — A matrix describing estimated uncertainty in state variables
 *     and how errors in those variables vary together.
 *   CV (constant velocity) — Straight-line motion with fixed 3D velocity:
 *     P(t)=P0+Vt. It has six fitted components: P0 and V.
 *   DE (differential evolution) — A population-based global optimizer that
 *     combines existing candidates to explore a bounded parameter space.
 *   Design matrix — The rectangular matrix A that maps unknown parameters x
 *     to predicted observations Ax in a linear model.
 *   ECEF (Earth-Centered, Earth-Fixed) — A global Cartesian coordinate system
 *     whose origin is Earth's center and whose axes rotate with Earth.
 *   ENU (East, North, Up) — A local Cartesian tangent frame used here so the
 *     fitting coordinates remain small and have intuitive metre-scale axes.
 *   Float32Array / Float64Array — JavaScript numeric arrays with fixed 32-bit
 *     or 64-bit floating-point precision; Float64 retains more significant
 *     digits.
 *   Fit / fitted trajectory — The model parameters, and resulting positions,
 *     chosen to minimize the selected mismatch and plausibility costs.
 *   Gaussian elimination with partial pivoting — A direct linear-system solve
 *     that swaps in a numerically safer pivot before eliminating each column.
 *   Gram matrix — The square matrix A^T A, which gathers how the columns of a
 *     design matrix constrain and couple the unknown parameters.
 *   Kalman filter — A recursive state estimator that alternates a motion-model
 *     prediction with a measurement correction, carrying uncertainty forward.
 *   LOS (line of sight) — The measured unit direction from the sensor toward
 *     the target. It supplies a bearing but no target distance by itself.
 *   LOS ray / supporting line — The ray begins at the sensor and extends only
 *     forward; its supporting line extends in both directions. Perpendicular
 *     line distance alone cannot tell whether a fitted point is behind the
 *     sensor.
 *   LSQ (least squares) — Choose parameters that minimize the sum of squared
 *     residual components across all active observations.
 *   Macrotask yield — Briefly return control to the browser event loop so UI
 *     updates and cancellation can run during a long optimizer search.
 *   Monte Carlo fit — Generate many random candidate data realizations and
 *     retain the best-scoring result. Fixed seeds make these fits repeatable.
 *   NaN (Not a Number) — The floating-point marker used here when a residual
 *     is deliberately unavailable, especially at an excluded frame.
 *   Nelder-Mead / polish — Nelder-Mead is a derivative-free local search over
 *     a simplex (a small set of nearby parameter vectors); here it can refine,
 *     or "polish," DE's best candidate.
 *   Normal equations — The compact linear system A^T A x=A^T b whose solution
 *     gives the ordinary least-squares parameters without explicitly inverting
 *     A.
 *   Observability / identifiability — Whether the observations and model make
 *     a state or parameter distinguishable from alternatives. More frames do
 *     not resolve a parameter if they repeat essentially the same geometry.
 *   Prior / extra cost — A soft plausibility preference added to measurement
 *     error; it can select among LOS-compatible solutions but is not new data.
 *   Polynomial order / degree — The highest time power in a polynomial; order
 *     k uses k+1 coefficients, from the constant term through t^k.
 *   Projection / ray filter — M=I-dd^T removes the component parallel to unit
 *     LOS d, retaining only the sideways component that a bearing constrains.
 *   Pseudo-linear — The original bearing/range relation is nonlinear, but the
 *     ray filter makes it linear in target state when measured d is treated as
 *     known.
 *   Process noise / measurement noise — Kalman covariance terms controlling,
 *     respectively, permitted departures from the motion model and trust in
 *     LOS data.
 *   Range / signed range — Distance along an LOS. Signed range is positive in
 *     the measured direction, zero at the sensor, and negative behind it.
 *   RANSAC-style — Build candidates from small random subsets and score them on
 *     all data. The Monte Carlo 1 fit resembles RANSAC but uses mean error, not
 *     a formal inlier/outlier consensus.
 *   Residual — The mismatch left after fitting. In this file it is reported as
 *     either perpendicular distance in metres or angular separation in radians
 *     (pi radians is 180 degrees).
 *   RK4 (fourth-order Runge-Kutta) — A numerical method that advances a physics
 *     state through time by sampling its derivatives four times per step.
 *   RTS (Rauch-Tung-Striebel) smoother — A backward pass over Kalman results
 *     that lets later observations refine state estimates at earlier frames.
 *   Soft constraint — A preference enforced with a large cost rather than an
 *     absolute rule; a sufficiently expensive competing error can still
 *     violate it.
 *   State vector — The ordered numerical variables describing a model at one
 *     time, such as [position, velocity] for the Kalman smoother.
 *   Stride-3 array — A flat array storing each 3D vector in three consecutive
 *     entries: x,y,z for frame 0, then x,y,z for frame 1, and so on.
 *   Unit vector — A vector of length one; this makes its dot product with a
 *     displacement equal the signed distance along that direction.
 *   Vandermonde matrix — A polynomial design matrix whose row contains powers
 *     of one sample time: [1,t,t^2,...].
 */

import {integrateRK4} from "./PhysicsModel";
import {assessBoundPins} from "./BoundedFit";

// ---------------------------------------------------------------------------
// Linear algebra helpers
// ---------------------------------------------------------------------------

// Gaussian elimination with partial pivoting. This deliberately mutates A and
// b while reducing them; callers that need to preserve normal equations pass
// copies. null means the system is singular at the scale used by this module.
function _solveLinearSystem(A, b) {
    const n = b.length;
    for (let col = 0; col < n; col++) {
        let maxVal = Math.abs(A[col][col]);
        let maxRow = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(A[row][col]) > maxVal) {
                maxVal = Math.abs(A[row][col]);
                maxRow = row;
            }
        }
        if (maxVal < 1e-14) return null;
        [A[col], A[maxRow]] = [A[maxRow], A[col]];
        [b[col], b[maxRow]] = [b[maxRow], b[col]];
        for (let row = col + 1; row < n; row++) {
            const factor = A[row][col] / A[col][col];
            for (let k = col; k < n; k++) A[row][k] -= factor * A[col][k];
            b[row] -= factor * b[col];
        }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
        x[i] = b[i];
        for (let j = i + 1; j < n; j++) x[i] -= A[i][j] * x[j];
        x[i] /= A[i][i];
    }
    return x;
}

// Macrotask yield immune to background-tab timer throttling (see AnalyzeTraverse
// makeYield). Used to keep the async DE fit responsive without setTimeout.
const _macroYield = (() => {
    // Node also exposes MessageChannel, but keeping one at module scope is
    // reported as an open async handle by test runners. setImmediate provides
    // the same macrotask boundary there without a persistent resource.
    const isNode = typeof globalThis !== "undefined" && !!globalThis.process?.versions?.node;
    if (isNode && typeof globalThis.setImmediate === "function") {
        return () => new Promise((resolve) => globalThis.setImmediate(resolve));
    }
    if (typeof MessageChannel === "undefined") {
        return () => new Promise((resolve) => setTimeout(resolve, 0));
    }
    const channel = new MessageChannel();
    const pending = [];
    channel.port1.onmessage = () => pending.shift()?.();
    return () => new Promise((resolve) => { pending.push(resolve); channel.port2.postMessage(0); });
})();

// Perpendicular distance to the infinite line supporting the LOS ray. It does
// not distinguish a point in front of the sensor from one behind it; signed
// range limits are handled separately by _solveSoftConstrained or diagnostics.
function _pointToRayDistance(P, O, D) {
    const dx = P[0] - O[0], dy = P[1] - O[1], dz = P[2] - O[2];
    const proj = dx * D[0] + dy * D[1] + dz * D[2];
    const px = dx - proj * D[0], py = dy - proj * D[1], pz = dz - proj * D[2];
    return Math.sqrt(px * px + py * py + pz * pz);
}

// ---------------------------------------------------------------------------
// Soft-constrained normal-equation solver
// ---------------------------------------------------------------------------

function _solveSoftConstrained(AtA, Atb, nUnknowns, active, dataset, rowFn, t0) {
    const {sensorPos, losDir, times, maxRange} = dataset;
    // Optional dataset.minRange (meters): treat lambda < minRange as a
    // violation with target = minRange. These fits minimize PERPENDICULAR
    // distance to the rays, and the sensor's own path is a zero-residual
    // solution whenever the sensor flies a CV/CA-representable trajectory —
    // a free fit on a straight-and-level sensor collapses onto the sensor
    // itself (~90 deg angular "fit"). Callers that need a genuinely free fit
    // but not that degenerate optimum (e.g. the noise-floor estimate in
    // AnalyzeTraverse) set minRange; existing callers are unaffected.
    const minRange = dataset.minRange ?? null;
    const PENALTY = 1e4;

    // First solve the unconstrained least-squares problem. For a fitted point
    // p and unit LOS d from sensor s, signed range is lambda = d·(p-s).
    // rowFn supplies the coefficients of d·p for the chosen motion model.
    const sol = _solveLinearSystem(AtA.map(r => r.slice()), Atb.slice());
    if (!sol) return null;

    const violations = [];
    for (const idx of active) {
        const b = idx * 3;
        const {lambdaRow} = rowFn(idx, times[idx] - t0);
        const dDotS = losDir[b] * sensorPos[b] +
            losDir[b + 1] * sensorPos[b + 1] +
            losDir[b + 2] * sensorPos[b + 2];
        let lambda = -dDotS;
        for (let k = 0; k < nUnknowns; k++) lambda += lambdaRow[k] * sol[k];

        let target = null;
        if (minRange !== null && lambda < minRange) {
            target = minRange;
        } else if (lambda < 0) {
            target = 0;
        } else if (maxRange) {
            const mr = maxRange[idx];
            if (mr > 0 && lambda > mr) target = mr;
        }
        if (target !== null) violations.push({lambdaRow, dDotS, target});
    }

    if (violations.length === 0) return sol;

    // This is intentionally a soft, one-pass correction rather than a hard
    // active-set/QP solve: every range violation found in the free solution is
    // added as a heavily weighted equality at its nearest allowed boundary.
    // The resulting trajectory remains a global CV/CA curve instead of being
    // clipped independently frame by frame.
    const A2 = AtA.map(r => r.slice());
    const b2 = Atb.slice();
    for (const {lambdaRow: r, dDotS, target} of violations) {
        const rhs = dDotS + target;
        for (let i = 0; i < nUnknowns; i++) {
            for (let j = 0; j < nUnknowns; j++) A2[i][j] += PENALTY * r[i] * r[j];
            b2[i] += PENALTY * rhs * r[i];
        }
    }
    return _solveLinearSystem(A2, b2);
}

// ---------------------------------------------------------------------------
// Constant Velocity Least Squares Fit
// ---------------------------------------------------------------------------

/**
 * Recover one straight 3D track with a direct pseudo-linear batch least-squares
 * solve. For frame i, the known data are time t_i, camera/sensor position C_i,
 * and unit LOS direction d_i; range along d_i is unknown.
 *
 * The implementation follows this chain:
 *
 *   1. x = [P0,V] describes every candidate constant-velocity track.
 *   2. T_i x = P0 + t_i V evaluates that track at frame i.
 *   3. M_i = I-d_i d_i^T removes the unknown along-ray component.
 *   4. A_i = M_i T_i and b_i = M_i C_i give A_i x ≈ b_i.
 *   5. Accumulate every frame directly into A^T A and A^T b.
 *   6. Solve the six normal equations, then evaluate P0+tV at every frame.
 *
 * A_i x-b_i is the sideways miss from the candidate point to the LOS. Each
 * per-frame 3-row block has only two independent constraints because M_i removes
 * the LOS direction. This is a direct linear solve, not an iterative trajectory
 * search; uniqueness still depends on the observer motion providing enough
 * parallax for the six columns of A to be independent.
 */
export function fitConstantVelocity(dataset, excluded) {
    const {sensorPos, losDir, times, count} = dataset;

    const active = [];
    for (let i = 0; i < count; i++) {
        if (!excluded.has(i)) active.push(i);
    }
    if (active.length < 2) return null;

    // Shift time so P0 is the position at the first active frame. This preserves
    // the derivation above while avoiding unnecessarily large absolute times.
    const t0 = times[active[0]];
    const AtA = Array.from({length: 6}, () => new Array(6).fill(0));
    const Atb = new Array(6).fill(0);

    for (const idx of active) {
        const b = idx * 3;
        const ti = times[idx] - t0;
        const sx = sensorPos[b], sy = sensorPos[b + 1], sz = sensorPos[b + 2];
        const dx = losDir[b], dy = losDir[b + 1], dz = losDir[b + 2];

        // Components of the explainer's ray-filter matrix M_i = I-d_i d_i^T.
        const p00 = 1 - dx * dx, p01 = -dx * dy, p02 = -dx * dz;
        const p10 = -dy * dx, p11 = 1 - dy * dy, p12 = -dy * dz;
        const p20 = -dz * dx, p21 = -dz * dy, p22 = 1 - dz * dz;

        // `rows` is the 3x6 block A_i=M_i*T_i; `rhs` is b_i=M_i*C_i.
        const rows = [
            [p00, p01, p02, p00 * ti, p01 * ti, p02 * ti],
            [p10, p11, p12, p10 * ti, p11 * ti, p12 * ti],
            [p20, p21, p22, p20 * ti, p21 * ti, p22 * ti],
        ];
        const rhs = [
            p00 * sx + p01 * sy + p02 * sz,
            p10 * sx + p11 * sy + p12 * sz,
            p20 * sx + p21 * sy + p22 * sz,
        ];

        // Add A_i^T A_i and A_i^T b_i directly. Stacking all A_i/b_i first
        // would produce the same normal equations but require a 3N-row matrix.
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 6; c++) {
                for (let k = 0; k < 6; k++) AtA[c][k] += rows[r][c] * rows[r][k];
                Atb[c] += rows[r][c] * rhs[r];
            }
        }
    }

    // d·p(t) is linear in [P0,V]; the shared constraint solver subtracts
    // d·s to turn this into the signed range along the ray.
    function cvLambdaRow(idx, ti) {
        const b = idx * 3;
        const dx = losDir[b], dy = losDir[b + 1], dz = losDir[b + 2];
        return {lambdaRow: [dx, dy, dz, dx * ti, dy * ti, dz * ti]};
    }

    const solution = _solveSoftConstrained(AtA, Atb, 6, active, dataset, cvLambdaRow, t0);
    if (!solution) return null;

    const P0 = [solution[0], solution[1], solution[2]];
    const V = [solution[3], solution[4], solution[5]];

    // Float64: these are ENU positions (tens of km). float32 quantizes them to
    // ~1 cm, and the g-force graph (a second difference x fps^2) turns that into
    // a residual ~0.7 g sawtooth. Float64 keeps a constant-velocity fit's track
    // a true straight line, so its acceleration graph reads flat ~0.
    const positions = new Float64Array(count * 3);
    const residuals = new Float32Array(count).fill(NaN);

    for (let i = 0; i < count; i++) {
        const ti = times[i] - t0;
        const fx = P0[0] + V[0] * ti, fy = P0[1] + V[1] * ti, fz = P0[2] + V[2] * ti;
        positions[i * 3] = fx;
        positions[i * 3 + 1] = fy;
        positions[i * 3 + 2] = fz;
        if (!excluded.has(i)) {
            const b = i * 3;
            residuals[i] = _pointToRayDistance(
                [fx, fy, fz],
                [sensorPos[b], sensorPos[b + 1], sensorPos[b + 2]],
                [losDir[b], losDir[b + 1], losDir[b + 2]],
            );
        }
    }
    return {positions, residuals, params: {P0, V}, activeCount: active.length};
}

// ---------------------------------------------------------------------------
// Constant Acceleration Least Squares Fit
// ---------------------------------------------------------------------------

export function fitConstantAcceleration(dataset, excluded) {
    const {sensorPos, losDir, times, count} = dataset;

    const active = [];
    for (let i = 0; i < count; i++) {
        if (!excluded.has(i)) active.push(i);
    }
    if (active.length < 3) return null;

    // This extends the CV ray-filter derivation to x=[P0,V,A], giving nine
    // unknowns. Use dimensionless tau in [0,1] while solving so the position,
    // and acceleration columns have comparable magnitudes on long clips. The
    // solved tau coefficients are converted back to metres/second units below.
    const t0 = times[active[0]];
    const tLast = times[active[active.length - 1]];
    const T_span = tLast - t0 || 1;

    const AtA = Array.from({length: 9}, () => new Array(9).fill(0));
    const Atb = new Array(9).fill(0);

    for (const idx of active) {
        const b = idx * 3;
        const tau = (times[idx] - t0) / T_span;
        const tau2 = 0.5 * tau * tau;
        const sx = sensorPos[b], sy = sensorPos[b + 1], sz = sensorPos[b + 2];
        const dx = losDir[b], dy = losDir[b + 1], dz = losDir[b + 2];

        const p00 = 1 - dx * dx, p01 = -dx * dy, p02 = -dx * dz;
        const p10 = -dy * dx, p11 = 1 - dy * dy, p12 = -dy * dz;
        const p20 = -dz * dx, p21 = -dz * dy, p22 = 1 - dz * dz;

        const rows = [
            [p00, p01, p02, p00 * tau, p01 * tau, p02 * tau, p00 * tau2, p01 * tau2, p02 * tau2],
            [p10, p11, p12, p10 * tau, p11 * tau, p12 * tau, p10 * tau2, p11 * tau2, p12 * tau2],
            [p20, p21, p22, p20 * tau, p21 * tau, p22 * tau, p20 * tau2, p21 * tau2, p22 * tau2],
        ];
        const rhs = [
            p00 * sx + p01 * sy + p02 * sz,
            p10 * sx + p11 * sy + p12 * sz,
            p20 * sx + p21 * sy + p22 * sz,
        ];

        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 9; c++) {
                for (let k = 0; k < 9; k++) AtA[c][k] += rows[r][c] * rows[r][k];
                Atb[c] += rows[r][c] * rhs[r];
            }
        }
    }

    function caLambdaRow(idx, _ti) {
        const b = idx * 3;
        const dx = losDir[b], dy = losDir[b + 1], dz = losDir[b + 2];
        const tau = (times[idx] - t0) / T_span;
        const tau2 = 0.5 * tau * tau;
        return {lambdaRow: [dx, dy, dz, dx * tau, dy * tau, dz * tau, dx * tau2, dy * tau2, dz * tau2]};
    }

    const solution = _solveSoftConstrained(AtA, Atb, 9, active, dataset, caLambdaRow, t0);
    if (!solution) return null;

    // In tau coordinates the polynomial is P0 + Vtau*tau + 0.5*Atau*tau^2.
    // Since tau=(t-t0)/T_span, divide once by T_span for velocity and twice for
    // acceleration to recover physical derivatives with respect to seconds.
    const P0 = [solution[0], solution[1], solution[2]];
    const V = [solution[3] / T_span, solution[4] / T_span, solution[5] / T_span];
    const A = [solution[6] / (T_span * T_span), solution[7] / (T_span * T_span), solution[8] / (T_span * T_span)];

    // Float64: centimetre-scale Float32 quantization at ENU scene magnitudes is
    // greatly amplified by downstream second-difference acceleration graphs.
    // Keeping the analytic CA curve in Float64 prevents that display artifact.
    const positions = new Float64Array(count * 3);
    const residuals = new Float32Array(count).fill(NaN);

    for (let i = 0; i < count; i++) {
        const ti = times[i] - t0;
        const ti2 = 0.5 * ti * ti;
        const fx = P0[0] + V[0] * ti + A[0] * ti2;
        const fy = P0[1] + V[1] * ti + A[1] * ti2;
        const fz = P0[2] + V[2] * ti + A[2] * ti2;
        positions[i * 3] = fx;
        positions[i * 3 + 1] = fy;
        positions[i * 3 + 2] = fz;
        if (!excluded.has(i)) {
            const b = i * 3;
            residuals[i] = _pointToRayDistance(
                [fx, fy, fz],
                [sensorPos[b], sensorPos[b + 1], sensorPos[b + 2]],
                [losDir[b], losDir[b + 1], losDir[b + 2]],
            );
        }
    }
    return {positions, residuals, params: {P0, V, A}, activeCount: active.length};
}

// ---------------------------------------------------------------------------
// Monte Carlo 1 — RANSAC-style: pick minimal random samples, fit exactly
// ---------------------------------------------------------------------------

// Deterministic PRNG (mulberry32) so the Monte-Carlo fits are reproducible: the
// same LOS + options always yield the same trajectory. That lets them be cached
// and used as stable traverse-analysis contenders (and makes the on-screen
// Global Fit: Monte Carlo traverses repeatable). Pass options.seed to vary the
// draw deliberately.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const MC_DEFAULT_SEED = 0x5eed1234;

export function fitMonteCarlo(dataset, excluded, options = {}) {
    const {sensorPos, losDir, times, count} = dataset;

    const order = Math.max(1, Math.round(options.order ?? 1));
    const losUncertDeg = options.losUncertaintyDeg ?? 2;
    const losUncertRad = losUncertDeg * (Math.PI / 180);
    const numTrials = Math.max(1, Math.round(options.numTrials ?? 500));
    const rng = mulberry32((options.seed ?? MC_DEFAULT_SEED) >>> 0);

    // Per-frame range estimates from a prior fit (e.g. CV). When provided,
    // random range sampling is centered on these values (0.9x to 1.1x) instead
    // of sampling blindly from [0, maxDistance].
    const rangeEstimates = options.rangeEstimates ?? null;

    // With no explicit search range, use ten times the sensor track's largest
    // axis span. This is only a search-domain heuristic; maxRange, when present,
    // still narrows individual frames below it.
    let maxDistance = options.maxDistance;
    if (maxDistance == null) {
        let sceneExtent = 1;
        if (count > 0) {
            let minX = Infinity, maxX = -Infinity;
            let minY = Infinity, maxY = -Infinity;
            let minZ = Infinity, maxZ = -Infinity;
            for (let i = 0; i < count; i++) {
                const b = i * 3;
                if (sensorPos[b] < minX) minX = sensorPos[b];
                if (sensorPos[b] > maxX) maxX = sensorPos[b];
                if (sensorPos[b + 1] < minY) minY = sensorPos[b + 1];
                if (sensorPos[b + 1] > maxY) maxY = sensorPos[b + 1];
                if (sensorPos[b + 2] < minZ) minZ = sensorPos[b + 2];
                if (sensorPos[b + 2] > maxZ) maxZ = sensorPos[b + 2];
            }
            sceneExtent = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
        }
        maxDistance = sceneExtent * 10;
    }

    const active = [];
    for (let i = 0; i < count; i++) {
        if (!excluded.has(i)) active.push(i);
    }
    const needed = order + 1;
    if (active.length < needed) return null;

    const t0 = times[active[0]];

    // Rodrigues' formula: rotate v about the unit axis a by theta.
    function _rotate(vx, vy, vz, ax, ay, az, theta) {
        const cosT = Math.cos(theta), sinT = Math.sin(theta);
        const dot = ax * vx + ay * vy + az * vz;
        const cx = ay * vz - az * vy, cy = az * vx - ax * vz, cz = ax * vy - ay * vx;
        return [
            vx * cosT + cx * sinT + ax * dot * (1 - cosT),
            vy * cosT + cy * sinT + ay * dot * (1 - cosT),
            vz * cosT + cz * sinT + az * dot * (1 - cosT),
        ];
    }

    // Construct a stable unit vector perpendicular to d by crossing it with
    // whichever coordinate axis is least parallel to it.
    function _perpUnit(dx, dy, dz) {
        const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
        let ux = 0, uy = 0, uz = 0;
        if (ax <= ay && ax <= az) ux = 1;
        else if (ay <= ax && ay <= az) uy = 1;
        else uz = 1;
        let px = dy * uz - dz * uy, py = dz * ux - dx * uz, pz = dx * uy - dy * ux;
        const len = Math.sqrt(px * px + py * py + pz * pz);
        return [px / len, py / len, pz / len];
    }

    // A trial chooses exactly order+1 points, so the square Vandermonde solve
    // interpolates those samples rather than performing a least-squares fit.
    function _fitPoly1D(ts, ys) {
        const n = ts.length;
        const V = [];
        for (let i = 0; i < n; i++) {
            const row = [];
            let pw = 1;
            for (let j = 0; j < n; j++) { row.push(pw); pw *= ts[i]; }
            V.push(row);
        }
        return _solveLinearSystem(V, ys.slice());
    }

    function _evalPoly(coeffs, t) {
        let val = 0, pw = 1;
        for (let k = 0; k < coeffs.length; k++) { val += coeffs[k] * pw; pw *= t; }
        return val;
    }

    function _angularError(fx, fy, fz, sx, sy, sz, dx, dy, dz) {
        let rx = fx - sx, ry = fy - sy, rz = fz - sz;
        const rlen = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (rlen < 1e-12) return Math.PI;
        rx /= rlen; ry /= rlen; rz /= rlen;
        const dot = Math.max(-1, Math.min(1, rx * dx + ry * dy + rz * dz));
        return Math.acos(dot);
    }

    let bestScore = Infinity;
    let bestCoeffsX = null, bestCoeffsY = null, bestCoeffsZ = null;

    // Each trial turns a minimal set of uncertain rays into concrete 3D points,
    // interpolates one time polynomial per axis, then scores that candidate on
    // every active LOS. This is RANSAC-like sampling, but the score is mean
    // angular error rather than an inlier count.
    for (let trial = 0; trial < numTrials; trial++) {
        const pool = active.slice();
        const chosen = [];
        for (let k = 0; k < needed; k++) {
            const idx = k + Math.floor(rng() * (pool.length - k));
            [pool[k], pool[idx]] = [pool[idx], pool[k]];
            chosen.push(pool[k]);
        }

        const sampleTs = [], sampleX = [], sampleY = [], sampleZ = [];
        for (const fi of chosen) {
            const b = fi * 3;
            const sx = sensorPos[b], sy = sensorPos[b + 1], sz = sensorPos[b + 2];
            const dx = losDir[b], dy = losDir[b + 1], dz = losDir[b + 2];

            let pdx, pdy, pdz;
            if (losUncertRad > 1e-10) {
                // Pick a random azimuth around the measured LOS, then tilt by
                // an angle uniformly sampled from zero to the uncertainty cap.
                const theta = rng() * losUncertRad;
                const [ex, ey, ez] = _perpUnit(dx, dy, dz);
                const phi = rng() * 2 * Math.PI;
                const [rx2, ry2, rz2] = _rotate(ex, ey, ez, dx, dy, dz, phi);
                [pdx, pdy, pdz] = _rotate(dx, dy, dz, rx2, ry2, rz2, theta);
            } else {
                [pdx, pdy, pdz] = [dx, dy, dz];
            }

            let lambda;
            if (rangeEstimates) {
                // Sample within 0.9x to 1.1x of the estimated range
                const est = rangeEstimates[fi];
                lambda = est * (0.9 + rng() * 0.2);
            } else {
                let effectiveMax = maxDistance;
                if (dataset.maxRange) {
                    const mr = dataset.maxRange[fi];
                    if (mr > 0) effectiveMax = Math.min(effectiveMax, mr);
                }
                lambda = rng() * effectiveMax;
            }

            sampleTs.push(times[fi] - t0);
            sampleX.push(sx + lambda * pdx);
            sampleY.push(sy + lambda * pdy);
            sampleZ.push(sz + lambda * pdz);
        }

        const cx = _fitPoly1D(sampleTs, sampleX);
        const cy = _fitPoly1D(sampleTs, sampleY);
        const cz = _fitPoly1D(sampleTs, sampleZ);
        if (!cx || !cy || !cz) continue;

        let totalErr = 0;
        for (const fi of active) {
            const ti = times[fi] - t0;
            const b = fi * 3;
            totalErr += _angularError(
                _evalPoly(cx, ti), _evalPoly(cy, ti), _evalPoly(cz, ti),
                sensorPos[b], sensorPos[b + 1], sensorPos[b + 2],
                losDir[b], losDir[b + 1], losDir[b + 2]);
        }
        const score = totalErr / active.length;
        if (score < bestScore) {
            bestScore = score;
            bestCoeffsX = cx; bestCoeffsY = cy; bestCoeffsZ = cz;
        }
    }

    if (!bestCoeffsX) return null;

    // Float64 preserves the polynomial's smooth derivatives; Float32 position
    // quantization would appear as artificial acceleration downstream.
    const positions = new Float64Array(count * 3);
    const residuals = new Float32Array(count).fill(NaN);

    for (let i = 0; i < count; i++) {
        const ti = times[i] - t0;
        const fx = _evalPoly(bestCoeffsX, ti);
        const fy = _evalPoly(bestCoeffsY, ti);
        const fz = _evalPoly(bestCoeffsZ, ti);
        positions[i * 3] = fx;
        positions[i * 3 + 1] = fy;
        positions[i * 3 + 2] = fz;
        if (!excluded.has(i)) {
            const b = i * 3;
            // Monte Carlo residuals are angular radians, unlike the metre
            // residuals returned by the linear CV/CA and Kalman families.
            residuals[i] = _angularError(fx, fy, fz,
                sensorPos[b], sensorPos[b + 1], sensorPos[b + 2],
                losDir[b], losDir[b + 1], losDir[b + 2]);
        }
    }
    return {positions, residuals, params: {order, bestScore, numTrials}, activeCount: active.length};
}

// ---------------------------------------------------------------------------
// Monte Carlo 2 — Least-squares: perturb all frames, fit overdetermined poly
// ---------------------------------------------------------------------------

export function fitMonteCarlo2(dataset, excluded, options = {}) {
    const {sensorPos, losDir, times, count} = dataset;

    const order = Math.max(1, Math.round(options.order ?? 1));
    const losUncertDeg = options.losUncertaintyDeg ?? 2;
    const losUncertRad = losUncertDeg * (Math.PI / 180);
    const numTrials = Math.max(1, Math.round(options.numTrials ?? 500));
    const rng = mulberry32((options.seed ?? MC_DEFAULT_SEED) >>> 0);

    const rangeEstimates = options.rangeEstimates ?? null;

    // Same fallback range domain as Monte Carlo 1: ten sensor-track extents.
    let maxDistance = options.maxDistance;
    if (maxDistance == null) {
        let sceneExtent = 1;
        if (count > 0) {
            let minX = Infinity, maxX = -Infinity;
            let minY = Infinity, maxY = -Infinity;
            let minZ = Infinity, maxZ = -Infinity;
            for (let i = 0; i < count; i++) {
                const b = i * 3;
                if (sensorPos[b] < minX) minX = sensorPos[b];
                if (sensorPos[b] > maxX) maxX = sensorPos[b];
                if (sensorPos[b + 1] < minY) minY = sensorPos[b + 1];
                if (sensorPos[b + 1] > maxY) maxY = sensorPos[b + 1];
                if (sensorPos[b + 2] < minZ) minZ = sensorPos[b + 2];
                if (sensorPos[b + 2] > maxZ) maxZ = sensorPos[b + 2];
            }
            sceneExtent = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
        }
        maxDistance = sceneExtent * 10;
    }

    const active = [];
    for (let i = 0; i < count; i++) {
        if (!excluded.has(i)) active.push(i);
    }
    const needed = order + 1;
    if (active.length < needed) return null;

    const t0 = times[active[0]];
    const tLast = times[active[active.length - 1]];
    const tSpan = (tLast - t0) || 1;

    function _rotate(vx, vy, vz, ax, ay, az, theta) {
        const cosT = Math.cos(theta), sinT = Math.sin(theta);
        const dot = ax * vx + ay * vy + az * vz;
        const cx = ay * vz - az * vy, cy = az * vx - ax * vz, cz = ax * vy - ay * vx;
        return [
            vx * cosT + cx * sinT + ax * dot * (1 - cosT),
            vy * cosT + cy * sinT + ay * dot * (1 - cosT),
            vz * cosT + cz * sinT + az * dot * (1 - cosT),
        ];
    }

    function _perpUnit(dx, dy, dz) {
        const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
        let ux = 0, uy = 0, uz = 0;
        if (ax <= ay && ax <= az) ux = 1;
        else if (ay <= ax && ay <= az) uy = 1;
        else uz = 1;
        let px = dy * uz - dz * uy, py = dz * ux - dx * uz, pz = dx * uy - dy * ux;
        const len = Math.sqrt(px * px + py * py + pz * pz);
        return [px / len, py / len, pz / len];
    }

    // Least-squares polynomial fit via normal equations: (V^T V) c = V^T y
    function _fitPoly1D(ts, ys, polyOrder) {
        const m = ts.length;
        const n = polyOrder + 1;
        const VtV = Array.from({length: n}, () => new Array(n).fill(0));
        const Vty = new Array(n).fill(0);
        for (let i = 0; i < m; i++) {
            const pw = [1];
            for (let j = 1; j < n; j++) pw.push(pw[j - 1] * ts[i]);
            for (let j = 0; j < n; j++) {
                Vty[j] += pw[j] * ys[i];
                for (let k = j; k < n; k++) {
                    VtV[j][k] += pw[j] * pw[k];
                }
            }
        }
        for (let j = 0; j < n; j++)
            for (let k = 0; k < j; k++)
                VtV[j][k] = VtV[k][j];
        return _solveLinearSystem(VtV, Vty);
    }

    function _evalPoly(coeffs, t) {
        let val = 0, pw = 1;
        for (let k = 0; k < coeffs.length; k++) { val += coeffs[k] * pw; pw *= t; }
        return val;
    }

    function _angularError(fx, fy, fz, sx, sy, sz, dx, dy, dz) {
        let rx = fx - sx, ry = fy - sy, rz = fz - sz;
        const rlen = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (rlen < 1e-12) return Math.PI;
        rx /= rlen; ry /= rlen; rz /= rlen;
        const dot = Math.max(-1, Math.min(1, rx * dx + ry * dy + rz * dz));
        return Math.acos(dot);
    }

    // Precompute one basis vector in each LOS-normal plane. A trial still gets
    // a random perturbation azimuth by rotating this basis around the LOS.
    let perpVecs = null;
    if (losUncertRad > 1e-10) {
        perpVecs = new Float32Array(count * 3);
        for (const fi of active) {
            const b = fi * 3;
            const [ex, ey, ez] = _perpUnit(losDir[b], losDir[b + 1], losDir[b + 2]);
            perpVecs[b] = ex; perpVecs[b + 1] = ey; perpVecs[b + 2] = ez;
        }
    }

    // Unlike Monte Carlo 1's minimal interpolation, this overdetermined solve
    // uses every active frame. Normalizing the time domain to [0,1] keeps the
    // Vandermonde normal equations usable at higher orders and long durations.
    const normTimes = new Float64Array(count);
    for (const fi of active) {
        normTimes[fi] = (times[fi] - t0) / tSpan;
    }

    let bestScore = Infinity;
    let bestCoeffsX = null, bestCoeffsY = null, bestCoeffsZ = null;

    // Perturb every sightline and range in a trial, fit an LSQ polynomial to
    // the resulting point cloud, and retain the lowest all-frame angular error.
    for (let trial = 0; trial < numTrials; trial++) {
        const sampleTs = [], sampleX = [], sampleY = [], sampleZ = [];
        for (const fi of active) {
            const b = fi * 3;
            const sx = sensorPos[b], sy = sensorPos[b + 1], sz = sensorPos[b + 2];
            const dx = losDir[b], dy = losDir[b + 1], dz = losDir[b + 2];

            let pdx, pdy, pdz;
            if (perpVecs) {
                const theta = rng() * losUncertRad;
                const phi = rng() * 2 * Math.PI;
                const [rx2, ry2, rz2] = _rotate(perpVecs[b], perpVecs[b + 1], perpVecs[b + 2], dx, dy, dz, phi);
                [pdx, pdy, pdz] = _rotate(dx, dy, dz, rx2, ry2, rz2, theta);
            } else {
                [pdx, pdy, pdz] = [dx, dy, dz];
            }

            let lambda;
            if (rangeEstimates) {
                const est = rangeEstimates[fi];
                lambda = est * (0.9 + rng() * 0.2);
            } else {
                let effectiveMax = maxDistance;
                if (dataset.maxRange) {
                    const mr = dataset.maxRange[fi];
                    if (mr > 0) effectiveMax = Math.min(effectiveMax, mr);
                }
                lambda = rng() * effectiveMax;
            }

            sampleTs.push(normTimes[fi]);
            sampleX.push(sx + lambda * pdx);
            sampleY.push(sy + lambda * pdy);
            sampleZ.push(sz + lambda * pdz);
        }

        const cx = _fitPoly1D(sampleTs, sampleX, order);
        const cy = _fitPoly1D(sampleTs, sampleY, order);
        const cz = _fitPoly1D(sampleTs, sampleZ, order);
        if (!cx || !cy || !cz) continue;

        let totalErr = 0;
        for (const fi of active) {
            const ti = normTimes[fi];
            const b = fi * 3;
            totalErr += _angularError(
                _evalPoly(cx, ti), _evalPoly(cy, ti), _evalPoly(cz, ti),
                sensorPos[b], sensorPos[b + 1], sensorPos[b + 2],
                losDir[b], losDir[b + 1], losDir[b + 2]);
        }
        const score = totalErr / active.length;
        if (score < bestScore) {
            bestScore = score;
            bestCoeffsX = cx; bestCoeffsY = cy; bestCoeffsZ = cz;
        }
    }

    if (!bestCoeffsX) return null;

    // Float64 preserves the polynomial's smooth derivatives; Float32 position
    // quantization would appear as artificial acceleration downstream.
    const positions = new Float64Array(count * 3);
    const residuals = new Float32Array(count).fill(NaN);

    for (let i = 0; i < count; i++) {
        const ti = (times[i] - t0) / tSpan;
        const fx = _evalPoly(bestCoeffsX, ti);
        const fy = _evalPoly(bestCoeffsY, ti);
        const fz = _evalPoly(bestCoeffsZ, ti);
        positions[i * 3] = fx;
        positions[i * 3 + 1] = fy;
        positions[i * 3 + 2] = fz;
        if (!excluded.has(i)) {
            const b = i * 3;
            // Angular radians, matching Monte Carlo 1's result contract.
            residuals[i] = _angularError(fx, fy, fz,
                sensorPos[b], sensorPos[b + 1], sensorPos[b + 2],
                losDir[b], losDir[b + 1], losDir[b + 2]);
        }
    }
    return {positions, residuals, params: {order, bestScore, numTrials}, activeCount: active.length};
}

// ---------------------------------------------------------------------------
// Alternating least squares — a deterministic way to fit a curved path
//
// THE PROBLEM, IN PLAIN TERMS
// Each video frame tells us the DIRECTION the object was in, but not how far
// away it was. Think of each frame as a straight line ("ray") shot out from the
// camera: the object was somewhere on that line, but we don't know where. With
// a few hundred frames we have a few hundred rays, and we want to pick one
// point on each ray so that the points, joined up in time order, form a smooth
// sensible flight path.
//
// The only real unknowns are the DISTANCES — one distance per ray. If somebody
// handed us the correct distances, the job would be finished: we would just
// multiply each direction by its distance and read off the positions.
//
// THE TRICK
// Here is the useful part. Suppose we simply GUESS all the distances. Now we
// have actual 3D points, and drawing a best-fit curve through a set of known
// points is the ordinary "line of best fit" you would do in a spreadsheet, just
// with a curve (a polynomial such as a parabola) instead of a straight line,
// and done three times over — once each for the east, north and up coordinates.
// That part is easy and exact; there is no searching involved.
//
// Then, having drawn the curve, we can IMPROVE the guesses: for each ray, slide
// along it to the point nearest the curve, and use that as the new distance.
// Better distances give a better curve, which gives better distances again. So:
//
//     1. put a point on each ray at its currently guessed distance
//     2. fit the best curve through all those points
//     3. slide each point along its own ray to sit nearest the new curve
//     4. repeat (about a dozen passes is plenty)
//
// It settles down quickly, and because nothing is random, running it twice on
// the same data gives exactly the same answer. The Monte Carlo fits, by
// contrast, throw darts — they try thousands of random guesses and keep the
// best — and are only repeatable because their random numbers use a fixed seed.
//
// WHY BOTHER — measured against both Monte Carlo fits on a test case (a rising,
// wobbling object watched by a circling camera): this is roughly 150-250 TIMES
// faster and also closer to the truth at nearly every degree. At degree 5 over
// 2000 frames it landed 147 m from the true path in 2 milliseconds, where
// Monte Carlo 2 managed 168 m in 491 ms. Giving Monte Carlo 1 five hundred
// thousand darts instead of a thousand (350x the time) still did not catch up,
// so the difference is the METHOD, not the effort spent.
//
// WHY TIME IS RESCALED TO -1..+1
// A polynomial multiplies time by itself over and over (t, t*t, t*t*t, ...).
// Measure time in seconds on a ten-minute clip and t*t*t*t*t reaches about
// 100,000,000,000,000. Computers store only ~15 significant digits, so numbers
// that huge sitting next to small ones lose all their accuracy and the answer
// turns to noise. Squeezing time into the range -1 to +1 first keeps every
// number modest. (The Monte Carlo fits do NOT do this, which is a good part of
// why they get worse as the degree goes up.)
//
// A NOTE ON WHAT THIS WILL AND WON'T FIND
// The starting distances come from the constant-velocity fit, but unlike the
// Monte Carlo fits — which only ever look within 0.9x to 1.1x of that starting
// guess — this method lets the distances travel as far as they need to. The
// starting point is a hint, not a fence, so a far-away or fast-moving answer
// stays findable if that is genuinely what the sightlines show.
//
// TWO HONEST LIMITS
//  - A polynomial of degree k can only change direction about k/2 times. A path
//    that weaves back and forth many times over a long clip therefore CANNOT be
//    captured by any sensible degree — that needs a different kind of curve
//    (a spline, stitched together from many short pieces), not a bigger number.
//  - A curve that hugs the sightlines more closely is not automatically more
//    correct. In testing, higher degrees sometimes matched the sightlines
//    better while drifting FURTHER from the real path. Treat a low error as one
//    piece of evidence, not proof.
// ---------------------------------------------------------------------------

export function fitAlternatingLSQ(dataset, excluded, options = {}) {
    const {sensorPos, losDir, times, count} = dataset;

    const order = Math.max(1, Math.round(options.order ?? 1));
    const iterations = Math.max(1, Math.round(options.iterations ?? 12));

    const active = [];
    for (let i = 0; i < count; i++) {
        if (!excluded.has(i)) active.push(i);
    }
    if (active.length < order + 1) return null;

    // Squeeze time into the range -1..+1 first. Raising raw seconds to the 5th
    // power on a long clip produces numbers around 1e14, which destroys the
    // accuracy of the arithmetic (see the header note on rescaling).
    const tFirst = times[active[0]];
    const tLast = times[active[active.length - 1]];
    const tHalf = (tLast - tFirst) / 2 || 1;
    const tn = new Float64Array(count);
    for (let i = 0; i < count; i++) tn[i] = (times[i] - tFirst) / tHalf - 1;

    // Seed the ranges from the constant-velocity fit when it converges; a
    // plain nominal range otherwise. Only the STARTING ranges come from this.
    const range = new Float64Array(count);
    const cv = fitConstantVelocity(dataset, excluded);
    if (cv && cv.positions) {
        for (let i = 0; i < count; i++) {
            const b = i * 3;
            range[i] = Math.max(1,
                (cv.positions[b] - sensorPos[b]) * losDir[b]
                + (cv.positions[b + 1] - sensorPos[b + 1]) * losDir[b + 1]
                + (cv.positions[b + 2] - sensorPos[b + 2]) * losDir[b + 2]);
        }
    } else {
        let ext = 1;
        for (let i = 0; i < count; i++) ext = Math.max(ext, Math.abs(sensorPos[i * 3]));
        range.fill(Math.max(1000, ext));
    }

    const m = order + 1;
    const px = new Float64Array(count), py = new Float64Array(count), pz = new Float64Array(count);
    const positions = new Float64Array(count * 3);

    // Best-fit polynomial through the points (tn, ys), for one axis at a time.
    // This is the standard "line of best fit" calculation extended to a curve:
    // it minimises the total squared vertical gap between the curve and the
    // points, and is solved directly — no searching or guessing.
    //
    // `moments` holds the running totals of t, t*t, t*t*t ... that the
    // calculation needs. They depend only on the TIMES, which never change
    // between passes, so they are added up once outside the loop and reused.
    const moments = new Float64Array(2 * order + 1);
    function lsqPoly(ys) {
        const rhs = new Float64Array(m);
        for (const fi of active) {
            let p = 1;
            for (let k = 0; k < m; k++) { rhs[k] += ys[fi] * p; p *= tn[fi]; }
        }
        const A = [];
        for (let r = 0; r < m; r++) {
            const row = new Float64Array(m);
            for (let c = 0; c < m; c++) row[c] = moments[r + c];
            A.push(row);
        }
        return _solveLinearSystem(A, Array.from(rhs));
    }
    function evalPoly(c, t) {
        let v = 0, p = 1;
        for (let k = 0; k < c.length; k++) { v += c[k] * p; p *= t; }
        return v;
    }

    for (const fi of active) {
        let p = 1;
        for (let k = 0; k <= 2 * order; k++) { moments[k] += p; p *= tn[fi]; }
    }

    for (let iter = 0; iter < iterations; iter++) {
        // Step 1: put a point on each ray at its currently guessed distance.
        // Excluded frames are populated for a continuous output track, but
        // lsqPoly's active-only loop prevents them from influencing the fit.
        for (let i = 0; i < count; i++) {
            const b = i * 3;
            px[i] = sensorPos[b] + range[i] * losDir[b];
            py[i] = sensorPos[b + 1] + range[i] * losDir[b + 1];
            pz[i] = sensorPos[b + 2] + range[i] * losDir[b + 2];
        }
        // Step 2: fit the best curve through those points (east, north, up).
        const cx = lsqPoly(px), cy = lsqPoly(py), cz = lsqPoly(pz);
        if (!cx || !cy || !cz) return null;

        // Step 3: slide each point along its own ray to sit nearest the new
        // curve. That sliding distance becomes the improved guess for step 1.
        for (let i = 0; i < count; i++) {
            const b = i * 3;
            const fx = evalPoly(cx, tn[i]), fy = evalPoly(cy, tn[i]), fz = evalPoly(cz, tn[i]);
            positions[b] = fx; positions[b + 1] = fy; positions[b + 2] = fz;
            // Orthogonal projection onto a unit ray gives d·(curve-sensor).
            // The one-metre floor keeps the update on the forward half-line and
            // avoids the direction singularity at the sensor itself.
            range[i] = Math.max(1,
                (fx - sensorPos[b]) * losDir[b]
                + (fy - sensorPos[b + 1]) * losDir[b + 1]
                + (fz - sensorPos[b + 2]) * losDir[b + 2]);
        }
    }

    const residuals = new Float32Array(count).fill(NaN);
    let sumErr = 0;
    for (let i = 0; i < count; i++) {
        const b = i * 3;
        let rx = positions[b] - sensorPos[b];
        let ry = positions[b + 1] - sensorPos[b + 1];
        let rz = positions[b + 2] - sensorPos[b + 2];
        const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (rl < 1e-12) continue;
        const dot = Math.max(-1, Math.min(1,
            (rx * losDir[b] + ry * losDir[b + 1] + rz * losDir[b + 2]) / rl));
        // The polynomial generally lies near, not exactly on, each LOS; report
        // that discrepancy as an angle in radians for range-independent scoring.
        const e = Math.acos(dot);
        if (!excluded.has(i)) { residuals[i] = e; sumErr += e; }
    }
    return {
        positions, residuals,
        params: {order, iterations, meanErrRad: sumErr / Math.max(1, active.length)},
        activeCount: active.length,
    };
}

// ---------------------------------------------------------------------------
// Kalman Filter (RTS Forward-Backward Smoother)
// ---------------------------------------------------------------------------

// State is [px, py, pz, vx, vy, vz]. The forward filter uses a constant-
// velocity transition with process noise, while each LOS supplies only the two
// observable components of position perpendicular to its direction. The RTS
// backward pass then lets later sightlines refine earlier states; this is a
// batch smoother, not a causal real-time track.
export function fitKalmanFilter(dataset, excluded, options = {}) {
    const {sensorPos, losDir, times, count} = dataset;

    // Covariances must be positive and finite. A caller that passes a log10
    // slider exponent by mistake (e.g. -4) would otherwise seed a negative
    // process variance and produce an all-NaN smoother track; fall back to the
    // defaults rather than propagate that.
    const posFinite = (v, dflt) => (Number.isFinite(v) && v > 0 ? v : dflt);
    const processNoise = posFinite(options.processNoise, 1e-4);
    const measurementNoise = posFinite(options.measurementNoise, 1.0);

    const active = [];
    for (let i = 0; i < count; i++) {
        if (!excluded.has(i)) active.push(i);
    }
    active.sort((a, b) => times[a] - times[b]);
    if (active.length < 2) return null;

    // Small fixed-size matrix helpers use flat row-major arrays to avoid
    // allocating nested matrices in every predict/update step.
    function _mat6Mul(A, B) {
        const C = new Array(36).fill(0);
        for (let i = 0; i < 6; i++)
            for (let k = 0; k < 6; k++) {
                const aik = A[i * 6 + k];
                if (aik === 0) continue;
                for (let j = 0; j < 6; j++) C[i * 6 + j] += aik * B[k * 6 + j];
            }
        return C;
    }

    function _mat6AddInPlace(A, B) {
        for (let i = 0; i < 36; i++) A[i] += B[i];
    }

    function _mat6T(A) {
        const T = new Array(36).fill(0);
        for (let i = 0; i < 6; i++)
            for (let j = 0; j < 6; j++) T[j * 6 + i] = A[i * 6 + j];
        return T;
    }

    function _mulHx(H, x) {
        return [
            H[0] * x[0] + H[1] * x[1] + H[2] * x[2] + H[3] * x[3] + H[4] * x[4] + H[5] * x[5],
            H[6] * x[0] + H[7] * x[1] + H[8] * x[2] + H[9] * x[3] + H[10] * x[4] + H[11] * x[5],
            H[12] * x[0] + H[13] * x[1] + H[14] * x[2] + H[15] * x[3] + H[16] * x[4] + H[17] * x[5],
        ];
    }

    function _computeHPHT(H, P) {
        const PHT = new Array(18).fill(0);
        for (let i = 0; i < 6; i++)
            for (let j = 0; j < 3; j++)
                for (let k = 0; k < 6; k++)
                    PHT[i * 3 + j] += P[i * 6 + k] * H[j * 6 + k];
        const HPHT = new Array(9).fill(0);
        for (let i = 0; i < 3; i++)
            for (let j = 0; j < 3; j++)
                for (let k = 0; k < 6; k++)
                    HPHT[i * 3 + j] += H[i * 6 + k] * PHT[k * 3 + j];
        return HPHT;
    }

    function _computeK(P, H, Sinv) {
        const PHT = new Array(18).fill(0);
        for (let i = 0; i < 6; i++)
            for (let j = 0; j < 3; j++)
                for (let k = 0; k < 6; k++)
                    PHT[i * 3 + j] += P[i * 6 + k] * H[j * 6 + k];
        const K = new Array(18).fill(0);
        for (let i = 0; i < 6; i++)
            for (let j = 0; j < 3; j++)
                for (let k = 0; k < 3; k++)
                    K[i * 3 + j] += PHT[i * 3 + k] * Sinv[k * 3 + j];
        return K;
    }

    function _inv3x3(M) {
        const [a, b, c, d, e, f, g, h, k] = M;
        const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
        if (Math.abs(det) < 1e-30) return null;
        const inv = 1 / det;
        return [
            (e * k - f * h) * inv, (c * h - b * k) * inv, (b * f - c * e) * inv,
            (f * g - d * k) * inv, (a * k - c * g) * inv, (c * d - a * f) * inv,
            (d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
        ];
    }

    function _inv6x6(M) {
        const A = [];
        for (let i = 0; i < 6; i++) A.push(M.slice(i * 6, i * 6 + 6));
        const inv = new Array(36).fill(0);
        for (let col = 0; col < 6; col++) {
            const rhs = new Array(6).fill(0);
            rhs[col] = 1;
            const Acopy = A.map(row => row.slice());
            const sol = _solveLinearSystem(Acopy, rhs);
            if (!sol) {
                const fallback = new Array(36).fill(0);
                const scale = 1 / (M[0] || 1);
                for (let i = 0; i < 6; i++) fallback[i * 6 + i] = scale;
                return fallback;
            }
            for (let row = 0; row < 6; row++) inv[row * 6 + col] = sol[row];
        }
        return inv;
    }

    // Seed from the all-frame CV fit when possible. The first active sample is
    // represented by this seed; measurement updates begin at active[1], and the
    // backward smoother later incorporates evidence from the remaining clip.
    const _cvSeed = fitConstantVelocity(dataset, excluded);

    let x;
    const P_init = new Array(36).fill(0);

    if (_cvSeed) {
        const P0cv = _cvSeed.params.P0;
        const Vcv = _cvSeed.params.V;
        x = [P0cv[0], P0cv[1], P0cv[2], Vcv[0], Vcv[1], Vcv[2]];
        for (let i = 0; i < 3; i++) P_init[i * 6 + i] = 1.0;
        for (let i = 3; i < 6; i++) P_init[i * 6 + i] = 0.01;
    } else {
        const b0 = active[0] * 3;
        x = [
            sensorPos[b0] + losDir[b0],
            sensorPos[b0 + 1] + losDir[b0 + 1],
            sensorPos[b0 + 2] + losDir[b0 + 2],
            0, 0, 0,
        ];
        for (let i = 0; i < 3; i++) P_init[i * 6 + i] = 1e6;
        for (let i = 3; i < 6; i++) P_init[i * 6 + i] = 1.0;
    }

    let P = P_init.slice();

    function _buildQ(dt) {
        // Couple position and velocity uncertainty for each axis. processNoise
        // is a tunable model variance, not a directly reported acceleration.
        const Q = new Array(36).fill(0);
        const q = processNoise;
        const qp = (dt * dt * 0.25) * q;
        const qv = dt * dt * q;
        const qc = dt * dt * 0.5 * q;
        for (let i = 0; i < 3; i++) {
            Q[i * 6 + i] = qp;
            Q[(i + 3) * 6 + (i + 3)] = qv;
            Q[i * 6 + (i + 3)] = qc;
            Q[(i + 3) * 6 + i] = qc;
        }
        return Q;
    }

    const filtX = [], filtP = [], predX = [], predP = [], Fmats = [];

    filtX.push(x.slice());
    filtP.push(P.slice());
    predX.push(x.slice());
    predP.push(P.slice());
    Fmats.push(null);

    // Forward Kalman pass
    for (let ai = 1; ai < active.length; ai++) {
        const prevIdx = active[ai - 1];
        const currIdx = active[ai];
        const dt = times[currIdx] - times[prevIdx];

        const F = new Array(36).fill(0);
        for (let i = 0; i < 6; i++) F[i * 6 + i] = 1;
        for (let i = 0; i < 3; i++) F[i * 6 + (i + 3)] = dt;
        Fmats.push(F);

        const xp = new Array(6).fill(0);
        for (let i = 0; i < 6; i++)
            for (let k = 0; k < 6; k++) xp[i] += F[i * 6 + k] * x[k];

        const FT = _mat6T(F);
        const FP = _mat6Mul(F, P);
        const FPF = _mat6Mul(FP, FT);
        const Q = _buildQ(dt);
        _mat6AddInPlace(FPF, Q);
        const Pp = FPF;

        predX.push(xp.slice());
        predP.push(Pp.slice());

        const bi = currIdx * 3;
        const dx = losDir[bi], dy = losDir[bi + 1], dz = losDir[bi + 2];
        const sx = sensorPos[bi], sy = sensorPos[bi + 1], sz = sensorPos[bi + 2];

        // Measurement equation P*position = P*sensor, P=I-dd^T. P removes the
        // unobservable along-LOS component, leaving the cross-LOS displacement
        // that should be zero when the state lies on the sightline.
        const p00 = 1 - dx * dx, p01 = -dx * dy, p02 = -dx * dz;
        const p10 = -dy * dx, p11 = 1 - dy * dy, p12 = -dy * dz;
        const p20 = -dz * dx, p21 = -dz * dy, p22 = 1 - dz * dz;
        const H = [
            p00, p01, p02, 0, 0, 0,
            p10, p11, p12, 0, 0, 0,
            p20, p21, p22, 0, 0, 0,
        ];

        const z = [
            p00 * sx + p01 * sy + p02 * sz,
            p10 * sx + p11 * sy + p12 * sz,
            p20 * sx + p21 * sy + p22 * sz,
        ];
        const Hxp = _mulHx(H, xp);
        const innov = [z[0] - Hxp[0], z[1] - Hxp[1], z[2] - Hxp[2]];

        const HPHT = _computeHPHT(H, Pp);
        const r = measurementNoise;
        // P has rank two, but adding isotropic R makes the 3x3 innovation
        // covariance invertible while retaining the LOS-null direction.
        HPHT[0] += r; HPHT[4] += r; HPHT[8] += r;

        const Sinv = _inv3x3(HPHT);
        if (!Sinv) {
            x = xp.slice();
            P = Pp.slice();
        } else {
            const K = _computeK(Pp, H, Sinv);
            const xNew = xp.slice();
            for (let i = 0; i < 6; i++)
                xNew[i] += K[i * 3] * innov[0] + K[i * 3 + 1] * innov[1] + K[i * 3 + 2] * innov[2];

            const KH = new Array(36).fill(0);
            for (let i = 0; i < 6; i++)
                for (let j = 0; j < 6; j++)
                    for (let k = 0; k < 3; k++)
                        KH[i * 6 + j] += K[i * 3 + k] * H[k * 6 + j];

            const IKH = new Array(36).fill(0);
            for (let i = 0; i < 6; i++) IKH[i * 6 + i] = 1;
            for (let i = 0; i < 36; i++) IKH[i] -= KH[i];

            x = xNew;
            P = _mat6Mul(IKH, Pp);
        }
        filtX.push(x.slice());
        filtP.push(P.slice());
    }

    // Rauch-Tung-Striebel backward smoother. G maps the difference between the
    // next smoothed state and its forward prediction back into this state.
    const n = active.length;
    const smoothX = filtX.map(s => s.slice());
    const smoothP = filtP.map(p => p.slice());

    for (let ai = n - 2; ai >= 0; ai--) {
        const F = Fmats[ai + 1];
        const xf = filtX[ai];
        const Pf = filtP[ai];
        const xpp = predX[ai + 1];
        const Ppp = predP[ai + 1];
        const xs1 = smoothX[ai + 1];

        const FT = _mat6T(F);
        const PfFT = _mat6Mul(Pf, FT);
        const PppInv = _inv6x6(Ppp);
        const G = _mat6Mul(PfFT, PppInv);

        const diff = xs1.map((v, j) => v - xpp[j]);
        const xsNew = xf.slice();
        for (let i = 0; i < 6; i++)
            for (let k = 0; k < 6; k++)
                xsNew[i] += G[i * 6 + k] * diff[k];
        smoothX[ai] = xsNew;

        const Ps1 = smoothP[ai + 1];
        const dP = Ps1.map((v, j) => v - Ppp[j]);
        const GT = _mat6T(G);
        const GdP = _mat6Mul(G, dP);
        const GdPGT = _mat6Mul(GdP, GT);
        const PsNew = Pf.slice();
        for (let i = 0; i < 36; i++) PsNew[i] += GdPGT[i];
        smoothP[ai] = PsNew;
    }

    // Only active frames own filtered states. The output pass linearly fills
    // excluded gaps (and any leading frames) and extrapolates from the last
    // active state so every source frame still receives a renderable position.
    const stateAtFrame = new Map();
    for (let ai = 0; ai < active.length; ai++) {
        stateAtFrame.set(active[ai], smoothX[ai]);
    }

    // Float64 prevents position quantization from masquerading as acceleration
    // when downstream graphs take finite differences of the smoothed track.
    const positions = new Float64Array(count * 3);
    const residuals = new Float32Array(count).fill(NaN);
    let activePtr = 0;

    for (let i = 0; i < count; i++) {
        while (activePtr + 1 < active.length && times[active[activePtr + 1]] <= times[i]) activePtr++;

        let fx, fy, fz;
        if (activePtr + 1 < active.length) {
            const idxA = active[activePtr], idxB = active[activePtr + 1];
            const tA = times[idxA], tB = times[idxB];
            const alpha = tB > tA ? (times[i] - tA) / (tB - tA) : 0;
            const sA = stateAtFrame.get(idxA), sB = stateAtFrame.get(idxB);
            fx = sA[0] + alpha * (sB[0] - sA[0]);
            fy = sA[1] + alpha * (sB[1] - sA[1]);
            fz = sA[2] + alpha * (sB[2] - sA[2]);
        } else {
            const idxLast = active[activePtr];
            const st = stateAtFrame.get(idxLast);
            const dt = times[i] - times[idxLast];
            fx = st[0] + st[3] * dt;
            fy = st[1] + st[4] * dt;
            fz = st[2] + st[5] * dt;
        }

        positions[i * 3] = fx;
        positions[i * 3 + 1] = fy;
        positions[i * 3 + 2] = fz;

        if (!excluded.has(i)) {
            const bi = i * 3;
            // Kalman residuals are perpendicular metres, like CV/CA (and unlike
            // the angular-radian residuals of Monte Carlo/ALS/physics fits).
            residuals[i] = _pointToRayDistance(
                [fx, fy, fz],
                [sensorPos[bi], sensorPos[bi + 1], sensorPos[bi + 2]],
                [losDir[bi], losDir[bi + 1], losDir[bi + 2]],
            );
        }
    }

    return {positions, residuals, params: {states: active.map(idx => stateAtFrame.get(idx))}, activeCount: active.length};
}

// ---------------------------------------------------------------------------
// Physics Model Trajectory Fit (RK4 integration; Nelder-Mead or DE+polish)
// ---------------------------------------------------------------------------

// Fit a PhysicsModel's parameters to the LOS dataset. Async (the DE optimizer
// is async and yields to the UI between generations); always returns a Promise.
//
// Cost = (meanAngularErrorDegrees / errSigma) + model.extraCost(params, dataset, T)
// where errSigma = options.errSigma ?? 0.02 degrees. The extraCost hook lets a
// model add soft plausibility priors — pure LOS angular error is hugely
// ambiguous for maneuvering-target models.
//
// options:
//   maxIter        Nelder-Mead iteration cap (default 5000)
//   errSigma       angular-error weight, degrees per unit cost (default 0.02)
//   sampleStride   use every Nth active frame (plus the last) in the cost
//                  (default 1); final trajectory/residuals stay full-resolution
//   optimizer      "nm" (default: single-start Nelder-Mead from model defaults)
//                  or "de" (global differential evolution over the parameter
//                  bounds, then Nelder-Mead polish from the DE best)
//   dePop, deGens  DE population/generations (defaults 48/120)
//   paramOverrides {name: value} initial-guess overrides (also seeds DE)
//   paramLocks     {name: value} hold these parameters FIXED and search only
//                  the rest (used to trace a range-conditioned solution family)
//
// Returns {positions, residuals, params: {model, cost, errDeg, solved}, activeCount}
// where cost is the composite cost above and errDeg is the full-resolution
// mean angular error of the final solution in degrees.
export async function fitPhysicsModel(dataset, excluded, model, options = {}) {
    const {sensorPos, losDir, times, count} = dataset;

    const active = [];
    for (let i = 0; i < count; i++) {
        if (!excluded.has(i)) active.push(i);
    }
    if (active.length < 2) return null;

    const paramDefs = model.getParameterDefs();
    const nParams = paramDefs.length;

    // Build the optimizer vector in the model's declared parameter order.
    // `scale` controls the initial simplex size; it does not rescale the model
    // parameter passed to getInitialState/derivatives/extraCost.
    const x0 = paramDefs.map(p => p.default);
    const lo = paramDefs.map(p => p.min);
    const hi = paramDefs.map(p => p.max);
    const scales = paramDefs.map(p => p.scale);

    // Apply GUI overrides to initial guesses
    const overrides = options.paramOverrides;
    if (overrides) {
        for (let i = 0; i < nParams; i++) {
            if (overrides[paramDefs[i].name] !== undefined) {
                x0[i] = overrides[paramDefs[i].name];
            }
        }
    }

    // Optional parameter LOCKS {name: value}: hold named parameters fixed and
    // search only the rest. Used to trace a solution FAMILY — refit everything
    // else at each of a ladder of ranges — so the analysis can show which
    // ranges a model admits rather than only its single best.
    //
    // Locks are applied as a REDUCED search vector, not by collapsing lo/hi to
    // the locked value: Nelder-Mead builds its simplex from the bounds, and a
    // zero-width dimension degenerates it. Locked coordinates are removed from
    // the vector the optimizer sees and re-inserted before the trajectory is
    // integrated, so everything downstream is unchanged. (fitAircraft needs no
    // equivalent — it is DE + pattern search, both of which take a zero-width
    // bound safely, so locking its range is just rangeMin === rangeMax.)
    const locks = options.paramLocks;
    const freeIdx = [];
    const lockedIdx = [];
    for (let i = 0; i < nParams; i++) {
        const v = locks ? locks[paramDefs[i].name] : undefined;
        if (v === undefined) freeIdx.push(i);
        else { x0[i] = v; lockedIdx.push(i); }
    }
    const hasLocks = lockedIdx.length > 0;
    const subset = (arr) => freeIdx.map((i) => arr[i]);
    // The locked values live in x0, so it is the correct base to expand into.
    const expand = (reduced) => {
        const full = x0.slice();
        for (let k = 0; k < freeIdx.length; k++) full[freeIdx[k]] = reduced[k];
        return full;
    };

    // Model time zero is the first active observation. Physics models therefore
    // receive clip-relative seconds even when source timestamps are epoch values.
    const t0 = times[active[0]];
    const T = times[active[active.length - 1]] - t0; // total duration, seconds

    // Strided subset of active frames for the expensive optimizer cost (always
    // keep the last frame so the whole engagement is constrained). stride 1 =
    // all frames. This subsampling never changes the final output resolution.
    const stride = Math.max(1, Math.floor(options.sampleStride ?? 1));
    const costFrames = [];
    for (let k = 0; k < active.length; k += stride) costFrames.push(active[k]);
    if (costFrames[costFrames.length - 1] !== active[active.length - 1]) {
        costFrames.push(active[active.length - 1]);
    }
    const costTimes = costFrames.map(i => times[i] - t0);

    const errSigma = options.errSigma ?? 0.02; // degrees of mean error per unit cost

    function _angularError(fx, fy, fz, sx, sy, sz, dx, dy, dz) {
        let rx = fx - sx, ry = fy - sy, rz = fz - sz;
        const rlen = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (rlen < 1e-12) return Math.PI;
        rx /= rlen; ry /= rlen; rz /= rlen;
        const dot = Math.max(-1, Math.min(1, rx * dx + ry * dy + rz * dz));
        return Math.acos(dot);
    }

    // Optional COARSER integration step used only during the search (the final
    // full-resolution trajectory below always uses the model's own maxDt). When
    // the fit is seeded near the answer it needs local refinement, not accuracy
    // to the metre at every substep, so a bigger step buys a large speed-up at no
    // cost to the reported result. Left undefined the search integrates exactly
    // as before.
    const fitMaxDt = options.fitMaxDt;

    // Mean angular error (radians) over the given frames, or null on divergence
    function _meanErrRad(params, frames, frameTimes) {
        const initialState = model.getInitialState(params, dataset);
        let states;
        try {
            states = integrateRK4(model, initialState, params, frameTimes, {maxDt: fitMaxDt, checkDivergence: true});
        } catch (e) {
            return null; // diverged
        }

        let totalErr = 0;
        for (let k = 0; k < frames.length; k++) {
            const fi = frames[k];
            const s = states[k];
            if (!s) return null;
            const b = fi * 3;
            const angularError = _angularError(
                s[0], s[1], s[2],
                sensorPos[b], sensorPos[b + 1], sensorPos[b + 2],
                losDir[b], losDir[b + 1], losDir[b + 2]
            );
            if (!Number.isFinite(angularError)) return null;
            totalErr += angularError;
        }
        return totalErr / frames.length;
    }

    // Optional soft ground-contact prior (from the analysis ground modes). Pulls
    // the trajectory's START and/or END altitude (ENU up, metres) toward a ground
    // reference, modelling takeoff/release (start) and landing/descent (end).
    // Gated on options.groundPrior — undefined leaves the cost untouched, so the
    // default fit is unchanged.
    const groundPrior = options.groundPrior || null;

    // Composite cost: scaled mean angular error (degrees) + model plausibility.
    // EARTH_R supplies the second-order curvature correction that converts
    // tangent-plane ENU up into approximate height above the reference ellipsoid.
    const EARTH_R = 6371000;   // tangent-plane curvature for the ground prior
    function costFn(params) {
        const errRad = _meanErrRad(params, costFrames, costTimes);
        if (errRad === null || !Number.isFinite(errRad)) return Infinity;
        const priorCost = model.extraCost(params, dataset, T);
        if (!Number.isFinite(priorCost)) return Infinity;
        let cost = (errRad * 180 / Math.PI) / errSigma + priorCost;
        if (groundPrior) {
            const sig = groundPrior.sigma ?? 40;
            const init = model.getInitialState(params, dataset);
            const hae = (s) => s[2] + (s[0] * s[0] + s[1] * s[1]) / (2 * EARTH_R);
            if (groundPrior.startZ !== undefined && groundPrior.startZ !== null) {
                cost += ((hae(init) - groundPrior.startZ) / sig) ** 2;
            }
            if (groundPrior.endZ !== undefined && groundPrior.endZ !== null) {
                try {
                    const st = integrateRK4(model, init, params, [0, T], {maxDt: fitMaxDt, checkDivergence: true});
                    const e = st[st.length - 1];
                    cost += ((hae(e) - groundPrior.endZ) / sig) ** 2;
                } catch (err) {
                    // A failed end-state integration cannot simply omit the
                    // requested ground prior and leave the candidate cheaper.
                    return Infinity;
                }
            }
        }
        return Number.isFinite(cost) ? cost : Infinity;
    }

    // Run the optimizer: single-start Nelder-Mead (default, original behavior)
    // or global differential evolution followed by a Nelder-Mead polish.
    const {nelderMead} = require("./NelderMead");
    const maxIter = options.maxIter ?? 5000;
    const _clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    let _lastYield = _clock();
    // Called after every objective evaluation in both DE and Nelder-Mead. A
    // generation or polish iteration can contain dozens of expensive long-clip
    // integrations, so generation-level cooperation alone still froze Cancel.
    const optimizerPulse = () => {
        if (options.shouldCancel && options.shouldCancel()) return false;
        const now = _clock();
        if (now - _lastYield <= 60) return true;
        return _macroYield().then(() => {
            _lastYield = _clock();
            return !(options.shouldCancel && options.shouldCancel());
        });
    };
    // What the optimizer actually searches: the full parameter vector, or the
    // free subset with the locked coordinates spliced back in (see paramLocks).
    const searchCost = hasLocks ? (p) => costFn(expand(p)) : costFn;
    const searchX0 = hasLocks ? subset(x0) : x0;
    const searchLo = hasLocks ? subset(lo) : lo;
    const searchHi = hasLocks ? subset(hi) : hi;
    const searchScales = hasLocks ? subset(scales) : scales;

    let result;
    if (options.optimizer === "de") {
        const {differentialEvolution, mulberry32} = require("./DifferentialEvolution");
        const de = await differentialEvolution(searchCost, searchLo, searchHi, {
            pop: options.dePop ?? 48,
            gens: options.deGens ?? 120,
            seeds: [searchX0],
            // Deterministic by default: identical dataset + options => identical
            // fit (was unseeded Math.random — user-visible parameters flipped
            // between runs on near-degenerate scenes). options.seed overrides.
            rng: mulberry32(options.seed ?? 0xF17DE5),
            // Candidate-level cooperation covers the initial population and the
            // inside of every generation, not just generation boundaries.
            onEvaluation: optimizerPulse,
        });
        if (de.cancelled || (options.shouldCancel && options.shouldCancel())) {
            throw new Error("cancelled");
        }
        result = await nelderMead(searchCost, de.params, {
            lo: searchLo, hi: searchHi, initialScale: searchScales,
            maxIter, onEvaluation: optimizerPulse,
        });
        if (result.cancelled || (options.shouldCancel && options.shouldCancel())) {
            throw new Error("cancelled");
        }
        if (de.cost < result.cost) result = de; // polish should never regress, but be safe
        result.de = {
            generations: de.generations,
            evaluations: de.evaluations,
            stopReason: de.stopReason,
        };
    } else {
        result = await nelderMead(searchCost, searchX0, {
            lo: searchLo, hi: searchHi, initialScale: searchScales,
            maxIter, onEvaluation: optimizerPulse,
        });
        if (result.cancelled || (options.shouldCancel && options.shouldCancel())) {
            throw new Error("cancelled");
        }
    }

    // Generate full trajectory at all frames using best params
    const bestParams = hasLocks ? expand(result.params) : result.params;
    const bestState0 = model.getInitialState(bestParams, dataset);
    const allTimes = [];
    for (let i = 0; i < count; i++) allTimes.push(times[i] - t0);

    let allStates;
    try {
        allStates = integrateRK4(model, bestState0, bestParams, allTimes, {checkDivergence: true});
    } catch (e) {
        return null;
    }

    // Float64 prevents ENU position quantization from being amplified into
    // artificial acceleration by downstream finite-difference graphs.
    const positions = new Float64Array(count * 3);
    const residuals = new Float32Array(count).fill(NaN);

    // Full-resolution mean angular error of the final solution (degrees),
    // reported separately from the composite cost so the GUI can show fit
    // quality regardless of the plausibility terms and errSigma scaling.
    let errSum = 0;
    let errCount = 0;

    for (let i = 0; i < count; i++) {
        const s = allStates[i];
        positions[i * 3] = s[0];
        positions[i * 3 + 1] = s[1];
        positions[i * 3 + 2] = s[2];
        if (!excluded.has(i)) {
            const b = i * 3;
            // Physics residuals are pure angular radians. Model priors appear
            // only in the composite cost and the `priors` result metadata.
            residuals[i] = _angularError(s[0], s[1], s[2],
                sensorPos[b], sensorPos[b + 1], sensorPos[b + 2],
                losDir[b], losDir[b + 1], losDir[b + 2]);
            errSum += residuals[i];
            errCount++;
        }
    }
    const errDeg = errCount > 0 ? (errSum / errCount) * 180 / Math.PI : NaN;

    // Fail closed on non-finite output. The divergence guard inside the
    // integrator only catches LARGE magnitudes, and NaN compares false to every
    // threshold, so a NaN trajectory (e.g. from a poisoned seed) would otherwise
    // pass silently and be published as a tile with NaN positions/metrics while
    // the run reports no failures. Returning null makes the caller record a
    // typed numerical failure instead.
    if (!Number.isFinite(result.cost) || !Number.isFinite(errDeg)) return null;
    for (let i = 0; i < bestParams.length; i++) {
        if (!Number.isFinite(bestParams[i])) return null;
    }
    for (let i = 0; i < positions.length; i++) {
        if (!Number.isFinite(positions[i])) return null;
    }
    for (let i = 0; i < residuals.length; i++) {
        if (!excluded.has(i) && !Number.isFinite(residuals[i])) return null;
    }

    // Package solved parameter values with names for display
    const solvedParams = {};
    for (let i = 0; i < nParams; i++) {
        solvedParams[paramDefs[i].name] = bestParams[i];
    }

    // Itemise the soft priors at the solution, in DEGREES of fit budget.
    // Display only — computed after the search, so it cannot affect it.
    let priorTermsDeg = null;
    try {
        const terms = model.extraCostTerms ? model.extraCostTerms(bestParams, dataset, T) : null;
        if (terms) {
            const out = {};
            let total = 0;
            for (const k of Object.keys(terms)) {
                const deg = terms[k] * errSigma;
                if (Number.isFinite(deg) && deg > 0) { out[k] = deg; total += deg; }
            }
            if (total > 0) priorTermsDeg = {total, terms: out};
        }
    } catch (e) {
        priorTermsDeg = null;   // reporting must never break a completed fit
    }

    // A coordinate sitting near a bound is not automatically a physical
    // capability violation: it may be inactive over this clip (GoFast's
    // pre-burn lantern vSink), flat, or numerical drift.  Probe each detected
    // bound inward and retain whether it is locally load-bearing.  Consumers
    // demote only load-bearing constraints and report the others as unresolved.
    // A LOCKED coordinate was never searched, so it cannot be a load-bearing
    // search limit however close to a bound the caller parked it.
    const pinned = assessBoundPins(bestParams, lo, hi,
        paramDefs.map((d) => d.name), costFn,
        {baseCost: result.cost, excludeIndices: lockedIdx});

    return {
        positions,
        residuals,
        params: {
            model: model.getName(), cost: result.cost, errDeg, solved: solvedParams, pinned,
            // What the model's soft priors cost AT THE SOLUTION, expressed in
            // the same units as errDeg so it can be compared against it
            // directly. The cost function is errDeg/errSigma + extraCost, so
            // multiplying by errSigma converts prior cost into "degrees of
            // residual the priors were willing to pay". Without this the priors
            // are unobservable: errDeg above is recomputed as pure angular
            // error and deliberately excludes them, so a prior can select the
            // solution while leaving no trace in the reported number.
            priors: priorTermsDeg,
            optimizer: {
                stopReason: result.stopReason ?? "best_de_candidate",
                iterations: result.iterations ?? 0,
                parameterSpread: result.parameterSpread ?? null,
                // Identifiability metadata (see NelderMead.js return note):
                // per-parameter normalized spreads + the final cost spread let
                // callers distinguish "search unfinished" from "objective
                // settled, some parameters unobservable from this clip".
                parameterSpreads: result.parameterSpreads ?? null,
                parameterMins: result.parameterMins ?? null,
                parameterMaxs: result.parameterMaxs ?? null,
                // The names of the coordinates the optimizer ACTUALLY searched,
                // so they stay index-aligned with the spread arrays above —
                // settledButUnidentifiable indexes one by the other. A locked
                // coordinate is absent because it was never searched.
                paramNames: (hasLocks ? freeIdx.map((i) => paramDefs[i]) : paramDefs)
                    .map((p) => p.name),
                lockedParams: hasLocks ? lockedIdx.map((i) => paramDefs[i].name) : null,
                costSpread: result.costSpread ?? null,
                tol: result.tol ?? null,
                xTol: result.xTol ?? null,
                de: result.de ?? null,
            },
        },
        activeCount: active.length
    };
}

// ---------------------------------------------------------------------------
// Shared: build LOS dataset from a sitrec LOS node (ECEF -> ENU)
// ---------------------------------------------------------------------------

import {ECEF2ENU_radii, ECEFToLLA_radii, ENU2ECEF_radii} from "./LLA-ECEF-ENU";
import {Sit} from "./Globals";
import {Vector3} from "three";

/**
 * Pack a Sitrec LOS node into a flat-array dataset in ENU coordinates.
 * Returns { dataset, originLat, originLon } where lat/lon are in radians.
 */
// Pack the LOS into flat ENU arrays for the fitters. frame0/frame1 window the
// dataset to the In/Out (A-B) range (defaults = the full clip) — the same
// window the traverse-analysis gallery fits, so a live fit method reproduces
// an applied gallery tile. Times are window-local (fit models are
// time-origin invariant).
export function buildLOSDataset(losNode, frame0 = 0, frame1 = (losNode.frames ?? 1) - 1) {
    frame0 = Math.max(0, Math.min(losNode.frames - 1, Math.round(frame0)));
    frame1 = Math.max(frame0, Math.min(losNode.frames - 1, Math.round(frame1)));
    const n = frame1 - frame0 + 1;

    // Center the tangent plane on the mean sensor position. Keeping local
    // coordinates small improves the normal-equation solves; the paired
    // conversion helpers only need this origin's latitude and longitude.
    let meanX = 0, meanY = 0, meanZ = 0;
    for (let f = frame0; f <= frame1; f++) {
        const los = losNode.v(f);
        meanX += los.position.x;
        meanY += los.position.y;
        meanZ += los.position.z;
    }
    meanX /= n;
    meanY /= n;
    meanZ /= n;

    const originLLA = ECEFToLLA_radii(meanX, meanY, meanZ);
    const originLat = originLLA[0];
    const originLon = originLLA[1];

    // Float64 throughout: sensor ENU coordinates span tens of km, and the
    // stationary/CV solves difference near-equal large values — Float32's
    // ~0.5-4 m quantization at those magnitudes is the largest error source
    // in an otherwise double-precision pipeline (buildAnalysisDataset is f64).
    const sensorPos = new Float64Array(n * 3);
    const losDir = new Float64Array(n * 3);
    // The camera's IMAGE-PLANE basis, which a boresight-aware fit needs: an
    // operator's pointing error is smooth in image coordinates, not in world
    // ones (see WindTracerFit.js). LOS nodes expose up/right only optionally,
    // so fall back to a world-referenced pair built from the heading — that
    // ignores camera roll, which costs a rolled fit a little accuracy but never
    // correctness, since the two axes still span the plane orthogonal to the
    // sightline.
    const camUp = new Float64Array(n * 3);
    const camRight = new Float64Array(n * 3);
    // Per-frame vertical field of view, degrees, where the LOS reports one.
    // A fit can then ask whether its residual would have put the object OUTSIDE
    // the frame — the one hard fact anyone has about a hand-slewed boresight.
    // NaN where unknown, so a consumer must handle absence rather than assume a
    // default that quietly licenses any residual.
    const vFOV = new Float64Array(n).fill(NaN);
    const times = new Float64Array(n);

    for (let i = 0; i < n; i++) {
        const los = losNode.v(frame0 + i);
        const posENU = ECEF2ENU_radii(los.position, originLat, originLon);
        sensorPos[i * 3] = posENU.x;
        sensorPos[i * 3 + 1] = posENU.y;
        sensorPos[i * 3 + 2] = posENU.z;

        // `true` selects vector rotation: a heading must not receive the ECEF
        // origin translation used when converting a position.
        const dirENU = ECEF2ENU_radii(los.heading, originLat, originLon, true);
        losDir[i * 3] = dirENU.x;
        losDir[i * 3 + 1] = dirENU.y;
        losDir[i * 3 + 2] = dirENU.z;

        let rx, ry, rz, ux, uy, uz;
        if (los.right && los.up) {
            const rENU = ECEF2ENU_radii(los.right, originLat, originLon, true);
            const uENU = ECEF2ENU_radii(los.up, originLat, originLon, true);
            rx = rENU.x; ry = rENU.y; rz = rENU.z;
            ux = uENU.x; uy = uENU.y; uz = uENU.z;
        } else {
            // right = normalize(heading x ENU-up), up = right x heading
            rx = dirENU.y; ry = -dirENU.x; rz = 0;
            const rn = Math.hypot(rx, ry, rz);
            if (rn < 1e-9) { rx = 1; ry = 0; rz = 0; } else { rx /= rn; ry /= rn; rz /= rn; }
            ux = ry * dirENU.z - rz * dirENU.y;
            uy = rz * dirENU.x - rx * dirENU.z;
            uz = rx * dirENU.y - ry * dirENU.x;
        }
        const rn = Math.hypot(rx, ry, rz) || 1;
        const un = Math.hypot(ux, uy, uz) || 1;
        camRight[i * 3] = rx / rn; camRight[i * 3 + 1] = ry / rn; camRight[i * 3 + 2] = rz / rn;
        camUp[i * 3] = ux / un; camUp[i * 3 + 1] = uy / un; camUp[i * 3 + 2] = uz / un;
        if (Number.isFinite(los.vFOV) && los.vFOV > 0) vFOV[i] = los.vFOV;

        // Uniform frame spacing. GlobalDateTimeNode.frameToMS quantizes to
        // integer milliseconds, so its per-frame deltas jitter (e.g. 33,34,33
        // ms at 30fps). A fit places its output at P0+V*t, so that time jitter
        // becomes ~0.15m of per-frame position wobble at high fit speeds, which
        // the g-force graph (a second difference assuming a uniform 1/fps step,
        // amplified by fps^2) blows up into tens of spurious g. Frames are
        // uniformly spaced in real time for a constant-fps sitch. One video
        // frame spans simSpeed/fps real seconds (simSpeed was ignored before,
        // inflating fitted speeds by simSpeed on time-compressed sitches).
        times[i] = i * (Sit.simSpeed ?? 1) / Sit.fps;
    }

    return {
        dataset: {sensorPos, losDir, camUp, camRight, vFOV, times, count: n, maxRange: null, frame0, frame1},
        originLat,
        originLon,
    };
}

/**
 * Unpack a Float32Array or Float64Array of ENU positions into an array of
 * {position: Vector3} objects in ECEF.
 */
// Unpack fitted ENU positions (nWin entries — the fitted A-B window) into a
// {position} array covering totalFrames: frames before the window hold its
// first position, frames after hold its last (outside the analyzed In/Out
// range we claim no knowledge of motion). Defaults = full-clip fit,
// identical to the historical behaviour.
export function unpackFitPositions(positions, nWin, originLat, originLon,
                                   frame0 = 0, totalFrames = nWin) {
    // Convert the fitted window first; outside it, endpoint holds deliberately
    // avoid inventing motion in frames that were not part of the fit.
    const win = [];
    for (let f = 0; f < nWin; f++) {
        const enuPos = new Vector3(
            positions[f * 3],
            positions[f * 3 + 1],
            positions[f * 3 + 2],
        );
        win.push({position: ENU2ECEF_radii(enuPos, originLat, originLon)});
    }
    if (frame0 === 0 && totalFrames <= nWin) return win;
    const result = new Array(totalFrames);
    const first = win[0].position, last = win[win.length - 1].position;
    for (let f = 0; f < totalFrames; f++) {
        if (f < frame0) result[f] = {position: first.clone()};
        else if (f >= frame0 + nWin) result[f] = {position: last.clone()};
        else result[f] = win[f - frame0];
    }
    return result;
}

// ---------------------------------------------------------------------------
// CV-family conditioning diagnostic (from the BOT Bench benchmark —
// benchmarks/botbench/, which is the reference implementation and the source
// of the thresholds below).
//
// WHAT THIS IS: the reciprocal condition number of the column-equilibrated
// constant-velocity DESIGN system over the sightlines — a measure of whether
// the linear-fit family (CV, CA, the Kalman smoother's CV process model, and
// the Monte Carlo fits seeded from CV) can determine range from this geometry
// at all. Benchmarked against known truth (GEO-DURATION block): the CV
// collapse rate was 82% in the log10(rcond) ~ -3 bin, 72% at ~ -2.5, and 0%
// at ~ -2 and above — a sharp RISK gradient, not a per-case guarantee in
// either direction (a formally derived detection threshold landed at
// 10^-2.457 with weighted ROC-AUC 0.79).
//
// WHAT THIS IS NOT: a universal range-observability proof. It speaks for the
// CV FAMILY only — a stationary-point, physical, or ray-constrained method
// can succeed where CV collapses (measured: fixed-point at 8% error in cells
// where CV sat at 100%). It is also ONE-WAY: observed pointing error can
// inflate apparent conditioning, so "good" must never be presented as a
// guarantee that the recovered range is right — only "poor" is load-bearing,
// as a warning.
// ---------------------------------------------------------------------------

export const LINEAR_RCOND_POOR = 10 ** -2.5;
export const LINEAR_RCOND_MARGINAL = 1e-2;

// An estimate within this distance of the sensor has no defined apparent
// direction — the fit has collapsed onto the camera (matches the benchmark's
// convention; meanAngularError reads such points as PI).
const ON_SENSOR_EPS_M = 1e-6;

// Eigenvalues of a symmetric m x m matrix (flat row-major) by cyclic Jacobi.
// The fixed small matrix (m=6 here) makes this dependency-free iteration
// simpler than introducing a general SVD solely for a conditioning metric.
function _symmetricEigenvalues(A, m) {
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

/**
 * Assess CV-family conditioning of a sightline dataset, and (optionally) the
 * collapse state of a fitted track.
 *
 * dataset: either the LOSFitting form {sensorPos, losDir, times, count} or
 * the TraverseAnalysis form {S, D, n, fps} (normalized internally).
 * options.excluded: optional Set of excluded frame indices.
 * options.positions: optional Float64Array(count*3) of fitted ENU positions;
 * when given, collapse statistics are computed against the sightlines.
 *
 * Returns {rcond, log10Rcond, effectiveRank, conditioning} plus, with
 * positions, {finiteFraction, onSensorFraction, behindSensorFraction,
 * medianSignedRangeM, collapse}. `conditioning` is "poor" | "marginal" |
 * "good"; treat it as a one-way warning (see the header note).
 */
export function assessLinearFitConditioning(dataset, options = {}) {
    const excluded = options.excluded ?? null;
    const sensorPos = dataset.sensorPos ?? dataset.S;
    const losDir = dataset.losDir ?? dataset.D;
    const count = dataset.count ?? dataset.n ?? 0;
    let times = dataset.times;
    if (!times && dataset.fps > 0) {
        times = new Float64Array(count);
        for (let i = 0; i < count; i++) times[i] = i / dataset.fps;
    }

    const active = [];
    for (let i = 0; i < count; i++) {
        if (!excluded || !excluded.has(i)) active.push(i);
    }

    const out = {rcond: null, log10Rcond: null, effectiveRank: null, conditioning: "poor"};
    if (active.length >= 2 && times) {
        let tMin = Infinity, tMax = -Infinity;
        for (const f of active) {
            if (times[f] < tMin) tMin = times[f];
            if (times[f] > tMax) tMax = times[f];
        }
        const mid = (tMin + tMax) / 2;
        const halfSpan = (tMax - tMin) / 2 || 1;

        // G = sum B^T B with B_i = P_i [I, tau_i I], P_i = I - d d^T, tau
        // centered/normalized time. Since P is symmetric and idempotent,
        // P^T P=P, which is why the blocks below accumulate P directly.
        // Equilibrate columns, then rcond = sqrt(lambdaMin/lambdaMax) of the
        // standardized design system.
        const G = new Float64Array(36);
        for (const f of active) {
            const b = f * 3;
            const dl = Math.hypot(losDir[b], losDir[b + 1], losDir[b + 2]) || 1;
            const dx = losDir[b] / dl, dy = losDir[b + 1] / dl, dz = losDir[b + 2] / dl;
            const tau = (times[f] - mid) / halfSpan;
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
        // Normalize each column by sqrt(G_ii). This removes arbitrary position-
        // versus-velocity units, so the diagnostic measures geometric dependence
        // rather than raw column magnitudes.
        const dinv = new Float64Array(6);
        for (let i = 0; i < 6; i++) {
            const dii = G[i * 6 + i];
            dinv[i] = dii > 0 ? 1 / Math.sqrt(dii) : 0;
        }
        const C = new Float64Array(36);
        for (let i = 0; i < 6; i++)
            for (let j = 0; j < 6; j++) C[i * 6 + j] = G[i * 6 + j] * dinv[i] * dinv[j];
        const ev = _symmetricEigenvalues(C, 6);
        const lambdaMax = ev[5];
        if (lambdaMax > 0) {
            // Roundoff can make the smallest eigenvalue microscopically
            // negative even though a Gram matrix is positive semidefinite.
            const rcond = Math.sqrt(Math.max(0, ev[0]) / lambdaMax);
            out.rcond = rcond;
            out.log10Rcond = Math.log10(Math.max(rcond, Number.MIN_VALUE));
            out.effectiveRank = ev.filter((e) => e > 1e-10 * lambdaMax).length;
            out.conditioning = rcond < LINEAR_RCOND_POOR ? "poor"
                : rcond < LINEAR_RCOND_MARGINAL ? "marginal" : "good";
        }
    }

    const positions = options.positions ?? null;
    if (positions && count > 0) {
        // Collapse statistics honor the same exclusions as the conditioning:
        // fractions are over ACTIVE finite frames, so an excluded segment
        // cannot dilute or trigger the verdict.
        let activeCount = 0, finite = 0, onSensor = 0, behind = 0;
        const signedRanges = [];
        for (let i = 0; i < count; i++) {
            if (excluded && excluded.has(i)) continue;
            activeCount++;
            const b = i * 3;
            const px = positions[b], py = positions[b + 1], pz = positions[b + 2];
            if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
            finite++;
            const rx = px - sensorPos[b], ry = py - sensorPos[b + 1], rz = pz - sensorPos[b + 2];
            const r = Math.hypot(rx, ry, rz);
            if (r <= ON_SENSOR_EPS_M) { onSensor++; signedRanges.push(0); continue; }
            const dl = Math.hypot(losDir[b], losDir[b + 1], losDir[b + 2]) || 1;
            const lambda = (rx * losDir[b] + ry * losDir[b + 1] + rz * losDir[b + 2]) / dl;
            if (lambda < 0) behind++;
            signedRanges.push(lambda);
        }
        signedRanges.sort((a, b) => a - b);
        const median = signedRanges.length
            ? signedRanges[signedRanges.length >> 1] : null;
        out.finiteFraction = activeCount ? finite / activeCount : 0;
        out.onSensorFraction = finite ? onSensor / finite : 0;
        out.behindSensorFraction = finite ? behind / finite : 0;
        out.medianSignedRangeM = median;
        // Collapse verdicts, most to least direct:
        //  - on-sensor / behind-sensor: the track itself demonstrates it;
        //  - near-camera-weak-geometry: a sub-10 m median range (the measured
        //    1-8 m parallax-free failures) counts ONLY when conditioning is
        //    also poor — a well-conditioned genuinely-close solution that the
        //    sightline geometry actually supports must never be condemned by
        //    an absolute distance rule.
        out.collapseReason = out.onSensorFraction > 0.5 ? "on-sensor"
            : out.behindSensorFraction > 0.5 ? "behind-sensor"
            : (median !== null && median < 10 && out.conditioning === "poor")
                ? "near-camera-weak-geometry"
                : null;
        out.collapse = out.collapseReason !== null;
    }
    return out;
}
