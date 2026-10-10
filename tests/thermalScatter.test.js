// Scatter: the near/far split, its energy, its allocation bounds, and the background it must not disturb.
import {normalizeSettings, settingsForPreset} from "../tools/thermal/thermalSchema.js";
import * as M from "../tools/thermal/sensorMath.js";
import {applyFarScatter, applyOptics, opticalKernels} from "../tools/thermal/sensorMath.js";

// Estimated numerical test conditions, not camera measurements.
const close = (actual, expected, tolerance) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
const l1 = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);
// No noise, shading, fixed pattern, dark current, pedestal or blur.
const quiet = extra => normalizeSettings({noiseEnabled: false, shadingK: 0, fixedPatternFraction: 0,
    darkElectronsPerS: 0, adcOffsetCounts: 0, systemBlurRmsUrad: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0, turbulenceR0M: 0, ...extra});
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

// Direct sparse convolution with the full unsplit radial kernel. No FFT, split,
// coarse sampling or interpolation participates in this reference calculation.
function directPointConvolution(settings, width, height, points) {
    const step = settings.pixelPitchM / (settings.focalLengthM * settings.supersample);
    const radius = Math.ceil(settings.scatterCutoffRad / step);
    const weight = (x, y) => {
        const angle = Math.hypot(x, y) * step;
        return angle <= settings.scatterCutoffRad ? (1 + (angle / settings.scatterShoulderRad) ** 2) ** (-settings.scatterSlope / 2) : 0;
    };
    let total = 0;
    for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) total += weight(x, y);
    return Float32Array.from({length: width * height}, (_, pixel) => points.reduce((value, point) => {
        const x = pixel % width - point.x, y = Math.floor(pixel / width) - point.y;
        return value + point.flux * (settings.scatterFraction * weight(x, y) / total + (x === 0 && y === 0 ? 1 - settings.scatterFraction : 0));
    }, 0));
}

test.each(["clean", "dirty"])("%s near/far profile agrees with direct point convolution", name => {
    const width = 257, height = 249;
    // Clean uses native MX-15 angular sampling. Dirty uses 100 um / 0.625 m
    // at 2x: its 2 mrad shoulder is still sampled by 25 fine pixels.
    const settings = quiet({scatterPreset: name, detectorWidth: 129, detectorHeight: 125,
        opticalSamplingMode: "manual", supersample: 2,
        opticsEnabled: false, fieldMode: "focalLength", ...(name === "dirty" ? {pixelPitchM: 100e-6, focalLengthM: 0.625} : {})});
    const kernels = M.opticalKernels(settings, width, height);
    expect(kernels.farMass).toBeGreaterThan(0);
    close(M.sum(kernels.scatter.data) + M.sum(kernels.farScatter.data), 1, 6e-8);
    const points = [{x: 128, y: 123, flux: 1}, {x: 3, y: 19, flux: 0.7}, {x: 218, y: 192, flux: 0.3}];
    const input = new Float32Array(width * height);
    for (const point of points) input[point.y * width + point.x] = point.flux;
    const actual = M.applyOptics(input, width, height, kernels);
    const direct = directPointConvolution(settings, width, height, points);
    const flux = points.reduce((value, point) => value + point.flux, 0);
    const l1 = actual.reduce((value, sample, pixel) => value + Math.abs(sample - direct[pixel]), 0) / flux;
    // Absolute integrated profile error <= 1% of redistributed flux, not 1% of
    // the bright unscattered peak. Includes off-center sources and partial cells.
    expect(l1 / settings.scatterFraction).toBeLessThan(0.01);
    close(M.sum(actual) / flux, M.sum(direct) / flux, settings.scatterFraction * 0.01);
    const uniform = new Float32Array(input.length).fill(0.4);
    expect(M.applyOptics(uniform, width, height, kernels, uniform[0])).toEqual(uniform);
}, 30000);

test("full contained scatter conserves energy after coarse reduction and reconstruction", () => {
    const settings = quiet({scatterPreset: "custom", scatterFraction: 0.4, scatterShoulderRad: 0.001,
        opticalSamplingMode: "manual", supersample: 2,
        scatterCutoffRad: 0.006, pixelPitchM: 100e-6, focalLengthM: 0.1, fieldMode: "focalLength",
        opticsEnabled: true, opticsRadiusPx: 2, detectorWidth: 128, detectorHeight: 128});
    const width = 256, input = new Float32Array(width * width); input[126 * width + 129] = 1;
    const kernels = M.opticalKernels(settings, width, width);
    // Exercise the same production split at a small, fully contained support.
    const plan = {...kernels.split, nearRadius: 8, nearCutoffRad: 8 * kernels.split.angularStep, factor: 2};
    const split = {...kernels, ...M.splitScatter(settings, plan), split: plan, farCore: M.coarsenKernel(kernels.core, 2)};
    expect(split.farMass).toBeGreaterThan(0);
    close(M.sum(M.applyFarScatter(input, width, width, split)), split.farMass, 1e-7);
    close(M.sum(M.applyOptics(input, width, width, split)), 1, 2e-7);
});

test("wide scatter allocation remains bounded for clean and dirty native presets", () => {
    for (const name of ["clean", "dirty"]) for (const supersample of [2, 4]) {
        const settings = normalizeSettings({scatterPreset: name, opticalSamplingMode: "manual", supersample});
        const plan = M.scatterPlan(settings);
        expect(plan.fftWidth).toBeLessThanOrEqual(4096); expect(plan.fftHeight).toBeLessThanOrEqual(4096);
        expect(plan.nearCutoffRad).toBeLessThan(settings.scatterCutoffRad);
        expect(Math.ceil((settings.detectorWidth * supersample + 2 * (plan.fullRadius + settings.opticsRadiusPx * supersample)) / plan.factor) + 8).toBeLessThanOrEqual(1024);
    }
    expect(() => M.scatterPlan(normalizeSettings({opticalSamplingMode: "manual", supersample: 8}))).toThrow(/4096/);
});

test("the changing sky radiance reaches the near and far scatter branches", () => {
    const settings = diffractionSettings({opticsEnabled: false, scatterFraction: 0.1, scatterCutoffRad: 0.02});
    const kernels = opticalKernels(settings, 32, 24);
    const image = Float32Array.from({length: 32 * 24}, (_, i) => 1 + Math.floor(i / 32) / 24);
    const contrast = image.map(v => v - 1.5);
    const far = applyFarScatter(contrast, 32, 24, kernels);
    expect(kernels.farMass).toBeGreaterThan(0);
    expect(far.some(v => v !== 0)).toBe(true);
    const result = applyOptics(image, 32, 24, kernels, 1.5);
    expect(result).not.toEqual(image);
    const flat = applyOptics(new Float32Array(image.length).fill(1.5), 32, 24, kernels, 1.5);
    expect(flat.every(v => v === 1.5)).toBe(true);
});

test("gradient background survives optics at every edge with near and far scatter", () => {
    const settings = sensorSettings({scatterPreset: "clean", opticsEnabled: true});
    const w = 128, h = 96, sky = Float32Array.from({length: w * h}, (_, i) => .2 + i % w * .0001 + Math.floor(i / w) * .0002);
    const kernels = M.opticalKernels(settings, w, h);
    expect(kernels.farMass).toBeGreaterThan(0);
    const result = M.applyOptics(sky, w, h, kernels, sky);
    close(l1(result, sky), 0, 0);
    const source = sky.slice(); source[48 * w + 64] += 1;
    const zero = new Float32Array(sky.length); zero[48 * w + 64] = 1;
    close(l1(M.applyOptics(source, w, h, kernels, sky), M.applyOptics(zero, w, h, kernels).map((v, i) => v + sky[i])), 0, .001);
});

test.each(["MX15", "ATFLIR", "OMAHA"].flatMap(sensor => ["clean", "dirty"].map(scatter => [sensor, scatter])))(
    "%s %s production scatter plan bounds worst coarse-cell placement error", (name, scatterPreset) => {
        const settings = normalizeSettings({...settingsForPreset(name), scatterPreset});
        const plan = M.scatterPlan(settings), split = M.splitScatter(settings, plan);
        const w = settings.detectorWidth * settings.supersample, h = settings.detectorHeight * settings.supersample;
        const px = Math.floor(w / 2 / plan.factor) * plan.factor, py = Math.floor(h / 2 / plan.factor) * plan.factor;
        const input = new Float32Array(w * h); input[py * w + px] = 1;
        const kernels = {...split, split: plan, core: M.deltaKernel(), farCore: M.coarsenKernel(M.deltaKernel(), plan.factor)};
        const far = M.applyFarScatter(input, w, h, kernels);
        const shoulder = settings.scatterShoulderRad / plan.angularStep, exponent = 1 - settings.scatterSlope / 2;
        // Independent analytic radial integral, 2*pi*integral r*(1+(r/a)^2)^(-p/2) dr.
        // The shoulder is resolved by >=5 fine cells in these presets; discrete-area
        // error is below the 1% profile tolerance and cannot hide source placement.
        const normalization = Math.PI * shoulder ** 2 * Math.expm1(exponent * Math.log1p((settings.scatterCutoffRad / settings.scatterShoulderRad) ** 2)) / exponent;
        let error = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const dx = x - px, dy = y - py, r = Math.hypot(dx, dy);
            const direct = r * plan.angularStep > settings.scatterCutoffRad ? 0 :
                settings.scatterFraction * (1 + (r / shoulder) ** 2) ** (-settings.scatterSlope / 2) / normalization;
            const near = Math.abs(dx) <= plan.nearRadius && Math.abs(dy) <= plan.nearRadius ?
                split.scatter.data[(dy + plan.nearRadius) * split.scatter.width + dx + plan.nearRadius] : 0;
            error += Math.abs(near + far[y * w + x] - direct - (dx === 0 && dy === 0 ? 1 - settings.scatterFraction : 0));
        }
        console.log(`${name} ${scatterPreset}: factor ${plan.factor}, near ${plan.nearRadius}, profile error ${(100 * error / settings.scatterFraction).toFixed(3)}% of scatter flux`);
        expect(error / settings.scatterFraction).toBeLessThan(.01);
    }, 60000);
