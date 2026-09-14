/** @jest-environment jsdom */
import {webcrypto, createHash} from "node:crypto";
import {TextEncoder} from "node:util";
import {analyseEntryWithCache, analyzeEntries, collectFsEntry, findVersionStaleEntries, openBotBenchDialog,
    pairSidecars, walkDirectoryHandle} from "../../src/analysis/BotBenchUI";
import {entryFileHashes, readEntrySidecars} from "../../src/analysis/BotBenchEntryFiles";
import {CACHE_BLOB_DIR, CACHE_FILENAME, combinedHash, unitRecord} from "../../src/analysis/BotBenchCacheIndex";
import {selectionKey, UNIT_VERSIONS} from "../../src/analysis/BotBenchSolvers";
import {BotBenchAnalysisPool} from "../../src/analysis/BotBenchAnalysisPool";

beforeAll(() => {
    globalThis.TextEncoder = TextEncoder;
    Object.defineProperty(globalThis.crypto, "subtle", {value: webcrypto.subtle, configurable: true});
});

const appVersion = process.env.BUILD_VERSION_STRING ?? "dev";
const options = {anchorM: 37040, solutionFamilies: false, mcOrderSweep: false, solvers: ["gfKalman"]};
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
            chartData: {version: 2, apertureDeg: 1, sensorTurnDeg: 0, candidateErrors: []}}}};
    }
    let text = JSON.stringify({schema: 3, results});
    const writes = [];
    const handle = {name, getFileHandle: jest.fn(async requested => {
        expect(requested).toBe(CACHE_FILENAME);
        return {getFile: async () => ({text: async () => text}), createWritable: async () => ({
            write: async value => { text = value; writes.push("write"); },
            close: async () => { writes.push("close"); },
        })};
    }), getDirectoryHandle: jest.fn()};
    sources.forEach(source => { source.dirHandle = handle; source.cacheWritable = false; });
    return {sources, handle, writes, readIndex: () => JSON.parse(text)};
}

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
