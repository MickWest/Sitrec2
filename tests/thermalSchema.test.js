import {THERMAL_PARAMETERS, defaultSettings, normalizeSettings, settingsForPreset} from "../tools/thermal/thermalSchema.js";
import {SENSOR_PRESETS} from "../tools/thermal/sensorPresets.js";

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
