// Files that are added to the list of loaded assets for certain sitches (.e.g. SitPVS14.js)

import {FileManager} from "./Globals";

// NightSkyFiles - loaded when Sit.nightSky is true. These are consumed synchronously while
// the night-sky node BUILDS (stars, their names, and the constellation lines/names group),
// so they load with the sitch's other assets. Deferring them was tried (2026-08-09) and
// reverted: holding them out of the load window shifts when Globals.pendingActions reaches
// zero, which finishDeserialization waits on, and night-visible sitches settled into a
// different layout. Only a file the build provably never reads may be deferred — see below.
export const NightSkyFiles = {
    IAUCSN: "nightsky/IAU-CSN.txt",
//    BSC5: "nightsky/BSC5.bin",
    BSC5: "nightsky/sitrec_bsc_lite.bin",
    constellationsLines: "nightsky/constellations.lines.json",  // https://github.com/ofrohn/d3-celestial/tree/master/data
    constellations: "nightsky/constellations.json",
}

// Deferred: the alternate asterism line set, read ONLY when the user switches the
// constellation-style dropdown to "astrometry" (or a sitch saved in that style loads).
// Nothing touches it at build time in the default style, so it can load on demand.
export const DeferredNightSkyFiles = {
    // Asterism lines as used by astrometry.net (default Stellarium "Western" set).
    // Derived from dstndstn/astrometry.net catalogs/stellarium-constellations.c (BSD-3-Clause)
    // via scripts/convertAstrometryConstellations.js.
    constellationsLinesAstrometry: "nightsky/constellations.lines.astrometry.json",
}

/**
 * Load one or more night-sky files into the FileManager under their usual keys.
 *
 * Thin on purpose: FileManager.loadAsset already resolves immediately for a loaded key,
 * de-duplicates in-flight loads by filename, and counts Globals.parsing/pendingActions
 * around the fetch — so this needs no cache of its own, and a file already loaded through
 * a sitch's asset list is simply found.
 *
 * @param {...string} keys FileManager keys from DeferredNightSkyFiles (or NightSkyFiles)
 * @returns {Promise} resolves when every requested file is loaded and parsed
 */
export function ensureNightSkyFiles(...keys) {
    return Promise.all(keys.map((key) => {
        const file = DeferredNightSkyFiles[key] ?? NightSkyFiles[key];
        return FileManager.loadAsset(file, key);
    }));
}
