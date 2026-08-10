// Camera fit by plane homography — the classical alternative to the direct 3D solve in
// CameraPointFit.js, provided so the two can be compared on the same control points.
//
// Why this exists. Published photogrammetric reconstructions of oblique video often use this
// route rather than a full 3D bundle: assume the ground is a plane, solve the plane-to-image
// projective map, then recover the focal length from the fact that two columns of a rotation
// matrix must be orthogonal and of equal length. It is a legitimate, standard method — it is how
// camera calibration from a printed checkerboard works. Having it side by side with the 3D fit
// makes it possible to show that a disagreement comes from the control points rather than from
// the choice of method, which is otherwise very hard to demonstrate.
//
// What it gives up. The plane assumption throws away each landmark's individual elevation, and
// more importantly the method's conditioning depends entirely on how the control points are
// spread in RANGE. Camera height is recovered from the near/far differential in depression
// angle; a control set confined to one depth band leaves almost nothing to recover it from, and
// then the focal score can still peak sharply while the height it implies is badly wrong. The
// returned diagnostics therefore report the score band AND the range spread, because the first
// without the second is precision mistaken for accuracy.

import {azElRollFromBasis, evaluateCamera, jacobiSVD} from "./CameraPointFit";

const DEG = Math.PI / 180;

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

/** Least-squares plane through local points: h = a*x + b*y + c, plus an orthonormal basis. */
function fitPlane(local) {
    let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, s1 = 0, sxz = 0, syz = 0, sz = 0;
    for (const p of local) {
        const [x, y, z] = p;
        sxx += x * x; sxy += x * y; sx += x;
        syy += y * y; sy += y; s1 += 1;
        sxz += x * z; syz += y * z; sz += z;
    }
    // Solve the 3x3 normal equations by hand; it is small and always well posed for >= 3
    // non-collinear points.
    const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, s1]];
    const b = [sxz, syz, sz];
    for (let i = 0; i < 3; i++) {
        let piv = i;
        for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
        [M[i], M[piv]] = [M[piv], M[i]];
        [b[i], b[piv]] = [b[piv], b[i]];
        if (Math.abs(M[i][i]) < 1e-12) return null;
        for (let r = 0; r < 3; r++) {
            if (r === i) continue;
            const f = M[r][i] / M[i][i];
            for (let k = i; k < 3; k++) M[r][k] -= f * M[i][k];
            b[r] -= f * b[i];
        }
    }
    const a = b[0] / M[0][0], bb = b[1] / M[1][1], cc = b[2] / M[2][2];

    const nrm = normalize([-a, -bb, 1]);
    const origin = [0, 0, cc];
    let ax1 = [1, 0, a];
    ax1 = normalize(sub(ax1, scale(nrm, dot(ax1, nrm))));
    const ax2 = cross(nrm, ax1);

    let worst = 0;
    for (const p of local) worst = Math.max(worst, Math.abs(dot(sub(p, origin), nrm)));
    return {origin, ax1, ax2, nrm, maxOffPlane: worst};
}

/** Hartley normalisation — centroid to the origin, mean radius sqrt(2). */
function conditionPoints(pts) {
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= pts.length; my /= pts.length;
    let d = 0;
    for (const p of pts) d += Math.hypot(p[0] - mx, p[1] - my);
    d /= pts.length;
    const s = d > 0 ? Math.SQRT2 / d : 1;
    return {
        out: pts.map((p) => [(p[0] - mx) * s, (p[1] - my) * s]),
        T: [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1],
    };
}

const mat3mul = (A, B) => {
    const C = new Array(9).fill(0);
    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
            for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
    return C;
};

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

/** Plane (x, y) -> pixel homography by normalised DLT. */
function dltHomography(plane, px) {
    const P = conditionPoints(plane), Q = conditionPoints(px);
    const rows = [];
    for (let i = 0; i < P.out.length; i++) {
        const [x, y] = P.out[i], [u, v] = Q.out[i];
        rows.push([-x, -y, -1, 0, 0, 0, u * x, u * y, u]);
        rows.push([0, 0, 0, -x, -y, -1, v * x, v * y, v]);
    }
    const m = rows.length;
    const A = new Float64Array(m * 9);
    for (let r = 0; r < m; r++) for (let c = 0; c < 9; c++) A[r * 9 + c] = rows[r][c];
    const {s, v} = jacobiSVD(A, m, 9);
    if (!s || !v) return null;
    // Right-singular vector of the smallest singular value = column 8 of v.
    const h = [];
    for (let r = 0; r < 9; r++) h.push(v[r * 9 + 8]);
    const Qi = mat3inv(Q.T);
    if (!Qi) return null;
    return mat3mul(Qi, mat3mul(h, P.T));
}

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

/** Coordinate-descent polish of the eight free homography entries. */
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
 * How badly K^-1 H fails to have two rotation columns, as a dimensionless score.
 * Both terms are scale-free so the two constraints are weighted comparably.
 */
function orthonormalityScore(Hm, focalPx, cx, cy) {
    const f = focalPx;
    // K^-1 = [[1/f, 0, -cx/f], [0, 1/f, -cy/f], [0, 0, 1]]
    const col = (j) => {
        const a = Hm[0 * 3 + j], b = Hm[1 * 3 + j], c = Hm[2 * 3 + j];
        return [(a - cx * c) / f, (b - cy * c) / f, c];
    };
    const h1 = col(0), h2 = col(1);
    const n1 = norm(h1), n2 = norm(h2);
    if (!(n1 > 0) || !(n2 > 0)) return Infinity;
    const ortho = dot(h1, h2) / (n1 * n2);
    const equal = (n1 - n2) / (n1 + n2);
    return ortho * ortho + equal * equal;
}

/** Recover the camera basis and centre, in plane coordinates, at a trial focal length. */
function decomposeAtFocal(Hm, focalPx, cx, cy) {
    const f = focalPx;
    const col = (j) => {
        const a = Hm[0 * 3 + j], b = Hm[1 * 3 + j], c = Hm[2 * 3 + j];
        return [(a - cx * c) / f, (b - cy * c) / f, c];
    };
    const m1 = col(0), m2 = col(1), m3 = col(2);
    const lambda = 2 / (norm(m1) + norm(m2));
    if (!Number.isFinite(lambda) || lambda <= 0) return null;

    // Both overall signs satisfy the homography; only one puts the camera above the plane.
    for (const sgn of [1, -1]) {
        let r1 = scale(m1, sgn * lambda);
        let r2 = scale(m2, sgn * lambda);
        const t = scale(m3, sgn * lambda);
        r1 = normalize(r1);
        r2 = normalize(sub(r2, scale(r1, dot(r2, r1))));   // re-orthogonalise against noise
        const r3 = cross(r1, r2);
        // R has columns r1,r2,r3 and maps plane -> camera, so R^T maps camera -> plane and its
        // COLUMNS (the rows of R) are the camera axes expressed in plane coordinates.
        const right = [r1[0], r2[0], r3[0]];
        const down = [r1[1], r2[1], r3[1]];
        const fwd = [r1[2], r2[2], r3[2]];
        // R*C + t = 0  =>  C = -R^T t
        const centre = [-dot(r1, t), -dot(r2, t), -dot(r3, t)];
        if (centre[2] > 0) return {right, down, fwd, centre, heightAbovePlane: centre[2]};
    }
    return null;
}

/**
 * Fit a camera to 2D/3D correspondences by assuming the control points are coplanar.
 *
 * Takes and returns the same shapes as fitCameraToPoints, so the two are interchangeable at the
 * call site. `free` is accepted for signature compatibility but is not read at all — the method
 * recovers position, pointing AND focal length from one decomposition and cannot hold any of the
 * three fixed. Rather than accept a lock that would do nothing, the Method dropdown greys the
 * Lock toggles out while this solver is selected (CNodeFitCameraPoints.syncMethodControls).
 *
 * @returns {object} {ok, reason, position, azDeg, elDeg, rollDeg, vfovDeg, rms, perPoint,
 *                    diagnostics, observability, homography}
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

    // Work in a local frame at the control points' centroid, so the plane fit is not distorted
    // by the curvature of the ECEF axes over the scene.
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

    const local = points.map((p) => toLocal(p.world));
    const plane = fitPlane(local);
    if (!plane) return fail("The control points are collinear — cannot fit a ground plane.");

    // 2D coordinates on the fitted plane, and the pixels they must map to.
    const planeXY = local.map((l) => {
        const d = sub(l, plane.origin);
        return [dot(d, plane.ax1), dot(d, plane.ax2)];
    });
    const px = points.map((p) => [p.px[0], p.px[1]]);

    let Hm = dltHomography(planeXY, px);
    if (!Hm) return fail("The plane-to-image homography could not be solved.");
    const refined = refineHomography(Hm, planeXY, px);
    Hm = refined.H;

    // Scan the focal length, then bisect into the best bracket. The score is smooth in log f,
    // so a coarse scan plus a golden-section refine is ample and cannot miss a narrow minimum
    // the way a pure gradient step could.
    const fovFromFocal = (f) => 2 * Math.atan((imageSize[1] / 2) / f) / DEG;
    const focalFromHFov = (h) => (imageSize[0] / 2) / Math.tan(h * DEG / 2);
    const LO = focalFromHFov(170), HI = focalFromHFov(1.0);
    const N = 900;
    let bestF = null, bestS = Infinity;
    for (let i = 0; i <= N; i++) {
        const f = LO * Math.pow(HI / LO, i / N);
        const s = orthonormalityScore(Hm, f, cx, cy);
        if (s < bestS) { bestS = s; bestF = f; }
    }
    if (bestF === null || !Number.isFinite(bestS)) {
        return fail("No focal length satisfies the rotation constraints on these points.");
    }
    {
        const r = Math.pow(HI / LO, 1 / N);
        let lo = bestF / r, hi = bestF * r;
        const gr = (Math.sqrt(5) - 1) / 2;
        for (let i = 0; i < 80; i++) {
            const a = hi - gr * (hi - lo), b = lo + gr * (hi - lo);
            if (orthonormalityScore(Hm, a, cx, cy) < orthonormalityScore(Hm, b, cx, cy)) hi = b;
            else lo = a;
        }
        bestF = (lo + hi) / 2;
        bestS = orthonormalityScore(Hm, bestF, cx, cy);
    }

    // The plane basis is expressed in LOCAL (east/north/up) components, so a vector given in
    // plane components becomes a local one here and a world one in localDirToWorld below.
    const planeDirToLocal = (v) => [
        plane.ax1[0] * v[0] + plane.ax2[0] * v[1] + plane.nrm[0] * v[2],
        plane.ax1[1] * v[0] + plane.ax2[1] * v[1] + plane.nrm[1] * v[2],
        plane.ax1[2] * v[0] + plane.ax2[2] * v[1] + plane.nrm[2] * v[2],
    ];
    // Local-frame direction components -> world directions.
    const localDirToWorld = (v) => normalize(
        add(scale(east, v[0]), add(scale(north, v[1]), scale(up, v[2]))));

    /**
     * One focal length -> one complete camera. Every focal the scan scores implies a whole
     * camera, not just a field of view — position and pointing fall out of the same
     * decomposition.
     *
     * @returns {object|null} null when the decomposition puts the camera below the plane
     */
    const cameraAtFocal = (f) => {
        const dec = decomposeAtFocal(Hm, f, cx, cy);
        if (!dec) return null;
        const posLocal = add(plane.origin,
            add(scale(plane.ax1, dec.centre[0]),
                add(scale(plane.ax2, dec.centre[1]), scale(plane.nrm, dec.centre[2]))));
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
    const evaluated = evaluateCamera({points, imageSize, state, localFrame});

    // The 5% score band is the same acceptance rule these pipelines usually publish. It measures
    // how sharply the score peaks — NOT how close the peak is to the truth — so it is reported
    // next to the range spread, which is what actually determines whether height is observable.
    // Walk outward from the refined minimum in fine log steps. Reading the band off the coarse
    // scan instead would collapse it to a single sample, because the refined minimum is lower
    // than anything the scan actually evaluated.
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
    let rMin = Infinity, rMax = 0;
    for (const p of points) {
        const r = norm(sub(p.world, position));
        rMin = Math.min(rMin, r); rMax = Math.max(rMax, r);
    }
    const spreadRatio = rMin > 0 ? rMax / rMin : Infinity;

    // Height is recovered from the near/far differential, so the range spread is the honest
    // observability statement for this method. The thresholds are deliberately generous: below
    // 1.5x the height is not meaningfully determined however sharp the score looks.
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
            homographyRms: refined.rms,
            maxOffPlane: plane.maxOffPlane,
            heightAbovePlane: state.heightAbovePlane,
        },
        freeParams: ["homography"],
    };
}
