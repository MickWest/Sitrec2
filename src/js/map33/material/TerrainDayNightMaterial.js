import {Color, ShaderMaterial, UniformsLib, UniformsUtils, Vector3} from "three";
import {sharedUniforms} from "./SharedUniforms";
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

            uniform float waterReflection;
            uniform float waterNightFactor;
            uniform vec3 waterDayColor;
            uniform samplerCube waterSkyCube;
            uniform samplerCube waterOcclusionCube;
            uniform float waterOcclusion;
            uniform vec3 waterColor;
            uniform float waterTolerance;
            uniform float waterStrength;
            uniform float waterDarken;
            uniform float waterWaveStrength;
            uniform float waterWaveLength;
            uniform float waterWaveTime;
            uniform vec3 waterWaveOrigin;
            uniform float waterUpSquash;
            uniform vec4 waterOrthoDir;

            uniform float waterMirror;
            uniform sampler2D waterMirrorMap;
            uniform mat4 waterMirrorMatrix;
            uniform vec3 waterMirrorOrigin;
            uniform float waterMirrorDistance;

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
                    // Detect water by the raw (pre-lighting) map colour. This is
                    // the OSM water fill by default; the tolerance has to absorb
                    // antialiased shorelines and PNG resampling.
                    float colorDist = distance(textureColor.rgb, waterColor);
                    float waterMask = 1.0 - smoothstep(waterTolerance * 0.5, waterTolerance, colorDist);

                    if (waterMask > 0.0) {
                        // Pull the flat map fill down towards what water really
                        // looks like, so the reflection carries the surface
                        // instead of being washed out by map blue. By day that
                        // target is deep-water dark blue; by night it goes to
                        // black, where only reflected light remains.
                        vec3 waterBase = sRGBTransferEOTF(vec4(waterDayColor, 1.0)).rgb
                                       * (1.0 - waterNightFactor);
                        linearColor.rgb = mix(linearColor.rgb, waterBase, waterDarken * waterMask);

                        // Geodetic up, not the geocentric radial: on WGS84 they
                        // differ by up to 0.19deg, which would tilt the whole
                        // reflected sky by twice that. waterUpSquash is (a/b)^2
                        // for the active earth model (1.0 when it's a sphere).
                        vec3 fromCenter = vWorldPosition - earthCenter;
                        vec3 up = normalize(vec3(fromCenter.x, fromCenter.y, fromCenter.z * waterUpSquash));

                        // Pole-safe tangent basis for the wave field.
                        vec3 ref = abs(up.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
                        vec3 east = normalize(cross(ref, up));
                        vec3 north = cross(up, east);

                        // Wave phase from a nearby origin — see waterWaveOrigin.
                        vec3 wp = vWorldPosition - waterWaveOrigin;
                        float e = dot(wp, east);
                        float n = dot(wp, north);
                        float k = 6.2831853 / max(waterWaveLength, 0.1);
                        float t = waterWaveTime;

                        // Three octaves of directional ripples, differentiated
                        // analytically to get the surface slope directly.
                        float p1 = e * k + t;
                        float p2 = (e * 0.6 + n * 0.8) * k * 1.7 - t * 1.3;
                        float p3 = (n * 0.6 - e * 0.8) * k * 2.9 + t * 0.7;
                        float slopeE = k * cos(p1)
                                     + k * 1.7 * 0.6 * 0.5 * cos(p2)
                                     - k * 2.9 * 0.8 * 0.25 * cos(p3);
                        float slopeN = k * 1.7 * 0.8 * 0.5 * cos(p2)
                                     + k * 2.9 * 0.6 * 0.25 * cos(p3);

                        vec3 waveNormal = normalize(up + (slopeE * east + slopeN * north) * waterWaveStrength);

                        // Orthographic cameras have no eye point, so the ray is
                        // the constant view direction rather than a difference.
                        vec3 viewDir = waterOrthoDir.w > 0.5
                            ? normalize(waterOrthoDir.xyz)
                            : normalize(vWorldPosition - cameraPosition);

                        vec3 reflected = reflect(viewDir, waveNormal);

                        // Schlick Fresnel for water (F0 = 0.02): almost a
                        // mirror at grazing angles, nearly nothing straight down.
                        float cosTheta = max(dot(-viewDir, waveNormal), 0.0);
                        float fresnel = 0.02 + 0.98 * pow(1.0 - cosTheta, 5.0);

                        if (waterMirror > 0.0) {
                            // PLANAR MIRROR MODE. The whole world has been
                            // re-rendered from a camera mirrored through the
                            // lake's plane, so the answer to "what is along this
                            // reflected ray" is already in a texture — the only
                            // question is where in it.
                            //
                            // For a fragment exactly on the mirror plane with an
                            // unperturbed normal, the mirror camera's ray THROUGH
                            // THAT FRAGMENT is the reflected ray, so projecting
                            // the fragment itself gives the exact lookup, and any
                            // point along the ray gives the same answer.
                            //
                            // Waves break that: the reflected ray tilts away from
                            // the mirror camera's ray. Walking waterMirrorDistance
                            // along the TILTED ray and projecting that point picks
                            // the mirror ray that meets ours at that distance —
                            // exact if the reflected scenery really is that far
                            // away, and gracefully wrong otherwise. It costs one
                            // matrix multiply and gets the perspective for free:
                            // near water ripples strongly, water near the horizon
                            // barely moves, which is what real water does. A flat
                            // screen-space offset would do the opposite.
                            //
                            // The same term quietly absorbs part of the Earth's
                            // curvature: 'up' here is the geodetic up AT THIS
                            // FRAGMENT, which tilts away from the plane normal by
                            // (distance / earthRadius) as the lake recedes.
                            // Relative to waterMirrorOrigin, never raw ECEF —
                            // the matrix has the origin's translation already
                            // folded in on the CPU in double precision, because
                            // doing that cancellation here in float32 costs
                            // metres of accuracy. Same reason waterWaveOrigin
                            // exists for the wave phase above.
                            vec4 mirrorClip = waterMirrorMatrix * vec4(
                                (vWorldPosition - waterMirrorOrigin)
                                    + reflected * waterMirrorDistance, 1.0);
                            if (mirrorClip.w > 0.0) {
                                vec2 muv = mirrorClip.xy / mirrorClip.w;
                                // Ripples can push the lookup off the edge of the
                                // render, where there is no information. Fade out
                                // instead of clamping, which would smear the edge
                                // pixel into a streak.
                                vec2 fade = smoothstep(vec2(0.0), vec2(0.03), muv)
                                          * (1.0 - smoothstep(vec2(0.97), vec2(1.0), muv));
                                vec3 mirrorColor = texture2D(waterMirrorMap, clamp(muv, 0.0, 1.0)).rgb;
                                linearColor.rgb += mirrorColor
                                    * (waterMask * fresnel * waterStrength * fade.x * fade.y);
                            }
                        } else if (dot(reflected, up) > 0.0) {
                            // SKY CUBE MODE. Only sample the sky hemisphere — a
                            // ray bent below the horizon by a steep wave would
                            // otherwise pick up the (black) ground half of the
                            // cube and punch holes.
                            vec3 sky = textureCube(waterSkyCube, reflected).rgb;

                            // Mask out sky the terrain is standing in front of.
                            // The silhouette is captured from the observer, so
                            // this is exact underfoot and approximate for the
                            // far side of the lake — but it is the difference
                            // between reflecting a star and reflecting a star
                            // that is behind a hill. Bilinear filtering of the
                            // mask softens the ridge line for free.
                            if (waterOcclusion > 0.0) {
                                float visible = textureCube(waterOcclusionCube, reflected).r;
                                sky *= mix(1.0, visible, waterOcclusion);
                            }

                            // The cube already carries the right sources for the
                            // time of day — stars and moon at night, the Sun's
                            // disc when it is up — so no day/night term here.
                            linearColor.rgb += sky * (waterMask * fresnel * waterStrength);
                        }
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
