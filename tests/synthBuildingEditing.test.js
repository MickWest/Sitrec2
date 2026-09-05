/** @jest-environment jsdom */

import {beforeEach, expect, jest, test} from "@jest/globals";
import {BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, SphereGeometry, Vector2, Vector3} from "three";
import {CNodeSynthBuilding} from "../src/nodes/CNodeSynthBuilding";
import {CNodeSynthClouds} from "../src/nodes/CNodeSynthClouds";
import {CNodeFloodSim} from "../src/nodes/CNodeFloodSim";
import {eventMethods as groundOverlayEvents} from "../src/nodes/CNodeGroundOverlayEvents";
import {ViewMan} from "../src/CViewManager";
import {MASK_HELPERS, MASK_LOOKRENDER, MASK_MAINRENDER} from "../src/LayerMasks";
import {withDisplayedCamera, worldUnitsPerPixel} from "../src/ViewUtils";

jest.mock("../src/nodes/CNode3DGroup", () => ({CNode3DGroup: class {}}));
jest.mock("../src/showError", () => ({}));
jest.mock("../src/SphericalMath", () => ({getLocalUpVector: () => new (require("three").Vector3)(0, 1, 0)}));
jest.mock("../src/LLA-ECEF-ENU", () => ({}));
jest.mock("../src/Globals", () => ({Globals: {settings: {}}, CustomManager: {saveGlobalSettings: jest.fn()}, setRenderOne: jest.fn()}));
jest.mock("../src/threeExt", () => ({getVisiblePointBelow: p => p.clone().setY(0)}));
jest.mock("../src/CEventManager", () => ({}));
jest.mock("../src/PageStructure", () => ({}));
jest.mock("../src/i18n", () => ({}));
jest.mock("../src/CViewManager", () => ({ViewMan: {get: jest.fn(), iterateVisibleIncludingOverlays: jest.fn()}}));
jest.mock("../src/mouseMoveView", () => ({
    screenToNDC: (view, x, y) => new (require("three").Vector2)(
        (x - view.leftPx) / view.widthPx * 2 - 1,
        1 - (y - view.topPx) / view.heightPx * 2,
    ),
}));

function makeView(id, leftPx, visible = true) {
    const camera = new PerspectiveCamera(40, 4 / 3, 0.1, 10000);
    camera.position.set(0, 60, 120);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    return {
        id, leftPx, topPx: 24, widthPx: 800, heightPx: 600, visible,
        camera, controls: {enabled: true}, displayedZoom: 1,
        pixelsToMeters(position, pixels) { return worldUnitsPerPixel(this, position) * pixels; },
        prepareCameraForLOD() {
            this._lodSavedZoom = camera.zoom;
            camera.zoom = this.displayedZoom;
            camera.updateProjectionMatrix();
        },
        restoreCameraAfterLOD() {
            camera.zoom = this._lodSavedZoom;
            this._lodSavedZoom = undefined;
            camera.updateProjectionMatrix();
        },
    };
}

function makeBuilding() {
    const building = Object.assign(Object.create(CNodeSynthBuilding.prototype), {
        editMode: true, group: new Group(), controlPoints: [], rotationHandles: [],
        raycaster: new Raycaster(), isDragging: false, isRotating: false,
        captureState: () => ({}),
        buildMesh: jest.fn(), syncParametersFromVertices: jest.fn(),
        updateGUIControllers: jest.fn(), snapGroundVerticesToTerrain: jest.fn(),
        vertices: [
            [-15, 0, -15], [15, 0, -15], [15, 0, 15], [-15, 0, 15],
            [-15, 10, -15], [15, 10, -15], [15, 10, 15], [-15, 10, 15],
            [0, 15, -15], [0, 15, 15],
        ].map((p, i) => ({
            position: new Vector3(...p), type: i < 4 ? "bottom" : i < 8 ? "top" : "roofline",
            prev: (i + 3) % 4, next: (i + 1) % 4,
            linkedVertex: i < 4 ? i + 4 : i - 4,
        })),
    });
    building.raycaster.layers.mask = MASK_HELPERS;
    building.createControlPoints();
    return building;
}

function pointerAt(view, position) {
    const p = withDisplayedCamera(view, camera => position.clone().project(camera));
    return {
        clientX: view.leftPx + (p.x + 1) * view.widthPx / 2,
        clientY: view.topPx + (1 - p.y) * view.heightPx / 2,
        button: 0, target: document.body,
        stopPropagation: jest.fn(), preventDefault: jest.fn(),
    };
}

let main, look, building;
beforeEach(() => {
    main = makeView("mainView", 0, false);
    look = makeView("lookView", 900);
    ViewMan.get.mockImplementation(id => ({mainView: main, lookView: look})[id]);
    ViewMan.iterateVisibleIncludingOverlays.mockImplementation(callback => {
        for (const view of [main, look]) if (view.visible) callback(view.id, view);
    });
    building = makeBuilding();
});

test("editing handles are visible to both cameras", () => {
    expect(building.controlPoints).toHaveLength(6);
    for (const handle of [...building.controlPoints, ...building.rotationHandles]) {
        expect(handle.layers.mask & MASK_MAINRENDER).not.toBe(0);
        expect(handle.layers.mask & MASK_LOOKRENDER).not.toBe(0);
    }
});

test.each(["cloud", "overlay", "flood"])("%s picks the displayed handle after zoom and rejects a hidden main view", family => {
    main.visible = true;
    main.displayedZoom = 3;
    const radius = family === "flood" ? 1 : 3;
    const handle = new Mesh(new SphereGeometry(radius), new MeshBasicMaterial());
    handle.position.set(18, 5, 0);
    const group = new Group();
    group.add(handle);
    const shared = {group, raycaster: new Raycaster(), editMode: true};
    let host;
    if (family === "cloud") {
        host = Object.assign(Object.create(CNodeSynthClouds.prototype), shared, {moveHandle: handle});
    } else if (family === "overlay") {
        host = Object.assign({}, groundOverlayEvents, shared, {cornerHandles: [handle], lockPointHandles: []});
    } else {
        host = Object.assign(Object.create(CNodeFloodSim.prototype), shared, {cornerHandles: [handle], method: "HeightMap"});
    }
    const at = pointerAt(main, handle.position);
    const hit = host.getHandleAtMouse(at.clientX, at.clientY);
    if (family === "cloud") expect(hit).toBe("move");
    else if (family === "overlay") expect(hit).toMatchObject({type: "corner", index: 0});
    else expect(hit).toBe(0);
    expect(handle.scale.x * radius / worldUnitsPerPixel(main, handle.position)).toBeCloseTo(20, 8);
    expect(main.camera.zoom).toBe(1);
    main._effectivelyVisible = false;
    expect(host.getHandleAtMouse(at.clientX, at.clientY)).toBe(family === "flood" ? -1 : null);
});

test.each([1, 3])("look-only layout picks the displayed roof handle at zoom %s", zoom => {
    look.displayedZoom = zoom;
    const event = pointerAt(look, building.roofCenterHandle.position);
    building.onPointerDown(event);
    expect(building.isDragging).toBe(true);
    expect(building.draggingPoint).toBe(building.roofCenterHandle);
    expect(building.activeView).toBe(look);
    expect(look.controls.enabled).toBe(false);
    expect(main.controls.enabled).toBe(true);
    expect(look.camera.zoom).toBe(1);
    building.onPointerUp(event);
    expect(building.isDragging).toBe(false);
    expect(look.controls.enabled).toBe(true);
});

test("picking rescales handles for the hovered view after another view rendered", () => {
    main.visible = true;
    main.camera.position.multiplyScalar(10);
    main.camera.updateMatrixWorld(true);
    building.updateHandleScales(main);
    const mainScale = building.roofCenterHandle.scale.x;
    building.setupRaycasterForEvent(pointerAt(look, building.roofCenterHandle.position));
    expect(building.roofCenterHandle.scale.x).toBeLessThan(mainScale / 5);
    expect(building.raycaster.intersectObject(building.roofCenterHandle)).not.toHaveLength(0);
});

test("a maximized look view ignores the main view's stale visible flag and bounds", () => {
    main.visible = true;
    main.leftPx = look.leftPx;
    main.div = {getBoundingClientRect: () => ({width: 0, height: 0})};
    building.onPointerDown(pointerAt(look, building.roofCenterHandle.position));
    expect(building.isDragging).toBe(true);
    expect(building.activeView).toBe(look);
});

test("drag ray stays in the starting view when the pointer crosses another pane", () => {
    main.visible = true;
    building.onPointerDown(pointerAt(look, building.roofCenterHandle.position));
    const event = {clientX: 400, clientY: 300};
    expect(building.setupRaycasterForEvent(event)).toBe(look);
    const expected = new Raycaster();
    expected.setFromCamera(new Vector2((400 - look.leftPx) / 800 * 2 - 1, 1 - (300 - 24) / 600 * 2), look.camera);
    expect(building.raycaster.ray.direction.distanceTo(expected.ray.direction)).toBeLessThan(1e-12);
});

test("handle size stays constant through displayed zoom and pane resizing", () => {
    const radiusInPixels = () => withDisplayedCamera(look, camera => {
        const handle = building.roofCenterHandle;
        const depth = -handle.position.clone().applyMatrix4(camera.matrixWorldInverse).z;
        return handle.geometry.parameters.radius * handle.scale.x * camera.projectionMatrix.elements[5] * look.heightPx / (2 * depth);
    });
    for (const [zoom, height] of [[1, 600], [3, 600], [2, 300]]) {
        look.displayedZoom = zoom;
        look.heightPx = height;
        building.updateHandleScales(look);
        expect(radiusInPixels()).toBeCloseTo(20, 8);
    }
});

test("rotation region uses the handle size of the active view", () => {
    building.setupRaycasterForEvent(pointerAt(look, building.controlPoints[0].position));
    const corner = building.vertices[0].position;
    const outward = corner.clone().sub(building.buildingCentroid).normalize();
    const radius = building.controlPoints[0].scale.x * 3;
    expect(building.isOutsideHandleInPlane(0, corner.clone().addScaledVector(outward, radius * 0.9))).toBe(false);
    expect(building.isOutsideHandleInPlane(0, corner.clone().addScaledVector(outward, radius * 1.1))).toBe(true);
});

test("a click outside either view does not start editing", () => {
    building.onPointerDown({clientX: 850, clientY: 0, button: 0, target: document.body});
    expect(building.isDragging).toBe(false);
    expect(look.controls.enabled).toBe(true);
});

test.each(["mainView", "lookView"])("roof and footprint resize in %s", id => {
    const view = id === "mainView" ? main : look;
    view.visible = true;
    const roof = pointerAt(view, building.roofCenterHandle.position);
    building.onPointerDown(roof);
    building.onPointerMove({...roof, clientY: roof.clientY - 20});
    expect(building.vertices[4].position.y).toBeGreaterThan(10);
    expect(building.vertices[0].position.y).toBe(0);
    building.onPointerUp(roof);

    const corner = pointerAt(view, building.controlPoints[2].position);
    const original = building.vertices[2].position.clone();
    const opposite = building.vertices[0].position.clone();
    building.onPointerDown(corner);
    expect(building.draggingVertexIndex).toBe(2);
    building.onPointerMove({...corner, clientX: corner.clientX + 20});
    expect(building.vertices[2].position.distanceTo(original)).toBeGreaterThan(1);
    expect(building.vertices[0].position.distanceTo(opposite)).toBeLessThan(1e-10);
    building.onPointerUp(corner);
    expect(view.controls.enabled).toBe(true);
});

test.each(["mainView", "lookView"])("whole-building translation and rotation in %s", id => {
    const view = id === "mainView" ? main : look;
    view.visible = true;
    building.solidMesh = new Mesh(new BoxGeometry(30, 10, 30), new MeshBasicMaterial());
    building.solidMesh.layers.mask = MASK_LOOKRENDER | MASK_MAINRENDER;
    building.solidMesh.position.y = 5;
    building.group.add(building.solidMesh);
    const body = pointerAt(view, new Vector3(0, 5, 15));
    const before = building.vertices.map(v => v.position.clone());
    building.onPointerDown(body);
    expect(building.draggingPoint.userData.isBuildingMesh).toBe(true);
    building.onPointerMove({...body, clientX: body.clientX + 20});
    const displacement = building.vertices[0].position.clone().sub(before[0]);
    expect(displacement.length()).toBeGreaterThan(1);
    building.vertices.forEach((v, i) => expect(v.position.clone().sub(before[i]).distanceTo(displacement)).toBeLessThan(1e-10));
    building.onPointerUp(body);

    building.updateHandleScales(view);
    const corner = building.vertices[2].position;
    const outward = corner.clone().sub(building.buildingCentroid).normalize();
    const radius = building.controlPoints[2].scale.x * 3;
    const rotation = pointerAt(view, corner.clone().addScaledVector(outward, radius * 2));
    building.onPointerDown(rotation);
    expect(building.isRotating).toBe(true);
    const width = building.vertices[0].position.distanceTo(building.vertices[1].position);
    const cornerBeforeRotation = building.vertices[0].position.clone();
    building.onPointerMove({...rotation, clientX: rotation.clientX + 20});
    expect(building.vertices[0].position.distanceTo(cornerBeforeRotation)).toBeGreaterThan(0.1);
    expect(building.vertices[0].position.distanceTo(building.vertices[1].position)).toBeCloseTo(width, 8);
    building.onPointerUp(rotation);
    expect(view.controls.enabled).toBe(true);
});
