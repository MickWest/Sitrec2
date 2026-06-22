# UI Redesign — Running ToDo

Canonical task list for the UI-redesign branch. Status: `[ ]` todo · `[~]` in progress · `[x]` done · `[?]` needs decision.
Last updated: 2026-06-22 (planning).

> Constraint on every item: **must not break existing sitches** (built-in or custom must still load + render). See ARCHITECTURE.md §Serialization.

---

## Decisions (resolved 2026-06-22)
- [x] **D1 — Light-grey scope → HEADERS LIGHT, APP DARK.** Keep the dark theme everywhere; only the new per-window header bars are light-grey for contrast. Theme work is additive.
- [x] **D2 — Layout model → EXPLICIT SPLIT-TREE (Strategy B).** Build a true Blender area split-tree as a new *optional* top-level `out.layout` descriptor; when absent (all old sitches) fall back to today's fractional rects unchanged. See [LAYOUT-MODEL.md](LAYOUT-MODEL.md).
- [x] **D3 — Sequencing → SAFETY NET + TOKENS FIRST.** Phase 0 before any visible layout change.
- [x] **D5 — Blender grounding → DONE.** Extracted Blender 5.1.2 Default-theme tokens (topbar `#181818`, area header `#303030` text `#EEE`, widgets `#545454`, header height 26px) + header anatomy + in-viewport overlay-control pattern, live via MCP → captured in [DESIGN-LANGUAGE.md](DESIGN-LANGUAGE.md) §1/§3. Key finding: Blender headers are *lighter than* the main menu, not absolute-light.
- [?] **D4 — Surfaced controls: replace vs mirror.** (Phase-4 decision, defer.) Move shared menu controls into per-view headers, or duplicate via `CustomManagerMirror`?

---

## Phase 0 — Foundations & safety nets (no visible change)
> **FOCUS (per Mick):** the redesign targets **SitCustom + user-created sitches** (the "Regression"-flagged + featured ones). **Legacy built-ins are NOT a dev focus — they only need to keep loading+rendering**, which the existing `run.mjs` pixel suite already gates. So the geometry *value* net anchors on SitCustom + user sitches, not built-ins.
- [x] **0.1 + 0.2 — geometry safety net DONE (2026-06-22).** Two scenario harness tests under `scenarios/layout/`, committed value-baselines under `value-baseline/`:
  - `layout-geometry-custom` (`sitch:'custom'` = **SitCustom**, the primary focus) — `liveGeometry` (`listViews` = 0.2's fraction baseline, 23 views), `serializedGeometry` (`CNodeView.modSerialize` persistence surface), and an `afterMove` `setViewPosition` round-trip (mainView → exactly `{0.1,0.2,0.4,0.5}` at 1920×1080). isolated.
  - `layout-geometry-layouttest` (`?custom=99999999/Layout Test/20260622_163801.js`) — a **user custom sitch with just a video** that is ALSO the Phase-2 **tiling testbed**: mainView left `{0,0,.5,1}`, video top-right `{.5,0,.5,.5}`, lookView bottom-right `{.5,.5,.5,.5}`. Pins the two shared seams the divider-drag must resize.
  - Both PASS deterministically on compare. Run: `node tests_regression/fast-regression/run-scenarios.mjs --filter=layout` (sandbox-off, ~9s). Captures the negative-width/height aspect-lock convention so split-tree work can't silently break it.
  - Follow-up: broaden geometry coverage across the rest of the ~39 "Regression"/featured user sitches (data-driven over `enumerateSitches`, or piggy-backed on `run.mjs`'s existing per-sitch load).
  - ⚠️ Noted (low priority, legacy): `gofast` trips a pre-existing `JetLOS` "Missing Managed object" assert on headless load — not a redesign concern, just needs to keep working.
- [ ] **0.3** Add **menu-serialization round-trip** test (guiMenus open/closed by title) so renames can't silently drop state.
- [x] **0.4 — design tokens DONE (2026-06-22).** Added `:root{--sitrec-*}` token block to `src/extra.css.js` (Blender-grounded; existing-surface values preserve current dark look, NEW tokens `--sitrec-bg-header #3a3a3a`/`--sitrec-border-area`/`--sitrec-header-h 26px` ready for Phase 3). Routed the Sitrec-authored CSS through the tokens (link, menu/folder/title backgrounds + borders) — value-preserving, verified by git diff. Build clean; layout value scenarios still PASS. **Deferred (deliberate):** re-pointing lil-gui's *internal* vars (touch font-size + hover variants) and `makePanel/makeButton/makeHeaderBar` helpers → fold into Phase 3 when headers need them.
- [ ] **0.5** **Audit `setMenuValue` string-path callers** — `CSitrecAPI` hard-coded paths, `CClientNLU`, Scripted Video — and build a path→controller inventory so Phase-5 renames are safe.
- [ ] **0.6** Resolve unknowns: real **Regression-sitch count** (`test-fast-list`), confirm the **single overlay creation point**, confirm WebGL **context budget** for many-area layouts.

## Phase 1 — Unified view-interaction model
- [x] **1.1 + 1.2 + 1.3 — core unification DONE (2026-06-22).** Realised by *centralising the gesture in `CNodeView`* (lighter + lower-risk than a separate controller class): added `export const VIEW_EDIT_KEY = "Q"` in `DragResizeUtils.js`; `CNodeView` now forces `dragKey = VIEW_EDIT_KEY, shiftDrag = false` for every movable view (`draggable || resizable`) in ONE place, mapping the three legacy gestures (Q / Shift / bare-drag) onto Q. Removed the dead `CNodeVideoView` `this.shiftDrag = true` override. `CMouseHandler` camera-suspend already keys off `dragKey` so it works uniformly.
  - **Verified LIVE via MCP** on the sidebar+3-view+2-graph test sitch (`?custom=…/175055.js`): **20/20 movable views** report `dragKey="Q"`, `shiftDrag=0`, non-uniform = none. Before reload (old build) the graphs were bare-drag (`dragKey=null`) and video `shiftDrag=true` — confirming the fix flipped them.
  - Headless safety net: `interaction-uniformity-custom.scenario.mjs` pins the uniform config (committed baseline). Build clean; all geometry + 9 existing scenarios still PASS.
- [~] **1.3b — parallel-drag classes → RESOLVED INTO PHASE 3.** Decision (2026-06-22): **all views get a header bar, and the header is the consistent drag handle** — so the tab-handle panels (`CNodeViewText`/`CNodeNotes`/`CNodeTabbedCanvasView`) and Chart's Shift holdout are superseded by the universal header model. Fold their `.cnodeview-tab` into the generic view header during Phase 3.
- [ ] **1.4** Document the unified interaction in DESIGN-LANGUAGE.md (the §4 interaction section already describes it; mark VIEW_EDIT_KEY as the implementation).

## Phase 2 — Snapped tiling via split-tree (first focus) — Strategy B, see [LAYOUT-MODEL.md](LAYOUT-MODEL.md)
- [ ] **2.1** Implement the `LayoutNode` split-tree model + geometry walk (Content rect → per-leaf px rect, written back to legacy fractions).
- [ ] **2.2** Hook into `CNodeView.updateWH()` parallel to `updateDockedWH()`: leaf-in-tree → rect from tree; else legacy fractional path (unchanged).
- [ ] **2.3** **Divider drag** (in Q edit-mode): adjust adjacent `sizes` of one split → coupled neighbour resize. Acceptance test = the Layout Test (`mainView` left | `video` over `look` right): vertical seam resizes main + right column; horizontal seam resizes video/look only.
- [ ] **2.4** Serialize as **optional top-level `out.layout`**; no tree ⇒ legacy behaviour; new saves keep leaf fractions in sync. Preserve the **negative-width/height aspect-lock** convention.
- [ ] **2.5** **Q-detach**: pull a leaf out to a floating window (split renormalises); re-dock/split/join (join/split later). Reconcile with sidebar-dock, `updateZOrder`, `scriptZ`, `alwaysOnTop`, overlay HUDs.
- [ ] **2.6** Decide hidden-leaf behaviour (collapse-and-redistribute vs reserve) and built-in rect→tree reconstruction.

## Phase 3 — Per-view header bars (ACTIVE) — decided design: hover-reveal OVERLAY + pin, non-serialized
> Design locked 2026-06-22 (see DESIGN-LANGUAGE §3a): header + all per-view UI are an **overlay above a full-size canvas** — never inset; **show/hide must not change rendering**; **hover-reveal**; **pin button** to keep shown; **not serialized** (saved/old sitches unaffected). This de-risks the survey's #2 canvas-inset coupling (no inset needed) and resolves 1.3b (header = universal drag handle).
- [x] **3.1 — generic header overlay DONE (2026-06-22).** `CNodeView.createViewHeader()` adds an absolute overlay strip (title + 📌 pin button) to every non-overlay, non-passThrough view: `--sitrec-bg-header`, `--sitrec-header-h`, `z-index 60` (above canvas + HUDs), `opacity 0`/`pointerEvents none` until shown. Verified live: all 5 visible views have headers.
- [x] **3.2 — hover-reveal + pin DONE (2026-06-22).** `pointerenter/leave` toggle `_headerHovering`; `setHeaderPinned()` + `_updateHeaderShown()` (pin overrides hover). Runtime-only state, NOT serialized. **Render-unchanged VERIFIED live:** pinning/showing a header left `widthPx/heightPx/canvasW/canvasH` byte-identical on all 5 views (`dimsChangedByPin: []`). Geometry + interaction scenarios still PASS.
- [x] **3.2b — CUIBar component DONE (2026-06-22).** New `src/CUIBar.js`: an overlay header bar supporting **title + menus (lil-gui via `addMenu`) + icon buttons (`addIcon`) + pin**, hover-reveal driven by owner. `CNodeView.createViewHeader` now builds a `CUIBar` (title + ⛶ fullscreen icon + 📌 pin). Generalises the old `CNodeTabbedCanvasView.createTabMenu`/`tabMenu` pattern. **Verified live:** `addMenu` creates a real lil-gui menu in the bar AND `renderUnchanged: true` (canvas dims identical with menu added + bar shown). All scenarios pass.
- [x] **3.3a — header = drag handle DONE (2026-06-22).** `CNodeView` wires a second `makeDraggable` with `handle = uiBar.bar` (no modifier); interactive children (menus/icons/pin) `stopPropagation` so they don't drag. Coexists with Phase-1 Q-drag. Verified live (`cursor: move`).
- [x] **3.3b — FOV / tabbed-editor menu migrated to CUIBar DONE (2026-06-22).** `CNodeTabbedCanvasView.createTabMenu` now does `this.tabMenu = this.uiBar.addMenu(menuName)` and drops the bespoke `menuContainer` + `setupTabDragging` + `updateDraggableWithMenuExclude`. Verified live: `fovEditorView` shows the **"FOV Editor"** menu on its header (`tabMenuIsBarMenu`, `menuContainerIsBar` true). Covers all `CNodeCurveEditorView2`/tabbed editors.
- [ ] **3.3c** Migrate the remaining legacy tab panels onto CUIBar: `CNodeNotes` + `CNodeViewText` `.cnodeview-tab` (+ converge `--cnodeview-tab-*` onto `--sitrec-*` tokens), and `CNodeChartView` (still hardcoded **Shift** — not migrated to the unified Q gesture; the interaction-uniformity baseline doesn't cover it because Chart wires its own makeDraggable). _(closes 1.3b fully)_

### UIBar content & behaviour (Stage 1 — DONE 2026-06-22)
- [x] **Friendly capitalised view names** in the header (`friendlyViewName`): map (Main/Look/Video/Video 2/Assistant) → `menuName` → prettified id. Verified live.
- [x] **Title is a lil-gui menu** (`CUIBar.titleMenu`, like the custom-graph tab menu) — the home for per-view options; tabbed editors (FOV/curve) now add their items to it.
- [x] **Pinned by default** (`pinHeader !== false`) so the bar is shown on most views.
- [x] **✕ Close icon** added alongside Fullscreen + Pin (hides the view); stable `data-uibar-action` on all three.
- [x] **Hover-reveal refined**: when NOT pinned, fades in only over the **bar strip** (not the whole view) and only with **no mouse button held** — so it won't appear while interacting with content or while a drag passes over the strip; leaving the strip hides it; mid-drag of the bar isn't hidden. Verified live.
- [ ] **Stage 2 — Assistant (chatView) migration (NEXT).** Move the chat's controls into its "Assistant" title-menu; **New Chat → a "+" icon** (override `addTabButtons`); **remove the duplicate `.cnodeview-tab`** (currently chat shows BOTH "Assistant" on the UIBar and "Sitrec Assistant" on its own tab). Entangled with `CNodeViewText`: it sets `v.draggable=false` during super (so the UIBar header-drag isn't wired for chat/debug — they drag via the tab) and sizes the log `calc(100% - 40px)` around the tab — so removing the tab must re-wire dragging to the UIBar header and re-flow the log. Pairs with 3.3c (`.cnodeview-tab` convergence for Text/Notes) and the `customGraph` menu convergence.
- [ ] **Mobile (later).** Hover-reveal has no true touch equivalent; plan: on coarse pointers default the bar **pinned** (always shown) or reveal via a tap-toggle / edge affordance rather than hover; ensure icons are touch-sized (≥32px). Noted in DESIGN-LANGUAGE.

### Review findings (DRY + UI agents, 2026-06-22)
- [x] **FIXED:** uiBar disposal leak (C1) · double-`makeDraggable` cleanup-orphan leak (C2, chained `_dragCleanup`) · `CNodeTabbedCanvasView` dead-code removal + dispose double-free (H3/L5) · `_headerHovering` stuck-on-hide (H1) · `pointercancel`/touch (H2) · shared `_propagateDragToDependents` helper (DRY) · stable `data-uibar-action` selector + `aria-label`s + legible pinned state (M3/L1/L2) · targeted header event-blocking so `wheel` passes through to the view (M4) · stale `#3a3a3a` token fallback → `#303030` · LAYOUT-MODEL overlay-vs-inset doc fix. All 13 scenarios pass; MCP-verified incl. clean reload/dispose.
- [ ] **DEFERRED (tracked):**
  - lil-gui dropdown clipping inside `overflow:hidden` view divs — verify tall menus aren't clipped; may need a body-level dropdown or capped height+scroll (M3-UI).
  - Per-view menu **outside-click dismiss** (currently only the title toggles it) (M5-UI).
  - Header `z=60` vs high-z instrument overlays (compass `z=10000`) where they overlap the top strip (M2-UI).
  - **Resize is not Q-gated** (move requires Q, edge-resize is always-on) — reconcile with the DESIGN-LANGUAGE "Q gates move + resize" claim, or update the doc (L4-UI).
  - CUIBar inline styles → token-driven **CSS classes** in `extra.css.js` (M4-DRY); name the `z-index:60` as a `--sitrec-z-*` token.
  - Extract the duplicated **scenario geometry eval** into `scenarios/lib/` (M2-DRY).
- [x] **Header colour → Blender `#303030`** (`--sitrec-bg-header`); "keep close to Blender" — resolves the earlier light-vs-dark colour question.
- [ ] **3.4** Populate the overlay with per-view controls (Phase-4 content): editor-type, overlay toggles, fullscreen, nav/zoom (top-right, Blender-style).
- [ ] **3.5** The regression **30px cropTop / single-menu-bar assumption** — likely unaffected (overlay = no geometry change), but re-verify pixel baselines once the header lands.

## Phase 4 — Surface common actions as viewport controls
- [ ] **4.1** Shared **playbar/scrubber** (biggest win): wire to `KeyBoardHandler` (space/←/→/`<`/`>`) + `KeyframeRegistry` jump-to-event. No on-screen transport exists today.
- [ ] **4.2** Per-view-type control sets — 3D/main: northUp, yCompress, atmosphere, effects; look: FOV/zoom, lock-track; video: zoom, grid/mask/annotate toggles; all: fullscreen, view-switch, overlay-toggle.
- [ ] **4.3** Standardise on a control pattern: extend the `CNodeAnnotateOverlay` DOM icon-toolbar template, or add a `GUI.prototype.addIconButton` factory (built on existing `addHTML`) in `lil-gui-extras.js`.
- [ ] **4.4** (D4) Replace vs mirror shared controls.

## Phase 5 — Menu reorganisation & renaming
- [ ] **5.1** Reorder top-level menus + surface common items; **rename confusing items** keeping `_menuId` stable + populating `_serializationAliases`; update API paths from the 0.5 audit.
- [ ] **5.2** Add context-specific **per-view menus** (in the headers from Phase 3).
- [ ] **5.3** Migration shim for subfolder open/closed state (serialized by title).

## Phase 6 — Design language & governance
- [ ] **6.1** Finalise DESIGN-LANGUAGE.md (tokens, components, icons, motion, interaction).
- [ ] **6.2** "New control/view/instrument" checklist enforced in review.

---

## Done log
- **2026-06-22** — Planning: surveyed architecture, locked decisions D1/D2/D3/D5, wrote README/ARCHITECTURE/DESIGN-LANGUAGE/LAYOUT-MODEL docs; extracted Blender 5.1.2 theme tokens via MCP.
- **2026-06-22** — Phase 0.1+0.2: layout geometry safety net (SitCustom + Layout Test user sitch; 2 scenarios + baselines, both PASS).
- **2026-06-22** — Phase 0.4: design tokens in extra.css.js (Blender-grounded, value-preserving; new header/area/header-h tokens for Phase 3).
- **2026-06-22** — Phase 1 core: unified view-interaction gesture (all movable views → Q) via CNodeView centralization + VIEW_EDIT_KEY; verified 20/20 live on MCP; interaction-uniformity scenario pins it. Parallel-drag classes (Chart/Text/Notes/Tabbed) deferred (UX fork, ties to Phase 3 headers).
- **2026-06-22** — Phase 3.1/3.2: per-view header overlay (title + pin), hover-reveal, non-serialized; OVERLAY design verified render-unchanged live (canvas dims identical when shown). Decided design: all views get a header (resolves 1.3b).
- **2026-06-22** — Phase 3.2b: `CUIBar` component (src/CUIBar.js) — header bar with title + menus (lil-gui) + icon buttons + pin; CNodeView header uses it. Verified live: addMenu creates a real menu AND rendering unchanged.
- **2026-06-22** — Phase 3.3a/b: header = drag handle; FOV/tabbed-editor menu migrated onto CUIBar (verified "FOV Editor" menu on header). Header colour → Blender #303030. Added UI-TEST-CHECKLIST.md (automated + manual).
- **2026-06-22** — UIBar Stage 1: friendly capitalised view names; title is a lil-gui menu; pinned-by-default; ✕ close icon (with fullscreen+pin, stable data-uibar-action); hover-reveal refined to bar-strip + no-button-held. Verified live; 11 scenarios pass. Stage 2 (Assistant migration) + mobile scoped.
- **2026-06-22** — UIBar polish: restored "Close" item to the tabbed/custom-graph menu; dropdown floats absolute so opening a menu doesn't move the title/bar.
- **2026-06-22** — Whole UIBar draggable + drag clamping: the title/menu area now drags the view too (only dropdown *items* block dragging); the title toggles its menu on a **tap** (pointerup w/ no move) so *dragging* the title doesn't open it; lil-gui's native mousedown toggle suppressed (gated via `_uibarAllowToggle`). And a window can no longer be dragged **off the top** — `clampBelowMenuBar` snaps it under the menu bar during drag + on drag-end (replacing the old "drag off top to close", now covered by ✕). Verified live.
- **2026-06-22** — Header ✕ close is now **undoable**: `CNodeView.closeViewWithUndo()` hides the view and pushes an `UndoManager` action (`undo`→reopen, `redo`→close). Verified live (Undo reopens "Close Look view", Redo re-closes).
- **2026-06-22** — UIBar menu-toggle fix: the per-view menu toggles on lil-gui's NATIVE title `mousedown`; removed the redundant `click` handler that double-toggled (caused empty `video` menu to open + custom-graph "flash then vanish"). Empty menus gated at `openAnimated`. **Compass + HUD instruments (`CNodeViewUI`: compass, videoInfo, MQ9UI, …) now opt out of the UIBar** via `v.noUIBar`. Verified live.
- **2026-06-22** — Code review (DRY + UI-programming agents) of all changes + plan; fixed lifecycle/leak issues (uiBar dispose, double-makeDraggable cleanup, tabbed-view dead code/dispose), hover-state robustness (stuck-on-hide, pointercancel), DRY (shared drag-propagate helper, data-action selector), a11y (aria, pin legibility), targeted event-blocking, + doc fix. 13 scenarios pass; deferred items tracked in Phase 3.
- **2026-06-22** — BUGFIX (fullscreen icon) — REAL root cause (found via instrumentation + capturing the live bad state): the header fullscreen icon called `doubleClick()` which set `fullscreenView` + resized the view, but **did NOT arm a render**. The other-view hide + z-order happen in `renderMain` (`computeEffectiveVisibility`/`updateDOMVisibility`/`updateZOrder`), which under render-on-demand only runs when `setRenderOne` wakes the loop. The native double-click path arms it (`onDocumentDoubleClick`); the icon path didn't — so fullscreen left every other view visible, nondeterministically ("depends how I hovered" = whether some other thing woke a render). NO mouse double-click was involved. **Fix:** `doubleClick()` now calls `setRenderOne(true)`. Verified live (icon click alone → others hide). Guard `fullscreen-toggle-custom` rewritten to assert the toggle ARMS a render (the old version used a manual `computeEffectiveVisibility` that masked the bug). Two earlier changes from chasing the wrong diagnosis are kept as legit improvements: `blockViewEvents(uiBar.bar)` (header clicks shouldn't reach view content) + explicit FOV-menu click-toggle in `CUIBar.addMenu` (forked lil-gui has no native root-title toggle). All 13 scenarios pass.
