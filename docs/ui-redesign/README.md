# Sitrec UI Redesign

A comprehensive, Blender-5.x-inspired redesign of the Sitrec UI. Goals:

1. **Surface common functionality** as viewport-specific controls (icons / instruments / headers) instead of burying it in obscure menus.
2. **One consistent, documented design language** for all views, controls, and instruments (see [DESIGN-LANGUAGE.md](DESIGN-LANGUAGE.md)).
3. **Blender-style window system**: edge-to-edge *tiled* windows (not floating) with shared-edge dividers that resize neighbours together; each window has its own light-grey header bar; detach to floating on demand (Q).
4. **Unified interaction model**: every movable view navigates/edits identically.
5. **Reorganised + renamed menus** that bring common items to the top — kept as the underpinning, with new context-specific per-view menus layered on.

## The hard constraint

> **Nothing may break existing sitches.** Every built-in and custom sitch must still load and render. The regression suite is necessary but not sufficient — see [ARCHITECTURE.md §Serialization](ARCHITECTURE.md) for the exact persisted schema that must stay backward-compatible, and the [verification strategy](#verification).

## Documents

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — grounded map of the *current* view/window/menu/serialization/styling system (produced from a 7-subsystem code survey). Read this before touching layout code.
- **[TODO.md](TODO.md)** — the running, canonical task list. Updated as we go.
- **[DESIGN-LANGUAGE.md](DESIGN-LANGUAGE.md)** — the design-language spec (tokens, components, iconography, interaction model) + a checklist for any new control/view/instrument.
- **[LAYOUT-MODEL.md](LAYOUT-MODEL.md)** — the split-tree tiling design (Strategy B) and its backward-compat serialization.
- **[UI-TEST-CHECKLIST.md](UI-TEST-CHECKLIST.md)** — automated + manual test checklist for every view element the redesign touches (kept current as work lands).

## Decisions locked (2026-06-22)
- **Theme:** headers light-grey, rest of app stays dark (additive).
- **Layout model:** explicit Blender split-tree (Strategy B) as an optional `out.layout`; no tree ⇒ legacy behaviour.
- **Start:** Phase 0 safety net + tokens first.
- **Blender grounding:** yes — extract exact tokens/interaction over MCP (server needs reconnecting).

## Phased plan (overview)

The user's stated "first focus" — the window layout system — actually decomposes into three layers that must land in order, bracketed by a safety net:

| Phase | Theme | Visible? | Why this order |
|---|---|---|---|
| **0** | Foundations & safety nets | No | Build the geometry/serialization round-trip tests + design tokens + rename-safety audit *before* moving layout code, so silent breakage is caught. |
| **1** | Unified view-interaction model | Subtle | One `CViewInteraction` controller; Q = universal "edit layout" modifier; collapse the 3 divergent drag gestures. Prerequisite for tiling. |
| **2** | Snapped tiling — **split-tree (Strategy B)** | Yes | True Blender area split-tree ([LAYOUT-MODEL.md](LAYOUT-MODEL.md)) as an *optional* `out.layout` descriptor; no tree ⇒ legacy fractional-rect behaviour, so old sitches are untouched. Dividers resize neighbours together; Q-detach to floating. |
| **3** | Per-window header bars | Yes | Light-grey Blender-style area headers hosting per-view controls; becomes the drag handle. |
| **4** | Surface common actions | Yes | Shared playbar/scrubber + per-view-type control sets (the biggest UX win). |
| **5** | Menu reorg & rename | Yes | Surface common items, rename confusing ones — `_menuId`-stable + alias + API-path-safe. |
| **6** | Design-language doc & governance | — | Finalise the documented language + new-component checklist. |

See [TODO.md](TODO.md) for the itemised, checkboxed breakdown.

## Verification

Three gates, run after every step (`npm run build` first — build *is* the deploy):
- **`test-scenarios`** (committed JSON value baselines via `window.sitrecAPI`) — the *trustworthy, env-independent* gate. We **add per-view geometry round-trip + `listViews` fraction baselines here in Phase 0.**
- **`test-fast`** (real-Chrome pixel diff, local baselines) — catches composited-render regressions. Will be intentionally re-baselined when chrome changes.
- **`test-ui`** (save/load round-trip + menu sweep) — extend to assert per-view geometry survives.

> Pixel baselines are local/gitignored and machine-specific; the *committed value baselines* are the real contract.
