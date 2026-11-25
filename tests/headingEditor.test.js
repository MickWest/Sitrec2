/** @jest-environment jsdom */
import {PerspectiveCamera, Quaternion, Vector3} from "three";
import {CNodeControllerHeadingEditor} from "../src/nodes/CNodeControllerHeadingEditor";
import {NodeMan, Sit, UndoManager} from "../src/Globals";
import {par} from "../src/par";
import {CNodeCurveEditorView2} from "../src/nodes/CNodeCurveEdit2";
import {KeyframeRegistry} from "../src/CKeyframeRegistry";
import {nextStop, prevStop} from "../src/TimelineMarkers";

jest.mock("../src/Globals", () => ({Globals: {}, Sit: {frames: 101}, NodeMan: {get: jest.fn()},
    markSitchDirty: jest.fn(), setRenderOne: jest.fn(), UndoManager: {add: jest.fn()}}));
jest.mock("../src/par", () => ({par: {frame: 50, paused: true}}));
jest.mock("../src/CViewManager", () => ({ViewMan: {iterate() {}}}));
jest.mock("../src/SurfaceInteraction", () => ({registerSurfaceInteraction: () => () => {}}));
jest.mock("../src/nodes/CNodeTrack", () => ({CNodeTrack: class {}}));
jest.mock("../src/nodes/CNodeController", () => ({CNodeController: class {
    constructor(v) { this.id = v.id; this.simpleSerials = []; }
    recalculateCascade() {}
    show() {}
    modSerialize() { return Object.fromEntries(this.simpleSerials.map(key => [key, this[key]])); }
    modDeserialize(v) { for (const key of this.simpleSerials) if (v[key] !== undefined) this[key] = v[key]; }
}}));
jest.mock("../src/nodes/CNodeTabbedCanvasView", () => ({CNodeTabbedCanvasView: class {
    constructor(v) {
        this.id = v.id; this.menuName = v.menuName;
        this.visible = v.visible;
        this.div = globalThis.document.createElement("div"); this.canvas = globalThis.document.createElement("canvas");
        this.div.appendChild(this.canvas); this.widthPx = 600; this.heightPx = 400;
        this.canvas.getBoundingClientRect = () => ({left: 0, top: 0, width: 600, height: 400});
        const control = {name() { return this; }, onChange() { return this; }, tooltip() { return this; }};
        this.tabMenu = {add: () => control, tooltip() {}};
    }
    enableTheme() {}
    show() {}
    dispose() {}
}}));

let editor, view, base, camera, object, source;
beforeEach(() => {
    KeyframeRegistry.providers.clear();
    Sit.frames = 101; par.frame = 50; UndoManager.add.mockClear();
    editor = new CNodeControllerHeadingEditor({id: "headingEditor", useEditor: true});
    view = editor.editorView;
    camera = new PerspectiveCamera(30); object = {camera};
    base = {apply: (f, ob) => ob.camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), f / 100)};
    source = {choice: "Heading Editor", inputs: {"To Target": base, Manual: base, "Heading Editor": editor}};
    NodeMan.get.mockImplementation(id => id === "CameraLOSController" ? source : undefined);
});

test("Clear removes both heading curves with one undo and preserves editor settings", () => {
    view.channels.pan.points = [{x: 10, y: 4}, {x: 75, y: -3}];
    view.channels.tilt.points = [{x: 20, y: 2}];
    view.channels.tilt.enabled = false;
    view.selectChannel("tilt");
    const before = view.captureState();
    view.clearKeyframes();
    expect(view.channels.pan.points).toEqual([]);
    expect(view.channels.tilt.points).toEqual([]);
    expect(view.valueAt("pan", 50)).toBe(0);
    expect(view.channels.tilt.enabled).toBe(false);
    expect(view.activeChannel).toBe("tilt");
    expect(editor.useEditor).toBe(true);
    expect(UndoManager.add).toHaveBeenCalledTimes(1);
    const action = UndoManager.add.mock.calls[0][0];
    action.undo(); expect(view.captureState()).toEqual(before);
    action.redo(); expect(view.channels.pan.points).toEqual([]);
    view.clearKeyframes(); expect(UndoManager.add).toHaveBeenCalledTimes(1);
});

test("FOV Clear notifies its owner and undo restores every key", () => {
    const fov = new CNodeCurveEditorView2({id: "fovView", menuName: "FOV Editor", visible: true,
        editorConfig: {points: [0, 5, 50, -3], minY: -10, maxY: 10, symmetricY: true}});
    fov.onChange = jest.fn();
    fov.clearKeyframes();
    expect(fov.points).toEqual([]);
    expect(fov.onChange).toHaveBeenCalledTimes(1);
    UndoManager.add.mock.calls[0][0].undo();
    expect(fov.points).toEqual([{x: 0, y: 5}, {x: 50, y: -3}]);
    expect(fov.maxY).toBe(10);
    expect(fov.visible).toBe(true);
});

test("only visible editors publish live, rounded keys from both curves for timeline navigation", () => {
    const fov = new CNodeCurveEditorView2({id: "fovView", visible: true,
        editorConfig: {points: [5, 2, 70, -4]}});
    fov.enableCameraEditorTools("FOV"); view.enableCameraEditorTools("Heading");
    view.channels.pan.points = [{x: 10, y: 2}, {x: 50, y: 3}, {x: 120, y: 4}];
    view.channels.tilt.points = [{x: 10, y: 1}, {x: 35.8, y: 2}];
    expect(KeyframeRegistry.getAllFrames()).toEqual([5, 70]);
    view.visible = true;
    expect(KeyframeRegistry.getAllFrames()).toEqual([5, 10, 36, 50, 70]);
    const frames = KeyframeRegistry.getAllFrames();
    expect(prevStop(frames, 50)).toBe(36); expect(nextStop(frames, 50)).toBe(70);
    const signature = KeyframeRegistry.signature();
    view.channels.pan.points[0].x = 15;
    view.channels.tilt.points[0].x = 15;
    expect(KeyframeRegistry.signature()).not.toBe(signature);
    view.clearKeyframes(); expect(KeyframeRegistry.getAllFrames()).toEqual([5, 70]);
    UndoManager.add.mock.calls[0][0].undo();
    expect(KeyframeRegistry.getAllFrames()).toContain(15);
    fov.visible = false; view.visible = false;
    expect(KeyframeRegistry.getAllFrames()).toEqual([]);
    fov.dispose(); view.dispose();
    expect(KeyframeRegistry.providers.size).toBe(0);
});

test("zero offsets preserve the base and edited curves interpolate with flat endpoints", () => {
    base.apply(50, object); editor.apply(50, object);
    expect(camera.quaternion.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), .5))).toBeLessThan(1e-7);
    view.channels.pan.points = [{x: 10, y: -6}, {x: 90, y: 10}];
    expect(view.valueAt("pan", 0)).toBe(-6);
    expect(view.valueAt("pan", 50)).toBe(2);
    expect(view.valueAt("pan", 100)).toBe(10);
    Sit.frames = 50;
    expect(view.valueAt("pan", 40)).toBe(-6);
});

test("positive pan turns right, positive tilt turns up, and sampling never accumulates", () => {
    view.channels.pan.points = [{x: 0, y: 5}]; view.channels.tilt.points = [{x: 0, y: 3}];
    editor.apply(0, object);
    const direction = camera.getWorldDirection(new Vector3());
    expect(direction.x).toBeGreaterThan(0); expect(direction.y).toBeGreaterThan(0);
    base.apply(50, object); editor.apply(50, object); const pose = camera.quaternion.clone();
    const basePose = editor.getBaseQuaternion(camera).clone();
    for (let i = 0; i < 20; i++) editor.apply(50, object);
    expect(camera.quaternion.angleTo(pose)).toBeLessThan(1e-7);
    const sample = {camera: camera.clone(), isCameraSample: true};
    editor.apply(90, sample); editor.apply(10, sample);
    expect(editor.getBaseQuaternion(camera).equals(basePose)).toBe(true);
    base.apply(20, object); editor.apply(20, object); base.apply(50, object); editor.apply(50, object);
    expect(camera.quaternion.angleTo(pose)).toBeLessThan(1e-7);
});

test("look-view drag inserts both keys once, updates them and has one undo", () => {
    editor.beginViewDrag(); editor.dragView(2, -3); editor.dragView(1, 1); editor.endViewDrag();
    expect(view.channels.pan.points).toEqual([{x: 0, y: 0}, {x: 50, y: 3}]);
    expect(view.channels.tilt.points).toEqual([{x: 0, y: 0}, {x: 50, y: -2}]);
    expect(UndoManager.add).toHaveBeenCalledTimes(1);
    const undo = UndoManager.add.mock.calls[0][0];
    undo.undo(); expect(view.valueAt("pan", 50)).toBe(0);
    undo.redo(); expect(view.valueAt("pan", 50)).toBe(3);
    editor.beginViewDrag(); editor.dragView(2, 0); editor.endViewDrag();
    expect(view.channels.pan.points).toHaveLength(2);
    expect(view.valueAt("pan", 50)).toBe(5);
});

test("disabled channels and zero-motion axes are untouched; cancelled drags restore keys", () => {
    view.channels.tilt.enabled = false;
    editor.beginViewDrag(); editor.dragView(2, -3); editor.endViewDrag();
    expect(view.channels.tilt.points).toEqual([{x: 0, y: 0}]);
    expect(view.valueAt("tilt", 50)).toBe(0);
    editor.beginViewDrag(); editor.dragView(8, 0); editor.endViewDrag(true);
    expect(view.valueAt("pan", 50)).toBe(2);
    expect(UndoManager.add).toHaveBeenCalledTimes(1);
});

test("both curves, axis ranges, enable flags and use setting survive serialization", () => {
    view.channels.pan.range = 25; view.channels.tilt.range = 2;
    view.channels.tilt.enabled = false;
    view.channels.pan.points = [{x: 0, y: -4}, {x: 60, y: 7}];
    view.selectChannel("tilt");
    const state = editor.modSerialize();
    const restored = new CNodeControllerHeadingEditor({id: "restored"});
    restored.modDeserialize(state);
    expect(restored.modSerialize()).toEqual(state);
    expect(restored.editorView.minY).toBe(-2);
    expect(restored.editorView.maxY).toBe(2);
});

test("dragging either graph curve uses its own scale and undo remains valid after switching", () => {
    view.channels.pan.range = 20; view.channels.tilt.range = 2;
    view.channels.pan.points = [{x: 50, y: 10}]; view.channels.tilt.points = [{x: 50, y: -1}];
    view.selectChannel("pan");
    const event = (x, y) => ({clientX: x, clientY: y, button: 0, shiftKey: false,
        preventDefault() {}, stopPropagation() {}});
    // Tilt = -1 on its ±2 axis is y=270, even while Pan is selected.
    view.onMouseDown(event(300, 270)); view.onMouseMove(event(300, 235)); view.onMouseUp(event(300, 235));
    expect(view.activeChannel).toBe("tilt");
    expect(view.channels.tilt.points[0].y).toBeCloseTo(-.5);
    expect(view.channels.pan.points[0].y).toBe(10);
    view.selectChannel("pan"); UndoManager.add.mock.calls[0][0].undo();
    expect(view.channels.tilt.points[0].y).toBe(-1);
    expect(view.channels.pan.points[0].y).toBe(10);
});

function graphEvent(x, y, extra = {}) {
    const screen = view.graphToScreen(x, y);
    return {clientX: screen.x, clientY: screen.y, button: 0, shiftKey: false,
        preventDefault() {}, stopPropagation() {}, ...extra};
}

function dragGraph(from, to) {
    view.onMouseDown(graphEvent(...from));
    view.onMouseMove(graphEvent(...to));
    view.onMouseUp(graphEvent(...to));
}

test("Sync Keyframes replaces the dropdown and pairs mismatched frames without changing either curve", () => {
    view.channels.pan.points = [{x: 10, y: 2}, {x: 90, y: 10}];
    view.channels.tilt.points = [{x: 20, y: -3}, {x: 60, y: 5}];
    const before = view.captureState();
    const values = Array.from({length: 101}, (_, f) => [view.valueAt("pan", f), view.valueAt("tilt", f)]);
    expect(view.channelControls.querySelector("select")).toBeNull();
    expect(view.syncButton.textContent).toBe("Sync Keyframes");
    view.syncButton.click();
    expect(view.syncButton.getAttribute("aria-pressed")).toBe("true");
    for (const channel of Object.values(view.channels)) expect(channel.points.map(p => p.x)).toEqual([10, 20, 60, 90]);
    values.forEach(([pan, tilt], f) => {
        expect(view.valueAt("pan", f)).toBeCloseTo(pan);
        expect(view.valueAt("tilt", f)).toBeCloseTo(tilt);
    });
    const after = view.captureState();
    const action = UndoManager.add.mock.calls[0][0];
    action.undo(); expect(view.captureState()).toEqual(before);
    action.redo(); expect(view.captureState()).toEqual(after);
    view.controls.tilt.select.click();
    expect(view.activeChannel).toBe("tilt");
    expect(view.channels.tilt.enabled).toBe(true);
});

test.each(["pan", "tilt"])("dragging a synced %s point moves only its partner's frame, with live updates and undo", key => {
    view.channels.pan.points = [{x: 20, y: 2}, {x: 50, y: 4}, {x: 80, y: 6}];
    view.channels.tilt.points = [{x: 20, y: -1}, {x: 50, y: -2}, {x: 80, y: -3}];
    view.toggleSyncKeyframes();
    view.selectChannel(key);
    UndoManager.add.mockClear();
    const other = key === "pan" ? "tilt" : "pan";
    const otherValues = view.channels[other].points.map(p => p.y);
    const before = view.captureState();
    const y = view.channels[key].points[1].y;
    view.onChange = jest.fn(() => {
        expect(view.channels[other].points.map(p => p.x)).toEqual(view.channels[key].points.map(p => p.x));
    });
    dragGraph([50, y], [60, y + 1]);
    expect(view.channels[key].points[1].x).toBeCloseTo(60);
    expect(view.channels[key].points[1].y).toBeCloseTo(y + 1);
    expect(view.channels[other].points.map(p => p.y)).toEqual(otherValues);
    expect(view.onChange).toHaveBeenCalled();
    expect(UndoManager.add).toHaveBeenCalledTimes(1);
    const after = view.captureState(), action = UndoManager.add.mock.calls[0][0];
    action.undo(); expect(view.captureState()).toEqual(before);
    action.redo(); expect(view.captureState()).toEqual(after);
    // Restoring state must rebuild the pairs for the next drag.
    dragGraph([60, y + 1], [65, y + 2]);
    expect(view.channels[other].points[1].x).toBeCloseTo(65);
    view.toggleSyncKeyframes();
    view.onChange = jest.fn();
    dragGraph([65, y + 2], [70, y + 2]);
    expect(view.channels[other].points[1].x).toBeCloseTo(65);
});

test.each(["pan", "tilt"])("dragging a synced %s segment moves both partners and pushed neighbors", key => {
    view.channels.pan.points = [{x: 10, y: 1}, {x: 30, y: 3}, {x: 50, y: 5}, {x: 90, y: 8}];
    view.channels.tilt.points = [{x: 10, y: -1}, {x: 30, y: -3}, {x: 50, y: -5}, {x: 90, y: -8}];
    view.toggleSyncKeyframes(); view.selectChannel(key); UndoManager.add.mockClear();
    const other = key === "pan" ? "tilt" : "pan";
    const otherValues = view.channels[other].points.map(p => p.y);
    const before = view.captureState(), y = key === "pan" ? 4 : -4;
    dragGraph([40, y], [85, y + 1]);
    for (const channel of Object.values(view.channels)) {
        channel.points.forEach((p, i) => expect(p.x).toBeCloseTo([10, 75, 95, 96][i]));
    }
    expect(view.channels[other].points.map(p => p.y)).toEqual(otherValues);
    expect(UndoManager.add).toHaveBeenCalledTimes(1);
    UndoManager.add.mock.calls[0][0].undo(); expect(view.captureState()).toEqual(before);
});

test("flat segment splitting creates partners before moving its two new endpoints", () => {
    view.channels.pan.points = [0, 20, 40, 80].map(x => ({x, y: 3}));
    view.channels.tilt.points = [{x: 0, y: -2}, {x: 20, y: -4}, {x: 40, y: -6}, {x: 80, y: -8}];
    view.toggleSyncKeyframes();
    dragGraph([30, 3], [40, 5]);
    for (const channel of Object.values(view.channels)) {
        channel.points.forEach((p, i) => expect(p.x).toBeCloseTo([0, 20, 31, 49, 50, 80][i]));
    }
    view.channels.tilt.points.forEach((p, i) => expect(p.y).toBeCloseTo([-2, -4, -4.1, -5.9, -6, -8][i]));
});

test("adding and deleting synced keys edits both curves in the same undo action", () => {
    view.canvas.width = 600; view.canvas.height = 400;
    view.channels.pan.points = [{x: 0, y: 2}, {x: 100, y: 4}];
    view.channels.tilt.points = [{x: 0, y: -2}, {x: 100, y: -6}];
    view.toggleSyncKeyframes(); UndoManager.add.mockClear();
    const before = view.captureState();
    view.onMouseDown(graphEvent(50, 6, {ctrlKey: true, metaKey: true}));
    view.onMouseUp(graphEvent(50, 6));
    expect(view.channels.pan.points[1].x).toBeCloseTo(50);
    expect(view.channels.pan.points[1].y).toBeCloseTo(6);
    expect(view.channels.tilt.points[1].x).toBe(view.channels.pan.points[1].x);
    expect(view.channels.tilt.points[1].y).toBeCloseTo(-4);
    expect(UndoManager.add).toHaveBeenCalledTimes(1);
    const added = view.captureState(), add = UndoManager.add.mock.calls[0][0];
    add.undo(); expect(view.captureState()).toEqual(before);
    add.redo(); expect(view.captureState()).toEqual(added);
    view.deletePointWithUndo(view.points[1]);
    expect(view.captureState()).toEqual(before);
    UndoManager.add.mock.calls[1][0].undo(); expect(view.captureState()).toEqual(added);
});

test("sync survives serialization and pairs one-axis look drags even when the other channel is disabled", () => {
    view.channels.pan.points = [{x: 0, y: 2}, {x: 49.8, y: 3}];
    view.channels.tilt.points = [{x: 0, y: -4}, {x: 49.8, y: -5}];
    view.channels.tilt.enabled = false;
    view.toggleSyncKeyframes();
    const state = editor.modSerialize();
    const restored = new CNodeControllerHeadingEditor({id: "restored"});
    restored.modDeserialize(state);
    expect(restored.modSerialize()).toEqual(state);
    restored.beginViewDrag(); restored.dragView(1, 0); restored.endViewDrag();
    expect(restored.editorView.channels.pan.points[1]).toEqual({x: 50, y: 4});
    expect(restored.editorView.channels.tilt.points[1]).toEqual({x: 50, y: -5});
    par.frame = 70;
    restored.beginViewDrag(); restored.dragView(1, 0); restored.endViewDrag();
    expect(restored.editorView.channels.tilt.points[2]).toEqual({x: 70, y: -5});
    const legacy = {...state.curves}; delete legacy.syncKeyframes;
    restored.editorView.restoreState(legacy);
    expect(restored.editorView.syncKeyframes).toBe(false);
});
