import {Group, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Raycaster, SphereGeometry, Vector3} from "three";
import {ObjectMoveWidget, withObjectMoveWidgetVisible} from "../src/CObjectMoveWidget";
import {CNodeBalloonTrack} from "../src/nodes/CNodeBalloonTrack";
import {CNode3DObject} from "../src/nodes/CNode3DObject";
import {Globals, mainLoopCount, setCustomManager, setNodeMan, setSit} from "../src/Globals";
import {updateObjectLocatorRings} from "../src/ObjectLocatorOverlay";
import {ViewMan} from "../src/CViewManager";
import {LLAToECEF, ECEFToLLAVD_radii} from "../src/LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "../src/EGM96Geoid";
import {getLocalEastVector, getLocalUpVector} from "../src/SphericalMath";
import {getPointBelow} from "../src/threeExt";
import {undoManager} from "../src/UndoManager";

jest.mock("../src/nodes/CNodeTrack", () => ({CNodeTrack: class CNodeTrack {}}));
jest.mock("../src/nodes/CNode3DObject", () => {
    class CNode3D {}
    return {CNode3DObject: class CNode3DObject extends CNode3D {}};
});
jest.mock("../src/LocalFrame", () => ({GlobalScene: new (require("three").Group)()}));
jest.mock("../src/threeExt", () => ({getPointBelow: jest.fn(p => p.clone())}));
jest.mock("../src/CViewManager", () => ({ViewMan: {iterate: jest.fn()}}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: (lat, lon) => 20 + lat * .1 + lon * .03}));
jest.mock("../src/UndoManager", () => ({undoManager: {add: jest.fn()}}));
jest.mock("../src/ObjectLocatorOverlay", () => ({updateObjectLocatorRings: jest.fn()}));

class CNodeController {}
class CNodeControllerTrackPosition extends CNodeController {
    constructor(track) { super(); this.isController = true; this.inputs = {sourceTrack: track}; }
}
function objectFor(track) {
    return Object.assign(new CNode3DObject(), {id: "editableObject", group: new Group(),
        inputs: {position: new CNodeControllerTrackPosition(track)}});
}
function param(value) {
    return {value, get v0() { return this.value; }, setValue: jest.fn(function(value) { this.value = value; })};
}
function balloon() {
    const node = Object.assign(Object.create(CNodeBalloonTrack.prototype), {
        id: "balloon", startLat: 34, startLon: -118,
        in: {startAltitude: param(100), launchDelay: param(1), buoyancy: param(5), windVariability: param(20), seed: param(12)},
        recalculateCascade: jest.fn(function() { this.recalculate(); }),
    });
    node.recalculate();
    return node;
}
let moveNodes;
function startMove(node, frame = 0) {
    const widget = ObjectMoveWidget;
    widget.node = objectFor(node);
    widget.target = widget.movableTarget(widget.node);
    widget.dragging = true; widget.dragPrepared = false;
    widget.proxy = new Object3D();
    widget.proxy.position.copy(node.array?.[frame].position ?? node.ecef);
    widget.dragAnchor = widget.proxy.position.clone();
    widget.node.group.position.copy(widget.proxy.position);
    widget.widget = null;
    return widget;
}
beforeEach(() => {
    setSit({frames: 120, fps: 30, simSpeed: 1, lat: 34, lon: -118});
    moveNodes = new Map([["targetWind", {from: 270, knots: 10}]]);
    setNodeMan({get: id => moveNodes.get(id)});
    jest.clearAllMocks();
});
afterEach(() => {
    ObjectMoveWidget.dragging = false; ObjectMoveWidget.dragPrepared = false;
    ObjectMoveWidget.widget = ObjectMoveWidget.target = ObjectMoveWidget.node = null;
    ObjectMoveWidget.otherKeysHeld.clear();
    ObjectMoveWidget.altHeld = ObjectMoveWidget.altMode = false;
});

test("Option-C releases object picking and pointer movement cannot reenable it", () => {
    const widget = ObjectMoveWidget;
    widget.updateHeldKey({key:'Alt',code:'AltLeft',altKey:true}, true);
    expect(widget.altHeld).toBe(true);
    widget.altMode = true;
    const release = jest.spyOn(widget,'suppressCamera').mockImplementation(()=>{});
    widget.updateHeldKey({key:'ç',code:'KeyC',altKey:true}, true);
    expect(widget.altHeld).toBe(false);
    expect(widget.altMode).toBe(false);
    expect(release).toHaveBeenCalledWith(false);
    widget.updateAltHeld({altKey:true});
    expect(widget.altHeld).toBe(false);
    widget.updateHeldKey({key:'c',code:'KeyC',altKey:true}, false);
    expect(widget.altHeld).toBe(true);
    release.mockRestore();
});

test('cycling modes with Alt+M keeps Alt object movement active', () => {
    const widget = ObjectMoveWidget;
    widget.updateHeldKey({key: 'Alt', code: 'AltLeft', altKey: true}, true);
    widget.updateHeldKey({key: 'µ', code: 'KeyM', altKey: true}, true);
    expect(widget.altHeld).toBe(true);
    widget.updateHeldKey({key: 'µ', code: 'KeyM', altKey: true}, false);
    expect(widget.altHeld).toBe(true);
    widget.updateHeldKey({key: 'Alt', code: 'AltLeft', altKey: false}, false);
    expect(widget.altHeld).toBe(false);
});

test("a key held before Option and repeated keydowns also block object picking", () => {
    const widget=ObjectMoveWidget;
    widget.updateHeldKey({key:'w',code:'KeyW',altKey:false},true);
    widget.updateHeldKey({key:'w',code:'KeyW',altKey:false},true);
    widget.updateHeldKey({key:'Alt',code:'AltLeft',altKey:true},true);
    expect(widget.altHeld).toBe(false);
    widget.updateHeldKey({key:'x',code:'KeyX',altKey:true},true);
    widget.updateHeldKey({key:'w',code:'KeyW',altKey:true},false);
    expect(widget.altHeld).toBe(false);
    widget.updateHeldKey({key:'x',code:'KeyX',altKey:true},false);
    expect(widget.altHeld).toBe(true);
});

test.each(['shiftKey','metaKey'])("Option plus %s does not pick objects", modifier => {
    ObjectMoveWidget.updateAltHeld({altKey:true,[modifier]:true});
    expect(ObjectMoveWidget.altHeld).toBe(false);
});

test('Option-Control keeps the object active, and a rotation edits only Rotate Y with one undo', () => {
    const widget = startMove(balloon());
    widget.updateHeldKey({key: 'Control', code: 'ControlLeft', altKey: true, ctrlKey: true}, true);
    expect(widget.altHeld).toBe(true);
    const node = widget.node, position = widget.target.position.getLLA();
    moveNodes.set(node.id, node);
    node.common = {rotateY: 175};
    widget.rotationStart = 175;
    widget.rotateByPixels(20);
    expect(node.common.rotateY).toBe(-175);
    widget.rotateByPixels(30);
    widget.endDrag();
    expect(widget.target.position.getLLA()).toEqual(position);
    expect(undoManager.add).toHaveBeenCalledTimes(1);
    const undo = undoManager.add.mock.calls[0][0];
    undo.undo(); expect(node.common.rotateY).toBe(175);
    undo.redo(); expect(node.common.rotateY).toBe(-170);
    widget.rotationStart = -170; widget.dragging = true;
    widget.rotateByPixels(-40); widget.rollbackDrag();
    expect(node.common.rotateY).toBe(-170);
    expect(undoManager.add).toHaveBeenCalledTimes(1);
});

test("Option cannot select an object through the globe, but can select it from the other side", () => {
    const widget = ObjectMoveWidget, node = objectFor({});
    const mesh = new Mesh(new SphereGeometry(), new MeshBasicMaterial());
    node.group.add(mesh);
    node.group.position.set(-Globals.equatorRadius - 100, 0, 0);
    const view = {camera: new PerspectiveCamera()};
    view.camera.position.set(Globals.equatorRadius + 1000, 0, 0);
    const spies = [
        jest.spyOn(widget, "objects").mockReturnValue([node]),
        jest.spyOn(widget, "viewUnderCursor").mockReturnValue(view),
        jest.spyOn(widget, "cursorDistancePx").mockReturnValue(0),
        jest.spyOn(widget, "movableTarget").mockReturnValue({kind: "fixed", node: {}}),
    ];
    try {
        expect(widget.findObjectUnderCursor()).toBeNull();
        view.camera.position.x *= -1;
        expect(widget.findObjectUnderCursor()?.node).toBe(node);
    } finally {
        spies.forEach(spy => spy.mockRestore());
        mesh.geometry.dispose(); mesh.material.dispose();
    }
});

test("a view that hides the camera or target widget cannot disable dragging in another view", () => {
    const widget = ObjectMoveWidget, node = objectFor({}), helper = new Group(), line = new Group();
    const mesh = new Mesh(new SphereGeometry(), new MeshBasicMaterial()); node.group.add(mesh);
    node.group.position.set(Globals.equatorRadius + 100, 0, 0);
    const view = {camera: new PerspectiveCamera()};
    view.camera.position.set(-Globals.equatorRadius - 1000, 0, 0);
    const previous = {node: widget.node, widget: widget.widget, dropLine: widget.dropLine};
    Object.assign(widget, {node, widget: {getHelper: () => helper}, dropLine: line});
    try {
        withObjectMoveWidgetVisible(view, () => {
            expect(helper.visible).toBe(false); expect(line.visible).toBe(false);
        });
        expect(helper.visible).toBe(true); expect(line.visible).toBe(true);
        view.camera.position.x *= -1;
        withObjectMoveWidgetVisible(view, () => expect(helper.visible).toBe(true));
        view._renderHiddenNodeIDs = new Set([node.id]);
        withObjectMoveWidgetVisible(view, () => expect(helper.visible).toBe(false));
        expect(helper.visible).toBe(true);
    } finally {
        Object.assign(widget, previous); mesh.geometry.dispose(); mesh.material.dispose();
    }
});

test("an edited object owns the ring; otherwise Alt highlights every shown object and release clears them", () => {
    const widget = ObjectMoveWidget;
    const selected = objectFor({}), other = objectFor({}), hidden = objectFor({});
    other.id = "other"; hidden.id = "hidden";
    for (const node of [selected, other, hidden]) {
        node.group.add(new Mesh(new SphereGeometry(), new MeshBasicMaterial()));
    }
    hidden.group.visible = false;
    const view = {id: "mainView", camera: new PerspectiveCamera()};
    const manager = {getEditingObjectNode: () => selected};
    setCustomManager(manager);
    const objects = jest.spyOn(widget, "objects").mockReturnValue([selected, other, hidden]);
    widget.lastMainLoopCount = mainLoopCount;
    widget.widget = null;
    try {
        widget.altHeld = true;
        widget.update(view);
        expect(updateObjectLocatorRings).toHaveBeenLastCalledWith(view, [selected]);
        manager.getEditingObjectNode = () => null;
        widget.update(view);
        expect(updateObjectLocatorRings).toHaveBeenLastCalledWith(view, [selected, other]);
        widget.altHeld = false;
        widget.update(view);
        expect(updateObjectLocatorRings).toHaveBeenLastCalledWith(view, []);
    } finally {
        objects.mockRestore(); setCustomManager(null); widget.altHeld = false;
        widget.lastMainLoopCount = -1;
        for (const node of [selected, other, hidden]) {
            node.group.children[0].geometry.dispose(); node.group.children[0].material.dispose();
        }
    }
});

test("dragging suspends only matching camera focus and never restores a stale selection", () => {
    const a = {id: "a"}, b = {id: "b"};
    const selected = {id: "selected", choice: "A", inputs: {A: a, B: b}};
    const tracks = {a, b, selected};
    setNodeMan({get: id => tracks[id]});
    const main = {focusTrackName: "a"}, look = {focusTrackName: "b"};
    ViewMan.iterate.mockImplementation(fn => {fn("mainView", main); fn("lookView", look);});
    const widget = ObjectMoveWidget;
    try {
        widget.node = objectFor(selected);
        widget.dragging = true;
        widget.updateEditFocus();
        expect(main.suspendObjectFocus).toBe(true);
        expect(look.suspendObjectFocus).toBe(false);
        expect(main.focusTrackName).toBe("a");

        // A menu choice during a drag takes effect immediately. Dropping the
        // object must not restore whichever track was focused before the drag.
        main.focusTrackName = "b";
        widget.updateEditFocus();
        expect(main.suspendObjectFocus).toBe(false);
        widget.dragging = false;
        widget.updateEditFocus();
        expect(main.focusTrackName).toBe("b");

        main.focusTrackName = "a";
        widget.dragging = true;
        widget.updateEditFocus();
        widget.dragging = false;
        widget.node = null;
        widget.updateEditFocus();
        expect(main.suspendObjectFocus).toBe(false);
        expect(main.focusTrackName).toBe("a");
    } finally {ViewMan.iterate.mockImplementation(() => {});}
});

test.each([0, 90])("balloon drag at frame %s moves the launch point and rebakes, with undo and redo", frame => {
    const node = balloon(), oldPath = node.array, initial = node.getPositionEditTarget().getLLA();
    const widget = startMove(node, frame);
    expect(widget.target.kind).toBe("fixed");
    const base = widget.target.position.getECEF();
    const delta = getLocalEastVector(base).multiplyScalar(30).addScaledVector(getLocalUpVector(base), 12);
    widget.proxy.position.add(delta);
    widget.onWidgetMoved();
    expect(node.recalculateCascade).toHaveBeenCalledTimes(1);
    expect(node.in.startAltitude.setValue).toHaveBeenCalledWith(expect.any(Number), true);
    expect(node.array).not.toBe(oldPath);
    const moved = node.getPositionEditTarget().getLLA();
    expect(moved[1]).not.toBe(initial[1]);
    const expected = ECEFToLLAVD_radii(base.clone().add(delta));
    expect(moved[2]).toBeCloseTo(expected.z - meanSeaLevelOffset(expected.x, expected.y), 8);
    expect(node.array[0].position.distanceTo(base.clone().add(delta))).toBeLessThan(1e-7);
    // Editing a later frame must still move the original launch point, not
    // overwrite it with the already risen/drifted balloon's current position.
    expect(moved[2]).toBeCloseTo(112, 2);
    expect([node.in.launchDelay.v0,node.in.buoyancy.v0,node.in.windVariability.v0,node.in.seed.v0]).toEqual([1,5,20,12]);
    widget.endDrag();
    expect(undoManager.add).toHaveBeenCalledTimes(1);
    const undo = undoManager.add.mock.calls[0][0];
    const movedPath = node.array.map(p => p.position.toArray());
    undo.undo();
    expect(node.getPositionEditTarget().getLLA()).toEqual(initial);
    expect(node.array.map(p => p.position.toArray())).toEqual(oldPath.map(p => p.position.toArray()));
    undo.redo();
    expect(node.getPositionEditTarget().getLLA()).toEqual(moved);
    expect(node.array.map(p => p.position.toArray())).toEqual(movedPath);
});

test("balloon cancellation restores the launch point and generated path without undo", () => {
    const node = balloon(), before = node.array.map(p => p.position.toArray());
    const initial = node.getPositionEditTarget().getLLA(), widget = startMove(node);
    widget.proxy.position.addScaledVector(getLocalUpVector(widget.proxy.position), 25);
    widget.onWidgetMoved(); widget.rollbackDrag();
    expect(node.getPositionEditTarget().getLLA()).toEqual(initial);
    expect(node.array.map(p => p.position.toArray())).toEqual(before);
    expect(undoManager.add).not.toHaveBeenCalled();
});

test.each([false, true])("existing fixed-position editing retains altitude handling and undo (AGL %s)", agl => {
    const root = Object.assign(Object.create(Object.getPrototypeOf(CNodeBalloonTrack.prototype)), {
        _LLA: [34,-118,100], agl,
        ecef: LLAToECEF(34,-118,100 + meanSeaLevelOffset(34,-118)),
        setLLA(lat,lon,alt) { this._LLA = [lat,lon,alt]; },
    });
    const widget = startMove(root), before = root._LLA.slice();
    widget.proxy.position.addScaledVector(getLocalEastVector(root.ecef), 20);
    widget.onWidgetMoved();widget.endDrag();
    expect(root._LLA[1]).not.toBe(before[1]);
    if (agl) expect(root._LLA[2]).toBeCloseTo(before[2], 8);
    undoManager.add.mock.calls[0][0].undo();
    expect(root._LLA).toEqual(before);
});

test("data tracks stay read-only and spline targets keep their existing edit path", () => {
    const root = Object.create(Object.getPrototypeOf(CNodeBalloonTrack.prototype));
    expect(ObjectMoveWidget.movableTarget(objectFor(root))).toBeNull();
    root.splineEditor = {enable:false};
    expect(ObjectMoveWidget.movableTarget(objectFor(root))).toMatchObject({kind:"spline",node:root});
    root.splineEditor.enable = true;
    expect(ObjectMoveWidget.movableTarget(objectFor(root))).toBeNull();
});

test.each(['lookCameraPlane', 'push', 'screenPlane'])('a %s drag converts AGL at its destination, with undo and redo', mode => {
    const groundHeight = 75;
    const root = Object.assign(Object.create(Object.getPrototypeOf(CNodeBalloonTrack.prototype)), {
        _LLA: [34, -118, 100], agl: true,
        ecef: LLAToECEF(34, -118, 100 + groundHeight),
        setLLA(lat, lon, alt) {
            this._LLA = [lat, lon, alt];
            this.ecef = LLAToECEF(lat, lon, alt + groundHeight);
        },
    });
    const widget = startMove(root), before = root._LLA.slice();
    widget.widget = {activeDragMode: mode};
    const destination = root.ecef.clone().addScaledVector(getLocalEastVector(root.ecef), 2000)
        .addScaledVector(getLocalUpVector(root.ecef), 40);
    getPointBelow.mockImplementationOnce(p => {
        const lla = ECEFToLLAVD_radii(p);
        return LLAToECEF(lla.x, lla.y, groundHeight);
    });
    widget.proxy.position.copy(destination);
    widget.onWidgetMoved();
    expect(root.ecef.distanceTo(destination)).toBeLessThan(1e-6);
    widget.endDrag();
    const undo = undoManager.add.mock.calls[0][0];
    undo.undo();
    expect(root._LLA).toEqual(before);
    undo.redo();
    expect(root.ecef.distanceTo(destination)).toBeLessThan(1e-6);
    widget.widget = null;
});


test('body picking uses the visible model at this view scale and restores shared state', () => {
    const group = new Group(), material = new MeshBasicMaterial();
    const mesh = new Mesh(new SphereGeometry(10, 24, 16), material);
    group.add(mesh);
    group.position.set(Globals.equatorRadius + 1000, 0, 0);
    const node = {id: 'body', group, _viewScale: 1, applyViewScale(view) {
        this._viewScale = view.id === 'mainView' ? 2 : 1;
        group.scale.setScalar(this._viewScale);
    }};
    ObjectMoveWidget.node = node;
    const camera = new PerspectiveCamera();
    camera.position.copy(group.position).add(new Vector3(0, 0, 100));
    const view = {id: 'mainView', camera};
    const ray = new Raycaster(camera.position.clone().add(new Vector3(15, 0, 0)), new Vector3(0, 0, -1));
    ray.layers.set(5); // Helper-only until the body pick temporarily uses the view mask.
    try {
        expect(ObjectMoveWidget.pickObjectSurface(ray, view)?.object).toBe(mesh);
        expect(ray.layers.mask).toBe(32);
        expect(group.scale.toArray()).toEqual([1, 1, 1]);
        expect(node._viewScale).toBe(1);
        expect(ObjectMoveWidget.pickObjectSurface(ray, {...view, id: 'lookView'})).toBeNull();
        mesh.visible = false;
        expect(ObjectMoveWidget.pickObjectSurface(ray, view)).toBeNull();
        mesh.visible = true;
        expect(ObjectMoveWidget.pickObjectSurface(ray, {...view, _renderHiddenNodeIDs: new Set(['body'])})).toBeNull();
    } finally { mesh.geometry.dispose(); material.dispose(); }
});

test.each(["render-hidden", "ancestor-hidden", "mesh-hidden", "different-layer"])("Alt hover ignores a closer %s object overlapping the balloon", hiddenKind => {
    const root = balloon(), visible = objectFor(root), hidden = objectFor(root);
    visible.id = "balloonObject"; hidden.id = "traverseObject";
    const material = new MeshBasicMaterial({opacity:1, transparent:false});
    visible.group.add(new Mesh(new SphereGeometry(1), material));
    hidden.group.add(new Mesh(new SphereGeometry(1), material.clone()));
    hidden.group.position.x = .0001;
    visible.group.position.z = hidden.group.position.z = Globals.polarRadius + 100;
    const camera = new PerspectiveCamera(50,1,.1,1000);
    camera.position.z = Globals.polarRadius + 200;camera.updateMatrixWorld(true);
    const rect = {left:0,top:0,width:200,height:200};
    const view = {id:"mainView",camera,widthPx:200,heightPx:200,leftPx:0,topPx:0,
        div:{getBoundingClientRect:()=>rect},canvas:{getBoundingClientRect:()=>rect},_renderHiddenNodeIDs:new Set()};
    const parent = new Group();parent.add(hidden.group);
    if (hiddenKind === "render-hidden") view._renderHiddenNodeIDs.add(hidden.id);
    if (hiddenKind === "ancestor-hidden") parent.visible = false;
    if (hiddenKind === "mesh-hidden") hidden.group.children[0].visible = false;
    if (hiddenKind === "different-layer") hidden.group.children[0].layers.set(1);
    const widget = ObjectMoveWidget;
    const views = jest.spyOn(widget,"viewUnderCursor").mockReturnValue(view);
    const objects = jest.spyOn(widget,"objects").mockReturnValue([hidden,visible]);
    widget.pointerX=110;widget.pointerY=100;
    try {
        expect(widget.cursorDistancePx(view,hidden.group.position)).toBeLessThan(widget.cursorDistancePx(view,visible.group.position));
        const pick=widget.findObjectUnderCursor();
        expect(pick.node).toBe(visible);
        widget.node=pick.node;widget.fade=1;
        widget.applyFade();
        expect(visible.group.children[0].material.opacity).toBe(1);
        expect(hidden.group.children[0].material.opacity).toBe(1);
        widget.fade=0;widget.applyFade();
        expect(material.opacity).toBe(1);expect(material.transparent).toBe(false);expect(material.depthWrite).toBe(true);
        // The exclusion is specific to this view/state. A shown object can be
        // selected when it really is visible, even if it shares a source track.
        view._renderHiddenNodeIDs.clear();parent.visible=true;
        hidden.group.children[0].visible=true;hidden.group.children[0].layers.set(0);
        expect(widget.findObjectUnderCursor().node).toBe(hidden);
    } finally {
        views.mockRestore();objects.mockRestore();widget.fade=0;
        for (const node of [visible,hidden]) node.group.traverse(child=>{child.geometry?.dispose();child.material?.dispose();});
    }
});

test("a ground projector uses the surface widget and follows its snapped position during drag", () => {
    const group = new Group();
    let location = [34, -118, 0.05];
    group.position.copy(LLAToECEF(location[0], location[1], 10.05));
    const position = {
        getLLA: () => location.slice(),
        getECEF: () => group.position.clone(),
        setLLA(lat, lon, clearance) {
            location = [lat, lon, clearance];
            group.position.copy(LLAToECEF(lat, lon, 35 + clearance));
        },
    };
    const node = {id: "projector", group, groundMoveOnly: true, getPositionEditTarget: () => position};
    const move = ObjectMoveWidget;
    move.node = node;
    move.target = move.movableTarget(node);
    move.proxy = new Object3D();
    move.widget = {object: move.proxy, group: new Group(), activeDragMode: "horizontal", updateOrientation() {}};
    move.syncToObject();
    expect(move.widget.freeMovementAllowed).toBe(false);
    expect(move.widget.groundMoveOnly).toBe(true);
    move.dragAnchor.copy(move.proxy.position);
    move.dragging = true;
    move.proxy.position.addScaledVector(getLocalEastVector(group.position), 120);
    move.onWidgetMoved();
    expect(location[1]).toBeGreaterThan(-118);
    expect(location[2]).toBe(0.05);
    expect(move.proxy.position).toEqual(group.position);
    move.endDrag();
    const action = undoManager.add.mock.calls.at(-1)[0];
    action.undo();
    expect(location).toEqual([34, -118, 0.05]);
    move.widget = null;
});
