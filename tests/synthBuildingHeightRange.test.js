/** @jest-environment jsdom */

// The building Height sliders (Roof Edge Height, Ridgeline Height) reach 1000 m, so a
// skyscraper or a tall marker pole can be set from the menu, in meters or in feet. A taller
// building set by dragging the roof handle, or loaded from a save, keeps its height when the
// slider is then nudged. These run against the real (forked) lil-gui and the real unit
// conversion in lil-gui-extras, because the limit lives in the slider's clamp.

// jsdom has no matchMedia; lil-gui's NumberController probes it for a coarse pointer.
window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));

import {afterEach, beforeEach, expect, jest, test} from "@jest/globals";

jest.mock("../src/Globals", () => ({
    Globals: {},
    guiMenus: {},
    Units: {
        units: "metric",
        factors: {
            metric: {small: {name: "Meters", abbrev: "m", toM: 1}},
            imperial: {small: {name: "Feet", abbrev: "ft", toM: 0.3048}},
        },
    },
    CustomManager: {saveGlobalSettings: jest.fn()},
    Synth3DManager: {},
    UndoManager: null,
    NodeMan: {},
    markShadowCastersDirty: jest.fn(),
    setMouseOverGUI: jest.fn(),
    setRenderOne: jest.fn(),
}));
jest.mock("../src/nodes/CNode3DGroup", () => ({CNode3DGroup: class {}}));
jest.mock("../src/showError", () => ({showConfirm: jest.fn()}));
jest.mock("../src/SphericalMath", () => ({getLocalUpVector: jest.fn()}));
jest.mock("../src/LLA-ECEF-ENU", () => ({}));
jest.mock("../src/threeExt", () => ({}));
jest.mock("../src/CEventManager", () => ({EventManager: {addEventListener: jest.fn()}}));
jest.mock("../src/i18n", () => ({t: key => key}));
jest.mock("../src/CViewManager", () => ({ViewMan: {topPx: 0, updateSize: jest.fn(), get: jest.fn(), iterate: jest.fn()}}));
jest.mock("../src/mouseMoveView", () => ({}));

import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";
import {guiMenus, Units} from "../src/Globals";
import {CNodeSynthBuilding} from "../src/nodes/CNodeSynthBuilding";

let gui;
const buildings = [];

beforeEach(() => {
    Units.units = "metric";
    gui = new GUI({container: document.body, autoPlace: false, title: "Objects"});
    guiMenus.objects = gui;
});

afterEach(() => {
    // setUnitType polls for a units change; stop it so Jest can exit.
    for (const building of buildings.splice(0)) {
        clearInterval(building.roofEdgeHeightController._unitsCheckInterval);
        clearInterval(building.ridgelineHeightController._unitsCheckInterval);
        clearInterval(building.ridgelineInsetController._unitsCheckInterval);
        clearInterval(building.roofEavesController._unitsCheckInterval);
    }
    gui.destroy();
});

// A building with no geometry: enough for its menu, and the height setters still record the
// new height before they look for vertices to move.
function makeBuilding(roofAGL = 4, rooflineHeightAGL = 0) {
    const building = Object.assign(Object.create(CNodeSynthBuilding.prototype), {
        name: "Building 1", visible: true, editMode: false,
        roofAGL, rooflineHeightAGL, ridgelineInset: 0, roofEaves: 0,
        materialType: "lambert", wallColor: "#c0c0c0", roofColor: "#404040",
        materialOpacity: 1, materialTransparent: true, materialDepthTest: true, materialWireframe: false,
        vertices: [], buildMesh: jest.fn(),
    });
    building.createGUIFolder();
    buildings.push(building);
    return building;
}

function typeInto(controller, text) {
    controller.$input.value = text;
    controller.$input.dispatchEvent(new Event("input"));
}

function arrowDown(controller) {
    controller.$input.dispatchEvent(new KeyboardEvent("keydown", {code: "ArrowDown"}));
}

test("Roof Edge Height accepts a typed height up to 1000 m", () => {
    const building = makeBuilding();

    typeInto(building.roofEdgeHeightController, "750");
    expect(building.roofAGL).toBe(750);

    typeInto(building.roofEdgeHeightController, "1000");
    expect(building.roofAGL).toBe(1000);

    // Still a limit: past 1000 m clamps to it.
    typeInto(building.roofEdgeHeightController, "5000");
    expect(building.roofAGL).toBe(1000);
});

test("Ridgeline Height accepts a typed height up to 1000 m", () => {
    const building = makeBuilding(4, 0);

    typeInto(building.ridgelineHeightController, "900");
    expect(building.rooflineHeightAGL).toBe(896);
    expect(building.ridgelineHeightController.getSIValue()).toBe(900);
});

test("in feet, both sliders reach the same 1000 m", () => {
    Units.units = "imperial";
    const building = makeBuilding();

    for (const controller of [building.roofEdgeHeightController, building.ridgelineHeightController]) {
        expect(controller._name).toBe(controller._originalName + " (ft)");
        expect(controller._max).toBeCloseTo(1000 / 0.3048, 6);
        expect(controller.getSILimits().max).toBe(1000);
    }

    typeInto(building.roofEdgeHeightController, "3000");
    expect(building.roofAGL).toBeCloseTo(3000 * 0.3048, 9);
});

test("a 600 m roof from a save or a handle drag keeps its height when the slider is nudged", () => {
    const building = makeBuilding(600);

    // The slider shows it inside the range rather than pinned at the end.
    expect(building.roofEdgeHeightController._fillPercent()).toBeCloseTo(599.9 / 999.9, 6);

    arrowDown(building.roofEdgeHeightController);
    expect(building.roofAGL).toBeCloseTo(599.99, 9);

    // The same after the roof handle sets it (the drag ends by calling updateGUIControllers).
    building.roofAGL = 950;
    building.updateGUIControllers();
    arrowDown(building.roofEdgeHeightController);
    expect(building.roofAGL).toBeCloseTo(949.99, 9);
});

test("the low end keeps its 0.1 m minimum and 0.01 m step", () => {
    const building = makeBuilding();

    for (const controller of [building.roofEdgeHeightController, building.ridgelineHeightController]) {
        expect(controller.getSILimits().min).toBe(0.1);
        expect(controller._step).toBe(0.01);
    }

    arrowDown(building.roofEdgeHeightController);
    expect(building.roofAGL).toBeCloseTo(3.99, 9);
});
