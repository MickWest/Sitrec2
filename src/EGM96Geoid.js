import {meanSeaLevel} from 'egm96-universal';

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
export function meanSeaLevelOffset(lat, lon) {
    return meanSeaLevel(lat, lon);
}
