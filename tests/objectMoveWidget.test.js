import {Group, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, SphereGeometry} from "three";
import {ObjectMoveWidget} from "../src/CObjectMoveWidget";
import {CNodeBalloonTrack} from "../src/nodes/CNodeBalloonTrack";
import {CNode3DObject} from "../src/nodes/CNode3DObject";
import {setNodeMan, setSit} from "../src/Globals";
import {LLAToECEF, ECEFToLLAVD_radii} from "../src/LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "../src/EGM96Geoid";
import {getLocalEastVector, getLocalUpVector} from "../src/SphericalMath";
import {undoManager} from "../src/UndoManager";

jest.mock("../src/nodes/CNodeTrack", () => ({CNodeTrack: class CNodeTrack {}}));
jest.mock("../src/nodes/CNode3DObject", () => {
    class CNode3D {}
    return {CNode3DObject: class CNode3DObject extends CNode3D {}};
});
jest.mock("../src/LocalFrame", () => ({GlobalScene: new (require("three").Group)()}));
jest.mock("../src/threeExt", () => ({getPointBelow: p => p.clone()}));
jest.mock("../src/CViewManager", () => ({ViewMan: {iterate: jest.fn()}}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: (lat, lon) => 20 + lat * .1 + lon * .03}));
jest.mock("../src/UndoManager", () => ({undoManager: {add: jest.fn()}}));

class CNodeController {}
class CNodeControllerTrackPosition extends CNodeController {
    constructor(track) { super(); this.inputs = {sourceTrack: track}; }
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
    setNodeMan({get: id => id === "targetWind" ? {from: 270, knots: 10} : null});
    jest.clearAllMocks();
});
afterEach(() => {
    ObjectMoveWidget.dragging = false; ObjectMoveWidget.dragPrepared = false;
    ObjectMoveWidget.target = ObjectMoveWidget.node = null;
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


test.each(["render-hidden", "ancestor-hidden", "mesh-hidden", "different-layer"])("Alt hover ignores a closer %s object overlapping the balloon", hiddenKind => {
    const root = balloon(), visible = objectFor(root), hidden = objectFor(root);
    visible.id = "balloonObject"; hidden.id = "traverseObject";
    const material = new MeshBasicMaterial({opacity:1, transparent:false});
    visible.group.add(new Mesh(new SphereGeometry(1), material));
    hidden.group.add(new Mesh(new SphereGeometry(1), material.clone()));
    hidden.group.position.x = .0001;
    const camera = new PerspectiveCamera(50,1,.1,1000);
    camera.position.z = 100;camera.updateMatrixWorld(true);
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
        widget.node=pick.node;widget.fade=1;widget.savedMaterials=null;widget.savedIgnorePick=undefined;
        widget.applyFade();
        expect(visible.group.children[0].material.opacity).toBe(.25);
        expect(hidden.group.children[0].material.opacity).toBe(1);
        widget.fade=0;widget.applyFade();
        expect(material.opacity).toBe(1);expect(material.transparent).toBe(false);expect(material.depthWrite).toBe(true);
        // The exclusion is specific to this view/state. A shown object can be
        // selected when it really is visible, even if it shares a source track.
        view._renderHiddenNodeIDs.clear();parent.visible=true;
        hidden.group.children[0].visible=true;hidden.group.children[0].layers.set(0);
        expect(widget.findObjectUnderCursor().node).toBe(hidden);
    } finally {
        views.mockRestore();objects.mockRestore();widget.savedMaterials=null;widget.fade=0;
        for (const node of [visible,hidden]) node.group.traverse(child=>{child.geometry?.dispose();child.material?.dispose();});
    }
});
