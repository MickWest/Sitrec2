/** @jest-environment jsdom */
// Track edit mode is modal for right-click: a control point opens its point menu, anything else
// opens the one edit menu, and the edit menu's items follow the playhead.
import {Vector3} from "three";

window.matchMedia ??= () => ({matches: false, addEventListener() {}, removeEventListener() {}});
jest.mock("../src/Globals", () => {
    const state = {isMobile: true};
    const custom = {showTrackEditingMenu: jest.fn()};
    const inert = new Proxy({}, {get: (_, key) => key === "then" ? undefined : inert});
    return new Proxy({}, {get: (_, key) => key === "Globals" ? state
        : key === "CustomManager" ? custom
        : key === "NodeMan" ? {iterate() {}, get: () => null, exists: () => false}
        : () => inert});
});
jest.mock("../src/UndoManager", () => ({undoManager: {add: jest.fn()}}));
jest.mock("../src/CViewManager", () => ({ViewMan: {iterateVisibleIncludingOverlays() {}, screenOffsetX: 0}}));
jest.mock("../src/raycastGround", () => ({raycastLocalGround: jest.fn()}));

const {Globals, CustomManager} = require("../src/Globals");
const {par} = require("../src/par");
const {raycastLocalGround} = require("../src/raycastGround");
const ViewUtils = require("../src/ViewUtils");
const {menuMethods} = require("../src/CustomManagerMenus");
const {mouseMethods} = require("../src/nodes/CNodeView3DMouse");
const {exitTrackEditMode, hasOpenContextMenu} = require("../src/TrackEditMode");

let actions, menu, createStandaloneMenu;
beforeEach(() => {
    actions = [];
    menu = {destroy: jest.fn(), open: jest.fn(), add: (data, key) => {
        const action = {run: data[key], enabled: true}; actions.push(action);
        const controller = {name: label => { action.label = label; return controller; },
            disable: () => { action.enabled = false; }};
        return controller;
    }};
    createStandaloneMenu = jest.fn(() => menu);
    Globals.menuBar = {createStandaloneMenu};
});
afterEach(() => { Globals.editingTrack = null; });

function editedTrack(frames = [0, 100]) {
    const splineEditor = {enable: true, frameNumbers: frames, insertPointWithUndo: jest.fn()};
    const trackOb = {
        menuText: "synth", splineEditor, setEditMode: jest.fn(),
        splineEditorNode: {array: Array.from({length: 200}, (_, i) => ({position: new Vector3(i, 0, 0)}))},
    };
    Globals.editingTrack = trackOb;
    return trackOb;
}

const labels = () => actions.map(a => a.label);

test("with the playhead off a point, the edit menu adds a point here or on the track", () => {
    const trackOb = editedTrack();
    par.frame = 40;
    const ground = new Vector3(5, 6, 7);
    menuMethods.showTrackEditingMenu(10, 20, ground);

    expect(createStandaloneMenu.mock.calls[0].slice(3)).toEqual([true, true]);
    expect(labels()).toEqual(["Add Point Here (Frame 40)", "Add Point on Track (Frame 40)", "Exit Edit Mode"]);
    expect(actions.every(a => a.enabled)).toBe(true);

    actions[0].run();
    expect(trackOb.splineEditor.insertPointWithUndo).toHaveBeenLastCalledWith(40, ground);
    actions[1].run();
    expect(trackOb.splineEditor.insertPointWithUndo.mock.calls[1][1].x).toBe(40);
});

test("with the playhead on a point, the edit menu moves that point, and never deletes", () => {
    const trackOb = editedTrack();
    par.frame = 100;
    const ground = new Vector3(1, 2, 3);
    menuMethods.showTrackEditingMenu(10, 20, ground);

    expect(labels()).toEqual(["Move Point 100 Here", "Exit Edit Mode"]);
    actions[0].run();
    expect(trackOb.splineEditor.insertPointWithUndo).toHaveBeenCalledWith(100, ground);
});

test("over the sky, ground placement is disabled rather than hidden", () => {
    editedTrack();
    par.frame = 40;
    menuMethods.showTrackEditingMenu(10, 20, null);
    expect(labels()).toEqual(["Add Point Here (Frame 40)", "Add Point on Track (Frame 40)", "Exit Edit Mode"]);
    expect(actions.map(a => a.enabled)).toEqual([false, true, true]);
});

test("Exit Edit Mode goes through the track's own setter", () => {
    const trackOb = editedTrack();
    par.frame = 40;
    menuMethods.showTrackEditingMenu(10, 20, null);
    actions.at(-1).run();
    expect(trackOb.setEditMode).toHaveBeenCalledWith(false);
});

test("exitTrackEditMode clears all three pieces of state on a track without a setter", () => {
    const trackOb = {editMode: true, splineEditor: {setEnable: jest.fn()}};
    Globals.editingTrack = trackOb;
    expect(exitTrackEditMode()).toBe(true);
    expect(trackOb.editMode).toBe(false);
    expect(trackOb.splineEditor.setEnable).toHaveBeenCalledWith(false);
    expect(Globals.editingTrack).toBe(null);
    expect(exitTrackEditMode()).toBe(false);
});

test("Escape waits for a context menu, but not for a persistent panel", () => {
    Globals.menuBar = {activePersistentMenu: {}, activeContextMenu: null};
    expect(hasOpenContextMenu()).toBe(false);
    Globals.menuBar.activeContextMenu = {};
    expect(hasOpenContextMenu()).toBe(true);
});

describe("right-click routing in a 3D view", () => {
    let view, inView;
    beforeEach(() => {
        CustomManager.showTrackEditingMenu.mockClear();
        inView = jest.spyOn(ViewUtils, "mouseInViewOnly").mockReturnValue(true);
        view = Object.assign(Object.create(mouseMethods), {
            mouseEnabled: true, camera: {}, raycaster: {setFromCamera: jest.fn()},
            findClosestTrack: jest.fn(() => ({trackID: "other"})), showTrackMenu: jest.fn(),
        });
    });
    afterEach(() => inView.mockRestore());

    const rightClick = () => view.onContextMenuInner({preventDefault() {}, stopPropagation() {}}, 50, 60);

    test("in edit mode, a track under the pointer opens the edit menu, not the track panel", () => {
        editedTrack();
        const ground = new Vector3(1, 1, 1);
        raycastLocalGround.mockReturnValue({point: ground});
        rightClick();
        expect(CustomManager.showTrackEditingMenu).toHaveBeenCalledWith(50, 60, ground);
        expect(view.findClosestTrack).not.toHaveBeenCalled();
        expect(view.showTrackMenu).not.toHaveBeenCalled();
    });

    test("in edit mode, the sky still opens the edit menu, with no ground point", () => {
        editedTrack();
        raycastLocalGround.mockReturnValue(null);
        rightClick();
        expect(CustomManager.showTrackEditingMenu).toHaveBeenCalledWith(50, 60, null);
    });
});
