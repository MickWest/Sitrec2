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
// HOVER PREVIEW. While hovering (not yet painting) the brush shows a live
// "ghost" of the geometry it would affect — those triangles are temporarily
// hidden from the solid tiles (cheap + reversible) and redrawn as wireframe line
// segments. It updates as the cursor / camera move and is fully restored when
// the brush moves away, the window loses focus, or Manual Edit is turned off.
// Nothing is committed until a click.
//
// Mouse coordinates are tracked HERE (this._sx/_sy) rather than read from the
// global getMousePosition(): while painting we stopPropagation(), which stops
// Sitrec's own move handler from updating that global, leaving it stale. A stale
// position can re-pick in the OTHER view (different camera → large offset).
//
// Raycasting is done against the per-view TilesRenderer group of whichever view
// the cursor is over; the resulting world-space hit point + brush radius are
// handed to the buildings node, which applies the edit (and the preview) to every
// per-view renderer so both the main and look views stay consistent.

import {
    BufferAttribute,
    BufferGeometry,
    LineBasicMaterial,
    LineSegments,
    Raycaster,
} from "three";
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
        this._lastFp = null;     // fingerprint of mouse+cameras, to skip idle rebuilds
        this._previewActive = false; // is a geometry "ghost" preview currently applied?

        // "Ghost" wireframe of the affected (would-be-removed) triangles, drawn in
        // world space at their original positions. depthTest on so it sits in the
        // scene where the removed geometry was; shown in both views.
        const wireGeo = new BufferGeometry();
        wireGeo.setAttribute("position", new BufferAttribute(new Float32Array(0), 3));
        const wireMat = new LineBasicMaterial({
            color: 0x66ffcc,
            transparent: true,
            opacity: 0.85,
            depthTest: true,
            depthWrite: false,
        });
        this.wireMesh = new LineSegments(wireGeo, wireMat);
        this.wireMesh.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
        this.wireMesh.renderOrder = 998;
        this.wireMesh.frustumCulled = false;
        this.wireMesh.visible = false;
        this.wireMesh.raycast = () => {};
        GlobalScene.add(this.wireMesh);

        this._onPointerDown = (e) => this.onPointerDown(e);
        this._onPointerMove = (e) => this.onPointerMove(e);
        this._onPointerUp = (e) => this.onPointerUp(e);
        // Hide the preview as soon as the window loses focus (e.g. alt-tab) — a
        // stale ghost sitting in an unfocused window is just noise.
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
    //     projection (full videoZoom + fov-coverage + pan + yCompress) — the same
    //     setup the terrain LOD uses to match what the user sees. We bracket the
    //     unproject with it and restore immediately. For the main view this is just
    //     the ordinary projection, so it's correct there too.
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

    // Cheap fingerprint of everything that moves the hit point: the pointer
    // position and both candidate cameras. Used to skip the per-frame rebuild
    // when nothing has changed (otherwise the preview would re-pick + re-edit
    // geometry every frame and never let the render loop sleep).
    _fingerprint() {
        let fp = this._sx * 7919 + this._sy * 104729;
        for (const id of BRUSH_VIEW_IDS) {
            const v = ViewMan.get(id, false);
            if (v && v.camera) {
                const e = v.camera.matrixWorld.elements;
                fp += e[12] + e[13] * 1.7 + e[14] * 2.3 + e[0] * 5.1 + e[6] * 9.3
                    + (v.camera.fov || 0) + (v.camera.zoom || 0);
            }
        }
        return fp;
    }

    onPointerDown(e) {
        if (!this.active || e.button !== 0) return;
        // Only paint when the press lands on a render canvas — never hijack a
        // click on the lil-gui panel (div/input/button) even if it happens to
        // overlap the view's pixel rect. Our capture-phase listener runs before
        // lil-gui's own handlers, so this guard is what keeps the menu usable.
        if (!(e.target instanceof HTMLCanvasElement)) return;
        this._sx = e.clientX; this._sy = e.clientY;
        // Restore the hover ghost so the pick + commit see the real geometry.
        this._clearGhost();
        const hit = this.pick(e.clientX, e.clientY);
        if (!hit) { this.hidePreview(); return; } // no tile hit → camera gets the drag
        this.painting = true;
        this.applyAt(hit.point);
        setRenderOne(true);
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
        this._lastFp = this._fingerprint();
        const hit = this._hover(e.clientX, e.clientY);
        if (this.painting) {
            if (hit) this.applyAt(hit.point);
            e.stopPropagation();
        }
    }

    onPointerUp(e) {
        if (!this.painting) return;
        this.painting = false;
        e.stopPropagation();
    }

    // Per-frame refresh (called from the buildings node update) so the preview
    // follows the surface as the camera orbits with the mouse held still. Skips
    // during a stroke (the pointer-move handler drives it then) and when nothing
    // has moved since the last refresh, so the render loop can settle.
    refreshPreview() {
        if (!this.active || !this.overCanvas || this.painting || !document.hasFocus()) {
            if (!this.active || !document.hasFocus()) this.hidePreview();
            return;
        }
        const fp = this._fingerprint();
        if (fp === this._lastFp) return;
        this._lastFp = fp;
        this._hover(this._sx, this._sy);
    }

    // Restore the previous ghost, pick on clean geometry (so the hit doesn't
    // oscillate through the hole the ghost would leave), then build the new
    // ghost. Returns the hit (or null).
    _hover(screenX, screenY) {
        this._clearGhost();
        const hit = this.pick(screenX, screenY);
        if (!hit) { this.hidePreview(); return null; }
        // Hide + wireframe the affected triangles (skip while painting — the real
        // edit is happening and is visible on its own).
        if (!this.painting) {
            const radius = this.buildingsNode.treeFlattenParams.brushRadius;
            const positions = this.buildingsNode.previewManualBrush(hit.point, radius);
            this._setGhost(positions);
        }
        setRenderOne(true);
        return hit;
    }

    // Update the ghost wireframe line segments from a flat [x,y,z,...] array.
    // Uses a growable persistent buffer + drawRange so we don't churn GPU
    // buffers each hover. The mesh is frustumCulled=false, so no bounding sphere
    // is needed (stale tail data past drawRange is never drawn).
    _setGhost(positions) {
        const n = positions.length;
        this._previewActive = n > 0;
        if (n === 0) {
            this.wireMesh.visible = false;
            return;
        }
        const geo = this.wireMesh.geometry;
        let attr = geo.getAttribute("position");
        if (!attr || attr.array.length < n) {
            const cap = Math.max(n, attr ? attr.array.length * 2 : 0, 6 * 512);
            attr = new BufferAttribute(new Float32Array(cap), 3);
            geo.setAttribute("position", attr);
        }
        attr.array.set(positions);
        attr.needsUpdate = true;
        geo.setDrawRange(0, n / 3);
        this.wireMesh.visible = true;
    }

    // Restore the solid geometry hidden by the ghost and clear the wireframe.
    _clearGhost() {
        if (this.wireMesh.visible) this.wireMesh.visible = false;
        if (this._previewActive) {
            this.buildingsNode.clearManualBrushPreview();
            this._previewActive = false;
        }
    }

    hidePreview() {
        const wasVisible = this.wireMesh.visible || this._previewActive;
        this._clearGhost();
        if (wasVisible) setRenderOne(true);
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
        this._clearGhost();
        if (this.wireMesh) {
            GlobalScene.remove(this.wireMesh);
            this.wireMesh.geometry.dispose();
            this.wireMesh.material.dispose();
            this.wireMesh = null;
        }
        this.buildingsNode = null;
    }
}
