/** @jest-environment jsdom */
jest.mock("../src/nodes/CNodeViewText", () => ({CNodeViewText: class {
    constructor(options) {
        Object.assign(this, options);
        this.outputArea = globalThis.document.createElement("div");
    }
    renderCanvas() {}
    dispose() {}
}}));
jest.mock("../src/Globals", () => ({NodeMan: {get: () => null}, setRenderOne: jest.fn(), Sit: {frames: 100}}));
jest.mock("../src/par", () => ({par: {frame: 0}}));
jest.mock("../src/i18n", () => ({t: key => key}));
jest.mock("../src/configUtils", () => ({isLocal: false}));
jest.mock("../src/CVideoLoadingManager", () => ({VideoLoadingManager: {isLoading: () => false}}));
jest.mock("../src/TimelineMenu", () => ({goToTimelineFrame: jest.fn()}));
jest.mock("../src/showError", () => ({showChoice: jest.fn()}));
jest.mock("../src/VideoNoisePattern", () => ({clampNoisePatternOptions: () => ({}), setVideoNoisePatternTeardown: jest.fn()}));
jest.mock("../src/videoNoisePattern/NoisePatternJob", () => ({terminateNoisePatternWorkers: jest.fn()}));
jest.mock("../src/videoNoisePattern/NoisePatternCharts", () => ({
    ...jest.requireActual("../src/videoNoisePattern/NoisePatternCharts"),
    drawLagChart: jest.fn(), drawWhereStrip: jest.fn(), drawPairImages: jest.fn(),
}));

import {CNodeVideoNoisePatternView} from "../src/videoNoisePattern/CNodeVideoNoisePatternView";
import {drawLagChart, drawPairImages, drawWhereStrip} from "../src/videoNoisePattern/NoisePatternCharts";

let view, dimensions;
beforeEach(() => {
    global.ResizeObserver = class {
        constructor(callback) { this.callback = callback; }
        observe() {}
        disconnect = jest.fn();
    };
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({setTransform() {}});
    view = new CNodeVideoNoisePatternView({id: "resizeTest", visible: true});
    dimensions = {width: 640, height: 480};
    Object.defineProperties(view.outputArea, {
        clientWidth: {get: () => dimensions.width},
        clientHeight: {get: () => dimensions.height},
    });
    view.layoutObserver.callback();
    jest.clearAllMocks();
});
afterEach(() => {
    view.dispose();
    delete global.ResizeObserver;
    jest.restoreAllMocks();
});

test("resizing a paused window redraws all canvases to the available width without a render tick", () => {
    dimensions.width = 128;
    view.layoutObserver.callback();

    for (const canvas of [view.chartCanvas, view.whereCanvas, view.pairCanvas]) {
        expect(canvas.width).toBe(112);
        expect(canvas.style.width).toBe("112px");
    }
    expect(drawLagChart).toHaveBeenCalledTimes(1);
    expect(drawWhereStrip).toHaveBeenCalledTimes(1);
    expect(drawPairImages).toHaveBeenCalledTimes(1);
    view.layoutObserver.callback();
    expect(drawLagChart).toHaveBeenCalledTimes(1);

    dimensions.height = 200;
    view.layoutObserver.callback();
    expect(drawLagChart).toHaveBeenCalledTimes(2);
});

test("popped-out windows keep rendering and resize while the main view is hidden", () => {
    expect(view.renderWhileWindowed).toBe(true);
    view.windowed = true;
    view.analysisVideo = null;
    dimensions.width = 320;
    view.renderCanvas(0);
    expect(view.chartCanvas.width).toBe(304);
    expect(view.pairCanvas.width).toBe(304);
});

test("hidden windows defer their redraw and disposing stops resize observation", () => {
    view.visible = false;
    dimensions.width = 320;
    view.layoutObserver.callback();
    expect(drawLagChart).not.toHaveBeenCalled();
    view.visible = true;
    view.layoutObserver.callback();
    expect(view.chartCanvas.width).toBe(304);
    view.dispose();
    expect(view.layoutObserver.disconnect).toHaveBeenCalled();
});

test("a click ends scrubbing on release even when another handler stops bubbling", () => {
    jest.spyOn(view, "scrubWhere").mockImplementation(() => {});
    jest.spyOn(view, "selectAtCurrentFrame").mockImplementation(() => {});
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    parent.appendChild(view.whereCanvas);
    const parentDown = jest.fn();
    parent.addEventListener("mousedown", parentDown);
    const stop = event => event.stopPropagation();
    view.whereCanvas.addEventListener("mouseup", stop);
    view.whereCanvas.dispatchEvent(new MouseEvent("mousedown", {button: 0, buttons: 1, bubbles: true}));
    view.whereCanvas.dispatchEvent(new MouseEvent("mouseup", {button: 0, buttons: 0, bubbles: true}));
    window.dispatchEvent(new MouseEvent("mousemove", {buttons: 0}));
    expect(view.scrubWhere).toHaveBeenCalledTimes(1);
    expect(view.selectAtCurrentFrame).toHaveBeenCalledTimes(1);
    expect(parentDown).not.toHaveBeenCalled();
    expect(view.whereDragCleanup).toBeNull();
    parent.remove();
});

test("scrubbing uses the popup's window and ends if the button is no longer held", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const popup = iframe.contentWindow;
    popup.document.body.appendChild(view.whereCanvas);
    jest.spyOn(view, "scrubWhere").mockImplementation(() => {});
    jest.spyOn(view, "selectAtCurrentFrame").mockImplementation(() => {});
    view.whereCanvas.dispatchEvent(new popup.MouseEvent("mousedown", {button: 0, buttons: 1, bubbles: true}));
    popup.dispatchEvent(new popup.MouseEvent("mousemove", {buttons: 1}));
    popup.dispatchEvent(new popup.MouseEvent("mousemove", {buttons: 0}));
    popup.dispatchEvent(new popup.MouseEvent("mousemove", {buttons: 1}));
    expect(view.scrubWhere).toHaveBeenCalledTimes(2);
    expect(view.selectAtCurrentFrame).toHaveBeenCalledTimes(1);
    expect(view.whereDragCleanup).toBeNull();
    iframe.remove();
});

test("losing focus or hiding the window cancels scrubbing, and right clicks do not start it", () => {
    jest.spyOn(view, "scrubWhere").mockImplementation(() => {});
    jest.spyOn(view, "selectAtCurrentFrame").mockImplementation(() => {});
    view.whereCanvas.dispatchEvent(new MouseEvent("mousedown", {button: 2, buttons: 2}));
    expect(view.scrubWhere).not.toHaveBeenCalled();
    view.whereCanvas.dispatchEvent(new MouseEvent("mousedown", {button: 0, buttons: 1}));
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new MouseEvent("mousemove", {buttons: 1}));
    expect(view.scrubWhere).toHaveBeenCalledTimes(1);
    view.whereCanvas.dispatchEvent(new MouseEvent("mousedown", {button: 0, buttons: 1}));
    view.release();
    window.dispatchEvent(new MouseEvent("mousemove", {buttons: 1}));
    expect(view.scrubWhere).toHaveBeenCalledTimes(2);
    expect(view.selectAtCurrentFrame).not.toHaveBeenCalled();
});
