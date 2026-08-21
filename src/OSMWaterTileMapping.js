// Mapping a terrain tile onto the OSM tile that covers it, for
// "Combine Terrain with OSM" (see QuadTreeTileMaterial.osmWaterSourceForTile).
//
// Kept free of three.js and app state so the ancestor arithmetic can be tested
// on its own — getting it wrong paints water in the wrong place, silently.

/**
 * Find the OSM tile covering a terrain tile, and which part of it to use.
 *
 * OSM stops at zoom 19 while satellite sources go deeper (MapBox reaches 20),
 * so beyond that there is no 1:1 OSM tile. We take the deepest OSM ancestor and
 * the sub-rectangle of it that this tile occupies.
 *
 * @param {number} z tile zoom
 * @param {number} x tile x
 * @param {number} y tile y
 * @param {number} osmMaxZoom deepest zoom OSM serves
 * @returns {{z: number, x: number, y: number, srcRect: ?{fx: number, fy: number, fw: number, fh: number}}}
 *          srcRect is null for a 1:1 match, otherwise fractions (0-1) of the ancestor tile.
 */
export function osmTileForTile(z, x, y, osmMaxZoom) {
    if (z <= osmMaxZoom) {
        return {z, x, y, srcRect: null};
    }

    const levels = z - osmMaxZoom;
    const scale = 1 << levels;
    const ax = x >> levels;
    const ay = y >> levels;

    return {
        z: osmMaxZoom,
        x: ax,
        y: ay,
        srcRect: {
            fx: (x - ax * scale) / scale,
            fy: (y - ay * scale) / scale,
            fw: 1 / scale,
            fh: 1 / scale,
        },
    };
}

/**
 * Canvas transform placing a vector tile's coordinates onto a mask canvas.
 *
 * The raster path above crops PIXELS out of an ancestor image. Vector data has
 * no pixels to crop: the polygons are scaled up instead, which is why the mask
 * stays sharp past the source's max zoom where a cropped raster goes blocky.
 *
 * A vector tile's coordinates run 0..extent across the whole tile. srcRect (from
 * osmTileForTile) says which fraction of that tile the terrain tile occupies, so
 * the transform maps that sub-rectangle onto the full `size`-pixel canvas.
 *
 * Lives here rather than in WaterMaskTiles.js so it can be tested without
 * pulling in three or a canvas — an error here offsets every coastline by a
 * fraction of a tile, which looks entirely plausible and is very hard to catch
 * by eye.
 *
 * @param {?{fx: number, fy: number, fw: number, fh: number}} srcRect null for a 1:1 tile
 * @param {number} size mask canvas size in pixels
 * @param {number} extent vector tile coordinate extent (4096 in practice)
 * @returns {[number, number, number, number, number, number]} ctx.setTransform arguments
 */
export function maskTransform(srcRect, size, extent) {
    const fx = srcRect ? srcRect.fx : 0;
    const fy = srcRect ? srcRect.fy : 0;
    const fw = srcRect ? srcRect.fw : 1;
    const fh = srcRect ? srcRect.fh : 1;

    return [
        size / (fw * extent), 0,
        0, size / (fh * extent),
        -fx * size / fw,
        -fy * size / fh,
    ];
}
