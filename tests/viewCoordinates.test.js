/** @jest-environment jsdom */
import {Object3D, OrthographicCamera, PerspectiveCamera, Plane, Raycaster, Vector3} from "three";
import {PointEditorWidget} from "../src/PointEditorWidget";
import {ViewMan} from "../src/CViewManager";
import {
    getInteractiveViewAt, mouseInRenderedView, mouseInViewOnly, mouseToNDC, mouseToView,
    ndcToView, offsetWorldPointPixels, projectWorldToView, renderedRect,
    setRaycasterFromView, viewToClient, viewToNDC, withDisplayedCamera, worldUnitsPerPixel,
} from "../src/ViewUtils";

jest.mock("../src/CViewManager", () => ({ViewMan: {
    screenOffsetX: 220, get: jest.fn(), iterateVisibleIncludingOverlays: jest.fn(),
}}));
jest.mock("../src/SphericalMath", () => ({getLocalUpVector: () => new (require("three").Vector3)(0, 1, 0)}));
jest.mock("../src/threeExt", () => ({adjustHeightAboveGround: p => p}));

function makeView(orthographic = false, letterbox = true) {
    const camera = orthographic ? new OrthographicCamera(-120, 120, 90, -90, 0.1, 2000)
        : new PerspectiveCamera(50, 4 / 3, 0.1, 2000);
    camera.position.set(10, 30, 100);
    camera.lookAt(5, 0, 0);
    camera.updateMatrixWorld(true);
    return {
        id: "lookView", camera, visible: true, leftPx: 80, topPx: 40, widthPx: 800, heightPx: 600,
        div: {getBoundingClientRect: () => ({left: 300, top: 40, width: 800, height: 600})},
        canvas: {getBoundingClientRect: () => ({left: 300, top: letterbox ? 115 : 40, width: 800, height: letterbox ? 450 : 600})},
        pixelsToMeters(position, pixels) { return pixels * worldUnitsPerPixel(this, position); },
        prepareCameraForLOD() {
            this._lodSavedZoom = camera.zoom;
            this.savedQuaternion = camera.quaternion.clone();
            camera.rotateY(0.08);
            camera.zoom = 2.4;
            camera.updateProjectionMatrix();
            // Off-center projection and compression used by video pan/coverage.
            camera.projectionMatrix.elements[5] *= 1.13;
            camera.projectionMatrix.elements[orthographic ? 12 : 8] += 0.17;
            camera.projectionMatrix.elements[orthographic ? 13 : 9] -= 0.11;
            camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        },
        restoreCameraAfterLOD() {
            camera.zoom = this._lodSavedZoom;
            this._lodSavedZoom = undefined;
            camera.quaternion.copy(this.savedQuaternion);
            camera.updateProjectionMatrix();
            camera.updateMatrixWorld(true);
        },
    };
}

beforeEach(() => ViewMan.iterateVisibleIncludingOverlays.mockImplementation(() => {}));

test.each([false, true])("rendered NDC and client/pane conversions round trip (letterbox %s)", letterbox => {
    const view = makeView(false, letterbox);
    for (const [x, y] of [[320, 130], [710, 295], [1050, 540]]) {
        const ndc = mouseToNDC(view, x, y);
        const pane = ndcToView(view, ndc);
        const expected = mouseToView(view, x, y);
        expect(pane[0]).toBeCloseTo(expected[0], 10);
        expect(pane[1]).toBeCloseTo(expected[1], 10);
        const client = viewToClient(view, ...pane);
        expect(client[0]).toBeCloseTo(x, 10);
        expect(client[1]).toBeCloseTo(y, 10);
    }
});

test.each([false, true])("displayed projection picks the projected point (orthographic %s)", orthographic => {
    const view = makeView(orthographic);
    const before = view.camera.quaternion.clone();
    const projectionBefore = view.camera.projectionMatrix.clone();
    const plane = new Plane(new Vector3(0, 0, 1), 0);
    for (const p of [new Vector3(0, 0, 0), new Vector3(-15, 12, 0), new Vector3(28, -10, 0)]) {
        const pane = projectWorldToView(view, p);
        const raycaster = new Raycaster();
        expect(setRaycasterFromView(raycaster, view, ...viewToClient(view, ...pane))).toBe(true);
        const hit = raycaster.ray.intersectPlane(plane, new Vector3());
        expect(hit.distanceTo(p)).toBeLessThan(1e-10);
    }
    expect(view.camera.quaternion.equals(before)).toBe(true);
    expect(view.camera.projectionMatrix.equals(projectionBefore)).toBe(true);
    expect(view.camera.zoom).toBe(1);
});

test.each([false, true])("handle scale uses displayed vertical pixels and depth (orthographic %s)", orthographic => {
    const view = makeView(orthographic);
    const position = new Vector3(20, 5, 0);
    const scale = worldUnitsPerPixel(view, position);
    withDisplayedCamera(view, camera => {
        const up = new Vector3(0, 1, 0).transformDirection(camera.matrixWorld);
        const a = projectWorldToView(view, position);
        const b = projectWorldToView(view, position.clone().addScaledVector(up, scale * 20));
        expect(a[1] - b[1]).toBeCloseTo(20, 9);
        const sideways = new Vector3(1, 0, 0).transformDirection(camera.matrixWorld);
        expect(worldUnitsPerPixel(view, position.clone().addScaledVector(sideways, 200))).toBeCloseTo(scale, 10);
    });
});

test("orthographic handle size is independent of camera distance", () => {
    const view = makeView(true);
    expect(worldUnitsPerPixel(view, new Vector3(0, 0, 0)))
        .toBeCloseTo(worldUnitsPerPixel(view, new Vector3(0, 0, -1000)), 12);
});

test("pixel offsets use full CSS pixels and restore the camera", () => {
    const view = makeView();
    const p = new Vector3(20, 5, 0);
    const moved = offsetWorldPointPixels(view, p, 17, 31);
    const a = viewToClient(view, ...projectWorldToView(view, p));
    const b = viewToClient(view, ...projectWorldToView(view, moved));
    expect(b[0] - a[0]).toBeCloseTo(17, 9);
    expect(a[1] - b[1]).toBeCloseTo(31, 9);
    expect(view.camera.zoom).toBe(1);
});

test("nested displayed-camera work restores exactly once even when a pick throws", () => {
    const view = makeView();
    const restore = jest.spyOn(view, "restoreCameraAfterLOD");
    const before = view.camera.quaternion.clone();
    expect(() => withDisplayedCamera(view, () => withDisplayedCamera(view, () => { throw Error("pick"); }))).toThrow("pick");
    expect(restore).toHaveBeenCalledTimes(1);
    expect(view.camera.quaternion.equals(before)).toBe(true);
    expect(view._lodSavedZoom).toBeUndefined();
});

test("letterbox bars belong to the pane but cannot start a 3D pick", () => {
    const view = makeView();
    expect(mouseInViewOnly(view, 400, 60)).toBe(true);
    expect(mouseInRenderedView(view, 400, 60)).toBe(false);
    expect(mouseInRenderedView(view, 400, 200)).toBe(true);
});

test("hidden and zero-area panes cannot cover the maximized view", () => {
    const look = makeView();
    const main = {...makeView(), id: "mainView", zIndex: 10, _effectivelyVisible: false};
    ViewMan.get.mockImplementation(id => ({mainView: main, lookView: look})[id]);
    ViewMan.iterateVisibleIncludingOverlays.mockImplementation(fn => [main, look].forEach(v => fn(v.id, v)));
    expect(getInteractiveViewAt(400, 200)).toBe(look);
    main._effectivelyVisible = true;
    main.div = {getBoundingClientRect: () => ({left: 0, top: 0, width: 0, height: 0})};
    expect(getInteractiveViewAt(400, 200)).toBe(look);
    expect(renderedRect(main, 800, 600).w).toBe(0);
    expect(setRaycasterFromView(new Raycaster(), main, 400, 200)).toBe(false);
});

test("an interactive pane in front blocks a pick", () => {
    const view = makeView();
    const front = {...makeView(), id: "front", zIndex: 5, onMouseDown() {}};
    ViewMan.iterateVisibleIncludingOverlays.mockImplementation(fn => fn(front.id, front));
    expect(mouseInRenderedView(view, 400, 200)).toBe(false);
});

test("pillarboxing also uses the rendered image", () => {
    const view = makeView();
    view.canvas.getBoundingClientRect = () => ({left: 450, top: 40, width: 500, height: 600});
    expect(viewToNDC(view, 150, 300).x).toBe(-1);
    expect(mouseInRenderedView(view, 350, 300)).toBe(false);
});

test("a point widget picks in a letterboxed look view and keeps that camera across panes", () => {
    const view = makeView();
    const main = {...makeView(), id: "mainView", _effectivelyVisible: false};
    ViewMan.get.mockImplementation(id => ({mainView: main, lookView: view})[id]);
    const widget = new PointEditorWidget(view.camera);
    const object = new Object3D();
    object.position.set(10, 0, 0);
    widget.attach(object);
    widget.setAltitudeLocked(true, -1);
    const [x, y] = viewToClient(view, ...projectWorldToView(view, object.position));
    const pointer = {button: 0, clientX: x, clientY: y, preventDefault() {}};
    try {
        widget.onPointerDown(pointer);
        expect(widget.isDragging).toBe(true);
        expect(widget.activeView).toBe(view);
        const ray = new Raycaster();
        setRaycasterFromView(ray, view, 150, 300);
        widget.setupRaycasterForEvent({...pointer, clientX: 150, clientY: 300});
        expect(widget.raycaster.ray.direction.distanceTo(ray.ray.direction)).toBeLessThan(1e-12);
        expect(widget.activeView).toBe(view);
        expect(view.camera.zoom).toBe(1);
    } finally {
        widget.onPointerUp(pointer);
        widget.dispose();
    }
});


test("an altitude drag ignores a ray parallel to its movement axis", () => {
    const widget = Object.create(PointEditorWidget.prototype);
    widget.dragStartWorld = new Vector3(6370000, 0, 0);
    widget.dragStartLocalUp = new Vector3(1, 0, 0);
    widget.raycaster = {ray: {origin: new Vector3(6371000, 0, 0), direction: new Vector3(-1, 0, 0)}};
    widget.object = {position: widget.dragStartWorld.clone()};
    widget.handleVerticalDrag();
    expect(widget.object.position.toArray()).toEqual([6370000, 0, 0]);
});
