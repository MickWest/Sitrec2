// The 3D half of "Fit Camera to Points": a landmark you drag with a flat 2D handle.
//
// The widget, the gesture and the cross-view behaviour are shared with the Ground Track editor and
// live in TerrainHandles3D.js — read its header for WHY a point on the ground is placed in screen
// space rather than with a gizmo. What is here is the part that is only true of a camera fit:
//
//   * the points are LANDMARKS, one set, all belonging to a single fit keyframe — so a handle
//     grabbed on any other frame is not editable, and says so rather than moving;
//   * the frustum's video quad is a picture of what the camera sees, so a marker showing through
//     the front of it would read as a point in mid-air rather than a place on the ground beyond;
//   * the main view also draws each point where it falls ON that video quad, which is the far end
//     of the sight lines FitPointSightLines3D draws.

import {mouseToCanvas} from "./ViewUtils";
import {drawFitHandle, OFF_FRAME_ALPHA} from "./FitHandleDraw";
import {CTerrainHandleOverlay, TerrainHandles3D} from "./TerrainHandles3D";

/**
 * The view the convergence display is drawn in.
 *
 * Only this one, because the look view IS the camera the sight lines start at: every line would
 * project to a single point, and every marker on the video quad would land on top of the pixel it
 * already sits on in the video view. The whole display only says anything from outside. It is also
 * the only view the frustum's video quad is drawn in at all — it is on the helpers layer, which the
 * look view deliberately excludes.
 */
const RAY_VIEW = "mainView";

// The pure geometry — surfaceAlongRay, groundUnderCanvasPoint and projectToCanvas — lives in
// FitSurfacePick.js (a leaf module, so CSitrecAPI can import it without pulling in the
// view classes below). Re-exported here for the existing importers of this module.
//
// projectToCanvas went with them rather than staying: picking a refracted scene means casting a
// ray and then checking where the answer actually LANDED, so the pick needs the projection. Split
// across the two modules, that dependency would have restored the very cycle the move removed.
import {surfaceAlongRay, groundUnderCanvasPoint, projectToCanvas} from "./FitSurfacePick";
export {surfaceAlongRay, groundUnderCanvasPoint, projectToCanvas};

/**
 * Does the frustum's video quad block the view from `eye` to `world`?
 *
 * Answered in the quad's own local frame, where the quad is exactly the square x,y in [-0.5, 0.5]
 * at z = 0, so the whole test is one segment-plane intersection and two comparisons — no projection
 * and no polygon walk. `t` is where the sight line crosses that plane, as a fraction of the way
 * from the eye to the point: outside (0,1) the quad is behind the viewer or beyond the point, and
 * blocks nothing.
 *
 * @param {{worldToQuad: Matrix4}} occluder
 */
function behindQuad(occluder, eye, world) {
    const a = eye.clone().applyMatrix4(occluder.worldToQuad);
    const b = world.clone().applyMatrix4(occluder.worldToQuad);
    const dz = b.z - a.z;
    if (dz === 0) return false;                     // sight line lies in the plane of the quad
    const t = -a.z / dz;
    if (t <= 0 || t >= 1) return false;
    return Math.abs(a.x + (b.x - a.x) * t) <= 0.5 && Math.abs(a.y + (b.y - a.y) * t) <= 0.5;
}

/**
 * One overlay per 3D view: draws that view's control points and owns dragging in it.
 */
class CFitHandleOverlay extends CTerrainHandleOverlay {
    interactionProfile = "fit";
    /** Canvas position of every point in this view, as [{id, color, index, cx, cy}]. */
    projected() {
        return this.projectPoints(this.owner.getPoints());
    }

    /** The video quad, in the one view that draws it. See behindQuad. */
    occlusionTest() {
        const occluder = this.hostId === RAY_VIEW ? this.owner.getOccluder() : null;
        if (!occluder) return null;
        const eye = this.host.camera.position;
        return (world) => behindQuad(occluder, eye, world);
    }

    renderCanvas(frame) {
        super.renderCanvas(frame);
        if (!this.owner.enabled || !this.ctx) return;
        // Faded off-keyframe, the same as the video's own handles. These are the SAME points, so
        // they have to answer the "can I edit this here?" question the same way in every view —
        // solid in one and faded in another said the two were different things.
        const alpha = this.owner.onCorrectFrame() ? 1 : OFF_FRAME_ALPHA;
        for (const h of this.projected()) {
            drawFitHandle(this.ctx, h.cx, h.cy, h.color, String(h.index + 1), alpha, this.handleState(h.id));
        }
        // Last, so a video point stays readable where it lands on top of its own ground handle —
        // which is exactly what a well-fitted near landmark looks like from behind the camera.
        if (this.hostId === RAY_VIEW) this.drawVideoPlaneHandles(alpha);
    }

    /**
     * Mark each video point where it falls on the video hanging in the frustum.
     *
     * The other end of the sight lines FitPointSightLines3D draws: a correct camera runs each line
     * straight through its own marker on its way to the ground point. Drawn as the same handle the
     * user places on the video, because it IS that point — seen from outside the camera that saw it.
     */
    drawVideoPlaneHandles(alpha = 1) {
        const host = this.host;
        const display = this.owner.getRayDisplay();
        if (!host || !display) return;
        for (const p of display.points) {
            if (p.image === null) continue;
            const at = projectToCanvas(host, p.image);
            if (at !== null) {
                drawFitHandle(this.ctx, at[0], at[1], p.color, String(p.index + 1), alpha);
            }
        }
    }

    onMouseDown(e, mouseX, mouseY) {
        this.draggingId = null;
        if (!this.owner.enabled || e.button !== 0) return false;

        const [cx, cy] = mouseToCanvas(this, mouseX, mouseY);
        const hit = this.pick(cx, cy, this.projected());
        if (!hit) return false;

        // Tested AFTER the hit, not before. Off-keyframe this offers to go to the nearest one,
        // and that offer belongs to a press on a HANDLE — the user reaching for a point. Asked
        // before the hit test, every press anywhere in a 3D view would raise a dialog, which
        // would make the view unorbitable off-keyframe. Not claimed either way, so a press that
        // happens to land on a faded handle still orbits, as it does with the fit switched off.
        if (!this.owner.onCorrectFrame()) {
            this.owner.onWrongFrame();
            return true;
        }

        this.owner.beginUndo();
        this.beginDrag(hit.id);
        return true;
    }

    movePoint(id, position) {
        this.owner.setPointPosition(id, position);
    }

    endDrag(id) {
        // Commit BEFORE closing the undo span, so the entry captures the refitted camera as well
        // as the moved point — the two are one edit, and undoing either alone is incoherent.
        this.owner.commitPointMove(id);
        this.owner.endUndo("Move camera fit point");
    }
}

/**
 * Owns one handle overlay per 3D view.
 *
 * @param {object}   v
 * @param {Function} v.getPoints     () => [{id, color, position: Vector3}]
 * @param {Function} v.getRayDisplay () => {origin: Vector3, points: [{index, color,
 *                                   ground: Vector3, image: Vector3|null}]} | null
 * @param {Function} v.getOccluder   () => {worldToQuad: Matrix4} | null
 * @param {Function} v.getUseTiles   () => boolean — place against 3D geometry, not the elevation
 * @param {Function} v.getUseObjects () => boolean — also place against the scene's 3D objects
 * @param {Function} v.onMoved       (id, Vector3) => void, continuously during a drag
 * @param {Function} v.onCommit      (id) => void, once on release
 * @param {Function} v.onCorrectFrame () => boolean
 * @param {Function} v.onWrongFrame  () => void, a handle was grabbed on the wrong frame
 * @param {Function} v.onBeginEdit   () => void, opens an undo span at the start of a drag
 * @param {Function} v.onEndEdit     (description) => void, closes it on release
 */
export class FitPointHandles3D extends TerrainHandles3D {
    constructor(v) {
        // No `owner`: the overlays' owner defaults to this wrapper, which is what holds the
        // callbacks below and what answers `enabled`. The node behind it is reached only
        // through them.
        super({overlayClass: CFitHandleOverlay, idPrefix: "fitHandles"});
        this.getPoints = v.getPoints;
        this.getRayDisplay = v.getRayDisplay ?? (() => null);
        this.getOccluder = v.getOccluder ?? (() => null);
        this.getUseTiles = v.getUseTiles ?? (() => false);
        this.getUseObjects = v.getUseObjects ?? (() => false);
        this.onMoved = v.onMoved ?? (() => {});
        this.onCommit = v.onCommit ?? (() => {});
        this.onCorrectFrame = v.onCorrectFrame ?? (() => true);
        this.onWrongFrame = v.onWrongFrame ?? (() => {});
        this.onBeginEdit = v.onBeginEdit ?? (() => {});
        this.onEndEdit = v.onEndEdit ?? (() => {});
        this.onRollbackEdit = v.onRollbackEdit ?? (() => {});
        this.enabled = false;
    }

    setEnabled(on) {
        this.enabled = on;
        this.setVisible(on);
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
}
