// Measured soundings: the CSV parser, the hypsometric profile and its assumptions, layer breakpoints, and
// the Santo Domingo regression.
import {parseSoundingCSV, atmosphereFromSounding} from "../tools/thermal/sounding.js";
import {SOUNDING_CSV} from "../tools/thermal/validationFixtures.js";
import {blackbodyBands, clearSky, createAtmosphere, evaluatePhotonPath, solvePath} from "../tools/thermal/atmosphere.js";
import {apparentTemperature} from "../tools/thermal/radiometry.js";
import {normalizeSettings} from "../tools/thermal/thermalSchema.js";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {sum} from "../tools/thermal/sensorMath.js";

const metadata = {stationId: "CIM00085586", stationElevationM: 77};
const sounding = () => parseSoundingCSV(SOUNDING_CSV, metadata);
const band = {minUm: 3, maxUm: 5};
const close = (actual, expected, tolerance) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
const cpuPipeline = () => {
    const pipeline = new ThermalPipeline(null, {analysis: true});
    pipeline.resources = {surfaces: new Map()};
    return pipeline;
};

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

test("sounding layer breakpoints reach the ray quadrature", () => {
    const sounding = parseSoundingCSV(`level_type,pressure_Pa,geopotential_height_m,temperature_C,relative_humidity_pct,dewpoint_depression_C,wind_dir_deg,wind_speed_m_s\n10,100000,0,15,50,,,\n10,90000,1234,7,40,,,\n10,70000,3456,-5,20,,,`);
    const {atmosphere} = atmosphereFromSounding(sounding);
    expect(atmosphere.layerAltitudesM).toEqual(expect.arrayContaining([1234, 3456]));
});
