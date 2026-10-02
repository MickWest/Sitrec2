/**
 * CNodeCameraState: what it answers per frame, what it saves (nothing while
 * empty, since every modifiable sitch has one), the save/restore round trip,
 * and its Camera Data menu folder.
 */
jest.mock("../src/showError", () => ({...jest.requireActual("../src/showError"), showError: jest.fn()}));

import fs from "fs";
import path from "path";
import {parse} from "@babel/parser";
import {Globals, guiMenus, setFileManager, setNodeMan} from "../src/Globals";
import {CNodeCameraState, importCameraStateCSV} from "../src/nodes/CNodeCameraState";
import {parseCameraStateCSV} from "../src/CameraStateTable";
import {showError} from "../src/showError";
import csv from "../src/utils/CSVParser";

const CAMERA = "Frame,Mode,FL,Zoom,Polarity\n"
    + "0,IR,675,1,\n"
    + "10,EOW,200,2,\n"
    + "20,IR,1012,1,W\n";
const table = () => parseCameraStateCSV(csv.toArrays(CAMERA), {sourceName: "camera.csv"});

// The mod the sitch serializer would store: it drops the marker key, then
// stores nothing for an empty object.
function savedMod(node) {
    const mod = node.modSerialize();
    expect(mod.rootTestRemove).toBe(true);
    delete mod.rootTestRemove;
    return Object.keys(mod).length > 0 ? JSON.parse(JSON.stringify(mod)) : null;
}

// A stand-in for the lil-gui folder: records what the node adds and shows.
function fakeCameraMenu() {
    const folder = {
        hidden: false, destroyed: false, controllers: [],
        add(object, property) {
            const controller = {object, property};
            for (const method of ["name", "tooltip", "listen", "disable"]) controller[method] = () => controller;
            controller.onChange = (callback) => {
                controller.change = callback;
                return controller;
            };
            folder.controllers.push(controller);
            return controller;
        },
        close: () => folder,
        show: () => { folder.hidden = false; },
        hide: () => { folder.hidden = true; },
        destroy: () => { folder.destroyed = true; },
    };
    return {addFolder: (title) => Object.assign(folder, {title}), folder};
}

let nodes;
beforeEach(() => {
    nodes = new Map();
    setNodeMan({add: (id, node) => nodes.set(id, node), get: (id) => nodes.get(id), exists: (id) => nodes.has(id)});
    setFileManager({removeExportButton: () => {}});
    delete guiMenus.camera;
    Globals.sitchDirty = false;
    showError.mockClear();
});

test("an empty node drives nothing and saves no mod", () => {
    const node = new CNodeCameraState({id: "cameraState"});
    expect(node.hasData()).toBe(false);
    expect(node.driveLookView).toBe(false);
    expect(node.stateAt(0)).toBeNull();
    expect(savedMod(node)).toBeNull();
});

test("loaded data drives every frame and is saved in the mod", () => {
    const node = new CNodeCameraState({id: "cameraState"});
    node.setTable(table());
    expect(node.driveLookView).toBe(true);
    expect(Globals.sitchDirty).toBe(true);
    expect(node.stateAt(9.9)).toMatchObject({index: 0, mode: "IR", focalLengthMm: 675});
    expect(node.stateAt(10)).toMatchObject({index: 1, band: "EO", zoom: 2});
    expect(node.stateAt(5000)).toMatchObject({index: 2, polarity: "whiteHot"});
    expect(savedMod(node)).toEqual({
        cameraState: {
            version: 1, sourceName: "camera.csv",
            rows: [[0, "IR", 675, 1, null], [10, "EOW", 200, 2, null], [20, "IR", 1012, 1, "whiteHot"]],
        },
        driveLookView: true,
    });
});

test("save and restore round trip, including Drive Look View off", () => {
    const first = new CNodeCameraState({id: "cameraState"});
    first.setTable(table());
    first.driveLookView = false;
    expect(first.stateAt(15)).toBeNull();
    const saved = savedMod(first);

    nodes.clear();
    Globals.sitchDirty = false;
    const restored = new CNodeCameraState({id: "cameraState"});
    restored.modDeserialize(saved);
    expect(restored.table).toEqual(first.table);
    expect(restored.sourceName).toBe("camera.csv");
    expect(restored.driveLookView).toBe(false);
    expect(Globals.sitchDirty).toBe(false);   // restoring is not an edit
    expect(savedMod(restored)).toEqual(saved);

    restored.driveLookView = true;
    for (let frame = 0; frame < 30; frame += 0.25) {
        first.driveLookView = true;
        expect(restored.stateAt(frame)).toEqual(first.stateAt(frame));
    }
});

test("a save without Drive Look View drives by default", () => {
    const node = new CNodeCameraState({id: "cameraState"});
    const saved = {cameraState: {version: 1, sourceName: "a.csv", rows: [[0, "IR", 675, 1, null]]}};
    node.modDeserialize(saved);
    expect(node.driveLookView).toBe(true);
});

test("a damaged save leaves the node empty rather than half filled", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const node = new CNodeCameraState({id: "cameraState"});
    node.modDeserialize({cameraState: {version: 1, sourceName: "a.csv", rows: [[0, "IR", -675, 1, null]]},
        driveLookView: true});
    expect(node.hasData()).toBe(false);
    expect(node.stateAt(0)).toBeNull();
    expect(savedMod(node)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/focal length "-675"/));
    warn.mockRestore();
});

test("clear removes the data, marks the sitch changed and saves nothing again", () => {
    const node = new CNodeCameraState({id: "cameraState"});
    node.setTable(table());
    Globals.sitchDirty = false;
    node.clear();
    expect(Globals.sitchDirty).toBe(true);
    expect(node.stateAt(0)).toBeNull();
    expect(node.driveLookView).toBe(false);
    expect(savedMod(node)).toBeNull();
});

test("the Camera Data folder: hidden while empty, read-only details, drive switch, remove button", () => {
    const menu = fakeCameraMenu();
    guiMenus.camera = menu;
    const node = new CNodeCameraState({id: "cameraState"});
    const {folder} = menu;
    expect(folder.title).toBe("Camera Data");
    expect(folder.hidden).toBe(true);

    node.setTable(table());
    expect(folder.hidden).toBe(false);
    expect(node.menuText).toEqual({
        source: "camera.csv",
        rows: "3 rows, frames 0 to 20",
        modes: "IR (IR), EOW (EO)",
    });

    const drive = folder.controllers.find(c => c.object === node && c.property === "driveLookView");
    Globals.sitchDirty = false;
    node.driveLookView = false;
    drive.change();
    expect(Globals.sitchDirty).toBe(true);

    const remove = folder.controllers.find(c => c.property === "remove");
    remove.object.remove();
    expect(node.hasData()).toBe(false);
    expect(folder.hidden).toBe(true);
    expect(node.menuText).toEqual({source: "", rows: "", modes: ""});

    node.dispose();
    expect(folder.destroyed).toBe(true);
});

// The real sub-sitch methods, taken from their source: the module itself imports the whole scene.
function subSitchManager(scope) {
    const source = fs.readFileSync(path.join(__dirname, "../src/CustomManagerSubSitch.js"), "utf8");
    const methods = parse(source, {sourceType: "module"}).program.body
        .map(n => n.declaration?.declarations?.[0]).find(d => d?.id?.name === "subSitchMethods").init;
    const names = ["setupSubSitchDetails", "nodeMatchesPattern", "nodeMatchesCategory", "shouldIncludeNodeForSave",
        "shouldIncludeNodeForLoad", "remapDeprecatedNodeId", "getSubSitchNodes", "captureSubSitchState", "restoreSubSitchState"];
    const code = methods.properties.filter(p => names.includes(p.key?.name)).map(p => source.slice(p.start, p.end)).join(",\n");
    const manager = new Function(...Object.keys(scope), `return {${code}};`)(...Object.values(scope));
    // Any menu call returns the stub again, so setupSubSitchDetails can build its folders.
    const menu = new Proxy(() => menu, {get: () => menu});
    manager.subSitchFolder = menu;
    manager.setupSubSitchDetails();
    return manager;
}

test("sub sitches neither capture nor restore the camera data: it belongs to the whole sitch", () => {
    const camera = {id: "lookCamera", modSerialize: () => ({fov: 5}), modDeserialize: jest.fn(), recalculateCascade: jest.fn()};
    nodes.set("lookCamera", camera);
    const node = new CNodeCameraState({id: "cameraState"});
    node.setTable(table());
    // No node here is a view, so a restore never changes the fullscreen view.
    const manager = subSitchManager({Globals, setRenderOne: jest.fn(), t: () => "", ViewMan: {exists: () => false}, NodeMan: {
        get: (id) => nodes.get(id), exists: (id) => nodes.has(id), iterate: (callback) => nodes.forEach((n, id) => callback(id, n))}});
    // Its id matches the camera category, so only the node's own flag keeps it out.
    expect(manager.nodeMatchesCategory("cameraState", "Cameras")).toBe(true);
    const state = manager.captureSubSitchState();
    expect(Object.keys(state.mods)).toEqual(["lookCamera"]);

    // A state that holds older camera data (another file's rows) restores the camera but not the data.
    const older = {cameraState: {version: 1, sourceName: "older.csv", rows: [[0, "EON", 9, 1, null]]}, driveLookView: false};
    manager.restoreSubSitchState({mods: {...state.mods, cameraState: older}, focusTracks: {}, lockTracks: {}});
    expect(camera.modDeserialize).toHaveBeenCalledWith({fov: 5});
    expect(node.sourceName).toBe("camera.csv"); expect(node.driveLookView).toBe(true);
    expect(node.table).toEqual(table());
    // Without the flag, each sub sitch would carry a copy of the rows.
    node.excludeFromSubSitches = false;
    expect(Object.keys(manager.captureSubSitchState().mods)).toEqual(["lookCamera", "cameraState"]);
});

test("an import keeps only the file's own name", () => {
    new CNodeCameraState({id: "cameraState"});
    const rows = csv.toArrays(CAMERA);
    expect(importCameraStateCSV("folder/sub/camera.csv", rows).sourceName).toBe("camera.csv");
    expect(importCameraStateCSV("https://example.com/data/camera.csv?v=2", rows).sourceName).toBe("camera.csv");
    expect(showError).not.toHaveBeenCalled();
});
