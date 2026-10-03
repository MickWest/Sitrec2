/** @jest-environment jsdom */
import {PerspectiveCamera, Scene, Vector3} from "three";
import {createThermalViewAdapter, thermalMachWarning} from "../src/rendering/ThermalViewAdapter";
import {Globals, NodeMan, Sit} from "../src/Globals";
import {defaultSettings, normalizeSettings, settingsForPreset, THERMAL_PARAMETERS} from "../tools/thermal/thermalSchema.js";
import {SENSOR_PRESETS} from "../tools/thermal/sensorPresets.js";
import {automaticWindow, detectorPresentation, enlargeImage, gainStatistics, opticalKernels,
    psfSpectrum, runSensorChain, sum, temporalFilter} from "../tools/thermal/sensorMath.js";
import {BANDS, blackbodyBands, cloudBackground, createAtmosphere, evaluatePath} from "../tools/thermal/atmosphere.js";
import {inBandRadiance} from "../tools/thermal/radiometry.js";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import en from "../src/i18n/en.js";

jest.mock("../src/Globals", () => ({Globals: {equatorRadius: 6371000, polarRadius: 6371000},
    NodeMan: {get: jest.fn(), iterate: jest.fn()}, Sit: {fps: 30, lat: 0, lon: 0}, markSitchDirty: jest.fn(), setRenderOne: jest.fn()}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: () => 0}));
jest.mock("../src/par", () => ({par: {frame: 0, trackToTrackStopAt: 0}}));
jest.mock("../src/i18n", () => ({t: (key, values = {}) => {
    const en = jest.requireActual("../src/i18n/en.js").default;
    return key.split(".").reduce((value, part) => value?.[part], en)?.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]) ?? key;
}}));
const close = (actual, expected, tolerance = 1e-10) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);

// Published focal steps: manufacturer operations manual.
// Calculated windows from the 2014-11-11 IB6830 active inset and 2× pixel footprints.
test.each(["27", "135", "675", "1012"])("MX15 optical step %s keeps native sampling and selects the window and pupil", focalStep => {
    const settings = normalizeSettings({...settingsForPreset("MX15"), focalStep});
    close(settings.focalLengthM, Number(focalStep) / 1000);
    close(settings.focalLengthM / settings.apertureM, .675 / .150);
    expect([settings.detectorWidth, settings.detectorHeight]).toEqual([640, 512]);
    const size = focalStep === "1012" ? [480, 384] : [640, 512];
    expect(settings.detectorWindow).toEqual({width: size[0], height: size[1]});
    expect([settings.pictureWidth, settings.pictureHeight]).toEqual(size.map(n => 2 * n));
    close(settings.verticalFovDeg, 2 * Math.atan(512 * 20e-6 / (2 * settings.focalLengthM)) * 180 / Math.PI);
    if (focalStep === "27") expect(() => normalizeSettings({...settings, pupilPolicy: "keepPupil"})).toThrow(/Pupil aperture/);
    else {
        const kept = normalizeSettings({...settings, pupilPolicy: "keepPupil"});
        close(kept.apertureM, .150);
        expect(normalizeSettings(JSON.parse(JSON.stringify(kept)))).toEqual(kept);
    }
    const editedReference = normalizeSettings({...settings, pupilReferenceM: .135});
    close(editedReference.apertureM, .135 * settings.focalLengthM / .675);
    expect(normalizeSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
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

test("free optics, old explicit fields and optical edits remain usable", () => {
    for (const sensorPreset of ["ATFLIR", "OMAHA"]) {
        const s = normalizeSettings({sensorPreset, fieldMode: "focalLength", focalLengthM: .8, focalStep: "1012"});
        expect(s.focalStep).toBe("free"); close(s.focalLengthM, .8);
        expect(normalizeSettings({...s, fieldMode: "fieldOfView", verticalFovDeg: 2}).verticalFovDeg).toBe(2);
    }
    expect(normalizeSettings({fieldMode: "focalLength", focalLengthM: 1.0125}).focalStep).toBe("free");
    const s = settingsForPreset("MX15");
    const edit = normalizeSettings({...s, focalLengthM: .8});
    expect(edit.focalStep).toBe("free"); close(edit.focalLengthM, .8);
    expect(normalizeSettings({...s, apertureM: .135}).focalStep).toBe("free");
    expect(() => normalizeSettings({focalStep: "999"})).toThrow();
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

test("received PSF weights intersect atmospheric bands and shorten the reference wavelength", () => {
    // Estimated geometry near IB6830, standard atmosphere; calculated spectral result.
    const settings = normalizeSettings({sensorAltitudeM: 1382, pathElevationDeg: 2.23, psfRangeM: 125000, psfTemperatureK: 500});
    const received = psfSpectrum(settings), source = psfSpectrum({...settings, psfRangeM: 0});
    close(source.meanWavelengthM * 1e6, 4.245523583745341, 1e-9);
    expect(received.meanWavelengthM * 1e6).toBeGreaterThan(3.95);
    expect(received.meanWavelengthM * 1e6).toBeLessThan(4.0);
    close(sum(received.bins.map(bin => bin.weight)), 1);
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
    const pipeline = new ThermalPipeline(null);
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

test("temporal filter advances once per forward frame and resets on repeats, seeks and sensor changes", () => {
    const s = defaultSettings(), first = new Float32Array([100, 200]), next = new Float32Array([200, 100]);
    let state = temporalFilter(first, s, 10);
    expect(state.image).toEqual(first);
    state = temporalFilter(next, s, 11, state);
    expect(state.image).toEqual(new Float32Array([170, 130]));
    const skipped = temporalFilter(next, s, 13, state);
    close(skipped.memory, .3 ** 2);
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
    close(1 / (window.high - window.low), gain);
    close(-window.low * gain, offset);
    expect(automaticWindow(counts, {deltaTimeS: 0, dynamics: "gainOffset"}, previous)).toEqual(previous);
});

test.each(["energy", "photon"])("cloud source inherits %s units and spectral band through zero and finite paths", quantity => {
    const band = {minUm: 3.7, maxUm: 4.1}, temperatureK = 270;
    for (const range of [0, 10000]) {
        const path = evaluatePath({sensorAltitudeM: 1382, elevationRad: .1, slantRangeM: range}, createAtmosphere(), {quantity, band});
        const B = blackbodyBands(temperatureK, {quantity, band});
        const opaque = cloudBackground(path, {temperatureK, normalOpticalDepth: 100});
        const expected = sum(B.map((v, i) => v * path.transmission[i] + path.pathRadiance[i]));
        close(opaque.observedRadiance / expected, 1, 1e-12);
        if (!range) close(opaque.observedRadiance / inBandRadiance(temperatureK, band)[quantity], 1, 1e-7);
        const transparent = cloudBackground(path, {temperatureK, normalOpticalDepth: 0, behindRadiance: B});
        close(transparent.observedRadiance / expected, 1, 1e-12);
        expect(opaque.quantity).toBe(quantity);
    }
});

test("preset audit values, statuses, limits and public provenance are retained", () => {
    const mx = SENSOR_PRESETS.MX15.parameters;
    expect(mx.apertureM).toMatchObject({value: .150, status: "estimated"});
    expect(mx.apertureM.source).toContain("0.120–0.180");
    for (const key of ["bandMinUm", "bandMaxUm"]) {
        expect(mx[key].status).toBe("published"); expect(mx[key].source).toContain("Published manufacturer data sheet");
    }
    expect(mx.jitterRmsUrad.source).toContain("unspecified bandwidth");
    expect(mx.detectorHeight.source).toContain("Published manufacturer data sheet");
    expect(SENSOR_PRESETS.ATFLIR.parameters.bandMinUm.source).toContain("Published manufacturer conference paper");
    expect(SENSOR_PRESETS.ATFLIR.parameters.pixelPitchM.status).toBe("estimated");
    expect(SENSOR_PRESETS.OMAHA.parameters.detectorHeight).toMatchObject({value: 480, status: "published"});
    expect(SENSOR_PRESETS.OMAHA.parameters.verticalFovDeg.source).toContain("unspecified axis");
    for (const preset of Object.values(SENSOR_PRESETS)) for (const parameter of Object.values(preset.parameters))
        expect(parameter.source.length).toBeGreaterThan(10);
    for (const key of ["focalStep", "pupilPolicy", "pupilReferenceM", "psfRangeM", "temporalFilterAlpha", "agcDynamics", "sampling"]) {
        const definition = THERMAL_PARAMETERS.find(p => p.key === key);
        expect(definition.source.length).toBeGreaterThan(10);
        expect(en.thermal.parameters[key].label).toBe(definition.label);
        expect(en.thermal.parameters[key].tooltip).toBe(definition.tooltip);
    }
});

test("implausible scene-derived airliner Mach warns and suggests an override without changing values", () => {
    const recipe = {parameters: {vehicleType: "aircraft", bodyStyle: "transport", engineType: "jet"}};
    const state = {mach: 2.5, sources: {mach: "groundSpeed"}};
    expect(thermalMachWarning(state, recipe)).toMatch(/2.500.*airliner.*Override/);
    expect(state.mach).toBe(2.5);
    expect(thermalMachWarning({...state, mach: .95}, recipe)).toBe("");
    expect(thermalMachWarning({...state, sources: {mach: "override"}}, recipe)).toBe("");
    expect(thermalMachWarning(state, {parameters: {...recipe.parameters, bodyStyle: "jet"}})).toBe("");
});

test("look host passes physical target range each frame without saving it into sensor settings", () => {
    const camera = new PerspectiveCamera(1, 1, 1, 500000);
    camera.position.set(Globals.equatorRadius + 1382, 0, 0);
    const target = new Vector3(Globals.equatorRadius + 1382, 125000, 0);
    camera.lookAt(target); camera.updateMatrixWorld(true);
    NodeMan.get.mockImplementation(id => id === "targetTrackSwitchSmooth" ? {p: () => target} : null);
    NodeMan.iterate.mockImplementation(() => {}); Sit.thermalEnvironment = undefined;
    const view = {camera, cameraNode: {thermalSensor: {turbulenceMode: "manual"}}, renderer: {}, renderMode: "physicalThermal"};
    const adapter = createThermalViewAdapter(view);
    const render = jest.spyOn(adapter.pipeline, "render").mockImplementation(() => {});
    try {
        adapter.render(new Scene(), 1);
        expect(render.mock.calls[0][0].psfRangeM).toBe(125000);
        target.y = 130000; adapter.render(new Scene(), 2);
        expect(render.mock.calls[1][0].psfRangeM).toBe(130000);
        expect(view.cameraNode.thermalSensor.psfRangeM).toBeUndefined();
    } finally {adapter.dispose();}
});
