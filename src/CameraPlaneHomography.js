// Camera fit by plane homography — the classical alternative to the direct 3D solve in
// CameraPointFit.js, provided so the two can be compared on the same control points.
//
//
// WHAT A HOMOGRAPHY IS, for anyone meeting the word here first.
//
// Photograph a flat surface — a tabletop, a car park, a stretch of desert — and every point on
// that surface lands on a predictable pixel. The map from "position on the flat surface" to
// "pixel in the photo" is called a HOMOGRAPHY, or equivalently a projective transform. It is the
// same family of transform as the "correct perspective" tool in a photo editor: it can stretch,
// rotate, shear, and make parallel lines converge, but it cannot bend a straight line.
//
// A homography is written as a 3x3 matrix H. To use it, write the surface position (x, y) as
// three numbers (x, y, 1), multiply by H, and divide the first two results by the third:
//
//     [ u' ]       [ x ]                       u = u' / w
//     [ v' ]  =  H [ y ]        and then       v = v' / w
//     [ w  ]       [ 1 ]
//
// That final divide is what produces perspective — distant things get a larger w and therefore
// shrink. Because scaling all nine entries of H at once cancels out in that divide, H has only
// 8 meaningful numbers, not 9. Each control point gives 2 equations, so 4 points is the minimum
// COUNT — but count alone is not enough. The four must also be in general position, with no
// three collinear, on the ground AND in the image. Three collinear points constrain only a line,
// and the DLT below then has more than one null direction, so it returns an arbitrary mix of
// them rather than failing. This solver does not test for that: fitPlane rejects a fully
// collinear set, but a set that is merely close to degenerate passes and produces a confident
// wrong camera. The range-spread figure in the diagnostics is the only warning the caller gets.
//
//
// WHY THIS IS A WAY TO FIND A CAMERA.
//
// H alone tells you where things land, not where the camera was. The extra step is this: H can be
// factored into "what the lens does" times "where the camera is and how it is turned". The lens
// part is a matrix called K, built entirely from the focal length. So:
//
//     (undo the lens)      K⁻¹H     =     (camera position and rotation)
//
// If we guess the focal length correctly, the right-hand side must be a valid rigid motion, and
// rigid motions have a strong structural property: two of their columns are rotation columns, so
// those columns must be perpendicular to each other and the same length. If we guess the focal
// length wrongly, they will not be. So we sweep the focal length, score how badly that property
// fails at each value, and take the focal length that scores best. Then one factorisation gives
// position, pointing and field of view together.
//
// This is a legitimate, standard method — it is how camera calibration from a printed
// checkerboard works. Having it side by side with the 3D fit makes it possible to show that a
// disagreement comes from the control points rather than from the choice of method, which is
// otherwise very hard to demonstrate.
//
//
// WHAT IT GIVES UP.
//
// The plane assumption throws away each landmark's individual elevation. More importantly, the
// method's conditioning depends entirely on how the control points are spread in RANGE. Camera
// height is recovered from the near/far differential in depression angle — how much more steeply
// you look down at a near landmark than a far one — so a control set confined to one depth band
// leaves almost nothing to recover it from. When that happens the focal score can still peak
// sharply while the height it implies is badly wrong, because a sharp peak measures how firmly
// the orthogonality constraint picks a focal length, NOT how close that pick is to the truth.
//
// The returned diagnostics therefore report the score band AND the range spread, because the
// first without the second is precision mistaken for accuracy.
//
//
// MATRIX LAYOUT, stated once. Every 3x3 matrix that is PASSED AROUND in this file — the
// homography, the conditioning transforms, anything reaching mat3mul or mat3inv — is a flat
// 9-element array in ROW-MAJOR order, meaning row 0 first:
//
//     [ m[0]  m[1]  m[2] ]
//     [ m[3]  m[4]  m[5] ]     element at (row r, column c) is  m[r * 3 + c]
//     [ m[6]  m[7]  m[8] ]
//
// One local exception: fitPlane's 3x3 normal equations are a nested array, because they get
// row-swapped during elimination and never leave that function.

import {azElRollFromBasis, evaluateCamera, jacobiSVD} from "./CameraPointFit";

const DEG = Math.PI / 180;

// --------------------------------------------------------------------------------------------
// Small vector helpers. A "vector" here is a plain 3-element array [x, y, z].
// --------------------------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a) => {
    const n = norm(a);
    return n > 0 ? scale(a, 1 / n) : [0, 0, 0];
};

/**
 * Fit a flat plane through the control points, and build a 2D coordinate system on it.
 *
 * The plane is written as a height that depends on the two horizontal coordinates:
 *
 *     z = slopeX * x + slopeY * y + offset
 *
 * We want the slopeX/slopeY/offset that make the plane pass as close as possible to every point.
 * The standard way to get that is LEAST SQUARES: write down the total squared vertical distance
 * from the points to the plane, and pick the three numbers that make it smallest. Doing the
 * calculus turns that into a 3x3 system of linear equations — the NORMAL EQUATIONS — whose
 * coefficients are just running sums over the points. That is what the accumulators below are.
 *
 * @param   {number[][]} local  points as [east, north, up] metres, relative to some local origin
 * @returns {object|null} {origin, ax1, ax2, normal, maxOffPlane}, or null if the points are
 *          collinear so that no unique plane exists. ax1 and ax2 are two perpendicular unit
 *          vectors lying IN the plane; together with `origin` they form a 2D coordinate system
 *          on it, which is what the homography needs.
 */
function fitPlane(local) {
    let sumXX = 0, sumXY = 0, sumX = 0;
    let sumYY = 0, sumY = 0, count = 0;
    let sumXZ = 0, sumYZ = 0, sumZ = 0;
    for (const p of local) {
        const [x, y, z] = p;
        sumXX += x * x; sumXY += x * y; sumX += x;
        sumYY += y * y; sumY += y; count += 1;
        sumXZ += x * z; sumYZ += y * z; sumZ += z;
    }

    // Solve the 3x3 normal equations by Gauss-Jordan elimination. Doing it by hand rather than
    // calling a library is reasonable here: it is small, and it is always well posed for 3 or
    // more points that are not in a straight line.
    const M = [[sumXX, sumXY, sumX], [sumXY, sumYY, sumY], [sumX, sumY, count]];
    const rhs = [sumXZ, sumYZ, sumZ];
    for (let i = 0; i < 3; i++) {
        // Partial pivoting: swap in the row with the largest leading coefficient before dividing
        // by it, so we never divide by a near-zero and amplify rounding error.
        let piv = i;
        for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
        [M[i], M[piv]] = [M[piv], M[i]];
        [rhs[i], rhs[piv]] = [rhs[piv], rhs[i]];
        if (Math.abs(M[i][i]) < 1e-12) return null;   // singular: the points are collinear
        // Eliminate this column from every OTHER row.
        for (let r = 0; r < 3; r++) {
            if (r === i) continue;
            const f = M[r][i] / M[i][i];
            for (let k = i; k < 3; k++) M[r][k] -= f * M[i][k];
            rhs[r] -= f * rhs[i];
        }
    }
    const slopeX = rhs[0] / M[0][0];
    const slopeY = rhs[1] / M[1][1];
    const offset = rhs[2] / M[2][2];

    // The plane's normal (the direction perpendicular to it) falls straight out of the slopes:
    // walking 1 east raises you by slopeX, so [-slopeX, -slopeY, 1] points out of the surface.
    const normal = normalize([-slopeX, -slopeY, 1]);
    const origin = [0, 0, offset];

    // Build the first in-plane axis by taking any direction with an east component and removing
    // whatever part of it sticks out of the plane (this is the Gram-Schmidt step). The second
    // axis is then forced: perpendicular to both the normal and the first axis.
    let ax1 = [1, 0, slopeX];
    ax1 = normalize(sub(ax1, scale(normal, dot(ax1, normal))));
    const ax2 = cross(normal, ax1);

    // How far the worst point sits off the plane. Reported so the caller can judge whether the
    // "the ground is flat" assumption was reasonable for this scene at all.
    let maxOffPlane = 0;
    for (const p of local) {
        maxOffPlane = Math.max(maxOffPlane, Math.abs(dot(sub(p, origin), normal)));
    }
    return {origin, ax1, ax2, normal, maxOffPlane};
}

/**
 * Hartley normalisation — recentre and rescale a set of 2D points before solving for H.
 *
 * This is not cosmetic. The homography equations mix raw pixel values (up to ~2000) with their
 * products (up to ~4,000,000). Feeding numbers of such different sizes into one linear solve
 * makes it numerically fragile, and the answer can lose most of its accuracy to rounding.
 * Shifting the points so their average is at the origin, then scaling so their average distance
 * from it is sqrt(2), puts every quantity near 1 and fixes that. The transform is undone
 * afterwards, so it changes only the arithmetic, not the result.
 *
 * @returns {object} {normalised, T} where T is the 3x3 transform that was applied, needed to
 *          undo the conditioning once H has been solved.
 */
function conditionPoints(pts) {
    let meanX = 0, meanY = 0;
    for (const p of pts) { meanX += p[0]; meanY += p[1]; }
    meanX /= pts.length; meanY /= pts.length;

    let meanDist = 0;
    for (const p of pts) meanDist += Math.hypot(p[0] - meanX, p[1] - meanY);
    meanDist /= pts.length;

    const s = meanDist > 0 ? Math.SQRT2 / meanDist : 1;
    return {
        normalised: pts.map((p) => [(p[0] - meanX) * s, (p[1] - meanY) * s]),
        T: [s, 0, -s * meanX, 0, s, -s * meanY, 0, 0, 1],
    };
}

/** Multiply two 3x3 row-major matrices. */
const mat3mul = (A, B) => {
    const C = new Array(9).fill(0);
    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
            for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
    return C;
};

/** Invert a 3x3 row-major matrix by the cofactor formula. Returns null if it is singular. */
function mat3inv(A) {
    const [a, b, c, d, e, f, g, h, i] = A;
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
    const s = 1 / det;
    return [
        (e * i - f * h) * s, (c * h - b * i) * s, (b * f - c * e) * s,
        (f * g - d * i) * s, (a * i - c * g) * s, (c * d - a * f) * s,
        (d * h - e * g) * s, (b * g - a * h) * s, (a * e - b * d) * s,
    ];
}

/**
 * Solve the plane-to-pixel homography by normalised DLT.
 *
 * DLT is the Direct Linear Transform, the standard textbook way to find H. The trick is that
 * although the homography involves a divide (u = u'/w), multiplying that divide out gives
 * equations that are LINEAR in the nine unknown entries of H. Each control point contributes two
 * such equations, which is where the two rows pushed below come from:
 *
 *     row for u:   -x*h0 - y*h1 - h2                    + u*x*h6 + u*y*h7 + u*h8  =  0
 *     row for v:                    -x*h3 - y*h4 - h5   + v*x*h6 + v*y*h7 + v*h8  =  0
 *
 * Stack them all up and we need the h that makes A*h as close to zero as possible — but h = 0 is
 * a useless answer, so we want the smallest NON-ZERO solution. That is exactly what the singular
 * value decomposition provides: the right-singular vector belonging to the smallest singular
 * value. jacobiSVD returns those vectors as the columns of v in descending order, so the one we
 * want is the last column, index 8.
 *
 * @param {number[][]} plane  2D positions on the fitted ground plane
 * @param {number[][]} px     the pixel each of those landed on
 */
function dltHomography(plane, px) {
    const P = conditionPoints(plane), Q = conditionPoints(px);
    const rows = [];
    for (let i = 0; i < P.normalised.length; i++) {
        const [x, y] = P.normalised[i], [u, v] = Q.normalised[i];
        rows.push([-x, -y, -1, 0, 0, 0, u * x, u * y, u]);
        rows.push([0, 0, 0, -x, -y, -1, v * x, v * y, v]);
    }
    const m = rows.length;
    const A = new Float64Array(m * 9);
    for (let r = 0; r < m; r++) for (let c = 0; c < 9; c++) A[r * 9 + c] = rows[r][c];

    const {s, v} = jacobiSVD(A, m, 9);
    if (!s || !v) return null;
    const hNormalised = [];
    for (let r = 0; r < 9; r++) hNormalised.push(v[r * 9 + 8]);

    // Undo the Hartley conditioning: the H we just solved maps conditioned plane coords to
    // conditioned pixels, so sandwich it between the two transforms to get the real one.
    const Qinv = mat3inv(Q.T);
    if (!Qinv) return null;

    // rankRatio is how the caller detects a degenerate control layout, and it is the ONLY thing
    // that does. Taking "the last column of v" as the answer silently assumes the null space is
    // one-dimensional. When three or more points are collinear — on the ground or in the image —
    // it is not, and the last column becomes an arbitrary mix of several equally valid null
    // directions. The SVD does not fail; it returns nonsense with total confidence.
    //
    // The second-smallest singular value is the tell. Measured over a range of layouts, after
    // Hartley conditioning:
    //     well spread 3x3 grid        s7/s0 = 2.8e-1
    //     4 points, general position  s7/s0 = 2.2e-1
    //     clustered but valid         s7/s0 = 2.4e-1
    //     3 of 5 collinear (still ok) s7/s0 = 1.0e-1
    //     near-collinear, 2% off      s7/s0 = 2.6e-3
    //     collinear in the image      s7/s0 = 4.2e-17
    //     collinear on the plane      s7/s0 = 0
    // Any usable layout sits at 1e-3 or above and any degenerate one at 1e-16 or below, so the
    // threshold has about four orders of magnitude of clearance on each side.
    return {
        H: mat3mul(Qinv, mat3mul(hNormalised, P.T)),
        rankRatio: s[0] > 0 ? s[7] / s[0] : 0,
    };
}

/** Below this, the DLT null space is not one-dimensional and its solution is meaningless. */
const DLT_RANK_FLOOR = 1e-6;

/** Root-mean-square pixel error of a homography against the correspondences it came from. */
function homographyRms(Hm, plane, px) {
    let acc = 0;
    for (let i = 0; i < plane.length; i++) {
        const [x, y] = plane[i];
        const w = Hm[6] * x + Hm[7] * y + Hm[8];
        if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return Infinity;
        const u = (Hm[0] * x + Hm[1] * y + Hm[2]) / w;
        const v = (Hm[3] * x + Hm[4] * y + Hm[5]) / w;
        acc += (u - px[i][0]) ** 2 + (v - px[i][1]) ** 2;
    }
    return Math.sqrt(acc / plane.length);
}

/**
 * Polish the homography by coordinate descent.
 *
 * The DLT above minimises an ALGEBRAIC error — how close A*h gets to zero — which is convenient
 * to solve but is not quite the thing we care about. What we actually want to minimise is the
 * GEOMETRIC error: the distance in pixels between where H sends each point and where it really
 * landed. This polishes toward that.
 *
 * Coordinate descent is the simplest possible optimiser: try nudging each parameter up and down
 * in turn, keep any nudge that helps, and when a whole pass helps nothing, halve the step size
 * and go round again. It is slow compared to a gradient method, but there are only 8 parameters,
 * it needs no derivatives, and it cannot diverge. The 9th entry is pinned to 1 first, because
 * scaling all of H changes nothing (see the header) and leaving that freedom in would let the
 * optimiser wander along a direction that does not affect the error at all.
 */
function refineHomography(Hm, plane, px) {
    const h = Hm.map((x) => x / Hm[8]);
    let best = homographyRms(h, plane, px);
    const step = h.map((x) => Math.abs(x) * 1e-3 + 1e-12);
    for (let pass = 0; pass < 200; pass++) {
        let improved = false;
        for (let j = 0; j < 8; j++) {
            for (const s of [1, -1]) {
                const t = h.slice();
                t[j] += s * step[j];
                const v = homographyRms(t, plane, px);
                if (v < best - 1e-12) { h[j] = t[j]; best = v; improved = true; }
            }
        }
        if (!improved) {
            for (let j = 0; j < 8; j++) step[j] *= 0.5;
            if (Math.max(...step) < 1e-15) break;
        }
    }
    return {H: h, rms: best};
}

/**
 * The first two columns of K⁻¹H, which are the two rotation columns we test for validity.
 *
 * K is the camera's intrinsic matrix — everything the lens contributes — and for a simple pinhole
 * it is built from just the focal length f and the image centre (cx, cy):
 *
 *          [ f  0  cx ]                  [ 1/f   0   -cx/f ]
 *     K =  [ 0  f  cy ]        K⁻¹  =    [  0   1/f  -cy/f ]
 *          [ 0  0   1 ]                  [  0    0     1   ]
 *
 * Multiplying that out for column j of H gives the three expressions below directly.
 */
function unlensedColumn(Hm, j, focalPx, cx, cy) {
    const a = Hm[0 * 3 + j], b = Hm[1 * 3 + j], c = Hm[2 * 3 + j];
    return [(a - cx * c) / focalPx, (b - cy * c) / focalPx, c];
}

/**
 * Score how badly K⁻¹H fails to contain two rotation columns, at a trial focal length.
 *
 * A rotation matrix has perpendicular columns of equal length. So we measure two things:
 *
 *   ortho — the cosine of the angle between the two columns. Zero when they are perpendicular.
 *   equal — the relative difference in their lengths. Zero when they match.
 *
 * Both are ratios, so both are dimensionless and neither can dominate the other just because of
 * the units. Squaring and adding gives one number to minimise, smallest is best.
 *
 * WHAT THIS SCORE IS AND IS NOT. It is computed from H and f alone and never re-examines the
 * image, so it is not a reprojection error. But it is not unrelated to one either, and it would
 * be wrong to say the focal length does not matter to the fit. H itself does reproduce the
 * control points identically at every f — it is fixed before the sweep starts — yet the sweep
 * does not use H directly. It DECOMPOSES H into a camera, and that decomposition forces the two
 * rotation columns to be orthonormal. At a wrong focal length that forcing distorts the mapping,
 * and the resulting camera reprojects badly. Measured on a real 7-point set: the decomposed
 * camera's reprojection error runs from 2.8 px at the score minimum to 409 px at the edge of the
 * sweep, and tracks this score monotonically throughout.
 *
 * So a low score does mean "this focal length decomposes into a camera that fits the control
 * points". What it does NOT mean is that the camera is right, because fitting the control points
 * only constrains the camera to the extent those points are spread out. On a control set confined
 * to one depth band, H is poorly determined in exactly the directions that set the height, and
 * both the score and the reprojection error can be small at a badly wrong camera. That is why the
 * diagnostics report range spread next to the score band.
 */
function orthonormalityScore(Hm, focalPx, cx, cy) {
    const h1 = unlensedColumn(Hm, 0, focalPx, cx, cy);
    const h2 = unlensedColumn(Hm, 1, focalPx, cx, cy);
    const n1 = norm(h1), n2 = norm(h2);
    if (!(n1 > 0) || !(n2 > 0)) return Infinity;
    const ortho = dot(h1, h2) / (n1 * n2);
    const equal = (n1 - n2) / (n1 + n2);
    return ortho * ortho + equal * equal;
}

/**
 * Factor the homography into a camera, at a trial focal length.
 *
 * Having undone the lens, the three columns of K⁻¹H are (up to one common scale factor) the first
 * two columns of the rotation and the translation. Recovering the camera means: work out that
 * scale factor, clean the two rotation columns up, rebuild the third by cross product, and then
 * undo the rotation to find where the camera centre must be.
 *
 * @returns {object|null} camera axes and centre in PLANE coordinates, or null if no valid
 *          factorisation puts the camera above the ground.
 */
function decomposeAtFocal(Hm, focalPx, cx, cy) {
    const m1 = unlensedColumn(Hm, 0, focalPx, cx, cy);
    const m2 = unlensedColumn(Hm, 1, focalPx, cx, cy);
    const m3 = unlensedColumn(Hm, 2, focalPx, cx, cy);

    // Rotation columns are unit length, so the common scale factor is 1 / (their average length).
    // Averaging the two rather than trusting either is the standard robust choice: with real data
    // they will not agree exactly, and there is no reason to prefer one.
    const lambda = 2 / (norm(m1) + norm(m2));
    if (!Number.isFinite(lambda) || lambda <= 0) return null;

    // Negating H changes nothing about where points land, so both signs are algebraically valid.
    // Only one of them puts the camera above the ground plane rather than below it, and that is
    // the physical one. This is the CHEIRALITY test — literally "handedness", the check that the
    // scene is in front of the camera rather than behind it.
    for (const sgn of [1, -1]) {
        let r1 = scale(m1, sgn * lambda);
        let r2 = scale(m2, sgn * lambda);
        const t = scale(m3, sgn * lambda);

        // Measurement noise means r1 and r2 will not be exactly perpendicular unit vectors, so
        // force them to be: normalise the first, then subtract from the second whatever part of
        // it points along the first (Gram-Schmidt again), and normalise that too.
        r1 = normalize(r1);
        r2 = normalize(sub(r2, scale(r1, dot(r2, r1))));
        const r3 = cross(r1, r2);

        // R has columns r1, r2, r3 and maps plane -> camera. So R transposed maps camera -> plane,
        // and ITS columns — which are the rows of R — are the camera's own axes written in plane
        // coordinates. That is what the caller needs to report a pointing.
        const right = [r1[0], r2[0], r3[0]];
        const down = [r1[1], r2[1], r3[1]];
        const fwd = [r1[2], r2[2], r3[2]];

        // A world point X images according to R*X + t, so the camera centre C is where that comes
        // to zero:  R*C + t = 0,  giving  C = -R⁻¹t = -Rᵀt.  For a rotation the transpose IS the
        // inverse, which is why this is three dot products rather than a matrix inversion.
        const centre = [-dot(r1, t), -dot(r2, t), -dot(r3, t)];
        if (centre[2] > 0) return {right, down, fwd, centre, heightAbovePlane: centre[2]};
    }
    return null;
}

/**
 * Find the focal length that minimises the orthonormality score, by golden-section search.
 *
 * The coarse scan that runs first has already found which sample is lowest; this narrows down
 * inside the one gap around it. Golden-section search keeps two bounds, tests two interior
 * points, and discards whichever end is further from the better of the two — shrinking the
 * interval by a constant factor each round without needing any derivatives, which matters here
 * because the score is only available by evaluation.
 *
 * Two honest caveats about this particular use.
 *
 * The interval is bestF/r to bestF*r, one scan step either side of the lowest sample. That
 * genuinely brackets the minimum only when the lowest sample is interior to the scan and the
 * score is unimodal across that step. If the scan's lowest sample were at either end the true
 * minimum could lie outside, and this would converge to the edge of the search rather than to
 * anything real — so the caller rejects an endpoint win BEFORE calling this, and never asks it
 * to refine an unbracketed interval.
 *
 * The classic reason for the 0.618 ratio is that one interior point can be reused next round,
 * halving the evaluations. This implementation does NOT exploit that — it recomputes both scores
 * every iteration. At 80 iterations of an arithmetically trivial score that is not worth the
 * added state, but do not read the ratio here as an optimisation that is being cashed in.
 *
 * @param   {number} bestF  the best focal length from the coarse scan
 * @param   {number} N      how many samples that scan used, which sets the gap width to search
 * @returns {number} the refined focal length
 */
function refineFocalByGoldenSection(Hm, cx, cy, bestF, LO, HI, N) {
    const ratioPerStep = Math.pow(HI / LO, 1 / N);
    // Clamp the bracket to the supported range. When the winning sample is at either end, the
    // bracket would otherwise reach one step past it and the search could converge OUTSIDE the
    // range the caller just finished validating — returning, say, 170.4 degrees as ok when the
    // supported maximum is 170. Clamping is a no-op for every interior minimum, where both
    // bracket ends are already inside; it bites only at indices 0 and N, and there it pins the
    // answer to the boundary rather than to a value the caller would have rejected.
    let lo = Math.max(bestF / ratioPerStep, LO);
    let hi = Math.min(bestF * ratioPerStep, HI);
    const gr = (Math.sqrt(5) - 1) / 2;
    for (let i = 0; i < 80; i++) {
        const a = hi - gr * (hi - lo), b = lo + gr * (hi - lo);
        if (orthonormalityScore(Hm, a, cx, cy) < orthonormalityScore(Hm, b, cx, cy)) hi = b;
        else lo = a;
    }
    return (lo + hi) / 2;
}

/**
 * Fit a camera to 2D/3D correspondences by assuming the control points are coplanar.
 *
 * Takes and returns the same shapes as fitCameraToPoints, so the two are interchangeable at the
 * call site. `free` is accepted for signature compatibility but is not read at all — the method
 * recovers position, pointing AND focal length from one factorisation and cannot hold any of the
 * three fixed. Rather than accept a lock that would do nothing, the Method dropdown greys the
 * Lock toggles out while this solver is selected (CNodeFitCameraPoints.syncMethodControls).
 *
 * @returns {object} {ok, reason, position, azDeg, elDeg, rollDeg, vfovDeg, rms, perPoint,
 *                    diagnostics, observability, freeParams}
 */
export function fitCameraByPlaneHomography(spec) {
    const points = spec.points ?? [];
    const imageSize = spec.imageSize;
    const localFrame = spec.localFrame;
    const fail = (reason) => ({ok: false, reason});

    if (points.length < 4) {
        return fail("The homography method needs at least 4 control points.");
    }
    if (!imageSize || !localFrame) return fail("Missing image size or local frame.");

    const cx = imageSize[0] / 2, cy = imageSize[1] / 2;

    // STEP 1 — move into a local east/north/up frame centred on the control points.
    //
    // World positions arrive as ECEF, which is measured from the centre of the Earth and so has
    // coordinates in the millions of metres, with axes that tilt as you move across the globe.
    // Fitting a plane in those coordinates would let that tilt distort the fit. Working relative
    // to the points' own centroid keeps the numbers small and the axes consistent.
    const centroid = scale(
        points.reduce((a, p) => add(a, p.world), [0, 0, 0]), 1 / points.length);
    const frame = localFrame(centroid);
    const up = normalize(frame.up);
    const north = normalize(frame.north);
    const east = cross(north, up);
    const toLocal = (w) => {
        const d = sub(w, centroid);
        return [dot(d, east), dot(d, north), dot(d, up)];
    };
    const toWorld = (l) => add(centroid,
        add(scale(east, l[0]), add(scale(north, l[1]), scale(up, l[2]))));

    // STEP 2 — fit the ground plane, and re-express each landmark as a 2D position on it.
    const local = points.map((p) => toLocal(p.world));
    const plane = fitPlane(local);
    // Note what this does and does not detect. fitPlane solves for a height over the horizontal
    // coordinates, so it fails when the points' HORIZONTAL PROJECTIONS are collinear. The points
    // themselves need not be: a set climbing a cliff face is collinear from above and perfectly
    // spread in 3D. That case genuinely has no z = f(x, y) plane, so failing is right, but the
    // reason is the plan view rather than the points.
    if (!plane) {
        return fail("Seen from above these control points fall on a line, so no ground plane " +
            "fits them. Add a point off that line.");
    }

    const planeXY = local.map((l) => {
        const d = sub(l, plane.origin);
        return [dot(d, plane.ax1), dot(d, plane.ax2)];
    });
    const px = points.map((p) => [p.px[0], p.px[1]]);

    // STEP 3 — solve the plane-to-image homography, then polish it.
    const dlt = dltHomography(planeXY, px);
    if (!dlt) return fail("The plane-to-image homography could not be solved.");
    if (!(dlt.rankRatio > DLT_RANK_FLOOR)) {
        return fail("These control points are degenerate for a homography — three or more are " +
            "collinear, on the ground or in the image. Move one off the line.");
    }
    let Hm = dlt.H;
    const refined = refineHomography(Hm, planeXY, px);
    Hm = refined.H;

    // STEP 4 — find the focal length that makes H factor into a valid camera.
    //
    // Scan coarsely first, then narrow into the winning gap. The scan steps by a constant RATIO
    // rather than a constant amount, because focal length is a scale: the interesting range spans
    // orders of magnitude, and even sampling in log space spends its samples evenly across fields
    // of view instead of piling them all up at the wide end. Scanning before refining also means
    // a narrow minimum cannot be stepped straight over, which a pure downhill method could do.
    const fovFromFocal = (f) => 2 * Math.atan((imageSize[1] / 2) / f) / DEG;
    const focalFromHFov = (h) => (imageSize[0] / 2) / Math.tan(h * DEG / 2);
    const LO = focalFromHFov(170), HI = focalFromHFov(1.0);
    const N = 900;
    // Sample a margin BEYOND each end of the supported range, at the same step ratio.
    //
    // The point is to make the supported endpoints interior. A camera at exactly 1 or exactly
    // 170 degrees is legitimate and passes the plausibility check below, but with the scan
    // stopping at those values its minimum would sit on the boundary sample with nothing outside
    // it to compare against — indistinguishable from a score still falling as the scan ran out,
    // and so rejected. Sampling past the ends gives every supported focal length neighbours on
    // both sides.
    //
    // Indices 0..N land on exactly the focal lengths they always did, because the expression is
    // unchanged for those i. Extra samples can only win when the score is genuinely still falling
    // outside the supported range, which is the case being rejected anyway.
    const MARGIN = 12;
    let bestF = null, bestS = Infinity, bestIdx = null;
    for (let i = -MARGIN; i <= N + MARGIN; i++) {
        const f = LO * Math.pow(HI / LO, i / N);
        const s = orthonormalityScore(Hm, f, cx, cy);
        if (s < bestS) { bestS = s; bestF = f; bestIdx = i; }
    }
    if (bestIdx === null || !Number.isFinite(bestS)) {
        return fail("No focal length satisfies the rotation constraints on these points.");
    }
    // An endpoint win is not a minimum. It means the score was still falling when the scan ran
    // out, so the best focal length lies outside 1-170 degrees and the value here is just the
    // edge of the search. Refining into that edge produces a confident answer that is an artefact
    // of where the scan stopped — a mismatched 8-point set drove the scan to its 1-degree limit
    // and returned a 46,700 px reprojection error labelled "Good".
    //
    // Two quite different things land here, so say which. Below 0 is WIDER than 170 deg and
    // above N is NARROWER than 1 deg, because the scan walks focal length upward. A camera
    // genuinely narrower than 1 degree is a real thing — Sitrec fits those routinely — and this
    // method simply does not search that far; the direct solver does, and is the right tool.
    // Mismatched correspondences also run off an end, because no focal length reconciles them.
    if (bestIdx < 0 || bestIdx > N) {
        const end = bestIdx > N ? "narrower than 1" : "wider than 170";
        return fail(`No focal length in the searched 1-170 degree range fits these points — the ` +
            `score was still falling at the ${end}-degree end. Either the correspondences do not ` +
            `describe one camera (check each 2D point is matched to the right 3D point), or the ` +
            `real field of view is outside that range, in which case use the 3D points method.`);
    }
    bestF = refineFocalByGoldenSection(Hm, cx, cy, bestF, LO, HI, N);
    bestS = orthonormalityScore(Hm, bestF, cx, cy);

    // STEP 5 — convert the factorisation back into Sitrec's camera description.
    //
    // decomposeAtFocal returns axes in PLANE components; these two helpers carry them back out to
    // local east/north/up components and then to world directions.
    const planeDirToLocal = (v) => [
        plane.ax1[0] * v[0] + plane.ax2[0] * v[1] + plane.normal[0] * v[2],
        plane.ax1[1] * v[0] + plane.ax2[1] * v[1] + plane.normal[1] * v[2],
        plane.ax1[2] * v[0] + plane.ax2[2] * v[1] + plane.normal[2] * v[2],
    ];
    const localDirToWorld = (v) => normalize(
        add(scale(east, v[0]), add(scale(north, v[1]), scale(up, v[2]))));

    /**
     * One focal length -> one complete camera. Every focal the scan scores implies a whole
     * camera, not just a field of view — position and pointing fall out of the same
     * factorisation.
     *
     * @returns {object|null} null when the factorisation puts the camera below the plane
     */
    const cameraAtFocal = (f) => {
        const dec = decomposeAtFocal(Hm, f, cx, cy);
        if (!dec) return null;
        const posLocal = add(plane.origin,
            add(scale(plane.ax1, dec.centre[0]),
                add(scale(plane.ax2, dec.centre[1]), scale(plane.normal, dec.centre[2]))));
        const position = toWorld(posLocal);
        const camFrame = localFrame(position);
        const {azDeg, elDeg, rollDeg} = azElRollFromBasis(
            normalize(camFrame.up), normalize(camFrame.north), {
                right: localDirToWorld(planeDirToLocal(dec.right)),
                down: localDirToWorld(planeDirToLocal(dec.down)),
                fwd: localDirToWorld(planeDirToLocal(dec.fwd)),
            });
        return {position, azDeg, elDeg, rollDeg, vfovDeg: fovFromFocal(f),
            heightAbovePlane: dec.heightAbovePlane};
    };

    const state = cameraAtFocal(bestF);
    if (state === null) return fail("The homography decomposes to a camera below the ground plane.");
    const {position, azDeg, elDeg, rollDeg, vfovDeg} = state;
    if (!Number.isFinite(vfovDeg) || vfovDeg < 0.02 || vfovDeg > 175) {
        return fail(`The homography implies an impossible field of view (${vfovDeg.toFixed(1)} deg).`);
    }

    // Score the finished camera the SAME way the direct solver is scored — by reprojecting the
    // control points through it — so the two methods can be compared on one number.
    const evaluated = evaluateCamera({points, imageSize, state, localFrame});

    // Cheirality, properly. decomposeAtFocal only checks centre[2] > 0, which says the camera
    // came out above the ground plane — it says nothing about whether the control points are in
    // front of the lens. A camera that puts landmarks behind itself is not a camera, whatever its
    // score, and fitCameraToPoints has always rejected that case. This is the same gate.
    if (evaluated.behind > 0) {
        return fail(`${evaluated.behind} control point` +
            `${evaluated.behind === 1 ? " is" : "s are"} behind the fitted camera.`);
    }

    // STEP 6 — diagnostics.
    //
    // The 5% score band is the same acceptance rule these pipelines usually publish: the span of
    // fields of view whose score is within 5% of the best. It measures how sharply the score
    // peaks — NOT how close the peak is to the truth — so it is reported next to the range
    // spread, which is what actually determines whether height is observable.
    //
    // Walk outward from the refined minimum in fine steps. Reading the band off the coarse scan
    // instead would collapse it to a single sample, because the refined minimum is lower than
    // anything the scan actually evaluated.
    const hfovAt = (f) => 2 * Math.atan((imageSize[0] / 2) / f) / DEG;
    const edge = (dir) => {
        const step = Math.pow(HI / LO, 1 / (N * 20));
        let f = bestF;
        for (let i = 0; i < N * 20; i++) {
            const next = dir > 0 ? f * step : f / step;
            if (next <= LO || next >= HI) break;
            if (orthonormalityScore(Hm, next, cx, cy) > bestS * 1.05) break;
            f = next;
        }
        return hfovAt(f);
    };
    const e1 = edge(+1), e2 = edge(-1);
    const bandLo = Math.min(e1, e2), bandHi = Math.max(e1, e2);

    // Range spread: the ratio of the farthest control point to the nearest. This is the honest
    // observability statement for this method, because camera height is recovered from the
    // near/far differential and nothing else. The thresholds are deliberately generous: below
    // 1.5x the height is not meaningfully determined however sharp the score looks.
    let rMin = Infinity, rMax = 0;
    for (const p of points) {
        const r = norm(sub(p.world, position));
        rMin = Math.min(rMin, r); rMax = Math.max(rMax, r);
    }
    const spreadRatio = rMin > 0 ? rMax / rMin : Infinity;

    const conditioning = spreadRatio >= 2.0 ? "good"
        : spreadRatio >= 1.5 ? "weak" : "unobservable";
    const observability = conditioning === "good"
        ? `Good (range spread ${spreadRatio.toFixed(1)}x)`
        : conditioning === "weak"
            ? `Weak — range spread only ${spreadRatio.toFixed(1)}x; height poorly determined`
            : `Unobservable — range spread ${spreadRatio.toFixed(1)}x; height not determined ` +
              `by these points`;

    return {
        ok: true,
        reason: null,
        position,
        azDeg, elDeg, rollDeg,
        vfovDeg,
        rms: evaluated.rms,
        perPoint: evaluated.perPoint,
        observability,
        diagnostics: {
            conditioning,
            rangeSpread: spreadRatio,
            scoreBandHFov: Number.isFinite(bandLo) && Number.isFinite(bandHi)
            ? [bandLo, bandHi] : null,
            scoreAtMinimum: bestS,
            // How far the control layout is from degenerate. Usable layouts sit at 1e-1; 1e-3 is
            // near-collinear and worth a second look; below DLT_RANK_FLOOR the solve is rejected.
            dltRankRatio: dlt.rankRatio,
            homographyRms: refined.rms,
            maxOffPlane: plane.maxOffPlane,
            heightAbovePlane: state.heightAbovePlane,
        },
        freeParams: ["homography"],
    };
}
