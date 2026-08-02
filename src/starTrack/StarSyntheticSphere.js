// Spherical synthetic scenes for Star Track.
//
// Added alongside StarSynthetic.js, which stays as the planar fixture for the 2D path's
// regression tests. This one is GEOMETRIC rather than rendered: it emits per-frame detection
// lists directly instead of drawing images for StarDetect to find. Detection is not what changes
// in the spherical migration, and rendering a 90 deg fisheye field just to re-find the points
// would make every test slower without testing anything new.
//
// What it can express that the planar generator cannot, and why each matters:
//
//   - a real sky ROTATION about an arbitrary axis, including an axis near the frame corner,
//     which is the geometry that produced the measured failure;
//   - a wide LENS, so stars near the edge are compressed the way real ones are;
//   - a mover parameterised in a TANGENT PLANE, so its motion is a sky motion rather than a
//     pixel motion;
//   - stars that enter or leave the lens FOOTPRINT during the clip;
//   - camera-fixed artifacts, which hold pixel position while the sky moves past.

import {makeLens, lensToRay, rayToPixel} from "../CameraLens";
import {qFromAxisAngle, qRotate, qConj, makeFrameState} from "./StarSphere";
import {tangentBasis, tangentTo} from "./StarSolveSphere";

export function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** The lens fitted from the real rotating-starfield clip: ~89 deg horizontal. */
export function clipLens(size = [1280, 720]) {
    return makeLens({
        type: "orthographicFisheye", focalPx: 914 * size[0] / 1280,
        principal: [636 * size[0] / 1280, 332 * size[1] / 720], refSize: size,
    });
}

/**
 * Build a spherical scene.
 *
 * @param {object} o
 * @param {number[]} o.size            frame size in pixels
 * @param {object}   o.lens            camera lens (defaults to the measured clip's)
 * @param {number}   o.frames          frame count
 * @param {number}   o.starCount       stars to place inside the footprint
 * @param {number}   o.rotationDeg     TOTAL sky rotation over the clip
 * @param {number}   o.poleOffsetDeg   angle between the rotation axis and the boresight
 * @param {number}   o.noise           per-detection Gaussian sigma, px
 * @param {number}   o.moverSpeedPx    mover speed, px per frame at the field centre (0 = none)
 * @param {number}   o.hotPixels       camera-fixed artifacts to add
 * @param {number}   o.dropoutRate     chance a given detection is missing in a given frame
 */
export function buildSphericalScene(o = {}) {
    const size = o.size ?? [1280, 720];
    const lens = o.lens ?? clipLens(size);
    const frames = o.frames ?? 40;
    const starCount = o.starCount ?? 80;
    const rotationDeg = o.rotationDeg ?? 3.28;
    const poleOffsetDeg = o.poleOffsetDeg ?? 49;
    const noise = o.noise ?? 0.2;
    const moverSpeedPx = o.moverSpeedPx ?? 0;
    const hotPixels = o.hotPixels ?? 0;
    const dropoutRate = o.dropoutRate ?? 0;
    const rand = mulberry32(o.seed ?? 1234);
    const gauss = () => {
        const u = Math.max(1e-12, rand()), v = rand();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };

    // Rotation axis at the requested angle off the boresight, aimed up and to the right so the
    // pole lands past the top-right corner, as it does on the real clip.
    const a = poleOffsetDeg * Math.PI / 180;
    const axis = [Math.sin(a) * 0.866, -Math.sin(a) * 0.5, Math.cos(a)];
    const perFrame = rotationDeg * Math.PI / 180 / Math.max(1, frames - 1);

    // Truth states: q_f maps REFERENCE -> FRAME, with frame 0 pinned to the identity, so the sky
    // appears to rotate by -perFrame*f in the camera.
    const states = [];
    for (let f = 0; f < frames; f++) {
        states.push(makeFrameState({q: qConj(qFromAxisAngle(axis, perFrame * f)), converged: true, inliers: starCount}));
    }

    // Stars, placed by sampling pixels in frame 0 and un-projecting.
    const stars = [];
    let guard = 0;
    while (stars.length < starCount && guard++ < starCount * 200) {
        const x = rand() * size[0], y = rand() * size[1];
        const r = lensToRay(lens, x, y, size);
        if (r) stars.push(r);
    }

    // A mover: starts near the centre, drifts in its own tangent plane. Speed is specified in
    // pixels per frame at the centre and converted through the local plate scale, so the test can
    // ask for something comparable to the 2.6 px/frame the real object moved at.
    let mover = null;
    if (moverSpeedPx > 0) {
        const start = lensToRay(lens, size[0] * 0.45, size[1] * 0.5, size);
        const basis = tangentBasis(start);
        // At the boresight the plate scale is focalPx px per radian.
        const perFrameRad = moverSpeedPx / lens.focalPx;
        mover = {start, basis, va: perFrameRad * 0.8, vb: perFrameRad * 0.6};
    }

    const out = [];
    const truth = [];
    for (let f = 0; f < frames; f++) {
        const st = states[f];
        const dets = [];
        const tags = [];
        for (let i = 0; i < stars.length; i++) {
            if (dropoutRate > 0 && rand() < dropoutRate) continue;
            const p = rayToPixel(lens, qRotate(st.q, stars[i]), size);
            if (!p) continue;                                  // left the footprint
            if (p[0] < 0 || p[1] < 0 || p[0] >= size[0] || p[1] >= size[1]) continue;
            dets.push({x: p[0] + gauss() * noise, y: p[1] + gauss() * noise});
            tags.push({kind: "star", index: i});
        }
        if (mover) {
            const dir = tangentTo(mover.start, mover.basis, mover.va * f, mover.vb * f);
            const p = rayToPixel(lens, qRotate(st.q, dir), size);
            if (p && p[0] >= 0 && p[1] >= 0 && p[0] < size[0] && p[1] < size[1]) {
                dets.push({x: p[0] + gauss() * noise, y: p[1] + gauss() * noise});
                tags.push({kind: "mover"});
            }
        }
        for (let h = 0; h < hotPixels; h++) {
            // Deterministic pixel positions, held for the whole clip.
            const x = 60 + (h * 137) % (size[0] - 120);
            const y = 40 + (h * 89) % (size[1] - 80);
            dets.push({x, y});
            tags.push({kind: "hot", index: h});
        }
        out.push(dets);
        truth.push(tags);
    }

    return {lens, size, frames, states, stars, mover, perFrame: out, truth};
}
