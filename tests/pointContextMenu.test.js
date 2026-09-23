/** @jest-environment jsdom */
import {BoxGeometry, Scene, Vector3} from "three";

window.matchMedia ??= () => ({matches: false, addEventListener() {}, removeEventListener() {}});
jest.mock("../src/Globals", () => {
    const state = {isMobile: true};
    const inert = new Proxy({}, {get: (_, key) => key === "then" ? undefined : inert});
    return new Proxy({}, {get: (_, key) => key === "Globals" ? state : () => inert});
});
jest.mock("../src/UndoManager", () => ({undoManager: {add: jest.fn()}}));
jest.mock("../src/CViewManager", () => ({ViewMan: {iterateVisibleIncludingOverlays() {}, screenOffsetX: 0}}));

const {Globals} = require("../src/Globals");
const {undoManager} = require("../src/UndoManager");
const {PointEditor} = require("../src/PointEditor");
const {CNodeFitCameraPoints} = require("../src/nodes/CNodeFitCameraPoints");
const {viewInteractionAdapter} = require("../src/ViewInteraction");
const {InteractionRouter} = require("../src/InteractionRouter");

let actions, menu;
beforeEach(() => {
    actions = [];
    menu = {destroy: jest.fn(), open: jest.fn(), add: (data, key) => {
        const action = {run: data[key], enabled: true}; actions.push(action);
        const controller = {name: label => { action.label = label; return controller; },
            disable: () => { action.enabled = false; }};
        return controller;
    }};
    Globals.menuBar = {createStandaloneMenu: jest.fn(() => menu)};
    undoManager.add.mockClear();
});

// The most recent menu item whose label starts with `prefix`.
const item = prefix => actions.filter(a => a.label?.startsWith(prefix)).at(-1);

function trackEditor(count = 3) {
    const editor = Object.assign(Object.create(PointEditor.prototype), {
        enable: true, scene: new Scene(), geometry: new BoxGeometry(),
        transformControl: {attach: jest.fn(), detach: jest.fn()},
        frameNumbers: [], positions: [], splineHelperObjects: [], numPoints: 0,
        updatePointEditorGraphics: jest.fn(), onChange: jest.fn(),
        setupRaycasterForEvent: () => true,
    });
    for (let i = 0; i < count; i++) editor.insertPoint(i * 10, new Vector3(i, 0, 0));
    editor.getIntersectedControlPoint = () => editor.splineHelperObjects[0];
    return editor;
}

test("3D point menus preserve points until Delete Point is chosen, with undo and redo", () => {
    const editor = trackEditor();
    const original = editor.positions.map(p => p.toArray());
    expect(editor.showPointMenuAtEvent({clientX: 20, clientY: 30})).toBe(true);
    expect(editor.positions.map(p => p.toArray())).toEqual(original);
    expect(undoManager.add).not.toHaveBeenCalled();
    menu.destroy();
    expect(editor.numPoints).toBe(3);
    editor.showPointMenuAtEvent({clientX: 20, clientY: 30});
    item("Delete Point").run();
    expect(editor.frameNumbers).toEqual([10, 20]);
    expect(undoManager.add).toHaveBeenCalledTimes(1);
    const edit = undoManager.add.mock.calls[0][0];
    edit.undo();
    expect(editor.positions.map(p => p.toArray())).toEqual(original);
    edit.redo(); expect(editor.frameNumbers).toEqual([10, 20]);
});

test("a single track point has a disabled delete action and cannot be removed", () => {
    const editor = trackEditor(1);
    editor.showPointMenuAtEvent({clientX: 20, clientY: 30});
    expect(item("Delete Point").enabled).toBe(false);
    item("Delete Point").run();
    expect(editor.numPoints).toBe(1);
    expect(editor.deletePointWithUndo(0)).toBe(false);
    expect(undoManager.add).not.toHaveBeenCalled();
});

test("a stale point menu cannot delete a different point after the original is removed", () => {
    const editor = trackEditor();
    editor.showPointMenuAtEvent({clientX: 20, clientY: 30});
    editor.removePointByIndex(0);
    item("Delete Point").run();
    expect(editor.frameNumbers).toEqual([10, 20]);
    expect(undoManager.add).not.toHaveBeenCalled();
});

test("the track point menu offers Go to Frame, and Exit Edit Mode only for the edited track", () => {
    const editor = trackEditor();
    Globals.editingTrack = null;
    editor.showPointMenuAtEvent({clientX: 20, clientY: 30});
    expect(actions.map(a => a.label)).toEqual(["Go to Frame 0", "Delete Point"]);
    expect(Globals.menuBar.createStandaloneMenu.mock.calls[0][0]).toBe("Point: Frame 0");

    actions = [];
    const trackOb = {splineEditor: editor, setEditMode: jest.fn()};
    Globals.editingTrack = trackOb;
    try {
        editor.showPointMenuAtEvent({clientX: 20, clientY: 30});
        expect(actions.map(a => a.label)).toEqual(["Go to Frame 0", "Delete Point", "Exit Edit Mode"]);
        item("Exit Edit Mode").run();
        expect(trackOb.setEditMode).toHaveBeenCalledWith(false);
        expect(editor.numPoints).toBe(3);
    } finally { Globals.editingTrack = null; }
});

test("insertPointWithUndo adds a new point, or moves the one at that frame, as one undo step", () => {
    const editor = trackEditor();
    editor.insertPointWithUndo(5, new Vector3(9, 9, 9));
    expect(editor.frameNumbers).toEqual([0, 5, 10, 20]);
    const add = undoManager.add.mock.calls[0][0];
    add.undo(); expect(editor.frameNumbers).toEqual([0, 10, 20]);
    add.redo(); expect(editor.positions[1].toArray()).toEqual([9, 9, 9]);

    editor.insertPointWithUndo(10, new Vector3(7, 7, 7));
    expect(editor.frameNumbers).toEqual([0, 5, 10, 20]);
    expect(editor.positions[2].toArray()).toEqual([7, 7, 7]);
    const move = undoManager.add.mock.calls[1][0];
    move.undo(); expect(editor.positions[2].toArray()).toEqual([1, 0, 0]);
    move.redo(); expect(editor.positions[2].toArray()).toEqual([7, 7, 7]);
});

test("fit point right-click opens one point menu, empty space opens the video menu, right-drag navigates", () => {
    const canvas = document.createElement("canvas"); document.body.appendChild(canvas);
    canvas.getBoundingClientRect = () => ({left: 0, top: 0, width: 400, height: 300});
    const point = {id: "point1"};
    const fit = Object.assign(Object.create(CNodeFitCameraPoints.prototype), {
        id: "fit", visible: true, enabled: true, canvas, div: canvas, zIndex: 0,
        widthPx: 400, heightPx: 300, leftPx: 0, topPx: 0,
        points: [point], hasVideoGeometry: () => true,
        pointNear: (x, y) => Math.hypot(x - 100, y - 100) < 10 ? point : null,
        removePoint: jest.fn(),
    });
    const router = new InteractionRouter(document);
    router.register(viewInteractionAdapter(fit));
    const navigation = {id: "video", navigation: true, hitTest: () => ({kind: "drag"}),
        hitSurface: () => ({}), begin: jest.fn(), move: jest.fn(), end: jest.fn(), contextMenu: jest.fn()};
    router.register(navigation);
    const event = (type, x) => ({type, target: canvas, button: 2, buttons: type === "pointerup" ? 0 : 2,
        pointerId: 1, clientX: x, clientY: 100, preventDefault() {}, stopImmediatePropagation() {}});
    try {
        router.down(event("pointerdown", 100));
        expect(fit.removePoint).not.toHaveBeenCalled();
        router.up(event("pointerup", 100));
        router.contextMenu(event("contextmenu", 100));
        expect(actions).toHaveLength(1);
        expect(fit.removePoint).not.toHaveBeenCalled();
        expect(navigation.contextMenu).not.toHaveBeenCalled();
        actions[0].run(); expect(fit.removePoint).toHaveBeenCalledWith("point1");
        router.down(event("pointerdown", 200)); router.up(event("pointerup", 200));
        expect(navigation.contextMenu).toHaveBeenCalledTimes(1);
        router.down(event("pointerdown", 100)); router.up(event("pointerup", 160));
        expect(navigation.move).toHaveBeenCalled();
        expect(actions).toHaveLength(1);
        expect(fit.removePoint).toHaveBeenCalledTimes(1);
    } finally { router.dispose(); canvas.remove(); }
});
