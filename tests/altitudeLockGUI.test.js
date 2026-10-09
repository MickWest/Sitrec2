/**
 * @jest-environment jsdom
 */

// Lock Altitude and Height From (src/AltitudeLockGUI.js): a checkbox and a choice around the
// lock height control, which still holds altitudeLock with -1 for off.

window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));
global.ResizeObserver = global.ResizeObserver || class { observe() {} disconnect() {} };

const mockScale = {small: 1};
jest.mock("../src/Globals", () => ({
    Globals: {},
    Units: {getScaleFactors: () => mockScale},
    setRenderOne: () => {},
}));
jest.mock("../src/threeExt", () => ({getPointBelow: () => null}));
jest.mock("../src/SphericalMath", () => ({altitudeHAE: () => 0}));

import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";
import {addAltitudeLockControls} from "../src/AltitudeLockGUI";

// The lock height: a CNodeGUIValue in the real code. value is in display units.
function heightNodeIn(folder, target, controls) {
    const node = {value: target.altitudeLock, visible: true};
    node.guiEntry = folder.add(node, "value");
    node.setValue = (value) => {
        node.value = value;
        target.altitudeLock = value / mockScale.small;     // what the onChange applies, in meters
        controls.current?.update();
    };
    node.show = (visible) => { node.visible = visible; };
    // A saved sitch restores the node's own `visible` (CNode simple serials).
    node.modDeserialize = (v) => { node.visible = v.visible; };
    return node;
}

function setup(altitudeLock = -1) {
    const folder = new GUI({container: document.body, autoPlace: false, title: "Path"});
    const target = {altitudeLock, agl: true};
    const controls = {current: null};
    const heightNode = heightNodeIn(folder, target, controls);
    controls.current = addAltitudeLockControls(folder, {
        heightNode,
        isOn: () => target.altitudeLock >= 0,
        currentHeight: () => 123.4,
        getAGL: () => target.agl,
        setAGL: (value) => { target.agl = value; },
    });
    const control = (property) => folder.controllers.find(c => c.property === property);
    return {folder, target, heightNode, lock: control("lockAltitude"), heightFrom: control("heightFrom")};
}

afterEach(() => { mockScale.small = 1; document.body.innerHTML = ""; });

test("the order is Lock Altitude, the height, Height From; off hides the other two", () => {
    const {folder, heightNode, lock, heightFrom} = setup();
    expect([...folder.$children.children]).toEqual([lock.domElement, heightNode.guiEntry.domElement, heightFrom.domElement]);
    expect(lock.getValue()).toBe(false);
    expect(heightNode.visible).toBe(false);
    expect(heightFrom._hidden).toBe(true);
});

test("switching on holds the track at its current height, in whole display units", () => {
    const {target, heightNode, lock, heightFrom} = setup();
    lock.setValue(true);
    expect(target.altitudeLock).toBe(123);
    expect(heightNode.visible).toBe(true);
    expect(heightFrom._hidden).toBe(false);

    lock.setValue(false);
    expect(target.altitudeLock).toBe(-1 / mockScale.small);
    expect(heightNode.visible).toBe(false);
});

test("in feet, the height is the rounded number of feet", () => {
    mockScale.small = 3.28084;
    const {heightNode, lock} = setup();
    lock.setValue(true);
    expect(heightNode.value).toBe(405);     // 123.4 m
});

test("a lock that is already on shows as on, and Height From picks ground or ellipsoid", () => {
    const {target, heightNode, lock, heightFrom} = setup(50);
    expect(lock.getValue()).toBe(true);
    expect(heightNode.visible).toBe(true);
    expect(heightFrom.getValue()).toBe("ground");
    heightFrom.setValue("ellipsoid");
    expect(target.agl).toBe(false);
});

test("a saved sitch that restores the height control as visible does not show it while the lock is off", () => {
    const {heightNode} = setup();
    heightNode.modDeserialize({visible: true});
    expect(heightNode.visible).toBe(false);
});
