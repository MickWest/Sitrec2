import fs from "fs";
import os from "os";
import path from "path";
import {setSit} from "../../src/Globals";
import {ROCK_V3, ROCK_V3_ERROR_LEVELS, rockDraws, rockSpec} from "../../benchmarks/botbench/lib/rockV3";
import {generateScenario, SITES} from "../../benchmarks/botbench/lib/generateScenario";
import {generateTargetTruth} from "../../benchmarks/botbench/lib/targets";
import {makeWind} from "../../benchmarks/botbench/lib/wind";
import {buildAllCsv} from "../../benchmarks/botbench/lib/exportInterchange";
import {ingestBotCSV} from "../../src/analysis/BotBenchIngest";
import {MOTION_FULL_V1_PLATFORMS} from "../../benchmarks/botbench/lib/motionFullV1Platforms";
import {MUNDANE_V1_VERSION, mundaneV1Spec, mundaneV1Platform, mundaneV1Basename,
    generateMundaneV1Scenario, generateMundaneV1Sets, refreshMundaneV1Readmes, mundaneV1Readme}
    from "../../benchmarks/botbench/lib/mundaneV1";

const CLEAN = ROCK_V3_ERROR_LEVELS[0];
const point = (a, f) => Array.from(a.slice(f * 3, f * 3 + 3));
beforeAll(() => setSit({name: "mundane-v1-test", frames: 10000, fps: 10, simSpeed: 1, lat: 40, lon: -105}));

test("all 300 definitions and 10 Hz master target paths preserve rock_v3", () => {
    const names = new Set();
    for (const cls of ROCK_V3.classes) {
        const counts = new Map(MOTION_FULL_V1_PLATFORMS.map(p => [p.id, 0]));
        for (let index = 1; index <= 100; index++) {
            const d = rockDraws(cls.key, index), spec = mundaneV1Spec(cls.key, index, 300, CLEAN, 10);
            const {mundaneCoverage, ...parameters} = spec.target.parameters;
            expect({...spec.target, parameters}).toEqual(d.target);
            expect(spec.wind).toEqual(d.wind);
            expect(spec.initialHorizontalRangeM).toBe(d.rangeM);
            expect(spec.platform.altitudeAGL).toBe(7000);
            const platform = mundaneV1Platform(index);
            counts.set(platform.id, counts.get(platform.id) + 1);
            names.add(mundaneV1Basename(cls.key, index, true));
            const site = SITES[spec.siteId], wind = makeWind(spec.wind, parameters.startAGL + site.groundElevationMSL);
            const options = {n: 3001, fps: 10, site, wind, seed: 7, windSeed: 17};
            const original = generateTargetTruth(rockSpec(cls.key, index, 300, CLEAN, 10).spec.target, options);
            const updated = generateTargetTruth(spec.target, {...options, seed: 99, windSeed: 23});
            expect(updated.target.positionENU).toEqual(original.target.positionENU);
        }
        expect([...counts.values()]).toEqual(Array(10).fill(10));
    }
    expect(names.size).toBe(300);
    expect([...names][0]).toBe("mundane001");
    expect([...names].at(-1)).toBe("mundane300");
}, 60000);

test.each(ROCK_V3.classes.map(c => c.key))("%s crops retain physical samples, bearings, timestamps and groups at both rates", cls => {
    const error = ROCK_V3_ERROR_LEVELS.at(-1);
    const master = generateMundaneV1Scenario(cls, 8, 300, error, 10);
    for (const duration of [...ROCK_V3.durations, 91]) for (const fps of [1, 10]) {
        const s = generateMundaneV1Scenario(cls, 8, duration, error, fps);
        const start = (300 - duration) * 5;
        expect(s.scenarioGroupId).toBe(master.scenarioGroupId);
        expect(s.platform.profile.turnCount).toBeGreaterThan(0);
        expect(s.platform.profile.maxTurnRateDegS).toBeLessThan(3);
        for (const [short, long] of [[s.target.positionENU, master.target.positionENU],
            [s.platform.positionENU, master.platform.positionENU],
            [s.observation.observedDirectionENU, master.observation.observedDirectionENU]]) {
            for (let f = 0; f < s.n; f++) expect(point(short, f)).toEqual(point(long, start + f * 10 / fps));
        }
        expect(Date.parse(s.spec.epochISO)).toBe(Date.parse(master.spec.epochISO) + start * 100);
    }
}, 60000);

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "mundane-v1-test-")); });
afterEach(() => { fs.rmSync(root, {recursive: true, force: true}); });

test.each([
    [{durationSeconds: 19}, /duration/], [{durationSeconds: 301}, /duration/],
    [{durationSeconds: 120.5}, /duration/], [{errorDeg: -1}, /error/],
    [{errorDeg: NaN}, /error/], [{rates: [2]}, /rates/],
    [{rates: [1, 10]}, /one sample rate/], [{rates: []}, /rates/],
    [{single: false, durationSeconds: 120}, /require a single-set/],
])("invalid selection %j creates no output", (options, message) => {
    expect(() => generateMundaneV1Sets({outRoot: root, single: true, ...options})).toThrow(message);
    expect(fs.readdirSync(root)).toEqual([]);
});

test("default single selection exports 300 ingestible scenarios and replayable sidecars", () => {
    const options = {outRoot: root, single: true, genericNames: true};
    const [result] = generateMundaneV1Sets(options);
    expect(result.set).toBe("mundane_single_v1_120s_0.01deg_10Hz");
    const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({scenarioCount: 300, fps: 10, durations: [120], pointingErrorDeg: [0.01]});
    for (const cls of ROCK_V3.classes) expect(manifest.tracks.filter(r => r.class === cls.key)).toHaveLength(100);
    for (const row of manifest.tracks) {
        const csv = fs.readFileSync(path.join(result.dir, row.files.allFile), "utf8");
        const sidecar = JSON.parse(fs.readFileSync(path.join(result.dir, row.files.scenarioFile), "utf8"));
        const labels = JSON.parse(fs.readFileSync(path.join(result.dir, row.files.truthJsonFile), "utf8"));
        const record = ingestBotCSV(csv, {sidecar, labels});
        expect(record.dataset.n).toBe(1201);
        const {spec, scenarioSeed, generatorVersion} = labels.provenance;
        const replay = generateScenario(spec, {scenarioSeed, generatorVersion});
        expect(generatorVersion).toBe(MUNDANE_V1_VERSION);
        expect(buildAllCsv(replay, labels.trackId, "botbench")).toBe(csv);
    }
    expect(() => generateMundaneV1Sets(options)).toThrow(/output already exists/);
    const readmePath = path.join(result.dir, "README.md"), before = fs.readFileSync(readmePath, "utf8");
    refreshMundaneV1Readmes({...options, genericNames: false});
    expect(fs.readFileSync(readmePath, "utf8")).toBe(before);
    expect(before).toContain("build-mundane-single-v1 -- --duration 120 --error 0.01 --fps 10 --generic-names");
    const published = mundaneV1Readme(manifest, {revision: "published-revision", localChanges: false, published: true});
    expect(published).toContain("git checkout --detach published-revision");
    expect(published).not.toContain("Publication pending");
}, 120000);
