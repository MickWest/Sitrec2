// Cached dynamic import of the geotiff library — ~340 KB of source (geotiff + its pako and
// float16 dependencies) that only two situations ever need: importing a TIFF/GeoTIFF file,
// and GeoTIFF elevation tiles. Everything that consumes it is already async, so the split
// costs one await at first use and removes the library from the entry chunk.
//
// Same promise-cache discipline as proj4Loader/openCVLoader: assign before any await can
// reject, and callers share one in-flight load.

let geotiffPromise = null;

/** @returns {Promise<object>} the geotiff module (use .fromArrayBuffer etc.) */
export function loadGeoTIFF() {
    geotiffPromise ??= import(/* webpackChunkName: "geotiff" */ "geotiff");
    return geotiffPromise;
}
