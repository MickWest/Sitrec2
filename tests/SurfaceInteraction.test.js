/** @jest-environment jsdom */
import {registerSurfaceInteraction, rebindSurfaceInteractions} from "../src/SurfaceInteraction";
import {getInteractionRouter} from "../src/InteractionRouter";
import {UndoManager} from "../src/Globals";
import {makeDraggable, makeResizable, removeDraggable, removeResizable} from "../src/DragResizeUtils";
import {LayoutMan} from "../src/CLayoutManager";
import {ViewMan} from "../src/CViewManager";

jest.mock("../src/Globals", () => ({setRenderOne: jest.fn(), UndoManager: {add: jest.fn()}}));
jest.mock("../src/CViewManager", () => ({ViewMan: {iterate() {}}}));
jest.mock("../src/KeyBoardHandler", () => ({isKeyHeld: () => false}));

const rect = {left: 10, top: 20, width: 200, height: 150};
let root, router, cleanup;
function pointer(target, type, x = 50, extra = {}) {
    const e = new MouseEvent(type, {bubbles: true, cancelable: true, clientX: x, clientY: 60,
        button: 0, buttons: type === "pointerup" ? 0 : 1, ...extra});
    Object.defineProperty(e, "pointerId", {value: extra.pointerId ?? 1});
    Object.defineProperty(e, "pointerType", {value: extra.pointerType ?? "mouse"});
    target.dispatchEvent(e);
    return e;
}
function tool(extra = {}) {
    let value = 0;
    const end = jest.fn();
    cleanup = registerSurfaceInteraction(root, {
        snapshot: () => value, restore: state => value = state,
        begin: () => {}, move: (e, dx) => value += dx, end, undo: "Edit value", ...extra,
    });
    return {value: () => value, end};
}
beforeEach(() => {
    root = document.createElement("div");
    root.getBoundingClientRect = () => rect;
    document.body.appendChild(root);
    router = getInteractionRouter(document);
    UndoManager.add.mockClear();
});
afterEach(() => { cleanup?.(); router.dispose(); root.remove(); });

test("release applies the last displacement, groups undo and restores both directions", () => {
    const t = tool();
    pointer(root, "pointerdown");
    pointer(document, "pointermove", 70);
    pointer(document, "pointerup", 90);
    expect(t.value()).toBe(40);
    expect(t.end).toHaveBeenCalledTimes(1);
    expect(UndoManager.add).toHaveBeenCalledTimes(1);
    const action = UndoManager.add.mock.calls[0][0];
    action.undo(); expect(t.value()).toBe(0);
    action.redo(); expect(t.value()).toBe(40);
});

test.each(["pointercancel", "lostpointercapture", "blur", "hidden", "dispose"])("%s preserves one completed edit", reason => {
    const t = tool();
    pointer(root, "pointerdown"); pointer(document, "pointermove", 70);
    if (reason === "blur") window.dispatchEvent(new Event("blur"));
    else if (reason === "hidden") {
        root.getBoundingClientRect = () => ({width: 0, height: 0});
        pointer(document, "pointermove", 90);
    } else if (reason === "dispose") cleanup();
    else pointer(root, reason, 90);
    pointer(document, "pointerup", 100);
    expect(t.value()).toBe(20);
    expect(t.end).toHaveBeenCalledTimes(1);
    expect(UndoManager.add).toHaveBeenCalledTimes(1);
    expect(router.session).toBeNull();
});

test("Escape restores the original value without adding undo", () => {
    const t = tool();
    pointer(root, "pointerdown"); pointer(document, "pointermove", 70);
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
    pointer(document, "pointerup", 100);
    expect(t.value()).toBe(0);
    expect(UndoManager.add).not.toHaveBeenCalled();
    expect(t.end).toHaveBeenCalledTimes(1);
});

test.each(["mouse", "pen", "touch"])("%s ignores other pointers and navigation buttons", pointerType => {
    const t = tool();
    pointer(root, "pointerdown", 50, {button: 2});
    expect(router.session).toBeNull();
    pointer(root, "pointerdown", 50, {pointerType});
    pointer(root, "pointerdown", 80, {pointerType, pointerId: 2});
    pointer(document, "pointermove", 100, {pointerId: 2});
    pointer(document, "pointerup", 100, {pointerId: 2});
    expect(t.value()).toBe(0);
    pointer(document, "pointerup", 70);
    expect(t.value()).toBe(20);
    expect(t.end).toHaveBeenCalledTimes(1);
});

test("native input remains a boundary inside a registered surface", () => {
    const begin = jest.fn(); tool({begin});
    const input = document.createElement("input"); root.appendChild(input);
    const e = pointer(input, "pointerdown");
    expect(begin).not.toHaveBeenCalled(); expect(e.defaultPrevented).toBe(false);
});

test("click edits enter undo after the action and a second touch suppresses the click", () => {
    let value = 0;
    tool({intent: {kind: "click"}, snapshot: () => value, restore: v => { value = v; }, click: () => value++});
    pointer(root, "pointerdown"); pointer(root, "pointerup");
    expect(value).toBe(1); expect(UndoManager.add).toHaveBeenCalledTimes(1);
    UndoManager.add.mock.calls[0][0].undo(); expect(value).toBe(0);
    pointer(root, "pointerdown", 50, {pointerType: "touch"});
    pointer(root, "pointerdown", 70, {pointerType: "touch", pointerId: 2});
    pointer(root, "pointerup", 50, {pointerType: "touch"});
    expect(value).toBe(0);
});

test("the router restores a surface cursor after hover, interruption and disposal", () => {
    root.style.cursor = "crosshair";
    tool({cursor: (e, hit, dragging) => dragging ? "grabbing" : "grab"});
    pointer(root, "pointermove"); expect(root.style.cursor).toBe("grab");
    pointer(root, "pointerdown"); expect(root.style.cursor).toBe("grabbing");
    window.dispatchEvent(new Event("blur")); expect(root.style.cursor).toBe("crosshair");
    pointer(root, "pointermove"); cleanup(); expect(root.style.cursor).toBe("crosshair");
});

test("a registered canvas receives wheel once inside a panel that blocks bubbling", () => {
    const wheel = jest.fn(); tool({wheel});
    root.addEventListener("wheel", e => e.stopPropagation());
    const e = new WheelEvent("wheel", {bubbles: true, cancelable: true, deltaY: 2});
    root.dispatchEvent(e);
    expect(wheel).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
});

test("an explicit range adapter can claim only its own handle", () => {
    const begin = jest.fn();
    tool({begin, nativeControl: true, hitTest: e => e.clientX < 60 ? {} : null});
    const input = document.createElement("input"); input.type = "range"; root.appendChild(input);
    expect(pointer(input, "pointerdown", 80).defaultPrevented).toBe(false);
    expect(pointer(input, "pointerdown", 50).defaultPrevented).toBe(true);
    expect(begin).toHaveBeenCalledTimes(1);
});

test("moving a surface into a pop-out ends its old gesture and rebinds exactly once", () => {
    const t = tool();
    pointer(root, "pointerdown"); pointer(document, "pointermove", 70);
    const frame = document.createElement("iframe"); document.body.appendChild(frame);
    const doc = frame.contentDocument;
    doc.body.appendChild(doc.adoptNode(root)); rebindSurfaceInteractions(root);
    expect(router.session).toBeNull(); expect(t.end).toHaveBeenCalledTimes(1);
    pointer(root, "pointerdown"); pointer(doc, "pointerup", 80);
    expect(t.value()).toBe(50); expect(t.end).toHaveBeenCalledTimes(2);
    document.body.appendChild(document.adoptNode(root)); rebindSurfaceInteractions(root);
    getInteractionRouter(doc).dispose(); frame.remove();
    pointer(root, "pointerdown"); pointer(document, "pointerup", 60);
    expect(t.value()).toBe(60); expect(t.end).toHaveBeenCalledTimes(3);
});

test("layout owns a resize before content and Escape restores dimensions", () => {
    root.style.cssText = "left:10px;top:20px;width:200px;height:150px";
    const content = jest.fn(); tool({begin: content});
    const end = jest.fn();
    makeResizable(root, {handles: "e", onResizeEnd: end});
    const handle = root._resizeHandles.e; handle.getBoundingClientRect = () => ({...rect, width: 10});
    pointer(handle, "pointerdown", 210); pointer(document, "pointermove", 250);
    expect(root.style.width).toBe("240px"); expect(content).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
    expect(root.style.width).toBe("200px"); expect(end).toHaveBeenCalledTimes(1);
    removeResizable(root);
});

test("header drag uses release coordinates and interruption does not close the window", () => {
    root.style.cssText = "left:10px;top:20px";
    const close = jest.fn(), end = jest.fn();
    makeDraggable(root, {closeOnDragOffTop: close, onDragEnd: end});
    pointer(root, "pointerdown"); pointer(document, "pointerup", 90);
    expect(root.style.left).toBe("50px");
    pointer(root, "pointerdown"); pointer(document, "pointermove", 100);
    window.dispatchEvent(new Event("blur"));
    expect(end).toHaveBeenCalledTimes(2); expect(close).not.toHaveBeenCalled();
    removeDraggable(root);
});

test("a shared seam keeps both edges coupled and Escape restores both views", () => {
    const a = {id: "a", visible: true, leftPx: 0, topPx: 0, widthPx: 200, heightPx: 150,
        width: .5, height: 1, left: 0, top: 0, containerWidth: () => 400, containerHeight: () => 150,
        containerLeft: () => 0, containerTop: () => 0};
    const b = {...a, id: "b", leftPx: 200, left: .5};
    ViewMan.get = id => id === "a" ? a : b;
    const update = jest.spyOn(LayoutMan, "updateSeams").mockImplementation(() => {});
    LayoutMan._seams = [{dir: "v", before: ["a"], after: ["b"]}];
    const handle = LayoutMan._makeSeamEl(0);
    handle.getBoundingClientRect = () => ({...rect, width: 8});
    root.appendChild(handle); LayoutMan._seamEls = [handle]; cleanup = handle._unregisterInteraction;
    try {
        pointer(handle, "pointerdown", 200); pointer(document, "pointermove", 240);
        expect(a.width).toBe(.6); expect(b.left).toBe(.6); expect(b.width).toBe(.4);
        document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
        expect(a.width).toBe(.5); expect(b.left).toBe(.5); expect(b.width).toBe(.5);
        expect(LayoutMan._activeSeam).toBeNull();
        pointer(handle, "pointerdown", 200); pointer(document, "pointermove", 220);
        b.visible = false; pointer(document, "pointermove", 240);
        expect(a.width).toBe(.55); expect(b.left).toBe(.55);
        expect(router.session).toBeNull();
    } finally { cleanup(); update.mockRestore(); }
});
