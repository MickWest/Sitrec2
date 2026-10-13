/** @jest-environment jsdom */
import {webcrypto} from "node:crypto";
import {TextEncoder} from "node:util";
import {ingestBotCSV} from "../../src/analysis/BotBenchIngest";
import {compareTrackToTruth, trackMetrics} from "../../src/TraverseAnalysis";
import {rankAllHypotheses} from "../../src/TraverseRanking";
import {
    buildAllTracksOutputCSV, buildSeparateTrackOutputCSVs, buildTrackOutputCSV, separateTrackFileName,
    trackAlgorithmID, trackOutputBase, trackOutputLocation, trackOutputName, writeTrackOutput,
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

test("all-tracks CSV holds every finite candidate in blind rank order, whatever the truth", () => {
    const record = ingestBotCSV(scenarioCSV());
    const hypotheses = candidates(record);
    const results = {...record, hypotheses};
    const blind = buildAllTracksOutputCSV(results);
    expect(blind).toMatchObject({algorithmIDs: ["sitrec_constAir", "sitrec_horizontalSpeed"], samples: 15, omitted: 0});
    const lines = blind.csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(header);
    expect(lines).toHaveLength(1 + 2 * 15);
    expect(lines[1]).toBe("0007,7.25,sitrec_constAir,3000,2000,500,,,,,,");
    expect(lines[16]).toBe("0007,7.25,sitrec_horizontalSpeed,4000,3000,600,,,,,,");
    expect(lines[30]).toBe("0007,14.25,sitrec_horizontalSpeed,4028,3000,600,,,,,,");
    // The first block is the best-track file's candidate.
    expect(lines.slice(1, 16)).toEqual(buildTrackOutputCSV(results).csv.trimEnd().split("\r\n").slice(1));
    results.truth = {track: hypotheses[1].track};
    for (const h of hypotheses) h.truthComparison = compareTrackToTruth(record.dataset, h.track, results.truth);
    expect(rankAllHypotheses(hypotheses, {dataset: record.dataset})[0].h).toBe(hypotheses[1]);
    expect(buildAllTracksOutputCSV(results)).toEqual(blind);
});

test("all-tracks CSV leaves out direction-only and incomplete candidates, and counts them", () => {
    const record = ingestBotCSV(scenarioCSV());
    const [a, b] = candidates(record);
    const output = buildAllTracksOutputCSV({...record, hypotheses: [{...a, atInfinity: true}, b]});
    expect(output).toMatchObject({algorithmIDs: ["sitrec_horizontalSpeed"], omitted: 1});
    expect(output.csv.trimEnd().split("\r\n")).toHaveLength(16);
    b.track[4] = Infinity;
    expect(buildAllTracksOutputCSV({...record, hypotheses: [{...a, atInfinity: true}, b]}))
        .toEqual({reason: "No candidate has a complete finite track."});
    expect(buildAllTracksOutputCSV({...record, hypotheses: []})).toEqual({reason: "No candidate was produced."});
});

test("all-tracks output goes in output/AllTracks with the source filename", async () => {
    const parentHandle = {}, dirHandle = {name: "All"};
    expect(trackOutputLocation({name: "track.all.csv", dirPath: "batch/All", dirHandle, parentHandle}, "allCombined"))
        .toEqual({base: parentHandle, path: "batch/output/AllTracks/track.all.csv"});
    expect(trackOutputLocation({name: "clip.ts", dirPath: "", dirHandle: {name: "tracks"}}, "allCombined").path)
        .toBe("output/AllTracks/clip.ts.csv");

    const record = ingestBotCSV(scenarioCSV());
    const getFileHandle = jest.fn(async () => ({createWritable: async () => ({write: jest.fn(), close: jest.fn()})}));
    const allTracks = {getFileHandle};
    const output = {getDirectoryHandle: jest.fn(async () => allTracks)};
    const tracks = {name: "tracks", getDirectoryHandle: jest.fn(async () => output)};
    await expect(writeTrackOutput({name: "clip.ts", dirHandle: tracks, results: {...record, hypotheses: candidates(record)}},
        {mode: "allCombined"})).resolves.toEqual({written: true, path: "output/AllTracks/clip.ts.csv",
        algorithmIDs: ["sitrec_constAir", "sitrec_horizontalSpeed"], samples: 15, omitted: 0});
    expect(tracks.getDirectoryHandle).toHaveBeenCalledWith("output", {create: true});
    expect(output.getDirectoryHandle).toHaveBeenCalledWith("AllTracks", {create: true});
    expect(getFileHandle).toHaveBeenCalledWith("clip.ts.csv", {create: true});
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

test.each([
    ["clip.ts", "clip.ts.csv"], ["clip.klv", "clip.klv.csv"], ["track.csv", "track.csv"], ["TRACK.CSV", "TRACK.CSV"],
])("the output for %s is named %s", (source, expected) => {
    expect(trackOutputName(source)).toBe(expected);
    const dirHandle = {name: "tracks"};
    expect(trackOutputLocation({name: source, dirPath: "", dirHandle}).path).toBe(`output/${expected}`);
});

test("a non-CSV source writes a file with .csv added", async () => {
    const record = ingestBotCSV(scenarioCSV());
    const getFileHandle = jest.fn(async () => ({createWritable: async () => ({write: jest.fn(), close: jest.fn()})}));
    const dirHandle = {name: "tracks", getDirectoryHandle: async () => ({getFileHandle})};
    await expect(writeTrackOutput({name: "clip.ts", dirHandle, results: {...record, hypotheses: candidates(record)}}))
        .resolves.toMatchObject({written: true, path: "output/clip.ts.csv"});
    expect(getFileHandle).toHaveBeenCalledWith("clip.ts.csv", {create: true});
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
        removeEntry: jest.fn(async child => {
            if (!children.delete(child)) missing();
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
        expect(state.trackOutputInput.value).toBe("none");
        expect([...state.trackOutputInput.options].map(option => option.textContent))
            .toEqual(["None", "Best Track", "All Tracks Combined", "All Tracks Separate CSVs"]);
        await analyzeEntries(state, entries);
        expect(state.entries[0].status).toBe("done");
        expect(root.children.has("output")).toBe(false);

        state.trackOutputInput.value = "best";
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
        expect(root.children.get("output").children.has("AllTracks")).toBe(false);
        expect(state.trackOutputInput.disabled).toBe(false);
        expect((await walkDirectoryHandle(root, {recursive: true})).map(e => e.name)).toEqual([source.name]);
        expect(root.children.get("output").entries).not.toHaveBeenCalled();

        output.text = "old result";
        await writeTrackOutput(entry);
        expect(output.text).toBe(lines.join("\r\n") + "\r\n");

        // All Tracks Combined: every candidate goes to AllTracks, the best one first.
        state.trackOutputInput.value = "allCombined";
        await analyzeEntries(state, entries);
        const combined = state.entries[2];
        expect(combined.fromCache).toBe(true);
        expect(combined.trackOutput).toMatchObject({written: true, path: "output/AllTracks/example.all.csv", samples: 15});
        const ids = combined.trackOutput.algorithmIDs;
        expect(ids[0]).toBe(entry.trackOutput.algorithmID);
        expect(new Set(ids).size).toBe(ids.length);
        const allLines = root.children.get("output").children.get("AllTracks").children.get(source.name)
            .text.trimEnd().split("\r\n");
        expect(allLines[0]).toBe(header);
        expect(allLines).toHaveLength(1 + ids.length * 15);
        expect(allLines.slice(1, 16)).toEqual(lines.slice(1));
        expect(state.status.textContent).toContain("Track output: 1 written, 0 skipped, 0 failed.");

        // All Tracks Separate CSVs: one file per candidate, in a folder for the source.
        state.trackOutputInput.value = "allSeparate";
        await analyzeEntries(state, entries);
        const separate = state.entries[3];
        expect(separate.trackOutput).toMatchObject({written: true, path: "output/AllTracksSeparate/example.all",
            files: ids.length, algorithmIDs: ids, removed: 0});
        const folder = root.children.get("output").children.get("AllTracksSeparate").children.get("example.all");
        const fileName = id => `example.all_${id.replace(/^sitrec_/, "")}.csv`;
        expect([...folder.children.keys()].sort()).toEqual(ids.map(fileName).sort());
        ids.forEach((id, i) => {
            const fileLines = folder.children.get(fileName(id)).text.trimEnd().split("\r\n");
            expect(fileLines[0]).toBe(header);
            expect(fileLines.slice(1)).toEqual(allLines.slice(1 + i * 15, 16 + i * 15));
        });
        expect(state.status.textContent).toContain(`Track output: 1 written, 0 skipped, 0 failed (${ids.length} files).`);
        expect((await walkDirectoryHandle(root, {recursive: true})).map(e => e.name)).toEqual([source.name]);
        state.trackOutputInput.value = "best";

        // With a new directory and no stored fits, export uses the fresh result.
        const fresh = directory("tracks");
        const freshSource = await fresh.getFileHandle("fresh.input.csv", {create: true});
        freshSource.text = scenarioCSV();
        await analyzeEntries(state, await pairSidecars(await walkDirectoryHandle(fresh)));
        expect(state.entries[4].fromCache).toBe(false);
        expect(state.entries[4].trackOutput.written).toBe(true);
        expect(fresh.children.get("output").children.get(freshSource.name).text.split("\r\n")[0]).toBe(header);
    } finally {
        state.closeButton.onclick();
        globalThis.Worker = originalWorker;
    }
});

test("wind variants and sweep orders that share a key get their own AlgorithmID", () => {
    const record = ingestBotCSV(scenarioCSV());
    const [a, b] = candidates(record);
    const variants = [
        {...a, windMode: "supplied"}, {...a, windMode: "fitted", errDeg: 0.02},
        {...b, key: "gfPolyALS", params: {mcOrder: 2}}, {...b, key: "gfPolyALS", params: {mcOrder: 3}, errDeg: 0.05},
    ];
    expect(variants.map(trackAlgorithmID)).toEqual([
        "sitrec_constAir_suppliedWind", "sitrec_constAir_fittedWind", "sitrec_gfPolyALS_order2", "sitrec_gfPolyALS_order3",
    ]);
    const output = buildAllTracksOutputCSV({...record, hypotheses: variants});
    expect(new Set(output.algorithmIDs)).toEqual(new Set(variants.map(trackAlgorithmID)));
    const top = buildTrackOutputCSV({...record, hypotheses: variants});
    expect(top.algorithmID).toBe(output.algorithmIDs[0]);
    expect(top.csv.split("\r\n")[1].split(",")[2]).toBe(top.algorithmID);
    // Anything that would still share an identifier is counted, never merged.
    const same = buildAllTracksOutputCSV({...record, hypotheses: [a, {...a, errDeg: 0.02}, {...a, errDeg: 0.03}]});
    expect(same.algorithmIDs).toEqual(["sitrec_constAir", "sitrec_constAir_2", "sitrec_constAir_3"]);
    expect(new Set(same.csv.trimEnd().split("\r\n").slice(1).map(line => line.split(",")[2])).size).toBe(3);
});

test("a run that cannot write a file removes the file from an earlier run", async () => {
    const record = ingestBotCSV(scenarioCSV());
    const dirHandle = directory("tracks");
    const entry = {name: "x.csv", dirHandle, results: {...record, hypotheses: candidates(record)}};
    await writeTrackOutput(entry);
    await writeTrackOutput(entry, {mode: "allCombined"});
    const output = dirHandle.children.get("output");
    expect(output.children.has("x.csv")).toBe(true);
    expect(output.children.get("AllTracks").children.has("x.csv")).toBe(true);

    entry.results = {...record, hypotheses: candidates(record).map(h => ({...h, atInfinity: true}))};
    await expect(writeTrackOutput(entry)).resolves.toEqual({written: false, removed: true,
        reason: "The top candidate has no finite target position. The output file from an earlier run was removed."});
    await expect(writeTrackOutput(entry, {mode: "allCombined"})).resolves.toMatchObject({written: false, removed: true});
    expect(output.children.has("x.csv")).toBe(false);
    expect(output.children.get("AllTracks").children.has("x.csv")).toBe(false);
    await expect(writeTrackOutput(entry, {mode: "allCombined"})).resolves.toEqual({written: false, removed: false,
        reason: "No candidate has a complete finite track."});
    const empty = directory("empty");
    await expect(writeTrackOutput({...entry, dirHandle: empty}, {mode: "allCombined"})).resolves.toMatchObject({removed: false});
    expect(empty.children.size).toBe(0);
});

test("separate CSVs: one file per candidate, named <source>_<method>.csv, in a folder for the source", async () => {
    expect(trackOutputBase("track.all.csv")).toBe("track.all");
    expect(trackOutputBase("clip.ts")).toBe("clip.ts");
    expect(separateTrackFileName("track.all.csv", "lantern_fittedWind")).toBe("track.all_lantern_fittedWind.csv");
    expect(separateTrackFileName("clip.ts", "gfKalman")).toBe("clip.ts_gfKalman.csv");
    const parentHandle = {}, dirHandle = {name: "All"};
    expect(trackOutputLocation({name: "track.all.csv", dirPath: "batch/All", dirHandle, parentHandle}, "allSeparate"))
        .toEqual({base: parentHandle, path: "batch/output/AllTracksSeparate/track.all"});

    const record = ingestBotCSV(scenarioCSV());
    const [a, b] = candidates(record);
    const hypotheses = [{...a, windMode: "fitted"}, b];
    const separate = buildSeparateTrackOutputCSVs({...record, hypotheses});
    const combined = buildAllTracksOutputCSV({...record, hypotheses});
    expect(separate.files.map(file => file.method)).toEqual(["constAir_fittedWind", "horizontalSpeed"]);
    expect(separate).toMatchObject({algorithmIDs: combined.algorithmIDs, samples: 15, omitted: 0});
    // Together the separate files hold the rows of the combined file, in the same order.
    const body = text => text.trimEnd().split("\r\n").slice(1);
    expect(separate.files.flatMap(file => body(file.csv))).toEqual(body(combined.csv));
    expect(separate.files.every(file => file.csv.startsWith(header + "\r\n"))).toBe(true);

    const tracks = directory("tracks");
    await expect(writeTrackOutput({name: "x.csv", dirHandle: tracks, results: {...record, hypotheses}},
        {mode: "allSeparate"})).resolves.toEqual({written: true, path: "output/AllTracksSeparate/x", files: 2,
        removed: 0, algorithmIDs: ["sitrec_constAir_fittedWind", "sitrec_horizontalSpeed"], samples: 15, omitted: 0});
    const folder = tracks.children.get("output").children.get("AllTracksSeparate").children.get("x");
    expect([...folder.children.keys()]).toEqual(["x_constAir_fittedWind.csv", "x_horizontalSpeed.csv"]);
});

test("separate CSVs that a later run does not write are removed, and nothing else", async () => {
    const record = ingestBotCSV(scenarioCSV());
    const [a, b] = candidates(record);
    const tracks = directory("tracks");
    const entry = {name: "x.csv", dirHandle: tracks, results: {...record, hypotheses: [a, b]}};
    await writeTrackOutput(entry, {mode: "allSeparate"});
    const folder = tracks.children.get("output").children.get("AllTracksSeparate").children.get("x");
    // Files that are not this source's separate files stay.
    (await folder.getFileHandle("notes.txt", {create: true})).text = "keep";
    (await folder.getFileHandle("y_constAir.csv", {create: true})).text = "keep";
    await folder.getDirectoryHandle("x_sub.csv", {create: true});

    entry.results = {...record, hypotheses: [b]};
    await expect(writeTrackOutput(entry, {mode: "allSeparate"}))
        .resolves.toMatchObject({written: true, files: 1, removed: 1});
    expect([...folder.children.keys()].sort())
        .toEqual(["notes.txt", "x_horizontalSpeed.csv", "x_sub.csv", "y_constAir.csv"]);

    entry.results = {...record, hypotheses: [{...b, atInfinity: true}]};
    await expect(writeTrackOutput(entry, {mode: "allSeparate"})).resolves.toEqual({written: false, removed: 1,
        reason: "No candidate has a complete finite track. 1 output file(s) from an earlier run were removed."});
    expect([...folder.children.keys()].sort()).toEqual(["notes.txt", "x_sub.csv", "y_constAir.csv"]);
    // With no folder yet, nothing is created.
    const empty = directory("empty");
    await expect(writeTrackOutput({...entry, dirHandle: empty}, {mode: "allSeparate"}))
        .resolves.toEqual({written: false, removed: 0, reason: "No candidate has a complete finite track."});
    expect(empty.children.size).toBe(0);
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
