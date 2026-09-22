import fs from "fs";
import os from "os";
import path from "path";
import {writeInterchange, buildAllCsv, buildScenarioJson} from "../../benchmarks/botbench/lib/exportInterchange";
import {ingestBotCSV, botBenchPairingKeys} from "../../src/analysis/BotBenchIngest";
import {MOTION_V1_SETS} from "../../benchmarks/botbench/lib/motionV1";
import {MOTION_FULL_V1_PLATFORMS} from "../../benchmarks/botbench/lib/motionFullV1Platforms";
import {generateScenario} from "../../benchmarks/botbench/lib/generateScenario";
import {ROCK_V3, ROCK_V3_ERROR_LEVELS} from "../../benchmarks/botbench/lib/rockV3";
import {MOTION_FULL_V1_VERSION, MOTION_FULL_V1_DURATIONS, MOTION_FULL_V1_ERRORS,
    motionFullV1Spec, motionFullV1Basename, generateMotionFullV1Scenario} from "../../benchmarks/botbench/lib/motionFullV1";

const cases = Object.entries(MOTION_V1_SETS).flatMap(([set, variants]) =>
    variants.map(v => [set.replace("_v1", "_full_v1"), v]));
const point = (array, frame) => Array.from(array.slice(frame * 3, frame * 3 + 3));

test("full sets share rock_v3 duration and operator-error coverage", () => {
    expect(MOTION_FULL_V1_DURATIONS).toEqual(ROCK_V3.durations);
    expect(MOTION_FULL_V1_ERRORS).toBe(ROCK_V3_ERROR_LEVELS);
    expect(20 * 10 * MOTION_FULL_V1_DURATIONS.length * MOTION_FULL_V1_ERRORS.length).toBe(12600);
    expect(8 * 10 * MOTION_FULL_V1_DURATIONS.length * MOTION_FULL_V1_ERRORS.length).toBe(5040);
});

test.each(cases)("%s/%s: nested crops, physical envelopes and matched sample rates", (set, variant) => {
    const error = MOTION_FULL_V1_ERRORS[0], platform = MOTION_FULL_V1_PLATFORMS[0];
    const master = generateMotionFullV1Scenario(set, variant, platform, 300, error, 10);
    for (const duration of MOTION_FULL_V1_DURATIONS) {
        const at10 = generateMotionFullV1Scenario(set, variant, platform, duration, error, 10);
        const at1 = generateMotionFullV1Scenario(set, variant, platform, duration, error, 1);
        const offset = (300 - duration) / 2;
        expect(at1.target.profile.metrics).toEqual(at10.target.profile.metrics);
        expect(at1.scenarioGroupId).toBe(master.scenarioGroupId);
        expect(at10.events.length).toBeGreaterThan(0);
        expect(at10.events.some(e => e.startSeconds <= duration / 2 && e.endSeconds >= duration / 2)).toBe(true);
        for (let second = 0; second <= duration; second++) {
            expect(point(at1.target.positionENU, second)).toEqual(point(master.target.positionENU, (offset + second) * 10));
            expect(point(at10.target.positionENU, second * 10)).toEqual(point(at1.target.positionENU, second));
            expect(point(at1.platform.positionENU, second)).toEqual(point(master.platform.positionENU, (offset + second) * 10));
            expect(at1.platform.positionENU[second * 3 + 2]).toBe(7000);
        }
        expect(at10.spec.epochISO).toBe(new Date(Date.parse(master.spec.epochISO) + offset * 1000).toISOString());
    }
}, 60000);

test.each(MOTION_FULL_V1_PLATFORMS)("platform $id retains all required turns at every duration/rate", platform => {
    const v = MOTION_V1_SETS.Anomalies_v1[0];
    const master = generateMotionFullV1Scenario("Anomalies_full_v1", v, platform, 300, MOTION_FULL_V1_ERRORS[0], 10);
    for (const duration of MOTION_FULL_V1_DURATIONS) for (const fps of [1, 10]) {
        const s = generateMotionFullV1Scenario("Anomalies_full_v1", v, platform, duration, MOTION_FULL_V1_ERRORS[0], fps);
        const offset = (300 - duration) / 2;
        for (let f = 0; f < s.n; f++) {
            expect(point(s.platform.positionENU, f)).toEqual(point(master.platform.positionENU, offset * 10 + f * 10 / fps));
        }
        const p = s.platform.profile;
        if (platform.category === "curved") {
            expect(p.turnCount).toBeGreaterThan(0);
            expect(p.maxTurnRateDegS).toBeLessThan(3);
            expect(new Set(p.segments.filter(s => s.kind === "turn").map(s => Math.sign(s.turnRateDegS))).size).toBe(1);
        }
    }
});

test.each(MOTION_FULL_V1_ERRORS)("$label errors are shared crops at 1 and 10 Hz", error => {
    const set = "Anomalies_full_v1", v = MOTION_V1_SETS.Anomalies_v1[0], p = MOTION_FULL_V1_PLATFORMS[6];
    const master = generateMotionFullV1Scenario(set, v, p, 300, error, 10);
    for (const duration of MOTION_FULL_V1_DURATIONS) for (const fps of [1, 10]) {
        const s = generateMotionFullV1Scenario(set, v, p, duration, error, fps);
        for (let f = 0; f < s.n; f++) {
            expect(point(s.observation.observedDirectionENU, f)).toEqual(
                point(master.observation.observedDirectionENU, (300 - duration) * 5 + f * 10 / fps));
        }
    }
});

test("generic names are unique, stable and reveal neither target nor platform maneuver", () => {
    for (const [set, prefix] of [["Extreme_full_v1", "extreme"], ["Anomalies_full_v1", "anomaly"]]) {
        const variants = MOTION_V1_SETS[set.replace("_full", "")];
        const names = variants.flatMap(v => MOTION_FULL_V1_PLATFORMS.map(p => motionFullV1Basename(set, v, p, true)));
        expect(new Set(names).size).toBe(variants.length * 10);
        expect(names[0]).toBe(`${prefix}001`);
        expect(names.at(-1)).toBe(`${prefix}${String(variants.length * 10).padStart(3, "0")}`);
    }
});

test("replaying a standalone stored specification reproduces generated truth and bearings", () => {
    const s = generateMotionFullV1Scenario("Extreme_full_v1", MOTION_V1_SETS.Extreme_v1[9],
        MOTION_FULL_V1_PLATFORMS[7], 40, MOTION_FULL_V1_ERRORS[5], 1);
    const replay = generateScenario(JSON.parse(JSON.stringify(s.spec)), {scenarioSeed: 901, generatorVersion: MOTION_FULL_V1_VERSION});
    expect(replay.target.positionENU).toEqual(s.target.positionENU);
    expect(replay.observation.observedDirectionENU).toEqual(s.observation.observedDirectionENU);
});

test("transmedium crops preserve surface crossings and underwater masking at both rates", () => {
    const v = MOTION_V1_SETS.Anomalies_v1.find(v => v.kind === "transmedium");
    for (const fps of [1, 10]) for (const duration of MOTION_FULL_V1_DURATIONS) {
        const s = generateMotionFullV1Scenario("Anomalies_full_v1", v, MOTION_FULL_V1_PLATFORMS[0], duration, MOTION_FULL_V1_ERRORS[8], fps);
        for (let f = 0; f < s.n; f++) expect(s.observation.measurementAvailable[f]).toBe(s.target.positionENU[f * 3 + 2] < 0 ? 0 : 1);
        expect(s.events.map(e => e.kind)).toEqual(["water-entry", "submerged-transit", "water-exit"]);
        const imported = ingestBotCSV(buildAllCsv(s, "water", "botbench"), {sidecar: buildScenarioJson(s, "water")});
        expect(imported.dataset.n).toBeGreaterThanOrEqual(10);
    }
});


test("plain numbered CSVs pair with sidecars and import at both sample rates", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "motion-full-names-"));
    try {
        for (const fps of [1, 10]) {
            const s = generateMotionFullV1Scenario("Extreme_full_v1", MOTION_V1_SETS.Extreme_v1[0],
                MOTION_FULL_V1_PLATFORMS[0], 20, MOTION_FULL_V1_ERRORS[0], fps);
            const out = writeInterchange(s, path.join(temp, String(fps)),
                {basename: "extreme001", sidecarDir: "meta", plainCsvNames: true});
            for (const key of ["inputFile", "truthFile", "allFile"]) expect(path.basename(out[key])).toBe("extreme001.csv");
            const record = ingestBotCSV(fs.readFileSync(out.allFile, "utf8"), {
                sidecar: JSON.parse(fs.readFileSync(out.scenarioFile)), labels: JSON.parse(fs.readFileSync(out.truthJsonFile))});
            expect(record.dataset.n).toBe(20 * fps + 1);
            expect(record.dataset.fps).toBeCloseTo(fps, 7);
            expect(botBenchPairingKeys("batch/All/extreme001.csv").altKey)
                .toBe(botBenchPairingKeys("batch/meta/extreme001.scenario.json").indexKey);
        }
    } finally { fs.rmSync(temp, {recursive: true, force: true}); }
});
