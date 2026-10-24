/** @jest-environment jsdom */
// CNodeCompassUI.dispose() on a phone or tablet. It used to remove touch listeners
// through this.handleTouchStart.bind(this) and friends, methods that no longer exist
// since the compass moved to the interaction router, so on mobile it threw before
// super.dispose(). NodeMan.disposeAll() has no try/catch, so every sitch switch and
// File > New stopped half way through tearing down a sitch with a compass in it.

window.matchMedia ??= () => ({matches: false, addEventListener() {}, removeEventListener() {}});

// Same inert Globals as tests/mouseCancellation.test.js, with isMobile on.
jest.mock("../src/Globals", () => {
    const state = {isMobile: true, showCompassElevation: false};
    const inert = new Proxy({}, {get: (_, key) => key === "then" ? undefined : inert});
    return new Proxy({}, {get: (_, key) => key === "Globals" ? state : () => inert});
});

const {CNodeCompassUI} = require("../src/nodes/CNodeCompassUI");
const {CNodeViewUI} = require("../src/nodes/CNodeViewUI");
const {getInteractionRouter} = require("../src/InteractionRouter");

test("dispose() on mobile does not throw, and removes the compass's interaction", () => {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    canvas.getBoundingClientRect = () => ({width: 100, height: 100});
    const compass = Object.create(CNodeCompassUI.prototype);
    Object.assign(compass, {canvas, activateCompass: jest.fn()});
    compass.installInteraction();
    // The view teardown itself is not under test here.
    const parentDispose = jest.spyOn(CNodeViewUI.prototype, "dispose").mockImplementation(() => {});

    const router = getInteractionRouter();
    const tap = {pointerType: "touch", pointerId: 1, button: 0, buttons: 1, clientX: 10, clientY: 10,
        target: canvas, preventDefault() {}, stopImmediatePropagation() {}};
    try {
        router.down(tap);
        router.up({...tap, buttons: 0});
        expect(compass.activateCompass).toHaveBeenCalledTimes(1);

        expect(() => compass.dispose()).not.toThrow();
        expect(parentDispose).toHaveBeenCalledTimes(1);

        router.down({...tap, pointerId: 2});
        router.up({...tap, pointerId: 2, buttons: 0});
        expect(compass.activateCompass).toHaveBeenCalledTimes(1);
    } finally {
        parentDispose.mockRestore(); router.dispose(); canvas.remove();
    }
});
