// Star IDENTIFICATION on a long panning clip, against real measured data - the regression
// suite for the density-blind acceptance failure.
//
// The fixture is two live captures of the same video (Giddierone, 1150x642, superzoom on the
// Vega/Cygnus region), differing ONLY in the analysed In/Out window:
//
//   short: ?custom=99999999/Giddierone ST test 1235-1413/20260804_225610.js   (179 frames)
//   long:  ?custom=99999999/Giddierone ST 1235 to 31s (671 Frames) BAD RESULT/20260804_230023.js
//
// Both share reference frame 1235, so their charts are in the same coordinates. The short
// segment identified correctly (Vega, 29/35 matched, rms 1.6 px). The long segment identified
// A DIFFERENT SKY: RA 160.5 Dec -40.5, a far-southern field below the horizon from the camera
// site, claimed as a 96-degree lens at 44/123 matched.
//
// What happened, measured through the solve diagnostics: the long pan mosaics 1220x1160 px of
// reference frame and admits 123 image stars, most of them real but fainter than the
// projection pools (25 observations is 14% of the short clip but 3.7% of the long one). The
// CORRECT tier-1 hypothesis refined 36 -> 43 matches on a 142-star projection and was
// rejected: 43 < 0.35 * 123 = 43.05, short by five hundredths of a match. The solve then fell
// through to the wide phone-lens tier, where a bogus 96-degree hypothesis projected 3,495
// catalog stars into the bounds - dense enough that coincidence alone matches ~30 of 123
// image stars within the 6.1 px tolerance - and its 44 chance matches cleared the same gate
// the truth had just failed. The right answer lost 43-to-44 against noise.
//
// The fix is the chance gate (see chanceMarginMin/chanceSigmas in the defaults): a match
// count is only evidence in the amount it exceeds what coincidence would produce against the
// hypothesis' own projection density. The CONTROL RUN below re-creates the old arithmetic and
// machine-checks the impostor, so this file fails loudly if the failure mode is ever
// reintroduced.

import fs from "fs";
import path from "path";
import {
    STAR_IDENTIFY_DEFAULTS, parseStarCatalog, buildQuadIndex, solveField,
} from "../src/starTrack/StarIdentify";

const segments = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "fixtures/giddieronePanSegments.json"), "utf8"));
const catalog = parseStarCatalog((() => {
    const b = fs.readFileSync(path.resolve(__dirname, "..", "data/nightsky/sitrec_bsc_lite.bin"));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
})());

const HIP_VEGA = 91262;

// One index per tier, shared across tests - the build is seconds each and pure.
const indexes = STAR_IDENTIFY_DEFAULTS.tiers.map((t) => buildQuadIndex(catalog, t));

/** identifyStars' bounds rule: the union of the video rectangle and the map's own bbox. */
function uiOpts(seg) {
    let bx0 = 0, by0 = 0, bx1 = seg.videoW, by1 = seg.videoH;
    for (const s of seg.stars) {
        bx0 = Math.min(bx0, s.x); bx1 = Math.max(bx1, s.x);
        by0 = Math.min(by0, s.y); by1 = Math.max(by1, s.y);
    }
    return {
        center: [(bx0 + bx1) / 2, (by0 + by1) / 2],
        width: Math.max(bx1 - bx0, by1 - by0),
        bounds: [bx0 - 12, by0 - 12, bx1 + 12, by1 + 12],
    };
}

/** identifyStars' tier loop: try each tier in order, first verified solve wins. */
async function solveLikeUI(seg, extraOpts = {}) {
    let solved = null;
    for (let tier = 0; tier < indexes.length; tier++) {
        solved = await solveField(seg.stars, catalog, [indexes[tier]],
            {...uiOpts(seg), ...extraOpts});
        if (solved.ok) return {solved, tier};
    }
    return {solved, tier: -1};
}

describe("identifying the Giddierone pan segments", () => {
    test("the fixture is the measured data we think it is", () => {
        expect(segments.short.stars).toHaveLength(35);
        expect(segments.long.stars).toHaveLength(123);
        expect(segments.short.videoW).toBe(1150);
        expect(segments.long.videoH).toBe(642);
        // The long pan carries the map far beyond the frame-0 rectangle - that mosaic extent
        // is the premise of the whole failure mode, so pin it.
        const ys = segments.long.stars.map((s) => s.y);
        expect(Math.max(...ys)).toBeGreaterThan(1100);
    });

    test("CONTROL: the old density-blind arithmetic accepts the southern-sky impostor", async () => {
        // The shipped-with-2.110.0 gates, re-created exactly: fraction floor 0.35 and the
        // chance gate disabled (a zero margin accepts any count). This is the machine-checked
        // record of the failure, not a behaviour anyone wants back.
        const {solved} = await solveLikeUI(segments.long,
            {strongMatchFraction: 0.35, chanceMarginMin: 0, chanceSigmas: 0});
        expect(solved.ok).toBe(true);
        // Wrong hemisphere, absurd field - "confident" purely on chance matches against a
        // 3,495-star projection.
        expect(solved.centerDecDeg).toBeLessThan(0);
        expect(solved.fovDeg).toBeGreaterThan(60);
    });

    test("the long segment now identifies the true Cygnus/Lyra field, on the narrow tier", async () => {
        const {solved, tier} = await solveLikeUI(segments.long);
        expect(solved.ok).toBe(true);
        // Never the wide phone-lens tier: the correct solve must win before the fall-through.
        expect(tier).toBe(1);
        // Measured at the time of writing: RA 288.6, Dec +41.5, fov 15.6 deg, 77.9 px/deg,
        // 42/123 matched at rms 1.89 px. Bars leave room for catalogue and tuning drift.
        expect(Math.abs(solved.centerRaDeg - 288.6)).toBeLessThan(4);
        expect(Math.abs(solved.centerDecDeg - 41.5)).toBeLessThan(3);
        expect(solved.fovDeg).toBeGreaterThan(12);
        expect(solved.fovDeg).toBeLessThan(20);
        expect(solved.matches.length).toBeGreaterThanOrEqual(35);
        expect(solved.rmsPx).toBeLessThan(3);
    });

    test("the short segment still identifies Vega's field exactly as before", async () => {
        const {solved, tier} = await solveLikeUI(segments.short);
        expect(solved.ok).toBe(true);
        expect(tier).toBe(1);
        expect(Math.abs(solved.centerRaDeg - 283.0)).toBeLessThan(4);
        expect(Math.abs(solved.centerDecDeg - 42.2)).toBeLessThan(3);
        expect(solved.matches.length).toBeGreaterThanOrEqual(25);
        expect(solved.matches.some((m) => m.hip === HIP_VEGA)).toBe(true);
        expect(solved.rmsPx).toBeLessThan(2.5);
    });

    test("the two solves agree where their charts share a reference frame", async () => {
        // Both charts are in frame-1235 pixels, so pointing the two calibrations at the same
        // pixel must give nearly the same sky. Measured: 1.42 deg apart at the frame centre -
        // real, and it is the long mosaic's internal similarity-stitching drift, which only an
        // identify on the spherical map will remove. The bar is set at 2.5 deg: loose enough
        // for that residual, and five percent of the ~120 deg any hemisphere-level
        // misidentification would show.
        const a = (await solveLikeUI(segments.short)).solved;
        const b = (await solveLikeUI(segments.long)).solved;
        const pa = a.refToSky(575, 321);
        const pb = b.refToSky(575, 321);
        const D2R = Math.PI / 180;
        const v = (p) => [
            Math.cos(p.decDeg * D2R) * Math.cos(p.raDeg * D2R),
            Math.cos(p.decDeg * D2R) * Math.sin(p.raDeg * D2R),
            Math.sin(p.decDeg * D2R),
        ];
        const va = v(pa), vb = v(pb);
        const sep = Math.acos(Math.max(-1, Math.min(1,
            va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]))) / D2R;
        expect(sep).toBeLessThan(2.5);
    });
});
