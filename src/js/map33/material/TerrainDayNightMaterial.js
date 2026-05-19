import {Color, ShaderMaterial, Vector3} from "three";
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
    const material = new ShaderMaterial({
        uniforms: {
            map: { value: texture },
            sunDirection: { value: Globals.sunLight.position }, // reference, so normalize before use
            earthCenter: { value: new Vector3(0, 0, 0) },
            terrainShadingStrength: { value: terrainShadingStrength },
            transparency: { value: transparency },
            // Required by Three.js when ShaderMaterial.fog = true
            fogColor: { value: new Color(0xffffff) },
            fogNear: { value: 1 },
            fogFar: { value: 1000 },
            fogDensity: { value: 0.00025 },
            ...sharedUniforms,
        },
        side: doubleSided ? 2 : 0, // 2 = DoubleSide, 0 = FrontSide
        transparent: transparency < 1,
        fog: true,
        vertexShader: `
            varying vec2 vUv;
            varying vec3 vNormal;
            varying vec3 vWorldPosition;
            varying vec4 vPosition;
            #include <fog_pars_vertex>
            
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
            #include <fog_pars_fragment>
            
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
                
                // Calculate day color with terrain shading
                vec4 dayColor = textureColor * sunGlobalTotal * terrainShading;
                
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
    
    return material;
}
