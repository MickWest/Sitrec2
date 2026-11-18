const mockViews = [];
const mockNode = {update: jest.fn()};
jest.mock("../src/Globals", () => ({
    Sit: {fps: 30}, GlobalDateTimeNode: {update: jest.fn()},
    NodeMan: {get list() { return {test: {data: mockNode}}; }, preRenderAll: jest.fn(), getPostRenderNodes: () => []},
}));
jest.mock("../src/CViewManager", () => ({ViewMan: {
    updateZOrder() {}, computeEffectiveVisibility() {}, iterate: fn => mockViews.forEach(v => fn(v.id, v)),
}}));
jest.mock("../src/LocalFrame", () => ({GlobalScene: {updateMatrixWorld() {}}, LocalFrame: null}));
jest.mock("../src/par", () => ({par: {frame: 0}}));
jest.mock("../src/VideoExporter", () => ({getCanvasDisplayRect: v => v.rect}));
jest.mock("../src/videoFilters/VideoFormatLayer", () => ({
    getVideoFormatExportSettings: () => null, createVideoFormatExportLayer: async () => null,
}));
jest.mock("../src/utils", () => ({drawVideoWatermark: ctx => ctx.drawImage("watermark")}));
jest.mock("../src/AttributionOverlay", () => ({drawAttributionOnCanvas: ctx => ctx.drawImage("attribution")}));
jest.mock("../src/CObjectTracking", () => ({getPointTrackOverlays: () => []}));
jest.mock("../src/CMotionAnalysisUI", () => ({getMotionAnalysisOverlays: () => null}));

import {createSingleViewCapture, singleViewCaptureSize} from "../src/SingleViewCapture";
import {encodeRenderedImage} from "../src/ImageExporter";
import {padVideoFrame} from "../src/VideoFrameCanvas";

const savedDocument = global.document;
beforeEach(() => {
    mockViews.length = 0;
    global.document = {createElement: () => {
        const ctx = {drawImage: jest.fn(), fillRect: jest.fn()};
        return {width: 0, height: 0, getContext: () => ctx};
    }};
});
afterAll(() => { global.document = savedDocument; });

test("single-view capture includes visible labels at the exported letterbox coordinates", async () => {
    const view = {id: "lookView", canvas: {width: 400, height: 300}, exportVideo() {},
        leftPx: 100, topPx: 20, widthPx: 600, heightPx: 500,
        rect: {x: 100, y: 50, width: 400, height: 300}, renderCanvas: jest.fn()};
    const labels = {id: "labels", overlayView: view, _effectivelyVisible: true,
        canvas: {width: 600, height: 500, style: {}}, leftPx: 100, topPx: 20,
        widthPx: 600, heightPx: 500, renderCanvas: jest.fn(), transparency: 0.5};
    const hidden = {...labels, id: "hidden", canvas: {...labels.canvas, style: {display: "none"}}, renderCanvas: jest.fn()};
    mockViews.push(view, labels, hidden);
    const capture = await createSingleViewCapture(view);
    await capture.render(12);
    const canvas = capture.finish(), draw = canvas.getContext("2d").drawImage;
    expect(view.renderCanvas).toHaveBeenCalledWith(12);
    expect(labels.renderCanvas).toHaveBeenCalledWith(12);
    expect(hidden.renderCanvas).not.toHaveBeenCalled();
    expect(mockNode.update).toHaveBeenCalledWith(12);
    expect(draw).toHaveBeenCalledWith(labels.canvas, -100, -50, 600, 500);
    expect(draw.mock.calls.slice(-2)).toEqual([["watermark"], ["attribution"]]);
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(300);
});

test("video preview uses the same even-dimension padding as the encoder", () => {
    const source = {width: 555, height: 869};
    const padded = padVideoFrame(source);
    expect([padded.width, padded.height]).toEqual([556, 870]);
    expect(padded.getContext("2d").drawImage).toHaveBeenCalledWith(source, 0, 0);
    expect(padded.getContext("2d").fillRect).toHaveBeenCalledWith(0, 0, 556, 870);
    expect(padVideoFrame(padded)).toBe(padded);
    expect(singleViewCaptureSize({canvas: {}, widthPx: 555, heightPx: 869})).toEqual({width: 555, height: 869});
});

test("still-image compression defaults to PNG and uses independent JPEG quality", async () => {
    const canvas = {toBlob: jest.fn((done, mime, quality) => done({type: mime, quality}))};
    expect((await encodeRenderedImage(canvas)).type).toBe("image/png");
    expect(await encodeRenderedImage(canvas, {format: "jpeg", quality: 0.7})).toEqual({type: "image/jpeg", quality: 0.7});
});
