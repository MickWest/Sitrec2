import {
    BufferGeometry,
    CircleGeometry,
    ConeGeometry,
    CylinderGeometry,
    DoubleSide,
    EventDispatcher,
    Float32BufferAttribute,
    Group,
    Matrix4,
    Mesh,
    MeshBasicMaterial,
    Plane,
    PlaneGeometry,
    Quaternion,
    Raycaster,
    Vector2,
    Vector3
} from "three";
import * as LAYER from "./LayerMasks";
import {getLocalUpVector} from "./SphericalMath";
import {getInteractiveViewAt, isViewDisplayed, mouseToNDC, setRaycasterFromView, withDisplayedCamera} from "./ViewUtils";
import {registerEditorInteraction} from "./EditorInteraction";
import {getInteractionRouter} from "./InteractionRouter";
import {adjustHeightAboveGround, adjustHeightHAE} from "./threeExt";
import {ECEFToLLAVD_radii} from "./LLA-ECEF-ENU";
import {getObjectMoveMode} from "./ObjectMoveModes";
import {isPointOccludedByGlobe} from "./GlobeOcclusion";
import {ViewMan} from "./CViewManager";
import {SceneLine} from "./SceneLines";
import {SceneLineMaterial} from "./SceneLineMaterial";

// Screen size the handles are drawn at, in pixels (updateHandleScales applies these).
// createArrowGeometry needs the arrow one to express its hit padding in pixels, so both
// live out here rather than inside that method.
// Preserve the established object/track widget proportions. These broad move
// and altitude grips serve a different purpose from compact corner handles.
const DISC_PIXEL_SIZE = 40;
const ARROW_PIXEL_SIZE = 30;

// How far past the drawn arrow the invisible pick region reaches, in screen pixels.
const ARROW_HIT_PADDING_PX = 3;
const PUSH_DOUBLING_PIXELS = 200;
const PUSH_COLOR = 0xffaa33;

function createArrowGeometry(material) {
    const shaftRadius = 0.05;
    const headRadius = 0.12;
    const shaftHeight = 1.4;
    const headHeight = 0.8;
    const shaftCenterY = -0.2;
    const headCenterY = 0.9;

    const shaftGeometry = new CylinderGeometry(shaftRadius, shaftRadius, shaftHeight, 8);
    const headGeometry = new ConeGeometry(headRadius, headHeight, 8);
    
    const group = new Group();
    const shaftMesh = new Mesh(shaftGeometry, material);
    const headMesh = new Mesh(headGeometry, material);
    
    shaftMesh.position.y = shaftCenterY;
    headMesh.position.y = headCenterY;
    shaftMesh.userData.arrowPart = 'shaft';
    headMesh.userData.arrowPart = 'head';
    
    group.add(shaftMesh);
    group.add(headMesh);

    // An invisible, more forgiving thing to actually click on.
    //
    // The drawn arrow is a hairline shaft under a cone, and a cone tapers to nothing:
    // near the tip — the part of an arrow people aim at — the target is a couple of
    // pixels wide, and the shaft is barely wider. So picking uses a plain cylinder of
    // the head's FULL base radius, running the whole length of the arrow: the head's
    // triangle becomes a rectangle whose top is the arrow's tip, and the shaft inherits
    // the same width. Then ARROW_HIT_PADDING_PX past that in every direction.
    //
    // Padding is stated in pixels and converted here because the handle is scaled to a
    // fixed SCREEN size: updateHandleScales gives y a factor of `arrowMeters` (=
    // ARROW_PIXEL_SIZE pixels) and x/z twice that, so a pixel is 1/30 of a local unit
    // along the arrow and 1/60 across it. Constant local padding is therefore constant
    // pixel padding at every distance.
    const padAlong = ARROW_HIT_PADDING_PX / ARROW_PIXEL_SIZE;
    const padAcross = ARROW_HIT_PADDING_PX / (2 * ARROW_PIXEL_SIZE);

    const hitBottom = shaftCenterY - shaftHeight / 2 - padAlong;
    const hitTop = headCenterY + headHeight / 2 + padAlong;
    const hitRadius = headRadius + padAcross;

    // Separate head and shaft picks so the disc can win over an overlapping
    // shaft while an arrowhead remains a vertical grip, regardless of depth.
    const headBottom = headCenterY - headHeight / 2 - padAlong;
    for (const [part, bottom, top] of [['shaft', hitBottom, headBottom], ['head', headBottom, hitTop]]) {
        const hitMesh = new Mesh(new CylinderGeometry(hitRadius, hitRadius, top - bottom, 8), material);
        hitMesh.position.y = (top + bottom) / 2;
        hitMesh.userData.arrowPart = part;
        hitMesh.userData.isPickPadding = true;
        // Three.js raycasting includes invisible meshes.
        hitMesh.visible = false;
        group.add(hitMesh);
    }

    return group;
}

export class PointEditorWidget extends EventDispatcher {
    constructor(camera, renderer) {
        super();
        
        this.camera = camera;
        this.renderer = renderer;
        
        this.object = null;
        this.group = new Group();
        
        this.raycaster = new Raycaster();
        this.raycaster.layers.mask = LAYER.MASK_HELPERS | LAYER.MASK_LOOK;
        this.pointer = new Vector2();
        
        this.isDragging = false;
        this.isPointerDown = false;
        this.pointerDownButton = -1;
        this.dragPlane = new Plane();
        this.dragStart = new Vector3();
        this.dragStartWorld = new Vector3();
        this.dragStartLocalUp = new Vector3();
        this.dragStartIntersect = new Vector3(); // Initial plane intersection point
        this.startClosestPoint = new Vector3(); // Closest point on localUp line to initial ray
        
        this.activeDragMode = null; // horizontal/vertical (surface), lookCameraPlane, push, screenPlane
        this.dragPlaneQuaternion = new Quaternion();
        this.pushOrigin = new Vector3();
        this.pushDirection = new Vector3();
        this.draggedHandle = null; // which handle was hit on pointerdown
        this.activeView = null;    // CNodeView3D that owns the active press (mainView or lookView)
        
        this.handles = {
            disc: null,
            arrowUp: null,
            arrowDown: null
        };
        
        this.createHandles();
        
        this.unregisterInteraction = registerEditorInteraction(this, {
            id: `point-widget:${this.group.uuid}`,
            enabled: () => !!this.object && this.group.visible,
            pick: e => {
                if (!this.setupRaycasterForEvent(e)) return null;
                const hit = this.pickHandle();
                return hit ? {distance: hit.distance, priority: 70, handle: hit.object} : null;
            },
            rollback: e => this.rollbackDrag(e),
        });
    }
    
    createHandles() {
        const discGeometry = new CircleGeometry(1, 32);
        const discMaterial = new MeshBasicMaterial({
            color: 0x00ff00,
            transparent: true,
            opacity: 0.6,
            side: DoubleSide,
            depthTest: true,
            depthWrite: false
        });
        
        this.handles.disc = new Mesh(discGeometry, discMaterial);
        this.handles.disc.userData.type = 'horizontal';
        this.handles.disc.userData.handleRole = 'move';
        this.handles.disc.layers.mask = LAYER.MASK_HELPERS | LAYER.MASK_LOOK;
        this.group.add(this.handles.disc);
        
        const arrowMaterial = new MeshBasicMaterial({
            color: 0xff0000,
            transparent: true,
            opacity: 0.6,
            depthTest: true,
            depthWrite: false
        });
        
        this.handles.arrowUp = createArrowGeometry(arrowMaterial);
        this.handles.arrowUp.userData.type = 'vertical_up';
        this.handles.arrowUp.layers.mask = LAYER.MASK_HELPERS | LAYER.MASK_LOOK;
        this.handles.arrowUp.traverse(child => {
            if (child.isMesh) {
                child.material = arrowMaterial;
                child.layers.mask = LAYER.MASK_HELPERS | LAYER.MASK_LOOK;
                child.userData.type = 'vertical_up';
                child.userData.handleRole = 'altitude';
            }
        });
        this.group.add(this.handles.arrowUp);
        
        this.handles.arrowDown = createArrowGeometry(arrowMaterial);
        this.handles.arrowDown.userData.type = 'vertical_down';
        this.handles.arrowDown.layers.mask = LAYER.MASK_HELPERS | LAYER.MASK_LOOK;
        this.handles.arrowDown.traverse(child => {
            if (child.isMesh) {
                child.material = arrowMaterial;
                child.layers.mask = LAYER.MASK_HELPERS | LAYER.MASK_LOOK;
                child.userData.type = 'vertical_down';
                child.userData.handleRole = 'altitude';
            }
        });
        this.group.add(this.handles.arrowDown);
    }

    createPlaneGrid() {
        // Flat strips make a square grid, without diagonal wireframe edges.
        // At the normal 40px handle radius each strip is about one pixel wide.
        const vertices = [];
        const rectangle = (x0, y0, x1, y1) => vertices.push(
            x0, y0, 0, x1, y0, 0, x1, y1, 0,
            x0, y0, 0, x1, y1, 0, x0, y1, 0);
        for (let i = 0; i <= 4; i++) {
            const p = -1 + i / 2;
            const lo = Math.max(-1, p - 0.0125), hi = Math.min(1, p + 0.0125);
            rectangle(lo, -1, hi, 1);
            rectangle(-1, lo, 1, hi);
        }
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
        const material = new MeshBasicMaterial({color: 0x3399ff, transparent: true,
            opacity: 0.6, side: DoubleSide, depthTest: true, depthWrite: false});
        const grid = this.handles.planeGrid = new Mesh(geometry, material);
        grid.layers.mask = LAYER.MASK_HELPERS | LAYER.MASK_LOOK;
        grid.userData.type = 'lookCameraPlane';
        grid.userData.handleRole = 'move';
        // The spaces between grid lines must be just as easy to grab as the lines.
        const pick = this.planeGridPick = new Mesh(new PlaneGeometry(2, 2), material);
        pick.visible = false;
        pick.layers.mask = grid.layers.mask;
        pick.userData.type = 'lookCameraPlane';
        pick.userData.handleRole = 'move';
        grid.add(pick);
        this.group.add(grid);
        return grid;
    }

    movementMode(view) {
        if (view?.id !== 'mainView' && view?.id !== 'lookView') return 'surface';
        if (this.isDragging) {
            return ['horizontal', 'vertical'].includes(this.activeDragMode) ? 'surface' : this.activeDragMode;
        }
        // An explicit track-height lock takes priority over a free plane or ray.
        if (this.freeMovementAllowed === false || (this.altitudeLocked && this.altitudeLockValue >= 0)) return 'surface';
        const mode = getObjectMoveMode();
        if (['lookCameraPlane', 'push'].includes(mode) && !ViewMan.get('lookView', false)?.camera) return 'surface';
        return mode;
    }

    planeQuaternion(mode, view) {
        return mode === 'screenPlane' ? withDisplayedCamera(view, camera => camera.getWorldQuaternion(new Quaternion()))
            : this.lookCameraPlaneQuaternion();
    }

    displayedPlaneQuaternion(actual, view) {
        const normal = new Vector3(0, 0, 1).applyQuaternion(actual);
        const towardView = view.camera.getWorldPosition(new Vector3()).sub(this.object.position).normalize();
        // The Look camera is IN the camera plane. Give its edge-on grid a
        // visible grip; movement still follows the exact, frozen constraint.
        if (Math.abs(normal.dot(towardView)) >= .15) return actual;
        const tiltedNormal = normal.clone().addScaledVector(towardView, .7).normalize();
        return new Quaternion().setFromUnitVectors(normal, tiltedNormal).multiply(actual);
    }

    createPushArrow() {
        const group = this.handles.push = new Group();
        group.userData.type = 'push';
        group.userData.handleRole = 'move';
        // A larger near arrowhead and smaller far arrowhead keep the depth cue
        // readable even with a narrow field of view, where perspective is slight.
        for (const [direction, size, color] of [[1, .8, 0xdd8822], [-1, 1.2, PUSH_COLOR]]) {
            const material = new MeshBasicMaterial({color, transparent: true, opacity: .6,
                depthTest: true, depthWrite: false});
            const arrow = createArrowGeometry(material);
            arrow.scale.setScalar(size);
            if (direction < 0) arrow.rotation.z = Math.PI;
            arrow.traverse(child => {
                child.layers.mask = LAYER.MASK_HELPERS | LAYER.MASK_LOOK;
                child.userData.type = 'push';
                child.userData.handleRole = 'move';
            });
            group.add(arrow);
        }
        group.layers.mask = LAYER.MASK_HELPERS | LAYER.MASK_LOOK;
        this.group.add(group);
        return group;
    }

    orientPushArrow(view) {
        const rotation = view.camera.getWorldQuaternion(new Quaternion());
        const away = this.isDragging ? this.pushDirection.clone()
            : this.object.position.clone().sub(ViewMan.get('lookView').camera.getWorldPosition(new Vector3())).normalize();
        // Tilt the drawn arrow toward screen-up/right so it is not end-on. This
        // is only a visual cue; the movement still uses the un-tilted camera ray.
        const direction = away.add(new Vector3(.3, .8, 0).applyQuaternion(rotation)).normalize();
        return new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction);
    }

    updatePushLine(view) {
        const pushing = this.isDragging && this.activeDragMode === 'push';
        if (pushing && !this.pushLine) {
            const geometry = new BufferGeometry();
            geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3));
            this.pushLine = new SceneLine(geometry, new SceneLineMaterial({color: PUSH_COLOR, linewidth: 1.5,
                depthTest: true, toneMapped: false}));
            this.pushLine.layers.mask = LAYER.MASK_HELPERS;
            this.pushLine.raycast = () => {}; // A guide, not another handle.
            this.group.add(this.pushLine);
        }
        if (!this.pushLine) return;
        this.pushLine.visible = pushing && view?.id === 'mainView';
        if (!pushing) return;
        const start = this.pushOrigin.clone().sub(this.group.position);
        const range = Math.max(this.pushStartRange, this.object.position.distanceTo(this.pushOrigin));
        const end = start.clone().addScaledVector(this.pushDirection, range * 1.5);
        const positions = this.pushLine.sourceGeometry.getAttribute('position');
        positions.setXYZ(0, start.x, start.y, start.z);
        positions.setXYZ(1, end.x, end.y, end.z);
        positions.needsUpdate = true;
        this.pushLine.syncGeometry();
    }

    lookCameraPlaneQuaternion() {
        const camera = ViewMan.get('lookView').camera;
        const rotation = camera.getWorldQuaternion(new Quaternion());
        const right = new Vector3(1, 0, 0).applyQuaternion(rotation);
        const towardCamera = camera.getWorldPosition(new Vector3()).sub(this.object.position);
        const along = towardCamera.addScaledVector(right, -towardCamera.dot(right));
        // On the camera's right axis (or at the camera), its forward axis
        // resolves the otherwise ambiguous plane through that line of sight.
        if (along.lengthSq() < 1e-12) {
            along.set(0, 0, -1).applyQuaternion(rotation);
        }
        along.normalize();
        const normal = new Vector3().crossVectors(right, along).normalize();
        return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, along, normal));
    }
    
    attach(object) {
        if (this.object === object) return;
        getInteractionRouter()?.cancelOwner(this);
        
        if (this.object) {
            this.object.visible = true;
        }
        
        this.object = object;
        this.group.position.copy(object.position);
        this.group.visible = true;
        this.updateOrientation();
        this.updateHandleScales();
        
        object.visible = false;
        this.dispatchEvent({ type: 'attachedToObject', value: object });
    }
    
    detach() {
        getInteractionRouter()?.cancelOwner(this);
        const wasDragging = this.isDragging;
        if (this.object) {
            this.object.visible = true;
            this.dispatchEvent({ type: 'detachedFromObject', value: this.object });
        }
        this.object = null;
        this.isDragging = false;
        if (this.pushLine) this.pushLine.visible = false;
        this.isPointerDown = false;
        this.activeDragMode = null;
        this.draggedHandle = null;
        this.dragStartIntersect.set(0, 0, 0);
        if (wasDragging) {
            this.dispatchEvent({ type: 'dragging-changed', value: false });
        }
        
        this.group.visible = false;
    }
    
    updateOrientation(view = this.handleView) {
        if (!this.object) return;

        const localUp = this.isDragging ? this.dragStartLocalUp : getLocalUpVector(this.object.position);

        const mode = this.movementMode(view);
        const usePlane = mode === 'lookCameraPlane' || mode === 'screenPlane';
        const usePush = mode === 'push';
        this.handles.disc.visible = !usePlane && !usePush;
        this.handles.arrowUp.visible = this.handles.arrowDown.visible = !this.groundMoveOnly && !usePush && !usePlane;
        if (usePush) {
            const arrow = this.handles.push ?? this.createPushArrow();
            arrow.visible = true;
            arrow.quaternion.copy(this.orientPushArrow(view));
            arrow.traverse(child => { if (child.isMesh) child.material.opacity = this.handles.disc.material.opacity; });
        } else if (this.handles.push) {
            this.handles.push.visible = false;
        }
        if (usePlane) {
            const grid = this.handles.planeGrid ?? this.createPlaneGrid();
            grid.visible = true;
            const actual = this.isDragging ? this.dragPlaneQuaternion : this.planeQuaternion(mode, view);
            grid.quaternion.copy(this.isDragging ? this.dragGridQuaternions[view.id]
                ?? this.displayedPlaneQuaternion(actual, view) : this.displayedPlaneQuaternion(actual, view));
            grid.userData.type = this.planeGridPick.userData.type = mode;
            grid.material.color.setHex(mode === 'screenPlane' ? 0xbb88ff : 0x3399ff);
            grid.material.opacity = this.handles.disc.material.opacity;
        } else if (this.handles.planeGrid) {
            this.handles.planeGrid.visible = false;
        }
        
        this.handles.disc.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), localUp);
        
        this.handles.arrowUp.position.set(0, 0, 0);
        this.handles.arrowUp.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), localUp);
        
        this.handles.arrowDown.position.set(0, 0, 0);
        this.handles.arrowDown.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), localUp.clone().multiplyScalar(-1));
        this.updateHandleDepth();
        this.updatePushLine(view);
    }

    updateHandleDepth() {
        // Object-move handles overlay the model. Apply after creating any lazy
        // grid/arrow, and to each mesh because nested groups reset render order.
        for (const handle of Object.values(this.handles)) {
            handle?.traverse(child => {
                if (!child.isMesh) return;
                child.material.depthTest = !this.drawOnTop;
                child.renderOrder = this.drawOnTop ? 999 : 0;
            });
        }
    }
    
    updateHandleScales(view) {
        if (!this.object || !view || !view.pixelsToMeters) {
            return;
        }

        this.handleView = view;
        this.updateOrientation(view);

        // Scale per-view: see updateCubeScales for the timing rationale —
        // the render loop calls this once per view immediately before rendering
        // that view, so the gizmo lands at the correct screen-pixel size in
        // each view despite being a single shared Object3D.
        const discMeters = view.pixelsToMeters(this.object.position, DISC_PIXEL_SIZE);
        const arrowMeters = view.pixelsToMeters(this.object.position, ARROW_PIXEL_SIZE);
        
        this.handles.disc.scale.set(discMeters, discMeters, 1);
        this.handles.planeGrid?.scale.set(discMeters, discMeters, 1);
        this.handles.push?.scale.set(arrowMeters * 2, arrowMeters, arrowMeters * 2);
        
        this.handles.arrowUp.scale.set(arrowMeters / 0.5, arrowMeters, arrowMeters / 0.5);
        this.handles.arrowDown.scale.set(arrowMeters / 0.5, arrowMeters, arrowMeters / 0.5);
    }
    
    setupRaycasterForEvent(event) {
        // While a press is active, stay locked to the view it started in —
        // the drag plane (setupHorizontalDragPlane) was built from that camera's
        // ray, so swapping cameras mid-drag would yield wrong plane intersections.
        // For hover/pointerdown, pick whichever editing-capable view the cursor
        // is over (mainView preferred, then lookView).
        let view = null;
        if (this.isPointerDown && this.activeView) {
            view = this.activeView;
        } else {
            view = getInteractiveViewAt(event.clientX, event.clientY);
        }

        if (!view || !isViewDisplayed(view)) {
            return false;
        }

        // Recheck at pointerdown, even if a handle is still fading out or was
        // attached in another view. A drag already in progress keeps its view.
        if (!this.isPointerDown && this.object
            && isPointOccludedByGlobe(view.camera.position, this.object.getWorldPosition(new Vector3()))) return false;

        // Rescale handles for THIS view's pixel space before raycasting. The
        // per-render scale ends up at whichever view rendered last, so between
        // frames the handles may be sized for the wrong camera and clicks miss.
        // Force matrixWorld too — raycasting reads matrixWorld and Three.js
        // only rebuilds it during render.
        this.updateHandleScales(view);
        this.group.updateMatrixWorld(true);

        this.pointer.copy(mouseToNDC(view, event.clientX, event.clientY));
        if (!setRaycasterFromView(this.raycaster, view, event.clientX, event.clientY)) return false;

        // Remember which view this press belongs to so subsequent move events stay anchored.
        // (isPointerDown is set AFTER this call in onPointerDown, so on the very first call
        // of a press we still take the search branch above — that's where activeView gets set.)
        if (!this.isPointerDown) {
            this.activeView = view;
        }

        return true;
    }

    pickHandle() {
        if (this.handles.push?.visible) {
            return this.raycaster.intersectObject(this.handles.push, true)[0]
                ?? this.pickObjectAsHandle(this.handles.push);
        }
        // Raycasting includes invisible meshes, so choose the active surface explicitly.
        const surface = this.handles.planeGrid?.visible ? this.planeGridPick : this.handles.disc;
        const objects = [surface, ...[this.handles.arrowUp, this.handles.arrowDown].filter(handle => handle.visible)];
        const hits = this.raycaster.intersectObjects(objects, true);
        // Prefer the plane/disk wherever handles overlap. Exposed arrows still
        // change altitude; the object's body is another grip for the surface.
        return hits.find(hit => hit.object === surface) ?? hits[0] ?? this.pickObjectAsHandle(surface);
    }

    pickObjectAsHandle(handle) {
        const hit = this.pickObjectSurface?.(this.raycaster, this.activeView);
        return hit ? {...hit, object: handle} : null;
    }
    
    onPointerDown(event) {
        if (!this.object || !this.setupRaycasterForEvent(event)) {
            return;
        }

        // Only the left button starts a drag. onPointerMove already ignored the others,
        // but the dispatch below fired for ANY button — so a right-click on a handle
        // announced a drag that would never happen. Listeners act on that: PointEditor
        // snapshots undo state and every view's camera controls go off. With
        // right-click-deletes-a-control-point that turned into a real fault — the widget
        // is attached to whichever point the cursor is over, so deleting a point
        // dispatched 'drag started' (N points), deleted it, then dispatched 'drag ended'
        // (N-1 points), and the state comparison logged a spurious "Move track control
        // point" undo on top of the delete. Undoing it wrote N positions into an N-1
        // array and shifted every point past the deletion.
        if (event.button !== 0) {
            return;
        }

        const hit = this.pickHandle();
        if (!hit) return;

        const intersected = hit.object;
        let dragType = intersected.userData.type;
        
        if (!dragType && intersected.parent) {
            dragType = intersected.parent.userData.type;
        }
        
        console.log('onPointerDown: intersected object:', intersected.name, 'dragType:', dragType);
        
        this.dragStart.copy(this.pointer);
        this.dragStartWorld.copy(this.object.position);
        this.dragStartLocalUp.copy(getLocalUpVector(this.object.position));

        this.dragStartAltitude = ECEFToLLAVD_radii(this.dragStartWorld).z;
        this.planeScreenDrag = false;

        if (dragType === 'push') {
            this.activeDragMode = 'push';
            const camera = ViewMan.get('lookView').camera;
            this.pushOrigin.copy(camera.getWorldPosition(new Vector3()));
            this.pushDirection.copy(this.dragStartWorld).sub(this.pushOrigin);
            this.pushStartRange = this.pushDirection.length();
            if (this.pushStartRange < 1e-6) { this.onPointerUp(event); return false; }
            this.pushDirection.divideScalar(this.pushStartRange);
            this.pushStartY = event.clientY;
            this.pushMinRange = Math.max(camera.near * 1.05, .001);
        } else if (['horizontal', 'lookCameraPlane', 'screenPlane'].includes(dragType)) {
            this.activeDragMode = dragType;
            if (dragType !== 'horizontal') {
                this.dragPlaneQuaternion.copy(this.planeQuaternion(dragType, this.activeView));
                const normal = new Vector3(0, 0, 1).applyQuaternion(this.dragPlaneQuaternion);
                this.dragPlane.setFromNormalAndCoplanarPoint(normal, this.dragStartWorld);
                this.dragGridQuaternions = {};
                for (const id of ['mainView', 'lookView']) {
                    const view = ViewMan.get(id, false);
                    if (view?.camera) this.dragGridQuaternions[id] = this.displayedPlaneQuaternion(this.dragPlaneQuaternion, view).clone();
                }
            } else {
                this.setupHorizontalDragPlane();
            }
            this.planeScreenDrag = dragType === 'lookCameraPlane'
                && (this.activeView.id === 'lookView'
                    || Math.abs(this.raycaster.ray.direction.dot(this.dragPlane.normal)) < .15);
            if (this.planeScreenDrag) {
                const camera = ViewMan.get('lookView').camera;
                this.planeOrigin = camera.getWorldPosition(new Vector3());
                this.planeRight = new Vector3(1, 0, 0).applyQuaternion(camera.getWorldQuaternion(new Quaternion()));
                this.planeStartPointer = new Vector2(event.clientX, event.clientY);
                this.planeMetersPerPixel = this.activeView.pixelsToMeters(this.dragStartWorld, 1);
            } else {
                const startIntersect = this.raycaster.ray.intersectPlane(this.dragPlane, new Vector3());
                if (!startIntersect || Math.abs(this.raycaster.ray.direction.dot(this.dragPlane.normal)) < 1e-6) {
                    this.onPointerUp(event);
                    return false;
                }
                this.dragStartIntersect.copy(startIntersect);
            }
        } else if (dragType === 'vertical_up' || dragType === 'vertical_down') {
            this.activeDragMode = 'vertical';
            const closest = this.getClosestPointOnLineToRay(
                this.dragStartWorld,
                this.dragStartLocalUp,
                this.raycaster.ray.origin,
                this.raycaster.ray.direction
            );
            if (!closest) { this.onPointerUp(event); return false; }
            this.startClosestPoint.copy(closest);
        }

        // Disable all camera controls on the press, before the first move event.
        this.isPointerDown = true;
        this.pointerDownButton = event.button;
        this.draggedHandle = dragType;
        this.isDragging = true;
        this.updatePushLine(this.activeView);
        this.dispatchEvent({ type: 'dragging-changed', value: true });
        
        event.preventDefault();
    }
    
    setupHorizontalDragPlane() {
        const localUp = this.dragStartLocalUp;
        this.dragPlane.setFromNormalAndCoplanarPoint(localUp, this.dragStartWorld);
    }
    
    getClosestPointOnLineToRay(linePoint, lineDir, rayOrigin, rayDir) {
        const w = new Vector3().subVectors(rayOrigin, linePoint);
        
        const a = lineDir.dot(rayDir);
        const b = lineDir.dot(lineDir);
        const c = rayDir.dot(rayDir);
        const dw = w.dot(lineDir);
        const ew = w.dot(rayDir);
        
        const denom = b * c - a * a;
        if (Math.abs(denom) < 1e-10) return null;
        const s = (dw * c - ew * a) / denom;
        
        return new Vector3().copy(linePoint).addScaledVector(lineDir, s);
    }
    
    onPointerMove(event) {
        if (!this.object) {
            return;
        }
        
        if (!this.isPointerDown) {
            return;
        }
        
        if (this.pointerDownButton !== 0) {
            return;
        }
        
        if (!this.setupRaycasterForEvent(event)) {
            return;
        }
        
        if (!this.isDragging) {
            this.isDragging = true;
            this.dispatchEvent({ type: 'dragging-changed', value: true });
        }
        
        if (this.activeDragMode === 'push') {
            this.handlePushDrag(event);
        } else if (['horizontal', 'lookCameraPlane', 'screenPlane'].includes(this.activeDragMode)) {
            this.handleHorizontalDrag(event);
        } else if (this.activeDragMode === 'vertical') {
            this.handleVerticalDrag();
        } else {
            console.log('onPointerMove: unknown activeDragMode:', this.activeDragMode);
        }
    }
    
    handleHorizontalDrag(event) {
        let newPosition;
        if (this.planeScreenDrag) {
            // Viewed edge-on: horizontal motion slides across the plane and
            // vertical motion changes range. Both axes stay in the frozen plane.
            const exponent = Math.max(-20, Math.min(20, (this.planeStartPointer.y - event.clientY) / PUSH_DOUBLING_PIXELS));
            const ratio = 2 ** exponent;
            newPosition = this.dragStartWorld.clone().sub(this.planeOrigin).multiplyScalar(ratio).add(this.planeOrigin)
                .addScaledVector(this.planeRight, (event.clientX - this.planeStartPointer.x) * this.planeMetersPerPixel * ratio);
        } else {
            if (Math.abs(this.raycaster.ray.direction.dot(this.dragPlane.normal)) < 1e-6) return;
            const currentIntersect = this.raycaster.ray.intersectPlane(this.dragPlane, new Vector3());
            if (currentIntersect === null) return;
            newPosition = this.dragStartWorld.clone().add(currentIntersect.sub(this.dragStartIntersect));
        }

        if (this.activeDragMode === 'horizontal') newPosition = adjustHeightHAE(newPosition, this.dragStartAltitude);
        
        if (this.altitudeLocked && this.altitudeLockValue >= 0) {
            newPosition = adjustHeightAboveGround(newPosition, this.altitudeLockValue);
        }
        
        this.object.position.copy(newPosition);
        this.group.position.copy(this.object.position);
        this.updateOrientation();
        
        this.dispatchEvent({ type: 'change' });
        this.dispatchEvent({ type: 'objectChange' });
    }

    handlePushDrag(event) {
        // Relative range gives useful control at both metre and kilometre scales
        // and avoids crossing the camera when pulling a distant object closer.
        const exponent = Math.max(-20, Math.min(20, (this.pushStartY - event.clientY) / PUSH_DOUBLING_PIXELS));
        const range = Math.max(this.pushMinRange, this.pushStartRange * 2 ** exponent);
        this.object.position.copy(this.pushOrigin).addScaledVector(this.pushDirection, range);
        this.group.position.copy(this.object.position);
        this.updateOrientation();
        this.dispatchEvent({type: 'change'});
        this.dispatchEvent({type: 'objectChange'});
    }
    
    handleVerticalDrag() {
        const newClosestPoint = this.getClosestPointOnLineToRay(
            this.dragStartWorld,
            this.dragStartLocalUp,
            this.raycaster.ray.origin,
            this.raycaster.ray.direction
        );
        if (!newClosestPoint) return;
        
        const offset = new Vector3().subVectors(newClosestPoint, this.startClosestPoint);
        
        const newPosition = new Vector3().copy(this.dragStartWorld).add(offset);
        

        this.object.position.copy(newPosition);
        this.group.position.copy(this.object.position);
        this.updateOrientation();
        
        this.dispatchEvent({ type: 'change' });
        this.dispatchEvent({ type: 'objectChange' });
    }
    
    rollbackDrag(event) {
        if (this.object && this.isDragging) {
            this.object.position.copy(this.dragStartWorld);
            this.group.position.copy(this.dragStartWorld);
            this.rollbackEdit?.();
            this.dispatchEvent({type: 'change'});
        }
        this.onPointerUp(event);
    }

    onPointerUp(event) {
        const wasDragging = this.isDragging;
        
        this.isPointerDown = false;
        this.pointerDownButton = -1;
        this.isDragging = false;
        if (this.pushLine) this.pushLine.visible = false;
        this.planeScreenDrag = false;
        this.activeDragMode = null;
        this.draggedHandle = null;
        this.activeView = null;
        this.dragStartIntersect.set(0, 0, 0);

        if (wasDragging) {
            this.dispatchEvent({ type: 'dragging-changed', value: false });
        }
    }
    
    getHelper() {
        return this.group;
    }
    
    getRaycaster() {
        return this.raycaster;
    }
    
    // The up/down arrows stay while locked: on a track, dragging them moves the lock
    // height itself (CNodeSplineEditor.conformDraggedControlPoint).
    setAltitudeLocked(locked, altitudeValue = 0) {
        this.altitudeLocked = locked;
        this.altitudeLockValue = altitudeValue;
    }
    
    dispose() {
        this.unregisterInteraction?.();

        if (this.pushLine) {
            this.pushLine.geometry.dispose();
            this.pushLine.sourceGeometry.dispose();
            this.pushLine.material.dispose();
        }
        if (this.handles.push) {
            const materials = new Set();
            this.handles.push.traverse(child => {
                if (!child.isMesh) return;
                child.geometry.dispose();
                materials.add(child.material);
            });
            materials.forEach(material => material.dispose());
        }

        if (this.handles.planeGrid) {
            this.handles.planeGrid.geometry.dispose();
            this.handles.planeGrid.material.dispose();
            this.planeGridPick.geometry.dispose();
        }
        
        if (this.handles.disc) {
            this.handles.disc.geometry.dispose();
            this.handles.disc.material.dispose();
        }
        if (this.handles.arrowUp) {
            this.handles.arrowUp.traverse(child => {
                if (child.isMesh) {
                    child.geometry.dispose();
                    child.material.dispose();
                }
            });
        }
        if (this.handles.arrowDown) {
            this.handles.arrowDown.traverse(child => {
                if (child.isMesh) {
                    child.geometry.dispose();
                    child.material.dispose();
                }
            });
        }
        
        this.group.clear();
    }
}
