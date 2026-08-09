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

import {Raycaster, Vector3} from "three";
import {CNodeViewUI} from "./nodes/CNodeViewUI";
import {NodeMan, setRenderOne} from "./Globals";
import {ViewMan} from "./CViewManager";
import {mouseToCanvas, renderedRect, withDisplayedCamera} from "./ViewUtils";
import {ellipsoidAlongRay, raycastGroundElevationFast} from "./raycastGround";
import {drawFitHandle, GRAB_RADIUS} from "./FitHandleDraw";

/** The 3D views a handle is offered in. */
const HANDLE_VIEWS = ["mainView", "lookView"];

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

/** How far a drag ray will look for ground before giving up. */
const MAX_GROUND_RANGE = 400000;

/**
 * Where a ray meets the world — the elevation surface, or the actual 3D geometry.
 *
 * Two genuinely different answers, which is why it is a choice rather than a default.
 *
 * The elevation map is a smooth height field. It is fast, it covers the whole planet at some zoom,
 * and it is the right surface for a landmark that IS the ground: a river bend, a shoreline, a
 * track. But it has no buildings on it, so a rooftop corner placed against it lands at street
 * level, tens of metres from the thing being pointed at — an error that matters enormously at
 * short range and is invisible at long range.
 *
 * The 3D tiles are the geometry actually on screen: roofs, walls, even trees. Placing against them
 * is what makes a close-range fit possible at all, because at those scales the recognisable
 * features are all things standing UP off the ground rather than marks on it.
 *
 * With tiles selected the order is STRICT PRIORITY — tiles, then elevation, then the ellipsoid —
 * and NOT raycastLocalGround's "nearest concrete surface". That distinction is the whole point.
 * The elevation surface can sit tens of metres ABOVE the tile geometry (raycastGround says so in
 * its own comments, and it is why the shared function skips a HIDDEN basemap entirely), so with
 * the basemap visible and 3D tiles on, "nearest" hands back the invisible height field draped over
 * the building the user is aiming at. Asking for the building and silently getting the terrain in
 * front of it is exactly the error this option exists to remove. Nearest is still right for orbit
 * and pan anchors, which want whatever is visibly frontmost, so that function is left alone.
 *
 * @param {boolean} useTiles
 * @param {object}  camera  needed for the tiles pass — the tile meshes are on the MAIN/LOOK
 *                          layers, so the raycaster has to borrow a camera's layer mask
 * @returns {Vector3|null}
 */
export function surfaceAlongRay(origin, direction, useTiles, camera) {
    const dir = direction.clone().normalize();
    if (!useTiles) return raycastGroundElevationFast(origin, dir, MAX_GROUND_RANGE);

    // 1. The 3D geometry, if any is loaded under this ray.
    if (camera && NodeMan.exists("buildings3DTiles")) {
        const group = NodeMan.get("buildings3DTiles").group;
        if (group && group.children.length > 0) {
            const raycaster = new Raycaster(origin.clone(), dir);
            raycaster.far = MAX_GROUND_RANGE;
            raycaster.layers.mask = camera.layers.mask;
            // firstHitOnly asks the tiles' BVH for just the nearest hit, and is ignored by
            // non-BVH meshes where the sorted hits[0] is the nearest anyway.
            raycaster.firstHitOnly = true;
            const hits = raycaster.intersectObject(group, true);
            if (hits.length > 0) return hits[0].point.clone();
        }
    }

    // 2. The elevation surface. The fast height-field march, not the terrain MESH: the mesh has no
    //    BVH and costs about a millisecond a ray, which a drag cannot afford at one ray per frame.
    const elevation = raycastGroundElevationFast(origin, dir, MAX_GROUND_RANGE);
    if (elevation !== null) return elevation;

    // 3. The ellipsoid, so a ray that reaches neither — outside tile coverage, or before the
    //    elevation has streamed in — still lands somewhere defensible instead of nowhere. Returns
    //    null for a ray heading away from the local ground, so looking at the sky still misses.
    return ellipsoidAlongRay(origin, dir);
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

/** Canvas pixels -> the surface point under them, or null if the ray never reaches one. */
export function groundUnderCanvasPoint(view, cx, cy, useTiles = false) {
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
    // view.camera, not the LOD-prepared one: prepareCameraForLOD changes fov, aspect and offsets
    // but never the layer mask, which is the only thing the tiles pass reads.
    return surfaceAlongRay(ray.origin, ray.dir, useTiles, view.camera);
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
        // Required for `visible = false` to actually hide anything. ViewMan.updateDOMVisibility
        // only touches an overlay's canvas when the overlay declares separate visibility;
        // everything else is left to the PARENT div's display, and this overlay's parent is the
        // main or look view, which stays up. So without this, switching Enable Fit off dropped
        // the overlay out of the render loop — _computeEV went false — while its canvas stayed
        // on screen holding the last handles it drew, frozen there because the view that would
        // have cleared them was no longer being rendered. Clear All Points could not shift them
        // either, for the same reason. The fit's own video overlay (CNodeFitCameraPoints) has
        // always set this; the 3D handles were the odd ones out.
        this.separateVisibility = true;
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
        // The handles are drawn on an overlay and so are never hidden by the terrain, which is
        // deliberate: a landmark you are trying to place is exactly the thing you still need to see
        // when a ridge is in the way. The video quad is the one exception — it is a picture of what
        // the camera sees, so a marker showing through the FRONT of it would read as a point in
        // mid-air rather than a place on the ground beyond.
        const occluder = this.hostId === RAY_VIEW ? this.owner.getOccluder() : null;
        const eye = occluder ? host.camera.position : null;
        for (let i = 0; i < points.length; i++) {
            if (occluder && behindQuad(occluder, eye, points[i].position)) continue;
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
        // Last, so a video point stays readable where it lands on top of its own ground handle —
        // which is exactly what a well-fitted near landmark looks like from behind the camera.
        if (this.hostId === RAY_VIEW) this.drawVideoPlaneHandles();
    }

    /**
     * Mark each video point where it falls on the video hanging in the frustum.
     *
     * The other end of the sight lines FitPointSightLines3D draws: a correct camera runs each line
     * straight through its own marker on its way to the ground point. Drawn as the same handle the
     * user places on the video, because it IS that point — seen from outside the camera that saw it.
     */
    drawVideoPlaneHandles() {
        const host = this.host;
        const display = this.owner.getRayDisplay();
        if (!host || !display) return;
        for (const p of display.points) {
            if (p.image === null) continue;
            const at = projectToCanvas(host, p.image);
            if (at !== null) drawFitHandle(this.ctx, at[0], at[1], p.color, String(p.index + 1));
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
        const ground = groundUnderCanvasPoint(this.host, cx, cy, this.owner.getUseTiles());
        // No surface under the cursor (dragged into the sky, or past the horizon): leave the point
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
 * @param {Function} v.getRayDisplay () => {origin: Vector3, points: [{index, color,
 *                                   ground: Vector3, image: Vector3|null}]} | null
 * @param {Function} v.getOccluder   () => {worldToQuad: Matrix4} | null
 * @param {Function} v.getUseTiles   () => boolean — place against 3D geometry, not the elevation
 * @param {Function} v.onMoved       (id, Vector3) => void, continuously during a drag
 * @param {Function} v.onCommit      (id) => void, once on release
 * @param {Function} v.onCorrectFrame () => boolean
 * @param {Function} v.onBeginEdit   () => void, opens an undo span at the start of a drag
 * @param {Function} v.onEndEdit     (description) => void, closes it on release
 */
export class FitPointHandles3D {
    constructor(v) {
        this.getPoints = v.getPoints;
        this.getRayDisplay = v.getRayDisplay ?? (() => null);
        this.getOccluder = v.getOccluder ?? (() => null);
        this.getUseTiles = v.getUseTiles ?? (() => false);
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
        // Go through the manager, not straight to the node. These overlays are constructed with
        // an id, so they are registered in NodeMan; disposing one directly tears down its DOM
        // but leaves the registration behind. NodeMan.disposeAll then reaches the same node and
        // disposes it a second time, and the second pass throws on removeChild(null) — which is
        // what killed the transition when one fit sitch was loaded after another. It also left a
        // dead id registered, so re-enabling the fit tried to build "fitHandles_mainView" when
        // one already existed. disposeRemove does both halves.
        for (const o of this.overlays) {
            if (o?.id !== undefined && NodeMan.exists(o.id)) NodeMan.disposeRemove(o.id);
            else o?.dispose?.();
        }
        this.overlays = [];
    }
}
