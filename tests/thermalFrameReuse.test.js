import {Color, PerspectiveCamera, Scene, Vector4, WebGLRenderTarget} from "three";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";

// The coordinator and gain statistics are real; the renderer does not execute shaders.
function fixture({width = 2, height = 2, automatic = false} = {}) {
    let target = null, viewport = new Vector4(1, 2, 3, 4), scissor = new Vector4(2, 3, 4, 5);
    const renderer = {autoClear: true, shadowMap: {enabled: true}, xr: {enabled: true},
        capabilities: {maxTextureSize: 16384}, getRenderTarget: () => target,
        getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
        getViewport: v => v.copy(viewport), getScissor: v => v.copy(scissor), getScissorTest: () => false,
        getClearColor: v => v.copy(new Color()), getClearAlpha: () => 1,
        setRenderTarget: v => {target = v;}, setViewport: v => {viewport = v.clone();},
        setScissor: v => {scissor = v.clone();}, setScissorTest() {}, setClearColor() {},
        getSize: v => v.set(width, height), getContext: () => ({FRAMEBUFFER: 1,
            FRAMEBUFFER_COMPLETE: 2, checkFramebufferStatus: () => 2})};
    const pipeline = new ThermalPipeline(renderer, {analysis: false, synchronous: false});
    pipeline.resources = {targets: new Map(), materials: new Map(), surfaces: new Map(),
        textures: new Set(), checkedSizes: new WeakMap()};
    pipeline.emptyTexture = {};
    pipeline._prepareAtmosphere = jest.fn();
    pipeline._prepareOptics = jest.fn(() => {pipeline.scatterSplit = {farMass: 0};});
    pipeline._prepareSkyBackground = jest.fn(() => {pipeline.background = {scaledPhotonRadiance: 0};});
    pipeline._radiance = jest.fn(); pipeline._optics = jest.fn(); pipeline._prepareFixedPattern = jest.fn();
    pipeline._pass = jest.fn();
    const counts = Float32Array.from({length: width * height}, (_, i) => 1000 + (i * 7919 % 12000));
    // Like the real readback, a sample carries the scene and image-state identity of the render that queued it.
    pipeline.gainReadback = {poll: () => pipeline.gainKey ? {counts, key: pipeline.gainKey, serial: pipeline.renderSerial - 1, frame: 10,
        scene: pipeline.renderSceneKey == null ? null : `${pipeline.renderSceneKey}#${pipeline._imageStateEpoch()}`} : null,
    enqueue: () => true, dispose() {}};
    const inputs = {scene: new Scene(), camera: new PerspectiveCamera(1, width / height, 1, 500000),
        settings: normalizeSettings({detectorWidth: width, detectorHeight: height, gainMode: automatic ? "automatic" : "manual",
            atmosphereEnabled: false, skySource: "manual", gainRegion: "detector"}), frame: 10, reuseKey: "same"};
    const clear = () => {for (const name of ["_prepareAtmosphere", "_prepareOptics", "_prepareSkyBackground", "_radiance", "_optics", "_prepareFixedPattern", "_pass"]) pipeline[name].mockClear();};
    return {pipeline, inputs, clear, renderer};
}

test("during playback a second draw inside the same frame shows that frame; the next frame renders", () => {
    // Found in review: playback advances par.frame continuously, so a fast renderer can draw twice inside one detector
    // frame; re-rendering would restart that frame's temporal filter and gain and make the noise flicker.
    const {pipeline, inputs, clear} = fixture();
    try {
        pipeline.render({...inputs, holdFrame: true});
        clear(); pipeline.render({...inputs, reuseKey: "moved", holdFrame: true});
        expect(pipeline._radiance).not.toHaveBeenCalled(); expect(pipeline.lastFrame.reused).toBe(true);
        clear(); pipeline.render({...inputs, reuseKey: "moved", frame: 11, holdFrame: true});
        expect(pipeline._radiance).toHaveBeenCalledTimes(1);
        // Paused (no hold), a changed scene inside the same frame renders again.
        clear(); pipeline.render({...inputs, reuseKey: "edited", frame: 11});
        expect(pipeline._radiance).toHaveBeenCalledTimes(1);
    } finally {pipeline.dispose();}
});

test("a re-render of the same frame and scene repeats its temporal step; an edited scene resets", () => {
    // Found in review: the render that settles the gain reset the temporal filter, so its image no longer matched
    // the statistics it settled on.
    const {pipeline, inputs, clear} = fixture();
    const settings = normalizeSettings({...inputs.settings, temporalFilterAlpha: .3});
    const temporal = () => pipeline._pass.mock.calls.filter(call => call[0] === "temporal").at(-1)[2];
    try {
        pipeline.render({...inputs, settings, frame: 9});
        pipeline.render({...inputs, settings, frame: 10});
        const first = temporal(), firstTarget = pipeline.temporalState.target;
        expect(first.memory).toBeCloseTo(.3, 12);
        pipeline.completedReuse = null; // the same frame and scene, but rendered again rather than reused
        clear(); pipeline.render({...inputs, settings, frame: 10});
        expect(temporal().memory).toBeCloseTo(.3, 12); expect(temporal().tPrevious).toBe(first.tPrevious);
        expect(pipeline.temporalState.target).toBe(firstTarget);
        clear(); pipeline.render({...inputs, settings, frame: 10, reuseKey: "edited"});
        expect(temporal().memory).toBe(0);
    } finally {pipeline.dispose();}
});

test("coordinator fixture completes a frame", () => {
    const {pipeline, inputs} = fixture();
    try {pipeline.render(inputs); expect(pipeline.hasFrame).toBe(true);} finally {pipeline.dispose();}
});

(process.env.THERMAL_REUSE_BENCH ? test : test.skip)("paused coordinator benchmark", () => {
    const {pipeline, inputs, clear} = fixture({width: 640, height: 512, automatic: true});
    try {
        for (let i = 0; i < 5; i++) pipeline.render(inputs);
        clearTimeout(pipeline.gainSettle); pipeline.gainSettle = null;
        const times = [];
        for (let i = 0; i < 31; i++) {
            clear(); const start = performance.now(); pipeline.render(inputs); times.push(performance.now() - start);
        }
        times.sort((a, b) => a - b);
        console.log(`Paused coordinator median: ${times[15].toFixed(3)} ms; passes: ${pipeline._pass.mock.calls.map(call => call[0]).join(",")}`);
    } finally {pipeline.dispose();}
});

test("an unchanged completed frame only presents and preserves temporal and detector state", () => {
    const {pipeline, inputs, clear, renderer} = fixture();
    try {
        pipeline.render(inputs);
        const display = pipeline.resources.targets.get("display"), last = pipeline.lastFrame;
        const temporal = pipeline.temporalState, serial = pipeline.renderSerial;
        clear(); pipeline.render(inputs);
        expect(pipeline._radiance).not.toHaveBeenCalled(); expect(pipeline._optics).not.toHaveBeenCalled();
        expect(pipeline._prepareOptics).not.toHaveBeenCalled(); expect(pipeline._prepareAtmosphere).not.toHaveBeenCalled();
        expect(pipeline._prepareSkyBackground).not.toHaveBeenCalled(); expect(pipeline._prepareFixedPattern).not.toHaveBeenCalled();
        expect(pipeline._pass.mock.calls.map(call => call[0])).toEqual(["enlarge"]);
        expect(pipeline._pass.mock.calls[0][2].tInput).toBe(display.texture);
        expect(pipeline.temporalState).toBe(temporal); expect(pipeline.renderSerial).toBe(serial);
        expect(pipeline.lastFrame).toBe(last); expect(last.reused).toBe(true);
        expect(renderer.autoClear).toBe(true); expect(renderer.shadowMap.enabled).toBe(true); expect(renderer.xr.enabled).toBe(true);
        expect(last.timing.stages).toHaveProperty("output");
    } finally {pipeline.dispose();}
});

test.each([
    ["different key", (p, i) => {i.reuseKey = "changed";}],
    ["null key", (p, i) => {i.reuseKey = null;}],
    ["non-string key", (p, i) => {i.reuseKey = 1;}],
    ["different frame", (p, i) => {i.frame++;}],
    ["missing frame", p => {p.hasFrame = false;}],
    ["analysis", p => {p.analysis = true;}],
    ["synchronous", p => {p.synchronous = true;}],
    ["held display", p => {p.lastFrame.held = true;}],
    ["optics worker", p => {p.opticsScheduler.pending = {};}],
    ["optics spectrum", p => {p.pendingOptics = {};}],
    ["range table", p => {p.rangeCache.pending = {};}],
    ["sky table", p => {p.skyCache.pending = {};}],
    ["gain settle", p => {p.gainSettle = setTimeout(() => {}, 60000);}],
    ["completed optics domain", p => {p.opticsScheduler.domain = {};}],
    ["completed range domain", p => {p.rangeCache.domain = {};}],
    ["completed sky table", p => {p.skyCache.cached = {};}],
])("%s prevents reuse", (name, change) => {
    const {pipeline, inputs, clear} = fixture();
    try {
        pipeline.render(inputs); clear(); change(pipeline, inputs); pipeline.render(inputs);
        expect(pipeline._radiance).toHaveBeenCalledTimes(1);
        expect(pipeline._optics).toHaveBeenCalledTimes(1);
        expect(pipeline._pass.mock.calls.some(call => call[0] === "detector")).toBe(true);
        expect(pipeline.lastFrame.reused).toBe(false);
    } finally {pipeline.dispose();}
});

test.each(["pendingOptics", "rangeCache", "skyCache", "opticsScheduler"])("a frame completed with %s pending must render again after completion", name => {
    const {pipeline, inputs, clear} = fixture();
    try {
        if (name === "pendingOptics") pipeline.pendingOptics = {}; else pipeline[name].pending = {};
        pipeline.render(inputs);
        if (name === "pendingOptics") pipeline.pendingOptics = null; else pipeline[name].pending = null;
        clear(); pipeline.render(inputs); expect(pipeline._radiance).toHaveBeenCalledTimes(1);
        clear(); pipeline.render(inputs); expect(pipeline._radiance).not.toHaveBeenCalled();
    } finally {pipeline.dispose();}
});

test("a ready gain fence still requires same-frame statistics; redundant readback does not prevent reuse", () => {
    const {pipeline, inputs, clear} = fixture({automatic: true});
    try {
        pipeline.render(inputs);
        clearTimeout(pipeline.gainSettle); pipeline.gainSettle = null;
        clear(); pipeline.render(inputs);
        expect(pipeline._radiance).toHaveBeenCalledTimes(1);
        expect(pipeline.gainReport).toMatchObject({held: false, statisticsFrame: 10});
        pipeline.gainReadback.pending = [{tag: {frame: 10}}];
        clear(); pipeline.render(inputs); expect(pipeline._radiance).not.toHaveBeenCalled();
        pipeline.gainReport.statisticsFrame = 9;
        clear(); pipeline.render(inputs); expect(pipeline._radiance).toHaveBeenCalledTimes(1);
    } finally {pipeline.dispose();}
});

test("a failed render never associates its key with the previous image", () => {
    const {pipeline, inputs, clear} = fixture();
    try {
        pipeline.render(inputs);
        pipeline._radiance.mockImplementationOnce(() => {throw new Error("draw failed");});
        expect(() => pipeline.render({...inputs, reuseKey: "edited"})).toThrow("draw failed");
        clear(); pipeline.render(inputs); expect(pipeline._radiance).toHaveBeenCalledTimes(1);
    } finally {pipeline.dispose();}
});

test("a held attempt does not record a completed key", () => {
    const {pipeline, inputs, clear} = fixture();
    try {
        pipeline.render(inputs);
        pipeline._prepareOptics.mockReturnValueOnce(false);
        expect(pipeline.render({...inputs, reuseKey: "edited"})).toBe(false);
        clear(); pipeline.render({...inputs, reuseKey: "edited"}); expect(pipeline._radiance).toHaveBeenCalledTimes(1);
    } finally {pipeline.dispose();}
});


test("reused presentation restores the target and host even if the output pass fails", () => {
    const {pipeline, inputs, renderer} = fixture(), target = new WebGLRenderTarget(20, 10);
    target.viewport.set(1, 2, 3, 4); target.scissorTest = true;
    try {
        pipeline.render(inputs);
        pipeline._pass.mockImplementationOnce(() => {target.viewport.set(0, 0, 20, 10); target.scissorTest = false; throw new Error("output failed");});
        expect(() => pipeline.render({...inputs, target})).toThrow("output failed");
        expect(renderer.getRenderTarget()).toBeNull();
        expect(renderer.autoClear).toBe(true); expect(renderer.shadowMap.enabled).toBe(true); expect(renderer.xr.enabled).toBe(true);
        expect(target.viewport).toEqual(new Vector4(1, 2, 3, 4)); expect(target.scissorTest).toBe(true);
        expect(pipeline.hasFrame).toBe(true);
    } finally {pipeline.dispose(); target.dispose();}
});

test.each(["analysis", "synchronous"])("%s with a key uses the same passes and uniforms as the reference route", mode => {
    const withKey = fixture(), reference = fixture();
    const uniforms = calls => calls.map(([name, shader, values]) => [name, shader,
        Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value?.isTexture ?
            [value.format, value.type, value.image?.width, value.image?.height, value.image?.data] : value]))]);
    withKey.pipeline[mode] = true; reference.pipeline[mode] = true;
    try {
        for (const frame of [0, 1, 1, 0]) {
            withKey.clear(); reference.clear();
            withKey.pipeline.render({...withKey.inputs, frame});
            reference.pipeline.render({...reference.inputs, frame, reuseKey: null});
            expect(uniforms(withKey.pipeline._pass.mock.calls)).toEqual(uniforms(reference.pipeline._pass.mock.calls));
            expect(withKey.pipeline.lastFrame.reused).toBe(false);
        }
    } finally {withKey.pipeline.dispose(); reference.pipeline.dispose();}
});
