// Self-calibration of the camera lens from the star field itself.
//
// No EXIF, no user input, no assumption that the sitch's FOV is right. Stars are at infinity and
// the camera only rotates, so a clip that turns at all carries the information needed to recover
// how the lens maps angles to pixels - if it turns the right way. Most of this module is about
// deciding whether it did.
//
// WHY A SCAN AND NOT AN OPTIMISER. Focal length is scanned over a grid and the rotation re-fitted
// at each value. That is not a numerical nicety: the cost surface has a broad flat valley running
// out to f -> infinity, and f -> infinity IS the degenerate 2D model this whole migration exists
// to replace. An optimiser started cold sits in that valley and reports convergence. Measured
// while diagnosing the clip this was built for: five different focal seeds returned bit-identical
// answers because none of them ever left it.
//
// WHAT MAKES A LENS UNOBSERVABLE. The gate below is built around one fact that is easy to miss: a
// PURE ROLL about the optical axis tells you nothing whatsoever about the lens. Every radially
// symmetric lens maps a roll to the same rotation about the principal point, so a large, clean,
// full-frame roll fits every candidate equally well and a naive "did it rotate enough / do the
// stars cover enough radii" test passes it with flying colours while the fit is pure noise. The
// rotation has to move stars ACROSS radii, not merely around them.

import {makeLens, validateLens, lensFOV, LENS_PRESETS} from "../CameraLens";
import {fitRotationRobust, qAngle, refToFrame} from "./StarSphere";
import {lensToRay} from "../CameraLens";

export const STAR_CALIBRATE_DEFAULTS = {
    // Focal scan, as a multiple of the frame half-width. 0.35 is a fisheye wider than 180 deg
    // could image; 8 is a long lens where every model agrees and the answer is "rectilinear".
    focalMin: 0.35,
    focalMax: 8.0,
    focalSteps: 34,
    inlierThreshold: 2.0,

    minPairs: 25,               // correspondences needed before any of this is worth doing
    minRotationDeg: 0.35,       // below this the baseline carries no shape information
    minRadialSpanFrac: 0.35,    // stars must occupy this fraction of the usable image radius
    minRadialMotionPx: 2.0,     // and must MOVE across radii by at least this much
    minAxisOffsetDeg: 12,       // a rotation axis this close to the boresight is a roll
    // The fitted model must beat the best RECTILINEAR fit - today's behaviour, re-optimised with
    // the same freedoms - by this factor in robust rms before it is worth adopting.
    minImprovement: 1.6,
    holdoutFraction: 0.3,
};

const PRESETS = ["rectilinear", "stereographic", "equidistantFisheye", "equisolidFisheye", "orthographicFisheye"];

/** Correspondences between two frames, from tracks seen in both. */
export function correspondences(tracks, f0, f1) {
    const A = [], B = [], index = [];
    for (let i = 0; i < tracks.length; i++) {
        const a = tracks[i].obs.find((o) => o.f === f0);
        const b = tracks[i].obs.find((o) => o.f === f1);
        if (!a || !b) continue;
        A.push([a.x, a.y]); B.push([b.x, b.y]); index.push(i);
    }
    return {A, B, index};
}

/** Pick the widest baseline that still shares plenty of tracks. */
export function chooseBaseline(tracks, nFrames, minPairs) {
    let best = null;
    // Try the full span first, then walk inwards; the widest baseline has the most signal.
    for (const frac of [1.0, 0.8, 0.6, 0.45, 0.3]) {
        const span = Math.max(1, Math.round((nFrames - 1) * frac));
        for (const f0 of [0, Math.floor((nFrames - 1 - span) / 2)]) {
            const f1 = f0 + span;
            if (f1 >= nFrames) continue;
            const c = correspondences(tracks, f0, f1);
            if (c.A.length >= minPairs) return {f0, f1, ...c};
            if (!best || c.A.length > best.A.length) best = {f0, f1, ...c};
        }
    }
    return best;
}

function scoreLens(lens, A, B, size, O) {
    if (!validateLens(lens, size).ok) return null;
    const fit = fitRotationRobust(lens, A, B, {size, inlierThreshold: O.inlierThreshold});
    if (!fit) return null;
    // Score on the FULL set, not just the inliers the fit kept, so a model cannot win by
    // discarding the points it explains badly.
    let sse = 0, n = 0, within = 0;
    for (let i = 0; i < A.length; i++) {
        const ray = lensToRay(lens, A[i][0], A[i][1], size);
        if (!ray) continue;
        const p = refToFrame({q: fit.q, s: 1}, lens, ray, size);
        if (!p) continue;
        const e = Math.hypot(p[0] - B[i][0], p[1] - B[i][1]);
        sse += Math.min(e, 20) ** 2;             // capped, so one wild point cannot dominate
        n++;
        if (e < O.inlierThreshold) within++;
    }
    if (!n) return null;
    return {lens, fit, rms: Math.sqrt(sse / n), within, n};
}

/**
 * Fit lens + rotation over a focal scan, for every named preset.
 *
 * @returns {{best, byType, rectilinear}} the winner, each type's best, and the rectilinear
 *   baseline that the acceptance gate compares against.
 */
export function scanLens(A, B, size, opts = {}) {
    const O = {...STAR_CALIBRATE_DEFAULTS, ...opts};
    const half = size[0] / 2;
    const principal = [size[0] / 2, size[1] / 2];
    const byType = {};
    let best = null;

    for (const type of PRESETS) {
        let bestOfType = null;
        for (let k = 0; k < O.focalSteps; k++) {
            // Geometric grid: focal length is a scale, so equal ratios matter, not equal steps.
            const t = k / (O.focalSteps - 1);
            const focalPx = half * O.focalMin * Math.pow(O.focalMax / O.focalMin, t);
            const lens = makeLens({type, focalPx, principal, refSize: size});
            const s = scoreLens(lens, A, B, size, O);
            if (!s) continue;
            s.atBoundary = (k === 0 || k === O.focalSteps - 1);
            if (!bestOfType || s.within > bestOfType.within
                || (s.within === bestOfType.within && s.rms < bestOfType.rms)) bestOfType = s;
        }
        if (bestOfType) {
            byType[type] = bestOfType;
            if (!best || bestOfType.within > best.within
                || (bestOfType.within === best.within && bestOfType.rms < best.rms)) best = bestOfType;
        }
    }
    return {best, byType, rectilinear: byType.rectilinear ?? null};
}

/** Local search over the principal point, which a fitted lens should place near the centre. */
function refinePrincipal(seed, A, B, size, O) {
    let best = seed;
    for (const step of [48, 16, 5]) {
        let improved = true;
        while (improved) {
            improved = false;
            for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
                const lens = makeLens({
                    ...best.lens,
                    principal: [best.lens.principal[0] + dx, best.lens.principal[1] + dy],
                });
                // Refuse to wander far from the centre; a principal point outside the frame is
                // a fitting artifact, not an optical property.
                if (Math.abs(lens.principal[0] - size[0] / 2) > size[0] * 0.25) continue;
                if (Math.abs(lens.principal[1] - size[1] / 2) > size[1] * 0.25) continue;
                const s = scoreLens(lens, A, B, size, O);
                if (s && (s.within > best.within || (s.within === best.within && s.rms < best.rms))) {
                    best = s; improved = true;
                }
            }
        }
    }
    return best;
}

/**
 * How much the correspondences move ACROSS radii, and how much of the radius they occupy.
 *
 * The first is what makes a lens observable and the second is not a substitute for it: a pure
 * roll moves every star a long way while changing no star's radius at all.
 */
export function radialExcitation(A, B, principal) {
    let spanMin = Infinity, spanMax = 0, motion = 0;
    const deltas = [];
    for (let i = 0; i < A.length; i++) {
        const ra = Math.hypot(A[i][0] - principal[0], A[i][1] - principal[1]);
        const rb = Math.hypot(B[i][0] - principal[0], B[i][1] - principal[1]);
        spanMin = Math.min(spanMin, ra); spanMax = Math.max(spanMax, ra);
        deltas.push(Math.abs(rb - ra));
    }
    deltas.sort((a, b) => a - b);
    motion = deltas.length ? deltas[Math.floor(deltas.length * 0.9)] : 0;
    return {spanMin, spanMax, radialMotion: motion};
}

/**
 * Calibrate the lens from solved tracks.
 *
 * @returns {{accepted: boolean, lens, reason, diagnostics}} On rejection `lens` is null and
 *   `reason` says why, so the caller can keep the camera's existing lens and tell the user
 *   rather than silently adopting a fit of noise.
 */
export function calibrateLens(tracks, nFrames, size, opts = {}) {
    const O = {...STAR_CALIBRATE_DEFAULTS, ...opts};
    const diag = {};

    const base = chooseBaseline(tracks, nFrames, O.minPairs);
    if (!base || base.A.length < O.minPairs) {
        return {accepted: false, lens: null, reason: `only ${base ? base.A.length : 0} correspondences; need ${O.minPairs}`, diagnostics: diag};
    }
    diag.baseline = [base.f0, base.f1];
    diag.pairs = base.A.length;

    const {A, B} = base;
    const scan = scanLens(A, B, size, O);
    if (!scan.best) return {accepted: false, lens: null, reason: "no lens fitted", diagnostics: diag};

    const refined = refinePrincipal(scan.best, A, B, size, O);
    diag.type = refined.lens.type;
    diag.focalPx = refined.lens.focalPx;
    diag.principal = refined.lens.principal;
    diag.rms = refined.rms;
    diag.within = refined.within;
    diag.of = refined.n;

    // ---- acceptance gate ----

    // 1. Enough rotation for the baseline to carry shape information at all.
    const rotDeg = qAngle(refined.fit.q) * 180 / Math.PI;
    diag.rotationDeg = rotDeg;
    if (rotDeg < O.minRotationDeg) {
        return {accepted: false, lens: null, reason: `only ${rotDeg.toFixed(2)} deg of rotation`, diagnostics: diag};
    }

    // 2. NOT a pure roll. The axis must be well off the boresight, or the lens is unobservable
    //    however clean and however large the rotation is.
    const v = Math.hypot(refined.fit.q[0], refined.fit.q[1], refined.fit.q[2]);
    const axisZ = v > 1e-12 ? Math.abs(refined.fit.q[2] / v) : 1;
    const axisOffDeg = Math.acos(Math.min(1, axisZ)) * 180 / Math.PI;
    diag.axisOffsetDeg = axisOffDeg;
    if (axisOffDeg < O.minAxisOffsetDeg) {
        return {accepted: false, lens: null, reason: `rotation is a roll about the optical axis (${axisOffDeg.toFixed(1)} deg off), which constrains no lens`, diagnostics: diag};
    }

    // 3. Radial coverage AND radial motion.
    const ex = radialExcitation(A, B, refined.lens.principal);
    const usable = Math.hypot(size[0] / 2, size[1] / 2);
    diag.radialSpanFrac = (ex.spanMax - ex.spanMin) / usable;
    diag.radialMotion = ex.radialMotion;
    if (diag.radialSpanFrac < O.minRadialSpanFrac) {
        return {accepted: false, lens: null, reason: `stars span only ${(diag.radialSpanFrac * 100).toFixed(0)}% of the image radius`, diagnostics: diag};
    }
    if (ex.radialMotion < O.minRadialMotionPx) {
        return {accepted: false, lens: null, reason: `stars barely move across radii (${ex.radialMotion.toFixed(1)} px)`, diagnostics: diag};
    }

    // 4. Beat a re-optimised RECTILINEAR model - today's behaviour with the same freedoms - by a
    //    clear margin. Comparing against "rectilinear at the sitch's current FOV" would be a
    //    straw man that almost anything beats.
    const rect = scan.rectilinear ? refinePrincipal(scan.rectilinear, A, B, size, O) : null;
    diag.rectilinearRms = rect ? rect.rms : null;
    diag.rectilinearWithin = rect ? rect.within : null;
    if (rect && refined.lens.type !== "rectilinear") {
        if (!(rect.rms > refined.rms * O.minImprovement || refined.within > rect.within * 1.15)) {
            return {accepted: false, lens: null, reason: `no better than a rectilinear lens (rms ${refined.rms.toFixed(2)} vs ${rect.rms.toFixed(2)})`, diagnostics: diag};
        }
    }

    // 5. Held-out correspondences, split by TRACK, never by observation.
    const n = A.length;
    const holdN = Math.max(5, Math.floor(n * O.holdoutFraction));
    const trainIdx = [], testIdx = [];
    for (let i = 0; i < n; i++) (i % Math.round(1 / O.holdoutFraction) === 0 ? testIdx : trainIdx).push(i);
    if (testIdx.length >= 5 && trainIdx.length >= O.minPairs / 2) {
        const trainA = trainIdx.map((i) => A[i]), trainB = trainIdx.map((i) => B[i]);
        const s = scoreLens(refined.lens, trainA, trainB, size, O);
        if (s) {
            let sse = 0, m = 0;
            for (const i of testIdx) {
                const ray = lensToRay(refined.lens, A[i][0], A[i][1], size);
                if (!ray) continue;
                const p = refToFrame({q: s.fit.q, s: 1}, refined.lens, ray, size);
                if (!p) continue;
                sse += Math.min(Math.hypot(p[0] - B[i][0], p[1] - B[i][1]), 20) ** 2; m++;
            }
            diag.holdoutRms = m ? Math.sqrt(sse / m) : null;
            if (diag.holdoutRms !== null && rect && diag.holdoutRms > rect.rms) {
                return {accepted: false, lens: null, reason: `does not generalise (held-out rms ${diag.holdoutRms.toFixed(2)})`, diagnostics: diag};
            }
        }
    }

    const lens = makeLens({...refined.lens, source: "fitted"});
    diag.fov = lensFOV(lens, size);
    return {accepted: true, lens, reason: null, diagnostics: diag};
}
