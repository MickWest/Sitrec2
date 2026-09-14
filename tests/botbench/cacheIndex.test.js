/**
 * cacheIndex.test.js — the rules of the per-unit result cache
 * (src/analysis/BotBenchCacheIndex.js): when a stored unit or row may stand in
 * for a fresh one, how a blob carries its own record, and how a schema-2 blob
 * is split into units.
 */
import {
    CACHE_BLOB_DIR, CACHE_FILENAME, describeDuration, formatBytes, measureCacheOnDisk, recordedFitMs,
    CACHE_SCHEMA, LEGACY_UNITS, adoptRecord, combinedHash, elapsedFromUnits, emptyIndex,
    isLegacyEntry, legacyBlobName, legacyUnitsFromBattery, normalizeIndex, packUnitBlob, readUnitBlob,
    recordRowMemo, recordUnit, rowMemoUsable, sameUnitResult, unitBlobName, unitMetaFromBlob,
    unitRecord, unitRecordFromMeta, unitRecordUsable, unitResultAgrees, valuesAgree,
} from "../../src/analysis/BotBenchCacheIndex";
import {UNIT_VERSIONS} from "../../src/analysis/BotBenchSolvers";

const hashes = {csv: "a".repeat(64), sidecar: "b".repeat(64), truth: "c".repeat(64)};
const hash = combinedHash(hashes);
const options = {anchorM: 37040, solutionFamilies: false, mcOrderSweep: false, solvers: null};

describe("names and schema", () => {
    test("a unit blob is named by all three hashes and the unit; the old blob name is kept to remove it", () => {
        expect(unitBlobName(hash, "aircraft")).toBe(`${"a".repeat(32)}-${"b".repeat(12)}-${"c".repeat(12)}.aircraft.json`);
        expect(legacyBlobName(hash)).toBe(`${"a".repeat(32)}-${"b".repeat(12)}-${"c".repeat(12)}.json`);
    });

    test("schema 2 and 3 indexes are read; anything else starts fresh", () => {
        expect(normalizeIndex({schema: 2, results: {x: {battery: "b.json"}}}).results.x.battery).toBe("b.json");
        expect(normalizeIndex({schema: 3, results: {}}).schema).toBe(CACHE_SCHEMA);
        expect(normalizeIndex({schema: 1, results: {}})).toEqual(emptyIndex());
        expect(normalizeIndex(null)).toEqual(emptyIndex());
        expect(isLegacyEntry({battery: "b.json"})).toBe(true);
        expect(isLegacyEntry({battery: "b.json", units: {}})).toBe(false);
    });
});

describe("a stored unit", () => {
    const record = unitRecord({unitId: "aircraft", blob: "x.aircraft.json", options, appVersion: "v1",
        elapsedMs: 1200, failures: []});

    test("is usable under its own build with the same options and version", () => {
        expect(unitRecordUsable(record, {unitId: "aircraft", options, appVersion: "v1"})).toBe(true);
    });

    test("is not usable under another build unless adopted, another anchor, or another unit version", () => {
        expect(unitRecordUsable(record, {unitId: "aircraft", options, appVersion: "v2"})).toBe(false);
        expect(unitRecordUsable(record, {unitId: "aircraft", options, appVersion: "v2", adoptable: true})).toBe(true);
        expect(unitRecordUsable(record, {unitId: "aircraft", options: {...options, anchorM: 1000}, appVersion: "v1"})).toBe(false);
        expect(unitRecordUsable({...record, version: UNIT_VERSIONS.aircraft + 1}, {unitId: "aircraft", options, appVersion: "v1"})).toBe(false);
        expect(unitRecordUsable(null, {unitId: "aircraft", options, appVersion: "v1"})).toBe(false);
    });

    test("carries its record in the blob, which reads back without decoding the fit", () => {
        const result = {track: new Float64Array([1, 2, 3]), errDeg: NaN, note: "x\"y}"};
        const text = packUnitBlob({unitId: "aircraft", hash, ...record}, result);
        const meta = unitMetaFromBlob(text);
        expect(meta.unitId).toBe("aircraft");
        expect(meta.blob).toBe("x.aircraft.json");
        expect(unitRecordFromMeta(meta)).toEqual(record);
        const back = readUnitBlob(text);
        expect(back.result.track).toBeInstanceOf(Float64Array);
        expect(Array.from(back.result.track)).toEqual([1, 2, 3]);
        expect(Number.isNaN(back.result.errDeg)).toBe(true);
        expect(sameUnitResult(result, text)).toBe(true);
        expect(sameUnitResult({...result, errDeg: 1}, text)).toBe(false);
    });

    test("the sweep's sorted copy is not stored and comes back in score order, in its place", () => {
        const results = [{startDist: 1, speed: 1, score: 3}, {startDist: 1, speed: 2, score: 1}];
        const sweep = {results, sorted: results.slice().sort((a, b) => a.score - b.score), best: results[1]};
        const text = packUnitBlob({unitId: "constAir", hash}, sweep);
        expect(text).toContain("\"sorted\":null");
        const back = readUnitBlob(text).result;
        expect(back.sorted.map((r) => r.score)).toEqual([1, 3]);
        expect(Object.keys(back)).toEqual(Object.keys(sweep));
        expect(sameUnitResult(sweep, text)).toBe(true);
    });

    test("agreement allows floating-point noise and nothing else", () => {
        const track = new Float64Array([5709.398935254078, 2, 3]);
        const result = {track, errDeg: NaN, solved: {a: 1e-7}, list: [1, 2], map: new Map([["k", 1]])};
        const noise = {track: new Float64Array([5709.3989352540775, 2, 3]), errDeg: NaN, solved: {a: 1e-7 + 1e-19},
            list: [1, 2], map: new Map([["k", 1]])};
        expect(valuesAgree(result, noise)).toBe(true);
        expect(valuesAgree(result, {...noise, solved: {a: 2e-7}})).toBe(false);
        expect(valuesAgree(result, {...noise, track: new Float64Array([5709.4, 2, 3])})).toBe(false);
        expect(valuesAgree(result, {...noise, list: [1, 2, 3]})).toBe(false);
        expect(valuesAgree(result, {...noise, errDeg: 0})).toBe(false);
        expect(valuesAgree({a: 1, elapsedMs: 5}, {a: 1, elapsedMs: 9})).toBe(true);
        const text = packUnitBlob({unitId: "aircraft", hash, ...record}, result);
        expect(unitResultAgrees(noise, text)).toBe(true);
        expect(unitResultAgrees({...noise, errDeg: 1}, text)).toBe(false);
        // The sweep's rebuilt copy is left out of the comparison on both sides.
        const results = [{startDist: 1, speed: 1, score: 3}, {startDist: 1, speed: 2, score: 1}];
        const sweep = {results, sorted: results.slice().sort((a, b) => a.score - b.score)};
        expect(unitResultAgrees(sweep, packUnitBlob({unitId: "constAir", hash}, sweep))).toBe(true);
    });

    test("adopting stamps the build and keeps the one that fitted it", () => {
        const adopted = adoptRecord({...record}, "v2");
        expect(adopted.appVersion).toBe("v2");
        expect(adopted.adoptedFrom).toBe("v1");
        expect(adopted.adopted).toBe(true);
        expect(adoptRecord({...adopted}, "v3").adoptedFrom).toBe("v1");
    });
});

describe("the index entry", () => {
    test("records units and rows, keeping the newest rows and starting over on a changed file", () => {
        const results = {};
        const rec = unitRecord({unitId: "kalman", blob: "k.json", options, appVersion: "v1"});
        recordUnit(results, "f.csv", {hash, hashes}, "kalman", rec);
        expect(results["f.csv"].units.kalman).toBe(rec);
        for (let i = 0; i < 8; i++) {
            recordRowMemo(results, "f.csv", {hash, hashes}, `sel${i}`, {row: {i}, appVersion: "v1"}, 3);
        }
        expect(Object.keys(results["f.csv"].rows)).toEqual(["sel5", "sel6", "sel7"]);
        // The same file with new bytes: nothing old survives.
        recordUnit(results, "f.csv", {hash: "other", hashes}, "kalman", rec);
        expect(results["f.csv"].rows).toEqual({});
    });

    test("a remembered row is shown under its build with the same unit versions, or when adopted", () => {
        const memo = {row: {x: 1}, appVersion: "v1", unitVersions: {kalman: UNIT_VERSIONS.kalman}};
        expect(rowMemoUsable(memo, {appVersion: "v1", unitVersions: {kalman: UNIT_VERSIONS.kalman}})).toBe(true);
        expect(rowMemoUsable(memo, {appVersion: "v2", unitVersions: {kalman: UNIT_VERSIONS.kalman}})).toBe(false);
        expect(rowMemoUsable(memo, {appVersion: "v2", unitVersions: {kalman: UNIT_VERSIONS.kalman}, adoptable: true})).toBe(true);
        expect(rowMemoUsable(memo, {appVersion: "v1", unitVersions: {kalman: UNIT_VERSIONS.kalman + 1}})).toBe(false);
        expect(rowMemoUsable(memo, {appVersion: "v1", unitVersions: {kalman: UNIT_VERSIONS.kalman, lantern: 1}})).toBe(false);
    });
});

describe("a schema-2 battery", () => {
    const battery = {
        sweep: {results: [], best: {}}, fastProfile: [{score: 1}], slowProfile: [{score: 2}],
        aircraft: null, plausible: {track: new Float64Array(3)}, lantern: {positions: new Float64Array(3)},
        quad: {positions: new Float64Array(3)}, families: null,
        failures: [
            {method: "Fixed-Wing Aircraft", error: "fit failed"},
            {method: "Sky Lantern / Balloon (measured wind)", error: "not tested"},
            {method: "Drone (control inputs)", error: "fit returned no finite solution"},
            {method: "Quadcopter range band", error: "failed"},
        ],
    };

    test("splits into the units it holds as raw fits, with their own failures", () => {
        const units = legacyUnitsFromBattery(battery, {elapsedMs: 5000});
        expect(Object.keys(units).sort()).toEqual(["aircraft", "constAir", "lantern", "plausible", "profiles", "quadcopter"]);
        expect(units.aircraft.result).toBeNull();
        expect(units.aircraft.failures).toEqual([{method: "Fixed-Wing Aircraft", error: "fit failed"}]);
        expect(units.lantern.failures).toEqual([]);
        expect(units.profiles.result.slowProfile).toBe(battery.slowProfile);
        for (const unit of Object.values(units)) {
            expect(unit.migrated).toBe(true);
            expect(unit.legacyBatteryMs).toBe(5000);
            expect(unit.elapsedMs).toBeNull();
        }
        for (const id of Object.keys(units)) expect(LEGACY_UNITS).toContain(id);
    });

    test("the row's fit time counts every unit once and an old battery once", () => {
        expect(elapsedFromUnits({a: {elapsedMs: 10}, b: {elapsedMs: 20, legacyBatteryMs: 5000},
            c: {elapsedMs: null, legacyBatteryMs: 5000}})).toBe(5030);
        expect(elapsedFromUnits({})).toBe(0);
    });
});

describe("what Flush Cache measures", () => {
    const file = (size) => ({kind: "file", getFile: async () => ({size})});
    const notFound = () => { const e = new Error("not found"); e.name = "NotFoundError"; throw e; };

    test("an index and its blobs are counted and sized; subfolders are skipped", async () => {
        const handle = {
            getFileHandle: async (name) => (name === CACHE_FILENAME ? file(4000) : notFound()),
            getDirectoryHandle: async (name) => (name === CACHE_BLOB_DIR ? {
                entries: async function* () {
                    yield ["x.aircraft.json", file(1000)];
                    yield ["x.kalman.json", file(200)];
                    yield ["nested", {kind: "directory"}];
                },
            } : notFound()),
        };
        const seen = [];
        expect(await measureCacheOnDisk(handle, (bytes) => seen.push(bytes)))
            .toEqual({indexFiles: 1, indexBytes: 4000, blobs: 2, blobBytes: 1200});
        expect(seen).toEqual([1000, 200]);
    });

    test("a folder with no cache measures as nothing", async () => {
        const handle = {getFileHandle: async () => notFound(), getDirectoryHandle: async () => notFound()};
        expect(await measureCacheOnDisk(handle)).toEqual({indexFiles: 0, indexBytes: 0, blobs: 0, blobBytes: 0});
    });

    test("sizes and durations read as people say them", () => {
        expect(formatBytes(0)).toBe("0 bytes");
        expect(formatBytes(900)).toBe("900 bytes");
        expect(formatBytes(12 * 1024)).toBe("12 KB");
        expect(formatBytes(340 * 1048576)).toBe("340 MB");
        expect(formatBytes(1.25 * 1073741824)).toBe("1.3 GB");
        expect(describeDuration(0)).toBe("no recorded time");
        expect(describeDuration(40000)).toBe("about 40 seconds");
        expect(describeDuration(12 * 60000)).toBe("about 12 minutes");
        expect(describeDuration(3.2 * 3600000)).toBe("about 3.2 hours");
    });

    test("the recorded fitting time counts each unit once, a split battery once per file, and an unsplit entry itself", () => {
        const data = {results: {
            "a.csv": {units: {
                aircraft: {elapsedMs: null, legacyBatteryMs: 5000},
                constAir: {elapsedMs: null, legacyBatteryMs: 5000},
                kalman: {elapsedMs: 30},
            }},
            "b.csv": {units: {aircraft: {elapsedMs: 4000}, kalman: {elapsedMs: 20}}},
            "c.csv": {battery: "old.json", elapsedMs: 7000},
        }};
        expect(recordedFitMs(data)).toBe(5000 + 30 + 4000 + 20 + 7000);
        expect(recordedFitMs(null)).toBe(0);
    });
});
