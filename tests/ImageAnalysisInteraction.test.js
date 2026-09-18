/** @jest-environment jsdom */
import {CNodeImageAnalysis} from "../src/nodes/CNodeImageAnalysis";
import {getInteractionRouter} from "../src/InteractionRouter";
import {UndoManager} from "../src/Globals";

jest.mock("../src/Globals", () => ({
    setRenderOne: jest.fn(), UndoManager: {add: jest.fn()}, Sit: {frames: 1},
    FileManager: {get: () => ({width: 4, height: 4})},
    gui: {add: () => ({onChange() { return this; }, listen() { return this; }, name() { return this; }})},
}));
jest.mock("../src/CViewManager", () => ({ViewMan: {}}));
jest.mock("../src/nodes/CNodeViewUI", () => ({CNodeViewUI: class {
    constructor(v) {
        this.id = v.id;
        this.widthPx = this.heightPx = 400;
        this.div = globalThis.document.createElement("div");
        this.canvas = globalThis.document.createElement("canvas");
        // Match the real UI view: pointer input goes to the div, not its canvas.
        this.canvas.style.pointerEvents = "none";
        this.div.appendChild(this.canvas);
        globalThis.document.body.appendChild(this.div);
        for (const element of [this.div, this.canvas]) {
            element.getBoundingClientRect = () => ({left: 0, top: 0, width: 400, height: 400});
        }
        this.in = {smooth: {v0: 0}};
    }
    input() {}
    updateWH() {}
}}));
jest.mock("../src/nodes/CNodeArray", () => ({CNodeArray: class {
    constructor(v) { this.array = v.array; }
}}));
jest.mock("../src/nodes/CNodeGraphSeries", () => ({CNodeGraphSeries: class {
    constructor(v) { this.inputs = {source: v.source}; }
}}));
jest.mock("../src/nodes/CNodeCurveEdit", () => ({CNodeCurveEditor: class {
    constructor(v) {
        this.inputs = v.inputs;
        this.editor = {max: {x: 0}};
        this.editorView = {recalculate: jest.fn()};
    }
}}));

let view;
function pointer(target, type, x, y) {
    const event = new MouseEvent(type, {bubbles: true, cancelable: true,
        clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1});
    Object.defineProperty(event, "pointerId", {value: 1});
    Object.defineProperty(event, "pointerType", {value: "mouse"});
    target.dispatchEvent(event);
}

beforeEach(() => {
    const pixels = new Uint8ClampedArray(4 * 4 * 4);
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) pixels.set([10 * x, 20 * y, 30, 255], 4 * (x + 4 * y));
    }
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
        drawImage() {}, getImageData: () => ({data: pixels}),
    });
    jest.spyOn(CNodeImageAnalysis.prototype, "makeImageFromPixels").mockImplementation(() => {});
    UndoManager.add.mockClear();
    view = new CNodeImageAnalysis({id: "analysis", filename: "image"});
    view.useFilter = view.normalize = false;
});

afterEach(() => {
    view.unregisterRegionInteraction();
    getInteractionRouter(document).dispose();
    document.body.replaceChildren();
    jest.restoreAllMocks();
});

test.each([1, 2])("a box drag analyzes the selected pixels at pixel ratio %s", ratio => {
    view.canvas.width = view.canvas.height = 400 * ratio;
    pointer(view.div, "pointerdown", 101, 101);
    pointer(document, "pointermove", 200, 200);
    pointer(document, "pointerup", 300, 300);

    expect(view.region.active).toBe(true);
    expect(view.region.rect.map(p => p.toArray())).toEqual([[100, 100], [300, 100], [300, 300], [100, 300]]);
    expect(view.columns[0]).toEqual([10, 20, 30]);
    expect(view.columns[1]).toEqual([40, 40, 40]);
    expect(view.columns[2]).toEqual([30, 30, 30]);
    expect(view.pixels[0]).toEqual([10, 20, 30, 255, 10, 40, 30, 255, 10, 60, 30, 255]);
    expect(view.graph.inputs.compare3.frames).toBe(3);
    expect(view.graph.inputs.compare3.inputs.source.array).toBe(view.columns[3]);
    expect(view.makeImageFromPixels).toHaveBeenCalled();
    expect(getInteractionRouter(document).session).toBeNull();
    expect(UndoManager.add).toHaveBeenCalledTimes(1);
});
