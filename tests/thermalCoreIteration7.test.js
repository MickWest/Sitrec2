import {defaultSettings, normalizeSettings, settingsForPreset} from "../tools/thermal/thermalSchema.js";
import {IB6830_DISPLAY_CURVE, POLARITY_PROFILES, SENSOR_PRESETS} from "../tools/thermal/sensorPresets.js";
import * as M from "../tools/thermal/sensorMath.js";
import {imageAxisVariances, measuredDisplayReference} from "../tools/thermal/selfTest.js";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {saveThermalSettings, thermalSettings} from "../src/rendering/ThermalViewAdapter.js";

// Estimated numerical acceptance tolerances, not measurement uncertainties.
// Physical expectations below are calculated from sigma_px=sigma_rad*f/p.
const close = (actual, expected, tolerance) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
const base = extra => normalizeSettings({focalStep: "free", fieldMode: "focalLength", focalLengthM: .675,
    detectorWidth: 32, detectorHeight: 32, opticalSamplingMode: "manual", supersample: 4,
    opticsEnabled: false, opticsRadiusPx: 8, turbulenceR0M: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0,
    systemBlurHorizontalRmsUrad: 0, systemBlurVerticalRmsUrad: 0,
    scatterPreset: "custom", scatterFraction: 0, noiseEnabled: false, shadingK: 0,
    fixedPatternFraction: 0, temporalFilterAlpha: 0, adcOffsetCounts: 0, ...extra});
const axisRms = (kernel, settings) => imageAxisVariances(kernel.data, kernel.width)
    .map(v => Math.sqrt(v) * settings.pixelPitchM / (settings.focalLengthM * settings.supersample) * 1e6);

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
    const settings = base({gainMode: "manual", fixedLevel: 8191.5, fixedGain: 1, responseGamma: 1});
    const small = M.processCounts(new Float32Array([6000, 9000]), 2, 1, settings).codes;
    const expanded = M.processCounts(new Float32Array([0, 6000, 9000, 16383]), 4, 1, settings).codes;
    expect(expanded.slice(1, 3)).toEqual(small);
    expect(M.displayCodes(drive, settings)).not.toEqual(M.displayCodes(drive, {...settings, displayCurve: "linear"}));
});

test.each(["linear", "measured"])("%s tone curve precedes quantization and optional polarity affine", displayCurve => {
    const drive = Float32Array.from({length: 4097}, (_, i) => i / 4096);
    const settings = base({displayCurve});
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

test.each([[0, 40], [12, 40], [40, 0]])("two-axis residual %s/%s urad has independent RMS and conserves energy", (horizontal, vertical) => {
    for (const focalLengthM of [.675, 1.012]) {
        const settings = base({focalLengthM, systemBlurHorizontalRmsUrad: horizontal, systemBlurVerticalRmsUrad: vertical});
        const kernels = M.opticalKernels(settings), rms = axisRms(kernels.core, settings);
        close(M.sum(kernels.core.data), 1, 1e-7);
        close(rms[0], horizontal, .03); close(rms[1], vertical, .03);
        const input = new Float32Array(128 * 128); input[64 * 128 + 64] = 1;
        const result = M.applyOptics(input, 128, 128, kernels);
        close(M.sum(result), 1, 3e-7);
        expect(result.every(value => value >= 0)).toBe(true);
    }
});

test("blur scales in native pixels with focal length and remains fixed in angle", () => {
    const widths = [.675, 1.012].map(focalLengthM => {
        const settings = base({focalLengthM, systemBlurVerticalRmsUrad: 40});
        const kernel = M.opticalKernels(settings).core;
        return Math.sqrt(imageAxisVariances(kernel.data, kernel.width)[1]) / settings.supersample;
    });
    close(widths[0], 40e-6 * .675 / 20e-6, .001);
    close(widths[1], 40e-6 * 1.012 / 20e-6, .001);
    close(widths[1] / widths[0], 1.012 / .675, .002);
});

test("axis variances include jitter and diffusion once, with turbulence separate", () => {
    const settings = base({systemBlurHorizontalRmsUrad: 12, systemBlurVerticalRmsUrad: 40,
        jitterRmsUrad: 10, diffusionSigmaPx: .2});
    const measured = axisRms(M.opticalKernels(settings).core, settings);
    const diffusionUrad = .2 * settings.pixelPitchM / settings.focalLengthM * 1e6;
    [12, 40].forEach((residual, axis) => close(measured[axis], Math.hypot(residual, 10, diffusionUrad), .04));
    const turbulent = {...settings, turbulenceR0M: .572};
    const independent = M.opticalKernels({...turbulent, systemBlurHorizontalRmsUrad: 0,
        systemBlurVerticalRmsUrad: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0}).core;
    const sigma = [Math.hypot(12, 10, diffusionUrad), Math.hypot(40, 10, diffusionUrad)].map(v => v * 1e-6);
    const composed = M.filterKernelMTF(independent, settings.pixelPitchM / settings.focalLengthM / settings.supersample,
        (_, fx, fy) => Math.exp(-2 * Math.PI ** 2 * ((sigma[0] * fx) ** 2 + (sigma[1] * fy) ** 2)), M.opticalCoreRadius(turbulent));
    expect(M.opticalKernels(turbulent).core.data).toEqual(composed.data);
    expect(M.opticalKernels(base()).core.data).toEqual(M.deltaKernel().data);
});

test("legacy saved and preset scalar blur maps to both axes without overriding explicit axes", () => {
    for (const input of [{systemBlurRmsUrad: 30}, {systemBlurRmsUrad: 30,
        presetMetadata: {systemBlurRmsUrad: {value: 30, overridden: false}}}]) {
        const migrated = normalizeSettings(input);
        expect(migrated.systemBlurHorizontalRmsUrad).toBe(30);
        expect(migrated.systemBlurVerticalRmsUrad).toBe(30);
        expect(migrated.systemBlurRmsUrad).toBeUndefined();
        expect(normalizeSettings(JSON.parse(JSON.stringify(migrated)))).toEqual(migrated);
        const raw = {...base(), systemBlurHorizontalRmsUrad: undefined, systemBlurVerticalRmsUrad: undefined, systemBlurRmsUrad: 30};
        expect(M.opticalKernels(raw).core.data).toEqual(M.opticalKernels({...raw,
            systemBlurHorizontalRmsUrad: 30, systemBlurVerticalRmsUrad: 30, systemBlurRmsUrad: undefined}).core.data);
    }
    const explicit = normalizeSettings({systemBlurRmsUrad: 30, systemBlurHorizontalRmsUrad: 0});
    expect(explicit.systemBlurHorizontalRmsUrad).toBe(0); expect(explicit.systemBlurVerticalRmsUrad).toBe(30);
    // A legacy value coincidentally equal to today's default remains explicit.
    const equalDefault = normalizeSettings(JSON.parse(JSON.stringify(normalizeSettings({systemBlurRmsUrad: 40}))));
    expect(normalizeSettings({...equalDefault, focalStep: "135"})).toMatchObject({
        systemBlurHorizontalRmsUrad: 40, systemBlurVerticalRmsUrad: 40});
    for (const value of [NaN, Infinity, "30"]) expect(() => normalizeSettings({systemBlurRmsUrad: value})).toThrow();
});

test("measured paired defaults follow lens steps and preserve explicit edits", () => {
    for (const focalStep of ["675", "1012"]) {
        const settings = normalizeSettings({focalStep});
        expect(settings).toMatchObject({displayCurve: "measured", systemBlurHorizontalRmsUrad: 0, systemBlurVerticalRmsUrad: 40});
        expect(settings.presetMetadata.systemBlurVerticalRmsUrad.status).toBe("measured");
    }
    for (const focalStep of ["27", "135", "free"]) {
        expect(normalizeSettings({...defaultSettings(), focalStep}).systemBlurVerticalRmsUrad).toBe(0);
        expect(normalizeSettings({...defaultSettings(), systemBlurVerticalRmsUrad: 22, focalStep}).systemBlurVerticalRmsUrad).toBe(22);
    }
    const short = normalizeSettings({...defaultSettings(), focalStep: "135"});
    expect(normalizeSettings({...short, focalStep: "1012"}).systemBlurVerticalRmsUrad).toBe(40);
});

test("each axis invalidates optical spectra and temporal history; display edits retain detector history", () => {
    const settings = base({systemBlurHorizontalRmsUrad: 12, systemBlurVerticalRmsUrad: 40});
    const pipeline = new ThermalPipeline({}, {analysis: true}); pipeline._prepareSpectrum = jest.fn();
    pipeline._prepareOptics(settings, 128, 128);
    expect(pipeline._prepareSpectrum).toHaveBeenCalledTimes(1);
    pipeline._prepareOptics(settings, 128, 128);
    expect(pipeline._prepareSpectrum).toHaveBeenCalledTimes(1);
    for (const key of ["systemBlurHorizontalRmsUrad", "systemBlurVerticalRmsUrad"]) {
        const changed = {...settings, [key]: settings[key] + 1};
        const before = pipeline._prepareSpectrum.mock.calls.length;
        pipeline._prepareOptics(changed, 128, 128);
        expect(pipeline._prepareSpectrum.mock.calls.length).toBe(before + 1);
        expect(M.temporalHistoryKey(changed)).not.toBe(M.temporalHistoryKey(settings));
    }
    expect(M.temporalHistoryKey({...settings, displayCurve: "linear", polarityAffine: {gain: 1.05, offset: 55}}))
        .toBe(M.temporalHistoryKey(settings));
});
