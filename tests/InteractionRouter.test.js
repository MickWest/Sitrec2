/** @jest-environment jsdom */
import {InteractionRouter, acquireControlLease} from "../src/InteractionRouter";

let router, canvas;
const event = (type, x = 100, extra = {}) => ({type, clientX: x, clientY: 100, pointerId: 1,
    button: 0, buttons: type === "pointerup" ? 0 : 1, target: canvas,
    preventDefault: jest.fn(), stopImmediatePropagation: jest.fn(), ...extra});
function adapter(id, priority = 0, extra = {}) {
    return {id, priority, hitTest: () => ({kind: "drag"}), hitSurface: () => ({}),
        begin: jest.fn(), move: jest.fn(), end: jest.fn(), cancel: jest.fn(), ...extra};
}
beforeEach(() => {
    canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    router = new InteractionRouter(document);
});
afterEach(() => { router.dispose(); canvas.remove(); });

test.each([false, true])("only the winning tool begins regardless of registration order (%s)", reverse => {
    const navigation = adapter("camera", 0, {navigation: true});
    const tool = adapter("mask", 90);
    const list = [navigation, tool];
    if (reverse) list.reverse();
    list.forEach(a => router.register(a));
    router.down(event("pointerdown"));
    router.move(event("pointermove", 120));
    router.up(event("pointerup", 130));
    expect(navigation.begin).not.toHaveBeenCalled();
    expect(tool.begin).toHaveBeenCalledTimes(1);
    expect(tool.move).toHaveBeenCalledTimes(2);
    expect(tool.move.mock.calls[1][0].buttons).toBe(1);
    expect(tool.move.mock.calls[1].slice(1)).toEqual([10, 0]);
    expect(tool.end).toHaveBeenCalledTimes(1);
});

test("a pending add becomes one pan, including the initial displacement", () => {
    const pending = adapter("fit", 20, {hitTest: () => ({kind: "pending"})});
    const pan = adapter("video", 0, {navigation: true});
    router.register(pan); router.register(pending);
    router.down(event("pointerdown"));
    router.move(event("pointermove", 103));
    expect(pan.begin).not.toHaveBeenCalled();
    router.move(event("pointermove", 120));
    router.move(event("pointermove", 100));
    router.up(event("pointerup"));
    expect(pending.cancel).toHaveBeenCalledTimes(1);
    expect(pending.end).not.toHaveBeenCalled();
    expect(pan.begin.mock.calls[0][0].clientX).toBe(100);
    expect(pan.move.mock.calls[0].slice(1)).toEqual([20, 0]);
    expect(pan.end).toHaveBeenCalledTimes(1);
});

test("a pending click completes only on its own release", () => {
    const pending = adapter("fit", 20, {hitTest: () => ({kind: "pending"})});
    router.register(pending);
    router.down(event("pointerdown"));
    router.up(event("pointerup", 100, {pointerId: 2}));
    router.up(event("pointerup"));
    router.up(event("pointerup"));
    expect(pending.end).toHaveBeenCalledTimes(1);
});

test("a second touch cancels a pending add before pinch navigation", () => {
    const pending = adapter("fit", 20, {hitTest: () => ({kind: "pending"})});
    router.register(pending);
    router.down(event("pointerdown", 100, {pointerType: "touch"}));
    router.down(event("pointerdown", 150, {pointerType: "touch", pointerId: 2}));
    router.up(event("pointerup"));
    expect(pending.cancel).toHaveBeenCalledTimes(1);
    expect(pending.end).not.toHaveBeenCalled();
});

test("native contextmenu before and after release produces one menu", () => {
    const nav = adapter("camera", 0, {contextMenu: jest.fn()});
    router.register(nav);
    router.down(event("pointerdown", 100, {button: 2, buttons: 2}));
    router.contextMenu(event("contextmenu", 100, {button: 2}));
    expect(nav.contextMenu).not.toHaveBeenCalled();
    router.up(event("pointerup", 100, {button: 2}));
    router.contextMenu(event("contextmenu", 100, {button: 2}));
    expect(nav.contextMenu).toHaveBeenCalledTimes(1);
});

test("a right drag away and back does not open a menu", () => {
    const nav = adapter("camera", 0, {contextMenu: jest.fn()});
    router.register(nav);
    router.down(event("pointerdown", 100, {button: 2, buttons: 2}));
    router.move(event("pointermove", 130, {button: 2, buttons: 2}));
    router.up(event("pointerup", 100, {button: 2}));
    router.contextMenu(event("contextmenu", 100, {button: 2}));
    expect(nav.contextMenu).not.toHaveBeenCalled();
});

test("wheel reaches one surface and is blocked during authoring", () => {
    const first = adapter("a", 0, {wheel: jest.fn()});
    const second = adapter("b", 0, {wheel: jest.fn()});
    router.register(second); router.register(first);
    router.wheel(event("wheel"));
    expect(first.wheel).toHaveBeenCalledTimes(1);
    expect(second.wheel).not.toHaveBeenCalled();
    router.down(event("pointerdown"));
    router.wheel(event("wheel"));
    expect(first.wheel).toHaveBeenCalledTimes(1);
});

test.each(["cancel", "dispose", "hidden", "buttons", "escape"])("%s finishes once and restores the original camera lock", termination => {
    const control = {enabled: false};
    let visible = true;
    const tool = adapter("building", 80, {controls: () => [control], valid: () => visible, rollback: jest.fn()});
    const remove = router.register(tool);
    router.down(event("pointerdown"));
    if (termination === "dispose") remove();
    else if (termination === "hidden") { visible = false; router.move(event("pointermove", 120)); }
    else if (termination === "buttons") router.move(event("pointermove", 120, {buttons: 0}));
    else if (termination === "escape") router.finish(event("keydown"), "rollback");
    else router.cancelPointer(event("pointercancel"));
    router.up(event("pointerup"));
    expect(tool.cancel.mock.calls.length + tool.rollback.mock.calls.length).toBe(1);
    expect(tool.end).not.toHaveBeenCalled();
    expect(control.enabled).toBe(false);
    expect(router.session).toBeNull();
});

test("nested leases restore controls only after the last borrower finishes", () => {
    const controls = {enabled: true};
    const a = acquireControlLease([controls, controls]);
    const b = acquireControlLease([controls]);
    a(); a();
    expect(controls.enabled).toBe(false);
    b();
    expect(controls.enabled).toBe(true);
});

test("native form controls remain outside the router", () => {
    const tool = adapter("mask", 100);
    router.register(tool);
    router.down(event("pointerdown", 100, {target: document.createElement("input")}));
    expect(tool.begin).not.toHaveBeenCalled();
});


test.each([1, 2])("pinch hands the remaining touch back without a click, lifted %s", lifted => {
    const nav = adapter("video", 0, {navigation: true,
        beginTouches: jest.fn(), moveTouches: jest.fn(), endTouches: jest.fn()});
    const pending = adapter("fit", 20, {hitTest: () => ({kind: "pending"})});
    router.register(nav); router.register(pending);
    const touch = (type, x, pointerId) => event(type, x, {pointerType: "touch", pointerId});
    router.down(touch("pointerdown", 100, 1));
    router.down(touch("pointerdown", 150, 2));
    router.move(touch("pointermove", 180, 2));
    expect(pending.cancel).toHaveBeenCalledTimes(1);
    expect(nav.moveTouches.mock.calls[0][0].touches.map(e => e.clientX)).toEqual([100, 180]);
    router.up(touch("pointerup", lifted === 1 ? 100 : 180, lifted));
    const remaining = lifted === 1 ? 2 : 1, x = lifted === 1 ? 180 : 100;
    expect(nav.begin.mock.calls.at(-1)[0].clientX).toBe(x);
    router.move(touch("pointermove", x + 10, remaining));
    expect(nav.move.mock.calls.at(-1).slice(1)).toEqual([10, 0]);
    router.up(touch("pointerup", x + 10, remaining));
    expect(nav.end.mock.calls[0][1].click).toBe(false);
    expect(pending.end).not.toHaveBeenCalled();
    expect(router.session).toBeNull();
});

test("a second finger never moves the camera beneath an authored drag", () => {
    const nav = adapter("camera", 0, {navigation: true, beginTouches: jest.fn()});
    const handle = adapter("handle", 70);
    router.register(nav); router.register(handle);
    router.down(event("pointerdown", 100, {pointerType: "touch"}));
    router.down(event("pointerdown", 140, {pointerType: "touch", pointerId: 2}));
    router.move(event("pointermove", 170, {pointerType: "touch", pointerId: 2}));
    router.up(event("pointerup", 170, {pointerId: 2}));
    expect(nav.beginTouches).not.toHaveBeenCalled();
    expect(handle.move).not.toHaveBeenCalled();
    router.up(event("pointerup", 120));
    expect(handle.end).toHaveBeenCalledTimes(1);
});

test("long press opens one menu and cannot become a late click", () => {
    jest.useFakeTimers();
    try {
        const nav = adapter("camera", 0, {navigation: true, contextMenu: jest.fn()});
        router.register(nav);
        router.down(event("pointerdown", 100, {pointerType: "touch"}));
        jest.advanceTimersByTime(501);
        router.contextMenu(event("contextmenu", 100, {button: 2}));
        router.up(event("pointerup"));
        expect(nav.contextMenu).toHaveBeenCalledTimes(1);
        expect(nav.end).not.toHaveBeenCalled();
        expect(router.session).toBeNull();
    } finally { jest.useRealTimers(); }
});


test("a failing drag releases its camera lease and cannot receive a late release", () => {
    const control = {enabled: true};
    const tool = adapter("tool", 70, {controls: () => [control], move: () => { throw new Error("failed move"); }});
    router.register(tool);
    router.down(event("pointerdown"));
    expect(() => router.move(event("pointermove", 120))).toThrow("failed move");
    router.up(event("pointerup", 120));
    expect(control.enabled).toBe(true);
    expect(router.session).toBeNull();
    expect(tool.cancel).toHaveBeenCalledTimes(1);
    expect(tool.end).not.toHaveBeenCalled();
});

test("disposing a host view completes a 3D editor attached to it", () => {
    const host = {}, control = {enabled: false};
    const editor = adapter("building", 70, {view: host, controls: () => [control]});
    router.register(editor);
    router.down(event("pointerdown"));
    router.move(event("pointermove", 120));
    router.cancelOwner(host);
    expect(editor.cancel.mock.calls[0][0].clientX).toBe(120);
    expect(control.enabled).toBe(false);
    expect(router.session).toBeNull();
});


test("rotating or resizing a device finishes a drag at its last valid location", () => {
    const tool = adapter("height", 70);
    router.register(tool);
    router.down(event("pointerdown", 100, {pointerType: "touch"}));
    router.move(event("pointermove", 130, {pointerType: "touch"}));
    window.dispatchEvent(new Event("resize"));
    expect(tool.cancel.mock.calls[0][0].clientX).toBe(130);
    expect(router.session).toBeNull();
});
