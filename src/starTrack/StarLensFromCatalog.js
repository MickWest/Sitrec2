// Lens calibration from IDENTIFIED stars.
//
// StarCalibrate.js fits a lens from the way stars move between two frames, which needs the
// camera to turn. A mounted allsky camera never turns - but once its stars are NAMED, every one
// of them is a correspondence between a pixel and a catalog direction, and that determines the
// lens far more strongly than any pair of frames could: hundreds of stars out to the rim, each
// with an exact truth.
//
// The model is the Star Track lens (CameraLens.js) plus one orientation: a catalog direction
// d (unit, equatorial frame) images at rayToPixel(lens, q * d). The lens TYPE is fixed by the
// caller - the user chose a projection for the render and it is honoured - and what is fitted
// is the focal length, the principal point and the three orientation parameters. The other
// presets are scored on the same correspondences so a mismatch can be reported, not silently
// adopted.
//
// Pure: plain arrays in, plain objects out. No DOM, no THREE, no Sitrec globals.

import {LENS_PRESETS, lensToRay, makeLens, rayToPixel} from "../CameraLens";
import {fitRotationWahba, qExp, qMul, qNormalize, qRotate} from "./StarSphere";

export const STAR_LENS_CATALOG_DEFAULTS = {
    gatePx: 8,          // residual trim gate for the first round
    finalGatePx: 4,     // and for the last
    rounds: 3,          // trim rounds
    steps: 12,          // Gauss-Newton steps per round
    minPairs: 12,
};

/**
 * Fit orientation + focal + principal for one lens type.
 *
 * @param {Array<{px:number[], dir:number[]}>} corr pixel <-> unit catalog direction
 * @param {number[]} size frame size the pixels are in
 * @param {object} opts {type, seedLens, seedQ, ...STAR_LENS_CATALOG_DEFAULTS}
 * @returns {{lens, q, rms, inliers, n, residuals}|null}
 */
export function fitLensToCatalog(corr, size, opts = {}) {
    const O = {...STAR_LENS_CATALOG_DEFAULTS, ...opts};
    const type = O.type ?? O.seedLens?.type ?? "equisolidFisheye";
    if (!LENS_PRESETS[type] || type === "custom") return null;
    if (corr.length < O.minPairs) return null;
    const [w, h] = size;
    const seed = O.seedLens ?? makeLens({type, focalPx: w / 2, refSize: size});

    // Orientation seed: Wahba between the catalog directions and the rays the seed lens gives
    // the pixels. Chord-optimal, so only a start; the pixel fit below does the work.
    let q0 = O.seedQ ?? null;
    if (!q0) {
        const A = [], B = [];
        for (const c of corr) {
            const r = lensToRay(seed, c.px[0], c.px[1], size);
            if (!r) continue;
            A.push(c.dir); B.push(r);
        }
        q0 = fitRotationWahba(A, B);
        if (!q0) return null;
    }

    // Parameters: rotation vector applied on the left of q0, focalPx, cx, cy.
    let p = [0, 0, 0, seed.focalPx, seed.principal?.[0] ?? w / 2, seed.principal?.[1] ?? h / 2];
    const lensOf = (pp) => makeLens({type, focalPx: pp[3], principal: [pp[4], pp[5]], refSize: size});
    const qOf = (pp) => qNormalize(qMul(qExp([pp[0], pp[1], pp[2]]), q0));
    const project = (pp, dir) => rayToPixel(lensOf(pp), qRotate(qOf(pp), dir), size);
    const residuals = (pp) => corr.map((c) => {
        const r = project(pp, c.dir);
        return r ? [c.px[0] - r[0], c.px[1] - r[1]] : null;
    });

    let mask = corr.map(() => true);
    let inliers = 0, rms = Infinity;
    for (let round = 0; round < O.rounds; round++) {
        const gate = round === O.rounds - 1 ? O.finalGatePx
            : O.gatePx + (O.finalGatePx - O.gatePx) * round / Math.max(1, O.rounds - 1);
        for (let step = 0; step < O.steps; step++) {
            const base = residuals(p);
            // Numeric Jacobian, one column per parameter. Step sizes scaled to each
            // parameter's units: radians for the rotation, pixels for the rest.
            const hs = [1e-6, 1e-6, 1e-6, 1e-3, 1e-3, 1e-3];
            const cols = hs.map((hk, k) => {
                const pp = p.slice(); pp[k] += hk;
                return residuals(pp);
            });
            const M = Array.from({length: 6}, () => new Array(6).fill(0));
            const g = new Array(6).fill(0);
            let used = 0;
            for (let i = 0; i < corr.length; i++) {
                if (!mask[i] || !base[i]) continue;
                const J = [];
                let ok = true;
                for (let k = 0; k < 6; k++) {
                    const c = cols[k][i];
                    if (!c) { ok = false; break; }
                    // residual = obs - model, so d(model)/dp = -(d residual / dp)
                    J.push([-(c[0] - base[i][0]) / hs[k], -(c[1] - base[i][1]) / hs[k]]);
                }
                if (!ok) continue;
                used++;
                for (let a = 0; a < 6; a++) {
                    for (let b = 0; b < 6; b++) M[a][b] += J[a][0] * J[b][0] + J[a][1] * J[b][1];
                    g[a] += J[a][0] * base[i][0] + J[a][1] * base[i][1];
                }
            }
            if (used < O.minPairs) return null;
            const d = solveN(M, g, 6);
            if (!d) break;
            const costOf = (pp) => {
                const r = residuals(pp);
                let sse = 0, n = 0;
                for (let i = 0; i < r.length; i++) {
                    if (!mask[i] || !r[i]) continue;
                    sse += r[i][0] ** 2 + r[i][1] ** 2; n++;
                }
                return n ? sse / n : Infinity;
            };
            const c0 = costOf(p);
            let scale = 1, accepted = false;
            for (let t = 0; t < 6; t++) {
                const pn = p.map((v, k) => v + scale * d[k]);
                if (pn[3] > 0 && costOf(pn) < c0) { p = pn; accepted = true; break; }
                scale *= 0.5;
            }
            if (!accepted) break;
            if (Math.hypot(d[0], d[1], d[2]) * scale < 1e-9 && Math.hypot(d[3], d[4], d[5]) * scale < 1e-4) break;
        }
        // Re-trim against the gate for the next round (and the final statistics).
        const r = residuals(p);
        let sse = 0; inliers = 0;
        mask = r.map((e) => {
            if (!e) return false;
            const m = Math.hypot(e[0], e[1]);
            if (m > gate) return false;
            sse += m * m; inliers++;
            return true;
        });
        rms = inliers ? Math.sqrt(sse / inliers) : Infinity;
    }
    if (inliers < O.minPairs) return null;
    return {lens: lensOf(p), q: qOf(p), rms, inliers, n: corr.length,
        residuals: residuals(p).map((e, i) => (e ? {i, dx: e[0], dy: e[1], inlier: mask[i]} : null))};
}

/**
 * Score every non-custom preset on the same correspondences, seeded from `fit`'s orientation,
 * so a report can say which projection the footage actually follows. Sorted best first.
 */
export function rankLensTypes(corr, size, seedLens, seedQ, opts = {}) {
    const out = [];
    for (const type of Object.keys(LENS_PRESETS)) {
        if (type === "custom") continue;
        const seed = makeLens({...seedLens, type});
        const f = fitLensToCatalog(corr, size, {...opts, type, seedLens: seed, seedQ});
        if (f) out.push({type, rms: f.rms, inliers: f.inliers, focalPx: f.lens.focalPx});
    }
    return out.sort((a, b) => a.rms - b.rms);
}

/**
 * Match catalog stars to detected pixels under a fitted model, so a fit seeded from the
 * identifier's matches (bright stars, central field) can be widened to every star the frame
 * holds, out to the rim where the lens curve is actually decided.
 *
 * @param {object} catalog from parseStarCatalog (ra/dec radians)
 * @param {Array<{px:number[], index:number}>} pixels detected star pixels, with a caller id
 * @returns {Array<{px, dir, cat, index, dPx}>} one-to-one nearest matches within tolPx
 */
export function matchCatalogToPixels(lens, q, catalog, pixels, size, magLimit, tolPx) {
    // Project the catalog once; only the stars that land in the frame are candidates.
    const cands = [];
    const [w, h] = size;
    for (let i = 0; i < catalog.n; i++) {
        if (catalog.mag[i] > magLimit) continue;
        const dec = catalog.dec[i], ra = catalog.ra[i];
        const dir = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
        const px = rayToPixel(lens, qRotate(q, dir), size);
        if (!px) continue;
        if (px[0] < -tolPx || px[1] < -tolPx || px[0] > w + tolPx || px[1] > h + tolPx) continue;
        cands.push({cat: i, dir, px});
    }
    // Greedy by distance, one catalog star per pixel and one pixel per catalog star.
    const pairs = [];
    for (let j = 0; j < pixels.length; j++) {
        const p = pixels[j].px;
        for (const c of cands) {
            const d = Math.hypot(c.px[0] - p[0], c.px[1] - p[1]);
            if (d <= tolPx) pairs.push({j, c, d});
        }
    }
    pairs.sort((a, b) => a.d - b.d);
    const usedPx = new Set(), usedCat = new Set();
    const out = [];
    for (const {j, c, d} of pairs) {
        if (usedPx.has(j) || usedCat.has(c.cat)) continue;
        usedPx.add(j); usedCat.add(c.cat);
        out.push({px: pixels[j].px, dir: c.dir, cat: c.cat, index: pixels[j].index, dPx: d});
    }
    return out;
}

function solveN(A, b, n) {
    const M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
        let piv = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
        if (Math.abs(M[piv][c]) < 1e-18) return null;
        [M[c], M[piv]] = [M[piv], M[c]];
        for (let r = 0; r < n; r++) {
            if (r === c) continue;
            const f = M[r][c] / M[c][c];
            for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
        }
    }
    return M.map((r, i) => r[n] / r[i]);
}
