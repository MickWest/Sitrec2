// Star identification on a real photo whose bright stars are CLIPPED.
//
// The fixture is the candidate-star list of a phone night photo of the Summer Triangle
// (4032x3024, a 24 mm equivalent lens, 442 detections), exactly as identifyStars hands it to the
// solver: position, instrumental magnitude, and the point-source measurements.
//
// The photo is a good one - 383 of the 442 detections are catalog stars - and the solver refused
// it. Every star brighter than about magnitude 4 peaks at the clip level, so a ranking by peak
// SNR orders those stars by how quiet the sky is around them: Vega and Altair came out below a
// magnitude 4.5 star. The quad anchors were then not the brightest stars, the only index that
// spans a field this wide holds nothing fainter than magnitude 4.0, and the true field was never
// proposed. After that failure Bright Triples named 19 stars, all wrongly, from blobs of lit
// ground. These tests hold both halves of the correction: rankPointSources ranks a clipped
// detection by its flux, and Bright Triples works on the best point sources only.

import fs from "fs";
import path from "path";
import {
    STAR_IDENTIFY_DEFAULTS, parseStarCatalog, buildQuadIndex, solveField, scalePriorFromFov,
    rankPointSources, raDecToVec,
} from "../src/starTrack/StarIdentify";
import {TRIPLE_DEFAULTS, identifyBrightTriples} from "../src/starTrack/StarTriples";

const D2R = Math.PI / 180;

const still = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "fixtures/clippedStarsPhoneStill.json"), "utf8"));
const catalog = parseStarCatalog((() => {
    const b = fs.readFileSync(path.resolve(__dirname, "..", "data/nightsky/sitrec_bsc_lite.bin"));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
})());

const {width: W, height: H, truth} = still;
const stars = still.stars.map((s, index) => ({...s, index}));
// The same list without the clip measurement: every detection is then ranked by peak SNR and
// held to one width bar, which is what the solver did before.
const withoutClip = stars.map(({saturated, ...rest}) => rest);

// The wide tier: the only index whose quads can span this field.
const wide = buildQuadIndex(catalog, STAR_IDENTIFY_DEFAULTS.tiers[3]);
const solveOpts = {
    center: [W / 2, H / 2],
    width: Math.max(W, H),
    bounds: [-12, -12, W + 12, H + 12],
    scalePrior: scalePriorFromFov(still.verticalFovDeg, W, H),
};

/** The detection at a known place in the photo. */
function starAt(x, y) {
    return stars.find((s) => Math.hypot(s.x - x, s.y - y) < 6).index;
}
const VEGA = starAt(2871, 1868), ALTAIR = starAt(1115, 2044), DENEB = starAt(2523, 683);

describe("a photo with clipped stars", () => {
    let solved;
    beforeAll(async () => {
        solved = await solveField(stars, catalog, [wide], solveOpts);
    });

    test("the three brightest stars are the first three anchors", () => {
        const anchors = rankPointSources(stars, Math.max(W, H))
            .slice(0, STAR_IDENTIFY_DEFAULTS.imageQuadStars);
        expect(anchors.slice(0, 3).sort((a, b) => a - b))
            .toEqual([VEGA, ALTAIR, DENEB].sort((a, b) => a - b));
        // By peak SNR alone none of the three is an anchor at all: each is wider than the bar
        // set by the faint detections, and Vega's peak SNR is below a magnitude 4.5 star's.
        const before = rankPointSources(withoutClip, Math.max(W, H))
            .slice(0, STAR_IDENTIFY_DEFAULTS.imageQuadStars);
        for (const bright of [VEGA, ALTAIR, DENEB]) expect(before).not.toContain(bright);
    });

    test("the field solves, and names Vega, Altair and Deneb", () => {
        expect(solved.ok).toBe(true);
        expect(Math.abs(solved.centerRaDeg / 15 - truth.centerRaHours)).toBeLessThan(0.05);
        expect(Math.abs(solved.centerDecDeg - truth.centerDecDeg)).toBeLessThan(0.5);
        expect(solved.matches.length).toBeGreaterThan(300);
        const hipOf = new Map(solved.matches.map((m) => [m.image, m.hip]));
        expect(hipOf.get(VEGA)).toBe(truth.vega);
        expect(hipOf.get(ALTAIR)).toBe(truth.altair);
        expect(hipOf.get(DENEB)).toBe(truth.deneb);
    });

    test("ranked by peak SNR alone, the same field is refused", async () => {
        // The failure this file exists for. Not a gate that refuses the true field - that pose
        // matches 387 stars against 105 needed - but a search that never proposes it.
        const refused = await solveField(withoutClip, catalog, [wide], solveOpts);
        expect(refused.ok).toBe(false);
    });

    test("Bright Triples names its stars right", () => {
        // The objects of Bright Triples: the stars to magnitude 3, here the half of the sky
        // around the field, as "above horizon only" would give.
        const centre = raDecToVec(truth.centerRaHours * 15 * D2R, truth.centerDecDeg * D2R);
        const objects = [];
        for (let i = 0; i < catalog.n; i++) {
            if (catalog.mag[i] > 3.0) continue;
            const v = raDecToVec(catalog.ra[i], catalog.dec[i]);
            if (v[0] * centre[0] + v[1] * centre[1] + v[2] * centre[2] < 0) continue;
            objects.push({label: `HIP ${catalog.hip[i]}`, hip: catalog.hip[i],
                raDeg: catalog.ra[i] / D2R, decDeg: catalog.dec[i] / D2R, mag: catalog.mag[i]});
        }
        const maxFovDeg = 2 * Math.atan(Math.tan(still.verticalFovDeg * D2R / 2) * Math.hypot(1, W / H)) / D2R;
        const res = identifyBrightTriples({stars, objects, width: W, height: H, maxFovDeg});
        expect(res.ok).toBe(true);
        expect(res.counts.candidateStars).toBe(TRIPLE_DEFAULTS.maxCandidateStars);
        expect(res.best.nMatched).toBeGreaterThanOrEqual(6);
        // Every name agrees with the full solve of the same photo.
        const hipOf = new Map(solved.matches.map((m) => [m.image, m.hip]));
        for (const m of res.best.matches) expect(m.object.hip).toBe(hipOf.get(m.star.index));
        const named = new Map(res.best.matches.map((m) => [m.star.index, m.object.hip]));
        expect(named.get(VEGA)).toBe(truth.vega);
        expect(named.get(ALTAIR)).toBe(truth.altair);
        expect(named.get(DENEB)).toBe(truth.deneb);
    });
});
