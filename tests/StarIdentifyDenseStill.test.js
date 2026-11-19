import fs from "fs";
import path from "path";
import {STAR_IDENTIFY_DEFAULTS, buildQuadIndex, certifySolve, parseStarCatalog, solveField}
    from "../src/starTrack/StarIdentify";

// Measured detections and mask from a 1536x2048 wide night photo. The original
// all-star search failed; a small bright subset must still explain the full image.
const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, "fixtures/denseStarsWideStill.json"), "utf8"));
const bytes = fs.readFileSync(path.join(__dirname, "../data/nightsky/sitrec_bsc_lite.bin"));
const catalog = parseStarCatalog(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
const wide = buildQuadIndex(catalog, STAR_IDENTIFY_DEFAULTS.tiers[3]);
const {width: W, height: H, stars, truth} = fixture;
const data = new Uint8Array(W * H);
let offset = 0;
fixture.maskRuns.forEach((length, i) => {
    data.fill(i % 2, offset, offset + length);
    offset += length;
});
const opts = {center: [W / 2, H / 2], width: Math.max(W, H),
    bounds: [-12, -12, W + 12, H + 12],
    visibilityMask: {width: W, height: H, bounds: [0, 0, W, H], data}};

describe("a dense wide still", () => {
    let attempt, cert;
    beforeAll(async () => {
        const bright = [...stars].sort((a, b) => a.mag - b.mag || a.index - b.index).slice(0, 50);
        attempt = await solveField(bright, catalog, [wide], opts);
        cert = certifySolve(attempt, stars, catalog, {...opts, refine: true});
    });

    test("bright stars seed a field that passes the unchanged full-set acceptance", () => {
        expect(offset).toBe(W * H);
        expect(stars).toHaveLength(1667);
        expect(attempt.ok).toBe(true);
        expect(cert.ok).toBe(true);
        expect(cert.nImage).toBe(stars.length);
        expect(cert.matches.length).toBeGreaterThan(1000);
        expect(cert.refinedSolve.ok).toBe(true);
        expect(Math.abs(cert.refinedSolve.centerRaDeg - truth.raDeg)).toBeLessThan(.5);
        expect(Math.abs(cert.refinedSolve.centerDecDeg - truth.decDeg)).toBeLessThan(.5);
    });

    test("full-field refinement preserves the recognizable stars and original indices", () => {
        const named = new Map(cert.matches.map(m => [m.image, m.hip]));
        for (const {image, hip} of truth.stars) expect(named.get(image)).toBe(hip);
        expect(cert.refinedSolve.rmsPx).toBeLessThan(4);
        for (const match of cert.refinedSolve.matches) {
            expect(match.image).toBeGreaterThanOrEqual(0);
            expect(match.image).toBeLessThan(stars.length);
        }
    });
});
