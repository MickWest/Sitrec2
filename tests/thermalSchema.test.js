import {THERMAL_PARAMETERS, defaultSettings, normalizeSettings, settingsForPreset} from "../tools/thermal/thermalSchema.js";
import {SENSOR_PRESETS, SCATTER_PRESETS} from "../tools/thermal/sensorPresets.js";
import {scatterPlan} from "../tools/thermal/sensorMath.js";

const close = (actual, expected, tolerance) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);

test("one complete parameter list supplies menus, defaults, ranges and units", () => {
    const keys=new Set();
    for (const parameter of THERMAL_PARAMETERS) {
        for (const key of ["key","group","type","unit","default","min","max","step","label","tooltip"]) expect(parameter).toHaveProperty(key);
        expect(["scene","optics","detector","processing","display"]).toContain(parameter.group);
        expect(keys.has(parameter.key)).toBe(false);keys.add(parameter.key);
        expect(parameter.label.length).toBeGreaterThan(0);expect(parameter.tooltip.length).toBeGreaterThan(10);
        if (parameter.type === "select") expect(parameter.options.some(option=>option.value===parameter.default)).toBe(true);
    }
    expect(defaultSettings().gainMode).toBe("manual");
});
test.each(Object.keys(SENSOR_PRESETS))("preset %s carries status and source for every value", name => {
    const settings=settingsForPreset(name);
    for (const [key, parameter] of Object.entries(SENSOR_PRESETS[name].parameters)) {
        expect(["published","measured","calculated","estimated"]).toContain(parameter.status);
        expect(parameter.source.length).toBeGreaterThan(5);
        expect(THERMAL_PARAMETERS.find(definition=>definition.key===key).presetMetadata[name]).toEqual(parameter);
        expect(settings.presetMetadata[key].overridden).toBe(false);
        if (typeof parameter.value === "number") expect(settings[key]).toBeCloseTo(parameter.value,10);
        else expect(settings[key]).toBe(parameter.value);
    }
});
test("MX-15 native detector, presentation and field match the narrow reference", () => {
    const settings=settingsForPreset("MX15");
    expect([settings.detectorWidth,settings.detectorHeight]).toEqual([640,512]);
    expect([settings.pictureWidth,settings.pictureHeight]).toEqual([1280,1024]);
    expect(settings.verticalFovDeg).toBeCloseTo(2*Math.atan(512*20e-6/(2*0.675))*180/Math.PI,12);expect(settings.focalLengthM).toBeCloseTo(0.675,12);
    expect(settings.pixelPitchM).toBeCloseTo(20e-6,14);
    expect(settings.presetMetadata.apertureM.status).toBe("estimated");
});
test("normalization clamps, fills and keeps independent provenance copies", () => {
    const input={emissivity:7,ambientTemperatureK:-10,detectorWidth:17.9,ignored:true};
    const result=normalizeSettings(input);
    expect(result.emissivity).toBe(1);expect(result.ambientTemperatureK).toBe(150);expect(result.detectorWidth).toBe(18);
    expect(result.ignored).toBeUndefined();expect(input.emissivity).toBe(7);
    result.presetMetadata.apertureM.source="changed";
    expect(defaultSettings().presetMetadata.apertureM.source).not.toBe("changed");
    expect(normalizeSettings({apertureM:0.2}).presetMetadata.apertureM).toMatchObject({overridden:true,status:"estimated"});
});
test("settings round trip and linked optical fields stay consistent", () => {
    const settings=normalizeSettings({sensorPreset:"OMAHA",fieldMode:"focalLength",focalLengthM:0.8});
    expect(normalizeSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
    expect(settings.verticalFovDeg).toBeCloseTo(2*Math.atan(settings.detectorHeight*settings.pixelPitchM/(2*0.8))*180/Math.PI,12);
});
test("non-finite values, wrong types and reversed intervals are rejected", () => {
    for (const parameter of THERMAL_PARAMETERS.filter(value=>value.type==="number"))
        for (const value of [NaN,Infinity,-Infinity,"1"]) expect(()=>normalizeSettings({[parameter.key]:value})).toThrow();
    for (const input of [{gainMode:"unknown"},{sensorPreset:"unknown"},{noiseEnabled:1},{supersample:3},
        {bandMinUm:4.8,bandMaxUm:3.2},{lowPercentile:0.8,highPercentile:0.2},{radiometricLow:10,radiometricHigh:1}])
        expect(()=>normalizeSettings(input)).toThrow();
});

test("linked optics stay inside both parameter ranges even at extreme detector sizes", () => {
    for (const input of [{detectorHeight:1,pixelPitchM:1e-6,verticalFovDeg:60,apertureM:.001},
        {detectorHeight:2048,pixelPitchM:100e-6,fieldMode:"focalLength",focalLengthM:0.005}]) {
        const settings=normalizeSettings(input);
        for (const key of ["focalLengthM","verticalFovDeg"]) {
            const definition=THERMAL_PARAMETERS.find(parameter=>parameter.key===key);
            expect(settings[key]).toBeGreaterThanOrEqual(definition.min-1e-12);
            expect(settings[key]).toBeLessThanOrEqual(definition.max+1e-12);
        }
    }
    expect(()=>normalizeSettings({emissivity:null})).toThrow();
});

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
    }
});

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

test("sea and cloud settings persist their sources; the generic Designer remains smooth", () => {
    const settings = defaultSettings(); expect(settings.seaMode).toBe("smooth");
    for (const p of THERMAL_PARAMETERS.filter(p => p.key.startsWith("sea") || p.key.startsWith("cloud"))) {
        expect(p.owner).toBe("environment"); expect(p.source).toBeTruthy(); expect(p.status).toBe("estimated");
        expect(settings.presetMetadata[p.key].source).toBe(p.source);
    }
    expect(normalizeSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
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

// Published focal steps: manufacturer operations manual.
// Calculated windows from the 2014-11-11 IB6830 active inset and 2× pixel footprints.
test.each(["27", "135", "675", "1012"])("MX15 optical step %s keeps native sampling and selects the window and pupil", focalStep => {
    const settings = normalizeSettings({...settingsForPreset("MX15"), focalStep});
    close(settings.focalLengthM, Number(focalStep) / 1000, 1e-10);
    close(settings.focalLengthM / settings.apertureM, .675 / .150, 1e-10);
    expect([settings.detectorWidth, settings.detectorHeight]).toEqual([640, 512]);
    const size = focalStep === "1012" ? [480, 384] : [640, 512];
    expect(settings.detectorWindow).toEqual({width: size[0], height: size[1]});
    expect([settings.pictureWidth, settings.pictureHeight]).toEqual(size.map(n => 2 * n));
    close(settings.verticalFovDeg, 2 * Math.atan(512 * 20e-6 / (2 * settings.focalLengthM)) * 180 / Math.PI, 1e-10);
    if (focalStep === "27") expect(() => normalizeSettings({...settings, pupilPolicy: "keepPupil"})).toThrow(/Pupil aperture/);
    else {
        const kept = normalizeSettings({...settings, pupilPolicy: "keepPupil"});
        close(kept.apertureM, .150, 1e-10);
        expect(normalizeSettings(JSON.parse(JSON.stringify(kept)))).toEqual(kept);
    }
    const editedReference = normalizeSettings({...settings, pupilReferenceM: .135});
    close(editedReference.apertureM, .135 * settings.focalLengthM / .675, 1e-10);
    expect(normalizeSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
});

test("free optics, old explicit fields and optical edits remain usable", () => {
    for (const sensorPreset of ["ATFLIR", "OMAHA"]) {
        const s = normalizeSettings({sensorPreset, fieldMode: "focalLength", focalLengthM: .8, focalStep: "1012"});
        expect(s.focalStep).toBe("free"); close(s.focalLengthM, .8, 1e-10);
        expect(normalizeSettings({...s, fieldMode: "fieldOfView", verticalFovDeg: 2}).verticalFovDeg).toBe(2);
    }
    expect(normalizeSettings({fieldMode: "focalLength", focalLengthM: 1.0125}).focalStep).toBe("free");
    const s = settingsForPreset("MX15");
    const edit = normalizeSettings({...s, focalLengthM: .8});
    expect(edit.focalStep).toBe("free"); close(edit.focalLengthM, .8, 1e-10);
    expect(normalizeSettings({...s, apertureM: .135}).focalStep).toBe("free");
    expect(() => normalizeSettings({focalStep: "999"})).toThrow();
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

test("pupil throughput rejects numerical aperture above one", () => {
    expect(() => normalizeSettings({detectorWidth: 32, detectorHeight: 24, fieldMode: "focalLength",
        apertureM: 2, focalLengthM: .675})).toThrow(/aperture|pupil/i);
});

test("Nyquist uses the shortest wavelength, linked optics and fitting allocation", () => {
    const mx = settingsForPreset("MX15"), at = settingsForPreset("ATFLIR");
    expect(mx.opticalSampling).toMatchObject({mode: "nyquist", factor: 4, nyquistMet: true, allocationFits: true});
    // Calculated Nyquist interval: 3 um × f/4.5 / 2 = 6.75 um.
    close(mx.opticalSampling.requiredFactor, 20 / 6.75, 1e-12);
    expect(at.opticalSampling).toMatchObject({factor: 4, nyquistMet: true});
    close(at.opticalSampling.requiredFactor, 2 * at.pixelPitchM * at.apertureM / (3.7e-6 * at.focalLengthM), 1e-12);
    const coarseOptics = normalizeSettings({...mx, apertureM: 0.05});
    expect(coarseOptics.supersample).toBe(2);
    const limited = normalizeSettings({...mx, apertureM: 1});
    expect(limited.opticalSampling).toMatchObject({factor: 4, nyquistMet: false, allocationFits: true});
    expect(limited.opticalSampling.requiredFactor).toBeGreaterThan(8);
    expect(() => scatterPlan({...limited, supersample: 8})).toThrow(/4096/);
    const allocationLimited = normalizeSettings({...mx, apertureM: 0.3});
    expect(allocationLimited.opticalSampling.requiredFactor).toBeLessThan(8);
    expect(allocationLimited.opticalSampling).toMatchObject({factor: 4, nyquistMet: false});
    const small = normalizeSettings({...allocationLimited, detectorWidth: 32, detectorHeight: 32, fieldMode: "focalLength"});
    expect(small.opticalSampling).toMatchObject({factor: 8, nyquistMet: true});
    const tooLarge = normalizeSettings({detectorWidth: 2048, detectorHeight: 2048});
    expect(tooLarge.opticalSampling).toMatchObject({factor: 2, nyquistMet: false, allocationFits: false});
    expect(() => scatterPlan(tooLarge)).toThrow(/4096/);
    expect(THERMAL_PARAMETERS.some(parameter => parameter.key === "opticalSampling")).toBe(false);
    expect(Object.isFrozen(mx.opticalSampling)).toBe(true);
});

test("factor edits select manual, modes round trip, and legacy saves select Nyquist", () => {
    const base = defaultSettings();
    const manual = normalizeSettings({...base, supersample: 2});
    expect(manual.opticalSampling).toMatchObject({mode: "manual", factor: 2, nyquistMet: false});
    expect(normalizeSettings({...manual, apertureM: 0.5}).supersample).toBe(2);
    expect(normalizeSettings(JSON.parse(JSON.stringify(manual)))).toEqual(manual);
    const automatic = normalizeSettings({...manual, opticalSamplingMode: "nyquist"});
    expect(automatic.opticalSampling).toMatchObject({mode: "nyquist", factor: 4});
    expect(normalizeSettings(JSON.parse(JSON.stringify(automatic)))).toEqual(automatic);
    const {opticalSamplingMode, opticalSampling, ...legacy} = base;
    expect(normalizeSettings({...legacy, supersample: 2}).supersample).toBe(4);
    expect(normalizeSettings({supersample: 8}).supersample).toBe(4);
    expect(normalizeSettings({opticalSamplingMode: "manual", supersample: 8}).supersample).toBe(8);
});
