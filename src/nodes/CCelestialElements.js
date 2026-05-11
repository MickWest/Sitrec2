/**
 * CCelestialElements - Extracted celestial visualization from CNodeDisplayNightSky
 * 
 * Handles:
 * - Celestial sphere coordinate grid (RA/DEC lines)
 * - Constellation lines visualization
 * - Constellation name labels (placeholder)
 * - Related celestial coordinate system helpers
 * 
 * Dependencies:
 * - Three.js: Provides rendering primitives (Line, LineSegments, BufferGeometry, etc.)
 * - FileManager: Loads constellation data (GeoJSON format)
 * - CelestialMath.raDec2Celestial: Converts RA/DEC to 3D coordinates
 */

import {BufferGeometry, Line, LineBasicMaterial, LineSegments, MathUtils, Vector3} from "three";
import {FileManager} from "../Globals";
import {raDec2Celestial} from "../CelestialMath";
import {installRefractionOnMaterial} from "../atmosphere/refraction";

export class CCelestialElements {
    /**
     * Creates a new CCelestialElements instance
     * @param {Object} config Configuration object
     * @param {number} [config.sphereRadius=100] Radius of celestial sphere in units
     */
    constructor(config = {}) {
        this.sphereRadius = config.sphereRadius ?? 100;
        
        // Store references to created objects for potential cleanup/updates
        this.celestialGridLines = [];
        this.constellationLines = [];
    }

    /**
     * Adds celestial sphere coordinate grid (RA/DEC lines) to scene
     * Creates a grid of Right Ascension (longitude-like) and Declination (latitude-like) lines
     * on the celestial sphere.
     * 
     * @param {Scene} scene Three.js scene to add lines to
     * @param {number} [gap=15] Degrees between grid lines (15 = every 15 degrees)
     * @param {number} [color=0x808080] Hex color for grid lines (default: gray)
     */
    addCelestialSphereLines(scene, gap = 15, color = 0x808080) {
        const material = new LineBasicMaterial({color: color});
        const materialWhite = new LineBasicMaterial({color: "#FF00FF"}); // Reference line (0° RA or poles)
        installRefractionOnMaterial(material);
        installRefractionOnMaterial(materialWhite);
        const segments = 100; // Number of segments per line

        // Helper function to create a single line
        function createLine(start, end) {
            const geometry = new BufferGeometry().setFromPoints([start, end]);
            return new Line(geometry, material);
        }

        // Adding lines for RA (Right Ascension)
        // These go from celestial North to South poles, similar to lines of longitude
        for (let ra = 0; ra < 360; ra += gap) {
            const raRad = MathUtils.degToRad(ra);
            const points = [];
            for (let dec = -90; dec <= 90; dec += 1.8) {
                const decRad = MathUtils.degToRad(dec);
                const equatorial = raDec2Celestial(raRad, decRad, this.sphereRadius);
                points.push(new Vector3(equatorial.x, equatorial.y, equatorial.z));
            }
            const geometry = new BufferGeometry().setFromPoints(points);
            // Highlight 0° RA line in white for reference
            const line = new Line(geometry, ra === 0 ? materialWhite : material);
            scene.add(line);
            this.celestialGridLines.push(line);
        }

        // Adding lines for Dec (Declination)
        // These go all the way around at constant declination, similar to lines of latitude
        for (let dec = -90; dec <= 90; dec += gap) {
            const decRad = MathUtils.degToRad(dec);
            const points = [];
            for (let ra = 0; ra <= 360; ra += 1.5) {
                const raRad = MathUtils.degToRad(ra);
                const equatorial = raDec2Celestial(raRad, decRad, this.sphereRadius);
                points.push(new Vector3(equatorial.x, equatorial.y, equatorial.z));
            }
            const geometry = new BufferGeometry().setFromPoints(points);
            // Highlight celestial poles in white for reference
            const line = new Line(geometry, (dec === 90 - gap) ? materialWhite : material);
            scene.add(line);
            this.celestialGridLines.push(line);
        }
    }

    /**
     * Adds constellation lines to scene
     * Loads constellation data from GeoJSON and renders line segments connecting stars
     *
     * @param {Scene} scene Three.js scene to add constellation lines to
     * @param {string} [dataKey="constellationsLines"] FileManager key for the asterism dataset
     */
    addConstellationLines(scene, dataKey = "constellationsLines") {
        // Use a single material for all line segments (more efficient)
        const material = new LineBasicMaterial({color: 0x808080});
        installRefractionOnMaterial(material);

        const constellationsLines = FileManager.get(dataKey);
        if (!constellationsLines) {
            console.warn(`CCelestialElements: ${dataKey} data not found in FileManager`);
            return;
        }

        // GeoJSON structure: features array containing constellation data
        const features = constellationsLines.features;
        
        for (const feature of features) {
            // feature.geometry.coordinates is an array of line segments
            // Each segment is an array of [lon/RA, lat/DEC] pairs
            
            // Build an array of segment start/end points for efficient rendering
            const segments = [];
            for (let c of feature.geometry.coordinates) {
                // c is an array of [RA, DEC] coordinate pairs
                const p0 = c[0];
                const ra0 = MathUtils.degToRad(Number(p0[0]));
                const dec0 = MathUtils.degToRad(Number(p0[1]));
                let equatorial0 = raDec2Celestial(ra0, dec0, this.sphereRadius);
                
                // Create segments between consecutive coordinates
                for (let i = 1; i < c.length; i++) {
                    const p1 = c[i];
                    const ra1 = MathUtils.degToRad(Number(p1[0]));
                    const dec1 = MathUtils.degToRad(Number(p1[1]));
                    const equatorial1 = raDec2Celestial(ra1, dec1, this.sphereRadius);
                    
                    segments.push(new Vector3(equatorial0.x, equatorial0.y, equatorial0.z));
                    segments.push(new Vector3(equatorial1.x, equatorial1.y, equatorial1.z));
                    equatorial0 = equatorial1;
                }
            }

            // Create buffer geometry from all segments
            const geometry = new BufferGeometry().setFromPoints(segments);
            
            // Create multi-segment line and add to scene
            const line = new LineSegments(geometry, material);
            scene.add(line);
            this.constellationLines.push(line);
        }
    }

    /**
     * Placeholder for constellation name labels
     * Currently unused - would display constellation name abbreviations on the celestial sphere
     * 
     * @param {Scene} scene Three.js scene to add constellation names to
     */
    addConstellationNames(scene) {
        const constellations = FileManager.get("constellations");
        if (!constellations) {
            console.warn("CCelestialElements: constellations data not found in FileManager");
            return;
        }
        
        const features = constellations.features;
        
        // TODO: Implement constellation name labels
        // This would typically involve:
        // - Calculating the centroid of each constellation
        // - Creating a Canvas texture with the constellation abbreviation
        // - Placing a sprite at that position on the celestial sphere
    }

    /**
     * Removes only the constellation lines (leaves the grid intact).
     * Used when switching between asterism datasets at runtime.
     *
     * @param {Scene} scene Three.js scene to remove from
     */
    clearConstellationLines(scene) {
        for (const line of this.constellationLines) {
            scene.remove(line);
            if (line.geometry) line.geometry.dispose();
            if (line.material) line.material.dispose();
        }
        this.constellationLines = [];
    }

    /**
     * Removes all celestial elements from scene
     *
     * @param {Scene} scene Three.js scene to remove from
     */
    dispose(scene) {
        // Remove celestial grid lines
        for (const line of this.celestialGridLines) {
            scene.remove(line);
            if (line.geometry) line.geometry.dispose();
            if (line.material) line.material.dispose();
        }
        this.celestialGridLines = [];

        this.clearConstellationLines(scene);
    }
}