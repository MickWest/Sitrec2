import {BufferGeometry, ColorManagement, Float32BufferAttribute, Vector2} from "three";
import {SceneLineMaterial, setLineViewHeight} from "../src/SceneLineMaterial";
import {SceneLine, SceneLineLoop, SceneLineSegments} from "../src/SceneLines";
import {patchFisheyeVertexShader} from "../src/FisheyeProjection";
import {patchTerrestrialRefractionVertexShader} from "../src/atmosphere/terrestrialRefraction";
import {installRefractionOnMaterial} from "../src/atmosphere/refraction";

function source() {
    return new BufferGeometry().setAttribute("position", new Float32BufferAttribute([
        0, 0, 0, 10, 0, 0, 10, 20, 0, 0, 20, 0,
    ], 3));
}

function segments(line) {
    return Array.from(line.geometry.attributes.instanceStart.data.array.slice(0, line.geometry.instanceCount * 6));
}

test("segments, strips, and closed loops retain their topology", () => {
    expect(segments(new SceneLineSegments(source()))).toEqual([0,0,0,10,0,0,10,20,0,0,20,0]);
    const strip = new SceneLine(source());
    expect(strip.geometry.instanceCount).toBe(3);
    expect(segments(strip).slice(6,12)).toEqual([10,0,0,10,20,0]);
    const loop = new SceneLineLoop(source());
    expect(loop.geometry.instanceCount).toBe(4);
    expect(segments(loop).slice(-6)).toEqual([0,20,0,0,0,0]);
});

test("indexed geometry and draw ranges select matching positions and colors", () => {
    const geometry = source().setIndex([3,2,1,0]);
    geometry.setAttribute("color", new Float32BufferAttribute([1,0,0,0,1,0,0,0,1,1,1,0], 3));
    geometry.setDrawRange(1, 2);
    const line = new SceneLineSegments(geometry);
    expect(segments(line)).toEqual([10,20,0,10,0,0]);
    expect(Array.from(line.geometry.attributes.instanceColorStart.data.array)).toEqual([0,0,1,0,1,0]);
});

test("dynamic updates reuse buffers and honor shrinking and empty draw ranges", () => {
    const line = new SceneLineSegments(source());
    const buffer = line.geometry.attributes.instanceStart.data;
    line.sourceGeometry.attributes.position.setXYZ(0, 8, 9, 10);
    line.sourceGeometry.setDrawRange(0, 2);
    line.syncGeometry();
    expect(line.geometry.attributes.instanceStart.data).toBe(buffer);
    expect(line.geometry.instanceCount).toBe(1);
    expect(segments(line).slice(0,3)).toEqual([8,9,10]);
    expect(line.geometry.boundingBox.max.y).toBe(9);
    line.sourceGeometry.setDrawRange(0, 0);
    line.syncGeometry();
    expect(line.geometry.instanceCount).toBe(0);
    expect(new SceneLineLoop(new BufferGeometry()).geometry.instanceCount).toBe(0);
});

test("cloned lines retain their source buffers and topology", () => {
    const line = new SceneLineLoop(source());
    const clone = line.clone();
    expect(clone.sourceGeometry).toBe(line.sourceGeometry);
    expect(clone.topology).toBe("loop");
    expect(segments(clone)).toEqual(segments(line));
});

test("growing dynamic geometry releases replaced GPU buffers", () => {
    const line = new SceneLineSegments(source());
    const released = jest.fn();
    line.geometry.addEventListener("dispose", released);
    line.sourceGeometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(60), 3));
    line.syncGeometry();
    expect(released).toHaveBeenCalled();
    expect(line.geometry.instanceCount).toBe(10);
});

test.each([0.5, 0.85, 1, 2, 2.4])("display width is preserved at pixel density %s", density => {
    const renderer = {
        getCurrentViewport: out => out.set(13, 27, 800*density, 400*density),
        getSize: out => out.set(800,400),
    };
    setLineViewHeight(renderer, 400);
    const material = new SceneLineMaterial({linewidth: 0.75, opacity: 0.3});
    material.onBeforeRender(renderer);
    expect(material.linewidth).toBe(0.75);
    expect(material.uniforms.linePixelWidth.value).toBeCloseTo(0.75*density);
    expect(material.resolution).toEqual(new Vector2(800*density,400*density));
    expect(material.uniforms.lineViewportOrigin.value.toArray()).toEqual([13,27]);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.alphaToCoverage).toBe(false);
    expect(material.opacity).toBe(0.3);
});

test("a shared material picks up each view and color mode without changing its style", () => {
    const renderer = height => ({getCurrentViewport: v => v.set(0,0,2000,height)});
    const a = renderer(1000), b = renderer(500);
    setLineViewHeight(a,500); setLineViewHeight(b,500);
    const material = new SceneLineMaterial({linewidth: 2});
    const original = ColorManagement.enabled;
    try {
        ColorManagement.enabled = false;
        material.onBeforeRender(a);
        expect(material.uniforms.linePixelWidth.value).toBe(4);
        expect(material.uniforms.lineInputSRGB.value).toBe(true);
        material.onBeforeRender(b);
        expect(material.uniforms.linePixelWidth.value).toBe(2);
        ColorManagement.enabled = true;
        material.onBeforeRender(a);
        expect(material.uniforms.lineInputSRGB.value).toBe(false);
        const clone = material.clone();
        clone.onBeforeRender(b);
        expect(clone.uniforms.linePixelWidth.value).toBe(2);
        expect(material.uniforms.linePixelWidth.value).toBe(4);
    } finally { ColorManagement.enabled = original; }
});

test("projection and refraction patches still transform line endpoints before extrusion", () => {
    const material = new SceneLineMaterial();
    const terrestrial = patchTerrestrialRefractionVertexShader(material.vertexShader);
    expect(terrestrial.matched).toBe(true);
    const fisheye = patchFisheyeVertexShader(terrestrial.vertexShader);
    expect(fisheye.matched).toBe(true);
    expect(fisheye.vertexShader).toContain("fisheyeClip( start )");
    expect(fisheye.vertexShader.indexOf("fisheyeClip( start )")).toBeLessThan(fisheye.vertexShader.indexOf("vLinePixelStart ="));
    installRefractionOnMaterial(material);
    const shader = {uniforms: {}, vertexShader: material.vertexShader};
    material.onBeforeCompile(shader, {});
    expect(shader.vertexShader).toContain("applyRefractionECI_chunk(instanceStart)");
    expect(shader.vertexShader).toContain("applyRefractionECI_chunk(instanceEnd)");
    expect(shader.vertexShader).toContain("applyRefractionECI_chunk(instanceLinePrevious.xyz)");
    expect(shader.vertexShader).toContain("applyRefractionECI_chunk(instanceLineNext.xyz)");
});

test("only touching segments share coverage, including the closing join", () => {
    const disconnected = new SceneLineSegments(source());
    expect(disconnected.geometry.attributes.instanceLinePrevious).toBeUndefined();
    const strip = new SceneLine(source());
    expect(strip.geometry.attributes.instanceLinePrevious.getW(0)).toBe(0);
    expect(strip.geometry.attributes.instanceLineNext.getW(0)).toBe(1);
    expect(strip.geometry.attributes.instanceLinePrevious.getW(1)).toBe(1);
    expect(strip.geometry.attributes.instanceLineNext.getW(2)).toBe(0);
    const loop = new SceneLineLoop(source());
    expect(loop.geometry.attributes.instanceLinePrevious.getW(0)).toBe(1);
    expect(loop.geometry.attributes.instanceLineNext.getW(3)).toBe(1);
});
