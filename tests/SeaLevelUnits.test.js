/** @jest-environment jsdom */
import fs from "node:fs";
import path from "node:path";
import {parse} from "@babel/parser";
import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";
import {CUnits} from "../src/CUnits";
import {setNodeMan, setUnits} from "../src/Globals";
import {roundIfClose, scaleF2M} from "../src/utils";

window.matchMedia ??= () => ({matches: false, addListener() {}, removeListener() {}});

// Exercise the real menu and unit hooks without starting terrain tile loading.
const source = fs.readFileSync(path.join(__dirname, "../src/nodes/CNodeTerrainUI.js"), "utf8");
const declaration = parse(source, {sourceType: "module"}).program.body
    .map(n => n.declaration ?? n).find(n => n.id?.name === "CNodeTerrainUI");
const methods = declaration.body.body.filter(n => ["buildSeaLevelGUI", "changeUnits", "updateDesc", "setOceanSurfaceCalculationLocked", "updateInundationStatus"].includes(n.key?.name))
    .map(n => source.slice(n.start, n.end)).join("\n");

let units, ui;
beforeEach(() => {
    ui = null;
    setNodeMan({iterate: callback => { if (ui) callback("terrainUI", ui); }});
    units = new CUnits("imperial");
    setUnits(units);
    const Menu = new Function("Units", "roundIfClose", "scaleF2M", "setRenderOne", `return class {${methods}}`)
        (units, roundIfClose, scaleF2M, () => {});
    ui = Object.assign(new Menu(), {
        gui: new GUI(), showOceanSurface: true,
        oceanSurfaceLevelFeet: 40, oceanSurfaceDatumOffset: 0.3048, oceanSurfaceWidthKm: 40,
        oceanSurfaceTransparent: false, oceanSurfaceTransparency: 50,
        oceanSurfaceInundation: true, inundationStatus: "Off", recalculateInundation: jest.fn(),
        oceanSurfaceUse3D: false, oceanSurfaceFlowArrows: false, oceanSurfaceDetailRadiusKm: 5,
        oceanSurfaceCalculationLocked: false,
        setOceanSurfaceVisible: jest.fn(),
    });
    ui.buildSeaLevelGUI();
});
afterEach(() => ui.gui.destroy());

const stored = () => [ui.oceanSurfaceLevelFeet, ui.oceanSurfaceDatumOffset, ui.oceanSurfaceWidthKm];
const controls = () => ui.seaLevelUnitControls.map(item => item.controller);

test("only overall 3D loading progress is displayed during short worker stages", () => {
    expect(ui.gui.controllersRecursive().some(c => c.property === "inundationProgress")).toBe(false);
    Object.assign(ui, {oceanSurfaceUse3D: true, showBuildings: true, buildingsSource: "google-photorealistic",
        oceanSurfaceGroup: {widthMeters: 40000},
        buildingsNode: {hasPendingLoads: () => false, inundationLoading: () => false}});
    ui.inundation = {status: "Coverage 30%", progress: {stage: "Coverage", fraction: 0.3},
        buildings: {ready: false}, detailCoverage: () => ({percent: 42, covered: 42, total: 100})};
    ui.updateInundationStatus();
    expect(ui.inundationStatus).toBe("Loading 3D detail 42%");
    ui.inundation.progress = {stage: "Water barriers", fraction: 0.9};
    ui.updateInundationStatus();
    expect(ui.inundationStatus).toBe("Loading 3D detail 42%");
    ui.inundation.detailCoverage = () => null;
    ui.updateInundationStatus();
    expect(ui.inundationStatus).toBe("Loading 3D detail 0%");
});

test("locking disables calculation edits while leaving presentation controls usable", () => {
    ui.inundation = {pauseCalculation: jest.fn()};
    ui.buildingsNode = {setInundationRegion: jest.fn()};
    const controllers = ui.gui.controllersRecursive();
    const mirror = {disable: jest.fn()};
    ui.seaLevelCalculationControls[0]._mirrorControllers = [mirror];
    const lock = controllers.find(c => c.property === "oceanSurfaceCalculationLocked");
    lock.setValue(true);
    expect(lock._name).toBe("Lock Calculation");
    expect(ui.inundation.pauseCalculation).toHaveBeenCalledTimes(1);
    expect(ui.buildingsNode.setInundationRegion).toHaveBeenCalledWith();
    expect(ui.inundationStatus).toBe("Locked");
    expect(ui.seaLevelCalculationControls.every(c => c._disabled)).toBe(true);
    expect(mirror.disable).toHaveBeenLastCalledWith(true);
    for (const property of ["showOceanSurface", "oceanSurfaceTransparent", "oceanSurfaceTransparency", "oceanSurfaceCalculationLocked"]) {
        expect(controllers.find(c => c.property === property)._disabled).toBe(false);
    }
    lock.setValue(false);
    expect(ui.seaLevelCalculationControls.every(c => !c._disabled)).toBe(true);
    expect(mirror.disable).toHaveBeenLastCalledWith(false);
});

test("switching and restoring units changes the display and ranges without changing saved physical values", () => {
    const initial = stored();
    for (const system of ["metric", "nautical", "feet", "imperial", "metric"]) {
        units.changeUnits(system);
        const [level, datum, coverage, detailRadius] = controls();
        expect(stored()).toEqual(initial);
        expect(level._name).toBe(`Level above MSL (${units.small.abbrev})`);
        expect(datum._name).toBe(`Datum correction (${units.small.abbrev})`);
        expect(coverage._name).toBe(`Coverage (${units.big.abbrev})`);
        expect(detailRadius._name).toBe(`3D detail radius (${units.big.abbrev})`);
        expect(detailRadius.getValue() * units.big.toM).toBeCloseTo(5000, 8);
        expect(level.getValue() * units.small.toM).toBeCloseTo(12.192, 10);
        expect(datum.getValue() * units.small.toM).toBeCloseTo(0.3048, 10);
        expect(coverage.getValue() * units.big.toM).toBeCloseTo(40000, 8);
        expect(level._min * units.small.toM).toBeCloseTo(-30.48, 10);
        expect(level._max * units.small.toM).toBeCloseTo(60.96, 10);
        expect(coverage._min * units.big.toM).toBeCloseTo(1000, 8);
        expect(coverage._max * units.big.toM).toBeCloseTo(100000, 8);
    }
    units.modDeserialize({units: "nautical"});
    expect(controls()[2]._name).toBe("Coverage (NM)");
    expect(stored()).toEqual(initial);
});

test.each(["metric", "nautical", "imperial", "feet"])("edits in %s write the existing save fields in their original units", system => {
    units.changeUnits(system);
    const [level, datum, coverage] = controls();
    level.setValue(12);
    datum.setValue(-2);
    coverage.setValue(5000 / units.big.toM);
    expect(ui.oceanSurfaceLevelFeet * scaleF2M).toBeCloseTo(12 * units.small.toM, 10);
    expect(ui.oceanSurfaceDatumOffset).toBeCloseTo(-2 * units.small.toM, 10);
    expect(ui.oceanSurfaceWidthKm).toBeCloseTo(5, 10);
    const saved = stored();
    units.modDeserialize({units: "metric"});
    expect(stored()).toEqual(saved);
    expect(level.getValue()).toBeCloseTo(saved[0] * scaleF2M, 10);
    expect(datum.getValue()).toBeCloseTo(saved[1], 10);
    expect(coverage.getValue()).toBeCloseTo(saved[2], 10);
});
