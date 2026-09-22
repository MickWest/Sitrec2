import fs from "fs";
import os from "os";
import path from "path";
import {ingestBotCSV} from "../../src/analysis/BotBenchIngest";
import {MOTION_V1_SETS} from "../../benchmarks/botbench/lib/motionV1";
import {MOTION_FULL_V1_PLATFORMS} from "../../benchmarks/botbench/lib/motionFullV1Platforms";
import {generateMotionFullV1Sets, refreshMotionFullV1Readmes, motionSingleV1Name,
    motionFullV1Readme} from "../../benchmarks/botbench/lib/motionFullV1";

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "motion-single-v1-")); });
afterEach(() => { fs.rmSync(root, {recursive: true, force: true}); });

test.each([
    [{durationSeconds: 19}, /duration/],
    [{durationSeconds: 301}, /duration/],
    [{durationSeconds: 120.5}, /duration/],
    [{durationSeconds: NaN}, /duration/],
    [{errorDeg: -0.01}, /error/],
    [{errorDeg: 2.01}, /error/],
    [{errorDeg: NaN}, /error/],
    [{rates: [2]}, /rate/],
    [{rates: [1, 10]}, /one sample rate/],
    [{single: false, durationSeconds: 120}, /require a single-set/],
    [{single: false, errorDeg: 0.01}, /require a single-set/],
])("invalid selection %j fails before creating output", (options, message) => {
    expect(() => generateMotionFullV1Sets({outRoot: root, set: "Extreme_full_v1", single: true, ...options}))
        .toThrow(message);
    expect(fs.readdirSync(root)).toEqual([]);
});

test("a custom single selection exports every target/platform and refreshes its own documentation", () => {
    const options = {outRoot: root, set: "Anomalies_full_v1", single: true,
        durationSeconds: 91, errorDeg: 0.03, rates: [1], genericNames: true};
    const [result] = generateMotionFullV1Sets(options);
    expect(result.set).toBe("Anomalies_single_v1_91s_0.03deg_1Hz");
    expect(result.scenarios).toBe(80);
    const manifestFile = path.join(result.dir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    expect(manifest).toMatchObject({selection: "single", fps: 1, durations: [91], pointingErrorDeg: [0.03],
        masterDurationSeconds: 300, platformAltitudeAGL: 7000, genericNames: true, scenarioCount: 80});
    expect(new Set(manifest.tracks.map(r => r.kind))).toEqual(new Set(MOTION_V1_SETS.Anomalies_v1.map(v => v.kind)));
    for (const kind of MOTION_V1_SETS.Anomalies_v1.map(v => v.kind)) {
        expect(new Set(manifest.tracks.filter(r => r.kind === kind).map(r => r.platformVariant)))
            .toEqual(new Set(MOTION_FULL_V1_PLATFORMS.map(p => p.id)));
    }
    for (const row of manifest.tracks) {
        expect(row).toMatchObject({fps: 1, durationSeconds: 91, frames: 92, pointingErrorDeg: 0.03});
        expect(row.files.allFile).toBe(`batch_91sec/0.03deg/All/${row.basename}.csv`);
        const csv = fs.readFileSync(path.join(result.dir, row.files.allFile), "utf8");
        const sidecar = JSON.parse(fs.readFileSync(path.join(result.dir, row.files.scenarioFile), "utf8"));
        const labels = JSON.parse(fs.readFileSync(path.join(result.dir, row.files.truthJsonFile), "utf8"));
        const record = ingestBotCSV(csv, {sidecar, labels});
        if (row.kind !== "transmedium") expect(record.dataset.n).toBe(92);
        expect(record.dataset.fps).toBeCloseTo(1, 7);
        expect(row.crop.clipStartSeconds).toBe(104.5);
    }
    expect(() => generateMotionFullV1Sets(options)).toThrow(/output already exists/);
    const readme = fs.readFileSync(path.join(result.dir, "README.md"), "utf8");
    expect(readme).toContain("build-anomalies-single-v1 -- --duration 91 --error 0.03 --fps 1 --generic-names");
    const [refreshed] = refreshMotionFullV1Readmes({...options, genericNames: false});
    expect(refreshed.set).toBe(result.set);
    expect(fs.readFileSync(path.join(result.dir, "README.md"), "utf8")).toBe(readme);
    expect(fs.readFileSync(manifestFile, "utf8")).toBe(JSON.stringify(manifest, null, 2) + "\n");
}, 60000);

test("default single sets include all variants at 120 seconds, 0.01 degrees and 10 Hz", () => {
    const [result] = generateMotionFullV1Sets({outRoot: root, set: "Anomalies_full_v1", single: true});
    expect(result.set).toBe("Anomalies_single_v1_120s_0.01deg_10Hz");
    expect(result.scenarios).toBe(80);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({fps: 10, durations: [120], pointingErrorDeg: [0.01], genericNames: false});
    expect(manifest.tracks.every(r => r.frames === 1201)).toBe(true);
    expect(motionSingleV1Name("Extreme_full_v1", 10)).toBe("Extreme_single_v1_120s_0.01deg_10Hz");
}, 60000);

test("single README pins its exact selection to a published generator revision", () => {
    const readme = motionFullV1Readme("Extreme_full_v1", 10, 200, true,
        {revision: "published-revision", localChanges: false, published: true}, {durationSeconds: 120, errorDeg: 0.01});
    expect(readme).toContain("git checkout --detach published-revision");
    expect(readme).toContain("build-extreme-single-v1 -- --duration 120 --error 0.01 --fps 10 --generic-names");
    expect(readme).toContain("20 target variants × 10 platform programs × 1 duration × 1 pointing-error level");
    expect(readme).toContain("All curved segments are slower than the standard rate");
    expect(readme).toContain("matching settings and filename style produce identical CSVs");
});
