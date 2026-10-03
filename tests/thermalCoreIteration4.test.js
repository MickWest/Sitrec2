import {OrthographicCamera, PerspectiveCamera, Vector3} from "three";
import {backgroundAtElevation, createAtmosphere, createSkyElevationLUT, EARTH_RADIUS_M,
    sampleSkyElevationLUT, skyElevationRange, skyRayDirection, skyRayElevation, skyViewGeometry} from "../tools/thermal/atmosphere.js";
import {atmosphereFromSounding, parseSoundingCSV} from "../tools/thermal/sounding.js";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {integrateTurbulence, hufnagelValley, scaleR0, turbulenceMTF} from "../tools/thermal/turbulence.js";
import {defaultSettings, normalizeSettings, settingsForPreset, THERMAL_PARAMETERS} from "../tools/thermal/thermalSchema.js";
import {applyFarScatter, applyOptics, diffractionKernel, filterKernelMTF, gainStatistics,
    opticalKernels, plateauLUT, processingParameters, sampleDetector, sum, windowImage} from "../tools/thermal/sensorMath.js";
import {blurredPointSourceCase, sampledConvergenceSources, skyGradientReference} from "../tools/thermal/selfTest.js";
import {PHOTON_SCALE} from "../tools/thermal/radiometry.js";

const rad = degrees => degrees * Math.PI / 180;
const close = (actual, expected, tolerance) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
const base = extra => normalizeSettings({fieldMode: "focalLength", detectorWidth: 32, detectorHeight: 32,
    opticsRadiusPx: 8, scatterPreset: "custom", scatterFraction: 0,
    turbulenceR0M: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0, systemBlurRmsUrad: 0, ...extra});
const cpuPipeline = () => {
    const pipeline = new ThermalPipeline(null);
    pipeline.resources = {surfaces: new Map(), textures: new Set()};
    return pipeline;
};

test("new settings have explicit provenance, normalization and disabled controls", () => {
    const settings = defaultSettings();
    expect(settings).toMatchObject({skyGradient: true, gainRegion: "detector", turbulenceR0M: 0,
        jitterRmsUrad: 2.714, diffusionSigmaPx: 0.2});
    for (const key of ["skyGradient", "gainRegion", "turbulenceR0M", "jitterRmsUrad", "diffusionSigmaPx"]) {
        const definition = THERMAL_PARAMETERS.find(parameter => parameter.key === key);
        expect(["estimated", "calculated", "published"]).toContain(definition.status);
        expect(definition.source.length).toBeGreaterThan(20);
    }
    for (const name of ["ATFLIR", "OMAHA"]) expect(settingsForPreset(name)).toMatchObject({
        turbulenceR0M: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0});
    expect(normalizeSettings({...settings, jitterRmsUrad: -1, diffusionSigmaPx: -1})).toMatchObject({jitterRmsUrad: 0, diffusionSigmaPx: 0});
    expect(() => normalizeSettings({gainRegion: "target"})).toThrow();
});

test("clear-sky elevation table decreases, contains the axis, and reports interpolation error", () => {
    const reference = skyGradientReference(), {table, atmosphere, settings} = reference;
    const options = {sensorAltitudeM: settings.sensorAltitudeM, temperatureK: settings.surfaceTemperatureK};
    for (let i = 1; i < table.sampleCount; i++) expect(table.photonRadiances[i]).toBeLessThanOrEqual(table.photonRadiances[i - 1]);
    const axis = backgroundAtElevation(rad(settings.pathElevationDeg), options, atmosphere).photonRadiance;
    close(sampleSkyElevationLUT(table, rad(settings.pathElevationDeg)) / axis, 1, 1e-12);
    expect(table.sampleCount).toBeGreaterThanOrEqual(65);
    expect(table.sampleCount).toBeLessThanOrEqual(2049);
    let error = 0;
    // Independent quarter-point probes, rather than rechecking adaptive midpoints.
    for (let i = 1; i < table.sampleCount; i++) {
        const e = 0.75 * table.elevations[i - 1] + 0.25 * table.elevations[i];
        const direct = backgroundAtElevation(e, options, atmosphere).photonRadiance;
        error = Math.max(error, Math.abs(sampleSkyElevationLUT(table, e) / direct - 1));
    }
    expect(table.interpolation.toleranceMet).toBe(true);
    expect(error).toBeLessThan(2e-5);
    console.log(`Sky elevation LUT: ${table.sampleCount} samples; midpoint relative error ${table.interpolation.maxRelativeError.toExponential(3)}; independent quarter-point error ${error.toExponential(3)}`);
});

test("wide table covers the diagonal, keeps the sea below the depressed horizon and never blends the branches", () => {
    const settings = normalizeSettings({verticalFovDeg: 20, apertureM: .005, sensorAltitudeM: 1382, pathElevationDeg: 0});
    const view = skyViewGeometry(settings), atmosphere = createAtmosphere();
    const options = {sensorAltitudeM: settings.sensorAltitudeM, temperatureK: 288.15};
    const table = createSkyElevationLUT({view, ...options}, atmosphere);
    close(table.horizonRad, -Math.acos(EARTH_RADIUS_M / (EARTH_RADIUS_M + 1382)), 1e-15);
    for (const degrees of [-10, -3, -0.5, 2, 10]) {
        const direct = backgroundAtElevation(rad(degrees), options, atmosphere);
        expect(direct.kind).toBe(degrees < table.horizonRad * 180 / Math.PI ? "sea" : "sky");
        close(sampleSkyElevationLUT(table, rad(degrees)) / direct.photonRadiance, 1, 8e-5);
    }
    expect(table.elevations.filter(e => e === table.horizonRad)).toHaveLength(2);
    for (let y = -1; y <= 1; y += 0.25) for (let x = -1; x <= 1; x += 0.25) {
        const e = skyRayElevation(x, y, view);
        expect(e).toBeGreaterThan(table.minRad); expect(e).toBeLessThan(table.maxRad);
    }
    console.log(`Wide sky/sea LUT: ${table.sampleCount} samples; midpoint relative error ${table.interpolation.maxRelativeError.toExponential(3)}`);
});

test("ray elevation uses image vertical by default and camera-space local up when supplied", () => {
    const settings = normalizeSettings({verticalFovDeg: 20, apertureM: .005, pathElevationDeg: 30});
    const view = skyViewGeometry(settings), e = rad(30);
    close(skyRayElevation(0, 0, view), e, 1e-15);
    close(skyRayElevation(0, 1, view), e + rad(10), 1e-15);
    close(skyRayElevation(0, -1, view), e - rad(10), 1e-15);
    // Finite horizontal off-axis elevation is not center elevation plus y*FOV.
    close(skyRayElevation(1, 0, view), Math.asin(Math.sin(e) / Math.hypot(1, view.aspect * view.tanHalfY)), 1e-15);
    const rolled = skyViewGeometry(settings, new Vector3(Math.cos(e), 0, -Math.sin(e)).multiplyScalar(7));
    close(skyRayElevation(0, 0, rolled), e, 1e-15);
    expect(skyRayElevation(1, 0, rolled)).toBeGreaterThan(e);
    close(skyRayElevation(0, 1, rolled), skyRayElevation(0, -1, rolled), 1e-15);
    const otherElevation = skyViewGeometry(settings, [0, 1, 0]);
    expect(skyRayElevation(0, 0, otherElevation)).toBe(0);
    expect(() => skyViewGeometry(settings, [0, 0, 0])).toThrow(/skyUp/);
    const nearZenith = skyViewGeometry({...settings, pathElevationDeg: 89});
    expect(skyElevationRange(nearZenith).maxRad).toBe(Math.PI / 2);
});

test("inverse projection handles a coverage tile and orthographic directions", () => {
    const settings = normalizeSettings({verticalFovDeg: 5});
    const camera = new PerspectiveCamera(settings.verticalFovDeg, settings.detectorWidth / settings.detectorHeight);
    const plain = skyViewGeometry(settings), projected = skyViewGeometry(settings, null, camera);
    for (const [x, y] of [[-1, -1], [0, 0], [0.4, 0.7]]) {
        const direction = new Vector3(x, y, 0).unproject(camera).normalize().toArray();
        skyRayDirection(x, y, projected).forEach((value, i) => close(value, direction[i], 1e-14));
        close(skyRayElevation(x, y, plain), skyRayElevation(x, y, projected), 1e-14);
    }
    camera.setViewOffset(640, 512, 320, 0, 320, 256);
    const tile = skyViewGeometry(settings, null, camera);
    close(skyRayElevation(0, 0, tile), skyRayElevation(0.5, 0.5, plain), 1e-14);
    const ortho = skyViewGeometry(settings, null, new OrthographicCamera());
    close(skyRayElevation(-1, 1, ortho), skyRayElevation(1, -1, ortho), 0);
});

test("background cache keys track atmosphere content, field, band and sky direction; uniform mode is retained", () => {
    const pipeline = cpuPipeline();
    const settings = normalizeSettings({sensorAltitudeM: 1382, pathElevationDeg: 2.23});
    const prepare = (s, sounding = null, up = null) => {
        pipeline._prepareAtmosphere(s, sounding);
        pipeline._prepareSkyBackground(s, skyViewGeometry(s, up));
    };
    prepare(settings);
    const first = pipeline.skyTable;
    expect(pipeline.frameBackground).toMatchObject({gradient: true, sampleCount: first.sampleCount});
    expect(pipeline.frameBackground.elevationRangeDeg[0]).toBeLessThan(2.23);
    expect(pipeline.frameBackground.photonRadianceRange[0]).toBeLessThan(pipeline.frameBackground.photonRadianceRange[1]);
    prepare({...settings, digitalZoom: 2}); expect(pipeline.skyTable).toBe(first);
    const elevation = rad(settings.pathElevationDeg);
    prepare(settings, null, [Math.cos(elevation), 0, -Math.sin(elevation)]);
    expect(pipeline.skyTable).toBe(first); // pure roll keeps the enclosing elevation interval
    prepare(settings, null, [0, Math.cos(rad(5)), -Math.sin(rad(5))]);
    expect(pipeline.skyTable).not.toBe(first);
    const pointed = pipeline.skyTable;
    prepare({...settings, pathElevationDeg: 7}); expect(pipeline.skyTable).not.toBe(pointed);
    prepare({...settings, verticalFovDeg: 2}); expect(pipeline.skyTable).not.toBe(first);
    prepare({...settings, bandMinUm: 3.7}); expect(pipeline.skyTable).not.toBe(first);
    prepare({...settings, skyGradient: false});
    expect(pipeline.frameBackground).toMatchObject({gradient: false, sampleCount: 1});
    expect(pipeline.frameBackground.photonRadianceRange).toEqual([pipeline.background.photonRadiance, pipeline.background.photonRadiance]);
    prepare({...settings, skySource: "manual"}); expect(pipeline.frameBackground.gradient).toBe(false);
    const csv = `level_type,pressure_Pa,geopotential_height_m,temperature_C,relative_humidity_pct,dewpoint_depression_C,wind_dir_deg,wind_speed_m_s
10,100000,0,15,50,,,
10,70000,3000,-5,20,,,`;
    const profile = parseSoundingCSV(csv); // estimated two-level test sounding
    prepare(settings, profile);
    const measured = pipeline.skyTable;
    expect(measured).not.toBe(first);
    const direct = backgroundAtElevation(rad(2.23), {sensorAltitudeM: 1382}, atmosphereFromSounding(profile).atmosphere);
    close(sampleSkyElevationLUT(measured, rad(2.23)) / direct.photonRadiance, 1, 1e-12);
    prepare(settings, parseSoundingCSV(csv)); expect(pipeline.skyTable).toBe(measured);
    prepare(settings, parseSoundingCSV(csv.replace(",15,50", ",16,50"))); expect(pipeline.skyTable).not.toBe(measured);
    for (const texture of pipeline.resources.textures) texture.dispose();
});

test("HV spherical integration reproduces the 125 km reference r0 and wavelength scaling", () => {
    // Estimated reconstructed IB6830 frame-11000 endpoints, in m. Published HV21
    // transferred to this geometry gives calculated r0=.5723 m at 4 um.
    const geometry = {sensorAltitudeM: 1382, targetAltitudeM: 7479.8611315789485, slantRangeM: 124979.14348796658};
    const result = integrateTurbulence(geometry);
    close(result.r0M, 0.5723, 0.0001);
    close(result.planeR0M, 0.4275, 0.0001);
    close(result.sphericalIntegral / 2.4285e-12, 1, 0.0001);
    expect(result.isoplanaticAngleRad).toBeGreaterThan(2e-6);
    expect(result.isoplanaticAngleRad).toBeLessThan(4e-6);
    expect(result.sampleCount).toBe(20001);
    const blue = integrateTurbulence(geometry, {wavelengthM: 3e-6});
    close(blue.r0M / result.r0M, (3 / 4) ** (6 / 5), 1e-12);
    close(blue.r0ReferenceM, result.r0M, 1e-12);
    close(scaleR0(result.r0M, 5e-6) / result.r0M, (5 / 4) ** (6 / 5), 1e-12);
    expect(hufnagelValley(2000, {windSpeedMS: 40})).toBeGreaterThan(hufnagelValley(2000));
    close(hufnagelValley(2000, {multiplier: 0.1}) / hufnagelValley(2000), 0.1, 1e-15);
    console.log(`HV21 finite-source reference: r0=${result.r0M.toFixed(6)} m at 4 um; theta0=${(result.isoplanaticAngleRad * 1e6).toFixed(6)} urad`);
});

test("uniform Cn² has the analytic finite-distance 3/8 weighting and isoplanatic angle", () => {
    const cn2 = 4e-17, length = 100000, wavelengthM = 4e-6;
    const result = integrateTurbulence({sensorAltitudeM: 2000, targetAltitudeM: 2000, slantRangeM: length}, {cn2: () => cn2});
    close(result.sphericalIntegral / (cn2 * length), 3 / 8, 1e-8);
    const expected = (2.91 * (2 * Math.PI / wavelengthM) ** 2 * cn2 * (3 / 8) * length ** (8 / 3)) ** (-3 / 5);
    close(result.isoplanaticAngleRad / expected, 1, 1e-8);
    expect(integrateTurbulence({sensorAltitudeM: 1000, targetAltitudeM: 1000, slantRangeM: 0}).r0M).toBe(Infinity);
    expect(() => integrateTurbulence({sensorAltitudeM: 1000, targetAltitudeM: 1000, slantRangeM: 1e6})).toThrow(/surface/);
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
    const settings = base({turbulenceR0M: 0.15});
    const weighted = opticalKernels(settings).core;
    const plain = opticalKernels({...settings, turbulenceR0M: 0}).core;
    const achromatic = filterKernelMTF(plain, step, f => turbulenceMTF(f, 4e-6, 0.15));
    expect(sum(weighted.data.map((v, i) => Math.abs(v - achromatic.data[i])))).toBeGreaterThan(0.0001);
});

test.each(["turbulenceR0M", "jitterRmsUrad", "diffusionSigmaPx"])("%s conserves flux, lowers the peak and is exactly bypassed at zero", key => {
    const settings = base(), baseline = opticalKernels(settings).core;
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

test("Gaussian jitter and diffusion follow angular/native units before detector integration", () => {
    const settings = base(), angularPixel = settings.pixelPitchM / settings.focalLengthM;
    const clear = opticalKernels(settings).core;
    const blur = opticalKernels({...settings, jitterRmsUrad: 2.714, diffusionSigmaPx: 0.2}).core;
    const frequencyPx = 0.5, sigmaPx = Math.hypot(2.714e-6 / angularPixel, 0.2);
    close(transferAt(blur, frequencyPx / settings.supersample) / transferAt(clear, frequencyPx / settings.supersample),
        Math.exp(-2 * Math.PI ** 2 * sigmaPx ** 2 * frequencyPx ** 2), 0.005);
    const off = opticalKernels({...settings, opticsEnabled: false}).core;
    expect(off.data).toEqual(new Float32Array([1]));
    const image = new Float32Array(128 * 128); image[64 * 128 + 64] = 1;
    const sampled = sampleDetector(applyOptics(image, 128, 128, opticalKernels({...settings, diffusionSigmaPx: 0.2})), 128, 128, 4);
    close(sum(sampled) * 16, 1, 2e-7);
});

test("the changing sky radiance reaches the near and far scatter branches", () => {
    const settings = base({opticsEnabled: false, scatterFraction: 0.1, scatterCutoffRad: 0.02});
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

test.each(["automatic", "plateau"])("%s gathers statistics from the selected native region", gainMode => {
    const settings = base({detectorWidth: 8, detectorHeight: 8, gainMode, digitalZoom: 2,
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

test("CPU sides of the sky and blurred-source browser checks execute in Jest", () => {
    const testCase = blurredPointSourceCase();
    const blurred = sampledConvergenceSources(testCase);
    const plain = sampledConvergenceSources(testCase, {...testCase.settings, turbulenceR0M: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0});
    close(sum(blurred) / sum(plain), 1, 1e-6);
    expect(Math.max(...blurred)).toBeLessThan(Math.max(...plain));
    const e = rad(2.23);
    for (const up of [null, [Math.cos(e), 0, -Math.sin(e)]]) {
        const reference = skyGradientReference(up);
        expect(reference.values).toHaveLength(5);
        reference.pixels.forEach(([x, y], i) => {
            const elevationRad = skyRayElevation(2 * (x + 0.5) / reference.width - 1, 2 * (y + 0.5) / reference.height - 1, reference.view);
            const direct = backgroundAtElevation(elevationRad, {sensorAltitudeM: 1382}, reference.atmosphere);
            close(reference.values[i] * PHOTON_SCALE / direct.photonRadiance, 1, 2e-5);
        });
    }
});
