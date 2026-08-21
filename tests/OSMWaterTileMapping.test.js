import {maskTransform, osmTileForTile} from "../src/OSMWaterTileMapping";

// "Combine Terrain with OSM" fetches the OSM tile covering each terrain tile.
// Past OSM's max zoom there is no 1:1 tile, so it falls back to an ancestor and
// crops. A wrong crop paints water in the wrong place with no error, so the
// arithmetic is pinned here.
describe("osmTileForTile", () => {
    test("uses the tile itself at or below OSM's max zoom", () => {
        expect(osmTileForTile(19, 1000, 2000, 19)).toEqual({z: 19, x: 1000, y: 2000, srcRect: null});
        expect(osmTileForTile(12, 700, 1600, 19)).toEqual({z: 12, x: 700, y: 1600, srcRect: null});
    });

    test("drops to the parent tile one level past max zoom, taking a quadrant", () => {
        // 2^1 = 2 tiles across the parent, so each child is one quarter of it.
        const evenEven = osmTileForTile(20, 1000, 2000, 19);
        expect(evenEven).toEqual({
            z: 19, x: 500, y: 1000,
            srcRect: {fx: 0, fy: 0, fw: 0.5, fh: 0.5},
        });

        const oddOdd = osmTileForTile(20, 1001, 2001, 19);
        expect(oddOdd).toEqual({
            z: 19, x: 500, y: 1000,
            srcRect: {fx: 0.5, fy: 0.5, fw: 0.5, fh: 0.5},
        });
    });

    test("keeps descending for deeper tiles", () => {
        // Three levels past max zoom: 8x8 grid within the ancestor.
        const deep = osmTileForTile(22, 4005, 8003, 19);
        expect(deep.z).toBe(19);
        expect(deep.x).toBe(500);   // 4005 >> 3
        expect(deep.y).toBe(1000);  // 8003 >> 3
        expect(deep.srcRect.fw).toBeCloseTo(1 / 8);
        expect(deep.srcRect.fh).toBeCloseTo(1 / 8);
        expect(deep.srcRect.fx).toBeCloseTo(5 / 8);  // 4005 - 500*8
        expect(deep.srcRect.fy).toBeCloseTo(3 / 8);  // 8003 - 1000*8
    });

    test("every child of a tile maps back inside its ancestor exactly once", () => {
        const seen = new Set();
        for (let dx = 0; dx < 4; dx++) {
            for (let dy = 0; dy < 4; dy++) {
                const r = osmTileForTile(21, 2000 + dx, 4000 + dy, 19);
                expect(r.x).toBe(500);
                expect(r.y).toBe(1000);
                expect(r.srcRect.fx).toBeGreaterThanOrEqual(0);
                expect(r.srcRect.fx + r.srcRect.fw).toBeLessThanOrEqual(1);
                expect(r.srcRect.fy).toBeGreaterThanOrEqual(0);
                expect(r.srcRect.fy + r.srcRect.fh).toBeLessThanOrEqual(1);
                const key = `${r.srcRect.fx},${r.srcRect.fy}`;
                expect(seen.has(key)).toBe(false);
                seen.add(key);
            }
        }
        expect(seen.size).toBe(16);
    });
});

// The vector water mask reuses osmTileForTile's ancestor arithmetic, but where
// the raster path CROPS pixels the vector path SCALES polygons. maskTransform is
// that scaling. A wrong transform shifts every coastline by a fraction of a tile
// — which still looks like a coastline, so it has to be pinned here rather than
// checked by eye.
describe("maskTransform", () => {
    const EXTENT = 4096;
    const SIZE = 256;

    // Apply the setTransform 6-tuple by hand, the way canvas would.
    const apply = (t, x, y) => ({x: t[0] * x + t[2] * y + t[4], y: t[1] * x + t[3] * y + t[5]});

    test("maps a 1:1 tile's full extent onto the full canvas", () => {
        const t = maskTransform(null, SIZE, EXTENT);
        expect(apply(t, 0, 0)).toEqual({x: 0, y: 0});
        expect(apply(t, EXTENT, EXTENT)).toEqual({x: SIZE, y: SIZE});
    });

    test("stretches a quadrant to fill the canvas", () => {
        // The bottom-right child one level past the source's max zoom.
        const srcRect = {fx: 0.5, fy: 0.5, fw: 0.5, fh: 0.5};
        const t = maskTransform(srcRect, SIZE, EXTENT);

        // The quadrant's own corners land on the canvas corners...
        expect(apply(t, EXTENT * 0.5, EXTENT * 0.5)).toEqual({x: 0, y: 0});
        expect(apply(t, EXTENT, EXTENT)).toEqual({x: SIZE, y: SIZE});
        // ...and the rest of the parent tile falls outside, so it is clipped.
        expect(apply(t, 0, 0)).toEqual({x: -SIZE, y: -SIZE});
    });

    test("scales by 2^levels, so deeper tiles magnify rather than blur", () => {
        const oneLevel = maskTransform({fx: 0, fy: 0, fw: 0.5, fh: 0.5}, SIZE, EXTENT);
        const twoLevels = maskTransform({fx: 0, fy: 0, fw: 0.25, fh: 0.25}, SIZE, EXTENT);
        expect(twoLevels[0]).toBeCloseTo(oneLevel[0] * 2);
        expect(twoLevels[3]).toBeCloseTo(oneLevel[3] * 2);
    });

    test("offsets follow the sub-rectangle's origin", () => {
        // A quadrant in x only: y is untouched, x is pushed left by one canvas.
        const t = maskTransform({fx: 0.5, fy: 0, fw: 0.5, fh: 1}, SIZE, EXTENT);
        expect(t[4]).toBeCloseTo(-SIZE);
        expect(t[5]).toBe(-0);
        expect(apply(t, EXTENT * 0.5, 0)).toEqual({x: 0, y: 0});
        expect(apply(t, EXTENT, EXTENT).y).toBeCloseTo(SIZE);
    });
});
