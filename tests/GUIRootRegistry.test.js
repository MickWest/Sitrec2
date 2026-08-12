/**
 * @jest-environment jsdom
 */

// The fork removed lil-gui's per-controller requestAnimationFrame, so `.listen()` is only a flag
// and CGuiMenuBar.updateListeners does the polling — for the docked menu-bar slots. A lil-gui
// root that is NOT a slot (a detached menu, a per-view header) was therefore never polled, and
// `.listen()` there was a silent no-op: correct when built, then quietly stale forever.
//
// This registry is how such a root opts in. The tests below pin the contract the callers rely
// on: registration is idempotent, unregistration really stops the polling, and one broken root
// cannot take the frame's whole listener pass down with it.

window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));

import GUI from "../src/js/lil-gui.esm";
import {guiRootCount, registerGUIRoot, unregisterGUIRoot, updateGUIRootListeners} from "../src/GUIRootRegistry";

let containers;

function makeGUI() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    return new GUI({container, autoPlace: false});
}

// Jest gives each test file its own module registry, so the set starts empty and the counts
// below are absolute. Tracked here so afterEach can hand it back empty for the next test.
const registered = new Set();

beforeEach(() => {
    containers = [];
});

afterEach(() => {
    for (const g of registered) unregisterGUIRoot(g);
    registered.clear();
    for (const c of containers) c.remove();
});

function track(gui) { registered.add(gui); return registerGUIRoot(gui); }

test("a registered root gets its listening controllers polled", () => {
    const state = {flag: false};
    const gui = track(makeGUI());
    const controller = gui.add(state, "flag").listen();

    state.flag = true;
    expect(controller.$input.checked).toBe(false);

    updateGUIRootListeners();
    expect(controller.$input.checked).toBe(true);
});

test("registering twice polls once, and unregistering stops it", () => {
    const state = {flag: false};
    const gui = makeGUI();
    track(gui); track(gui);
    expect(guiRootCount()).toBe(1);

    const controller = gui.add(state, "flag").listen();
    unregisterGUIRoot(gui);
    registered.delete(gui);
    expect(guiRootCount()).toBe(0);

    state.flag = true;
    updateGUIRootListeners();
    expect(controller.$input.checked).toBe(false);   // nobody is polling it now
});

test("a torn-down root is dropped rather than breaking the frame's listener pass", () => {
    const state = {flag: false};
    const dead = {};                     // a GUI whose updateListeners has gone
    registerGUIRoot(dead);
    const gui = track(makeGUI());
    const controller = gui.add(state, "flag").listen();

    state.flag = true;
    expect(() => updateGUIRootListeners()).not.toThrow();
    expect(controller.$input.checked).toBe(true);
});
