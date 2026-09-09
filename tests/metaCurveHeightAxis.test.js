/** @jest-environment jsdom */
import {MetaBezierCurveEditor} from "../src/MetaCurveEdit";
import {getInteractionRouter} from "../src/InteractionRouter";

jest.mock("../src/Globals", () => ({Sit: {}, setRenderOne: jest.fn()}));
jest.mock("../src/utils", () => ({findStep: () => 1}));
jest.mock("../src/CViewManager", () => ({ViewMan: {iterate() {}}}));
jest.mock("../src/KeyBoardHandler", () => ({isKeyHeld: () => false}));

let editor, canvas, router, started, ended;
beforeEach(() => {
    canvas = document.createElement("canvas"); document.body.appendChild(canvas);
    canvas.width = 380; canvas.height = 340;
    Object.defineProperties(canvas, {clientWidth: {value: 380}, clientHeight: {value: 340}});
    canvas.getBoundingClientRect = () => ({left: 0, top: 0, width: 380, height: 340});
    canvas.getContext = () => new Proxy({}, {get: (target, key) => target[key] ?? (() => {})});
    started = jest.fn(); ended = jest.fn();
    editor = new MetaBezierCurveEditor({canvas, independentAxis: "y", minX: 0, maxX: 30, minY: 0, maxY: 1000,
        xStep: 5, yStep: 200, xLabel: "Temperature", yLabel: "Height", onChange: jest.fn(),
        onEditStart: started, onEditEnd: ended,
        points: [15, 0, 15, 100, 8, 300, 8, 200, 10, 1000, 10, 700]});
    router = getInteractionRouter(document);
    jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { editor.unregisterInteraction(); router.dispose(); canvas.remove(); jest.restoreAllMocks(); });

function pointer(target, type, value, height, extra = {}) {
    const e = new MouseEvent(type, {bubbles: true, cancelable: true, button: 0,
        buttons: type === "pointerup" ? 0 : 1, clientX: editor.D2CX(value), clientY: editor.D2CY(height), ...extra});
    Object.defineProperties(e, {pointerId: {value: 1}, pointerType: {value: "mouse"}});
    target.dispatchEvent(e);
}

test("temperature can cross adjacent values while height ordering and the selected anchor stay intact", () => {
    const anchor = editor.curve.ps[2];
    pointer(canvas, "pointerdown", 8, 300);
    pointer(document, "pointermove", 22, 300);
    expect(editor.selectedPoint).toBe(anchor);
    expect(editor.curve.ps[2]).toBe(anchor);
    expect(anchor.x).toBeCloseTo(22);
    expect(editor.curve.ps.filter((_, i) => i % 2 === 0).map(p => p.y)).toEqual([0, 300, 1000]);
    pointer(document, "pointerup", 22, 300);
    expect(started).toHaveBeenCalledTimes(1); expect(ended).toHaveBeenCalledTimes(1);
    expect(editor.selectedPoint).toBeNull();
});

test.each(["pointercancel", "blur", "Escape"])("%s ends preview mode and releases the selected point", reason => {
    pointer(canvas, "pointerdown", 8, 300); pointer(document, "pointermove", 12, 300);
    if (reason === "blur") window.dispatchEvent(new Event("blur"));
    else if (reason === "Escape") document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
    else pointer(canvas, reason, 12, 300);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(editor.selectedPoint).toBeNull();
    if (reason === "Escape") expect(editor.curve.ps[2].x).toBe(8);
});

test("adding an inversion point sorts by height, not temperature", () => {
    pointer(canvas, "pointerdown", 25, 500, {button: 2, buttons: 2});
    pointer(document, "pointerup", 25, 500, {button: 2});
    expect(editor.curve.ps.filter((_, i) => i % 2 === 0).map(p => p.y)).toEqual([0, 300, 500, 1000]);
    expect(editor.curve.ps[4].x).toBe(25);
});
