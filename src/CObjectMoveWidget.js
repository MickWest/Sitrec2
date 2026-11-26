import {SceneLine} from "./SceneLines";
import {SceneLineMaterial} from "./SceneLineMaterial";
import {acquireControlLease} from "./InteractionRouter";
import {editingControls} from "./EditorInteraction";
import {objectFocusTrack, sameFocusTrack, syncCameraFocusUI} from "./CameraFocusUI";
// Dragging a 3D object around, instead of typing numbers into whatever track drives it.
//
// An object never owns its position. A CNodeControllerTrackPosition copies one out of a
// track every frame (FindRootTrack.js walks that chain), so "move the object" always
// means "move what the track says at this frame" — and the kinds of track answer that
// differently:
//
//   - a synthetic spline (CNodeSplineEditor): move the control point at this frame,
//     inserting one first when the frame falls between two existing points
//   - a fixed position (CNodePositionLLA — the camera, the target): edit its single
//     lat/lon/alt, which also refreshes its GUI boxes
//   - a generated balloon track: edit its launch position and regenerate its path
//   - anything else (ADS-B, KML, MISB, satellites): read-only data, so no widget at all
//
// The widget itself is the same PointEditorWidget the spline editor puts on its control
// points. It fades in when the cursor comes near the object and draws over it,
// without changing the object's materials. The object and its handles remain
// right-click targets for opening the object's edit menu.
//
// Two ways in:
//
//   - the object whose edit menu is open (right-click an object), or
//   - ANY movable object near the cursor while Option/Alt is held. That is a transient
//     move mode: no menu is opened, and camera navigation is suppressed for as long as
//     it is active, so a drag that misses the handles does not orbit the scene instead.
//
// Driven per view from CNodeView3D's render path, next to the spline editor's own
// handle scaling, because the handles are one shared Object3D that has to be re-scaled
// into each view's pixel space just before that view renders.

import {BufferGeometry, Float32BufferAttribute, Object3D, Vector3} from "three";
import {PointEditorWidget} from "./PointEditorWidget";
import {CNode3DObject} from "./nodes/CNode3DObject";
import {GlobalScene} from "./LocalFrame";
import {CustomManager, mainLoopCount, markShadowCastersDirty, NodeMan, setRenderOne} from "./Globals";
import {par} from "./par";
import {ViewMan} from "./CViewManager";
import {getInteractiveViewAt, projectWorldToView, viewToClient} from "./ViewUtils";
import {isPointOccludedByGlobe} from "./GlobeOcclusion";
import {findRootTrack} from "./FindRootTrack";
import {ECEFToLLAVD_radii, LLAToECEF} from "./LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import {getLocalUpVector} from "./SphericalMath";
import {getPointBelow} from "./threeExt";
import {undoManager as UndoManager} from "./UndoManager";
import {isAltitudeLockActive} from "./AltitudeLock";
import {updateObjectLocatorRings} from "./ObjectLocatorOverlay";
import {setObjectMoveMode} from './ObjectMoveModes';

// How close the cursor has to get, in screen pixels, before the widget appears. The
// widget's own disc is 40px and its arrows 30px, so this is a little wider than the
// thing it reveals. Big objects extend it to their own projected size (capped, so a
// model that fills the view does not make the whole viewport a hot zone).
const HOVER_RADIUS_PX = 70;
const HOVER_RADIUS_MAX_PX = 300;

// Widget fade time each way.
const FADE_MS = 150;

// The widget's handle materials are authored at this opacity; the fade scales it.
const WIDGET_OPACITY = 0.6;

function setObjectRotationY(node, angle) {
    node.common.rotateY = angle; // The menu listens to this value; preRender applies it in each view.
    if (node.hasVisibleShadowCaster?.()) markShadowCastersDirty("object rotation");
    setRenderOne(true);
}

/**
 * What, if anything, a drag on this object should write to.
 * @returns {{kind: "spline"|"fixed", node: CNode}|null} null when the object rides a
 *          data track (ADS-B, KML, satellite...) that the user cannot hand-edit.
 */
function resolveMoveTarget(objectNode) {
    const root = objectNode.groundMoveOnly ? objectNode : findRootTrack(objectNode);
    if (!root) return null;

    // A hand-drawn spline: control points at frames, interpolated between.
    if (root.splineEditor) {
        return {kind: "spline", node: root};
    }

    // Generated tracks can expose the position that drives their generator.
    // Editing that source keeps their physics and serialization intact.
    const position = root.getPositionEditTarget?.();
    if (position) return {kind: "fixed", node: root, position};

    // A fixed lat/lon/alt. Recognised by behaviour rather than by class so the
    // camera's and target's position nodes, and any future kin, all qualify.
    if (typeof root.setLLA === "function" && root._LLA !== undefined && root.ecef !== undefined) {
        return {kind: "fixed", node: root, position: {
            getLLA: () => root._LLA.slice(),
            getECEF: () => root.ecef.clone(),
            setLLA: (lat, lon, alt) => root.setLLA(lat, lon, alt),
            get agl() { return root.agl; },
        }};
    }

    return null;
}

class CObjectMoveWidget {
    constructor() {
        this.widget = null;         // PointEditorWidget, built on first use
        this.proxy = new Object3D();// what the widget actually moves; never in the scene
        this.node = null;           // the CNode3DObject being edited, if movable
        this.target = null;         // resolveMoveTarget() for that object

        this.fade = 0;              // 0 = no widget; 1 = widget fully visible
        this.hover = false;
        this.dragging = false;
        this.dragPrepared = false;
        this.dragAnchor = new Vector3();
        this.lockDragStart = null;  // altitude lock at the start of an up/down drag that moves it

        this.altHeld = false;       // Option/Alt alone: pick up whatever is under the cursor
        this.otherKeysHeld = new Set();
        this.altMode = false;       // ...and something movable actually is
        this.cameraSuppressed = false;
        this.savedControlsEnabled = null;

        this.lastMainLoopCount = -1;
        this.lastFadeTime = 0;

        this.pointerX = -1;
        this.pointerY = -1;
        // Guarded because this singleton is built at module load, and CNodeView3D —
        // which imports it — is reachable from Jest suites running in the default
        // "node" environment, where there is no document.
        if (typeof document === "undefined") return;

        document.addEventListener("pointermove", (event) => {
            this.pointerX = event.clientX;
            this.pointerY = event.clientY;
            this.updateAltHeld(event);
            // Plain mouse movement over a view does not otherwise request a render
            // (onDocumentMouseMove only does so while a button is down), so with
            // render-on-demand the reveal would wait for some unrelated redraw. Asked
            // for only when there is something to reveal, and the fade re-arms itself
            // from there until it settles.
            if (this.node || this.altHeld) setRenderOne(true);
        });

        // Alt is read from the events themselves rather than through
        // KeyBoardHandler.isKeyHeld: a DOM event's altKey cannot latch, and keyup does
        // not request a render (keydown does), so letting go of Alt would otherwise
        // leave the widget up until something unrelated redrew.
        // Track physical keys locally: Option+C produces “ç” on macOS, and the
        // main shortcut handler may consume an event before recording it.
        document.addEventListener("keydown", event => this.updateHeldKey(event, true), true);
        document.addEventListener("keyup", event => this.updateHeldKey(event, false), true);
        // Alt+Tab and friends take the key away with no keyup, which would leave the
        // mode stuck on when focus came back.
        window.addEventListener("blur", () => {
            this.otherKeysHeld.clear();
            this.setAltHeld(false);
        });
    }

    updateHeldKey(event, down) {
        const key = event.code || event.key;
        if (!["Alt", "AltLeft", "AltRight", "Control", "ControlLeft", "ControlRight"].includes(key)) {
            if (down) this.otherKeysHeld.add(key);
            else this.otherKeysHeld.delete(key);
        }
        this.updateAltHeld(event);
    }

    updateAltHeld(event) {
        this.setAltHeld(!!event.altKey && !event.shiftKey && !event.metaKey
            // Cycling movement modes is part of the Alt move gesture.
            && (this.otherKeysHeld.size === 0 || (!event.ctrlKey && this.otherKeysHeld.size === 1 && this.otherKeysHeld.has('KeyM'))));
    }

    setAltHeld(held) {
        if (held === this.altHeld) return;
        this.altHeld = held;
        if (!held && this.altMode && !this.dragging) {
            this.altMode = false;
            this.suppressCamera(false);
        }
        setRenderOne(true);
    }

    // The event listeners live for the page, but handles, picks and drag state belong
    // to one sitch. Run before nodes/scene disposal: disposeScene recursively empties
    // helper groups, so re-adding the old group would bring back no handles.
    resetForSitch() {
        setObjectMoveMode('surface');
        this.dragPrepared = false; // leaving a sitch must not record an unfinished drag
        this.rotationStart = undefined;
        this.setNode(null);
        this.widget?.detach();
        this.widget?.getHelper().removeFromParent();
        this.widget?.dispose();
        this.widget = null;
        if (this.dropLine) {
            this.dropLine.removeFromParent();
            this.dropLine.geometry.dispose();
            this.dropLine.sourceGeometry.dispose();
            this.dropLine.material.dispose();
            this.dropLine = null;
        }
        this.suppressCamera(false);
        this.updateEditFocus();
        this.target = null;
        this.altHeld = this.altMode = this.hover = this.dragging = false;
        this.fade = this.lastFadeTime = 0;
        this.lastMainLoopCount = -1;
        this.pointerX = this.pointerY = -1;
        this._objects = null;
        this._objectsVersion = undefined;
        this.undoStateBefore = this.insertedFrame = this.lockDragStart = null;
    }

    // ---------------------------------------------------------------- per-frame driver

    /**
     * Called once per visible 3D view, per frame, from CNodeView3D's render path.
     * The frame's own work runs on the first of those calls; the rest is per-view.
     */
    update(view) {
        if (mainLoopCount !== this.lastMainLoopCount) {
            this.lastMainLoopCount = mainLoopCount;
            this.updateFrame();
        }

        // Handles are a single shared Object3D, so size them for THIS view's pixel
        // space right before it renders (same reason as PointEditor.updateCubeScales).
        if (this.widget && this.widget.object && view.pixelsToMeters) {
            this.widget.updateHandleScales(view);
        }

        if (view.id === "mainView") {
            const editing = CustomManager?.getEditingObjectNode?.();
            const nodes = editing ? [editing] : this.altHeld ? this.objects() : [];
            updateObjectLocatorRings(view, nodes.filter(node => this.isObjectShownInView(node, view)));
        }
    }

    updateFrame() {
        syncCameraFocusUI();
        // Never re-pick mid-drag: releasing Alt, or dragging the object out from under
        // the cursor, must not hand the widget to a different object half way through.
        if (!this.dragging) {
            this.setNode(this.findEditableObject());
        }

        if (!this.node) {
            this.suppressCamera(false);
            this.updateDropLine();      // hides it
            this.updateEditFocus();
            return;
        }

        this.updateHover();
        this.updateDropLine();
        this.updateEditFocus();

        const fadeChanged = this.advanceFade();

        // Attached (and therefore grabbable) from the moment the cursor is near, so a
        // fast approach-and-click is not swallowed by the fade-in.
        const wantWidget = this.hover || this.fade > 0;
        this.setWidgetAttached(wantWidget);

        if (!this.dragging) {
            this.syncToObject();
        }

        this.applyFade();
        this.suppressCamera(this.dragging || this.altMode);

        if (fadeChanged) setRenderOne(true);
    }

    /** The object to put the widget on, if a drag on it could actually go anywhere. */
    findEditableObject() {
        // Option/Alt picks up whatever movable object is under the cursor, in
        // preference to whatever has its menu open. No menu is opened for it — an
        // already-open one just stays as it is.
        if (this.altHeld) {
            const found = this.findObjectUnderCursor();
            if (found) {
                this.target = found.target;
                this.altMode = true;
                return found.node;
            }
        }
        this.altMode = false;

        const node = CustomManager?.getEditingObjectNode?.();
        const target = this.movableTarget(node);
        if (!target) return null;

        this.target = target;
        return node;
    }

    /**
     * resolveMoveTarget, plus the checks that decide whether this widget should be the
     * one handling the object at all.
     * @returns {{kind: string, node: CNode}|null}
     */
    movableTarget(node) {
        if (!node || node.visible === false || !node.group) return null;
        if (!Number.isFinite(node.group.position.x)) return null;

        const target = resolveMoveTarget(node);
        if (!target) return null;

        // When the track's own spline editor is switched on it already owns this
        // interaction — its control-point cubes carry the identical widget, and two
        // of them at the same place would both answer the same pointerdown.
        if (target.kind === "spline" && target.node.splineEditor.enable) return null;

        return target;
    }

    /**
     * Every CNode3DObject, rebuilt only when the node set changes.
     *
     * Same caching as CCustomManager._getCNode3DObjects, and for the same reason: this
     * runs in the render loop and the graph is hundreds of nodes. Only ever called while
     * Alt is held, so the normal case pays nothing at all.
     */
    objects() {
        if (this._objectsVersion !== NodeMan.listVersion) {
            this._objects = [];
            for (const entry of Object.values(NodeMan.list)) {
                if (entry.data instanceof CNode3DObject || entry.data.groundMoveOnly) this._objects.push(entry.data);
            }
            this._objectsVersion = NodeMan.listVersion;
        }
        return this._objects;
    }

    /** The nearest movable object within reach of the cursor, or null. */
    findObjectUnderCursor() {
        const view = this.viewUnderCursor();
        if (!view) return null;

        let best = null;
        let bestDistance = Infinity;

        for (const node of this.objects()) {
            if (node.visible === false || !node.group) continue;
            if (view._renderHiddenNodeIDs?.has(node.id)) continue;
            const position = node.group.position;
            if (!Number.isFinite(position.x)) continue;

            // Cheapest tests first — the target walk is the expensive one.
            const distance = this.cursorDistancePx(view, position);
            if (distance >= bestDistance) continue;
            if (distance > this.hoverRadiusPx(view, position, node)) continue;
            if (!this.isObjectShownInView(node, view)) continue;

            const target = this.movableTarget(node);
            if (!target) continue;

            best = {node, target};
            bestDistance = distance;
        }

        return best;
    }

    // Custom views can hide a duplicate target only for the render, then
    // restore .visible afterwards. Match that per-view exclusion as well as
    // ordinary visibility and layers so hidden objects cannot steal the fade.
    isObjectShownInView(node, view) {
        if (!node || node.visible === false || !node.group || view._renderHiddenNodeIDs?.has(node.id)) return false;
        if (isPointOccludedByGlobe(view.camera.position, node.group.getWorldPosition(new Vector3()))) return false;
        for (let object = node.group; object; object = object.parent) {
            if (!object.visible) return false;
        }
        let shown = false;
        node.group.traverseVisible(object => {
            if ((object.isMesh || object.isLine || object.isPoints || object.isSprite)
                && object.layers.test(view.camera.layers)) shown = true;
        });
        return shown;
    }

    pickObjectSurface(raycaster, view) {
        if (!view || !this.isObjectShownInView(this.node, view)) return null;
        const node = this.node, group = node.group;
        const scale = group.scale.clone(), viewScale = node._viewScale, mask = raycaster.layers.mask;
        try {
            // Pick the size actually drawn in this view, including Main View Scale.
            node.applyViewScale?.(view);
            group.updateWorldMatrix(true, true);
            raycaster.layers.mask = view.camera.layers.mask;
            const meshes = [];
            group.traverseVisible(child => { if (child.isMesh || child.isSprite) meshes.push(child); });
            return raycaster.intersectObjects(meshes, false)[0] ?? null;
        } finally {
            raycaster.layers.mask = mask;
            group.scale.copy(scale);
            node._viewScale = viewScale;
            group.updateWorldMatrix(true, true);
        }
    }

    /** The displayed editing view under the cursor. */
    viewUnderCursor() {
        return getInteractiveViewAt(this.pointerX, this.pointerY);
    }

    setNode(node) {
        if (node === this.node) return;

        // Leave the outgoing object exactly as it was found.
        if (this.node) {
            this.hover = false;
            this.fade = 0;
            this.applyFade();
            this.setWidgetAttached(false);
            this.dragging = false;
        }

        this.node = node;
        if (!node) {
            this.target = null;
            this.altMode = false;
            return;
        }

        this.ensureWidget();
        this.syncToObject();
    }

    // ------------------------------------------------------------------------- hover

    updateHover() {
        // A drag owns the widget; Alt mode only picked this object BECAUSE it was in
        // reach, so in both cases the proximity question is already answered.
        if (this.dragging || this.altMode) {
            this.hover = true;
            return;
        }

        const view = this.viewUnderCursor();
        if (!view || !this.isObjectShownInView(this.node, view)) {
            this.hover = false;
            return;
        }

        const position = this.node.group.position;
        this.hover = this.cursorDistancePx(view, position)
            < this.hoverRadiusPx(view, position, this.node);
        // Large models can extend beyond the normal proximity radius.
        if (!this.hover && this.widget?.setupRaycasterForEvent({clientX: this.pointerX, clientY: this.pointerY})) {
            this.hover = !!this.pickObjectSurface(this.widget.raycaster, view);
        }
    }

    /**
     * Screen-pixel distance from the cursor to a world point in this view.
     *
     * Uses the displayed projection, just like the widget's handle pick.
     */
    cursorDistancePx(view, position) {
        const projected = projectWorldToView(view, position);
        if (!projected) return Infinity;
        const [x, y] = viewToClient(view, ...projected);
        return Math.hypot(x - this.pointerX, y - this.pointerY);
    }

    /** Wide enough to cover the object itself, so a large model is grabbable anywhere on it. */
    hoverRadiusPx(view, position, node) {
        const radius = node.cachedBoundingSphere?.radius;
        if (!radius || !view.metersToPixels) return HOVER_RADIUS_PX;

        const objectPx = view.metersToPixels(position, radius * (node.group.scale.x || 1));
        if (!Number.isFinite(objectPx)) return HOVER_RADIUS_PX;

        return Math.min(Math.max(HOVER_RADIUS_PX, objectPx + 20), HOVER_RADIUS_MAX_PX);
    }

    // -------------------------------------------------------------------------- fade

    /** Step this.fade towards its target. @returns {boolean} true while still moving. */
    advanceFade() {
        const now = performance.now();
        const elapsed = this.lastFadeTime ? now - this.lastFadeTime : 0;
        this.lastFadeTime = now;

        const target = this.hover ? 1 : 0;
        if (this.fade === target) return false;

        // Clamped: a long frame (a sitch load, a tab regaining focus) should finish the
        // fade, not overshoot past it.
        const step = Math.min(elapsed, FADE_MS) / FADE_MS;
        this.fade = target > this.fade
            ? Math.min(target, this.fade + step)
            : Math.max(target, this.fade - step);
        return true;
    }

    applyFade() {
        this.setWidgetOpacity(this.dragging ? 1 : this.fade);
    }

    setWidgetOpacity(amount) {
        if (!this.widget) return;
        const helper = this.widget.getHelper();
        helper.visible = this.widget.object !== null && amount > 0;
        helper.traverse((child) => {
            if (child.isMesh && child.material) {
                child.material.opacity = WIDGET_OPACITY * amount;
            }
        });
    }

    // ------------------------------------------------------------------------ widget

    ensureWidget() {
        if (!this.widget) {
            const view = ViewMan.get("mainView", false);
            this.widget = new PointEditorWidget(view?.camera, view?.renderer?.domElement);
            this.widget.drawOnTop = true;
            this.widget.pickObjectSurface = (raycaster, view) => this.pickObjectSurface(raycaster, view);
            this.widget.canRotate = () => Number.isFinite(this.node?.common?.rotateY);
            this.widget.addEventListener("rotateY", event => this.rotateByPixels(event.pixels));

            // Draw the handles after the object, including transparent materials.
            const helper = this.widget.getHelper();
            helper.renderOrder = 999;

            this.widget.addEventListener("change", () => setRenderOne());
            this.widget.addEventListener("objectChange", () => this.onWidgetMoved());
            this.widget.rollbackEdit = () => this.rollbackDrag();
            this.widget.addEventListener("dragging-changed", (event) => this.onDraggingChanged(event));
        }

        // resetForSitch releases these handles before the old scene is destroyed.
        const helper = this.widget.getHelper();
        // The normal view picker walks ancestors for nodeId. Keep it on the helper
        // so right-clicking any handle opens the menu for the current object.
        helper.userData.nodeId = this.node.id;
        if (helper.parent !== GlobalScene) {
            GlobalScene.add(helper);
        }
    }

    // Suspend aiming while dragging the focused object, without changing the
    // selected track. No saved focus can later overwrite a newer menu choice.
    updateEditFocus() {
        ViewMan.iterate((id, view) => {
            if (view?.focusTrackName === undefined) return;
            view.suspendObjectFocus = !!(this.node && this.dragging && sameFocusTrack(
                NodeMan.get(view.focusTrackName, false), objectFocusTrack(this.node)));
        });
    }

    // A plumb line from the object straight down to the ground.
    //
    // Height above open terrain is the one thing a perspective view will not tell you: a
    // sphere at 20 m and one at 2000 m look identical against distant ground, and while
    // dragging that is exactly what you are trying to judge. The line gives the eye
    // something to read the height against, and shows WHERE on the ground it sits.
    //
    // Down means along the local up vector, not world -Y: the render frame is ECEF, so
    // "down" is toward the Earth's centre and differs by hundreds of kilometres of
    // direction across a sitch.
    updateDropLine() {
        if (!this.node?.group) {
            if (this.dropLine) this.dropLine.visible = false;
            return;
        }

        const top = this.node.group.position;
        // raycast:false — the smooth elevation map rather than the mesh. Under Google 3D
        // the terrain keeps its whole LOD pyramid and a raycast returns the topmost tile,
        // which is not the surface being looked at.
        const ground = getPointBelow(top, false);
        if (!ground) {
            if (this.dropLine) this.dropLine.visible = false;
            return;
        }

        if (!this.dropLine) {
            const geometry = new BufferGeometry();
            geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(6), 3));
            this.dropLine = new SceneLine(geometry, new SceneLineMaterial({
                color: 0x808080,        // 50% grey
                linewidth: 1,
                depthTest: true,
                toneMapped: false,
            }));
            this.dropLine.renderOrder = 998;   // under the widget handles (999)
        }

        // The singleton survives a sitch load; resetForSitch releases its old line.
        if (this.dropLine.parent !== GlobalScene) GlobalScene.add(this.dropLine);

        // The line is drawn in the object's own local space so the two ends stay in
        // float32 range — ECEF coordinates are ~6,378 km from the origin, and a geometry
        // holding them directly would visibly jitter.
        this.dropLine.position.copy(top);
        const positions = this.dropLine.sourceGeometry.getAttribute("position");
        positions.setXYZ(0, 0, 0, 0);
        positions.setXYZ(1, ground.x - top.x, ground.y - top.y, ground.z - top.z);
        positions.needsUpdate = true;
        this.dropLine.syncGeometry();
        this.dropLine.visible = true;
    }

    setWidgetAttached(attached) {
        if (!this.widget) return;
        if (attached) {
            if (this.widget.object !== this.proxy) {
                this.proxy.position.copy(this.node.group.position);
                this.widget.attach(this.proxy);
            }
        } else if (this.widget.object) {
            this.widget.detach();
        }
    }

    /**
     * Hold every 3D view's camera controls off while this widget owns the pointer.
     *
     * Two reasons. During a drag, the view that captured the press would otherwise orbit
     * on the first pointermove (see PointEditorWidget's note on dispatching
     * dragging-changed at pointerdown). And in Alt move mode the whole point is that the
     * gesture belongs to the object: a drag that misses the handles should do nothing,
     * not spin the scene.
     *
     * Each view's previous value is remembered and put back, rather than blanket
     * re-enabling — something else may have had them off for its own reasons.
     */
    suppressCamera(suppress) {
        if (suppress === this.cameraSuppressed) return;
        this.cameraSuppressed = suppress;

        if (suppress) this.releaseCamera = acquireControlLease(editingControls());
        else { this.releaseCamera?.(); this.releaseCamera = null; }
    }

    /** Follow the object, which the controllers re-place every frame. */
    syncToObject() {
        if (!this.node) return;
        this.proxy.position.copy(this.node.group.position);
        if (this.widget && this.widget.object) {
            this.widget.groundMoveOnly = !!this.node.groundMoveOnly;
            this.widget.freeMovementAllowed = !this.widget.groundMoveOnly
                && (this.target?.kind !== 'spline' || !isAltitudeLockActive(this.target.node));
            this.widget.group.position.copy(this.proxy.position);
            this.widget.updateOrientation();
        }
    }

    // -------------------------------------------------------------------------- drag

    onDraggingChanged(event) {
        if (event.value) {
            // The widget announces a drag on ANY button; only the left one moves things
            // (its own pointermove handler ignores the rest).
            if (this.widget.pointerDownButton !== 0) return;
            this.dragging = true;
            this.dragPrepared = false;
            this.dragAnchor.copy(this.proxy.position);
            this.rotationStart = this.widget.activeDragMode === "rotateY" ? this.node.common.rotateY : undefined;
        } else {
            this.endDrag();
        }

        // Keep the widget fully visible from press until release.
        this.applyFade();
        setRenderOne(true);

        // Applied here as well as in updateFrame so it lands at pointerdown, BEFORE the
        // next pointermove — a frame's delay is enough for the view that captured the
        // press to orbit once. Leaving a drag while Alt is still held keeps it on.
        this.suppressCamera(this.dragging || this.altMode);
        this.updateEditFocus();
    }

    rotateByPixels(pixels) {
        if (!this.dragging || this.rotationStart === undefined) return;
        const delta = Math.round(pixels / 2);
        const raw = this.rotationStart + delta;
        const angle = raw >= -180 && raw <= 180 ? raw : ((raw + 180) % 360 + 360) % 360 - 180;
        if (angle !== this.node.common.rotateY) setObjectRotationY(this.node, angle);
    }

    onWidgetMoved() {
        if (!this.dragging || !this.node || !this.target) return;

        // Prepared on the first actual movement, not on pointerdown, so merely clicking
        // the widget never inserts a control point.
        if (!this.dragPrepared) {
            if (!this.prepareDrag()) {
                this.dragging = false;
                return;
            }
            this.dragPrepared = true;
        }

        const delta = this.proxy.position.clone().sub(this.dragAnchor);

        // The delta, never the absolute position. The object sits at whatever the track
        // says AFTER smoothing and ground clamping, so its position is not the track's;
        // displacing the source by the same amount is what makes the object follow the
        // cursor.
        if (this.target.kind === "spline") {
            this.applySplineDrag(delta);
        } else {
            this.applyFixedDrag(delta);
        }
    }

    /** Resolve what this drag edits, creating a control point if the frame has none. */
    prepareDrag() {
        if (this.target.kind === "fixed") {
            const position = this.target.position;
            this.dragBaseECEF = position.getECEF();
            this.dragStartLLA = position.getLLA();
            return true;
        }

        const splineEditor = this.target.node.splineEditor;
        const frame = Math.round(par.frame);
        let index = splineEditor.frameNumbers.indexOf(frame);

        this.insertedFrame = null;

        // Up/down on a track with its altitude locked moves the lock, which carries the
        // whole track with it — so no control point is needed at this frame.
        this.lockDragStart = null;
        if (isAltitudeLockActive(this.target.node) && this.widget.activeDragMode === "vertical") {
            this.lockDragStart = this.target.node.altitudeLock;
            this.undoStateBefore = splineEditor.captureState();
            return true;
        }

        if (index < 0) {
            // Between control points: split the track here first, at the position the
            // track already has, so the drag that follows is an ordinary point move.
            splineEditor.insertPoint(frame, this.target.node.p(frame));
            index = splineEditor.frameNumbers.indexOf(frame);
            if (index < 0) return false;
            this.insertedFrame = frame;
        }

        this.dragIndex = index;
        this.dragStartPoint = splineEditor.positions[index].clone();
        // An insertion is undone by removing the point again (see recordUndo), not by
        // restoreState — that only writes into the points that already exist.
        this.undoStateBefore = this.insertedFrame === null ? splineEditor.captureState() : null;
        return true;
    }

    applySplineDrag(delta) {
        const node = this.target.node;
        const splineEditor = node.splineEditor;

        if (this.lockDragStart !== null) {
            node.setAltitudeLockFromDrag(this.lockDragStart + delta.dot(getLocalUpVector(this.dragAnchor)));
            if (splineEditor.onChange) splineEditor.onChange();
            return;
        }

        const index = this.dragIndex;
        if (index >= splineEditor.numPoints) return;

        // positions[i] IS splineHelperObjects[i].position, so the control cube moves too.
        splineEditor.positions[index].copy(this.dragStartPoint).add(delta);
        splineEditor.snapPointByIndex(index);
        // A locked track keeps the moved point at the lock height (no-op when unlocked).
        node.syncControlPointsToAltitudeLock();
        splineEditor.updatePointEditorGraphics();
        if (splineEditor.onChange) splineEditor.onChange();
    }

    applyFixedDrag(delta) {
        const position = this.target.position;
        const newBase = this.dragBaseECEF.clone().add(delta);
        const lla = ECEFToLLAVD_radii(newBase);

        if (this.node.groundMoveOnly) {
            position.setLLA(lla.x, lla.y, this.dragStartLLA[2]);
            this.syncToObject();
            return;
        }

        let altitude;
        if (this.widget?.activeDragMode === 'horizontal') {
            altitude = this.dragStartLLA[2];
        } else if (position.agl && ['lookCameraPlane', 'push', 'screenPlane'].includes(this.widget?.activeDragMode)) {
            // A constrained drag owns all three coordinates. Convert its destination
            // back to AGL using the same ground as the position node, so terrain
            // slopes do not bend the movement away from the frozen plane.
            const node = this.target.node;
            const terrain = NodeMan.get('TerrainModel', false);
            const ground = terrain && node._aglGroundPoint
                ? node._aglGroundPoint(terrain, LLAToECEF(lla.x, lla.y, 100000), 0, 0)
                : getPointBelow(newBase, true);
            altitude = lla.z - ECEFToLLAVD_radii(ground).z;
        } else if (position.agl) {
            // In AGL mode _LLA[2] is a height above the ground, not a datum altitude, so
            // only the part of the drag along local up may change it — sliding sideways
            // over a slope keeps the same clearance.
            altitude = this.dragStartLLA[2] + delta.dot(getLocalUpVector(this.dragBaseECEF));
        } else {
            // ECEFToLLAVD_radii gives HAE; _LLA[2] is MSL (h = H + N).
            altitude = lla.z - meanSeaLevelOffset(lla.x, lla.y);
        }

        position.setLLA(lla.x, lla.y, altitude);
    }

    rollbackDrag() {
        if (this.rotationStart !== undefined) {
            setObjectRotationY(this.node, this.rotationStart);
            this.rotationStart = undefined;
        }
        if (this.dragPrepared) {
            if (this.target.kind === "fixed") this.target.position.setLLA(...this.dragStartLLA);
            else {
                const editor = this.target.node.splineEditor;
                if (this.insertedFrame !== null) {
                    const index = editor.frameNumbers.indexOf(this.insertedFrame);
                    if (index >= 0) editor.removePointByIndex(index);
                } else if (this.undoStateBefore) {
                    if (this.lockDragStart !== null) this.target.node.setAltitudeLockFromDrag(this.lockDragStart);
                    editor.restoreState(this.undoStateBefore);
                }
            }
        }
        this.dragPrepared = false;
        this.endDrag();
        this.syncToObject();
    }

    endDrag() {
        if (!this.dragging) return;
        this.dragging = false;

        if (this.rotationStart !== undefined) {
            const before = this.rotationStart, after = this.node.common.rotateY, id = this.node.id;
            this.rotationStart = undefined;
            if (after !== before) UndoManager.add({description: "Rotate " + (this.node.displayName ?? id),
                undo: () => setObjectRotationY(NodeMan.get(id), before),
                redo: () => setObjectRotationY(NodeMan.get(id), after)});
        } else if (this.dragPrepared && UndoManager) {
            this.recordUndo();
        }
        this.dragPrepared = false;
        this.undoStateBefore = null;
        this.insertedFrame = null;
        this.lockDragStart = null;
    }

    recordUndo() {
        if (this.target.kind === "fixed") {
            const {position, node} = this.target;
            const before = this.dragStartLLA.slice();
            const after = position.getLLA();
            if (before.every((value, i) => value === after[i])) return;
            UndoManager.add({
                description: "Move " + (this.node?.id ?? node.id),
                undo: () => position.setLLA(...before),
                redo: () => position.setLLA(...after),
            });
            return;
        }

        const splineEditor = this.target.node.splineEditor;
        const description = "Move " + (this.node?.id ?? this.target.node.id);

        if (this.insertedFrame !== null) {
            // This drag CREATED the control point, so undo has to remove it — leaving
            // it behind and only restoring positions would make Ctrl-Z appear to work
            // while the track kept the new point. Located by frame rather than by the
            // index captured here, so an unrelated edit in between cannot make undo
            // delete the wrong point.
            const frame = this.insertedFrame;
            const position = splineEditor.positions[this.dragIndex]?.clone();
            if (!position) return;
            UndoManager.add({
                description,
                undo: () => {
                    const index = splineEditor.frameNumbers.indexOf(frame);
                    if (index >= 0) splineEditor.removePointByIndex(index);
                },
                // insertPoint REPLACES a point at the same frame, so this is safe to
                // repeat and cannot stack duplicates.
                redo: () => splineEditor.insertPoint(frame, position.clone()),
            });
            return;
        }

        if (!this.undoStateBefore) return;
        const before = this.undoStateBefore;
        const after = splineEditor.captureState();
        const node = this.target.node;
        const lockBefore = this.lockDragStart;
        const lockAfter = node.altitudeLock;
        const lockMoved = lockBefore !== null && lockBefore !== lockAfter;
        if (!lockMoved && JSON.stringify(before) === JSON.stringify(after)) return;
        UndoManager.add({
            description,
            undo: () => {
                if (lockMoved) node.setAltitudeLockFromDrag(lockBefore);
                splineEditor.restoreState(before);
            },
            redo: () => {
                if (lockMoved) node.setAltitudeLockFromDrag(lockAfter);
                splineEditor.restoreState(after);
            },
        });
    }
}

export const ObjectMoveWidget = new CObjectMoveWidget();

// The same widget serves every view. Hide it only during this draw, so a view
// which cannot see the object does not disable picking in the other views.
export function withObjectMoveWidgetVisible(view, render) {
    const widget = ObjectMoveWidget;
    if (!widget.node || widget.isObjectShownInView(widget.node, view)) return render();
    const hidden = [widget.widget?.getHelper(), widget.dropLine].filter(group => group?.visible);
    for (const group of hidden) group.visible = false;
    try {
        return render();
    } finally {
        for (const group of hidden) group.visible = true;
    }
}

/** Per-view render-loop hook. See CObjectMoveWidget.update(). */
export function updateObjectMoveWidget(view) {
    ObjectMoveWidget.update(view);
}
