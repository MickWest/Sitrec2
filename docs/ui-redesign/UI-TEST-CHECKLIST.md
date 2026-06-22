# UI Redesign — Test Checklist (automated + manual)

Living checklist for everything the redesign can affect. Update it as elements change.
Status: `[ ]` not covered · `[A]` automated & passing · `[M]` needs manual check · `[x]` manually verified this build.

## How to run the automated tests
- Build first (build IS the deploy): `npm run build`
- Value scenarios (committed JSON baselines — the trustworthy gate, sandbox-off):
  `node tests_regression/fast-regression/run-scenarios.mjs --filter=<custom|layout>`
- Pixel suite (local baselines): `npm run test-fast`
- Re-baseline a value scenario: delete its `value-baseline/<id>.json` and re-run (or `--update-values`).

## Automated coverage (scenario harness)
| Concern | Scenario | Status |
|---|---|---|
| Per-view geometry (left/top/width/height/visible) of SitCustom | `layout-geometry-custom` | [A] |
| Serialized-geometry round-trip (modSerialize) | `layout-geometry-custom` | [A] |
| `setViewPosition` move round-trip | `layout-geometry-custom` (`afterMove`) | [A] |
| Per-view geometry of the Layout-Test user sitch (tiling testbed) | `layout-geometry-layouttest` | [A] |
| Interaction uniformity — every movable view `dragKey="Q"`, `shiftDrag=false` | `interaction-uniformity-custom` | [A] |
| Existing SitCustom create/edit/synth/undo/time scenarios still pass | `custom-*` (9) | [A] |
| **Fullscreen icon arms a render** (so fullscreen actually hides other views; render-on-demand bug) | `fullscreen-toggle-custom` | [A] |
| **GAP**: header presence / render-unchanged-on-show as a committed scenario | _(verified via MCP eval; partially exercised by fullscreen-toggle-custom)_ | [ ] |
| **GAP**: FOV/tab menu lives on CUIBar + toggles | _(verified via MCP eval)_ | [ ] |
| **GAP**: menu-serialization round-trip (Phase 0.3) | _(deferred to Phase 5)_ | [ ] |

## Manual checklist — header / UIBar (per the decided design)
- [M] **Hover-reveal**: header fades in on pointer-enter, out on leave.
- [M] **Pin**: 📌 keeps the header shown when not hovering; click again to unpin.
- [x] **Render unchanged**: showing/hiding the header does NOT resize/shift the viewport — MCP-verified (canvas dims identical when shown).
- [x] **Header drag**: dragging the bar moves the view (MCP-verified leftPx 0→70); menu/icon/pin swallow pointerdown so they don't drag.
- [x] **Fullscreen icon** ⛶ toggles fullscreen; **double-click does NOT strand the view** (bug fixed + guarded by `fullscreen-toggle-custom`; `blockViewEvents` on the bar stops the dblclick leak).
- [x] **FOV/tab menu** opens/closes on header title click (explicit toggle in `CUIBar.addMenu`); controls present.
- [M] **Colour/theme**: header is Blender `#303030` (MCP-verified `rgb(48,48,48)`); confirm text legibility visually.
- [M] **Title**: shows `menuName` (falls back to view id).

## Manual checklist — interaction (Phase 1)
- [M] **Q-drag** still moves any view (hold Q + drag the body).
- [M] **Edge resize**: dragging a view edge resizes it (with snap).
- [M] **No bare-drag**: clicking+dragging a graph/view body WITHOUT Q does NOT move it (except via the header).
- [M] **Camera views**: orbit/pan in mainView/lookView works normally when NOT holding Q and NOT on the header.

## Manual checklist — per view type
| View type (class) | Elements to check | Status |
|---|---|---|
| 3D main / look (`CNodeView3D`) | header overlay above viewport; orbit unaffected; fullscreen icon; header-drag; HUD overlays (compass) still draw under header | [M] |
| Video (`CNodeVideoWebCodecView`) | header overlay; video scrub still works; header-drag; videoInfo overlay intact | [M] |
| Graphs / curve editors (`CNodeCurveEditorView`, `CNodeCustomGraphView`) | header; curve point editing still works; header-drag; menu (if any) opens | [M] |
| **FOV / tabbed editors (`CNodeCurveEditorView2`/`CNodeTabbedCanvasView`)** | **menu now on CUIBar header ("FOV Editor"); snap setting works; "Hide" closes the view; Y-range slider still works; canvas point-edit unaffected by menu** | [M] |
| Notes (`CNodeNotes`) | _still uses legacy `.cnodeview-tab` — NOT yet migrated to CUIBar (Phase 3.3); verify it still drags/works_ | [M] |
| Text (`CNodeViewText`) | _legacy `.cnodeview-tab`, not migrated; verify_ | [M] |
| DAG view (`CNodeViewDAG`) | resizable, not draggable — header shows, no header-drag | [M] |

## Regression watch — existing behaviour that must NOT break
- [M] Existing always-on instruments (compass `CNodeCompassUI`, OSD `CNodeMQ9UI`, videoInfo) still render and remain interactive.
- [M] Sidebar docking (drag a view to a screen edge → docks) still works.
- [M] Double-click fullscreen still works.
- [M] Saved/old sitches load and render identically (header is non-serialized; geometry unchanged).
- [A] Negative width/height aspect-lock convention preserved (covered by geometry scenarios).

## Notes
- The header/UIBar is **overlay-only** and **non-serialized** — by construction it cannot change saved-sitch geometry or rendering. That is the main safety argument; the geometry scenarios are the committed proof.
- Page-screenshot verification via MCP needs the SitrecBridge `activeTab` grant (click the extension icon).
