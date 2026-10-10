// Automatic and plateau gain: when the display window settles on a frame's own statistics, in analysis renders
// (same-render statistics), in live renders with fenced readback, and with GPU statistics.
import {FencedReadback, ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {processingParameters} from "../tools/thermal/sensorMath.js";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";
import {compactSettings as compact, coordinatorFixture, fakeGl, hostFixture} from "./fixtures/thermalPipelineDoubles.js";

test("gain readback polls without waiting, preserves tags and bounds allocation", () => {
    const gl = fakeGl(), reader = new FencedReadback(gl);
    expect(reader.enqueue(2, 1, {serial: 1, key: "first"})).toBe(true);
    expect(reader.enqueue(2, 1, {serial: 2, key: "second"})).toBe(true);
    expect(reader.enqueue(2, 1, {})).toBe(false);
    // A pack-state query is a synchronous GPU-process round trip (110-128 ms behind queued passes, measured). The read
    // sets the state it needs and queries only the buffer binding, which the browser answers on the client side.
    expect(gl.getParameter.mock.calls.every(([name]) => name === gl.PIXEL_PACK_BUFFER_BINDING)).toBe(true);
    expect(gl.pixelStorei.mock.calls).toEqual(expect.arrayContaining([[gl.PACK_ROW_LENGTH, 0], [gl.PACK_SKIP_PIXELS, 0], [gl.PACK_SKIP_ROWS, 0]]));
    expect(reader.poll()).toBeNull(); expect(gl.getBufferSubData).not.toHaveBeenCalled();
    expect(gl.clientWaitSync.mock.calls.every(([, flags, timeout]) => flags === 0 && timeout === 0)).toBe(true);
    gl.clientWaitSync.mockReturnValue(gl.CONDITION_SATISFIED);
    expect(reader.poll()).toMatchObject({counts: new Float32Array([10, 20]), serial: 2, key: "second"});
    reader.dispose(); expect(gl.deleteBuffer).toHaveBeenCalledTimes(2); expect(gl.deleteSync).toHaveBeenCalledTimes(2);
});

test("interactive gain never reads synchronously, applies each sample once and never another key's", () => {
    const pipeline = new ThermalPipeline({}, {analysis: false});
    pipeline._read = () => {throw new Error("synchronous readback");};
    pipeline._target = () => ({}); pipeline._pass = () => {};
    pipeline.gainReadback = {poll: jest.fn(() => null), enqueue: jest.fn(() => true)};
    const settings = compact({gainMode: "automatic", gainRegion: "detector", agcTimeConstantS: 0, lowPercentile: 0, highPercentile: 1});
    const options = {gainKey: "A", reset: true, deltaTimeS: 1 / 30, width: 2, height: 2, frame: 0};
    pipeline.renderSerial = 1;
    expect(pipeline._gainParameters({}, settings, options).window).toEqual({low: 0, high: 16383});
    pipeline.gainReadback.poll.mockReturnValue({counts: new Float32Array([100, 200, 300, 400]), key: "A", serial: 1, frame: 0});
    pipeline.renderSerial = 2;
    const parameters = pipeline._gainParameters({}, settings, {...options, frame: 1});
    expect(parameters.window).toEqual({low: 100, high: 400}); expect(pipeline.gainReport.latencyFrames).toBe(1);
    pipeline.renderSerial = 4;
    pipeline._gainParameters({}, settings, {...options, reset: false, frame: 3});
    expect(pipeline.gainReport).toMatchObject({held: true, missedDeadline: true});
    pipeline.gainReadback.poll.mockReturnValue({counts: new Float32Array([999, 999, 999, 999]), key: "B", serial: 4, frame: 3});
    pipeline.renderSerial = 5;
    // Another gain key's sample never applies; the last valid window holds.
    expect(pipeline._gainParameters({}, settings, {...options, frame: 4}).window).toEqual({low: 100, high: 400});
    expect(pipeline.gainReport.held).toBe(true);
    clearTimeout(pipeline.gainSettle);
});

test("a re-rendered frame holds its window, then settles on that frame's own statistics", () => {
    // Sitrec renders a paused frame again whenever, for example, a terrain tile arrives. Without a ready sample that
    // render keeps the window, so the picture does not jump to the full ADC interval and back.
    jest.useFakeTimers();
    const onReady = jest.fn();
    const pipeline = new ThermalPipeline({}, {analysis: false, onReady});
    try {
        pipeline._read = () => {throw new Error("synchronous readback");};
        pipeline._target = () => ({}); pipeline._pass = () => {};
        const readback = {pending: [], poll: jest.fn(() => null), signaled: jest.fn(() => false),
            enqueue: jest.fn(() => {readback.pending.push({}); return true;}), dispose() {}};
        pipeline.gainReadback = readback;
        const settings = compact({gainMode: "automatic", gainRegion: "detector", agcTimeConstantS: 0, lowPercentile: 0, highPercentile: 1});
        const options = {gainKey: "A", reset: false, deltaTimeS: 1 / 30, width: 2, height: 2};
        const sample = (counts, serial, frame) => readback.poll.mockReturnValueOnce({counts: new Float32Array(counts), key: "A", serial, frame});
        pipeline.renderSerial = 1; pipeline._gainParameters({}, settings, {...options, reset: true, frame: 7});
        pipeline.lastFrame = {frame: 7};
        sample([100, 200, 300, 400], 1, 7); pipeline.renderSerial = 2;
        expect(pipeline._gainParameters({}, settings, {...options, frame: 8}).window).toEqual({low: 100, high: 400});
        pipeline.lastFrame = {frame: 8};
        // Re-render of frame 8 before its sample is ready: hold the window, never the full ADC interval.
        pipeline.renderSerial = 3;
        expect(pipeline._gainParameters({}, settings, {...options, reset: true, frame: 8}).window).toEqual({low: 100, high: 400});
        expect(pipeline.gainReport.held).toBe(true);
        // Nothing else renders (paused): once the sample is ready, exactly one more render is requested.
        readback.signaled.mockReturnValue(true);
        jest.advanceTimersByTime(20);
        expect(onReady).toHaveBeenCalledTimes(1);
        // That render recomputes frame 8's window from its own statistics, as an analysis re-render does.
        sample([500, 600, 700, 800], 3, 8); pipeline.renderSerial = 4;
        expect(pipeline._gainParameters({}, settings, {...options, reset: true, frame: 8}).window).toEqual({low: 500, high: 800});
        // Further re-renders with no new sample keep it.
        pipeline.renderSerial = 5;
        expect(pipeline._gainParameters({}, settings, {...options, reset: true, frame: 8}).window).toEqual({low: 500, high: 800});
        // After a backward seek, a sample from a later frame never applies.
        sample([1, 2, 3, 4], 5, 8); pipeline.renderSerial = 6;
        expect(pipeline._gainParameters({}, settings, {...options, reset: true, frame: 2}).window).toEqual({low: 500, high: 800});
    } finally {pipeline.dispose(); jest.useRealTimers();}
});

test("a paused edit does not settle on statistics recorded before it", () => {
    // With frame reuse, an edited paused frame that settled on the previous scene's statistics would keep that window
    // for as long as the frame is reused.
    jest.useFakeTimers();
    const onReady = jest.fn();
    const pipeline = new ThermalPipeline({}, {analysis: false, onReady});
    try {
        pipeline._read = () => {throw new Error("synchronous readback");};
        pipeline._target = () => ({}); pipeline._pass = () => {};
        const readback = {pending: [], poll: jest.fn(() => null), signaled: jest.fn(() => true),
            enqueue: jest.fn(() => {readback.pending.push({}); return true;}), dispose() {}};
        pipeline.gainReadback = readback;
        const settings = compact({gainMode: "automatic", gainRegion: "detector", agcTimeConstantS: 0, lowPercentile: 0, highPercentile: 1});
        const options = {gainKey: "A", reset: true, deltaTimeS: 0, width: 2, height: 2, frame: 8};
        // A sample's scene tag is the host scene plus the pipeline's image-state epoch, as the real readback records.
        const sample = (counts, serial, scene) => readback.poll.mockReturnValueOnce({counts: new Float32Array(counts), key: "A", serial,
            frame: 8, scene: `${scene}#${pipeline._imageStateEpoch()}`});
        pipeline.lastFrame = {frame: 8};
        pipeline.renderSceneKey = "before"; sample([100, 200, 300, 400], 1, "before"); pipeline.renderSerial = 2;
        pipeline._gainParameters({}, settings, options);
        expect(pipeline.gainReport.settled).toBe(true);
        // The edit changes the host's scene identity; the newest same-frame sample predates it.
        pipeline.renderSceneKey = "after"; sample([100, 200, 300, 400], 2, "before"); pipeline.renderSerial = 3;
        expect(pipeline._gainParameters({}, settings, options).window).toEqual({low: 100, high: 400});
        expect(pipeline.gainReport.settled).toBe(false);
        jest.advanceTimersByTime(20);
        expect(onReady).toHaveBeenCalledTimes(1);
        // The requested render applies the edited scene's own statistics and settles.
        sample([500, 600, 700, 800], 3, "after"); pipeline.renderSerial = 4;
        expect(pipeline._gainParameters({}, settings, options).window).toEqual({low: 500, high: 800});
        expect(pipeline.gainReport.settled).toBe(true);
    } finally {pipeline.dispose(); jest.useRealTimers();}
});

test("an advancing frame applies the newest unused sample even when the GPU lags a render", () => {
    const pipeline = new ThermalPipeline({}, {analysis: false});
    pipeline._read = () => {throw new Error("synchronous readback");};
    pipeline._target = () => ({}); pipeline._pass = () => {};
    const readback = {pending: [], poll: jest.fn(() => null), enqueue: jest.fn(() => true)};
    pipeline.gainReadback = readback;
    const settings = compact({gainMode: "automatic", gainRegion: "detector", agcTimeConstantS: 0, lowPercentile: 0, highPercentile: 1});
    const options = {gainKey: "A", reset: false, deltaTimeS: 1 / 30, width: 2, height: 2};
    pipeline.renderSerial = 1; pipeline._gainParameters({}, settings, {...options, reset: true, frame: 10});
    pipeline.lastFrame = {frame: 10}; pipeline.renderSerial = 2; pipeline._gainParameters({}, settings, {...options, frame: 14});
    // Two renders later, frame 10's sample is the newest ready one, and it applies.
    readback.poll.mockReturnValueOnce({counts: new Float32Array([100, 200, 300, 400]), key: "A", serial: 1, frame: 10});
    pipeline.lastFrame = {frame: 14}; pipeline.renderSerial = 3;
    expect(pipeline._gainParameters({}, settings, {...options, frame: 18}).window).toEqual({low: 100, high: 400});
    expect(pipeline.gainReport).toMatchObject({held: false, latencyFrames: 2});
    clearTimeout(pipeline.gainSettle);
});

test("paused, revisited and backward frames recompute gain; advancing frames still settle",()=>{
    const {pipeline,settings,scene,camera}=hostFixture();
    pipeline.render({scene,camera,settings,frame:10});const old={...pipeline.window};
    const codes=new Float32Array([1100,1200,1300,1400]);pipeline._read=()=>codes;
    pipeline.render({scene,camera,settings,frame:11});
    expect(pipeline.window.low).toBeGreaterThan(old.low);expect(pipeline.window.low).toBeLessThan(1100);
    const fresh=processingParameters(codes,settings).window;
    pipeline.render({scene,camera,settings,frame:11});expect(pipeline.window).toEqual(fresh);
    pipeline._read=()=>new Float32Array([2100,2200,2300,2400]);camera.position.x=20;
    pipeline.render({scene,camera,settings,frame:11});expect(pipeline.window.low).toBe(2100);
    pipeline._read=()=>codes;pipeline.render({scene,camera,settings,frame:3});expect(pipeline.window).toEqual(fresh);
    pipeline.dispose();
});

test("interactive render restores the host and never performs a synchronous gain read", () => {
    const {pipeline, settings, scene, camera, state} = hostFixture(), before = state();
    pipeline.analysis = false;
    pipeline._read = () => {throw new Error("synchronous frame read");};
    pipeline.gainReadback = {poll: jest.fn(() => null), enqueue: jest.fn(() => true), dispose() {}};
    pipeline.render({scene, camera, settings, frame: 10});
    expect(pipeline.lastFrame.gain).toMatchObject({mode: "fenced", held: true, queued: true});
    pipeline.gainReadback.poll.mockReturnValue({counts: new Float32Array([100, 200, 300, 400]),
        key: pipeline.gainKey, serial: 1, frame: 10});
    pipeline.render({scene, camera, settings, frame: 11});
    expect(pipeline.lastFrame.gain).toMatchObject({mode: "fenced", held: false, latencyFrames: 1});
    expect(state()).toEqual(before); expect(pipeline.gainReadback.enqueue).toHaveBeenCalledTimes(2);
    pipeline.dispose();
});

test.each([2048,16384])("GPU histogram stacks fit a %i-pixel texture limit",maximum=>{
    const {pipeline,renderer,settings}=hostFixture();
    pipeline.analysis=false;renderer.capabilities.maxTextureSize=maximum;
    pipeline._scatter=jest.fn();
    pipeline._gpuGain({texture:{}},{...settings,gainMode:"automatic"},
        {reset:true,deltaTimeS:0,width:2,height:2,presentation:null,frame:0});
    for(const [uniforms,target,samples] of pipeline._scatter.mock.calls) {
        expect(target.height).toBeLessThanOrEqual(maximum);
        expect(uniforms.copies).toBe(Math.min(32,Math.floor(maximum/uniforms.histogramSize[1])));
        expect(samples).toBe(4);
    }
    expect(pipeline._scatter).toHaveBeenCalledTimes(2);
    pipeline.dispose();
});

test("a ready gain fence still requires same-frame statistics; redundant readback does not prevent reuse", () => {
    const {pipeline, inputs, clear} = coordinatorFixture({automatic: true});
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

test("a live render reads finished gain statistics before it queues the frame's passes", () => {
    // The read is a synchronous round trip to the GPU process; after the passes it would wait for them (up to 182 ms,
    // measured).
    const {pipeline, inputs} = coordinatorFixture({automatic: true}), order = [], poll = pipeline.gainReadback.poll;
    pipeline.gainReadback.poll = () => {order.push("poll"); return poll();};
    pipeline._radiance = jest.fn(() => order.push("radiance"));
    try {
        pipeline.render(inputs); order.length = 0;
        pipeline.render({...inputs, frame: 11});
        expect(order.slice(0, 2)).toEqual(["poll", "radiance"]);
    } finally {pipeline.dispose();}
});

test("live GPU gain uses each frame's own statistics: no readback, settled at once, AGC step only on advancing frames", () => {
    // The GPU statistics remove the readback that waited behind queued GPU work (see _gpuGain).
    const {pipeline, inputs, clear} = coordinatorFixture({automatic: true});
    pipeline.gpuGain = true; pipeline._scatter = jest.fn();
    pipeline.gainReadback = {poll: jest.fn(() => null), enqueue: jest.fn(() => true), dispose() {}};
    const settings = normalizeSettings({...inputs.settings, agcTimeConstantS: .5});
    const last = name => pipeline._pass.mock.calls.filter(call => call[0] === name).at(-1)?.[2];
    try {
        pipeline.render({...inputs, settings});
        expect(pipeline.gainReadback.enqueue).not.toHaveBeenCalled();
        expect(pipeline.lastFrame.gain).toMatchObject({mode: "gpu", settled: true, statisticsFrame: 10, window: null});
        expect(last("gainWindow")).toMatchObject({hasPrevious: false, alpha: 1});
        expect(last("processingGainState")).toBeDefined(); expect(last("processing")).toBeUndefined();
        // Ranks as percentileCounts: floor(p (n - 1)) over the 2 × 2 detector.
        expect(last("gainSelect").ranks).toEqual([Math.floor(settings.lowPercentile * 3), Math.floor(settings.highPercentile * 3)]);
        expect(pipeline._scatter).toHaveBeenCalledTimes(2);
        clear(); pipeline.render({...inputs, settings, frame: 13});
        expect(last("gainWindow").hasPrevious).toBe(true);
        expect(last("gainWindow").alpha).toBeCloseTo(-Math.expm1(-(3 / settings.frameRateHz) / .5), 12);
        // A re-render of the same frame starts from that frame's statistics, as an analysis render does.
        clear(); pipeline.render({...inputs, settings, frame: 13, reuseKey: "edited"});
        expect(last("gainWindow")).toMatchObject({hasPrevious: false, alpha: 1});
        expect(pipeline.gainReadback.enqueue).not.toHaveBeenCalled();
    } finally {pipeline.dispose();}
});
