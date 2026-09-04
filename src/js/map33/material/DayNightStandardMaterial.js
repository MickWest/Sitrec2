import {MeshStandardMaterial, ShaderChunk, Vector3} from "three";
import {sharedUniforms} from "./SharedUniforms";
import {waterShadeGLSL, waterUniformsGLSL} from "../../../water/WaterShading.glsl.js";
import {Globals} from "../../../Globals";
import {
    addTerrestrialRefractionUniforms,
    patchTerrestrialRefractionVertexShader,
} from "../../../atmosphere/terrestrialRefraction";

const CACHE_KEY = "DayNightStandardMaterial.v9tilewater";

// Whether a NEWLY CREATED tile material should carry the water branch.
//
// The branch is a compile-time #define rather than a uniform test, because it
// drags the whole ocean BRDF and the mirror lookup into the fragment shader and
// a dead branch of that size still costs every tile registers. Tiles stream in
// constantly, so a new material has to know the current answer at construction;
// materials that already exist are switched by TilesDayNightPlugin walking them,
// which is safe (it edits a define, it does not swap the material out).
let tileWaterEnabled = false;

/**
 * Set the default for materials created from now on.
 *
 * Does NOT touch existing materials — TilesDayNightPlugin.setTileWater() does
 * that, because only it knows which ones are loaded.
 */
export function setTileWaterDefault(on) {
    tileWaterEnabled = !!on;
}

// MeshStandardMaterial subclass that uses the PBR pipeline for textures,
// vertex colors, and normal-based shading from the scene's sun directional
// light, then applies a post-lighting pass to darken fragments on the night
// side of the earth's terminator.
//
// flatShading is forced on because tile geometries (e.g. Cesium OSM Buildings)
// often lack a normal attribute. Without normals the PBR directional light
// contribution is zero (dot((0,0,0), lightDir) = 0). flatShading computes
// face normals from screen-space derivatives, which always works and is
// visually correct for architectural geometry.
export class DayNightStandardMaterial extends MeshStandardMaterial {

    constructor(parameters) {
        const {tileOutputGamma = 1.0, useSitrecShadowCoords = false, ...materialParameters} = parameters ?? {};
        super(materialParameters);

        this.flatShading = true;
        this.tileOutputGamma = tileOutputGamma;
        this.useSitrecShadowCoords = useSitrecShadowCoords;
        this.defines = {};
        if (tileWaterEnabled) this.defines.SITREC_TILE_WATER = "";

        this._dayNightUniforms = {
            sunDirection: {value: Globals.sunLight.position},
            earthCenter: {value: new Vector3(0, 0, 0)},
            useDayNight: sharedUniforms.useDayNight,
            sunGlobalTotal: sharedUniforms.sunGlobalTotal,
            sunAmbientIntensity: sharedUniforms.sunAmbientIntensity,
            sunNightAmbientIntensity: sharedUniforms.sunNightAmbientIntensity,
            tileOutputGamma: {value: this.tileOutputGamma},
            showBuildingEdges: sharedUniforms.showBuildingEdges,
            showTileEdges: sharedUniforms.showTileEdges,
        };

        // Every water uniform, shared BY REFERENCE exactly as the terrain
        // material shares them — that reference is what makes
        // CNodeWaterReflection.push()/pop() scope the effect to one view's
        // render without touching any material. Taken by prefix rather than
        // listed, so a uniform added to the water shader cannot be forgotten
        // here. Ones the shader does not use are ignored by three, and when
        // SITREC_TILE_WATER is off the shader uses none of them.
        for (const k of Object.keys(sharedUniforms)) {
            if (k.startsWith("water")) this._dayNightUniforms[k] = sharedUniforms[k];
        }

        this.onBeforeCompile = this._onBeforeCompile.bind(this);
    }

    _onBeforeCompile(shader) {
        Object.assign(shader.uniforms, this._dayNightUniforms);
        // Terrestrial refraction of the solid scene. TilesDayNightPlugin swaps
        // every streamed tile's material for this class, so patching here is
        // what covers Google Photorealistic tiles and Cesium OSM buildings —
        // including tiles that stream in later. It rewrites gl_Position only;
        // uTerrK defaults to 0, which makes the shader arithmetic identical to
        // the unpatched form.
        addTerrestrialRefractionUniforms(shader);

        // --- Vertex shader: pass world position and barycentric coords ---
        // V5 shadows: Three's stock <shadowmap_vertex> chunk poisons
        // vDirectionalShadowCoord with NaN for geometries that lack a
        // 'normal' vertex attribute — which Google Photorealistic 3D Tiles
        // do (their BufferGeometry has only position, uv, barycentric).
        //
        // Chain of failure:
        //   1. WebGL feeds (0,0,0) for the missing 'normal' attribute.
        //   2. <defaultnormal_vertex>: transformedNormal = normalMatrix * (0,0,0) = (0,0,0).
        //   3. <shadowmap_vertex>:
        //        shadowWorldNormal = inverseTransformDirection(transformedNormal, viewMatrix)
        //        which is normalize(vec3(0,0,0)) = NaN.
        //   4. shadowWorldPosition = worldPosition + NaN * shadowNormalBias = NaN.
        //      (NaN * 0 is also NaN per IEEE 754, so just zeroing
        //      shadowNormalBias doesn't rescue this.)
        //   5. vDirectionalShadowCoord = directionalShadowMatrix * NaN = NaN.
        //   6. After /w, frustum/depth comparisons all fail; getShadow()
        //      falls through and returns 1.0 — no visible shadow reception.
        //
        // The CesiumOSMBuildings case happens to look mostly OK only
        // because building shadows are normally observed on terrain
        // (which has its own shader and normals), not on the buildings
        // themselves. Google PR has roads and buildings in a single
        // photogrammetric mesh, so the road-receives-shadow case is
        // exactly what fails.
        //
        // Fix: pass both verified-good ECEF world position and tile-local
        // position through to the fragment shader, then replace Three's
        // directional direct-light shadow lookup with one that derives its
        // receiver coordinate from a CPU-composed local-to-shadow matrix.
        shader.vertexShader = shader.vertexShader.replace(
            '#include <common>',
            `#include <common>
attribute vec3 barycentric;
varying vec3 vBarycentric;
varying vec3 vWorldPositionDN;
varying vec3 vLocalPositionDN;
varying vec2 vDNUv;`
        );

        const vertexInjection =
            `vec4 sitrecLocalPositionDN = vec4(transformed, 1.0);
#ifdef USE_BATCHING
sitrecLocalPositionDN = batchingMatrix * sitrecLocalPositionDN;
#endif
#ifdef USE_INSTANCING
sitrecLocalPositionDN = instanceMatrix * sitrecLocalPositionDN;
#endif
vWorldPositionDN = (modelMatrix * sitrecLocalPositionDN).xyz;
vLocalPositionDN = sitrecLocalPositionDN.xyz;
vBarycentric = barycentric;
vDNUv = uv;`;

        if (shader.vertexShader.includes('#include <worldpos_vertex>')) {
            shader.vertexShader = shader.vertexShader.replace(
                '#include <worldpos_vertex>',
                `#include <worldpos_vertex>
${vertexInjection}`
            );
        } else {
            shader.vertexShader = shader.vertexShader.replace(
                '#include <project_vertex>',
                `#include <project_vertex>
${vertexInjection}`
            );
        }

        // Applied last so it sees the finished vertex shader. Safe to compose
        // with the injection above: that only fills varyings from `transformed`
        // and modelMatrix, while this rewrites gl_Position and leaves
        // mvPosition — and therefore vWorldPositionDN, the normals and the
        // shadow receiver coordinates — physical.
        shader.vertexShader = patchTerrestrialRefractionVertexShader(shader.vertexShader).vertexShader;

        // --- Fragment shader: darken night side and use Sitrec shadow coords ---
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <common>',
            `#include <common>
uniform vec3 sunDirection;
uniform vec3 earthCenter;
uniform bool useDayNight;
uniform float sunGlobalTotal;
uniform float sunAmbientIntensity;
uniform float sunNightAmbientIntensity;
uniform float tileOutputGamma;
uniform bool showBuildingEdges;
uniform bool showTileEdges;
varying vec3 vWorldPositionDN;
varying vec3 vLocalPositionDN;
varying vec3 vBarycentric;
varying vec2 vDNUv;
#ifdef SITREC_TILE_WATER
${waterUniformsGLSL}

// Where the water is, for a mesh that carries neither map imagery nor a tile
// UV — the two things the terrain uses to answer this. See WaterMaskGeo.js.
uniform float waterGeoActive;
uniform sampler2D waterGeoMask;
uniform vec4 waterGeoRect;
uniform vec3 waterPlaneOrigin;
uniform vec3 waterPlaneNormal;
uniform float waterPlaneBand;
uniform float waterPlaneRadius;

// How much further the height band reaches below the sea than above it — see
// sitrecTileWaterMask for why the two directions are different problems.
#define BELOW_BAND_FACTOR 4.0

${waterShadeGLSL}

// How much of this fragment is water, 0..1, and where the sea surface under it
// is. Three independent tests, all of which have to pass:
//
//  (a) THE MAP SAYS SO. A coverage mask rasterised from real water polygons,
//      looked up by this fragment's own latitude and longitude.
//  (b) IT IS AT SEA LEVEL. The mask is a plan view, so the pier deck, the
//      hillside behind the beach and the boats moored off it are all "water" to
//      it. Height above the sea is what separates them, and it is the only
//      thing that can.
//  (c) IT FACES THE SKY. A piling at the waterline passes both tests above and
//      is still not a water surface.
//
// seaPos comes back as the point on the sea surface under the fragment. The
// photogrammetry's own sea is bumpy by a few metres, and every water quantity
// downstream — the wave phase, the mirror lookup — is a function of position on
// a FLAT surface, so shading is done at the surface the water actually has
// rather than at the mesh's guess about it. The mesh keeps its own depth, so
// occlusion by the pier is unaffected.
float sitrecTileWaterMask(vec3 worldPos, vec3 worldNormal, out vec3 seaPos) {
    seaPos = worldPos;
    if (waterGeoActive < 0.5) return 0.0;

    // Geodetic latitude and longitude. The elevation angle of the ELLIPSOID
    // NORMAL is the geodetic latitude by definition, so squashing the radial by
    // waterUpSquash — which the wave code needs anyway — gets it for nothing,
    // where the geocentric radial would be out by up to 0.19 degrees, or 21 km.
    vec3 fromCenter = worldPos - earthCenter;
    vec3 up = normalize(vec3(fromCenter.xy, fromCenter.z * waterUpSquash));
    float lat = atan(up.z, length(up.xy));
    float lon = atan(fromCenter.y, fromCenter.x);

    // Normalised Web Mercator, then this fragment's place in the mask square.
    // 0.15915494 is 1/(2*pi).
    float mx = lon * 0.15915494 + 0.5;
    float my = 0.5 - log(tan(0.78539816 + lat * 0.5)) * 0.15915494;
    // fract, not a plain subtraction, because mercator x is periodic: a mask
    // centred on the antimeridian has a left edge below 0 or above 1, and the
    // fragments on its far side have wrapped round to the other end of the
    // range. fract gives the distance EAST of the left edge either way, which
    // is the coordinate wanted, and lands outside 0..1 for anything not in the
    // square exactly as the plain difference did.
    vec2 uv = vec2(fract(mx - waterGeoRect.x), my - waterGeoRect.y) * waterGeoRect.z;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;

    float mask = texture2D(waterGeoMask, uv).r;
    if (mask <= 0.0) return 0.0;

    // Fade out ACROSS the mask's edge rather than stopping at it. The mask
    // covers a finite square of ground and the sea does not, so somewhere out
    // there the shading has to end; a hard stop puts a straight line across
    // open water, which is the one thing the eye is guaranteed to find.
    vec2 edge = smoothstep(vec2(0.0), vec2(0.04), uv)
              * (1.0 - smoothstep(vec2(0.96), vec2(1.0), uv));
    mask *= edge.x * edge.y;
    if (mask <= 0.0) return 0.0;

    // Height above the SEA, not above the water PLANE. The plane is flat and
    // the sea is not: by 12 km out the sea has already dropped 11 m below its
    // own tangent plane, which is more than the band, so without the sagitta
    // term the far half of the bay would fail the height test. The correction
    // is d^2/2R, wrong by d^4/8R^3 — two centimetres at 12 km.
    vec3 rel = worldPos - waterPlaneOrigin;
    float h = dot(rel, waterPlaneNormal);
    float horizontal2 = max(dot(rel, rel) - h * h, 0.0);
    float alt = h + horizontal2 / (2.0 * waterPlaneRadius);

    // ASYMMETRIC, and that is the whole trick. One tolerance cannot do this job:
    // measured against the pier at Santa Monica, 4 m leaves patches of open sea
    // unshaded and 20 m starts shading the pier deck.
    //
    // The two directions are not the same problem. Nothing is ABOVE the sea
    // except structures — a deck, a boat, the beach — so up there the tolerance
    // only has to cover the photogrammetry's noise, and tight is right. BELOW
    // the sea there is nothing to be confused with, only the mesh dipping under
    // where the surface should be, and that dip was measured at 10 m over open
    // water. So the band reaches down four times as far as it reaches up, and
    // both jobs are done by the one control.
    float band = alt > 0.0 ? waterPlaneBand : waterPlaneBand * BELOW_BAND_FACTOR;
    mask *= 1.0 - smoothstep(band * 0.5, band, abs(alt));
    if (mask <= 0.0) return 0.0;

    // Deliberately generous. Google's sea is photogrammetry and its triangles
    // wander by tens of degrees, so a tight test speckles the water; a piling
    // or a hull side is near enough vertical to fail this anyway.
    mask *= smoothstep(0.15, 0.5, dot(worldNormal, up));

    seaPos = worldPos - up * alt;
    return mask;
}
#endif
${this.useSitrecShadowCoords ? `#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
uniform mat4 sitrecDirectionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
uniform mat4 sitrecDirectionalShadowWorldMatrix[ NUM_DIR_LIGHT_SHADOWS ];
#endif` : ``}`
        );

        if (this.useSitrecShadowCoords) {
            // Google PR tiles can lack vertex normals, making Three's stock
            // vDirectionalShadowCoord NaN. Replace the include with a patched
            // copy of the chunk so only direct sunlight is attenuated.
            const sitrecLightsFragmentBegin = ShaderChunk.lights_fragment_begin.replace(
                'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;',
                `vec3 sitrecShadowWorldNormal = inverseTransformDirection( normal, viewMatrix );
			vec4 sitrecShadowCoord =
				sitrecDirectionalShadowMatrix[ i ] * vec4( vLocalPositionDN, 1.0 )
				+ sitrecDirectionalShadowWorldMatrix[ i ] * vec4( sitrecShadowWorldNormal * directionalLightShadow.shadowNormalBias, 0.0 );
			directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, sitrecShadowCoord ) : 1.0;`
            );
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <lights_fragment_begin>',
                sitrecLightsFragmentBegin
            );
        }

        // After the full PBR pipeline (including dithering), darken fragments
        // that are on the night side of the earth based on global position.
        // The PBR result already has correct local shading from scene lights;
        // we just attenuate toward ambient for the dark hemisphere.
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <dithering_fragment>',
            `#include <dithering_fragment>
if (showBuildingEdges) {
    // Screen-space anti-aliased wireframe via barycentric coords
    vec3 d = fwidth(vBarycentric);
    vec3 a3 = smoothstep(vec3(0.0), d * 1.2, vBarycentric);
    float edgeFactor = min(min(a3.x, a3.y), a3.z);
    vec3 edgeColor = vec3(0.25);
    gl_FragColor.rgb = mix(edgeColor, gl_FragColor.rgb, edgeFactor);
}
if (showTileEdges) {
    // Magenta ~1-pixel border around each tile, anti-aliased.
    // vUv runs 0..1 across the tile; fwidth(vUv) gives UV change per pixel,
    // so dividing distance-to-edge by that yields pixel distance to the
    // nearest tile edge regardless of zoom. This is the same screen-space
    // derivative trick used by the building-edges path above (which uses
    // barycentric coords for per-triangle edges); here we use the tile UV
    // for per-tile boundaries.
    //
    // The max(uvD) < 0.5 guard skips sub-pixel tiles (where the whole tile
    // is essentially within the edge-fade range and would render solid
    // magenta). Triggered most visibly by the "Main Use Look Layers" debug
    // toggle showing lookView's high-zoom tiles through mainView's wider
    // FOV camera.
    vec2 uvD = fwidth(vDNUv);
    // min(uvD) > 1e-5 also guards against skirt geometry, whose UV stays
    // constant along one axis (the skirt is extruded down from a tile edge)
    // and would otherwise render solid magenta because pxFromEdge clamps to 0.
    if (max(uvD.x, uvD.y) < 0.5 && min(uvD.x, uvD.y) > 1e-5) {
        vec2 distToEdge = min(vDNUv, vec2(1.0) - vDNUv);
        float pxFromEdge = min(distToEdge.x / max(uvD.x, 1e-7),
                               distToEdge.y / max(uvD.y, 1e-7));
        float borderFactor = 1.0 - smoothstep(0.5, 1.0, pxFromEdge);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0, 0.0, 1.0), borderFactor);
    }
}
if (useDayNight) {
    vec3 globalNormal = normalize(vWorldPositionDN - earthCenter);
    vec3 sunNorm = normalize(sunDirection);
    float globalIntensity = max(dot(globalNormal, sunNorm), -0.1);
    float dayFactor = smoothstep(-0.1, 0.1, globalIntensity);
    // gl_FragColor already includes PBR lighting, including ambient.
    // Normalize fixed ambient against total global light to avoid over-darkening.
    // Sun scattering is excluded here: it lifts local shadow floors on the
    // daylight side, but should not brighten the planet's dark hemisphere.
    float normalizedAmbient = sunNightAmbientIntensity / max(sunGlobalTotal, 0.0001);
    float nightAttenuation = clamp(normalizedAmbient, 0.35, 1.0);
    gl_FragColor.rgb *= mix(nightAttenuation, 1.0, dayFactor);
}
if (abs(tileOutputGamma - 1.0) > 0.0001) {
    gl_FragColor.rgb = pow(max(gl_FragColor.rgb, vec3(0.0)), vec3(tileOutputGamma));
}
#ifdef SITREC_TILE_WATER
// Water, added LAST — after the day/night attenuation, exactly as the terrain
// material adds it after its own day/night mix. The reflection carries its own
// night factor and must not be attenuated twice.
//
// gl_FragColor is linear radiance here, not sRGB: Sitrec renders into
// half-float srgb-linear targets and the copy-to-screen shader does the
// encoding, so <colorspace_fragment> above was a no-op. That is the same space
// the terrain adds its reflection in, which is why one chunk serves both.
if (waterReflection > 0.0) {
    vec3 seaPos;
    vec3 waterWorldNormal = inverseTransformDirection(normal, viewMatrix);
    float tileWaterMask = sitrecTileWaterMask(vWorldPositionDN, waterWorldNormal, seaPos);
    if (tileWaterMask > 0.0) {
        gl_FragColor.rgb = sitrecWaterShade(gl_FragColor.rgb, tileWaterMask, seaPos);
    }
}
#endif`
        );
    }

    /**
     * Switch the water branch on or off for THIS material.
     *
     * Recompiles, because the branch is a #define — hence the guard: called on
     * every loaded tile whenever the user toggles the feature, and a redundant
     * needsUpdate would rebuild every tile program for nothing.
     */
    setTileWater(on) {
        const want = !!on;
        this.defines = this.defines ?? {};
        if (!!this.defines.SITREC_TILE_WATER === want) return;
        if (want) this.defines.SITREC_TILE_WATER = "";
        else delete this.defines.SITREC_TILE_WATER;
        this.needsUpdate = true;
    }

    setTileOutputGamma(value) {
        this.tileOutputGamma = value;
        if (this._dayNightUniforms?.tileOutputGamma) {
            this._dayNightUniforms.tileOutputGamma.value = value;
        }
    }

    copy(source) {
        // Material.copy() would bring the SOURCE's defines across, and the
        // source here is a streamed glTF material that has none — which would
        // silently clear the water define this material was constructed with.
        const defines = this.defines;
        super.copy(source);
        this.defines = defines;
        this.flatShading = true;
        this.setTileOutputGamma(source.tileOutputGamma ?? 1.0);
        this.useSitrecShadowCoords = source.useSitrecShadowCoords ?? this.useSitrecShadowCoords ?? false;
        this.onBeforeCompile = this._onBeforeCompile.bind(this);
        return this;
    }

    customProgramCacheKey() {
        // three already folds material.defines into the program cache key, so
        // the water variant is separated either way; naming it here as well
        // keeps the key readable in a shader dump.
        return `${CACHE_KEY}.${this.useSitrecShadowCoords ? "sitrec" : "stock"}`
            + `.${this.defines?.SITREC_TILE_WATER !== undefined ? "water" : "dry"}`;
    }

    static fromMaterial(source, options = {}) {
        const mat = new DayNightStandardMaterial({
            tileOutputGamma: options.tileOutputGamma ?? 1.0,
            useSitrecShadowCoords: options.useSitrecShadowCoords ?? false,
        });

        if (source.isMeshStandardMaterial) {
            mat.copy(source);
        } else {
            if (source.map) mat.map = source.map;
            if (source.color) mat.color.copy(source.color);
            if (source.transparent !== undefined) mat.transparent = source.transparent;
            if (source.opacity !== undefined) mat.opacity = source.opacity;
            if (source.side !== undefined) mat.side = source.side;
            if (source.alphaTest !== undefined) mat.alphaTest = source.alphaTest;
            if (source.vertexColors !== undefined) mat.vertexColors = source.vertexColors;
            if (source.normalMap) mat.normalMap = source.normalMap;
            if (source.normalScale) mat.normalScale.copy(source.normalScale);
            if (source.aoMap) mat.aoMap = source.aoMap;
            if (source.emissiveMap) mat.emissiveMap = source.emissiveMap;
            if (source.emissive) mat.emissive.copy(source.emissive);
        }

        mat.setTileOutputGamma(options.tileOutputGamma ?? mat.tileOutputGamma ?? 1.0);
        mat.onBeforeCompile = mat._onBeforeCompile.bind(mat);
        // Flat Earth rendering: patch at creation so a freshly streamed 3D
        // tile lands on the disc on its first frame instead of flashing at
        // its globe position until the 500 ms scene sweep finds it. MUST
        // come after the onBeforeCompile rebind above, which would clobber
        // the patch's chained wrapper. Null when the mode is off.
        Globals.flatEarthPatchMaterial?.(mat);
        mat.needsUpdate = true;
        return mat;
    }
}
