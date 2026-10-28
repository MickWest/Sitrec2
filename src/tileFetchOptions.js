// Fetch options for a map tile request, shared by the tile loader
// (QuadTextureMaterial.js) and the recovery probe (ServiceAvailability.js), so a
// probe gets the answer a real tile request would.

export const OSM_TILE_URL_PATTERN = /^https:\/\/(?:[abc]\.)?tile\.openstreetmap\.org\//i;

// Mapbox token restrictions and OSM's tile policy require the app origin.
// Limit this exception to those hosts; never send the page path/query.
// Keep default browser caching and identification (no custom headers).
export function tileFetchOptions(url) {
    if (/^https:\/\/api\.mapbox\.com\//.test(url) || OSM_TILE_URL_PATTERN.test(url)) {
        return {referrerPolicy: 'strict-origin'};
    }
    return {};
}
