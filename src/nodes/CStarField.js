/**
 * CStarField - Star rendering system using CPointLightCloud
 * 
 * Handles:
 * - Loading and parsing binary BSC5 (Bright Star Catalog) data
 * - Loading common star names from IAU Catalog Star Names (IAUCSN)
 * - Rendering stars via CPointLightCloud in celestial sphere mode
 * - Dynamic magnitude-based visibility filtering
 * - Resource cleanup and disposal
 * 
 * Dependencies:
 * - FileManager: Loads BSC5 and IAUCSN data files
 * - CPointLightCloud: Unified point light rendering
 * - Sit: Global settings (starScale, starLimit)
 * - CelestialMath.raDec2Celestial: Converts RA/DEC to 3D coordinates
 */

import {FileManager, NodeMan, Sit} from "../Globals";
import {raDec2Celestial} from "../CelestialMath";
import {assert} from "../assert";
import {CPointLightCloud} from "./CPointLightCloud";

export class CStarField {
    constructor(config = {}) {
        this.starLimit = config.starLimit ?? 6.5;
        this.starScale = config.starScale ?? 1.0;
        this.sphereRadius = config.sphereRadius ?? 100;

        this.BSC_NumStars = 0;
        this.BSC_MaxMag = -10000;
        this.BSC_RA = [];
        this.BSC_DEC = [];
        this.BSC_MAG = [];
        this.BSC_HIP = [];
        this.BSC_NAME = [];

        this.commonNames = {};

        this.lightCloud = null;
        this.starIndexMap = [];  // maps light index to BSC index
        this.scene = null;
    }

    /**
     * Loads star data from the binary star catalogue.
     *
     * The "BSC5" name is the FORMAT, not the contents. The file this reads
     * (data/nightsky/sitrec_bsc_lite.bin) is a repacked HIPPARCOS catalogue —
     * 117,955 stars keyed by HIP number, magnitude -1.44 to 14.08 — carried in
     * the BSC5 binary container (28-byte header of 7 int32, then 22-byte
     * records). The real 9,110-entry Yale Bright Star Catalogue sits unused
     * beside it as BSC5.bin. Verified against known stars: HIP 32349 reads
     * 6.753h / -16.71 / -1.44, which is Sirius.
     *
     * Format reference: https://observablehq.com/@visnup/yale-bright-star-catalog
     */
    loadStarData() {
        const buffer = FileManager.get("BSC5");
        const littleEndian = true;
        const view = new DataView(buffer);
        
        let offset = 0;
        
        // Read header (7 * 4-byte integers = 28 bytes)
        const star0 = view.getInt32(offset, littleEndian);
        offset += 4;
        const star1 = view.getInt32(offset, littleEndian);
        offset += 4;
        const starn = view.getInt32(offset, littleEndian);
        offset += 4;
        const stnum = view.getInt32(offset, littleEndian);
        offset += 4;
        const mprop = view.getInt32(offset, littleEndian);
        offset += 4;
        const nmag = view.getInt32(offset, littleEndian);
        offset += 4;
        const nbent = view.getInt32(offset, littleEndian);
        offset += 4;

        let nInput = 0;
        
        // Read star records
        while (offset < -starn * nbent - 28) {
            const xno = view.getInt32(offset, littleEndian);  // HIP (Hipparcos) number
            offset += 4;
            const sra0 = view.getFloat64(offset, littleEndian);  // Right Ascension
            offset += 8;
            const sdec0 = view.getFloat64(offset, littleEndian);  // Declination
            offset += 8;
            let mag = view.getInt16(offset, littleEndian) / 100;  // Magnitude (stored as int, divide by 100)
            offset += 2;

            // Validate magnitude is in expected range and not NaN
            assert(
                !isNaN(mag) && mag >= -2 && mag <= 15,
                "mag out of range: " + mag + " at nInput = " + nInput
            );

            // Mark placeholder entries (RA=0, DEC=0) as invisible by setting magnitude to 15
            if (sra0 === 0 && sdec0 === 0) {
                mag = 15;
            } else {
                // Track maximum magnitude of valid stars (ignoring placeholders)
                if (mag > this.BSC_MaxMag) {
                    this.BSC_MaxMag = mag;
                }
            }

            this.BSC_RA[this.BSC_NumStars] = sra0;
            this.BSC_DEC[this.BSC_NumStars] = sdec0;
            this.BSC_MAG[this.BSC_NumStars] = mag;
            this.BSC_HIP[this.BSC_NumStars] = xno;

            this.BSC_NumStars++;
            nInput++;
        }

        console.log("CStarField: Loaded " + this.BSC_NumStars + " stars, max mag = " + this.BSC_MaxMag);
    }

    /**
     * Loads common star names from IAU Catalog Star Names (IAUCSN) text file
     * Maps common names to stars using Hipparcos ID for correlation
     */
    loadCommonStarNames() {
        const lines = FileManager.get("IAUCSN").split('\n');
        
        for (const line of lines) {
            // Skip comment lines and empty lines
            if (line[0] === '#' || line[0] === '$' || line.trim() === '') {
                continue;
            }

            // Fixed-width format:
            // - Columns 0-18: Common name
            // - Columns 89-96: Hipparcos ID (column 10 in 0-based indexing)
            const name = line.substring(0, 18).trim();
            let hipStr = line.substring(89, 96).trim();

            if (hipStr !== "_") {
                const hip = parseInt(hipStr);
                
                // Find the star in our BSC_HIP array
                const index = this.BSC_HIP.indexOf(hip);
                if (index !== -1) {
                    // Store name, using index+1 for BSC compatibility
                    // (historical BSC indexing starts at 1, not 0)
                    this.commonNames[index + 1] = name;
                }
            }
        }
    }

    magnitudeToFlux(mag) {
        const magRef = -1.5;
        return Math.cbrt(100000000 * Math.pow(10, -0.4 * (mag - magRef))) / 16;
    }

    createStarCloud(scene) {
        if (this.lightCloud) {
            NodeMan.disposeRemove(this.lightCloud);
            this.lightCloud = null;
        }

        this.starIndexMap = [];
        let visibleCount = 0;
        for (let i = 0; i < this.BSC_NumStars; i++) {
            if (this.BSC_MAG[i] <= Sit.starLimit) {
                visibleCount++;
            }
        }

        this.lightCloud = new CPointLightCloud({
            id: "StarfieldLightCloud",
            mode: 'celestial',
            singleColor: 0xffffff,
            sphereRadius: this.sphereRadius,
            baseScale: Sit.starScale / window.devicePixelRatio,
            minPointSize: 2.0,
            uRadius: 0.4,
            count: visibleCount,
            scene: scene,
        });

        let lightIndex = 0;
        for (let i = 0; i < this.BSC_NumStars; i++) {
            const mag = this.BSC_MAG[i];
            if (mag <= Sit.starLimit) {
                const equatorial = raDec2Celestial(this.BSC_RA[i], this.BSC_DEC[i], this.sphereRadius);
                const flux = this.magnitudeToFlux(mag);

                this.lightCloud.setPosition(lightIndex, equatorial.x, equatorial.y, equatorial.z);
                this.lightCloud.setBrightness(lightIndex, flux);
                this.starIndexMap[lightIndex] = i;
                lightIndex++;
            }
        }

        this.lightCloud.markPositionsNeedUpdate();
        this.lightCloud.markBrightnessNeedUpdate();
        this.scene = scene;
    }

    addToScene(scene) {
        this.loadStarData();
        this.loadCommonStarNames();
        this.createStarCloud(scene);
    }

    updateStarVisibility(newLimit, scene) {
        Sit.starLimit = newLimit;
        this.createStarCloud(scene);
    }

    /**
     * Gets the common name of a star by index
     * @param {number} index Star index in BSC catalog
     * @returns {string|undefined} Common name or undefined if not found
     */
    getStarName(index) {
        return this.commonNames[index];
    }

    /**
     * Finds a star by its common name (case-insensitive)
     * @param {string} name Common name to search for
     * @returns {object|null} Object with {ra, dec} in radians, or null if not found
     */
    findStarByName(name) {
        const lowerName = name.toLowerCase();
        for (const HR in this.commonNames) {
            if (this.commonNames[HR].toLowerCase() === lowerName) {
                const index = HR - 1;
                return {
                    ra: this.BSC_RA[index],
                    dec: this.BSC_DEC[index],
                };
            }
        }
        return null;
    }

    /**
     * Gets total number of stars loaded
     * @returns {number} Number of stars
     */
    getStarCount() {
        return this.BSC_NumStars;
    }

    /**
     * Gets the maximum (faintest) magnitude in the loaded catalog
     * @returns {number} Maximum magnitude value
     */
    getMaxMagnitude() {
        return this.BSC_MaxMag;
    }

    /**
     * Accessor methods for external code (e.g., CNodeDisplaySkyOverlay)
     * These maintain backward compatibility with direct array access
     */

    /**
     * Gets Right Ascension for a specific star
     * @param {number} index Star index
     * @returns {number} RA in radians
     */
    getStarRA(index) {
        return this.BSC_RA[index];
    }

    /**
     * Gets Declination for a specific star
     * @param {number} index Star index
     * @returns {number} DEC in radians
     */
    getStarDEC(index) {
        return this.BSC_DEC[index];
    }

    /**
     * Gets magnitude for a specific star
     * @param {number} index Star index
     * @returns {number} Magnitude value
     */
    getStarMagnitude(index) {
        return this.BSC_MAG[index];
    }

    /**
     * Gets Hipparcos ID for a specific star
     * @param {number} index Star index
     * @returns {number} Hipparcos catalog ID
     */
    getStarHIP(index) {
        return this.BSC_HIP[index];
    }

    dispose() {
        if (this.lightCloud) {
            NodeMan.disposeRemove(this.lightCloud);
            this.lightCloud = null;
        }

        this.BSC_RA = [];
        this.BSC_DEC = [];
        this.BSC_MAG = [];
        this.BSC_HIP = [];
        this.BSC_NAME = [];
        this.commonNames = {};
        this.starIndexMap = [];
    }

    updateScale(newScale) {
        this.starScale = newScale;
        if (this.lightCloud) {
            this.lightCloud.baseScale = newScale / window.devicePixelRatio;
        }
    }

    updateStarScales(view) {
        if (this.lightCloud) {
            this.lightCloud.baseScale = 1.4 / 1.78 * 2 * Sit.starScale / window.devicePixelRatio;
            this.lightCloud.preRender(view);
        }
    }
}