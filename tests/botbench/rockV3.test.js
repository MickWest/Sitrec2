/**
 * rockV3.test.js — the rock_v3 dataset definition (benchmarks/botbench/lib/rockV3.js)
 * and the generator pieces it uses: the "centered-turn" platform kind, the
 * "racetrack" kind the first version flew, and the fixed-wing drone patterns.
 *
 * Pins the properties the set is built on: a track's target depends on its name
 * alone and is the target of the first version; its sensor path, turn level
 * included, depends on its number alone; 25 tracks of every class fly each of the
 * four turn levels, with start headings spread evenly and turn directions
 * balanced; a track turns by exactly its level, as the same shape at every clip
 * length; the target flights are deterministic, so a shorter clip's truth is the
 * first part of a longer one; and one operator wobble per rung is shared by every
 * clip length.
 */

import {setSit} from "../../src/Globals";
import {generateScenario} from "../../benchmarks/botbench/lib/generateScenario";
import {
    generatePlatformPath, racetrackSchedule, racetrackState, racetrackTurnFraction,
    centeredTurnSchedule, centeredTurnState,
} from "../../benchmarks/botbench/lib/platforms";
import {generateDroneTruth, dronePatternGeometry} from "../../benchmarks/botbench/lib/rockTargets";
import {
    ROCK_V3, ROCK_V3_ERROR_LEVELS, rockBasename, rockDraws, rockPlatform, rockSpec, rockTrackTable,
    rockDefinitionHash,
} from "../../benchmarks/botbench/lib/rockV3";
import {measuredHeadingChange} from "../../benchmarks/botbench/lib/rockV3Batch";
import {windConfigFor, makeWind} from "../../benchmarks/botbench/lib/wind";

beforeAll(() => {
    setSit({name: "rock-v3-test", frames: 10000, fps: 10, simSpeed: 1, lat: 40, lon: -105});
});

const CLEAN = ROCK_V3_ERROR_LEVELS.find((e) => e.label === "0.0deg");
const times = (n, fps) => Float64Array.from({length: n}, (_, f) => f / fps);
const TRACK_NUMBERS = Array.from({length: 100}, (_, i) => i + 1);

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

describe("centered-turn platform", () => {
    const R = 9000;
    const spec = {kind: "centered-turn", speedMS: 110, altitudeAGL: 5000, headingDeg: 30, turnDeg: 20, turnDir: 1,
        turnStartFraction: 0.25, turnEndFraction: 0.75};
    const fly = (s, seconds) => {
        const n = seconds * 10 + 1;
        return {n, path: generatePlatformPath(s, n, times(n, 10), 10, R)};
    };

    test("straight, one turn through exactly the level, straight", () => {
        const {n, path} = fly(spec, 120);
        const m = measuredHeadingChange(path.positionENU, n);
        expect(m.totalDeg).toBeCloseTo(20, 6);
        expect(m.netDeg).toBeCloseTo(20, 6);
        // the chord heading moves across the middle half, plus a half step at each end
        expect(m.changedChords).toBe((n - 1) / 2 + 1);
        const left = fly({...spec, turnDir: -1}, 120).path.positionENU;
        expect(measuredHeadingChange(left, n).netDeg).toBeCloseTo(-20, 6);
        expect(centeredTurnState(spec, 120, 10).segment).toBe("before");
        expect(centeredTurnState(spec, 120, 60).segment).toBe("turn");
        expect(centeredTurnState(spec, 120, 100).headingRad).toBeCloseTo(50 * Math.PI / 180, 12);
    });

    test("starts at [0, -R], level, constant speed, and feasible at the tightest turn in the set", () => {
        // 20 degrees in the middle 10 s of a 20 s clip at the top speed
        const fast = {...spec, speedMS: 120};
        const {n, path} = fly(fast, 20);
        const p = path.positionENU;
        expect(path.feasibility.valid).toBe(true);
        expect(p[0]).toBe(0);
        expect(p[1]).toBe(-R);
        for (let f = 0; f < n; f++) expect(p[f * 3 + 2]).toBe(5000);
        for (let f = 1; f < n; f++) {
            const chord = Math.hypot(p[f * 3] - p[(f - 1) * 3], p[f * 3 + 1] - p[(f - 1) * 3 + 1]);
            expect(Math.abs(chord - 12)).toBeLessThan(1e-3);
        }
        expect(centeredTurnSchedule(fast, 20).bankRad * 180 / Math.PI).toBeCloseTo(23.1, 1);
    });

    test("a longer clip flies the same shape, enlarged", () => {
        const short = fly(spec, 20).path.positionENU;
        const long = fly(spec, 300).path.positionENU;
        for (let f = 0; f <= 200; f++) {
            expect(long[f * 15 * 3]).toBeCloseTo(15 * short[f * 3], 6);
            expect(long[f * 15 * 3 + 1] + R).toBeCloseTo(15 * (short[f * 3 + 1] + R), 6);
        }
        expect(measuredHeadingChange(long, 3001).totalDeg).toBeCloseTo(20, 6);
    });

    test("no turn is a straight line, and a left turn mirrors a right turn", () => {
        const flat = fly({...spec, turnDeg: 0}, 60);
        expect(measuredHeadingChange(flat.path.positionENU, flat.n).totalDeg).toBeLessThan(1e-6);
        expect(measuredHeadingChange(flat.path.positionENU, flat.n).changedChords).toBe(0);
        const north = {...spec, headingDeg: 0};
        const right = fly(north, 60).path.positionENU;
        const left = fly({...north, turnDir: -1}, 60).path.positionENU;
        for (let f = 0; f < flat.n; f++) {
            expect(left[f * 3]).toBeCloseTo(-right[f * 3], 6);
            expect(left[f * 3 + 1]).toBeCloseTo(right[f * 3 + 1], 6);
        }
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

    test("the targets are those of the first version of the set", () => {
        // Values from that version's master manifest (definition b9c49c0c). Its
        // holding-pattern draws are still taken, so every later draw lands where it did.
        const balloon = rockDraws("balloon", 17);
        expect(balloon.rangeM).toBe(23755);
        expect(balloon.target.parameters).toEqual({startAGL: 1267, ascentRate: 3.47});
        expect(balloon.wind).toEqual({kind: "custom", u: 0.224, v: 14.288, variabilityPct: 0});
        const drone = rockDraws("drone", 5);
        expect(drone.rangeM).toBe(1354);
        expect(drone.target.kind).toBe("drone-circle");
        expect(drone.target.parameters).toMatchObject({speedMS: 26.3, radiusM: 206, headingDeg: 50.9,
            phaseFraction: 0.5749, turnDir: -1});
        const weather = rockDraws("weather_balloon", 100);
        expect(weather.rangeM).toBe(39447);
        expect(weather.target.parameters).toEqual({startAGL: 11541, ascentRate: 5.57});
        expect(weather.wind).toMatchObject({shearPerM: 0.0001926, veerDeg: 27.1});
    });

    test("one sensor path per track number, turn level included, shared by the three classes", () => {
        for (const index of [1, 17, 100]) {
            const paths = ROCK_V3.classes.map((c) => rockDraws(c.key, index).platform);
            expect(paths[1]).toEqual(paths[0]);
            expect(paths[2]).toEqual(paths[0]);
            expect(paths[0].kind).toBe("centered-turn");
        }
        expect(rockPlatform(3).platform).not.toEqual(rockPlatform(4).platform);
    });

    test("four turn levels, flown by 25 tracks of every class each", () => {
        expect(ROCK_V3.platform.turnLevelsDeg).toEqual([0, 5, 10, 20]);
        for (const cls of ROCK_V3.classes) {
            const levels = TRACK_NUMBERS.map((i) => rockDraws(cls.key, i).platform.turnDeg);
            for (const turnDeg of ROCK_V3.platform.turnLevelsDeg) {
                expect([cls.key, turnDeg, levels.filter((t) => t === turnDeg).length]).toEqual([cls.key, turnDeg, 25]);
            }
        }
    });

    test("in each turn level the start headings cover the circle evenly and the turn directions alternate", () => {
        const platforms = TRACK_NUMBERS.map((i) => rockPlatform(i).platform);
        expect(platforms.filter((p) => p.turnDir === 1)).toHaveLength(50);
        for (const turnDeg of ROCK_V3.platform.turnLevelsDeg) {
            const level = platforms.filter((p) => p.turnDeg === turnDeg).sort((a, b) => a.headingDeg - b.headingDeg);
            // one start heading in every 14.4 degree span of the circle
            expect(new Set(level.map((p) => Math.floor(p.headingDeg / 14.4))).size).toBe(25);
            // neighbouring headings turn opposite ways
            for (let k = 1; k < level.length; k++) expect(level[k].turnDir).toBe(-level[k - 1].turnDir);
        }
    });

    test("draws stay inside their declared ranges", () => {
        for (const cls of ROCK_V3.classes) {
            for (const i of TRACK_NUMBERS) {
                const d = rockDraws(cls.key, i);
                expect(d.platform.altitudeAGL).toBeGreaterThanOrEqual(15000 * 0.3048 - 1);
                expect(d.platform.altitudeAGL).toBeLessThanOrEqual(20000 * 0.3048 + 1);
                expect(d.platform.speedMS).toBeGreaterThanOrEqual(95);
                expect(d.platform.speedMS).toBeLessThanOrEqual(120);
                expect(d.platform.headingDeg).toBeGreaterThanOrEqual(0);
                expect(d.platform.headingDeg).toBeLessThan(360);
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
        // the tightest turn in the set, 20 degrees in 10 s, stays well inside the generator's bank limit
        for (const i of TRACK_NUMBERS) {
            const s = centeredTurnSchedule({...rockPlatform(i).platform, turnDeg: 20}, 20);
            expect(s.bankRad * 180 / Math.PI).toBeLessThan(23.2);
        }
    });

    test("a spec differs across lengths and rungs only in the duration and the observation", () => {
        for (const cls of ROCK_V3.classes) {
            const a = rockSpec(cls.key, 17, 20, CLEAN).spec;
            const b = rockSpec(cls.key, 17, 300, ROCK_V3_ERROR_LEVELS[5]).spec;
            const strip = (s) => ({...s, durationSeconds: null, observation: null});
            expect(strip(a)).toEqual(strip(b));
        }
    });

    test.each(ROCK_V3.classes.map((c) => c.key))("%s: generates clean, turns by its level, and its target truth nests while the sensor path scales", (clsKey) => {
        const index = TRACK_NUMBERS.find((i) => rockPlatform(i).platform.turnDeg === 10);
        const make = (seconds, platformChange = {}) => {
            const {spec} = rockSpec(clsKey, index, seconds, CLEAN);
            return generateScenario({...spec, platform: {...spec.platform, ...platformChange}}, {scenarioSeed: ROCK_V3.seed});
        };
        const s20 = make(20), s60 = make(60), straight20 = make(20, {turnDeg: 0});
        expect(s20.events).toHaveLength(0);
        expect(s20.observation.outOfFrameCount).toBe(0);
        expect(s20.platform.feasibility.valid).toBe(true);
        expect(Math.hypot(s20.target.positionENU[0], s20.target.positionENU[1])).toBeLessThan(1e-6);
        expect(s20.platform.positionENU[1]).toBeCloseTo(-s20.spec.initialHorizontalRangeM, 6);
        expect(measuredHeadingChange(s20.platform.positionENU, s20.n).totalDeg).toBeCloseTo(10, 6);
        expect(measuredHeadingChange(s60.platform.positionENU, s60.n).totalDeg).toBeCloseTo(10, 6);
        // the target does not depend on the sensor path ...
        expect(Array.from(straight20.target.positionENU)).toEqual(Array.from(s20.target.positionENU));
        // ... and a shorter clip's target truth is the first part of a longer one
        const n = s20.n;
        expect(Array.from(s60.target.positionENU.subarray(0, n * 3))).toEqual(Array.from(s20.target.positionENU));
        // a turning sensor path does not nest: the longer clip flies the same shape, larger
        expect(Array.from(s60.platform.positionENU.subarray(0, n * 3))).not.toEqual(Array.from(s20.platform.positionENU));
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
        const make = (index, seconds, level) => generateScenario(rockSpec("drone", index, seconds, level).spec,
            {scenarioSeed: ROCK_V3.seed});
        const s20 = make(3, 20, r5), s60 = make(3, 60, r5);
        const n = s20.n;
        expect(Array.from(s60.observation.tangentErrorDeg.subarray(0, n * 2)))
            .toEqual(Array.from(s20.observation.tangentErrorDeg));
        const otherRung = make(3, 20, r6);
        const otherTrack = make(4, 20, r5);
        expect(otherRung.observation.realizedRmsDegAllFrames).not.toBe(s20.observation.realizedRmsDegAllFrames);
        expect(Array.from(otherTrack.observation.tangentErrorDeg)).not.toEqual(Array.from(s20.observation.tangentErrorDeg));
    });
});
