// Spherical primitives for Star Track: per-frame camera orientation on SO(3), and the fit that
// recovers it.
//
// Added ALONGSIDE the 2D similarity algebra in StarMatch.js, not in place of it. Nothing here is
// wired into the pipeline yet; the existing chain remains the default until the spherical path is
// verified against both regression windows.
//
// WHY THIS EXISTS. Star Track models frame-to-frame sky motion as a 2D similarity, q = A*p + B.
// That is the small-angle, narrow-field approximation to what actually happens, which is a
// rotation of the celestial sphere seen through a lens. Measured on a ~89 deg IR monocular clip:
// the similarity explained 84 of 129 star correspondences with an 11.7 px worst case, and
// reported ~70 real stars as moving; rays through a fitted lens plus ONE 3D rotation explained
// all 129 to 0.75 px rms. A homography (8 dof) barely helped, which is the diagnostic detail -
// K R K^-1 covers perspective, but radial lens compression is not a projective map, so no
// planar model of any order can absorb it.
//
//
// REPRESENTATION. A quaternion, not a matrix: it composes and inverts as cheaply as the complex
// similarity it replaces, which is the property the whole architecture rests on, and it
// interpolates properly across gaps.
//
//   q maps REFERENCE -> FRAME.  Stated once; the inverse direction is everywhere.
//   Storage order is [x, y, z, w] with w the scalar, matching Three.js.
//
// Per-frame state is {q, s, ...provenance}, NOT a stored frame-to-frame transform. Frame-to-frame
// maps are derived: i -> j is refToFrame(j, frameToRef(i, .)), with R_{j<-i} = q_j q_i^-1. That
// removes the question of whether the transform composes, and it is what makes zoom expressible
// at all - a frame-to-frame map depends on BOTH frames' focal scales, so it is not a group
// element on its own.
//
// The provenance fields are load-bearing, not debug extras. "We have a q for frame j" and "we
// TRUST frame j" are different claims, and the bridging logic in solveChainOnce depends on the
// difference: an interpolated or held orientation must never become a bridge anchor.

import {lensToRay, rayToPixel} from "../CameraLens";

export const Q_IDENTITY = [0, 0, 0, 1];

export function qMul(a, b) {
    const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ];
}

export function qConj(q) {
    return [-q[0], -q[1], -q[2], q[3]];
}

export function qNormalize(q) {
    const n = Math.hypot(q[0], q[1], q[2], q[3]);
    if (!(n > 1e-12)) return Q_IDENTITY.slice();
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Rotate a 3-vector by q. */
export function qRotate(q, v) {
    const [x, y, z, w] = q;
    // t = 2 * (qv x v); result = v + w*t + qv x t
    const tx = 2 * (y * v[2] - z * v[1]);
    const ty = 2 * (z * v[0] - x * v[2]);
    const tz = 2 * (x * v[1] - y * v[0]);
    return [
        v[0] + w * tx + y * tz - z * ty,
        v[1] + w * ty + z * tx - x * tz,
        v[2] + w * tz + x * ty - y * tx,
    ];
}

export function qFromAxisAngle(axis, angle) {
    const n = Math.hypot(axis[0], axis[1], axis[2]);
    if (!(n > 1e-12)) return Q_IDENTITY.slice();
    const h = angle / 2, s = Math.sin(h) / n;
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

/** Rotation angle of q, in radians, always in [0, pi]. */
export function qAngle(q) {
    const w = Math.min(1, Math.abs(q[3]));
    return 2 * Math.acos(w);
}

/**
 * Force q onto the same hemisphere as `ref`.
 *
 * q and -q are the same rotation but different numbers, and every log, slerp and smoothness
 * penalty in this module is sensitive to which one it is handed. A 2*pi seam in the middle of a
 * frame sequence reads as a physical swing to a second-difference prior. Call this before any of
 * them, not after noticing the artefact.
 */
export function qAlign(q, ref) {
    const d = q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3];
    return d < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}

/** Rotation vector (axis * angle) of q. Inverse of qExp. */
export function qLog(q) {
    const qq = q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;  // shortest arc
    const v = Math.hypot(qq[0], qq[1], qq[2]);
    if (v < 1e-12) return [0, 0, 0];
    const angle = 2 * Math.atan2(v, qq[3]);
    const k = angle / v;
    return [qq[0] * k, qq[1] * k, qq[2] * k];
}

/** Quaternion from a rotation vector. Inverse of qLog. */
export function qExp(v) {
    const angle = Math.hypot(v[0], v[1], v[2]);
    if (angle < 1e-12) return Q_IDENTITY.slice();
    return qFromAxisAngle(v, angle);
}

/** The rotation taking `a` to `b`: b = qBetween(a,b) * a. */
export function qBetween(a, b) {
    return qMul(b, qConj(a));
}

export function qSlerp(a, b, t) {
    const bb = qAlign(b, a);
    let dot = a[0] * bb[0] + a[1] * bb[1] + a[2] * bb[2] + a[3] * bb[3];
    dot = Math.max(-1, Math.min(1, dot));
    if (dot > 0.9995) {
        return qNormalize([
            a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t,
            a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t,
        ]);
    }
    const theta = Math.acos(dot), s = Math.sin(theta);
    const ka = Math.sin((1 - t) * theta) / s, kb = Math.sin(t * theta) / s;
    return qNormalize([
        a[0] * ka + bb[0] * kb, a[1] * ka + bb[1] * kb,
        a[2] * ka + bb[2] * kb, a[3] * ka + bb[3] * kb,
    ]);
}

/**
 * Per-frame camera state.
 *
 * `s` is the focal scale (zoom), 1 at the lens's reference zoom. It exists in the data model from
 * the start so that enabling zoom later is a contained change rather than a second rewrite, but
 * nothing solves for it yet - see the plan's gating rationale, which turns on the measured fact
 * that a free scale absorbs camera-fixed artifacts instead of rejecting them.
 */
export function makeFrameState(opts = {}) {
    return {
        q: opts.q ? qNormalize(opts.q) : Q_IDENTITY.slice(),
        s: opts.s ?? 1,
        status: opts.status ?? "solved",     // "solved" | "interpolated" | "held"
        base: opts.base ?? null,             // which frame this was solved against
        inliers: opts.inliers ?? 0,
        converged: opts.converged ?? false,
    };
}

/** Is this state trustworthy enough to anchor a bridge? */
export function isTrustedAnchor(state, minInliers = 6) {
    return !!state && state.status === "solved" && state.converged && state.inliers >= minInliers;
}

/** Frame pixel -> unit ray in the REFERENCE frame. Null if the pixel is not imageable. */
export function frameToRef(state, lens, x, y, size = null) {
    const ray = lensToRay(lens, x, y, size, state.s);
    if (!ray) return null;
    return qRotate(qConj(state.q), ray);
}

/**
 * Reference-frame unit ray -> frame pixel. Null when the ray is behind the camera or outside the
 * lens's field.
 *
 * Callers MUST handle null. A 2D similarity always returned a point, so no existing call site
 * expects a miss; treating null as "no offset" or "no motion" silently biases whatever it feeds -
 * the motion probe that gates artifact rejection is the dangerous one, because a null read as
 * zero motion switches artifact removal off entirely.
 */
export function refToFrame(state, lens, ray, size = null) {
    return rayToPixel(lens, qRotate(state.q, ray), size, state.s);
}

/** Map a pixel from frame i into frame j. Null if it has no image in j. */
export function framePixelToFrame(stateI, stateJ, lens, x, y, size = null) {
    const ref = frameToRef(stateI, lens, x, y, size);
    if (!ref) return null;
    return refToFrame(stateJ, lens, ref, size);
}

// ---------------------------------------------------------------------------------------------
// Rotation fitting
// ---------------------------------------------------------------------------------------------

/** Jacobi eigen-decomposition of a small symmetric matrix; returns the dominant eigenvector. */
function dominantEigenvector(K, n) {
    // Work on copies: A holds the matrix, V the accumulated rotations.
    const A = K.map((r) => r.slice());
    const V = Array.from({length: n}, (_, i) => Array.from({length: n}, (_, j) => (i === j ? 1 : 0)));
    for (let sweep = 0; sweep < 100; sweep++) {
        let off = 0;
        for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
        if (off < 1e-24) break;
        for (let p = 0; p < n; p++) {
            for (let q = p + 1; q < n; q++) {
                if (Math.abs(A[p][q]) < 1e-30) continue;
                const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1), s = t * c;
                for (let k = 0; k < n; k++) {
                    const akp = A[k][p], akq = A[k][q];
                    A[k][p] = c * akp - s * akq;
                    A[k][q] = s * akp + c * akq;
                }
                for (let k = 0; k < n; k++) {
                    const apk = A[p][k], aqk = A[q][k];
                    A[p][k] = c * apk - s * aqk;
                    A[q][k] = s * apk + c * aqk;
                }
                for (let k = 0; k < n; k++) {
                    const vkp = V[k][p], vkq = V[k][q];
                    V[k][p] = c * vkp - s * vkq;
                    V[k][q] = s * vkp + c * vkq;
                }
            }
        }
    }
    let best = 0;
    for (let i = 1; i < n; i++) if (A[i][i] > A[best][best]) best = i;
    return V.map((row) => row[best]);
}

/**
 * Wahba's problem, closed form: the rotation best aligning reference rays `A` to frame rays `B`.
 *
 * Davenport's q-method - build the 4x4 K matrix and take its dominant eigenvector, which IS the
 * quaternion. This is the exact analogue of the complex least-squares solve that fitSimilarity
 * uses, and like it, the solution is exact given the correspondences; only the modelling is
 * approximate.
 *
 * Note what it minimises: CHORD error between unit rays. That is not detector-pixel error once
 * the lens Jacobian varies across the field, so this is the INITIALISER, and
 * refineRotationPixels does the real work.
 */
export function fitRotationWahba(A, B, w = null) {
    const n = Math.min(A.length, B.length);
    if (n < 2) return null;
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    let total = 0;
    for (let i = 0; i < n; i++) {
        const wi = w ? w[i] : 1;
        if (!(wi > 0)) continue;
        total += wi;
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r][c] += wi * B[i][r] * A[i][c];
    }
    if (total <= 0) return null;
    const tr = M[0][0] + M[1][1] + M[2][2];
    const z = [M[1][2] - M[2][1], M[2][0] - M[0][2], M[0][1] - M[1][0]];
    const K = [
        [M[0][0] + M[0][0] - tr, M[0][1] + M[1][0], M[0][2] + M[2][0], z[0]],
        [M[1][0] + M[0][1], M[1][1] + M[1][1] - tr, M[1][2] + M[2][1], z[1]],
        [M[2][0] + M[0][2], M[2][1] + M[1][2], M[2][2] + M[2][2] - tr, z[2]],
        [z[0], z[1], z[2], tr],
    ];
    // Davenport's method is stated in the Shuster/JPL quaternion convention, which is the
    // CONJUGATE of the Hamilton convention used everywhere else here (and by Three.js). Returning
    // it unconjugated is not a small error - it is the inverse rotation, so the recovered angle
    // comes out at exactly twice the truth. That is the signature to look for if this ever
    // regresses: an error of 2*theta rather than a noisy theta.
    return qConj(qNormalize(dominantEigenvector(K, 4)));
}

/**
 * Refine a rotation by minimising DETECTOR-PIXEL reprojection, by Gauss-Newton on the rotation
 * vector, with the update applied on the left: q <- exp(delta) * q.
 *
 * Wahba gets the chord-optimal answer; this gets the pixel-optimal one. On a wide lens they are
 * not the same, because a fixed angular error is worth very different numbers of pixels at the
 * centre and at the edge - an orthographic lens compresses radially by cos(theta), which is 0.6
 * at the corner of the measured clip.
 */
export function refineRotationPixels(q0, lens, refRays, pixels, size = null, opts = {}) {
    const {iterations = 12, s = 1, weights = null} = opts;
    let q = qNormalize(q0);
    const state = {q, s};
    const cost = (qq) => {
        const st = {q: qq, s};
        let sse = 0, n = 0;
        for (let i = 0; i < refRays.length; i++) {
            const wi = weights ? weights[i] : 1;
            if (!(wi > 0)) continue;
            const p = refToFrame(st, lens, refRays[i], size);
            if (!p) continue;
            sse += wi * ((p[0] - pixels[i][0]) ** 2 + (p[1] - pixels[i][1]) ** 2);
            n += wi;
        }
        return n > 0 ? sse : Infinity;
    };
    let c = cost(q);
    for (let iter = 0; iter < iterations; iter++) {
        // Numeric Jacobian in the 3 rotation-vector components. Three columns is cheap enough
        // that an analytic derivative would buy little and cost a convention bug.
        const h = 1e-7;
        const AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Atb = [0, 0, 0];
        state.q = q;
        for (let i = 0; i < refRays.length; i++) {
            const wi = weights ? weights[i] : 1;
            if (!(wi > 0)) continue;
            const base = refToFrame(state, lens, refRays[i], size);
            if (!base) continue;
            const J = [[0, 0], [0, 0], [0, 0]];       // [param][x|y]
            let ok = true;
            for (let k = 0; k < 3; k++) {
                const d = [0, 0, 0]; d[k] = h;
                const p = refToFrame({q: qMul(qExp(d), q), s}, lens, refRays[i], size);
                if (!p) { ok = false; break; }
                J[k][0] = (p[0] - base[0]) / h;
                J[k][1] = (p[1] - base[1]) / h;
            }
            if (!ok) continue;
            const rx = pixels[i][0] - base[0], ry = pixels[i][1] - base[1];
            for (let a = 0; a < 3; a++) {
                for (let b = 0; b < 3; b++) AtA[a][b] += wi * (J[a][0] * J[b][0] + J[a][1] * J[b][1]);
                Atb[a] += wi * (J[a][0] * rx + J[a][1] * ry);
            }
        }
        const delta = solve3(AtA, Atb);
        if (!delta) break;
        const qn = qNormalize(qMul(qExp(delta), q));
        const cn = cost(qn);
        if (!(cn < c)) break;
        const improved = c - cn;
        q = qn; c = cn;
        if (improved < 1e-12) break;
    }
    return q;
}

function solve3(A, b) {
    const M = [[A[0][0], A[0][1], A[0][2], b[0]],
               [A[1][0], A[1][1], A[1][2], b[1]],
               [A[2][0], A[2][1], A[2][2], b[2]]];
    for (let c = 0; c < 3; c++) {
        let piv = c;
        for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
        [M[c], M[piv]] = [M[piv], M[c]];
        if (Math.abs(M[c][c]) < 1e-14) return null;
        for (let r = 0; r < 3; r++) {
            if (r === c) continue;
            const f = M[r][c] / M[c][c];
            for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
        }
    }
    const out = [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
    return out.every((v) => isFinite(v)) ? out : null;
}

/**
 * Robust rotation from pixel correspondences: robust seed, Wahba initialiser, pixel refinement,
 * annealed trimming.
 *
 * The seed matters and is not decoration. fitSimilarity anneals from a MEDIAN-seeded consensus
 * precisely because a plain least-squares start can be dragged far enough by gross mismatches
 * that the trimming then rejects the true consensus instead of the outliers. Unweighted Wahba has
 * exactly that weakness, so the seed here is the rotation implied by the median of the per-pair
 * rotation vectors, which tolerates almost half the pairs disagreeing.
 *
 * @returns {{q, inliers, inlierMask, rms, converged}|null}
 */
export function fitRotationRobust(lens, pixelsA, pixelsB, opts = {}) {
    const {
        size = null, s = 1, inlierThreshold = 1.2, startThresholdFactor = 4.0,
        rounds = 8, minPairs = 3,
    } = opts;
    const n = Math.min(pixelsA.length, pixelsB.length);
    if (n < minPairs) return null;

    const idState = makeFrameState({s});
    const A = [], B = [], pxB = [], keep = [];
    for (let i = 0; i < n; i++) {
        const a = lensToRay(lens, pixelsA[i][0], pixelsA[i][1], size, s);
        const b = lensToRay(lens, pixelsB[i][0], pixelsB[i][1], size, s);
        if (!a || !b) continue;
        A.push(a); B.push(b); pxB.push(pixelsB[i]); keep.push(i);
    }
    if (A.length < minPairs) return null;

    // Median-of-per-pair-rotations seed.
    const vecs = A.map((a, i) => qLog(shortestArc(a, B[i])));
    const med = [0, 1, 2].map((k) => {
        const c = vecs.map((v) => v[k]).sort((x, y) => x - y);
        return c[c.length >> 1];
    });
    let q = qExp(med);

    let w = new Array(A.length).fill(1);
    let rms = Infinity, converged = false;
    for (let r = 0; r < rounds; r++) {
        // Residuals under the CURRENT estimate FIRST, so the weights that go into Wahba have
        // already excluded the gross mismatches.
        //
        // Refitting on everything before trimming - which is the obvious loop order - throws away
        // the robust seed on round zero. Measured: with a fifth of the pairs displaced by ~150 px,
        // all-pairs Wahba lands 2.4 deg out, which puts every genuine inlier ~37 px from its
        // prediction, so nothing falls inside the gate and the whole fit collapses to the
        // contaminated answer. This is the same reasoning that makes fitSimilarity median-seed
        // its translation before annealing.
        const st = {q, s};
        const err = A.map((a, i) => {
            const p = refToFrame(st, lens, a, size);
            return p ? Math.hypot(p[0] - pxB[i][0], p[1] - pxB[i][1]) : Infinity;
        });
        // Anneal the gate from wide to tight, as fitSimilarity does: a fixed threshold cannot
        // separate a coherent contaminant from a small true motion.
        const f = startThresholdFactor + (1 - startThresholdFactor) * (r / Math.max(1, rounds - 1));
        let gate = inlierThreshold * Math.max(1, f);
        let nw = err.map((e) => (e < gate ? 1 : 0));
        let count = nw.reduce((x, y) => x + y, 0);
        // If the current estimate is poor enough that nothing sits inside the gate, WIDEN rather
        // than give up: an empty gate means the estimate is bad, not that the data is bad, and
        // bailing here would return exactly the bad estimate that emptied it.
        while (count < minPairs && gate < 4096) {
            gate *= 2;
            nw = err.map((e) => (e < gate ? 1 : 0));
            count = nw.reduce((x, y) => x + y, 0);
        }
        if (count < minPairs) break;
        const same = nw.every((v, i) => v === w[i]);
        w = nw;

        const seed = fitRotationWahba(A, B, w);
        if (seed) q = qAlign(seed, q);
        q = refineRotationPixels(q, lens, A, pxB, size, {s, weights: w});

        const st2 = {q, s};
        let sse = 0, m = 0;
        for (let i = 0; i < A.length; i++) {
            if (!w[i]) continue;
            const p = refToFrame(st2, lens, A[i], size);
            const e = p ? Math.hypot(p[0] - pxB[i][0], p[1] - pxB[i][1]) : Infinity;
            if (isFinite(e)) { sse += e * e; m++; }
        }
        rms = m ? Math.sqrt(sse / m) : Infinity;
        if (same && r > 0) { converged = true; break; }
    }
    // Final weights reflect the returned q, not the estimate that produced them one round ago.
    {
        const st = {q, s};
        const gate = inlierThreshold;
        w = A.map((a, i) => {
            const p = refToFrame(st, lens, a, size);
            return p && Math.hypot(p[0] - pxB[i][0], p[1] - pxB[i][1]) < gate ? 1 : 0;
        });
    }

    const inlierMask = new Array(n).fill(false);
    let inliers = 0;
    for (let i = 0; i < w.length; i++) if (w[i]) { inlierMask[keep[i]] = true; inliers++; }
    return {q, inliers, inlierMask, rms, converged};
}

/** Shortest-arc quaternion taking unit vector a to unit vector b. */
export function shortestArc(a, b) {
    const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    if (d > 0.999999) return Q_IDENTITY.slice();
    if (d < -0.999999) {
        // Antipodal: any perpendicular axis, pi rotation.
        let axis = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        axis = [
            a[1] * axis[2] - a[2] * axis[1],
            a[2] * axis[0] - a[0] * axis[2],
            a[0] * axis[1] - a[1] * axis[0],
        ];
        return qFromAxisAngle(axis, Math.PI);
    }
    const c = [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
    return qNormalize([c[0], c[1], c[2], 1 + d]);
}
