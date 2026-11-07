jest.mock("../src/Globals", () => ({Globals: {}, NodeMan: {get: jest.fn()}}));
jest.mock("../src/LocalFrame", () => ({GlobalScene: new (require("three").Scene)()}));
jest.mock("../src/FisheyeProjection", () => ({installFisheyeOnMaterial: jest.fn()}));
jest.mock("../src/atmosphere/terrestrialRefraction", () => ({installTerrestrialRefractionOnMaterial: jest.fn()}));

import {Color, Group, Mesh, PerspectiveCamera} from "three";
import {NodeMan} from "../src/Globals";
import {GlobalScene} from "../src/LocalFrame";
import {captureRidgeline, refractRidgeline, renderRidgeline} from "../src/rendering/RidgelinePass";

let sky, terrain, annotation, alreadyHidden;
function view(id = "lookView", scale = 1) {
    let target = {width: 800 * scale, height: 400 * scale};
    let clear = new Color(0x123456), alpha = 0.4;
    return {id, camera: new PerspectiveCamera(), heightPx: 400, letterboxScaleY: 1,
        fullscreenQuad: {material: {}}, fullscreenQuadCamera: {},
        renderer: {autoClear: false, shadowMap: {enabled: true}, capabilities: {maxSamples: 4},
            getContext: () => ({getInternalformatParameter: () => []}),
            getRenderTarget: () => target, setRenderTarget: jest.fn(value => { target = value; }),
            getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
            getClearColor: value => value.copy(clear), getClearAlpha: () => alpha,
            setClearColor: (color, value) => { clear = new Color(color); alpha = value; },
            getDrawingBufferSize: value => value.set(800 * scale, 400 * scale),
            clear: jest.fn(), render: jest.fn()},
    };
}

beforeEach(() => {
    NodeMan.get.mockClear();
    sky = {showRidgelineMain: false, showRidgelineLook: false};
    terrain = new Group(); terrain.add(new Mesh());
    annotation = new Group(); alreadyHidden = new Group(); alreadyHidden.visible = false;
    GlobalScene.clear(); GlobalScene.add(terrain, annotation, alreadyHidden);
    GlobalScene.background = new Color(0xabcdef); GlobalScene.overrideMaterial = null;
    NodeMan.get.mockImplementation(id => id === "NightSkyNode" ? sky : id === "TerrainModel" ? {getGroup: () => terrain} : undefined);
});

test("disabled views allocate nothing and perform no terrain lookup, traversal or rendering", () => {
    for (const id of ["mainView", "lookView", "otherView"]) {
        const v = view(id);
        captureRidgeline(v); renderRidgeline(v); refractRidgeline(v, {usable: true});
        expect(v.ridgelinePass).toBeUndefined();
        expect(v.renderer.setRenderTarget).not.toHaveBeenCalled();
        expect(v.renderer.render).not.toHaveBeenCalled();
    }
    expect(NodeMan.get.mock.calls.every(([id]) => id === "NightSkyNode")).toBe(true);
});

test("Main and Look are independent; switching off skips an existing pass", () => {
    sky.showRidgelineLook = true;
    const main = view("mainView"), look = view();
    captureRidgeline(main); captureRidgeline(look);
    expect(main.ridgelinePass).toBeUndefined();
    expect(look.ridgelinePass.ready).toBe(true);
    const draws = look.renderer.render.mock.calls.length;
    sky.showRidgelineLook = false;
    captureRidgeline(look); renderRidgeline(look);
    expect(look.renderer.render).toHaveBeenCalledTimes(draws);
    look.ridgelinePass.dispose();
});

test.each([false, true])("terrain capture restores scene and renderer state after failure=%s", fail => {
    sky.showRidgelineLook = true;
    const v = view(), r = v.renderer;
    const target = r.getRenderTarget(), background = GlobalScene.background;
    r.render.mockImplementation((scene, camera) => {
        expect(scene).toBe(GlobalScene); expect(camera).toBe(v.camera);
        expect(terrain.visible).toBe(true); expect(annotation.visible).toBe(false);
        expect(alreadyHidden.visible).toBe(false); expect(r.shadowMap.enabled).toBe(false);
        expect(scene.overrideMaterial).toBe(v.ridgelinePass.maskMaterial);
        if (fail) throw new Error("draw failed");
    });
    if (fail) expect(() => captureRidgeline(v)).toThrow("draw failed");
    else captureRidgeline(v);
    expect(annotation.visible).toBe(true); expect(alreadyHidden.visible).toBe(false);
    expect(GlobalScene.background).toBe(background); expect(GlobalScene.overrideMaterial).toBeNull();
    expect(r.shadowMap.enabled).toBe(true); expect(r.autoClear).toBe(false);
    expect(r.getRenderTarget()).toBe(target); expect(r.getClearAlpha()).toBe(0.4);
    expect(r.getClearColor(new Color()).getHex()).toBe(0x123456);
    v.ridgelinePass.dispose();
});

test.each([0.75, 1, 2])("outline stays half a display pixel at render scale %s and releases targets", scale => {
    sky.showRidgelineLook = true;
    const v = view("lookView", scale);
    captureRidgeline(v);
    const target = v.ridgelinePass.target, dispose = jest.spyOn(target, "dispose");
    const previousTarget = v.renderer.getRenderTarget(), previousMaterial = v.fullscreenQuad.material;
    renderRidgeline(v);
    expect(v.ridgelinePass.material.uniforms.width.value).toBe(0.5 * scale);
    expect(v.renderer.getRenderTarget()).toBe(previousTarget);
    expect(v.fullscreenQuad.material).toBe(previousMaterial);
    captureRidgeline(v);
    expect(v.ridgelinePass.target).toBe(target);
    v.ridgelinePass.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(v.ridgelinePass.targets.size).toBe(0);
});

test("hiding all landscape suppresses a previously captured outline", () => {
    sky.showRidgelineLook = true;
    const v = view();
    captureRidgeline(v);
    terrain.visible = false;
    const draws = v.renderer.render.mock.calls.length;
    captureRidgeline(v); renderRidgeline(v);
    expect(v.ridgelinePass.ready).toBe(false);
    expect(v.renderer.render).toHaveBeenCalledTimes(draws);
    v.ridgelinePass.dispose();
});

test("resizing a panorama reuses a bounded set of face targets", () => {
    sky.showRidgelineLook = true;
    const v = view();
    for (const width of [800, 900, 1000]) {
        for (let index = 0; index < 6; index++) {
            v._panoramaFace = {index};
            v.renderer.setRenderTarget({width, height: 400});
            captureRidgeline(v);
        }
    }
    expect(v.ridgelinePass.targets.size).toBe(6);
    v.ridgelinePass.dispose();
});

test("ray-traced refraction warps coverage into a separate target without overwriting scene colour", () => {
    sky.showRidgelineLook = true;
    const v = view();
    captureRidgeline(v);
    const source = v.ridgelinePass.target;
    const refraction = {usable: true, renderMask: jest.fn((view, input, output) => output)};
    refractRidgeline(v, refraction);
    const output = v.ridgelinePass.target;
    expect(refraction.renderMask).toHaveBeenCalledWith(v, source, output);
    expect(output).not.toBe(source);
    expect(output.width).toBe(source.width);
    expect(output.height).toBe(source.height);
    v.ridgelinePass.dispose();
});
