/** @jest-environment jsdom */
import {Group, Mesh, MeshBasicMaterial, PerspectiveCamera, SphereGeometry, Vector2} from "three";
import {ObjectMoveWidget} from "../src/CObjectMoveWidget";
import {GlobalScene} from "../src/LocalFrame";
import {ViewMan} from "../src/CViewManager";
import {disposeScene} from "../src/threeExt";
import {getInteractionRouter} from "../src/InteractionRouter";
import {undoManager} from "../src/UndoManager";

jest.mock("../src/nodes/CNode3DObject", () => ({CNode3DObject: class {}}));
jest.mock("../src/LocalFrame", () => ({GlobalScene: new (require("three").Group)()}));
jest.mock("../src/CViewManager", () => ({ViewMan: {get: jest.fn(), iterate: jest.fn()}}));
jest.mock("../src/threeExt", () => ({...jest.requireActual("../src/threeExt"), getPointBelow: p => p.clone()}));
jest.mock("../src/UndoManager", () => ({undoManager: {add: jest.fn()}}));

let view;
beforeEach(() => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(6371100, 0, 0);
    camera.lookAt(6371000, 0, 0);
    camera.updateMatrixWorld(true);
    camera.layers.mask = 105;
    view = {camera, renderer: {domElement: document.createElement("canvas")},
        controls: {enabled: true}, focusTrackName: "default", pixelsToMeters: (p, px) => px / 2};
    ViewMan.get.mockReturnValue(view);
    ViewMan.iterate.mockImplementation(fn => fn("mainView", view));
    undoManager.add.mockClear();
});
afterEach(() => {
    ObjectMoveWidget.resetForSitch();
    disposeScene(GlobalScene);
    getInteractionRouter().dispose();
});

function attachObject() {
    const node = {id: "object", group: new Group()};
    node.group.position.set(6371000, 0, 0);
    node.group.add(new Mesh(new SphereGeometry(1), new MeshBasicMaterial()));
    GlobalScene.add(node.group);
    const move = ObjectMoveWidget;
    move.setNode(node);
    move.setWidgetAttached(true);
    move.fade = 1;
    move.applyFade();
    move.updateDropLine();
    move.widget.updateHandleScales(view);
    move.widget.group.updateMatrixWorld(true);
    return node;
}

function expectUsableHandles() {
    const widget = ObjectMoveWidget.widget;
    expect(widget.group.parent).toBe(GlobalScene);
    expect(widget.group.children).toHaveLength(3);
    expect(widget.handles.arrowUp.children).toHaveLength(4);
    expect(widget.handles.arrowDown.children).toHaveLength(4);
    widget.raycaster.setFromCamera(new Vector2(0, 0), view.camera);
    expect(widget.pickHandle()).toBeDefined();
    expect(widget.pickHandle()).not.toBeNull();
}

test("switching sitches after a hover rebuilds visible, pickable handles without stale registrations", () => {
    const move = ObjectMoveWidget, router = getInteractionRouter();
    const providers = router.providers.size;
    let oldWidget;
    for (let load = 0; load < 3; load++) {
        const node = attachObject();
        expectUsableHandles();
        expect(move.widget).not.toBe(oldWidget);
        expect(router.providers.size).toBe(providers + 1);
        expect(node.group.children[0].material.opacity).toBe(0.25);
        oldWidget = move.widget;
        const discDispose = jest.spyOn(oldWidget.handles.disc.geometry, "dispose");
        const line = move.dropLine;
        const lineDispose = jest.spyOn(line.geometry, "dispose");
        move.altHeld = move.altMode = true;
        move.suppressCamera(true);
        expect(view.controls.enabled).toBe(false);

        // Same ordering as disposeEverything: release the editor while its nodes
        // still exist, then recursively empty and dispose the scene.
        move.resetForSitch();
        expect(node.group.children[0].material.opacity).toBe(1);
        expect(node.group.userData.ignoreContextMenu).toBeUndefined();
        expect(view.controls.enabled).toBe(true);
        expect(router.providers.size).toBe(providers);
        expect(move.widget).toBeNull();
        expect(move.node).toBeNull();
        expect(move.dropLine).toBeNull();
        expect(move.altHeld).toBe(false);
        expect(discDispose).toHaveBeenCalledTimes(1);
        expect(lineDispose).toHaveBeenCalledTimes(1);
        disposeScene(GlobalScene);
    }
});

test("teardown during a drag releases the pointer and cameras without recording an unfinished move", () => {
    attachObject();
    const move = ObjectMoveWidget;
    move.dragging = move.dragPrepared = true;
    move.widget.isDragging = true;
    move.suppressCamera(true);
    move.resetForSitch();
    expect(undoManager.add).not.toHaveBeenCalled();
    expect(move.dragging).toBe(false);
    expect(move.dragPrepared).toBe(false);
    expect(view.controls.enabled).toBe(true);
    expect(() => move.resetForSitch()).not.toThrow();
});
