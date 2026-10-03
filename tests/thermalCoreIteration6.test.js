import {BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, RGFormat, RedFormat} from "three";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {normalizeSettings, settingsForPreset} from "../tools/thermal/thermalSchema.js";
import * as A from "../tools/thermal/atmosphere.js";
import * as M from "../tools/thermal/sensorMath.js";
import {inBandRadiance, PHOTON_SCALE} from "../tools/thermal/radiometry.js";
import {integrateTurbulence} from "../tools/thermal/turbulence.js";
import {atmosphereFromSounding, parseSoundingCSV} from "../tools/thermal/sounding.js";
import {radianceVertex, radianceFragment} from "../tools/thermal/shaders.js";

// Estimated numerical test conditions, not camera measurements. Relative limits
// isolate the named mechanism; charge rounding permits one ADC count where stated.
const close = (a, b, e = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(e);
const l1 = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);
const base = extra => normalizeSettings({detectorWidth: 32, detectorHeight: 24,
    fieldMode: "focalLength", opticalSamplingMode: "manual", supersample: 4,
    opticsRadiusPx: 8, scatterPreset: "custom", scatterFraction: 0,
    turbulenceR0M: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0, systemBlurHorizontalRmsUrad: 0, systemBlurVerticalRmsUrad: 0,
    displayCurve: "linear", shadingK: 0, fixedPatternFraction: 0, noiseEnabled: false, ...extra});
const cpuPipeline = () => {
    const pipeline = new ThermalPipeline({capabilities: {maxTextureSize: 8192}}, {analysis: true});
    pipeline.resources = {surfaces: new Map(), textures: new Set(), targets: new Map()};
    return pipeline;
};

test("non-vacuum range samples preserve photon scale and distinct band pairing", () => {
    const atmosphere = A.createAtmosphere(), band = {minUm: 3.2, maxUm: 4.9};
    const geometry = {sensorAltitudeM: 1382, elevationRad: 2.23 * Math.PI / 180};
    const table = A.createRangeLUT({...geometry, maxRangeM: 160000, size: 128, band, atmosphere});
    const source = A.blackbodyBands(730, {quantity: "photon", band}).map((v, i) => v * (i + 1));
    const values = A.sourceRangeLUT(table, source);
    for (const node of [3, 21, 73, 100, 127]) for (const offset of [0, ...(node < 127 ? [.5] : [])]) {
        const position = node + offset, range = table.maxRangeM * (position / (table.size - 1)) ** 2;
        const path = A.evaluatePhotonPath({...geometry, slantRangeM: range}, atmosphere, {band, segments: 96});
        const expected = M.sum(source.map((v, i) => v * path.transmission[i] + path.pathRadiance[i])) / PHOTON_SCALE;
        const actual = offset ? (values[node] + values[node + 1]) / 2 : values[node];
        close(actual / expected, 1, offset ? 1e-3 : 2e-7);
        if (!offset) path.pathRadiance.forEach((v, i) => close(table.pathRadiance[node * 12 + i], v / PHOTON_SCALE, 2e-9));
    }
});

test.each([[20, -.3, 15000], [1382, -1.3, 125000], [0, -.05, 5000]])(
    "sea-limited range rejects farther geometry at altitude %s m", (altitude, elevation, distance) => {
        const pipeline = cpuPipeline(), settings = base({sensorAltitudeM: altitude, pathElevationDeg: elevation});
        pipeline._prepareAtmosphere(settings);
        expect(pipeline.rangeLUT.maxRangeM).toBeLessThan(distance);
        const camera = new PerspectiveCamera(1, 1, 1, 1e6);
        camera.updateMatrixWorld();
        const mesh = new Mesh(new BoxGeometry(10, 10, 10), new MeshBasicMaterial());
        mesh.position.z = -distance; mesh.updateMatrixWorld();
        expect(() => [...pipeline._coverageTiles([mesh], camera, settings)]).toThrow(/range|Range/);
        mesh.geometry.dispose(); mesh.material.dispose();
    });

test("accepted sea-level endpoints never pass negative roundoff heights to turbulence", () => {
    let negative = 0;
    for (const sensorAltitudeM of [10, 100, 1382]) for (let i = 1; i < 20; i++) {
        const slantRangeM = Math.sqrt(2 * A.EARTH_RADIUS_M * sensorAltitudeM) * i / 21;
        const geometry = {sensorAltitudeM, targetAltitudeM: 0, slantRangeM};
        if (A.solvePath(geometry).altitudeAt(slantRangeM) < 0) negative++;
        expect(Number.isFinite(integrateTurbulence(geometry, {segments: 100}).r0M)).toBe(true);
        integrateTurbulence(geometry, {segments: 10, cn2: h => { expect(h).toBeGreaterThanOrEqual(0); return 1e-15; }});
    }
    expect(negative).toBeGreaterThan(0);
    expect(() => integrateTurbulence({sensorAltitudeM: 10, elevationRad: -.1, slantRangeM: 10000})).toThrow(/surface/);
});

test("gradient background survives optics at every edge with near and far scatter", () => {
    const settings = base({scatterPreset: "clean", opticsEnabled: true});
    const w = 128, h = 96, sky = Float32Array.from({length: w * h}, (_, i) => .2 + i % w * .0001 + Math.floor(i / w) * .0002);
    const kernels = M.opticalKernels(settings, w, h);
    expect(kernels.farMass).toBeGreaterThan(0);
    const result = M.applyOptics(sky, w, h, kernels, sky);
    close(l1(result, sky), 0, 0);
    const source = sky.slice(); source[48 * w + 64] += 1;
    const zero = new Float32Array(sky.length); zero[48 * w + 64] = 1;
    close(l1(M.applyOptics(source, w, h, kernels, sky), M.applyOptics(zero, w, h, kernels).map((v, i) => v + sky[i])), 0, .001);
});

test.each([3.143e-6, 4.857e-6])("vanishing defocus matches analytic Airy at %s m", wavelengthM => {
    const sensor = {focalM: .675, apertureM: .15, pitchM: 20e-6};
    const analytic = M.diffractionKernel(sensor, {radiusPx: 8}, wavelengthM, 4);
    const fft = M.diffractionKernel(sensor, {radiusPx: 8, defocusM: 1e-12, pupilGrid: 1024}, wavelengthM, 4);
    expect(l1(fft.data, analytic.data)).toBeLessThan(.004);
    close(M.sum(fft.data), 1, 1e-7);
});

test("plateau uses detector-level bins before percentile clipping", () => {
    const counts = Float32Array.from({length: 1000}, (_, i) => i < 970 ? 3800 + i % 16 : 15000 + i % 20);
    const settings = base({gainMode: "plateau", plateauFactor: 100, localAmount: 0});
    const plateau = M.processCounts(counts, 40, 25, settings);
    const auto = M.processCounts(counts, 40, 25, {...settings, gainMode: "automatic"});
    expect(new Set(plateau.codes.slice(0, 970)).size).toBe(16);
    expect(plateau.codes[15] - plateau.codes[0]).toBeGreaterThan(100);
    expect(auto.codes[15] - auto.codes[0]).toBeLessThan(2);
    expect(plateau.lut.values.length).toBe(16384);
});

test.each(["isLine2", "isLineSegments2", "isWireframe"])("generic radiance excludes %s meshes and restores them", flag => {
    const pipeline = cpuPipeline(), settings = base(), scene = new Scene(), camera = new PerspectiveCamera();
    const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial()); mesh[flag] = true; scene.add(mesh);
    const paint = mesh.material;
    pipeline._drawRadiance = () => expect(mesh.visible).toBe(false);
    pipeline._surface = () => { throw new Error("line became a surface"); };
    pipeline._coverageTiles = meshes => { expect(meshes).toHaveLength(0); return []; };
    pipeline._radiance(scene, camera, settings, {width: 1, height: 1, viewport: {set() {}}}, 0);
    expect(mesh.visible).toBe(true); expect(mesh.material).toBe(paint);
    mesh.geometry.dispose(); paint.dispose();
});

test("radiance shaders retain all logarithmic depth chunks", () => {
    for (const chunk of ["logdepthbuf_pars_vertex", "logdepthbuf_vertex"]) expect(radianceVertex).toContain(`#include <${chunk}>`);
    for (const chunk of ["logdepthbuf_pars_fragment", "logdepthbuf_fragment"]) expect(radianceFragment).toContain(`#include <${chunk}>`);
});

test("cold allowed temperatures converge without a subnormal quadrature failure", () => {
    for (let t = 0; t <= 10; t += .1) for (const band of [{minUm: 3, maxUm: 5}, {minUm: 3.7, maxUm: 5}]) {
        const result = inBandRadiance(t, band);
        expect(Number.isFinite(result.photon)).toBe(true);
        expect(result.photon).toBeGreaterThanOrEqual(0);
        expect(result.photon).toBeLessThan(1e-90);
    }
});

test("ADC pedestal preserves symmetric zero-signal noise and is removed for manual display", () => {
    const settings = base({detectorWidth: 200, detectorHeight: 100, noiseEnabled: true,
        shotNoiseEnabled: false, shadingK: 0, darkElectronsPerS: 0, adcOffsetCounts: 256});
    const counts = M.detectorCounts(new Float32Array(20000), settings, 8);
    const mean = M.sum(counts) / counts.length;
    close(mean, 256, .05);
    expect(counts.some(v => v < 256)).toBe(true); expect(counts.some(v => v > 256)).toBe(true);
    const result = M.processCounts(new Float32Array([156, 256, 356]), 3, 1,
        {...settings, gainMode: "manual", fixedLevel: 0, fixedGain: 16383 / 200});
    expect(result.codes).toEqual(new Float32Array([0, 128, 255]));
});

test.each(["nearest", "linear", "sampleCentered"])("minification averages every native column and row with %s", sampling => {
    const settings = {detectorWidth: 16, detectorHeight: 12, digitalZoom: 1, sampling};
    for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
        const input = new Float32Array(192); input[y * 16 + x] = 1;
        close(M.sum(M.enlargeImage(input, 16, 12, 5, 4, settings)) * (16 / 5) * 3, 1, 1e-7);
    }
});

test("default fixed radiometric endpoints use the available ADC signal range", () => {
    const settings = base({gainMode: "fixedRadiometric", adcOffsetCounts: 256});
    const highCounts = M.detectorCounts(new Float32Array([settings.radiometricHigh]), settings)[0];
    close(highCounts, 16383, 1);
    const code = M.processCounts(new Float32Array([highCounts]), 1, 1, settings).codes[0];
    expect(code).toBe(255);
});

test("scalar and complex targets use one and two float channels", () => {
    const pipeline = cpuPipeline();
    expect(pipeline._target("radiance", 64, 48, true).texture.format).toBe(RedFormat);
    expect(pipeline._target("fineFftA", 128, 128).texture.format).toBe(RGFormat);
    expect(pipeline._target("opticalSpectrum", 128, 128).texture.format).toBe(RGFormat);
    for (const target of pipeline.resources.targets.values()) target.dispose();
});

test("system residual stays angular, conserves flux and has an exact zero bypass", () => {
    const rms = kernel => {
        const c = (kernel.width - 1) / 2;
        return Math.sqrt(kernel.data.reduce((s, v, i) => s + v * (i % kernel.width - c) ** 2, 0)) / 4;
    };
    const widths = [];
    for (const f of [.675, 1.012]) {
        const settings = base({focalLengthM: f, opticsEnabled: false, systemBlurHorizontalRmsUrad: 30, systemBlurVerticalRmsUrad: 30});
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

test("pupil throughput rejects numerical aperture above one", () => {
    expect(() => base({apertureM: 2, focalLengthM: .675})).toThrow(/aperture|pupil/i);
});

test("sounding layer breakpoints reach the ray quadrature", () => {
    const sounding = parseSoundingCSV(`level_type,pressure_Pa,geopotential_height_m,temperature_C,relative_humidity_pct,dewpoint_depression_C,wind_dir_deg,wind_speed_m_s\n10,100000,0,15,50,,,\n10,90000,1234,7,40,,,\n10,70000,3456,-5,20,,,`);
    const {atmosphere} = atmosphereFromSounding(sounding);
    expect(atmosphere.layerAltitudesM).toEqual(expect.arrayContaining([1234, 3456]));
});

test("CPU sensor chain requires an explicit background for optical boundaries", () => {
    expect(() => M.runSensorChain(new Float32Array(16), 4, 4, base())).toThrow(/background/i);
});

test.each([300, 900])("polychromatic PSF matches independent photon weights at %s K", psfTemperatureK => {
    const settings = base({psfTemperatureK, jitterRmsUrad: 0, diffusionSigmaPx: 0});
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

test("MX15 render-target byte budget uses actual allocated formats and sizes", () => {
    const settings = settingsForPreset("MX15"), pipeline = cpuPipeline();
    pipeline._prepareSpectrum = (name, kernels, width, height) => {
        pipeline._target(name, width, height);
        const pool = name === "farSpectrum" ? "far" : "fine";
        pipeline._target(`${pool}FftA`, width, height); pipeline._target(`${pool}FftB`, width, height);
    };
    const w = settings.detectorWidth * settings.supersample, h = settings.detectorHeight * settings.supersample;
    pipeline._prepareOptics(settings, w, h);
    for (const name of ["radiance", "optics", "nearOptics", "farScatter", "skyBackground"]) pipeline._target(name, w, h, name === "radiance");
    for (const name of ["sampled", "counts", "drive", "display", "temporalA", "temporalB"]) pipeline._target(name, settings.detectorWidth, settings.detectorHeight);
    let rw = w, rh = h;
    for (let factor = 1; factor < pipeline.scatterSplit.factor; factor *= 2) {
        rw = Math.ceil(rw / 2); rh = Math.ceil(rh / 2); pipeline._target(`scatterReduce${factor}`, rw, rh);
    }
    pipeline._target("coverage", 512, 512, true);
    let bytes = 0;
    for (const t of pipeline.resources.targets.values()) {
        const channels = t.texture.format === RedFormat ? 1 : t.texture.format === RGFormat ? 2 : 4;
        bytes += t.width * t.height * (4 * channels + (t.depthBuffer ? 4 : 0)); t.dispose();
    }
    console.log(`MX15 resident targets: ${(bytes / 2 ** 20).toFixed(3)} MiB; routine ADC readback peak +5 MiB; fine-stage diagnostic readback +80 MiB`);
    expect(bytes / 2 ** 20).toBeLessThan(540);
});

test("range-table numeric reference rejects lost scaling and collapsed band pairing", () => {
    // Execute two source mutations in memory; production files remain untouched.
    const {readFileSync} = require("fs"), path = require("path"), {transformSync} = require("@babel/core");
    const filename = path.resolve("tools/thermal/atmosphere.js"), sourceText = readFileSync(filename, "utf8");
    for (const [before, after] of [
        ["path.pathRadiance[bandIndex] / PHOTON_SCALE", "path.pathRadiance[bandIndex]"],
        ["rangeLUT.transmission[index]", "rangeLUT.transmission[sample * N]"],
    ]) {
        expect(sourceText).toContain(before);
        const code = transformSync(sourceText.replace(before, after), {filename}).code, module = {exports: {}};
        new Function("require", "module", "exports", code)(id => require(path.resolve("tools/thermal", id)), module, module.exports);
        const atmosphere = A.createAtmosphere(), geometry = {sensorAltitudeM: 1382, elevationRad: .04};
        const mutated = module.exports, source = A.blackbodyBands(730, {quantity: "photon"});
        const table = mutated.createRangeLUT({...geometry, maxRangeM: 125000, size: 8, atmosphere});
        const actual = mutated.sourceRangeLUT(table, source).at(-1);
        const expectedPath = A.evaluatePhotonPath({...geometry, slantRangeM: 125000}, atmosphere, {segments: 96});
        const expected = M.sum(source.map((v, i) => v * expectedPath.transmission[i] + expectedPath.pathRadiance[i])) / PHOTON_SCALE;
        expect(Math.abs(actual / expected - 1)).toBeGreaterThan(.1);
    }
});

test("defocus converges when focal-plane spacing is halved as well as pupil resolution doubled", () => {
    const sensor = {focalM: .675, apertureM: .15, pitchM: 20e-6}, lambda = 3.143e-6;
    const fill = sensor.pitchM / 4 / (lambda * sensor.focalM / sensor.apertureM);
    const matched = M.diffractionKernel(sensor, {radiusPx: 8, defocusM: 200e-6, pupilGrid: 1024}, lambda, 4);
    const fine = M.diffractionKernel(sensor, {radiusPx: 8, defocusM: 200e-6, pupilGrid: 2048, pupilFill: fill / 2}, lambda, 4);
    expect(l1(matched.data, fine.data)).toBeLessThan(1e-6);
});

test("independent angular residual, jitter and diffusion add variances once", () => {
    const settings = base({opticsEnabled: false, systemBlurHorizontalRmsUrad: 30, systemBlurVerticalRmsUrad: 30, jitterRmsUrad: 10, diffusionSigmaPx: .2});
    const k = M.opticalKernels(settings).core, center = (k.width - 1) / 2;
    const variance = k.data.reduce((s, v, i) => s + v * ((i % k.width - center) / settings.supersample) ** 2, 0);
    const expected = ((30e-6) ** 2 + (10e-6) ** 2) * (settings.focalLengthM / settings.pixelPitchM) ** 2 + .2 ** 2;
    close(variance / expected, 1, .002);
    expect(M.opticalKernels({...settings, systemBlurHorizontalRmsUrad: 0, systemBlurVerticalRmsUrad: 0}).core).toEqual(M.opticalKernels({...settings, systemBlurHorizontalRmsUrad: undefined, systemBlurVerticalRmsUrad: undefined}).core);
});

test("unequal-population browser reference separates each processing algorithm", () => {
    const {processingModesReference} = require("../tools/thermal/selfTest.js");
    const counts = processingModesReference(), settings = base({adcOffsetCounts: 0, plateauFactor: 100});
    const result = mode => M.processCounts(counts, 32, 32, {...settings, gainMode: mode}).codes;
    expect(l1(result("plateau"), result("automatic")) / counts.length).toBeGreaterThan(50);
    expect(l1(result("manual"), result("automatic")) / counts.length).toBeGreaterThan(50);
});
