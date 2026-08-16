/**
 * crlbTriage.js — the class-conditioned PREDICTED-PRECISION score (program
 * step 9): before any fitting, how well could range possibly be recovered for
 * an assumed dynamics class, from geometry + sample count + declared noise
 * alone?
 *
 * THE NUMBER. Under an assumed dynamics class the target state is a polynomial
 * in time — order 1 is constant velocity, 6 parameters in 3-D; order 2 adds a
 * constant acceleration, 9. A bearing measurement carries two numbers with
 * per-axis angular noise sigma, and a displacement of the target only shows up
 * in the plane perpendicular to the sightline, divided by the range. So the
 * Fisher information for the class parameters theta is
 *
 *     J = (1/sigma^2) * sum_f  H_f^T P_f H_f / r_f^2
 *     H_f = [I, tau_f I, tau_f^2 I, ...]      (3 x 3(order+1))
 *     P_f = I - u_f u_f^T                     (the tangent plane)
 *
 * with r_f the range and u_f the unit sightline AT THE ASSUMED TRAJECTORY. The
 * bound on the range at a reference frame follows from its gradient
 * g = dr/dtheta: sigma_r = sqrt(g^T J^-1 g), reported as the dimensionless
 * fraction sigma_r / r.
 *
 * WHY IT SPLITS CLEANLY. J is proportional to N/sigma^2, so the bound factors
 * into a noise term and a pure-geometry term:
 *
 *     sigma_r / r  =  (sigma / sqrt(N)) * kappa,     kappa = sqrt(g^T A^-1 g)/r
 *
 * where A = (sigma^2/N) J is the AVERAGE per-sample information. kappa is free
 * of both sigma and N, and is invariant to an overall scaling of the scene: it
 * is the geometry's range dilution of precision, and nothing but a different
 * flight path can change it. That factorization is the whole point of the
 * module — it is what makes the noise-limited vs geometry-limited label a
 * statement about the geometry rather than about this particular clip.
 *
 * THE LABEL. "Would more data help?" At fixed geometry the bound falls as
 * 1/sqrt(N) whenever kappa is finite, so the honest answer is not a single
 * asymptote but a required-sample count: reaching a target fraction needs
 * N * (kappa*sigma/target)^2 samples. Above a growth factor the analyst cannot
 * buy, the case is geometry-limited in practice; when kappa is infinite — the
 * classic straight-line-observer degeneracy, where scaling the whole geometry
 * about the sensor reproduces every bearing exactly — it is geometry-limited
 * as a matter of algebra and no N whatsoever helps. Both thresholds below are
 * policy, not physics, and are returned with the answer.
 *
 * NO TRUTH, STRUCTURALLY. The bound must be evaluated AT a trajectory, and the
 * true one is unknown, so it is evaluated over a coarse log-spaced grid of
 * candidate ranges across the search bracket, each with the velocity (and
 * higher coefficients) that the observed sightlines imply at that range, and
 * min/median/max are reported over the grid. This module imports nothing, is
 * handed nothing but sensor positions, observed unit sightlines, times and a
 * declared sigma, and rejects unknown keys on every input object — there is no
 * argument through which a truth track, a generating range or a fitted answer
 * could arrive, and no future caller can smuggle one in as an extra field.
 *
 * WHAT IT IS NOT (see PREDICTION_CAVEAT, returned with every result). This is
 * a LOWER BOUND on the error of an unbiased estimator OF A CORRECTLY SPECIFIED
 * MODEL. A real fit can only do worse. If the true target is not in the
 * assumed class the bound says nothing at all about it — a 2% predicted
 * fractional range error on a constant-velocity hypothesis is not 2% accuracy,
 * and is not a precision guarantee under any reading.
 */

// Coarse by design: the grid is a sweep over an unknown range, not a search.
export const DEFAULT_GRID_COUNT = 12;

// Policy knobs for the noise-limited / geometry-limited label. The target is
// the fractional range error at which a range answer becomes worth having (the
// tractability study's usable-recovery band); the growth factor is how much
// more data an analyst could plausibly obtain at the same geometry.
export const TARGET_SIGMA_R_OVER_R = 0.1;
export const MAX_SAMPLE_GROWTH = 100;

export const LIMIT_NOISE = "noise-limited";
export const LIMIT_GEOMETRY = "geometry-limited";
export const LIMIT_NONE = "class-excluded";

export const PREDICTION_CAVEAT =
    "CRLB lower bound for a correctly specified model: an unbiased estimator of "
    + "this dynamics class cannot do better, any real fit does worse, and if the "
    + "target is not in this class the bound says nothing. Not a precision guarantee.";

// Eigenvalues this far below the largest are treated as directions the
// geometry cannot see at all, rather than inverted into a huge finite number
// that is really a floating-point artifact of an exactly singular problem.
// It sits about five orders of magnitude above double-precision round-off for
// a matrix this size, so it cannot mistake round-off for information; the cost
// is that a geometry conditioned between 1e-10 and round-off reports as
// unobservable rather than as a bound of order 1e5 range fractions, which is
// the same operational answer. Each grid point carries its own rcond so the
// two cases can be told apart by the reader.
const CONDITION_FLOOR = 1e-10;

// A gradient component smaller than this fraction of |g| does not count as
// "leaning on" an unseen direction (it is round-off, not information).
const PROJECTION_FLOOR = 1e-8;

// An assumed trajectory that reaches the sensor makes the 1/r weighting
// meaningless; such a grid point is reported, but not scored.
const MIN_ASSUMED_RANGE_M = 1;

const GEOMETRY_KEYS = ["sensorPositionENU", "observedDirectionENU", "times",
    "activeFrames", "sigmaRad"];
const TRIAGE_KEYS = ["minRangeM", "maxRangeM", "gridCount", "dynamicsOrder",
    "speedEnvelopeMS", "className", "targetSigmaROverR", "maxSampleGrowth"];

// The structural no-truth guard: every input object is closed. An unexpected
// key is a bug or a smuggled answer, and either way it stops the run.
function requireExactKeys(obj, allowed, where) {
    if (obj === null || typeof obj !== "object") {
        throw new Error(`botbench: ${where} expects an options object`);
    }
    for (const k of Object.keys(obj)) {
        if (!allowed.includes(k)) {
            throw new Error(`botbench: ${where} got unexpected key "${k}" `
                + `(allowed: ${allowed.join(", ")}). This module never accepts truth.`);
        }
    }
}

// ---------------------------------------------------------------------------
// Dense symmetric linear algebra. Small (at most 12x12), so cyclic Jacobi is
// both the simplest and the most accurate option, and it hands us the
// eigenvectors that the conditioning floor above needs.
// ---------------------------------------------------------------------------

// A = sum_k values[k] * q_k q_k^T, with q_k in column k of vectors
// (vectors[i*m + k] is component i of q_k). Values are NOT sorted.
function symmetricEigen(A, m) {
    const a = Float64Array.from(A);
    const v = new Float64Array(m * m);
    for (let i = 0; i < m; i++) v[i * m + i] = 1;
    for (let sweep = 0; sweep < 64; sweep++) {
        let off = 0;
        for (let p = 0; p < m - 1; p++)
            for (let q = p + 1; q < m; q++) off += a[p * m + q] * a[p * m + q];
        if (off < 1e-30) break;
        for (let p = 0; p < m - 1; p++) {
            for (let q = p + 1; q < m; q++) {
                const apq = a[p * m + q];
                if (Math.abs(apq) < 1e-300) continue;
                const app = a[p * m + p], aqq = a[q * m + q];
                const theta = (aqq - app) / (2 * apq);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;
                for (let k = 0; k < m; k++) {          // columns: A <- A J
                    const akp = a[k * m + p], akq = a[k * m + q];
                    a[k * m + p] = c * akp - s * akq;
                    a[k * m + q] = s * akp + c * akq;
                }
                for (let k = 0; k < m; k++) {          // rows: A <- J^T A
                    const apk = a[p * m + k], aqk = a[q * m + k];
                    a[p * m + k] = c * apk - s * aqk;
                    a[q * m + k] = s * apk + c * aqk;
                }
                for (let k = 0; k < m; k++) {          // accumulate V <- V J
                    const vkp = v[k * m + p], vkq = v[k * m + q];
                    v[k * m + p] = c * vkp - s * vkq;
                    v[k * m + q] = s * vkp + c * vkq;
                }
            }
        }
    }
    const values = new Float64Array(m);
    for (let i = 0; i < m; i++) values[i] = a[i * m + i];
    return {values, vectors: v};
}

function maxAbsEigenvalue(values) {
    let mx = 0;
    for (let k = 0; k < values.length; k++) mx = Math.max(mx, Math.abs(values[k]));
    return mx;
}

// lambdaMin/lambdaMax of an information matrix (never negative: a Fisher
// information is positive semi-definite, so a negative eigenvalue is round-off
// around zero). Reported per grid point as the audit trail for CONDITION_FLOOR.
function conditioning(values) {
    let lo = Infinity, hi = 0;
    for (let k = 0; k < values.length; k++) {
        if (values[k] < lo) lo = values[k];
        if (values[k] > hi) hi = values[k];
    }
    return hi > 0 ? Math.max(0, lo) / hi : 0;
}

// Least-norm solution of A x = b for symmetric A: directions below the
// conditioning floor are DROPPED, not amplified. Used for the assumed-velocity
// fit, where a null direction means "the sightlines do not constrain this
// component" and the least-norm choice is the neutral one.
function pseudoSolve(eig, m, b) {
    const {values, vectors} = eig;
    const cut = CONDITION_FLOOR * maxAbsEigenvalue(values);
    const x = new Float64Array(m);
    for (let k = 0; k < m; k++) {
        if (Math.abs(values[k]) <= cut) continue;
        let dot = 0;
        for (let i = 0; i < m; i++) dot += vectors[i * m + k] * b[i];
        const c = dot / values[k];
        for (let i = 0; i < m; i++) x[i] += c * vectors[i * m + k];
    }
    return x;
}

// g^T A^-1 g in spectral form, or Infinity when g leans on a direction the
// geometry cannot see. Returning Infinity is the honest answer for an exactly
// singular Fisher information: the parameter combination is unobservable, so
// no estimator has bounded variance for it, and no sample count changes that.
function quadraticFormInverse(eig, m, g) {
    const {values, vectors} = eig;
    const cut = CONDITION_FLOOR * maxAbsEigenvalue(values);
    let gNorm = 0;
    for (let i = 0; i < m; i++) gNorm += g[i] * g[i];
    gNorm = Math.sqrt(gNorm);
    let sum = 0;
    for (let k = 0; k < m; k++) {
        let dot = 0;
        for (let i = 0; i < m; i++) dot += vectors[i * m + k] * g[i];
        if (values[k] <= cut) {
            if (Math.abs(dot) > PROJECTION_FLOOR * gNorm) return Infinity;
            continue;                                  // g is orthogonal to it
        }
        sum += (dot * dot) / values[k];
    }
    return sum;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The only way into this module. Takes the OBSERVED sightline set and nothing
 * else, and compacts it to the active frames.
 *
 * sigmaRad is the PER-AXIS tangent-plane pointing standard deviation. An
 * observation's realized RMS angular error is the magnitude of a 2-D error, so
 * it is sqrt(2) larger than this — passing it unconverted doubles the
 * predicted variance. Declared sigma should be replaced by the empirical
 * estimate where one exists (program step 6); every number here scales as
 * sigma, so a misdeclaration propagates in full.
 */
export function makeLosGeometry(fields) {
    requireExactKeys(fields, GEOMETRY_KEYS, "makeLosGeometry");
    const {sensorPositionENU, observedDirectionENU, times, activeFrames, sigmaRad} = fields;
    if (!(sigmaRad > 0) || !Number.isFinite(sigmaRad)) {
        throw new Error("botbench: makeLosGeometry needs a positive finite sigmaRad");
    }
    const n = times.length;
    if (sensorPositionENU.length < n * 3 || observedDirectionENU.length < n * 3) {
        throw new Error("botbench: makeLosGeometry position/direction arrays are shorter than times");
    }
    const active = Array.from(activeFrames ?? times.keys());
    if (active.length < 3) {
        // Two frames give 4 numbers against 6 constant-velocity parameters; the
        // bound would be infinite by construction and says nothing useful.
        throw new Error("botbench: makeLosGeometry needs at least 3 active frames");
    }

    const k = active.length;
    const S = new Float64Array(k * 3);
    const D = new Float64Array(k * 3);
    const t = new Float64Array(k);
    for (let i = 0; i < k; i++) {
        const f = active[i];
        if (!Number.isInteger(f) || f < 0 || f >= n) {
            throw new Error(`botbench: makeLosGeometry active frame ${f} out of range`);
        }
        if (i > 0 && times[f] <= times[active[i - 1]]) {
            throw new Error("botbench: makeLosGeometry needs active frames in strictly increasing time order");
        }
        t[i] = times[f];
        const b = f * 3;
        const dx = observedDirectionENU[b], dy = observedDirectionENU[b + 1], dz = observedDirectionENU[b + 2];
        const L = Math.hypot(dx, dy, dz);
        if (!(L > 0)) throw new Error(`botbench: makeLosGeometry zero sightline at frame ${f}`);
        D[i * 3] = dx / L; D[i * 3 + 1] = dy / L; D[i * 3 + 2] = dz / L;
        for (let c = 0; c < 3; c++) {
            const s = sensorPositionENU[b + c];
            if (!Number.isFinite(s)) throw new Error(`botbench: makeLosGeometry non-finite sensor position at frame ${f}`);
            S[i * 3 + c] = s;
        }
    }

    // Time basis: the epoch is the MIDDLE active frame and time is scaled to
    // the half-span, so the design blocks are comparable in magnitude (the
    // equilibration diagnostics.js applies for the same reason) and the
    // position and velocity blocks are as decorrelated as this window allows.
    // Because the epoch is the reference frame, the range gradient has no
    // velocity component at all, which is what makes the reported bound a
    // statement about that frame's range and not about a fitted trajectory.
    const ref = k >> 1;
    const tScale = Math.max((t[k - 1] - t[0]) / 2, Number.MIN_VALUE);
    const tau = new Float64Array(k);
    for (let i = 0; i < k; i++) tau[i] = (t[i] - t[ref]) / tScale;

    // Tangent projectors of the OBSERVED rays, used to anchor a candidate
    // trajectory to the sightlines. The Fisher information itself rebuilds its
    // projectors from the assumed trajectory instead.
    const projObserved = new Float64Array(k * 9);
    for (let i = 0; i < k; i++) {
        const dx = D[i * 3], dy = D[i * 3 + 1], dz = D[i * 3 + 2];
        const p = projObserved;
        const o = i * 9;
        p[o] = 1 - dx * dx; p[o + 1] = -dx * dy; p[o + 2] = -dx * dz;
        p[o + 3] = -dy * dx; p[o + 4] = 1 - dy * dy; p[o + 5] = -dy * dz;
        p[o + 6] = -dz * dx; p[o + 7] = -dz * dy; p[o + 8] = 1 - dz * dz;
    }

    return Object.freeze({
        nActive: k, S, D, tau, tScale, ref, projObserved, sigmaRad,
        durationS: t[k - 1] - t[0],
    });
}

// ---------------------------------------------------------------------------
// The assumed trajectory at a candidate range
// ---------------------------------------------------------------------------

/**
 * Place the target on the reference frame's observed ray at range R, then take
 * the polynomial coefficients that the REST of the sightlines imply: the
 * least-squares minimizer of the perpendicular miss distance to every observed
 * ray. That is a small linear solve (no iteration, no class physics, no
 * optimizer), and it is the natural reading of "the velocity implied by the
 * geometry at this range" — the same family whose precision the bound is about.
 *
 * Returns null when the implied trajectory reaches the sensor, where the 1/r
 * weighting stops meaning anything and the grid point is not an evaluation
 * point at all.
 */
function assumedTrajectory(geo, rangeM, order) {
    const {nActive, S, D, tau, tScale, ref, projObserved} = geo;
    const c0 = [
        S[ref * 3] + rangeM * D[ref * 3],
        S[ref * 3 + 1] + rangeM * D[ref * 3 + 1],
        S[ref * 3 + 2] + rangeM * D[ref * 3 + 2],
    ];

    // Normal equations for c_1..c_order (3 each):
    //   M[j][k] = sum_f tau^(j+k) P_f,   b[j] = -sum_f tau^j P_f (c0 - S_f)
    const m = 3 * order;
    const M = new Float64Array(m * m);
    const b = new Float64Array(m);
    const pw = new Float64Array(2 * order + 1);
    for (let i = 0; i < nActive; i++) {
        pw[0] = 1;
        for (let e = 1; e <= 2 * order; e++) pw[e] = pw[e - 1] * tau[i];
        const o = i * 9;
        const d0 = c0[0] - S[i * 3], d1 = c0[1] - S[i * 3 + 1], d2 = c0[2] - S[i * 3 + 2];
        // P_f (c0 - S_f), reused across all j.
        const pd = [
            projObserved[o] * d0 + projObserved[o + 1] * d1 + projObserved[o + 2] * d2,
            projObserved[o + 3] * d0 + projObserved[o + 4] * d1 + projObserved[o + 5] * d2,
            projObserved[o + 6] * d0 + projObserved[o + 7] * d1 + projObserved[o + 8] * d2,
        ];
        for (let j = 1; j <= order; j++) {
            for (let r = 0; r < 3; r++) b[(j - 1) * 3 + r] -= pw[j] * pd[r];
            for (let k = 1; k <= order; k++) {
                const w = pw[j + k];
                for (let r = 0; r < 3; r++)
                    for (let c = 0; c < 3; c++)
                        M[((j - 1) * 3 + r) * m + (k - 1) * 3 + c] += w * projObserved[o + r * 3 + c];
            }
        }
    }
    const coef = pseudoSolve(symmetricEigen(M, m), m, b);

    // Sample the trajectory: positions, ranges, assumed unit sightlines, and
    // the implied speed (the derivative in real seconds, not in tau).
    const pos = new Float64Array(nActive * 3);
    const dir = new Float64Array(nActive * 3);
    const range = new Float64Array(nActive);
    let minSpeed = Infinity, maxSpeed = 0, sumSpeed = 0;
    for (let i = 0; i < nActive; i++) {
        pw[0] = 1;
        for (let e = 1; e <= order; e++) pw[e] = pw[e - 1] * tau[i];
        let vx = 0, vy = 0, vz = 0;
        for (let r = 0; r < 3; r++) {
            let x = c0[r];
            for (let k = 1; k <= order; k++) x += coef[(k - 1) * 3 + r] * pw[k];
            pos[i * 3 + r] = x;
        }
        for (let k = 1; k <= order; k++) {
            const w = k * pw[k - 1] / tScale;
            vx += w * coef[(k - 1) * 3];
            vy += w * coef[(k - 1) * 3 + 1];
            vz += w * coef[(k - 1) * 3 + 2];
        }
        const rx = pos[i * 3] - S[i * 3], ry = pos[i * 3 + 1] - S[i * 3 + 1], rz = pos[i * 3 + 2] - S[i * 3 + 2];
        const L = Math.hypot(rx, ry, rz);
        if (!(L >= MIN_ASSUMED_RANGE_M)) return null;
        range[i] = L;
        dir[i * 3] = rx / L; dir[i * 3 + 1] = ry / L; dir[i * 3 + 2] = rz / L;
        const sp = Math.hypot(vx, vy, vz);
        if (sp < minSpeed) minSpeed = sp;
        if (sp > maxSpeed) maxSpeed = sp;
        sumSpeed += sp;
    }
    return {
        dir, range,
        minSpeedMS: minSpeed,
        maxSpeedMS: maxSpeed,
        meanSpeedMS: sumSpeed / nActive,
    };
}

/**
 * The average per-sample Fisher information A = (sigma^2/N) J in the tau-scaled
 * parameter basis, evaluated at an assumed trajectory. Factoring sigma and N
 * out here is what leaves kappa as pure geometry.
 */
function averageInformation(geo, traj, order) {
    const {nActive, tau} = geo;
    const m = 3 * (order + 1);
    const A = new Float64Array(m * m);
    const pw = new Float64Array(order + 1);
    for (let i = 0; i < nActive; i++) {
        pw[0] = 1;
        for (let e = 1; e <= order; e++) pw[e] = pw[e - 1] * tau[i];
        const ux = traj.dir[i * 3], uy = traj.dir[i * 3 + 1], uz = traj.dir[i * 3 + 2];
        const w = 1 / (traj.range[i] * traj.range[i] * nActive);
        const P = [
            1 - ux * ux, -ux * uy, -ux * uz,
            -uy * ux, 1 - uy * uy, -uy * uz,
            -uz * ux, -uz * uy, 1 - uz * uz,
        ];
        for (let j = 0; j <= order; j++) {
            for (let k = 0; k <= order; k++) {
                const s = w * pw[j] * pw[k];
                for (let r = 0; r < 3; r++)
                    for (let c = 0; c < 3; c++)
                        A[(j * 3 + r) * m + k * 3 + c] += s * P[r * 3 + c];
            }
        }
    }
    return A;
}

function quantiles(sorted) {
    if (sorted.length === 0) return {min: null, median: null, max: null};
    const mid = sorted.length >> 1;
    // Fail-closed median: with an even count the two central values are
    // averaged, so an unbounded upper half reports as unbounded rather than
    // being rounded down to its finite neighbor.
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return {min: sorted[0], median, max: sorted[sorted.length - 1]};
}

// ---------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------

/**
 * Predicted fractional range precision for one assumed dynamics class.
 *
 * Options:
 *   minRangeM, maxRangeM   the SEARCH bracket (the analyst's anchor policy —
 *                          never the generating range, which this module has
 *                          no way to see);
 *   gridCount              log-spaced candidate ranges across the bracket;
 *   dynamicsOrder          1 = constant velocity (6 params), 2 = constant
 *                          acceleration (9), 3 = constant jerk (12). A class
 *                          that is allowed to accelerate spends information on
 *                          its extra parameters, so its bound is never better;
 *   speedEnvelopeMS        {minMS, maxMS} coarse catalog gate — a candidate
 *                          range whose implied speed the class cannot fly is
 *                          not a candidate for that class. This is an
 *                          admissibility filter on the grid, NOT an envelope
 *                          feasibility test (envelopeFeasibility.js is that);
 *   className              carried through for reporting only;
 *   targetSigmaROverR,
 *   maxSampleGrowth        the label policy, echoed in the result.
 */
export function crlbTriage(geometry, options = {}) {
    requireExactKeys(options, TRIAGE_KEYS, "crlbTriage");
    const {
        minRangeM, maxRangeM,
        gridCount = DEFAULT_GRID_COUNT,
        dynamicsOrder = 1,
        speedEnvelopeMS = null,
        className = null,
        targetSigmaROverR = TARGET_SIGMA_R_OVER_R,
        maxSampleGrowth = MAX_SAMPLE_GROWTH,
    } = options;
    if (!(minRangeM > 0) || !(maxRangeM >= minRangeM)) {
        throw new Error("botbench: crlbTriage needs 0 < minRangeM <= maxRangeM");
    }
    if (!Number.isInteger(dynamicsOrder) || dynamicsOrder < 1 || dynamicsOrder > 3) {
        throw new Error("botbench: crlbTriage dynamicsOrder must be 1, 2 or 3");
    }
    if (!Number.isInteger(gridCount) || gridCount < 2) {
        throw new Error("botbench: crlbTriage needs gridCount >= 2");
    }

    const {nActive, sigmaRad, ref} = geometry;
    const order = dynamicsOrder;
    const m = 3 * (order + 1);
    const noiseFactor = sigmaRad / Math.sqrt(nActive);

    // The range gradient. With the epoch AT the reference frame every tau^k
    // vanishes for k >= 1, so g is the assumed sightline in the position block
    // and zero elsewhere — the loop is written out because that cancellation is
    // a property of the basis choice, not an assumption to be hidden.
    const g = new Float64Array(m);

    const grid = [];
    const usable = [];
    const logLo = Math.log(minRangeM), logHi = Math.log(maxRangeM);
    for (let i = 0; i < gridCount; i++) {
        const rangeM = Math.exp(logLo + (logHi - logLo) * i / (gridCount - 1));
        const traj = assumedTrajectory(geometry, rangeM, order);
        if (traj === null) {
            grid.push({rangeM, admissible: false, reason: "assumed trajectory reaches the sensor",
                impliedSpeedMS: null, peakImpliedSpeedMS: null, kappa: null,
                sigmaROverR: null, rcond: null});
            continue;
        }
        let reason = null;
        if (speedEnvelopeMS) {
            if (speedEnvelopeMS.maxMS != null && traj.maxSpeedMS > speedEnvelopeMS.maxMS) {
                reason = "implied speed above the class envelope";
            } else if (speedEnvelopeMS.minMS != null && traj.minSpeedMS < speedEnvelopeMS.minMS) {
                reason = "implied speed below the class envelope";
            }
        }

        g.fill(0);
        for (let r = 0; r < 3; r++) g[r] = traj.dir[ref * 3 + r];
        const eig = symmetricEigen(averageInformation(geometry, traj, order), m);
        const q = quadraticFormInverse(eig, m, g);
        // r at the reference frame IS the grid range: the anchor put it there.
        const kappa = Math.sqrt(q) / rangeM;
        const sigmaROverR = noiseFactor * kappa;

        const point = {
            rangeM,
            admissible: reason === null,
            reason,
            impliedSpeedMS: traj.meanSpeedMS,
            peakImpliedSpeedMS: traj.maxSpeedMS,
            kappa,
            sigmaROverR,
            rcond: conditioning(eig.values),
        };
        grid.push(point);
        if (reason === null) usable.push(point);
    }

    const kappaSorted = usable.map((p) => p.kappa).sort((a, b) => a - b);
    const fracSorted = usable.map((p) => p.sigmaROverR).sort((a, b) => a - b);
    const kappaStats = quantiles(kappaSorted);
    const fracStats = quantiles(fracSorted);

    // The label, read off the median candidate — fail-closed, since a median
    // taken over an unbounded upper half is itself unbounded. sigma_r/r falls
    // as 1/sqrt(N) at fixed geometry, so "more data" is quantified as the
    // sample count that would reach the target; that count is infinite when the
    // range direction is unobservable, and then no N helps at all.
    let limit = LIMIT_NONE;
    let limitReason = "no candidate range in the bracket is admissible for this class";
    let samplesForTarget = null;
    let sampleGrowthForTarget = null;
    let rangeObservable = null;
    if (usable.length > 0) {
        rangeObservable = Number.isFinite(kappaStats.median);
        if (!rangeObservable) {
            limit = LIMIT_GEOMETRY;
            limitReason = "range is unobservable for this class at this geometry: the Fisher "
                + "information is singular along the range direction to within the conditioning "
                + "floor (see each grid point's rcond), so no sample count helps";
            samplesForTarget = Infinity;
            sampleGrowthForTarget = Infinity;
        } else {
            const growth = (fracStats.median / targetSigmaROverR) ** 2;
            samplesForTarget = nActive * growth;
            sampleGrowthForTarget = growth;
            if (growth <= maxSampleGrowth) {
                limit = LIMIT_NOISE;
                limitReason = growth <= 1
                    ? `the bound is set by noise and sample count, and sigma_r/r = ${targetSigmaROverR} `
                        + `is already predicted at ${nActive} samples`
                    : `the bound is set by noise and sample count: about ${Math.ceil(samplesForTarget)} `
                        + `samples at this geometry would reach sigma_r/r = ${targetSigmaROverR}`;
            } else {
                limit = LIMIT_GEOMETRY;
                limitReason = `the bound is set by geometry: reaching sigma_r/r = ${targetSigmaROverR} `
                    + `would take about ${Math.round(growth)}x more samples at this geometry`;
            }
        }
    }

    return {
        className,
        dynamicsOrder: order,
        parameterCount: m,
        nActive,
        sigmaRad,
        durationS: geometry.durationS,
        bracketM: {minRangeM, maxRangeM},
        gridCount,
        grid,
        admissibleCount: usable.length,

        // The headline: predicted fractional range error over the grid. This is
        // a LOWER BOUND for a correctly specified model (see PREDICTION_CAVEAT).
        sigmaROverR: fracStats,

        // Its geometry-only factor, free of sigma and N and invariant to an
        // overall scaling of the scene. sigma_r/r = kappa * sigma / sqrt(N).
        kappa: kappaStats,
        noiseFactor,

        // Would more data help? See limitReason for the arithmetic. The N ->
        // infinity value at fixed geometry is 0 whenever the range direction is
        // observable at all — the honest content of the comparison is the RATE,
        // i.e. how many samples the target costs, not the asymptote. And that
        // asymptote assumes independent per-frame pointing error: correlated
        // real pointing texture has a smaller effective N (program step 37),
        // and a systematic pointing bias is not shrunk by sqrt(N) at all.
        limit,
        limitReason,
        rangeObservable,
        sigmaROverRAsNInfinite: rangeObservable === null ? null
            : (rangeObservable ? 0 : Infinity),
        samplesForTarget,
        sampleGrowthForTarget,
        targetSigmaROverR,
        maxSampleGrowth,

        isLowerBound: true,
        caveat: PREDICTION_CAVEAT,
    };
}

/**
 * The same score for several assumed classes over one geometry — the queue
 * ordering and per-class range pre-sizing use of program step 9. Each class is
 * {className, dynamicsOrder?, speedEnvelopeMS?, minRangeM?, maxRangeM?}, with
 * anything omitted taken from the shared options. Results keep the input order:
 * nothing here sorts by a number the caller has not seen.
 */
export function crlbTriageByClass(geometry, classes, sharedOptions = {}) {
    requireExactKeys(sharedOptions, TRIAGE_KEYS, "crlbTriageByClass");
    return classes.map((c) => {
        requireExactKeys(c, TRIAGE_KEYS, "crlbTriageByClass class");
        return crlbTriage(geometry, {...sharedOptions, ...c});
    });
}
