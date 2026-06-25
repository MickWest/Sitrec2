// TreeManualBrush.js
//
// Manual-edit brush for the "Tree Removal" feature. When the Tree Removal
// "Manual Edit" checkbox is on, left-click-dragging over the Google
// Photorealistic 3D tiles paints the current Tree Action (snap / delete) onto
// the geometry under the brush instead of relying on the automatic analysis.
//
// The interaction is owned here rather than in the per-view 3D mouse code: we
// install document-level pointer listeners in the CAPTURE phase so that, when a
// stroke begins on a tile hit, we can stopPropagation() and pre-empt the view's
// own camera-drag handlers (which run in the bubble phase). When Manual Edit is
// off — or the press isn't over a tile hit — we do nothing and let the normal
// camera controls run, so the user can still orbit by dragging empty space.
//
// While Manual Edit is on, a 25%-transparent wireframe sphere tracks the cursor
// at the brush radius so the user can see exactly what will be edited. It is
// refreshed on pointer-move and once per frame (refreshPreview, called from the
// buildings node) so it also follows the surface as the camera orbits with the
// mouse held still.
//
// Mouse coordinates are tracked HERE (this._sx/_sy) rather than read from the
// global getMousePosition(): while painting we stopPropagation(), which stops
// Sitrec's own move handler from updating that global, leaving it stale. A stale
// position can re-pick in the OTHER view (different camera → large offset), which
// previously caused the preview to jump/flicker mid-stroke.
//
// Raycasting is done against the per-view TilesRenderer group of whichever view
// the cursor is over; the resulting world-space hit point + brush radius are
// handed to the buildings node, which applies the edit to every per-view
// renderer so both the main and look views stay consistent.

import {Mesh, MeshBasicMaterial, Raycaster, SphereGeometry} from "three";
import {ViewMan} from "./CViewManager";
import {mouseInViewOnly} from "./ViewUtils";
import {GlobalScene} from "./LocalFrame";
import {setRenderOne} from "./Globals";
import * as LAYER from "./LayerMasks";

// Views that carry a Google-photorealistic TilesRenderer (see CNodeBuildings3DTiles).
const BRUSH_VIEW_IDS = ["mainView", "lookView"];

export class TreeManualBrush {
    /** @param {Object} buildingsNode the CNodeBuildings3DTiles that owns the renderers + params */
    constructor(buildingsNode) {
        this.buildingsNode = buildingsNode;
        this.raycaster = new Raycaster();
        this.painting = false;
        this.overCanvas = false; // is the cursor currently over a render canvas?
        this._sx = 0;            // our own tracked pointer position (screen coords)
        this._sy = 0;

        // Wireframe preview sphere — unit radius, scaled to the brush radius.
        // depthTest off so the whole sphere reads as an overlay gizmo regardless
        // of where it sits relative to the tiles; raycast no-op so it never
        // interferes with any picking (including our own brush ray). Its layer
        // mask is set per-pick to the hovered view only.
        const geo = new SphereGeometry(1, 24, 16);
        const mat = new MeshBasicMaterial({
            color: 0x00ff88,
            wireframe: true,
            transparent: true,
            opacity: 0.1, // 10% opacity
            depthTest: false,
            depthWrite: false,
        });
        this.brushMesh = new Mesh(geo, mat);
        this.brushMesh.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
        this.brushMesh.renderOrder = 999;
        this.brushMesh.visible = false;
        this.brushMesh.raycast = () => {};
        GlobalScene.add(this.brushMesh);

        this._onPointerDown = (e) => this.onPointerDown(e);
        this._onPointerMove = (e) => this.onPointerMove(e);
        this._onPointerUp = (e) => this.onPointerUp(e);
        // Hide the preview as soon as the window loses focus (e.g. alt-tab) — a
        // stale sphere sitting in an unfocused window is just noise.
        this._onBlur = () => { this.painting = false; this.hidePreview(); };
        document.addEventListener("pointerdown", this._onPointerDown, true);
        document.addEventListener("pointermove", this._onPointerMove, true);
        document.addEventListener("pointerup", this._onPointerUp, true);
        window.addEventListener("blur", this._onBlur);
    }

    // Active only while the Manual Edit checkbox is on.
    get active() {
        const p = this.buildingsNode && this.buildingsNode.treeFlattenParams;
        return !!(p && p.manualEdit);
    }

    // Raycast the Google-tile geometry of the top-most view under the cursor.
    // Returns {point, mask} (world hit + that view's layer mask) or null.
    //
    // Coordinate + projection handling is what makes this robust across views,
    // including the look view's video-matched "pixel zoom":
    //   • Gate on _effectivelyVisible, NOT view.visible — in full-screen mode the
    //     hidden view keeps visible=true and still occupies its old half-screen
    //     rect at a high z, which would resolve the wrong half to the wrong camera.
    //   • NDC is computed from canvas.getBoundingClientRect(), so it matches the
    //     pixels on screen (letterbox offset / DPR included).
    //   • The ray is built from the DISPLAYED projection, not the live camera.
    //     The look view renders a wider frustum (camera zoom is pixel-match-capped)
    //     to an offscreen target and shows a magnified central crop, so the live
    //     camera projection is ~2x too wide for picking. prepareCameraForLOD() /
    //     restoreCameraAfterLOD() set the camera to exactly the displayed
    //     projection (full videoZoom + fov-coverage + pan + yCompress) — it's the
    //     same setup the terrain LOD uses to match what the user sees. We bracket
    //     the unproject with it and restore immediately. For the main view this is
    //     just the ordinary projection, so it's correct there too.
    pick(screenX, screenY) {
        let best = null, bestZ = -Infinity, bestRect = null;
        for (const id of BRUSH_VIEW_IDS) {
            const view = ViewMan.get(id, false);
            if (!view || !view.camera || !view._effectivelyVisible || !view.canvas) continue;
            if (typeof view.prepareCameraForLOD !== "function") continue;
            if (!mouseInViewOnly(view, screenX, screenY)) continue;
            const rect = view.canvas.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            if (screenX < rect.left || screenX > rect.right || screenY < rect.top || screenY > rect.bottom) continue;
            const z = view.zIndex || 0;
            if (z > bestZ) { bestZ = z; best = {view, id}; bestRect = rect; }
        }
        if (!best) return null;
        const group = this.buildingsNode.getViewRendererGroup(best.id);
        if (!group) return null; // view has no Google renderer

        const view = best.view;
        const cam = view.camera;
        const ndcX = ((screenX - bestRect.left) / bestRect.width) * 2 - 1;
        const ndcY = -((screenY - bestRect.top) / bestRect.height) * 2 + 1;

        // Temporarily put the camera into its on-screen (displayed) projection,
        // unproject, then restore. Guard against re-entrancy with the terrain LOD
        // pass (which also uses these), though they don't interleave in practice.
        const lodActive = view._lodSavedZoom !== undefined;
        if (!lodActive) view.prepareCameraForLOD();
        cam.updateMatrixWorld();
        const ray = this.raycaster.ray;
        ray.origin.setFromMatrixPosition(cam.matrixWorld);
        ray.direction.set(ndcX, ndcY, 0.5).unproject(cam).sub(ray.origin).normalize();
        if (!lodActive) view.restoreCameraAfterLOD();

        this.raycaster.camera = cam;
        this.raycaster.layers.mask = cam.layers.mask;
        const hits = this.raycaster.intersectObject(group, true);
        if (!hits.length) return null;
        return {point: hits[0].point, mask: cam.layers.mask};
    }

    onPointerDown(e) {
        if (!this.active || e.button !== 0) return;
        // Only paint when the press lands on a render canvas — never hijack a
        // click on the lil-gui panel (div/input/button) even if it happens to
        // overlap the view's pixel rect. Our capture-phase listener runs before
        // lil-gui's own handlers, so this guard is what keeps the menu usable.
        if (!(e.target instanceof HTMLCanvasElement)) return;
        this._sx = e.clientX; this._sy = e.clientY;
        const hit = this.pick(e.clientX, e.clientY);
        this.showPreviewAt(hit);
        if (!hit) return; // no tile hit → let the camera controls have the drag
        this.painting = true;
        this.applyAt(hit.point);
        // Own this stroke: block the view's camera-drag / selection handlers.
        e.stopPropagation();
        e.preventDefault();
    }

    onPointerMove(e) {
        if (!this.active) { this.hidePreview(); return; }
        this._sx = e.clientX; this._sy = e.clientY;
        this.overCanvas = e.target instanceof HTMLCanvasElement;
        if (!this.overCanvas) {
            this.hidePreview();
            if (this.painting) e.stopPropagation();
            return;
        }
        const hit = this.pick(e.clientX, e.clientY);
        this.showPreviewAt(hit);
        if (this.painting) {
            if (hit) this.applyAt(hit.point);
            e.stopPropagation();
        }
        // Hover doesn't otherwise wake the render-on-demand loop, so request a
        // redraw to keep the preview tracking the cursor.
        setRenderOne(true);
    }

    onPointerUp(e) {
        if (!this.painting) return;
        this.painting = false;
        e.stopPropagation();
    }

    // Per-frame refresh (called from the buildings node update) so the preview
    // follows the surface as the camera orbits with the mouse held still. Skips
    // during a stroke — the pointer-move handler drives the preview then, and the
    // global mouse position is stale anyway because we stopPropagation().
    refreshPreview() {
        if (!this.active || !this.overCanvas || this.painting || !document.hasFocus()) {
            if (!this.active || !document.hasFocus()) this.hidePreview();
            return;
        }
        this.showPreviewAt(this.pick(this._sx, this._sy));
    }

    showPreviewAt(hit) {
        if (!hit) { this.hidePreview(); return; }
        const radius = this.buildingsNode.treeFlattenParams.brushRadius;
        this.brushMesh.position.copy(hit.point);
        this.brushMesh.scale.setScalar(radius);
        this.brushMesh.layers.mask = hit.mask; // show only in the hovered view
        if (!this.brushMesh.visible) this.brushMesh.visible = true;
        this.brushMesh.updateMatrixWorld();
        setRenderOne(true);
    }

    hidePreview() {
        if (this.brushMesh.visible) {
            this.brushMesh.visible = false;
            setRenderOne(true);
        }
    }

    applyAt(point) {
        const radius = this.buildingsNode.treeFlattenParams.brushRadius;
        this.buildingsNode.applyManualBrush(point, radius);
    }

    dispose() {
        document.removeEventListener("pointerdown", this._onPointerDown, true);
        document.removeEventListener("pointermove", this._onPointerMove, true);
        document.removeEventListener("pointerup", this._onPointerUp, true);
        window.removeEventListener("blur", this._onBlur);
        if (this.brushMesh) {
            GlobalScene.remove(this.brushMesh);
            this.brushMesh.geometry.dispose();
            this.brushMesh.material.dispose();
            this.brushMesh = null;
        }
        this.buildingsNode = null;
    }
}
