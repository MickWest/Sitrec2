// Optics: diffraction, the polychromatic PSF and its photon spectrum, turbulence, the Gaussian residual blur,
// exposure jitter and charge diffusion, optical sampling convergence, and optics cache invalidation.
import {normalizeSettings, settingsForPreset} from "../tools/thermal/thermalSchema.js";
import {BANDS, createAtmosphere, evaluatePath} from "../tools/thermal/atmosphere.js";
import {inBandRadiance} from "../tools/thermal/radiometry.js";
import {turbulenceMTF} from "../tools/thermal/turbulence.js";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import * as M from "../tools/thermal/sensorMath.js";
import {applyOptics, diffractionKernel, filterKernelMTF, opticalKernels, psfSpectrum, sampleDetector, sum} from "../tools/thermal/sensorMath.js";
import {blurredPointSourceCase, imageAxisVariances, opticalConvergenceCase, relativeRadianceError,
    sampledConvergenceSources} from "../tools/thermal/selfTest.js";

// Estimated numerical test conditions, not camera measurements.
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
// Physical expectations below are calculated from sigma_px = sigma_rad * f / p.
const axisRms = (kernel, settings) => imageAxisVariances(kernel.data, kernel.width)
    .map(v => Math.sqrt(v) * settings.pixelPitchM / (settings.focalLengthM * settings.supersample) * 1e6);

test.each([3.143e-6, 4.857e-6])("vanishing defocus matches analytic Airy at %s m", wavelengthM => {
    const sensor = {focalM: .675, apertureM: .15, pitchM: 20e-6};
    const analytic = M.diffractionKernel(sensor, {radiusPx: 8}, wavelengthM, 4);
    const fft = M.diffractionKernel(sensor, {radiusPx: 8, defocusM: 1e-12, pupilGrid: 1024}, wavelengthM, 4);
    expect(l1(fft.data, analytic.data)).toBeLessThan(.004);
    close(M.sum(fft.data), 1, 1e-7);
});

test("defocus converges when focal-plane spacing is halved as well as pupil resolution doubled", () => {
    const sensor = {focalM: .675, apertureM: .15, pitchM: 20e-6}, lambda = 3.143e-6;
    const fill = sensor.pitchM / 4 / (lambda * sensor.focalM / sensor.apertureM);
    const matched = M.diffractionKernel(sensor, {radiusPx: 8, defocusM: 200e-6, pupilGrid: 1024}, lambda, 4);
    const fine = M.diffractionKernel(sensor, {radiusPx: 8, defocusM: 200e-6, pupilGrid: 2048, pupilFill: fill / 2}, lambda, 4);
    expect(l1(matched.data, fine.data)).toBeLessThan(1e-6);
});

test.each([300, 900])("polychromatic PSF matches independent photon weights at %s K", psfTemperatureK => {
    const settings = sensorSettings({psfTemperatureK, jitterRmsUrad: 0, diffusionSigmaPx: 0});
    const bins = Array.from({length: 7}, (_, i) => {
        const minUm = 3 + 2 * i / 7, maxUm = 3 + 2 * (i + 1) / 7;
        return {radiance: inBandRadiance(psfTemperatureK, {minUm, maxUm}),
            kernel: M.diffractionKernel({focalM: settings.focalLengthM, apertureM: settings.apertureM,
                pitchM: settings.pixelPitchM}, {radiusPx: settings.opticsRadiusPx}, (minUm + maxUm) * .5e-6, 4)};
    });
    const expected = quantity => {
        const total = M.sum(bins.map(b => quantity === "equal" ? 1 : b.radiance[quantity]));
        return Float32Array.from(bins[0].kernel.data, (_, i) => M.sum(bins.map(b =>
            b.kernel.data[i] * (quantity === "equal" ? 1 : b.radiance[quantity]))) / total);
    };
    const core = M.opticalKernels(settings).core.data, photon = expected("photon");
    expect(l1(core, photon)).toBeLessThan(2e-7);
    // Negative controls: both wrong choices conserve energy, but fail this profile reference.
    expect(l1(expected("energy"), photon)).toBeGreaterThan(.005);
    expect(l1(expected("equal"), photon)).toBeGreaterThan(.005);
});

test("received PSF weights intersect atmospheric bands and shorten the reference wavelength", () => {
    // Estimated geometry near IB6830, standard atmosphere; calculated spectral result.
    const settings = normalizeSettings({sensorAltitudeM: 1382, pathElevationDeg: 2.23, psfRangeM: 125000, psfTemperatureK: 500});
    const received = psfSpectrum(settings), source = psfSpectrum({...settings, psfRangeM: 0});
    close(source.meanWavelengthM * 1e6, 4.245523583745341, 1e-9);
    expect(received.meanWavelengthM * 1e6).toBeGreaterThan(3.95);
    expect(received.meanWavelengthM * 1e6).toBeLessThan(4.0);
    close(sum(received.bins.map(bin => bin.weight)), 1, 1e-10);
    const path = evaluatePath({sensorAltitudeM: 1382, elevationRad: 2.23 * Math.PI / 180, slantRangeM: 125000},
        createAtmosphere(), {segments: 96, quantity: "photon"});
    for (const bin of received.bins) {
        const photons = BANDS.reduce((n, band, i) => {
            const minUm = Math.max(bin.minUm, band.minM * 1e6), maxUm = Math.min(bin.maxUm, band.maxM * 1e6);
            return n + (maxUm > minUm ? inBandRadiance(500, {minUm, maxUm}).photon * path.transmission[i] : 0);
        }, 0);
        close(bin.photons / photons, 1, 1e-12);
    }
    const off = psfSpectrum({...settings, atmosphereEnabled: false});
    close(off.meanWavelengthM, source.meanWavelengthM, 1e-15);
    console.log(`PSF photon mean: source ${(source.meanWavelengthM * 1e6).toFixed(6)} um; received ${(received.meanWavelengthM * 1e6).toFixed(6)} um at 125000 m`);
});

test("PSF range and profile refresh weights while equal finite kernels retain spectra", () => {
    const settings = normalizeSettings({detectorWidth: 8, detectorHeight: 8, fieldMode: "focalLength",
        psfRangeM: 125000, sensorAltitudeM: 1382, pathElevationDeg: 2.23,
        opticsRadiusPx: 4, scatterPreset: "custom", scatterFraction: 0});
    const pipeline = new ThermalPipeline(null, {analysis: true});
    pipeline.atmosphere = createAtmosphere(); pipeline.profileKey = "standard";
    pipeline._prepareSpectrum = jest.fn();
    pipeline._prepareOptics(settings, 32, 32);
    const first = pipeline.psfSpectrum.meanWavelengthM;
    pipeline._prepareOptics(settings, 32, 32); expect(pipeline._prepareSpectrum).toHaveBeenCalledTimes(1);
    pipeline._prepareOptics({...settings, psfRangeM: 0}, 32, 32);
    expect(pipeline.psfSpectrum.meanWavelengthM).toBeGreaterThan(first);
    pipeline.profileKey = "changed";
    pipeline.atmosphere = createAtmosphere({densityScale: 0});
    pipeline._prepareOptics(settings, 32, 32); expect(pipeline._prepareSpectrum).toHaveBeenCalledTimes(2);
    expect(pipeline.opticsReport.errorL1).toBeLessThanOrEqual(pipeline.opticsReport.toleranceL1);
    close(pipeline.psfSpectrum.meanWavelengthM, psfSpectrum({...settings, psfRangeM: 0}).meanWavelengthM, 1e-15);
    close(sum(opticalKernels(settings).core.data), 1, 1e-7);
    pipeline.atmosphere = createAtmosphere({densityScale: .5});
    pipeline._prepareOptics(settings, 32, 32);
    expect(pipeline._prepareSpectrum).toHaveBeenCalledTimes(3);
    close(pipeline.psfSpectrum.meanWavelengthM, psfSpectrum(settings, pipeline.atmosphere).meanWavelengthM, 1e-15);
});

const transferAt = (kernel, cyclesPerSample) => {
    let value = 0;
    for (let y = 0; y < kernel.height; y++) for (let x = 0; x < kernel.width; x++)
        value += kernel.data[y * kernel.width + x] * Math.cos(2 * Math.PI * cyclesPerSample * (x - (kernel.width - 1) / 2));
    return value;
};

test("turbulence filters each wavelength PSF by the long-exposure Kolmogorov MTF", () => {
    const sensor = {focalM: 0.675, apertureM: 0.135, pitchM: 20e-6}, s = 4;
    const step = sensor.pitchM / sensor.focalM / s, frequency = 0.35 / (step * s);
    for (const wavelength of [3e-6, 4e-6, 5e-6]) {
        const clear = diffractionKernel(sensor, {radiusPx: 16}, wavelength, s);
        const expected = Math.exp(-3.44 * (wavelength * frequency / (0.572 * (wavelength / 4e-6) ** 1.2)) ** (5 / 3));
        close(turbulenceMTF(frequency, wavelength, 0.572), expected, 1e-14);
        const blurred = filterKernelMTF(clear, step, f => turbulenceMTF(f, wavelength, 0.572));
        close(transferAt(blurred, frequency * step) / transferAt(clear, frequency * step), expected, 0.005);
        close(sum(blurred.data), 1, 1e-7);
    }
    expect(turbulenceMTF(1e5, 4e-6, 0)).toBe(1);
    expect(turbulenceMTF(0, 4e-6, 0.572)).toBe(1);
    // Polychromatic result must differ from an achromatic 4 um filter.
    const settings = diffractionSettings({turbulenceR0M: 0.15});
    const weighted = opticalKernels(settings).core;
    const plain = opticalKernels({...settings, turbulenceR0M: 0}).core;
    const achromatic = filterKernelMTF(plain, step, f => turbulenceMTF(f, 4e-6, 0.15));
    expect(sum(weighted.data.map((v, i) => Math.abs(v - achromatic.data[i])))).toBeGreaterThan(0.0001);
});

test.each(["turbulenceR0M", "jitterRmsUrad", "diffusionSigmaPx"])("%s conserves flux, lowers the peak and is exactly bypassed at zero", key => {
    const settings = diffractionSettings(), baseline = opticalKernels(settings).core;
    const values = {turbulenceR0M: 0.572, jitterRmsUrad: 2.714, diffusionSigmaPx: 0.2};
    const kernels = opticalKernels({...settings, [key]: values[key]});
    const center = (kernels.core.data.length - 1) / 2;
    close(sum(kernels.core.data), 1, 1e-7);
    expect(kernels.core.data[center]).toBeLessThan(baseline.data[center]);
    expect(kernels.core.data.every(v => v >= 0)).toBe(true);
    const input = new Float32Array(129 * 129); input[64 * 129 + 64] = 1;
    const result = applyOptics(input, 129, 129, kernels);
    close(sum(result), 1, 2e-7);
    expect(opticalKernels({...settings, [key]: 0}).core.data).toEqual(baseline.data);
    // Diffraction's bypass does not disable independently requested blur terms.
    close(sum(opticalKernels({...settings, opticsEnabled: false, [key]: values[key]}).core.data), 1, 1e-7);
});

test("residual blur, jitter and diffusion add variances once per axis, with turbulence separate", () => {
    const settings = blurSettings({systemBlurHorizontalRmsUrad: 12, systemBlurVerticalRmsUrad: 40,
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
    // The kernels apply the Gaussian to each wavelength before the spectral mix; the composition here applies it
    // after. Both are the same linear operation, so they agree to Float32 rounding.
    expect(l1(M.opticalKernels(turbulent).core.data, composed.data)).toBeLessThan(1e-6);
    expect(M.opticalKernels(blurSettings()).core.data).toEqual(M.deltaKernel().data);
    // Absent axes are zero.
    expect(M.opticalKernels({...settings, systemBlurHorizontalRmsUrad: 0, systemBlurVerticalRmsUrad: 0}).core)
        .toEqual(M.opticalKernels({...settings, systemBlurHorizontalRmsUrad: undefined, systemBlurVerticalRmsUrad: undefined}).core);
    // With diffraction, jitter and diffusion multiply its transfer by exp(-2 pi² sigma² f²), and the detector
    // footprint conserves the flux.
    const optics = diffractionSettings(), angularPixel = optics.pixelPitchM / optics.focalLengthM;
    const clear = opticalKernels(optics).core;
    const blur = opticalKernels({...optics, jitterRmsUrad: 2.714, diffusionSigmaPx: 0.2}).core;
    const frequencyPx = 0.5, sigmaPx = Math.hypot(2.714e-6 / angularPixel, 0.2);
    close(transferAt(blur, frequencyPx / optics.supersample) / transferAt(clear, frequencyPx / optics.supersample),
        Math.exp(-2 * Math.PI ** 2 * sigmaPx ** 2 * frequencyPx ** 2), 0.005);
    const image = new Float32Array(128 * 128); image[64 * 128 + 64] = 1;
    const sampled = sampleDetector(applyOptics(image, 128, 128, opticalKernels({...optics, diffusionSigmaPx: 0.2})), 128, 128, 4);
    close(sum(sampled) * 16, 1, 2e-7);
});

test("system residual stays angular, conserves flux and has an exact zero bypass", () => {
    const rms = kernel => {
        const c = (kernel.width - 1) / 2;
        return Math.sqrt(kernel.data.reduce((s, v, i) => s + v * (i % kernel.width - c) ** 2, 0)) / 4;
    };
    const widths = [];
    for (const f of [.675, 1.012]) {
        const settings = sensorSettings({focalLengthM: f, opticsEnabled: false, systemBlurHorizontalRmsUrad: 30, systemBlurVerticalRmsUrad: 30});
        const kernels = M.opticalKernels(settings), k = kernels.core;
        close(M.sum(k.data), 1, 1e-7);
        const impulse = new Float32Array(128 * 96); impulse[48 * 128 + 64] = 1;
        close(M.sum(M.applyOptics(impulse, 128, 96, kernels)), 1, 3e-7);
        close(rms(k) * settings.pixelPitchM / f * 1e6, 30, .03);
        widths.push(rms(k));
        const zero = M.opticalKernels({...settings, systemBlurHorizontalRmsUrad: 0, systemBlurVerticalRmsUrad: 0}).core;
        expect(zero.data).toEqual(M.deltaKernel().data);
    }
    close(widths[1] / widths[0], 1.012 / .675, .002);
    for (const focalStep of ["675", "1012"]) expect(normalizeSettings({focalStep}).systemBlurVerticalRmsUrad).toBe(40);
    for (const focalStep of ["27", "135"]) expect(normalizeSettings({focalStep}).systemBlurVerticalRmsUrad).toBe(0);
    expect(settingsForPreset("ATFLIR").systemBlurVerticalRmsUrad).toBe(0);
});

test.each([[0, 40], [12, 40], [40, 0]])("two-axis residual %s/%s urad has independent RMS and conserves energy", (horizontal, vertical) => {
    for (const focalLengthM of [.675, 1.012]) {
        const settings = blurSettings({focalLengthM, systemBlurHorizontalRmsUrad: horizontal, systemBlurVerticalRmsUrad: vertical});
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
        const settings = blurSettings({focalLengthM, systemBlurVerticalRmsUrad: 40});
        const kernel = M.opticalKernels(settings).core;
        return Math.sqrt(imageAxisVariances(kernel.data, kernel.width)[1]) / settings.supersample;
    });
    close(widths[0], 40e-6 * .675 / 20e-6, .001);
    close(widths[1], 40e-6 * 1.012 / 20e-6, .001);
    close(widths[1] / widths[0], 1.012 / .675, .002);
});

test("legacy saved and preset scalar blur maps to both axes without overriding explicit axes", () => {
    for (const input of [{systemBlurRmsUrad: 30}, {systemBlurRmsUrad: 30,
        presetMetadata: {systemBlurRmsUrad: {value: 30, overridden: false}}}]) {
        const migrated = normalizeSettings(input);
        expect(migrated.systemBlurHorizontalRmsUrad).toBe(30);
        expect(migrated.systemBlurVerticalRmsUrad).toBe(30);
        expect(migrated.systemBlurRmsUrad).toBeUndefined();
        expect(normalizeSettings(JSON.parse(JSON.stringify(migrated)))).toEqual(migrated);
        const raw = {...blurSettings(), systemBlurHorizontalRmsUrad: undefined, systemBlurVerticalRmsUrad: undefined, systemBlurRmsUrad: 30};
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

test("each axis invalidates optical spectra and temporal history; display edits retain detector history", () => {
    const settings = blurSettings({systemBlurHorizontalRmsUrad: 12, systemBlurVerticalRmsUrad: 40});
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

test("CPU four-source optical Nyquist convergence against factor 8", () => {
    const testCase = opticalConvergenceCase();
    expect(testCase.settings.supersample).toBe(4);
    const nyquist = sampledConvergenceSources(testCase);
    const reference = sampledConvergenceSources(testCase, {...testCase.settings, opticalSamplingMode: "manual", supersample: 8});
    const error = relativeRadianceError(nyquist, reference);
    expect(error).toBeLessThan(testCase.tolerance);
    console.log(`Four-source Nyquist versus 8x: ${(error * 100).toFixed(4)}% integrated radiance error (limit 5%)`);
});

test("CPU side of the blurred-source browser check executes in Jest", () => {
    const testCase = blurredPointSourceCase();
    const blurred = sampledConvergenceSources(testCase);
    const plain = sampledConvergenceSources(testCase, {...testCase.settings, turbulenceR0M: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0});
    close(sum(blurred) / sum(plain), 1, 1e-6);
    expect(Math.max(...blurred)).toBeLessThan(Math.max(...plain));
});
