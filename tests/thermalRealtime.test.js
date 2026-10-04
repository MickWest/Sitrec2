import {PerspectiveCamera} from "three";
import {Worker as NodeWorker} from "node:worker_threads";
import {readFileSync} from "node:fs";
import {createDefaultOpticsWorker, OpticsScheduler, OPTICS_DOMAIN_CACHE_BYTES, opticalDomainBytes, opticalStructureKey} from "../tools/thermal/sensorMath.js";
import {createOpticsWorker} from "../src/rendering/ThermalWorkerFactory.js";
import {OpticalKernelCache, opticalKernelError, OPTICS_L1_TOLERANCE, buildOpticalDomain, sampleOpticalDomain, psfSpectrum} from "../tools/thermal/sensorMath.js";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";
import {opticalKernels, scatterPlan, applyOptics} from "../tools/thermal/sensorMath.js";
import {createAtmosphere, backgroundAtElevation, skyViewGeometry, sampleSkyElevationLUT,
    brightnessErrorBound, createThermalRayGeometry, skyElevationRange} from "../tools/thermal/atmosphere.js";
import {FencedReadback, ThermalGpuTimer} from "../tools/thermal/ThermalPipeline.js";
import {SkyBackgroundCache} from "../tools/thermal/atmosphere.js";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {skyGradientReference} from "../tools/thermal/selfTest.js";

const compact = extra => normalizeSettings({detectorWidth: 16, detectorHeight: 12,
    fieldMode: "focalLength", focalStep: "free", focalLengthM: .675,
    opticalSamplingMode: "manual", supersample: 2, opticsRadiusPx: 4,
    scatterFraction: 0, scatterPreset: "custom", ...extra});

test.each([0, .12, .7])("spectral basis preserves full finite kernels at r0=%s m", turbulenceR0M => {
    const cache = new OpticalKernelCache(), atmosphere = createAtmosphere();
    for (const psfRangeM of [0, 2000, 125000]) {
        const settings = compact({turbulenceR0M, psfRangeM, sensorAltitudeM: 1380, pathElevationDeg: 2.27});
        const actual = cache.candidate(settings, 32, 24, atmosphere);
        const reference = opticalKernels(settings, 32, 24, atmosphere);
        // Calculated floating-point allowance for commuting a linear FFT filter
        // with spectral mixing; far below the estimated cache reuse budget.
        expect(opticalKernelError(actual, reference)).toBeLessThan(2e-6);
        expect(cache.basisRebuilt).toBe(psfRangeM === 0);
    }
});

test("IB6830 lens steps retain the independent full-kernel result at long range", () => {
    const atmosphere = createAtmosphere(); let maximum = 0;
    for (const focalStep of ["675", "1012"]) {
        const cache = new OpticalKernelCache();
        for (const psfRangeM of [120000, 145000]) {
            const settings = normalizeSettings({sensorPreset: "MX15", focalStep, psfRangeM,
                sensorAltitudeM: 1380, pathElevationDeg: 2.27});
            const width = settings.detectorWidth * settings.supersample, height = settings.detectorHeight * settings.supersample;
            const actual = cache.candidate(settings, width, height, atmosphere);
            const reference = opticalKernels(settings, width, height, atmosphere);
            maximum = Math.max(maximum, opticalKernelError(actual, reference));
        }
    }
    expect(maximum).toBeLessThan(2e-6);
    console.log(`IB6830 preset finite-kernel maximum L1 difference: ${maximum}`);
});

test("moving range checks the actual kernel and invalidates changed optical physics", () => {
    const cache = new OpticalKernelCache(), atmosphere = createAtmosphere();
    const settings = compact({psfRangeM: 125000, sensorAltitudeM: 1380, pathElevationDeg: 2.27});
    const original = cache.candidate(settings, 32, 24, atmosphere);
    const moved = cache.candidate({...settings, psfRangeM: 125008}, 32, 24, atmosphere);
    expect(cache.basisRebuilt).toBe(false);
    const bound = opticalKernelError(original, moved);
    expect(bound).toBeLessThan(OPTICS_L1_TOLERANCE);
    const input = Float32Array.from({length: 32 * 24}, (_, i) => i % 7 === 0 ? 1 : 0);
    const a = applyOptics(input, 32, 24, original, 0), b = applyOptics(input, 32, 24, moved, 0);
    expect(Math.max(...a.map((v, i) => Math.abs(v - b[i])))).toBeLessThanOrEqual(bound + 1e-7);
    cache.candidate({...settings, turbulenceR0M: .2}, 32, 24, atmosphere);
    expect(cache.basisRebuilt).toBe(true);
});

test("retained default support requires 4096 while smaller fields choose smaller FFTs", () => {
    const settings = normalizeSettings({sensorPreset: "MX15"}), plan = scatterPlan(settings);
    expect(plan).toMatchObject({fftWidth: 4096, fftHeight: 4096, requiredWidth: 3328, requiredHeight: 2816});
    const small = scatterPlan(compact({scatterFraction: 0}));
    expect(small.fftWidth).toBeLessThan(4096);
    for (const p of [plan, small]) {
        expect(p.fftWidth).toBeGreaterThanOrEqual(p.requiredWidth);
        expect(p.fftHeight).toBeGreaterThanOrEqual(p.requiredHeight);
        expect(p.fftWidth / 2).toBeLessThan(p.requiredWidth);
        expect(p.fftHeight / 2).toBeLessThan(p.requiredHeight);
    }
});

test("every displayed moving kernel, including deferred refreshes, stays inside the current bound", () => {
    const pipeline = new ThermalPipeline({}, {analysis: false});
    pipeline.resources = {targets: new Map(), materials: new Map(), textures: new Set(), surfaces: new Map()}; pipeline._prepareSpectrum = jest.fn(name => pipeline.resources.targets.set(name, {dispose() {}}));
    pipeline.atmosphere = createAtmosphere();
    pipeline.opticsScheduler.domain = buildOpticalDomain(compact({}), 32, 24, psfSpectrum(compact({}), pipeline.atmosphere));
    let pending = 0, rebuilds = 0;
    for (let frame = 0; frame < 60; frame++) {
        // Estimated 250 m/s radial track, 30 delivered frames/s.
        const settings = compact({psfRangeM: 2000 + 250 * frame / 30, pathElevationDeg: 2.27, sensorAltitudeM: 1380});
        pipeline._prepareOptics(settings, 32, 24);
        const error = opticalKernelError(pipeline.activeKernels, opticalKernels(settings, 32, 24, pipeline.atmosphere));
        expect(error).toBeLessThanOrEqual(OPTICS_L1_TOLERANCE + 2e-6);
        pending += Number(pipeline.opticsReport.pending); rebuilds += Number(pipeline.opticsReport.spectraRebuilt);
    }
    expect(pending).toBeGreaterThan(0); expect(rebuilds).toBeLessThan(60);
    // A discontinuous camera seek has no right to keep a now-invalid kernel.
    const jump = compact({psfRangeM: 125000, pathElevationDeg: 2.27, sensorAltitudeM: 1380});
    pipeline._prepareOptics(jump, 32, 24);
    expect(pipeline.opticsReport).toMatchObject({spectraRebuilt: true, pending: false});
    expect(pipeline.opticsReport.errorL1).toBeLessThan(OPTICS_L1_TOLERANCE);
    pipeline.dispose();
});

test("failed spectrum replacement cannot leave an apparently valid cache", () => {
    const pipeline = new ThermalPipeline({}, {analysis: true});
    pipeline._prepareSpectrum = jest.fn();
    const settings = compact({});
    pipeline._prepareOptics(settings, 32, 24);
    pipeline._prepareSpectrum.mockImplementationOnce(() => {throw new Error("allocation");});
    expect(() => pipeline._prepareOptics({...settings, opticsRadiusPx: 5}, 32, 24)).toThrow("allocation");
    expect(pipeline.opticsKey).toBeNull();
    const calls = pipeline._prepareSpectrum.mock.calls.length;
    pipeline._prepareOptics(settings, 32, 24);
    expect(pipeline._prepareSpectrum).toHaveBeenCalledTimes(calls + 1);
    expect(pipeline.opticsReport.spectraRebuilt).toBe(true);
});

test("sky cache reuses checked elevation domain and agrees at independent moving rays", () => {
    const atmosphere = createAtmosphere(), cache = new SkyBackgroundCache();
    const settings = compact({sensorAltitudeM: 1380}), camera = new PerspectiveCamera(.8, 4 / 3, 1, 200000);
    const band = {minUm: 3, maxUm: 5};
    let first;
    for (let frame = 0; frame < 31; frame++) {
        const elevation = .04 + frame * 1e-5;
        const view = skyViewGeometry(settings, [0, Math.cos(elevation), -Math.sin(elevation)], camera);
        const options = {view, sensorAltitudeM: 1380, temperatureK: 288.15, band};
        const table = cache.table(options, atmosphere); first ??= table;
        expect(table).toBe(first);
        for (const offset of [-.00371, .000317, .00291]) {
            const e = elevation + offset;
            const actual = backgroundAtElevation(e, options, atmosphere).photonRadiance;
            const predicted = sampleSkyElevationLUT(table, e);
            expect(brightnessErrorBound(Math.abs(actual - predicted), Math.min(actual, predicted), band)).toBeLessThan(.005);
        }
    }
    const shifted = cache.table({...first.options, sensorAltitudeM: 1380.001}, atmosphere);
    expect(shifted).toBe(first);
    expect(shifted.altitudeDomain.maxErrorK).toBeLessThanOrEqual(.001);
    expect(cache.table({...first.options, sensorAltitudeM: 1400}, atmosphere)).not.toBe(first);
    expect(cache.table(first.options, createAtmosphere({surfaceTemperatureK: 300}))).not.toBe(first);
});

test("mapped horizon cache never blends the separate sky and sea limits", () => {
    const cache = new SkyBackgroundCache(), atmosphere = createAtmosphere();
    const settings = compact({sensorAltitudeM: 21});
    const camera = new PerspectiveCamera(2, 4 / 3, 1, 200000);
    const rayGeometry = createThermalRayGeometry({sensorAltitudeM: 21, earthRadiusM: 6371000,
        lift: () => 0, key: "estimated-flat-lift-fixture"});
    const options = {sensorAltitudeM: 21, temperatureK: 288.15, band: {minUm: 3, maxUm: 5}, rayGeometry,
        view: skyViewGeometry(settings, [0, 1, 0], camera)};
    const table = cache.table(options, atmosphere);
    for (const offset of [-1e-7, 1e-7]) {
        const e = rayGeometry.horizonRad + offset;
        const actual = backgroundAtElevation(e, options, atmosphere).photonRadiance;
        const interpolated = sampleSkyElevationLUT(table, e);
        expect(brightnessErrorBound(Math.abs(actual - interpolated), Math.min(actual, interpolated), options.band)).toBeLessThan(.005);
    }
});

test("zero-radiance vacuum sky retains a finite altitude reuse bound", () => {
    const cache = new SkyBackgroundCache(), atmosphere = createAtmosphere({densityScale: 0});
    const settings = compact({sensorAltitudeM: 1380});
    const options = {sensorAltitudeM: 1380, temperatureK: 288.15, band: {minUm: 3, maxUm: 5},
        view: skyViewGeometry(settings, [0, Math.cos(.1), -Math.sin(.1)])};
    const table = cache.table(options, atmosphere);
    expect(cache.table({...options, sensorAltitudeM: 1380.001}, atmosphere)).toBe(table);
    expect(table.altitudeDomain.maxErrorK).toBe(0);
});

test.each([null, [Math.cos(2.23 * Math.PI / 180), 0, -Math.sin(2.23 * Math.PI / 180)]])(
    "offline sky uses the exact reference table and unchanged inputs reuse identical values (%s)", up => {
        const reference = skyGradientReference(up), pipeline = new ThermalPipeline({});
        pipeline.resources = {textures: new Set(), surfaces: new Map(), materials: new Map(), targets: new Map()};
        pipeline.atmosphere = reference.atmosphere;
        try {
            pipeline._prepareSkyBackground(reference.settings, reference.view);
            const table = pipeline.skyTable, texture = pipeline.skyTableTexture;
            expect(table.elevations).toEqual(reference.table.elevations);
            expect(table.photonRadiances).toEqual(reference.table.photonRadiances);
            pipeline._prepareSkyBackground(reference.settings, reference.view);
            expect(pipeline.skyTable).toBe(table);
            expect(pipeline.skyTableTexture).toBe(texture);
            expect(pipeline.skyCacheRebuilt).toBe(false);
        } finally {pipeline.dispose();}
    });

test("an interactive view reads its centre sky value from the sky table instead of a new path integral", () => {
    // Found live: the centre ray's 96-segment path integral ran on every moving frame (~40 ms) although the sky
    // gradient draws the background from the validated table and ignores that value.
    const reference = skyGradientReference(null);
    const settings = {...reference.settings, pathElevationDeg: skyElevationRange(reference.view).centerRad * 180 / Math.PI};
    const run = analysis => {
        const pipeline = new ThermalPipeline({}, {analysis});
        pipeline.resources = {textures: new Set(), surfaces: new Map(), materials: new Map(), targets: new Map()};
        pipeline.skyView = reference.view;
        pipeline._prepareAtmosphere(settings, null);
        const deferred = pipeline.background.deferredRadiance;
        pipeline._prepareSkyBackground(settings, reference.view);
        return {pipeline, deferred, kelvin: pipeline.background.brightnessTemperatureK};
    };
    const live = run(false), offline = run(true);
    try {
        expect(live.deferred).toBe(true); expect(offline.deferred).toBe(false);
        expect(live.pipeline.background.deferredRadiance).toBe(false);
        // The sky shader's own lookup in the validated table: inside the table's stated 0.005 K bound of the integral.
        expect(Math.abs(live.kelvin - offline.kelvin)).toBeLessThan(.005);
    } finally {live.pipeline.dispose(); offline.pipeline.dispose();}
});

function fakeGl() {
    const gl = Object.fromEntries(["PIXEL_PACK_BUFFER_BINDING", "PACK_ALIGNMENT", "PACK_ROW_LENGTH", "PACK_SKIP_PIXELS",
        "PACK_SKIP_ROWS", "PIXEL_PACK_BUFFER", "STREAM_READ", "RGBA", "FLOAT", "SYNC_GPU_COMMANDS_COMPLETE",
        "TIMEOUT_EXPIRED", "WAIT_FAILED", "CONDITION_SATISFIED", "CURRENT_QUERY", "QUERY_RESULT_AVAILABLE", "QUERY_RESULT"].map((name, i) => [name, i + 1]));
    Object.assign(gl, {getParameter: jest.fn(() => 0), createBuffer: jest.fn(() => ({})), bindBuffer: jest.fn(),
        bufferData: jest.fn(), pixelStorei: jest.fn(), readPixels: jest.fn(), fenceSync: jest.fn(() => ({})),
        flush: jest.fn(), deleteBuffer: jest.fn(), deleteSync: jest.fn(),
        clientWaitSync: jest.fn(() => gl.TIMEOUT_EXPIRED),
        getBufferSubData: jest.fn((target, offset, data) => data.set([10, 0, 0, 1, 20, 0, 0, 1]))});
    return gl;
}

test("gain readback polls without waiting, preserves tags and bounds allocation", () => {
    const gl = fakeGl(), reader = new FencedReadback(gl);
    expect(reader.enqueue(2, 1, {serial: 1, key: "first"})).toBe(true);
    expect(reader.enqueue(2, 1, {serial: 2, key: "second"})).toBe(true);
    expect(reader.enqueue(2, 1, {})).toBe(false);
    // Found live: a pack-state query is a synchronous GPU-process round trip (110-128 ms behind queued passes). The
    // read sets the state it needs and queries only the buffer binding, which the browser answers on the client side.
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
    // Sitrec re-renders a paused frame whenever, for example, a terrain tile arrives. Before the fix a
    // re-render without a ready sample showed the full ADC interval, so the picture jumped between two states.
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
    // Found in review: with frame reuse, an edited paused frame could settle on the previous scene's statistics and
    // then be re-presented with that stale window indefinitely.
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
    // Two renders later, frame 10's sample is the newest ready one; before the fix it was refused.
    readback.poll.mockReturnValueOnce({counts: new Float32Array([100, 200, 300, 400]), key: "A", serial: 1, frame: 10});
    pipeline.lastFrame = {frame: 14}; pipeline.renderSerial = 3;
    expect(pipeline._gainParameters({}, settings, {...options, frame: 18}).window).toEqual({low: 100, high: 400});
    expect(pipeline.gainReport).toMatchObject({held: false, latencyFrames: 2});
    clearTimeout(pipeline.gainSettle);
});

test("GPU timer discards disjoint samples and converts valid ns to ms", () => {
    const gl = fakeGl(), extension = {TIME_ELAPSED_EXT: 100, GPU_DISJOINT_EXT: 101};
    Object.assign(gl, {getExtension: () => extension, getQuery: () => null, createQuery: () => ({}),
        beginQuery: jest.fn(), endQuery: jest.fn(), deleteQuery: jest.fn(),
        getQueryParameter: (query, key) => key === gl.QUERY_RESULT_AVAILABLE ? true : 2500000});
    const timer = new ThermalGpuTimer(gl);
    timer.begin(1, "optics"); timer.end(); timer.poll();
    expect(timer.samples).toEqual([{frame: 1, stage: "optics", ms: 2.5}]);
    timer.begin(2, "optics"); timer.end(); gl.getParameter.mockReturnValue(true); timer.poll();
    expect(timer.samples).toHaveLength(1); expect(timer.disjointSamples).toBe(1); timer.dispose();
});


test("interactive construction displays a bounded coarse preview, retains output on edits and rejects late replies", async () => {
    const worker = {postMessage: jest.fn(), terminate: jest.fn()};
    const onReady = jest.fn(), pipeline = new ThermalPipeline({}, {analysis: false, createOpticsWorker: () => worker, onReady});
    pipeline._prepareSpectrum = jest.fn(); pipeline.atmosphere = createAtmosphere();
    pipeline.opticalCache.candidate = () => {throw Error("synchronous construction");};
    const settings = compact({turbulenceR0M: 0});
    expect(pipeline._prepareOptics(settings, 32, 24)).toBe(true);
    expect(pipeline._prepareSpectrum).toHaveBeenCalled();
    expect(pipeline.opticsReport).toMatchObject({quality: "coarse", errorL1: 2, pending: true});
    expect(pipeline.opticsReport.message).toMatch(/Coarse.*bound/);
    await pipeline.opticsScheduler.workerPromise;
    await Promise.resolve();
    const message = worker.postMessage.mock.calls[0][0];
    worker.onmessage({data: {id: message.id, domain: buildOpticalDomain(settings, 32, 24, message.spectrum)}});
    expect(pipeline._prepareOptics(settings, 32, 24)).toBe(true);
    expect(pipeline.opticsReport.quality).toBe("full");
    const installed = pipeline.activeKernels;
    // An incompatible edit queues work and preserves the completed output.
    expect(pipeline._prepareOptics({...settings, defocusM: 1e-5}, 32, 24)).toBe(true);
    expect(pipeline.activeKernels).toBe(installed);
    pipeline.dispose();
    const calls = onReady.mock.calls.length;
    worker.onmessage({data: {id: message.id, domain: {}}});
    expect(onReady).toHaveBeenCalledTimes(calls); expect(worker.terminate).toHaveBeenCalledTimes(1);
});

// A worker stand-in that answers each posted build with the real domain, on request.
function domainWorker() {
    const worker = {postMessage: jest.fn(), terminate: jest.fn()};
    worker.complete = () => {
        const message = worker.postMessage.mock.calls.at(-1)[0];
        worker.onmessage({data: {id: message.id, complete: true, buildMs: 1,
            domain: buildOpticalDomain(message.settings, 32, 24, message.spectrum)}});
    };
    return worker;
}
const settle = async scheduler => {await scheduler.workerPromise; await Promise.resolve(); await Promise.resolve();};

test("completed domains are kept per lens within a byte budget: A, B, then A again builds nothing, and the least recently used is evicted", async () => {
    expect(OPTICS_DOMAIN_CACHE_BYTES).toBe(128 * 2 ** 20);
    const worker = domainWorker(), atmosphere = createAtmosphere();
    // Three lens focal lengths: each is a different optical structure.
    const [a, b, c] = [.675, 1.012, .135].map(focalLengthM => compact({focalLengthM}));
    const bytes = [a, b, c].map(lens => opticalDomainBytes(buildOpticalDomain(lens, 32, 24, psfSpectrum(lens, atmosphere))));
    // A budget that holds any two of these domains, but not all three.
    const budget = 2 * Math.max(...bytes);
    expect(bytes[0] + bytes[1] + bytes[2]).toBeGreaterThan(budget);
    const scheduler = new OpticsScheduler({createWorker: () => worker, domainBudgetBytes: budget});
    const key = settings => opticalStructureKey(settings, 32, 24);
    try {
        for (const lens of [a, b]) {scheduler.request(lens, 32, 24, atmosphere); await settle(scheduler); worker.complete();}
        expect(worker.postMessage).toHaveBeenCalledTimes(2); expect(scheduler.retainedBytes).toBe(bytes[0] + bytes[1]);
        const back = scheduler.request(a, 32, 24, atmosphere);
        await settle(scheduler);
        expect(back).toMatchObject({pending: false}); expect(back.kernels).not.toBeNull();
        expect(opticalKernelError(back.kernels, opticalKernels(a, 32, 24, atmosphere))).toBeLessThan(2e-6);
        expect(scheduler.domain.key).toBe(key(a)); expect(worker.postMessage).toHaveBeenCalledTimes(2);
        // A was used after B, so a third lens evicts B, and B then needs a new build.
        scheduler.request(c, 32, 24, atmosphere); await settle(scheduler); worker.complete();
        expect([...scheduler.domains.keys()]).toEqual([key(a), key(c)]);
        expect(scheduler.retainedBytes).toBe(bytes[0] + bytes[2]);
        expect(scheduler.request(b, 32, 24, atmosphere)).toMatchObject({kernels: null, pending: true});
        await settle(scheduler); expect(worker.postMessage).toHaveBeenCalledTimes(4);
    } finally {scheduler.dispose(); expect(scheduler.domains.size).toBe(0);}
});

test("the domain in current use stays even when it alone is larger than the budget", async () => {
    const worker = domainWorker(), atmosphere = createAtmosphere();
    const scheduler = new OpticsScheduler({createWorker: () => worker, domainBudgetBytes: 1});
    const [a, b] = [.675, 1.012].map(focalLengthM => compact({focalLengthM}));
    try {
        for (const lens of [a, b]) {scheduler.request(lens, 32, 24, atmosphere); await settle(scheduler); worker.complete();}
        expect([...scheduler.domains.keys()]).toEqual([opticalStructureKey(b, 32, 24)]);
        expect(scheduler.request(b, 32, 24, atmosphere).kernels).not.toBeNull();
        expect(scheduler.request(a, 32, 24, atmosphere)).toMatchObject({kernels: null, pending: true});
    } finally {scheduler.dispose();}
});

test("a cached domain serves only turbulence strengths inside its validated intervals", async () => {
    const worker = domainWorker(), atmosphere = createAtmosphere();
    const scheduler = new OpticsScheduler({createWorker: () => worker});
    const a = compact({turbulenceR0M: .574}), b = compact({focalLengthM: 1.012, turbulenceR0M: .574});
    try {
        for (const lens of [a, b]) {scheduler.request(lens, 32, 24, atmosphere); await settle(scheduler); worker.complete();}
        expect(scheduler.request(a, 32, 24, atmosphere).kernels).not.toBeNull();
        await settle(scheduler); expect(worker.postMessage).toHaveBeenCalledTimes(2);
        // A much stronger path (r0 0.2 m) lies outside A's intervals: A is rebuilt there, under the same key.
        const strong = {...a, turbulenceR0M: .2};
        expect(scheduler.request(strong, 32, 24, atmosphere)).toMatchObject({kernels: null, pending: true});
        await settle(scheduler); expect(worker.postMessage).toHaveBeenCalledTimes(3);
        worker.complete();
        expect(scheduler.domains.size).toBe(2);
        expect(scheduler.request(strong, 32, 24, atmosphere).kernels).not.toBeNull();
    } finally {scheduler.dispose();}
});

test("without a worker, a return to an earlier lens reuses its domain instead of rebuilding on the main thread", () => {
    const scheduler = new OpticsScheduler({createWorker: () => null}), atmosphere = createAtmosphere();
    const a = compact({}), b = compact({focalLengthM: 1.012});
    try {
        scheduler.request(a, 32, 24, atmosphere); const domainA = scheduler.domain;
        scheduler.request(b, 32, 24, atmosphere); expect(scheduler.domain).not.toBe(domainA);
        const back = scheduler.request(a, 32, 24, atmosphere);
        expect(scheduler.domain).toBe(domainA); expect(back).toMatchObject({fallback: true, pending: false});
    } finally {scheduler.dispose();}
});

test("worker URLs are module-relative even with an unusable document base", () => {
    const originalWorker = global.Worker, originalDocument = global.document;
    const worker = {};
    global.document = {get baseURI() {throw new Error("no document base");}};
    global.Worker = jest.fn(() => worker);
    try {
        expect(createDefaultOpticsWorker()).toBe(worker);
        expect(createOpticsWorker()).toBe(worker);
        for (const [url, options] of global.Worker.mock.calls) {
            expect(url.pathname).toMatch(/\/tools\/thermal\/opticsWorker\.js$/);
            expect(options).toEqual({type: "module"});
        }
        global.Worker.mockImplementation(() => {throw new Error("constructor unavailable");});
        expect(createDefaultOpticsWorker()).toBeNull();
        expect(createOpticsWorker()).toBeNull();
        delete global.Worker;
        expect(createDefaultOpticsWorker()).toBeNull();
    } finally {
        if (originalWorker === undefined) delete global.Worker; else global.Worker = originalWorker;
        if (originalDocument === undefined) delete global.document; else global.document = originalDocument;
    }
});

test("evaluated worker factories without a module URL return the synchronous fallback", () => {
    for (const [path, name] of [["../tools/thermal/sensorMath.js", "createDefaultOpticsWorker"],
        ["../src/rendering/ThermalWorkerFactory.js", "createOpticsWorker"]]) {
        const source = readFileSync(new URL(path, import.meta.url), "utf8");
        const factory = source.match(new RegExp(`export function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))[0]
            .replace("export ", "").replaceAll("import.meta.url", "undefined");
        const Worker = jest.fn();
        expect(new Function("Worker", "URL", `${factory}; return ${name}();`)(Worker, URL)).toBeNull();
        expect(Worker).not.toHaveBeenCalled();
    }
});

test("unavailable worker keeps one domain while turbulence moves inside it (no per-frame rebuild)", () => {
    // A moving camera changes turbulenceR0M every frame; without a worker the scheduler must sample its domain,
    // not rebuild the whole optical basis each frame (that made the GPU self-test take tens of minutes).
    const scheduler = new OpticsScheduler({createWorker: () => null}), atmosphere = createAtmosphere();
    try {
        const first = compact({turbulenceR0M: 0.5});
        const a = scheduler.request(first, 32, 24, atmosphere), domain = scheduler.domain;
        const cell = domain.intervals.find(interval => interval.high > interval.low);
        const qInside = cell.low + 0.37 * (cell.high - cell.low);
        const b = scheduler.request(compact({turbulenceR0M: qInside ** (-3 / 5)}), 32, 24, atmosphere);
        expect(scheduler.domain).toBe(domain);
        expect(b.kernels).not.toBe(a.kernels);
        expect(b).toMatchObject({fallback: true, pending: false});
    } finally {scheduler.dispose();}
});

test.each([() => null, () => {throw new Error("invalid base URL");}])("unavailable worker builds exact kernels on the requesting thread", createWorker => {
    const scheduler = new OpticsScheduler({createWorker}), settings = compact({}), atmosphere = createAtmosphere();
    try {
        const result = scheduler.request(settings, 32, 24, atmosphere);
        expect(result).toMatchObject({fallback: true, pending: false});
        expect(opticalKernelError(result.kernels, opticalKernels(settings, 32, 24, atmosphere))).toBeLessThan(2e-6);
        expect(scheduler.request(settings, 32, 24, atmosphere).kernels).toBe(result.kernels);
    } finally {scheduler.dispose();}
});

test.each(["rejected factory", "load", "message", "post"])("worker %s failure falls back without a rejected task or missing kernel", async failure => {
    const worker = {postMessage: jest.fn(), terminate: jest.fn()};
    if (failure === "post") worker.postMessage.mockImplementation(() => {throw new Error("post failed");});
    const scheduler = new OpticsScheduler({createWorker: () => failure === "rejected factory" ? Promise.reject(Error("load failed")) : worker});
    const settings = compact({}), atmosphere = createAtmosphere();
    try {
        scheduler.request(settings, 32, 24, atmosphere);
        await scheduler.workerPromise;
        await Promise.resolve();
        if (failure === "load") worker.onerror({message: "load failed"});
        if (failure === "message") worker.onmessageerror();
        await Promise.resolve();
        expect(scheduler.request(settings, 32, 24, atmosphere)).toMatchObject({fallback: true, pending: false});
    } finally {scheduler.dispose();}
});

test("an early worker response does not evict the validated interval during prefetch", async () => {
    const worker = {postMessage: jest.fn(), terminate: jest.fn()};
    const scheduler = new OpticsScheduler({createWorker: () => worker}), atmosphere = createAtmosphere();
    const settings = compact({turbulenceR0M: .574}), spectrum = psfSpectrum(settings, atmosphere);
    const original = buildOpticalDomain(settings, 32, 24, spectrum);
    scheduler.domain = original;
    const next = {...settings, turbulenceR0M: .55};
    try {
        scheduler.request(next, 32, 24, atmosphere);
        await scheduler.workerPromise;
        await Promise.resolve();
        const request = worker.postMessage.mock.calls[0][0];
        buildOpticalDomain(next, 32, 24, spectrum, anchor => {
            worker.onmessage({data: {id: request.id, domain: anchor, complete: false, buildMs: 1}});
            const result = scheduler.request(settings, 32, 24, atmosphere);
            expect(scheduler.domain).toBe(original);
            expect(result.kernels).not.toBeNull();
            expect(result.kernels.interpolationErrorL1).toBeLessThan(OPTICS_L1_TOLERANCE);
            expect(result.pending).toBe(true);
        });
    } finally {scheduler.dispose();}
});

test("native worker publishes the requested full kernel before validating its reuse domain", async () => {
    // Estimated long-range motion fixture; physical units follow the settings schema.
    const settings = normalizeSettings({sensorPreset: "MX15", psfRangeM: 125000,
        sensorAltitudeM: 1380, pathElevationDeg: 2.27, turbulenceR0M: .574});
    const width = settings.detectorWidth * settings.supersample, height = settings.detectorHeight * settings.supersample;
    const spectrum = psfSpectrum(settings), worker = new NodeWorker(new URL("../tools/thermal/opticsWorkerNode.mjs", import.meta.url));
    const messages = [];
    try {
        await new Promise((resolve, reject) => {
            worker.on("error", reject);
            worker.on("message", message => {
                if (message.error) {reject(new Error(message.error)); return;}
                messages.push(message);
                if (message.complete) resolve();
            });
            worker.postMessage({id: 1, settings, width, height, spectrum});
        });
        expect(messages).toHaveLength(2);
        expect(messages[0].complete).toBe(false);
        expect(messages[0].buildMs).toBeLessThan(messages[1].buildMs);
        const anchor = sampleOpticalDomain(messages[0].domain, settings, spectrum);
        const domain = sampleOpticalDomain(messages[1].domain, settings, spectrum);
        expect(opticalKernelError(anchor, domain)).toBeLessThanOrEqual(domain.interpolationErrorL1 + 2e-6);
        console.log(`Measured native worker: first full kernel ${messages[0].buildMs.toFixed(1)} ms; validated domain ${messages[1].buildMs.toFixed(1)} ms; ${messages[1].domain.builds} basis samples`);
    } finally {await worker.terminate();}
}, 120000);

test("validated turbulence intervals match independent unsampled strengths and spectra", () => {
    const atmosphere = createAtmosphere(), settings = compact({turbulenceR0M: .572});
    const domain = buildOpticalDomain(settings, 32, 24, psfSpectrum(settings, atmosphere));
    for (const cell of domain.intervals) for (const fraction of [.137, .419, .863]) {
        const q = cell.low + fraction*(cell.high-cell.low);
        for (const psfRangeM of [2000, 125000]) {
            const current = {...settings, turbulenceR0M: q ** (-3/5), psfRangeM};
            const actual = sampleOpticalDomain(domain, current, psfSpectrum(current, atmosphere));
            const exact = opticalKernels(current, 32, 24, atmosphere);
            expect(opticalKernelError(actual, exact)).toBeLessThanOrEqual(actual.interpolationErrorL1 + 2e-6);
        }
    }
});


test("IB6830 interactive interpolation preserves both full native lens-step kernels", () => {
    // Estimated path fixtures: range/altitude/coherence diameter in m; elevation in degrees.
    // Compare the unchanged full finite calculation at independent interpolation points.
    const atmosphere = createAtmosphere(); let maximum = 0;
    for (const focalStep of ["675", "1012"]) {
        const initial = normalizeSettings({sensorPreset: "MX15", focalStep, psfRangeM: 125000,
            sensorAltitudeM: 1380, pathElevationDeg: 2.27, turbulenceR0M: .574});
        const width = initial.detectorWidth*initial.supersample, height = initial.detectorHeight*initial.supersample;
        const domain = buildOpticalDomain(initial, width, height, psfSpectrum(initial, atmosphere));
        for (const [psfRangeM, turbulenceR0M] of [[120000,.582], [145000,.55]]) {
            const settings = {...initial, psfRangeM, turbulenceR0M};
            const actual = sampleOpticalDomain(domain, settings, psfSpectrum(settings, atmosphere));
            const error = opticalKernelError(actual, opticalKernels(settings,width,height,atmosphere));
            maximum = Math.max(maximum,error);
            expect(error).toBeLessThanOrEqual(actual.interpolationErrorL1+2e-6);
            expect(error).toBeLessThan(OPTICS_L1_TOLERANCE/4);
        }
    }
    console.log(`IB6830 interactive finite-kernel maximum L1 difference: ${maximum}`);
}, 180000);
