jest.mock("../src/FileHandoff", () => ({createFileHandoffId: () => "local-token", putFileHandoff: jest.fn(), takeFileHandoff: jest.fn()}));
jest.mock("../src/Globals", () => ({Globals: {loadGeneration: 1}, NodeMan: {get: jest.fn()}, Sit: {frames: 9000}, setRenderOne: jest.fn()}));
jest.mock("../src/CVideoLoadingManager", () => ({VideoLoadingManager: {isLoading: jest.fn(() => false)}}));
jest.mock("../src/UpdateSitFrames", () => ({clampSitFrameRange: jest.fn()}));
jest.mock("../src/VideoNoisePattern", () => ({clampNoisePatternOptions: o => ({...o}), showVideoNoisePattern: jest.fn()}));
jest.mock("../src/videoNoisePattern/NoisePatternFile", () => ({readNoisePatternFile: jest.fn().mockResolvedValue({scan: {analysisFrames: 240}})}));
import {createNoisePatternFileLink, runNoisePatternHandoff} from "../src/videoNoisePattern/NoisePatternHandoff";
import {putFileHandoff} from "../src/FileHandoff";
import {NodeMan, Sit} from "../src/Globals";
import {showVideoNoisePattern} from "../src/VideoNoisePattern";
import {readNoisePatternFile} from "../src/videoNoisePattern/NoisePatternFile";

beforeEach(() => jest.clearAllMocks());

function directoryOf(file) {
    const child = {async *entries() { yield [file.name, {kind: "file", getFile: async () => file}]; }};
    return {async *entries() { yield ["child", child]; }};
}

test("a path link transfers the local file with settings and its exact shortened region once", async () => {
    const file = {name: "clip.mp4"};
    const options = {longestLag: 128, detail: 4, vertical: 1, held: "picture", searchOn: "cpu", limitMinutes: 2};
    const transfer = createNoisePatternFileLink(directoryOf(file), {path: "child/clip.mp4", status: "done", frames: 725}, options,
        "https://example.test/sitrec/?custom=old#frame");
    expect(transfer.url).toBe("https://example.test/sitrec/?action=new&handoff=local-token&npd=1");
    await Promise.all([transfer.prepare(), transfer.prepare()]);
    expect(putFileHandoff).toHaveBeenCalledTimes(1);
    expect(putFileHandoff).toHaveBeenCalledWith([file], {source: "npd-folder-scan", relativePath: "child/clip.mp4", noisePattern: {options, frames: 725}}, "local-token");
    expect(readNoisePatternFile).not.toHaveBeenCalled();
});

test("opening an unfinished scan computes the same bounded region before handing it over", async () => {
    const file = {name: "clip.mp4"};
    const options = {limitMinutes: 2, detail: 8};
    const transfer = createNoisePatternFileLink(directoryOf(file), {path: "child/clip.mp4", status: "queued"}, options, "https://example.test/");
    await transfer.prepare();
    expect(readNoisePatternFile).toHaveBeenCalledWith(file, options);
    expect(putFileHandoff.mock.calls[0][1].noisePattern.frames).toBe(240);
});

test("the receiving tab opens NPD with the same source frames and search settings", async () => {
    NodeMan.get.mockReturnValue({videoData: {chunks: new Array(9000), config: {}, groups: [{}], videoSpeed: 1.5}});
    await runNoisePatternHandoff({noisePattern: {frames: 3600, options: {longestLag: 128, detail: 4, held: "picture", searchOn: "cpu"}}});
    expect(Sit.aFrame).toBe(0);
    expect(Sit.bFrame).toBe(5399);
    expect(showVideoNoisePattern).toHaveBeenCalledWith(true, {noisePatternOptions: {longestLag: 128, detail: 4, held: "picture", searchOn: "cpu", frames: "ab"}});
});
