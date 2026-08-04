import {MeshStandardMaterial, ShaderChunk, Vector3} from "three";
import {sharedUniforms} from "./SharedUniforms";
import {Globals} from "../../../Globals";
import {
    addTerrestrialRefractionUniforms,
    patchTerrestrialRefractionVertexShader,
} from "../../../atmosphere/terrestrialRefraction";

const CACHE_KEY = "DayNightStandardMaterial.v8terrestrialrefraction";

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
}`
        );
    }

    setTileOutputGamma(value) {
        this.tileOutputGamma = value;
        if (this._dayNightUniforms?.tileOutputGamma) {
            this._dayNightUniforms.tileOutputGamma.value = value;
        }
    }

    copy(source) {
        super.copy(source);
        this.flatShading = true;
        this.setTileOutputGamma(source.tileOutputGamma ?? 1.0);
        this.useSitrecShadowCoords = source.useSitrecShadowCoords ?? this.useSitrecShadowCoords ?? false;
        this.onBeforeCompile = this._onBeforeCompile.bind(this);
        return this;
    }

    customProgramCacheKey() {
        return `${CACHE_KEY}.${this.useSitrecShadowCoords ? "sitrec" : "stock"}`;
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
        mat.needsUpdate = true;
        return mat;
    }
}
