// Spherical primitives: quaternion algebra, Wahba, and the pixel-domain rotation fit.
//
// The last describe block is the one that matters most - it reconstructs the measured failure
// (a wide lens, a sky rotation about an axis near the frame corner) and checks that the spherical
// fit explains what the 2D similarity cannot. If that block ever goes green for the similarity
// too, the rewrite has lost its reason to exist.

import {
    Q_IDENTITY, qMul, qConj, qNormalize, qRotate, qFromAxisAngle, qAngle, qAlign,
    qLog, qExp, qBetween, qSlerp, shortestArc,
    makeFrameState, isTrustedAnchor, frameToRef, refToFrame, framePixelToFrame,
    fitRotationWahba, refineRotationPixels, fitRotationRobust,
} from "../src/starTrack/StarSphere";
import {makeLens, lensToRay, rayToPixel} from "../src/CameraLens";
import {fitSimilarity, applyTransform} from "../src/starTrack/StarMatch";

const SIZE = [1280, 720];
/** The lens fitted from the real rotating-starfield clip. */
const CLIP_LENS = makeLens({
    type: "orthographicFisheye", focalPx: 914, principal: [636, 332], refSize: SIZE,
});

function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe("quaternion algebra", () => {
    test("identity, conjugate and composition behave", () => {
        const q = qFromAxisAngle([0.3, -0.5, 0.8], 0.42);
        const v = [0.2, 0.5, Math.sqrt(1 - 0.04 - 0.25)];
        expect(qRotate(Q_IDENTITY, v)).toEqual(v);
        // q then q^-1 is the identity
        const back = qRotate(qConj(q), qRotate(q, v));
        for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(v[i], 12);
        // composition order: qMul(b, a) applies a first
        const a = qFromAxisAngle([0, 0, 1], 0.3), b = qFromAxisAngle([1, 0, 0], -0.2);
        const composed = qRotate(qMul(b, a), v);
        const stepwise = qRotate(b, qRotate(a, v));
        for (let i = 0; i < 3; i++) expect(composed[i]).toBeCloseTo(stepwise[i], 12);
    });

    test("rotation preserves length", () => {
        const q = qFromAxisAngle([1, 2, 3], 1.1);
        const r = qRotate(q, [0.6, 0, 0.8]);
        expect(Math.hypot(...r)).toBeCloseTo(1, 12);
    });

    test("log and exp are mutual inverses", () => {
        for (const angle of [1e-9, 0.01, 0.5, 2.5, 3.0]) {
            const q = qFromAxisAngle([0.2, 0.9, -0.4], angle);
            const back = qExp(qLog(q));
            const d = Math.abs(back[0] * q[0] + back[1] * q[1] + back[2] * q[2] + back[3] * q[3]);
            expect(d).toBeCloseTo(1, 10);
        }
    });

    test("qAlign removes the sign ambiguity that a 2*pi seam would create", () => {
        const q = qFromAxisAngle([0, 0, 1], 0.2);
        const flipped = q.map((v) => -v);
        const fixed = qAlign(flipped, q);
        for (let i = 0; i < 4; i++) expect(fixed[i]).toBeCloseTo(q[i], 12);
        // and the flipped form really is the same rotation, which is why it is a trap
        const v = [1, 0, 0];
        const a = qRotate(q, v), b = qRotate(flipped, v);
        for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], 12);
    });

    test("qBetween produces the rotation that takes one orientation to another", () => {
        const a = qFromAxisAngle([0, 1, 0], 0.3), b = qFromAxisAngle([1, 0, 1], 0.9);
        const rel = qBetween(a, b);
        const got = qMul(rel, a);
        const d = Math.abs(got[0] * b[0] + got[1] * b[1] + got[2] * b[2] + got[3] * b[3]);
        expect(d).toBeCloseTo(1, 12);
    });

    test("slerp interpolates on the manifold and hits both ends", () => {
        const a = qFromAxisAngle([0, 0, 1], 0), b = qFromAxisAngle([0, 0, 1], 1.2);
        expect(qAngle(qBetween(a, qSlerp(a, b, 0)))).toBeCloseTo(0, 9);
        expect(qAngle(qBetween(b, qSlerp(a, b, 1)))).toBeCloseTo(0, 9);
        // halfway is half the angle - which per-component log interpolation would NOT guarantee
        expect(qAngle(qBetween(a, qSlerp(a, b, 0.5)))).toBeCloseTo(0.6, 9);
    });

    test("shortestArc maps one ray onto another", () => {
        const a = qNormalize([0.3, 0.4, 0.86, 0]).slice(0, 3);
        const an = a.map((v) => v / Math.hypot(...a));
        const b = [0, 0, 1];
        const r = qRotate(shortestArc(an, b), an);
        for (let i = 0; i < 3; i++) expect(r[i]).toBeCloseTo(b[i], 9);
    });
});

describe("per-frame state", () => {
    test("frameToRef and refToFrame round trip through the lens", () => {
        const st = makeFrameState({q: qFromAxisAngle([0.2, 1, 0.1], 0.05)});
        for (const px of [[100, 100], [640, 360], [1200, 650], [636, 332]]) {
            const ref = frameToRef(st, CLIP_LENS, px[0], px[1], SIZE);
            expect(ref).not.toBeNull();
            const back = refToFrame(st, CLIP_LENS, ref, SIZE);
            expect(back).not.toBeNull();
            expect(Math.hypot(back[0] - px[0], back[1] - px[1])).toBeLessThan(1e-8);
        }
    });

    test("an identity state maps a pixel to itself", () => {
        const st = makeFrameState();
        const p = framePixelToFrame(st, st, CLIP_LENS, 900, 200, SIZE);
        expect(p[0]).toBeCloseTo(900, 9);
        expect(p[1]).toBeCloseTo(200, 9);
    });

    test("a ray with no image returns null rather than a clamped pixel", () => {
        // Rotate so a pixel's ray ends up behind the camera.
        const st = makeFrameState({q: qFromAxisAngle([0, 1, 0], Math.PI * 0.9)});
        expect(refToFrame(st, CLIP_LENS, [0, 0, 1], SIZE)).toBeNull();
    });

    test("only a solved, converged, well-supported frame can anchor a bridge", () => {
        expect(isTrustedAnchor(makeFrameState({status: "solved", converged: true, inliers: 20}))).toBe(true);
        expect(isTrustedAnchor(makeFrameState({status: "interpolated", converged: true, inliers: 20}))).toBe(false);
        expect(isTrustedAnchor(makeFrameState({status: "held", converged: true, inliers: 20}))).toBe(false);
        expect(isTrustedAnchor(makeFrameState({status: "solved", converged: false, inliers: 20}))).toBe(false);
        expect(isTrustedAnchor(makeFrameState({status: "solved", converged: true, inliers: 2}))).toBe(false);
    });
});

/** Random unit rays inside the lens's field, plus their pixels. */
function syntheticField(n, lens, seed = 5) {
    const rand = mulberry32(seed);
    const rays = [], px = [];
    let guard = 0;
    while (rays.length < n && guard++ < n * 100) {
        const x = rand() * SIZE[0], y = rand() * SIZE[1];
        const r = lensToRay(lens, x, y, SIZE);
        if (!r) continue;
        rays.push(r); px.push([x, y]);
    }
    return {rays, px};
}

describe("Wahba and pixel refinement", () => {
    test("Wahba recovers a known rotation exactly from clean rays", () => {
        const truth = qFromAxisAngle([0.4, -0.7, 0.6], 0.0573);   // 3.28 deg, the measured value
        const {rays} = syntheticField(40, CLIP_LENS);
        const rotated = rays.map((r) => qRotate(truth, r));
        const q = fitRotationWahba(rays, rotated);

        // Scored on how well the rotation maps the rays, NOT on qAngle of the difference.
        // qAngle is 2*acos(|w|), which is ill-conditioned near the identity: an eps error in w
        // shows up as ~2*sqrt(2 eps), so in double precision a numerically exact fit still reads
        // ~3e-8 rad. That is the measurement's floor, not the fit's error.
        let worst = 0;
        for (let i = 0; i < rays.length; i++) {
            const p = qRotate(q, rays[i]);
            worst = Math.max(worst, Math.hypot(p[0] - rotated[i][0], p[1] - rotated[i][1], p[2] - rotated[i][2]));
        }
        expect(worst).toBeLessThan(1e-12);
        expect(qAngle(qBetween(q, truth))).toBeLessThan(1e-6);
    });

    test("Wahba needs at least two directions", () => {
        expect(fitRotationWahba([[0, 0, 1]], [[0, 0, 1]])).toBeNull();
    });

    test("pixel refinement improves on the chord-optimal answer under noise", () => {
        const truth = qFromAxisAngle([0.4, -0.7, 0.6], 0.0573);
        const {rays, px} = syntheticField(60, CLIP_LENS, 17);
        const rand = mulberry32(3);
        const target = rays.map((r) => {
            const p = rayToPixel(CLIP_LENS, qRotate(truth, r), SIZE);
            return [p[0] + (rand() - 0.5) * 0.6, p[1] + (rand() - 0.5) * 0.6];
        });
        const seed = fitRotationWahba(rays, rays.map((r) => qRotate(truth, r)));
        const refined = refineRotationPixels(seed, CLIP_LENS, rays, target, SIZE);
        const rms = (q) => {
            const st = {q, s: 1};
            let sse = 0;
            for (let i = 0; i < rays.length; i++) {
                const p = refToFrame(st, CLIP_LENS, rays[i], SIZE);
                sse += (p[0] - target[i][0]) ** 2 + (p[1] - target[i][1]) ** 2;
            }
            return Math.sqrt(sse / rays.length);
        };
        expect(rms(refined)).toBeLessThanOrEqual(rms(seed) + 1e-12);
    });
});

describe("fitRotationRobust", () => {
    test("recovers a known rotation from pixel correspondences", () => {
        const truth = qFromAxisAngle([0.4, -0.7, 0.6], 0.0573);
        const {rays, px} = syntheticField(50, CLIP_LENS, 21);
        const pxB = rays.map((r) => rayToPixel(CLIP_LENS, qRotate(truth, r), SIZE));
        const fit = fitRotationRobust(CLIP_LENS, px, pxB, {size: SIZE});
        expect(fit).not.toBeNull();
        expect(qAngle(qBetween(fit.q, truth))).toBeLessThan(1e-6);
        expect(fit.rms).toBeLessThan(0.01);
    });

    test("rejects gross mismatches instead of averaging them in", () => {
        const truth = qFromAxisAngle([0.1, -0.9, 0.4], 0.04);
        const {rays, px} = syntheticField(50, CLIP_LENS, 33);
        const pxB = rays.map((r) => rayToPixel(CLIP_LENS, qRotate(truth, r), SIZE));
        // corrupt a fifth of the correspondences
        for (let i = 0; i < 10; i++) pxB[i * 5] = [pxB[i * 5][0] + 120, pxB[i * 5][1] - 90];
        const fit = fitRotationRobust(CLIP_LENS, px, pxB, {size: SIZE});
        expect(qAngle(qBetween(fit.q, truth))).toBeLessThan(1e-4);
        expect(fit.inliers).toBeGreaterThan(35);
        for (let i = 0; i < 10; i++) expect(fit.inlierMask[i * 5]).toBe(false);
    });

    test("returns null rather than a meaningless fit below the minimum", () => {
        expect(fitRotationRobust(CLIP_LENS, [[1, 1]], [[2, 2]], {size: SIZE})).toBeNull();
    });
});

describe("the measured failure, reconstructed", () => {
    // Rebuilds the clip's geometry: an ~89 deg lens, and 3.28 deg of sky rotation about an axis
    // 49 deg off the boresight (which put the celestial pole just past the top-right corner).
    // The 2D similarity is expected to FAIL here by ~10 px; the spherical fit should not.
    function scene(seed) {
        const alpha = 49 * Math.PI / 180;
        const axis = [Math.sin(alpha) * 0.866, -Math.sin(alpha) * 0.5, Math.cos(alpha)];
        const truth = qFromAxisAngle(axis, 3.28 * Math.PI / 180);
        const {rays, px} = syntheticField(130, CLIP_LENS, seed);
        const pxB = [], pxA = [], keep = [];
        for (let i = 0; i < rays.length; i++) {
            const p = rayToPixel(CLIP_LENS, qRotate(truth, rays[i]), SIZE);
            if (!p) continue;
            pxA.push(px[i]); pxB.push(p); keep.push(rays[i]);
        }
        return {truth, pxA, pxB, rays: keep};
    }

    test("a 2D similarity leaves a large residual, as measured on the real clip", () => {
        const {pxA, pxB} = scene(101);
        const fit = fitSimilarity(pxA, pxB, {allowScale: false});
        let worst = 0;
        for (let i = 0; i < pxA.length; i++) {
            const p = applyTransform({A: fit.A, B: fit.B}, pxA[i][0], pxA[i][1]);
            worst = Math.max(worst, Math.hypot(p[0] - pxB[i][0], p[1] - pxB[i][1]));
        }
        // The real clip's worst case was 11.7 px. Synthetic geometry, same order.
        expect(worst).toBeGreaterThan(5);
    });

    test("the spherical fit explains the same field to well under a pixel", () => {
        const {truth, pxA, pxB, rays} = scene(101);
        const fit = fitRotationRobust(CLIP_LENS, pxA, pxB, {size: SIZE});
        expect(fit).not.toBeNull();
        expect(qAngle(qBetween(fit.q, truth))).toBeLessThan(1e-6);

        const st = {q: fit.q, s: 1};
        let worst = 0;
        for (let i = 0; i < rays.length; i++) {
            const p = refToFrame(st, CLIP_LENS, rays[i], SIZE);
            worst = Math.max(worst, Math.hypot(p[0] - pxB[i][0], p[1] - pxB[i][1]));
        }
        expect(worst).toBeLessThan(0.05);
        // and every correspondence is an inlier, where the similarity had to call some of them
        // movers to fit the rest
        expect(fit.inliers).toBe(pxA.length);
    });

    test("the recovered rotation angle is the true 3.28 deg, not the similarity's underestimate", () => {
        const {truth, pxA, pxB} = scene(101);
        const fit = fitRotationRobust(CLIP_LENS, pxA, pxB, {size: SIZE});
        expect(qAngle(fit.q) * 180 / Math.PI).toBeCloseTo(3.28, 3);
        // the similarity's in-plane angle is smaller - the real clip reported 2.19 vs 3.28
        const sim = fitSimilarity(pxA, pxB, {allowScale: false});
        const simAngle = Math.abs(Math.atan2(sim.A[1], sim.A[0])) * 180 / Math.PI;
        expect(simAngle).toBeLessThan(qAngle(truth) * 180 / Math.PI);
    });
});
