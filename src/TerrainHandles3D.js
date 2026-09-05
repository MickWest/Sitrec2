import {acquireControlLease, getInteractionRouter} from "./InteractionRouter";
import {editingControls} from "./EditorInteraction";
// Dragging a point across the terrain from a 3D view: the machinery two editors share.
//
// "Fit Camera to Points" and "Ground Track" are asking different questions — where is the camera,
// versus where did the object cross the ground — but they place their points the same way, and
// deliberately so. Both are choosing a SPOT, which is a two-dimensional choice: the analyst is not
// thinking "east a bit, up a bit", they are thinking "there, that one". So both present the widget
// the way the choice is made — a flat circle-and-crosshair, dragged in screen space — and let the
// terrain supply the third dimension. (This replaced a disc-and-arrows gizmo, the one the track
// editor still uses. That widget is right for a target in mid-air, which has a real vertical
// degree of freedom to set. A point on the ground does not: offering it a vertical handle only
// invites putting it underground.)
//
// Both also work the same way across views. A point sits at different screen positions in the main
// view and the look view, and dragging it in one moves it in the other. That is not a quirk to
// hide; it is the point. Each view is a different question about the same place, and in practice
// the look view is where a point is PLACED — it is the camera's own view, the one the object
// appears in — while the main view is where it is checked against the map and nudged.
//
// What is shared, therefore: projecting world points into a view, hit-testing them, casting the
// cursor back onto the terrain, borrowing the camera controls for the duration of a drag, and the
// overlay lifecycle. What is NOT shared is policy — which gestures mean what, what gets drawn
// besides the handles, and whether a point may be edited at this frame at all. Those are the
// subclass's, and they are where the two editors genuinely differ.

import {CNodeViewUI} from "./nodes/CNodeViewUI";
import {NodeMan, setRenderOne} from "./Globals";
import {ViewMan} from "./CViewManager";
import {mouseToCanvas} from "./ViewUtils";
import {groundUnderCanvasPoint, projectToCanvas} from "./FitSurfacePick";
import {GRAB_RADIUS} from "./FitHandleDraw";

/** The 3D views a handle is offered in. */
export const HANDLE_VIEWS = ["mainView", "lookView"];

/**
 * One overlay per 3D view: draws that view's handles and owns dragging in it.
 *
 * The `owner` is whatever object holds the points. It must answer `getUseTiles()` and
 * `getUseObjects()` (how the cursor is cast onto the world) and expose `enabled`.
 */
export class CTerrainHandleOverlay extends CNodeViewUI {
    constructor(v) {
        super(v);
        this.owner = v.owner;
        this.hostId = v.overlayView;
        this.doubleClickResizes = false;
        this.doubleClickFullScreen = false;
        this.draggingId = null;
        this._controlsWere = null;
        this.visible = false;
        // Required for `visible = false` to actually hide anything. ViewMan.updateDOMVisibility
        // only touches an overlay's canvas when the overlay declares separate visibility;
        // everything else is left to the PARENT div's display, and this overlay's parent is the
        // main or look view, which stays up. So without this, switching the editor off dropped
        // the overlay out of the render loop — _computeEV went false — while its canvas stayed
        // on screen holding the last handles it drew, frozen there because the view that would
        // have cleared them was no longer being rendered.
        this.separateVisibility = true;
    }

    get host() {
        return ViewMan.get(this.hostId, false);
    }

    // ---------- projection and picking ----------

    /**
     * Canvas positions of a list of `{position, ...}` points in this view.
     *
     * Each result carries the original point's own fields plus `index`, `cx` and `cy`. Points
     * that do not project — behind the camera, or off the world — are dropped rather than
     * clamped, so nothing is drawn at a position it is not actually at.
     */
    projectPoints(points) {
        const host = this.host;
        const out = [];
        if (!host) return out;
        // The handles are drawn on an overlay and so are never hidden by the terrain, which is
        // deliberate: a point you are trying to place is exactly the thing you still need to see
        // when a ridge is in the way. A subclass can still declare something that legitimately
        // occludes them.
        const hidden = this.occlusionTest();
        for (let i = 0; i < points.length; i++) {
            if (hidden && hidden(points[i].position)) continue;
            const p = projectToCanvas(host, points[i].position);
            if (p === null) continue;
            out.push({...points[i], index: i, cx: p[0], cy: p[1]});
        }
        return out;
    }

    /**
     * Subclass hook: `(worldPosition) => boolean` for points this view must not show, or null.
     * Recomputed once per projection pass, so an implementation can hoist its own setup.
     */
    occlusionTest() {
        return null;
    }

    /** The topmost projected handle within grabbing distance of a canvas position, or null. */
    pick(cx, cy, handles) {
        let hit = null;
        for (const h of handles) {
            if (Math.hypot(cx - h.cx, cy - h.cy) <= GRAB_RADIUS) hit = h;   // last = topmost
        }
        return hit;
    }

    /** Where the world is under a canvas position, on the owner's placement terms, or null. */
    groundUnder(cx, cy) {
        return groundUnderCanvasPoint(this.host, cx, cy,
                                      this.owner.getUseTiles(), this.owner.getUseObjects());
    }

    // ---------- dragging ----------

    /** Start dragging the point `id`, taking the camera controls until the button comes up. */
    beginDrag(id) {
        this.draggingId = id;
        this.grabControls();
    }

    onMouseDrag(e, mouseX, mouseY) {
        if (this.draggingId === null) return;
        const [cx, cy] = mouseToCanvas(this, mouseX, mouseY);
        const ground = this.groundUnder(cx, cy);
        // No surface under the cursor (dragged into the sky, or past the horizon): leave the
        // point where it is rather than inventing a position at some arbitrary range.
        if (!ground) return;
        this.movePoint(this.draggingId, ground);
        setRenderOne(true);
    }

    onMouseUp() {
        // Unconditional, and safe: releaseControls is a no-op when nothing was grabbed, which is
        // the case for a gesture that claimed the press without starting a drag.
        this.releaseControls();
        if (this.draggingId === null) return;
        const id = this.draggingId;
        this.draggingId = null;
        this.endDrag(id);
    }

    /** Subclass: put point `id` at this world position. Called continuously during a drag. */
    movePoint(id, position) {}

    /** Subclass: the drag of point `id` is over. Called once, on release. */
    endDrag(id) {}

    // ---------- the camera controls ----------

    /**
     * Take EVERY 3D view's camera controls for the duration of a drag — not just this one, since
     * a drag must not orbit the other view either.
     *
     * Needed at all because the 3D views orbit from their own canvas listeners, independent of
     * this overlay: switching the controls off is the only way to stop the camera swinging under
     * the drag. Doing it here, after the canvas handler has already run, is still in time —
     * CameraControls.handleMouseMove returns early and resets its state when disabled.
     */
    grabControls() {
        this.releaseControls();
        this.releaseLease = acquireControlLease(editingControls());
    }

    releaseControls() {
        this.releaseLease?.();
        this.releaseLease = null;
    }

    isInteractionEnabled() { return this.owner.enabled; }

    getInteractionIntent(e, mouseX, mouseY) {
        if (!this.owner.enabled || e.button !== 0) return null;
        const [cx, cy] = mouseToCanvas(this, mouseX, mouseY);
        const hit = this.pick(cx, cy, this.projected());
        return hit ? {kind: "drag", priority: 70, handleId: hit.id ?? hit.frame} : null;
    }

    handleState(id) {
        return this.draggingId === id ? "dragging" : this.interactionHover === id ? "hover" : "idle";
    }

    onMouseRollback() {
        this.releaseControls();
        this.draggingId = null;
        this.owner.onRollbackEdit?.();
        setRenderOne(true);
    }

    dispose() {
        getInteractionRouter()?.cancelOwner(this);
        this.onMouseUp();
        super.dispose();
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
 * @param {object}   [v.owner]       passed through to each overlay; defaults to this manager,
 *                                   which is right when the manager itself holds the callbacks
 * @param {Function} v.overlayClass  the CTerrainHandleOverlay subclass to build
 * @param {string}   v.idPrefix      overlay node ids are `<idPrefix>_<viewId>`
 */
export class TerrainHandles3D {
    constructor(v) {
        this.owner = v.owner ?? this;
        this.overlayClass = v.overlayClass;
        this.idPrefix = v.idPrefix;
        this.overlays = [];
    }

    /**
     * Build the overlays on first use, and show or hide them.
     *
     * Built lazily rather than up front: a sitch that never opens the editor should not carry
     * two extra views around for the whole session.
     */
    setVisible(on) {
        if (on && this.overlays.length === 0) this.build();
        for (const o of this.overlays) {
            if (!on) { getInteractionRouter()?.cancelOwner(o); o.onMouseUp(); }
            o.visible = on;
        }
        setRenderOne(true);
    }

    build() {
        for (const hostId of HANDLE_VIEWS) {
            if (!ViewMan.exists(hostId)) continue;
            this.overlays.push(new this.overlayClass({
                id: this.idPrefix + "_" + hostId,
                overlayView: hostId,
                owner: this.owner,
            }));
        }
    }

    /** True while any view is dragging a handle. */
    get isDragging() {
        return this.overlays.some((o) => o.isDragging);
    }

    dispose() {
        // Go through the manager, not straight to the node. These overlays are constructed with
        // an id, so they are registered in NodeMan; disposing one directly tears down its DOM
        // but leaves the registration behind. NodeMan.disposeAll then reaches the same node and
        // disposes it a second time, and the second pass throws on removeChild(null) — which is
        // what killed the transition when one fit sitch was loaded after another. It also left a
        // dead id registered, so re-enabling the editor tried to build an overlay that already
        // existed. disposeRemove does both halves.
        for (const o of this.overlays) {
            if (o?.id !== undefined && NodeMan.exists(o.id)) NodeMan.disposeRemove(o.id);
            else o?.dispose?.();
        }
        this.overlays = [];
    }
}
