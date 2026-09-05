/** @jest-environment jsdom */

window.matchMedia ??= () => ({matches: false, addEventListener() {}, removeEventListener() {}});

// Permit the node graph's module initialization; the gestures below use real
// methods with model hooks spied so accidental commits remain observable.
jest.mock("../src/Globals", () => {
    const state = {isMobile: true, showCompassElevation: false};
    const inert = new Proxy({}, {get: (_, key) => key === "then" ? undefined : inert});
    return new Proxy({}, {get: (_, key) => key === "Globals" ? state : () => inert});
});

const {Globals} = require("../src/Globals");
const {CNodeFitCameraPoints} = require("../src/nodes/CNodeFitCameraPoints");
const {CNodeCompassUI} = require("../src/nodes/CNodeCompassUI");
const {mouseMethods} = require("../src/nodes/CNodeView3DMouse");
const {DRAG} = require("../src/mouseMoveView");

function fitHost() {
    return Object.assign(Object.create(CNodeFitCameraPoints.prototype), {
        pendingAdd: {pointerId: 7, cx: 100, cy: 100}, draggingId: null,
        finishPendingAdd: jest.fn(), syncActiveKeyframe: jest.fn(),
        invalidateKeyframes: jest.fn(), requestFit: jest.fn(), endUndo: jest.fn(),
    });
}

test("canceled fit click cannot become a point addition on a later release", () => {
    const fit = fitHost();
    fit.onMouseCancel({pointerId: 7});
    fit.onMouseUp({pointerId: 7, button: 0});
    expect(fit.pendingAdd).toBeNull();
    expect(fit.finishPendingAdd).not.toHaveBeenCalled();
    expect(fit.endUndo).not.toHaveBeenCalled();
});

test("a different pointer's cancellation leaves a pending fit click intact", () => {
    const fit = fitHost();
    fit.onMouseCancel({pointerId: 8});
    expect(fit.pendingAdd).toEqual({pointerId: 7, cx: 100, cy: 100});
});

test("a missed fit-click release is canceled when no buttons remain pressed", () => {
    const fit = fitHost();
    fit.trackPendingAdd({pointerId: 7, buttons: 0});
    expect(fit.pendingAdd).toBeNull();
});

test("interrupted fit-point movement preserves its keyframe and finishes undo once", () => {
    const fit = fitHost();
    fit.pendingAdd = null;
    fit.draggingId = "point1";
    fit._dragMoved = true;
    fit.onMouseCancel(new Event("blur"));
    fit.onMouseCancel({pointerId: 7});
    fit.onMouseUp({pointerId: 7});
    expect(fit.draggingId).toBeNull();
    expect(fit.syncActiveKeyframe).toHaveBeenCalledTimes(1);
    expect(fit.invalidateKeyframes).toHaveBeenCalledWith("active");
    expect(fit.requestFit).toHaveBeenCalledTimes(1);
    expect(fit.endUndo).toHaveBeenCalledTimes(1);
});

test("canceled traffic selection clears the click without promoting it", () => {
    const view = {_trafficClick: {hex: "abc123"}, dragMode: 1, mouseDown: true,
        _completeTrafficClick: jest.fn()};
    mouseMethods.onMouseCancel.call(view);
    expect(view._trafficClick).toBeNull();
    expect(view.dragMode).toBe(DRAG.NONE);
    expect(view.mouseDown).toBe(false);
    expect(view._completeTrafficClick).not.toHaveBeenCalled();
});

test("canceling the compass session prevents its click and pending long press", () => {
    const {getInteractionRouter} = require("../src/InteractionRouter");
    jest.useFakeTimers();
    const canvas = document.createElement("canvas"); document.body.appendChild(canvas);
    canvas.getBoundingClientRect = () => ({width: 100, height: 100});
    const compass = {canvas, activateCompass: jest.fn(), toggleARMode: jest.fn(), in: {relativeTo: {id: "lookView"}}};
    CNodeCompassUI.prototype.installInteraction.call(compass);
    const router = getInteractionRouter();
    const event = {pointerType: "touch", pointerId: 1, button: 0, buttons: 1, clientX: 10, clientY: 10,
        target: canvas, preventDefault() {}, stopImmediatePropagation() {}};
    try {
        router.down(event);
        router.cancelPointer(event);
        jest.advanceTimersByTime(1000);
        router.up({...event, buttons: 0});
        expect(compass.activateCompass).not.toHaveBeenCalled();
        expect(compass.toggleARMode).not.toHaveBeenCalled();
    } finally {
        compass.unregisterCompassInteraction(); router.dispose(); canvas.remove(); jest.useRealTimers();
    }
});
