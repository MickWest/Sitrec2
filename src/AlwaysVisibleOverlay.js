import {Vector3} from "three";
import {Globals} from "./Globals";

function replaceOnce(source, anchor, replacement) {
    if (!source.includes(anchor)) throw new Error(`Always-visible overlay shader: missing ${anchor}`);
    return source.replace(anchor, replacement);
}

function patchOverlayShader(shader, isSceneLine, normalScale) {
    shader.uniforms.overlayNormalScale = normalScale;
    shader.vertexShader = replaceOnce(shader.vertexShader, "void main() {",
        "varying vec3 vOverlayWorld;\nvoid main() {");
    const anchor = isSceneLine ? "// scene line attributes" : "void main() {";
    const point = isSceneLine
        ? "mix(instanceStart, instanceEnd, lineVertexFraction)" : "position";
    shader.vertexShader = replaceOnce(shader.vertexShader, anchor,
        `${anchor}\n vOverlayWorld = (modelMatrix * vec4(${point}, 1.0)).xyz;`);
    shader.fragmentShader = replaceOnce(shader.fragmentShader, "void main() {", `
        uniform vec3 overlayNormalScale;
        varying vec3 vOverlayWorld;
        void main() {
            if (dot(vOverlayWorld * overlayNormalScale, cameraPosition - vOverlayWorld) < 0.0) discard;`);
}

// Draw over terrain and buildings, but discard the far side of the Earth per fragment.
// Supports groups (including arrows), stock mesh materials, ShaderMaterial and SceneLineMaterial.
export function setAlwaysVisibleOverlay(object, renderOrder = 1000) {
    if (!object.material) {
        object.children.forEach(child => setAlwaysVisibleOverlay(child, renderOrder));
        return object;
    }
    object.frustumCulled = false;
    object.renderOrder = renderOrder;
    const material = object.material;
    if (material.userData.alwaysVisibleOverlay) return object;
    material.userData.alwaysVisibleOverlay = true;
    material.transparent = true;
    material.depthTest = false;
    material.depthWrite = false;
    const normalScale = {value: new Vector3()};
    const updateNormal = () => {
        const a = Globals.equatorRadius, b = Globals.polarRadius;
        // Pre-scale 1/a², 1/b² by a² to retain precision in float32.
        normalScale.value.set(1, 1, a * a / (b * b));
    };
    updateNormal();
    const beforeRender = material.onBeforeRender;
    material.onBeforeRender = function (...args) {
        beforeRender?.apply(this, args);
        updateNormal();
    };
    if (material.isShaderMaterial) {
        patchOverlayShader(material, material.isSceneLineMaterial, normalScale);
    } else {
        // Arrowheads use MeshBasicMaterial. Chain its color/projection patches and keep this
        // program distinct from ordinary meshes that use the same material settings.
        const beforeCompile = material.onBeforeCompile;
        const cacheKey = material.customProgramCacheKey();
        material.onBeforeCompile = function (shader, renderer) {
            beforeCompile?.call(this, shader, renderer);
            patchOverlayShader(shader, false, normalScale);
        };
        material.customProgramCacheKey = () => `${cacheKey}|always-visible-overlay`;
    }
    material.needsUpdate = true;
    return object;
}
