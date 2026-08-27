// The flat fill the standard OpenStreetMap Carto style paints water with
// (#AAD3DF). The Water Reflection effect finds water by matching the map
// texture against the active source's declared `waterColor`, so a source
// without one gets no reflection at all. One copy, used by the config.js
// backfill and by the SITREC_CUSTOM_MAP_* env parser.
export const OSM_WATER_COLOR = [170, 211, 223];

// Does this URL template point at the standard OSM tile servers?
//
// Used to give an env-defined OSM source the water fill automatically, so
// SITREC_CUSTOM_MAP_OSM_URL="https://c.tile.openstreetmap.org/{z}/{x}/{y}.png"
// works with no extra configuration. Deliberately narrow: only these hosts are
// known to serve the Carto style whose water is #AAD3DF. A self-hosted renderer
// or a different style must declare _WATER_COLOR itself.
//
// The template is decoded first because config.js and shared.env both support
// routing tiles through `cachemaps.php?url=<encoded>`, where the real host is
// percent-encoded inside the query string.
export function isStandardOSMTileURL(url) {
    if (typeof url !== "string") return false;
    let text = url;
    try {
        text = decodeURIComponent(url);
    } catch {
        // A malformed escape sequence is not fatal — test the raw string.
    }
    // An explicit port is allowed after the host: a URL written
    // "https://tile.openstreetmap.org:443/{z}/{x}/{y}.png" is still OSM, and
    // failing to match it silently leaves the source with no water colour.
    return /\/\/[a-z0-9-]*\.?(?:tile\.openstreetmap\.org|tile\.osm\.org)(?::\d+)?\//i.test(text);
}

function clampChannel(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}

// Parse a water fill colour written as an env var into [r, g, b], 0-255.
//
// Accepts "170,211,223" and "#AAD3DF" (the hash is optional) because the docs
// quote the colour both ways. Returns undefined for anything unparseable, so a
// typo leaves the source with no water colour — the effect then stays off,
// rather than detecting water of some arbitrary wrong colour.
export function parseWaterColor(value) {
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    if (text === "") return undefined;

    const hex = text.match(/^#?([0-9a-f]{6})$/i);
    if (hex) {
        const packed = parseInt(hex[1], 16);
        return [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255];
    }

    const channels = text.split(",").map((part) => Number(part.trim()));
    if (channels.length !== 3 || !channels.every(Number.isFinite)) return undefined;
    return channels.map(clampChannel);
}

// The water colour to give a SITREC_CUSTOM_MAP_<NAME>_* source.
//
// An explicit _WATER_COLOR wins. Otherwise the standard OSM tile servers are
// recognised by URL and get OSM's fill, so the documented OSM example works with
// no extra configuration. A value that will not parse falls through to the URL
// test rather than being trusted — on an OSM URL that recovers the right colour,
// and anywhere else it leaves the source with none, which turns the effect off
// rather than detecting water of some arbitrary wrong colour.
export function waterColorForCustomSource(explicitValue, urlTemplate) {
    return parseWaterColor(explicitValue)
        ?? (isStandardOSMTileURL(urlTemplate) ? [...OSM_WATER_COLOR] : undefined);
}

// Find the source that "Combine Terrain with OSM" should stamp water from.
//
// The config.js key `osm` is preferred, so installs that have one behave exactly
// as before. Without it — a deployment that defines OSM only through
// SITREC_CUSTOM_MAP_OSM_*, or one running with
// SITREC_ENABLE_DEFAULT_MAP_SOURCES=false, which strips the config sources —
// any other source that declares a water colour will do. `mapping: 4326`
// (GoogleCRS84Quad) sources are skipped in that search because their tiles do
// not line up with the Web Mercator grid the combine assumes.
export function findOSMWaterSource(sources) {
    if (!sources) return undefined;

    // An `osm` key IS the OSM source, so its answer is final either way. A
    // config.js that deliberately clears waterColor (`waterColor: null`, which
    // the backfill leaves alone — it only fills `undefined`) must still turn the
    // combine off, exactly as it did before this fallback existed, rather than
    // quietly stamping from osmHighlight instead.
    if (sources.osm) return sources.osm.waterColor ? sources.osm : undefined;

    // No `osm` key at all: an env-only deployment, or one running with
    // SITREC_ENABLE_DEFAULT_MAP_SOURCES=false / in serverless, both of which
    // filter the config.js sources out.
    //
    // Two kinds of source are excluded even though they carry a water colour:
    //
    //   processColors  — the source exists to RECOLOR its tiles (osmHighlight
    //                    dims everything to 10% and paints roads yellow), so
    //                    what it serves is not the flat fill its waterColor
    //                    claims.
    //   excludeFromMenu — an internal variant the user cannot even select.
    //                    Stamping from something invisible in the UI makes the
    //                    combine impossible to reason about.
    //
    // Both describe `osmHighlight`, which is backfilled with OSM's colour
    // alongside `osm` and sits BEFORE any CustomMap_* source in insertion
    // order. Commenting out `osm` in config.js therefore silently handed the
    // combine to the road-highlight source instead of the user's own OSM.
    const candidates = Object.values(sources).filter((sourceDef) =>
        sourceDef?.waterColor
        && sourceDef.mapping !== 4326
        && !sourceDef.processColors
        && !sourceDef.excludeFromMenu);

    // Prefer one that is recognisably OSM, rather than whichever happens to be
    // first: insertion order is an accident of config.js, and a source that
    // merely declares a colour is not necessarily one whose water lines up with
    // OSM's. mapURL is pure string building, so calling it here is cheap.
    for (const sourceDef of candidates) {
        let url;
        try {
            url = sourceDef.mapURL?.(0, 0, 0);
        } catch {
            url = undefined;   // a source whose mapURL needs a layer argument
        }
        if (typeof url === "string" && isStandardOSMTileURL(url)) return sourceDef;
    }

    return candidates[0];
}

export function filterSourcesForServerless(sources) {
    return Object.fromEntries(
        Object.entries(sources).filter(([, sourceDef]) => sourceDef?.allowInServerless === true)
    );
}

// Keep only the user's env-defined custom sources (key matches customKeyRegex, e.g.
// /^CustomMap_/) plus the built-in sources explicitly flagged `offlineSafe: true`
// (Local, Debug, etc. — sources that don't need third-party internet access).
// Used when SITREC_ENABLE_DEFAULT_*_SOURCES=false to strip the internet providers
// (ESRI, MapBox, MapTiler, EOX, AWS, …) for restricted / offline deployments.
export function filterToCustomAndOfflineSources(sources, customKeyRegex) {
    return Object.fromEntries(
        Object.entries(sources).filter(
            ([key, sourceDef]) => customKeyRegex.test(key) || sourceDef?.offlineSafe === true
        )
    );
}

// A SITREC_ENABLE_DEFAULT_*_SOURCES flag defaults to enabled; only an explicit
// "false" (string, as env values arrive) or boolean false disables it.
export function defaultSourcesEnabled(value) {
    return !(value === false || String(value ?? "").trim().toLowerCase() === "false");
}

export function pickAvailableSourceType({
    sources,
    requestedType,
    defaultType,
    fallbackType = "Local",
}) {
    if (requestedType && sources[requestedType]) {
        return requestedType;
    }

    if (defaultType && sources[defaultType]) {
        return defaultType;
    }

    if (fallbackType && sources[fallbackType]) {
        return fallbackType;
    }

    return Object.keys(sources)[0];
}
