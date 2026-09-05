/** @jest-environment jsdom */
import {getInteractionRouter} from "../src/InteractionRouter";
import {UndoManager, Sit} from "../src/Globals";
import {CNodeVideoLevelsView} from "../src/nodes/CNodeVideoLevelsView";
import {CNodeVideoCurvesView} from "../src/nodes/CNodeVideoCurvesView";
import {CNodeCurveEditorView2} from "../src/nodes/CNodeCurveEdit2";
import {CRegionSelector} from "../src/CRegionSelector";

jest.mock("../src/Globals", () => ({setRenderOne: jest.fn(), markSitchDirty: jest.fn(),
    UndoManager: {add: jest.fn()}, NodeMan: {get: () => null}, Sit: {frames: 101, aFrame: 0, bFrame: 100}}));
jest.mock("../src/CEventManager", () => ({EventManager: {dispatchEvent: jest.fn()}}));
jest.mock("../src/CViewManager", () => ({ViewMan: {iterate() {}}}));
jest.mock("../src/nodes/CNodeTrack", () => ({CNodeTrack: class {}}));
jest.mock("../src/nodes/CNodeTabbedCanvasView", () => ({CNodeTabbedCanvasView: class {}}));
jest.mock("../src/nodes/CNodeViewCanvas", () => ({CNodeViewCanvas2D: class {
    constructor(v) { Object.assign(this, v); this.div = globalThis.document.createElement("div"); this.canvas = globalThis.document.createElement("canvas");
        this.div.appendChild(this.canvas); globalThis.document.body.appendChild(this.div); }
    dispose() { this.div.remove(); }
}}));

let router, roots;
function geometry(element) {
    element.getBoundingClientRect = () => ({left: 0, top: 0, width: 400, height: 400});
    Object.defineProperty(element, "clientWidth", {value: 400, configurable: true});
    Object.defineProperty(element, "clientHeight", {value: 400, configurable: true});
    return element;
}
function send(target, type, x, y, extra = {}) {
    const e = new MouseEvent(type, {clientX: x, clientY: y, bubbles: true, cancelable: true,
        buttons: type === "pointerup" ? 0 : 1, button: 0, ...extra});
    Object.defineProperty(e, "pointerId", {value: 1});
    Object.defineProperty(e, "pointerType", {value: extra.pointerType ?? "mouse"});
    target.dispatchEvent(e);
}
beforeEach(() => {
    roots = []; router = getInteractionRouter(document); UndoManager.add.mockClear();
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({}));
});
afterEach(() => {
    roots.forEach(r => { r.unregisterInteraction?.(); r.div?.remove(); });
    router.dispose(); jest.restoreAllMocks();
});
function videoEditor(Type) {
    const e = new Type({id: "testEditor", visible: true}); roots.push(e);
    geometry(e.div); geometry(e.canvas); e.widthPx = e.heightPx = 400;
    return e;
}

test("levels enforce ordered endpoints and interrupted movement has one undo", () => {
    const e = videoEditor(CNodeVideoLevelsView);
    const node = value => ({value, setValue(v) { this.value = v; }});
    e.videoView = {in: {levelsInputBlack: node(0), levelsInputWhite: node(255), levelsMidpoint: node(1),
        levelsOutputBlack: node(0), levelsOutputWhite: node(255)}, invalidateLevelsResult: jest.fn()};
    e.inputRect = {left: 0, right: 255, top: 50, bottom: 200, width: 255};
    e.handles = new Map([["inputBlack", {x: 0, y: 202}], ["inputWhite", {x: 255, y: 202}], ["midpoint", {x: 128, y: 202}]]);
    send(e.div, "pointerdown", 0, 202); send(document, "pointermove", 300, 202);
    window.dispatchEvent(new Event("blur"));
    expect(e.values().inputBlack).toBe(254); expect(e.draggingHandle).toBeNull();
    expect(UndoManager.add).toHaveBeenCalledTimes(1);
    UndoManager.add.mock.calls[0][0].undo(); expect(e.values().inputBlack).toBe(0);
    UndoManager.add.mock.calls[0][0].redo(); expect(e.values().inputBlack).toBe(254);
});

test("video curve insert and drag is rolled back by Escape", () => {
    const e = videoEditor(CNodeVideoCurvesView);
    e.graphRect = {left: 0, right: 255, top: 0, bottom: 255, width: 255, height: 255};
    send(e.div, "pointerdown", 128, 128); send(document, "pointermove", 150, 75);
    expect(e.points).toHaveLength(3);
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
    send(document, "pointerup", 175, 50);
    expect(e.points).toEqual([{x: 0, y: 0}, {x: 255, y: 1}]);
    expect(e.draggingPointIndex).toBe(-1); expect(UndoManager.add).not.toHaveBeenCalled();
});

test("the original curve mouse grab moves a point instead of inserting another", () => {
    const e = videoEditor(CNodeVideoCurvesView);
    e.graphRect = {left: 0, right: 255, top: 0, bottom: 255, width: 255, height: 255};
    e.points = [{x: 0, y: 0}, {x: 128, y: .5}, {x: 255, y: 1}];
    send(e.div, "pointerdown", 144, 127.5);
    expect(e.draggingPointIndex).toBe(1);
    send(e.div, "pointerup", 154, 127.5);
    expect(e.points).toHaveLength(3);
    expect(e.points[1].x).toBeCloseTo(138);
    expect(UndoManager.add).toHaveBeenCalledTimes(1);
});

test("curve endpoint padding works on the first touch and never leaks into mouse picking", () => {
    const e = videoEditor(CNodeVideoCurvesView);
    e.graphRect = {left: 50, right: 305, top: 50, bottom: 305, width: 255, height: 255};
    for (const pointerType of ["touch", "mouse", "touch"]) {
        send(e.div, "pointerdown", 30, 305, {pointerType});
        expect(e.draggingPointIndex).toBe(pointerType === "touch" ? 0 : -1);
        expect(!!router.session).toBe(pointerType === "touch");
        send(e.div, "pointerup", 30, 305, {pointerType});
        expect(e.points).toHaveLength(2);
    }
});

test("levels endpoint touch padding is available during probing and preserves the value", () => {
    const e = videoEditor(CNodeVideoLevelsView);
    const node = value => ({value, setValue(v) { this.value = v; }});
    e.videoView = {in: {levelsInputBlack: node(0), levelsInputWhite: node(255), levelsMidpoint: node(1),
        levelsOutputBlack: node(0), levelsOutputWhite: node(255)}, invalidateLevelsResult: jest.fn()};
    e.inputRect = {left: 50, right: 305, top: 50, bottom: 200, width: 255};
    e.handles = new Map([["inputBlack", {x: 50, y: 202}], ["inputWhite", {x: 305, y: 202}], ["midpoint", {x: 178, y: 202}]]);
    for (const pointerType of ["touch", "mouse", "touch"]) {
        send(e.div, "pointerdown", 30, 202, {pointerType});
        expect(e.draggingHandle).toBe(pointerType === "touch" ? "inputBlack" : null);
        expect(!!router.session).toBe(pointerType === "touch");
        send(e.div, "pointerup", 30, 202, {pointerType});
        expect(e.values().inputBlack).toBe(0);
    }
    expect(UndoManager.add).not.toHaveBeenCalled();
});

test("video curve Delete in an unrelated input cannot remove a point", () => {
    const e = videoEditor(CNodeVideoCurvesView);
    e.points.splice(1, 0, {x: 120, y: .4}); e.selectedPointIndex = 1;
    const input = document.createElement("input"); document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", {key: "Delete", bubbles: true}));
    expect(e.points).toHaveLength(3); input.remove();
});

test("focused video curve Delete removes one point with undo and redo", () => {
    const e = videoEditor(CNodeVideoCurvesView);
    e.points.splice(1, 0, {x: 120, y: .4}); e.selectedPointIndex = 1;
    e.div.dispatchEvent(new KeyboardEvent("keydown", {key: "Delete", bubbles: true}));
    expect(e.points).toHaveLength(2); expect(UndoManager.add).toHaveBeenCalledTimes(1);
    UndoManager.add.mock.calls[0][0].undo(); expect(e.points[1]).toEqual({x: 120, y: .4});
    UndoManager.add.mock.calls[0][0].redo(); expect(e.points).toHaveLength(2);
});

function currentCurve() {
    const e = Object.assign(Object.create(CNodeCurveEditorView2.prototype), {
        id: "curve", div: geometry(document.createElement("div")), canvas: geometry(document.createElement("canvas")),
        widthPx: 400, heightPx: 400, minX: 0, maxX: 100, minY: 0, maxY: 100,
        points: [{x: 0, y: 0}, {x: 50, y: 50}, {x: 100, y: 100}],
        draggedPointIndex: null, draggedLineIndex: null, defaultSnap: false, onChange: jest.fn(),
    });
    e.canvas.width = e.canvas.height = 400; e.div.appendChild(e.canvas); document.body.appendChild(e.div);
    e.setupMouseHandlers(); roots.push(e); return e;
}

test("current curve deletion finishes once and Escape can restore it", () => {
    const e = currentCurve();
    send(e.canvas, "pointerdown", 200, 200, {altKey: true});
    expect(e.points).toHaveLength(2);
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
    expect(e.points).toHaveLength(3); expect(UndoManager.add).not.toHaveBeenCalled();
    send(e.canvas, "pointerdown", 200, 200, {altKey: true}); send(document, "pointerup", 200, 200);
    expect(e.points).toHaveLength(2); expect(UndoManager.add).toHaveBeenCalledTimes(1);
});

test("current curve grab offset is retained through final release", () => {
    const e = currentCurve();
    send(e.canvas, "pointerdown", 206, 200); send(document, "pointerup", 220, 200);
    expect(e.points[1].x).toBeCloseTo(55); expect(e.points[1].y).toBeCloseTo(50);
    expect(UndoManager.add).toHaveBeenCalledTimes(1);
    expect(Sit.aFrame).toBe(0);
});

test.each(["ctrlKey", "metaKey"])("current curve %s adds one undoable point", modifier => {
    const e = currentCurve();
    send(e.canvas, "pointerdown", 250, 220, {[modifier]: true});
    send(document, "pointerup", 250, 220, {[modifier]: true});
    expect(e.points).toHaveLength(4); expect(UndoManager.add).toHaveBeenCalledTimes(1);
});

test("restoring a region preserves its point references and original activation", () => {
    const region = new CRegionSelector(), original = region.captureState();
    const first = region.dragpoints[0].point;
    region.active = true; region.rect[0].set(50, 75); region.center.set(80, 90);
    region.restoreState(original);
    expect(region.active).toBe(false); expect(region.rect[0]).toBe(first);
    expect(first.toArray()).toEqual([0, 0]); expect(region.center.toArray()).toEqual([0, 0]);
});
