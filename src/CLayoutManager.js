// Adjacency-based shared-edge layout (Strategy C — replaces the old guillotine split-tree).
//
// Views are FREE rectangles (their existing fractional left/top/width/height). There is no
// tree and no required tiling: each layout update we scan the visible views' pixel rects and
// detect SHARED EDGES — places where one view's edge is flush against another's (even if only
// part of the length). Every shared edge gets a draggable seam; dragging it moves the coupled
// views' edges together (one grows into adjacent empty space while the other shrinks, clamped
// at a minimum size). This is what lets a small view share a partial edge with a larger one
// and still have a single grab handle that moves both — impossible under the old full-length
// guillotine cuts.
//
// The old tree-based public API (setLayout/clearLayout/serialize/dockViewAt/…) is kept as thin
// no-op stubs so existing callers (sitch load/save, the View menu, CNodeView drag handling)
// keep working unchanged: views simply persist and restore via their own fractional rects.

import {ViewMan} from "./CViewManager";
import {setRenderOne} from "./Globals";
import {MIN_VIEW_PX} from "./DragResizeUtils";

export const LAYOUT_DIVIDER_PX = 0;   // kept for import compatibility (no reserved gap)

const EDGE_TOL = 6;       // px: how close two edges must be to count as a shared edge
const MIN_OVERLAP = 16;   // px: minimum perpendicular overlap for a seam to form
const GRAB_PX = 8;        // px: interactive grab-zone width centred on each shared edge
// A seam drag can't shrink a view below MIN_VIEW_PX (shared with edge-resize, see DragResizeUtils).

class CLayoutManager {
    constructor() {
        this._seams = [];        // [{dir:'v'|'h', coord, start, end, before:[ids], after:[ids]}]
        this._seamEls = [];      // pooled DOM grab-strips, parallel to _seams
        this._seamLayer = null;  // absolute overlay holding the strips
        this._sig = "";          // signature of the last rect set (skip redundant recompute)
    }

    // The old "is the tree active" flag. There is no tree now (views are always free), so the
    // tree code paths in callers (CNodeView detach/dock) stay dormant.
    get active() { return false; }

    // --- Shared-edge detection (run once per frame from indexRender, after view layout) ---

    // Rebuild the seam set from the current view pixel rects, then sync the grab-strip DOM.
    // Cheap: skips entirely when no rect moved (signature match).
    updateSeams() {
        if (typeof document === "undefined") return;
        const rects = this._collectRects();
        const sig = this._signature(rects);
        if (sig === this._sig) return;
        this._sig = sig;
        this._seams = this._computeSeams(rects);
        this._syncSeamDOM();
    }

    // Visible, top-level, non-aspect-locked views' absolute pixel rects. Mirrors the old
    // tileable-view filter (skips overlays, relative children, docked sidebars, HUD instruments
    // and aspect-locked views, which can't be freely resized).
    _collectRects() {
        const out = [];
        ViewMan.iterate((id, v) => {
            if (!v.visible || v.windowed || v.overlayView || v.in.relativeTo || v.dockedSidebar) return;
            if (v.noUIBar && v.constructor && /UI$/.test(v.constructor.name)) return;
            if (v.width < 0 || v.height < 0) return;                 // aspect-locked encoding
            if (!(v.widthPx > 0) || !(v.heightPx > 0)) return;
            out.push({id, l: v.leftPx, t: v.topPx, r: v.leftPx + v.widthPx, b: v.topPx + v.heightPx});
        });
        return out;
    }

    _signature(rects) {
        return rects.map(r => `${r.id}:${r.l},${r.t},${r.r},${r.b}`).join("|")
            + `|${!!ViewMan.fullscreenView}`;
    }

    _computeSeams(rects) {
        return [
            ...this._seamsForAxis(rects, "v"),
            ...this._seamsForAxis(rects, "h"),
        ];
    }

    // Find shared edges along one axis. dir 'v' = vertical seams (a view's RIGHT edge flush
    // against another's LEFT, overlapping vertically); 'h' = horizontal (BOTTOM against TOP).
    // Adjacencies at (nearly) the same coordinate whose spans overlap/touch are merged into one
    // connected seam, so the grab handle and the coupling cover exactly the shared run.
    _seamsForAxis(rects, dir) {
        const isV = dir === "v";
        const far = r => isV ? r.r : r.b;     // A's far edge meets...
        const near = r => isV ? r.l : r.t;    // ...B's near edge
        const lo = r => isV ? r.t : r.l;      // perpendicular span start
        const hi = r => isV ? r.b : r.r;      // perpendicular span end

        const adj = [];
        for (const A of rects) {
            for (const B of rects) {
                if (A.id === B.id) continue;
                if (Math.abs(far(A) - near(B)) > EDGE_TOL) continue;   // A is just-left-of B
                const top = Math.max(lo(A), lo(B));
                const bottom = Math.min(hi(A), hi(B));
                if (bottom - top < MIN_OVERLAP) continue;
                adj.push({coord: (far(A) + near(B)) / 2, before: A.id, after: B.id, top, bottom});
            }
        }
        if (!adj.length) return [];

        // Cluster by coordinate (consecutive within EDGE_TOL), then within each coordinate
        // cluster merge adjacencies whose perpendicular intervals overlap or touch — those form
        // one connected seam coupling all the views that meet along it.
        adj.sort((a, b) => a.coord - b.coord);
        const groups = [];
        for (const a of adj) {
            const g = groups[groups.length - 1];
            if (g && a.coord - g.lastCoord <= EDGE_TOL) { g.items.push(a); g.lastCoord = a.coord; }
            else groups.push({items: [a], lastCoord: a.coord});
        }

        const seams = [];
        for (const g of groups) {
            g.items.sort((a, b) => a.top - b.top);
            let cur = null;
            for (const a of g.items) {
                if (cur && a.top <= cur.bottom) {          // overlapping / touching → same seam
                    cur.bottom = Math.max(cur.bottom, a.bottom);
                    cur.before.add(a.before); cur.after.add(a.after); cur.coords.push(a.coord);
                } else {
                    cur = {top: a.top, bottom: a.bottom, coords: [a.coord],
                        before: new Set([a.before]), after: new Set([a.after])};
                    seams.push(cur);
                }
            }
        }

        return seams.map(s => ({
            dir,
            coord: Math.round(s.coords.reduce((a, b) => a + b, 0) / s.coords.length),
            start: Math.round(s.top), end: Math.round(s.bottom),
            before: [...s.before], after: [...s.after],
        }));
    }

    // --- Seam grab-strip DOM (reuses the old divider-layer styling) ---

    _syncSeamDOM() {
        if (typeof document === "undefined") return;
        const container = ViewMan.container;
        if (!container) return;

        if (!this._seams.length) {
            if (this._seamLayer) this._seamLayer.style.display = "none";
            return;
        }

        if (!this._seamLayer || !this._seamLayer.isConnected) {
            const layer = document.createElement("div");
            layer.className = "sitrec-divider-layer";
            Object.assign(layer.style, {
                position: "absolute", left: "0", top: "0", width: "100%", height: "100%",
                pointerEvents: "none", zIndex: "55",
            });
            container.appendChild(layer);
            this._seamLayer = layer;
            this._seamEls = [];
        }

        while (this._seamEls.length < this._seams.length) {
            const el = this._makeSeamEl(this._seamEls.length);
            this._seamLayer.appendChild(el);
            this._seamEls.push(el);
        }
        while (this._seamEls.length > this._seams.length) {
            this._seamEls.pop().remove();
        }

        const grab = GRAB_PX;
        for (let i = 0; i < this._seams.length; i++) {
            const s = this._seams[i];
            const el = this._seamEls[i];
            const len = Math.max(1, s.end - s.start);
            if (s.dir === "v") {
                Object.assign(el.style, {
                    left: `${Math.round(s.coord - grab / 2)}px`, top: `${s.start}px`,
                    width: `${grab}px`, height: `${len}px`, cursor: "col-resize",
                });
                Object.assign(el._line.style, {width: "1px", height: "100%"});
            } else {
                Object.assign(el.style, {
                    left: `${s.start}px`, top: `${Math.round(s.coord - grab / 2)}px`,
                    width: `${len}px`, height: `${grab}px`, cursor: "row-resize",
                });
                Object.assign(el._line.style, {width: "100%", height: "1px"});
            }
        }
        this.updateDividerVisibility();
    }

    // Hide the seam overlay while a view is fullscreen (the strips sit above the canvas and
    // would otherwise draw their lines over it). Kept under the old name — CNodeView.doubleClick
    // calls it on the fullscreen toggle.
    updateDividerVisibility() {
        if (!this._seamLayer) return;
        const hide = !this._seams.length || !!ViewMan.fullscreenView;
        this._seamLayer.style.display = hide ? "none" : "block";
    }

    _makeSeamEl(index) {
        const el = document.createElement("div");
        el.className = "sitrec-layout-divider";
        Object.assign(el.style, {
            position: "absolute", pointerEvents: "auto", background: "transparent",
            zIndex: "1", touchAction: "none", display: "flex",
            alignItems: "center", justifyContent: "center",
        });
        const line = document.createElement("div");
        line.className = "sitrec-layout-divider-line";
        Object.assign(line.style, {
            background: "var(--sitrec-border-area, rgba(255,255,255,0.18))",
            transition: "background 0.1s",
        });
        el.appendChild(line);
        el._line = line;
        el.addEventListener("pointerenter", () => {
            line.style.background = "var(--sitrec-accent, #2cc9ff)";
        });
        el.addEventListener("pointerleave", () => {
            if (!el._dragging) line.style.background = "var(--sitrec-border-area, rgba(255,255,255,0.18))";
        });
        el.addEventListener("pointerdown", (e) => this._onSeamPointerDown(e, index));
        return el;
    }

    // Snapshot a view's current geometry + container metrics, so a drag maps the absolute
    // pointer delta onto fixed start values (no drift, and the per-frame seam recompute can't
    // pull the rug out mid-drag).
    _snapView(v) {
        return {v, l: v.leftPx, t: v.topPx, w: v.widthPx, h: v.heightPx,
            cw: v.containerWidth(), ch: v.containerHeight(),
            cl: v.containerLeft(), ct: v.containerTop()};
    }

    // Clamp a desired seam delta so the SHRINKING side never goes below MIN_VIEW_PX. d>0 moves
    // the seam toward the 'after' side (after shrinks); d<0 toward 'before' (before shrinks).
    // The growing side grows freely into whatever empty space (or neighbour) is there.
    _clampSeamDelta(before, after, d, isV) {
        const minBefore = Math.min(...before.map(s => isV ? s.w : s.h));
        const minAfter = Math.min(...after.map(s => isV ? s.w : s.h));
        d = Math.min(d, minAfter - MIN_VIEW_PX);
        d = Math.max(d, -(minBefore - MIN_VIEW_PX));
        return d;
    }

    // Apply a (clamped) delta to the snapshotted views' fractions: 'before' views move their far
    // edge (right/bottom), 'after' views move their near edge (left/top); the opposite edge of
    // each stays put, so the views grow/shrink in place and stay flush along the seam.
    _applySeam(before, after, d, isV) {
        for (const s of before) {
            if (isV) s.v.width = (s.w + d) / s.cw;
            else     s.v.height = (s.h + d) / s.ch;
        }
        for (const s of after) {
            if (isV) { s.v.left = (s.l + d - s.cl) / s.cw; s.v.width = (s.w - d) / s.cw; }
            else     { s.v.top  = (s.t + d - s.ct) / s.ch; s.v.height = (s.h - d) / s.ch; }
        }
        this._sig = "";              // geometry changed → force a seam recompute next frame
        setRenderOne(true);
    }

    // Resolve a seam's view ids to current snapshots (skipping any that vanished).
    _snapSeam(seam) {
        const snap = (ids) => ids.map(id => ViewMan.get(id, false)).filter(Boolean).map(v => this._snapView(v));
        return {before: snap(seam.before), after: snap(seam.after), isV: seam.dir === "v"};
    }

    // Single-shot programmatic seam drag (used by the live pointer handler's first move and by
    // tests / API): move the seam by dPx, clamped. Returns the delta actually applied.
    dragSeamBy(seam, dPx) {
        const {before, after, isV} = this._snapSeam(seam);
        if (!before.length || !after.length) return 0;
        const d = this._clampSeamDelta(before, after, dPx, isV);
        this._applySeam(before, after, d, isV);
        return d;
    }

    // Live drag of a shared edge via its grab strip.
    _onSeamPointerDown(e, index) {
        const seam = this._seams[index];
        if (!seam) return;
        e.preventDefault();
        e.stopPropagation();
        const el = this._seamEls[index];
        if (el) { el._dragging = true; if (el._line) el._line.style.background = "var(--sitrec-accent, #2cc9ff)"; }

        const {before, after, isV} = this._snapSeam(seam);
        if (!before.length || !after.length) return;
        const startX = e.clientX, startY = e.clientY;

        const onMove = (ev) => {
            const raw = isV ? ev.clientX - startX : ev.clientY - startY;
            this._applySeam(before, after, this._clampSeamDelta(before, after, raw, isV), isV);
        };
        const onUp = () => {
            if (el) { el._dragging = false; if (el._line) el._line.style.background = "var(--sitrec-border-area, rgba(255,255,255,0.18))"; }
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("pointercancel", onUp);
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        document.addEventListener("pointercancel", onUp);
    }

    // --- View ▸ Reset Layout: snap the open views back into a clean default grid ---

    _tileableViews() {
        const out = [];
        ViewMan.iterate((id, v) => {
            if (!v.visible || v.overlayView || v.in.relativeTo || v.dockedSidebar) return;
            if (v.noUIBar && v.constructor && /UI$/.test(v.constructor.name)) return;
            if (v.width < 0 || v.height < 0) return;
            out.push(v);
        });
        return out;
    }

    _setViewFrac(v, l, t, w, h) { v.left = l; v.top = t; v.width = w; v.height = h; }

    resetLayout() {
        const views = this._tileableViews();
        if (views.length < 2) return false;
        const main = views.find(v => v.id === "mainView");
        if (main) {
            this._setViewFrac(main, 0, 0, 0.5, 1);
            const rest = views.filter(v => v !== main);
            const n = rest.length;
            rest.forEach((v, i) => this._setViewFrac(v, 0.5, i / n, 0.5, 1 / n));
        } else {
            const n = views.length;
            views.forEach((v, i) => this._setViewFrac(v, i / n, 0, 1 / n, 1));
        }
        this._sig = "";
        setRenderOne(true);
        return true;
    }

    // --- Compatibility stubs for the retired guillotine-tree API ---
    // Views persist/restore via their own fractional rects, so these are all no-ops. Old saved
    // sitches with a serialized `layout` tree just ignore it and come back as free rects at the
    // same positions; the seam engine re-couples any edges that are flush.
    serialize() { return null; }
    setLayout() {}
    clearLayout() {}
    autoTileIfSnapped() { return false; }
    tileFromViews() { return false; }
    hasLeaf() { return false; }
    rectFor() { return null; }
    removeLeaf() { return false; }
    dockViewAt() { return false; }
    updateDropPreview() {}
    hideDropPreview() {}
}

export const LayoutMan = new CLayoutManager();
