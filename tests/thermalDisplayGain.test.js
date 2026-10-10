// Processing and display: temporal filtering, gain statistics and dynamics, plateau equalization, fixed
// radiometric endpoints, enlargement, the measured display curve and the polarity affine.
import {defaultSettings, normalizeSettings, settingsForPreset} from "../tools/thermal/thermalSchema.js";
import {IB6830_DISPLAY_CURVE, POLARITY_PROFILES, SENSOR_PRESETS} from "../tools/thermal/sensorPresets.js";
import * as M from "../tools/thermal/sensorMath.js";
import {automaticWindow, detectorPresentation, enlargeImage, gainStatistics, plateauLUT, processingParameters,
    runSensorChain, sum, temporalFilter} from "../tools/thermal/sensorMath.js";
import {measuredDisplayReference} from "../tools/thermal/selfTest.js";
import {saveThermalSettings, thermalSettings} from "../src/rendering/ThermalViewAdapter.js";

// Estimated numerical acceptance tolerances, not measurement uncertainties.
const close = (actual, expected, tolerance) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
const l1 = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);
// Diffraction on, a 32 × 32 detector, no scatter and no blur: optics and gain fixtures.
const diffractionSettings = extra => normalizeSettings({fieldMode: "focalLength", detectorWidth: 32, detectorHeight: 32,
    opticsRadiusPx: 8, scatterPreset: "custom", scatterFraction: 0,
    turbulenceR0M: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0, systemBlurRmsUrad: 0, ...extra});
// A quiet 32 × 24 detector at a manual 4× sampling, with a linear display: chain fixtures.
const sensorSettings = extra => normalizeSettings({detectorWidth: 32, detectorHeight: 24,
    fieldMode: "focalLength", opticalSamplingMode: "manual", supersample: 4,
    opticsRadiusPx: 8, scatterPreset: "custom", scatterFraction: 0,
    turbulenceR0M: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0, systemBlurHorizontalRmsUrad: 0, systemBlurVerticalRmsUrad: 0,
    displayCurve: "linear", shadingK: 0, fixedPatternFraction: 0, noiseEnabled: false, ...extra});
// Free 0.675 m optics with diffraction off and every blur at zero: residual blur and display fixtures.
const blurSettings = extra => normalizeSettings({focalStep: "free", fieldMode: "focalLength", focalLengthM: .675,
    detectorWidth: 32, detectorHeight: 32, opticalSamplingMode: "manual", supersample: 4,
    opticsEnabled: false, opticsRadiusPx: 8, turbulenceR0M: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0,
    systemBlurHorizontalRmsUrad: 0, systemBlurVerticalRmsUrad: 0,
    scatterPreset: "custom", scatterFraction: 0, noiseEnabled: false, shadingK: 0,
    fixedPatternFraction: 0, temporalFilterAlpha: 0, adcOffsetCounts: 0, ...extra});

test("temporal filter advances once per forward frame and resets on repeats, seeks and sensor changes", () => {
    const s = defaultSettings(), first = new Float32Array([100, 200]), next = new Float32Array([200, 100]);
    let state = temporalFilter(first, s, 10);
    expect(state.image).toEqual(first);
    state = temporalFilter(next, s, 11, state);
    expect(state.image).toEqual(new Float32Array([170, 130]));
    const skipped = temporalFilter(next, s, 13, state);
    close(skipped.memory, .3 ** 2, 1e-10);
    close(skipped.image[0], 197.3, 1e-5);
    for (const frame of [11, 3]) expect(temporalFilter(next, s, frame, state).image).toEqual(next);
    expect(temporalFilter(next, {...s, focalStep: "1012"}, 12, state).image).toEqual(next);
    expect(temporalFilter(next, {...s, temporalFilterAlpha: 0}, 12, state).image).toEqual(next);
    expect(temporalFilter(next, {...s, digitalZoom: 2}, 12, state).reset).toBe(false);
    expect(temporalFilter(next, {...s, psfRangeM: 130000, turbulenceR0M: .6}, 12, state).reset).toBe(false);
    expect(first).toEqual(new Float32Array([100, 200]));
});

test("stationary dynamic variance follows (1-alpha)/(1+alpha) and fixed pattern survives", () => {
    const settings = defaultSettings(); let state = null, seed = 12345, rawSq = 0, smoothSq = 0, n = 0;
    for (let frame = 0; frame < 600; frame++) {
        const counts = Float32Array.from({length: 256}, (_, i) => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return 1000 + i + (seed / 4294967296 - .5) * 200;
        });
        state = temporalFilter(counts, settings, frame, state);
        if (frame > 50) for (let i = 0; i < counts.length; i++) {
            rawSq += (counts[i] - 1000 - i) ** 2; smoothSq += (state.image[i] - 1000 - i) ** 2; n++;
        }
    }
    close(smoothSq / rawSq, .7 / 1.3, .005);
    const fixed = Float32Array.from({length: 256}, (_, i) => 1000 + i);
    state = null;
    for (let frame = 0; frame < 10; frame++) state = temporalFilter(fixed, settings, frame, state);
    expect(state.image).toEqual(fixed); expect(n).toBeGreaterThan(100000);
});

test("CPU sensor chain filters counts before gain and preserves raw readback", () => {
    const settings = normalizeSettings({focalStep: "free", fieldMode: "focalLength", adcOffsetCounts: 0, detectorWidth: 1, detectorHeight: 1,
        opticalSamplingMode: "manual", supersample: 2, opticsEnabled: false, scatterPreset: "custom", scatterFraction: 0,
        jitterRmsUrad: 0, diffusionSigmaPx: 0, noiseEnabled: false, shadingK: 0, fixedPatternFraction: 0});
    const first = runSensorChain(new Float32Array(4).fill(.01), 2, 2, settings, {frame: 1, backgroundRadiance: 0});
    const next = runSensorChain(new Float32Array(4).fill(.02), 2, 2, settings, {frame: 2, previousTemporal: first.temporal, backgroundRadiance: 0});
    close(next.filteredCounts[0], .7 * next.counts[0] + .3 * first.counts[0], .001);
    expect(next.drive[0]).toBeCloseTo(next.filteredCounts[0] / 16383, 7);
});

test("MX15 gain time constant applies to affine display gain and offset", () => {
    const settings = settingsForPreset("MX15");
    expect(settings).toMatchObject({agcTimeConstantS: .12, agcDynamics: "gainOffset", temporalFilterAlpha: .3});
    const previous = {low: 100, high: 200}, counts = new Float32Array([200, 600]);
    const window = automaticWindow(counts, {lowPercentile: 0, highPercentile: 1, minimumSpan: 1,
        timeConstantS: .12, deltaTimeS: .12, dynamics: "gainOffset"}, previous);
    const gain = Math.exp(-1) / 100 + (1 - Math.exp(-1)) / 400;
    const offset = -Math.exp(-1) - (1 - Math.exp(-1)) * .5;
    close(1 / (window.high - window.low), gain, 1e-10);
    close(-window.low * gain, offset, 1e-10);
    expect(automaticWindow(counts, {deltaTimeS: 0, dynamics: "gainOffset"}, previous)).toEqual(previous);
});

test.each(["automatic", "plateau"])("%s gathers statistics from the selected native region", gainMode => {
    const settings = diffractionSettings({detectorWidth: 8, detectorHeight: 8, gainMode, digitalZoom: 2,
        lowPercentile: 0, highPercentile: 1, minimumWindowCounts: 1});
    const counts = new Float32Array(64);
    counts[0] = 16000;
    const crop = Float32Array.from({length: 16}, (_, i) => 100 + i * 2);
    for (let y = 0; y < 4; y++) counts.set(crop.subarray(y * 4, y * 4 + 4), (y + 2) * 8 + 2);
    const detector = processingParameters(counts, settings);
    expect(detector.window).toEqual({low: 0, high: 16000});
    const displayedSettings = {...settings, gainRegion: "displayed"};
    expect(gainStatistics(counts, 8, 8, displayedSettings)).toEqual(crop);
    const displayed = processingParameters(counts, displayedSettings);
    expect(displayed.window).toEqual({low: 100, high: 130}); expect(displayed.statisticsCount).toBe(16);
    if (gainMode === "plateau") expect(displayed.lut).toEqual(plateauLUT(crop, settings.plateauFactor, 16384, true));
    counts[0] = 1000;
    expect(processingParameters(counts, displayedSettings)).toEqual(displayed);
    expect(processingParameters(counts, {...settings, digitalZoom: 8}).window).toEqual(processingParameters(counts, settings).window);
    expect(processingParameters(counts, {...displayedSettings, digitalZoom: 1})).toEqual(processingParameters(counts, settings));
});

test("step crop feeds displayed statistics; supplied host mapping already describes the physical field", () => {
    const settings = normalizeSettings({focalStep: "1012", gainRegion: "displayed"});
    expect(detectorPresentation(settings)).toEqual({scale: [.75, .75], offset: [0, 0]});
    const counts = Float32Array.from({length: 640 * 512}, (_, i) => i);
    const selected = gainStatistics(counts, 640, 512, settings);
    expect(selected.length).toBe(480 * 384);
    expect(selected[0]).toBe(counts[64 * 640 + 80]);
    const host = {scale: [.5, .25], offset: [.1, .2]};
    expect(detectorPresentation(settings, host)).toBe(host);
    const wideHost = {scale: [1, 1], offset: [0, 0]};
    expect(gainStatistics(counts, 640, 512, settings, wideHost)).toEqual(selected);
    const displayed = enlargeImage(new Float32Array(640 * 512).fill(1), 640, 512, 640, 512, settings, wideHost);
    expect(displayed[0]).toBe(0); expect(displayed[256 * 640 + 320]).toBe(1);
    expect(sum(displayed)).toBe(480 * 384);
    const outside = Float32Array.from(displayed, value => 1 - value);
    expect(sum(enlargeImage(outside, 640, 512, 960, 768, settings))).toBe(0);
    const next = normalizeSettings({...settings, focalStep: "675"});
    expect(next.detectorWindow).toEqual({width: 640, height: 512});
});

test("plateau uses detector-level bins before percentile clipping", () => {
    const counts = Float32Array.from({length: 1000}, (_, i) => i < 970 ? 3800 + i % 16 : 15000 + i % 20);
    const settings = sensorSettings({gainMode: "plateau", plateauFactor: 100, localAmount: 0});
    const plateau = M.processCounts(counts, 40, 25, settings);
    const auto = M.processCounts(counts, 40, 25, {...settings, gainMode: "automatic"});
    expect(new Set(plateau.codes.slice(0, 970)).size).toBe(16);
    expect(plateau.codes[15] - plateau.codes[0]).toBeGreaterThan(100);
    expect(auto.codes[15] - auto.codes[0]).toBeLessThan(2);
    expect(plateau.lut.values.length).toBe(16384);
});

test("default fixed radiometric endpoints use the available ADC signal range", () => {
    const settings = sensorSettings({gainMode: "fixedRadiometric", adcOffsetCounts: 256});
    const highCounts = M.detectorCounts(new Float32Array([settings.radiometricHigh]), settings)[0];
    close(highCounts, 16383, 1);
    const code = M.processCounts(new Float32Array([highCounts]), 1, 1, settings).codes[0];
    expect(code).toBe(255);
});

test("unequal-population browser reference separates each processing algorithm", () => {
    const {processingModesReference} = require("../tools/thermal/selfTest.js");
    const counts = processingModesReference(), settings = sensorSettings({adcOffsetCounts: 0, plateauFactor: 100});
    const result = mode => M.processCounts(counts, 32, 32, {...settings, gainMode: mode}).codes;
    expect(l1(result("plateau"), result("automatic")) / counts.length).toBeGreaterThan(50);
    expect(l1(result("manual"), result("automatic")) / counts.length).toBeGreaterThan(50);
});

test("sample-centered 2× impulse is 0.5/1/0.5; half-pixel and nearest retain their phases", () => {
    const input = new Float32Array(9); input[4] = 1;
    const settings = {detectorWidth: 9, detectorHeight: 1, digitalZoom: 1};
    const enlarge = sampling => Array.from(enlargeImage(input, 9, 1, 18, 1, {...settings, sampling}));
    expect(enlarge("sampleCentered").slice(6, 11)).toEqual([0, .5, 1, .5, 0]);
    expect(enlarge("linear").slice(6, 12)).toEqual([0, .25, .75, .75, .25, 0]);
    expect(enlarge("nearest").slice(6, 12)).toEqual([0, 0, 1, 1, 0, 0]);
    for (const sampling of ["sampleCentered", "linear", "nearest"]) {
        expect(enlargeImage(input, 9, 1, 9, 1, {...settings, sampling})).toEqual(input);
        expect(sum(enlarge(sampling))).toBe(2);
    }
    const impulse = new Float32Array(25); impulse[12] = 1;
    const centered2D = enlargeImage(impulse, 5, 5, 10, 10,
        {detectorWidth: 5, detectorHeight: 5, sampling: "sampleCentered", digitalZoom: 1});
    expect(centered2D[5 * 10 + 4]).toBe(1); // display (4,4) from top left; bottom-first row 5.
    expect(centered2D[4 * 10 + 4]).toBe(.5);
    expect(centered2D[5 * 10 + 3]).toBe(.5);
    const constant = enlargeImage(new Float32Array(16).fill(7), 4, 4, 8, 8,
        {detectorWidth: 4, detectorHeight: 4, sampling: "sampleCentered", digitalZoom: 2});
    expect(Array.from(constant).every(value => value === 7)).toBe(true);
});

test.each(["nearest", "linear", "sampleCentered"])("minification averages every native column and row with %s", sampling => {
    const settings = {detectorWidth: 16, detectorHeight: 12, digitalZoom: 1, sampling};
    for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
        const input = new Float32Array(192); input[y * 16 + x] = 1;
        close(M.sum(M.enlargeImage(input, 16, 12, 5, 4, settings)) * (16 / 5) * 3, 1, 1e-7);
    }
});

test("measured LUT is monotonic, clipped at endpoints, and has the measured local slopes", () => {
    const reference = measuredDisplayReference();
    const ramp = Float32Array.from({length: 4097}, (_, i) => i / 4096);
    const response = M.displayCurve(ramp, reference.settings);
    expect(IB6830_DISPLAY_CURVE).toHaveLength(257);
    expect(response[0]).toBe(0); expect(response[response.length - 1]).toBe(1);
    expect(response.every((value, i) => i === 0 || value >= response[i - 1])).toBe(true);
    // Measured table's second black-hot sample is 253.3349321342256 codes.
    close(response[16], (255 - 253.3349321342256) / 255, 1e-8);
    const values = M.displayCurve(reference.drive, reference.settings);
    const slopes = reference.probes.map((_, i) => (values[2 * i + 1] - values[2 * i]) * 255 / (2 * reference.epsilon));
    close(slopes[1], 131, 3);
    close(slopes[0] / slopes[1], 5.2, .12);
    close(slopes[2] / slopes[1], 3.2, .10);
    expect(SENSOR_PRESETS.MX15.parameters.displayCurve).toMatchObject({status: "measured", uncertainty: expect.stringContaining("±20%")});
});

test("linear display remains the generic identity and measured response is scene-independent", () => {
    for (const name of ["ATFLIR", "OMAHA"]) expect(settingsForPreset(name).displayCurve).toBe("linear");
    expect(defaultSettings().displayCurve).toBe("measured");
    const drive = new Float32Array([-1, 0, .2, .5, .9, 1, 2]);
    expect(M.displayCurve(drive, {displayCurve: "linear"})).toEqual(M.responseCurve(drive));
    expect(() => normalizeSettings({sensorPreset: "OMAHA", displayCurve: "measured"})).toThrow(/No measured/);
    const settings = blurSettings({gainMode: "manual", fixedLevel: 8191.5, fixedGain: 1, responseGamma: 1});
    const small = M.processCounts(new Float32Array([6000, 9000]), 2, 1, settings).codes;
    const expanded = M.processCounts(new Float32Array([0, 6000, 9000, 16383]), 4, 1, settings).codes;
    expect(expanded.slice(1, 3)).toEqual(small);
    expect(M.displayCodes(drive, settings)).not.toEqual(M.displayCodes(drive, {...settings, displayCurve: "linear"}));
});

test.each(["linear", "measured"])("%s tone curve precedes quantization and optional polarity affine", displayCurve => {
    const drive = Float32Array.from({length: 4097}, (_, i) => i / 4096);
    const settings = blurSettings({displayCurve});
    const white = M.displayCodes(drive, {...settings, polarity: "whiteHot"});
    const black = M.displayCodes(drive, {...settings, polarity: "blackHot"});
    const affine = POLARITY_PROFILES.IB6830.polarityAffine;
    const recorded = M.displayCodes(drive, {...settings, polarity: "whiteHot", polarityAffine: affine});
    for (let i = 0; i < drive.length; i++) {
        expect(white[i] + black[i]).toBe(255);
        expect(recorded[i]).toBe(Math.floor(Math.min(255, 1.05 * (255 - black[i]) + 55) + .5));
    }
    expect(M.displayCodes(drive, {...settings, polarity: "blackHot", polarityAffine: affine})).toEqual(black);
    expect(recorded[0]).toBe(55); expect(recorded[4096]).toBe(255);
    const lower = M.displayCodes(new Float32Array([0]), {...settings, polarity: "whiteHot", polarityAffine: {gain: 1, offset: -55}});
    expect(lower[0]).toBe(0);
});

test("affine profile is opt-in, fresh, validated, and survives serialization", () => {
    const settings = defaultSettings();
    expect(settings).toMatchObject({polarityAffineGain: 1, polarityAffineOffset: 0});
    const changed = normalizeSettings({...settings, polarityAffine: POLARITY_PROFILES.IB6830.polarityAffine});
    expect(normalizeSettings(JSON.parse(JSON.stringify(changed)))).toEqual(changed);
    changed.polarityAffineGain = 2;
    expect(POLARITY_PROFILES.IB6830.polarityAffine.gain).toBe(1.05);
    expect(defaultSettings().polarityAffineGain).toBe(1);
    for (const polarityAffine of [{gain: NaN, offset: 0}, {gain: 1, offset: Infinity}, {gain: -1, offset: 0},
        {gain: "1", offset: 0}, {}, [], null]) expect(() => normalizeSettings({polarityAffine})).toThrow();
});

test("affine object and menu edits survive host saving and preset reselection", () => {
    const configured = normalizeSettings({...defaultSettings(), polarityAffine: POLARITY_PROFILES.IB6830.polarityAffine});
    expect(configured).toMatchObject({polarityAffineGain: 1.05, polarityAffineOffset: 55});
    const cameraNode = {}, sit = {};
    saveThermalSettings(configured, cameraNode, sit);
    expect(thermalSettings(cameraNode, sit)).toMatchObject({polarityAffineGain: 1.05, polarityAffineOffset: 55});
    const edited = normalizeSettings({...configured, polarityAffineGain: 1.2, polarityAffineOffset: 42});
    expect(edited).toMatchObject({polarityAffineGain: 1.2, polarityAffineOffset: 42});
    const objectEdit = normalizeSettings({...edited, polarityAffine: {gain: .9, offset: 20}});
    expect(objectEdit).toMatchObject({polarityAffineGain: .9, polarityAffineOffset: 20});
    const reset = normalizeSettings({...objectEdit, ...settingsForPreset("MX15")});
    expect(reset).toMatchObject({polarityAffineGain: 1, polarityAffineOffset: 0});
    expect(configured.polarityAffine).toBeUndefined();
});
