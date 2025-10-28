/**
 * CStarField - Extracted star rendering system from CNodeDisplayNightSky
 * 
 * Handles:
 * - Loading and parsing binary BSC5 (Bright Star Catalog) data
 * - Loading common star names from IAU Catalog Star Names (IAUCSN)
 * - Creating custom shader material for star rendering
 * - Generating and managing star sprite geometry
 * - Dynamic magnitude-based visibility filtering
 * - Resource cleanup and disposal
 * 
 * Dependencies:
 * - FileManager: Loads BSC5 and IAUCSN data files
 * - Three.js: Provides rendering primitives (Points, BufferGeometry, ShaderMaterial, etc.)
 * - Sit: Global settings (starScale, starLimit)
 * - CelestialMath.raDec2Celestial: Converts RA/DEC to 3D coordinates
 * - configUtils.SITREC_APP: Application root path for resources
 */

import {BufferAttribute, BufferGeometry, Points, ShaderMaterial, TextureLoader} from "three";
import {FileManager, NodeMan, Sit} from "../Globals";
import {raDec2Celestial} from "../CelestialMath";
import {SITREC_APP} from "../configUtils";
import {assert} from "../assert.js";

export class CStarField {
    /**
     * Creates a new CStarField instance
     * @param {Object} config Configuration object
     * @param {number} [config.starLimit=6.5] Magnitude limit for stars to display (higher = fainter stars shown)
     * @param {number} [config.starScale=1.0] Responsive scale factor for star sizes
     * @param {number} [config.sphereRadius=100] Radius of celestial sphere in units
     * @param {string} [config.starTexturePath] Custom path to star texture (default: SITREC_APP+'data/images/nightsky/MickStar.png')
     */
    constructor(config = {}) {
        this.starLimit = config.starLimit ?? 6.5;
        this.starScale = config.starScale ?? 1.0;
        this.sphereRadius = config.sphereRadius ?? 100;
        this.starTexturePath = config.starTexturePath ?? (SITREC_APP + 'data/images/nightsky/MickStar.png');

        // Bright Star Catalog data - using separate arrays for performance
        this.BSC_NumStars = 0;
        this.BSC_MaxMag = -10000;
        this.BSC_RA = [];      // Right Ascension in radians
        this.BSC_DEC = [];     // Declination in radians
        this.BSC_MAG = [];     // Magnitude (brightness)
        this.BSC_HIP = [];     // Hipparcos catalog ID
        this.BSC_NAME = [];    // Star names (rarely used, mostly empty)

        // Common star names indexed by position in catalog
        this.commonNames = {};

        // Rendering objects
        this.starSprites = null;        // Points object for GPU rendering
        this.starGeometry = null;       // BufferGeometry with positions and flux
        this.starMaterial = null;       // Custom ShaderMaterial
    }

    /**
     * Loads star data from binary BSC5 (Yale Bright Star Catalog) file
     * Binary format: Fixed-width records containing star positions and magnitudes
     * Reference: https://observablehq.com/@visnup/yale-bright-star-catalog
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
            this.BSC_NAME[this.BSC_NumStars] = "HIP " + xno.toString().padStart(6, '0');

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

    /**
     * Creates the custom ShaderMaterial for star rendering
     * Vertex shader: Calculates point size based on flux (magnitude-derived brightness)
     * Fragment shader: Renders circular stars with texture and smooth alpha blending
     * @returns {ShaderMaterial} The star rendering material
     */
    createStarMaterial() {
        const customVertexShader = `
        varying vec3 vColor;
        varying float vFlux;

        uniform float cameraFOV;
        uniform float starScale;
        
        attribute float flux;

        void main() {
            vColor = vec3(1.0);

            // Size proportional to flux and responsive scaling
            float size = flux * starScale;
            vFlux = size;

            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mvPosition;
            gl_PointSize = size;
        }
    `;

        const customFragmentShader = `
        varying vec3 vColor;
        varying float vFlux;
        uniform sampler2D starTexture;

        void main() {
            vec2 uv = gl_PointCoord.xy * 2.0 - 1.0;
            float alpha = 1.0 - dot(uv, uv);
            if (alpha < 0.0) discard;
            
            vec4 textureColor = texture2D(starTexture, gl_PointCoord);
            
            // Discard very faint stars to reduce visual clutter
            if (vFlux < 0.5) {
                gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
                return;
            }
            
            gl_FragColor = textureColor;
        }`;

        this.starMaterial = new ShaderMaterial({
            vertexShader: customVertexShader,
            fragmentShader: customFragmentShader,
            uniforms: {
                starTexture: {
                    value: new TextureLoader().load(this.starTexturePath)
                },
                cameraFOV: { value: 30 },
                starScale: { value: Sit.starScale / window.devicePixelRatio },
            },
            transparent: true,
            depthTest: true,
        });

        return this.starMaterial;
    }

    /**
     * Generates star sprite geometry and creates Points object for rendering
     * Converts RA/DEC coordinates to 3D positions and calculates magnitude-based flux values
     * @param {Scene} scene Three.js scene to add star sprites to
     */
    createStarSprites(scene) {
        const numStars = this.BSC_NumStars;

        // Remove existing star sprites to prevent duplicates
        if (this.starSprites) {
            scene.remove(this.starSprites);
            if (this.starGeometry) {
                this.starGeometry.dispose();
            }
            this.starSprites = null;
        }

        this.starGeometry = new BufferGeometry();

        let positions = [];
        let fluxes = [];

        // Reference magnitude for flux calculation normalization
        // Corresponds to Sirius-like brightness
        const magRef = -1.5;

        // Create vertices for each star that passes magnitude filter
        for (let i = 0; i < numStars; i++) {
            const mag = this.BSC_MAG[i];
            
            // Only include stars brighter than the limit
            if (mag <= Sit.starLimit) {
                // Convert RA/DEC celestial coordinates to 3D Cartesian on sphere
                const equatorial = raDec2Celestial(this.BSC_RA[i], this.BSC_DEC[i], this.sphereRadius);
                positions.push(equatorial.x, equatorial.y, equatorial.z);

                // Calculate flux (visual brightness) from magnitude
                // Formula: flux = cbrt(100000000 * 10^(-0.4 * (mag - (-1.5)))) / 16
                // This converts astronomical magnitude scale to visual point size
                const flux = Math.cbrt(100000000 * Math.pow(10, -0.4 * (mag - magRef))) / 16;
                fluxes.push(flux);
            }
        }

        // Set geometry attributes
        this.starGeometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
        this.starGeometry.setAttribute('flux', new BufferAttribute(new Float32Array(fluxes), 1));

        // Create and add Points object to scene
        this.starSprites = new Points(this.starGeometry, this.starMaterial);
        scene.add(this.starSprites);
    }

    /**
     * Initializes star rendering system
     * Loads data, creates material, and generates sprite geometry
     * @param {Scene} scene Three.js scene to add stars to
     */
    addToScene(scene) {
        this.loadStarData();
        this.loadCommonStarNames();
        this.createStarMaterial();
        this.createStarSprites(scene);
    }

    /**
     * Updates star visibility based on new magnitude limit
     * Useful for dynamic filtering without reloading star data
     * @param {number} newLimit New magnitude limit (higher = more stars visible)
     * @param {Scene} scene Three.js scene containing the stars
     */
    updateStarVisibility(newLimit, scene) {
        Sit.starLimit = newLimit;
        this.createStarSprites(scene);
    }

    /**
     * Gets the common name of a star by index
     * @param {number} index Star index in BSC catalog
     * @returns {string|undefined} Common name or undefined if not found
     */
    getStarCommonName(index) {
        return this.commonNames[index];
    }

    /**
     * Gets the HIP name of a star by index
     * @param {number} index Star index in BSC catalog
     * @returns {string|undefined} Common name or undefined if not found
     */
    getStarName(index) {
        return this.BSC_NAME[index];
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

    /**
     * Cleans up GPU resources
     * Should be called when the star field is no longer needed or being replaced
     */
    dispose() {
        if (this.starSprites) {
            if (this.starGeometry) {
                this.starGeometry.dispose();
            }
            if (this.starMaterial) {
                if (this.starMaterial.uniforms.starTexture && this.starMaterial.uniforms.starTexture.value) {
                    this.starMaterial.uniforms.starTexture.value.dispose();
                }
                this.starMaterial.dispose();
            }
        }

        // Clear data arrays
        this.BSC_RA = [];
        this.BSC_DEC = [];
        this.BSC_MAG = [];
        this.BSC_HIP = [];
        this.BSC_NAME = [];
        this.commonNames = {};
    }

    /**
     * Updates the responsive star scale
     * Useful when device pixel ratio changes or user adjusts brightness
     * @param {number} newScale New scale factor
     */
    updateScale(newScale) {
        this.starScale = newScale;
        if (this.starMaterial) {
            this.starMaterial.uniforms.starScale.value = newScale / window.devicePixelRatio;
        }
    }

    /**
     * Updates star scales based on view camera and atmospheric conditions
     * Adjusts star visibility based on sky brightness at camera location
     * Called once per frame during rendering to maintain responsive display
     * @param {Object} view The view object containing camera and adjustment methods
     */
    updateStarScales(view) {
        if (!this.starMaterial) return;

        const camera = view.camera;

        let starScale = Sit.starScale;
        this.starMaterial.uniforms.cameraFOV.value = camera.fov;

        // scale based on sky brightness at camera location
        const sunNode = NodeMan.get("theSun", true);
        const skyBrightness = sunNode.calculateSkyBrightness(camera.position);
        let attenuation = Math.max(0, 1 - skyBrightness);
        starScale *= attenuation;

        starScale = view.adjustPointScale(starScale);
        this.starMaterial.uniforms.starScale.value = starScale;
    }
}