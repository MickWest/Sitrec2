// Lens calibration from identified stars (StarLensFromCatalog.js), against a synthetic truth.

import {makeLens, rayToPixel} from "../src/CameraLens";
import {qFromAxisAngle, qRotate, qConj, qAngle, qBetween} from "../src/starTrack/StarSphere";
import {fitLensToCatalog, rankLensTypes, matchCatalogToPixels} from "../src/starTrack/StarLensFromCatalog";
import {mulberry32} from "../src/starTrack/StarSyntheticSphere";

const SIZE = [1280, 720];
// The measured situation: the render's hand-matched lens (seed) is ~9% short in scale at 30
// degrees off-axis and a few pixels off-centre from the truth.
const TRUTH = makeLens({type: "equisolidFisheye", focalPx: 423, principal: [630, 370], refSize: SIZE});
const SEED = makeLens({type: "equisolidFisheye", focalPx: 388, principal: [636, 364], refSize: SIZE});
const Q_TRUE = qFromAxisAngle([0.2, 0.3, 0.93], 1.1);

function scene(seed = 1, n = 200, noise = 0.3, outliers = 0) {
    const rand = mulberry32(seed);
    const gauss = () => {
        const u = Math.max(1e-12, rand()), v = rand();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const corr = [];
    let guard = 0;
    while (corr.length < n && guard++ < n * 50) {
        // Random sky direction; keep those that image inside the frame.
        const z = 2 * rand() - 1, a = 2 * Math.PI * rand(), s = Math.sqrt(1 - z * z);
        const dir = [s * Math.cos(a), s * Math.sin(a), z];
        const px = rayToPixel(TRUTH, qRotate(Q_TRUE, dir), SIZE);
        if (!px || px[0] < 0 || px[1] < 0 || px[0] >= SIZE[0] || px[1] >= SIZE[1]) continue;
        corr.push({px: [px[0] + gauss() * noise, px[1] + gauss() * noise], dir});
    }
    for (let i = 0; i < outliers; i++) {
        corr[i].px = [corr[i].px[0] + 40 + 30 * rand(), corr[i].px[1] - 25];
    }
    return corr;
}

describe("fitLensToCatalog", () => {
    test("recovers focal, principal and orientation from a mismatched seed", () => {
        const corr = scene(1, 200, 0.3);
        const fit = fitLensToCatalog(corr, SIZE, {type: "equisolidFisheye", seedLens: SEED});
        expect(fit).not.toBeNull();
        expect(fit.lens.focalPx).toBeCloseTo(423, 0);
        expect(fit.lens.principal[0]).toBeCloseTo(630, 0);
        expect(fit.lens.principal[1]).toBeCloseTo(370, 0);
        expect(qAngle(qBetween(fit.q, Q_TRUE)) * 180 / Math.PI).toBeLessThan(0.02);
        expect(fit.rms).toBeLessThan(0.5);
        expect(fit.inliers).toBeGreaterThan(190);
    });

    test("gross outliers are trimmed, not fitted", () => {
        const corr = scene(2, 200, 0.3, 20);
        const fit = fitLensToCatalog(corr, SIZE, {type: "equisolidFisheye", seedLens: SEED});
        expect(fit.lens.focalPx).toBeCloseTo(423, 0);
        expect(fit.inliers).toBeGreaterThanOrEqual(175);
        expect(fit.inliers).toBeLessThanOrEqual(180);
        expect(fit.rms).toBeLessThan(0.5);
    });

    test("the true projection ranks first", () => {
        const corr = scene(3, 250, 0.3);
        const fit = fitLensToCatalog(corr, SIZE, {type: "equisolidFisheye", seedLens: SEED});
        const ranked = rankLensTypes(corr, SIZE, fit.lens, fit.q);
        expect(ranked[0].type).toBe("equisolidFisheye");
        // And the wrong ones are not close: at 200-400 px radii the curves differ by many px.
        expect(ranked[1].rms).toBeGreaterThan(ranked[0].rms * 4);
    });

    test("refuses too few correspondences", () => {
        expect(fitLensToCatalog(scene(4, 8), SIZE, {type: "equisolidFisheye", seedLens: SEED})).toBeNull();
    });
});

describe("matchCatalogToPixels", () => {
    test("matches each detected pixel to the nearest projected catalog star, one-to-one", () => {
        const rand = mulberry32(9);
        const n = 60;
        const ra = new Float64Array(n), dec = new Float64Array(n), mag = new Float32Array(n), hip = new Int32Array(n);
        const pixels = [];
        for (let i = 0; i < n; i++) {
            ra[i] = 2 * Math.PI * rand(); dec[i] = Math.asin(2 * rand() - 1); mag[i] = 3 + 3 * rand(); hip[i] = i + 1;
            const dir = [Math.cos(dec[i]) * Math.cos(ra[i]), Math.cos(dec[i]) * Math.sin(ra[i]), Math.sin(dec[i])];
            const px = rayToPixel(TRUTH, qRotate(Q_TRUE, dir), SIZE);
            if (px && px[0] > 0 && px[1] > 0 && px[0] < SIZE[0] && px[1] < SIZE[1]) {
                pixels.push({px: [px[0] + 0.5, px[1] - 0.4], index: i});
            }
        }
        const catalog = {n, ra, dec, mag, hip};
        const m = matchCatalogToPixels(TRUTH, Q_TRUE, catalog, pixels, SIZE, 7, 3);
        expect(m.length).toBe(pixels.length);
        for (const x of m) expect(x.cat).toBe(x.index);
        // A magnitude cut removes candidates.
        const faint = matchCatalogToPixels(TRUTH, Q_TRUE, catalog, pixels, SIZE, 4, 3);
        expect(faint.length).toBeLessThan(m.length);
    });
});
