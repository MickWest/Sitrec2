// Frame reuse and GPU pacing: when a paused or held draw only presents the completed image, and when it must render.
import {Vector4, WebGLRenderTarget} from "three";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";
import {coordinatorFixture as fixture} from "./fixtures/thermalPipelineDoubles.js";

test("during playback a second draw inside the same frame shows that frame; the next frame renders", () => {
    // Playback advances par.frame continuously, so a fast renderer can draw twice inside one detector frame;
    // rendering it again would restart that frame's temporal filter and gain and make the noise flicker.
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
    // The render that settles the gain must show the image whose statistics it settled on, so it repeats the
    // temporal step instead of resetting the filter.
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

test("a failed render never associates its key with the previous image", () => {
    const {pipeline, inputs, clear} = fixture();
    try {
        pipeline.render(inputs);
        pipeline._radiance.mockImplementationOnce(() => {throw new Error("draw failed");});
        expect(() => pipeline.render({...inputs, reuseKey: "edited"})).toThrow("draw failed");
        clear(); pipeline.render(inputs); expect(pipeline._radiance).toHaveBeenCalledTimes(1);
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

function pacingContext() {
    const gl = {FRAMEBUFFER: 1, FRAMEBUFFER_COMPLETE: 2, checkFramebufferStatus: () => 2,
        SYNC_GPU_COMMANDS_COMPLETE: 3, SYNC_STATUS: 4, SIGNALED: 5, UNSIGNALED: 6, signaled: false,
        fenceSync: jest.fn(() => ({})), deleteSync: jest.fn()};
    gl.getSyncParameter = jest.fn(() => gl.signaled ? gl.SIGNALED : gl.UNSIGNALED);
    return gl;
}

test("a live render starts after the previous frame completes on the GPU; draws meanwhile show the last image", () => {
    // A live host asks for frames faster than the GPU completes them (about 200 ms of GPU time each, measured); queued
    // frames would make every synchronous WebGL call wait behind the queue.
    jest.useFakeTimers();
    const {pipeline, inputs, clear, renderer} = fixture(), gl = pacingContext();
    renderer.getContext = () => gl; pipeline.onReady = jest.fn();
    try {
        pipeline.render({...inputs, holdFrame: true, pace: true});
        expect(gl.fenceSync).toHaveBeenCalledTimes(1);
        const serial = pipeline.renderSerial;
        // The next frame arrives while the GPU is busy: the draw shows the last image and evaluates nothing.
        clear(); pipeline.render({...inputs, frame: 11, holdFrame: true, pace: true});
        expect(pipeline._radiance).not.toHaveBeenCalled();
        expect(pipeline.lastFrame).toMatchObject({frame: 10, reused: true, paced: true});
        expect(pipeline.renderSerial).toBe(serial);
        jest.advanceTimersByTime(40); expect(pipeline.onReady).not.toHaveBeenCalled();
        // The fence signals: the host is asked for a render, which evaluates the new frame and fences it.
        gl.signaled = true; jest.advanceTimersByTime(20);
        expect(pipeline.onReady).toHaveBeenCalledTimes(1);
        clear(); pipeline.render({...inputs, frame: 11, holdFrame: true, pace: true});
        expect(pipeline._radiance).toHaveBeenCalledTimes(1);
        expect(pipeline.lastFrame).toMatchObject({frame: 11, reused: false, paced: false});
        expect(gl.fenceSync).toHaveBeenCalledTimes(2);
        // A caller that reads the image after rendering (an export, a screenshot) does not ask for pacing: with the
        // GPU still busy it gets the frame it requested.
        gl.signaled = false;
        clear(); pipeline.render({...inputs, frame: 12, holdFrame: true});
        expect(pipeline._radiance).toHaveBeenCalledTimes(1);
        expect(pipeline.lastFrame).toMatchObject({frame: 12, reused: false, paced: false});
    } finally {pipeline.dispose(); jest.useRealTimers();}
    expect(gl.deleteSync).toHaveBeenCalled();
});

test("framesInFlight lets a paced render start while fewer frames than that are still on the GPU", () => {
    // Measured live: two frames in flight raised playback from 14 to 22 new frames per second, but each gain readback
    // then waited about 15 ms behind the other frame, so the default stays one.
    const {pipeline, inputs, clear, renderer} = fixture(), gl = pacingContext();
    renderer.getContext = () => gl;
    try {
        pipeline.render({...inputs, holdFrame: true, pace: true, framesInFlight: 2});
        clear(); pipeline.render({...inputs, frame: 11, holdFrame: true, pace: true, framesInFlight: 2});
        expect(pipeline._radiance).toHaveBeenCalledTimes(1); expect(pipeline.frameFences).toHaveLength(2);
        clear(); pipeline.render({...inputs, frame: 12, holdFrame: true, pace: true, framesInFlight: 2});
        expect(pipeline._radiance).not.toHaveBeenCalled(); expect(pipeline.lastFrame).toMatchObject({frame: 11, paced: true});
        // Both fences signal: they are released, and the next render starts.
        gl.signaled = true;
        clear(); pipeline.render({...inputs, frame: 12, holdFrame: true, pace: true, framesInFlight: 2});
        expect(pipeline._radiance).toHaveBeenCalledTimes(1); expect(pipeline.frameFences).toHaveLength(1);
        expect(gl.deleteSync).toHaveBeenCalledTimes(2);
    } finally {pipeline.dispose();}
});
