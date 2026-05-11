// Files that are added to the list of loaded assets for certain sitches (.e.g. SitPVS14.js)

// NightSkyFiles - loaded when Sit.nightSky is true
export const NightSkyFiles = {
    IAUCSN: "nightsky/IAU-CSN.txt",
//    BSC5: "nightsky/BSC5.bin",
    BSC5: "nightsky/sitrec_bsc_lite.bin",
    constellationsLines: "nightsky/constellations.lines.json",  // https://github.com/ofrohn/d3-celestial/tree/master/data
    // Asterism lines as used by astrometry.net (default Stellarium "Western" set).
    // Derived from dstndstn/astrometry.net catalogs/stellarium-constellations.c (BSD-3-Clause)
    // via scripts/convertAstrometryConstellations.js.
    constellationsLinesAstrometry: "nightsky/constellations.lines.astrometry.json",
    constellations: "nightsky/constellations.json",

}