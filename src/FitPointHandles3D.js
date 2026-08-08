// The 3D half of "Fit Camera to Points": a ground point you drag with a flat 2D handle.
//
// The thing being edited is a position ON THE GROUND — a headland, a building corner, the end of
// a runway. That is a two-dimensional choice: the analyst is not thinking "east a bit, up a bit",
// they are thinking "there, that spot". So the widget is presented the way the choice is made —
// the same circle-and-crosshair used on the video, dragged in screen space — and the third
// dimension is supplied by the terrain rather than by the user.
//
// Dragging casts a ray from THAT view's camera through the cursor and takes where it meets the
// ground. Which means the same control point sits at different screen positions in the main view
// and the look view, and dragging it in one moves it in the other. That is not a quirk to hide;
// it is the point. Each view is a different question about the same place, and being able to say
// "that spot" from whichever view shows it most clearly is the whole value.
//
// This replaced a disc-and-arrows gizmo (the one the track editor uses). That widget is right for
// a target in mid-air, which has a genuine vertical degree of freedom to set. A landmark does
// not: it is on the ground, and offering a vertical handle for it only invites putting it
// underground.

import {Vector3} from "three";
import {CNodeViewUI} from "./nodes/CNodeViewUI";
import {setRenderOne} from "./Globals";
import {ViewMan} from "./CViewManager";
import {mouseToCanvas} from "./ViewUtils";
import {raycastGroundElevationFast} from "./raycastGround";
import {drawFitHandle, GRAB_RADIUS} from "./FitHandleDraw";

/** The 3D views a handle is offered in. */
const HANDLE_VIEWS = ["mainView", "lookView"];

/** How far a drag ray will look for ground before giving up. */
const MAX_GROUND_RANGE = 400000;

/**
 * Put a view's camera into the projection actually on screen, run `fn`, and put it back.
 *
 * Load-bearing for the look view, which renders a wider frustum to an offscreen target and shows
 * a magnified crop of it — so the live camera projection is roughly twice as wide as what the
 * user sees. prepareCameraForLOD() applies the full displayed transform (video zoom, FOV
 * coverage, pan, y-compression, display-only lookAt, camera-tweak offsets); it exists for terrain
 * LOD, and it is exactly what makes a handle land on the pixel its ground point appears at.
 * Without it the handle would be drawn in one place and pick from another.
 */
function withDisplayedCamera(view, fn) {
    const lodActive = view._lodSavedZoom !== undefined;
    if (!lodActive) view.prepareCameraForLOD();
    view.camera.updateMatrixWorld();
    try {
        return fn(view.camera);
    } finally {
        if (!lodActive) view.restoreCameraAfterLOD();
    }
}

/**
 * The sub-rectangle of the overlay's pixel space that the host view's 3D canvas actually fills,
 * as {x, y, w, h}.
 *
 * Normally the whole thing — but not always, and the exception is invisible until it bites. With
 * "Match Video Aspect" on, CNodeView3D letterboxes by resizing and centring the 3D CANVAS ELEMENT
 * inside its div (canvas.style.width/height/left/top) rather than by using a viewport inside a
 * full-size canvas. The overlay this class draws on is a SEPARATE canvas that still covers the
 * whole div. Measured on a 572x435 div: the 3D canvas was 572x321 at a 57 px vertical inset.
 *
 * Mapping NDC across the overlay's full height, as this used to, therefore spread the handles
 * over 435 px of a scene drawn into 321 of them — correct at the centre, wrong everywhere else,
 * and wrong by a different amount whenever the letterbox changed. Going through the real rect
 * covers letterbox, pillarbox and neither, without this code having to know which is in play.
 */
function renderedRect(view, w, h) {
    const canvas = view.canvas, div = view.div;
    const whole = {x: 0, y: 0, w, h};
    if (!canvas || !div) return whole;
    const rc = canvas.getBoundingClientRect();
    const rd = div.getBoundingClientRect();
    if (!(rd.width > 0) || !(rd.height > 0) || !(rc.width > 0) || !(rc.height > 0)) return whole;
    return {
        x: ((rc.left - rd.left) / rd.width) * w,
        y: ((rc.top - rd.top) / rd.height) * h,
        w: (rc.width / rd.width) * w,
        h: (rc.height / rd.height) * h,
    };
}

/** World position -> canvas pixels for a view, or null when it is not in front of the camera. */
export function projectToCanvas(view, world) {
    if (!view || !view.camera || !(view.widthPx > 0)) return null;
    return withDisplayedCamera(view, (cam) => {
        const fwd = new Vector3();
        cam.getWorldDirection(fwd);
        if (world.clone().sub(cam.position).dot(fwd) <= 0) return null;   // behind the camera
        const ndc = world.clone().project(cam);
        if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y)) return null;
        const r = renderedRect(view, view.widthPx, view.heightPx);
        return [r.x + (ndc.x + 1) * 0.5 * r.w, r.y + (1 - ndc.y) * 0.5 * r.h];
    });
}

/** Canvas pixels -> the ground point under them, or null if the ray never reaches ground. */
export function groundUnderCanvasPoint(view, cx, cy) {
    if (!view || !view.camera || !(view.widthPx > 0)) return null;
    const r = renderedRect(view, view.widthPx, view.heightPx);
    if (!(r.w > 0) || !(r.h > 0)) return null;
    const ray = withDisplayedCamera(view, (cam) => {
        const ndcX = ((cx - r.x) / r.w) * 2 - 1;
        const ndcY = -(((cy - r.y) / r.h) * 2 - 1);
        const origin = new Vector3().setFromMatrixPosition(cam.matrixWorld);
        const dir = new Vector3(ndcX, ndcY, 0.5).unproject(cam).sub(origin).normalize();
        return {origin, dir};
    });
    if (!ray || !Number.isFinite(ray.dir.x)) return null;
    return raycastGroundElevationFast(ray.origin, ray.dir, MAX_GROUND_RANGE);
}

/**
 * One overlay per 3D view: draws that view's handles and owns dragging in it.
 */
class CFitHandleOverlay extends CNodeViewUI {
    constructor(v) {
        super(v);
        this.owner = v.owner;
        this.hostId = v.overlayView;
        this.doubleClickResizes = false;
        this.doubleClickFullScreen = false;
        this.draggingId = null;
        this.visible = false;
    }

    get host() {
        return ViewMan.get(this.hostId, false);
    }

    /** Canvas position of every point in this view, as [{id, color, index, cx, cy}]. */
    projected() {
        const host = this.host;
        const out = [];
        if (!host) return out;
        const points = this.owner.getPoints();
        for (let i = 0; i < points.length; i++) {
            const p = projectToCanvas(host, points[i].position);
            if (p === null) continue;
            out.push({id: points[i].id, color: points[i].color, index: i, cx: p[0], cy: p[1]});
        }
        return out;
    }

    renderCanvas(frame) {
        super.renderCanvas(frame);
        if (!this.owner.enabled || !this.ctx) return;
        for (const h of this.projected()) {
            drawFitHandle(this.ctx, h.cx, h.cy, h.color, String(h.index + 1));
        }
    }

    onMouseDown(e, mouseX, mouseY) {
        this.draggingId = null;
        if (!this.owner.enabled || e.button !== 0) return false;
        if (!this.owner.onCorrectFrame()) return false;

        const [cx, cy] = mouseToCanvas(this, mouseX, mouseY);
        let hit = null;
        for (const h of this.projected()) {
            if (Math.hypot(cx - h.cx, cy - h.cy) <= GRAB_RADIUS) hit = h;   // last = topmost
        }
        if (!hit) return false;

        this.draggingId = hit.id;
        this.owner.beginUndo();
        // The 3D view orbits from its own canvas listeners, independent of this overlay, so the
        // only way to stop the camera swinging under the drag is to switch its controls off.
        this.setControlsEnabled(false);
        return true;
    }

    onMouseDrag(e, mouseX, mouseY) {
        if (this.draggingId === null) return;
        const [cx, cy] = mouseToCanvas(this, mouseX, mouseY);
        const ground = groundUnderCanvasPoint(this.host, cx, cy);
        // No ground under the cursor (dragged into the sky, or past the horizon): leave the point
        // where it is rather than inventing a position at some arbitrary range.
        if (!ground) return;
        this.owner.setPointPosition(this.draggingId, ground);
        setRenderOne(true);
    }

    onMouseUp() {
        if (this.draggingId === null) return;
        const id = this.draggingId;
        this.draggingId = null;
        this.setControlsEnabled(true);

        // Commit BEFORE closing the undo span, so the entry captures the refitted camera as well
        // as the moved point — the two are one edit, and undoing either alone is incoherent.
        this.owner.commitPointMove(id);
        this.owner.endUndo("Move camera fit point");
    }

    /** Gate EVERY 3D view's controls, not just this one — a drag must not orbit the other. */
    setControlsEnabled(enabled) {
        for (const id of HANDLE_VIEWS) {
            const v = ViewMan.get(id, false);
            if (v && v.controls) v.controls.enabled = enabled;
        }
    }

    /** True while this overlay owns a drag, so the host view knows not to also act on it. */
    get isDragging() {
        return this.draggingId !== null;
    }
}

/**
 * Owns one handle overlay per 3D view.
 *
 * @param {object}   v
 * @param {Function} v.getPoints     () => [{id, color, position: Vector3}]
 * @param {Function} v.onMoved       (id, Vector3) => void, continuously during a drag
 * @param {Function} v.onCommit      (id) => void, once on release
 * @param {Function} v.onCorrectFrame () => boolean
 * @param {Function} v.onBeginEdit   () => void, opens an undo span at the start of a drag
 * @param {Function} v.onEndEdit     (description) => void, closes it on release
 */
export class FitPointHandles3D {
    constructor(v) {
        this.getPoints = v.getPoints;
        this.onMoved = v.onMoved ?? (() => {});
        this.onCommit = v.onCommit ?? (() => {});
        this.onCorrectFrame = v.onCorrectFrame ?? (() => true);
        this.onBeginEdit = v.onBeginEdit ?? (() => {});
        this.onEndEdit = v.onEndEdit ?? (() => {});
        this.enabled = false;
        this.overlays = [];
    }

    setEnabled(on) {
        this.enabled = on;
        // Built on first use rather than up front: a sitch that never opens this feature should
        // not carry two extra views around for the whole session.
        if (on && this.overlays.length === 0) this.build();
        for (const o of this.overlays) {
            o.visible = on;
            if (!on) o.draggingId = null;
        }
        setRenderOne(true);
    }

    build() {
        for (const hostId of HANDLE_VIEWS) {
            if (!ViewMan.exists(hostId)) continue;
            this.overlays.push(new CFitHandleOverlay({
                id: "fitHandles_" + hostId,
                overlayView: hostId,
                owner: this,
            }));
        }
    }

    setPointPosition(id, position) {
        this.onMoved(id, position.clone());
    }

    commitPointMove(id) {
        this.onCommit(id);
    }

    // Undo spans belong to the owning node — it is what holds the points AND knows how to
    // snapshot the camera the fit derives from them. These just forward.
    beginUndo() {
        this.onBeginEdit();
    }

    endUndo(description) {
        this.onEndEdit(description);
    }

    /** True while any view is dragging a handle. */
    get isDragging() {
        return this.overlays.some((o) => o.isDragging);
    }

    dispose() {
        for (const o of this.overlays) o.dispose?.();
        this.overlays = [];
    }
}
