import {DoubleSide, MeshPhongMaterial, Vector3} from "three";
import {sharedUniforms} from "../js/map33/material/SharedUniforms";
import {installTerrestrialRefractionOnMaterial} from "../atmosphere/terrestrialRefraction";
import {waterShadeGLSL, waterUniformsGLSL} from "./WaterShading.glsl.js";

// Use the SAME water shading and per-view reflection captures as map water and
// 3D tiles. Only the mask differs: every fragment of this mesh is water.
export function createSeaLevelMaterial() {
    const material = new MeshPhongMaterial({
        color: 0x2f6aa8,
        shininess: 70,
        side: DoubleSide,
        depthTest: true,
        depthWrite: true,
    });
    material.name = "Sea Level";
    const inundationUniforms = {
        seaInundation: {value: false},
        seaInundationReady: {value: false},
        seaInundationMask: {value: null},
    };
    material.userData.inundationUniforms = inundationUniforms;
    material.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, inundationUniforms);
        for (const key of Object.keys(sharedUniforms)) {
            if (key.startsWith("water")) shader.uniforms[key] = sharedUniforms[key];
        }
        shader.uniforms.earthCenter = {value: new Vector3()};
        shader.vertexShader = shader.vertexShader.replace("#include <common>",
            "#include <common>\nvarying vec3 vSeaWorldPosition;\nattribute vec2 seaMaskUv;\nvarying vec2 vSeaMaskUv;")
            .replace("#include <begin_vertex>",
                "#include <begin_vertex>\nvSeaWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSeaMaskUv = seaMaskUv;");
        shader.fragmentShader = shader.fragmentShader.replace("#include <common>",
            `#include <common>\nvarying vec3 vSeaWorldPosition;\nuniform vec3 earthCenter;
            varying vec2 vSeaMaskUv;
            uniform bool seaInundation;
            uniform bool seaInundationReady;
            uniform sampler2D seaInundationMask;
            ${waterUniformsGLSL}\n${waterShadeGLSL}`)
            .replace("#include <clipping_planes_fragment>",
                `#include <clipping_planes_fragment>
                if (seaInundation && (!seaInundationReady || texture2D(seaInundationMask, vSeaMaskUv).r < 0.5)) discard;`)
            .replace("#include <opaque_fragment>",
                `if (waterReflection > 0.0) {
                    outgoingLight = sitrecWaterShade(outgoingLight, 1.0, vSeaWorldPosition);
                }
                #include <opaque_fragment>`);
    };
    material.customProgramCacheKey = () => "seaLevel.v2";
    installTerrestrialRefractionOnMaterial(material);
    return material;
}
