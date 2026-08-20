import {Color, ShaderMaterial, UniformsLib, UniformsUtils, Vector3} from "three";
import {sharedUniforms} from "./SharedUniforms";
import {oceanBRDFChunk} from "../../../ocean/OceanBRDF.glsl.js";
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

            uniform float waterMaxTileSize;
            uniform float cameraFocalLength;
            uniform float tileWaterAllowed;

            // PER-TILE water mask rasterised from vector water polygons, and the
            // flag saying this tile actually got one. See WaterMaskTiles.js.
            uniform sampler2D waterMaskMap;
            uniform float hasWaterMask;

            uniform float waterMirror;
            uniform sampler2D waterMirrorMap;
            uniform mat4 waterMirrorMatrix;
            uniform vec3 waterMirrorOrigin;
            uniform float waterMirrorDistance;

            uniform float waterOcean;
            uniform vec2 waterSigma2;
            uniform vec2 waterWindDir;
            uniform vec3 waterUpwelling;
            uniform float waterIrradiance;
            uniform float waterWhitecap;
            uniform vec3 waterSunDir;
            uniform vec3 waterSunRadiance;
            uniform float waterSunSolidAngle;
            uniform float waterSunRadius;
            uniform vec3 waterMoonDir;
            uniform vec3 waterMoonRadiance;
            uniform float waterMoonSolidAngle;
            uniform float waterMoonRadius;
            uniform float waterPixelAngle;
            uniform float waterGlitterExposure;
            uniform vec3 waterSkyZenith;
            uniform vec3 waterSkyHorizon;
            uniform float waterMirrorFov;
            uniform float waterGustiness;
            uniform float waterGustScale;
            uniform sampler2D waterWaveData;
            uniform float waterWaveCount;
            uniform float waterWaveTexels;
            uniform vec2 waterResidualSigma2;
            uniform float waterDebug;

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

            // Gaussian-slope microfacet BRDF for the sea surface — see
            // src/ocean/OceanBRDF.glsl.js. Only used by the Ocean method.
            ${oceanBRDFChunk}
            
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

                        if (waterOcean > 0.0) {
                            // OCEAN (SPECTRAL) MODE.
                            //
                            // The other two methods perturb a normal and look up
                            // what is along the reflected ray. That is right only
                            // while a pixel is smaller than a wave. Past a few
                            // kilometres one pixel spans thousands of waves, there
                            // is no meaningful normal left, and averaging them gives
                            // a flat one — which is why the sea goes glassy at range
                            // in both other modes, and why the fix cannot be "more
                            // ripple strength".
                            //
                            // Here the surface is a slope DISTRIBUTION instead, and
                            // the shading is an integral over it: a microfacet BRDF
                            // whose roughness is the mean square slope of the part of
                            // the wave spectrum this pixel cannot resolve. The
                            // variance comes from Cox & Munk's sun-glitter
                            // measurements by way of the Elfouhaily spectrum, so the
                            // wind speed control is a physical input, not a look
                            // knob. See src/ocean/OceanSpectrum.js.

                            // Wind-aligned tangent axes. Built per fragment from the
                            // geodetic up, because over a sea wide enough to see the
                            // horizon "east" has rotated appreciably from one side of
                            // the view to the other.
                            vec3 windX = normalize(east * waterWindDir.x + north * waterWindDir.y);
                            vec3 windY = cross(up, windX);

                            vec3 toEye = -viewDir;
                            float cosView = dot(toEye, up);

                            if (cosView > 1e-3) {
                                // Starting point if there is no wave field loaded:
                                // the whole spectrum as roughness, nothing resolved.
                                vec2 sigma2 = waterSigma2;

                                // Gustiness: patches of rougher and smoother water,
                                // streaked along the wind. Relative to the wave origin
                                // so the noise coordinate stays in metres — float32
                                // cannot resolve a 300 m feature at ECEF magnitudes.
                                vec3 gustOffset = vWorldPosition - waterWaveOrigin;
                                vec2 windCoords = vec2(dot(gustOffset, windX),
                                                       dot(gustOffset, windY));
                                float gust = oceanGustiness(windCoords, waterGustiness,
                                                            waterWaveTime, waterGustScale);

                                // The patch of sea this pixel covers. It is an ELLIPSE:
                                // across the view a pixel spans dist*pixelAngle, but
                                // along the view that is divided by the sine of the
                                // depression angle, which at grazing incidence makes it
                                // tens of times longer. Looking across a lake from 38 m
                                // up the ratio reaches 53:1 by two kilometres.
                                //
                                // Both axes are kept, and each wave is tested against
                                // the one that matters for its own direction of travel.
                                // Collapsing this to the long axis stops the ripples
                                // dead at a visible line a few hundred metres out.
                                //
                                // NOT from fwidth(vWorldPosition): float32 quantises
                                // ECEF to about 0.4 m, so its derivative is noise
                                // rather than a footprint.
                                float fragDistance = length(vWorldPosition - cameraPosition);
                                float footprintAcross = fragDistance * waterPixelAngle;
                                float footprintAlong = footprintAcross / max(cosView, 0.002);

                                // Along-view direction, flattened into the surface and
                                // expressed in the wind frame the wavevectors use.
                                vec3 viewFlat = viewDir - up * dot(viewDir, up);
                                vec2 viewAxis = vec2(dot(viewFlat, windX), dot(viewFlat, windY));
                                viewAxis = length(viewAxis) > 1e-6
                                    ? normalize(viewAxis) : vec2(1.0, 0.0);

                                // Resolved waves, and the variance of everything this
                                // pixel is too far away to resolve. The two are exact
                                // complements — see oceanWaveSurface.
                                vec3 oceanNormal = up;
                                if (waterWaveCount > 0.0) {
                                    OceanSurface surface = oceanWaveSurface(
                                        waterWaveData, waterWaveCount, waterWaveTexels,
                                        windCoords, waterWaveTime,
                                        footprintAlong, footprintAcross, viewAxis);
                                    // The trains' own unresolved part PLUS the band
                                    // they never covered. Assigning only the first
                                    // throws away about two fifths of the roughness.
                                    sigma2 = (surface.residualVariance
                                            + waterResidualSigma2) * gust;
                                    oceanNormal = normalize(up
                                        - windX * surface.slope.x
                                        - windY * surface.slope.y);
                                } else {
                                    sigma2 *= gust;
                                }

                                // --- reflected environment -------------------------
                                // Sample the mirror render target through the width of
                                // the reflection lobe, then weight it by the
                                // DIRECTIONAL reflectance rather than by a point BRDF
                                // value: the environment has already been integrated
                                // over solid angle by the filtering, so multiplying by
                                // a quantity per steradian again would be a category
                                // error.
                                vec3 reflectedDir = reflect(viewDir, oceanNormal);

                                // How wide the reflection lobe is, in render-target
                                // pixels. A slope deviation turns the reflected ray by
                                // twice as much, and the target resolves
                                // waterPixelAngle per pixel.
                                float lobePixels = oceanLobeAngle(sigma2)
                                                 / max(waterPixelAngle, 1e-6);
                                float lod = log2(max(lobePixels, 1.0));

                                // THE RENDER TARGET CAN ONLY SUPPLY PART OF THE LOBE.
                                // At any real sea state the reflection lobe is
                                // comparable to a whole camera field of view — about
                                // 14 degrees at 5 m/s of wind, against this view's 13 —
                                // so most of the light this surface reflects arrives
                                // from directions that were never rendered.
                                //
                                // Treating that as all-or-nothing gets it wrong both
                                // ways: keep the render target and the "reflection"
                                // becomes the average of the frame, drop it and the
                                // sea stops reflecting the island next to it. So use it
                                // for the FRACTION of the lobe it covers, and let the
                                // sky supply the rest. At a glassy surface the fraction
                                // goes to one and the reflection sharpens; in a fresh
                                // breeze it falls away and the sea turns to sky.
                                float lobeCoverage = clamp(
                                    waterMirrorFov / max(2.0 * oceanLobeAngle(sigma2), 1e-4),
                                    0.0, 1.0);
                                // Never blur wider than the render itself: past that the
                                // sample stops being a reflection and becomes the mean
                                // of the frame.
                                lod = min(lod, log2(max(waterMirrorFov / max(waterPixelAngle, 1e-6), 4.0)) - 1.0);
                                float mirrorWeight = lobeCoverage;

                                vec3 environment = oceanSkyRadiance(
                                    reflectedDir, up, waterSkyZenith, waterSkyHorizon,
                                    oceanLobeAngle(sigma2));
                                if (mirrorWeight > 0.0) {
                                    vec4 mirrorClip = waterMirrorMatrix * vec4(
                                        (vWorldPosition - waterMirrorOrigin)
                                            + reflectedDir * waterMirrorDistance, 1.0);
                                    if (mirrorClip.w > 0.0) {
                                        vec2 muv = mirrorClip.xy / mirrorClip.w;
                                        // Fade ACROSS the edge, and fade towards the
                                        // sky rather than towards black. Fading to
                                        // nothing — which the mirror method does —
                                        // deletes energy and leaves a dark seam
                                        // exactly where the water is brightest.
                                        vec2 edge = smoothstep(vec2(0.0), vec2(0.04), muv)
                                                  * (1.0 - smoothstep(vec2(0.96), vec2(1.0), muv));
                                        float inside = edge.x * edge.y;
                                        // Bias rather than an explicit level:
                                        // texture2D's bias form is core GLSL ES 1.00,
                                        // whereas explicit-LOD sampling in a fragment
                                        // shader needs an extension that is not
                                        // available on every path this material
                                        // compiles for.
                                        vec3 mirrorEnv = texture2D(
                                            waterMirrorMap, clamp(muv, 0.0, 1.0), lod).rgb;
                                        environment = mix(environment, mirrorEnv,
                                                          inside * mirrorWeight);
                                    }
                                }

                                // Fresnel, shadowing and the glitter geometry are all
                                // measured against the LOCAL surface — the resolved
                                // waves tilt it, and the unresolved ones are the
                                // roughness about it. That split is the whole scheme:
                                // waves big enough to see become geometry, waves too
                                // small to see become a BRDF, and which is which
                                // depends on how far away this pixel is.
                                float reflectance = oceanEnvironmentReflectance(
                                    toEye, oceanNormal, sigma2, 1.34);

                                vec3 oceanRadiance = environment * reflectance;

                                // --- Sun and Moon glitter, analytic ----------------
                                // Never sampled from the render target: at half a
                                // degree the discs are a handful of pixels there, and
                                // the blur just applied would erase them. The glitter
                                // path is the most recognisable feature of real water,
                                // so it is reintroduced as a quantity.
                                vec3 glitter = vec3(0.0);
                                if (dot(waterSunRadiance, waterSunRadiance) > 0.0) {
                                    glitter += oceanSourceGlitter(
                                        toEye, waterSunDir, oceanNormal, windX, windY, sigma2,
                                        waterSunRadiance, waterSunSolidAngle,
                                        waterSunRadius, 1.34);
                                }
                                if (dot(waterMoonRadiance, waterMoonRadiance) > 0.0) {
                                    glitter += oceanSourceGlitter(
                                        toEye, waterMoonDir, oceanNormal, windX, windY, sigma2,
                                        waterMoonRadiance, waterMoonSolidAngle,
                                        waterMoonRadius, 1.34);
                                }
                                // A specular highlight off the solar disc is orders of
                                // magnitude brighter than the sky, so what sets the
                                // apparent LENGTH of a glitter path in any photograph
                                // is where it crosses saturation. Physics alone would
                                // give a clipped white wedge; the shoulder restores
                                // the roll-off a sensor provides.
                                glitter = glitter * waterGlitterExposure;
                                glitter = glitter / (1.0 + glitter);
                                oceanRadiance += glitter;

                                // --- water-leaving radiance ------------------------
                                // The blue of the sea is light that went into it and
                                // came back out. Without this the surface is grey
                                // glass, however good the reflection is. The
                                // reflectance already includes the air-water interface
                                // transmission, so it must not be multiplied by
                                // (1 - Fresnel) again.
                                oceanRadiance += waterUpwelling * waterIrradiance
                                               * (1.0 - reflectance);

                                // --- whitecaps -------------------------------------
                                oceanRadiance += vec3(waterWhitecap * 0.22
                                               * waterIrradiance * 0.31830989);

                                if (waterDebug > 0.5) {
                                    // False color, replacing the water entirely so a
                                    // dark night scene cannot hide the signal.
                                    vec3 probe = vec3(0.0);
                                    if (waterDebug < 1.5) {
                                        probe = vec3(gust * 0.5);
                                    } else if (waterDebug < 2.5) {
                                        probe = vec3(abs(oceanNormal - up) * 40.0);
                                    } else if (waterDebug < 3.5) {
                                        probe = vec3(sigma2.x, sigma2.y, 0.0) * 20.0;
                                    } else {
                                        probe = vec3(mirrorWeight, 1.0 - mirrorWeight, 0.0);
                                    }
                                    linearColor.rgb = mix(linearColor.rgb, probe, waterMask);
                                } else {
                                    linearColor.rgb += oceanRadiance
                                                     * (waterMask * waterStrength);
                                }
                            }
                        } else if (waterMirror > 0.0) {
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
