import {Color, ShaderMaterial, UniformsLib, UniformsUtils, Vector3} from "three";
import {sharedUniforms} from "./SharedUniforms";
import {Globals} from "../../../Globals";

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
export function createTerrainDayNightMaterial(texture, terrainShadingStrength = 0.3, doubleSided = false, transparency = 1) {
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
    mergedUniforms.sunDirection = { value: Globals.sunLight.position };
    for (const k of Object.keys(sharedUniforms)) {
        mergedUniforms[k] = sharedUniforms[k];
    }
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

            void main() {
                vUv = uv;

                // Transform normal to world space for local terrain shading
                vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);

                // Get world position for calculating global normal
                vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;

                // Calculate position for depth
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                vPosition = projectionMatrix * mvPosition;
                #include <fog_vertex>
                // shadowmap_pars_vertex expects vNormal/transformed/objectNormal
                // identifiers. We inline a minimal worldpos pass for the
                // shadowmap_vertex chunk to consume.
                vec3 transformedNormal = vNormal;
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
            uniform float nearPlane;
            uniform float farPlane;
            uniform bool useDayNight;
            uniform bool showTileEdges;

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
                // ambient term stays unattenuated so raising Ambient Intensity
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
                
                // Calculate night color (flat texture with ambient lighting, no terrain shading)
                vec4 nightColor = textureColor * sunAmbientIntensity;
                
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
                gl_FragColor = sRGBTransferEOTF(finalColor);
                #include <fog_fragment>
                
                // Logarithmic depth calculation (same as globe shader)
                float w = vPosition.w;
                float z = (log2(max(nearPlane, 1.0 + w)) / log2(1.0 + farPlane)) * 2.0 - 1.0;
                gl_FragDepthEXT = z * 0.5 + 0.5;
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
    return clone;
}
