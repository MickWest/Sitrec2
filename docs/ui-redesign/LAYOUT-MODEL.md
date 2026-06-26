# Layout Model — Explicit Split-Tree (Strategy B)

Decision D2: build a true Blender-style **area split-tree** as the tiling model, layered on top of the existing fractional-rect views so **no existing sitch breaks**.

## Data model

```
LayoutNode =
  | { type:'split', dir:'v'|'h', sizes:[f, ...], children:[LayoutNode, ...] }   // sizes sum to 1
  | { type:'leaf',  viewId:string }
```

- `dir:'v'` → vertical dividers, children laid out **left→right**; `dir:'h'` → horizontal dividers, children **top→bottom**.
- N-ary children (not just binary); a divider sits between each adjacent pair.
- A **leaf** binds a rectangle to an existing view by its stable `viewId` (`mainView`, `lookView`, `video`, graph ids, …).

**Canonical "Layout Test" tree** (main left | video over look right):
```
{ type:'split', dir:'v', sizes:[0.5, 0.5], children:[
    { type:'leaf', viewId:'mainView' },
    { type:'split', dir:'h', sizes:[0.5, 0.5], children:[
        { type:'leaf', viewId:'video' },
        { type:'leaf', viewId:'lookView' } ] } ] }
```
Dragging the root vertical divider resizes main + the whole right column; dragging the inner horizontal divider resizes video/look only. Exactly the target behaviour.

## Geometry (how it drives views)

Walk the tree from the Content rect (minus the top menu strip / `ViewMan.topPx`). At each split, partition the rect along `dir` by `sizes`, reserving divider thickness. At each leaf, assign the rect directly to the view's `leftPx/topPx/widthPx/heightPx`, **and write it back to the legacy `left/top/width/height` fractions**.

> **Do NOT inset the header height.** The per-view header is a hover-reveal **overlay** that never insets the canvas (DESIGN-LANGUAGE §3a); the canvas renders full-size under it. So a tiled leaf must occupy the *full* cell — insetting the header would leave a permanent ~26px dead strip per tile. (Resolves LAYOUT-MODEL open-question 2 + the reviewer's doc-contradiction flag.)

Hook point: parallel to the existing `updateDockedWH()` early-return inside `CNodeView.updateWH()` —
> *if this view is a leaf in the active layout tree → take rect from the tree; else → legacy fractional-rect path (unchanged).*

This keeps the per-frame render path, `changedSize()`/`deferredResizeWebGL()` debounce, and camera-aspect logic untouched.

## Interactions

- **Divider drag** (inside Q edit-mode): adjusts the two adjacent `sizes` of one split (sum preserved) → recompute geometry. Replaces today's cosmetic edge-snap with real coupled resize.
- **Detach (Q + pull out)**: remove the leaf; its split renormalises (collapses to the surviving child if only one remains); the view becomes a floating rect-based window exactly like today.
- **Re-dock / split / join**: insert a view as a new leaf at a drop target (Blender-style split); join adjacent leaves. (Later phase.)
- **Visibility**: a hidden view's leaf **collapses**, redistributing its space to siblings; re-showing re-inserts it. _(Open question — Sitrec toggles view visibility frequently; confirm collapse-vs-reserve.)_

## Serialization & backward-compat (the whole point)

- New **optional** top-level field `out.layout` = the serialized tree (view ids only).
- **Old / built-in sitches have no `out.layout`** → pure legacy fractional-rect behaviour, byte-for-byte as today. ✅ nothing breaks.
- **New saves** write `out.layout` **AND** keep each leaf's legacy fractions in sync → older builds that ignore `out.layout` still render approximately right. ✅ forward-compatible.
- Views **not** in the tree (floating/detached, `overlayView` HUDs, `relativeTo` children, sidebar-docked) keep using their rects — the tree governs only top-level tiled views.
- Migrate with the existing `exportTagNumber` version gate if ever needed.
- **Built-in sitches stay rect-based** (no tree) initially — tree is opt-in via a "tile current layout" action, with an optional rect→tree reconstruction (the default guillotine layouts reconstruct cleanly). Absolute guarantee: **no tree ⇒ legacy behaviour.**

## Hard invariants (do not violate)
- Never repurpose `left/top/width/height`; **negative width/height = aspect-lock** stays meaningful.
- The tree references views by **stable id**; renaming a view id orphans saved layout.
- Leaf rect → view must flow through the existing resize path (`changedSize`) so WebGL renderers resize correctly.

## Open questions
1. Hidden-leaf: collapse-and-redistribute vs reserve space? (lean: collapse)
2. Header height: part of the leaf rect (inset) vs outside it — ties to Phase 3 header coupling.
3. Coexistence with the legacy `mainView` center-sidebar split in `updateWH` (the tree should eventually subsume it).
4. Per-view geometry round-trip test (Phase 0.1) must assert both the tree and the synced fractions.
