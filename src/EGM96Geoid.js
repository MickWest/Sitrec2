// EGM96 geoid undulation lookup, backed by a compact binary grid asset that is
// fetched on demand (data/egm96/egm96-15.bin) rather than embedded in the JS bundle.
//
// Previously this wrapped the `egm96-universal` npm package, which embedded the
// 721x1440 Int16 grid as a 2.77MB base64 STRING — ~1.87MB gzipped, over HALF of
// the whole production JS bundle, parsed on the main thread at startup. We now ship
// the grid as gzip(planar(rowDelta(grid))) (~849KB, built by scripts/extractEGM96Geoid.js)
// and decode it lazily here. The grid is only fetched once a sitch actually needs
// elevation (terrain / tracks / geotagged imports) — never on the bare sitch browser —
// and the asset has a stable name, so returning users get it from cache across deploys
// instead of re-downloading it inside every contenthashed bundle.
//
// callers MUST `await ensureGeoidLoaded()` on any async path that precedes synchronous
// geoid use. The universal gate is at the top of SituationSetupFromData (every node is
// built after it); EXIF image import awaits it too. If a synchronous accessor is somehow
// reached before the grid loads, it returns 0 (no correction) and warns once, rather
// than throwing — a wrong-by-a-few-tens-of-metres transient is preferable to a crash in
// a tool whose asserts freeze the page.

import {SITREC_APP} from "./configUtils";

const NUM_ROWS = 721;
const NUM_COLS = 1440;
const NUM_VALUES = NUM_ROWS * NUM_COLS;
const INTERVAL = (15 / 60) * (Math.PI / 180); // 15 arc-minutes, in radians

let grid = null;            // Int16Array of undulation in centimetres, row-major
let loadPromise = null;     // cached in-flight / settled load
let warnedNotLoaded = false;

async function gunzip(arrayBuffer) {
    // Native gzip decoder (Chrome 80+, Safari 16.4+, Firefox 113+ — all browsers
    // Sitrec already requires for WebGL2 / WebCodecs).
    const stream = new Response(arrayBuffer).body.pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeGrid(planar) {
    // Inverse of scripts/extractEGM96Geoid.js: un-planar + un-row-delta.
    const out = new Int16Array(NUM_VALUES);
    for (let r = 0; r < NUM_ROWS; r++) {
        let acc = 0;
        const base = r * NUM_COLS;
        for (let c = 0; c < NUM_COLS; c++) {
            const i = base + c;
            const delta = planar[i] | (planar[NUM_VALUES + i] << 8);
            acc = (acc + delta) & 0xffff;
            out[i] = (acc << 16) >> 16; // wrap to signed int16
        }
    }
    return out;
}

// Fetch + decode the geoid grid. Idempotent and safe to call concurrently.
export function ensureGeoidLoaded() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
        const url = SITREC_APP + "data/egm96/egm96-15.bin";
        const response = await fetch(url);
        if (!response.ok) {
            loadPromise = null; // allow a later retry
            throw new Error(`EGM96 geoid fetch failed: ${response.status} ${url}`);
        }
        const planar = await gunzip(await response.arrayBuffer());
        if (planar.length !== NUM_VALUES * 2) {
            loadPromise = null;
            throw new Error(`EGM96 geoid grid is ${planar.length} bytes, expected ${NUM_VALUES * 2}`);
        }
        grid = decodeGrid(planar);
        return grid;
    })();
    return loadPromise;
}

export function isGeoidLoaded() {
    return grid !== null;
}

const getValue = (row, col) => grid[row * NUM_COLS + col] / 100;

const normalizeRadians = (rads, center = 0) =>
    rads - (2 * Math.PI) * Math.floor((rads + Math.PI - center) / (2 * Math.PI));

// Mean sea level (geoid undulation N) in metres relative to the WGS84 ellipsoid.
// Bilinear interpolation over the EGM96 grid — identical algorithm to egm96-universal.
function meanSeaLevel(latitude, longitude) {
    if (grid === null) {
        if (!warnedNotLoaded) {
            console.warn("EGM96Geoid: meanSeaLevel() called before ensureGeoidLoaded() resolved; returning 0. " +
                "This indicates a missing await on a geoid-using path.");
            warnedNotLoaded = true;
        }
        return 0;
    }

    const lat = normalizeRadians(degToRad(latitude));
    const lon = normalizeRadians(degToRad(longitude));

    let topRow = Math.floor(((Math.PI / 2) - lat) / INTERVAL);
    topRow = topRow === NUM_ROWS - 1 ? topRow - 1 : topRow;
    const bottomRow = topRow + 1;

    const leftCol = Math.floor(normalizeRadians(lon, Math.PI) / INTERVAL);
    const rightCol = (leftCol + 1) % NUM_COLS;

    const topLeft = getValue(topRow, leftCol);
    const bottomLeft = getValue(bottomRow, leftCol);
    const bottomRight = getValue(bottomRow, rightCol);
    const topRight = getValue(topRow, rightCol);

    const lonLeft = normalizeRadians(leftCol * INTERVAL);
    const latTop = (Math.PI / 2) - (topRow * INTERVAL);

    const leftProp = (lon - lonLeft) / INTERVAL;
    const topProp = (latTop - lat) / INTERVAL;

    const top = topLeft + (topRight - topLeft) * leftProp;
    const bottom = bottomLeft + (bottomRight - bottomLeft) * leftProp;
    return top + (bottom - top) * topProp;
}

function degToRad(d) {
    return d * (Math.PI / 180);
}

// ---- Public API (unchanged from the egm96-universal-backed version) ----

// Compute geoid undulation (N) at the 4 corners of a map tile.
// mapProjection provides getNorthLatitude(y, z) and getLeftLongitude(x, z).
// Returns {nw, ne, sw, se} in meters (add to MSL elevation to get ellipsoid height).
export function geoidCorrectionForTile(mapProjection, z, x, y) {
    const latN = mapProjection.getNorthLatitude(y, z);
    const latS = mapProjection.getNorthLatitude(y + 1, z);
    const lonW = mapProjection.getLeftLongitude(x, z);
    const lonE = mapProjection.getLeftLongitude(x + 1, z);

    return {
        nw: meanSeaLevel(latN, lonW),
        ne: meanSeaLevel(latN, lonE),
        sw: meanSeaLevel(latS, lonW),
        se: meanSeaLevel(latS, lonE),
    };
}

// Bilinear interpolation of geoid offset within a tile.
// xFrac and yFrac are in [0,1], where (0,0) is the NW corner.
export function interpolateGeoidOffset(corners, xFrac, yFrac) {
    const top = corners.nw + (corners.ne - corners.nw) * xFrac;
    const bot = corners.sw + (corners.se - corners.sw) * xFrac;
    return top + (bot - top) * yFrac;
}

// Single-point geoid undulation lookup.
// Returns N in meters: h_ellipsoid = h_MSL + N.
// Clamps latitude to avoid out-of-bounds access in the EGM96 grid data.
export function meanSeaLevelOffset(lat, lon) {
    lat = Math.max(-90, Math.min(90, lat));
    return meanSeaLevel(lat, lon);
}
