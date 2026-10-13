/** @jest-environment jsdom */
jest.mock("../src/VideoExporter", () => ({createVideoExporter: jest.fn(), checkCodecAtResolution: jest.fn()}));
jest.mock("../src/videoQP/VideoQPAnalysis", () => ({sourceVideoOf: v => v.source || v}));
jest.mock("../src/i18n", () => ({t: key => key}));

import {createVideoExporter, checkCodecAtResolution} from "../src/VideoExporter";
import {centeredOffsetFrame, exportNoiseOffsetFade, overlapFadeTargetWeight, OFFSET_FADE_FRAMES} from "../src/videoNoisePattern/NoiseOffsetFadeExport";

const match = {source: 7, target: 135, x: 272, y: 272, tx: 160, ty: 544, width: 16, height: 128};
let source, exporter, contexts, captures;
beforeEach(() => {
    const image = {width: 1280, height: 720};
    source = {videoSpeed: 2, getImageNoPurge: jest.fn(() => image), waitForFrame: jest.fn()};
    contexts = []; captures = [];
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function () {
        const context = {fillRect: jest.fn(), drawImage: jest.fn(), globalAlpha: 1};
        contexts.push(context); return context;
    });
    exporter = {initialize: jest.fn(), addFrame: jest.fn((canvas, index) => {
        captures.push({width: canvas.width, height: canvas.height, index, alpha: contexts[2].drawImage.mock.calls.length});
    }), finalize: jest.fn(() => new Blob(["mp4"], {type: "video/mp4"})), dispose: jest.fn()};
    checkCodecAtResolution.mockResolvedValue({supported: true});
    createVideoExporter.mockResolvedValue(exporter);
});
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

test("four second schedule contains 15 hold, 30 fade, 15 hold frames and their exact reverse", () => {
    const alpha = Array.from({length: OFFSET_FADE_FRAMES}, (_, i) => overlapFadeTargetWeight(i));
    expect(alpha.slice(0, 15)).toEqual(Array(15).fill(0));
    expect(alpha.slice(15, 45).every(x => x > 0 && x < 1)).toBe(true);
    expect(alpha.slice(45, 75)).toEqual(Array(30).fill(1));
    expect(alpha.slice(105)).toEqual(Array(15).fill(0));
    expect(alpha).toEqual([...alpha].reverse());
    expect(alpha[15]).toBeCloseTo(1 / 60);
    expect(alpha[44]).toBeCloseTo(59 / 60);
});

test("whole native frames translate their matching centers to the same output center", () => {
    const image = {};
    centeredOffsetFrame(image, 1280, 720, match.x, match.y, match.width, match.height);
    centeredOffsetFrame(image, 1280, 720, match.tx, match.ty, match.width, match.height);
    expect(contexts[0].drawImage).toHaveBeenCalledWith(image, 360, 24);
    expect(contexts[1].drawImage).toHaveBeenCalledWith(image, 472, -248);
    expect(contexts[1].fillRect).toHaveBeenCalledWith(0, 0, 1280, 720);
});

test("exports 120 frames as MP4 from the underlying video, independent of timeline patches", async () => {
    const result = await exportNoiseOffsetFade({videoData: {source}, match, width: 1280, height: 720});
    expect(source.getImageNoPurge.mock.calls).toEqual([[14], [270]]);
    expect(createVideoExporter).toHaveBeenCalledWith("mp4-h264", expect.objectContaining({width: 1280, height: 720, fps: 30}));
    expect(captures).toHaveLength(120);
    expect(captures[119]).toMatchObject({index: 119, width: 1280, height: 720});
    expect(result).toMatchObject({frames: 120, duration: 4, fps: 30});
    expect(result.blob.type).toBe("video/mp4");
    expect(exporter.dispose).toHaveBeenCalledTimes(1);
});

test("cancellation releases the encoder and never finalizes a partial fade", async () => {
    let cancelled = false;
    await expect(exportNoiseOffsetFade({videoData: source, match, width: 1280, height: 720,
        onProgress: () => { cancelled = true; }, isCancelled: () => cancelled,
    })).rejects.toMatchObject({name: "AbortError"});
    expect(exporter.addFrame).toHaveBeenCalledTimes(1);
    expect(exporter.finalize).not.toHaveBeenCalled();
    expect(exporter.dispose).toHaveBeenCalledTimes(1);
});

test("a missing original frame fails instead of exporting stale or blank pixels", async () => {
    source.getImageNoPurge.mockReturnValue(null);
    await expect(exportNoiseOffsetFade({videoData: source, match, width: 1280, height: 720})).rejects.toThrow("frameUnavailable");
    expect(source.waitForFrame).toHaveBeenCalledWith(14);
    expect(createVideoExporter).not.toHaveBeenCalled();
});

test("unsupported MP4 fails without substituting another container", async () => {
    checkCodecAtResolution.mockResolvedValue({supported: false, reason: "unavailable"});
    await expect(exportNoiseOffsetFade({videoData: source, match, width: 1280, height: 720})).rejects.toThrow("unsupported");
    expect(createVideoExporter).not.toHaveBeenCalled();
});
