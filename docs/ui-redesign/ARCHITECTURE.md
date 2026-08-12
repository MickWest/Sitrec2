# Sitrec UI — Current Architecture Digest
_Provenance: produced 2026-06-22 from a 7-subsystem code survey (view/window core, drag/resize/dock, menu/lil-gui, sitch layout+serialization, styling, viewport overlays, regression). Line numbers are approximate. This describes the system as-is, before the redesign._

# Sitrec UI Redesign — Cross-Cutting Architecture Digest

Scope note: This synthesizes 7 subsystem readers. Where readers disagree on exact line numbers (they read independently), I cite the file + function/field name and flag the number as approximate. Two readers gave slightly different line counts for the same files (e.g. `CNodeView.js` ~1000–1211, `lil-gui-extras.js` ~2800–2919) — treat those as approximate.

---

## 1. CURRENT ARCHITECTURE

### View/Window model
- **Base class `CNodeView`** (`src/nodes/CNodeView.js`, ~1210 lines). Every view is a `CNode` (so it has `modSerialize`/`modDeserialize`) AND owns one absolutely-positioned `div` inside the `#Content` container. The div is created **bare**: `position:absolute` + px `top/left/width/height`, `zIndex 1`, `pointerEvents:auto`, and the border/background lines are **commented out** (~lines 148–150). **There is no per-window header/title bar and no chrome anywhere.** This is the central gap for the Blender redesign.
- **Positioning is fractional.** Each view stores `this.left/top/width/height` as fractions 0..1 of its *container*. The **negative-value aspect-lock convention** is load-bearing: `height<0` ⇒ `widthPx = containerW*width`, `heightPx = containerW*width*(-height)` (so `width:0.25,height:-1` = a square ¼ the container width; `height:-0.5625` = 16:9 from width); `width<0` is the symmetric off-height case.
- **`updateWH()`** (`CNodeView.js` ~517) is the single chokepoint that turns fractions → px and writes `div.style.*`. It has special branches for the **mainView center-sidebar split** and an early-return `updateDockedWH()` for docked views. **`setFromDiv(div)`** (~477) is the inverse: reads `div.clientWidth/offsetLeft/...` back into px then back-computes fractions (preserving the aspect convention via `freeAspect`).
- **Per-frame loop** (`src/indexRender.js` ~475–549): for each effectively-visible view → `setFromDiv()` → `updateWH()` → (3D) camera/preRender → `renderCanvas()`. `updateWH` runs every frame for every visible view, gated by `oldWidth/oldHeight` so `changedSize()` only fires on actual change. `changedSize()` debounces WebGL `renderer.setSize` 100ms (`deferredResizeWebGL`); 2D views set `_pendingCanvasResize`.
- **Canvas-per-view.** `CNodeViewCanvas` (`src/nodes/CNodeViewCanvas.js`) appends a `<canvas>` at `top/left:0, width/height:100%` of the div. **`CNodeView3D`** (`src/nodes/CNodeView3D.js`, ~3787 lines) `setupRenderPipeline()` creates a **dedicated `WebGLRenderer` per view** bound to that canvas. So each 3D view is an independent GL context — a many-area Blender layout multiplies contexts (side-by-side already drops to 0.7 resolution scale).
- **Two nesting mechanisms** (distinct): `overlayView` — child SHARES the parent's div (`this.div = overlayView.div`, no own div; used by HUDs/`CNodeViewUI`, `inheritSize()` copies parent rect each frame); `relativeTo` — child has its OWN div but its 0..1 rect is interpreted against the parent's px rect.

### Manager + page shell
- **`ViewMan` = `CViewManager` singleton** (`src/CViewManager.js`, ~234). Owns `container` (`#Content`), the coordinate space (`topPx=24` hardcoded menu offset, `leftPx=0`, `widthPx`, `heightPx = container.offsetHeight - topPx` via `updateSize()`), `fullscreenView`, `updateZOrder()` (every frame: non-overlay views sorted by `scriptZ`, then `alwaysOnTop`, then **area descending — bigger area = lower z** so small floaters sit on top), `computeEffectiveVisibility()/_computeEV()/updateDOMVisibility()`, and `restoreFullscreenFromMods()`.
- **`PageStructure.setupPageStructure()`** (`src/PageStructure.js`, ~532) builds `#Content` (absolute, `height: calc(100% - (CONTROLS_HEIGHT+10+4)px)`, overflow hidden) and `#ControlsBottom` (frame slider, 20px). Constants: `CONTROLS_HEIGHT=20`, `MENU_BAR_HEIGHT=25`, `SIDEBAR_WIDTH=250`. Builds Left/Right/Center sidebars (`#1a1a1a`, 250px) which are docking targets AND lil-gui hosts, plus the center-divider split logic.

### Menu / lil-gui model
- **One menu bar: `CGuiMenuBar`** (`src/lil-gui-extras.js`, ~2919; lines 722+ is the class), instantiated once as **`Globals.menuBar`** (`src/index.js` ~1682). It's a black 25px top bar with ~20 fixed slot divs. All ~19 top-level menus are created up front in `index.js` (~1690–1781): main, file, view, video, time, objects, satellites, terrain, physics, camera, target, traverse, showhide (with showhideviews/graphs subfolders), effects, lighting, contents, help, debug. Initial visibility restricted to main/file/help via `menuBar.showOnlyMenus`.
- **`Globals.guiMenus{}`** (`src/Globals.js` ~331) is the registry keyed by stable string `_menuId`. Registration via `addGUIMenu/addTranslatedGUIMenu` (top-level = `menuBar.addFolder().close().perm()`) and `addGUIFolder/addTranslatedGUIFolder` (subfolders). `.perm()` marks menus that survive `menuBar.destroy(false)` on sitch change.
- **lil-gui is VENDORED-AND-FORKED** (`src/js/lil-gui.esm.js`, ~2900). Sitrec added `GUI.prototype.perm()`/`Controller.prototype.perm()` directly in it. **The only design-token system in the app lives here**: CSS custom properties on `.lil-gui` (~1670–1696): `--background-color:#1f1f1f`, `--title-background-color:#111`, `--widget-color:#424242`, `--hover-color:#4f4f4f`, `--text-color:#ebebeb`, `--number-color:#2cc9ff`, `--font-size:11px`, `--widget-height:20px`, `--name-width:36%`. New control types should be added as prototype patches in `lil-gui-extras.js`, NOT by editing the vendored file.
- **Drag/undock/dock**: each menu has `.mode` ∈ DOCKED/DRAGGING/DETACHED/SIDEBAR_LEFT/RIGHT/CENTER. `handleTitleMouseDown` drags a whole menu out → docks to a sidebar (`PageStructure.addMenuToLeftSidebar` etc.). Subfolders tear out via `_makeFolderDraggable`/`_detachFolder`/`restoreFolderToParent` (a comment-node placeholder marks the restore slot so the children array stays intact). `createStandaloneMenu(title,x,y,dismissOnOutsideClick)` builds context menus (canonical caller: `CustomManagerMenus.showGroundContextMenu`).
- **`setMenuValue`/`getMenuValue` is NOT a UI helper — it's the `CSitrecAPI` action layer** (`src/CSitrecAPI.js` ~1747–1819) used by the MCP bridge, in-app AI/NLU, and Scripted Video. `_findController` walks `guiMenus[menuId]` by a `'Folder/Sub/Control'` path and calls `controller.setValue()`. **Renaming a menu title or control `.name()` breaks any string-path caller** unless `_serializationAliases`/paths are updated.

### Sitch declaration + serialization
- **Two definition paths** (`src/SituationSetup.js`, `SetupFromKeyAndData()`): (1) data-driven — top-level keys (`mainView`, `lookView`, `videoView`, `dagView`, `speedGraph`, etc.) whose value is a rect object, spread over hard-coded defaults (e.g. mainView `{left:0,top:0,width:.5,height:1, draggable,resizable,freeAspect}`); (2) imperative — `new CNodeView3D({left,top,...})` inside a custom `setup()` (e.g. `SitVideo`). Per-view drag defaults (`dragKey:"Q"`, draggable/resizable/freeAspect) set in `SituationSetup.js` (~688/719/766/803).
- **Save** (`src/CustomManagerSerialize.js`, `getCustomSitchString()` ~99): iterate ALL nodes, `node.modSerialize()` → `out.mods[node.id]`. Views chain `CNode.modSerialize` → `CNodeView.modSerialize` (spreads `simpleSerialize(toSerialCNodeView)`). `out.guiMenus = Globals.menuBar.modSerialize()` persists menu open/closed by **title**. Empty mods and the lone `{visible:true}` are dropped; `doubled` forced false on non-fullscreen views.
- **Restore**: `deserializeMods()` iterates `mods` by id, `node.modDeserialize()` inside try/catch (one bad mod skipped). `simpleDeserialize` skips undefined keys (old saves keep defaults — additive-safe). Fullscreen deferred to `CViewManager.restoreFullscreenFromMods()` after all mods apply.

---

## 2. THE SNAPPED-LAYOUT GAP

### What exists today (`src/DragResizeUtils.js`, ~969)
- **Floating/overlapping MDI model — the OPPOSITE of Blender's gap-free tiling.** Views are absolutely-positioned floats.
- **Move**: `makeDraggable()` — document-level pointer listeners. For main/look/video views drag only starts if the **`dragKey:"Q"`** modifier is held. The bridge is `CMouseHandler.handleMouseDown` (~102–106): if `view.dragKey` held, the canvas handler returns early and does NOT `setPointerCapture`, so the event bubbles to the div's `makeDraggable`. So **Q converts camera-drag into window-move**. There is **no pop-out-to-OS-window**; "detach" only means dragging a docked panel out of a sidebar (`undockFromSidebar`).
- **Resize**: `makeResizable()` creates **8 invisible 10px handle divs** (n/e/s/w + corners), straddling each edge by `-HANDLE_HALF`(5px). **Edge-drag hit-testing IS entirely these per-view handle divs — there is NO global geometric "near a shared edge" test.** Resize affects ONLY the dragged window; neighbors untouched. Min 20px.
- **Snap is cosmetic only**: `calculateSnap()`/`calculateResizeSnap()` (lines ~153–258) magnetize the moving edge to screen edges + other views' edges within `SNAP_DISTANCE=10px`, but **never move/resize the neighbor**. Flush edges are coincidental, not coupled.
- **`updateAllHandlePositions()`** (~266–334) is the closest thing to shared-edge awareness: it shifts a view's handles inward when a neighbor edge is within `HANDLE_SIZE`, so grab zones don't overlap. It computes neighbor-edge proximity (`vOverlap/hOverlap`) but only repositions grab zones.
- **Maximize exists**: `doubleClick()` (`CNodeView.js` ~788) toggles `doubled`, saves `preDoubled*`, expands to fill (preserving the negative-aspect convention), sets `ViewMan.fullscreenView`. This ≈ Blender Ctrl+Space.

### What a Blender snapped-tiling layout needs, and where it hooks
- **An area/edge-adjacency tree** (vertical/horizontal splits) replacing independent fractions — does not exist; the flat `ViewMan` list + `relativeTo` chains are the nearest scaffold.
- **Shared-edge splitters that resize BOTH neighbors.** Two candidate hooks: (a) extend `calculateResizeSnap()` — it already iterates all neighbors and identifies the matched edge — to apply the inverse delta to the matched neighbor and call `updateWH()`/`setFromDiv()` on both; (b) replace per-view handle divs with dedicated splitter elements between panels. `updateAllHandlePositions()`'s neighbor-pairing geometry can seed an **edge adjacency map**.
- **Per-area header bar** — net-new DOM (see §4). A header consuming vertical pixels must inset `updateWH`'s `heightPx` (a parallel branch alongside `updateDockedWH`) AND be added back in `setFromDiv`, AND the canvas's `100%/100%` fill must become div-minus-header.
- **Strict non-overlap** conflicts with the area-descending z-order heuristic in `updateZOrder()` — a tiled model doesn't need it, but overlay HUDs, `scriptZ`, and `alwaysOnTop` floaters still do (hybrid stacking needed).
- **Coexistence with sidebar docking** (`DOCK_EDGE_PX`, Left/Right/Center sidebars) — orthogonal existing "snap" system that a Blender edge-snap may supersede or wrap as Blender N/T-panel regions.

---

## 3. SERIALIZATION COMPAT SURFACE (must stay backward compatible)

The persisted layout schema (DO NOT change meaning):

- **`toSerialCNodeView = ['left','top','width','height','visible','doubled','preDoubledLeft','preDoubledTop','preDoubledWidth','preDoubledHeight']`** plus conditional **`dockedSidebar`** (`'left'|'right'`). All in `CNodeView.js`.
  - `left,top`: fraction 0..1, top-left origin.
  - `width,height`: fraction; **NEGATIVE = aspect-lock multiplier off the other axis.** This sign-overloading is the #1 compat hazard — every built-in sitch def relies on it (`SitGoFast` `lookView:{width:-1,height:0.4}`, `SitVideo`, etc.) and so do `freeAspect`/`doubleClick`/many overlays. **Do not reinterpret negative width/height.**
  - `doubled` + `preDoubled*`: fullscreen state; only the true `fullscreenView` serializes `doubled:true`. Two-phase restore (modDeserialize defers → `restoreFullscreenFromMods` reconciles single/repairs multi) must be preserved.
- **`mods` map keyed by stable `node.id`** (`mainView`, `lookView`, `video`, `video2`, `dagView`, graph ids, `<shortName>_ob`). This id is the join key between a freshly-built sitch and its saved layout. **Renaming a view id silently orphans saved layout** (deserialize just warns + skips).
- **Menu state** (`out.guiMenus = Globals.menuBar.modSerialize()`): top-level keyed by `_menuId` (stable, with `_serializationAliases` fallback) — so renaming a menu **display title is fairly safe IF `_menuId` stays and the old title is added to `_serializationAliases`**. BUT **subfolder open/closed state is serialized by folder TITLE string** (`_serializeFolderStates` reads `f.$title.innerHTML`) — renaming a subfolder silently drops its saved expand/detach state.
- **Overlay/instrument serialized fields** (all in saved sitches): MQ9 display modes, VideoInfo per-item X/Y + show flags + fontSize, Annotate strokes/tool/color, Tracking keyframes `[{x,y,frame}]` (source-indexed, with a pre-2001001 percent-of-height legacy conversion + a `videoLoaded`-deferred frame translation in modDeserialize — must not be disturbed), Grid settings. Coordinate basis (percentage vs **original-video-pixel**) must not change.

### Where to layer a new model without breaking old saves
- **`simpleDeserialize` is forgiving** (skips undefined; only reads listed keys) → **ADDING a new field to `toSerialCNodeView` is safe both directions.** This is exactly how `dockedSidebar` was added.
- **Recommended pattern** (mirrors `dockedSidebar`): add a NEW optional descriptor (e.g. `gridCell:{col,row,colSpan,rowSpan}` or a named layout-slot) **alongside** the existing four fractions. In `modDeserialize`/`updateWH`, branch: if the new descriptor is present, resolve it to px (parallel to `updateDockedWH`'s early-return); else fall back to the legacy fractional rect. **Keep `setFromDiv` populating the legacy fractional rect as a fallback** so saves remain loadable by older builds (which ignore unknown fields).
- **Version gating exists**: `out.exportTagNumber` (int = major*1e6+minor*1e3+patch) is read on deserialize and already drives legacy remaps (`remapLegacyTrackMods`, `deprecatedIds`) — a clean hook for version-gated migration.
- **Open design choice**: per-view in `mods[id]` (keeps id-keyed try/catch isolation) vs a new top-level `out.layout`/`out.workspaces` envelope (cleaner whole-window grid, needs its own deserialize ordering). Readers lean toward per-view-additive for compat.
- **Caveat**: serialization is gated by `Sit.isCustom` — only the custom sitch fully round-trips; **built-in sitch layouts are validated only by the pixel gate**, not by save/load.

---

## 4. EXTENSION POINTS (and risk)

| Extension | Where | Risk |
|---|---|---|
| **Arbitrary DOM as a control** | `GUI.prototype.addHTML(html,label)` (lil-gui-extras) — already exists | **Low.** An icon-button row / mini-toolbar can be built today, zero core change. |
| **New `addIconButton` factory** | `GUI.prototype.addIconButton = ...` in `lil-gui-extras.js` built on `addHTML` | **Low-med.** Bypasses the Controller value/listen/serialize lifecycle — fine for stateless buttons, not for serialized state. Preferred over editing vendored file. |
| **New Controller subclass (icon/toolbar)** | edit vendored `lil-gui.esm.js` | **Med-high.** Clean lifecycle integration but future-merge pain; existing `_notifyMenuBarChanged` wrappers assume current `add/addFolder` signatures. |
| **Per-view header bar** | new child div in `CNodeView.div` (~128), host a lil-gui via `new GUI({container:headerDiv, autoPlace:false})` (same pattern as `createStandaloneMenu`) OR plain DOM | **High.** Net-new concept. Must inset canvas + all HUD overlays (overlayView shares the div → header would clip 100%/100% HUD canvases), feed `changedSize`/`deferredResizeWebGL`, and either inset or sit-outside serialized rect. Also lil-gui is dark-themed → needs CSS override for "light grey". |
| **Per-view control ownership** | give each view its own GUI; reroute `guiMenus.view.add(...)` calls | **High & wide.** Today there is NO view→control registry; controls are added imperatively by whatever node calls `guiMenus.<id>.add`. Surfacing per-view requires inventing that registry, and touches `CNodeView3D` + many nodes. `CustomManagerMirror` (`src/CustomManagerMirror.js`) is the existing mechanism if you want to DUPLICATE rather than MOVE controls. |
| **Theme tokens** | `:root{--sitrec-*}` in `extra.css.js` + alias lil-gui's `.lil-gui` vars to them | **Low** (cosmetic, not serialized) but breaks pixel baselines. |
| **Reorder/rename top menus** | reorder `addTranslatedGUIMenu` calls in `index.js` | **Low for layout restore** (keyed by `_menuId`) but **breaks `setMenuValue` string-path callers** (MCP/AI/Scripted Video) — audit needed (see §8). |
| **New context/floating panel** | `createStandaloneMenu()` | **Low.** Full drag/dock/Escape support already. |
| **Drag via header handle** | `makeDraggable`/`makeResizable` already accept `options.handle` (used by `TrackFilterDialog`, `ScriptEditorWindow`) | **Low.** Header bar can be passed as the drag handle. |

---

## 5. EXISTING VIEWPORT CONTROLS & SURFACING CANDIDATES

All in-viewport UI is a stack of **2D canvas overlays subclassing `CNodeViewUI`** (`src/nodes/CNodeViewUI.js`, extends `CNodeViewCanvas2D`), bound to a host via `overlayView`/`relativeTo`. Provides percentage coords (`px/py/sx/sy`, `rLine`), named text elements (`.listen(obj,prop,fmt)`), and `ignoreMouseEvents()` by default (clicks pass through to camera). Render-on-demand with per-instrument dirty-checks — **load-bearing for CPU**; forcing continuous redraw would regress the render-one-arming bug class.

Existing instruments:
- **`CNodeCompassUI`** — compass rose + heading/elevation, wind arrows. Already interactive (click = snap-to-north on mainView / toggle elevation on lookView).
- **`CNodeMQ9UI`** (~745) — full reaper OSD, clickable fields cycle units (pointer-events toggled via a document-level mousemove — fragile, preserve or replace wholesale).
- **`CNodeATFLIRUI`**, **`CNodeVideoInfoUI`** (~1033, draggable serialized items), **`CNodeSimInfoUI`**.
- **`CNodeAnnotateOverlay`** (~1445) — **the most complete existing pattern: a real floating DOM icon TOOLBAR** built in `overlayView.div` (`_makeIconButton` with SVG icons, hover, color/width inputs, undo/clear/Done, single-letter hotkeys, `stopPropagation`). This is the template for any new per-view toolbar.
- **`CNodeActiveOverlay`** + `CDraggableItem/Circle` — standardized mouse-interactive draggable overlay base (Tracking, Speed, Mask reuse it).
- **`CNodeGridOverlay`**, **`CNodeMaskOverlay`**, **`CNodeSpeedOverlay`**.
- **`CNodeControllerPTZUI`** — drag-to-steer look camera (no on-screen buttons).
- **3D view DOM badges**: mainView "Y-compress=N.Nx" indicator (`updateYCompressIndicator`, gated `if(this.id!=='mainView')` — per-view conditionals are ad-hoc by id string), hidden VRButton.

**Highest-value BURIED actions to surface per view type** (currently only via global keyboard or deep menus — there is **NO on-canvas playbar/scrubber, view-switch, zoom buttons, or fullscreen affordance** besides double-click):
- **All views**: fullscreen/maximize (only `doubleClick`), view-switch/editor-type selector (doesn't exist), overlay-toggle dropdown.
- **Timeline/playback** (`src/KeyBoardHandler.js`): space=play/pause, ←/→=step frame, `<`/`>`=prev/next keyframe (`KeyframeRegistry`) — **no on-screen control at all**. A shared playbar is the biggest surfacing win; `KeyframeRegistry` already abstracts jump-to-event.
- **3D/main**: northUp, yCompress, atmosphere, effects toggles (in global `guiMenus.view`/lighting/effects).
- **look/camera**: PTZ/FOV/zoom (drag-only today), focus/lock track.
- **video**: zoom (wheel + menu slider — confirm if any visible control), grid/mask/annotate toggles.

Standardization seam: a single new `CNodeViewUI` subclass (or per-view header) attached at **one creation point** — but readers flag uncertainty on whether overlays are created uniformly (`CommonSitch`/`SetupCommon`) or per-sitch (`JetStuff` for Gimbal). **Confirm the single creation point before building a universal control bar.** Globals like `showCompassElevation/showSimInfo/arMode` are global, not per-node — surfacing per-view needs care.

---

## 6. DESIGN-LANGUAGE STARTING POINT

**There is no static app stylesheet and no design-token module.** (`grep` for tokens.js/theme.js/`:root`/`--sitrec` in src returns nothing.) HTML is generated by HtmlWebpackPlugin (title/meta only). The deployed `index.css` (`/Users/mick/Sites/UI/index.css`) contains **only vendored uPlot chart styles** — not app chrome.

App look comes from three imperative layers:
1. **lil-gui's injected stylesheet** (`src/js/lil-gui.esm.js`) — the **only real token system**, dark theme via `.lil-gui` CSS vars (scoped to `.lil-gui`, NOT `:root`, so non-lil-gui DOM can't reuse them). Values in §1.
2. **`src/extra.css.js`** — a JS template string (~290 lines) injected by `injectExtraCSS()` (`index.js` ~1983) one rAF after startup so it wins the cascade. Overrides lil-gui (menu tabs, dropdowns, folder borders `#FFFFFF`/`#202030`, body font). **Footgun: C++ `//` comments are stripped before injection** — new CSS must avoid `//` in url()/values.
3. **~40 files of ad-hoc inline `element.style`/`cssText`** (lil-gui-extras 196 occurrences, PageStructure 114). Every dialog hardcodes its own palette.

Current state to unify:
- **~15 dark surface hexes** (#1f1f1f, #111, #1a1a1a, #2a2a2a, #202030, #101418, #000…), **widget greys** (#424242/#4f4f4f/#595959/#333–#757575), **near-whites** (#ebebeb/#eee/#f4f7fb), **accents** (#2cc9ff slider/number, #1976d2 primary blue, #0080ff links, frame-marker #00ff00/#0088ff/#ffcc00/#ff0000, #d32f2f error, rgba(100,150,255,*) drag highlight, #377e22 banner green).
- **FOUR font conventions coexist**: lil-gui sans 11px (28px touch=13px), body Monospace 20px (extra.css), dialogs Arial/sans 12–18px, uPlot system-ui 14–18px. Blender uses one UI font ~11–12px.
- **Modals are inconsistent**: `showError.js` is LIGHT (white, #1976d2), `TextPrompt.js` is dark glass (#101418), `TrackFilterDialog.js` has a real `#333` titleBar header, `ScriptEditorWindow.js` (newest) has a dark `cursor:move` header — **the closest existing prototype to the desired per-window header**, but dark not light-grey.
- **Iconography**: a single PNG sprite sheet `data/images/video-sprites-40px-5x3-dark.png` for transport; lil-gui's glyph arrows for folders. **No SVG icon set / icon font** (except lil-gui's). Annotate's toolbar uses inline SVG.

**Recommended seam**: define one `:root{--sitrec-*}` token set in `extra.css.js`, alias lil-gui's `.lil-gui` vars to them, add shared `makePanel/makeButton/makeHeaderBar` helpers to replace the ~40 files of copy-pasted hex. Layout knobs: `MENU_BAR_HEIGHT`/`SIDEBAR_WIDTH` (PageStructure), `barHeight`/`baseZIndex` (lil-gui-extras), `ViewMan.topPx`.

---

## 7. VERIFICATION STRATEGY

### What exists
- **Fast visual-regression harness** (`tests_regression/fast-regression/run.mjs`, ~777). Enumerates **"Regression"-labelled sitches** from the server (auto-grows by tagging — no code change), loads each in real Chrome (ANGLE Metal, warm-cache profile), `waitForSettle()` (polls pendingActions/loadingTerrain/tile flags + frame-ready gate, `minWaitMs=3000` floor, `stableChecks=20`), forces a render (`setRenderOne(true)`+double-rAF+`gl.flush()`), screenshots a **fixed clip `{0,30,1920,1050}` — top 30px cropped because of the live clock**, pixelmatch vs baseline at `maxDiffRatio=0.001` (0.1%). **Flake-recovery solo retry.** Pixel baselines are **LOCAL-ONLY/gitignored** (env-specific: headed vs headless ANGLE, Metal vs CI SwiftShader differ) — each machine regenerates with `test-fast-update`.
- **Scenario harness** (`run-scenarios.mjs` + `stepRunner.mjs`): **committed env-independent JSON value baselines** (`value-baseline/*.json`, currently 9, all custom-sitch). Drives `window.sitrecAPI` (97 fns incl. `listViews`, `setLayout`, `getMenuValue/setMenuValue`, `exportSitchState`). **This is the trustworthy logic gate.**
- **Playwright suite**: `regression.test.js` (committed platform-suffixed PNGs), `save-load-roundtrip.test.js` (custom sitch only: isCustom/nodeCount/name + pixels A==B), `ui-menu-sweep.test.js` (toggles every control, asserts no new console errors — validates wiring, not geometry/serialization).
- URL contract: `?custom=<url>`/`?sitch=<key>` `&regression=1 &frame=N &ignoreunload=1 [&regressionLocalTerrain=1]`.

### Documented GAPS the redesign must fill (SCENARIO-HARNESS-PLAN Areas 10 & 11, proposed not implemented)
- **No per-VIEW geometry round-trip assertion** — a layout-engine change silently corrupts saved geometry; pixel gate only catches the *composited* render. **Add a scenario**: `setLayout`/move-resize → `exportSitchState` → assert `mods[viewId].{left,top,width,height,visible,doubled,dockedSidebar}` against a committed value-baseline. Extend `save-load-roundtrip.test.js` to assert per-view geometry survives.
- **No per-view pixel capture** — a lookView/header regression is masked by mainView in the single composited shot. Plan proposes per-view captures keyed by view id.
- **No menu-serialization round-trip** (guiMenus open/closed by title) — directly at risk if menus are renamed/restructured.
- **No `listViews` fractions baseline** — committed JSON of each view's rect so a layout change is a readable diff.

### Recipe (per memory)
`npm run build` first (build IS the deploy to `/Users/mick/Sites`), run **sandbox-OFF**, headless default. **Baseline ONCE on clean pre-redesign main**, then each step: `test-fast` (pixels — review-then-rebaseline, never reflex-rebaseline a regression), `test-scenarios` (committed values — the real gate), `test-ui` (roundtrip + menu sweep). The **30px cropTop + single-top-menu-bar assumption is baked into run.mjs** — a per-area-header redesign needs this parameterized or the whole suite re-baselined.

---

## 8. TOP RISKS & UNKNOWNS (ranked)

1. **Saved-layout geometry corruption (silent).** A new layout model or per-view header that changes how `widthPx/heightPx` derive from the fractional rect will mis-position EVERY saved + built-in sitch. The negative-width/height aspect convention is load-bearing across `updateWH/setFromDiv/doubleClick/freeAspect`. *Resolve:* layer a NEW optional descriptor alongside the four fractions (never repurpose them), keep `setFromDiv` writing the legacy rect, and build the **per-view geometry round-trip value-baseline FIRST** (current gap). *Open Q:* per-view `mods[id]` vs top-level `out.layout`/`out.workspaces`?

2. **Per-view header bar coupling to the shared div.** `overlayView` HUDs draw into the SAME div at canvas `100%/100%`; a header inside the div clips them, and the canvas inset must flow through `changedSize`/`deferredResizeWebGL`. *Open Q:* header INSIDE `CNodeView.div` (inset canvas + all overlays) vs a WRAPPER div around div+canvas? The overlayView mechanism strongly couples to "div == canvas area" today.

3. **`setMenuValue` string-path breakage (MCP/AI/Scripted Video).** Renaming menu titles or control `.name()`s breaks string-path callers (`CSitrecAPI` hard-coded paths like `objects/<name>/width`, `CClientNLU`). *Resolve:* **audit `CSitrecAPI` hard-coded paths + `CClientNLU` before any rename**; keep `_menuId` stable + populate `_serializationAliases`. *Open Q:* full inventory of path-addressed controls not yet done.

4. **Subfolder open/closed state keyed by TITLE** (`_serializeFolderStates` reads `$title.innerHTML`) — renaming a subfolder silently drops saved expand/detach state on old sitches. *Resolve:* migration shim or avoid subfolder renames.

5. **Light-grey scope ambiguity** — does "per-window header bars on light grey" mean a **full app retheme to light/neutral** or **only the new headers are light while menus stay dark**? Drastically different scope (full retheme of lil-gui vars + ~40 dialogs vs additive). *Open Q — needs a product decision before any CSS work.*

6. **Pixel baselines will all break, by design.** Any chrome/header change fails every visual baseline; the 30px cropTop assumption breaks if the menu/clock moves. *Resolve:* planned intentional rebaseline pass + lean on committed VALUE baselines as the real gate. *Open Q:* who owns the canonical baseline in multi-dev/CI (CI uses SwiftShader, can't share Metal baselines)?

7. **No view→control registry** for per-view headers — controls are added imperatively to shared global menus by whatever node runs. Building per-area headers requires inventing this registry (wide change) OR using `CustomManagerMirror` to duplicate (doubles serialization concerns). *Open Q:* replace vs duplicate the shared `guiMenus.view/camera/target` controls?
   **RESOLVED (2026-08-12) — neither replace nor duplicate: MIRROR, with the registry split in two.** `src/ViewUIBarMenus.js` holds the declarative *what goes where* (`VIEW_UIBAR_MENUS`), while each control's creation site declares *what it is* with a one-line `registerViewMenuItem(viewId, slot, controller)`. The two halves meet through `src/MenuMirror.js`, which binds header row and global-menu row to the SAME lil-gui controller — so the imperative creation order stays exactly as it was, nothing extra is serialized, and a control the sitch never creates simply has no row. Kept honest by a static two-way scan in `tests/ViewUIBarMenus.test.js`.

8. **WebGL context budget.** Each `CNodeView3D` owns a `WebGLRenderer`+canvas; a many-area Blender layout multiplies GPU contexts (side-by-side already drops to 0.7 resolution scale). *Open Q:* is there a context budget / context-sharing plan?

9. **Z-order heuristic vs tiling.** `updateZOrder`'s area-descending stacking is meaningless for non-overlapping tiles but still needed for overlay HUDs, `scriptZ`, `alwaysOnTop`. *Open Q:* hybrid stacking model?

10. **Single overlay creation point unconfirmed.** A universal viewport control bar needs one creation site, but it's unclear whether overlays are wired uniformly (`CommonSitch`/`SetupCommon`) or per-sitch (`JetStuff`). *Resolve:* confirm before building. Also: built-in sitches can't be serialization-round-tripped (`Sit.isCustom` gate) — confirm whether built-in saved-layout fidelity is in scope.

11. **Authoritative Regression-sitch count unknown** — README says ~6, the SCENARIO plan says ~38. *Resolve:* run `npm run test-fast-list` sandbox-off before redesign to get the real coverage set.

---

Key files for the plan, by concern: layout math `src/nodes/CNodeView.js` (updateWH/setFromDiv/doubleClick/toSerialCNodeView) + `src/CViewManager.js`; drag/resize/snap `src/DragResizeUtils.js` + `src/CMouseHandler.js`; page shell/sidebars `src/PageStructure.js`; menus `src/lil-gui-extras.js` (CGuiMenuBar) + vendored `src/js/lil-gui.esm.js` + `src/Globals.js`; API/paths `src/CSitrecAPI.js`; save/load `src/CustomManagerSerialize.js` + `src/SituationSetup.js`; styling `src/extra.css.js` + `src/index.js` (injectExtraCSS); overlays `src/nodes/CNodeViewUI.js` + `CNodeAnnotateOverlay.js` (toolbar template); tests `tests_regression/fast-regression/{run.mjs,run-scenarios.mjs,SCENARIO-HARNESS-PLAN.md}` + `tests_regression/save-load-roundtrip.test.js`.
