/**
 * rockV3.test.js — the rock_v3 dataset definition (benchmarks/botbench/lib/rockV3.js)
 * and the two generator pieces it added: the "racetrack" platform kind and the
 * fixed-wing drone patterns.
 *
 * Pins the properties the set is built on: a track's random draws depend on
 * its name alone (so every batch and rung is the same flight), the flights are
 * deterministic and a shorter clip is the first part of a longer one, the
 * drone loops close and run at constant speed, and the holding pattern is
 * feasible at the bank cap.
 */

import {setSit} from "../../src/Globals";
import {generateScenario} from "../../benchmarks/botbench/lib/generateScenario";
import {generatePlatformPath, racetrackSchedule, racetrackState, racetrackTurnFraction}
    from "../../benchmarks/botbench/lib/platforms";
import {generateDroneTruth, dronePatternGeometry} from "../../benchmarks/botbench/lib/rockTargets";
import {ROCK_V3, ROCK_V3_ERROR_LEVELS, rockBasename, rockDraws, rockSpec, rockTrackTable, rockDefinitionHash}
    from "../../benchmarks/botbench/lib/rockV3";
import {windConfigFor, makeWind} from "../../benchmarks/botbench/lib/wind";

beforeAll(() => {
    setSit({name: "rock-v3-test", frames: 10000, fps: 10, simSpeed: 1, lat: 40, lon: -105});
});

const CLEAN = ROCK_V3_ERROR_LEVELS.find((e) => e.label === "0.0deg");
const times = (n, fps) => Float64Array.from({length: n}, (_, f) => f / fps);

describe("racetrack platform", () => {
    const spec = {kind: "racetrack", speedMS: 100, altitudeAGL: 5000, bankDeg: 25,
        legSeconds: 90, headingDeg: 45, turnDir: 1, phaseSeconds: 100};

    test("schedule: two legs and two 180 degree turns at the coordinated rate", () => {
        const s = racetrackSchedule(spec);
        expect(s.turnSeconds).toBeCloseTo(Math.PI / ((9.80665 / 100) * Math.tan(25 * Math.PI / 180)), 6);
        expect(s.period).toBeCloseTo(2 * 90 + 2 * s.turnSeconds, 9);
        expect(racetrackState(spec, 10).segment).toBe("leg1");
        expect(racetrackState(spec, 100).segment).toBe("turn1");
        expect(racetrackState(spec, 100).bankRad).toBeGreaterThan(0);
        expect(racetrackState(spec, 90 + s.turnSeconds + 10).segment).toBe("leg2");
        expect(racetrackState(spec, s.period + 10).segment).toBe("leg1");
    });

    test("path is feasible, deterministic, level, and starts at [0, -R]", () => {
        const n = 3001, fps = 10, R = 12000;
        const a = generatePlatformPath(spec, n, times(n, fps), fps, R);
        const b = generatePlatformPath(spec, n, times(n, fps), fps, R);
        expect(a.feasibility.valid).toBe(true);
        expect(Array.from(a.positionENU)).toEqual(Array.from(b.positionENU));
        expect(a.positionENU[0]).toBeCloseTo(0, 9);
        expect(a.positionENU[1]).toBeCloseTo(-R, 9);
        for (let f = 0; f < n; f++) expect(a.positionENU[f * 3 + 2]).toBe(5000);
        // speed is constant along the integrated path
        const d = (f) => Math.hypot(a.positionENU[f * 3] - a.positionENU[(f - 1) * 3],
            a.positionENU[f * 3 + 1] - a.positionENU[(f - 1) * 3 + 1]);
        expect(d(1)).toBeCloseTo(10, 3);
        expect(d(2000)).toBeCloseTo(10, 3);
    });

    test("turn fraction reads the window the clip covers", () => {
        expect(racetrackTurnFraction({...spec, phaseSeconds: 0}, 20)).toBe(0);          // all leg
        expect(racetrackTurnFraction({...spec, phaseSeconds: 95}, 20)).toBe(1);         // all turn
        const both = racetrackTurnFraction({...spec, phaseSeconds: 80}, 40);
        expect(both).toBeGreaterThan(0);
        expect(both).toBeLessThan(1);
        expect(racetrackTurnFraction(spec, 300)).toBeGreaterThan(0.3);                  // most of a pattern
    });
});

describe("drone patterns", () => {
    const base = {speedMS: 20, altitudeAGL: 300, radiusM: 120, legM: 600, headingDeg: 30,
        phaseFraction: 0.37, turnDir: 1};

    test.each(["drone-racetrack", "drone-circle", "drone-square"])("%s closes, is level, constant speed, starts at the origin", (kind) => {
        const geom = dronePatternGeometry(kind, base);
        const fps = 10;
        const n = Math.round(geom.periodSeconds * fps) + 1;
        const {target} = generateDroneTruth({kind, family: "drone", parameters: base}, {n, fps});
        const p = target.positionENU;
        expect(p[0]).toBeCloseTo(0, 9);
        expect(p[1]).toBeCloseTo(0, 9);
        expect(p[2]).toBe(300);
        // one full period later the drone is back where it started
        const last = (n - 1) * 3;
        const drift = Math.hypot(p[last] - p[0], p[last + 1] - p[1]);
        expect(drift).toBeLessThan(20 * (n - 1) / fps - geom.perimeter + 1e-6 + 0.05);
        expect(Math.abs((n - 1) / fps - geom.periodSeconds)).toBeLessThan(0.1);
        // constant ground speed: chord per frame within 0.1 percent of 2 m
        for (let f = 1; f < n; f++) {
            const d = Math.hypot(p[f * 3] - p[(f - 1) * 3], p[f * 3 + 1] - p[(f - 1) * 3 + 1]);
            expect(Math.abs(d - 2)).toBeLessThan(0.002);
        }
        expect(geom.bankDeg).toBeCloseTo(Math.atan(400 / (9.80665 * 120)) * 180 / Math.PI, 6);
    });

    test("a left-hand loop is the mirror of the right-hand loop", () => {
        const n = 201, fps = 10;
        const r = generateDroneTruth({kind: "drone-circle", family: "drone", parameters: {...base, headingDeg: 0, phaseFraction: 0}}, {n, fps}).target.positionENU;
        const l = generateDroneTruth({kind: "drone-circle", family: "drone", parameters: {...base, headingDeg: 0, phaseFraction: 0, turnDir: -1}}, {n, fps}).target.positionENU;
        for (let f = 0; f < n; f++) {
            expect(l[f * 3]).toBeCloseTo(-r[f * 3], 9);
            expect(l[f * 3 + 1]).toBeCloseTo(r[f * 3 + 1], 9);
        }
    });
});

describe("custom wind specs", () => {
    test("a spec with its own numbers resolves and samples", () => {
        const w = makeWind({kind: "custom", u: 3, v: -4, variabilityPct: 0}, 500);
        expect(w.kind).toBe("custom");
        expect(w.meanAt(500)).toEqual({u: 3, v: -4});
        expect(windConfigFor({kind: "custom", u: 3, v: -4})).toEqual({variabilityPct: 0, u: 3, v: -4});
        expect(windConfigFor("fixed")).toEqual({u: 6, v: -2, variabilityPct: 0});
        expect(() => windConfigFor({kind: "nonsense"})).toThrow(/unknown wind kind/);
    });
});

describe("rock_v3 definition", () => {
    test("the definition hash is stable and eight hex digits", () => {
        expect(rockDefinitionHash()).toMatch(/^[0-9a-f]{8}$/);
        expect(rockDefinitionHash()).toBe(rockDefinitionHash());
    });

    test("300 distinct names, three classes of 100", () => {
        const table = rockTrackTable();
        expect(table).toHaveLength(300);
        expect(new Set(table.map((r) => r.basename)).size).toBe(300);
        expect(table.filter((r) => r.class === "balloon")).toHaveLength(100);
        expect(table[0].basename).toBe("balloon_001");
        expect(rockBasename(ROCK_V3.classes[2], 100)).toBe("weather_balloon_100");
    });

    test("draws depend on the name alone: same spec at every length and rung", () => {
        for (const cls of ROCK_V3.classes) {
            const a = rockSpec(cls.key, 17, 20, CLEAN).spec;
            const b = rockSpec(cls.key, 17, 300, ROCK_V3_ERROR_LEVELS[5]).spec;
            const strip = (s) => ({...s, durationSeconds: null, observation: null});
            expect(strip(a)).toEqual(strip(b));
            expect(rockDraws(cls.key, 17)).toEqual(rockDraws(cls.key, 17));
            expect(rockDraws(cls.key, 17).rangeM).not.toBe(rockDraws(cls.key, 18).rangeM);
        }
    });

    test("draws stay inside their declared ranges", () => {
        for (const cls of ROCK_V3.classes) {
            for (let i = 1; i <= 100; i++) {
                const d = rockDraws(cls.key, i);
                expect(d.platform.altitudeAGL).toBeGreaterThanOrEqual(15000 * 0.3048 - 1);
                expect(d.platform.altitudeAGL).toBeLessThanOrEqual(20000 * 0.3048 + 1);
                expect(d.platform.speedMS).toBeGreaterThanOrEqual(95);
                expect(d.platform.speedMS).toBeLessThanOrEqual(120);
                const [lo, hi] = ROCK_V3.rangeM[cls.key];
                expect(d.rangeM).toBeGreaterThanOrEqual(lo);
                expect(d.rangeM).toBeLessThanOrEqual(hi);
                if (cls.key === "balloon") {
                    // a sinking balloon stays above ground for the longest clip
                    expect(d.target.parameters.startAGL + d.target.parameters.ascentRate * 300).toBeGreaterThan(40);
                }
                if (cls.key === "drone") {
                    expect(d.info.bankDeg).toBeLessThanOrEqual(40.01);
                    if (d.info.pattern === "drone-square") expect(d.target.parameters.legM).toBeGreaterThanOrEqual(2 * d.target.parameters.radiusM + 50);
                }
            }
        }
    });

    test.each(ROCK_V3.classes.map((c) => c.key))("%s: one scenario per class generates clean, starts at the origin, and nests 20 s inside 60 s", (clsKey) => {
        const s20 = generateScenario(rockSpec(clsKey, 5, 20, CLEAN).spec, {scenarioSeed: ROCK_V3.seed});
        const s60 = generateScenario(rockSpec(clsKey, 5, 60, CLEAN).spec, {scenarioSeed: ROCK_V3.seed});
        expect(s20.events).toHaveLength(0);
        expect(s20.observation.outOfFrameCount).toBe(0);
        expect(s20.platform.feasibility.valid).toBe(true);
        expect(Math.hypot(s20.target.positionENU[0], s20.target.positionENU[1])).toBeLessThan(1e-6);
        expect(s20.platform.positionENU[1]).toBeCloseTo(-s20.spec.initialHorizontalRangeM, 6);
        // the shorter clip is the first part of the longer one: truth AND sensor
        const n = s20.n;
        expect(Array.from(s60.target.positionENU.subarray(0, n * 3))).toEqual(Array.from(s20.target.positionENU));
        expect(Array.from(s60.platform.positionENU.subarray(0, n * 3))).toEqual(Array.from(s20.platform.positionENU));
        expect(s20.scenarioId).not.toBe(s60.scenarioId);
    });

    test("a wobble rung shares the truth and moves only the observation", () => {
        const clean = generateScenario(rockSpec("balloon", 9, 20, CLEAN).spec, {scenarioSeed: ROCK_V3.seed});
        const wob = generateScenario(rockSpec("balloon", 9, 20, ROCK_V3_ERROR_LEVELS[5]).spec, {scenarioSeed: ROCK_V3.seed});
        expect(Array.from(wob.target.positionENU)).toEqual(Array.from(clean.target.positionENU));
        expect(wob.observation.realizedRmsDegAllFrames).toBeGreaterThan(0.05);
        expect(clean.observation.realizedRmsDegAllFrames).toBe(0);
        expect(wob.observation.outOfFrameCount).toBe(0);
    });

    test("the wobble draw is shared across clip lengths and differs across rungs and tracks", () => {
        const r5 = ROCK_V3_ERROR_LEVELS[5], r6 = ROCK_V3_ERROR_LEVELS[6];
        const s20 = generateScenario(rockSpec("drone", 3, 20, r5).spec, {scenarioSeed: ROCK_V3.seed});
        const s60 = generateScenario(rockSpec("drone", 3, 60, r5).spec, {scenarioSeed: ROCK_V3.seed});
        const n = s20.n;
        expect(Array.from(s60.observation.observedDirectionENU.subarray(0, n * 3)))
            .toEqual(Array.from(s20.observation.observedDirectionENU));
        const other = generateScenario(rockSpec("drone", 3, 20, r6).spec, {scenarioSeed: ROCK_V3.seed});
        const otherTrack = generateScenario(rockSpec("drone", 4, 20, r5).spec, {scenarioSeed: ROCK_V3.seed});
        expect(other.observation.realizedRmsDegAllFrames).not.toBe(s20.observation.realizedRmsDegAllFrames);
        expect(Array.from(otherTrack.observation.observedDirectionENU)).not.toEqual(Array.from(s20.observation.observedDirectionENU));
    });
});
