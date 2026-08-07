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
