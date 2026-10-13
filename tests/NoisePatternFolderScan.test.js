jest.mock("../src/videoNoisePattern/NoisePatternFile", () => ({
    analyzeNoisePatternFile: jest.fn(),
    checkNoisePatternAbort: signal => { if (signal?.aborted) throw Object.assign(new Error("Stopped"), {name: "AbortError"}); },
    isNoisePatternVideoName: name => /\.(mp4|mov|webm)$/i.test(name),
}));
import {createNoisePatternFolderScan, noisePatternFolderCSV, summarizeNoisePatternResult} from "../src/videoNoisePattern/NoisePatternFolderScan";

const file = name => ({kind: "file", getFile: async () => ({name})});
const folder = (name, contents) => ({kind: "directory", name, async *entries() { yield* Object.entries(contents); }});
const result = (kind = "none") => ({status: "done", verdict: {kind}, video: {frames: 200}, counts: {decoded: 200}});

test("walks nested and empty folders, analyzes every video sequentially, and retains per-file/folder errors", async () => {
    let running = 0;
    const analyze = jest.fn(async (f, options) => {
        expect(++running).toBe(1);
        expect(options).toMatchObject({frames: "all", range: null, longestLag: 128});
        await Promise.resolve();
        running--;
        if (f.name === "bad.mov") throw new Error("Damaged file");
        return result();
    });
    const denied = {kind: "directory", async *entries() { throw new Error("Read denied"); }};
    const scan = createNoisePatternFolderScan({analyze});
    const state = await scan.run(folder("chosen", {"root.MP4": file("root.MP4"), "notes.txt": file("notes.txt"),
        nested: folder("nested", {"bad.mov": file("bad.mov"), empty: folder("empty", {})}), denied}),
    {frames: "ab", range: {from: 4, to: 10}, longestLag: 128});
    expect(state.status).toBe("done");
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(state.folders).toEqual([".", "nested", "nested/empty", "denied"]);
    expect(state.errors).toEqual([{path: "denied", error: "Read denied"}]);
    expect(state.rows.map(r => [r.path, r.status])).toEqual([["nested/bad.mov", "error"], ["root.MP4", "done"]]);
    expect(state.completed).toBe(2);
    expect(state.rows.every(r => !r.getFile && !r.progress)).toBe(true);
});

test("stop aborts the active file, preserves completed results, and marks the remaining files stopped", async () => {
    let scan;
    const analyze = jest.fn(async (f, options, {signal}) => {
        if (f.name === "b.mp4") {
            scan.stop();
            expect(signal.aborted).toBe(true);
            throw Object.assign(new Error("Stopped"), {name: "AbortError"});
        }
        return result("repeat");
    });
    scan = createNoisePatternFolderScan({analyze});
    const state = await scan.run(folder("chosen", {"a.mp4": file("a.mp4"), "b.mp4": file("b.mp4"), "c.mp4": file("c.mp4")}));
    expect(state.status).toBe("stopped");
    expect(state.completed).toBe(1);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(state.rows.map(r => r.status)).toEqual(["done", "stopped", "stopped"]);
    expect(state.errors).toEqual([]);
});

test("stop during discovery does not start any analysis", async () => {
    const analyze = jest.fn();
    let scan;
    scan = createNoisePatternFolderScan({analyze, onUpdate: state => { if (state.folders.length > 1) scan.stop(); }});
    const state = await scan.run(folder("chosen", {nested: folder("nested", {}), "video.mp4": file("video.mp4")}));
    expect(state.status).toBe("stopped");
    expect(analyze).not.toHaveBeenCalled();
});

test("retains strength, coverage, picture controls, ranges and failures without retaining feature arrays", () => {
    const summary = summarizeNoisePatternResult({...result("repeat"),
        verdict: {kind: "repeat", period: 32, strength: 12.4, strengthLabel: "strong", coverage: 6, references: 8, curve: "S-Cb"},
        precise: {tested: 100, matched: 80, runs: [[3, 120]], m: new Float32Array(200)},
        pictureRepeat: {repeats: true}, counts: {decoded: 190, failed: 10, held: 2},
        longRange: {lag: 128}, timings: {total: 1000}});
    expect(summary).toMatchObject({kind: "repeat", period: 32, strength: 12.4, coverage: 6, references: 8,
        pictureRepeat: true, decoded: 190, failed: 10, matched: 80, runs: [[3, 120]]});
    expect(summary.precise).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain('"m":');
    const isolated = summarizeNoisePatternResult({...result("isolated"), verdict: {kind: "isolated", isolated: [{z: 6, curve: "S-Y", lag: 14}, {z: 9, curve: "A-Yfine", lag: 40}]}});
    expect(isolated).toMatchObject({kind: "isolated", strength: 9, period: null, curve: "A-Yfine"});
    const short = summarizeNoisePatternResult({...result("cannot"), verdict: {kind: "cannot", frames: 127},
        counts: {frames: 322, decoded: 322, held: 195, validAny: 127, valid: [127, 127, 127]}});
    expect(short).toMatchObject({frames: 322, decoded: 322, held: 195, usable: 127, minUsableFrames: 136});
});

test("CSV quotes relative paths, errors and every result status", () => {
    const csv = noisePatternFolderCSV([{path: 'a/"b,c".mp4', status: "error", error: "bad\nfile"}, {path: "d.mp4", status: "stopped"}]);
    expect(csv).toContain('"a/""b,c"".mp4"');
    expect(csv).toContain('"bad\nfile"');
    expect(csv).toContain('"stopped"');
});


test("folder summary retains offset-only discoveries without carrying pixel crops", () => {
    const summary = summarizeNoisePatternResult({...result("none"), offset: {status: "done", pairs: 73,
        matches: [{score: 0.81, screening: {passed: true}, sourceCrop: {pixels: new Float32Array(128)}}, {score: 0.99, screening: {passed: false}}]}});
    expect(summary).toMatchObject({kind: "none", offsetStatus: "done", offsetCandidates: 1, offsetScore: 0.81, offsetPairs: 73});
    expect(JSON.stringify(summary)).not.toContain("pixels");
    expect(noisePatternFolderCSV([summary])).toContain("offsetCandidates");
    expect(summary.offsetSuppressed).toBe(1);
});
