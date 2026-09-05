/** @jest-environment jsdom */
// Drag completion, button isolation and viewport coordinate regressions.
import {beforeEach, afterEach, expect, jest, test} from "@jest/globals";
import {CMouseHandler} from "../src/CMouseHandler";
import {ViewMan} from "../src/CViewManager";
import {mouseInViewOnly, mouseToNDC} from "../src/ViewUtils";
import {SetupMouseHandler, onDocumentMouseDown, onDocumentMouseMove, onDocumentMouseUp, onDocumentMouseCancel, screenToNDC} from "../src/mouseMoveView";
import {CNodeMaskOverlay} from "../src/nodes/CNodeMaskOverlay";
import {makeResizable, removeResizable} from "../src/DragResizeUtils";
import {MetaBezierCurveEditor} from "../src/MetaCurveEdit";

jest.mock("../src/CViewManager", () => ({ViewMan: {screenOffsetX: 0, iterate: jest.fn(), iterateVisibleIncludingOverlays: jest.fn()}}));
jest.mock("../src/KeyBoardHandler", () => ({isKeyHeld: () => false}));
jest.mock("../src/Globals", () => ({setRenderOne: jest.fn()}));
jest.mock("../src/nodes/CNodeTrackingOverlay", () => ({CNodeActiveOverlay: class {}}));
jest.mock("../src/UndoManager", () => ({}));
jest.mock("../src/FlowAlignment", () => ({}));
jest.mock("../src/CEventManager", () => ({}));
jest.mock("../src/par", () => ({}));

let views;
const event = (type, x = 100, y = 100, button = 0) => new MouseEvent(type, {bubbles: true, cancelable: true, clientX: x, clientY: y, button, buttons: button === 2 ? 2 : 1});
const pane = (id) => ({id, visible: true, zIndex: 3, leftPx: 0, topPx: 0, widthPx: 800, heightPx: 600});

beforeEach(() => {
    document.body.innerHTML = "";
    document.elementFromPoint = () => document.body;
    views = [];
    ViewMan.iterate.mockImplementation(fn => views.forEach(v => fn(v.id, v)));
    ViewMan.iterateVisibleIncludingOverlays.mockImplementation(fn => views.forEach(v => fn(v.id, v)));
    onDocumentMouseUp(event("pointerup"));
});
afterEach(() => onDocumentMouseUp(event("pointerup")));

test("NDC helpers agree for a letterboxed pane", () => {
    const view = pane("lookView");
    view.div = {getBoundingClientRect: () => ({left: 0, top: 0, width: 800, height: 600})};
    view.canvas = {getBoundingClientRect: () => ({left: 0, top: 75, width: 800, height: 450})};
    expect(mouseToNDC(view, 400, 150).y).toBeCloseTo(2 / 3);
    expect(screenToNDC(view, 400, 150).y).toBeCloseTo(2 / 3);
});

test("shared hit testing rejects a hidden zero-area pane with stale logical bounds", () => {
    const view = {...pane("mainView"), _effectivelyVisible: false, div: {getBoundingClientRect: () => ({width: 0, height: 0})}};
    expect(mouseInViewOnly(view, 100, 100)).toBe(false);
});

test("document pointer-up applies the final movement before completing", () => {
    const view = {...pane("view"), onMouseDown: () => true, onMouseDrag: jest.fn(), onMouseUp: jest.fn()};
    views = [view];
    onDocumentMouseDown(event("pointerdown", 100, 100));
    const up = event("pointerup", 150, 160);
    onDocumentMouseUp(up);
    expect(view.onMouseDrag).toHaveBeenCalledWith(up, 150, 160, 50, 60);
    expect(view.onMouseUp).toHaveBeenCalledWith(up, 150, 160);
    expect(view.onMouseDrag.mock.invocationCallOrder[0]).toBeLessThan(view.onMouseUp.mock.invocationCallOrder[0]);
});

test("pointer cancellation clears the document router owner", () => {
    const view = {...pane("view"), onMouseDown: () => true, onMouseDrag: jest.fn()};
    views = [view];
    SetupMouseHandler();
    document.dispatchEvent(event("pointerdown"));
    document.dispatchEvent(event("pointercancel"));
    document.dispatchEvent(new MouseEvent("pointermove", {bubbles: true, clientX: 110, clientY: 110, buttons: 0}));
    expect(view.onMouseDrag).not.toHaveBeenCalled();
});

test.each([1, 2])("mask declines navigation button %s", button => {
    const mask = Object.assign(Object.create(CNodeMaskOverlay.prototype), pane("mask"), {
        editing: true, overlayView: {canvasToVideoCoords: (x, y) => [x, y]},
        unrotateCanvasCoords: (x, y) => [x, y], ensureMaskInitialized() {}, drawLineTo: jest.fn(),
    });
    expect(mask.onMouseDown(event("pointerdown", 100, 100, button), 100, 100)).toBe(false);
    expect(mask.isDrawing).not.toBe(true);
    expect(mask.drawLineTo).not.toHaveBeenCalled();
});

test("resizing stops after pointer cancellation and disposal", () => {
    const element = document.createElement("div");
    element.getBoundingClientRect = () => ({left: 0, top: 0, width: 200, height: 200});
    document.body.appendChild(element);
    makeResizable(element, {handles: "e"});
    const handle = element._resizeHandles.e;
    handle.getBoundingClientRect = () => ({left: 195, top: 0, width: 10, height: 200});
    handle.dispatchEvent(event("pointerdown", 200, 100));
    document.dispatchEvent(event("pointermove", 210, 100));
    document.dispatchEvent(event("pointercancel", 210, 100));
    document.dispatchEvent(event("pointermove", 220, 100));
    expect(element.style.width).toBe("210px");
    handle.dispatchEvent(event("pointerdown", 200, 100));
    removeResizable(element);
    document.dispatchEvent(event("pointermove", 240, 100));
    expect(element.style.width).toBe("210px");
    document.dispatchEvent(event("pointerup", 240, 100));
});

test("legacy curve right-click deletes one pair without adding a replacement", () => {
    const points = Array.from({length: 6}, (_, i) => ({x: i, y: i}));
    const removed = points[2];
    const editor = Object.assign(Object.create(MetaBezierCurveEditor.prototype), {
        curve: {ps: points}, insideGraph: () => true,
        selectPointAt() { this.selectedPoint = this.curve.ps[2]; this.selectedPointIndex = 2; },
        C2DX: x => x, C2DY: y => y, recalculate: jest.fn(), onChange: jest.fn(),
    });
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
        editor.mouseDown({button: 2, layerX: 100, layerY: 100, preventDefault() {}, stopPropagation() {}});
    } finally { log.mockRestore(); }
    expect(points).not.toContain(removed);
    expect(points).toHaveLength(4);
    expect(points.some(p => p.x === 100 && p.y === 100)).toBe(false);
    expect(editor.onChange).toHaveBeenCalledTimes(1);
});

test.each(["pointercancel", "blur", "lostpointercapture"])("%s completes once at the last valid position", type => {
    const view = {...pane("view"), onMouseDown: () => true, onMouseDrag: jest.fn(), onMouseUp: jest.fn()};
    views = [view];
    onDocumentMouseDown(event("pointerdown"));
    onDocumentMouseMove(event("pointermove", 120, 130));
    onDocumentMouseCancel(event(type, 0, 0));
    onDocumentMouseCancel(event(type, 0, 0));
    expect(view.onMouseUp).toHaveBeenCalledTimes(1);
    expect(view.onMouseUp.mock.calls[0].slice(1)).toEqual([120, 130]);
    expect(view.onMouseDrag).toHaveBeenCalledTimes(1);
});

test("a different pointer or button cannot move or release a document drag", () => {
    const pointer = (type, id, x, button = 0) => Object.assign(event(type, x, 100, button), {pointerId: id});
    const view = {...pane("view"), onMouseDown: () => true, onMouseDrag: jest.fn(), onMouseUp: jest.fn()};
    views = [view];
    onDocumentMouseDown(pointer("pointerdown", 7, 100));
    onDocumentMouseMove(pointer("pointermove", 8, 200));
    onDocumentMouseUp(pointer("pointerup", 8, 200));
    onDocumentMouseUp(pointer("pointerup", 7, 200, 2));
    expect(view.onMouseUp).not.toHaveBeenCalled();
    expect(view.onMouseDrag).not.toHaveBeenCalled();
    onDocumentMouseUp(pointer("pointerup", 7, 120));
    expect(view.onMouseUp).toHaveBeenCalledTimes(1);
});

test("buttons=0 recovery ends an edit without applying unpressed movement", () => {
    const view = {...pane("view"), onMouseDown: () => true, onMouseDrag: jest.fn(), onMouseUp: jest.fn()};
    views = [view];
    onDocumentMouseDown(event("pointerdown"));
    onDocumentMouseMove(new MouseEvent("pointermove", {clientX: 500, clientY: 500, buttons: 0}));
    expect(view.onMouseDrag).not.toHaveBeenCalled();
    expect(view.onMouseUp).toHaveBeenCalledTimes(1);
    expect(view.onMouseUp.mock.calls[0].slice(1)).toEqual([100, 100]);
});

test("cancellation uses the owner's cancel action rather than completing a pending click", () => {
    const view = {...pane("view"), onMouseDown: () => true, onMouseCancel: jest.fn(), onMouseUp: jest.fn()};
    views = [view];
    onDocumentMouseDown(event("pointerdown"));
    onDocumentMouseCancel(event("pointercancel"));
    onDocumentMouseUp(event("pointerup"));
    expect(view.onMouseCancel).toHaveBeenCalledTimes(1);
    expect(view.onMouseUp).not.toHaveBeenCalled();
});

test("canvas cancellation notifies its editor once and cannot open a later context menu", () => {
    const canvas = document.createElement("canvas");
    canvas.setPointerCapture = jest.fn();
    canvas.releasePointerCapture = jest.fn();
    const handlers = {up: jest.fn(), contextMenu: jest.fn()};
    const mouse = new CMouseHandler({canvas}, handlers);
    mouse.handleMouseDown(event("pointerdown", 100, 100, 2));
    mouse.handlePointerCancel(event("pointercancel"));
    mouse.handlePointerCancel(event("pointercancel"));
    mouse.handleMouseUp(event("pointerup", 100, 100, 2));
    expect(handlers.up).toHaveBeenCalledTimes(1);
    expect(handlers.contextMenu).not.toHaveBeenCalled();
});

test("resize applies release coordinates and ends exactly once", () => {
    const element = document.createElement("div");
    element.getBoundingClientRect = () => ({left: 0, top: 0, width: 200, height: 200});
    document.body.appendChild(element);
    const end = jest.fn();
    makeResizable(element, {handles: "e", onResizeEnd: end});
    element._resizeHandles.e.getBoundingClientRect = () => ({left: 195, top: 0, width: 10, height: 200});
    element._resizeHandles.e.dispatchEvent(event("pointerdown", 200, 100));
    document.dispatchEvent(event("pointerup", 250, 100));
    removeResizable(element);
    expect(element.style.width).toBe("250px");
    expect(end).toHaveBeenCalledTimes(1);
    expect(end.mock.calls[0][1].cancelled).toBe(false);
});
