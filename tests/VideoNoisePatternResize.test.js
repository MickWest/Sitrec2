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
import {getInteractionRouter, INTERACTION} from "../src/InteractionRouter";
import {rebindSurfaceInteractions} from "../src/SurfaceInteraction";

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

// The scrub and the video pick go through the interaction router. jsdom has no PointerEvent,
// so these are MouseEvents with the pointer fields added, as in SurfaceInteraction.test.js.
function pointer(target, type, x = 50, extra = {}, Event = MouseEvent) {
    const e = new Event(type, {bubbles: true, cancelable: true, clientX: x, clientY: 10,
        button: 0, buttons: type === "pointerup" ? 0 : 1, ...extra});
    Object.defineProperty(e, "pointerId", {value: extra.pointerId ?? 1});
    Object.defineProperty(e, "pointerType", {value: "mouse"});
    Object.defineProperty(e, "isPrimary", {value: true});
    target.dispatchEvent(e);
    return e;
}
const shown = {left: 0, top: 0, width: 400, height: 20};

// A text window is a native boundary: it stops mouse events from bubbling (blockViewEvents).
function nativePanel(doc = document) {
    const panel = doc.createElement("div");
    panel.dataset.interactionNative = "";
    for (const type of ["mousedown", "mouseup", "click"]) panel.addEventListener(type, e => e.stopPropagation());
    doc.body.appendChild(panel);
    return panel;
}

describe("scrubbing the where strip", () => {
    let router, panel;
    beforeEach(() => {
        router = getInteractionRouter(document);
        panel = nativePanel();
        panel.appendChild(view.whereCanvas);
        view.whereCanvas.getBoundingClientRect = () => shown;
        jest.spyOn(view, "scrubWhere").mockImplementation(() => {});
        jest.spyOn(view, "selectAtCurrentFrame").mockImplementation(() => {});
    });
    afterEach(() => { router.dispose(); panel.remove(); });

    test("a press and a drag scrub, and the release selects the pair, inside a native panel", () => {
        const down = pointer(view.whereCanvas, "pointerdown", 50);
        expect(down.defaultPrevented).toBe(true);
        pointer(document, "pointermove", 80);
        pointer(document, "pointerup", 80);
        expect(view.scrubWhere).toHaveBeenCalledTimes(2);
        expect(view.selectAtCurrentFrame).toHaveBeenCalledTimes(1);
    });

    test("losing focus, hiding the window or a lost release cancels without selecting", () => {
        pointer(view.whereCanvas, "pointerdown", 50);
        window.dispatchEvent(new Event("blur"));
        pointer(document, "pointermove", 80);
        expect(view.scrubWhere).toHaveBeenCalledTimes(1);

        pointer(view.whereCanvas, "pointerdown", 50);
        view.whereCanvas.getBoundingClientRect = () => ({left: 0, top: 0, width: 0, height: 0});
        pointer(document, "pointermove", 80);
        view.whereCanvas.getBoundingClientRect = () => shown;
        expect(view.scrubWhere).toHaveBeenCalledTimes(2);

        pointer(view.whereCanvas, "pointerdown", 50);
        pointer(document, "pointermove", 80, {buttons: 0});
        pointer(document, "pointermove", 90);
        expect(view.scrubWhere).toHaveBeenCalledTimes(3);
        expect(view.selectAtCurrentFrame).not.toHaveBeenCalled();
    });

    test("a right press does not start a scrub", () => {
        pointer(view.whereCanvas, "pointerdown", 50, {button: 2, buttons: 2});
        expect(view.scrubWhere).not.toHaveBeenCalled();
    });

    test("in a popped-out window the scrub moves to that window's router", () => {
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const popup = iframe.contentWindow;
        nativePanel(popup.document).appendChild(view.whereCanvas);
        rebindSurfaceInteractions(view.whereCanvas);
        const popupRouter = getInteractionRouter(popup.document);
        pointer(view.whereCanvas, "pointerdown", 50, {}, popup.MouseEvent);
        pointer(popup.document, "pointermove", 80, {}, popup.MouseEvent);
        pointer(popup.document, "pointerup", 80, {}, popup.MouseEvent);
        expect(view.scrubWhere).toHaveBeenCalledTimes(2);
        expect(view.selectAtCurrentFrame).toHaveBeenCalledTimes(1);
        popupRouter.dispose();
        iframe.remove();
    });
});

describe("picking a strip in the video view", () => {
    let router, videoDiv, videoCanvas, navigation;
    beforeEach(() => {
        router = getInteractionRouter(document);
        videoDiv = document.createElement("div");
        videoCanvas = document.createElement("canvas");
        videoDiv.appendChild(videoCanvas);
        document.body.appendChild(videoDiv);
        // stands in for the video view's own pan adapter (CMouseHandler)
        navigation = {begin: jest.fn(), move: jest.fn(), end: jest.fn(), hover: jest.fn()};
        router.register({id: "video:test", navigation: true, priority: 0, ...navigation,
            hitTest: e => videoDiv.contains(e.target) ? {kind: INTERACTION.DRAG} : null});
        view.watchVideoClicks(videoDiv);
        jest.spyOn(view, "videoStripAt").mockReturnValue({sel: {}, k: 3});
        jest.spyOn(view, "clickVideo").mockImplementation(() => {});
    });
    afterEach(() => { view.watchVideoClicks(null); router.dispose(); videoDiv.remove(); });

    test("a click on a strip picks it and does not pan", () => {
        pointer(videoCanvas, "pointerdown", 50);
        pointer(document, "pointerup", 51);
        expect(view.clickVideo).toHaveBeenCalledTimes(1);
        expect(navigation.begin).not.toHaveBeenCalled();
    });

    test("a drag that starts on a strip pans the video and picks nothing", () => {
        pointer(videoCanvas, "pointerdown", 50);
        pointer(document, "pointermove", 70);
        pointer(document, "pointerup", 70);
        expect(view.clickVideo).not.toHaveBeenCalled();
        expect(navigation.begin).toHaveBeenCalledTimes(1);
        expect(navigation.move).toHaveBeenCalled();
    });

    test("a press away from the strips goes straight to the video", () => {
        view.videoStripAt.mockReturnValue(null);
        pointer(videoCanvas, "pointerdown", 50);
        pointer(document, "pointerup", 50);
        expect(view.clickVideo).not.toHaveBeenCalled();
        expect(navigation.begin).toHaveBeenCalledTimes(1);
    });

    test("hovering over a strip still reaches the video view", () => {
        pointer(videoCanvas, "pointermove", 50, {buttons: 0});
        expect(navigation.hover).toHaveBeenCalled();
    });

    test("letting go of the video view removes the pick", () => {
        view.watchVideoClicks(null);
        pointer(videoCanvas, "pointerdown", 50);
        pointer(document, "pointerup", 50);
        expect(view.clickVideo).not.toHaveBeenCalled();
    });
});
