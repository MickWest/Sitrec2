import {atmosphereFromSounding} from "../tools/thermal/sounding.js";
import {nearestThermalSounding, thermalSoundingFromSonde} from "../src/rendering/ThermalSceneAdapters";

jest.mock("../src/Globals", () => ({Globals: {equatorRadius: 6378137, polarRadius: 6356752.3}, Sit: {},
    NodeMan: {get: () => undefined, iterate() {}}}));
jest.mock("../src/par", () => ({par: {frame: 0}}));
jest.mock("../src/i18n", () => ({t: key => key}));

// Estimated synthetic warm humid profile in the sonde import's units (hPa, m, degrees C, %, m/s); not an observation.
const row = (pressure, height, temp, dewpoint, rh = null) =>
    ({time_s: null, pressure, height, temp, rh, dewpoint, windDir: 90, windSpeed: 5, lat: null, lon: null});
const sonde = (iso, levels) => ({station: {id: "00000", lat: 18, lon: -66, elev: 3, name: "test"},
    datetime: new Date(iso), source: "uwyo-list", hasGPS: false, levels});
const PROFILE = [row(1012, 3, 26, 21, 74), row(1000, 110, 25, 20), row(950, 560, 22.4, 18.6),
    row(925, 790, 20.6, 17.8), row(850, 1520, 16.2, 12.4), row(700, 3160, 9.4, -2.6), row(500, 5880, -6.1, -24.1)];

test("A sonde import converts to a thermal sounding in SI units", () => {
    const sounding = thermalSoundingFromSonde(sonde("2013-04-26T00:00:00Z", PROFILE));
    expect(sounding.levels.map(level => level.levelType)).toEqual(["21", "10", "20", "10", "10", "10", "10"]);
    const surface = sounding.levels[0];
    expect(surface.pressurePa).toBe(101200);
    expect(surface.temperatureK).toBeCloseTo(299.15, 10);
    expect(surface.dewpointDepressionK).toBeCloseTo(5, 10);
    expect(surface.windSpeedMS).toBe(5);
    expect(sounding.stationId).toBe("00000");
    expect(sounding.time).toBe("2013-04-26T00:00:00.000Z");
    // The thermal atmosphere starts from the measured surface state: 26 C with a 21 C dew point at 3 m.
    const {atmosphere} = atmosphereFromSounding(sounding);
    expect(atmosphere.sample(3).temperatureK).toBeCloseTo(299.15, 6);
    // Calculated: saturation 2486 Pa at 21 C, rho_v = e / (R_v T) = 0.0180 kg/m3.
    expect(atmosphere.sample(3).waterVaporDensityKgM3).toBeCloseTo(0.0180, 3);
});

test("A conversion is cached, and a profile without temperatures gives no sounding", () => {
    const parsed = sonde("2013-04-26T00:00:00Z", PROFILE);
    expect(thermalSoundingFromSonde(parsed)).toBe(thermalSoundingFromSonde(parsed));
    const windOnly = sonde("2013-04-26T00:00:00Z", PROFILE.map(level => ({...level, temp: null, dewpoint: null})));
    expect(thermalSoundingFromSonde(windOnly)).toBeNull();
    expect(thermalSoundingFromSonde(null)).toBeNull();
});

test("Rounding above saturation is clamped; an invalid dew point falls back to relative humidity", () => {
    const levels = PROFILE.map(level => ({...level}));
    levels[3].dewpoint = levels[3].temp + 0.3;
    levels[4].dewpoint = levels[4].temp + 8;
    const sounding = thermalSoundingFromSonde(sonde("2013-04-26T00:00:00Z", levels));
    expect(sounding.levels[3].dewpointDepressionK).toBe(0);
    expect(sounding.levels[4].dewpointDepressionK).toBeNull();
    expect(() => atmosphereFromSounding(sounding)).not.toThrow();
});

test("Rows without pressure are kept as non-pressure levels and ignored by the atmosphere", () => {
    const sounding = thermalSoundingFromSonde(sonde("2013-04-26T00:00:00Z", [row(null, 2, 27, 21), ...PROFILE]));
    expect(sounding.levels[0].levelType).toBe("30");
    expect(sounding.levels[1].levelType).toBe("21");
    expect(atmosphereFromSounding(sounding).atmosphere.sample(3).temperatureK).toBeCloseTo(299.15, 6);
});

test("The launch nearest the scene time is selected", () => {
    const early = sonde("2013-04-25T12:00:00Z", PROFILE.map(level => ({...level, temp: level.temp - 1})));
    const late = sonde("2013-04-26T00:00:00Z", PROFILE);
    const scene = Date.parse("2013-04-26T01:20:00Z");
    expect(nearestThermalSounding([early, late], scene).time).toBe("2013-04-26T00:00:00.000Z");
    expect(nearestThermalSounding([early, late], Date.parse("2013-04-25T13:00:00Z")).time).toBe("2013-04-25T12:00:00.000Z");
    expect(nearestThermalSounding([], scene)).toBeNull();
});
