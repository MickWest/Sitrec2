import {SceneLineSegments, SceneLine} from "../SceneLines";
import {SceneLineMaterial} from "../SceneLineMaterial";
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

import {BufferGeometry, MathUtils, Matrix4, Vector3} from "three";
import {FileManager} from "../Globals";
import {raDec2Celestial} from "../CelestialMath";
import {installRefractionOnMaterial} from "../atmosphere/refraction";
import {horizonCompassFrame} from "../HorizonCompassRibbon";
import {CelestialGridMaterial} from "../CelestialGridMaterial";

function clearLines(lines) {
    const materials = new Set();
    for (const line of lines) {
        line.removeFromParent();
        line.geometry?.dispose();
        line.sourceGeometry?.dispose();
        if (line.material) materials.add(line.material);
    }
    for (const material of materials) material.dispose();
    lines.length = 0;
}

export class CCelestialElements {
    /**
     * Creates a new CCelestialElements instance
     * @param {Object} config Configuration object
     * @param {number} [config.sphereRadius=100] Radius of celestial sphere in units
     */
    constructor(config = {}) {
        this.sphereRadius = config.sphereRadius ?? 100;
        this.lineWidth = config.lineWidth ?? 0.25;
        
        // Store references to created objects for potential cleanup/updates
        this.celestialGridLines = [];
        this.azimuthalGridLines = [];
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
        this.addSphereGridLines(scene, gap, color, this.celestialGridLines, true);
    }

    // In the observer's East/North/Up frame, longitude circles are azimuths
    // and latitude circles are elevations. Keep these measured angles free of
    // celestial refraction; the equatorial grid instead follows refracted stars.
    addAzimuthalSphereLines(scene, gap = 10, color = 0x808080) {
        this.addSphereGridLines(scene, gap, color, this.azimuthalGridLines, false, true);
    }

    orientAzimuthalGrid(group, observer, equatorRadius, polarRadius) {
        const {east, north, up} = horizonCompassFrame(observer, equatorRadius, polarRadius);
        group.setRotationFromMatrix(new Matrix4().makeBasis(east, north, up));
    }

    addSphereGridLines(scene, gap, color, lines, refracted, azimuthal = false) {
        const material = new CelestialGridMaterial({color, linewidth: this.lineWidth,
            sphereRadius: this.sphereRadius, refracted});

        // Adding lines for RA (Right Ascension)
        // These go from celestial North to South poles, similar to lines of longitude
        for (let ra = 0; ra < 360; ra += gap) {
            // Azimuth starts at north (local +Y) and increases toward east (+X).
            const raRad = MathUtils.degToRad(azimuthal ? 90 - ra : ra);
            const points = [];
            for (let dec = -90; dec <= 90; dec += 1.8) {
                const decRad = MathUtils.degToRad(dec);
                const equatorial = raDec2Celestial(raRad, decRad, this.sphereRadius);
                points.push(new Vector3(equatorial.x, equatorial.y, equatorial.z));
            }
            const geometry = new BufferGeometry().setFromPoints(points);
            const line = new SceneLine(geometry, material);
            scene.add(line);
            lines.push(line);
        }

        // Adding lines for Dec (Declination)
        // These go all the way around at constant declination, similar to lines of latitude
        // Anchor parallels at zero, even for spacings such as 25 or 35 degrees
        // that do not divide 90. Always include the equator / level horizon.
        const declinations = [-90, 0, 90];
        for (let dec = gap; dec < 90; dec += gap) declinations.push(-dec, dec);
        declinations.sort((a, b) => a - b);
        for (const dec of declinations) {
            const decRad = MathUtils.degToRad(dec);
            const points = [];
            for (let ra = 0; ra <= 360; ra += 1.5) {
                const raRad = MathUtils.degToRad(ra);
                const equatorial = raDec2Celestial(raRad, decRad, this.sphereRadius);
                points.push(new Vector3(equatorial.x, equatorial.y, equatorial.z));
            }
            const geometry = new BufferGeometry().setFromPoints(points);
            const line = new SceneLine(geometry, material);
            scene.add(line);
            lines.push(line);
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
        const material = new SceneLineMaterial({color: 0x808080, linewidth: this.lineWidth});
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
            const line = new SceneLineSegments(geometry, material);
            scene.add(line);
            this.constellationLines.push(line);
        }
    }

    setLineWidth(width) {
        this.lineWidth = width;
        for (const line of [...this.celestialGridLines, ...this.azimuthalGridLines, ...this.constellationLines]) {
            line.material.linewidth = width;
        }
    }

    rebuildGridLines(equatorialGroup, azimuthalGroup, spacing) {
        clearLines(this.celestialGridLines);
        clearLines(this.azimuthalGridLines);
        this.addCelestialSphereLines(equatorialGroup, spacing);
        this.addAzimuthalSphereLines(azimuthalGroup, spacing);
    }

    // Constellation NAMES are not built here. They are drawn as 2D text by
    // CNodeDisplaySkyOverlay, alongside the star and satellite labels: that keeps them at a
    // fixed pixel size whatever the field of view, and gives them the same projection - fisheye
    // included - and the same Earth occlusion and dusk fade as every other sky label.

    /**
     * Removes only the constellation lines (leaves the grid intact).
     * Used when switching between asterism datasets at runtime.
     *
     * @param {Scene} scene Three.js scene to remove from
     */
    clearConstellationLines(scene) {
        clearLines(this.constellationLines);
    }

    /**
     * Removes all celestial elements from scene
     *
     * @param {Scene} scene Three.js scene to remove from
     */
    dispose(scene) {
        clearLines(this.celestialGridLines);
        clearLines(this.azimuthalGridLines);

        this.clearConstellationLines(scene);
    }
}
