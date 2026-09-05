import {registerEditorInteraction} from "./EditorInteraction";
// GroundPaintBrush.js
//
// Pointer handling for "Paint On Ground" — the texture-space sibling of
// TreeManualBrush (which edits GEOMETRY). While the "Paint Mode" checkbox is on,
// left-click-dragging over the ground paints the current colour into the surface
// TEXTURES under the brush; holding Option/Alt erases back to the original
// imagery.
//
// The interaction router selects the brush before navigation and retains the
// originating view for the whole stroke. The brush supplies surface geometry.
//
// The pick itself goes through raycastLocalGround(), so it lands on whichever
// surface is actually in front: the Google Photorealistic 3D tiles when they are
// loaded, the basemap terrain mesh otherwise. That is the same "both surfaces"
// rule the painter uses when it replays the dabs.
//
// HOVER PREVIEW is just a ring on the ground at the brush radius, tinted with the
// paint colour (red while erasing). Unlike the geometry brush there is nothing to
// ghost — the paint is flat, so a footprint outline is the whole story.

import {
    BufferAttribute,
    BufferGeometry,
    LineBasicMaterial,
    LineLoop,
    Raycaster,
    Vector3,
} from "three";
import {ViewMan} from "./CViewManager";
import {getInteractiveViewAt, setRaycasterFromView} from "./ViewUtils";
import {GlobalScene} from "./LocalFrame";
import {setRenderOne} from "./Globals";
import {getLocalUpVector} from "./SphericalMath";
import {raycastLocalGround} from "./raycastGround";
import * as LAYER from "./LayerMasks";

// The 3D views a brush stroke can land in.
const BRUSH_VIEW_IDS = ["mainView", "lookView"];

// Segments in the cursor ring.
const RING_SEGMENTS = 72;

const _up = new Vector3();
const _zAxis = new Vector3(0, 0, 1);

export class GroundPaintBrush {
    /** @param {Object} painter the CGroundPainter that owns the dab list + params */
    constructor(painter) {
        this.painter = painter;
        this.raycaster = new Raycaster();
        this.painting = false;
        this.overCanvas = false;
        this._altKey = false;   // Option/Alt held → erase
        this._sx = 0;
        this._sy = 0;
        this._lastFp = null;    // fingerprint of mouse+cameras, to skip idle rebuilds
        this._strokeBefore = null; // dab-list snapshot taken at the start of a stroke
        // Where the brush last PAINTED, in world space — the anchor a shift-click
        // draws its line FROM. Updated by every click AND continuously through a
        // drag, so the anchor is always the end of what you last painted: click,
        // click chains into a polyline; drag, then shift-click continues the line
        // from where the drag stopped rather than from where it began.
        this._lastPaintPoint = null;

        // Cursor ring: a unit circle in the XY plane, re-oriented and scaled per
        // hover. depthTest off so it stays visible over the surface it is lying on
        // (a ring exactly ON the ground z-fights with it otherwise).
        const pts = new Float32Array(RING_SEGMENTS * 3);
        for (let i = 0; i < RING_SEGMENTS; i++) {
            const a = (i / RING_SEGMENTS) * Math.PI * 2;
            pts[i * 3] = Math.cos(a);
            pts[i * 3 + 1] = Math.sin(a);
            pts[i * 3 + 2] = 0;
        }
        const geo = new BufferGeometry();
        geo.setAttribute("position", new BufferAttribute(pts, 3));
        this.ringMesh = new LineLoop(geo, new LineBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.9,
            depthTest: false,
            depthWrite: false,
        }));
        this.ringMesh.layers.mask = LAYER.MASK_MAIN | LAYER.MASK_LOOK;
        this.ringMesh.renderOrder = 999;
        this.ringMesh.frustumCulled = false;
        this.ringMesh.visible = false;
        this.ringMesh.raycast = () => {};
        GlobalScene.add(this.ringMesh);

        this.unregisterInteraction = registerEditorInteraction(this, {
            profile: "brush",
            id: "brush:GroundPaintBrush", enabled: () => this.active,
            pick: e => e.target?.tagName === "CANVAS" ? {priority: 80} : null,
            begin: e => { this._anchorBefore = this._lastPaintPoint?.clone(); this.onPointerDown(e); },
            end: e => { this.onPointerUp(e); this.activeView = null; },
            leave: () => { this.overCanvas = false; this.hidePreview(); },
            rollback: e => {
                const before = this._strokeBefore;
                this._strokeBefore = null;
                if (before) this.painter.restoreDabsState(before);
                this._lastPaintPoint = this._anchorBefore;
                this.onPointerUp(e); this.activeView = null; this.hidePreview();
            },
        });
    }

    // Active only while the "Paint Mode" checkbox is on.
    get active() {
        return !!this.painter?.params?.paintMode;
    }

    // Ray-pick the ground (3D tiles or terrain, nearest wins) in the top-most view
    // under the cursor. Returns a world-space Vector3 or null. See the file header
    // for why the projection is bracketed with prepareCameraForLOD.
    pick(screenX, screenY) {
        const view = this.painting && this.activeView ? this.activeView : getInteractiveViewAt(screenX, screenY, BRUSH_VIEW_IDS);
        if (!view) return null;
        const cam = view.camera;
        if (!setRaycasterFromView(this.raycaster, view, screenX, screenY)) return null;

        this.raycaster.camera = cam;
        // Both the 3D-tile meshes and the terrain tiles live on the MAIN/LOOK
        // layers, so the raycaster needs the camera's mask for either to be tested.
        this.raycaster.layers.mask = cam.layers.mask;
        this.raycaster.near = 0;
        this.raycaster.far = Infinity;
        const hit = raycastLocalGround(this.raycaster, cam);
        // isTerrain false means nothing was actually hit — it is the bare-ellipsoid
        // fallback, where there is no texture to paint.
        if (!hit || !hit.isTerrain) return null;
        return hit.point;
    }

    // Cheap fingerprint of everything that moves the hit point (pointer + both
    // candidate cameras), so an idle hover doesn't re-pick every frame and keep
    // the render loop awake.
    // Forget the shift-line anchor. Called when the paint it referred to is gone
    // (Clear Paint, undo/redo), so a shift-click can't draw a line from a location
    // that is no longer part of anything on screen.
    resetPaintAnchor() {
        this._lastPaintPoint = null;
    }

    _fingerprint() {
        // brushRadius is in here so the cursor ring resizes as [ / ] are pressed,
        // not only when the pointer or camera moves.
        let fp = this._sx * 7919 + this._sy * 104729 + (this._altKey ? 1 : 0)
            + (this.painter?.params?.brushRadius ?? 0) * 31;
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
        // Only paint when the press lands on a render canvas — never hijack a click
        // on the lil-gui panel even if it overlaps the view's pixel rect. Our
        // capture-phase listener runs before lil-gui's, so this is what keeps the
        // menu usable while Paint Mode is on.
        if (!(e.target instanceof HTMLCanvasElement)) return;
        this._sx = e.clientX; this._sy = e.clientY;
        this._altKey = e.altKey;
        // Begin the stroke even if this press isn't over the ground, so a swipe that
        // STARTS on sky still paints as the brush crosses the surface.
        this.painting = true;
        this._strokeBefore = this.painter.snapshotDabs();
        const point = this.pick(e.clientX, e.clientY);
        if (point) {
            // Shift-click draws a straight line from wherever the brush last painted
            // instead of a single dab — deliberately only on the CLICK, so a drag
            // still paints freehand exactly as before (and a shift-DRAG is just a
            // line to the press point followed by a normal freehand stroke on from
            // there, which also leaves the anchor at the drag's end).
            if (e.shiftKey && this._lastPaintPoint) {
                this.painter.applyBrushLine(this._lastPaintPoint, point,
                    this.painter.params.brushRadius, this._erasing());
            } else {
                this.applyAt(point);
            }
            this._lastPaintPoint = point.clone();
        }
        setRenderOne(true);
        e.stopPropagation();
        e.preventDefault();
    }

    onPointerMove(e) {
        if (!this.active) { this.hidePreview(); return; }
        this._sx = e.clientX; this._sy = e.clientY;
        this._altKey = e.altKey;
        this.overCanvas = e.target instanceof HTMLCanvasElement;
        if (!this.overCanvas) {
            this.hidePreview();
            if (this.painting) e.stopPropagation();
            return;
        }
        this._lastFp = this._fingerprint();
        const point = this.pick(e.clientX, e.clientY);
        this._setRing(point);
        if (this.painting) {
            if (point) {
                this.applyAt(point);
                // Carry the shift-line anchor along with the drag, so it ends up at
                // the end of the stroke. Set from the picked point rather than only
                // when a dab is actually appended: applyAt may dedupe a dab that is
                // within 0.3 * radius of the previous one, but the brush was still
                // there, and that is what "where I last painted" means.
                this._lastPaintPoint = point.clone();
            }
            e.stopPropagation();
        }
        setRenderOne(true);
    }

    onPointerUp(e) {
        if (!this.painting) return;
        this._endStroke();
        e.stopPropagation();
    }

    // Finish the current stroke (if any) and record its undo entry. Safe to call
    // when not painting. Driven from pointer-up and window-blur.
    _endStroke() {
        if (!this.painting) return;
        this.painting = false;
        if (this._strokeBefore) {
            this.painter.commitStrokeUndo(this._strokeBefore);
            this._strokeBefore = null;
        }
    }

    // Per-frame refresh so the ring follows the surface as the camera orbits with
    // the mouse held still. Skipped during a stroke (pointer-move drives it then)
    // and when nothing has moved, so the render loop can settle.
    refreshPreview() {
        if (!this.active || !this.overCanvas || this.painting || !document.hasFocus()) {
            if (!this.active || !document.hasFocus()) this.hidePreview();
            return;
        }
        const fp = this._fingerprint();
        if (fp === this._lastFp) return;
        this._lastFp = fp;
        this._setRing(this.pick(this._sx, this._sy));
        setRenderOne(true);
    }

    // Place the cursor ring flat on the ground at `point`, sized to the brush
    // radius and tinted with what a click would do. null hides it.
    _setRing(point) {
        if (!point) {
            this.ringMesh.visible = false;
            return;
        }
        const p = this.painter.params;
        _up.copy(getLocalUpVector(point));
        this.ringMesh.position.copy(point);
        this.ringMesh.quaternion.setFromUnitVectors(_zAxis, _up);
        this.ringMesh.scale.setScalar(Math.max(0.01, p.brushRadius));
        this.ringMesh.material.color.set(this._erasing() ? 0xff4040 : p.color);
        this.ringMesh.visible = true;
    }

    _erasing() {
        return this._altKey;
    }

    hidePreview() {
        if (this.ringMesh.visible) {
            this.ringMesh.visible = false;
            setRenderOne(true);
        }
    }

    applyAt(point) {
        this.painter.applyBrush(point, this.painter.params.brushRadius, this._erasing());
    }

    dispose() {
        this.unregisterInteraction?.();
        if (this.ringMesh) {
            GlobalScene.remove(this.ringMesh);
            this.ringMesh.geometry.dispose();
            this.ringMesh.material.dispose();
            this.ringMesh = null;
        }
        this.painter = null;
    }
}
