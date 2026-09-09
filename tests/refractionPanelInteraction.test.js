/** @jest-environment jsdom */
import {RefractionTool} from "../src/refraction/RefractionTool";
import {getInteractionRouter} from "../src/InteractionRouter";
import {registerSurfaceInteraction} from "../src/SurfaceInteraction";

jest.mock("../src/Globals", () => ({Sit: {}, NodeMan: {get: () => null, list: {}},
    setRenderOne: jest.fn(), markSitchDirty: jest.fn()}));
jest.mock("../src/LocalFrame", () => ({GlobalScene: {add: jest.fn()}}));
jest.mock("../src/CViewManager", () => ({ViewMan: {iterate() {}}}));
jest.mock("../src/KeyBoardHandler", () => ({isKeyHeld: () => false}));
jest.mock("../src/MetaCurveEdit", () => ({}));
jest.mock("../src/refraction/RefractionPass", () => ({}));
jest.mock("../src/refraction/refraction.css", () => ({}));

let tool, panel, header, router, navigation;
const rect = {left: 10, top: 20, width: 680, height: 780};
function pointer(target, type, x = 50, extra = {}) {
    const event = new MouseEvent(type, {bubbles: true, cancelable: true, clientX: x, clientY: 60,
        button: 0, buttons: type === "pointerup" ? 0 : 1, ...extra});
    Object.defineProperties(event, {pointerId: {value: 1}, pointerType: {value: "mouse"}});
    target.dispatchEvent(event);
    return event;
}

beforeEach(() => {
    global.ResizeObserver = class { observe() {} disconnect() {} };
    // Exercise the real panel shell and router without rendering the graphs/GPU.
    for (const name of ["buildAtmosphere", "buildRays", "buildLasers", "resizeGraphs", "animate"]) {
        jest.spyOn(RefractionTool.prototype, name).mockImplementation(() => {});
    }
    router = getInteractionRouter(document);
    navigation = {id: "scene", hitTest: () => ({kind: "drag"}), hitSurface: () => ({}),
        begin: jest.fn(), move: jest.fn(), wheel: jest.fn()};
    router.register(navigation);
    tool = new RefractionTool(); tool.show(); panel = tool.panel;
    header = panel.querySelector(".rf-header");
    panel.getBoundingClientRect = () => rect;
    header.getBoundingClientRect = () => ({...rect, height: 70});
});
afterEach(() => { tool.dispose(); router.dispose(); jest.restoreAllMocks(); delete global.ResizeObserver; });

test("header release outside the dialog finishes dragging without moving the scene", () => {
    pointer(header, "pointerdown");
    pointer(document, "pointermove", 70);
    pointer(document, "pointerup", 90);
    expect(panel.style.left).toBe("50px");
    expect(tool.drag).toBeNull(); expect(router.session).toBeNull();
    pointer(header, "pointermove", 200, {buttons: 0});
    expect(panel.style.left).toBe("50px");
    expect(navigation.begin).not.toHaveBeenCalled(); expect(navigation.move).not.toHaveBeenCalled();
});

test.each(["pointercancel", "lostpointercapture", "blur", "buttons released", "hide", "destroy"])(
    "%s cannot leave the dialog stuck to the pointer", reason => {
        pointer(header, "pointerdown"); pointer(document, "pointermove", 70);
        if (reason === "blur") window.dispatchEvent(new Event("blur"));
        else if (reason === "buttons released") pointer(document, "pointermove", 100, {buttons: 0});
        else if (reason === "hide") tool.hide();
        else if (reason === "destroy") tool.destroyPanel();
        else pointer(header, reason);
        expect(tool.drag).toBeNull(); expect(router.session).toBeNull();
        pointer(header, "pointermove", 200, {buttons: 0});
        expect(panel.style.left).toBe("30px");
    });

test("Escape restores the dialog position and releases the gesture", () => {
    pointer(header, "pointerdown"); pointer(document, "pointermove", 70);
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
    expect(panel.style.left).toBe(""); expect(panel.style.right).toBe("");
    expect(tool.drag).toBeNull(); expect(router.session).toBeNull();
});

test("wheel stays inside the panel without cancelling its native scroll", () => {
    const event = new WheelEvent("wheel", {bubbles: true, cancelable: true, deltaY: 100});
    panel.querySelector(".rf-body").dispatchEvent(event);
    expect(navigation.wheel).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
});

test("the native boundary preserves controls and registered graph gestures", () => {
    const input = panel.querySelector("input[type=checkbox]");
    expect(pointer(input, "pointerdown").defaultPrevented).toBe(false);
    expect(router.session).toBeNull(); expect(navigation.begin).not.toHaveBeenCalled();
    const canvas = document.createElement("canvas"); panel.querySelector(".rf-body").appendChild(canvas);
    canvas.getBoundingClientRect = () => rect;
    const move = jest.fn(), end = jest.fn(), wheel = jest.fn();
    const unregister = registerSurfaceInteraction(canvas, {move, end, wheel});
    try {
        pointer(canvas, "pointerdown"); pointer(document, "pointerup", 70);
        expect(move).toHaveBeenCalledTimes(1); expect(end).toHaveBeenCalledTimes(1);
        canvas.dispatchEvent(new WheelEvent("wheel", {bubbles: true, cancelable: true, deltaY: 100}));
        expect(wheel).toHaveBeenCalledTimes(1); expect(navigation.wheel).not.toHaveBeenCalled();
    } finally { unregister(); }
});
