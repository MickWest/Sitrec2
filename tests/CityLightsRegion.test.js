import {CITY_LIGHTS_MAX_TILES, cityLightsRegion, cityLightsRegionContains, cityLightsTiles} from "../src/citylights/CityLightsRegion";

test("near and aerial coverage retain classified roads and a bounded request count", () => {
    const near = cityLightsRegion(34.02, -118.49, 300);
    const aerial = cityLightsRegion(34.06, -118.26, 6096);
    expect(near.meters / near.size).toBeLessThan(2.1);
    expect(aerial.meters / aerial.size).toBeLessThan(8.1);
    expect(cityLightsTiles(near)).toHaveLength(32);
    expect(cityLightsTiles(aerial)).toHaveLength(320);
    for (const region of [near, aerial]) {
        expect(cityLightsTiles(region).filter(t => t.theme === "transportation").every(t => t.z === 14)).toBe(true);
        expect(cityLightsRegionContains(region, region.lat, region.lon)).toBe(true);
    }
});

test("polar and very high cameras cannot cause unbounded tile requests", () => {
    for (const latitude of [-90, -85, 0, 85, 90]) {
        const region = cityLightsRegion(latitude, 0, 4e7);
        const tiles = cityLightsTiles(region);
        expect(tiles.length).toBeLessThanOrEqual(CITY_LIGHTS_MAX_TILES);
        expect(tiles.every(t => Number.isInteger(t.x) && Number.isInteger(t.y) && t.y >= 0 && t.y < 2 ** t.z)).toBe(true);
    }
});

test("coverage crosses the date line without invalid tile coordinates", () => {
    const region = cityLightsRegion(34, 179.999, 1000);
    expect(cityLightsRegionContains(region, 34, -179.999)).toBe(true);
    expect(cityLightsRegionContains(region, 34, 0)).toBe(false);
    const tiles = cityLightsTiles(region);
    expect(tiles.every(t => t.x >= 0 && t.x < 2 ** t.z)).toBe(true);
    expect(tiles.some(t => t.x === 0)).toBe(true);
});
