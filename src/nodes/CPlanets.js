/**
 * CPlanets - Extracted planet rendering system from CNodeDisplayNightSky
 * 
 * Handles:
 * - Planet sprite creation and management
 * - Day sky sprite rendering (Sun and Moon visible during day)
 * - Planet position calculation using Astronomy Engine
 * - Magnitude-based brightness scaling
 * - Resource cleanup and disposal
 * 
 * Dependencies:
 * - Three.js: Provides rendering primitives (Sprite, SpriteMaterial, TextureLoader, etc.)
 * - Astronomy Engine: Calculates planet positions and illumination
 * - CelestialMath.raDec2Celestial: Converts RA/DEC to 3D coordinates
 * - Sit: Global settings (planetScale)
 * - configUtils.SITREC_APP: Application root path for resources
 */

import {
    BufferAttribute,
    BufferGeometry,
    CircleGeometry,
    Matrix4,
    Mesh,
    MeshBasicMaterial,
    ShaderMaterial,
    SphereGeometry,
    Sprite,
    SpriteMaterial,
    SRGBColorSpace,
    TextureLoader,
    Vector3
} from "three";
import {Sit} from "../Globals";
import {raDec2Celestial, getECEFToEQJMatrix} from "../CelestialMath";
import {
    applyRefractionECI,
    zenithEQJFromLatLon,
    refractionUniforms,
    REFRACTION_VERTEX_GLSL,
    REFRACTION_DEFAULTS,
} from "../atmosphere/refraction";
import {lunarEclipseRender, MOON_MEAN_RADIUS_KM, SUN_RADIUS_KM} from "../CLunarEclipseCalc";
import {SITREC_APP} from "../configUtils";
import {assert} from "../assert";
import {radians} from "../utils";
import * as Astronomy from "astronomy-engine";

// Lunar-eclipse shading for the Moon's fragment shader.
//
// Everything is done per-fragment from the surface point's true 3-D position,
// so the shadow's curvature across the disc, and the foreshortening of the
// terminator near the limb, are exact rather than a screen-space circle.
//
// The DIRECT term is the fraction of the Sun's disc that the Earth hides, as
// seen from that point, put through a limb-darkening curve. That single
// expression gives the whole geometric shadow: the long soft penumbral
// gradient, the feathered umbral edge, and hard zero inside the umbra. It is
// the GLSL twin of directSunlightAt() in CLunarEclipseCalc, which the unit
// tests pin against astronomy-engine's cone model.
//
// The REFRACTED term is looked up from a 1-D profile of the light that has
// been bent into the umbra by the Earth's atmosphere - the blood-moon colour.
// See atmosphere/umbralLight.js for how that profile is computed. It is
// sqrt-encoded in a half-float texture so three decades of dynamic range
// survive; squaring on read undoes that.
const MOON_ECLIPSE_GLSL = /* glsl */`
    const float ECLIPSE_PI = 3.141592653589793;

    // Fraction of disc A (radius ra) hidden by disc B (radius rb), with their
    // centres d apart. All three in the SAME units; the caller scales by the
    // Sun's angular radius so the terms are O(1), because in raw radians
    // (~0.005) the lens-area formula cancels catastrophically in 32-bit floats
    // right where it matters - at tangency.
    float eclipseDiscOverlap(float ra, float rb, float d) {
        if (ra <= 0.0 || rb <= 0.0) return 0.0;
        if (d >= ra + rb) return 0.0;
        if (d <= abs(rb - ra)) return rb >= ra ? 1.0 : (rb * rb) / (ra * ra);
        float ra2 = ra * ra, rb2 = rb * rb, d2 = d * d;
        float a1 = acos(clamp((d2 + ra2 - rb2) / (2.0 * d * ra), -1.0, 1.0));
        float a2 = acos(clamp((d2 + rb2 - ra2) / (2.0 * d * rb), -1.0, 1.0));
        float tri = 0.5 * sqrt(max(0.0,
            (-d + ra + rb) * (d + ra - rb) * (d - ra + rb) * (d + ra + rb)));
        return clamp((ra2 * a1 + rb2 * a2 - tri) / (ECLIPSE_PI * ra2), 0.0, 1.0);
    }

    // Surviving photospheric FLUX for a given fraction of the disc AREA
    // covered. The limb goes first and comes back last, and the limb is only
    // ~40% as bright as disc centre, so flux does not track area. Same closed
    // form as eclipseLightFraction() in CEclipseCalc.
    float eclipseLimbFlux(float O) {
        O = clamp(O, 0.0, 1.0);
        return clamp(1.0 - O + sin(2.0 * ECLIPSE_PI * O) / (4.0 * ECLIPSE_PI), 0.0, 1.0);
    }

    vec3 eclipseIllumination() {
        if (uEclipse < 0.5) return vec3(1.0);

        // This fragment's surface point, relative to the Moon's centre, in the
        // Moon's body-fixed frame - the frame vNormal already lives in.
        vec3 xKm = normalize(vNormal) * uMoonRadiusKm;

        vec3 toEarth = uEarthDirML * uEarthDistKm - xKm;
        float dE = length(toEarth);
        vec3 dirE = toEarth / dE;

        // The Sun is 1.5e8 km away, so forming its position outright would
        // throw away the low bits. normalize(S*D - x) == normalize(S - x/D)
        // keeps every term near unity.
        vec3 dirS = normalize(uSunDirEclipseML - xKm / uSunDistKm);
        float dS = uSunDistKm - dot(xKm, uSunDirEclipseML);

        float rhoE = asin(clamp(uEarthShadowRadiusKm / dE, 0.0, 1.0));
        float rhoS = asin(clamp(${SUN_RADIUS_KM.toFixed(1)} / dS, 0.0, 1.0));
        // atan2 form: the two directions are nearly parallel during an
        // eclipse, which is exactly where acos(dot) loses its precision.
        float sep = atan(length(cross(dirE, dirS)), dot(dirE, dirS));

        float direct = 1.0;
        if (sep < rhoE + rhoS) {
            direct = eclipseLimbFlux(eclipseDiscOverlap(1.0, rhoE / rhoS, sep / rhoS));
        }

        // Refracted light: indexed by this point's perpendicular distance from
        // the shadow axis.
        vec3 refracted = vec3(0.0);
        vec3 axis = -uSunDirEclipseML;
        vec3 pE = xKm - uEarthDirML * uEarthDistKm;
        float along = dot(pE, axis);
        float rPerp = length(pE - axis * along);
        if (rPerp < uUmbraLUTScaleKm) {
            vec3 enc = texture2D(uUmbraLUT, vec2(rPerp / uUmbraLUTScaleKm, 0.5)).rgb;
            refracted = enc * enc * uUmbraLUTGain;
            refracted = mix(vec3(dot(refracted, vec3(0.2126, 0.7152, 0.0722))),
                            refracted, uBloodMoon);
        }

        vec3 illum = (vec3(direct) + refracted) * uEclipseExposure;

        // Soft shoulder above 0.8, so a photographic exposure boost rolls the
        // un-eclipsed limb off instead of clipping it flat. Branch-free, and a
        // strict no-op at exposure 1 where nothing ever exceeds 1.
        vec3 over = max(illum - 0.8, 0.0);
        return min(illum, 0.8) + 0.2 * (1.0 - exp(-over / 0.2));
    }
`;

export class CPlanets {
    /**
     * Creates a new CPlanets instance
     * @param {Object} config Configuration object
     * @param {number} [config.sphereRadius=100] Radius of celestial sphere in units
     * @param {Array<string>} [config.planets] List of planet names to render
     * @param {Array<string>} [config.planetColors] Hex colors for each planet
     */
    constructor(config = {}) {
        this.sphereRadius = config.sphereRadius ?? 100;
        this.sunSphereRadius = this.sphereRadius + 1;
        
        // Planet list and colors
        this.planets = config.planets ?? [
            "Sun", "Moon", "Mercury", "Venus", "Mars", 
            "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto"
        ];
        
        // Sun is WHITE. It was "#FFFF40", a saturated yellow, which painted a
        // hard yellow disc in the middle of the sun glare — and one narrower
        // than the Sun itself, since the sprite's visible core is smaller than
        // its quad. The Sun's photosphere is very nearly white; what warmth you
        // see near the horizon comes from the air it is shining through, which
        // the atmosphere and refraction paths already supply.
        this.planetColors = config.planetColors ?? [
            "#FFFFFF", "#FFFFFF", "#FFFFFF", "#80ff80", "#ff8080",
            "#FFFF80", "#FF80FF", "#FFFFFF", "#FFFFFF", "#FFFFFF"
        ];
        
        // Stores all planet sprite data
        // Structure: { planetName: { sprite, daySkySprite, ra, dec, mag, equatorial, color } }
        this.planetSprites = {};

        this._zenithECI = new Vector3(0, 0, 1);
        this._ecefToEQJ = new Matrix4();
        // Reused per call to avoid per-frame allocation.
        this._refractionOptsCache = {
            enabled: REFRACTION_DEFAULTS.enabled,
            pressureHPa: REFRACTION_DEFAULTS.pressureHPa,
            tempC: REFRACTION_DEFAULTS.tempC,
        };
        
        // Preloaded textures for efficiency
        this.textures = {
            star: null,
            sun: null,
            moon: null,
            moonSurface: null
        };
        
        this.moonMesh = null;
        this.moonDayMesh = null;
        this.moonMaterial = null;
        this.moonDayMaterial = null;
        this._loadTextures();
    }

    /**
     * Preload planet sprite textures
     * @private
     */
    _loadTextures() {
        const textureLoader = new TextureLoader();
        this.textures.star = textureLoader.load(SITREC_APP + 'data/images/nightsky/MickStar.png');
        this.textures.star.colorSpace = SRGBColorSpace;
        this.textures.sun = textureLoader.load(SITREC_APP + 'data/images/nightsky/MickSun.png');
        this.textures.sun.colorSpace = SRGBColorSpace;
        this.textures.moon = textureLoader.load(SITREC_APP + 'data/images/nightsky/MickMoon.png');
        this.textures.moon.colorSpace = SRGBColorSpace;
        this.textures.moonSurface = textureLoader.load(SITREC_APP + 'data/images/nightsky/lroc_color_1k.jpg');
        this.textures.moonSurface.colorSpace = SRGBColorSpace;
    }
    
    _createMoonMaterial(isDay = false) {
        return new ShaderMaterial({
            uniforms: {
                moonTexture: { value: this.textures.moonSurface },
                sunDirection: { value: new Vector3(1, 0, 0) },
                observerDirection: { value: new Vector3(0, 0, -1) },
                skyColor: { value: new Vector3(0, 0, 0) },
                skyBrightness: { value: 0.0 },
                // Lunar eclipse. uEclipse is the hard no-op switch: at 0 the
                // fragment shader never reads any of the rest.
                uEclipse: { value: 0.0 },
                uEarthDirML: { value: new Vector3(0, 0, 1) },
                uEarthDistKm: { value: 384400.0 },
                uSunDirEclipseML: { value: new Vector3(0, 0, 1) },
                uSunDistKm: { value: 1.4959787e8 },
                uEarthShadowRadiusKm: { value: 6459.0 },
                uMoonRadiusKm: { value: MOON_MEAN_RADIUS_KM },
                uUmbraLUT: { value: null },
                uUmbraLUTScaleKm: { value: 8263.0 },
                uUmbraLUTGain: { value: 1.0 },
                uEclipseExposure: { value: 1.0 },
                uBloodMoon: { value: 1.0 },
                ...refractionUniforms,
            },
            vertexShader: `
                varying vec3 vNormal;
                varying vec2 vUv;
                ${REFRACTION_VERTEX_GLSL}
                void main() {
                    vUv = uv;
                    vNormal = normalize(normal);
                    // Refract each sphere vertex in world space — bottom of the
                    // disk gets lifted more than the top near the horizon, so
                    // the rendered Moon flattens vertically the way the real
                    // sky does.
                    vec4 worldPos = modelMatrix * vec4(position, 1.0);
                    worldPos.xyz = applyRefractionECEF_chunk(worldPos.xyz);
                    gl_Position = projectionMatrix * viewMatrix * worldPos;
                }
            `,
            fragmentShader: `
                uniform sampler2D moonTexture;
                uniform vec3 sunDirection;
                uniform vec3 observerDirection;
                uniform vec3 skyColor;
                uniform float skyBrightness;
                uniform float uEclipse;
                uniform vec3 uEarthDirML;
                uniform float uEarthDistKm;
                uniform vec3 uSunDirEclipseML;
                uniform float uSunDistKm;
                uniform float uEarthShadowRadiusKm;
                uniform float uMoonRadiusKm;
                uniform sampler2D uUmbraLUT;
                uniform float uUmbraLUTScaleKm;
                uniform float uUmbraLUTGain;
                uniform float uEclipseExposure;
                uniform float uBloodMoon;
                varying vec3 vNormal;
                varying vec2 vUv;

                ${MOON_ECLIPSE_GLSL}

                void main() {
                    vec3 sunDir = normalize(sunDirection);
                    vec3 viewDir = normalize(observerDirection);
                    float mu0 = max(0.0, dot(vNormal, sunDir));
                    float mu = max(0.0, dot(vNormal, viewDir));
                    // Lommel-Seeliger reflectance is a reasonable first-order model
                    // for an airless body like the Moon. It darkens toward the
                    // terminator without adding any light to the shadowed side.
                    float reflectance = 0.0;
                    if (mu0 > 0.0 && mu > 0.0) {
                        reflectance = min(1.0, (2.0 * mu0) / max(mu0 + mu, 1e-4));
                    }

                    vec2 uv = vUv;
                    uv.x = fract(uv.x + 0.25);
                    vec4 textureColor = texture2D(moonTexture, uv);
                    // Lunar eclipse: how much sunlight actually arrives here.
                    // Exactly 1.0, and free of any texture fetch, when there is
                    // no eclipse.
                    vec3 moonLit = textureColor.rgb * reflectance * eclipseIllumination();

                    // skyColor uniform is in sRGB space; linearize to match
                    // the linear moon color and the linear render target.
                    vec3 linearSky = sRGBTransferEOTF(vec4(skyColor, 1.0)).rgb;

                    // skyOpacity = min(1, skyBrightness * 2) — matches the JS calculation
                    // in CNodeSunlight.calculateSkyOpacity(). This is what the sky
                    // fullscreen quad uses for its alpha blend.
                    float skyOpacity = clamp(skyBrightness * 2.0, 0.0, 1.0);

                    // Attenuate the moon in daylight to simulate shorter camera exposure.
                    // 1.0 at night, 0.5 at full day.
                    float dayBlend = clamp(skyBrightness, 0.0, 1.0);
                    float moonAtten = max(0.0, 1.0 - 0.5 * dayBlend);

                    // Use linearSky * skyOpacity to exactly match the sky background
                    // rendered by the fullscreen sky quad. On the dark side moonLit is 0,
                    // so the output equals the sky — no visible dark disc.
                    vec3 finalColor = moonLit * moonAtten + linearSky * skyOpacity;

                    gl_FragColor = vec4(finalColor, 1.0);
                }
            `,
            depthWrite: true,
            depthTest: true,
        });
    }

    _createSunMaterial() {
        // ShaderMaterial so each vertex gets refracted individually — the
        // Sun's lower limb lifts more than the upper one near the horizon,
        // producing the characteristic vertical squash.
        //
        // WHITE. This was 0xfff27a, carried over from the MeshBasicMaterial
        // before it, and it drew a hard yellow disc in the middle of the sun
        // glare — narrower than the Sun itself, because the sprite's visible
        // core is smaller than its quad, so it read as a small yellow dot
        // inside a white glow rather than as the Sun. The photosphere is very
        // nearly white; the warmth in a real low Sun comes from the air it
        // shines through, which the atmosphere and refraction paths supply.
        return new ShaderMaterial({
            uniforms: {
                uColor: {value: new Vector3(1.0, 1.0, 1.0)},
                ...refractionUniforms,
            },
            vertexShader: `
                ${REFRACTION_VERTEX_GLSL}
                void main() {
                    vec4 worldPos = modelMatrix * vec4(position, 1.0);
                    worldPos.xyz = applyRefractionECEF_chunk(worldPos.xyz);
                    gl_Position = projectionMatrix * viewMatrix * worldPos;
                }
            `,
            fragmentShader: `
                uniform vec3 uColor;
                void main() {
                    gl_FragColor = vec4(uColor, 1.0);
                }
            `,
            depthWrite: false,
            depthTest: false,
        });
    }

    // Build a unit-radius (0.5) disk made of N horizontal strips. Used for
    // the Sun so per-vertex refraction can flatten it vertically near the
    // horizon. Vertices are placed exactly on the circle (no internal grid),
    // so 32 strips approximate a circle with 64 boundary vertices.
    _buildSunStripGeometry(radius = 0.5, strips = 32) {
        const geom = new BufferGeometry();
        const positionsArr = new Float32Array((strips + 1) * 2 * 3);
        const uvsArr = new Float32Array((strips + 1) * 2 * 2);
        const indices = [];
        for (let i = 0; i <= strips; i++) {
            const t = i / strips;
            const y = -radius + 2 * radius * t;
            const x = Math.sqrt(Math.max(0, radius * radius - y * y));
            const base = i * 6;
            positionsArr[base + 0] = -x;
            positionsArr[base + 1] = y;
            positionsArr[base + 2] = 0;
            positionsArr[base + 3] = x;
            positionsArr[base + 4] = y;
            positionsArr[base + 5] = 0;
            const uvBase = i * 4;
            uvsArr[uvBase + 0] = 0.0;
            uvsArr[uvBase + 1] = t;
            uvsArr[uvBase + 2] = 1.0;
            uvsArr[uvBase + 3] = t;
        }
        for (let i = 0; i < strips; i++) {
            const v = i * 2;
            indices.push(v, v + 1, v + 3);
            indices.push(v, v + 3, v + 2);
        }
        geom.setAttribute('position', new BufferAttribute(positionsArr, 3));
        geom.setAttribute('uv', new BufferAttribute(uvsArr, 2));
        geom.setIndex(indices);
        return geom;
    }

    _createSunDisk() {
        const mesh = new Mesh(this._buildSunStripGeometry(0.5, 32), this._createSunMaterial());
        // Vertex shader refraction can lift the visible disk above
        // mesh.position near the horizon — see Moon mesh comment.
        mesh.frustumCulled = false;
        return mesh;
    }

    _getTopocentricDistanceMeters(body, date, observer, aberration = true) {
        const bodyId = typeof body === "string" ? Astronomy.Body[body] : body;
        const bodyVector = Astronomy.GeoVector(bodyId, date, aberration);
        const observerVector = Astronomy.ObserverVector(date, observer, false);

        const dx = bodyVector.x - observerVector.x;
        const dy = bodyVector.y - observerVector.y;
        const dz = bodyVector.z - observerVector.z;

        return Math.hypot(dx, dy, dz) * Astronomy.KM_PER_AU * 1000;
    }

    _getAngularDiameterRad(body, date, observer, physicalRadiusMeters, aberration = true) {
        const distanceMeters = this._getTopocentricDistanceMeters(body, date, observer, aberration);
        return 2 * Math.atan(physicalRadiusMeters / distanceMeters);
    }

    _getMoonToSunDirection(date, aberration = true) {
        const sunVector = Astronomy.GeoVector(Astronomy.Body.Sun, date, aberration);
        const moonVector = Astronomy.GeoVector(Astronomy.Body.Moon, date, aberration);

        // Lighting on the Moon should use the direction from the Moon's center to
        // the Sun, not the topocentric direction from the Earth observer to the
        // Sun. Using the observer's Sun direction leaves a small but noticeable
        // bias in eclipse/new-moon cases where even sub-degree errors create a
        // one-sided illuminated rim.
        return new Vector3(
            sunVector.x - moonVector.x,
            sunVector.y - moonVector.y,
            sunVector.z - moonVector.z
        ).normalize();
    }

    _getMoonBodyAxes(axisInfo) {
        const alpha = (axisInfo.ra / 24) * 2 * Math.PI;
        const delta = radians(axisInfo.dec);
        const spin = radians((((axisInfo.spin % 360) + 360) % 360));

        // Build a true Moon-fixed frame from the IAU rotational elements:
        // alpha/delta give the north-pole direction in J2000, and spin=W gives
        // the prime meridian angle around that pole. This is a more stable basis
        // for crater placement than inferring the face orientation by mixing
        // libration angles with extra topocentric correction terms.
        //
        // Resulting local axes:
        // - north: Moon north pole
        // - primeMeridian: selenographic lon=0, lat=0 direction
        // - east: completes the right-handed texture frame
        const north = new Vector3(axisInfo.north.x, axisInfo.north.y, axisInfo.north.z).normalize();

        // nodeDir and meridianRef are the standard two perpendicular directions
        // in the Moon's equatorial plane derived from the pole RA/Dec.
        // Rotating between them by W lands on the current prime meridian.
        const nodeDir = new Vector3(-Math.sin(alpha), Math.cos(alpha), 0).normalize();
        const meridianRef = new Vector3(
            -Math.cos(alpha) * Math.sin(delta),
            -Math.sin(alpha) * Math.sin(delta),
            Math.cos(delta)
        ).normalize();

        // Prime meridian in inertial space at this instant.
        const primeMeridian = nodeDir.multiplyScalar(Math.cos(spin))
            .add(meridianRef.multiplyScalar(Math.sin(spin)))
            .normalize();

        // The map uses the Moon's equatorial east-west direction across the face.
        // Together with the existing +0.25 U offset in the shader, this keeps the
        // Earth-facing near side aligned with the equirectangular texture.
        const east = new Vector3().crossVectors(north, primeMeridian).normalize();

        return {east, north, primeMeridian};
    }

    /**
     * Removes all planet sprites from scenes
     * Safely disposes of materials and textures
     * 
     * @param {Scene} scene Main night sky scene
     * @param {Scene} [dayScene] Optional day sky scene for Sun/Moon rendering
     */
    removePlanets(scene, dayScene = null) {
        if (this.planetSprites) {
            for (const [planet, planetData] of Object.entries(this.planetSprites)) {
                if (planetData.sprite) {
                    if (scene) scene.remove(planetData.sprite);
                    if (planetData.sprite.material) {
                        if (planetData.sprite.material.map) {
                            planetData.sprite.material.map.dispose();
                        }
                        planetData.sprite.material.dispose();
                    }
                }
                if (planetData.daySkySprite && dayScene) {
                    dayScene.remove(planetData.daySkySprite);
                    if (planetData.daySkySprite.isMesh && planetData.daySkySprite.geometry) {
                        planetData.daySkySprite.geometry.dispose();
                    }
                    if (planetData.daySkySprite.material) {
                        if (planetData.daySkySprite.material.map) {
                            planetData.daySkySprite.material.map.dispose();
                        }
                        planetData.daySkySprite.material.dispose();
                    }
                }
            }
        }
        
        if (this.moonMesh && scene) {
            scene.remove(this.moonMesh);
            if (this.moonMesh.geometry) this.moonMesh.geometry.dispose();
        }
        if (this.moonDayMesh && dayScene) {
            dayScene.remove(this.moonDayMesh);
            if (this.moonDayMesh.geometry) this.moonDayMesh.geometry.dispose();
        }
        if (this.moonMaterial) {
            this.moonMaterial.dispose();
            this.moonMaterial = null;
        }
        if (this.moonDayMaterial) {
            this.moonDayMaterial.dispose();
            this.moonDayMaterial = null;
        }
        this.moonMesh = null;
        this.moonDayMesh = null;
        
        this.planetSprites = {};
    }

    /**
     * Adds planet sprites to the scenes
     * Creates sprites for all planets and positions them based on observer location
     * 
     * @param {Scene} scene Main night sky scene
     * @param {Scene} [dayScene] Optional day sky scene for Sun/Moon during daylight
     * @param {Object} params Configuration object
     * @param {Date} params.date Current simulation date/time
     * @param {Vector3} params.cameraPos Camera position in ECEF coordinates
     * @param {Function} params.ecefToLla Function to convert ECEF to LLA coordinates
     */
    addPlanets(scene, dayScene = null, params = {}) {
        assert(params.date, "CPlanets.addPlanets: date required");
        assert(params.cameraPos, "CPlanets.addPlanets: cameraPos required");
        assert(params.ecefToLla, "CPlanets.addPlanets: ecefToLla function required");

        this.removePlanets(scene, dayScene);

        if (this.planetSprites && Object.keys(this.planetSprites).length > 0) {
            console.warn("CPlanets: planetSprites not empty after removePlanets, forcing cleanup");
            this.planetSprites = {};
        }

        const cameraLLA = params.ecefToLla(params.cameraPos);
        const observer = new Astronomy.Observer(cameraLLA.x, cameraLLA.y, cameraLLA.z);

        let n = 0;
        for (const planet of this.planets) {
            const color = this.planetColors[n++];
            
            if (planet === "Moon") {
                this.moonMaterial = this._createMoonMaterial();
                const moonGeometry = new SphereGeometry(1, 32, 32);
                this.moonMesh = new Mesh(moonGeometry, this.moonMaterial);
                this.moonMesh.renderOrder = 2;
                this.moonMesh.visible = !dayScene;
                // Per-vertex shader refraction can lift the visible disk by
                // up to ~0.5° relative to mesh.position, so the geometric
                // bounds aren't a reliable cull predicate near the horizon.
                this.moonMesh.frustumCulled = false;
                scene.add(this.moonMesh);

                if (dayScene) {
                    this.moonDayMaterial = this._createMoonMaterial();
                    const moonDayGeometry = new SphereGeometry(1, 32, 32);
                    this.moonDayMesh = new Mesh(moonDayGeometry, this.moonDayMaterial);
                    this.moonDayMesh.renderOrder = 2;
                    this.moonDayMesh.frustumCulled = false;
                    dayScene.add(this.moonDayMesh);
                }
                
                this.updateMoonMesh(params.date, observer);
                this.planetSprites[planet] = {
                    ra: 0, dec: 0, mag: 0, equatorial: new Vector3(),
                    sprite: this.moonMesh, color: color,
                    daySkySprite: this.moonDayMesh, isMesh: true
                };
            } else if (planet === "Sun") {
                const sunDisk = this._createSunDisk();
                sunDisk.visible = !dayScene;
                let daySkySprite = null;
                if (dayScene) {
                    daySkySprite = this._createSunDisk();
                    dayScene.add(daySkySprite);
                }

                this.updatePlanetSprite(planet, sunDisk, params.date, observer, daySkySprite);
                this.planetSprites[planet].color = color;
                scene.add(sunDisk);
            } else {
                const texture = this._getTextureForPlanet(planet);
                const spriteMaterial = new SpriteMaterial({map: texture, color: color, depthWrite: false});
                const sprite = new Sprite(spriteMaterial);

                let daySkySprite = null;
                this.updatePlanetSprite(planet, sprite, params.date, observer, daySkySprite);
                this.planetSprites[planet].color = color;
                scene.add(sprite);
            }
        }
    }

    // Build the refraction options block from current Sit settings and, as a
    // side effect, refresh this._zenithECI for the given observer/date so a
    // single computation feeds both the Moon and any subsequent planets in
    // the same sync pass.
    _refractionOpts(date, observer) {
        if (date && observer) {
            zenithEQJFromLatLon(
                radians(observer.latitude),
                radians(observer.longitude),
                getECEFToEQJMatrix(date, this._ecefToEQJ),
                this._zenithECI,
            );
        }
        const opts = this._refractionOptsCache;
        opts.enabled = Sit.refractionEnabled !== undefined
            ? !!Sit.refractionEnabled
            : REFRACTION_DEFAULTS.enabled;
        opts.pressureHPa = Sit.refractionPressure ?? REFRACTION_DEFAULTS.pressureHPa;
        opts.tempC = Sit.refractionTemp ?? REFRACTION_DEFAULTS.tempC;
        // Height of the observer above the ellipsoid, so the bend is scaled to
        // the atmosphere the sightline crosses. This CPU result is what the
        // sky-overlay labels track, so it has to agree with the vertex shader
        // that draws the disk — hence the radius comes from the same uniform
        // the shader is reading this frame.
        opts.observerHeight = observer?.height ?? refractionUniforms.uObserverHeight.value;
        opts.earthRadius = refractionUniforms.uEarthRadius.value;
        return opts;
    }

    updateMoonMesh(date, observer, options = {}) {
        if (!this.moonMesh) return;
        const storeState = options.storeState ?? true;

        // Topocentric center direction for the Moon. This sets where the Moon
        // appears in the sky for the current observer and naturally captures
        // topocentric viewing geometry.
        const celestialInfo = Astronomy.Equator("Moon", date, observer, false, true);
        const axisInfo = Astronomy.RotationAxis("Moon", date);

        const ra = (celestialInfo.ra) / 24 * 2 * Math.PI;
        const dec = radians(celestialInfo.dec);
        const equatorialGeometric = raDec2Celestial(ra, dec, this.sphereRadius);

        // The Moon mesh sits at its geometric position; per-vertex refraction
        // happens in the vertex shader so the disk flattens correctly near the
        // horizon. We still compute an apparent center for the planetSprites
        // map (used by sky-overlay labels) so labels track the visible disk.
        const refractOpts = options.refractionOpts ?? this._refractionOpts(date, observer);
        const zenithECI = options.zenithECI ?? this._zenithECI;
        const equatorial = applyRefractionECI(equatorialGeometric.clone(), zenithECI, refractOpts);

        const moonAngularDiameter = this._getAngularDiameterRad("Moon", date, observer, 1737400);
        const moonRadius = Math.tan(moonAngularDiameter / 2) * this.sphereRadius;

        // Drive the lunar terminator from the physical Moon-center -> Sun vector.
        // This keeps the lighting basis in the same inertial frame as the Moon's
        // body rotation and avoids the small topocentric bias from observer -> Sun.
        const sunDir = this._getMoonToSunDirection(date);

        // Orient the Moon from its body-fixed frame directly.
        // The previous version started from the Earth-facing direction and then
        // added libration/parallax terms by hand; that was close, but subtle
        // crater placement errors remained. Using the prime meridian explicitly
        // keeps visible lunar features anchored to the actual rotational model.
        const {east, north, primeMeridian} = this._getMoonBodyAxes(axisInfo);
        const rotMatrix = new Matrix4();
        rotMatrix.makeBasis(east, north, primeMeridian);

        // Use the geometric (un-refracted) center; the moon vertex shader
        // applies refraction per vertex so the visible disk position and
        // shape are both correct.
        this.moonMesh.position.set(equatorialGeometric.x, equatorialGeometric.y, equatorialGeometric.z);
        this.moonMesh.scale.set(moonRadius, moonRadius, moonRadius);
        this.moonMesh.setRotationFromMatrix(rotMatrix);

        // Convert the Sun direction into Moon-local space for lighting.
        const invRotMatrix = rotMatrix.clone().invert();
        const sunInMoonLocal = sunDir.clone().applyMatrix4(invRotMatrix);
        const observerInMoonLocal = equatorialGeometric.clone().normalize().negate().applyMatrix4(invRotMatrix).normalize();
        
        this.moonMaterial.uniforms.sunDirection.value.copy(sunInMoonLocal);
        this.moonMaterial.uniforms.observerDirection.value.copy(observerInMoonLocal);
        
        if (this.moonDayMesh && this.moonDayMaterial) {
            this.moonDayMesh.position.copy(this.moonMesh.position);
            this.moonDayMesh.scale.copy(this.moonMesh.scale);
            this.moonDayMesh.setRotationFromMatrix(rotMatrix);
            this.moonDayMaterial.uniforms.sunDirection.value.copy(sunInMoonLocal);
            this.moonDayMaterial.uniforms.observerDirection.value.copy(observerInMoonLocal);
        }

        // Earth's shadow on the Moon. Done here because this is where the
        // body-fixed rotation is in hand, and the shader works in that frame.
        this._applyLunarEclipse(invRotMatrix);
        
        // Apparent center always tracks the most recent sync — picker /
        // overlay labels use it, and per-view re-syncs (storeState:false)
        // need this to reflect the rendering view's observer.
        if (this.planetSprites["Moon"]) {
            this.planetSprites["Moon"].equatorial = equatorial;
            if (storeState) {
                this.planetSprites["Moon"].ra = ra;
                this.planetSprites["Moon"].dec = dec;
                // phase-dependent apparent magnitude (~ -12.7 full, -10 quarter):
                // the regular planet path stores illumination.mag but the Moon
                // branches here and was leaving mag at its init value of 0 —
                // consumers (HDR moon disk, Moonlight mode) need the real one
                this.planetSprites["Moon"].mag = Astronomy.Illumination("Moon", date).mag;
            }
        }
    }

    // Push the current lunar-eclipse state into both Moon materials, rotated
    // into the Moon's body-fixed frame.
    //
    // HARD NO-OP: with no eclipse under way this writes a single 0 to uEclipse
    // per material and returns; the fragment shader then takes its early-out
    // and never touches a shadow uniform or the profile texture.
    _applyLunarEclipse(invRotMatrix) {
        const materials = [this.moonMaterial, this.moonDayMaterial];
        const r = lunarEclipseRender;
        if (!r.active || r.state.kind === "none") {
            for (const m of materials) {
                if (m) m.uniforms.uEclipse.value = 0;
            }
            return;
        }

        const st = r.state;
        // Moon -> Earth centre, and Moon -> Sun centre, in the body frame.
        this._eclipseEarthDir ??= new Vector3();
        this._eclipseSunDir ??= new Vector3();
        this._eclipseEarthDir.copy(st.moonEQJ).negate().normalize().applyMatrix4(invRotMatrix);
        this._eclipseSunDir.subVectors(st.sunEQJ, st.moonEQJ).normalize().applyMatrix4(invRotMatrix);
        const sunDistKm = st.sunEQJ.distanceTo(st.moonEQJ);

        for (const m of materials) {
            if (!m) continue;
            const u = m.uniforms;
            u.uEclipse.value = 1;
            u.uEarthDirML.value.copy(this._eclipseEarthDir);
            u.uEarthDistKm.value = st.moonDistKm;
            u.uSunDirEclipseML.value.copy(this._eclipseSunDir);
            u.uSunDistKm.value = sunDistKm;
            u.uEarthShadowRadiusKm.value = st.shadowRadiusKm;
            u.uMoonRadiusKm.value = MOON_MEAN_RADIUS_KM;
            u.uUmbraLUT.value = r.lutTexture;
            u.uUmbraLUTScaleKm.value = r.lutScaleKm;
            u.uUmbraLUTGain.value = r.lutTexture ? r.lutGain : 0;
            u.uEclipseExposure.value = r.exposure;
            u.uBloodMoon.value = r.bloodMoon;
        }
    }

    updateMoonSkyUniforms(skyColor, skyBrightness) {
        if (this.moonDayMaterial) {
            this.moonDayMaterial.uniforms.skyColor.value.set(skyColor.r, skyColor.g, skyColor.b);
            this.moonDayMaterial.uniforms.skyBrightness.value = skyBrightness;
        }
    }

    updateDaySkyVisibility(skyOpacity) {
        const sunData = this.planetSprites["Sun"];
        if (sunData?.sprite && sunData.daySkySprite) {
            sunData.sprite.visible = false;
            sunData.daySkySprite.visible = true;
        }

        const moonData = this.planetSprites["Moon"];
        if (moonData?.sprite && moonData.daySkySprite) {
            moonData.sprite.visible = false;
            moonData.daySkySprite.visible = true;
        }
    }

    _orientDiskTowardOrigin(mesh, position) {
        mesh.position.copy(position);
        mesh.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), position.clone().normalize().negate());
    }

    /**
     * Updates a planet sprite's position and scale for the current time
     * Calculates RA/DEC from astronomy library and converts to 3D position
     * 
     * @param {string} planet Planet name
     * @param {Sprite} sprite Three.js Sprite object
     * @param {Date} date Current simulation date/time
     * @param {Astronomy.Observer} observer Observer location
     * @param {Sprite} [daySkySprite] Optional day sky sprite to update in parallel
     */
    updatePlanetSprite(planet, sprite, date, observer, daySkySprite = undefined, options = {}) {
        const storeState = options.storeState ?? true;
        if (planet === "Moon") {
            this.updateMoonMesh(date, observer, {
                storeState,
                refractionOpts: options.refractionOpts,
                zenithECI: options.zenithECI,
            });
            return;
        }
        
        const celestialInfo = Astronomy.Equator(planet, date, observer, false, true);
        const illumination = Astronomy.Illumination(planet, date);

        const ra = (celestialInfo.ra) / 24 * 2 * Math.PI;
        const dec = radians(celestialInfo.dec);
        const mag = illumination.mag;
        const equatorialGeometric = raDec2Celestial(ra, dec, this.sphereRadius);
        const refractOpts = options.refractionOpts ?? this._refractionOpts(date, observer);
        const zenithECI = options.zenithECI ?? this._zenithECI;
        const equatorial = applyRefractionECI(equatorialGeometric.clone(), zenithECI, refractOpts);

        let color = "#FFFFFF";
        if (this.planetSprites[planet] !== undefined) {
            color = this.planetSprites[planet].color;
        }

        var scale = 10 * Math.pow(10, -0.4 * (mag - -5));
        if (scale > 1) scale = 1;
        
        if (planet === "Sun") {
            // IAU nominal solar radius — matches astronomy-engine's eclipse
            // model and CEclipseCalc.SUN_RADIUS_M, so rendered contacts agree
            // with the computed eclipse circumstances to well under a second.
            const sunAngularDiameter = this._getAngularDiameterRad("Sun", date, observer, 695700000);
            scale = 2 * Math.tan(sunAngularDiameter / 2) * this.sunSphereRadius;
        }
        
        if (planet !== "Sun") {
            scale *= Math.pow(10, 0.4 * Math.log10(Sit.planetScale));
        }

        if (planet === "Sun") {
            // Sun mesh is placed at its geometric center so the per-vertex
            // refraction in the Sun shader produces the correct apparent
            // shape (lower limb lifts more than upper near the horizon).
            const sunPosition = equatorialGeometric.clone().normalize().multiplyScalar(this.sunSphereRadius);
            if (sprite.isMesh) {
                this._orientDiskTowardOrigin(sprite, sunPosition);
                sprite.scale.set(scale, scale, 1);
            } else {
                sprite.position.copy(sunPosition);
                sprite.scale.set(scale, scale, 1);
            }
            sprite.renderOrder = 1;
        } else {
            sprite.position.set(equatorial.x, equatorial.y, equatorial.z);
            sprite.scale.set(scale, scale, 1);
        }

        if (daySkySprite) {
            if (planet === "Sun" && daySkySprite.isMesh) {
                this._orientDiskTowardOrigin(daySkySprite, sprite.position);
                daySkySprite.scale.set(scale, scale, 1);
                daySkySprite.renderOrder = 1;
            } else {
                daySkySprite.position.set(equatorial.x, equatorial.y, equatorial.z);
                daySkySprite.scale.set(scale, scale, 1);
                if (planet === "Sun") {
                    daySkySprite.renderOrder = 1;
                }
            }
        }

        if (!this.planetSprites[planet]) {
            this.planetSprites[planet] = {
                ra: ra,
                dec: dec,
                mag: mag,
                equatorial: equatorial,
                sprite: sprite,
                color: color,
                daySkySprite: daySkySprite,
            };
        } else {
            // Apparent center always tracks the latest sync — needed for
            // picker / overlay labels regardless of storeState (the Sun
            // re-syncs every view, so this would otherwise stay pinned to
            // the look camera's apparent center).
            this.planetSprites[planet].equatorial = equatorial;
            if (storeState) {
                this.planetSprites[planet].ra = ra;
                this.planetSprites[planet].dec = dec;
                this.planetSprites[planet].mag = mag;
                this.planetSprites[planet].color = color;
                if (daySkySprite) {
                    this.planetSprites[planet].daySkySprite = daySkySprite;
                }
            }
        }
    }

    /**
     * Get appropriate texture for a planet sprite
     * @private
     * @param {string} planet Planet name
     * @returns {Texture} Three.js texture object
     */
    _getTextureForPlanet(planet) {
        if (planet === "Sun") return this.textures.sun;
        if (planet === "Moon") return this.textures.moon;
        return this.textures.star;
    }

    /**
     * Get planet data by name
     * @param {string} planet Planet name
     * @returns {Object|null} Planet sprite data or null if not found
     */
    getPlanetData(planet) {
        return this.planetSprites[planet] || null;
    }

    /**
     * Cleanup and dispose of all resources
     * Call this when the night sky is being destroyed
     */
    dispose() {
        this.removePlanets(null, null);
        
        if (this.textures.star) this.textures.star.dispose();
        if (this.textures.sun) this.textures.sun.dispose();
        if (this.textures.moon) this.textures.moon.dispose();
        if (this.textures.moonSurface) this.textures.moonSurface.dispose();
    }
}
