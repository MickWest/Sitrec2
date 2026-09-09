jest.mock("../src/Globals", () => ({Globals: {equatorRadius: 6371000, polarRadius: 6371000},
    Sit: {refractionEnabled: true, terrestrialRefraction: true}, setRenderOne: jest.fn()}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: () => 0}));
jest.mock("../src/LLA-ECEF-ENU", () => ({ECEFToLLAVD_radii: p => ({x: 0, y: 0, z: p.length() - 6371000})}));
jest.mock("../src/FisheyeProjection", () => ({isFisheyeCamera: () => false}));

import {HalfFloatType, LinearSRGBColorSpace, PerspectiveCamera, WebGLRenderTarget} from "three";
import {Sit} from "../src/Globals";
import {RefractionPass} from "../src/refraction/RefractionPass";
import {normalizeSettings} from "../src/refraction/RefractionPhysics";

let pass, view, tool;
beforeEach(() => {
    global.Worker = jest.fn().mockImplementation(() => ({postMessage: jest.fn(), terminate: jest.fn()}));
    const camera = new PerspectiveCamera(1, 1, 0.1, 1e7);
    camera.position.set(6371010, 0, 0); camera.up.set(1, 0, 0); camera.lookAt(6371010, 10000, 0);
    view = {camera, renderer: {capabilities: {logarithmicDepthBuffer: true}, extensions: {has: () => true}}};
    tool = {settings: normalizeSettings(), opticalRevision: 0, status: jest.fn(), setResult: jest.fn(),
        sync: jest.fn(), updateObserver: jest.fn(), view};
    pass = new RefractionPass(tool);
    pass.attachDepth(new WebGLRenderTarget(100, 100));
});
afterEach(() => { pass.dispose(); delete global.Worker; });

const reply = (job = pass.busy) => ({id: job.id, result: {data: new Float32Array(16), width: 2, rows: 2,
    minAngle: -0.1, maxAngle: 0.1, distances: new Float64Array([0, 50000]), milliseconds: 1}});

const previewReply = () => reply(pass.previewBusy);

test("continuous profile edits retain refraction and display advancing previews", () => {
    pass.capture(view); pass.receive(reply());
    expect(pass.previewWorker).toBeUndefined();
    const initialTexture = pass.texture;
    tool.editing = true; tool.opticalRevision++; pass.capture(view);
    const first = previewReply();
    for (let i = 0; i < 20; i++) { tool.opticalRevision++; pass.capture(view); expect(pass.usable).toBe(true); }
    expect(pass.previewJobs).toBe(1);
    expect(pass.jobs).toBe(1);
    pass.receive(first, true);
    expect(pass.appliedSequence).toBe(first.id);
    expect(pass.texture).toBe(initialTexture);
    expect(pass.previewJobs).toBe(2);
    const second = previewReply();
    tool.opticalRevision++; pass.capture(view); pass.receive(second, true);
    expect(pass.appliedSequence).toBe(second.id);
    expect(pass.usable).toBe(true);

    tool.editing = false; pass.capture(view);
    expect(pass.previewQueued).toBeNull();
    expect(pass.jobs).toBe(2);
    const full = reply(), latePreview = previewReply();
    pass.receive(full);
    pass.receive(latePreview, true);
    expect(pass.appliedSequence).toBe(full.id);
    expect(pass.tableKey).toBe(pass.wantedKey);
    for (let i = 0; i < 60; i++) pass.capture(view);
    expect(pass.jobs).toBe(2);
});

test("preview tracing is independent of a full job and cannot survive observer changes or disposal", () => {
    pass.capture(view); const full = reply();
    tool.editing = true; tool.opticalRevision++; pass.capture(view);
    const response = previewReply(), worker = pass.previewWorker;
    expect(pass.jobs).toBe(1); expect(pass.previewJobs).toBe(1);
    view.camera.position.x += 1; pass.capture(view);
    pass.receive(response, true);
    expect(tool.setResult).not.toHaveBeenCalled();
    pass.dispose();
    expect(worker.terminate).toHaveBeenCalled();
    pass.receive(full);
    expect(tool.setResult).not.toHaveBeenCalled();
});

test("a stationary camera traces once and reuses its table", () => {
    pass.capture(view); pass.receive(reply());
    for (let i = 0; i < 120; i++) pass.capture(view);
    expect(pass.jobs).toBe(1);
    expect(pass.usable).toBe(true);
    expect(tool.updateObserver).toHaveBeenCalledTimes(1);
});

test("camera and atmosphere changes coalesce, and stale results are discarded", () => {
    pass.capture(view);
    const old = reply();
    for (let i = 0; i < 20; i++) { tool.opticalRevision++; pass.capture(view); }
    expect(pass.jobs).toBe(1);
    pass.receive(old);
    expect(tool.setResult).not.toHaveBeenCalled();
    expect(pass.jobs).toBe(2);
    pass.receive(reply()); pass.capture(view);
    expect(tool.setResult).toHaveBeenCalledTimes(1);
    expect(pass.usable).toBe(true);
    view.camera.position.x += 1; pass.capture(view);
    expect(pass.jobs).toBe(3);
    expect(pass.usable).toBe(false);
});

test("subpixel pose jitter and fractional pane resize do not repeatedly retrace", () => {
    pass.capture(view); pass.receive(reply());
    for (let i = 0; i < 100; i++) {
        view.camera.rotateX(1e-12);
        pass.target.height = 100 + i % 2;
        pass.capture(view);
    }
    expect(pass.jobs).toBe(1);
});

test("a small pan retains a compatible cached table while a replacement traces", () => {
    pass.capture(view); pass.receive(reply()); pass.capture(view);
    const texture = pass.texture;
    view.camera.rotateX(0.004);
    pass.capture(view);
    expect(pass.jobs).toBe(2);
    expect(pass.texture).toBe(texture);
    expect(pass.usable).toBe(true);
    view.camera.rotateX(0.2);
    pass.capture(view);
    expect(pass.usable).toBe(false);
});

test("an out-of-range stationary camera never reuses the previous valid table", () => {
    pass.capture(view); pass.receive(reply()); pass.capture(view);
    view.camera.position.x = 6370990;
    for (let i = 0; i < 10; i++) {
        pass.capture(view);
        expect(pass.usable).toBe(false);
    }
});

test.each([[true, true], [false, false], [true, false]])("existing refraction flags (%p, %p) restore before other views render, even on failure", (sky, terrain) => {
    Sit.refractionEnabled = sky; Sit.terrestrialRefraction = terrain;
    const restore = pass.begin();
    try { expect(Sit.refractionEnabled).toBe(false); expect(Sit.terrestrialRefraction).toBe(false); }
    finally { restore(); }
    expect(Sit.refractionEnabled).toBe(sky); expect(Sit.terrestrialRefraction).toBe(terrain);
});

test("disabling releases depth, textures, worker, and ignores late replies", () => {
    pass.capture(view); const response = reply(), target = pass.target, worker = pass.worker;
    pass.dispose();
    expect(target.depthTexture).toBeNull();
    expect(worker.terminate).toHaveBeenCalled();
    pass.receive(response);
    expect(tool.setResult).not.toHaveBeenCalled();
});

test("sky capture is dormant until ready and preserves scene format and render state", () => {
    const input = new WebGLRenderTarget(80, 40, {type: HalfFloatType, colorSpace: LinearSRGBColorSpace});
    const material = {};
    view.fullscreenQuad = {material};
    view.renderer.getRenderTarget = () => input;
    view.renderer.setRenderTarget = jest.fn();
    view.renderer.render = jest.fn();
    pass.captureBackground(view, input);
    expect(pass.skyTarget).toBeUndefined();
    expect(view.renderer.render).not.toHaveBeenCalled();

    pass.usable = true;
    pass.captureBackground(view, input);
    const sky = pass.skyTarget;
    expect([sky.width, sky.height, sky.texture.type, sky.texture.colorSpace, sky.depthBuffer])
        .toEqual([80, 40, HalfFloatType, LinearSRGBColorSpace, false]);
    expect(pass.material.uniforms.tSky.value).toBe(sky.texture);
    expect(view.renderer.setRenderTarget.mock.calls.map(call => call[0])).toEqual([sky, input]);
    expect(view.fullscreenQuad.material).toBe(material);

    input.setSize(160, 90);
    pass.captureBackground(view, input);
    expect(pass.skyTarget).toBe(sky);
    expect([sky.width, sky.height]).toEqual([160, 90]);
    const disposeSky = jest.spyOn(sky, "dispose"), disposeCopy = jest.spyOn(pass.backgroundMaterial, "dispose");
    pass.dispose();
    expect(disposeSky).toHaveBeenCalled();
    expect(disposeCopy).toHaveBeenCalled();
    input.dispose();
});

test("a failed sky copy restores the target and fullscreen material", () => {
    const input = new WebGLRenderTarget(20, 10), material = {};
    view.fullscreenQuad = {material};
    view.renderer.getRenderTarget = () => input;
    view.renderer.setRenderTarget = jest.fn();
    view.renderer.render = () => { throw new Error("draw failed"); };
    pass.usable = true;
    expect(() => pass.captureBackground(view, input)).toThrow("draw failed");
    expect(view.renderer.setRenderTarget).toHaveBeenLastCalledWith(input);
    expect(view.fullscreenQuad.material).toBe(material);
    input.dispose();
});
