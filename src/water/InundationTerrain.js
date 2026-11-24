import {meanSeaLevelOffset} from "../EGM96Geoid";
import {sampleElevationTile} from "../ElevationSampling";
import {latitudeAtMercatorY} from "./InundationGrid";

// Load uniform detail across the whole flow region, including off-screen
// barriers. Camera-dependent LOD and the terrain query's missing-data fallback
// must not open a route to the sea. Tile decoding/caching stays in the existing
// terrain pipeline used by Flood Sim, including its vertical datum conversion.
export async function loadInundationTerrain(map, rect, size, signal, progress = () => {}) {
    if (!map || map.options.elevationType === "Flat") throw new Error("Select an elevation source for inundation.");
    const {QuadTreeTile} = await import("../QuadTreeTile");
    const projection = map.options.mapProjection;
    const zoom = Math.max(map.minZoom, Math.min(map.maxZoom, 20, Math.ceil(Math.log2(size / (256 * rect.du)))));
    const lon = new Float64Array(size), lat = new Float64Array(size);
    const tx = new Float64Array(size), ty = new Float64Array(size);
    for (let i = 0; i < size; i++) {
        lon[i] = ((rect.u0 + (i + 0.5) / size * rect.du) * 360) % 360;
        if (lon[i] < 0) lon[i] += 360;
        lon[i] -= 180;
        lat[i] = latitudeAtMercatorY(rect.v0 + (i + 0.5) / size * rect.du);
        tx[i] = projection.lon2Tile(lon[i], zoom);
        ty[i] = projection.lat2Tile(lat[i], zoom);
    }
    const xs = [...new Set(Array.from(tx, Math.floor))], ys = [...new Set(Array.from(ty, Math.floor))];
    const jobs = xs.flatMap(x => ys.map(y => ({x, y})));
    if (jobs.length > 256) throw new Error("Reduce Coverage to calculate inundation with this elevation source.");
    const tiles = new Map(), owned = [];
    let next = 0, completed = 0, failed = 0;
    try {
        await Promise.all(Array.from({length: Math.min(6, jobs.length)}, async () => {
            while (next < jobs.length && !signal.aborted) {
                const {x, y} = jobs[next++];
                let tile = map.getTile(x, y, zoom);
                if (!tile?.elevation || tile.elevationLoadFailed || tile.usingParentData) {
                    tile = new QuadTreeTile(map, zoom, x, y);
                    owned.push(tile);
                    try { await tile.fetchElevationTile(signal); }
                    catch { tile.elevation = null; }
                }
                if (!tile.elevation) failed++;
                tiles.set(`${x}/${y}`, tile);
                progress(++completed, jobs.length);
            }
        }));
        if (signal.aborted) return null;
        const heights = new Float32Array(size * size);
        let missing = 0;
        for (let y = 0; y < size; y++) {
            const iy = Math.floor(ty[y]);
            // Cache each tile for the row instead of doing millions of string
            // allocations and map lookups during interpolation.
            const rowTiles = new Map(xs.map(x => [x, tiles.get(`${x}/${iy}`)]));
            let lastX = NaN, tile;
            for (let x = 0; x < size; x++) {
                const ix = Math.floor(tx[x]);
                if (ix !== lastX) { tile = rowTiles.get(ix); lastX = ix; }
                const hae = sampleElevationTile(tile, tx[x] - ix, ty[y] - iy, true);
                if (hae === null) { heights[y * size + x] = Infinity; missing++; }
                else heights[y * size + x] = hae * map.options.zScale - meanSeaLevelOffset(lat[y], lon[x]);
            }
            if (y % 32 === 31) {
                await new Promise(resolve => setTimeout(resolve, 0));
                if (signal.aborted) return null;
            }
        }
        return {heights, missing, failed, zoom};
    } finally {
        for (const tile of owned) tile.dispose();
    }
}
