import {PerspectiveCamera} from "three";
import {OpticalKernelCache, opticalKernelError, OPTICS_L1_TOLERANCE} from "../tools/thermal/sensorMath.js";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";
import {opticalKernels, scatterPlan, applyOptics} from "../tools/thermal/sensorMath.js";
import {createAtmosphere, backgroundAtElevation, skyViewGeometry, sampleSkyElevationLUT,
    brightnessErrorBound, createThermalRayGeometry} from "../tools/thermal/atmosphere.js";
import {FencedReadback, ThermalGpuTimer} from "../tools/thermal/ThermalPipeline.js";
import {SkyBackgroundCache} from "../tools/thermal/atmosphere.js";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";

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
    const pipeline = new ThermalPipeline({});
    pipeline.resources = {targets: new Map()}; pipeline._prepareSpectrum = jest.fn();
    pipeline.atmosphere = createAtmosphere();
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
    expect(pipeline.opticsReport).toMatchObject({errorL1: 0, spectraRebuilt: true, pending: false});
});

test("failed spectrum replacement cannot leave an apparently valid cache", () => {
    const pipeline = new ThermalPipeline({});
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
    expect(reader.poll()).toBeNull(); expect(gl.getBufferSubData).not.toHaveBeenCalled();
    expect(gl.clientWaitSync.mock.calls.every(([, flags, timeout]) => flags === 0 && timeout === 0)).toBe(true);
    gl.clientWaitSync.mockReturnValue(gl.CONDITION_SATISFIED);
    expect(reader.poll()).toMatchObject({counts: new Float32Array([10, 20]), serial: 2, key: "second"});
    reader.dispose(); expect(gl.deleteBuffer).toHaveBeenCalledTimes(2); expect(gl.deleteSync).toHaveBeenCalledTimes(2);
});

test("interactive gain never reads synchronously or applies statistics older than one render", () => {
    const pipeline = new ThermalPipeline({});
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
    expect(pipeline._gainParameters({}, settings, {...options, frame: 4}).statisticsCount).toBe(0);
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
