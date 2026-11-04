import {ArrowHelper, BufferGeometry, LineSegments, ShaderLib, ShaderMaterial} from "three";
import {Globals} from "../src/Globals";
import {SceneLineMaterial} from "../src/SceneLineMaterial";
import {SceneLineSegments} from "../src/SceneLines";
import {setAlwaysVisibleOverlay} from "../src/AlwaysVisibleOverlay";

test("overlay keeps line widths per view and updates the cull when the Earth model changes", () => {
    Globals.equatorRadius = 10;
    Globals.polarRadius = 5;
    const material = new SceneLineMaterial({linewidth: 1.5});
    const lines = setAlwaysVisibleOverlay(new SceneLineSegments(new BufferGeometry(), material));
    const renderer = {getCurrentViewport: v => v.set(0, 0, 800, 600), getSize: v => v.set(800, 600)};
    material.onBeforeRender(renderer);
    expect(material.uniforms.linePixelWidth.value).toBe(1.5);
    expect(material.uniforms.overlayNormalScale.value.toArray()).toEqual([1, 1, 4]);
    Globals.polarRadius = 10;
    material.onBeforeRender(renderer);
    expect(material.uniforms.overlayNormalScale.value.toArray()).toEqual([1, 1, 1]);
    expect(material.depthTest).toBe(false);
    expect(material.depthWrite).toBe(false);
    expect(lines.renderOrder).toBe(1000);
    expect(lines.frustumCulled).toBe(false);
    expect(material.vertexShader).toContain("mix(instanceStart, instanceEnd, lineVertexFraction)");
});

test("ordinary geometry and repeated setup use the same single horizon cull", () => {
    const material = new ShaderMaterial({
        vertexShader: "void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader: "void main() { gl_FragColor = vec4(1.0); }",
    });
    const lines = setAlwaysVisibleOverlay(new LineSegments(new BufferGeometry(), material));
    setAlwaysVisibleOverlay(lines);
    expect(material.vertexShader.match(/varying vec3 vOverlayWorld/g)).toHaveLength(1);
    expect(material.fragmentShader.match(/discard/g)).toHaveLength(1);
    expect(material.vertexShader).toContain("modelMatrix * vec4(position, 1.0)");
});

test("arrow shafts and heads share the overlay and retain existing shader patches", () => {
    Globals.equatorRadius = 10;
    Globals.polarRadius = 5;
    const arrow = new ArrowHelper();
    const material = arrow.cone.material;
    const originalPatch = jest.fn(shader => { shader.fragmentShader += "\n// existing color patch"; });
    material.onBeforeCompile = originalPatch;
    const originalKey = material.customProgramCacheKey();
    setAlwaysVisibleOverlay(arrow);
    setAlwaysVisibleOverlay(arrow);
    for (const child of [arrow.line, arrow.cone]) {
        expect(child.material.depthTest).toBe(false);
        expect(child.material.depthWrite).toBe(false);
        expect(child.renderOrder).toBe(1000);
    }
    const shader = {...ShaderLib.basic, uniforms: {}};
    material.onBeforeCompile(shader, {});
    expect(originalPatch).toHaveBeenCalledTimes(1);
    expect(shader.fragmentShader).toContain("// existing color patch");
    expect(shader.fragmentShader.match(/varying vec3 vOverlayWorld/g)).toHaveLength(1);
    expect(material.customProgramCacheKey()).toBe(`${originalKey}|always-visible-overlay`);
    expect(shader.uniforms.overlayNormalScale.value.toArray()).toEqual([1, 1, 4]);
    Globals.polarRadius = 10;
    material.onBeforeRender({});
    expect(shader.uniforms.overlayNormalScale.value.toArray()).toEqual([1, 1, 1]);
});
