import {Color, ShaderMaterial, UniformsLib, UniformsUtils, Vector3} from "three";
import {sharedUniforms} from "./SharedUniforms";
import {waterShadeGLSL, waterUniformsGLSL} from "../../../water/WaterShading.glsl.js";
import {Globals} from "../../../Globals";
import {
    addTerrestrialRefractionUniforms,
    TERRESTRIAL_REFRACTION_VERTEX_GLSL,
} from "../../../atmosphere/terrestrialRefraction";

/**
 * Creates a custom shader material for terrain tiles that combines:
 * - Global day/night lighting based on sun direction and position on Earth
 * - Local terrain shading based on polygon normals
 * 
 * @param {Texture} texture - The texture to apply to the terrain
 * @param {number} terrainShadingStrength - How much terrain shading to apply (0-1), default 0.3 (30% variation)
 * @param {boolean} doubleSided - Whether to render both sides of the geometry, default false
 * @param {number} transparency - Transparency of the terrain (0-1), where 0 is fully transparent and 1 is fully opaque, default 1
 * @returns {ShaderMaterial} The custom shader material
 */
export function createTerrainDayNightMaterial(texture, terrainShadingStrength = 0.3, doubleSided = false, transparency = 1, waterMask = null) {
    // V5 shadows: merge Three.js's lights/shadows uniforms so a single
    // DirectionalLight's shadow map can darken this material. Without
    // UniformsLib.lights + the shadow chunks below, ShaderMaterial.lights=true
    // would have no effect — receiveShadow=true on the mesh is meaningless if
    // the fragment shader never samples the shadow map.
    // Merge built-in lights uniforms (needed by shadowmap chunks) with our
    // own. After merge we replace shared-reference uniforms (map texture,
    // sunDirection, sharedUniforms.*) with the live references so the rest of
    // Sitrec's update path keeps working.
    const mergedUniforms = UniformsUtils.merge([
        UniformsLib.lights,
        {
            map: { value: null },
            // PER-TILE, deliberately not in sharedUniforms: 0 marks a tile
            // whose "water" cannot be the body being reflected — a mountain
            // whose only blue pixels are streams and rivers, hundreds of metres
            // above the lake. Set by CNodeWaterReflection each frame; 1 by
            // default so any tile it never reaches behaves exactly as before.
            tileWaterAllowed: { value: 1.0 },
            // PER-TILE for the same reason as map itself: every tile has its own
            // mask texture, so these cannot live in sharedUniforms. hasWaterMask
            // stays 0 until a mask actually arrives, which is what makes the
            // color test the fallback rather than something to switch off.
            waterMaskMap: { value: null },
            hasWaterMask: { value: 0.0 },
            sunDirection: { value: new Vector3() },
            earthCenter: { value: new Vector3(0, 0, 0) },
            terrainShadingStrength: { value: terrainShadingStrength },
            transparency: { value: transparency },
            fogColor: { value: new Color(0xffffff) },
            fogNear: { value: 1 },
            fogFar: { value: 1000 },
            fogDensity: { value: 0.00025 },
        },
    ]);
    mergedUniforms.map.value = texture;
    mergedUniforms.waterMaskMap.value = waterMask;
    mergedUniforms.hasWaterMask.value = waterMask ? 1.0 : 0.0;
    mergedUniforms.sunDirection = { value: Globals.sunLight.position };
    for (const k of Object.keys(sharedUniforms)) {
        mergedUniforms[k] = sharedUniforms[k];
    }
    // Shared by reference, so one per-view update reaches every terrain tile.
    addTerrestrialRefractionUniforms({uniforms: mergedUniforms});
    const material = new ShaderMaterial({
        uniforms: mergedUniforms,
        side: doubleSided ? 2 : 0, // 2 = DoubleSide, 0 = FrontSide
        transparent: transparency < 1,
        fog: true,
        lights: true,
        vertexShader: `
            varying vec2 vUv;
            varying vec3 vNormal;
            varying vec3 vWorldPosition;
            varying vec4 vPosition;
            #include <common>
            #include <fog_pars_vertex>
            #include <shadowmap_pars_vertex>
            ${TERRESTRIAL_REFRACTION_VERTEX_GLSL}

            void main() {
                vUv = uv;

                // Transform normal to world space for local terrain shading
                vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);

                // Get world position for calculating global normal
                vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;

                // Calculate position for depth
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                // Terrestrial refraction — apparent position only. vWorldPosition
                // and vNormal above are computed from the model matrix directly
                // and stay physical, so day/night lighting, local terrain shading
                // and the shadow receiver coordinates below are unaffected.
                mvPosition.xyz = applyTerrestrialRefraction_chunk(mvPosition.xyz);
                vPosition = projectionMatrix * mvPosition;
                #include <fog_vertex>
                // shadowmap_pars_vertex expects transformed/transformedNormal
                // identifiers. transformed stays in tile-local coordinates
                // so Sitrec's stable receiver patch can avoid ECEF-scale
                // float math when projecting into the shadow map.
                vec3 transformed = position;
                vec3 transformedNormal = normalMatrix * normal;
                vec4 worldPosition = vec4(vWorldPosition, 1.0);
                #include <shadowmap_vertex>

                gl_Position = vPosition;
            }
        `,
        fragmentShader: `
            uniform sampler2D map;
            uniform vec3 sunDirection;
            uniform vec3 earthCenter;
            uniform float terrainShadingStrength;
            uniform float transparency;
            uniform float sunGlobalTotal;
            uniform float sunAmbientIntensity;
            uniform float sunNightAmbientIntensity;
            uniform float nearPlane;
            uniform float farPlane;
            uniform bool useDayNight;
            uniform bool showTileEdges;

            // Water surface shading, shared with the 3D-tiles material.
            // See src/water/WaterShading.glsl.js.
            ${waterUniformsGLSL}

            // Terrain's own way of FINDING water, which the shared chunk knows
            // nothing about: the OSM water fill to match, and the per-tile
            // vector mask that supersedes it where one was loaded.
            uniform vec3 waterColor;
            uniform float waterTolerance;
            uniform float waterMaxTileSize;
            uniform float cameraFocalLength;
            uniform float tileWaterAllowed;

            // PER-TILE water mask rasterised from vector water polygons, and the
            // flag saying this tile actually got one. See WaterMaskTiles.js.
            uniform sampler2D waterMaskMap;
            uniform float hasWaterMask;

            varying vec2 vUv;
            varying vec3 vNormal;
            varying vec3 vWorldPosition;
            varying vec4 vPosition;
            #include <common>
            #include <packing>
            #include <fog_pars_fragment>
            #include <lights_pars_begin>
            #include <shadowmap_pars_fragment>
            #include <shadowmask_pars_fragment>

            // The water surface, shared with DayNightStandardMaterial (the
            // Google 3D tiles). Carries the Ocean method's microfacet BRDF with
            // it — see src/water/WaterShading.glsl.js.
            ${waterShadeGLSL}
            
            void main() {
                // Get the base texture color
                vec4 textureColor = texture2D(map, vUv);
                
                // Calculate global normal (from earth center to this point)
                vec3 globalNormal = normalize(vWorldPosition - earthCenter);
                
                // Normalize sun direction
                vec3 sunNormal = normalize(sunDirection);
                
                // Calculate global day/night blend factor based on global normal
                float globalIntensity = max(dot(globalNormal, sunNormal), -0.1);
                float blendFactor = smoothstep(-0.1, 0.1, globalIntensity);
                
                // Calculate local terrain shading based on polygon normals
                // This gives us the angle between the terrain surface and the sun
                float localIntensity = dot(vNormal, sunNormal);
                
                // Map local intensity to the range [1.0 - terrainShadingStrength, 1.0]
                // So if terrainShadingStrength = 0.3:
                // - Surfaces facing sun get 1.0 (100% brightness)
                // - Surfaces facing away get 0.7 (70% brightness)
                float terrainShading = mix(1.0 - terrainShadingStrength, 1.0, localIntensity * 0.5 + 0.5);
                
                // V5 shadows: sample the directional-light shadow map. When
                // no shadow casters cover this fragment, getShadowMask()=1.0
                // so the day color is unchanged. Where covered, the mask drops
                // toward 0 and darkens ONLY the direct-sun contribution; the
                // ambient term stays unattenuated so raising the effective
                // ambient (Ambient Intensity plus daylight Sun Scattering)
                // washes shadows out the same way it washes out building dark
                // sides (which already do this via PBR).
                //
                // terrainShading is the surface-normal-to-sun modulation —
                // it's meaningful only for the directional component. Ambient
                // is omnidirectional, so it bypasses terrainShading. This
                // makes terrain-in-shadow match a building's dark side at the
                // same ambient level (both = albedo × ambient).
                float shadowMask = getShadowMask();
                float ambient = sunAmbientIntensity;
                float directLight = max(0.0, sunGlobalTotal - ambient);

                vec4 dayColor = textureColor * (ambient + directLight * terrainShading * shadowMask);
                
                // Calculate night color from fixed ambient only. Daylight sun
                // scattering belongs in local shadow floors, not the dark
                // hemisphere.
                vec4 nightColor = textureColor * sunNightAmbientIntensity;
                
                // Blend between night and day based on global position
                vec4 finalColor;
                if (useDayNight) {
                    finalColor = mix(nightColor, dayColor, blendFactor);
                } else {
                    // When day/night is disabled (noMainLighting mode), use plain texture
                    // with no lighting calculations at all for true debugging
                    finalColor = textureColor;
                }
                
                // Magenta border around each tile (debug overlay). Uses screen-
                // space derivatives of vUv to get a constant ~1-pixel-wide line
                // regardless of zoom. Mirrors the building-edges trick in
                // DayNightStandardMaterial — there it's per-triangle from
                // barycentric coords; here it's per-tile from the 0..1 UV.
                if (showTileEdges) {
                    vec2 uvD = fwidth(vUv);
                    // Two guards on rendering the magenta border:
                    //
                    // (1) max(uvD) < 0.5 — skip sub-pixel tiles. uvD is the
                    //     UV change per screen pixel; uvD > ~0.5 means the
                    //     tile spans less than 2 screen pixels, so the whole
                    //     tile is within the smoothstep range and renders
                    //     solid magenta. Triggered by lookView's high-zoom
                    //     tiles being shown through mainView's wider-FOV
                    //     camera in the "Main Use Look Layers" debug.
                    //
                    // (2) min(uvD) > 1e-5 — skip skirt geometry. Skirts share
                    //     this material with the tile, but their UVs are
                    //     constant along one axis (the skirt is extruded
                    //     downward from a tile edge, so vUv.y stays at 0 or 1
                    //     across the entire skirt). That makes uvD on that
                    //     axis essentially zero → distToEdge/uvD on that
                    //     axis is 0 → pxFromEdge clamps to 0 everywhere on
                    //     the skirt → the whole skirt renders solid magenta.
                    //     A non-degenerate tile mesh has uvD non-zero on
                    //     both axes.
                    if (max(uvD.x, uvD.y) < 0.5 && min(uvD.x, uvD.y) > 1e-5) {
                        vec2 distToEdge = min(vUv, vec2(1.0) - vUv);
                        float pxFromEdge = min(distToEdge.x / max(uvD.x, 1e-7),
                                               distToEdge.y / max(uvD.y, 1e-7));
                        float borderFactor = 1.0 - smoothstep(0.5, 1.0, pxFromEdge);
                        finalColor.rgb = mix(finalColor.rgb, vec3(1.0, 0.0, 1.0), borderFactor);
                    }
                }

                // Set alpha based on transparency parameter
                finalColor.a = transparency;

                // Convert sRGB-space output to linear to match standard materials.
                // The copy-to-screen shader applies sRGB encoding, so this round-trips
                // back to the original sRGB values while keeping the RT consistently linear.
                vec4 linearColor = sRGBTransferEOTF(finalColor);

                // Water Reflection. waterReflection is both the master gate and
                // the night factor (1 - skyOpacity), so reflections fade out at
                // dawn exactly as the night sky itself does. The cube holds the
                // night sky rendered from the origin, in LINEAR radiance — which
                // is why this is added AFTER the sRGB->linear conversion above.
                if (waterReflection > 0.0) {
                    // Where a vector water mask was loaded for this tile, it IS
                    // the answer: real water polygons, rasterised with the
                    // canvas's antialiasing, so the shoreline is fractional
                    // coverage rather than a color guess. Otherwise fall back to
                    // detecting water by the raw (pre-lighting) map color — the
                    // OSM water fill, whose tolerance has to absorb antialiased
                    // shorelines and PNG resampling.
                    float colorDist = distance(textureColor.rgb, waterColor);
                    float colorMask = 1.0 - smoothstep(waterTolerance * 0.5, waterTolerance, colorDist);
                    float waterMask = hasWaterMask > 0.5
                        ? texture2D(waterMaskMap, vUv).r
                        : colorMask;

                    // Tiles whose blue pixels cannot be the body being reflected
                    // — mountainsides whose only water is streams and rivers,
                    // hundreds of metres above the lake — are switched off whole
                    // by the CPU, which can see the tile's elevation range and
                    // how much of it is water. Reflecting a river using a plane
                    // fitted to the sea is meaningless.
                    waterMask *= tileWaterAllowed;


                    // Stop trusting the color test once the tile under this
                    // fragment gets too coarse. Distant water is drawn by
                    // enormous low-zoom tiles that still carry only a 512px
                    // texture, so one texel spans kilometres and the flat water
                    // fill is averaged together with the coastline — the test
                    // then passes in patches and the reflection breaks into
                    // blotches. Fading the MASK (not just the reflection) means
                    // distant water simply reverts to plain map color.
                    //
                    // vUv runs 0..1 across the tile, so
                    //   tile width in metres = (metres per pixel) / (uv per pixel)
                    // and metres per pixel comes from the focal length. NOT from
                    // fwidth(vWorldPosition): at ECEF magnitudes float32 quantises
                    // world position to ~0.4 m, so its derivative is pure noise.
                    //
                    // Does NOT apply to a vector mask. The fade exists purely
                    // because the COLOR test degrades when a texel spans
                    // kilometres; a rasterised polygon does not degrade, it just
                    // gets smaller. Left on, it fades real water out on the
                    // coarse tiles that draw the distance, putting a hard-edged
                    // rectangle of plain map color in the middle of the sea.
                    if (hasWaterMask < 0.5 && waterMaxTileSize > 0.0 && waterMask > 0.0) {
                        float uvPerPixel = length(fwidth(vUv));
                        float metresPerPixel = length(vWorldPosition - cameraPosition)
                                             / max(cameraFocalLength, 1.0);
                        float tileMetres = metresPerPixel / max(uvPerPixel, 1e-9);
                        waterMask *= 1.0 - smoothstep(waterMaxTileSize * 0.5,
                                                      waterMaxTileSize, tileMetres);
                    }

                    if (waterMask > 0.0) {
                        // Everything from here on is identical for terrain and
                        // for a Google 3D tile, so it lives in one place —
                        // src/water/WaterShading.glsl.js.
                        linearColor.rgb = sitrecWaterShade(
                            linearColor.rgb, waterMask, vWorldPosition);
                    }
                }

                gl_FragColor = linearColor;
                #include <fog_fragment>
                
                // Logarithmic depth. In an ORTHOGRAPHIC projection clip-space w is
                // a constant 1.0, which collapses this log formula to a single
                // depth for every fragment → catastrophic z-fighting (terraced
                // terrain). Fall back to the rasteriser's linear depth, matching
                // three.js's logdepthbuf_fragment path for non-perspective matrices.
                float w = vPosition.w;
                if (w == 1.0) {
                    gl_FragDepthEXT = gl_FragCoord.z;
                } else {
                    float z = (log2(max(nearPlane, 1.0 + w)) / log2(1.0 + farPlane)) * 2.0 - 1.0;
                    gl_FragDepthEXT = z * 0.5 + 0.5;
                }
            }
        `,
        // Enable depth writing + derivatives (fwidth, used by tile-edge overlay).
        extensions: {
            fragDepth: true,
            derivatives: true
        }
    });

    // Tag so consumers can identify a TerrainDayNight material for per-view cloning.
    material.userData.isTerrainDayNight = true;
    // Flat Earth rendering: patch at creation, not via the 500 ms scene
    // sweep — a tile activated on an LOD change must land on the disc on
    // its FIRST frame, or the swap briefly shows a hole where the new tile
    // still sits at its globe position. Null when the mode is off.
    Globals.flatEarthPatchMaterial?.(material);
    return material;
}

/**
 * Build a per-view clone of a TerrainDayNightMaterial.
 *
 * Why this is needed: Three.js's WebGLRenderer points
 * materialProperties.uniforms AT the material's own uniforms object (no
 * clone for ShaderMaterial). When BOTH renderers (mainView, lookView) use
 * the same terrain material, each renderer's setupLights() phase writes
 * its own lights state INTO material.uniforms.directionalShadowMatrix.value
 * (and the directionalLightShadows array). Last writer wins. The view that
 * rendered LAST has the right uniforms; the other ends up sampling the
 * wrong shadow camera/matrix.
 *
 * The fix is to give each view its own ShaderMaterial instance — and
 * therefore its own uniforms — while keeping every non-lights uniform
 * SHARED BY REFERENCE so live updates (Globals.sunLight.position,
 * sharedUniforms.*, the tile texture) still propagate to all views.
 */
export function cloneTerrainDayNightMaterialForView(orig) {
    // Fresh lights uniforms — each view gets its own arrays for
    // directionalLights / directionalLightShadows / directionalShadowMap /
    // directionalShadowMatrix / etc. These are what Three.js's setupLights
    // mutates; keeping them independent is the whole point of the clone.
    const freshLights = UniformsUtils.merge([UniformsLib.lights]);

    // Start from the fresh lights uniforms, then overlay non-lights
    // uniforms from `orig` BY REFERENCE so live values stay synced.
    const uniforms = {};
    for (const k of Object.keys(freshLights)) {
        uniforms[k] = freshLights[k];
    }
    for (const k of Object.keys(orig.uniforms)) {
        if (k in freshLights) continue; // skip lights — keep ours
        uniforms[k] = orig.uniforms[k]; // SHARED REFERENCE
    }

    const clone = new ShaderMaterial({
        uniforms,
        vertexShader: orig.vertexShader,
        fragmentShader: orig.fragmentShader,
        side: orig.side,
        transparent: orig.transparent,
        fog: orig.fog,
        lights: true,
        extensions: orig.extensions ? {...orig.extensions} : undefined,
    });
    clone.userData.isTerrainDayNight = true;
    clone.userData.isPerViewClone = true;
    // See createTerrainDayNightMaterial — per-view clones need the flat
    // earth patch at creation for the same first-frame reason.
    Globals.flatEarthPatchMaterial?.(clone);
    return clone;
}
