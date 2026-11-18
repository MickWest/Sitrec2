import {canUseSharedStarLabels, shouldAnalyzeImportedStarImage} from "../src/starTrack/StarChartPolicy";
import {DEEP_SKY_OBJECTS, PLEIADES, deepSkyCategory, groupPleiades} from "../src/DeepSkyObjects";
import {ridgelineContours} from "../src/rendering/RidgelineContours";

test("fresh Star Tracker imports run automatically, but established work and restores do not", () => {
    const fresh = {template: "Star Tracker", primary: true};
    expect(shouldAnalyzeImportedStarImage(fresh)).toBe(true);
    for (const flag of ["established", "restoring", "hasWork"]) {
        expect(shouldAnalyzeImportedStarImage({...fresh, [flag]: true})).toBe(false);
    }
    expect(shouldAnalyzeImportedStarImage({...fresh, primary: false})).toBe(false);
    expect(shouldAnalyzeImportedStarImage({...fresh, automatic: false})).toBe(false);
    expect(shouldAnalyzeImportedStarImage({...fresh, template: "Satellite"})).toBe(false);
});

test("only a well registered, fully synced fit hands labels to the shared sky renderer", () => {
    const result = {videoW: 1536, identify: {solved: {ok: true, rmsPx: 3.34}}};
    expect(canUseSharedStarLabels(result, "Star Track", "Star Track")).toBe(true);
    expect(canUseSharedStarLabels(result, "Manual", "Star Track")).toBe(false);
    expect(canUseSharedStarLabels(result, "Star Track", "User FOV")).toBe(false);
    for (const badFit of [{rmsPx: 30}, {mirrored: true}, {ok: false}]) {
        expect(canUseSharedStarLabels({...result, identify: {solved: {...result.identify.solved, ...badFit}}},
            "Star Track", "Star Track")).toBe(false);
    }
    expect(canUseSharedStarLabels({...result, identify: {...result.identify, partial: true}}, "Star Track", "Star Track")).toBe(false);
});

test("deep-sky catalog includes the example's clusters and galaxies with distinct categories", () => {
    expect(deepSkyCategory(PLEIADES)).toBe("Clusters");
    expect(deepSkyCategory(DEEP_SKY_OBJECTS.find(o => o.name === "M34"))).toBe("Clusters");
    for (const id of ["NGC 891", "NGC 1023"]) {
        expect(deepSkyCategory(DEEP_SKY_OBJECTS.find(o => o.id === id))).toBe("Galaxies");
    }
    expect(deepSkyCategory(DEEP_SKY_OBJECTS.find(o => o.name === "M42"))).toBe("Nebulae");
    expect(groupPleiades(50)).toBe(true);
    expect(groupPleiades(250)).toBe(false);
    expect(groupPleiades(50, false)).toBe(false);
});

test("ridgeline traces only the sky/terrain boundary, including antialiased coverage", () => {
    const pixels = new Uint8Array(3 * 3 * 4);
    for (let x = 0; x < 3; x++) {
        pixels[x * 4] = 255;
        pixels[(3 + x) * 4] = 128;
    }
    const segments = ridgelineContours(pixels, 3, 3);
    expect(segments).toHaveLength(2);
    for (const segment of segments) for (const point of segment) expect(point[1]).toBeCloseTo(1.504, 2);
    pixels.fill(255);
    expect(ridgelineContours(pixels, 3, 3)).toEqual([]);
});
