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
//   - anything else (ADS-B, KML, MISB, satellites): read-only data, so no widget at all
//
// The widget itself is the same PointEditorWidget the spline editor puts on its control
// points: a green horizontal disc and red up/down arrows. It stays hidden until the
// cursor comes near the object, then crossfades in while the object fades to 25% so the
// widget inside it is visible and grabbable. While faded the object is also skipped by
// the right-click picker — it is the thing being edited, so a click belongs to the
// ground behind it.
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

import {BufferGeometry, Float32BufferAttribute, Line, LineBasicMaterial, Object3D, Vector3} from "three";
import {PointEditorWidget} from "./PointEditorWidget";
import {CNode3DObject} from "./nodes/CNode3DObject";
import {GlobalScene} from "./LocalFrame";
import {CustomManager, mainLoopCount, NodeMan, setRenderOne} from "./Globals";
import {par} from "./par";
import {ViewMan} from "./CViewManager";
import {mouseInViewOnly, mouseToViewNormalized} from "./ViewUtils";
import {findRootTrack} from "./FindRootTrack";
import {ECEFToLLAVD_radii} from "./LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import {getLocalUpVector} from "./SphericalMath";
import {getPointBelow} from "./threeExt";
import {undoManager as UndoManager} from "./UndoManager";

// How close the cursor has to get, in screen pixels, before the widget appears. The
// widget's own disc is 40px and its arrows 30px, so this is a little wider than the
// thing it reveals. Big objects extend it to their own projected size (capped, so a
// model that fills the view does not make the whole viewport a hot zone).
const HOVER_RADIUS_PX = 70;
const HOVER_RADIUS_MAX_PX = 300;

// Crossfade time each way, and how far down the object's opacity goes.
const FADE_MS = 150;
const FADED_OPACITY = 0.25;

// The widget's handle materials are authored at this opacity; the fade scales it.
const WIDGET_OPACITY = 0.6;

// Reused by the Option/Alt search, which projects every movable object every frame.
const scratchNDC = new Vector3();

/**
 * What, if anything, a drag on this object should write to.
 * @returns {{kind: "spline"|"fixed", node: CNode}|null} null when the object rides a
 *          data track (ADS-B, KML, satellite...) that the user cannot hand-edit.
 */
function resolveMoveTarget(objectNode) {
    const root = findRootTrack(objectNode);
    if (!root) return null;

    // A hand-drawn spline: control points at frames, interpolated between.
    if (root.splineEditor) {
        return {kind: "spline", node: root};
    }

    // A fixed lat/lon/alt. Recognised by behaviour rather than by class so the
    // camera's and target's position nodes, and any future kin, all qualify.
    if (typeof root.setLLA === "function" && root._LLA !== undefined && root.ecef !== undefined) {
        return {kind: "fixed", node: root};
    }

    return null;
}

class CObjectMoveWidget {
    constructor() {
        this.widget = null;         // PointEditorWidget, built on first use
        this.proxy = new Object3D();// what the widget actually moves; never in the scene
        this.node = null;           // the CNode3DObject being edited, if movable
        this.target = null;         // resolveMoveTarget() for that object

        this.fade = 0;              // 0 = solid object, no widget; 1 = faded, widget up
        this.hover = false;
        this.dragging = false;
        this.dragPrepared = false;
        this.dragAnchor = new Vector3();

        this.savedMaterials = null; // Map material -> {opacity, transparent, depthWrite}
        this.savedIgnorePick = undefined;

        this.altHeld = false;       // Option/Alt: pick up whatever is under the cursor
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
            this.setAltHeld(event.altKey);
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
        const readAlt = (event) => this.setAltHeld(event.altKey);
        document.addEventListener("keydown", readAlt);
        document.addEventListener("keyup", readAlt);
        // Alt+Tab and friends take the key away with no keyup, which would leave the
        // mode stuck on when focus came back.
        window.addEventListener("blur", () => this.setAltHeld(false));
    }

    setAltHeld(held) {
        if (held === this.altHeld) return;
        this.altHeld = held;
        setRenderOne(true);
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
    }

    updateFrame() {
        // Never re-pick mid-drag: releasing Alt, or dragging the object out from under
        // the cursor, must not hand the widget to a different object half way through.
        if (!this.dragging) {
            this.setNode(this.findEditableObject());
        }

        if (!this.node) {
            this.suppressCamera(false);
            this.updateDropLine();      // hides it
            this.updateEditFocus();     // releases focus back to whatever it was
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
                if (entry.data instanceof CNode3DObject) this._objects.push(entry.data);
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
            const position = node.group.position;
            if (!Number.isFinite(position.x)) continue;

            // Cheapest tests first — the target walk is the expensive one.
            const distance = this.cursorDistancePx(view, position);
            if (distance >= bestDistance) continue;
            if (distance > this.hoverRadiusPx(view, position, node)) continue;

            const target = this.movableTarget(node);
            if (!target) continue;

            best = {node, target};
            bestDistance = distance;
        }

        return best;
    }

    /** The editing-capable view the cursor is over, mainView first. */
    viewUnderCursor() {
        for (const id of ["mainView", "lookView"]) {
            const view = ViewMan.get(id, false);
            if (view && view.camera && mouseInViewOnly(view, this.pointerX, this.pointerY)) {
                return view;
            }
        }
        return null;
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
        if (!view) {
            this.hover = false;
            return;
        }

        const position = this.node.group.position;
        this.hover = this.cursorDistancePx(view, position)
            < this.hoverRadiusPx(view, position, this.node);
    }

    /**
     * Screen-pixel distance from the cursor to a world point in this view.
     *
     * Deliberately uses view.camera as-is, matching PointEditorWidget's own hit test,
     * rather than the LOD-prepared display camera — the two have to agree about where
     * the widget is or the reveal and the grab would disagree at the edges.
     */
    cursorDistancePx(view, position) {
        const ndc = scratchNDC.copy(position).project(view.camera);
        if (ndc.z > 1) return Infinity;     // behind the camera

        const [mouseNdcX, mouseNdcY] = mouseToViewNormalized(view, this.pointerX, this.pointerY);
        const dx = (ndc.x - mouseNdcX) * view.widthPx / 2;
        const dy = (ndc.y - mouseNdcY) * view.heightPx / 2;
        return Math.hypot(dx, dy);
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
        const amount = this.fade;

        if (amount > 0 && !this.savedMaterials) {
            this.savedMaterials = this.captureMaterials();
        }

        if (this.savedMaterials) {
            const scale = 1 - (1 - FADED_OPACITY) * amount;
            const wantTransparent = amount > 0;
            for (const [material, original] of this.savedMaterials) {
                material.opacity = original.opacity * scale;
                // A ShaderMaterial ignores material.opacity — it has no built-in
                // opacity uniform — so the object's own shader has to be told. The
                // gradient material declares one; anything without it is left alone.
                // Scaled from the uniform's OWN captured value, not from
                // material.opacity, so the restore at scale 1 is exact even where the
                // two disagree (a gradient material can carry an unused .opacity).
                if (original.uniformOpacity !== undefined) {
                    material.uniforms.opacity.value = original.uniformOpacity * scale;
                }
                const transparent = wantTransparent || original.transparent;
                if (material.transparent !== transparent) {
                    material.transparent = transparent;
                    // .transparent is part of the shader program key, so three.js only
                    // picks it up on a recompile. Guarded, so this is not paid per frame.
                    material.needsUpdate = true;
                }
                // A faded object that still wrote depth would hide the widget sitting
                // inside it, which is the whole point of fading it.
                material.depthWrite = wantTransparent ? false : original.depthWrite;
            }
            if (amount === 0) {
                // Released rather than kept, so a model reloaded or a geometry rebuilt
                // while not hovering is re-captured fresh next time.
                this.savedMaterials = null;
            }
        }

        this.setPickIgnored(amount > 0);
        this.setWidgetOpacity(amount);
    }

    captureMaterials() {
        const saved = new Map();
        this.node.group.traverse((child) => {
            const materials = child.material;
            if (!materials) return;
            for (const material of Array.isArray(materials) ? materials : [materials]) {
                if (saved.has(material)) continue;
                saved.set(material, {
                    opacity: material.opacity,
                    uniformOpacity: material.uniforms?.opacity?.value,
                    transparent: material.transparent,
                    depthWrite: material.depthWrite,
                });
            }
        });
        return saved;
    }

    /**
     * Take the object out of the right-click picker while it is faded. The picker walks
     * up parents looking for this flag (CNodeView3DMouse.shouldIgnoreContextMenu), so
     * setting it on the group covers the whole object.
     */
    setPickIgnored(ignored) {
        const userData = this.node.group.userData;
        if (ignored) {
            if (this.savedIgnorePick === undefined) {
                this.savedIgnorePick = userData.ignoreContextMenu ?? false;
            }
            userData.ignoreContextMenu = true;
        } else if (this.savedIgnorePick !== undefined) {
            userData.ignoreContextMenu = this.savedIgnorePick;
            this.savedIgnorePick = undefined;
        }
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

            // Above the faded object, which no longer writes depth but still draws.
            const helper = this.widget.getHelper();
            helper.renderOrder = 999;

            this.widget.addEventListener("change", () => setRenderOne());
            this.widget.addEventListener("objectChange", () => this.onWidgetMoved());
            this.widget.addEventListener("dragging-changed", (event) => this.onDraggingChanged(event));
        }

        // Re-added rather than added once: a sitch load rebuilds the scene, and this
        // widget outlives it.
        const helper = this.widget.getHelper();
        if (helper.parent !== GlobalScene) {
            GlobalScene.add(helper);
        }
    }

    // "Focus While Editing": point every 3D view's camera at the object being edited.
    //
    // This reuses the view's existing focus-track machinery rather than moving cameras
    // directly — CNodeView3D already does `controls.target = node.p(frame)` plus a lookAt
    // every frame for whatever focusTrackName names, and a CNode3DObject answers p() like
    // any track. So focusing is one assignment, and it inherits the orbit behaviour and
    // the frame-by-frame follow for free.
    //
    // SUSPENDED WHILE DRAGGING. Focus pins the orbit centre to the object, so dragging
    // under it means the camera swings to chase the thing your pointer is moving — the
    // view fights the gesture. Released on drag start and restored on drop, which is also
    // when you most want to see where it ended up.
    updateEditFocus() {
        const node = this.node;
        const wanted = (node && node.focusWhileEditing && !this.dragging && !this.altMode)
            ? node.id : null;

        if (wanted === this.focusedNodeId) return;
        this.focusedNodeId = wanted;

        // Every view that has a focus track — i.e. the 3D ones. Tested by the property
        // rather than by class so it needs no import and cannot miss a subclass.
        ViewMan.iterate((id, view) => {
            if (view?.focusTrackName === undefined) return;
            if (wanted) {
                // Remember what the view was focused on, once, so releasing focus puts
                // back the user's own choice rather than "default".
                if (view._focusBeforeEdit === undefined) {
                    view._focusBeforeEdit = view.focusTrackName;
                }
                view.focusTrackName = wanted;
            } else if (view._focusBeforeEdit !== undefined) {
                view.focusTrackName = view._focusBeforeEdit;
                view._focusBeforeEdit = undefined;
            }
        });
        setRenderOne(true);
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
            this.dropLine = new Line(geometry, new LineBasicMaterial({
                color: 0x808080,        // 50% grey
                // WebGL ignores widths above 1 on almost every platform, so 1 is both the
                // request and the only value that would have been honoured anyway.
                linewidth: 1,
                depthTest: true,
                toneMapped: false,
            }));
            this.dropLine.renderOrder = 998;   // under the widget handles (999)
        }

        // Re-added rather than added once, for the same reason as the widget helper: a
        // sitch load rebuilds the scene while this object outlives it.
        if (this.dropLine.parent !== GlobalScene) GlobalScene.add(this.dropLine);

        // The line is drawn in the object's own local space so the two ends stay in
        // float32 range — ECEF coordinates are ~6,378 km from the origin, and a geometry
        // holding them directly would visibly jitter.
        this.dropLine.position.copy(top);
        const positions = this.dropLine.geometry.getAttribute("position");
        positions.setXYZ(0, 0, 0, 0);
        positions.setXYZ(1, ground.x - top.x, ground.y - top.y, ground.z - top.z);
        positions.needsUpdate = true;
        this.dropLine.geometry.computeBoundingSphere();
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

        if (suppress) {
            this.savedControlsEnabled = new Map();
            ViewMan.iterate((id, view) => {
                if (!view || !view.controls) return;
                this.savedControlsEnabled.set(view.controls, view.controls.enabled);
                view.controls.enabled = false;
            });
            return;
        }

        for (const [controls, enabled] of this.savedControlsEnabled ?? []) {
            controls.enabled = enabled;
        }
        this.savedControlsEnabled = null;
    }

    /** Follow the object, which the controllers re-place every frame. */
    syncToObject() {
        if (!this.node) return;
        this.proxy.position.copy(this.node.group.position);
        if (this.widget && this.widget.object) {
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
        } else {
            this.endDrag();
        }

        // Applied here as well as in updateFrame so it lands at pointerdown, BEFORE the
        // next pointermove — a frame's delay is enough for the view that captured the
        // press to orbit once. Leaving a drag while Alt is still held keeps it on.
        this.suppressCamera(this.dragging || this.altMode);
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
            const positionNode = this.target.node;
            this.dragBaseECEF = positionNode.ecef.clone();
            this.dragStartLLA = positionNode._LLA.slice();
            return true;
        }

        const splineEditor = this.target.node.splineEditor;
        const frame = Math.round(par.frame);
        let index = splineEditor.frameNumbers.indexOf(frame);

        this.insertedFrame = null;
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
        const splineEditor = this.target.node.splineEditor;
        const index = this.dragIndex;
        if (index >= splineEditor.numPoints) return;

        // positions[i] IS splineHelperObjects[i].position, so the control cube moves too.
        splineEditor.positions[index].copy(this.dragStartPoint).add(delta);
        splineEditor.snapPointByIndex(index);
        splineEditor.updatePointEditorGraphics();
        if (splineEditor.onChange) splineEditor.onChange();
    }

    applyFixedDrag(delta) {
        const positionNode = this.target.node;
        const newBase = this.dragBaseECEF.clone().add(delta);
        const lla = ECEFToLLAVD_radii(newBase);

        let altitude;
        if (positionNode.agl) {
            // In AGL mode _LLA[2] is a height above the ground, not a datum altitude, so
            // only the part of the drag along local up may change it — sliding sideways
            // over a slope keeps the same clearance.
            altitude = this.dragStartLLA[2] + delta.dot(getLocalUpVector(this.dragBaseECEF));
        } else {
            // ECEFToLLAVD_radii gives HAE; _LLA[2] is MSL (h = H + N).
            altitude = lla.z - meanSeaLevelOffset(lla.x, lla.y);
        }

        positionNode.setLLA(lla.x, lla.y, altitude);
    }

    endDrag() {
        if (!this.dragging) return;
        this.dragging = false;

        if (this.dragPrepared && UndoManager) {
            this.recordUndo();
        }
        this.dragPrepared = false;
        this.undoStateBefore = null;
        this.insertedFrame = null;
    }

    recordUndo() {
        if (this.target.kind === "fixed") {
            const positionNode = this.target.node;
            const before = this.dragStartLLA.slice();
            const after = positionNode._LLA.slice();
            if (before.every((value, i) => value === after[i])) return;
            UndoManager.add({
                description: "Move " + (this.node?.id ?? positionNode.id),
                undo: () => positionNode.setLLA(before[0], before[1], before[2]),
                redo: () => positionNode.setLLA(after[0], after[1], after[2]),
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
        if (JSON.stringify(before) === JSON.stringify(after)) return;
        UndoManager.add({
            description,
            undo: () => splineEditor.restoreState(before),
            redo: () => splineEditor.restoreState(after),
        });
    }
}

export const ObjectMoveWidget = new CObjectMoveWidget();

/** Per-view render-loop hook. See CObjectMoveWidget.update(). */
export function updateObjectMoveWidget(view) {
    ObjectMoveWidget.update(view);
}
