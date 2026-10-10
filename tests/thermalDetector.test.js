// Detector: well-fill exposure, shading, fixed pattern, the ADC pedestal, and the sensor chain's inputs.
import {SENSOR_PRESETS} from "../tools/thermal/sensorPresets.js";
import {defaultSettings, normalizeSettings} from "../tools/thermal/thermalSchema.js";
import {inBandRadiance, PHOTON_SCALE, radianceDerivative} from "../tools/thermal/radiometry.js";
import * as M from "../tools/thermal/sensorMath.js";

const close = (actual, expected, tolerance) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
// No noise, shading, fixed pattern, dark current, pedestal or blur.
const quiet = extra => normalizeSettings({noiseEnabled: false, shadingK: 0, fixedPatternFraction: 0,
    darkElectronsPerS: 0, adcOffsetCounts: 0, systemBlurRmsUrad: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0, turbulenceR0M: 0, ...extra});
// A quiet 32 × 24 detector at a manual 4× sampling, with a linear display: chain fixtures.
const sensorSettings = extra => normalizeSettings({detectorWidth: 32, detectorHeight: 24,
    fieldMode: "focalLength", opticalSamplingMode: "manual", supersample: 4,
    opticsRadiusPx: 8, scatterPreset: "custom", scatterFraction: 0,
    turbulenceR0M: 0, jitterRmsUrad: 0, diffusionSigmaPx: 0, systemBlurHorizontalRmsUrad: 0, systemBlurVerticalRmsUrad: 0,
    displayCurve: "linear", shadingK: 0, fixedPatternFraction: 0, noiseEnabled: false, ...extra});

test("reference blackbody fills half the well through the actual exposure factor", () => {
    for (const name of Object.keys(SENSOR_PRESETS)) {
        const settings = quiet({sensorPreset: name});
        const radiance = inBandRadiance(300, {minUm: settings.bandMinUm, maxUm: settings.bandMaxUm}).photon / PHOTON_SCALE;
        const time = M.integrationTime(settings);
        const independentRate = PHOTON_SCALE * settings.pixelPitchM ** 2 * settings.fillFactor * Math.PI / 4 *
            (settings.apertureM / settings.focalLengthM) ** 2 * settings.quantumEfficiency * settings.opticalTransmission;
        close(time * independentRate * radiance / settings.wellElectrons, 0.5, 1e-12);
        close(M.electronsPerRadiance(settings) * radiance / settings.wellElectrons, 0.5, 1e-12);
        close(M.detectorCounts(new Float32Array([radiance]), settings)[0], 8191.5, 0.5);
        expect(M.integrationTime({...settings, integrationTimeS: 0.9})).toBe(time);
        expect(M.integrationTime({...settings, exposureMode: "manual", integrationTimeS: 0.009})).toBe(0.009);
    }
    const settings = defaultSettings(), radiance = inBandRadiance(300).photon / PHOTON_SCALE;
    close((radiance * M.electronRatePerRadiance(settings) + settings.darkElectronsPerS) *
        M.integrationTime(settings) / settings.wellElectrons, 0.5, 1e-12);
    // Calculated t scales as 1/D²: a 0.135 m pupil gives 0.01463 s.
    close(M.integrationTime(quiet({fillFactor: 1})), 0.01463 * (.135 / .150) ** 2, 0.00001);
    expect(() => M.integrationTime({...settings, opticalTransmission: 0})).toThrow(/throughput/);
});

test("Planck derivative and detector shading have the specified kelvin scale and shape", () => {
    const settings = quiet({detectorWidth: 65, detectorHeight: 49, shadingK: 0.3});
    const derivative = radianceDerivative(300).photon / PHOTON_SCALE;
    const finiteDifference = (inBandRadiance(300.001).photon - inBandRadiance(299.999).photon) / (0.002 * PHOTON_SCALE);
    close(derivative / finiteDifference, 1, 1e-8);
    const cx = 32, cy = 24, halfWidth = 32.5;
    close(M.shadingTemperature(cx, cy, 65, 49), 0, 0);
    close(M.shadingTemperature(cx + halfWidth, cy, 65, 49), 0.3, 1e-15);
    const map = M.shadingMap(settings);
    for (const [x, y] of [[0, 0], [32, 24], [64, 24], [32, 48]]) {
        const q2 = ((x - cx) ** 2 + (y - cy) ** 2) / halfWidth ** 2;
        const expected = 0.3 * (1 - Math.exp(-q2 / (2 * 0.9 ** 2))) / (1 - Math.exp(-1 / (2 * 0.9 ** 2)));
        close(map[y * 65 + x] / derivative, expected, 3e-8);
    }
    const field = new Float32Array(map.length).fill(inBandRadiance(300).photon / PHOTON_SCALE);
    expect(M.detectorCounts(field, settings, 2)).toEqual(M.detectorCounts(field, settings, 99));
    expect(M.shadingMap({...settings, shadingK: 0}).every(value => value === 0)).toBe(true);
    const counts = M.detectorCounts(field, settings);
    close(counts[cy * 65 + 64] - counts[cy * 65 + cx], map[cy * 65 + 64] * M.electronsPerRadiance(settings) * 16383 / settings.wellElectrons, 1);
    const shorter = {...settings, exposureMode: "manual", integrationTimeS: M.integrationTime(settings) / 2};
    const shorterCounts = M.detectorCounts(field, shorter);
    close(shorterCounts[cy * 65 + 64] - shorterCounts[cy * 65 + cx], (counts[cy * 65 + 64] - counts[cy * 65 + cx]) / 2, 1);
});

test("digital zoom crops native shading rather than regenerating its radial coordinates", () => {
    const settings = quiet({detectorWidth: 64, detectorHeight: 48, shadingK: 0.3});
    const map = M.shadingMap(settings);
    expect(M.shadingMap({...settings, digitalZoom: 2})).toEqual(map);
    const config = {...settings, sampling: "linear"};
    const enlarged = M.enlargeImage(map, 64, 48, 128, 96, config);
    const zoomed = M.enlargeImage(map, 64, 48, 64, 48, {...config, digitalZoom: 2});
    for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++)
        close(zoomed[y * 64 + x], enlarged[(y + 24) * 128 + x + 32], 5e-10);
    expect(zoomed[0]).toBeLessThan(enlarged[0]);
});

test("fixed pattern has the requested RMS and stays identical between frames", () => {
    const settings = quiet({detectorWidth: 640, detectorHeight: 512, fixedPatternFraction: 0.0002});
    const offsets = M.fixedPatternMap(settings), mean = M.sum(offsets) / offsets.length;
    const variance = offsets.reduce((total, value) => total + (value - mean) ** 2, 0) / offsets.length;
    close(Math.sqrt(variance) / 16383, 0.0002, 0.000002);
    expect(M.fixedPatternMap(settings)).toEqual(offsets);
    expect(M.fixedPatternMap({...settings, noiseSeed: 1})).not.toEqual(offsets);
    const field = new Float32Array(offsets.length).fill(inBandRadiance(300).photon / PHOTON_SCALE);
    const first = M.detectorCounts(field, settings, 1);
    expect(M.detectorCounts(field, settings, 79)).toEqual(first);
    expect(new Set(first).size).toBeGreaterThan(10);
});

test("ADC pedestal preserves symmetric zero-signal noise and is removed for manual display", () => {
    const settings = sensorSettings({detectorWidth: 200, detectorHeight: 100, noiseEnabled: true,
        shotNoiseEnabled: false, shadingK: 0, darkElectronsPerS: 0, adcOffsetCounts: 256});
    const counts = M.detectorCounts(new Float32Array(20000), settings, 8);
    const mean = M.sum(counts) / counts.length;
    close(mean, 256, .05);
    expect(counts.some(v => v < 256)).toBe(true); expect(counts.some(v => v > 256)).toBe(true);
    const result = M.processCounts(new Float32Array([156, 256, 356]), 3, 1,
        {...settings, gainMode: "manual", fixedLevel: 0, fixedGain: 16383 / 200});
    expect(result.codes).toEqual(new Float32Array([0, 128, 255]));
});

test("CPU sensor chain requires an explicit background for optical boundaries", () => {
    expect(() => M.runSensorChain(new Float32Array(16), 4, 4, sensorSettings())).toThrow(/background/i);
});
