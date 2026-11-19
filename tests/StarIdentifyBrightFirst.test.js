import fs from "fs";
import path from "path";
import {STAR_IDENTIFY_DEFAULTS, buildQuadIndex, parseStarCatalog, rankPointSources,
    solveField, solveFieldBrightFirst} from "../src/starTrack/StarIdentify";

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/denseStarsWideUnmasked.json"), "utf8"));
const stars = fixture.stars.map((values, index) => ({index,
    ...Object.fromEntries(fixture.columns.map((key, i) => [key, values[i]]))}));
const bytes = fs.readFileSync(path.join(__dirname, "../data/nightsky/sitrec_bsc_lite.bin"));
const catalog = parseStarCatalog(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
const indexes = STAR_IDENTIFY_DEFAULTS.tiers.map(tier => buildQuadIndex(catalog, tier));
const {width: W, height: H, truth} = fixture;
const opts = {center: [W / 2, H / 2], width: Math.max(W, H), bounds: [-12, -12, W + 12, H + 12]};
const ranked = rankPointSources(stars, opts.width);

test("the unmasked dense photo stops after a 25-star search and an independent bounded check", async () => {
    const searches = [];
    const solved = await solveFieldBrightFirst(stars, catalog, async tier => indexes[tier], [0, 1, 2, 3],
        {...opts, onSearch: s => searches.push(s)});
    expect(stars).toHaveLength(3206);
    expect(solved.ok).toBe(true);
    expect(solved.brightStarCap).toBe(25);
    expect(solved.nImage).toBe(100);
    expect(solved.validationStars).toBe(75);
    expect(solved.validationMatches).toBeGreaterThanOrEqual(38);
    expect(solved.matches.length).toBeGreaterThan(60);
    expect(solved.rmsPx).toBeLessThan(5);
    expect(Math.abs(solved.centerRaDeg - truth.raDeg)).toBeLessThan(0.3);
    expect(Math.abs(solved.centerDecDeg - truth.decDeg)).toBeLessThan(0.3);
    expect(searches.every(s => s.cap === 25)).toBe(true);
    // Matches must address the original detection list, not positions in the small sample.
    const allowed = new Set(ranked.slice(0, 100));
    expect(solved.matches.every(m => allowed.has(m.image))).toBe(true);
    expect(new Set(solved.matches.map(m => m.image)).size).toBe(solved.matches.length);
    const matched = new Map(solved.matches.map(m => [m.image, m.hip]));
    expect(matched.get(26)).toBe(36850); // Castor
    expect(matched.get(24)).toBe(28360); // Menkalinan
});

test("a valid bright seed cannot approve a field contradicted by its unused stars", async () => {
    const contradicted = stars.map(s => ({...s}));
    // Leave the seed intact, but move the subsequent validation candidates away
    // from the true field. Keep them inside the same image and use the same gates.
    for (const i of ranked.slice(25, 175)) {
        contradicted[i].x = (contradicted[i].x + 317) % W;
        contradicted[i].y = (contradicted[i].y + 499) % H;
    }
    expect(rankPointSources(contradicted, opts.width).slice(0, 25)).toEqual(ranked.slice(0, 25));
    const seed = await solveField(ranked.slice(0, 25).map(i => contradicted[i]), catalog, [indexes[3]], opts);
    expect(seed.ok).toBe(true);
    expect(seed.matches.length).toBeGreaterThan(20);
    const solved = await solveFieldBrightFirst(contradicted, catalog, async tier => indexes[tier], [0, 1, 2, 3], opts);
    expect(solved.ok).toBe(false);
}, 30000);

test("cancelling the bright search prevents a later index or result from being used", async () => {
    let cancelled = false;
    const getIndex = jest.fn(async tier => { cancelled = true; return indexes[tier]; });
    const solved = await solveFieldBrightFirst(stars, catalog, getIndex, [0, 1, 2, 3],
        {...opts, shouldStop: () => cancelled});
    expect(solved.ok).toBe(false);
    expect(solved.reason).toBe("cancelled");
    expect(getIndex).toHaveBeenCalledTimes(1);
});
