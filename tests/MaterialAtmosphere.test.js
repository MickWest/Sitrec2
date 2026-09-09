import {AdditiveBlending, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, ShaderLib, ShaderMaterial, UniformsUtils, Vector4} from "three";
import {atmosphereProjectionUniforms, setAtmosphereProjection} from "../src/atmosphere/AtmosphereProjection";
import {installMaterialAtmosphere, materialAtmosphereUniforms, withMaterialAtmosphere} from "../src/atmosphere/MaterialAtmosphere";
import {patchFisheyeVertexShader} from "../src/FisheyeProjection";

test("atmosphere captures the displayed projection including asymmetric compression", () => {
    const camera = new PerspectiveCamera(48, 1.7, 0.1, 6e9);
    camera.projectionMatrix.elements[8] = .17;
    camera.projectionMatrix.elements[9] = -.08;
    camera.projectionMatrix.elements[5] /= 1.4;
    const u = atmosphereProjectionUniforms();
    setAtmosphereProjection(u, camera);
    const point = new Vector4(1200, 400, -10000, 1);
    const restored = point.clone().applyMatrix4(camera.projectionMatrix).applyMatrix4(u.atmoInverseProjection.value);
    expect(restored.x / restored.w).toBeCloseTo(point.x, 5);
    expect(restored.y / restored.w).toBeCloseTo(point.y, 5);
    camera.projectionMatrix.makeOrthographic(-100, 100, 100, -100, .1, 8000);
    setAtmosphereProjection(u, camera);
    expect(u.atmoOrthographic.value).toBe(true);
    expect(camera.isPerspectiveCamera).toBe(true);
});

test("nested camera draws and exceptions restore every atmosphere uniform", () => {
    const original = Object.fromEntries(Object.entries(materialAtmosphereUniforms).map(([k, u]) => [k, u.value]));
    const first = UniformsUtils.clone(materialAtmosphereUniforms);
    const second = UniformsUtils.clone(materialAtmosphereUniforms);
    first.atmoEnabled.value = second.atmoEnabled.value = true;
    first.atmoAltitude.value = 12;
    second.atmoAltitude.value = 5000;
    const scene = new Scene();
    expect(() => withMaterialAtmosphere(scene, first, () => {
        expect(materialAtmosphereUniforms.atmoAltitude.value).toBe(12);
        withMaterialAtmosphere(scene, second, () => expect(materialAtmosphereUniforms.atmoAltitude.value).toBe(5000));
        withMaterialAtmosphere(scene, null, () => expect(materialAtmosphereUniforms.atmoEnabled.value).toBe(false));
        expect(materialAtmosphereUniforms.atmoEnabled.value).toBe(true);
        expect(materialAtmosphereUniforms.atmoAltitude.value).toBe(12);
        throw new Error("draw failed");
    })).toThrow("draw failed");
    for (const [key, value] of Object.entries(original)) expect(materialAtmosphereUniforms[key].value).toBe(value);
});

test("material patches preserve callbacks and remain installable on clones", () => {
    const material = new MeshBasicMaterial();
    material.onBeforeCompile = shader => shader.vertexShader = "// existing patch\n" + shader.vertexShader;
    expect(installMaterialAtmosphere(material)).toBe(true);
    expect(installMaterialAtmosphere(material)).toBe(false);
    const shader = {...ShaderLib.basic, uniforms: {}};
    material.onBeforeCompile(shader, {});
    expect(shader.vertexShader).toContain("// existing patch");
    // Later projection installers need to put their declarations before main.
    const fish = patchFisheyeVertexShader(shader.vertexShader).vertexShader;
    expect(fish.indexOf("uniform float uFishOn;")).toBeLessThan(fish.indexOf("void main()"));
    const clone = material.clone();
    expect(installMaterialAtmosphere(clone)).toBe(true);
    const additive = new MeshBasicMaterial({transparent: true, blending: AdditiveBlending});
    installMaterialAtmosphere(additive);
    expect(additive.customProgramCacheKey()).not.toBe(clone.customProgramCacheKey());
});

test("helper opt-outs do not turn into atmospheric surfaces", () => {
    const scene = new Scene();
    const helper = new MeshBasicMaterial({depthTest: false});
    const explicit = new MeshBasicMaterial();
    explicit.userData.atmosphere = false;
    scene.add(new Mesh(undefined, helper), new Mesh(undefined, explicit));
    const u = UniformsUtils.clone(materialAtmosphereUniforms);
    u.atmoEnabled.value = true;
    const helperVersion = helper.version, explicitVersion = explicit.version;
    withMaterialAtmosphere(scene, u, () => {});
    expect(helper.version).toBe(helperVersion);
    expect(explicit.version).toBe(explicitVersion);
});

test("custom shader early exits retain conditional control flow", () => {
    const material = new ShaderMaterial();
    installMaterialAtmosphere(material);
    const shader = {uniforms: {},
        vertexShader: "void main(void) { /* } */ if (position.x < 0.0) { gl_Position = vec4(0.0); return; } gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader: "void main() { gl_FragColor = vec4(1.0); if (gl_FragCoord.x < 1.0) return; gl_FragColor.r = 2.0; }"};
    material.onBeforeCompile(shader, {});
    expect(shader.fragmentShader).toContain("if (gl_FragCoord.x < 1.0) { gl_FragColor.rgb = applyMaterialAtmosphere(gl_FragColor.rgb); return; }");
    expect(shader.vertexShader).toContain("void main(void)");
});
