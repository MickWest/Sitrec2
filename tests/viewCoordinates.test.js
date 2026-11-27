/** @jest-environment jsdom */
import {BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, OrthographicCamera, PerspectiveCamera, Plane, Raycaster, SphereGeometry, Vector3} from "three";
import {intersectContextObjects} from "../src/ContextObjectPicking";
import {PointEditorWidget} from "../src/PointEditorWidget";
import {ViewMan} from "../src/CViewManager";
import {setObjectMoveMode} from "../src/ObjectMoveModes";
import {adjustHeightHAE} from "../src/threeExt";
import {ECEFToLLAVD_radii} from "../src/LLA-ECEF-ENU";
import * as LAYER from "../src/LayerMasks";
import {
    getInteractiveViewAt, mouseInRenderedView, mouseInViewOnly, mouseToNDC, mouseToView,
    ndcToView, offsetWorldPointPixels, projectWorldToView, renderedRect,
    setRaycasterFromView, viewToClient, viewToNDC, withDisplayedCamera, worldUnitsPerPixel,
} from "../src/ViewUtils";

jest.mock("../src/CViewManager", () => ({ViewMan: {
    screenOffsetX: 220, get: jest.fn(), iterateVisibleIncludingOverlays: jest.fn(),
}}));
jest.mock("../src/SphericalMath", () => ({getLocalUpVector: () => new (require("three").Vector3)(0, 1, 0)}));
jest.mock("../src/threeExt", () => ({adjustHeightAboveGround: p => p, adjustHeightHAE: jest.fn(p => p)}));

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

beforeEach(() => {
    setObjectMoveMode('surface');
    adjustHeightHAE.mockReset().mockImplementation(p => p);
    ViewMan.iterateVisibleIncludingOverlays.mockImplementation(() => {});
});

test("tower picking uses its displayed rotation, gives exact hits priority and leaves open ground clickable", () => {
    const camera = new OrthographicCamera(-50,50,50,-50,.1,100);
    camera.position.z = 20;
    camera.updateMatrixWorld(true);
    const group = new Group(), scene = new Group();
    const arm = new Mesh(new BoxGeometry(8,.3,.3),new MeshBasicMaterial());
    arm.position.x = 10;
    group.add(arm);
    scene.add(group);
    const node = {group,model:arm,common:{rotateZ:90},applyViewScale() {},rotateForDisplay() {group.rotateZ(Math.PI/2);},
        proceduralModel:{recipe:{parameters:{groundKind:"pylon"}}}};
    const manager = {list:{tower:{data:node}},iterate(callback) {callback("tower",node);}};
    const view = {camera,scene,raycaster:new Raycaster(),widthPx:100,heightPx:100,
        div:{getBoundingClientRect:() => ({left:0,top:0,width:100,height:100})},findObjectID:obj => obj.id};
    const pick = (x,y) => intersectContextObjects(view,x,y,manager,() => true)[0]?.object;
    try {
        expect(pick(50,38)).toBe(arm);
        expect(pick(52,38)).toBe(arm);
        expect(pick(56,38)).toBeUndefined();
        expect(pick(60,50)).toBeUndefined();
        const other = new Mesh(arm.geometry,arm.material);
        other.rotation.z = Math.PI/2;
        other.position.set(2,12,-1);
        scene.add(other);
        scene.updateMatrixWorld(true);
        expect(pick(52,38)).toBe(other);
        expect(group.rotation.z).toBeCloseTo(0);
    } finally {arm.geometry.dispose(); arm.material.dispose();}
});

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
    // PointEditorWidget refuses a pick that the globe hides (GlobeOcclusion.js), so put
    // the scene 1 km above the surface on +Y, where the mocked local up is correct.
    // At makeView's toy origin, the camera and the object would be inside the Earth.
    const surface = new Vector3(0, 6378137 + 1000, 0);
    view.camera.position.add(surface);
    view.camera.updateMatrixWorld(true);
    const widget = new PointEditorWidget(view.camera);
    const object = new Object3D();
    object.position.set(10, 0, 0).add(surface);
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

function planeWidgetViews() {
    setObjectMoveMode('lookCameraPlane');
    const position = new Vector3(0, 6379137, 0);
    const camera = new PerspectiveCamera(50, 1, 0.1, 2000);
    camera.position.copy(position).add(new Vector3(60, 200, 250));
    camera.lookAt(position);
    camera.updateMatrixWorld(true);
    const rect = {left: 0, top: 0, width: 400, height: 400};
    const main = {id: 'mainView', camera, visible: true,
        leftPx: 0, topPx: 0, widthPx: 400, heightPx: 400,
        div: {getBoundingClientRect: () => rect}, canvas: {getBoundingClientRect: () => rect},
        pixelsToMeters: (p, px) => px * worldUnitsPerPixel(main, p)};
    const look = {id: 'lookView', camera: new PerspectiveCamera(), pixelsToMeters: main.pixelsToMeters};
    look.camera.position.copy(position).add(new Vector3(200, 100, 60));
    look.camera.lookAt(position);
    look.camera.rotateZ(.25);
    look.camera.updateMatrixWorld(true);
    ViewMan.get.mockImplementation(id => ({mainView: main, lookView: look})[id]);
    ViewMan.iterateVisibleIncludingOverlays.mockImplementation(() => {});
    const widget = new PointEditorWidget(camera);
    const object = new Object3D();
    object.position.copy(position);
    widget.attach(object);
    widget.updateHandleScales(main);
    const pointerAt = point => {
        const [clientX, clientY] = viewToClient(main, ...projectWorldToView(main, point));
        return {button: 0, clientX, clientY, preventDefault() {}};
    };
    return {main, look, widget, position, pointerAt};
}

test.each([0, 2])('Control-click (button %i) toggles the rotation ring and tracks horizontal pixels', button => {
    const {main, widget, position, pointerAt} = planeWidgetViews();
    widget.canRotate = () => true;
    const rotate = jest.fn(), pointer = pointerAt(position), toggle = {...pointer, button, ctrlKey: true};
    widget.addEventListener('rotateY', rotate);
    try {
        widget.onPointerDown(toggle);
        expect(widget.activeDragMode).toBe('rotateY');
        expect(widget.handles.rotation.visible).toBe(true);
        expect(widget.handles.planeGrid.visible).toBe(false);
        widget.onPointerMove({...pointer, clientX: pointer.clientX + 27, clientY: pointer.clientY + 81});
        expect(rotate).toHaveBeenLastCalledWith(expect.objectContaining({pixels: 27}));
        expect(widget.object.position).toEqual(position);
        widget.onPointerUp(toggle);
        widget.onPointerDown(pointer);
        expect(widget.activeDragMode).toBe('rotateY');
        widget.onPointerUp(pointer);
        widget.onPointerDown(toggle);
        widget.onPointerUp(toggle);
        widget.updateHandleScales(main);
        expect(widget.handles.rotation.visible).toBe(false);
        expect(widget.handles.planeGrid.visible).toBe(true);
    } finally { widget.dispose(); setObjectMoveMode('surface'); }
});

test('Main view moves along the Look camera plane and freezes its geometry throughout the drag', () => {
    const {main, look, widget, position, pointerAt} = planeWidgetViews();
    try {
        const grid = widget.handles.planeGrid;
        expect(grid.visible).toBe(true);
        expect(widget.handles.disc.visible).toBe(false);
        expect(grid.material.color.getHex()).toBe(0x3399ff);
        const orientation = grid.quaternion.clone();
        const right = new Vector3(1, 0, 0).applyQuaternion(orientation);
        const along = new Vector3(0, 1, 0).applyQuaternion(orientation);
        const cameraRight = new Vector3(1, 0, 0).applyQuaternion(look.camera.quaternion);
        expect(right.distanceTo(cameraRight)).toBeLessThan(1e-12);
        // Grab an empty grid square, away from the red arrows and grid lines.
        const grip = position.clone().addScaledVector(right, grid.scale.x * .65)
            .addScaledVector(along, grid.scale.y * .35);
        const down = pointerAt(grip);
        widget.onPointerDown(down);
        expect(widget.activeDragMode).toBe('lookCameraPlane');
        expect(widget.activeView).toBe(main);
        const plane = widget.dragPlane.clone();
        expect(Math.abs(plane.distanceToPoint(position))).toBeLessThan(1e-8);
        expect(Math.abs(plane.distanceToPoint(look.camera.position))).toBeLessThan(1e-8);
        expect(Math.abs(plane.normal.dot(cameraRight))).toBeLessThan(1e-12);

        look.camera.position.add(new Vector3(150, 30, -120));
        look.camera.up.set(.2, .9, .3).normalize();
        look.camera.lookAt(position);
        setObjectMoveMode('surface');
        // Another view rendering must not change the Main view's drag basis.
        widget.updateHandleScales(look);
        expect(grid.visible).toBe(true);
        expect(widget.handles.disc.visible).toBe(false);
        widget.updateHandleScales(main);
        expect(grid.visible).toBe(true);
        expect(grid.quaternion.angleTo(orientation)).toBeLessThan(1e-7);

        const delta = right.clone().multiplyScalar(15).addScaledVector(along, 10);
        for (const fraction of [.5, 1]) {
            widget.onPointerMove(pointerAt(grip.clone().addScaledVector(delta, fraction)));
            expect(widget.object.position.distanceTo(position.clone().addScaledVector(delta, fraction))).toBeLessThan(1e-5);
            expect(Math.abs(plane.distanceToPoint(widget.object.position))).toBeLessThan(1e-8);
            expect(widget.dragPlane.equals(plane)).toBe(true);
            expect(grid.quaternion.angleTo(orientation)).toBeLessThan(1e-7);
        }
        widget.rollbackDrag(down);
        expect(widget.object.position.distanceTo(position)).toBeLessThan(1e-8);
        expect(widget.isDragging).toBe(false);
        widget.updateHandleScales(main);
        expect(grid.visible).toBe(false);
        setObjectMoveMode('lookCameraPlane');
        widget.updateHandleScales(main);
        expect(grid.quaternion.angleTo(orientation)).toBeGreaterThan(.1);
    } finally { widget.dispose(); }
});

test('the Look view has a visible grid grip, and the grid is released on disposal', () => {
    const {main, look, widget, position} = planeWidgetViews();
    const grid = widget.handles.planeGrid;
    const disposeGrid = jest.spyOn(grid.geometry, 'dispose');
    const disposePick = jest.spyOn(widget.planeGridPick.geometry, 'dispose');
    const disposeMaterial = jest.spyOn(grid.material, 'dispose');
    widget.updateHandleScales(look);
    expect(grid.visible).toBe(true);
    expect(widget.handles.disc.visible).toBe(false);
    // An object on the Look camera's right axis also has a finite plane.
    const cameraRight = new Vector3(1, 0, 0).applyQuaternion(look.camera.quaternion);
    look.camera.position.copy(position).addScaledVector(cameraRight, 100);
    widget.updateHandleScales(main);
    const normal = new Vector3(0, 0, 1).applyQuaternion(widget.lookCameraPlaneQuaternion());
    expect(normal.length()).toBeCloseTo(1);
    expect(normal.dot(cameraRight)).toBeCloseTo(0);
    widget.dispose();
    expect(disposeGrid).toHaveBeenCalledTimes(1);
    expect(disposePick).toHaveBeenCalledTimes(1);
    expect(disposeMaterial).toHaveBeenCalledTimes(1);
});

function pushWidgetViews() {
    const state = planeWidgetViews();
    setObjectMoveMode('push');
    const {look, main, widget} = state;
    const rect = {left: 400, top: 0, width: 400, height: 400};
    Object.assign(look, {visible: true,
        leftPx: 400, topPx: 0, widthPx: 400, heightPx: 400,
        div: {getBoundingClientRect: () => rect}, canvas: {getBoundingClientRect: () => rect},
        pixelsToMeters: (p, px) => px * worldUnitsPerPixel(look, p)});
    main.camera.layers.mask = LAYER.MASK_MAINRENDER;
    look.camera.layers.mask = LAYER.MASK_LOOKRENDER;
    widget.updateHandleScales(look);
    const [clientX, clientY] = viewToClient(look, ...projectWorldToView(look, widget.object.position));
    state.pointer = {button: 0, clientX, clientY, preventDefault() {}};
    return state;
}

test('Push moves only along the frozen Look camera ray and shows its guide only in Main view', () => {
    const {look, main, widget, pointer, position} = pushWidgetViews();
    try {
        expect(widget.handles.push.visible).toBe(true);
        expect(widget.handles.disc.visible).toBe(false);
        expect(widget.handles.arrowUp.visible).toBe(false);
        expect(widget.handles.arrowDown.visible).toBe(false);
        const projectionBefore = projectWorldToView(look, position);
        widget.onPointerDown(pointer);
        expect(widget.activeDragMode).toBe('push');
        expect(widget.activeView).toBe(look);
        const origin = widget.pushOrigin.clone(), direction = widget.pushDirection.clone();
        const range = widget.pushStartRange;
        const visualAxis = position.clone().set(0, 1, 0).applyQuaternion(widget.handles.push.quaternion);
        expect(Math.abs(visualAxis.dot(direction))).toBeLessThan(.99);

        // Horizontal mouse movement has no effect on the range or bearing.
        widget.onPointerMove({...pointer, clientX: pointer.clientX + 100});
        expect(widget.object.position.distanceTo(position)).toBeLessThan(1e-8);
        widget.onPointerMove({...pointer, clientX: pointer.clientX + 100, clientY: pointer.clientY - 200});
        expect(widget.object.position.distanceTo(origin)).toBeCloseTo(range * 2, 7);
        const projectionAfter = projectWorldToView(look, widget.object.position);
        expect(projectionAfter[0]).toBeCloseTo(projectionBefore[0], 6);
        expect(projectionAfter[1]).toBeCloseTo(projectionBefore[1], 6);

        widget.updateHandleScales(main);
        expect(widget.pushLine.visible).toBe(true);
        expect(widget.pushLine.layers.test(main.camera.layers)).toBe(true);
        expect(widget.pushLine.layers.test(look.camera.layers)).toBe(false);
        expect(widget.handles.push.visible).toBe(true);
        const lineStart = position.clone().fromBufferAttribute(widget.pushLine.sourceGeometry.getAttribute('position'), 0)
            .add(widget.group.position);
        expect(lineStart.distanceTo(origin)).toBeLessThan(1e-4);
        widget.updateHandleScales(look);
        expect(widget.pushLine.visible).toBe(false);

        look.camera.position.add(new Vector3(50, 10, 80));
        look.camera.lookAt(position);
        setObjectMoveMode('surface');
        widget.onPointerMove({...pointer, clientY: pointer.clientY + 200});
        expect(widget.object.position.distanceTo(origin.clone().addScaledVector(direction, range / 2))).toBeLessThan(1e-7);
        expect(widget.pushOrigin.equals(origin)).toBe(true);
        expect(widget.pushDirection.equals(direction)).toBe(true);
        expect(widget.handles.push.visible).toBe(true);
        widget.onPointerMove({...pointer, clientY: pointer.clientY + 5000});
        expect(widget.object.position.distanceTo(origin)).toBeCloseTo(widget.pushMinRange, 7);
        widget.rollbackDrag(pointer);
        expect(widget.object.position.distanceTo(position)).toBeLessThan(1e-8);
        expect(widget.pushLine.visible).toBe(false);
        expect(widget.isDragging).toBe(false);
    } finally { widget.dispose(); }
});

test('Push respects altitude locks and releases its guide and arrow resources after a drag', () => {
    const {look, main, widget, pointer} = pushWidgetViews();
    widget.setAltitudeLocked(true, 100);
    widget.updateHandleScales(look);
    expect(widget.handles.push.visible).toBe(false);
    expect(widget.handles.disc.visible).toBe(true);
    widget.setAltitudeLocked(false);
    widget.updateHandleScales(look);
    widget.onPointerDown(pointer);
    widget.updateHandleScales(main);
    expect(widget.pushLine.visible).toBe(true);
    widget.onPointerUp(pointer);
    expect(widget.pushLine.visible).toBe(false);
    const geometries = new Set(), materials = new Set();
    widget.handles.push.traverse(child => {
        if (child.isMesh) { geometries.add(child.geometry); materials.add(child.material); }
    });
    geometries.add(widget.pushLine.geometry);
    geometries.add(widget.pushLine.sourceGeometry);
    materials.add(widget.pushLine.material);
    const disposals = [...geometries, ...materials].map(resource => jest.spyOn(resource, 'dispose'));
    widget.dispose();
    for (const disposal of disposals) expect(disposal).toHaveBeenCalledTimes(1);
});

test('the edge-on Camera plane can be dragged in Look while retaining the exact plane', () => {
    const {look, widget, pointer, position} = pushWidgetViews();
    setObjectMoveMode('lookCameraPlane');
    widget.updateHandleScales(look);
    try {
        widget.onPointerDown(pointer);
        expect(widget.activeDragMode).toBe('lookCameraPlane');
        expect(widget.planeScreenDrag).toBe(true);
        const plane = widget.dragPlane.clone();
        const origin = look.camera.position.clone();
        const displayedGrid = widget.handles.planeGrid.quaternion.clone();
        const right = new Vector3(1, 0, 0).applyQuaternion(look.camera.quaternion);
        const pixelScale = look.pixelsToMeters(position, 1);
        // Freeze both movement axes even if the camera or toolbar changes.
        look.camera.position.add(new Vector3(30, 40, -10));
        look.camera.rotateZ(.4);
        setObjectMoveMode('push');
        widget.onPointerMove({...pointer, clientX: pointer.clientX + 20, clientY: pointer.clientY - 200});
        const expected = position.clone().sub(origin).multiplyScalar(2).add(origin).addScaledVector(right, 40 * pixelScale);
        expect(widget.object.position.distanceTo(expected)).toBeLessThan(1e-8);
        expect(Math.abs(plane.distanceToPoint(widget.object.position))).toBeLessThan(1e-8);
        expect(widget.dragPlane.equals(plane)).toBe(true);
        expect(widget.handles.planeGrid.quaternion.angleTo(displayedGrid)).toBeLessThan(1e-7);
        widget.rollbackDrag(pointer);
        expect(widget.object.position.distanceTo(position)).toBeLessThan(1e-8);
    } finally { widget.dispose(); }
});

test.each(['mainView', 'lookView'])('Screen plane freezes depth in its initiating %s', id => {
    const {main, look, widget, position} = pushWidgetViews();
    const view = id === 'mainView' ? main : look;
    setObjectMoveMode('screenPlane');
    widget.updateHandleScales(view);
    const [clientX, clientY] = viewToClient(view, ...projectWorldToView(view, position));
    const pointer = {button: 0, clientX, clientY, preventDefault() {}};
    try {
        widget.onPointerDown(pointer);
        expect(widget.activeDragMode).toBe('screenPlane');
        expect(widget.handles.planeGrid.material.color.getHex()).toBe(0xbb88ff);
        const plane = widget.dragPlane.clone();
        const forward = view.camera.getWorldDirection(new Vector3());
        expect(Math.abs(plane.normal.dot(forward))).toBeCloseTo(1);
        widget.onPointerMove({...pointer, clientX: clientX + 25, clientY: clientY - 15});
        const moved = viewToClient(view, ...projectWorldToView(view, widget.object.position));
        expect(moved[0]).toBeCloseTo(clientX + 25, 6);
        expect(moved[1]).toBeCloseTo(clientY - 15, 6);
        expect(Math.abs(plane.distanceToPoint(widget.object.position))).toBeLessThan(1e-8);
        view.camera.rotateY(.2);
        widget.onPointerMove({...pointer, clientX: clientX + 30});
        expect(Math.abs(plane.distanceToPoint(widget.object.position))).toBeLessThan(1e-8);
        expect(widget.dragPlane.equals(plane)).toBe(true);
        widget.rollbackDrag(pointer);
    } finally { widget.dispose(); }
});

test('In/out in Main uses the Look camera ray, with the same vertical drag mapping', () => {
    const {main, look, widget, position, pointerAt} = pushWidgetViews();
    widget.updateHandleScales(main);
    const pointer = pointerAt(position);
    try {
        widget.onPointerDown(pointer);
        expect(widget.activeDragMode).toBe('push');
        expect(widget.pushOrigin.equals(look.camera.position)).toBe(true);
        widget.onPointerMove({...pointer, clientY: pointer.clientY - 200});
        const expected = position.clone().sub(look.camera.position).multiplyScalar(2).add(look.camera.position);
        expect(widget.object.position.distanceTo(expected)).toBeLessThan(1e-8);
        expect(widget.pushLine.visible).toBe(true);
        widget.rollbackDrag(pointer);
    } finally { widget.dispose(); }
});

test('Surface follows Earth curvature instead of gaining altitude along a tangent plane', () => {
    const {widget, position, pointerAt} = planeWidgetViews();
    setObjectMoveMode('surface');
    try {
        const pointer = pointerAt(position);
        widget.onPointerDown(pointer);
        expect(widget.activeDragMode).toBe('horizontal');
        const tangentDestination = position.clone().add(new Vector3(-50000, 0, 0));
        expect(ECEFToLLAVD_radii(tangentDestination).z).toBeGreaterThan(widget.dragStartAltitude + 100);
        adjustHeightHAE.mockImplementationOnce(jest.requireActual('../src/SphericalMath').setAltitudeHAE);
        widget.onPointerMove(pointerAt(tangentDestination));
        expect(ECEFToLLAVD_radii(widget.object.position).z).toBeCloseTo(widget.dragStartAltitude, 6);
        expect(widget.object.position.distanceTo(position)).toBeGreaterThan(40000);
        widget.rollbackDrag(pointer);
    } finally { widget.dispose(); }
});

test.each(['surface', 'lookCameraPlane', 'push', 'screenPlane'])('clicking the object outside the %s widget starts a move without jumping', mode => {
    const {look, widget, position, pointer} = pushWidgetViews();
    setObjectMoveMode(mode);
    const body = new Mesh(new SphereGeometry(look.pixelsToMeters(position, 110), 24, 16), new MeshBasicMaterial());
    body.position.copy(position);
    body.layers.mask = LAYER.MASK_LOOK;
    body.updateMatrixWorld(true);
    widget.pickObjectSurface = raycaster => raycaster.intersectObject(body)[0];
    const event = {...pointer, clientX: pointer.clientX + 80};
    try {
        widget.setupRaycasterForEvent(event);
        // The selected grip must come from the body, not padded widget geometry.
        const pickBody = widget.pickObjectSurface;
        widget.pickObjectSurface = undefined;
        expect(widget.pickHandle()).toBeNull();
        widget.pickObjectSurface = pickBody;
        widget.onPointerDown(event);
        expect(widget.activeDragMode).toBe(mode === 'surface' ? 'horizontal' : mode);
        expect(widget.object.position.distanceTo(position)).toBeLessThan(1e-8);
        widget.onPointerMove(event);
        expect(widget.object.position.distanceTo(position)).toBeLessThan(1e-8);
        widget.onPointerMove({...event, clientY: event.clientY - 15});
        expect(widget.object.position.distanceTo(position)).toBeGreaterThan(1);
        widget.rollbackDrag(event);
        expect(widget.object.position.distanceTo(position)).toBeLessThan(1e-8);
    } finally { widget.dispose(); body.geometry.dispose(); body.material.dispose(); }
});

test.each([
    [10, 0, "horizontal", "disc over shaft"],
    [10, 9, "vertical", "exposed shaft"],
    [10, 27, "vertical", "upper arrowhead"],
    [10, -27, "vertical", "lower arrowhead"],
    [60, 0, "horizontal", "disc center under arrowhead padding"],
    [60, 27, "horizontal", "disc overlapping upper arrowhead"],
    [60, -27, "horizontal", "disc overlapping lower arrowhead"],
])("point widget at %s degrees picks %s as %s (%s)", (angle, height, mode) => {
    const camera = new OrthographicCamera(-100, 100, 100, -100, .1, 2000);
    camera.position.set(0, 1000 * Math.sin(angle * Math.PI / 180), 1000 * Math.cos(angle * Math.PI / 180));
    camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
    const rect = {left: 0, top: 0, width: 200, height: 200};
    const view = {id: "mainView", camera, visible: true, leftPx: 0, topPx: 0, widthPx: 200, heightPx: 200,
        div: {getBoundingClientRect: () => rect}, canvas: {getBoundingClientRect: () => rect},
        pixelsToMeters: (_position, pixels) => pixels};
    ViewMan.get.mockImplementation(id => id === "mainView" ? view : undefined);
    const widget = new PointEditorWidget(camera);
    widget.attach(new Object3D());
    const [x, y] = viewToClient(view, ...projectWorldToView(view, new Vector3(0, height, 0)));
    try {
        for (const pointerType of ["mouse", "touch"]) {
            const event = {button: 0, pointerType, clientX: x, clientY: y, preventDefault() {}};
            const hit = widget.unregisterInteraction.adapter.hitTest(event);
            expect(hit.handle.userData.type.startsWith(mode)).toBe(true);
            // Prove the overlap exists in the real geometry, including a shaft
            // that is closer to the camera than the disc at the center.
            const discHits = widget.raycaster.intersectObject(widget.handles.disc);
            if (angle === 60 || height === 0) expect(discHits.length).toBeGreaterThan(0);
            if (height === 0) {
                const nearest = widget.raycaster.intersectObjects([widget.handles.arrowUp, widget.handles.arrowDown], true)[0];
                expect(nearest.distance).toBeLessThan(discHits[0].distance);
            }
            widget.onPointerDown(event);
            expect(widget.activeDragMode).toBe(mode);
            widget.onPointerMove({...event, clientX: x + 8, clientY: y - 8});
            if (mode === "horizontal") {
                expect(widget.object.position.y).toBeCloseTo(0);
                expect(widget.object.position.x).toBeGreaterThan(0);
            } else {
                expect(widget.object.position.x).toBeCloseTo(0);
                expect(widget.object.position.z).toBeCloseTo(0);
                expect(widget.object.position.y).toBeGreaterThan(0);
            }
            widget.rollbackDrag(event);
            expect(widget.object.position.length()).toBeCloseTo(0);
        }
    } finally { widget.dispose(); }
});
