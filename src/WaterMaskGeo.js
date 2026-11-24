// A water mask for a REGION OF GROUND, rather than for one terrain tile.
//
// WaterMaskTiles.js gives every terrain tile its own mask, indexed by that
// tile's UV. That works because a terrain tile is a rectangle of ground and its
// UV runs across it. A Google Photorealistic 3D tile is neither: it is an
// arbitrary lump of photogrammetric mesh whose UVs index into a texture atlas,
// so there is no UV to look a mask up by, and no tile-shaped piece of ground to
// build one for.
//
// So this module builds ONE mask over a square of ground, and the shader finds
// its place in it from the fragment's own latitude and longitude — see
// DayNightStandardMaterial. The mask is a square in Web Mercator, which is what
// lets the vector tiles be drawn into it with nothing but a scale and an offset
// per tile: mercator is the projection the tiles are already in.
//
// The polygons, the decoder, the in-flight dedup and the tile cache are all
// WaterMaskTiles's — this only picks a different set of tiles and a different
// canvas to draw them on.

import {CanvasTexture, ClampToEdgeWrapping, LinearFilter} from "three";
import {loadVectorWaterTile, vectorWaterMaxZoom, vectorWaterTileUrl} from "./WaterMaskTiles";
import {clampLatitude, mercatorX, mercatorY} from "./WaterMaskMath";
export {clampLatitude, mercatorX, mercatorY} from "./WaterMaskMath";

// Mask resolution. Over the 12 km default span this is 5.9 m per texel, which
// is about what the source polygons resolve anyway, and 16 MB of texture —
// there is exactly one of these, unlike the per-tile masks.
const MASK_SIZE = 2048;

// Circumference of the WGS84 equator, the ground length of one full turn of
// normalised mercator x. Ground metres per unit of mercator at latitude L is
// this times cos(L).
const MERCATOR_WORLD_M = 40075016.686;

// Aim for the region to span about this many vector tiles. Two means a 12 km
// mask costs four tile fetches rather than the forty-nine that asking for the
// source's deepest zoom would, and the polygons at that zoom still resolve a
// coastline to a few metres — far finer than the mask's own texels.
const TARGET_TILES_ACROSS = 2;

// Rebuild once the centre has moved this fraction of the span. The mask has to
// stay ahead of the water the user is looking at, but rebuilding is a fetch and
// a 2048-square rasterise, so not every frame.
const RECENTRE_FRACTION = 0.25;

// Backstop on the tile count, in case some future span/zoom combination gets
// past the clamp above. At the zoom this module picks, a region is two or three
// tiles across, so nine is the working number and sixteen is already slack.
const MAX_MASK_TILES = 16;

// How long to wait before trying again after a tile failed to load. Without it a
// partly-built mask would either be accepted forever — leaving a tile-shaped
// hole in the sea that only recentring could clear — or retried every frame.
const RETRY_AFTER_MS = 5000;

// How many times to come back for a failed tile before giving up on it. A brief
// outage is covered; a source that is properly down is not polled forever. The
// hole clears by itself whenever the camera moves far enough to recentre.
const MAX_RETRIES = 3;

const DEG2RAD = Math.PI / 180;

/**
 * The vector zoom whose tiles are about TARGET_TILES_ACROSS across the region.
 *
 * Clamped to the source's deepest zoom at one end, and at the other to a zoom
 * where a tile is still small enough to carry a usable coastline. The deep end
 * comes from the configured source rather than a constant, because a
 * self-hosted server may stop shallower than MapTiler does and asking it for a
 * zoom it does not serve returns 404s, which read as "no water here".
 */
export function maskZoomForSpan(spanMetres, latDeg) {
    const lat = clampLatitude(latDeg);
    const groundPerTile = (z) => MERCATOR_WORLD_M * Math.cos(lat * DEG2RAD) / (1 << z);
    let z = vectorWaterMaxZoom();
    while (z > 6 && groundPerTile(z) * TARGET_TILES_ACROSS < spanMetres) z--;
    return z;
}

/**
 * One geographic water mask, rebuilt as the camera moves.
 *
 * Owned by CNodeWaterReflection. Everything is lazy: nothing is fetched, and no
 * canvas exists, until update() is first called with the effect switched on.
 */
export class CGeoWaterMask {

    /**
     * @param {?function()} onReady called when a new mask becomes usable. The
     *        build is asynchronous and Sitrec renders on demand, so without this
     *        a settled scene — Wave Speed 0 draws no frames of its own — would
     *        stay unshaded until the user next touched something.
     */
    constructor(onReady = null) {
        this.onReady = onReady;
        this.texture = null;
        // {u0, v0, du} in normalised mercator — du is the side of the square,
        // and the region is square in mercator so dv equals it. u0 may fall
        // outside 0..1 for a region straddling the antimeridian; the shader
        // takes the longitude difference modulo one turn, so it does not care.
        this.rect = null;
        // What the CURRENT texture was built for, so a rebuild is only started
        // when the region has actually moved.
        this._builtCentre = null;
        this._builtSpan = 0;
        this._building = false;
        // Set when a tile failed: the mask on screen has a hole in it, so it is
        // used but not treated as final.
        this._retryAt = 0;
        this._retryTimer = null;
        this._retriesLeft = 0;
        // Bumped on every dispose so a rasterise that was already in flight
        // knows its texture is no longer wanted.
        this._generation = 0;
    }

    dispose() {
        this._generation++;
        this.texture?.dispose();
        this.texture = null;
        this.rect = null;
        this._builtCentre = null;
        this._builtSpan = 0;
        this._building = false;
        this._cancelRetry();
    }

    _cancelRetry() {
        if (this._retryTimer !== null) clearTimeout(this._retryTimer);
        this._retryTimer = null;
        this._retryAt = 0;
        this._retriesLeft = 0;
    }

    /**
     * Ask for one frame once the retry deadline has passed.
     *
     * A deadline on its own is not enough: _needsRebuild is only ever polled
     * from the render path, and a settled scene draws no frames — Wave Speed 0
     * is a supported setting and leaves updateWhilePaused false — so a transient
     * tile failure would leave the hole in the sea until some unrelated
     * interaction happened to draw a frame. The timer's whole job is to request
     * the one frame that will notice the deadline; the rebuild itself stays in
     * the render path with everything else.
     */
    _scheduleRetry() {
        if (this._retryTimer !== null) return;
        const generation = this._generation;
        this._retryTimer = setTimeout(() => {
            this._retryTimer = null;
            if (generation !== this._generation) return;   // disposed while waiting
            this.onReady?.();
        }, RETRY_AFTER_MS);
    }

    /**
     * Ensure a mask covering `spanMetres` of ground centred on (lat, lon).
     *
     * Returns immediately with whatever is ready — the previous mask while a new
     * one is being fetched, or null before the first one arrives. Water simply
     * does not shade until then, which is the right failure: a half-built mask
     * would put water on the land it has not loaded yet.
     */
    update(latDeg, lonDeg, spanMetres) {
        if (this._needsRebuild(latDeg, lonDeg, spanMetres)) {
            this._build(latDeg, lonDeg, spanMetres);
        }
        return this.texture;
    }

    _needsRebuild(latDeg, lonDeg, spanMetres) {
        if (this._building) return false;
        if (this._builtCentre === null) return true;
        if (this._builtSpan !== spanMetres) return true;
        // A tile failed last time, so what is on screen has a hole in it. Retry
        // on a timer rather than every frame — a source that is down would
        // otherwise be asked sixty times a second.
        if (this._retryAt !== 0 && Date.now() >= this._retryAt) return true;
        // Distance in metres from the centre the current mask was built for.
        // Longitude is scaled by cos(lat) so this is ground distance, not
        // degrees — a degree of longitude is 92 km at Santa Monica — and taken
        // the short way round, so crossing the antimeridian is a small step
        // rather than a 360-degree one.
        const dLat = (latDeg - this._builtCentre.lat) * 111320;
        let dLonDeg = lonDeg - this._builtCentre.lon;
        dLonDeg -= 360 * Math.round(dLonDeg / 360);
        const dLon = dLonDeg * 111320 * Math.cos(latDeg * DEG2RAD);
        return Math.hypot(dLat, dLon) > spanMetres * RECENTRE_FRACTION;
    }

    _build(latDeg, lonDeg, spanMetres) {
        const lat = clampLatitude(latDeg);
        const z = maskZoomForSpan(spanMetres, lat);
        const n = 1 << z;

        // The square, in normalised mercator. A square in mercator is a square
        // on the ground at the centre latitude — mercator's scale distortion is
        // isotropic, so within one region it is a uniform magnification and not
        // a shear. Over 12 km at 34 degrees the scale varies by 0.17% edge to
        // edge, which is 20 m of registration error at the corners; the height
        // band around the water plane is what actually decides water there, so
        // the mask only has to be right to about a texel, and it is.
        const du = spanMetres / (MERCATOR_WORLD_M * Math.cos(lat * DEG2RAD));
        const cx = mercatorX(lonDeg);
        const cy = mercatorY(lat);
        const rect = {u0: cx - du / 2, v0: cy - du / 2, du};

        let loading;
        try { loading = loadRegionTiles(rect, z); }
        catch { return; } // no source or out-of-range coverage

        this._building = true;
        // A build the camera asked for gets a fresh budget; one the retry timer
        // asked for spends the budget the first failure set up, so a source that
        // is down cannot be polled forever.
        if (this._retryAt === 0) this._retriesLeft = MAX_RETRIES;
        const generation = this._generation;

        loading.then((results) => {
            if (generation !== this._generation) return;   // disposed while loading
            const loaded = results.filter(Boolean);
            const texture = rasterise(loaded, rect, n);
            this.texture?.dispose();
            this.texture = texture;
            this.rect = rect;
            this._builtCentre = {lat: latDeg, lon: lonDeg};
            this._builtSpan = spanMetres;
            // A tile that failed leaves a tile-shaped hole of "land" in the sea.
            // Show the rest — most of the mask is usually right — but come back
            // for it, or the hole would survive until the camera moved far
            // enough to recentre.
            if (loaded.length === results.length) {
                this._cancelRetry();
            } else if (this._retriesLeft > 0) {
                this._retriesLeft--;
                this._retryAt = Date.now() + RETRY_AFTER_MS;
                this._scheduleRetry();
            } else {
                this._retryAt = 0;
            }
            this.onReady?.();
        }).finally(() => {
            if (generation === this._generation) this._building = false;
        });
    }
}

// Ocean seeds for inundation, sharing the reflection mask's decoder and cache.
export async function loadOceanMaskRegion(rect, size) {
    const z = Math.min(vectorWaterMaxZoom(), Math.max(6, Math.floor(Math.log2(2 / rect.du))));
    const tiles = await loadRegionTiles(rect, z);
    if (tiles.some(tile => tile === null)) throw new Error("Ocean map could not be loaded. Recalculate to retry.");
    return rasterise(tiles, rect, 2 ** z, size, true);
}

function loadRegionTiles(rect, z) {
    const n = 2 ** z;
    const tx0 = Math.floor(rect.u0 * n), tx1 = Math.floor((rect.u0 + rect.du) * n);
    const ty0 = Math.max(0, Math.floor(rect.v0 * n));
    const ty1 = Math.min(n - 1, Math.floor((rect.v0 + rect.du) * n));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > MAX_MASK_TILES) {
        throw new Error("Ocean map coverage is too large at this latitude.");
    }
    const jobs = [];
    // Keep x unwrapped for placement, wrapping only the requested tile URL.
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
        const url = vectorWaterTileUrl(z, ((tx % n) + n) % n, ty);
        if (!url) throw new Error("Ocean map source is not configured.");
        jobs.push(loadVectorWaterTile(url).then(decoded => ({tx, ty, decoded})).catch(() => null));
    }
    return Promise.all(jobs);
}

// Rasterise each tile with its own transform into one geographic mask.
function rasterise(tiles, rect, n, size = MASK_SIZE, oceanOnly = false) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", {willReadFrequently: false});

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#ffffff";

    for (const {tx, ty, decoded} of tiles) {
        const polygons = oceanOnly ? decoded.oceanPolygons : decoded.polygons;
        if (!polygons?.length) continue;
        const extent = decoded.extent;
        // Tile-local coordinate p (0..extent) sits at mercator (tx + p/extent)/n,
        // and mercator u maps to canvas pixel (u - rect.u0) / rect.du * MASK_SIZE.
        const scale = size / (extent * n * rect.du);
        const ox = (tx / n - rect.u0) / rect.du * size;
        const oy = (ty / n - rect.v0) / rect.du * size;

        ctx.save();
        ctx.setTransform(scale, 0, 0, scale, ox, oy);
        // One path per feature, so two lakes overlapping in the tile's buffer
        // zone cannot cancel each other out under the nonzero fill rule — see
        // WaterMaskTiles.rasteriseMask, which has the same requirement.
        for (const rings of polygons) {
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
    // flipY OFF, unlike three's default. Canvas row 0 is the NORTH edge of the
    // region, and mercator y also increases southward, so leaving the flip in
    // would make the shader's v coordinate run the wrong way and put the
    // coastline in the sea. With it off, v is (mercatorY - v0) / du directly.
    texture.flipY = false;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
}
