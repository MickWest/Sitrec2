/** @jest-environment jsdom */
import {webcrypto} from "node:crypto";
import {TextEncoder} from "node:util";
import {ingestBotCSV} from "../../src/analysis/BotBenchIngest";
import {compareTrackToTruth, trackMetrics} from "../../src/TraverseAnalysis";
import {rankAllHypotheses} from "../../src/TraverseRanking";
import {
    buildTrackOutputCSV, trackOutputLocation, writeTrackOutput,
} from "../../src/analysis/BotBenchTrackOutput";
import {
    analyzeEntries, collectFsEntry, openBotBenchDialog, pairSidecars, walkDirectoryHandle,
} from "../../src/analysis/BotBenchUI";

beforeAll(() => {
    globalThis.TextEncoder = TextEncoder;
    Object.defineProperty(globalThis.crypto, "subtle", {value: webcrypto.subtle, configurable: true});
});

const header = "TrackID,Time,AlgorithmID,EstimatedPositionX,EstimatedPositionY,EstimatedPositionZ,"
    + "CovarianceXX,CovarianceYY,CovarianceZZ,CovarianceXY,CovarianceXZ,CovarianceYZ";

function scenarioCSV({gap = false} = {}) {
    const rows = ["TrackID,Time,SensorPositionX,SensorPositionY,SensorPositionZ,LOSUnitVectorX,LOSUnitVectorY,LOSUnitVectorZ"];
    for (let f = 0; f < 15; f++) {
        const sensor = [f * 10, f * f, 1000], delta = [3000 - sensor[0], 2000 - sensor[1], -500];
        const length = Math.hypot(...delta);
        const time = 7.25 + f / 2 + (gap && f >= 3 ? 10 : 0);
        rows.push(["0007", time, ...sensor, ...delta.map(v => v / length)].join(","));
    }
    return rows.join("\n");
}

function candidates(record) {
    const {dataset} = record;
    const trackA = new Float64Array(dataset.n * 3), trackB = new Float64Array(dataset.n * 3);
    for (let f = 0; f < dataset.n; f++) {
        trackA.set([3000 + f, 2000, 500], f * 3);
        trackB.set([4000 + f * 2, 3000, 600], f * 3);
    }
    return [
        {key: "constAir", name: "A", track: trackA, errDeg: 0.01},
        {key: "horizontalSpeed", name: "B", track: trackB, errDeg: 0.04},
    ].map(h => ({...h, params: {}, metricsFull: trackMetrics(dataset, h.track)}));
}

test("CSV keeps source IDs, trimmed source times, XYZ metres and blank optional covariance", () => {
    const record = ingestBotCSV(scenarioCSV({gap: true}));
    const hypotheses = candidates(record);
    const {csv} = buildTrackOutputCSV({...record, hypotheses});
    const lines = csv.trimEnd().split("\r\n");
    expect(record.dataset.n).toBe(12);
    expect(lines[0]).toBe(header);
    expect(lines[1]).toBe("0007,18.75,sitrec_constAir,3000,2000,500,,,,,,");
    expect(lines[12]).toBe("0007,24.25,sitrec_constAir,3011,2000,500,,,,,,");
    expect(lines).toHaveLength(13);
    expect(lines.every(line => line.split(",").length === 12)).toBe(true);
});

test("changing truth cannot change the exported candidate", () => {
    const record = ingestBotCSV(scenarioCSV());
    const hypotheses = candidates(record);
    const results = {...record, hypotheses};
    const blind = buildTrackOutputCSV(results);
    expect(blind.algorithmID).toBe("sitrec_constAir");
    for (const track of [hypotheses[1].track, hypotheses[0].track]) {
        results.truth = {track};
        for (const h of hypotheses) h.truthComparison = compareTrackToTruth(record.dataset, h.track, results.truth);
        expect(rankAllHypotheses(hypotheses, {dataset: record.dataset})[0].h.track).toBe(track);
        expect(buildTrackOutputCSV(results)).toEqual(blind);
    }
});

test("CSV quotes identifiers and refuses an artificial or incomplete position track", () => {
    const record = ingestBotCSV(scenarioCSV());
    const [h] = candidates(record);
    record.outputSamples.trackId = 'track,"7"';
    expect(buildTrackOutputCSV({...record, hypotheses: [h]}).csv.split("\r\n")[1])
        .toMatch(/^"track,""7""",7.25,/);
    expect(buildTrackOutputCSV({...record, hypotheses: [{...h, atInfinity: true}]}))
        .toEqual({reason: "The top candidate has no finite target position."});
    h.track[0] = NaN;
    expect(buildTrackOutputCSV({...record, hypotheses: [h]}).csv).toBeUndefined();
    expect(buildTrackOutputCSV({...record, hypotheses: []}).csv).toBeUndefined();
});

test.each(["All", "INPUT", "all", "input"])("%s reached through a parent writes beside the track folder", name => {
    const parentHandle = {}, dirHandle = {name};
    expect(trackOutputLocation({name: "track.input.csv", dirPath: `batch/${name}`, dirHandle, parentHandle}))
        .toEqual({base: parentHandle, path: "batch/output/track.input.csv"});
});

test.each(["All", "input", "tracks"])("a directly selected %s writes inside itself", name => {
    const dirHandle = {name};
    expect(trackOutputLocation({name: "track.csv", dirPath: "", dirHandle}))
        .toEqual({base: dirHandle, path: "output/track.csv"});
});

test("ordinary nested folders keep their outputs inside the track folder", () => {
    const dirHandle = {name: "tracks"};
    expect(trackOutputLocation({name: "x.csv", dirPath: "batch/tracks", dirHandle, parentHandle: {}}))
        .toEqual({base: dirHandle, path: "batch/tracks/output/x.csv"});
});

// A small in-memory File System Access implementation, including atomic close,
// exercises the same folder walk, cache writes and output writes as the picker.
function directory(name) {
    const children = new Map();
    const missing = () => { throw Object.assign(new Error("missing"), {name: "NotFoundError"}); };
    return {name, kind: "directory", children,
        entries: jest.fn(async function* () { yield* children.entries(); }),
        getDirectoryHandle: jest.fn(async (child, opts = {}) => {
            if (!children.has(child)) {
                if (!opts.create) missing();
                children.set(child, directory(child));
            }
            return children.get(child);
        }),
        getFileHandle: jest.fn(async (child, opts = {}) => {
            if (!children.has(child)) {
                if (!opts.create) missing();
                const file = {name: child, kind: "file", text: "",
                    getFile: async () => ({name: child, text: async () => file.text,
                        arrayBuffer: async () => Buffer.from(file.text)}),
                    createWritable: async () => {
                        let pending = "";
                        return {write: async text => { pending += text; },
                            close: async () => { file.text = pending; }, abort: async () => {}};
                    }};
                children.set(child, file);
            }
            return children.get(child);
        }),
    };
}

test("fresh and cached runs export only when enabled, using stored fits and the same source filename", async () => {
    const root = directory("batch");
    const all = await root.getDirectoryHandle("All", {create: true});
    const source = await all.getFileHandle("example.all.csv", {create: true});
    source.text = scenarioCSV();
    const entries = await pairSidecars(await walkDirectoryHandle(root, {recursive: true}));
    const state = openBotBenchDialog();
    const originalWorker = globalThis.Worker;
    globalThis.Worker = undefined;
    try {
        state.solvers = ["gfKalman"];
        state.gpuSearchInput.checked = false;
        expect(state.trackOutputInput.checked).toBe(false);
        await analyzeEntries(state, entries);
        expect(state.entries[0].status).toBe("done");
        expect(root.children.has("output")).toBe(false);

        state.trackOutputInput.checked = true;
        const replay = analyzeEntries(state, entries);
        expect(state.trackOutputInput.disabled).toBe(true);
        await replay;
        const entry = state.entries[1];
        expect(entry.status).toBe("done");
        expect(entry.fromCache).toBe(true);
        expect(entry.rowReused).toBe(false);
        expect(entry.trackOutput).toMatchObject({written: true, path: "output/example.all.csv", samples: 15});
        const output = root.children.get("output").children.get(source.name);
        const lines = output.text.trimEnd().split("\r\n");
        expect(lines[0]).toBe(header);
        expect(lines).toHaveLength(16);
        expect(lines[1].split(",").slice(0, 3)).toEqual(["0007", "7.25", `sitrec_${entry.row.top.key}`]);
        expect(source.text).toBe(scenarioCSV());
        expect(all.children.has("output")).toBe(false);
        expect(state.status.textContent).toContain("Track output: 1 written, 0 skipped, 0 failed.");
        expect(state.trackOutputInput.disabled).toBe(false);
        expect((await walkDirectoryHandle(root, {recursive: true})).map(e => e.name)).toEqual([source.name]);
        expect(root.children.get("output").entries).not.toHaveBeenCalled();

        output.text = "old result";
        await writeTrackOutput(entry);
        expect(output.text).toBe(lines.join("\r\n") + "\r\n");

        // With a new directory and no stored fits, export uses the fresh result.
        const fresh = directory("tracks");
        const freshSource = await fresh.getFileHandle("fresh.input.csv", {create: true});
        freshSource.text = scenarioCSV();
        await analyzeEntries(state, await pairSidecars(await walkDirectoryHandle(fresh)));
        expect(state.entries[2].fromCache).toBe(false);
        expect(state.entries[2].trackOutput.written).toBe(true);
        expect(fresh.children.get("output").children.get(freshSource.name).text.split("\r\n")[0]).toBe(header);
    } finally {
        state.closeButton.onclick();
        globalThis.Worker = originalWorker;
    }
});

test("read-only or file-only entries never create an output directory", async () => {
    const dirHandle = directory("tracks");
    for (const entry of [{dirHandle, cacheWritable: false}, {}]) {
        expect(await writeTrackOutput(entry)).toMatchObject({written: false,
            reason: expect.stringContaining("Folder (Caching)")});
    }
    expect(dirHandle.getDirectoryHandle).not.toHaveBeenCalled();
});

test("dropped folders also exclude generated output, case-insensitively", async () => {
    const output = {name: "Output", isDirectory: true, createReader: jest.fn()};
    await collectFsEntry(output, "", [], true);
    expect(output.createReader).not.toHaveBeenCalled();
});

test("a failed write aborts the stream and preserves the error", async () => {
    const record = ingestBotCSV(scenarioCSV());
    const writable = {write: jest.fn().mockRejectedValue(new Error("disk full")),
        close: jest.fn(), abort: jest.fn()};
    const dirHandle = {name: "tracks", getDirectoryHandle: async () => ({
        getFileHandle: async () => ({createWritable: async () => writable}),
    })};
    await expect(writeTrackOutput({name: "x.csv", dirHandle, results: {...record, hypotheses: candidates(record)}}))
        .rejects.toThrow("disk full");
    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(writable.close).not.toHaveBeenCalled();
});
