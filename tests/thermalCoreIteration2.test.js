import {Mesh, MeshBasicMaterial, PlaneGeometry, Scene} from "three";
import {SENSOR_PRESETS, SCATTER_PRESETS} from "../tools/thermal/sensorPresets.js";
import {defaultSettings, normalizeSettings, settingsForPreset} from "../tools/thermal/thermalSchema.js";
import {inBandRadiance, PHOTON_SCALE, radianceDerivative} from "../tools/thermal/radiometry.js";
import {createAtmosphere} from "../tools/thermal/atmosphere.js";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import * as sensor from "../tools/thermal/sensorMath.js";

const close = (actual, expected, tolerance) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
const quiet = extra => normalizeSettings({noiseEnabled: false, shadingK: 0, fixedPatternFraction: 0,
    darkElectronsPerS: 0, adcOffsetCounts: 0, systemBlurRmsUrad: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0, turbulenceR0M: 0, ...extra});

test("sensor geometry retains the evidence status of each source", () => {
    const mx = settingsForPreset("MX15"), at = settingsForPreset("ATFLIR"), sea = settingsForPreset("OMAHA");
    expect([mx.detectorWidth, mx.detectorHeight, mx.pixelPitchM, mx.focalLengthM]).toEqual([640, 512, 20e-6, 0.675]);
    close(mx.verticalFovDeg, 0.8691815267, 1e-10);
    expect(Math.abs(mx.verticalFovDeg / (0.915 * 1024 / 1080) - 1)).toBeLessThan(0.002);
    expect(mx.presetMetadata.pixelPitchM.status).toBe("published");
    expect(mx.presetMetadata.verticalFovDeg.status).toBe("calculated");
    expect(mx.presetMetadata.apertureM).toMatchObject({value: 0.150, status: "estimated"});
    for (const settings of [at, sea]) {
        expect([settings.detectorWidth, settings.detectorHeight]).toEqual([640, 480]);
        expect(settings.presetMetadata.detectorWidth.status).toBe("published");
        expect(settings.presetMetadata.detectorHeight.status).toBe("published");
        expect(settings.presetMetadata.pixelPitchM.status).toBe("estimated");
        expect(settings.presetMetadata.apertureM.status).toBe("estimated");
        expect(settings.presetMetadata.focalLengthM.status).toBe("calculated");
    }
    expect([at.bandMinUm, at.bandMaxUm]).toEqual([3.7, 5]);
    expect(at.presetMetadata.verticalFovDeg.status).toBe("estimated");
    close(2 * Math.atan(sea.detectorWidth * sea.pixelPitchM / (2 * sea.focalLengthM)) * 180 / Math.PI, 0.7, 1e-12);
    for (const key of ["shadingK", "shadingWidth", "fixedPatternFraction", "wellFillFraction", "scatterFraction"])
        expect(SENSOR_PRESETS.MX15.parameters[key].status).toBe("estimated");
});

test("reference blackbody fills half the well through the actual exposure factor", () => {
    for (const name of Object.keys(SENSOR_PRESETS)) {
        const settings = quiet({sensorPreset: name});
        const radiance = inBandRadiance(300, {minUm: settings.bandMinUm, maxUm: settings.bandMaxUm}).photon / PHOTON_SCALE;
        const time = sensor.integrationTime(settings);
        const independentRate = PHOTON_SCALE * settings.pixelPitchM ** 2 * settings.fillFactor * Math.PI / 4 *
            (settings.apertureM / settings.focalLengthM) ** 2 * settings.quantumEfficiency * settings.opticalTransmission;
        close(time * independentRate * radiance / settings.wellElectrons, 0.5, 1e-12);
        close(sensor.electronsPerRadiance(settings) * radiance / settings.wellElectrons, 0.5, 1e-12);
        close(sensor.detectorCounts(new Float32Array([radiance]), settings)[0], 8191.5, 0.5);
        expect(sensor.integrationTime({...settings, integrationTimeS: 0.9})).toBe(time);
        expect(sensor.integrationTime({...settings, exposureMode: "manual", integrationTimeS: 0.009})).toBe(0.009);
    }
    const settings = defaultSettings(), radiance = inBandRadiance(300).photon / PHOTON_SCALE;
    close((radiance * sensor.electronRatePerRadiance(settings) + settings.darkElectronsPerS) *
        sensor.integrationTime(settings) / settings.wellElectrons, 0.5, 1e-12);
    // Calculated t scales as 1/D²: the former 0.135 m reference was 0.01463 s.
    close(sensor.integrationTime(quiet({fillFactor: 1})), 0.01463 * (.135 / .150) ** 2, 0.00001);
    expect(() => sensor.integrationTime({...settings, opticalTransmission: 0})).toThrow(/throughput/);
});

test("Planck derivative and detector shading have the specified kelvin scale and shape", () => {
    const settings = quiet({detectorWidth: 65, detectorHeight: 49, shadingK: 0.3});
    const derivative = radianceDerivative(300).photon / PHOTON_SCALE;
    const finiteDifference = (inBandRadiance(300.001).photon - inBandRadiance(299.999).photon) / (0.002 * PHOTON_SCALE);
    close(derivative / finiteDifference, 1, 1e-8);
    const cx = 32, cy = 24, halfWidth = 32.5;
    close(sensor.shadingTemperature(cx, cy, 65, 49), 0, 0);
    close(sensor.shadingTemperature(cx + halfWidth, cy, 65, 49), 0.3, 1e-15);
    const map = sensor.shadingMap(settings);
    for (const [x, y] of [[0, 0], [32, 24], [64, 24], [32, 48]]) {
        const q2 = ((x - cx) ** 2 + (y - cy) ** 2) / halfWidth ** 2;
        const expected = 0.3 * (1 - Math.exp(-q2 / (2 * 0.9 ** 2))) / (1 - Math.exp(-1 / (2 * 0.9 ** 2)));
        close(map[y * 65 + x] / derivative, expected, 3e-8);
    }
    const field = new Float32Array(map.length).fill(inBandRadiance(300).photon / PHOTON_SCALE);
    expect(sensor.detectorCounts(field, settings, 2)).toEqual(sensor.detectorCounts(field, settings, 99));
    expect(sensor.shadingMap({...settings, shadingK: 0}).every(value => value === 0)).toBe(true);
    const counts = sensor.detectorCounts(field, settings);
    close(counts[cy * 65 + 64] - counts[cy * 65 + cx], map[cy * 65 + 64] * sensor.electronsPerRadiance(settings) * 16383 / settings.wellElectrons, 1);
    const shorter = {...settings, exposureMode: "manual", integrationTimeS: sensor.integrationTime(settings) / 2};
    const shorterCounts = sensor.detectorCounts(field, shorter);
    close(shorterCounts[cy * 65 + 64] - shorterCounts[cy * 65 + cx], (counts[cy * 65 + 64] - counts[cy * 65 + cx]) / 2, 1);
});

test("digital zoom crops native shading rather than regenerating its radial coordinates", () => {
    const settings = quiet({detectorWidth: 64, detectorHeight: 48, shadingK: 0.3});
    const map = sensor.shadingMap(settings);
    expect(sensor.shadingMap({...settings, digitalZoom: 2})).toEqual(map);
    const config = {...settings, sampling: "linear"};
    const enlarged = sensor.enlargeImage(map, 64, 48, 128, 96, config);
    const zoomed = sensor.enlargeImage(map, 64, 48, 64, 48, {...config, digitalZoom: 2});
    for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++)
        close(zoomed[y * 64 + x], enlarged[(y + 24) * 128 + x + 32], 5e-10);
    expect(zoomed[0]).toBeLessThan(enlarged[0]);
});

test("fixed pattern has the requested RMS and stays identical between frames", () => {
    const settings = quiet({detectorWidth: 640, detectorHeight: 512, fixedPatternFraction: 0.0002});
    const offsets = sensor.fixedPatternMap(settings), mean = sensor.sum(offsets) / offsets.length;
    const variance = offsets.reduce((total, value) => total + (value - mean) ** 2, 0) / offsets.length;
    close(Math.sqrt(variance) / 16383, 0.0002, 0.000002);
    expect(sensor.fixedPatternMap(settings)).toEqual(offsets);
    expect(sensor.fixedPatternMap({...settings, noiseSeed: 1})).not.toEqual(offsets);
    const field = new Float32Array(offsets.length).fill(inBandRadiance(300).photon / PHOTON_SCALE);
    const first = sensor.detectorCounts(field, settings, 1);
    expect(sensor.detectorCounts(field, settings, 79)).toEqual(first);
    expect(new Set(first).size).toBeGreaterThan(10);
});

test("scatter choices apply all values, numeric edits become custom, and saves round trip", () => {
    const clean = defaultSettings();
    const dirty = normalizeSettings({...clean, scatterPreset: "dirty"});
    for (const [key, value] of Object.entries(SCATTER_PRESETS.dirty)) expect(dirty[key]).toBe(value);
    expect(dirty.presetMetadata.scatterSlope).toMatchObject({status: "estimated", value: 1.7});
    expect(normalizeSettings(JSON.parse(JSON.stringify(dirty)))).toEqual(dirty);
    const custom = normalizeSettings({...dirty, scatterFraction: 0.02});
    expect(custom.scatterPreset).toBe("custom"); expect(custom.scatterFraction).toBe(0.02);
    const restored = normalizeSettings({...custom, scatterPreset: "clean"});
    for (const [key, value] of Object.entries(SCATTER_PRESETS.clean)) expect(restored[key]).toBe(value);
    expect(normalizeSettings({scatterFraction: 0}).scatterFraction).toBe(0);
});

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
    const kernels = sensor.opticalKernels(settings, width, height);
    expect(kernels.farMass).toBeGreaterThan(0);
    close(sensor.sum(kernels.scatter.data) + sensor.sum(kernels.farScatter.data), 1, 6e-8);
    const points = [{x: 128, y: 123, flux: 1}, {x: 3, y: 19, flux: 0.7}, {x: 218, y: 192, flux: 0.3}];
    const input = new Float32Array(width * height);
    for (const point of points) input[point.y * width + point.x] = point.flux;
    const actual = sensor.applyOptics(input, width, height, kernels);
    const direct = directPointConvolution(settings, width, height, points);
    const flux = points.reduce((value, point) => value + point.flux, 0);
    const l1 = actual.reduce((value, sample, pixel) => value + Math.abs(sample - direct[pixel]), 0) / flux;
    // Absolute integrated profile error <= 1% of redistributed flux, not 1% of
    // the bright unscattered peak. Includes off-center sources and partial cells.
    expect(l1 / settings.scatterFraction).toBeLessThan(0.01);
    close(sensor.sum(actual) / flux, sensor.sum(direct) / flux, settings.scatterFraction * 0.01);
    const uniform = new Float32Array(input.length).fill(0.4);
    expect(sensor.applyOptics(uniform, width, height, kernels, uniform[0])).toEqual(uniform);
}, 30000);

test("full contained scatter conserves energy after coarse reduction and reconstruction", () => {
    const settings = quiet({scatterPreset: "custom", scatterFraction: 0.4, scatterShoulderRad: 0.001,
        opticalSamplingMode: "manual", supersample: 2,
        scatterCutoffRad: 0.006, pixelPitchM: 100e-6, focalLengthM: 0.1, fieldMode: "focalLength",
        opticsEnabled: true, opticsRadiusPx: 2, detectorWidth: 128, detectorHeight: 128});
    const width = 256, input = new Float32Array(width * width); input[126 * width + 129] = 1;
    const kernels = sensor.opticalKernels(settings, width, width);
    // Exercise the same production split at a small, fully contained support.
    const plan = {...kernels.split, nearRadius: 8, nearCutoffRad: 8 * kernels.split.angularStep, factor: 2};
    const split = {...kernels, ...sensor.splitScatter(settings, plan), split: plan, farCore: sensor.coarsenKernel(kernels.core, 2)};
    expect(split.farMass).toBeGreaterThan(0);
    close(sensor.sum(sensor.applyFarScatter(input, width, width, split)), split.farMass, 1e-7);
    close(sensor.sum(sensor.applyOptics(input, width, width, split)), 1, 2e-7);
});

test("wide scatter allocation remains bounded for clean and dirty native presets", () => {
    for (const name of ["clean", "dirty"]) for (const supersample of [2, 4]) {
        const settings = normalizeSettings({scatterPreset: name, opticalSamplingMode: "manual", supersample});
        const plan = sensor.scatterPlan(settings);
        expect(plan.fftWidth).toBeLessThanOrEqual(4096); expect(plan.fftHeight).toBeLessThanOrEqual(4096);
        expect(plan.nearCutoffRad).toBeLessThan(settings.scatterCutoffRad);
        expect(Math.ceil((settings.detectorWidth * supersample + 2 * (plan.fullRadius + settings.opticsRadiusPx * supersample)) / plan.factor) + 8).toBeLessThanOrEqual(1024);
    }
    expect(() => sensor.scatterPlan(normalizeSettings({opticalSamplingMode: "manual", supersample: 8}))).toThrow(/4096/);
});

test("surface air drives the atmospheric profile independently of object ambient air", () => {
    const standard = createAtmosphere(), warmer = createAtmosphere({surfaceTemperatureK: 300});
    close(standard.sample(0).temperatureK, 288.15, 1e-12);
    close(standard.sample(1382).temperatureK, 288.15 - 0.0065 * 1382, 1e-12);
    close(warmer.sample(1382).temperatureK, 300 - 0.0065 * 1382, 1e-12);
    expect(warmer.sample(1382).pressurePa).toBeGreaterThan(standard.sample(1382).pressurePa);
    const pipeline = new ThermalPipeline(null);
    pipeline.resources = {surfaces: new Map()};
    const settings = quiet({surfaceTemperatureK: 300, ambientTemperatureK: 240, atmosphereMaxRangeM: 1000});
    pipeline._prepareAtmosphere(settings);
    const table = pipeline.rangeLUT;
    pipeline._prepareAtmosphere({...settings, ambientTemperatureK: 280});
    expect(pipeline.rangeLUT).toBe(table);
    pipeline._prepareAtmosphere({...settings, surfaceTemperatureK: 288.15});
    expect(pipeline.rangeLUT).not.toBe(table);
    expect(pipeline.rangeLUT.pathRadiance).not.toEqual(table.pathRadiance);
    const scene = new Scene(), mesh = new Mesh(new PlaneGeometry(), new MeshBasicMaterial()); scene.add(mesh);
    expect(pipeline._attributes(mesh, scene, settings).temperatureK).toBe(240);
    mesh.geometry.dispose(); mesh.material.dispose();
});
