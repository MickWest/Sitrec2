import {parseSoundingCSV, parseIGRASounding, atmosphereFromSounding} from "../tools/thermal/sounding.js";
import {blackbodyBands, clearSky, createAtmosphere, evaluatePhotonPath, seaBackground, solvePath} from "../tools/thermal/atmosphere.js";
import {apparentTemperature, inBandRadiance, PHOTON_SCALE} from "../tools/thermal/radiometry.js";
import {defaultSettings, normalizeSettings, settingsForPreset, THERMAL_PARAMETERS} from "../tools/thermal/thermalSchema.js";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {opticalConvergenceCase, sampledConvergenceSources, relativeRadianceError} from "../tools/thermal/selfTest.js";
import {scatterPlan, sum} from "../tools/thermal/sensorMath.js";

// Published radiosonde archive observations, Santo Domingo, 2014-11-11 12 UTC.
// Station elevation 77 m: radiosonde archive station inventory. Values below are the
// decoded record; blank fields are absent reports, not zero-valued observations.
const SOUNDING_CSV = `level_type,pressure_Pa,geopotential_height_m,temperature_C,relative_humidity_pct,dewpoint_depression_C,wind_dir_deg,wind_speed_m_s
21,100800,,10.8,,2.1,190,2.1
10,100000,145,9.4,,1.1,215,1.0
20,97700,,8.4,,0.5,,
20,95700,,,,,160,5.7
20,93600,,16.6,,12.0,,
20,93100,,,,,165,10.8
10,92500,798,16.6,,15.0,170,10.8
20,92400,,16.6,,15.0,,
10,85000,1510,10.2,,7.0,180,7.2
20,84000,,9.4,,7.0,,
20,82800,,10.0,,21.0,,
20,81000,,10.8,,36.0,,
20,80500,,,,,180,5.1
20,75000,,7.8,,37.0,,
10,70000,3110,2.8,,32.0,260,4.1
20,63600,,,,,275,2.6
20,61000,,,,,280,5.1
20,60200,,-6.7,,33.0,,
20,58700,,,,,265,8.7
20,57900,,-9.1,,9.0,,
20,54400,,,,,280,10.3
20,54300,,-13.5,,3.9,,
20,54100,,-13.7,,4.3,,
20,54000,,-13.7,,8.0,,
20,53900,,-13.7,,10.0,,
20,53000,,-13.3,,23.0,,
20,51400,,,,,245,12.3
10,50000,5730,-16.5,,26.0,250,12.9
20,48700,,,,,265,13.9
20,47300,,-18.3,,41.0,,
10,40000,7370,-27.7,,36.0,260,19.5
20,39700,,-27.9,,35.0,,
20,37000,,-31.3,,12.0,,
20,35500,,-32.9,,17.0,,
20,32200,,-39.3,,4.6,,
20,31600,,,,,270,31.4
20,31300,,-41.1,,4.6,,
20,31100,,-41.1,,9.0,,
20,30600,,,,,275,30.9
10,30000,9380,-42.9,,8.0,280,32.9
20,27800,,-46.9,,3.9,,
20,27100,,-48.3,,4.6,,
20,26900,,-48.5,,6.0,,
20,26300,,-49.1,,16.0,,
10,25000,10580,-51.1,,17.0,275,43.2
20,24000,,,,,275,47.3
20,22400,,,,,280,44.2
22,22100,,-55.1,,17.0,280,45.8
20,21300,,,,,280,53.0
10,20000,12020,-55.1,,21.0,275,52.5
20,18800,,-56.9,,21.0,,
20,16700,,-53.1,,30.0,,
20,15200,,,,,275,36.5
10,15000,13850,-56.3,,31.0,270,36.5
22,14200,,-58.9,,29.0,270,41.2
20,13900,,,,,265,43.2
20,12900,,-55.3,,31.0,,
20,12700,,,,,275,23.1
20,11800,,,,,285,27.8
20,11100,,,,,275,31.4
20,10800,,-61.7,,28.0,,
10,10000,16400,-61.3,,28.0,285,20.6
10,7000,18570,-69.9,,24.0,300,14.9
10,5000,20620,-62.5,,29.0,205,2.6`;
const metadata = {stationId: "CIM00085586", stationElevationM: 77};
const sounding = () => parseSoundingCSV(SOUNDING_CSV, metadata);
const band = {minUm: 3, maxUm: 5};
const close = (actual, expected, tolerance) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
const cpuPipeline = () => {
    const pipeline = new ThermalPipeline(null);
    pipeline.resources = {surfaces: new Map()};
    return pipeline;
};

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

test("CSV parser retains blanks, wind-only rows, inversions and level types", () => {
    const data = sounding();
    expect(data.levels).toHaveLength(64);
    expect(data.levels[0]).toMatchObject({levelType: "21", pressurePa: 100800, geopotentialHeightM: null,
        temperatureK: 283.95, dewpointDepressionK: 2.1, relativeHumidityPct: null});
    expect(data.levels[3]).toMatchObject({temperatureK: null, dewpointDepressionK: null, windDirectionDeg: 160, windSpeedMS: 5.7});
    expect(data.levels[5].temperatureK).toBeNull();
    expect(data.levels[6].temperatureK).toBeGreaterThan(data.levels[1].temperatureK);
    expect(data.levels.filter(row => row.levelType === "22")).toHaveLength(2);
    expect(parseSoundingCSV(SOUNDING_CSV.replace(/\n/g, "\r\n"), metadata)).toEqual(data);
    expect(() => parseSoundingCSV("pressure_Pa,temperature_C\n100000,20")).toThrow(/columns/);
});

// Calculated fixed-width encoding of the same public CSV record. Column widths
// and tenths scaling follow the radiosonde archive's published format
// description, independently of the parser.
function igraRecord(csv = SOUNDING_CSV) {
    const rows = csv.split("\n").slice(1);
    const field = (value, width, scale = 1) => String(value === "" ? -9999 : Math.round(Number(value) * scale)).padStart(width);
    const lines = rows.map(line => {
        const [type, p, z, t, rh, dpd, direction, speed] = line.split(",");
        return type + " " + "-9999" + " " + field(p, 6) + "B" + field(z, 5) + "B" + field(t, 5, 10) + "B" +
            field(rh, 5, 10) + " " + field(dpd, 5, 10) + " " + field(direction, 5) + " " + field(speed, 5, 10);
    });
    return "#CIM00085586 2014 11 11 12 1200 " + String(lines.length).padStart(4) + "\n" + lines.join("\n");
}

test("IGRA period-of-record parser decodes the same levels and preserves quality flags", () => {
    const data = parseIGRASounding(igraRecord(), {stationElevationM: 77});
    expect(data).toMatchObject({stationId: metadata.stationId, year: 2014, month: 11, day: 11, hour: 12});
    const csv = sounding();
    data.levels.forEach((row, index) => {
        for (const [key, value] of Object.entries(csv.levels[index])) {
            if (typeof value === "number") close(row[key], value, 1e-12);
            else expect(row[key]).toBe(value);
        }
        expect(row.flags).toEqual({pressure: "B", height: "B", temperature: "B"});
    });
    expect(atmosphereFromSounding(data).contentKey).toBe(atmosphereFromSounding(csv).contentKey);
    // Literal record exercises tenths RH, rejected T, and a non-pressure level.
    const missing = parseIGRASounding("#CIM00085586 2014 11 11 12 9999    1\n30 -9999  -9999 -9999 -8888   500 -9999   180    25");
    expect(missing.levels[0]).toMatchObject({levelType: "30", pressurePa: null, temperatureK: null,
        relativeHumidityPct: 50, dewpointDepressionK: null, windSpeedMS: 2.5});
    expect(() => parseIGRASounding(igraRecord() + "\n" + igraRecord())).toThrow(/exactly one/);
    expect(() => parseIGRASounding(igraRecord().split("\n").slice(0, -1).join("\n"))).toThrow(/level count/);
});

test("hypsometry, humidity interpolation and estimated upper continuation are explicit", () => {
    const result = atmosphereFromSounding(sounding());
    expect(result.assumptions.every(item => item.status === "estimated" && item.reason.length > 20)).toBe(true);
    close(result.levels[0].geopotentialHeightM, 77, 0);
    const a = result.levels[1], b = result.levels[2];
    close(b.geopotentialHeightM, a.geopotentialHeightM + 287.05 * (a.temperatureK + b.temperatureK) / (2 * 9.80665) * Math.log(a.pressurePa / b.pressurePa), 1e-12);
    const mid = result.atmosphere.sample((a.geopotentialHeightM + b.geopotentialHeightM) / 2);
    close(mid.pressurePa, Math.sqrt(a.pressurePa * b.pressurePa), 1e-8);
    close(mid.temperatureK, (a.temperatureK + b.temperatureK) / 2, 1e-12);
    close(result.atmosphere.sample(0).pressurePa, 100800, 0);
    const top = result.levels.at(-1), standard = createAtmosphere();
    const above = result.atmosphere.sample(top.geopotentialHeightM + 1000);
    close(above.temperatureK, standard.sample(top.geopotentialHeightM + 1000).temperatureK + top.temperatureK - standard.sample(top.geopotentialHeightM).temperatureK, 1e-12);
    close(above.pressurePa, standard.sample(top.geopotentialHeightM + 1000).pressurePa * top.pressurePa / standard.sample(top.geopotentialHeightM).pressurePa, 1e-12);
    expect(above.waterVaporDensityKgM3).toBe(0);
    const rhCSV = SOUNDING_CSV.split("\n")[0] + "\n10,100000,0,20,50,,,\n10,80000,2000,10,,,,";
    const rh = atmosphereFromSounding(parseSoundingCSV(rhCSV));
    const rho = 0.5 * 611.2 * Math.exp(17.67 * 20 / (20 + 243.5)) / (461.5 * 293.15);
    close(rh.atmosphere.sample(0).waterVaporDensityKgM3, rho, 1e-14);
    close(rh.atmosphere.sample(1000).waterVaporDensityKgM3, rho / Math.E, 1e-14);
    expect(() => atmosphereFromSounding(parseSoundingCSV(SOUNDING_CSV))).toThrow(/stationElevationM/);
    expect(atmosphereFromSounding(sounding()).contentKey).toBe(result.contentKey);
    expect(atmosphereFromSounding(sounding(), {visibilityM: 10000}).contentKey).not.toBe(result.contentKey);
});

test("Santo Domingo sounding reproduces the 125 km 750 K path and clear sky", () => {
    // Calculated spherical geometry for sensor 1382 m, target 7480 m, range 124979 m.
    // Estimated regression tolerance 1%; these model outputs are not measured transfer.
    const atmosphere = atmosphereFromSounding(sounding()).atmosphere;
    const geometry = {sensorAltitudeM: 1382, targetAltitudeM: 7480, slantRangeM: 124979};
    const path = evaluatePhotonPath(geometry, atmosphere, {segments: 96, band});
    const source = blackbodyBands(750, {quantity: "photon", band});
    const transmission = sum(source.map((value, i) => value * path.transmission[i])) / sum(source);
    const sky = clearSky({sensorAltitudeM: 1382, elevationRad: solvePath(geometry).elevationRad}, atmosphere,
        {segments: 96, quantity: "photon", band});
    const temperature = apparentTemperature(sum(sky.radiance), {band});
    close(transmission, 0.180, 0.180 * 0.01);
    close(temperature, 279.6, 279.6 * 0.01);
    const pipeline = cpuPipeline();
    pipeline._prepareAtmosphere(normalizeSettings({sensorAltitudeM: 1382, atmosphereMaxRangeM: 124979,
        pathElevationDeg: solvePath(geometry).elevationRad * 180 / Math.PI}), sounding());
    const lastRow = (pipeline.rangeLUT.size - 1) * source.length;
    const tableTransmission = sum(source.map((value, i) => value * pipeline.rangeLUT.transmission[lastRow + i])) / sum(source);
    close(tableTransmission, 0.180, 0.180 * 0.01);
    close(pipeline.background.brightnessTemperatureK, 279.6, 279.6 * 0.01);
    console.log(`Sounding: 750 K transmission ${transmission.toFixed(6)}; sky ${temperature.toFixed(4)} K`);
});

test.each([false, true])("pipeline sky equals CPU clearSky, measured=%s; cache uses content", measured => {
    const pipeline = cpuPipeline(), profile = measured ? sounding() : null;
    const settings = normalizeSettings({sensorAltitudeM: 1382, pathElevationDeg: 2.23, atmosphereMaxRangeM: 125000});
    pipeline._prepareAtmosphere(settings, profile);
    const atmosphere = measured ? atmosphereFromSounding(profile).atmosphere : createAtmosphere();
    const sky = clearSky({sensorAltitudeM: 1382, elevationRad: 2.23 * Math.PI / 180}, atmosphere,
        {segments: 96, quantity: "photon", band});
    close(pipeline.background.photonRadiance, sum(sky.radiance), sum(sky.radiance) * 1e-12);
    expect(pipeline.atmosphereProfile.source).toBe(measured ? "sounding" : "standard");
    const table = pipeline.rangeLUT, background = pipeline.background;
    pipeline._prepareAtmosphere({...settings, ambientTemperatureK: 250}, measured ? sounding() : null);
    expect(pipeline.rangeLUT).toBe(table); expect(pipeline.background).toBe(background);
    if (measured) {
        pipeline._prepareAtmosphere({...settings, surfaceTemperatureK: 310, waterVaporDensityKgM3: 0}, sounding());
        expect(pipeline.rangeLUT).toBe(table);
        expect(pipeline.background).toBe(background);
        close(pipeline.background.photonRadiance, background.photonRadiance, 0);
        const changed = parseSoundingCSV(SOUNDING_CSV.replace("10,85000,1510,10.2", "10,85000,1510,11.2"), metadata);
        pipeline._prepareAtmosphere(settings, changed);
        expect(pipeline.rangeLUT).not.toBe(table);
        expect(pipeline.background.photonRadiance).not.toBe(background.photonRadiance);
    }
    pipeline._prepareAtmosphere({...settings, visibilityM: 10000}, profile);
    expect(pipeline.rangeLUT).not.toBe(table);
    expect(pipeline.background.photonRadiance).not.toBe(background.photonRadiance);
    pipeline._prepareAtmosphere({...settings, skySource: "manual", skyTemperatureK: 240}, profile);
    close(pipeline.background.scaledPhotonRadiance, inBandRadiance(240).photon / PHOTON_SCALE, 1e-14);
    pipeline._prepareAtmosphere({...settings, bandMinUm: 3.7}, profile);
    const narrowSky = clearSky({sensorAltitudeM: 1382, elevationRad: 2.23 * Math.PI / 180}, atmosphere,
        {segments: 96, quantity: "photon", band: {minUm: 3.7, maxUm: 5}});
    close(pipeline.background.photonRadiance, sum(narrowSky.radiance), sum(narrowSky.radiance) * 1e-12);
});

test("surface center ray uses selected-band photon sea radiance and bounds the range table", () => {
    const pipeline = cpuPipeline();
    const settings = normalizeSettings({sensorAltitudeM: 1382, pathElevationDeg: -30, bandMinUm: 3.7, surfaceTemperatureK: 294});
    pipeline._prepareAtmosphere(settings, sounding());
    const geometry = {sensorAltitudeM: 1382, elevationRad: -Math.PI / 6};
    const atmosphere = atmosphereFromSounding(sounding()).atmosphere;
    const sea = seaBackground({...geometry, temperatureK: 294}, atmosphere,
        {quantity: "photon", band: {minUm: 3.7, maxUm: 5}, segments: 96});
    expect(pipeline.background).toMatchObject({kind: "sea", status: "estimated"});
    close(pipeline.background.photonRadiance, sum(sea.radiance), sum(sea.radiance) * 1e-12);
    close(pipeline.rangeLUT.maxRangeM, clearSky(geometry, atmosphere).distanceM, 1e-9);
    // Independent vacuum emission check catches energy/photon or full-band mixing.
    const vacuum = createAtmosphere({densityScale: 0});
    const direct = seaBackground(geometry, vacuum, {quantity: "photon", band: {minUm: 3.7, maxUm: 5}});
    close(sum(direct.radiance) / ((1 - direct.meanReflectance) * inBandRadiance(290, {minUm: 3.7, maxUm: 5}).photon), 1, 1e-12);
    pipeline._prepareAtmosphere({...settings, sensorAltitudeM: 0, atmosphereEnabled: false});
    expect(pipeline.rangeLUT.maxRangeM).toBe(0);
    expect(pipeline.background.photonRadiance).toBeGreaterThan(0);
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
