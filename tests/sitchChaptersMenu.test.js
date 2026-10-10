/**
 * @jest-environment jsdom
 */

// The File → Sitch Chapters folder is built from ordinary lil-gui controls, so a floating copy
// of the menu (GUI.mirrorFolderFrom) and the Sitrec API, which both walk lil-gui's lists, see
// every chapter and can switch to it. The real chapter methods run against the real (forked)
// lil-gui; the scene graph is a stub.

window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));

import fs from "fs";
import vm from "vm";
import {transformSync} from "@babel/core";
import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";
import "../src/MenuMirror";
import {TimelineMarkers} from "../src/TimelineMarkers";
import {t} from "../src/i18n";

function chapterManager() {
    const camera = {value: {zoom: 1}, modSerialize() { return {value: this.value}; },
        modDeserialize(data) { this.value = data.value; }, recalculateCascade() {}};
    const fileMenu = new GUI({container: document.body, autoPlace: false, title: "File"});
    const context = {
        // jsdom has no structuredClone; chapter states are plain JSON data.
        structuredClone: value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value))),
        console, t, TimelineMarkers,
        UndoManager: {clear() {}},
        Globals: {loadGeneration: 1},
        par: {frame: 0},
        Sit: {frames: 100},
        guiMenus: {file: fileMenu},
        FileManager: {},
        NodeMan: {iterate: callback => callback("mainCamera", camera), get: () => camera, exists: () => true},
        ViewMan: {exists: () => false},
        setRenderOne() {}, UIChangedFrame() {}, markSitchDirty() {},
    };
    const source = fs.readFileSync(require.resolve("../src/CustomManagerSubSitch.js"), "utf8");
    const code = transformSync(source, {configFile: false, plugins: [() => ({visitor: {
        ImportDeclaration(path) { path.remove(); },
        ExportNamedDeclaration(path) { path.replaceWith(path.node.declaration); },
    }})]}).code;
    vm.createContext(context);
    vm.runInContext(code + ";globalThis.methods=subSitchMethods;", context);
    const manager = {...context.methods};
    TimelineMarkers.clear();
    manager.setupSubSitches();
    return {manager, camera, fileMenu};
}

const chapterButtons = folder => folder.folders.find(sub => sub._title === "Chapters").controllers.map(c => c._name);

test("each chapter is a button in the Chapters folder, the current one marked", () => {
    const {manager} = chapterManager();
    manager.updateAndAddSubSitch();
    expect(chapterButtons(manager.subSitchFolder)).toEqual(["Chapter 1", "● Chapter 2"]);
    manager.switchToSubSitch(0);
    expect(chapterButtons(manager.subSitchFolder)).toEqual(["● Chapter 1", "Chapter 2"]);
});

test("a floating copy of the folder shows the chapters, and its buttons switch chapters", () => {
    const {manager, camera} = chapterManager();
    camera.value.zoom = 2;
    manager.updateAndAddSubSitch();
    camera.value.zoom = 5;
    TimelineMarkers.add(30, "Only in chapter 2");

    const popup = new GUI({container: document.body, autoPlace: false, title: "Sitch Chapters"});
    popup.mirrorFolderFrom(manager.subSitchFolder);
    expect(chapterButtons(popup)).toEqual(["Chapter 1", "● Chapter 2"]);
    expect(popup.controllers.map(c => c._name)).toContain("Add satellite rise / set markers");

    popup.folders.find(sub => sub._title === "Chapters").controllers[0].$button.click();
    expect(manager.currentSubIndex).toBe(0);
    expect(camera.value.zoom).toBe(2);
    expect(TimelineMarkers.count()).toBe(0);
});
