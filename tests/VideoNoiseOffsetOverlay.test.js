/** @jest-environment jsdom */
jest.mock("../src/nodes/CNodeViewText", () => ({CNodeViewText: class {}}));
jest.mock("../src/Globals", () => ({NodeMan: {get: jest.fn()}, setRenderOne: jest.fn(), Sit: {}}));
jest.mock("../src/par", () => ({par: {frame: 900}}));
jest.mock("../src/i18n", () => ({t: key => key}));
jest.mock("../src/configUtils", () => ({isLocal: false}));
jest.mock("../src/CVideoLoadingManager", () => ({}));
jest.mock("../src/TimelineMenu", () => ({goToTimelineFrame: jest.fn()}));
jest.mock("../src/showError", () => ({}));
jest.mock("../src/VideoNoisePattern", () => ({setVideoNoisePatternTeardown: jest.fn()}));
jest.mock("../src/videoNoisePattern/NoisePatternJob", () => ({}));
jest.mock("../src/videoNoisePattern/NoisePatternCharts", () => ({}));
jest.mock("../src/videoQP/VideoQPAnalysis", () => ({displayIndexForFrame: (_, f) => f, frameForDisplayIndex: (_, f) => f}));

import {CNodeVideoNoisePatternView} from "../src/videoNoisePattern/CNodeVideoNoisePatternView";

const match = {source: 7, target: 135, x: 272, y: 272, tx: 160, ty: 544, width: 16, height: 128, dx: -112, dy: 272, screening: {passed: true}};
const context = () => ({drawImage: jest.fn(), strokeRect: jest.fn(), strokeText: jest.fn(), fillText: jest.fn()});
let view, videoView, ctx;
beforeEach(() => {
    ctx = context();
    view = Object.assign(Object.create(CNodeVideoNoisePatternView.prototype), {
        ui: {}, job: {result: {video: {width: 1280, height: 720}, offset: {matches: [match]}}},
        frameOf: f => f, overlayCaption: jest.fn(), refreshDisplay: jest.fn(),
        currentVideoData: () => videoView.videoData, goToOffset: jest.fn(), drawOffset: jest.fn(),
    });
    videoView = {videoData: {}, videoToCanvasCoordsOriginal: (x, y) => [10 + x / 2, 20 + y / 2]};
});
afterEach(() => jest.restoreAllMocks());

test("default offset navigation excludes scene and unchecked matches but explicit review preserves them", () => {
    view.job.result.offset.matches = [{...match, source: 1, screening: {passed: false}}, match, {...match, source: 3, screening: undefined}];
    expect(view.offsetMatches()).toEqual([match]);
    expect(view.offsetMatch()).toBe(match);
    view.toggle("offsetAmbiguous");
    expect(view.offsetMatches()).toHaveLength(3);
    expect(view.offsetMatch().source).toBe(1);
    view.toggle("offsetAmbiguous");
    expect(view.offsetMatch()).toBe(match);
});

test.each(["source", "target"])("aligns the other original ROI beside the %s in zoomed/panned video coordinates", role => {
    const pasted = {};
    jest.spyOn(view, "stripCanvas").mockReturnValue(pasted);
    view.drawOffsetOverlay(ctx, 640, 400, videoView, match, match[role]);
    const source = role === "source";
    expect(view.offsetPaste).toMatchObject({display: match[source ? "target" : "source"],
        a: source ? 160 : 272, b: source ? 176 : 288,
        top: source ? 544 : 272, bottom: source ? 672 : 400});
    // Original dy=272 is removed: the pasted target is at source y=272 (and vice versa).
    expect(ctx.drawImage).toHaveBeenCalledWith(pasted, source ? 157 : 79, source ? 156 : 292, 8, 64);
});

test("a patch at the right edge pastes to the left, and unrelated frames draw no stale patch", () => {
    jest.spyOn(view, "stripCanvas").mockReturnValue({});
    const edge = {...match, x: 1240};
    view.drawOffsetOverlay(ctx, 640, 400, videoView, edge, 7);
    expect(ctx.drawImage.mock.calls[0].slice(1)).toEqual([619, 156, 8, 64]);
    ctx.drawImage.mockClear();
    view.drawOffsetOverlay(ctx, 640, 400, videoView, edge, 900);
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(view.overlayCaption).toHaveBeenLastCalledWith(ctx, 640, 400, "videoNoisePattern.overlay.offsetOtherFrame");
});

test.each(["source", "target"])("original positions keeps both coordinates when viewing the %s frame", role => {
    const source = {}, target = {};
    jest.spyOn(view, "offsetResidualCanvases").mockReturnValue({source, target});
    view.ui.offsetResidual = true;
    view.toggle("offsetOriginalPositions");
    expect(view.ui.offsetOverlay).toBe(true);
    view.drawOffsetOverlay(ctx, 640, 400, videoView, match, match[role]);
    const draws = {source: [source, 146, 156, 8, 64], target: [target, 90, 292, 8, 64]};
    expect(ctx.drawImage.mock.calls).toEqual([draws[role], draws[role === "source" ? "target" : "source"]]);
    expect(ctx.strokeRect).toHaveBeenCalledWith(145, 155, 10, 66);
    expect(ctx.strokeRect).toHaveBeenCalledWith(89, 291, 10, 66);
    expect(view.overlayCaption).toHaveBeenLastCalledWith(ctx, 640, 400, "videoNoisePattern.overlay.offsetResidualOriginalCaption");
    view.toggle("offsetOriginalPositions");
    expect(view.ui.offsetResidual).toBe(true);
    ctx.drawImage.mockClear();
    view.drawOffsetOverlay(ctx, 640, 400, videoView, match, match[role]);
    expect(ctx.drawImage.mock.calls[1].slice(1)).toEqual(role === "source" ? [157, 156, 8, 64] : [79, 292, 8, 64]);
});

test("original positions clips a partially offscreen crop without relocating it", () => {
    const pasted = {};
    jest.spyOn(view, "stripCanvas").mockReturnValue(pasted);
    view.ui.offsetOriginalPositions = true;
    view.drawOffsetOverlay(ctx, 640, 400, videoView, {...match, tx: 1256}, 7);
    expect(ctx.drawImage).toHaveBeenCalledWith(pasted, 638, 292, 8, 64);
    expect(view.overlayCaption).toHaveBeenLastCalledWith(ctx, 640, 400, "videoNoisePattern.overlay.offsetOriginalCaption");
});

test("raw crops use the target y and playback adjustments while legacy columns retain full height", () => {
    const copyCtx = context();
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(copyCtx);
    const image = {width: 1280, height: 720};
    videoView.videoData.getImageNoPurge = jest.fn(() => image);
    videoView.getAdjustedVideoFrameSource = () => ({sourceImage: image, filter: "contrast(5)"});
    const item = {display: 135, a: 160, b: 176, top: 544, bottom: 672};
    const canvas = view.stripCanvas(item, videoView, videoView.videoData, "contrast5", 720, 1280);
    expect([canvas.width, canvas.height]).toEqual([16, 128]);
    expect(copyCtx.drawImage).toHaveBeenLastCalledWith(image, 160, 544, 16, 128, 0, 0, 16, 128);
    expect(copyCtx.filter).toBe("contrast(5)");
    view.stripCanvas({display: 135, a: 160, b: 176}, videoView, videoView.videoData, "contrast5", 720, 1280);
    expect(copyCtx.drawImage).toHaveBeenLastCalledWith(image, 160, 0, 16, 720, 0, 0, 16, 720);
});

test("residual display uses a single contrast mapping for both crops", () => {
    const contexts=[];
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
        const ctx={createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:jest.fn()}; contexts.push(ctx); return ctx;
    });
    const crop=values=>({width:4,height:1,pixels:Float32Array.from(values)});
    const m={...match,sourceCrop:crop([-4,0,1,4]),targetCrop:crop([-2,0,1,2])};
    const images=view.offsetResidualCanvases(m);
    expect(images.source.width).toBe(4);
    expect(contexts[0].putImageData.mock.calls[0][0].data[8]).toBe(160);
    expect(contexts[1].putImageData.mock.calls[0][0].data[8]).toBe(160);
    expect(view.offsetResidualCanvases(m)).toBe(images);
});

test("processed overlay draws both residual crops without fetching original pixels", () => {
    view.ui.offsetResidual=true;
    const source={},target={};
    jest.spyOn(view,"offsetResidualCanvases").mockReturnValue({source,target});
    jest.spyOn(view,"stripCanvas");
    view.drawOffsetOverlay(ctx,640,400,videoView,match,7);
    expect(view.stripCanvas).not.toHaveBeenCalled();
    expect(ctx.drawImage.mock.calls).toEqual([[source,146,156,8,64],[target,157,156,8,64]]);
    expect(view.overlayCaption).toHaveBeenLastCalledWith(ctx,640,400,"videoNoisePattern.overlay.offsetResidualCaption");
});

test("switching overlay modes preserves the column selection, and offset stepping seeks the new match", () => {
    const columnSelection = {source: 1, target: 33};
    view.job.result.selection = columnSelection;
    view.ui.overlay = true;
    view.toggle("offsetOverlay");
    expect(view.ui).toMatchObject({overlay: false, offsetOverlay: true});
    expect(view.goToOffset).toHaveBeenCalledWith("source");
    view.job.result.offset.matches.push({...match, source: 15, target: 143});
    view.stepOffset(1);
    expect(view.offsetMatch().source).toBe(15);
    expect(view.goToOffset).toHaveBeenCalledTimes(2);
    view.toggle("overlay");
    expect(view.ui).toMatchObject({overlay: true, offsetOverlay: false});
    expect(view.job.result.selection).toBe(columnSelection);
});
