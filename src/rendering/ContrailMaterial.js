import {DoubleSide, MeshBasicMaterial} from "three";
import {installSoftDepthMaterial} from "./SoftDepth";

export function createContrailMaterial() {
    const material = new MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: .7,
        side: DoubleSide, depthWrite: false, forceSinglePass: true});
    const length = {value: 1};
    material.userData.trailLength = length;
    material.onBeforeCompile = shader => {
        shader.uniforms.trailLength = length;
        shader.vertexShader = "attribute vec2 trailCoord; varying vec2 vTrailCoord;\n" + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>",
            "#include <begin_vertex>\nvTrailCoord = trailCoord;");
        shader.fragmentShader = "uniform float trailLength; varying vec2 vTrailCoord;\n" + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace("#include <alphatest_fragment>", `
            // Smooth cross-ribbon density and a stable variation along the trail.
            float across = abs(vTrailCoord.x);
            float footprint = max(fwidth(vTrailCoord.x), 0.001);
            float edge = 1.0 - smoothstep(0.25, 1.0, across);
            float coverage = 1.0 - smoothstep(1.0 - footprint, 1.0, across);
            float variation = 0.94 + 0.04 * sin(vTrailCoord.y * 0.021)
                + 0.02 * sin(vTrailCoord.y * 0.057);
            float ends = smoothstep(0.0, min(10.0, trailLength * 0.1), vTrailCoord.y)
                * smoothstep(0.0, min(60.0, trailLength * 0.1), trailLength - vTrailCoord.y);
            diffuseColor.a *= edge * coverage * variation * ends;
            #include <alphatest_fragment>`);
    };
    material.customProgramCacheKey = () => "contrail-density-v1";
    return installSoftDepthMaterial(material, 20);
}
