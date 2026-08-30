import {
    CircleGeometry,
    ConeGeometry,
    CylinderGeometry,
    DoubleSide,
    EventDispatcher,
    Group,
    Mesh,
    MeshBasicMaterial,
    Plane,
    Raycaster,
    Vector2,
    Vector3
} from "three";
import * as LAYER from "./LayerMasks";
import {getLocalUpVector} from "./SphericalMath";
import {ViewMan} from "./CViewManager";
import {mouseInViewOnly, mouseToViewNormalized} from "./ViewUtils";
import {adjustHeightAboveGround} from "./threeExt";

// Screen size the handles are drawn at, in pixels (updateHandleScales applies these).
// createArrowGeometry needs the arrow one to express its hit padding in pixels, so both
// live out here rather than inside that method.
const DISC_PIXEL_SIZE = 40;
const ARROW_PIXEL_SIZE = 30;

// How far past the drawn arrow the invisible pick region reaches, in screen pixels.
const ARROW_HIT_PADDING_PX = 3;

function createArrowGeometry() {
    const shaftRadius = 0.05;
    const headRadius = 0.12;
    const shaftHeight = 1.4;
    const headHeight = 0.8;
    const shaftCenterY = -0.2;
    const headCenterY = 0.9;

    const shaftGeometry = new CylinderGeometry(shaftRadius, shaftRadius, shaftHeight, 8);
    const headGeometry = new ConeGeometry(headRadius, headHeight, 8);
    
    const group = new Group();
    const shaftMesh = new Mesh(shaftGeometry);
    const headMesh = new Mesh(headGeometry);
    
    shaftMesh.position.y = shaftCenterY;
    headMesh.position.y = headCenterY;
    
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

    const hitMesh = new Mesh(
        new CylinderGeometry(hitRadius, hitRadius, hitTop - hitBottom, 8)
    );
    hitMesh.position.y = (hitTop + hitBottom) / 2;
    // Never drawn, still picked: Three.js's Raycaster does not test .visible. (The same
    // property is what lets a control point be deleted while the widget hides its cube.)
    hitMesh.visible = false;
    group.add(hitMesh);

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
        
        this.activeDragMode = null; // 'horizontal' or 'vertical'
        this.draggedHandle = null; // which handle was hit on pointerdown
        this.activeView = null;    // CNodeView3D that owns the active press (mainView or lookView)
        
        this.handles = {
            disc: null,
            arrowUp: null,
            arrowDown: null
        };
        
        this.createHandles();
        
        this.boundPointerMove = (e) => this.onPointerMove(e);
        this.boundPointerDown = (e) => this.onPointerDown(e);
        this.boundPointerUp = (e) => this.onPointerUp(e);
        
        document.addEventListener('pointermove', this.boundPointerMove);
        document.addEventListener('pointerdown', this.boundPointerDown);
        document.addEventListener('pointerup', this.boundPointerUp);
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
        this.handles.disc.layers.mask = LAYER.MASK_HELPERS | LAYER.MASK_LOOK;
        this.group.add(this.handles.disc);
        
        const arrowMaterial = new MeshBasicMaterial({
            color: 0xff0000,
            transparent: true,
            opacity: 0.6,
            depthTest: true,
            depthWrite: false
        });
        
        this.handles.arrowUp = createArrowGeometry();
        this.handles.arrowUp.userData.type = 'vertical_up';
        this.handles.arrowUp.layers.mask = LAYER.MASK_HELPERS | LAYER.MASK_LOOK;
        this.handles.arrowUp.traverse(child => {
            if (child.isMesh) {
                child.material = arrowMaterial;
                child.layers.mask = LAYER.MASK_HELPERS | LAYER.MASK_LOOK;
                child.userData.type = 'vertical_up';
            }
        });
        this.group.add(this.handles.arrowUp);
        
        this.handles.arrowDown = createArrowGeometry();
        this.handles.arrowDown.userData.type = 'vertical_down';
        this.handles.arrowDown.layers.mask = LAYER.MASK_HELPERS | LAYER.MASK_LOOK;
        this.handles.arrowDown.traverse(child => {
            if (child.isMesh) {
                child.material = arrowMaterial;
                child.layers.mask = LAYER.MASK_HELPERS | LAYER.MASK_LOOK;
                child.userData.type = 'vertical_down';
            }
        });
        this.group.add(this.handles.arrowDown);
    }
    
    attach(object) {
        if (this.object === object) return;
        
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
        const wasDragging = this.isDragging;
        if (this.object) {
            this.object.visible = true;
            this.dispatchEvent({ type: 'detachedFromObject', value: this.object });
        }
        this.object = null;
        this.isDragging = false;
        this.isPointerDown = false;
        this.activeDragMode = null;
        this.draggedHandle = null;
        this.dragStartIntersect.set(0, 0, 0);
        if (wasDragging) {
            this.dispatchEvent({ type: 'dragging-changed', value: false });
        }
        
        this.group.visible = false;
    }
    
    updateOrientation() {
        if (!this.object) return;
        
        this.dragStartLocalUp = getLocalUpVector(this.object.position);
        
        const localUp = this.dragStartLocalUp.clone();
        
        this.handles.disc.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), localUp);
        
        this.handles.arrowUp.position.set(0, 0, 0);
        this.handles.arrowUp.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), localUp);
        
        this.handles.arrowDown.position.set(0, 0, 0);
        this.handles.arrowDown.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), localUp.clone().multiplyScalar(-1));
    }
    
    updateHandleScales(view) {
        if (!this.object || !view || !view.pixelsToMeters) {
            return;
        }

        // Scale per-view: see updateCubeScales for the timing rationale —
        // the render loop calls this once per view immediately before rendering
        // that view, so the gizmo lands at the correct screen-pixel size in
        // each view despite being a single shared Object3D.
        const discMeters = view.pixelsToMeters(this.object.position, DISC_PIXEL_SIZE);
        const arrowMeters = view.pixelsToMeters(this.object.position, ARROW_PIXEL_SIZE);
        
        this.handles.disc.scale.set(discMeters, discMeters, 1);
        
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
            for (const id of ["mainView", "lookView"]) {
                const v = ViewMan.get(id, false);
                if (v && mouseInViewOnly(v, event.clientX, event.clientY)) {
                    view = v;
                    break;
                }
            }
        }

        if (!view) {
            return false;
        }

        // Rescale handles for THIS view's pixel space before raycasting. The
        // per-render scale ends up at whichever view rendered last, so between
        // frames the handles may be sized for the wrong camera and clicks miss.
        // Force matrixWorld too — raycasting reads matrixWorld and Three.js
        // only rebuilds it during render.
        this.updateHandleScales(view);
        this.group.updateMatrixWorld(true);

        const [px, py] = mouseToViewNormalized(view, event.clientX, event.clientY);
        this.pointer.x = px;
        this.pointer.y = py;
        this.raycaster.setFromCamera(this.pointer, view.camera);

        // Remember which view this press belongs to so subsequent move events stay anchored.
        // (isPointerDown is set AFTER this call in onPointerDown, so on the very first call
        // of a press we still take the search branch above — that's where activeView gets set.)
        if (!this.isPointerDown) {
            this.activeView = view;
        }

        return true;
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

        const objectsToTest = [this.handles.disc];
        if (!this.altitudeLocked) {
            objectsToTest.push(this.handles.arrowUp, this.handles.arrowDown);
        }
        
        const intersects = this.raycaster.intersectObjects(objectsToTest, true);
        
        if (intersects.length === 0) {
            return;
        }
        
        const intersected = intersects[0].object;
        let dragType = intersected.userData.type;
        
        if (!dragType && intersected.parent) {
            dragType = intersected.parent.userData.type;
        }
        
        console.log('onPointerDown: intersected object:', intersected.name, 'dragType:', dragType);
        
        this.isPointerDown = true;
        this.pointerDownButton = event.button;
        this.draggedHandle = dragType;
        this.dragStart.copy(this.pointer);
        this.dragStartWorld.copy(this.object.position);
        this.dragStartLocalUp.copy(getLocalUpVector(this.object.position));
        
        // Dispatch dragging-changed at pointerdown — not at first move — so
        // the listener can disable ALL views' camera controls BEFORE the next
        // pointermove fires. The lookView (or mainView) canvas captured this
        // pointer on its handleMouseDown and would otherwise orbit its camera
        // on the very first move event, before the existing dispatch in
        // onPointerMove had a chance to flip enabled=false. That one-frame
        // orbit was what made the dragged point appear to "flash away."
        this.isDragging = true;
        this.dispatchEvent({ type: 'dragging-changed', value: true });

        if (dragType === 'horizontal') {
            this.activeDragMode = 'horizontal';
            this.setupHorizontalDragPlane();
            const startIntersect = this.raycaster.ray.intersectPlane(this.dragPlane, new Vector3());
            if (startIntersect) {
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
            this.startClosestPoint.copy(closest);
        }
        
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
        
        if (this.activeDragMode === 'horizontal') {
            this.handleHorizontalDrag();
        } else if (this.activeDragMode === 'vertical') {
            this.handleVerticalDrag();
        } else {
            console.log('onPointerMove: unknown activeDragMode:', this.activeDragMode);
        }
    }
    
    handleHorizontalDrag() {
        const currentIntersect = this.raycaster.ray.intersectPlane(this.dragPlane, new Vector3());
        
        if (currentIntersect === null) {
            return;
        }
        
        const offset = currentIntersect.clone().sub(this.dragStartIntersect);
        let newPosition = this.dragStartWorld.clone().add(offset);
        
        if (this.altitudeLocked && this.altitudeLockValue >= 0) {
            newPosition = adjustHeightAboveGround(newPosition, this.altitudeLockValue);
        }
        
        this.object.position.copy(newPosition);
        this.group.position.copy(this.object.position);
        this.updateOrientation();
        
        this.dispatchEvent({ type: 'change' });
        this.dispatchEvent({ type: 'objectChange' });
    }
    
    handleVerticalDrag() {
        const newClosestPoint = this.getClosestPointOnLineToRay(
            this.dragStartWorld,
            this.dragStartLocalUp,
            this.raycaster.ray.origin,
            this.raycaster.ray.direction
        );
        
        const offset = new Vector3().subVectors(newClosestPoint, this.startClosestPoint);
        
        const newPosition = new Vector3().copy(this.dragStartWorld).add(offset);
        

        this.object.position.copy(newPosition);
        this.group.position.copy(this.object.position);
        this.updateOrientation();
        
        this.dispatchEvent({ type: 'change' });
        this.dispatchEvent({ type: 'objectChange' });
    }
    
    onPointerUp(event) {
        const wasDragging = this.isDragging;
        
        this.isPointerDown = false;
        this.pointerDownButton = -1;
        this.isDragging = false;
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
    
    setAltitudeLocked(locked, altitudeValue = 0) {
        this.altitudeLocked = locked;
        this.altitudeLockValue = altitudeValue;
        if (this.handles.arrowUp) {
            this.handles.arrowUp.visible = !locked;
        }
        if (this.handles.arrowDown) {
            this.handles.arrowDown.visible = !locked;
        }
    }
    
    dispose() {
        document.removeEventListener('pointermove', this.boundPointerMove);
        document.removeEventListener('pointerdown', this.boundPointerDown);
        document.removeEventListener('pointerup', this.boundPointerUp);
        
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
