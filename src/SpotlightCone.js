// A faint shaft seen side-on in haze. The silhouette softens toward grazing
// angles and the light fades along the beam and into the receiving cloud.
import {AdditiveBlending, ShaderMaterial} from "three";
import {installTerrestrialRefractionOnShaderMaterial} from "./atmosphere/terrestrialRefraction";

export function createSpotlightConeMaterial() {
    const material = new ShaderMaterial({
        name: "Spotlight cone",
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: {intensity: {value: 0}, lengthMeters: {value: 0}},
        vertexShader: /* glsl */`
            varying vec3 vViewNormal;
            varying vec3 vViewPosition;
            varying float vFraction;
            #include <common>
            #include <logdepthbuf_pars_vertex>
            void main() {
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                vViewNormal = normalMatrix * normal;
                vViewPosition = mvPosition.xyz;
                vFraction = position.y;
                gl_Position = projectionMatrix * vec4(applyTerrestrialRefraction_chunk(mvPosition.xyz), 1.0);
                #include <logdepthbuf_vertex>
            }
        `,
        fragmentShader: /* glsl */`
            uniform float intensity;
            uniform float lengthMeters;
            varying vec3 vViewNormal;
            varying vec3 vViewPosition;
            varying float vFraction;
            #include <common>
            #include <logdepthbuf_pars_fragment>
            void main() {
                #include <logdepthbuf_fragment>
                vec3 toEye = isOrthographic ? vec3(0., 0., 1.) : normalize(-vViewPosition);
                float profile = abs(dot(normalize(vViewNormal), toEye));
                float fade = (1.0 - smoothstep(0.88, 1.0, vFraction)) / (1.0 + lengthMeters * vFraction / 250.0);
                gl_FragColor = vec4(vec3(intensity * profile * profile * fade), 1.0);
            }
        `,
    });
    material.userData.atmosphere = false;
    installTerrestrialRefractionOnShaderMaterial(material);
    return material;
}
