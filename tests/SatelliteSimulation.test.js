/** @jest-environment jsdom */
import {SatelliteSimulation, SATELLITE_ORBIT_WINDOW_MS} from "../src/SatelliteSimulation";
import {starlinkPopulation} from "../src/StarlinkPopulation";
import {CTLEData} from "../src/TLEUtils";
import {CSatellite} from "../src/nodes/CSatellite";
import {generateConstellationTLE} from "../tools/shf/syntheticOrbits.js";
import {STARLINK_SHELLS} from "../tools/shf/starlinkShells.js";
import {gmstRad} from "../tools/shf/astro.js";
import {propagate} from "satellite.js";

const date = new Date("2026-09-30T12:00:00Z");
const makeData = (epoch = date) => new CTLEData(generateConstellationTLE(epoch, STARLINK_SHELLS, gmstRad, {total: 3}));

test("population follows historical samples, starts at launch, and caps future estimates", () => {
    expect(starlinkPopulation(new Date("2019-05-23T23:59:00Z"))).toBe(0);
    expect(starlinkPopulation(new Date("2019-05-24T00:00:00Z"))).toBe(60);
    expect(starlinkPopulation(new Date("2020-01-01Z"))).toBe(114);
    expect(starlinkPopulation(new Date("2024-01-01Z"))).toBe(5201);
    const between = starlinkPopulation(new Date("2024-01-15Z"));
    expect(between).toBeGreaterThan(5201);
    expect(between).toBeLessThan(5346);
    expect(starlinkPopulation(date)).toBe(STARLINK_SHELLS.total);
    expect(starlinkPopulation(new Date("2040-01-01Z"))).toBe(STARLINK_SHELLS.total);
});

test("usable loaded orbits take precedence, including the window boundary", () => {
    const selector = new SatelliteSimulation(), real = makeData();
    expect(selector.select(real, date, true)).toBe(real);
    expect(selector.hasUsableOrbits(real, new Date(+date + SATELLITE_ORBIT_WINDOW_MS))).toBe(true);
    expect(selector.hasUsableOrbits(real, new Date(+date + SATELLITE_ORBIT_WINDOW_MS + 1))).toBe(false);
    expect(selector.select(real, new Date("2020-01-01Z"), false)).toBe(real);
    expect(selector.select(undefined, date, false)).toBeUndefined();
});

test("separate epoch clusters do not falsely cover a gap, and a merge invalidates coverage", () => {
    const selector = new SatelliteSimulation(), real = makeData(new Date("2020-01-01Z"));
    real.mergeFrom(makeData(new Date("2020-06-01Z")));
    expect(selector.hasUsableOrbits(real, new Date("2020-03-01Z"))).toBe(false);
    real.mergeFrom(makeData(new Date("2020-03-01Z")));
    selector.invalidateCatalog();
    expect(selector.hasUsableOrbits(real, new Date("2020-03-01Z"))).toBe(true);
    real.satData.forEach(sat => {sat.launchDate = +new Date("2027-01-01Z");});
    selector.invalidateCatalog();
    expect(selector.hasUsableOrbits(real, date)).toBe(false);
});

test("fallback is deterministic, date-scaled, propagates and leaves loaded data untouched", () => {
    const selector = new SatelliteSimulation(), real = makeData();
    const text = real.rawText, historical = new Date("2020-01-01T04:00:00Z");
    const simulated = selector.select(real, historical, true);
    expect(simulated.simulated).toBe(true);
    expect(simulated.satData).toHaveLength(starlinkPopulation(historical));
    expect(simulated.satData.every(sat => sat.simulated && sat.name.startsWith("SIMULATED STARLINK"))).toBe(true);
    expect(propagate(simulated.satData[0].satrecs[0], historical).position.x).toEqual(expect.any(Number));
    expect(selector.select(undefined, new Date("2020-01-01T23:00:00Z"), true)).toBe(simulated);
    expect(new SatelliteSimulation().select(undefined, historical, true).rawText).toBe(simulated.rawText);
    expect(selector.select(real, date, true)).toBe(real);
    expect(real.rawText).toBe(text);
    expect(real.simulated).toBeUndefined();
    expect(selector.select(undefined, new Date("2018-01-01Z"), true).satData).toHaveLength(0);
});

test("simulated Starlink respects categories and search without reusing indexed real-data filters", () => {
    const sats = new CSatellite();
    sats.TLEData = makeData();
    sats._renderTLEData = sats.simulation.select(undefined, new Date("2020-01-01Z"), true);
    sats.tleFilterResults = [false, false, false];
    sats.filterSatellites();
    expect(sats.renderTLEData.satData.every(sat => sat.visible)).toBe(true);
    expect(sats.TLEData.satData.every(sat => !sat.visible)).toBe(true);
    sats.nameFilter = "SIMULATED STARLINK 10";
    sats.filterSatellites();
    expect(sats.renderTLEData.satData.some(sat => sat.visible)).toBe(true);
    expect(sats.renderTLEData.satData.some(sat => !sat.visible)).toBe(true);
    sats.showStarlink = false;
    sats.showOtherSatellites = true;
    sats.filterSatellites();
    expect(sats.renderTLEData.satData.every(sat => !sat.visible)).toBe(true);
    sats.showStarlink = true; sats.showSatellites = false;
    sats.filterSatellites();
    expect(sats.renderTLEData.satData.every(sat => !sat.visible)).toBe(true);
});
