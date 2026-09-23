// Bounded geographic coverage for the currently visible ground. Roads must
// use zoom 14: the source's coarser tiles omit the class of many side streets.
export const CITY_LIGHTS_RELEASE = "2026-08-19.0";
export const CITY_LIGHTS_MASK_SIZE = 4096;
export const CITY_LIGHTS_MAX_TILES = 320;
const WORLD_METRES = 40075016.686;

export function cityLightsRegion(lat, lon, altitude = 0) {
    lat = Math.max(-85, Math.min(85, Number.isFinite(lat) ? lat : 0));
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    const n = 2 ** 14;
    const tileMetres = WORLD_METRES * Math.cos(lat * Math.PI / 180) / n;
    const wanted = Math.max(8000, Math.min(32000, Math.max(0, altitude) * 6));
    // Powers of two avoid constant size changes during a flight. The tile cap
    // takes priority over physical span near the poles.
    const across = [4, 8, 16].find(count => count * tileMetres >= wanted) ?? 16;
    const cx = (lon + 180) / 360 * n;
    const cy = (.5 - Math.asinh(Math.tan(lat * Math.PI / 180)) / (2 * Math.PI)) * n;
    const x0 = Math.round((cx - across / 2) / 2) * 2;
    const y0 = Math.max(0, Math.min(n - across, Math.round((cy - across / 2) / 2) * 2));
    const buildingZoom = across > 4 ? 13 : 14;
    return {
        key: `${buildingZoom}/${x0}/${y0}/${across}`,
        lat, lon, x0, y0, across, buildingZoom,
        rect: [x0 / n, y0 / n, n / across, n / across],
        meters: tileMetres * across,
        size: CITY_LIGHTS_MASK_SIZE,
    };
}

export function cityLightsTiles(region) {
    const tasks = [];
    for (const theme of ["buildings", "transportation"]) {
        const z = theme === "buildings" ? region.buildingZoom : 14;
        const scale = 2 ** (14 - z), n = 2 ** z;
        for (let y = region.y0 / scale; y < (region.y0 + region.across) / scale; y++) {
            for (let x = region.x0 / scale; x < (region.x0 + region.across) / scale; x++) {
                tasks.push({theme, z, x: ((x % n) + n) % n, y, unwrappedX: x, scale});
            }
        }
    }
    if (tasks.length > CITY_LIGHTS_MAX_TILES) throw new Error("City lights coverage is too large");
    return tasks;
}

// Keep the current region until the target approaches its edge. This prevents
// a small camera movement at a tile boundary from repeatedly loading vectors.
export function cityLightsRegionContains(region, lat, lon) {
    const x = (lon + 180) / 360, y = .5 - Math.asinh(Math.tan(lat * Math.PI / 180)) / (2 * Math.PI);
    const u = ((x - region.rect[0]) % 1 + 1) % 1 * region.rect[2];
    const v = (y - region.rect[1]) * region.rect[3];
    return u > .2 && u < .8 && v > .2 && v < .8;
}
