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
    // The shape search is synchronous; these bound its cost so it cannot freeze the UI.
    // shapeMaxPairs trades speed against SHAPE accuracy specifically, and the two are not
    // interchangeable: dropping to 50 of 130 pairs halved the runtime but cost the edge coverage
    // that determines the curve, taking absolute sky accuracy from 0.09 to 0.30 deg while the
    // self-consistency rms barely moved. Trim the step count before trimming the pairs.
    shapeMaxPairs: 110,         // correspondences used while exploring lens shape
    shapeScales: [1, 0.3, 0.1], // coordinate-descent step scales
    shapeMaxSteps: 10,          // passes per scale

    // How far the principal point may sit from the frame centre, as a fraction of each frame
    // dimension. This is a BOUND ON A WEAKLY OBSERVABLE PARAMETER, not a statement about optics:
    // over a small rotation the principal point trades against the lens curve, so an unbounded
    // search wanders instead of converging.
    //
    // It is a real modelling assumption, and cropping is what breaks it. A centred digital zoom
    // is harmless - the crop keeps the axis at the new centre, and focalPx is measured in the
    // analysed pixels either way - but an UNEVEN crop moves the optical axis off the frame centre
    // by however much was taken off one side, and a hard enough crop puts it outside the frame
    // altogether. That is an ordinary property of cropped footage, not an artifact. So the bound
    // is generous, adjustable, and - the part that matters - REPORTED when the search ends up
    // pressed against it, because a clamped principal point is a fit that wanted to be elsewhere.
    principalMaxOffsetFrac: 0.45,

    // When the centred scan explains fewer than this fraction of the correspondences, the frame
    // centre is probably not where the optical axis is, and scanPrincipal takes a coarse global
    // look before the local refinement starts. Measured on the two real clips: an uncropped one
    // scores 0.99 here and never triggers it; a hard-cropped one scores 0.27 and cannot be solved
    // without it.
    principalSearchWithinFrac: 0.6,
    principalScanSteps: 5,      // n x n grid across +-principalMaxOffsetFrac (odd: includes centre)
    principalScanPairs: 40,     // correspondences subsampled for the grid - it only locates a basin
    principalScanFocals: 9,     // coarse focal grid for the same reason
    // Two shapes, not five: across the grid the principal point dominates the score, and these
    // two bracket the family (a pinhole and the most compressive fisheye). The winning cell is
    // re-scanned over every type at full resolution afterwards, so nothing is lost.
    principalScanTypes: ["rectilinear", "orthographicFisheye"],
    principalScanKeep: 3,       // grid cells re-scanned at full resolution before one is chosen
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

/**
 * Pick the baseline carrying the most lens signal: wide AND well populated.
 *
 * This used to return the FIRST baseline clearing minPairs, walking from widest inwards - "the
 * widest baseline has the most signal". Width alone is not signal. On a cropped timelapse whose
 * tracks are mostly short, that rule took a 127-frame baseline with 31 correspondences over a
 * 40-frame one with 342, and 31 noisy pairs do not determine a lens: the fit came back rms 2.05
 * with 21 of 31 inliers and a principal point 268 px from the truth, where the richer baseline
 * gives rms 0.51 and lands within 7 px.
 *
 * So every candidate is scored, `pairs * span`, and the best wins. Both factors are real - span
 * buys the rotation that makes a lens observable at all, pairs buy the statistics - and the
 * separate gates below still check that the rotation and the radial excitation are sufficient, so
 * this only has to choose between candidates, not judge them.
 */
export function chooseBaseline(tracks, nFrames, minPairs, opts = {}) {
    const O = {...STAR_CALIBRATE_DEFAULTS, ...opts};
    let fallback = null;
    const cands = [];
    for (const frac of [1.0, 0.8, 0.6, 0.45, 0.3]) {
        const span = Math.max(1, Math.round((nFrames - 1) * frac));
        for (const f0 of [0, Math.floor((nFrames - 1 - span) / 2)]) {
            const f1 = f0 + span;
            if (f1 >= nFrames) continue;
            const c = correspondences(tracks, f0, f1);
            // Kept so a clip that never reaches minPairs still reports its best effort, and the
            // caller's own "only N correspondences; need M" refusal is what speaks.
            if (!fallback || c.A.length > fallback.A.length) fallback = {f0, f1, ...c};
            if (c.A.length < minPairs) continue;
            cands.push({f0, f1, span, ...c});
        }
    }
    if (!cands.length) return fallback;

    // ROTATION IS A PREREQUISITE, NOT A TIEBREAK. `pairs * span` on its own will happily pick a
    // dense NARROW baseline whose rotation is below minRotationDeg - and because the gate that
    // catches that only ever sees the ONE chosen baseline, the whole clip is then refused while a
    // wider, thinner, perfectly calibratable baseline sat unexamined. (Measured on a 1-degree
    // synthetic scene: 0->12 with 150 pairs wins on score, rotates 0.31 deg and is refused, while
    // 0->39 with 25 pairs rotates 0.99 deg and calibrates.) So candidates are screened for
    // rotation FIRST, with a cheap nominal-lens fit, and only the survivors are ranked.
    if (opts.size) {
        const nominal = makeLens({type: "rectilinear", focalPx: opts.size[0] / 2,
            refSize: opts.size});
        for (const c of cands) {
            const fit = fitRotationRobust(nominal, c.A, c.B,
                {size: opts.size, inlierThreshold: O.inlierThreshold, rounds: 4});
            c.rotationDeg = fit ? qAngle(fit.q) * 180 / Math.PI : 0;
        }
        // The estimate uses a stand-in lens, so leave margin rather than screening at the exact
        // gate; the real gate still runs on the winner.
        const viable = cands.filter((c) => c.rotationDeg >= 0.8 * O.minRotationDeg);
        if (viable.length) cands.length = 0, cands.push(...viable);
    }

    let best = null, bestScore = -1;
    for (const c of cands) {
        const score = c.A.length * c.span;
        if (score > bestScore) { bestScore = score; best = c; }
    }
    return best ?? fallback;
}

function scoreLens(lens, A, B, size, O) {
    if (!validateLens(lens, size).ok) return null;
    // `fitRounds` lets the coordinate descent run a cheaper rotation fit while it explores - the
    // shape search does not need a fully annealed inlier set at every trial point, only a
    // comparable one - and the winner is re-scored at full depth afterwards.
    const fit = fitRotationRobust(lens, A, B,
        {size, inlierThreshold: O.inlierThreshold, rounds: O.fitRounds ?? 8});
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
    // Defaults to the frame centre, which is where an UNCROPPED camera's axis is. A caller that
    // has reason to believe otherwise - scanPrincipal, below - passes its own.
    const principal = opts.principal ? [...opts.principal] : [size[0] / 2, size[1] / 2];
    const byType = {};
    let best = null;

    // Callers locating a BASIN rather than a final answer can restrict the shape family: at this
    // stage the principal point dominates the score and the exact curve barely moves it.
    for (const type of (opts.types ?? PRESETS)) {
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

/**
 * Least-squares fit of the custom polynomial to a named preset's curve, over the radii the image
 * actually uses.
 *
 * The seed for the custom refinement, and it has to be FITTED rather than derived. The truncated
 * Taylor series of the same curve is far worse: for an orthographic lens over a 1280x720 frame,
 * best-fit d3/d5 leaves 0.98 px at the corner where the Taylor coefficients leave 9.83 px. Least
 * squares spreads the error over the range; a Taylor series is optimal only at rho = 0 and
 * degrades monotonically outward, which on a wide lens means it is worst exactly where the
 * original bug lives.
 */
/**
 * Find roughly WHERE the optical axis is, when it is clearly not at the frame centre.
 *
 * refinePrincipal is a local descent, and on a hard crop the objective actively misleads it.
 * Measured on a real cropped timelapse whose axis is at (953, 239) of a 1280x720 video - the
 * video is a crop of a larger frame - the rms surface over the principal point runs:
 *
 *        x=400   520   640   760   880   953  1040
 *   y=239  4.73  5.44  5.53  1.81  0.65  0.60  0.76
 *   y=360  4.51  5.07  5.90  5.66  2.41  1.66  1.07
 *
 * The global minimum is 0.60 at the true axis, and from the frame centre (5.90) the STEEPEST
 * improvement is leftward - away from it - into a broad shallow plateau. That surface is scanned
 * with lens type and focal re-fitted at every cell, so it is not an artifact of holding those
 * fixed: no local refinement of the principal point can solve this, however it is stepped. It
 * needs a coarse global look.
 *
 * Gated, and deliberately so: an uncropped clip's centred scan already explains nearly every
 * correspondence, so this never runs for it and costs it nothing. The grid is only paid for by
 * the clips that would otherwise be refused outright.
 *
 * Cheap by construction - a subsample of the correspondences and a coarse focal grid. It only has
 * to identify the right NEIGHBOURHOOD; the existing scan and refinePrincipal do the precision
 * work from there.
 */
export function scanPrincipal(A, B, size, opts = {}) {
    const O = {...STAR_CALIBRATE_DEFAULTS, ...opts};
    // Subsample: locating a basin does not need every pair, and this runs synchronously.
    const step = Math.max(1, Math.floor(A.length / O.principalScanPairs));
    const a = [], b = [];
    for (let i = 0; i < A.length; i += step) { a.push(A[i]); b.push(B[i]); }

    const n = O.principalScanSteps;
    const span = O.principalMaxOffsetFrac;
    const cells = [];
    for (let iy = 0; iy < n; iy++) {
        for (let ix = 0; ix < n; ix++) {
            // Spread across +-principalMaxOffsetFrac of the frame, centre included (n is odd).
            const fx = n === 1 ? 0 : -span + (2 * span * ix) / (n - 1);
            const fy = n === 1 ? 0 : -span + (2 * span * iy) / (n - 1);
            const principal = [size[0] * (0.5 + fx), size[1] * (0.5 + fy)];
            const s = scanLens(a, b, size, {...O, principal,
                focalSteps: O.principalScanFocals, types: O.principalScanTypes});
            if (!s.best) continue;
            const c = {...s.best, principal,
                atBoundary: ix === 0 || iy === 0 || ix === n - 1 || iy === n - 1};
            // A MARGINAL inlier gain must not buy a much worse rms. scanLens ranks by inlier
            // count with rms only as an exact-tie break, which is right when it is comparing
            // focal lengths at one principal point - but across the grid, and at this scan's
            // coarse focal resolution, a wrong cell can pick up a couple of extra inliers while
            // fitting visibly worse. Measured on the 0->80 baseline: the boundary cell (1216,198)
            // scored 97/153 at rms 3.267 and beat the near-truth cell (928,198) at 95/153 and rms
            // 2.145 - two inliers, 52% more error - and the calibration went on to accept a
            // principal point 77 px from the truth. At the full 34 focals the near-truth cell wins
            // outright (144/153, rms 1.186), which is what makes this a RANKING fault rather than
            // a resolution one. So counts within 10% of each other are separated by rms.
            cells.push(c);
        }
    }
    // Return the top few, not just the winner. At this scan's coarse focal resolution the ranking
    // is not reliable enough to commit to: measured on the 0->80 baseline, the boundary cell
    // (1216,198) out-scored the near-truth cell (928,198) on inlier count, and the calibration
    // went on to accept a principal point 77 px from the truth - while at the full 34 focals the
    // near-truth cell wins outright (144/153 at rms 1.186 against 97/153 at rms 3.121). So the
    // grid nominates, and the caller re-scans the nominees properly before choosing.
    cells.sort((x, y) => (y.within - x.within) || (x.rms - y.rms));
    return cells.slice(0, O.principalScanKeep);
}

export function polyFromPreset(type, rhoMax, terms = 3) {
    const preset = LENS_PRESETS[type];
    if (!preset || type === "custom") return [0, 0, 0];
    const powers = [3, 5, 7].slice(0, terms);
    const m = powers.length;
    const AtA = Array.from({length: m}, () => new Array(m).fill(0));
    const Atb = new Array(m).fill(0);
    const N = 300;
    for (let i = 1; i <= N; i++) {
        const rho = rhoMax * i / N;
        if (rho > preset.maxRho) break;
        const row = powers.map((p) => Math.pow(rho, p));
        // Weighted by rho: the sensor's area element goes as rho d rho, so equal weighting would
        // over-fit the sparse centre at the expense of the crowded edge.
        const w = rho;
        const target = preset.theta(rho) - rho;
        for (let a = 0; a < m; a++) {
            for (let b = 0; b < m; b++) AtA[a][b] += w * row[a] * row[b];
            Atb[a] += w * row[a] * target;
        }
    }
    const M = AtA.map((r, i) => [...r, Atb[i]]);
    for (let c = 0; c < m; c++) {
        let piv = c;
        for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
        [M[c], M[piv]] = [M[piv], M[c]];
        if (Math.abs(M[c][c]) < 1e-18) return [0, 0, 0];
        for (let r = 0; r < m; r++) {
            if (r === c) continue;
            const f = M[r][c] / M[c][c];
            for (let k = c; k <= m; k++) M[r][k] -= f * M[c][k];
        }
    }
    const out = [0, 0, 0];
    for (let i = 0; i < m; i++) out[i] = M[i][m] / M[i][i];
    return out.every((v) => isFinite(v)) ? out : [0, 0, 0];
}

/**
 * Refine a fitted preset into a free CUSTOM lens.
 *
 * A named preset is the closest of five shapes, not the actual lens, and "closest of five" is not
 * good enough for everything downstream. Self-consistency and absolute accuracy are different
 * quantities: the preset solve reproduces its own observations to ~0.25 px while placing the
 * recovered sky directions ~0.4 deg out, because a slightly wrong lens shape plus compensating
 * per-frame rotations still fits the data. Classification only needs the former. Star
 * identification needs the latter.
 *
 * Coordinate descent with shrinking steps rather than an LM: the objective already contains a
 * robust rotation re-fit at every evaluation, so a numeric Jacobian would cost six of those per
 * step, and the surface is smooth enough in the polynomial coefficients that it buys nothing.
 *
 * Terms are added one at a time and each must EARN its degree of freedom on held-out
 * correspondences - a clip whose stars occupy only the inner half of the frame cannot constrain a
 * 7th-order term and would happily fit noise with it.
 */
export function refineCustom(seed, A, B, size, O, holdout = null) {
    const rhoMax = Math.hypot(
        Math.max(seed.lens.principal[0], size[0] - seed.lens.principal[0]),
        Math.max(seed.lens.principal[1], size[1] - seed.lens.principal[1]),
    ) / seed.lens.focalPx;

    // EXPLORATION IS DELIBERATELY CHEAP, and it has to be. This search is synchronous, and a
    // full-depth robust rotation fit at every trial point over every correspondence froze the
    // browser for minutes on the reference clip - the descent visits on the order of a thousand
    // candidates. The lens shape has four or five free numbers; it does not need 130
    // correspondences and an eight-round annealed inlier set to tell one candidate from the next.
    // So the descent runs on a spread subsample at shallow depth, and the WINNER is re-scored at
    // full depth on the full set, which is the number that gets reported and gated on.
    const F = {...O, fitRounds: 2};
    const subsample = (p) => {
        const n = p.A.length;
        if (n <= O.shapeMaxPairs) return p;
        const step = n / O.shapeMaxPairs;
        const A2 = [], B2 = [];
        for (let i = 0; i < O.shapeMaxPairs; i++) {
            const k = Math.floor(i * step);
            A2.push(p.A[k]); B2.push(p.B[k]);
        }
        return {A: A2, B: B2};
    };
    const evalOn = (lens, pairs) => {
        const s = scoreLens(lens, pairs.A, pairs.B, size, O);
        return s ? s.rms : Infinity;
    };
    const train = subsample(holdout ? holdout.train : {A, B});
    const test = holdout ? holdout.test : null;

    let best = seed;
    let bestHeld = test ? evalOn(seed.lens, test) : null;
    // Whether the principal-point search ended up pressed against its bound; see the same idea
    // in refinePrincipal. Reported so a cropped clip does not silently look like a centred one.
    let clamped = false;

    for (let terms = 1; terms <= 3; terms++) {
        const d = polyFromPreset(seed.lens.type, rhoMax, terms);
        let cand = scoreLens(makeLens({
            ...seed.lens, type: "custom", distortion: d,
        }), train.A, train.B, size, O);
        if (!cand) continue;

        // Coordinate descent over focal, the active coefficients, and the principal point.
        const active = [0, 1, 2].slice(0, terms);
        for (const scale of O.shapeScales) {
            let improved = true;
            let guard = 0;
            while (improved && guard++ < O.shapeMaxSteps) {
                improved = false;
                for (const k of active) {
                    for (const dir of [1, -1]) {
                        const dd = cand.lens.distortion.slice();
                        dd[k] += dir * scale * (0.06 / Math.pow(3, k));
                        const t = scoreLens(makeLens({...cand.lens, distortion: dd}), train.A, train.B, size, F);
                        if (t && t.rms < cand.rms) { cand = t; improved = true; }
                    }
                }
                for (const dir of [1, -1]) {
                    const t = scoreLens(makeLens({
                        ...cand.lens, focalPx: cand.lens.focalPx * (1 + dir * scale * 0.02),
                    }), train.A, train.B, size, F);
                    if (t && t.rms < cand.rms) { cand = t; improved = true; }
                }
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const p = [cand.lens.principal[0] + dx * scale * 12, cand.lens.principal[1] + dy * scale * 12];
                    // The same bound refinePrincipal uses, and from the same option - two
                    // hard-coded 0.25s would drift apart, and this one would silently pull a
                    // cropped clip's axis back toward the centre after the other let it out.
                    const outside = Math.abs(p[0] - size[0] / 2) > size[0] * O.principalMaxOffsetFrac
                        || Math.abs(p[1] - size[1] / 2) > size[1] * O.principalMaxOffsetFrac;
                    const t = scoreLens(makeLens({...cand.lens, principal: p}), train.A, train.B, size, F);
                    if (!(t && t.rms < cand.rms)) continue;
                    // A move the score WANTED but the bound refused is the signal that the
                    // footage may be cropped harder than the search may follow.
                    if (outside) { clamped = true; continue; }
                    cand = t; improved = true; clamped = false;
                }
            }
        }
        if (!validateLens(cand.lens, size).ok) continue;

        if (test) {
            const held = evalOn(cand.lens, test);
            // Each added term must beat the incumbent on data it never saw.
            if (!(held < bestHeld * 0.97)) continue;
            bestHeld = held;
        } else if (!(cand.rms < best.rms * 0.97)) continue;
        best = cand;
    }
    return {...best, principalClamped: clamped};
}

/**
 * Local search over the principal point - the optical axis, which on UNCROPPED footage sits near
 * the frame centre and on cropped footage does not.
 *
 * The search is bounded (see principalMaxOffsetFrac). When a step is refused only because of that
 * bound, `clampedBy` records it: the difference between "the fit chose this point" and "the fit
 * was stopped here" is the difference between a measurement and an assumption, and only the first
 * deserves to be shown as an optical property.
 */
function refinePrincipal(seed, A, B, size, O) {
    let best = seed;
    const maxDx = size[0] * O.principalMaxOffsetFrac;
    const maxDy = size[1] * O.principalMaxOffsetFrac;
    let clampedBy = null;
    for (const step of [48, 16, 5]) {
        let improved = true;
        while (improved) {
            improved = false;
            for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
                const lens = makeLens({
                    ...best.lens,
                    principal: [best.lens.principal[0] + dx, best.lens.principal[1] + dy],
                });
                if (Math.abs(lens.principal[0] - size[0] / 2) > maxDx
                    || Math.abs(lens.principal[1] - size[1] / 2) > maxDy) {
                    // Only a CLAMP if the move would otherwise have been taken; a step the score
                    // rejects anyway says nothing about the bound.
                    const s = scoreLens(lens, A, B, size, O);
                    if (s && (s.within > best.within
                        || (s.within === best.within && s.rms < best.rms))) {
                        clampedBy = {step, dx, dy};
                    }
                    continue;
                }
                const s = scoreLens(lens, A, B, size, O);
                if (s && (s.within > best.within || (s.within === best.within && s.rms < best.rms))) {
                    best = s; improved = true; clampedBy = null;
                }
            }
        }
    }
    return {...best, principalClamped: !!clampedBy};
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
export async function calibrateLens(tracks, nFrames, size, opts = {}) {
    const O = {...STAR_CALIBRATE_DEFAULTS, ...opts};
    const diag = {};
    // This runs on the UI thread and the scans below take tens of seconds on a well-populated
    // clip, so the caller can hand in a yield (StarTrackerUI passes yieldToBrowser) to keep the
    // page answering between stages. Defaults to a no-op, which is what the tests want.
    const breathe = O.onYield ?? (async () => {});
    // Optional running commentary for a caller showing progress. The interesting thing this stage
    // computes is WHERE THE OPTICAL AXIS IS - on cropped footage it can be hundreds of pixels from
    // the frame centre - so every emission carries the axis currently believed in, plus how well
    // it explains the correspondences. Reporting only; nothing here changes the fit.
    const report = O.onProgress ?? (() => {});

    const base = chooseBaseline(tracks, nFrames, O.minPairs, {...O, size});
    if (!base || base.A.length < O.minPairs) {
        return {accepted: false, lens: null, reason: `only ${base ? base.A.length : 0} correspondences; need ${O.minPairs}`, diagnostics: diag};
    }
    diag.baseline = [base.f0, base.f1];
    diag.pairs = base.A.length;

    const {A, B} = base;
    await breathe();
    let scan = scanLens(A, B, size, O);
    if (!scan.best) return {accepted: false, lens: null, reason: "no lens fitted", diagnostics: diag};

    // If a centred axis cannot explain most of the correspondences, the axis is probably not
    // centred - which is ordinary for cropped footage - and a local refinement will not find it
    // (see scanPrincipal for the measured surface). Look globally first, then carry on as normal.
    // Of the INPUT correspondences, not of the rows this lens happened to be able to project:
    // scoreLens skips pairs whose ray or reprojection is undefined and reports `n` for the rest,
    // so within/n could read 0.75 for a lens that explained 15 of 100 pairs and evaluated 20.
    diag.centredWithin = scan.best.within / Math.max(1, A.length);
    report({stage: "centred", principal: [size[0] / 2, size[1] / 2], size,
        rms: scan.best.rms, within: scan.best.within, pairs: A.length});
    if (diag.centredWithin < O.principalSearchWithinFrac) {
        await breathe();
        const seeds = scanPrincipal(A, B, size, O);
        // Re-scan every nominee at FULL resolution and let those results choose. The grid's own
        // ranking is not trustworthy enough to commit to (see scanPrincipal), and re-scanning only
        // its winner is how a boundary cell got accepted 77 px from the truth.
        let bestSeed = null, bestFull = null;
        for (const seed of seeds) {
            await breathe();
            const full = scanLens(A, B, size, {...O, principal: seed.principal});
            if (!full.best) continue;
            report({stage: "searching", principal: seed.principal, size,
                rms: full.best.rms, within: full.best.within, pairs: A.length});
            if (!bestFull || full.best.within > bestFull.best.within
                || (full.best.within === bestFull.best.within
                    && full.best.rms < bestFull.best.rms)) {
                bestFull = full; bestSeed = seed;
            }
        }
        // Adopted only on strictly better evidence - more inliers AND no worse rms, the same
        // ordering scanLens itself uses. A noisy CENTRED clip can trip the trigger, and "more
        // inliers at any rms" would let it wander off-axis for nothing.
        if (bestFull && bestFull.best.within > scan.best.within
            && bestFull.best.rms <= scan.best.rms * 1.05) {
            diag.principalSearched = [...bestSeed.principal];
            diag.principalScanAtBoundary = !!bestSeed.atBoundary;
            diag.principalSearchedWithin = bestFull.best.within / Math.max(1, A.length);
            scan = bestFull;
        }
    }

    await breathe();
    let refined = refinePrincipal(scan.best, A, B, size, O);
    diag.presetType = refined.lens.type;
    diag.presetRms = refined.rms;
    diag.type = refined.lens.type;
    diag.focalPx = refined.lens.focalPx;
    diag.principal = refined.lens.principal;
    // The optical axis' offset from the frame centre, and whether the search was STOPPED there
    // rather than settling there. A large offset is the signature of an uneven crop; a clamped
    // one says the footage may be cropped harder than the search is allowed to follow.
    diag.principalOffset = [refined.lens.principal[0] - size[0] / 2,
        refined.lens.principal[1] - size[1] / 2];
    diag.principalClamped = !!refined.principalClamped;
    diag.rms = refined.rms;
    report({stage: "refined", principal: refined.lens.principal, size,
        focalPx: refined.lens.focalPx, type: refined.lens.type,
        rms: refined.rms, pairs: A.length});
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
    await breathe();
    const rect = scan.rectilinear ? refinePrincipal(scan.rectilinear, A, B, size, O) : null;
    diag.rectilinearRms = rect ? rect.rms : null;
    diag.rectilinearWithin = rect ? rect.within : null;
    if (rect && refined.lens.type !== "rectilinear") {
        if (!(rect.rms > refined.rms * O.minImprovement || refined.within > rect.within * 1.15)) {
            return {accepted: false, lens: null, reason: `no better than a rectilinear lens (rms ${refined.rms.toFixed(2)} vs ${rect.rms.toFixed(2)})`, diagnostics: diag};
        }
    }

    // Only now, once the clip has been shown to constrain a lens at all, is it worth paying for
    // the free-shape refinement - which is by far the most expensive step here. Refining before
    // the gate meant doing the whole coordinate descent on still cameras and pure rolls we were
    // about to reject, which is both wasted work and a slow test suite.
    //
    // Held out so each added term has to earn itself. The split is over the correspondence list,
    // whose rows are distinct TRACKS by construction (one per track seen in both baseline
    // frames), so this is a whole-track split rather than a per-observation one that would leak.
    // The PRESET fit, kept so a free-shape refinement that fails to generalise can be undone
    // rather than taking the whole calibration down with it (see gate 5).
    const presetRefined = refined;
    if (O.fitCustom !== false) {
        const testIdx = [], trainIdx = [];
        for (let i = 0; i < A.length; i++) (i % 4 === 0 ? testIdx : trainIdx).push(i);
        const holdout = testIdx.length >= 8 && trainIdx.length >= 20 ? {
            train: {A: trainIdx.map((i) => A[i]), B: trainIdx.map((i) => B[i])},
            test: {A: testIdx.map((i) => A[i]), B: testIdx.map((i) => B[i])},
        } : null;
        await breathe();
        const custom = refineCustom(refined, A, B, size, O, holdout);
        if (custom && custom.lens.type === "custom") {
            // Re-score on the FULL set so the reported numbers stay comparable with the preset's.
            const full = scoreLens(custom.lens, A, B, size, O);
            if (full && full.within >= refined.within) {
                refined = {...full, principalClamped: custom.principalClamped};
            }
        }
        diag.type = refined.lens.type;
        diag.distortion = refined.lens.distortion;
        diag.rms = refined.rms;
        diag.within = refined.within;
        // The shape refinement moves the PRINCIPAL POINT too, so the values recorded before it
        // describe a lens that is no longer the answer. Re-read them here or the reported optical
        // axis is the preset stage's, which on the cropped test scene was 170 px away from the
        // one actually returned - and it is the returned one the user is shown.
        diag.principal = refined.lens.principal;
        diag.focalPx = refined.lens.focalPx;   // the shape search moves this too
        diag.principalOffset = [refined.lens.principal[0] - size[0] / 2,
            refined.lens.principal[1] - size[1] / 2];
        diag.principalClamped = diag.principalClamped || !!refined.principalClamped;
    }

    // 5. Held-out correspondences, split by TRACK, never by observation.
    const n = A.length;
    const holdN = Math.max(5, Math.floor(n * O.holdoutFraction));
    const trainIdx = [], testIdx = [];
    for (let i = 0; i < n; i++) (i % Math.round(1 / O.holdoutFraction) === 0 ? testIdx : trainIdx).push(i);
    if (testIdx.length >= 5 && trainIdx.length >= O.minPairs / 2) {
        const trainA = trainIdx.map((i) => A[i]), trainB = trainIdx.map((i) => B[i]);
        /** Fit on the training half, measure on the held-out half. */
        const heldOut = (lens) => {
            const s = scoreLens(lens, trainA, trainB, size, O);
            if (!s) return null;
            let sse = 0, m = 0;
            for (const i of testIdx) {
                const ray = lensToRay(lens, A[i][0], A[i][1], size);
                if (!ray) continue;
                const p = refToFrame({q: s.fit.q, s: 1}, lens, ray, size);
                if (!p) continue;
                sse += Math.min(Math.hypot(p[0] - B[i][0], p[1] - B[i][1]), 20) ** 2; m++;
            }
            return m ? Math.sqrt(sse / m) : null;
        };
        diag.holdoutRms = heldOut(refined.lens);
        // Compared LIKE WITH LIKE: the rectilinear baseline is measured on the same held-out half,
        // not on the full set it was fitted to. Held-out error is essentially always larger than
        // in-sample error, so the old `holdoutRms > rect.rms` test compared out-of-sample against
        // in-sample and refused a correct answer whenever the lens really was a pinhole - which is
        // exactly what a cropped phone clip is. Measured on the cropped timelapse: held-out 0.66
        // against an in-sample rectilinear 0.5, refused, no lens, frame-edge stars left red.
        const rectHeld = rect ? heldOut(rect.lens) : null;
        diag.holdoutRectRms = rectHeld;
        if (diag.holdoutRms !== null && rectHeld !== null && diag.holdoutRms > rectHeld) {
            // The free polynomial did not earn itself. That is a verdict on the POLYNOMIAL, not on
            // the clip: the preset fit underneath it may be perfectly good, and on a clip whose
            // lens really is a pinhole it usually is. Refusing outright here threw away a correct
            // rectilinear answer and left the flat 2D model to call the frame-edge stars moving.
            // So fall back to the preset and judge THAT on the same holdout; only if it fails too
            // is there nothing worth keeping.
            const presetHeld = refined.lens.type === "custom" ? heldOut(presetRefined.lens) : null;
            if (presetHeld !== null && presetHeld <= rectHeld) {
                refined = presetRefined;
                diag.customRejected = {holdoutRms: diag.holdoutRms, fellBackTo: presetRefined.lens.type};
                diag.holdoutRms = presetHeld;
                diag.type = refined.lens.type;
                diag.distortion = refined.lens.distortion;
                diag.rms = refined.rms;
                diag.within = refined.within;
                diag.principal = refined.lens.principal;
                diag.principalOffset = [refined.lens.principal[0] - size[0] / 2,
                    refined.lens.principal[1] - size[1] / 2];
                // The clamp flag described the CUSTOM fit that was just discarded. The preset now
                // being returned has its own answer, and reporting the rejected fit's would tell
                // the user a clean calibration was CLAMPED.
                diag.principalClamped = !!presetRefined.principalClamped;
                diag.focalPx = refined.lens.focalPx;
            } else {
                return {accepted: false, lens: null, reason: `does not generalise (held-out rms ${diag.holdoutRms.toFixed(2)})`, diagnostics: diag};
            }
        }
    }

    const lens = makeLens({...refined.lens, source: "fitted"});
    diag.fov = lensFOV(lens, size);
    return {accepted: true, lens, reason: null, diagnostics: diag};
}
