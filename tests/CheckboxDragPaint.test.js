/**
 * @jest-environment jsdom
 */

// Press a lil-gui checkbox and drag over others: each is set to the state the first one is
// changing to, through the same `change` event a click sends (so onChange runs). jsdom has no
// layout, so elementFromPoint is stubbed to return whatever element the test "moves" over.

window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));
global.ResizeObserver = global.ResizeObserver || class { observe() {} disconnect() {} };

import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";      // installs FolderToggle and CheckboxDragPaint

let container, gui, under;

beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    gui = new GUI({container, autoPlace: false, title: "menu"});
    under = null;
    document.elementFromPoint = () => under;
});

afterEach(() => container.remove());

function pointer(type, el, buttons) {
    under = el;
    // jsdom has no PointerEvent; a MouseEvent of the same type carries button/buttons.
    el.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, button: 0, buttons}));
}

function drag(elements) {
    pointer("pointerdown", elements[0], 1);
    for (const el of elements.slice(1)) pointer("pointermove", el, 1);
    pointer("pointerup", elements[elements.length - 1], 0);
}

test("dragging from a checked box unticks every box passed over, running onChange", () => {
    const state = {a: true, b: true, c: false, d: true};
    const changed = jest.fn();
    const rows = ["a", "b", "c", "d"].map(k => gui.add(state, k).onChange(changed));
    drag(rows.slice(0, 3).map(c => c.$input));
    expect(state).toEqual({a: false, b: false, c: false, d: true});
    expect(changed).toHaveBeenCalledTimes(2);      // c was already false
});

test("dragging over the row labels works as well as over the boxes", () => {
    const state = {a: false, b: false};
    const [a, b] = ["a", "b"].map(k => gui.add(state, k));
    drag([a.domElement, b.domElement]);
    expect(state).toEqual({a: true, b: true});
});

test("folder title checkboxes take part", () => {
    const state = {a: true, b: true};
    const fa = gui.addFolder("A"), fb = gui.addFolder("B");
    fa.add(state, "a").asFolderToggle();
    fb.add(state, "b").asFolderToggle();
    const box = f => f.domElement.querySelector(":scope > input.lil-folder-toggle");
    drag([box(fa), box(fb)]);
    expect(state).toEqual({a: false, b: false});
});

test("the click that follows a drag back onto the first box is cancelled", () => {
    const state = {a: false, b: false};
    const [a, b] = ["a", "b"].map(k => gui.add(state, k));
    pointer("pointerdown", a.$input, 1);
    pointer("pointermove", b.$input, 1);
    pointer("pointermove", a.$input, 1);
    pointer("pointerup", a.$input, 0);
    a.$input.click();                      // what the browser sends: down and up on the same box
    expect(state).toEqual({a: true, b: true});
});

test("a press and release without dragging is an ordinary click", () => {
    const state = {a: false};
    const a = gui.add(state, "a");
    pointer("pointerdown", a.$input, 1);
    pointer("pointerup", a.$input, 0);
    a.$input.click();
    expect(state.a).toBe(true);
});

test("disabled boxes and rows of an off folder are skipped", async () => {
    const state = {a: false, b: false, on: false, c: false, e: false};
    const a = gui.add(state, "a");
    const b = gui.add(state, "b").disable();
    const folder = gui.addFolder("F");
    folder.add(state, "on").asFolderToggle();
    const c = folder.add(state, "c");
    const e = gui.add(state, "e");
    await Promise.resolve();     // a row added after promotion is marked a microtask later
    drag([a.$input, b.$input, c.$input, e.$input]);
    expect(state).toEqual({a: true, b: false, on: false, c: false, e: true});
});

test("a drag that reaches no other usable box changes nothing, like a cancelled click", () => {
    const state = {a: false, b: false};
    const a = gui.add(state, "a");
    const b = gui.add(state, "b").disable();
    drag([a.$input, b.$input]);
    expect(state).toEqual({a: false, b: false});
});
