// Explicit split-tree tiling layout (Strategy B). See docs/ui-redesign/LAYOUT-MODEL.md.
//
// A LayoutNode tree partitions the Content rect into tiles; each leaf binds a tile to an
// existing view by its stable id. This is OPTIONAL: when no tree is set every view uses its
// legacy fractional rect exactly as before, so no existing sitch is affected.
//
//   LayoutNode =
//     | { type:'split', dir:'v'|'h', sizes:[f,...], children:[LayoutNode,...] }  // sizes sum to 1
//     | { type:'leaf',  viewId:string }
//
//   dir:'v' → vertical dividers, children laid out left→right
//   dir:'h' → horizontal dividers, children laid out top→bottom

import {ViewMan} from "./CViewManager";
import {setRenderOne} from "./Globals";

export const LAYOUT_DIVIDER_PX = 4;   // divider thickness reserved between adjacent tiles
const MIN_TILE_FRAC = 0.05;           // a tile can't be dragged smaller than this fraction of its split
const DIVIDER_GRAB_PX = 10;           // interactive grab zone width centred on each seam

class CLayoutManager {
    constructor() {
        this.tree = null;            // root LayoutNode, or null (= legacy fractional mode)
        this._rects = new Map();     // viewId -> {leftPx, topPx, widthPx, heightPx}
        this._dividers = [];         // {node, index, dir, x, y, w, h, usablePx} for divider hit-testing
        this._lastW = this._lastH = this._lastT = this._lastL = -1;
        this._dirty = false;
    }

    get active() { return !!this.tree; }

    // Install a layout tree (or null to return to legacy mode). Wakes a render.
    setLayout(tree) {
        this.tree = tree || null;
        this._dirty = true;
        this.recompute();
        setRenderOne(true);
    }

    clearLayout() {
        this.tree = null;
        this._rects.clear();
        this._dividers = [];
        this._syncDividerDOM();   // hides the seam layer
        setRenderOne(true);
    }

    // Pixel rect for a leaf view in the active tree, or null (not tiled / legacy mode).
    rectFor(viewId) {
        if (!this.tree) return null;
        this._recomputeIfNeeded();
        return this._rects.get(viewId) || null;
    }

    // True if this view is currently a leaf in the active tree.
    hasLeaf(viewId) {
        return this.rectFor(viewId) !== null;
    }

    // Recompute only when the container rect changed (or explicitly dirtied). Cheap to call
    // per-view per-frame: it just compares four ints and walks once when they move.
    _recomputeIfNeeded() {
        const w = ViewMan.widthPx, h = ViewMan.heightPx, t = ViewMan.topPx, l = ViewMan.leftPx;
        if (this._dirty || w !== this._lastW || h !== this._lastH || t !== this._lastT || l !== this._lastL) {
            this._lastW = w; this._lastH = h; this._lastT = t; this._lastL = l;
            this._dirty = false;
            this.recompute();
        }
    }

    // Walk the tree from the Content rect, filling _rects + _dividers.
    recompute() {
        this._rects.clear();
        this._dividers = [];
        if (this.tree) {
            this._walk(this.tree, ViewMan.leftPx, ViewMan.topPx, ViewMan.widthPx, ViewMan.heightPx);
        }
        this._syncDividerDOM();
    }

    _walk(node, x, y, w, h) {
        if (!node) return;
        if (node.type === "leaf") {
            this._rects.set(node.viewId, {
                leftPx: Math.round(x), topPx: Math.round(y),
                widthPx: Math.max(1, Math.round(w)), heightPx: Math.max(1, Math.round(h)),
            });
            return;
        }
        const children = node.children || [];
        const n = children.length;
        if (n === 0) return;
        const vertical = node.dir === "v";   // 'v' = vertical dividers → children left→right
        const sizes = this._normalizedSizes(node, n);
        const total = vertical ? w : h;
        const usable = Math.max(0, total - LAYOUT_DIVIDER_PX * (n - 1));
        let cursor = vertical ? x : y;
        for (let i = 0; i < n; i++) {
            const extent = usable * sizes[i];
            if (vertical) {
                this._walk(children[i], cursor, y, extent, h);
                cursor += extent;
                if (i < n - 1) {
                    this._dividers.push({node, index: i, dir: "v", usablePx: usable,
                        x: cursor, y, w: LAYOUT_DIVIDER_PX, h});
                    cursor += LAYOUT_DIVIDER_PX;
                }
            } else {
                this._walk(children[i], x, cursor, w, extent);
                cursor += extent;
                if (i < n - 1) {
                    this._dividers.push({node, index: i, dir: "h", usablePx: usable,
                        x, y: cursor, w, h: LAYOUT_DIVIDER_PX});
                    cursor += LAYOUT_DIVIDER_PX;
                }
            }
        }
    }

    // Return sizes normalised to sum 1 (without mutating the stored array, so serialization
    // stays stable). Repairs a missing/degenerate array by writing back equal sizes.
    _normalizedSizes(node, n) {
        let sizes = node.sizes;
        if (!Array.isArray(sizes) || sizes.length !== n) {
            sizes = new Array(n).fill(1 / n);
            node.sizes = sizes;
            return sizes;
        }
        const sum = sizes.reduce((a, b) => a + (b > 0 ? b : 0), 0);
        if (sum <= 0) {
            sizes = new Array(n).fill(1 / n);
            node.sizes = sizes;
            return sizes;
        }
        if (Math.abs(sum - 1) > 1e-6) return sizes.map(s => (s > 0 ? s : 0) / sum);
        return sizes;
    }

    // --- Divider drag (Q edit-mode, Phase 2.3) ---

    // Find the divider near a container-relative point (px,py), or null.
    dividerAt(px, py, tol = 6) {
        for (const d of this._dividers) {
            if (px >= d.x - tol && px <= d.x + d.w + tol &&
                py >= d.y - tol && py <= d.y + d.h + tol) return d;
        }
        return null;
    }

    // Resize the two tiles adjacent to a divider by dragging it dxPx/dyPx. The split's total
    // is preserved (we add to one neighbour and subtract from the other); neither neighbour
    // collapses below MIN_TILE_FRAC. Recomputes + wakes a render.
    dragDivider(divider, dxPx, dyPx) {
        const node = divider.node;
        const i = divider.index;
        const n = (node.children || []).length;
        if (n < 2) return;
        if (!Array.isArray(node.sizes) || node.sizes.length !== n) {
            node.sizes = new Array(n).fill(1 / n);
        }
        const sizes = node.sizes;
        const usable = divider.usablePx || 1;
        const deltaPx = divider.dir === "v" ? dxPx : dyPx;
        let dFrac = deltaPx / usable;
        // clamp so sizes[i] >= MIN and sizes[i+1] >= MIN
        dFrac = Math.max(dFrac, MIN_TILE_FRAC - sizes[i]);
        dFrac = Math.min(dFrac, sizes[i + 1] - MIN_TILE_FRAC);
        sizes[i] += dFrac;
        sizes[i + 1] -= dFrac;
        this._dirty = true;
        this.recompute();
        setRenderOne(true);
    }

    // --- Tree maintenance (detach / Phase 2.5) ---

    // Remove a leaf (by viewId) from the tree; collapse any split left with a single child.
    // Returns true if the view was a leaf and removed. Does NOT reposition the view — the
    // caller turns it into a floating window.
    removeLeaf(viewId) {
        if (!this.tree) return false;
        if (this.tree.type === "leaf") {
            if (this.tree.viewId === viewId) { this.clearLayout(); return true; }
            return false;
        }
        const removed = this._removeLeafFrom(this.tree, viewId);
        if (removed) { this._dirty = true; this.recompute(); setRenderOne(true); }
        return removed;
    }

    _removeLeafFrom(split, viewId) {
        const children = split.children;
        for (let i = 0; i < children.length; i++) {
            const c = children[i];
            if (c.type === "leaf" && c.viewId === viewId) {
                children.splice(i, 1);
                if (Array.isArray(split.sizes)) split.sizes.splice(i, 1);
                this._collapse(split);
                return true;
            }
            if (c.type === "split" && this._removeLeafFrom(c, viewId)) {
                this._collapse(c);
                return true;
            }
        }
        return false;
    }

    // If a split is down to one child, replace it (in place) with that child's contents.
    _collapse(split) {
        if (split.type !== "split") return;
        if (split.children.length === 1) {
            const only = split.children[0];
            delete split.dir; delete split.sizes;
            if (only.type === "leaf") {
                split.type = "leaf"; split.viewId = only.viewId;
                delete split.children;
            } else {
                split.type = "split"; split.dir = only.dir;
                split.sizes = only.sizes; split.children = only.children;
            }
        }
    }

    // List the view ids currently bound to leaves (in tree order).
    leafViewIds() {
        const out = [];
        const recur = (node) => {
            if (!node) return;
            if (node.type === "leaf") out.push(node.viewId);
            else (node.children || []).forEach(recur);
        };
        recur(this.tree);
        return out;
    }

    // --- Reconstruct a tree from the current view rects (Phase 2.6 rect→tree) ---
    // Tile the currently visible top-level views: read their fractional rects and recover a
    // split-tree by recursive guillotine cuts. Default layouts (main left | video over look
    // right) recover cleanly. Returns true if a tree was installed; false if the current
    // layout isn't guillotine-separable (then nothing changes — legacy mode stays).
    tileFromViews() {
        const rects = [];
        ViewMan.iterate((id, v) => {
            if (!v.visible || v.overlayView || v.in.relativeTo || v.dockedSidebar) return;
            if (v.noUIBar && v.constructor && /UI$/.test(v.constructor.name)) return; // HUD instruments
            const W = v.containerWidth(), H = v.containerHeight();
            if (!(W > 0 && H > 0)) return;
            rects.push({
                viewId: id,
                left:   (v.leftPx - v.containerLeft()) / W,
                top:    (v.topPx  - v.containerTop())  / H,
                width:  v.widthPx  / W,
                height: v.heightPx / H,
            });
        });
        if (rects.length < 2) return false;
        const tree = buildGuillotineTree(rects);
        if (!tree) return false;
        this.setLayout(tree);
        return true;
    }

    // --- Interactive divider DOM (Blender-style draggable seams) ---
    // Each seam gets a thin transparent grab strip (wider than the 4px gap) on top of the
    // tiles, with a col/row-resize cursor. Dragging it calls dragDivider. Elements are reused
    // across recomputes (only added/removed when the seam COUNT changes) so an in-progress
    // drag isn't destroyed when the geometry re-walks.
    _syncDividerDOM() {
        if (typeof document === "undefined") return;
        const container = ViewMan.container;
        if (!container) return;

        if (!this._dividers.length) {
            if (this._dividerLayer) this._dividerLayer.style.display = "none";
            return;
        }

        if (!this._dividerLayer || !this._dividerLayer.isConnected) {
            const layer = document.createElement("div");
            layer.className = "sitrec-divider-layer";
            Object.assign(layer.style, {
                position: "absolute", left: "0", top: "0", width: "100%", height: "100%",
                pointerEvents: "none", zIndex: "55",
            });
            container.appendChild(layer);
            this._dividerLayer = layer;
            this._dividerEls = [];
        }
        this._dividerLayer.style.display = "block";

        // Grow/shrink the pool of grab strips to match the seam count.
        while (this._dividerEls.length < this._dividers.length) {
            this._dividerEls.push(this._makeDividerEl(this._dividerEls.length));
        }
        while (this._dividerEls.length > this._dividers.length) {
            this._dividerEls.pop().remove();
        }

        // Position each strip over its seam (centred, widened to the grab zone). Coordinates
        // are container-relative (the divider rects are in container px, which already start
        // at ViewMan.leftPx/topPx = the container origin).
        const grab = DIVIDER_GRAB_PX;
        for (let i = 0; i < this._dividers.length; i++) {
            const d = this._dividers[i];
            const el = this._dividerEls[i];
            if (d.dir === "v") {
                Object.assign(el.style, {
                    left: `${Math.round(d.x + d.w / 2 - grab / 2)}px`, top: `${Math.round(d.y)}px`,
                    width: `${grab}px`, height: `${Math.round(d.h)}px`, cursor: "col-resize",
                });
            } else {
                Object.assign(el.style, {
                    left: `${Math.round(d.x)}px`, top: `${Math.round(d.y + d.h / 2 - grab / 2)}px`,
                    width: `${Math.round(d.w)}px`, height: `${grab}px`, cursor: "row-resize",
                });
            }
        }
    }

    _makeDividerEl(index) {
        const el = document.createElement("div");
        el.className = "sitrec-layout-divider";
        Object.assign(el.style, {
            position: "absolute", pointerEvents: "auto", background: "transparent",
            zIndex: "1", touchAction: "none",
        });
        el.addEventListener("pointerdown", (e) => this._onDividerPointerDown(e, index));
        return el;
    }

    _onDividerPointerDown(e, index) {
        const divider = this._dividers[index];
        if (!divider) return;
        e.preventDefault();
        e.stopPropagation();
        const node = divider.node;
        const dir = divider.dir;
        const usablePx = divider.usablePx;
        const i = divider.index;
        const startX = e.clientX, startY = e.clientY;
        // Snapshot the split's sizes so cumulative pointer delta maps to absolute sizes
        // (avoids drift from re-reading mutated sizes each move).
        const n = (node.children || []).length;
        const startSizes = (Array.isArray(node.sizes) && node.sizes.length === n)
            ? node.sizes.slice() : new Array(n).fill(1 / n);

        const onMove = (ev) => {
            const deltaPx = dir === "v" ? ev.clientX - startX : ev.clientY - startY;
            let dFrac = deltaPx / (usablePx || 1);
            dFrac = Math.max(dFrac, MIN_TILE_FRAC - startSizes[i]);
            dFrac = Math.min(dFrac, startSizes[i + 1] - MIN_TILE_FRAC);
            if (!Array.isArray(node.sizes) || node.sizes.length !== n) node.sizes = startSizes.slice();
            node.sizes[i] = startSizes[i] + dFrac;
            node.sizes[i + 1] = startSizes[i + 1] - dFrac;
            this._dirty = true;
            this.recompute();
            setRenderOne(true);
        };
        const onUp = () => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("pointercancel", onUp);
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        document.addEventListener("pointercancel", onUp);
    }

    // Serializable copy of the tree (view ids + sizes only; strips transient walk state).
    serialize() {
        const clean = (node) => {
            if (!node) return null;
            if (node.type === "leaf") return {type: "leaf", viewId: node.viewId};
            return {
                type: "split", dir: node.dir,
                sizes: Array.isArray(node.sizes) ? node.sizes.slice() : undefined,
                children: (node.children || []).map(clean),
            };
        };
        return this.tree ? clean(this.tree) : null;
    }
}

// Recover a split-tree from a set of fractional rects via recursive guillotine cuts. Returns
// a LayoutNode, or null if the set isn't guillotine-separable (overlapping / pinwheel layout).
function buildGuillotineTree(rects) {
    if (rects.length === 1) {
        return {type: "leaf", viewId: rects[0].viewId};
    }
    // Try a vertical cut (a clean x where every rect is fully left or fully right of it).
    const vCut = findCut(rects, "x");
    if (vCut) {
        return makeSplit("v", vCut.groups, "left", "width");
    }
    // Then a horizontal cut.
    const hCut = findCut(rects, "y");
    if (hCut) {
        return makeSplit("h", hCut.groups, "top", "height");
    }
    return null;   // not guillotine-separable
}

// Find a clean cut along axis 'x' (using left/width → vertical seam) or 'y' (top/height →
// horizontal seam): the rects partition into two non-empty groups separated by a gap.
function findCut(rects, axis) {
    const lo = axis === "x" ? "left" : "top";
    const ext = axis === "x" ? "width" : "height";
    const eps = 1e-3;
    // Candidate cut lines = the right/bottom edges of each rect.
    const edges = [...new Set(rects.map(r => r[lo] + r[ext]))].sort((a, b) => a - b);
    for (const cut of edges) {
        const before = rects.filter(r => r[lo] + r[ext] <= cut + eps);
        const after = rects.filter(r => r[lo] >= cut - eps);
        if (before.length && after.length && before.length + after.length === rects.length) {
            return {groups: [before, after]};
        }
    }
    return null;
}

function makeSplit(dir, groups, lo, ext) {
    const children = groups.map(g => buildGuillotineTree(g));
    if (children.some(c => c === null)) return null;   // a subgroup wasn't separable
    // group extent = (max far edge - min near edge); sizes proportional to that.
    const spans = groups.map(g => {
        const near = Math.min(...g.map(r => r[lo]));
        const far = Math.max(...g.map(r => r[lo] + r[ext]));
        return far - near;
    });
    const total = spans.reduce((a, b) => a + b, 0) || 1;
    return {type: "split", dir, sizes: spans.map(s => s / total), children};
}

export const LayoutMan = new CLayoutManager();
