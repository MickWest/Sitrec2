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
    material.onBeforeCompile = shader => {
        for (const key of Object.keys(sharedUniforms)) {
            if (key.startsWith("water")) shader.uniforms[key] = sharedUniforms[key];
        }
        shader.uniforms.earthCenter = {value: new Vector3()};
        shader.vertexShader = shader.vertexShader.replace("#include <common>",
            "#include <common>\nvarying vec3 vSeaWorldPosition;")
            .replace("#include <begin_vertex>",
                "#include <begin_vertex>\nvSeaWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;");
        shader.fragmentShader = shader.fragmentShader.replace("#include <common>",
            `#include <common>\nvarying vec3 vSeaWorldPosition;\nuniform vec3 earthCenter;\n${waterUniformsGLSL}\n${waterShadeGLSL}`)
            .replace("#include <opaque_fragment>",
                `if (waterReflection > 0.0) {
                    outgoingLight = sitrecWaterShade(outgoingLight, 1.0, vSeaWorldPosition);
                }
                #include <opaque_fragment>`);
    };
    material.customProgramCacheKey = () => "seaLevel.v1";
    installTerrestrialRefractionOnMaterial(material);
    return material;
}
