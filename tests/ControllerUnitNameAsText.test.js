/**
 * @jest-environment jsdom
 */

// The forked lil-gui sets a controller's name with textContent (see the SITREC PATCH in
// name()), because names carry untrusted text: object and building names from a sitch, GUIValue
// descriptions from a sitch loaded with ?custom=. Three other places rename a controller when
// its units change, and they must keep the name as text too:
//   - setUnitType() in lil-gui-extras, which adds the "(m)"/"(ft)" suffix;
//   - the units-change handler there, for a controller's _mirrorControllers;
//   - CNodeGUIValue.updateMirrors(), for the same list.
// These run against the real (forked) lil-gui, the real lil-gui-extras and the real CNodeGUIValue.

// jsdom has no matchMedia; lil-gui's NumberController probes it for a coarse pointer.
window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));

import {afterEach, beforeEach, expect, jest, test} from "@jest/globals";
import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";
import {setUnits} from "../src/Globals";
import {CNodeGUIValue} from "../src/nodes/CNodeGUIValue";

const PAYLOAD = '<img src=x onerror="globalThis.__xss=1">';

// Only the parts of CUnits these paths read.
const units = {
    units: "metric",
    factors: {
        metric: {small: {abbrev: "m", toM: 1}},
        imperial: {small: {abbrev: "ft", toM: 0.3048}},
    },
    small: {abbrev: "m", toM: 1},
};

let gui;
const unitTyped = [];

beforeEach(() => {
    delete globalThis.__xss;
    units.units = "metric";
    setUnits(units);
    gui = new GUI({container: document.body, autoPlace: false, title: "Objects"});
});

afterEach(() => {
    // setUnitType polls for a units change; stop it so Jest can exit.
    for (const controller of unitTyped.splice(0)) clearInterval(controller._unitsCheckInterval);
    gui.destroy();
    jest.useRealTimers();
});

// A browser fires onerror for an image that fails to load. jsdom loads no images, so fire it
// here: if markup got into the menu, its handler runs as it would on the live page.
function fireImageErrors() {
    for (const img of gui.domElement.querySelectorAll("img")) img.dispatchEvent(new Event("error"));
}

function addUnitTyped(name) {
    const controller = gui.add({height: 10}, "height", 0, 100, 1).name(name).setUnitType("small");
    unitTyped.push(controller);
    return controller;
}

test("setUnitType keeps a name with markup in it as text", () => {
    const controller = addUnitTyped(PAYLOAD);
    fireImageErrors();

    expect(globalThis.__xss).toBeUndefined();
    expect(gui.domElement.querySelector("img")).toBeNull();
    expect(controller.$name.textContent).toBe(PAYLOAD + " (m)");
});

test("a units change renames a mirrored controller as text", () => {
    jest.useFakeTimers();                         // before setUnitType, which starts the poll
    const source = addUnitTyped("Height");
    const mirror = gui.add({height: 10}, "height", 0, 100, 1).name("Height");
    Object.assign(mirror, {
        _unitType: "small", _originalName: PAYLOAD,
        _originalMinSI: 0, _originalMaxSI: 100, _originalStepSI: 1,
    });
    // Nothing in src registers a mirror in this list today; set it by hand to reach the path.
    source._mirrorControllers = [mirror];

    units.units = "imperial";
    jest.advanceTimersByTime(600);                // the poll runs every 500 ms
    fireImageErrors();

    expect(source.$name.textContent).toBe("Height (ft)");
    expect(globalThis.__xss).toBeUndefined();
    expect(gui.domElement.querySelector("img")).toBeNull();
    expect(mirror.$name.textContent).toBe(PAYLOAD + " (ft)");
});

test("CNodeGUIValue.updateMirrors renames its mirrors as text", () => {
    const source = gui.add({value: 1}, "value", 0, 10, 1).name("Size (m)");
    const mirror = gui.add({value: 1}, "value", 0, 10, 1).name("Size (m)");
    source._mirrorControllers = [mirror];
    // Only the fields updateMirrors() reads; desc is the label a sitch's GUIValue can supply.
    const node = Object.assign(Object.create(CNodeGUIValue.prototype), {
        desc: PAYLOAD, unitType: "small", guiEntry: source,
    });

    node.updateMirrors();
    fireImageErrors();

    expect(globalThis.__xss).toBeUndefined();
    expect(gui.domElement.querySelector("img")).toBeNull();
    expect(mirror.$name.textContent).toBe(PAYLOAD + " (m)");
});
