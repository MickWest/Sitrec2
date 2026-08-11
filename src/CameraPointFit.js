// Camera resection from hand-placed 2D/3D correspondences — "Fit Camera to Points".
//
// "Resection" is the surveying word for working backwards: instead of standing at a known place
// and measuring where things are, you measure where known things appear and work out where you
// must have been standing.
//
//
// THE PROBLEM. A redacted video arrives with no platform position and no field of view. The
// analyst can still recognise landmarks — a headland, a mast, a building corner — and can say
// "that pixel is that place". Given enough of those pairs, the camera that produced the frame is
// determined. This module is the solver for that.
//
//
// HOW IT WORKS, in one paragraph. A camera is described by seven numbers: where it is (3), which
// way it points (3), and how zoomed in it is (1). Guess those seven numbers, and you can compute
// where each landmark SHOULD appear in the frame. Compare that to where the analyst actually
// clicked, and you get an error in pixels. The solver then adjusts the seven numbers to make that
// total error as small as possible. That is all it is: guess, measure the miss, improve the
// guess, repeat. The rest of this file is about doing that reliably — starting from a sensible
// guess, not being derailed by one badly placed point, and above all knowing when the answer is
// not actually determined by the data.
//
//
// WHY THE COUNT OF POINTS IS NOT THE POINT. Each correspondence contributes two equations (one
// for the x pixel, one for the y), so four pairs is the algebraic minimum and six is the first
// count with useful redundancy. But the count is never sufficient on its own — four landmarks
// strung along a horizon determine far less than four spread over the frame at different ranges.
// So every solve reports its own OBSERVABILITY (which combinations of the seven numbers the data
// could actually pin down) rather than just a residual. See `buildDiagnostics`.
//
//
// Pure module: plain arrays in, plain objects out. No THREE, no DOM, no Sitrec globals. The two
// things that genuinely need the host — the local up/north frame at a given ECEF position, and
// the lens — are passed in. That keeps this unit-testable and keeps the geometry honest, because
// the caller supplies the SAME local-frame function the camera controller uses.
//
//
// CONVENTIONS, stated once:
//
//   World is ECEF metres, as plain [x, y, z] arrays. ECEF is Earth-Centred Earth-Fixed: the
//   origin is the centre of the planet, so every coordinate is in the millions.
//
//   Camera space is the CameraLens convention: +x RIGHT, +y DOWN, +z FORWARD. Not the three.js
//   convention. Everything here works in {right, down, fwd} world-space basis vectors so a pixel
//   offset maps to a ray component with no sign flip, and so `rayToPixel` can be handed the
//   result directly.
//
//   Orientation is (az, el, roll) in DEGREES — azimuth is a compass bearing, elevation is the
//   tilt up or down from horizontal, roll is rotation about the direction of view. It is built by
//   exactly the construction CNodeControllerAzElZoom.apply() uses: north rotated by el about
//   local east, then by -az about local up, then rolled about the view axis.
//
//   That is a deliberate choice and the reason is worth stating: az/el/roll is also the
//   WRITE-BACK target (ptzAngles), so solving in it makes the applied camera identical to the
//   solved camera by construction rather than by a conversion that has to be trusted. It also
//   makes "Lock Roll" an exact removal of a parameter instead of a constraint that leaks.
//
//   The cost of that choice is a singularity at |el| = 90 deg, where azimuth stops being defined
//   — pointing straight up or straight down, every azimuth describes the same view. That is a
//   pose with no ground landmarks in frame and therefore not a pose this feature can be used from
//   at all. The solver refuses past MAX_ABS_EL rather than returning a confident answer from a
//   coordinate system that has broken down.

import {lensFromVFOV, rayToPixel} from "./CameraLens";

/** Beyond this elevation the azimuth parameter stops being identifiable. See the header. */
export const MAX_ABS_EL = 85;

export const CAMERA_FIT_DEFAULTS = {
    // --- Levenberg-Marquardt (LM), the optimiser. ---------------------------------------------
    //
    // LM blends two strategies for improving a guess. Far from the answer it behaves like
    // gradient descent: creep downhill in small safe steps. Close to the answer it behaves like
    // Gauss-Newton: model the error surface as a bowl and jump straight to the bottom. (Gauss-
    // Newton rather than full Newton because the curvature is approximated from the Jacobian
    // alone, dropping the second-derivative term — standard for least squares, and it costs
    // nothing here since the residuals go to a few pixels.) The blend is controlled by one
    // number, `lambda`. Large lambda = small cautious steps; small lambda = big confident ones.
    //
    // The loop adapts lambda as it goes: every step that improves the error MULTIPLIES lambda by
    // lambdaDown, which is less than 1, so lambda shrinks and the next step is bolder. Every step
    // that makes things worse is thrown away and multiplies lambda by lambdaUp, which is greater
    // than 1, so lambda grows and the retry is more cautious.
    maxIterations: 120,
    lambda0: 1e-3,
    lambdaUp: 10,
    lambdaDown: 0.3,
    // Stop when the robust cost stops improving by a meaningful relative amount.
    tolerance: 1e-12,

    // --- Restarts of the WINNING run, from wherever it stopped. --------------------------------
    //
    // A run that ends at maxIterations has not converged, it has run out of budget — and on an
    // ill-conditioned configuration that is the normal outcome, because progress along a nearly
    // flat valley is slow and LM's lambda has to be re-earned after every rejected trial.
    //
    // Measured on the 3-point 38 km case: four consecutive presses of Fit Now moved the camera
    // 54 km, 2.6 km, 1.1 km and 13.4 km, each a genuine improvement (176.9 -> 62.8 -> 62.5 ->
    // 62.4 -> 61.1 px RMS), before the acceptance gate finally refused the fifth. What the user
    // saw was a fixed control point wandering every time they pressed the button; what was
    // actually happening is that pressing it again was doing the optimiser's remaining work by
    // hand, one budget at a time.
    //
    // So finish it here instead. Restarting also resets lambda, which is the point: a run that
    // has ended with lambda large is not stuck, it is just taking tiny steps.
    //
    // Costs nothing on a well-conditioned fit, where the first restart reproduces the same cost
    // and stops immediately.
    maxRestarts: 8,
    restartTolerance: 1e-6,

    // --- Huber transition, in pixels. ----------------------------------------------------------
    //
    // Plain least squares squares every error, so a point that is 50 px out contributes 100x more
    // than one 5 px out and drags the whole solution toward itself. A ROBUST LOSS limits how much
    // any single bad point can influence the answer. The Huber loss does this by switching
    // behaviour at a threshold `delta`: below it, ordinary squared error; above it, the penalty
    // grows only linearly.
    //
    // One badly placed pair should be limited, not erased: at N = 4 there is no redundancy to
    // reject anything with, and a loss that drives a deliberate placement to zero weight would
    // silently turn a 4-point solve into an underdetermined 3-point one. Huber caps the influence
    // and keeps the point in the fit.
    huberDeltaInit: 5,
    huberDelta: 3,

    // --- Initialisation sweep. -----------------------------------------------------------------
    //
    // Log-spaced because focal length is a scale: the interesting range spans three orders of
    // magnitude and a linear sweep would spend all its samples on wide angles nobody is fitting.
    focalScanCount: 21,
    focalScanMinVFOV: 0.1,
    focalScanMaxVFOV: 150,
    // How many seeds (best-scoring, plus the caller's current state) get a full LM run.
    seedsToRefine: 3,
    // Iterations of the cheap LM pass used to RANK the candidates before that.
    //
    // Ranking on the raw seed residual does not work, and the failure is not subtle: on a real
    // 5-landmark clip every one of the 42 candidates scored between 1288 and 1365 px — noise —
    // while fully refining 20 of them recovered the camera exactly. A pre-refinement residual
    // says nothing about which basin a seed will fall into, so the only honest way to compare
    // seeds is to start descending each one and see where it is heading.
    prefilterIterations: 15,

    // --- Observability. ------------------------------------------------------------------------
    //
    // The CONDITION NUMBER (kappa) measures how much the answer can move for a given wobble in
    // the input. It is the ratio of the largest to the smallest singular value of the Jacobian —
    // roughly, "the best-determined direction is this many times better determined than the
    // worst". A kappa of 10 is healthy. A kappa of 1e6 means one combination of the seven
    // parameters is essentially invisible to the data.
    //
    // These are singular values of the COLUMN-SCALED Jacobian, so they are pure numbers
    // comparable across problems rather than a mix of metres, degrees and log-focal.
    kappaWarn: 1e4,
    kappaSevere: 1e6,
    // Below this fraction of sigmaMax a mode carries no usable information and its step is
    // suppressed entirely, leaving that combination at its starting value.
    //
    // It is 1/kappaSevere, and the two MUST stay tied: kappaSevere is the threshold at which
    // buildDiagnostics reports a mode as "unobservable", which the UI renders as "cannot be
    // determined by these points — held near its previous value". At the old 1e-8 that sentence
    // was not true. Every mode between 1e-8 and 1e-6 was declared undeterminable and stepped
    // anyway, and near convergence it is stepped HARD: the SVD gain sigma/(sigma^2 + lambda)
    // tends to 1/sigma as lambda decays, so the weakest mode takes the largest step of all.
    //
    // Measured on a 3-point fit at 38 km, all three landmarks at the same range: the camera slid
    // 2.29 km along the range/focal trade-off and narrowed its field 5.7% for an RMS change of
    // 0.01 px, every time the button was pressed. Freezing at the same place the diagnostics
    // draw the line makes the promise the UI prints a fact.
    sigmaFloorRatio: 1e-6,

    // Reported uncertainty never claims better than this, however exact the algebra. A four-point
    // fit can pass exactly through its own data and still be wrong by whatever the placement
    // error is; pretending to zero uncertainty there is the single most misleading thing this
    // could output.
    pixelNoiseFloor: 2,
};

// The seven parameters live in a fixed-length array, and these name the slots. The optimiser
// works on the free subset, but the slot order never changes, so the diagnostics can name a
// parameter without threading labels through every call.
//
// P_LOGF is the LOG of the focal scale, not the focal scale itself. Optimising the log is what
// makes a step mean "10% narrower" rather than "10 pixels of focal length", which is the sensible
// thing when the plausible range spans three orders of magnitude — and it makes the value
// unbounded in both directions, so the optimiser can never step to a negative or zero focal
// length and produce a nonsense camera.
export const P_EAST = 0, P_NORTH = 1, P_UP = 2, P_AZ = 3, P_EL = 4, P_ROLL = 5, P_LOGF = 6;
export const PARAM_COUNT = 7;
export const PARAM_NAMES = ["east", "north", "up", "az", "el", "roll", "fov"];

// -----------------------------------------------------------------------------------------
// Small vector helpers. Local rather than imported: this module is plain arrays by design, and
// the Sitrec vector utilities are all THREE.Vector3.
// -----------------------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
const addScaled = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

function normalize(a) {
    const n = norm(a);
    return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
}

function centroid(list) {
    const c = [0, 0, 0];
    for (const p of list) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    return [c[0] / list.length, c[1] / list.length, c[2] / list.length];
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const DEG = Math.PI / 180;

/**
 * Rotate vector v about a UNIT axis k by `angle` radians (Rodrigues' rotation formula).
 *
 * The formula splits v into the part along the axis, which the rotation leaves alone, and the
 * part perpendicular to it, which spins in a circle. Written out, that gives:
 *
 *     v*cos(a)  +  (k x v)*sin(a)  +  k*(k . v)*(1 - cos(a))
 *
 * It is used instead of building a rotation matrix because we only ever rotate a handful of
 * vectors at a time, and this avoids constructing and multiplying a matrix to do it.
 */
function rotateAbout(v, k, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const kv = cross(k, v);
    const kd = dot(k, v) * (1 - c);
    return [
        v[0] * c + kv[0] * s + k[0] * kd,
        v[1] * c + kv[1] * s + k[1] * kd,
        v[2] * c + kv[2] * s + k[2] * kd,
    ];
}

// -----------------------------------------------------------------------------------------
// Orientation: (az, el, roll) <-> world-space camera basis.
//
// A "basis" here is just the three directions the camera considers right, down and forward,
// written as world-space vectors. These two functions convert between that and the three angles.
//
// They are exact inverses of each other, which is what the round-trip test asserts. Getting that
// wrong is the classic silent failure in this kind of code — a sign error in roll costs nothing
// until someone fits a rolled camera — so it is pinned down by construction here and by test
// rather than by inspection.
// -----------------------------------------------------------------------------------------

/**
 * World-space {right, down, fwd} for a pointing, in the CameraLens camera convention.
 *
 * Mirrors CNodeControllerAzElZoom.apply(): start at local north, tilt by el about local east,
 * pan by -az about local up (so az is a compass bearing, increasing clockwise from north), then
 * roll about the view axis the way three.js `camera.rotateZ` does.
 *
 * @param {number[]} up local geodetic up at the camera, unit
 * @param {number[]} north local horizontal north at the camera, unit and perpendicular to up
 */
export function basisFromAzElRoll(up, north, azDeg, elDeg, rollDeg) {
    // east = north x up. (Equivalently the controller's `up cross south`.)
    const east = cross(north, up);

    let fwd = rotateAbout(north, east, elDeg * DEG);
    fwd = normalize(rotateAbout(fwd, up, -azDeg * DEG));

    // Zero-roll basis: `right` horizontal, `down` in the vertical plane through the view axis.
    // At az = el = 0 this gives right = east and down = -up.
    const right0 = normalize(cross(fwd, up));
    const down0 = cross(fwd, right0);

    if (rollDeg === 0) return {right: right0, down: down0, fwd};

    // Roll spins right and down around fwd, which stays put. This is a plain 2D rotation within
    // the plane those two span.
    const c = Math.cos(rollDeg * DEG), s = Math.sin(rollDeg * DEG);
    return {
        right: [
            right0[0] * c - down0[0] * s,
            right0[1] * c - down0[1] * s,
            right0[2] * c - down0[2] * s,
        ],
        down: [
            right0[0] * s + down0[0] * c,
            right0[1] * s + down0[1] * c,
            right0[2] * s + down0[2] * c,
        ],
        fwd,
    };
}

/** Inverse of basisFromAzElRoll: recover (az, el, roll) degrees from a world-space basis. */
export function azElRollFromBasis(up, north, basis) {
    const east = cross(north, up);
    const fwd = normalize(basis.fwd);

    // Elevation is how much of the view direction points along up; azimuth is the compass angle
    // of what is left once that vertical part is set aside.
    const elDeg = Math.asin(clamp(dot(fwd, up), -1, 1)) / DEG;
    const azDeg = Math.atan2(dot(fwd, east), dot(fwd, north)) / DEG;

    // Roll is measured against the zero-roll basis for THIS pointing, so it is independent of
    // where the camera happens to be looking.
    const right0 = normalize(cross(fwd, up));
    const down0 = cross(fwd, right0);
    const rollDeg = Math.atan2(dot(basis.down, right0), dot(basis.down, down0)) / DEG;

    return {azDeg, elDeg, rollDeg};
}

// -----------------------------------------------------------------------------------------
// One-sided Jacobi SVD.
//
// WHAT AN SVD IS. The singular value decomposition rewrites any matrix A as three factors,
// A = U * S * Vᵀ, where U and V are rotations and S is a diagonal matrix of non-negative numbers
// called the SINGULAR VALUES. The useful reading: whatever A does to a vector can be described as
// "rotate, then stretch each axis by its own singular value, then rotate again". A large singular
// value means A responds strongly along that direction; a singular value near zero means A is
// nearly blind to it. That is precisely the question this solver has to answer about its own
// data, which is why the SVD appears twice here.
//
// HOW THIS ONE WORKS. The one-sided Jacobi method takes pairs of columns and rotates them against
// each other so they become perpendicular, repeating over every pair (a "sweep") until the whole
// matrix has orthogonal columns. At that point each column's length IS a singular value, and the
// accumulated rotations are V. It is iterative, but it converges quickly and is unusually
// accurate for small matrices.
//
// The matrices here are at most 2N x 7 and 3 x 3, so a compact iterative method with no
// dependencies beats pulling in a linear-algebra package — mathjs is deliberately imported
// number-only elsewhere in Sitrec precisely to avoid that weight.
// -----------------------------------------------------------------------------------------

/**
 * SVD of a row-major m x n matrix.
 *
 * m >= n is the usual case and the one the LM step relies on. m < n also works, and is used
 * deliberately: the four-point homography path in CameraPlaneHomography builds an 8 x 9 matrix
 * and wants its null direction. One-sided Jacobi handles that without special-casing, because it
 * orthogonalises COLUMNS — with m < n at least n - m of them come out with zero length, and the
 * matching columns of v span the null space. Verified on an 8 x 9 case: |A * v_last| = 6e-16 with
 * |v_last| = 1. What you do NOT get from an m < n call is a usable u, since only the first m
 * columns can be independent.
 *
 * @returns {{u: Float64Array, s: Float64Array, v: Float64Array}} u is m x n, v is n x n, both
 *          row-major, columns ordered by descending singular value.
 */
export function jacobiSVD(A, m, n) {
    const a = Float64Array.from(A);   // working copy; rotated in place until columns are orthogonal
    const v = new Float64Array(n * n);
    for (let i = 0; i < n; i++) v[i * n + i] = 1;   // v starts as the identity and accumulates

    const EPS = 1e-15;
    for (let sweep = 0; sweep < 60; sweep++) {
        let off = 0;   // how far from orthogonal the columns still are, summed over this sweep
        for (let p = 0; p < n - 1; p++) {
            for (let q = p + 1; q < n; q++) {
                // alpha and beta are the squared lengths of columns p and q; gamma is their dot
                // product, which is what we are trying to drive to zero.
                let alpha = 0, beta = 0, gamma = 0;
                for (let i = 0; i < m; i++) {
                    const ap = a[i * n + p], aq = a[i * n + q];
                    alpha += ap * ap;
                    beta += aq * aq;
                    gamma += ap * aq;
                }
                if (gamma === 0) continue;   // already orthogonal, nothing to do
                const denom = Math.sqrt(alpha * beta);
                if (denom === 0 || Math.abs(gamma) / denom < EPS) continue;
                off += (gamma * gamma) / (alpha * beta);

                // The rotation angle that makes these two columns exactly perpendicular. This is
                // the standard closed-form Jacobi solution: zeta describes the pair's shape, and
                // t = tan(theta) follows from it. Taking the smaller root (hence the + in the
                // denominator) keeps the rotation small, which is the numerically stable choice.
                const zeta = (beta - alpha) / (2 * gamma);
                const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
                const c = 1 / Math.sqrt(1 + t * t);
                const s = c * t;

                // Apply the rotation to the two columns of a, and record it in v.
                for (let i = 0; i < m; i++) {
                    const ap = a[i * n + p], aq = a[i * n + q];
                    a[i * n + p] = c * ap - s * aq;
                    a[i * n + q] = s * ap + c * aq;
                }
                for (let i = 0; i < n; i++) {
                    const vp = v[i * n + p], vq = v[i * n + q];
                    v[i * n + p] = c * vp - s * vq;
                    v[i * n + q] = s * vp + c * vq;
                }
            }
        }
        if (off < 1e-30) break;   // columns are orthogonal to machine precision
    }

    // Columns are orthogonal now, so each one's length is its singular value.
    const s = new Float64Array(n);
    for (let j = 0; j < n; j++) {
        let acc = 0;
        for (let i = 0; i < m; i++) acc += a[i * n + j] * a[i * n + j];
        s[j] = Math.sqrt(acc);
    }

    // Order by descending singular value so index 0 is the strongest mode and n-1 the weakest.
    // Callers rely on that ordering: the weakest mode is the one the diagnostics report on, and
    // dltHomography takes the very last column as its answer.
    const order = Array.from({length: n}, (_, j) => j).sort((x, y) => s[y] - s[x]);
    const u = new Float64Array(m * n);
    const sOut = new Float64Array(n);
    const vOut = new Float64Array(n * n);
    for (let k = 0; k < n; k++) {
        const j = order[k];
        sOut[k] = s[j];
        // Dividing each orthogonal column by its length turns it into a unit column of U.
        const inv = s[j] > 0 ? 1 / s[j] : 0;
        for (let i = 0; i < m; i++) u[i * n + k] = a[i * n + j] * inv;
        for (let i = 0; i < n; i++) vOut[i * n + k] = v[i * n + j];
    }
    return {u, s: sOut, v: vOut};
}

/**
 * Solve a small dense n x n system A x = b by Gaussian elimination with partial pivoting.
 *
 * Two phases. First, eliminate downward so the matrix becomes upper-triangular, always swapping
 * the largest available coefficient into the pivot position first ("partial pivoting") so we
 * never divide by a near-zero. Then substitute backwards from the last row up.
 *
 * @returns {number[]|null} null if the matrix is singular or the result is not finite
 */
function solveDense(A, b, n) {
    const a = Float64Array.from(A);
    const x = Float64Array.from(b);
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) {
            if (Math.abs(a[r * n + col]) > Math.abs(a[piv * n + col])) piv = r;
        }
        if (Math.abs(a[piv * n + col]) < 1e-14) return null;
        if (piv !== col) {
            for (let c = 0; c < n; c++) {
                const t = a[col * n + c]; a[col * n + c] = a[piv * n + c]; a[piv * n + c] = t;
            }
            const t = x[col]; x[col] = x[piv]; x[piv] = t;
        }
        for (let r = col + 1; r < n; r++) {
            const f = a[r * n + col] / a[col * n + col];
            if (f === 0) continue;
            for (let c = col; c < n; c++) a[r * n + c] -= f * a[col * n + c];
            x[r] -= f * x[col];
        }
    }
    // Back-substitution.
    for (let r = n - 1; r >= 0; r--) {
        let acc = x[r];
        for (let c = r + 1; c < n; c++) acc -= a[r * n + c] * x[c];
        x[r] = acc / a[r * n + r];
    }
    for (let i = 0; i < n; i++) if (!Number.isFinite(x[i])) return null;
    return Array.from(x);
}

// -----------------------------------------------------------------------------------------
// Forward model — given a camera, where does a world point land in the frame?
//
// This is the function the optimiser is trying to match to the analyst's clicks. Everything else
// in the file exists to search for the camera that makes this agree with the data.
// -----------------------------------------------------------------------------------------

/**
 * Project a world point into original-video pixels.
 * @returns {number[]|null} [x, y], or null when the point is behind the camera or outside the
 *          lens's representable field. Null is a first-class outcome, not an error.
 */
export function projectWorldPoint(state, world, lens, imageSize) {
    let d = sub(world, state.position);
    // Where the camera SAW this point, which is not where it is if the air between them bends.
    // The caller supplies the bend (see spec.liftFactory) because the model belongs to the host;
    // without one this is the plain pinhole it has always been.
    if (state.lift) d = state.lift(d);
    // Decompose the camera-to-point offset onto the camera's own axes: z is how far in front,
    // x is how far right, y is how far down.
    const z = dot(d, state.basis.fwd);
    // Reject at the plane rather than at zero: a point grazing 90 degrees off-axis projects to
    // an arbitrarily large pixel coordinate and would dominate any least-squares cost.
    if (!(z > 1e-6)) return null;
    const x = dot(d, state.basis.right);
    const y = dot(d, state.basis.down);
    const n = Math.hypot(x, y, z);
    // The lens takes a UNIT direction, not a distance, so normalise before handing it over.
    return rayToPixel(lens, [x / n, y / n, z / n], imageSize, state.focalScale);
}

/**
 * Build the full camera state from a parameter vector.
 *
 * `base` carries everything the parameters are relative to: the starting position, the fixed
 * east/north/up basis the position offsets are expressed in, and the starting angles/focal for
 * any locked slot. So p[P_EAST] = 100 means "100 m east of where we started", not an absolute
 * coordinate — which keeps the numbers the optimiser handles small and comparable, instead of
 * ECEF values in the millions.
 */
function stateFromParams(p, base, localFrame, liftFactory) {
    const position = [
        base.position[0] + p[P_EAST] * base.east[0] + p[P_NORTH] * base.north[0] + p[P_UP] * base.up[0],
        base.position[1] + p[P_EAST] * base.east[1] + p[P_NORTH] * base.north[1] + p[P_UP] * base.up[1],
        base.position[2] + p[P_EAST] * base.east[2] + p[P_NORTH] * base.north[2] + p[P_UP] * base.up[2],
    ];
    // The local frame is re-evaluated at the CURRENT position, not the starting one. Over a few
    // kilometres the difference is a hundredth of a degree, which is small but is exactly the
    // kind of small that shows up as an unexplained residual floor.
    const frame = localFrame(position);
    const basis = basisFromAzElRoll(frame.up, frame.north, p[P_AZ], p[P_EL], p[P_ROLL]);
    return {
        position,
        azDeg: p[P_AZ],
        elDeg: p[P_EL],
        rollDeg: p[P_ROLL],
        // Undo the log. See P_LOGF for why the parameter is stored logged.
        focalScale: Math.exp(p[P_LOGF]),
        basis,
        frame,
        // Rebuilt at the CURRENT position for the same reason the frame is: the bend is a
        // property of where the observer stands, and the optimiser moves the observer.
        lift: liftFactory ? liftFactory(position) : null,
    };
}

/**
 * Per-pair pixel residuals for a state — the signed x and y miss distance for every landmark.
 * These are the numbers the optimiser is driving toward zero.
 *
 * A point that fails to project gets a large finite residual rather than NaN, so a seed that
 * starts with landmarks behind the camera can still be scored and can still climb out.
 */
function residualsFor(state, points, lens, imageSize) {
    const out = new Float64Array(points.length * 2);
    let behind = 0;
    const BEHIND_PENALTY = 1e4;
    for (let i = 0; i < points.length; i++) {
        const px = projectWorldPoint(state, points[i].world, lens, imageSize);
        if (px === null || !Number.isFinite(px[0]) || !Number.isFinite(px[1])) {
            behind++;
            out[i * 2] = BEHIND_PENALTY;
            out[i * 2 + 1] = BEHIND_PENALTY;
            continue;
        }
        out[i * 2] = px[0] - points[i].px[0];
        out[i * 2 + 1] = px[1] - points[i].px[1];
    }
    return {r: out, behind};
}

/**
 * Huber weight per PAIR, applied to both components so the x/y residual stays a vector.
 *
 * This is how the Huber loss gets implemented inside a least-squares optimiser: rather than
 * changing the optimiser, downweight each point and let it solve an ordinary weighted problem.
 * The sqrt is there because the optimiser squares what it is given, so a weight of
 * sqrt(delta/mag) contributes delta*mag instead of mag*mag.
 *
 * Note what that does and does not reproduce. delta*mag is NOT the Huber penalty, which is
 * delta*(2*mag - delta) out here — the two differ by delta*(mag - delta). What matches is the
 * DERIVATIVE, and therefore the descent direction and the normal equations the step is built
 * from. That is all the optimiser needs from the weights. The true Huber value is computed
 * separately by robustCost, which is what the accept/reject test actually compares, so the
 * search direction and the acceptance criterion come from different expressions on purpose.
 *
 * Weights depend on the current residuals, which change every iteration, so they get recomputed
 * as the fit moves. That loop — reweight, re-solve, repeat — is called ITERATIVELY REWEIGHTED
 * LEAST SQUARES.
 */
function huberWeights(r, n, delta) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const mag = Math.hypot(r[i * 2], r[i * 2 + 1]);
        w[i] = mag <= delta ? 1 : Math.sqrt(delta / mag);
    }
    return w;
}

/**
 * The Huber cost itself — quadratic for small misses, linear for large ones.
 *
 * The two branches are chosen to meet smoothly at mag = delta: at that point both give
 * delta*delta, and both have the same slope, so there is no kink for the optimiser to trip over.
 */
function robustCost(r, n, delta) {
    let c = 0;
    for (let i = 0; i < n; i++) {
        const mag = Math.hypot(r[i * 2], r[i * 2 + 1]);
        c += mag <= delta ? mag * mag : delta * (2 * mag - delta);
    }
    return c;
}

function rmsOf(r, n) {
    let acc = 0;
    for (let i = 0; i < 2 * n; i++) acc += r[i] * r[i];
    return Math.sqrt(acc / n);   // per-point pixel distance, not per-component
}

// -----------------------------------------------------------------------------------------
// Levenberg-Marquardt, stepped through the SVD.
//
// Each iteration does four things:
//
//   1. Build the JACOBIAN — a table of "if I nudge parameter j, how much does residual i move?".
//      One row per residual, one column per free parameter. It is the multi-parameter equivalent
//      of a derivative, and it is what tells the optimiser which way is downhill.
//   2. Decompose it with the SVD, so the step can be taken mode by mode.
//   3. Take a trial step, damped by lambda.
//   4. Accept it if the cost went down, otherwise increase lambda and try a smaller one.
//
// WHY THE SVD FORM IS NOT DECORATION. Expressing the step as
//
//     delta = sum over modes i of:   v_i * [ sigma_i / (sigma_i^2 + lambda) ] * (u_i . -r)
//
// gives each mode its own gain factor. For a strong mode (large sigma) that factor is about
// 1/sigma, the undamped Gauss-Newton step. For a mode the data cannot see (sigma near zero) the factor
// collapses to about sigma/lambda, which is near zero — so that direction simply does not move
// and stays at its starting value. That is exactly the required behaviour for the
// distant-landmark case, where camera range and focal length trade off against each other and
// the data cannot separate them.
//
// The same decomposition then reports WHICH combination was unobservable, so the UI can say so
// instead of quietly returning a number. Solving the normal equations instead would have to bolt
// that on separately, and would square the condition number doing it — turning a hard-but-usable
// 1e6 into a hopeless 1e12.
// -----------------------------------------------------------------------------------------

function runLM(seedParams, base, ctx, maxIterations = ctx.options.maxIterations) {
    const {points, lens, imageSize, localFrame, liftFactory, freeIdx, options} = ctx;
    const nFree = freeIdx.length;
    const nPts = points.length;
    const m = nPts * 2;              // total residual count: x and y for every point

    const p = Float64Array.from(seedParams);
    const stepSize = ctx.stepSize;

    let state = stateFromParams(p, base, localFrame, liftFactory);
    let {r} = residualsFor(state, points, lens, imageSize);
    let delta = options.huberDeltaInit;
    let w = huberWeights(r, nPts, delta);
    let cost = robustCost(r, nPts, delta);

    let lambda = options.lambda0;
    const J = new Float64Array(m * nFree);
    let lastSVD = null;
    let lastColScale = null;

    for (let iter = 0; iter < maxIterations; iter++) {
        // Tighten the robust transition once the fit is roughly in place. Starting tight would
        // downweight everything while the pose is still wrong and stall the descent.
        if (iter === Math.floor(maxIterations / 6)) {
            delta = options.huberDelta;
            w = huberWeights(r, nPts, delta);
            cost = robustCost(r, nPts, delta);
        }

        // --- 1. Jacobian, by central differences. ---------------------------------------------
        //
        // No analytic derivatives: nudge each free parameter a little each way, see how far every
        // residual moved, and divide by the total nudge. Central differences (both directions)
        // rather than one-sided because the error cancels to a much higher order, which matters
        // here since the whole conditioning analysis is read off this matrix.
        //
        // The Huber weight is folded in as the Jacobian is built, so everything downstream — the
        // SVD, the step, the diagnostics — sees the reweighted problem consistently.
        for (let col = 0; col < nFree; col++) {
            const slot = freeIdx[col];
            const h = stepSize[slot];
            const pPlus = Float64Array.from(p); pPlus[slot] += h;
            const pMinus = Float64Array.from(p); pMinus[slot] -= h;
            const rp = residualsFor(stateFromParams(pPlus, base, localFrame, liftFactory), points, lens, imageSize).r;
            const rm = residualsFor(stateFromParams(pMinus, base, localFrame, liftFactory), points, lens, imageSize).r;
            for (let i = 0; i < nPts; i++) {
                const g = w[i] / (2 * h);
                J[(i * 2) * nFree + col] = (rp[i * 2] - rm[i * 2]) * g;
                J[(i * 2 + 1) * nFree + col] = (rp[i * 2 + 1] - rm[i * 2 + 1]) * g;
            }
        }

        // --- 2. Column equilibration, then SVD. -----------------------------------------------
        //
        // "Equilibration" means rescaling each column to unit length. Without it the columns are
        // in metres, degrees and log-focal, so the singular values would mostly describe the
        // choice of units rather than the geometry — and the condition number, which is the
        // headline observability number, would be meaningless. Scaling is undone when the step is
        // applied, a few lines below.
        const colScale = new Float64Array(nFree);
        for (let col = 0; col < nFree; col++) {
            let acc = 0;
            for (let i = 0; i < m; i++) acc += J[i * nFree + col] * J[i * nFree + col];
            const nrm = Math.sqrt(acc);
            colScale[col] = nrm > 1e-300 ? 1 / nrm : 0;
        }
        const Js = new Float64Array(m * nFree);
        for (let i = 0; i < m; i++) {
            for (let col = 0; col < nFree; col++) Js[i * nFree + col] = J[i * nFree + col] * colScale[col];
        }

        const svd = jacobiSVD(Js, m, nFree);
        lastSVD = svd;
        lastColScale = colScale;

        // Weighted residual, negated: the direction we want the residuals to move in.
        const rw = new Float64Array(m);
        for (let i = 0; i < nPts; i++) {
            rw[i * 2] = -w[i] * r[i * 2];
            rw[i * 2 + 1] = -w[i] * r[i * 2 + 1];
        }

        const sigmaMax = svd.s[0];
        const sigmaFloor = sigmaMax * options.sigmaFloorRatio;

        // --- 3 & 4. Trial steps, damped harder each time until one improves the cost. ----------
        let improved = false;
        for (let attempt = 0; attempt < 12 && !improved; attempt++) {
            const stepScaled = new Float64Array(nFree);
            for (let k = 0; k < nFree; k++) {
                const sig = svd.s[k];
                if (!(sig > sigmaFloor)) continue;   // unobservable: no step, stays at seed value
                // How much this mode wants to move: project the residual onto its direction.
                let utr = 0;
                for (let i = 0; i < m; i++) utr += svd.u[i * nFree + k] * rw[i];
                // The damped gain from the header. Newton-like for strong modes, ~0 for weak.
                const gain = sig / (sig * sig + lambda);
                const coeff = gain * utr;
                for (let j = 0; j < nFree; j++) stepScaled[j] += svd.v[j * nFree + k] * coeff;
            }

            const pTry = Float64Array.from(p);
            let finite = true;
            for (let col = 0; col < nFree; col++) {
                // Undo the column scaling to get a step in real parameter units.
                const d = stepScaled[col] * colScale[col];
                if (!Number.isFinite(d)) { finite = false; break; }
                pTry[freeIdx[col]] += d;
            }

            if (finite && Math.abs(pTry[P_EL]) <= MAX_ABS_EL) {
                const tryState = stateFromParams(pTry, base, localFrame, liftFactory);
                const tryR = residualsFor(tryState, points, lens, imageSize).r;
                const tryCost = robustCost(tryR, nPts, delta);
                if (Number.isFinite(tryCost) && tryCost < cost) {
                    // Accepted. Commit the step, relax the damping, and recompute the weights at
                    // the new residuals.
                    const rel = (cost - tryCost) / Math.max(cost, 1e-300);
                    p.set(pTry);
                    state = tryState;
                    r = tryR;
                    cost = tryCost;
                    w = huberWeights(r, nPts, delta);
                    lambda = Math.max(lambda * options.lambdaDown, 1e-12);
                    improved = true;
                    // Improvement has become negligible. Setting iter to the limit ends the outer
                    // loop after this break, which is the convergence exit.
                    if (rel < options.tolerance) iter = maxIterations;
                    break;
                }
            }
            // Rejected: damp harder and retry from the same place with a shorter, safer step.
            lambda *= options.lambdaUp;
            if (lambda > 1e12) break;
        }

        if (!improved) break;   // 12 attempts and nothing helped: this is as far as LM gets
    }

    const {behind} = residualsFor(state, points, lens, imageSize);
    return {
        params: Array.from(p),
        state,
        residuals: r,
        cost,
        rms: rmsOf(r, nPts),
        behind,
        svd: lastSVD,
        colScale: lastColScale,
        freeIdx,
    };
}

// -----------------------------------------------------------------------------------------
// Initialisation — finding a starting guess worth refining.
//
// LM only ever walks downhill from where it starts, so it finds the nearest local minimum, not
// necessarily the right one. A warm start from the camera the sitch happens to have is not enough
// on its own. In the case this feature exists for — a redacted clip with no platform metadata —
// that camera can be tens of degrees and hundreds of kilometres away, which puts most landmarks
// behind it and leaves LM with no gradient worth following. So the caller's state is only ONE
// candidate among several.
//
// The others come from a focal-length scan. At each trial focal the pixels become rays; a Kabsch
// rotation lines those rays up with the landmark bearings; and the camera centre is then the
// least-squares intersection of the oriented rays. Alternating those two a few times converges
// quickly when the geometry supports it, and visibly fails to when it does not — which is the
// same distant-landmark degeneracy the final solve has to report anyway.
// -----------------------------------------------------------------------------------------

/**
 * Rotation (camera -> world) best aligning camera-space rays to world bearings.
 *
 * This is the KABSCH ALGORITHM, the standard closed-form answer to "what single rotation best
 * lines up these two sets of directions?". No iteration is needed: build the 3x3 correlation
 * matrix M by summing the outer products of each matched pair, take its SVD, and the best
 * rotation is V Uᵀ. The intuition is that the SVD finds the principal axes the two sets share,
 * and lining those axes up is the same as lining the sets up.
 *
 * The one wrinkle is that V Uᵀ can come out as a REFLECTION rather than a rotation (determinant
 * -1), which would mirror the scene. The fix is to flip the axis carrying the least evidence.
 */
export function kabschRotation(rays, bearings) {
    // M = sum r_i d_i^T, and the maximiser of trace(R M) is R = V diag(1,1,det) U^T.
    const M = new Float64Array(9);
    for (let i = 0; i < rays.length; i++) {
        const r = rays[i], d = bearings[i];
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) M[a * 3 + b] += r[a] * d[b];
    }
    const {u, v} = jacobiSVD(M, 3, 3);
    // R = V * U^T.
    const R = new Float64Array(9);
    for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
            let acc = 0;
            for (let k = 0; k < 3; k++) acc += v[a * 3 + k] * u[b * 3 + k];
            R[a * 3 + b] = acc;
        }
    }
    const det =
        R[0] * (R[4] * R[8] - R[5] * R[7]) -
        R[1] * (R[3] * R[8] - R[5] * R[6]) +
        R[2] * (R[3] * R[7] - R[4] * R[6]);
    if (det < 0) {
        // A reflection, not a rotation. Flip the least-significant right-singular direction
        // (column 2 of V, the one carrying the least evidence) and rebuild.
        for (let a = 0; a < 3; a++) {
            for (let b = 0; b < 3; b++) {
                let acc = 0;
                for (let k = 0; k < 3; k++) {
                    const vk = k === 2 ? -v[a * 3 + k] : v[a * 3 + k];
                    acc += vk * u[b * 3 + k];
                }
                R[a * 3 + b] = acc;
            }
        }
    }
    return R;
}

/** Apply a row-major 3x3 rotation to a vector. */
const applyR = (R, x) => [
    R[0] * x[0] + R[1] * x[1] + R[2] * x[2],
    R[3] * x[0] + R[4] * x[1] + R[5] * x[2],
    R[6] * x[0] + R[7] * x[1] + R[8] * x[2],
];

/**
 * Least-squares point closest to a bundle of world LINES — where they most nearly meet.
 *
 * Lines, not rays, and the distinction is worth being precise about. Sightlines built from
 * clicked pixels never intersect exactly, so "the intersection" has to mean the point whose total
 * squared distance to all of them is smallest. The distance from a point C to the line through P
 * with unit direction d comes from the part of (C - P) that is PERPENDICULAR to d, and the matrix
 * that extracts that perpendicular part is (I - d dᵀ). Summing those gives a plain 3x3 system:
 *
 *     sum (I - d dᵀ) C  =  sum (I - d dᵀ) P
 *
 * That expression is indifferent to which way d points, and to whether the answer lies forward or
 * backward along it — it minimises against the infinite line. The caller relies on exactly that.
 * It passes the LANDMARKS as origins and the camera-to-landmark directions as d, so at each
 * origin the direction points AWAY from the camera and the solution sits behind every one of
 * them. A genuine ray intersection, constrained to d >= 0, would find nothing.
 *
 * @returns {number[]|null} null when the bundle is too parallel to meet at a well-defined point —
 *          which is precisely the distant-landmark case, and is why the caller keeps the previous
 *          centre when this fails. Nearly parallel lines meet at a point that is enormously
 *          sensitive to noise, so this refuses rather than returning a number it cannot stand
 *          behind.
 */
export function intersectRays(origins, dirs) {
    const A = new Float64Array(9);
    const b = new Float64Array(3);
    for (let i = 0; i < dirs.length; i++) {
        const d = dirs[i], P = origins[i];
        for (let a = 0; a < 3; a++) {
            for (let c = 0; c < 3; c++) {
                const proj = (a === c ? 1 : 0) - d[a] * d[c];
                A[a * 3 + c] += proj;
                b[a] += proj * P[c];
            }
        }
    }
    // Reject an ill-conditioned bundle before inverting it: if the smallest singular value is a
    // millionth of the largest, the rays effectively share a direction and there is no crossing.
    const {s} = jacobiSVD(A, 3, 3);
    if (!(s[0] > 0) || s[2] / s[0] < 1e-6) return null;
    return solveDense(A, b, 3);
}

// -----------------------------------------------------------------------------------------
// Observability reporting — what the data could and could not determine.
// -----------------------------------------------------------------------------------------

/**
 * Turn the final Jacobian's SVD into statements about which parameters were actually pinned down.
 *
 * Three things come out of it:
 *
 *   conditionNumber — largest singular value over smallest. How lopsided the information is.
 *   weakestMode     — the direction belonging to the smallest singular value, broken down into
 *                     the parameters that make it up, so the UI can name what was not determined
 *                     rather than printing a bare number at the user.
 *   uncertainty     — an approximate 1-sigma error bar per parameter, from the same decomposition.
 */
function buildDiagnostics(fit, options, nPts) {
    const {svd, colScale, freeIdx} = fit;
    const nFree = freeIdx.length;
    const out = {
        conditionNumber: null,
        conditioning: "unknown",
        weakestMode: null,
        uncertainty: {},
        // How many more measurements than unknowns. Zero means the fit can pass exactly through
        // its own data and tells you nothing about whether it is right.
        redundancy: 2 * nPts - nFree,
    };
    if (!svd || !colScale) return out;

    const sMax = svd.s[0], sMin = svd.s[nFree - 1];
    if (sMax > 0) {
        const kappa = sMin > 0 ? sMax / sMin : Infinity;
        out.conditionNumber = kappa;
        out.conditioning = kappa > options.kappaSevere ? "unobservable"
            : kappa > options.kappaWarn ? "weak" : "good";

        // The weakest mode is the last column of v. Its entries say how much each parameter
        // contributes to the combination the data could not see — so a mode that is mostly "up"
        // and "fov" is the classic altitude/zoom trade-off.
        const weak = [];
        for (let j = 0; j < nFree; j++) {
            const v = svd.v[j * nFree + (nFree - 1)];
            weak.push({name: PARAM_NAMES[freeIdx[j]], weight: Math.abs(v), signed: v});
        }
        weak.sort((a, b) => b.weight - a.weight);
        out.weakestMode = {sigma: sMin, components: weak};
    }

    // Approximate 1-sigma parameter uncertainty. Each parameter's variance is the sum over modes
    // of (its share of that mode / that mode's singular value) squared — weak modes contribute
    // most, which is the whole point. Scaled back into real units by colScale, and by the
    // residual size, since a fit that misses by 10 px is less certain than one that misses by 1.
    //
    // The residual scale is floored so a fit that passes exactly through four hand-placed points
    // cannot report zero uncertainty.
    const dof = Math.max(1, 2 * nPts - nFree);
    const s2 = Math.max(fit.rms * fit.rms, options.pixelNoiseFloor * options.pixelNoiseFloor);
    const scaleResidual = Math.sqrt((s2 * nPts) / dof);
    for (let j = 0; j < nFree; j++) {
        let acc = 0;
        for (let k = 0; k < nFree; k++) {
            if (!(svd.s[k] > 0)) continue;
            const t = svd.v[j * nFree + k] / svd.s[k];
            acc += t * t;
        }
        const sigma = Math.sqrt(acc) * colScale[j] * scaleResidual;
        out.uncertainty[PARAM_NAMES[freeIdx[j]]] = sigma;
    }
    return out;
}

/**
 * Spread of the 2D points, as the two principal standard deviations in pixels.
 *
 * "Principal" meaning along the two axes the cluster is actually elongated on, which need not be
 * horizontal and vertical. Those come from the eigenvalues of the 2x2 covariance matrix, and for
 * a matrix that small there is a closed form: half the trace, plus or minus a discriminant.
 *
 * A large major with a tiny minor means the clicks lie nearly along a line, which constrains the
 * camera far less than the same number of points spread over the frame.
 */
function pixelSpread(points) {
    const n = points.length;
    let mx = 0, my = 0;
    for (const p of points) { mx += p.px[0]; my += p.px[1]; }
    mx /= n; my /= n;
    let cxx = 0, cyy = 0, cxy = 0;
    for (const p of points) {
        const dx = p.px[0] - mx, dy = p.px[1] - my;
        cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
    }
    cxx /= n; cyy /= n; cxy /= n;
    const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    return {major: Math.sqrt(Math.max(0, tr / 2 + disc)), minor: Math.sqrt(Math.max(0, tr / 2 - disc))};
}

// -----------------------------------------------------------------------------------------
// Public entry points
// -----------------------------------------------------------------------------------------

/**
 * Reprojection error of a GIVEN camera against the correspondences.
 *
 * Exists so a caller can compare a proposed fit against the camera it would replace. That
 * comparison is the difference between a tool that improves a camera and one that can silently
 * destroy a good one: an optimiser always returns its best local minimum, and "best local" can
 * still be far worse than where the user already was.
 *
 * @param {object} spec {points, imageSize, state: {position, azDeg, elDeg, rollDeg, vfovDeg},
 *                       localFrame, lens?, liftFactory?}
 * @returns {{rms: number, behind: number, perPoint: object[]}}
 */
export function evaluateCamera(spec) {
    const {points, imageSize, state, localFrame} = spec;
    const lens = spec.lens ?? lensFromVFOV(state.vfovDeg, imageSize);
    const frame = localFrame(state.position);
    const st = {
        position: state.position,
        focalScale: 1,
        basis: basisFromAzElRoll(frame.up, frame.north, state.azDeg, state.elDeg, state.rollDeg),
        // Same forward model the fit uses, or the "is the fit better than what we have?"
        // comparison would be scoring two cameras with two different physics.
        lift: spec.liftFactory ? spec.liftFactory(state.position) : null,
    };
    const {r, behind} = residualsFor(st, points, lens, imageSize);
    const perPoint = points.map((p, i) => ({
        dx: r[i * 2], dy: r[i * 2 + 1],
        distance: Math.hypot(r[i * 2], r[i * 2 + 1]),
        range: norm(sub(p.world, state.position)),
    }));
    return {rms: rmsOf(r, points.length), behind, perPoint};
}

/**
 * Fit a camera to 2D/3D correspondences.
 *
 * The overall shape of the run:
 *
 *   1. Validate, and set up the parameter scaling.
 *   2. Build a list of candidate starting guesses (the caller's camera, plus a focal-length scan).
 *   3. Rank the candidates with a short LM run each, and fully refine the best few.
 *   4. Keep the winner, and restart it until it stops improving.
 *   5. Sanity-check the result, and report it along with what the data could not determine.
 *
 * @param {object}   spec
 * @param {Array}    spec.points      [{px: [x, y] in ORIGINAL video pixels, world: [X, Y, Z] ECEF}]
 * @param {number[]} spec.imageSize   [originalVideoWidth, originalVideoHeight]
 * @param {object}   spec.initial     {position: [X,Y,Z], azDeg, elDeg, rollDeg, vfovDeg}
 * @param {object}   spec.free        which slots may move: {position, az, el, roll, fov}
 * @param {Function} spec.localFrame  (positionECEF) => {up, north}, both unit, north perpendicular
 *                                    to up. Supply the SAME frame the camera controller uses.
 * @param {object}  [spec.lens]       CameraLens object; defaults to the rectilinear pinhole at
 *                                    initial.vfovDeg. focalScale multiplies its focal length.
 * @param {Function}[spec.liftFactory] (positionECEF) => ((offsetECEF) => offsetECEF) | null.
 *                                    Given where the camera is, returns the map from a
 *                                    camera-relative world offset to the APPARENT one — the
 *                                    atmosphere between camera and landmark. Omit for straight
 *                                    lines. The host owns the model; this module only applies it.
 * @param {object}  [spec.options]    overrides for CAMERA_FIT_DEFAULTS
 *
 * @returns {object} {ok, reason, position, azDeg, elDeg, rollDeg, vfovDeg, rms, residuals,
 *                    perPoint, diagnostics, spread}
 */
export function fitCameraToPoints(spec) {
    const options = {...CAMERA_FIT_DEFAULTS, ...(spec.options ?? {})};
    const points = spec.points ?? [];
    const imageSize = spec.imageSize;
    const initial = spec.initial;
    const localFrame = spec.localFrame;
    const nPts = points.length;

    // --- 1. Validate, and work out which parameters are allowed to move. ----------------------

    const free = {
        position: spec.free?.position ?? true,
        az: spec.free?.az ?? true,
        el: spec.free?.el ?? true,
        roll: spec.free?.roll ?? false,
        fov: spec.free?.fov ?? true,
    };

    // freeIdx is the list of slot numbers the optimiser may touch. Locked parameters are simply
    // absent from it, so they are not stepped, not differentiated, and not reported on.
    const freeIdx = [];
    if (free.position) freeIdx.push(P_EAST, P_NORTH, P_UP);
    if (free.az) freeIdx.push(P_AZ);
    if (free.el) freeIdx.push(P_EL);
    if (free.roll) freeIdx.push(P_ROLL);
    if (free.fov) freeIdx.push(P_LOGF);

    const fail = (reason, extra = {}) => ({ok: false, reason, ...extra});

    if (freeIdx.length === 0) return fail("Nothing to fit — every parameter is locked.");
    if (nPts < 2) return fail(`Need at least 2 points, have ${nPts}.`);
    if (2 * nPts < freeIdx.length) {
        return fail(`Need at least ${Math.ceil(freeIdx.length / 2)} points for ` +
            `${freeIdx.length} free parameters, have ${nPts}.`);
    }
    if (!imageSize || !(imageSize[0] > 0) || !(imageSize[1] > 0)) {
        return fail("No video dimensions — the fit needs the original video size.");
    }
    if (Math.abs(initial.elDeg) > MAX_ABS_EL) {
        return fail(`Camera elevation is ${initial.elDeg.toFixed(1)} deg; azimuth is not ` +
            `identifiable past +/-${MAX_ABS_EL} deg.`);
    }

    // The base frame: position parameters are offsets in these fixed east/north/up directions,
    // taken once at the starting position and never re-derived, so the parameter space does not
    // shift under the optimiser.
    const frame0 = localFrame(initial.position);
    const east0 = cross(frame0.north, frame0.up);
    const base = {
        position: initial.position.slice(),
        east: east0,
        north: frame0.north.slice(),
        up: frame0.up.slice(),
    };
    const lens = spec.lens ?? lensFromVFOV(initial.vfovDeg, imageSize);

    // Median range sets the position step size and the scale everything positional is judged
    // against — a 10 m uncertainty means something very different at 500 m and at 50 km.
    const ranges = points.map((pt) => norm(sub(pt.world, initial.position))).sort((a, b) => a - b);
    const medianRange = ranges[Math.floor(ranges.length / 2)] || 1000;

    // Finite-difference nudge sizes, one per slot. Too large and the derivative is wrong; too
    // small and it drowns in floating-point noise. Scaling position by range is what keeps the
    // same code working at 500 m and at 50 km.
    const stepSize = new Float64Array(PARAM_COUNT);
    stepSize[P_EAST] = stepSize[P_NORTH] = stepSize[P_UP] = Math.max(0.01, 1e-7 * medianRange);
    stepSize[P_AZ] = stepSize[P_EL] = stepSize[P_ROLL] = 1e-4;   // degrees
    stepSize[P_LOGF] = 1e-6;

    const liftFactory = spec.liftFactory ?? null;
    const ctx = {points, lens, imageSize, localFrame, liftFactory, freeIdx, options, stepSize};

    // --- 2. Candidate starting guesses ---------------------------------------------------------

    const seedFromState = (position, azDeg, elDeg, rollDeg, focalScale) => {
        const p = new Float64Array(PARAM_COUNT);
        // Position offsets are expressed in the FIXED base frame, so invert against that.
        const d = sub(position, base.position);
        p[P_EAST] = dot(d, base.east);
        p[P_NORTH] = dot(d, base.north);
        p[P_UP] = dot(d, base.up);
        p[P_AZ] = azDeg; p[P_EL] = elDeg; p[P_ROLL] = rollDeg;
        p[P_LOGF] = Math.log(focalScale);
        return p;
    };

    let seedReport = null;
    const currentSeed = seedFromState(initial.position, initial.azDeg, initial.elDeg,
        initial.rollDeg, 1);
    const seeds = [currentSeed];

    // Only scan for a pose when the geometry can support one. With position locked the caller has
    // asserted where the camera is, and with fewer than 3 points the Kabsch/intersection pair has
    // nothing to work with.
    //
    // The scan itself works in STRAIGHT lines even when spec.liftFactory bends them. A seed only
    // has to land in the right basin, and the bend is a fraction of a degree where these
    // candidates differ by tens of degrees and kilometres. The LM refinement that follows uses
    // the real forward model, so the ANSWER carries the bend even though the guess did not.
    if (nPts >= 3) {
        const candidates = [];
        const {focalScanCount: NF, focalScanMinVFOV: V0, focalScanMaxVFOV: V1} = options;
        for (let k = 0; k < NF; k++) {
            const vfov = V0 * Math.pow(V1 / V0, k / (NF - 1));
            const trialLens = lensFromVFOV(vfov, imageSize);
            // Camera-space rays for the observed pixels at this trial focal length.
            const rays = [];
            let bad = false;
            for (const pt of points) {
                const ray = lensToRayLocal(trialLens, pt.px);
                if (!ray) { bad = true; break; }
                rays.push(ray);
            }
            if (bad) continue;

            // Several starting centres, because the alternation below is only as good as the
            // bearings it starts from, and no single choice is reliable:
            //
            //   The caller's position is right when the camera was roughly placed by hand, and
            //   useless when there was no platform metadata at all.
            //
            //   The landmark centroid rescues the far-off case, but ONLY when the camera is well
            //   outside the landmark cluster. Measured on a real 5-landmark clip with the camera
            //   6-14 km out and the cluster 8 km across, the centroid sits INSIDE the cluster:
            //   bearings from there fan out over 360 degrees while the real camera sees them all
            //   within 30, no rotation maps one onto the other, and the alternation walks away —
            //   ending at azimuth +90 for a camera actually looking at -87.
            //
            //   So also try standing off from the centroid, along the direction the caller's
            //   camera lies in, at a range comparable to the cluster's own size. That is the
            //   geometry a camera looking AT this cluster must roughly have.
            const centreSeeds = [initial.position.slice()];
            if (free.position) {
                const c = centroid(points.map((pt) => pt.world));
                centreSeeds.push(c);
                const spread = Math.max(...points.map((pt) => norm(sub(pt.world, c))));
                const away = normalize(sub(initial.position, c));
                if (norm(away) > 0) {
                    for (const k of [1.5, 4]) centreSeeds.push(addScaled(c, away, spread * k));
                }
            }

            for (const centre0 of centreSeeds) {
                // Alternate: given a guessed centre, find the rotation that best explains the
                // bearings; given that rotation, find where the rays best meet. Each step uses
                // the other's latest answer, and a few rounds is enough to settle.
                let centre = centre0;
                let R = null;
                for (let alt = 0; alt < 8; alt++) {
                    const bearings = points.map((pt) => normalize(sub(pt.world, centre)));
                    R = kabschRotation(rays, bearings);
                    if (!free.position) break;
                    const worldDirs = rays.map((r) => normalize(applyR(R, r)));
                    const c = intersectRays(points.map((pt) => pt.world), worldDirs);
                    if (c === null) break;   // rays too parallel: keep the centre we have
                    const moved = norm(sub(c, centre));
                    centre = c;
                    if (moved < 1) break;    // settled
                }
                if (!R) continue;

                const fr = localFrame(centre);
                const {azDeg, elDeg, rollDeg} = azElRollFromBasis(fr.up, fr.north, {
                    right: applyR(R, [1, 0, 0]),
                    down: applyR(R, [0, 1, 0]),
                    fwd: applyR(R, [0, 0, 1]),
                });
                if (!Number.isFinite(azDeg) || Math.abs(elDeg) > MAX_ABS_EL) continue;

                // Trial focal expressed as a scale on the base lens, so it lands in the same
                // parameter the optimiser moves.
                const focalScale = trialLens.focalPx / lens.focalPx;
                const seed = seedFromState(centre, azDeg, elDeg,
                    free.roll ? rollDeg : initial.rollDeg, focalScale);
                candidates.push({seed, vfov});
            }
        }

        // --- 3. Rank by a SHORT LM run, not by the seed's own residual. ----------------------
        //
        // See prefilterIterations: the raw residual is not merely a weak predictor of which seed
        // converges, it carries no signal at all — the measured spread across 42 candidates was
        // 1288 to 1365 px with the winner nowhere near the top. A dozen iterations of descent
        // separates them properly, and costs a fraction of refining them all.
        //
        // The 1e9 term makes any seed with landmarks behind the camera lose to any seed without,
        // regardless of residual.
        for (const c of candidates) {
            const quick = runLM(c.seed, base, ctx, options.prefilterIterations);
            c.score = Number.isFinite(quick.cost) ? quick.cost + quick.behind * 1e9 : Infinity;
        }
        candidates.sort((a, b) => a.score - b.score);
        if (options.collectSeeds) {
            seedReport = candidates.map((s) => ({vfov: +s.vfov.toFixed(3), score: s.score}));
        }
        for (let i = 0; i < Math.min(options.seedsToRefine, candidates.length); i++) {
            seeds.push(candidates[i].seed);
        }
    }

    // --- refine every surviving seed, keep the best ------------------------------------------

    let best = null;
    for (const seed of seeds) {
        const fit = runLM(seed, base, ctx);
        if (!Number.isFinite(fit.cost)) continue;
        // Cheirality first: a solution with landmarks behind the camera is not a camera, whatever
        // its residual says. ("Cheirality" is handedness — the check that the scene is in front.)
        const better = best === null
            || fit.behind < best.behind
            || (fit.behind === best.behind && fit.cost < best.cost);
        if (better) best = fit;
    }

    if (best === null) return fail("The solver did not converge from any starting point.");

    // --- 4. Run the winner to a fixed point ---------------------------------------------------
    //
    // See maxRestarts. Only the winner: the losing seeds are in other basins and finishing their
    // descent would not change which basin won.
    for (let restart = 0; restart < options.maxRestarts; restart++) {
        const again = runLM(best.params, base, ctx);
        if (!Number.isFinite(again.cost)) break;
        const better = again.behind < best.behind
            || (again.behind === best.behind && again.cost < best.cost);
        if (!better) break;
        const improvedBy = (best.cost - again.cost) / Math.max(best.cost, 1e-300);
        best = again;
        if (improvedBy < options.restartTolerance) break;
    }

    // --- 5. Sanity-check and report -----------------------------------------------------------

    if (best.behind > 0) {
        return fail(`${best.behind} point${best.behind === 1 ? " is" : "s are"} behind the ` +
            `fitted camera — check the 3D placements.`);
    }

    const st = best.state;
    const vfovDeg = 2 * Math.atan((imageSize[1] / 2) / (lens.focalPx * st.focalScale)) / DEG;
    // Bounded well inside the 0-180 the camera nodes assert on, not merely inside it: a fit that
    // has run away to a 179-degree field is not a camera anybody photographed anything with, and
    // letting it through only moves the failure to an assert deep in the render loop.
    if (!Number.isFinite(vfovDeg) || vfovDeg < 0.02 || vfovDeg > 175) {
        return fail(`The fitted field of view (${vfovDeg.toFixed(1)} deg) is not plausible.`);
    }

    const perPoint = [];
    for (let i = 0; i < nPts; i++) {
        perPoint.push({
            dx: best.residuals[i * 2],
            dy: best.residuals[i * 2 + 1],
            distance: Math.hypot(best.residuals[i * 2], best.residuals[i * 2 + 1]),
            range: norm(sub(points[i].world, st.position)),
        });
    }

    return {
        ok: true,
        reason: null,
        position: st.position,
        azDeg: st.azDeg,
        elDeg: st.elDeg,
        rollDeg: st.rollDeg,
        vfovDeg,
        rms: best.rms,
        perPoint,
        spread: pixelSpread(points),
        medianRange,
        diagnostics: buildDiagnostics(best, options, nPts),
        seedReport,
        freeParams: freeIdx.map((i) => PARAM_NAMES[i]),
    };
}

/**
 * Pixel -> unit camera ray for the initialiser's trial lenses.
 *
 * Deliberately rectilinear-only: the focal scan searches pinhole shapes to get a pose in the
 * right basin, and the LM refinement afterwards uses the caller's real lens. Using the general
 * lensToRay here would add a null-rejection path per trial for no gain, since a trial focal that
 * cannot image its own pixels is one we discard anyway.
 */
export function lensToRayLocal(lens, px) {
    const f = lens.focalPx;
    const dx = px[0] - lens.principal[0], dy = px[1] - lens.principal[1];
    const n = Math.hypot(dx, dy, f);
    if (!(n > 0) || !Number.isFinite(n)) return null;
    return [dx / n, dy / n, f / n];
}
