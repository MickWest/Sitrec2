# Sitrec Design Language (DRAFT)

Modelled on **Blender 5.1+** (areas + headers + N/T sidebars + a single top menu). This is the spec every new view, control, panel, and instrument must follow. It is a living document — fill in as decisions land.

> **Current reality (what we're unifying away from):** there is *no* app stylesheet and *no* design-token module. The only token system is lil-gui's dark theme (`.lil-gui` CSS vars). Look comes from 3 imperative layers: lil-gui's injected sheet, `src/extra.css.js` (a JS template string, `//`-comments stripped before injection!), and ~40 files of ad-hoc inline `element.style`. See ARCHITECTURE.md §6.

> **D1 resolved (2026-06-22):** app stays **dark**; only per-window **headers are light-grey** (`--sitrec-bg-header`). Theme work is additive — no full retheme. Exact header palette/height to be pulled from Blender 5.1.2 over MCP (D5).

## 1. Design tokens

Single source of truth → `:root{ --sitrec-* }` (in `extra.css.js`), with lil-gui's `.lil-gui` vars *aliased* to them so menus and custom DOM share one palette.

### Inventory of current values (to consolidate, not necessarily keep)
| Role | Current value(s) |
|---|---|
| Menu/panel background (dark) | `#1f1f1f`, `#1a1a1a`, `#111`, `#202030`, `#101418` |
| Widget grey | `#424242` / hover `#4f4f4f` / `#595959` / `#333`–`#757575` |
| Text (near-white) | `#ebebeb`, `#eee`, `#f4f7fb` |
| Accent (slider/number) | `#2cc9ff` |
| Primary blue | `#1976d2`; links `#0080ff` |
| Drag highlight | `rgba(100,150,255,0.6)` border / `0.3` hover |
| Frame markers | `#00ff00 #0088ff #ffcc00 #ff0000` |
| Error | `#d32f2f` |
| Borders | `#444`, `#FFFFFF`/`#202030` (folders) |

### Blender 5.1.2 reference (extracted live via MCP, Default theme, ui_scale 1.0)
| Blender role | Value | Note |
|---|---|---|
| Top menu bar (topbar) | `#181818` | the *main* menu — darkest |
| **Area header** | `#303030` | **deliberately LIGHTER than the topbar** → this is the "distinguish from main menu" relationship we want |
| Header text | `#EEEEEE` | |
| Editor/panel background | `#303030` | properties panel back |
| Widget inner | `#545454` | buttons/fields |
| Widget outline | `#3D3D3D` | |
| Menu dropdown back | `#181818` | |
| Text-field inner | `#1D1D1D` | |
| Area border | white @ 8% (`editor_outline`) | the thin seam between areas |
| Widget emboss | black @ 15% | bottom shadow line |
| **Header height** | **26 px** (uniform all editors) | |
| Toolbar (T) icon column | ~56 px | |

**Takeaway for D1:** "light-grey header" = a header *one+ step lighter than the (near-black) main menu*, not an absolute light colour. Blender uses `#303030` header over `#181818` menu. Sitrec's main menu is `#1f1f1f`/black, so the header should be a clearly lighter grey. **Exact shade is a quick visual call (see `--sitrec-bg-header` below).**

### Implemented token set — IMPLEMENTED in `src/extra.css.js` (Phase 0.4, 2026-06-22)
Existing-surface tokens use the **current** values so the dark app looks identical (no
visual regression); tokens tagged NEW are Blender-grounded and consumed by later phases.
The Sitrec-authored CSS now reads from these; lil-gui's *internal* vars are NOT yet
re-pointed (it has touch font-size + hover-color variants — a careful later step).
```
/* surfaces (DARK — preserve current look) */
--sitrec-bg-app:     #000000
--sitrec-bg-menubar: #1f1f1f
--sitrec-bg-panel:   #1f1f1f   /* = lil-gui --background-color */
--sitrec-bg-title:   #111111   /* = lil-gui --title-background-color */
--sitrec-bg-folder:  #202030   /* nested-folder dark blue */
--sitrec-bg-widget:  #424242   /* = lil-gui --widget-color */
--sitrec-hover:      #4f4f4f
--sitrec-bg-header:  #3a3a3a   /* NEW — per-window header (Blender #303030, lighter than menubar); Phase 3 */
/* text */
--sitrec-text: #ebebeb · --sitrec-text-strong: #fff · --sitrec-text-dim: #a0a0a0
/* lines & accents */
--sitrec-border: #666 · --sitrec-border-folder: #fff
--sitrec-border-area: rgba(255,255,255,0.08)   /* NEW — Blender area seam; Phase 2/3 */
--sitrec-accent: #2cc9ff · --sitrec-primary: #1976d2 · --sitrec-danger: #d32f2f
--sitrec-link: #0080ff · --sitrec-drag-highlight: rgba(100,150,255,0.6)
/* metrics */
--sitrec-header-h: 26px   /* NEW — Blender header height; Phase 3 */
--sitrec-font-size: 11px · --sitrec-radius: 4px · --sitrec-space-1/2/3: 4/8/12px
```
> Future option (not done): shift the dark menu palette toward Blender's exact greys
> (panel `#303030`, widget `#545454`) and alias lil-gui's internal vars — a deliberate
> retheme, gated behind a pixel re-baseline, not part of 0.4.

### Layout constants (today, to route through tokens)
`MENU_BAR_HEIGHT=25` (≈ Blender topbar), `--sitrec-header-h=26` (NEW, per-window header), `SIDEBAR_WIDTH=250`, `CONTROLS_HEIGHT=20`, `ViewMan.topPx=24`, resize `HANDLE_SIZE=10`, `SNAP_DISTANCE=10`.

## 2. Typography  `[pending]`
Today **four** font conventions coexist (lil-gui sans 11px, body Monospace 20px, dialog Arial 12–18px, uPlot system-ui 14–18px). **Target: one UI font, ~11–12px**, with a defined scale.

## 3. Windows / areas
- Edge-to-edge **tiled** by default; no gaps, no overlap. Floating only on explicit detach (Q).
- **Every view has a header bar** (at least a tab), light-grey (`--sitrec-bg-header`, height `--sitrec-header-h` `26px`), distinct from the near-black main menu bar.
- **Header anatomy (from Blender 5.1.2):** a single horizontal strip — **left** = title / editor-type selector + context menus; **right** = view toggles + a **pin button**. The whole strip is the drag handle.

### 3a. Per-view UI behaviour (decided 2026-06-22) — LOAD-BEARING
- **Overlay, never inset.** The header and ALL per-view UI are an overlay layer floating **above** the view's canvas. The canvas always renders at the **full view rect** — **showing/hiding the UI must NOT change rendering** (it renders "as if the viewport is there under the UI"). ⇒ no canvas inset, no `changedSize`/renderer resize, no geometry change.
- **Title is a menu.** The leftmost element is a lil-gui menu (`CUIBar.titleMenu`) named with a **friendly, capitalised** view name ("Main", "Look", "Video", "Assistant"; else `menuName`; else a prettified id) — the home for per-view options (like the custom-graph tab menu). It replaces each view's own title/tab.
- **Standard icons (right):** Fullscreen ⛶ · Pin 📌 · Close ✕ — each with a stable `data-uibar-action`.
- **Pinned by default** (most views) so the bar is shown; opt out with `pinHeader: false`.
- **Hover-reveal (when not pinned).** Fades in only while the pointer is over the **bar strip** (not the whole view) and **only with no mouse button held** — so it won't appear while interacting with content or while a drag passes over the strip. Leaving the strip hides it; a header-drag in progress (button held, in strip) is not hidden.
- **Mobile (later).** No true touch hover: default the bar **pinned** on coarse pointers (or a tap-toggle/edge affordance), and size icons for touch (≥32px).
- **Non-serialized chrome.** Header visibility / pin state is runtime UI, NOT in `toSerialCNodeView`. Saved + old sitches are unaffected ("hideable, so saved sitches won't have it").
- This design is why it's safe: it's purely additive overlay chrome — it can't break existing sitches.
- **In-viewport controls** (nav gizmo, zoom/pan, fullscreen — Phase 4) live in this same hover-revealed overlay layer (Blender floats them top-right), not in the header strip.

## 4. Interaction model (unified — Phase 1)
- **Q = edit-layout modifier.** Hold Q → edges highlight identically on every view; move tiles, drag shared-edge dividers, detach, fullscreen. Release → normal camera/content interaction.
- Same snap rules, same min-size, same aspect handling for all views.
- Double-click = fullscreen toggle (one behaviour app-wide; the `doubleClickResizes` variant is deprecated to an opt-out).
- _Reference: extract exact Blender edit-mode behaviour via MCP (D5)._

## 5. Components
- **`CUIBar`** (`src/CUIBar.js`) — BUILT. The per-view header / UI bar: an overlay strip (never insets the canvas) with `addTitle` / `addMenu(title)→lil-gui` / `addIcon(html,onClick,tip)` + pin. Owner (CNodeView) drives `setShown`(hover/pin). This is the standard host for per-view menus + icon controls; the legacy `CNodeTabbedCanvasView.tabMenu` and `.cnodeview-tab` panels migrate onto it. Uses `--sitrec-bg-header`/`--sitrec-header-h`/`--sitrec-border-area`.
- `makePanel()`, `makeButton()`, `makeHeaderBar()` — shared factories replacing copy-pasted inline styles.
- `GUI.prototype.addIconButton` / mini-toolbar — built on the existing `addHTML`; template = `CNodeAnnotateOverlay`'s SVG icon toolbar.
- Instruments (compass, OSD, info) — subclasses of `CNodeViewUI`; render-on-demand, dirty-checked (do **not** force continuous redraw — CPU/render-arming hazard).

## 6. Iconography  `[pending]`
Today: one PNG transport sprite sheet + lil-gui glyphs + Annotate's inline SVG. **Target: one SVG icon set** (or icon font), defined sizes, tokenised colour.

## 7. Checklist for any new control / view / instrument
- [ ] Uses design tokens (no hardcoded hex).
- [ ] Uses the unified Q interaction (if movable) — no new bespoke drag gesture.
- [ ] Render-on-demand / dirty-checked (no continuous repaint).
- [ ] Serialized fields are *additive* (don't repurpose existing ones; don't reinterpret negative width/height).
- [ ] If menu-addressable, has a stable `_menuId` and is registered in the `setMenuValue` path inventory.
- [ ] Has a value-baseline scenario test if it carries state/geometry.
- [ ] Light-grey header conforms to `--sitrec-bg-header`.
