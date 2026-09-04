// Per-tile water mask rasterised from vector water polygons.
//
// This replaces asking "is this pixel the shade of blue that OSM paints water
// in". That question has no good answer. The color is destroyed by JPEG
// compression and by mipmapping; labels, roads and boundaries are drawn ON TOP
// of water and punch holes through it; OSM fills streams with the same color as
// the sea, so a mountainside reads as water; and on satellite imagery there is
// no flat fill to match at all, which is why the effect currently needs the OSM
// composite that overwrites the imagery it is painted onto.
//
// Here we fetch the water POLYGONS and rasterise them into a coverage mask. The
// mask is the real shoreline, antialiased by the canvas, and — because the data
// is vector — it stays sharp at whatever magnification a terrain tile needs.
//
// Deliberately separate from the map texture. Packing the mask into the imagery
// (as the color composite does) couples classification to color processing,
// ground painting, source alpha and mipmap generation, and destroys the imagery
// in every view. A mask of its own survives all of that.

import {CanvasTexture, ClampToEdgeWrapping, LinearFilter} from "three";
import {getEnv} from "./envUtils";
import {maskTransform, osmTileForTile} from "./OSMWaterTileMapping";

// OpenMapTiles serves its vector schema to z14. Past that we magnify the
// ancestor's polygons instead of resampling pixels — the entire reason for
// using vector data, since the shoreline stays sharp at any terrain zoom.
//
// Only the DEFAULT. A different server may stop somewhere else, and asking it
// for a zoom it does not serve returns 404s, which this module reads as "no
// polygons here" — so the water would vanish rather than fail, which is the
// worst way for it to be wrong. SITREC_VECTOR_WATER_MAX_ZOOM sets it.
const DEFAULT_VECTOR_MAX_ZOOM = 14;

// Mask resolution in pixels. 256 is enough because the edge is antialiased
// COVERAGE, not a hard threshold: the shader reads a smooth 0..1 ramp about a
// texel wide, and a coastline has little left to say below that scale. Raising
// it costs memory on every terrain tile in the cache.
const MASK_SIZE = 256;

// The OpenMapTiles "water" layer carries a class per feature: ocean, lake,
// river, pond, dock, swimming_pool. Only swimming pools are dropped — at z14 a
// suburb has enough of them to speckle the mask, and nothing reflects in one.
//
// Rivers are deliberately KEPT. They are genuinely water and genuinely
// reflective; the reason the color classifier had to fear them was that it
// could not tell a river from the sea, so a mountain stream got reflected in a
// plane fitted to sea level. That is a question about ALTITUDE, not about
// classification, and CNodeWaterReflection's per-tile altitude gate already
// answers it.
const EXCLUDED_WATER_CLASSES = new Set(["swimming_pool"]);

// Layers in the OpenMapTiles schema that hold water polygons. "water" is the
// polygon layer; "waterway" is line geometry (river centrelines) and is NOT
// used — a line has no area to fill.
const WATER_LAYERS = ["water"];

// The MVT decoder, imported on first use rather than at module load.
//
// Two reasons. It is dead weight in the bundle for every session that never
// turns the mask on. And both packages are ESM-only, which Jest cannot parse
// from node_modules — a static import here reaches QuadTreeTileMaterial, then
// QuadTreeMap, and takes the terrain test suites down with it.
let mvtDecoder = null;

function loadMvtDecoder() {
    // pbf 5 dropped its default export for named PbfReader/PbfWriter, and
    // @mapbox/vector-tile 3 wants a PbfReader. `import Pbf from "pbf"` builds
    // clean and fails at runtime, so the names are worth being explicit about.
    mvtDecoder ??= Promise.all([
        import("@mapbox/vector-tile"),
        import("pbf"),
    ]).then(([vectorTile, pbf]) => ({
        VectorTile: vectorTile.VectorTile,
        PbfReader: pbf.PbfReader,
    }));
    return mvtDecoder;
}

/**
 * The vector water source: a {z}/{x}/{y} URL template and the deepest zoom it
 * serves, or null when none is configured.
 *
 * MapTiler is the default rather than the requirement. What this module
 * actually depends on is the OPENMAPTILES SCHEMA — a `water` layer of polygons
 * in Mapbox Vector Tile format — and several servers speak it: a self-hosted
 * OpenMapTiles, or Protomaps behind a small range-request shim. MapTiler was
 * chosen because its key was already one of the keys Sitrec asks for, which is
 * a fact about this install rather than about the problem.
 *
 * Every RASTER source has been operator-definable for a long time
 * (SITREC_CUSTOM_MAP_<NAME>_*), and SITREC_ENABLE_DEFAULT_MAP_SOURCES=false
 * exists so a deployment with no route to the internet can offer only its own.
 * The vector water source escaped all of that and reached for api.maptiler.com
 * regardless — so on such a deployment the basemaps fell back correctly and the
 * water quietly stopped working, with nothing to say why. Hence the override.
 *
 * When SITREC_VECTOR_WATER_URL is set, MAPTILER_KEY is not consulted at all: an
 * isolated deployment should not need an account with anyone.
 */
export function vectorWaterSource() {
    const template = getEnv("SITREC_VECTOR_WATER_URL", process.env.SITREC_VECTOR_WATER_URL);
    if (template) {
        const maxZoom = parseInt(getEnv("SITREC_VECTOR_WATER_MAX_ZOOM",
            process.env.SITREC_VECTOR_WATER_MAX_ZOOM), 10);
        // Defined-but-empty is a deliberate "credit nothing", so the test is on
        // the TYPE, not on truthiness — an operator serving their own
        // non-OSM-derived water must be able to switch the line off, and
        // `SITREC_VECTOR_WATER_ATTRIBUTION=` is the obvious way to try.
        const attribution = getEnv("SITREC_VECTOR_WATER_ATTRIBUTION",
            process.env.SITREC_VECTOR_WATER_ATTRIBUTION);
        const termsURL = getEnv("SITREC_VECTOR_WATER_TERMS_URL",
            process.env.SITREC_VECTOR_WATER_TERMS_URL);
        return {
            template,
            maxZoom: Number.isFinite(maxZoom) ? maxZoom : DEFAULT_VECTOR_MAX_ZOOM,
            // Defaulted rather than blank: this module decodes the OpenMapTiles
            // schema, and a server speaking that schema is overwhelmingly
            // serving OpenStreetMap data, which is ODbL and must be credited.
            // Crediting by default and letting an operator correct it is the
            // right way round; the reverse silently drops a licence obligation
            // for anyone who never reads this far.
            attribution: typeof attribution === "string"
                ? attribution : "Water: © OpenStreetMap contributors",
            termsURL: typeof termsURL === "string"
                ? termsURL : "https://www.openstreetmap.org/copyright",
        };
    }

    const key = getEnv("MAPTILER_KEY", process.env.MAPTILER_KEY);
    if (!key || key === "EXAMPLEKEY") return null;
    return {
        template: `https://api.maptiler.com/tiles/v3/{z}/{x}/{y}.pbf?key=${key}`,
        maxZoom: DEFAULT_VECTOR_MAX_ZOOM,
        // MapTiler's terms want both them and OSM named; their own copyright
        // page covers both, so it is the one link to give.
        attribution: "Water: © MapTiler © OpenStreetMap contributors",
        termsURL: "https://www.maptiler.com/copyright/",
    };
}

/**
 * Fill a {z}/{x}/{y} template.
 *
 * Exported for the tests; the two callers below are the real ones.
 */
export function fillTileTemplate(template, z, x, y) {
    return template
        .replace(/\{z\}/g, z)
        .replace(/\{x\}/g, x)
        .replace(/\{y\}/g, y);
}

/**
 * Is a vector water source configured?
 *
 * Exported so the UI can hide the option rather than offer a switch wired to
 * nothing, and so the material path can skip the work entirely.
 */
export function waterMaskAvailable() {
    return vectorWaterSource() !== null;
}

/**
 * The vector tile covering a terrain tile, and which part of it to use.
 *
 * Shares osmTileForTile's ancestor arithmetic — the problem is identical (a
 * source that stops at some zoom, a terrain tile that goes deeper) and getting
 * it wrong puts water in the wrong place silently, so there should be exactly
 * one copy of it.
 *
 * @param {number} z terrain tile zoom
 * @param {number} x terrain tile x
 * @param {number} y terrain tile y
 * @returns {?{url: string, srcRect: ?{fx: number, fy: number, fw: number, fh: number}}}
 */
export function waterMaskSourceForTile(z, x, y) {
    const source = vectorWaterSource();
    if (source === null) return null;

    const tile = osmTileForTile(z, x, y, source.maxZoom);
    const url = fillTileTemplate(source.template, tile.z, tile.x, tile.y);
    return {url, srcRect: tile.srcRect};
}

// Decoded vector tiles, keyed by URL, both in flight and settled.
//
// Past the vector source's max zoom MANY terrain tiles crop from the SAME
// ancestor — 4 of them one level down, 16 two levels down — so without dedup a
// camera sweep issues the same request dozens of times. We hold the decoded
// RINGS rather than the rasterised mask because each terrain tile needs its own
// crop of them.
//
// Deliberately not given any tile's abortSignal: the result is shared, so one
// tile being pruned must not cancel the fetch out from under its siblings.
const vectorTileLoads = new Map();

// Settled decodes, so a tile arriving after its siblings does not refetch.
// Bounded because a long session over a wide area would otherwise hold every
// vector tile ever touched; water polygons are small, but not free.
const MAX_CACHED_VECTOR_TILES = 512;
const vectorTileCache = new Map();

function rememberVectorTile(url, decoded) {
    if (vectorTileCache.size >= MAX_CACHED_VECTOR_TILES) {
        // Map preserves insertion order, so the first key is the oldest.
        const oldest = vectorTileCache.keys().next().value;
        vectorTileCache.delete(oldest);
    }
    vectorTileCache.set(url, decoded);
}

/**
 * The vector tile URL for a tile of the vector source's own grid.
 *
 * waterMaskSourceForTile() above answers "which vector tile covers this TERRAIN
 * tile", which is the only question the terrain has. WaterMaskGeo.js asks the
 * other one — it picks its own zoom and its own block of tiles to cover a
 * region of ground — so it needs the URL without the ancestor arithmetic.
 *
 * @returns {?string} null when no vector source is configured.
 */
export function vectorWaterTileUrl(z, x, y) {
    const source = vectorWaterSource();
    if (source === null) return null;
    return fillTileTemplate(source.template, z, x, y);
}

/**
 * The deepest zoom the vector source serves.
 *
 * A function, not a constant: the source is read from the environment, which a
 * Docker deployment can change at runtime through window.__SITREC_ENV__.
 */
export function vectorWaterMaxZoom() {
    return vectorWaterSource()?.maxZoom ?? DEFAULT_VECTOR_MAX_ZOOM;
}

/**
 * Fetch and decode one vector tile down to the water rings we care about.
 *
 * Exported for WaterMaskGeo.js, which rasterises the same decoded rings into a
 * region-wide mask rather than a per-terrain-tile one — sharing this function
 * means it also shares the in-flight dedup and the decoded-tile cache, so a
 * terrain tile and the geographic mask asking for the same tile fetch once.
 *
 * @returns {Promise<{extent: number, polygons: Array<Array<Array<{x: number, y: number}>>>}>}
 */
export function loadVectorWaterTile(url) {
    const cached = vectorTileCache.get(url);
    if (cached) return Promise.resolve(cached);

    const existing = vectorTileLoads.get(url);
    if (existing) return existing;

    const promise = fetch(url)
        .then((response) => {
            // A 404 is normal and not an error: the vector source has no tile
            // over open ocean far from any coast, which correctly means "no
            // polygons here". An empty result is the right answer, and it gets
            // cached like any other so we do not ask again.
            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`water mask tile ${response.status}`);
            return response.arrayBuffer();
        })
        .then((buffer) => (buffer === null
            ? {extent: 4096, polygons: []}
            : decodeWaterPolygons(buffer)))
        .then((decoded) => {
            rememberVectorTile(url, decoded);
            return decoded;
        })
        .finally(() => {
            vectorTileLoads.delete(url);
        });

    vectorTileLoads.set(url, promise);
    return promise;
}

/**
 * Pull the water polygons out of a raw MVT buffer.
 *
 * loadGeometry() hands back rings in tile coordinates with the winding the MVT
 * spec requires — exterior rings one way, holes the other — which is exactly
 * what a nonzero-winding canvas fill needs to punch islands out of a lake. So
 * the rings of one feature are kept together and filled as a single path.
 */
function decodeWaterPolygons(buffer) {
    return loadMvtDecoder().then(({VectorTile, PbfReader}) => {
        const tile = new VectorTile(new PbfReader(buffer));
        const polygons = [];
        let extent = 4096;

        for (const layerName of WATER_LAYERS) {
            const layer = tile.layers[layerName];
            if (!layer) continue;
            extent = layer.extent || extent;

            for (let i = 0; i < layer.length; i++) {
                const feature = layer.feature(i);
                if (feature.type !== 3) continue;      // 3 = polygon; ignore stray points/lines
                if (EXCLUDED_WATER_CLASSES.has(feature.properties?.class)) continue;
                polygons.push(feature.loadGeometry());
            }
        }

        return {extent, polygons};
    });
}

/**
 * Rasterise decoded water polygons into a mask texture for one terrain tile.
 *
 * White where water, black where land, with the canvas's own antialiasing across
 * the shoreline — so the mask carries fractional coverage at the edge instead of
 * a stair-stepped binary boundary.
 */
function rasteriseMask(decoded, srcRect) {
    const canvas = document.createElement("canvas");
    canvas.width = MASK_SIZE;
    canvas.height = MASK_SIZE;
    const ctx = canvas.getContext("2d", {willReadFrequently: false});

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);

    if (decoded.polygons.length > 0) {
        ctx.save();
        ctx.setTransform(...maskTransform(srcRect, MASK_SIZE, decoded.extent));
        ctx.fillStyle = "#ffffff";

        // One path per FEATURE, not one path for the whole tile: nonzero winding
        // resolves holes within a feature, but two separate lakes that happen to
        // overlap in the buffer zone outside the tile edge would cancel each
        // other out if they shared a path.
        for (const rings of decoded.polygons) {
            const path = new Path2D();
            for (const ring of rings) {
                if (ring.length < 3) continue;
                path.moveTo(ring[0].x, ring[0].y);
                for (let i = 1; i < ring.length; i++) path.lineTo(ring[i].x, ring[i].y);
                path.closePath();
            }
            ctx.fill(path, "nonzero");
        }
        ctx.restore();
    }

    const texture = new CanvasTexture(canvas);
    // Linear filtering is what makes the mask better than the color test: the
    // shoreline is a smooth ramp rather than a texel staircase. No mipmaps —
    // a mip chain of a coverage mask is fractional coverage, which is right for
    // the far field, but three would build it from the unpremultiplied canvas
    // and the gain does not pay for the memory on every cached tile yet.
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
}

/**
 * The whole job for one terrain tile: locate, fetch, decode, rasterise.
 *
 * Resolves to null on any failure. A missing mask is not fatal — the caller
 * falls back to the color test, exactly as before this existed.
 */
export function loadWaterMaskTexture(z, x, y) {
    const source = waterMaskSourceForTile(z, x, y);
    if (!source) return Promise.resolve(null);

    return loadVectorWaterTile(source.url)
        .then((decoded) => rasteriseMask(decoded, source.srcRect))
        .catch(() => null);
}
