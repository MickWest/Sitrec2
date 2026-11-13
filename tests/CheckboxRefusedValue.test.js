/** @jest-environment jsdom */
// A checkbox bound to a value that can refuse a change (a setter that checks first) must show the
// value, not the click. The click changes the box before the value is set, so the display must
// not trust its record of what it drew last.
import GUI from "../src/js/lil-gui.esm";

window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));
global.ResizeObserver = global.ResizeObserver || class { observe() {} disconnect() {} };

let gui;
beforeEach(() => { gui = new GUI({autoPlace: false}); document.body.appendChild(gui.domElement); });
afterEach(() => { gui.destroy(); });

test("a refused change puts the box back", () => {
    let on = false, allowed = false;
    const row = {get value() { return on; }, set value(v) { if (allowed) on = v; }};
    const box = gui.add(row, "value").$input;
    box.click();
    expect(on).toBe(false);
    expect(box.checked).toBe(false);
    allowed = true;
    box.click();
    expect(on).toBe(true);
    expect(box.checked).toBe(true);
});

test("an ordinary checkbox still follows the click", () => {
    const state = {flag: false};
    const box = gui.add(state, "flag").$input;
    box.click();
    expect(state.flag).toBe(true);
    expect(box.checked).toBe(true);
    box.click();
    expect(state.flag).toBe(false);
    expect(box.checked).toBe(false);
});
