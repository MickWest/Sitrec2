// paidTileProviders.js — which tile sources bill per tile request.
//
// Flat Earth rendering has no horizon: the terrain quadtree subdivides out to
// the disc rim (see flatEarthWarpSphere in scenarios/FlatEarthScenario.js), so
// a per-tile-billed provider would be charged for the entire far band on every
// camera stop. While that mode is on, CNodeTerrainUI locks these providers out
// (setPaidProvidersLocked). Google Photorealistic 3D Tiles are deliberately NOT
// listed: Google bills per root-tileset session, not per tile
// (GooglePhotorealisticTilesAuth.js).

import {identifyServiceFromUrl} from "./TileUsageTracker";

export const PAID_TILE_SERVICES = new Set(["mapbox", "maptiler"]);

// The URL a source would request for tile 0/0/0 — the same probe the
// service-outage fallback in CNodeTerrainUI uses. null when the source builds
// no URL (wireframe, Debug, Local, Flat) or the probe throws (a WMS source
// whose projection helper is not bound yet).
export function sampleSourceUrl(sourceDef) {
    if (!sourceDef) return null;
    try {
        if (typeof sourceDef.mapURL === "function") {
            const url = sourceDef.mapURL.call(sourceDef, 0, 0, 0);
            return typeof url === "string" && url ? url : null;
        }
        const template = sourceDef.urlTemplate ?? sourceDef.url;
        return typeof template === "string" && template ? template : null;
    } catch {
        return null;
    }
}

export function isPaidTileSource(sourceDef) {
    const url = sampleSourceUrl(sourceDef);
    return !!url && PAID_TILE_SERVICES.has(identifyServiceFromUrl(url));
}

// First entry of preferenceOrder that exists in `sources` and is not paid;
// failing that, the first non-paid source in definition order; null if none.
export function pickFreeSourceType(sources, preferenceOrder = []) {
    if (!sources) return null;
    for (const key of preferenceOrder) {
        if (sources[key] && !isPaidTileSource(sources[key])) return key;
    }
    for (const key of Object.keys(sources)) {
        if (!isPaidTileSource(sources[key])) return key;
    }
    return null;
}
