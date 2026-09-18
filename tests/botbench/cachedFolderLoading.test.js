/** @jest-environment jsdom */
import {createHash, webcrypto} from "node:crypto";
import {TextEncoder} from "node:util";
import {
    analyseEntryWithCache,
    analyzeEntries,
    collectFsEntry,
    findVersionStaleEntries,
    flushDirCache,
    gatherCachedUnits,
    loadDirCache,
    openBotBenchDialog,
    pairSidecars,
    walkDirectoryHandle,
    writeDirCache
} from "../../src/analysis/BotBenchUI";
import {entryFileHashes, readEntrySidecars} from "../../src/analysis/BotBenchEntryFiles";
import {
    CACHE_BLOB_DIR,
    CACHE_FILENAME,
    combinedHash,
    packUnitBlob,
    recordUnit,
    ROW_ASSESSMENT_REVISION,
    unitBlobName,
    unitRecord
} from "../../src/analysis/BotBenchCacheIndex";
import {selectionKey, UNIT_VERSIONS} from "../../src/analysis/BotBenchSolvers";
import {BotBenchAnalysisPool} from "../../src/analysis/BotBenchAnalysisPool";
import {rowsFromBotBenchEntries} from "../../src/analysis/charts/BotBenchChartRows";

beforeAll(() => {
    globalThis.TextEncoder = TextEncoder;
    Object.defineProperty(globalThis.crypto, "subtle", {value: webcrypto.subtle, configurable: true});
});

const appVersion = process.env.BUILD_VERSION_STRING ?? "dev";
const options = {anchorM: 37040, solutionFamilies: false, mcOrderSweep: false,
    gpuSearch: true, solvers: ["gfKalman"]};
const digest = text => createHash("sha256").update(text).digest("hex");
function file(name, text, relativePath = name) {
    return {name, relativePath, kind: "file", getFile: jest.fn(async () => ({
        text: async () => text, arrayBuffer: async () => Buffer.from(text),
    }))};
}
function directory(name, children) {
    return {name, kind: "directory", entries: jest.fn(async function* () {
        for (const child of children) yield [child.name, child];
    })};
}

test("folder selection never enumerates generated fit blobs", async () => {
    const cache = directory(CACHE_BLOB_DIR, [file("should-not-load.csv", "")]);
    const root = directory("root", [file("scenario.all.csv", ""), cache]);
    expect((await walkDirectoryHandle(root, {recursive: true})).map(e => e.name))
        .toEqual(["scenario.all.csv"]);
    expect(cache.entries).not.toHaveBeenCalled();
    const droppedCache = {name: CACHE_BLOB_DIR, isDirectory: true, createReader: jest.fn()};
    await collectFsEntry(droppedCache, "", [], true);
    expect(droppedCache.createReader).not.toHaveBeenCalled();
});

test("pairing retains file references, with the correct batch's metadata", async () => {
    const files = [file("x.all.csv", "csv", "one/All/x.all.csv"),
        file("x.scenario.json", "one", "one/meta/x.scenario.json"),
        file("x.truth.json", "truth", "one/meta/x.truth.json"),
        file("x.scenario.json", "two", "two/meta/x.scenario.json")];
    const [entry] = await pairSidecars(files);
    expect(files.every(f => !f.getFile.mock.calls.length)).toBe(true);
    expect(entry.sidecarFile).toBe(files[1]);
    expect(await readEntrySidecars(entry)).toMatchObject({sidecarText: "one", labelsText: "truth"});
    expect(entry.sidecarText).toBeUndefined();
    expect(entry.labelsText).toBeUndefined();
});

test("changed CSV, scenario and truth bytes each invalidate cached hashes", async () => {
    const entry = {...file("x.all.csv", "csv"), sidecarFile: file("x.scenario.json", "scenario"),
        labelsFile: file("x.truth.json", "truth")};
    const original = await entryFileHashes(entry);
    expect(original).toEqual({csv: digest("csv"), sidecar: digest("scenario"), truth: digest("truth")});
    for (const field of ["getFile", "sidecarFile", "labelsFile"]) {
        const changed = {...entry, [field]: field === "getFile"
            ? file("x.all.csv", "changed").getFile : file("sidecar", "changed")};
        expect(combinedHash(await entryFileHashes(changed))).not.toBe(combinedHash(original));
    }
    expect(await entryFileHashes({...entry, sidecarText: "inline"}))
        .toEqual({...original, sidecar: digest("inline")});
    expect(entry.sidecarText).toBeUndefined();
    expect(entry.labelsText).toBeUndefined();
});

function cachedFolder(name, count, version = appVersion) {
    const results = {};
    const sources = Array.from({length: count}, (_, i) => file(`${i}.all.csv`, `csv-${i}`, `${name}/${i}.all.csv`));
    const key = selectionKey(options.solvers, options);
    for (const [i, source] of sources.entries()) {
        const hashes = {csv: digest(`csv-${i}`)};
        results[source.name] = {hash: combinedHash(hashes), hashes,
            units: {kalman: unitRecord({unitId: "kalman", blob: "stored.json", options, appVersion: version,
                elapsedMs: 100})},
            rows: {[key]: {row: {warnings: [], viableClasses: [], failures: [],
                quality: {frames: 2}, fileSha256: hashes, elapsedMs: 100,
                displayName: source.name, top: {errDeg: 0.1}},
            appVersion: version, unitVersions: {kalman: UNIT_VERSIONS.kalman},
            assessmentRevision: ROW_ASSESSMENT_REVISION,
            chartData: {version: 4, apertureDeg: 1, sensorTurnDeg: 0, candidateErrors: []}}}};
    }
    let text = JSON.stringify({schema: 3, results});
    const writes = [];
    const handle = {name, getFileHandle: jest.fn(async requested => {
        expect(requested).toBe(CACHE_FILENAME);
        // A writable stream appends its writes and replaces the file on close.
        return {getFile: async () => ({text: async () => text}), createWritable: async () => {
            let pending = "";
            return {
                write: async value => { pending += value; writes.push("write"); },
                close: async () => { text = pending; writes.push("close"); },
            };
        }};
    }), getDirectoryHandle: jest.fn()};
    sources.forEach(source => { source.dirHandle = handle; source.cacheWritable = false; });
    return {sources, handle, writes, readIndex: () => JSON.parse(text)};
}

function scenarioCSV() {
    const rows = ["TrackID,Time,SensorPositionX,SensorPositionY,SensorPositionZ,LOSUnitVectorX,LOSUnitVectorY,LOSUnitVectorZ"];
    for (let i = 0; i < 12; i++) {
        const sensor = [i * 10, i * i, 1000], delta = [3000 - sensor[0], 2000 - sensor[1], -500];
        const length = Math.hypot(...delta);
        rows.push(["fraction-test", i, ...sensor, ...delta.map(v => v / length)].join(","));
    }
    return rows.join("\n");
}

test("Fraction fits and charts every third case while ignoring other cached results", async () => {
    const folder = cachedFolder("fraction", 9);
    const state = openBotBenchDialog();
    const analysis = jest.spyOn(BotBenchAnalysisPool.prototype, "run");
    const originalWorker = globalThis.Worker;
    globalThis.Worker = undefined;
    // Selected cases 3, 6 and 9 need new fits. Case 1 has changed too, while the
    // other cases have valid cached rows; all six unselected cases must be ignored.
    for (const i of [0, 2, 5, 8]) folder.sources[i].getFile = file(folder.sources[i].name, scenarioCSV()).getFile;
    folder.handle.getDirectoryHandle.mockRejectedValue(Object.assign(new Error("missing"), {name: "NotFoundError"}));
    try {
        expect(state.fractionInput.value).toBe("1");
        state.fractionInput.value = "3";
        state.solvers = options.solvers;
        const running = analyzeEntries(state, folder.sources);
        expect(state.fractionInput.disabled).toBe(true);
        await running;
        expect(analysis.mock.calls.map(([record]) => record.label)).toEqual(
            [2, 5, 8].map(i => folder.sources[i].relativePath));
        expect(state.entries[0].status).toBe("skipped");
        expect(state.entries.filter(e => e.status === "done")).toHaveLength(3);
        expect(state.entries.filter(e => e.rowReused)).toHaveLength(0);
        expect(rowsFromBotBenchEntries(state.entries.filter(e => e.status === "done"))).toHaveLength(3);
        for (const i of [0, 1, 3, 4, 6, 7]) expect(folder.sources[i].getFile).not.toHaveBeenCalled();
        expect(state.status.textContent).toContain("Fraction 3: 3 of 9 cases selected");
        expect(state.progress.value).toBe(1);
        expect(state.fractionInput.disabled).toBe(false);
        expect(state.entries.every(e => !Object.hasOwn(e.options, "fraction"))).toBe(true);
        expect(state.dirCaches.every(rec => rec.data === null)).toBe(true);
    } finally {
        state.closeButton.onclick();
        analysis.mockRestore();
        globalThis.Worker = originalWorker;
    }
});

test("a fraction larger than the folder ignores all cached results", async () => {
    const folder = cachedFolder("cached-fraction", 4);
    const state = openBotBenchDialog();
    const analysis = jest.spyOn(BotBenchAnalysisPool.prototype, "run");
    try {
        state.solvers = options.solvers;
        state.fractionInput.value = "10";
        state.rebuildRowsInput.checked = true;
        await analyzeEntries(state, folder.sources);
        expect(analysis).not.toHaveBeenCalled();
        expect(state.entries.every(e => e.status === "skipped")).toBe(true);
        expect(rowsFromBotBenchEntries(state.entries)).toHaveLength(0);
        expect(folder.handle.getFileHandle).not.toHaveBeenCalled();
    } finally {
        state.closeButton.onclick();
        analysis.mockRestore();
    }
});

test("invalid Fraction values normalize to 1", () => {
    const state = openBotBenchDialog();
    try {
        for (const value of ["", "0", "-3", "2.5", "NaN"]) {
            state.fractionInput.value = value;
            state.fractionInput.dispatchEvent(new Event("change"));
            expect(state.fractionInput.value).toBe("1");
        }
    } finally { state.closeButton.onclick(); }
});

test("the compatibility scan reads only indexes and releases them between folders", async () => {
    const a = cachedFolder("a", 20), b = cachedFolder("b", 20, "old");
    const state = {};
    const stale = await findVersionStaleEntries(state, [...a.sources, ...b.sources], options, ["kalman"]);
    expect(stale).toHaveLength(20);
    expect(stale.every(candidate => !candidate.hit && !candidate.dirCache && !candidate.hashes)).toBe(true);
    expect([...a.sources, ...b.sources].every(source => !source.getFile.mock.calls.length)).toBe(true);
    expect(state.dirCaches.every(rec => rec.data === null && rec.loading === null)).toBe(true);
    expect(state.dirCaches.map(rec => rec.recordedFitMs)).toEqual([2000, 2000]);
});

test("releasing an index waits for pending writes before dropping its data", async () => {
    const folder = cachedFolder("a", 1);
    const rec = {handle: folder.handle, data: {schema: 3, results: {}}, pendingChanges: 1};
    rec.loading = Promise.resolve(rec);
    const state = {dirCaches: [rec]};
    await findVersionStaleEntries(state, folder.sources, options, ["kalman"]);
    expect(folder.writes).toEqual(["write", "close"]);
    expect(rec.data).toBeNull();
});

test("adopting unchanged rows batches stamps until the folder finishes", async () => {
    const folder = cachedFolder("a", 100, "old");
    const rec = {handle: folder.handle, data: folder.readIndex(), writable: true};
    rec.loading = Promise.resolve(rec);
    const pool = {run: jest.fn()};
    const key = selectionKey(options.solvers, options);
    for (const source of folder.sources) {
        const out = await analyseEntryWithCache(source, {dirCache: rec, pool, options, key,
            plan: ["kalman"], hashes: rec.data.results[source.name].hashes,
            adoptRows: true, adoptUnits: new Set(["kalman"])});
        expect(out.rowReused).toBe(true);
        expect(out.adopted).toBe(true);
    }
    expect(pool.run).not.toHaveBeenCalled();
    expect(folder.writes).toEqual([]);
    await findVersionStaleEntries({dirCaches: [rec]}, folder.sources, options, ["kalman"]);
    expect(folder.writes).toEqual(["write", "close"]);
    expect(rec.data).toBeNull();
    for (const hit of Object.values(folder.readIndex().results)) {
        expect(hit.units.kalman.appVersion).toBe(appVersion);
        expect(hit.rows[key]).toMatchObject({appVersion, adopted: true, adoptedFrom: "old"});
    }
});

test("adoption stamps are still checkpointed during a long folder run", async () => {
    jest.useFakeTimers();
    const folder = cachedFolder("a", 100, "old");
    const rec = {handle: folder.handle, data: folder.readIndex(), writable: true};
    rec.loading = Promise.resolve(rec);
    try {
        const source = folder.sources[0];
        await analyseEntryWithCache(source, {dirCache: rec, options, plan: ["kalman"],
            key: selectionKey(options.solvers, options), hashes: rec.data.results[source.name].hashes,
            adoptRows: true, adoptUnits: new Set(["kalman"])});
        await jest.advanceTimersByTimeAsync(3000);
        expect(folder.writes).toEqual(["write", "close"]);
    } finally { jest.useRealTimers(); }
});

test("a gallery reading an index keeps it alive until the reader finishes", async () => {
    const folder = cachedFolder("a", 1);
    const rec = {handle: folder.handle, data: {schema: 3, results: {}}, resultReaders: 1};
    rec.loading = Promise.resolve(rec);
    const state = {dirCaches: [rec]};
    await findVersionStaleEntries(state, folder.sources, options, ["kalman"]);
    expect(rec.data).not.toBeNull();
    rec.resultReaders = 0;
    await findVersionStaleEntries(state, folder.sources, options, ["kalman"]);
    expect(rec.data).toBeNull();
});

test("cached rows need one content read, no analysis, and retain no indexes after completion", async () => {
    const a = cachedFolder("a", 20), b = cachedFolder("b", 20);
    const state = openBotBenchDialog();
    const analysis = jest.spyOn(BotBenchAnalysisPool.prototype, "run");
    const warnings = jest.spyOn(console, "warn");
    const previousWorker = globalThis.Worker;
    globalThis.Worker = jest.fn(() => { throw new Error("Cached rows must not start workers"); });
    // Finish the first folder out of order while the next folder starts, as the
    // parallel queue does in a browser. Its index must stay until every row ends.
    const firstFile = a.sources[0].getFile;
    a.sources[0].getFile = jest.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return firstFile();
    });
    try {
        state.solvers = options.solvers;
        state.anchorInput.value = "20";
        state.familiesInput.checked = false;
        state.mcSweepInput.checked = false;
        state.screenshotsInput.checked = false;
        state.rebuildRowsInput.checked = false;
        const sources = [...a.sources, ...b.sources];
        await analyzeEntries(state, sources);
        expect(state.entries).toHaveLength(40);
        expect(state.entries.every(entry => entry.status === "done" && entry.rowReused && !entry.results)).toBe(true);
        expect(sources.every(source => source.getFile.mock.calls.length === 1)).toBe(true);
        expect(analysis).not.toHaveBeenCalled();
        expect(globalThis.Worker).not.toHaveBeenCalled();
        expect(a.handle.getDirectoryHandle).not.toHaveBeenCalled();
        expect(b.handle.getDirectoryHandle).not.toHaveBeenCalled();
        expect(state.dirCaches.every(rec => rec.data === null && rec.loading === null)).toBe(true);
        state.rowView.render();
        expect(state.rowView.renderedCount).toBeLessThan(40);
        expect(warnings).not.toHaveBeenCalled();
    } finally {
        analysis.mockRestore();
        warnings.mockRestore();
        globalThis.Worker = previousWorker;
        state.closeButton.onclick();
    }
});

const notFound = () => Object.assign(new Error("missing"), {name: "NotFoundError"});

test("the saved worker limit bounds file reads and leaves cached rows reusable", async () => {
    const storageKey = "botbench.maxWorkers";
    const previousLimit = localStorage.getItem(storageKey);
    const cores = jest.spyOn(navigator, "hardwareConcurrency", "get").mockReturnValue(24);
    const previousWorker = globalThis.Worker;
    globalThis.Worker = jest.fn(() => { throw new Error("Cached rows must not start workers"); });
    localStorage.removeItem(storageKey);
    let state = openBotBenchDialog();
    let running;
    try {
        expect(state.workerLimitInput.value).toBe("4");
        state.workerLimitInput.value = "2";
        state.workerLimitInput.dispatchEvent(new Event("change"));
        state.closeButton.onclick();
        state = openBotBenchDialog();
        expect(state.workerLimitInput.value).toBe("2");
        state.solvers = options.solvers;
        let previousOptions;
        for (const limit of [2, 1]) {
            state.workerLimitInput.value = String(limit);
            const folder = cachedFolder(`limit-${limit}`, 6);
            let active = 0, peak = 0;
            for (const source of folder.sources) {
                const getFile = source.getFile;
                source.getFile = async () => {
                    peak = Math.max(peak, ++active);
                    await new Promise(resolve => setTimeout(resolve, 5));
                    active--;
                    return getFile();
                };
            }
            running = analyzeEntries(state, folder.sources);
            expect(state.workerLimitInput.disabled).toBe(true);
            expect(state.workerPool.workers.size).toBe(limit);
            await running;
            expect(peak).toBe(limit);
            expect(state.workerLimitInput.disabled).toBe(false);
            expect(state.entries.every(entry => entry.status === "done" && entry.rowReused)).toBe(true);
            const rowOptions = state.entries.at(-1).options;
            if (previousOptions) expect(rowOptions).toEqual(previousOptions);
            previousOptions = rowOptions;
        }
        expect(globalThis.Worker).not.toHaveBeenCalled();
    } finally {
        await running;
        state.closeButton.onclick();
        cores.mockRestore();
        globalThis.Worker = previousWorker;
        if (previousLimit === null) localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, previousLimit);
    }
});

test("a file whose index entry was lost is found again by its blob names", async () => {
    const hashes = {csv: digest("csv")};
    const hash = combinedHash(hashes);
    const name = "x.all.csv";
    const plan = ["kalman", "polySweep"];
    const blobs = new Map();
    const store = (unitId, meta = {}) => {
        const record = unitRecord({unitId, blob: unitBlobName(hash, unitId), options, appVersion, elapsedMs: 100});
        blobs.set(unitBlobName(hash, unitId),
            packUnitBlob({unitId, hash, ...record, ...meta}, {positions: new Float64Array([1, 2, 3])}));
        return record;
    };
    const kalman = store("kalman");
    const blobDir = {getFileHandle: jest.fn(async blobName => {
        if (!blobs.has(blobName)) throw notFound();
        return {getFile: async () => ({text: async () => blobs.get(blobName)})};
    })};
    const dirCache = {handle: {getDirectoryHandle: jest.fn(async () => blobDir)},
        data: {schema: 3, results: {}}, writable: true};

    // No entry at all, as after a tab lost between index writes.
    const found = await gatherCachedUnits(dirCache, null, {hash, hashes, name, plan, options});
    expect(Object.keys(found.texts.cached)).toEqual(["kalman"]);
    expect(found.records.kalman).toEqual(kalman);
    expect(dirCache.data.results[name]).toMatchObject({hash, units: {kalman}});
    expect(dirCache.handle.getDirectoryHandle).toHaveBeenCalledTimes(1);

    // An entry for other bytes does not hide the fits of these bytes.
    dirCache.data.results[name] = {hash: "other", hashes: {csv: "other"}, units: {}, rows: {}};
    const again = await gatherCachedUnits(dirCache, dirCache.data.results[name], {hash, hashes, name, plan, options});
    expect(Object.keys(again.texts.cached)).toEqual(["kalman"]);
    expect(dirCache.data.results[name].hash).toBe(hash);

    // A blob under this name whose meta says other bytes made it is not used.
    store("kalman", {hash: "other"});
    const wrong = {...dirCache, data: {schema: 3, results: {}}};
    expect((await gatherCachedUnits(wrong, null, {hash, hashes, name, plan, options})).texts.cached).toEqual({});

    // A folder with no fits yet costs one lookup per file.
    const empty = {handle: {getDirectoryHandle: jest.fn(async () => { throw notFound(); })},
        data: {schema: 3, results: {}}};
    expect((await gatherCachedUnits(empty, null, {hash, hashes, name, plan, options})).texts.cached).toEqual({});
    expect(empty.handle.getDirectoryHandle).toHaveBeenCalledTimes(1);
});

test("an index that is on disk but unreadable is kept, and a missing one is made", async () => {
    const damaged = "{\"schema\":3,\"results\":{\"a.all.csv\":";
    const disk = {text: damaged};
    const handle = {getFileHandle: jest.fn(async (requested, {create = false} = {}) => {
        expect(requested).toBe(CACHE_FILENAME);
        if (disk.text === null && !create) throw notFound();
        return {getFile: async () => ({text: async () => disk.text}), createWritable: async () => {
            let pending = "";
            return {write: async value => { pending += value; }, close: async () => { disk.text = pending; }};
        }};
    })};
    const hashes = {csv: digest("csv")};
    const record = unitRecord({unitId: "kalman", blob: "b.json", options, appVersion});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
        const rec = await loadDirCache({}, {name: "a.all.csv", dirHandle: handle});
        expect(rec.indexUnreadable).toBeTruthy();
        recordUnit(rec.data.results, "a.all.csv", {hash: combinedHash(hashes), hashes}, "kalman", record);
        await writeDirCache(rec);
        await flushDirCache(rec);
        expect(disk.text).toBe(damaged);
        expect(warn).toHaveBeenCalled();

        disk.text = null;
        const fresh = await loadDirCache({}, {name: "a.all.csv", dirHandle: handle});
        expect(fresh.indexUnreadable).toBeNull();
        recordUnit(fresh.data.results, "a.all.csv", {hash: combinedHash(hashes), hashes}, "kalman", record);
        await writeDirCache(fresh);
        await flushDirCache(fresh);
        expect(JSON.parse(disk.text).results["a.all.csv"].units.kalman).toEqual(record);
    } finally { warn.mockRestore(); }
});

test("cancelling row loading releases indexes and stops claiming new files", async () => {
    const folder = cachedFolder("a", 40);
    const state = openBotBenchDialog();
    const firstFile = folder.sources[0].getFile;
    folder.sources[0].getFile = jest.fn(async () => {
        state.cancelled = true;
        return firstFile();
    });
    try {
        state.solvers = options.solvers;
        state.anchorInput.value = "20";
        state.screenshotsInput.checked = false;
        await analyzeEntries(state, folder.sources);
        expect(state.cancelled).toBe(true);
        expect(state.entries).toHaveLength(1);
        expect(state.entries[0].status).toBe("cancelled");
        expect(state.dirCaches.every(rec => rec.data === null && rec.loading === null)).toBe(true);
    } finally { state.closeButton.onclick(); }
});
