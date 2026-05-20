# 3D Buildings: Optional Shadows + Optional Custom Material — v5 (consolidated)

**Status:** Draft v5, consolidated from Codex V2, Claude V3, Codex V4. Not yet approved or implemented.

**Predecessors:**
- `3d-buildings-shadows-and-materials.md` — original v2.1 (Claude)
- `3d-buildings-shadows-and-materials-v2.md` — Codex revision (18 KB)
- `3d-buildings-shadows-and-materials-v3.md` — Claude revision (56 KB)
- `3d-buildings-shadows-and-materials-v4.md` — Codex revision (21 KB)

**Reviewers consulted for v5:** lighting specialist, architecture-synthesis reviewer, implementation-realism reviewer (all read all three plans).

**Scope:** Sitrec `mainView` and `lookView`, Cesium OSM Buildings, Google Photorealistic 3D Tiles, terrain receive-shadow opt-in, optional custom-material override.

**Date:** 2026-05-20.

---

## v5 Headline decisions (TL;DR for implementers)

| Decision | v5 verdict | Source |
|---|---|---|
| Per-view shadow architecture | **Render-scoped sun swap** — V4's design. Hide `Globals.sunLight` and show per-view `viewSun` only during that view's render; restore in `finally`. **REJECT V3's MASK_LIGHTING flip** — Three.js filters light layers against the *render camera*, not per-mesh, so V3's design double-lights `MASK_MAIN \| MASK_LOOK` meshes (which exist: `CNodeBuildings3DTiles.js:139`). | V4 |
| Shadow camera frustum | **Per-view bounds-fitted ortho** with origin-radius fallback (`|sunPos|±r`). Bounds computed from visible caster + receiver subtree at render-scope time. | V4 |
| Filter type | `PCFShadowMap` (V4/V3). `PCFSoftShadowMap` is deprecated in three@0.183.1 and silently downgrades with console warning. Do not use VSM in V1. | V3, V4 |
| Default `shadowMapSize` | **1024**, with 2048 / 4096 as opt-in. Mobile forces 1024. | V2, V4 |
| `shadowBias`, `shadowNormalBias` | `bias = -0.0005` (NDC, scale-invariant); `normalBias = (shadowRadius/5000) × 5` ≈ 5 at default radius (≈ 1 texel at 2048²). | Lighting reviewer |
| Terrain `receiveShadow` | **Separate opt-in toggle, default off.** Largest fragment producer; flipping always-on hurts perf for sitches that don't need it. | V2, V4 |
| Material modes | `photo` (default), `flat`, `halfPhoto`. **No `vertexColor`** (tile sources don't ship vertex colours). | All three |
| Material mode change | **Applies to next tile load only.** Re-walking loaded tiles breaks `TilesFadePlugin.FadeMaterialManager`'s WeakMap. | All three |
| Temporal coherence | Throttled invalidation: combined angular threshold + wall-clock min-interval (V3 §3.12). Defaults 0.25° / 50 ms. Per-view state. | V3 |
| Image Set exporter | Force-refresh shadow per captured pose via `forceShadowRefreshForExport(view)` helper, hooked into `ExportImageSet.js:218`'s `renderShot`. | V3 + V4 helper |
| Time budget | **5-7 days**, not 4. Phase 0 (architecture spike) gates the rest. | Implementation-realism reviewer |

---

## 0. Critical invariant: defaults-off is pure dead-code activation

**The non-negotiable rule. Implementers enforce it; reviewers verify it.**

> When every new toggle is in default-off state, runtime behaviour must be **byte-identical** to current behaviour. Every new code path must either be gated behind a non-default toggle, or be provably no-op when all toggles are off.

Concretely:
- No new scene traversal at construction time when shadows are off.
- No `material.needsUpdate = true` writes when shadows are off.
- No new property writes on `Globals.sunLight` or any `viewSun` when shadows are off (`viewSun` is not constructed at all until first transition to on).
- No new property writes on `renderer.shadowMap` when shadows are off.
- No iteration over loaded tiles when shadows are off and material mode is `photo`.
- No additional WebGLRenderTarget allocations when shadows are off (`shadow.map === null` post-boot for every light).
- No additional shader programs compiled (`renderer.info.programs.length` unchanged).
- No `applyMaterialMode()` invocation when mode is `photo` (call is gated, not just a no-op default branch).

### Verification gates (each phase must pass before merging)

1. **GL trace gate.** `renderer.info.render.calls` identical to baseline over 10 frames.
2. **Shader program gate.** `renderer.info.programs.length` unchanged post-boot.
3. **GPU memory gate.** `renderer.info.memory.textures` and `renderer.info.memory.geometries` unchanged.
4. **Shadow render target nullity.** `Globals.sunLight.shadow.map === null` AND no `viewSun` instance exists on any `CNodeView3D`.
5. **Instrumentation counters.** Module-level counters (`shadowViewSunCreations`, `shadowMapAllocations`, `shadowMaterialNeedsUpdateWrites`, `materialModeApplications`) all equal 0 after sitch boot.
6. **Visual regression gate.** Existing baselines pass unchanged; only the explicitly-enumerated GUI-bearing baselines (§4.2) shift due to new menu rows.
7. **Construct-time audit checklist** — verify these specific call sites are no-op in defaults-off:
   - `CNodeLighting` constructor → `applyShadowConfig` (must early-return).
   - `CNodeView3D` constructor → `applyShadowRendererConfig` (must early-return).
   - `TilesDayNightPlugin.processTileModel` → `applyMaterialMode` is **not called** when mode is `photo`.
   - `CNodeBuildings3DTiles` `load-model` handler → `castShadow` assignment gated.
   - `QuadTreeTile` construction → `receiveShadow` gated.
   - `CNodeSunlight.update` → throttle walk gated.

---

## 1. Prerequisites — Three.js & Sitrec facts (verified, do not re-derive)

### Three.js semantics (the load-bearing rules)

- **Light visibility is camera-filtered.** `WebGLRenderer.js:1379` tests `light.layers.test(camera.layers)` — light layer mask filters against the **render camera**, NOT per-receiver mesh. This is why V3's "shadowSun on MASK_MAIN only" design fails: any camera whose mask includes both MASK_WORLD and MASK_MAIN will pick BOTH the global sun and the per-view shadowSun, producing double-lighting on mesh layers in the intersection.
- **Shadow caster filtering** uses the render camera too. `WebGLShadowMap.js:511`: `object.layers.test(camera.layers)` where camera is `shadow.camera`. So `shadow.camera.layers` does filter casters, but only because the shadow camera *is* the render camera for the depth pass.
- **`light.shadow.map` is a `WebGLRenderTarget`** owned by the renderer's GL context that first uploaded it. Cross-renderer sharing **does not work**. Two `WebGLRenderer` instances each have their own `WebGLShadowMap` (`WebGLRenderer.js:455`).
- **`PCFSoftShadowMap` is deprecated** in three@0.183.1 (`WebGLShadowMap.js:99-104`). Silently downgrades to `PCFShadowMap` with console warning.
- **`MeshDepthMaterial`** is used by `WebGLShadowMap` for the caster pass. Copies `alphaTest`, `alphaMap`, `map`, `alphaToCoverage`, `clippingPlanes`, `displacementMap` from the original (`WebGLShadowMap.js:481-491`) but does **not** honour custom `onBeforeCompile` discards.
- **Setting `intensity = 0`** does NOT disable a light's shadow rendering cost — the shadow map is still computed in the depth pass — but the shadow term is multiplied by zero in the lighting equation, so the shadow is invisible. There is no "shadow-only" light in Three.js.

### Sitrec code state (verified file:line)

- `Globals.sunLight` is constructed at `CNodeLighting.js:62` with `layers.mask = MASK_LIGHTING` (`:63`), initial position `(0, 7000, 0)` (`:64`). Dormant shadow block at lines 65-72 references `Globals.shadowsEnabled` which is never assigned anywhere — confirmed by repo-wide grep.
- `CNodeSunlight.calculateSunAt` returns `sunPos = dir × 60000` (`CNodeSunlight.js:33`). Per-frame `sunLight.position.copy(sun.sunPos)` at `:163`. **Sun is ~60,000 units from origin once `update` runs**, but `(0, 7000, 0)` at construction time. First `applyShadowConfig` must defer until after `CNodeSunlight.update()` runs at least once.
- `LayerMasks.js:31` — `MASK_LIGHTING = MASK_WORLD | MASK_MAIN | MASK_LOOK | MASK_TARGET`.
- `MeshDepthMaterial.alphaTest` cutout shadows work; `DayNightStandardMaterial._onBeforeCompile` (`src/js/map33/material/DayNightStandardMaterial.js:40-145`) contains **no `discard` statements** — all edge/border rendering uses `mix()`, day/night uses `*=`. Verified safe for shadow casting.
- `CNodeBuildings3DTiles.js:139` sets `this.group.layers.mask = MASK_MAIN | MASK_LOOK` — **combined-layer mesh confirmed**. Individual tile meshes get `MASK_MAIN` or `MASK_LOOK` per-view in the `load-model` handler at line 90-97.
- `TilesEdgesPlugin` adds a `barycentric` vertex attribute and draws edges in-shader within the same material call — no separate `Line` meshes.
- `TilesFadePlugin.FadeMaterialManager` keys WeakMap by material identity. Re-walking with `fromMaterial(...)` orphans entries and pops fading tiles — material mode swap on already-loaded tiles is unsafe.
- `CNodeTerrain.js:590` constructs `QuadTreeMapTexture(this.group, …)`. `QuadTreeMapTexture.js:19` stores group as `this.scene`. Tile meshes attach via `this.map.scene.add(this.mesh)` (`QuadTreeTile.js:2048`), so `CNodeTerrain.group.traverse(...)` covers all loaded tiles. `QuadTreeMap.forEachTile` also exists at `src/QuadTreeMap.js:171`.
- Terrain mesh at `QuadTreeTile.js:2081`; skirt at `:2087`. Skirts must NEVER `castShadow` and should NEVER `receiveShadow` in V1 (degenerate UVs/normals → seam artifacts).
- `ColorManagement.enabled = false` at `src/index.js:1454`. Material colours need explicit `.convertSRGBToLinear()` after `.setHex()`.
- `Globals.isMobile` set in `index.js:1204-1226` synchronously at load.
- `NodeMan.iterate((id, node) => ...)` at `src/CManager.js:140-142`. Filter by `node.constructor.name`. Terser `keep_classnames: true` confirmed at `webpack.common.js:361` — `constructor.name` checks work in production.
- `CustomManagerSerialize.js` has two `TerrainModel` blocks at lines 131 and 207. Both must be updated for `buildingsMaterialMode` / `buildingsFlatColor`.
- `ExportImageSet.js:218` defines `renderShot` async closure that drives `view.renderCanvas(par.frame)` programmatically. The shadow-refresh hook lives here.
- `CNodeView3D.js:174` constructs `_lookViewFog` (FogExp2). `pushLookViewAtmosphereFog` / `popLookViewAtmosphereFog` at lines 976-992 manage scene fog during render.
- `CNodeView3D.js:1474` activates `hdrToneMappingPass` for lookView under `useLookViewHDR && atmosphereEnabled && atmosphereHDR`. Shadows render before tone-mapping (HDR linear space) — Three.js handles this correctly per the lighting reviewer.

---

## 2. Architecture: render-scoped sun swap

### The model (V4, validated by lighting reviewer)

Three.js's per-camera light selection means **the only way to give each view independent shadow geometry is to swap the active sun light per render**. Plain "different layer masks" doesn't work — both lights get selected by any camera whose mask covers both.

```
Legacy mode (shadows OFF anywhere):
    GlobalScene contains: Globals.sunLight (visible, MASK_LIGHTING)
    Every renderer.render(scene, view.camera) lights from sunLight as today.

Shadow-system mode (shadows ON for any view):
    GlobalScene contains: Globals.sunLight (visible=false), viewSun_main, viewSun_look
    Each viewSun is created lazily on first transition to "any view has shadows."

    Per render of CNodeView3D 'V' (in V.renderCanvas):
        1. Hide Globals.sunLight.visible = false
        2. Set V.viewSun.visible = true
        3. V.viewSun.castShadow = V.shadowsEnabled
        4. V.viewSun.intensity = Globals.sunLight.intensity
        5. V.viewSun.color.copy(Globals.sunLight.color)
        6. V.viewSun.position.copy(Globals.sunLight.position)
        7. V.viewSun.target.position.set(0,0,0)
        8. V.renderer.shadowMap.enabled = V.shadowsEnabled
        9. renderer.render(GlobalScene, V.camera)
        10. finally:
            V.viewSun.visible = false
            Hide other views' viewSuns
            Globals.sunLight.visible = true (restored)
```

### Why this is correct

- During V's render, only `V.viewSun` is visible — single light source, no double-counting.
- Each view's renderer renders its own shadow pass into its own `viewSun.shadow.map` (per-renderer GL context, owned locally — no cross-context texture sharing).
- Receiving meshes are lit by `V.viewSun` only (because it's the only visible light) — total illumination matches legacy (sunLight had the same intensity).
- `try / finally` guarantees state restoration even if render throws.
- Other views' `viewSun` instances stay hidden during V's render — Three.js skips them.

### Defaults-off behaviour

When no view has `shadowsEnabled`:
- No `viewSun` instances are constructed (lazy creation gated on first transition).
- `Globals.sunLight` stays as the only light. Layer mask unchanged.
- No render-scoped swap runs (gate at top of `applyShadowRendererConfig` in `renderCanvas`).
- Defaults-off invariant preserved.

### Combined-layer meshes (the trap V3 fell into)

`CNodeBuildings3DTiles.js:139` sets the buildings group to `MASK_MAIN | MASK_LOOK`. Individual tile meshes get single masks (`MASK_MAIN` or `MASK_LOOK`). The render-scoped swap model handles this correctly because only one light is visible per render — combined-layer meshes are lit by whichever view's `viewSun` is active. No double-lighting.

---

## 3. Detailed changes (specific code shapes + file:line refs)

### 3.1 Globals + `CNodeLighting`

**Files touched:** `src/Globals.js`, `src/nodes/CNodeLighting.js`, `src/nodes/CNodeSunlight.js`.

`src/Globals.js`:
```js
export let shadowsEnabled = false;
// Exported counters for §0 defaults-off invariant verification gates.
export const shadowDiagCounters = {
    viewSunCreations: 0,
    shadowMapAllocations: 0,
    materialNeedsUpdateWrites: 0,
    materialModeApplications: 0,
};
```

`src/nodes/CNodeLighting.js` — add lighting-side controls + transition orchestration:

```js
// In constructor
this.shadowMapSize    = v.shadowMapSize    ?? 1024;
this.shadowRadius     = v.shadowRadius     ?? 5000;
this.shadowBias       = v.shadowBias       ?? -0.0005;
this.shadowNormalBias = v.shadowNormalBias ?? (this.shadowRadius / 5000) * 5;
this.terrainReceivesShadow = v.terrainReceivesShadow ?? false;

this.addSimpleSerial("shadowMapSize");
this.addSimpleSerial("shadowRadius");
this.addSimpleSerial("shadowBias");
this.addSimpleSerial("shadowNormalBias");
this.addSimpleSerial("terrainReceivesShadow");

// GUI: collapsed "Shadow tweaks" subfolder — see §3.9.

// Defer first applyShadowConfig until CNodeSunlight has run once.
// At construction, sunLight.position is (0,7000,0); correct ~60000 magnitude
// is only set after CNodeSunlight.update(). Frustum math must use the latter.
this._pendingFirstShadowConfig = true;
```

`applyShadowConfig` (called from `CNodeSunlight.update` on first run, then on any toggle):
```js
applyShadowConfig() {
    const anyEnabled = this.isAnyViewShadowsEnabled();
    const wasEnabled = this._prevShadowsAnyEnabled === true;
    const transitioned = anyEnabled !== wasEnabled;

    // §0 short-circuit: never-on, currently-off → pure no-op.
    if (!anyEnabled && !wasEnabled) {
        this._prevShadowsAnyEnabled = false;
        return;
    }

    Globals.shadowsEnabled = anyEnabled;

    if (transitioned) {
        Globals.sunLight.visible = !anyEnabled;
        NodeMan.iterate((id, node) => {
            const ctor = node.constructor.name;
            if (ctor === "CNodeView3D"
                && typeof node.applyShadowRendererConfig === "function") {
                node.applyShadowRendererConfig({ transitioned: true });
            }
            if (ctor === "CNodeBuildings3DTiles"
                && typeof node.refreshShadowFlags === "function") {
                node.refreshShadowFlags();
            }
            if (ctor === "CNode3DObject"
                && typeof node.refreshShadowFlags === "function") {
                node.refreshShadowFlags();
            }
            if (ctor === "CNodeTerrain"
                && typeof node.refreshShadowFlags === "function") {
                node.refreshShadowFlags();
            }
        });
    }

    this._prevShadowsAnyEnabled = anyEnabled;
    setRenderOne(true);
}

isAnyViewShadowsEnabled() {
    let any = false;
    NodeMan.iterate((id, node) => {
        if (node.constructor.name === "CNodeView3D" && node.shadowsEnabled) any = true;
    });
    return any;
}
```

`src/nodes/CNodeSunlight.js` — at the end of `update()` (after `:163`):
```js
const lighting = NodeMan.get("lighting", false);
if (lighting && lighting._pendingFirstShadowConfig) {
    lighting._pendingFirstShadowConfig = false;
    lighting.applyShadowConfig();
}
// Per-frame throttled invalidation (§3.8).
if (Globals.shadowsEnabled) {
    Globals_propagateSunAndThrottle(performance.now());
}
```

(`Globals_propagateSunAndThrottle` is defined in §3.8.)

### 3.2 `CNodeView3D` + `viewSun` lifecycle

**File:** `src/nodes/CNodeView3D.js`.

```js
// In constructor (mainView/lookView only)
this.shadowsEnabled = v.shadowsEnabled ?? false;
this.allowMobileShadows = v.allowMobileShadows ?? false;
this.addSimpleSerial("shadowsEnabled");
this.addSimpleSerial("allowMobileShadows");

// Mobile auto-disable: shadowsEnabled requested but allowMobileShadows false
// and Globals.isMobile → effective shadows = false.
// areShadowsEffective() is the gate used everywhere.

this.viewSun = null;  // lazy-created on first transition to active

if (this.id === "mainView" || this.id === "lookView") {
    guiTweaks.add(this, "shadowsEnabled")
        .name(t("view3d.shadowsEnabled.label"))
        .tooltip(t("view3d.shadowsEnabled.tooltip"))
        .onChange(() => {
            const lighting = NodeMan.get("lighting", false);
            if (lighting) lighting.applyShadowConfig();
        });
}

areShadowsEffective() {
    if (!this.shadowsEnabled) return false;
    if (Globals.isMobile && !this.allowMobileShadows) return false;
    return true;
}

applyShadowRendererConfig({ transitioned = false } = {}) {
    if (!this.renderer) return;

    // §0 short-circuit: stable defaults-off.
    if (!this.areShadowsEffective()
        && !this.renderer.shadowMap.enabled
        && !transitioned) {
        return;
    }

    // Lazy-create viewSun on first transition to effective-on.
    if (this.areShadowsEffective() && !this.viewSun) {
        this.viewSun = new DirectionalLight(0xFFFFFF, 0);
        this.viewSun.visible = false;
        this.viewSun.castShadow = true;
        const lighting = NodeMan.get("lighting", false);
        const size = lighting?.shadowMapSize ?? 1024;
        this.viewSun.shadow.mapSize.set(size, size);
        this.viewSun.shadow.bias = lighting?.shadowBias ?? -0.0005;
        this.viewSun.shadow.normalBias = lighting?.shadowNormalBias ?? 5;
        this.viewSun.shadow.autoUpdate = false;
        // Frustum computed lazily per-render in renderCanvas. Default bounds
        // are origin-radius fallback; bounds-fitting (§3.3) overrides per-render.
        this.applyShadowFrustumOriginFallback();
        GlobalScene.add(this.viewSun);
        Globals.shadowDiagCounters.viewSunCreations++;
    }

    const want = this.areShadowsEffective();
    if (this.renderer.shadowMap.enabled !== want) {
        this.renderer.shadowMap.enabled = want;
        this.scene?.traverse(o => {
            if (o.material) {
                o.material.needsUpdate = true;
                Globals.shadowDiagCounters.materialNeedsUpdateWrites++;
            }
        });
    }
    if (want && this.renderer.shadowMap.type !== PCFShadowMap) {
        this.renderer.shadowMap.type = PCFShadowMap;
    }

    // Reset throttle state on OFF→ON transition so first frame bypasses the
    // angle threshold (avoids up-to-50ms first-shadow latency).
    if (transitioned && want) {
        this._lastShadowSunDir = null;
        this._lastShadowUpdateMs = 0;
    }
}
```

Render-scoped sun swap — hook into the existing `renderCanvas` entry point:

```js
renderCanvas(frame) {
    // ... existing setup ...

    let restoreFn = null;
    if (Globals.shadowsEnabled) {
        restoreFn = this._enterShadowRenderScope();
    }
    try {
        // existing render code (pushLookViewAtmosphereFog → renderer.render → ...).
    } finally {
        if (restoreFn) restoreFn();
    }
}

_enterShadowRenderScope() {
    // Snapshot state.
    const prevSunVisible = Globals.sunLight.visible;
    const otherSuns = [];

    Globals.sunLight.visible = false;
    NodeMan.iterate((id, node) => {
        if (node.constructor.name === "CNodeView3D"
            && node !== this
            && node.viewSun) {
            otherSuns.push({ node, wasVisible: node.viewSun.visible });
            node.viewSun.visible = false;
        }
    });

    if (this.viewSun) {
        const want = this.areShadowsEffective();
        this.viewSun.visible = true;
        this.viewSun.castShadow = want;
        this.viewSun.intensity = Globals.sunLight.intensity;
        this.viewSun.color.copy(Globals.sunLight.color);
        this.viewSun.position.copy(Globals.sunLight.position);
        this.viewSun.target.position.set(0, 0, 0);
        this.viewSun.target.updateMatrixWorld();
        this.applyShadowFrustumFitOrFallback();
    }

    return () => {
        if (this.viewSun) this.viewSun.visible = false;
        for (const { node, wasVisible } of otherSuns) {
            if (node.viewSun) node.viewSun.visible = wasVisible;
        }
        Globals.sunLight.visible = prevSunVisible;
    };
}
```

### 3.3 Shadow camera fitting

Per-view bounds-fitted ortho with origin-radius fallback. Called from `_enterShadowRenderScope` right after the per-render position update.

```js
applyShadowFrustumFitOrFallback() {
    const lighting = NodeMan.get("lighting", false);
    const r = lighting?.shadowRadius ?? 5000;

    const bounds = this._computeShadowCasterBounds();  // null if unavailable
    if (bounds) {
        this._fitShadowFrustumToBounds(bounds);
    } else {
        this._fitShadowFrustumOrigin(r);
        if (!this._loggedFallbackOnce) {
            console.warn(
                `[shadows] view '${this.id}': bounds unavailable, using origin-radius fallback (r=${r})`
            );
            this._loggedFallbackOnce = true;
        }
    }
}

_fitShadowFrustumOrigin(r) {
    const cam = this.viewSun.shadow.camera;
    const dist = Globals.sunLight.position.length() || 60000;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = Math.max(1, dist - r);
    cam.far  = dist + r;
    cam.updateProjectionMatrix();
}

// _computeShadowCasterBounds walks visible casters in this view's mask, accumulates
// a Box3, projects against the sun direction to derive ortho extents. Detailed
// implementation deferred to Phase 0 spike — V5 specifies the contract, not the
// math (which depends on what bounds infrastructure is already in place; see
// `src/threeExt.js` for existing Box3 helpers).
```

### 3.4 `TilesDayNightPlugin` extensions

**File:** `src/TilesDayNightPlugin.js`.

```js
constructor(options = {}) {
    this.tiles = null;
    this.source = options.source ?? "cesium-osm";
    this.googleTileOutputGamma = options.googleTileOutputGamma ?? DEFAULT_GOOGLE_TILE_OUTPUT_GAMMA;
    this.materialMode = options.materialMode ?? "photo";
    this.flatColor = options.flatColor ?? null;
    this.shadowsEnabled = options.shadowsEnabled ?? false;
}

processTileModel(scene, tile) {
    scene.traverse(child => {
        if (child.isMesh && child.material) {
            const original = child.material;
            if (original[ORIGINAL_MATERIAL]) return;

            const tileOutputGamma = this.source === "google-photorealistic"
                ? this.googleTileOutputGamma : 1.0;
            const replacement = DayNightStandardMaterial.fromMaterial(original, { tileOutputGamma });

            // §0 invariant: skip applyMaterialMode entirely when in default
            // photo mode. No function call, no switch dispatch.
            if (this.materialMode !== "photo") {
                this.applyMaterialMode(replacement, original);
            }
            replacement[ORIGINAL_MATERIAL] = original;
            child.material = replacement;
        }
    });
}

applyMaterialMode(replacement, original) {
    const sourceDefault = this.source === "google-photorealistic" ? 0xc0b8a8 : 0xb8b4ac;
    const flatHex = this.flatColor ?? sourceDefault;
    switch (this.materialMode) {
        case "flat":
            replacement.map = null;
            replacement.color.setHex(flatHex).convertSRGBToLinear();
            replacement.needsUpdate = true;
            break;
        case "halfPhoto":
            replacement.color.setRGB(0.6, 0.6, 0.6);
            break;
    }
    Globals.shadowDiagCounters.materialModeApplications++;
}
```

### 3.5 `CNodeBuildings3DTiles`

**File:** `src/nodes/CNodeBuildings3DTiles.js`.

- Store the plugin reference on `PerViewTiles` as `dayNightPlugin` (not anonymous).
- Add `materialMode`, `flatColor` to constructor options.
- Modified `load-model` handler (§0 gated):

```js
this.renderer.addEventListener('load-model', ({ scene }) => {
    scene.traverse(child => {
        if (child.isMesh || child.isLine || child.isPoints) {
            child.layers.mask = layerMask;
        }
        if (Globals.shadowsEnabled) {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
            if (child.isLine || child.isPoints) {
                child.castShadow = false;
            }
        }
    });
});
```

- `refreshShadowFlags()` with `_didEverEnableShadows` guard.
- `setMaterialMode(mode, flatColor)` — **updates plugin state only for future tile loads**. No traversal of loaded tiles.

### 3.6 `CNode3DObject` late-toggle fix

```js
refreshShadowFlags() {
    if (!Globals.shadowsEnabled && !this._didEverEnableShadows) return;
    if (Globals.shadowsEnabled) this._didEverEnableShadows = true;
    // Walk this.group (preferred — covers cloned children) and this.object as fallback.
    const root = this.group ?? this.object;
    if (!root) return;
    root.traverse(child => {
        if (child.isMesh && !child.isLine && !child.isPoints) {
            child.castShadow = Globals.shadowsEnabled;
            child.receiveShadow = Globals.shadowsEnabled;
        }
    });
}
```

Keep load-time blocks at `CNode3DObject.js:1248-1252` and `:1361-1363` unchanged (already gated, defaults-off safe).

### 3.7 Terrain receive-shadow

**Files:** `src/QuadTreeTile.js`, `src/nodes/CNodeTerrain.js`.

`QuadTreeTile.js:2081`:
```js
this.mesh = new Mesh(this.geometry, tileMaterial);
const lighting = NodeMan.get("lighting", false);
if (Globals.shadowsEnabled && lighting?.terrainReceivesShadow) {
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
}
// Skirts NEVER receive or cast (degenerate UVs/normals → seam artifacts).
if (this.skirtMesh) {
    this.skirtMesh.castShadow = false;
    this.skirtMesh.receiveShadow = false;
}
```

`CNodeTerrain.refreshShadowFlags()`:
```js
refreshShadowFlags() {
    const lighting = NodeMan.get("lighting", false);
    const want = !!(Globals.shadowsEnabled && lighting?.terrainReceivesShadow);
    if (!want && !this._didEverEnableShadows) return;
    if (want) this._didEverEnableShadows = true;
    this.group.traverse(obj => {
        if (obj.isMesh && obj !== this.skirtMesh) obj.receiveShadow = want;
    });
}
```

### 3.8 Temporal coherence — shadow update throttling

Per-view throttle on `viewSun.shadow.needsUpdate`. Combined angular + min-interval threshold.

```js
// Module-level scratch to avoid per-frame allocations.
const _tmpSunDir = new Vector3();

function Globals_propagateSunAndThrottle(now) {
    const lighting = NodeMan.get("lighting", false);
    const minInterval = lighting?.shadowUpdateMinIntervalMs ?? 50;
    const minAngleDeg = lighting?.shadowUpdateAngleThreshold ?? 0.25;

    NodeMan.iterate((id, node) => {
        if (node.constructor.name !== "CNodeView3D") return;
        if (!node.areShadowsEffective() || !node.viewSun) return;

        // viewSun position is mirrored per-render in _enterShadowRenderScope
        // (not here) — but we still need the comparison vector.
        if (!node._lastShadowSunDir) {
            node._lastShadowSunDir = new Vector3();
            node._lastShadowUpdateMs = 0;
        }

        const dt = now - node._lastShadowUpdateMs;
        if (dt < minInterval) return;

        const curDir = _tmpSunDir.copy(Globals.sunLight.position).normalize();
        const angleDeg = (curDir.angleTo(node._lastShadowSunDir) * 180) / Math.PI;
        const firstUpdate = node._lastShadowUpdateMs === 0;

        if (firstUpdate || angleDeg >= minAngleDeg) {
            node.viewSun.shadow.needsUpdate = true;
            node._lastShadowSunDir.copy(curDir);
            node._lastShadowUpdateMs = now;
        }
    });
}
```

GUI knobs (§3.9): `shadowUpdateMinIntervalMs` slider 16-500 (default 50), `shadowUpdateAngleThreshold` slider 0.05-5.0 (default 0.25).

Tile-visibility-change → also call `viewSun.shadow.needsUpdate = true` (bypasses throttle; correct because caster set changed). Hook in `CNodeBuildings3DTiles.js:86`'s `tile-visibility-change` listener.

### 3.9 GUI organisation

**Lighting menu** (`CNodeLighting`):
- Collapsed sub-folder `Shadow tweaks`:
  - `Shadow map size` — dropdown {1024, 2048, 4096}.
  - `Shadow radius (m)` — slider 500-50000.
  - `Shadow bias` — number.
  - `Shadow normal bias` — number.
  - `Shadow update interval (ms)` — slider 16-500.
  - `Shadow update angle (°)` — slider 0.05-5.0.
- `Terrain receives shadows` — boolean (top-level).

**Each `CNodeView3D` (mainView/lookView)**, under `guiTweaks`:
- `Shadows enabled` — boolean.
- `Allow on mobile` — boolean (only visible when `Globals.isMobile`).

**Terrain menu — buildings section** (`CNodeTerrainUI`):
- `Building material` — dropdown {Photo / Flat / Half-photo}.
- `Building flat colour` — colour picker, visible when material=Flat.

i18n keys in `src/i18n/en.js`:
```
view3d.shadowsEnabled.label = "Shadows enabled"
view3d.shadowsEnabled.tooltip = "Per-view shadow rendering. Off by default; enabling triggers per-view depth-pass shadow rendering on this view's renderer."
view3d.allowMobileShadows.label = "Allow on mobile"
view3d.allowMobileShadows.tooltip = "Override mobile auto-disable. Shadows are expensive; expect reduced frame rate."
lighting.shadowMapSize.label = "Shadow map size"
lighting.shadowMapSize.tooltip = "Resolution of the depth texture used for shadow rendering. Larger = sharper shadows, more GPU memory."
lighting.shadowRadius.label = "Shadow radius (m)"
lighting.shadowRadius.tooltip = "Half-extent of the orthographic shadow frustum. Origin-centred unless bounds-fitting is active."
lighting.shadowBias.label = "Shadow bias"
lighting.shadowBias.tooltip = "Depth offset (NDC). Negative values push shadow surface toward the light. Avoids shadow acne; too negative causes Peter-Pan (detached shadows)."
lighting.shadowNormalBias.label = "Shadow normal bias"
lighting.shadowNormalBias.tooltip = "Surface-normal offset (world units). Typically ~1 texel at the shadow camera scale."
lighting.shadowUpdateInterval.label = "Shadow update interval (ms)"
lighting.shadowUpdateInterval.tooltip = "Minimum time between shadow re-renders. Lower = smoother but more GPU cost."
lighting.shadowUpdateAngle.label = "Shadow update angle (°)"
lighting.shadowUpdateAngle.tooltip = "Sun-direction change required to trigger a shadow re-render. Lower = smoother during slow time movement."
lighting.terrainReceivesShadow.label = "Terrain receives shadows"
lighting.terrainReceivesShadow.tooltip = "Allow terrain meshes to be darkened by cast shadows. Off by default; flipping on adds a shadow sample per terrain pixel."
terrainUI.buildingMaterial.label = "Building material"
terrainUI.buildingMaterial.tooltip = "Applies to newly loaded tiles. Toggle buildings off/on to force-apply on already-loaded tiles."
terrainUI.buildingMaterial.modes.photo = "Photo"
terrainUI.buildingMaterial.modes.flat = "Flat"
terrainUI.buildingMaterial.modes.halfPhoto = "Half-photo"
terrainUI.buildingFlatColor.label = "Building flat colour"
terrainUI.buildingFlatColor.tooltip = "Base colour used when Material = Flat. Default per source: warm concrete for photogrammetric, neutral for OSM."
```

### 3.10 Image Set exporter hook

**File:** `src/ExportImageSet.js`. Add to module-level utility import path:

```js
import { forceShadowRefreshForExport } from "./CNodeView3D";  // or wherever exposed
```

Modify the `renderShot` closure at `:218`:

```js
const renderShot = async () => {
    camera.position.copy(target).addScaledVector(dir, distance);
    camera.up.copy(up);
    camera.lookAt(target);
    camera.updateMatrix();
    camera.updateMatrixWorld(true);
    // Force shadow re-render at this pose, bypassing the §3.8 throttle.
    if (Globals.shadowsEnabled) {
        forceShadowRefreshForExport(view);
    }
    view.renderCanvas(par.frame);
};
```

Helper definition (in `CNodeView3D.js` or `Globals.js`):
```js
export function forceShadowRefreshForExport(view) {
    if (!view?.viewSun?.shadow) return;
    view.viewSun.shadow.needsUpdate = true;
    // If bounds-fitting is in use, force recompute too.
    view._exportForceFrustumRefit = true;
}
```

Audit other programmatic render entry points (search `renderCanvas\\(` in src/) and apply the same pattern.

### 3.11 Serialization

Each new field via `addSimpleSerial` on its owner node. Defaults preserve back-compat.

`CustomManagerSerialize.js` `TerrainModel` blocks at lines 131 and 207 — explicitly include:
```js
buildingsMaterialMode: terrainUI.buildingsMaterialMode,
buildingsFlatColor: terrainUI.buildingsFlatColor,
```

`force: true` not needed for V1 stable defaults; revisit if defaults migrate later.

### 3.12 Mobile

`Globals.isMobile === true` AND `allowMobileShadows === false` → `areShadowsEffective()` returns false. Hide `shadowMapSize: 4096` option from the dropdown on mobile.

### 3.13 Known limitations (document in §9, surface in WhatsNew)

- **Edges plugin / `MeshDepthMaterial`.** `TilesEdgesPlugin` draws edges in-shader via `onBeforeCompile` with no `discard`. The depth pass uses `MeshDepthMaterial` which doesn't run those shader modifications. Tile shadow casters are slightly more solid at edges than the visible mesh — generally imperceptible because edges live on opaque geometry.
- **Photogrammetric tile baked lighting.** Google Photorealistic tile textures contain baked sun shadows from satellite capture time. With Material=Photo, runtime shadows are *added* on top. Material=Flat eliminates baked lighting entirely (clean shadows, lose photo realism). Material=Half-Photo is a compromise.
- **First-frame shadow latency.** On sitches with `shadowsEnabled` saved as true, the user sees one frame of legacy lighting before `applyShadowConfig` runs (deferred to first `CNodeSunlight.update`). Imperceptible in practice.
- **Atmospheric fog + night-side multiplier in `DayNightStandardMaterial`.** The night-side darkening at `DayNightStandardMaterial.js:130-140` runs after `<fog_fragment>`, so fog colour itself is dimmed on the night side. Pre-existing bug, not introduced by shadows; flagged here for context. Defer fix.

---

## 4. Test plan

### 4.1 Unit (Jest)

- `TilesDayNightPlugin.applyMaterialMode` per-mode behaviour: `map`, `color`, `needsUpdate` correctly set.
- §0 invariant test: construct sitch with all defaults, snapshot `renderer.info.render.calls`, `info.programs.length`, `info.memory.textures`, `info.memory.geometries`, and `Globals.shadowDiagCounters` over 10 frames. Assert byte-equal to pre-PR baseline. Assert `Globals.sunLight.shadow.map === null`.
- `applyShadowFrustumOriginFallback` math: feed `sunLight.position = (0, 60000, 0)`, `shadowRadius = 5000`, assert `near ≈ 55000, far ≈ 65000`.
- Throttle test: feed time series of `sunLight.position` (paused, slow, fast scrub) and assert update counts match expected (paused = 1 firstUpdate; slow = sparse; scrub = ≤ 20 Hz).
- Round-trip serialise→deserialise: shadowsEnabled, material mode, terrainReceivesShadow all preserved through `CustomManagerSerialize`.

### 4.2 Visual regression

**Existing baselines that will shift** (regenerate as explicit ship step):
- `demo-truck` (per `test-registry.js:14`) — GUI panel content shifts.
- Audit `test-registry.js` for any other snapshot whose visible region includes the right-sidebar GUI panels.

**New baselines** (added per CLAUDE.md "Adding a Visual Regression Test"):
- `chicago-buildings-shadows-main-only`
- `chicago-buildings-shadows-look-only`
- `chicago-buildings-shadows-both`
- `chicago-buildings-shadows-flat`
- `chicago-buildings-shadows-halfphoto`
- `chicago-buildings-shadows-terrain-receive`

**Caveat:** these reference `chicago`-prefixed cases that don't exist as regression sitches today. Implementer must either:
- Add a new urban regression sitch with bundled local tile fixture (preferred), or
- Use a credential-gated path with non-blocking CI behaviour.

### 4.3 Manual / MCP

8-case matrix: `{mainView shadows × lookView shadows × Cesium-OSM/Google-PR × Photo/Flat/HalfPhoto}`. Spot-check 8 of the 24 combinations + mobile auto-disable + a runtime toggle.

### 4.4 Performance pass/fail

Per V4 tiering — record on each tier (desktop / integrated-GPU laptop / iPad / phone) the per-frame shadow render cost via `EXT_disjoint_timer_query_webgl2` when available, falling back to `performance.now()` deltas. Thresholds:
- Desktop discrete GPU: < 8 ms / shadow update at 1024².
- Integrated laptop: < 20 ms.
- Mobile: shadows auto-disabled, no threshold.

---

## 5. Performance budgets — tiered

Per V4: refuse universal ms numbers. Instead require hardware/scene/DPR/tile-source context. Starting numbers (revise after Phase 6 instrumentation):

| Tier | Tile source | Per-update budget @ 1024² | Per-update budget @ 2048² |
|---|---|---:|---:|
| Desktop discrete (RTX/AMD) | Google PR | < 8 ms | < 20 ms |
| Desktop integrated (Intel) | Cesium OSM | < 10 ms | < 25 ms |
| Mac laptop integrated | Google PR | < 15 ms | < 40 ms |
| Mobile | any | auto-disabled | auto-disabled |

Update *frequency* governed by §3.8 throttle. At default knobs (0.25° / 50 ms): paused ≈ 0 updates/sec; real-time playback ≈ 1 update/min sitch-time; 60× playback ≈ 1 update/sec; scrubbing ≤ 20 updates/sec.

Memory: 1024² depth = ~4 MB per `viewSun`. Two viewSuns = ~8 MB. At 2048² = ~16 MB each / 32 MB total. 4096² = ~64 MB each / 128 MB total (desktop-only).

---

## 6. Rollout

- All toggles default off; mobile auto-disable.
- **Visual regression baseline regeneration is an explicit ship step**, not a side-effect — listed in commit message + WhatsNew.
- WhatsNew entry (draft text):

```markdown
### New Features
- **Optional shadows for 3D Buildings**: per-view toggles in the Tweaks panel let
  you cast dynamic shadows in mainView and lookView independently from Cesium
  OSM Buildings and Google Photorealistic 3D Tiles. Sun position drives shadow
  direction; updates throttle smoothly with time. Off by default — performance-
  sensitive feature gated per view. Mobile auto-disable. Three custom material
  modes (Photo / Flat / Half-Photo) let you trade photo realism for clean
  shadow geometry on photogrammetric tiles. Optional terrain receives shadows
  toggle in the Lighting menu.
```

- `/ship` workflow: when ready, build → tag → push as a minor bump (new user-facing feature; 2.56.x → 2.57.0).

---

## 7. Open questions (still need empirical work)

1. **Bounds-fitting failure modes (§3.3).** What fraction of frames in real sitches will fall back to origin-radius? Instrument and report after Phase 0 spike. If > 10%, design a tighter receiver bounds path or accept fallback as the common case.
2. **`PCFShadowMap` edge quality on photogrammetric tiles.** Hard edges might look unacceptable at oblique sun angles. Visual A/B at 3 sitches (chicago, gimbal, custom) before V1 ship. If unacceptable, evaluate `VSMShadowMap` as a follow-up (NOT V1).
3. **Throttle default tuning.** Defaults 0.25° / 50 ms are reasoned-but-untested. Instrument cadence on (a) paused, (b) real-time playback, (c) 60× playback, (d) scrubbing. Adjust if needed and document the chosen values.
4. **HDR pipeline interaction during shadow render.** lookView's HDR tone-mapping pass renders post-shadow-sampling. Visual confirmation that shadows in HDR-active lookView look correct (no over-darkening, no banding).
5. **Atmospheric fog colour on shadowed pixels.** With per-view fog and per-view shadows, confirm `(shadowed_color × (1 - fogFactor)) + (fog_color × fogFactor)` blends to the right look at sunrise/sunset.

### Resolved during plan revision (kept here for context, can be skipped by implementers)

- ~~Terser keep_classnames~~: confirmed true at `webpack.common.js:361`.
- ~~Terrain group.traverse coverage~~: confirmed via `QuadTreeMapTexture.js:19` storing group as scene; `QuadTreeTile.js:2048` adds to it.
- ~~`MeshDepthMaterial` discard correctness~~: no `discard` statements in `DayNightStandardMaterial._onBeforeCompile`.
- ~~Cross-renderer shadow map sharing~~: confirmed not possible; v5 uses per-renderer `viewSun.shadow.map`.
- ~~`PCFSoftShadowMap`~~: deprecated; use `PCFShadowMap`.

---

## 8. Step-by-step implementation plan (each step is independently testable)

### Conventions

- Every step lists: **Code** (exact file:line / function), **Validation** (specific command or observation), **Pass** (binary criterion), **Rollback** (what to do if fails).
- **Working-tree invariant:** at the end of every step, `npm run build` succeeds and the `chicago` sitch loads without console errors. Any step that breaks this must be reverted, not patched forward.
- **Defaults-off invariant:** the §0 verification gates must pass after every step. If a step inadvertently breaks them, treat as a failure even if the step's own test passes.
- Time estimates are for a Sitrec-fluent engineer. Add 30-50% for first contact.

### Reference snapshot — capture BEFORE any code change

Run once on `main` branch:

```js
// Browser console at chicago sitch
const v = NodeMan.get("mainView");
console.log(JSON.stringify({
    calls: v.renderer.info.render.calls,
    programs: v.renderer.info.programs.length,
    textures: v.renderer.info.memory.textures,
    geometries: v.renderer.info.memory.geometries,
    sunMapNull: Globals.sunLight.shadow.map === null,
    shadowMapEnabled: v.renderer.shadowMap.enabled,
}, null, 2));
```

Save the output to `/tmp/shadow-baseline.json`. Every defaults-off test compares against this.

---

### Phase 0 — Architecture spike (BLOCKING, 6-10h)

**Phase goal:** Prove render-scoped sun swap (§2) works with Sitrec's existing render loop before committing to plan-wide implementation.
**Phase gate (must pass before Phase 1):** main-only shadows visibly render correctly on a building; lookView lights correctly with no shadow; defaults-off counters byte-identical to baseline.

#### Step 0.1 — Spike branch + stub `viewSun` lifecycle (~1h)

**Code:**
- Create branch `spike/shadow-arch`.
- `src/nodes/CNodeView3D.js`, in constructor, only for `mainView`:
  ```js
  if (this.id === "mainView") {
      this.viewSun = new DirectionalLight(0xFFFFFF, 0);
      this.viewSun.visible = false;
      this.viewSun.castShadow = false;
      GlobalScene.add(this.viewSun);
  }
  ```

**Validation:**
- `npm run build` succeeds.
- Load `chicago` sitch. Open devtools, run: `NodeMan.get("mainView").viewSun && Globals.sunLight && Globals.sunLight.parent !== null`.

**Pass:** Returns `true`. Sitch renders identically to baseline (eyeball check).

**Rollback:** If sitch fails to load, the `DirectionalLight` import is wrong or scene is null. Revert step, check imports.

#### Step 0.2 — Manual render-scoped swap, no shadow (~1.5h)

**Code:**
- In `mainView.renderCanvas`, before the existing render call:
  ```js
  let _prevSunVisible, _viewSunRestore;
  if (this.viewSun) {
      _prevSunVisible = Globals.sunLight.visible;
      Globals.sunLight.visible = false;
      this.viewSun.visible = true;
      this.viewSun.castShadow = false;
      this.viewSun.intensity = Globals.sunLight.intensity;
      this.viewSun.color.copy(Globals.sunLight.color);
      this.viewSun.position.copy(Globals.sunLight.position);
      this.viewSun.target.position.set(0, 0, 0);
      this.viewSun.target.updateMatrixWorld();
      _viewSunRestore = () => {
          this.viewSun.visible = false;
          Globals.sunLight.visible = _prevSunVisible;
      };
  }
  try { /* existing render code */ } finally { _viewSunRestore?.(); }
  ```

**Validation:**
- Build, load `chicago`. Take MCP screenshot. Compare byte-by-byte (or via `imagemagick compare -metric AE`) against pre-spike baseline screenshot of same camera pose.

**Pass:** Pixel difference < 1% (intensity/color/position copy is mathematically a no-op — the visible result must match).

**Rollback:** If pixels differ noticeably, the position/intensity/color copy is wrong, OR the swap is happening at the wrong point in `renderCanvas`. Read `pushLookViewAtmosphereFog` (line 976) — the swap may need to be INSIDE that scope, not outside.

#### Step 0.3 — Enable shadow map with no casters (~1h)

**Code:**
- Add to the swap block: `this.viewSun.castShadow = true;` and `this.viewSun.shadow.camera.left/right/top/bottom = ±5000; near = 55000; far = 65000; updateProjectionMatrix();`.
- Add `mainView.renderer.shadowMap.enabled = true` (one-shot at the start of `renderCanvas` for now).

**Validation:**
- Build, load, take screenshot. Compare with Step 0.2 screenshot.

**Pass:** Pixels identical (no mesh has `castShadow = true` yet, so the depth pass renders nothing → no shadow visible).

**Rollback:** If pixels differ, either bias is wrong or `shadow.autoUpdate` is creating unintended state. Set `viewSun.shadow.autoUpdate = false`.

#### Step 0.4 — Cast shadow from a single synthetic object (~1.5h)

**Code:**
- In devtools at runtime, pick any `CNode3DObject` instance (e.g., `NodeMan.get("plane01")` or whatever exists in `chicago`). Manually `instance.object.traverse(c => { if (c.isMesh) c.castShadow = true; })`.
- Also: terrain receive — for one terrain tile mesh visible at the synthetic object's location, set `mesh.receiveShadow = true`.

**Validation:**
- Visual MCP screenshot. Compare to Step 0.3.

**Pass:** Shadow visible on terrain under the synthetic object. Shadow direction matches `Globals.sunLight.position` direction (eyeball: at `chicago` noon sitch time, shadow points roughly north).

**Rollback:** If no shadow visible, check (a) `mainView.renderer.shadowMap.enabled === true`, (b) `viewSun.castShadow === true`, (c) ortho frustum bounds contain both caster and receiver. If wrong direction, the frustum is centred on wrong location.

#### Step 0.5 — Defaults-off counter check, tear-down (~1h)

**Code:** Remove the temporary `castShadow = true` from the synthetic object. Reload sitch.

**Validation:**
- Run the reference snapshot command from §8 preamble.

**Pass:** All counter values match `/tmp/shadow-baseline.json` exactly.

**Rollback:** If counters drift even with castShadow off, the swap block or `shadowMap.enabled` is leaking state. Move toward Phase 1 with a `shadowsEnabled === false` early-return at the top of `renderCanvas`'s swap block.

#### Step 0.6 — Spike verdict (~30 min)

**Validation:** Write a 200-word note: did the swap work? Any surprises? Bounds-fitting needed for buildings, or origin-radius enough?

**Pass:** "Yes, proceed to Phase 1." OR "No — here's the redesign needed."

**Rollback:** If "no," return to v5 §2 and propose an alternative architecture (e.g., single-renderer-with-viewports). This adds ~2-3 days and gates Phase 1 on the new design.

**Discard the spike branch** after verdict — Phase 1 starts fresh on `main`.

---

### Phase 1 — Infrastructure: globals, counters, view toggles (6-8h)

**Phase goal:** Wire up the per-view `shadowsEnabled` toggle plus the `viewSun` lazy lifecycle and render-scoped swap. No shadows render yet (no casters opted in).
**Phase gate:** Toggle `mainView.shadowsEnabled` on/off in GUI; verify counters change exactly on transition, viewSun is created lazily on first ON, defaults-off byte-identity preserved when both views are off.

#### Step 1.1 — Globals counters skeleton (~30 min)

**Code:** `src/Globals.js` — add `Globals.shadowsEnabled = false` and `Globals.shadowDiagCounters` per §3.1.

**Validation:** Build, load sitch, run `console.log(Globals.shadowDiagCounters)`.

**Pass:** `{ viewSunCreations: 0, shadowMapAllocations: 0, materialNeedsUpdateWrites: 0, materialModeApplications: 0 }`.

**Rollback:** Reverse the addition.

#### Step 1.2 — `shadowsEnabled` field + GUI toggle per view (~1h)

**Code:** `src/nodes/CNodeView3D.js` — add `this.shadowsEnabled = v.shadowsEnabled ?? false; this.addSimpleSerial("shadowsEnabled");` plus GUI control per §3.2. **DO NOT** wire `onChange` to anything yet (will hook in Step 1.4).

**Validation:** Build, load. In Tweaks panel, see "Shadows enabled" toggle in both mainView and lookView. Click it on, save sitch (`Save State`), reload page.

**Pass:** Toggle state survives reload. Visible rendering unchanged (no implementation yet).

**Rollback:** If toggle not visible, check guiTweaks scope. If state doesn't survive reload, `addSimpleSerial` is in wrong place.

#### Step 1.3 — `areShadowsEffective()` + mobile auto-disable (~30 min)

**Code:** Add per-view `allowMobileShadows` field + `areShadowsEffective()` method per §3.2.

**Validation:** In devtools: `NodeMan.get("mainView").areShadowsEffective()`. Toggle `shadowsEnabled`, re-check. Set `Globals.isMobile = true` (simulate mobile), re-check.

**Pass:** Returns `false` in all cases until `shadowsEnabled === true && (Globals.isMobile === false || allowMobileShadows === true)`.

**Rollback:** Method logic wrong; fix conditions.

#### Step 1.4 — `applyShadowRendererConfig` short-circuit (~1h)

**Code:** Add the method per §3.2, with the `!areShadowsEffective() && !renderer.shadowMap.enabled && !transitioned` short-circuit. Call from view constructor. Wire the GUI toggle's `onChange` to call `applyShadowConfig` on the lighting node (or just `applyShadowRendererConfig({transitioned:true})` on this view for now — until Phase 1.7 wires lighting orchestration).

**Validation:**
- Defaults-off counter check: load sitch, all counters at 0. Pass §0 gates 1-5 from preamble.
- Toggle `mainView.shadowsEnabled` on. Counter `materialNeedsUpdateWrites > 0` confirms scene-walk fired.
- Toggle off. No change.

**Pass:** Counters byte-identical to baseline when off; non-zero after first transition on.

**Rollback:** If counters drift when off, the short-circuit is wrong; add `console.log` to verify entry path.

#### Step 1.5 — Lazy `viewSun` creation (~1.5h)

**Code:** Inside `applyShadowRendererConfig`, the lazy-create block per §3.2 (only when `areShadowsEffective()` and `!this.viewSun`).

**Validation:**
- Load sitch (default off). In devtools: `NodeMan.get("mainView").viewSun === null` → true.
- Counter `viewSunCreations === 0`.
- Toggle shadows on. `NodeMan.get("mainView").viewSun` is now a `DirectionalLight` instance. Counter `viewSunCreations === 1`.
- Toggle shadows off, then on again. `viewSunCreations` stays at 1 (lazy create only first time).

**Pass:** All three observations match.

**Rollback:** If counter increments on every toggle, the `!this.viewSun` guard is missing. If toggle off then on doesn't show the existing viewSun, the toggle-off path is incorrectly nulling.

#### Step 1.6 — Render-scoped swap in `renderCanvas` (~2h)

**Code:** Add `_enterShadowRenderScope()` per §3.2 (returns restoreFn). Wrap existing render code in `try/finally`. Gated on `Globals.shadowsEnabled` at the top — defaults-off skips entirely.

**Validation:**
- Defaults-off counter check (still passes).
- Toggle `mainView.shadowsEnabled` on. Take screenshot. Compare to baseline screenshot of same camera pose.
- Pixel diff should be small (< 1%) — viewSun mirrors sunLight exactly, swap is mathematically a no-op for visible state.

**Pass:** Defaults-off counters unchanged. Shadows-on pixels match baseline within 1% (no shadows yet because no caster has `castShadow=true`).

**Rollback:** If pixels differ significantly, the swap is happening at the wrong point relative to `pushLookViewAtmosphereFog`. Per `CNodeView3D.js:827` and `:1733`, the fog push/pop wraps the render — swap must be INSIDE the fog push (sun visible during fog scope) but OUTSIDE the renderer.render call boundary. Test both arrangements.

#### Step 1.7 — `CNodeLighting.applyShadowConfig` orchestration (~1h)

**Code:** Add per §3.1: `_pendingFirstShadowConfig`, `applyShadowConfig`, `isAnyViewShadowsEnabled`. Wire `CNodeSunlight.update` hook for the first-call deferral. Wire GUI toggle to `applyShadowConfig` instead of view-local config.

**Validation:**
- Load sitch. In devtools: `NodeMan.get("lighting")._pendingFirstShadowConfig === true` initially. After one frame, becomes `false` (because `CNodeSunlight.update` ran).
- After `_pendingFirstShadowConfig` flips, `Globals.shadowsEnabled` is still `false` (no view toggled).
- Toggle `mainView.shadowsEnabled` on. `Globals.shadowsEnabled === true`. Counter `viewSunCreations === 1`. Toggle off: `Globals.shadowsEnabled === false`, counter unchanged.

**Pass:** Deferral works, transitions fire `viewSun` lazy-create exactly once on first ON.

**Rollback:** If deferral never fires, the hook in `CNodeSunlight.update` is wrong. If transitions fire multiple times, `_prevShadowsAnyEnabled` tracking is broken.

**Phase 1 gate test:** Defaults-off counters match baseline at sitch boot. Toggle `mainView.shadowsEnabled` on, see `viewSunCreations = 1`. Reload sitch (with toggle saved on). After load: counters = 1 viewSunCreations, 1+ materialNeedsUpdateWrites. Toggle off, reload again: counters back at baseline 0.

---

### Phase 2 — Renderer config: PCFShadowMap, frustum, bias (4-6h)

**Phase goal:** Shadow map renders at correct resolution/filter/bias when shadows are enabled, even though no casters opt in yet.
**Phase gate:** Manually set `castShadow = true` on a synthetic mesh; shadow appears on a flat ground plane in the right direction with no acne.

#### Step 2.1 — `PCFShadowMap` filter (~30 min)

**Code:** In `applyShadowRendererConfig`, after `shadowMap.enabled = true`, set `this.renderer.shadowMap.type = PCFShadowMap` (import from `"three"`). Per §3.2.

**Validation:** Toggle shadows on. Devtools: `NodeMan.get("mainView").renderer.shadowMap.type === 1` (PCFShadowMap value).

**Pass:** Value is 1. No console deprecation warning.

**Rollback:** If a warning appears, you accidentally used `PCFSoftShadowMap` (deprecated).

#### Step 2.2 — Origin-radius shadow frustum (~1h)

**Code:** `applyShadowFrustumOriginFallback` per §3.3. Called from `applyShadowRendererConfig` lazy-create block.

**Validation:** After enabling shadows + first sun update, devtools: `NodeMan.get("mainView").viewSun.shadow.camera.{near,far,left,right,top,bottom}`.

**Pass:** `near ≈ 55000, far ≈ 65000, left/right/top/bottom = ±5000` (with default `shadowRadius = 5000`).

**Rollback:** If `near < 0` or `far < near`, the formula has a sign error.

#### Step 2.3 — Shadow bias defaults (~30 min)

**Code:** Per §3.7 — `bias = -0.0005`, `normalBias = 5` (scaled = `shadowRadius / 5000 × 5`). Apply in lazy-create.

**Validation:** Devtools: `viewSun.shadow.bias === -0.0005 && viewSun.shadow.normalBias === 5`.

**Pass:** Matches.

#### Step 2.4 — Synthetic-mesh smoke test (~1.5h)

**Code:** Temporarily in `_enterShadowRenderScope`, OR via devtools at runtime: take ONE synthetic plane (or floor) mesh in the scene, set `mesh.castShadow = true; mesh.receiveShadow = true`. Pick a sitch where a plane object is positioned above the terrain.

**Validation:**
- Visual: shadow visible on terrain under the plane?
- No "shadow acne" stripes on lit terrain?
- No "Peter-Pan" (detached shadow) effect?

**Pass:** Clean shadow visible at expected location.

**Rollback:** If acne visible, bump `normalBias` to 10. If Peter-Pan, halve `bias`. If no shadow at all, frustum doesn't contain caster or receiver — check positions.

#### Step 2.5 — Defaults-off counter re-check (~30 min)

**Code:** Remove the temporary synthetic-mesh `castShadow = true` from Step 2.4. Reload.

**Validation:** Defaults-off counter check passes.

**Pass:** Counters match baseline.

**Rollback:** Some leftover state from spike-style debugging — find and remove.

#### Step 2.6 — `applyShadowMapConfig` for runtime size change (~1h)

**Code:** Per §3.2 `applyShadowMapConfig(newSize)` — dispose old `shadow.map`, set new size. Hook to a GUI control (placeholder; full GUI in Phase 7).

**Validation:** Devtools at runtime: `NodeMan.get("mainView").applyShadowMapConfig(2048)`. Check `viewSun.shadow.mapSize.x === 2048` and `viewSun.shadow.map === null` (or freshly allocated). Toggle shadows off and on. Verify no GL warnings about leaked render targets.

**Pass:** Size changes cleanly. No leak warnings in console.

**Phase 2 gate test:** Synthetic mesh in scene + manual `castShadow=true` → shadow renders correctly. Defaults-off counters still byte-identical to baseline.

---

### Phase 3 — Caster + receiver opt-ins on real geometry (4-6h)

**Phase goal:** Buildings, 3D objects, and (optionally) terrain start casting and receiving shadows when shadows are enabled. Toggle off restores byte-identity.

#### Step 3.1 — Buildings `load-model` handler (~1h)

**Code:** Modify `CNodeBuildings3DTiles.js:90-97` per §3.5. Gated on `Globals.shadowsEnabled`.

**Validation:**
- Toggle shadows on. Wait for tiles to load. Devtools: traverse one tile mesh, check `mesh.castShadow === true && mesh.receiveShadow === true`.
- Toggle shadows off. Reload sitch. Same traversal: `castShadow === false`. Defaults-off counters match baseline.

**Pass:** Castshadow flag flips correctly per tile load + per session.

**Rollback:** If flag isn't set, the `Globals.shadowsEnabled` snapshot at load time is wrong — confirm shadows are on BEFORE first tile loads.

#### Step 3.2 — Visual building-shadow smoke test (~1h)

**Validation:** Load a city sitch with buildings visible (chicago or similar urban). Enable mainView shadows. Visually confirm: building-shaped shadows on terrain in the expected direction.

**Pass:** Shadows visible and correct direction.

**Rollback:** Same diagnostic flow as Step 2.4 (frustum / bias).

#### Step 3.3 — `CNodeBuildings3DTiles.refreshShadowFlags` (~1h)

**Code:** Per §3.5. Walks `forEachLoadedModel` with `_didEverEnableShadows` guard.

**Validation:**
- Load sitch with buildings already on, shadows off (default).
- Counters at baseline. 
- Toggle shadows on. Already-loaded tile meshes now have `castShadow = true` (without reload).
- Toggle off. `castShadow = false` again.

**Pass:** Mid-session toggle works without needing to reload.

#### Step 3.4 — `CNode3DObject.refreshShadowFlags` (~1h)

**Code:** Per §3.6. Walk `this.group ?? this.object`. Hook into `applyShadowConfig`'s iteration.

**Validation:** Add a synthetic plane to chicago via custom sitch UI. Toggle shadows on. Plane casts shadow on terrain. Toggle off, no shadow.

**Pass:** Mid-session toggle works on synthetic objects.

#### Step 3.5 — Terrain receive toggle (~1h)

**Code:** Per §3.7. Add `terrainReceivesShadow` field to `CNodeLighting`. GUI toggle (top-level in Lighting menu). `QuadTreeTile.js:2081/2087` edits. `CNodeTerrain.refreshShadowFlags`.

**Validation:**
- Default off: no shadows visible on terrain even with buildings casting.
- Toggle "Terrain receives shadows" on: shadows appear on terrain.
- Toggle off: shadows disappear.
- Defaults-off (both shadows AND terrainReceivesShadow off): counter check passes.

**Pass:** Independent toggle works; defaults-off invariant holds.

#### Step 3.6 — Skirt mesh shadows OFF (~30 min)

**Code:** In `QuadTreeTile.js:2087` (skirt construction), unconditionally `skirtMesh.castShadow = false; skirtMesh.receiveShadow = false`.

**Validation:** With terrain receive on, check tile boundary seams. No seam artifacts from skirt shadows.

**Pass:** No seam artifacts visible.

**Phase 3 gate test:** Toggle all combinations of `{mainView shadows, lookView shadows, terrain receive}` mid-session. All transitions visually correct, no console errors, defaults-off counter byte-identity holds when all off.

---

### Phase 4 — Material modes (4-6h)

**Phase goal:** Photo / Flat / Half-photo material modes selectable from terrain GUI. Mode change applies to next tile load only (no on-the-fly retoggle).

#### Step 4.1 — Plugin constructor extension (~30 min)

**Code:** `TilesDayNightPlugin.js` constructor per §3.4 — accept `materialMode`, `flatColor`, `shadowsEnabled`. Store on plugin.

**Validation:** Build; pass options through `CNodeBuildings3DTiles` constructor. Devtools: inspect a `PerViewTiles.dayNightPlugin.materialMode === "photo"`.

**Pass:** Plugin receives options correctly.

#### Step 4.2 — `applyMaterialMode` (gated for photo) (~1h)

**Code:** Per §3.4. Critical: `processTileModel` only calls `applyMaterialMode` when `materialMode !== "photo"`. Increment `Globals.shadowDiagCounters.materialModeApplications` in the function body.

**Validation:**
- Default photo mode: counter `materialModeApplications === 0` after loading tiles.
- Switch to flat mode in code (Step 4.3 will add GUI). Reload. Counter > 0.

**Pass:** Counter stays at 0 in photo mode; non-zero in flat mode.

**Rollback:** If counter increments in photo mode, the gate is missing.

#### Step 4.3 — GUI dropdown for material mode (~1h)

**Code:** Add to `CNodeTerrainUI` per §3.9 — dropdown {Photo / Flat / Half-photo} + flat colour picker (visible only when mode=Flat). `setMaterialMode(mode, flatColor)` on `CNodeBuildings3DTiles` that updates plugin state for FUTURE loads only.

**Validation:**
- GUI control visible.
- Change to Flat. Existing tiles look unchanged (already loaded). Camera-pan to a region that triggers new tile loads. New tiles render with flat material.
- Toggle buildings off then on → all reload as flat.

**Pass:** Future-load semantics work; no console errors.

**Rollback:** If existing tiles change mid-session, the implementation accidentally walked loaded tiles (forbidden — breaks fade plugin).

#### Step 4.4 — `convertSRGBToLinear` correctness check (~30 min)

**Code:** Per §3.4 — `replacement.color.setHex(flatHex).convertSRGBToLinear()`.

**Validation:** Switch to Flat with hex `0xc0b8a8`. Take screenshot. Pick a non-shadowed pixel of a building. Check colour with eyedropper — should be close to the actual sRGB hex `0xc0b8a8` after Three.js's tone-mapping inverse. If buildings look washed-out (much lighter than `0xc0b8a8`), `convertSRGBToLinear` is missing.

**Pass:** Building colour matches the chosen flat colour reasonably.

#### Step 4.5 — Half-photo mode (~30 min)

**Code:** Per §3.4 — `replacement.color.setRGB(0.6, 0.6, 0.6)` keeps `map`.

**Validation:** Switch to Half-photo. Existing tiles unchanged; new tiles render dimmer with photo texture. Direct shadow contrast more visible.

**Pass:** Photo texture still visible but dimmer.

#### Step 4.6 — Defaults-off counter re-check (~30 min)

**Validation:** Set mode back to Photo. Reload sitch. All counters at baseline.

**Pass:** Photo-default path is byte-identical.

**Phase 4 gate test:** Cycle through Photo → Flat → Half-photo → Photo. Camera-pan to trigger new tile loads between each mode. New tiles match the mode at load time. Defaults-off counter byte-identity holds in Photo mode.

---

### Phase 5 — Temporal coherence + exporter hook (4-5h)

**Phase goal:** Shadows update smoothly with sitch time but throttled. Image Set exporter renders correct shadows per captured pose.

#### Step 5.1 — `shadowUpdateMinIntervalMs`, `shadowUpdateAngleThreshold` fields + GUI (~1h)

**Code:** Add to `CNodeLighting` per §3.8 — fields, addSimpleSerial, GUI sliders.

**Validation:** GUI sliders visible. Default values: 50 ms, 0.25°.

**Pass:** Sliders visible and serialised.

#### Step 5.2 — `Globals_propagateSunAndThrottle` hook (~1.5h)

**Code:** Per §3.8. Called from `CNodeSunlight.update` only when `Globals.shadowsEnabled`.

**Validation:**
- Defaults-off: function never called (gated). Counter check passes.
- Shadows on, paused at frame 0: should call once (firstUpdate), then no further updates.
- Add console.log in the `if (firstUpdate || angleDeg >= minAngleDeg)` branch. Confirm fires once.

**Pass:** Single firstUpdate when paused; subsequent paused frames don't re-fire.

#### Step 5.3 — Playback throttle test (~1h)

**Validation:**
- Set sitch to 60× playback. Start playback. Watch console log frequency.
- Expected: roughly 1 update / sec at 60× (sun moves 0.24°/sec, threshold 0.25° → 1/sec).
- Check `info.render.calls` per frame is approximately constant — shadow re-renders shouldn't double per-frame cost.

**Pass:** Cadence matches expectation. Per-frame call count stable.

**Rollback:** If updates fire every frame, the angle threshold isn't doing its job — log `angleDeg` to debug.

#### Step 5.4 — Scrubbing throttle test (~30 min)

**Validation:** Scrub the time slider rapidly. Expect ≤ 20 updates / sec (capped by min-interval). Frame rate should stay above 10 fps even during scrub.

**Pass:** Cap enforced, no frame rate collapse.

#### Step 5.5 — Reset-on-transition (~30 min)

**Code:** In `applyShadowRendererConfig`, when `transitioned && want`, clear `this._lastShadowSunDir = null; this._lastShadowUpdateMs = 0` per §3.2.

**Validation:** Pause for 5 seconds (no shadow updates). Toggle shadows off then on. First frame after toggle should show shadow immediately (not wait 50 ms).

**Pass:** Shadow appears within one frame of toggle on, not after a 50 ms gap.

#### Step 5.6 — `forceShadowRefreshForExport` helper + Image Set hook (~1h)

**Code:** Per §3.10. Add helper. Modify `ExportImageSet.js:218`'s `renderShot` to call it.

**Validation:**
- Run Image Set export with shadows enabled. Open the resulting zip.
- For two adjacent captures (close az/el), shadow directions should look correct per their respective sun positions (not stale from throttle).

**Pass:** Exported shadows match sitch time per capture, not throttled.

**Phase 5 gate test:** Visually inspect playback (smooth shadow motion), scrubbing (no frame collapse), pause-then-toggle (immediate shadow), exported image set (correct per-frame shadows).

---

### Phase 6 — Serialisation + i18n + GUI organisation (3-5h)

#### Step 6.1 — All `addSimpleSerial` fields wired (~1h)

**Code:** Audit checklist:
- `CNodeLighting`: `shadowMapSize`, `shadowRadius`, `shadowBias`, `shadowNormalBias`, `shadowUpdateMinIntervalMs`, `shadowUpdateAngleThreshold`, `terrainReceivesShadow`.
- `CNodeView3D`: `shadowsEnabled`, `allowMobileShadows`.
- `CNodeTerrainUI`: `buildingsMaterialMode`, `buildingsFlatColor`.

**Validation:** Set non-default values for each. Save sitch. Reload. All values restored.

**Pass:** All fields round-trip correctly.

#### Step 6.2 — `CustomManagerSerialize.js` TerrainModel blocks (~1h)

**Code:** Add `buildingsMaterialMode` and `buildingsFlatColor` to BOTH blocks at lines 131 and 207 per §3.11.

**Validation:** Save a modded sitch with material settings. Reload. Material persists. Edit sitch data, reload. Settings still correct.

**Pass:** Modded-sitch round-trip works.

#### Step 6.3 — i18n English keys (~1h)

**Code:** Add all keys from §3.9 to `src/i18n/en.js`. Verify with grep that no `t("...")` calls in new code lack a corresponding key.

**Validation:** Load sitch. All new GUI labels show English text (not the key path `lighting.shadowMapSize.label`).

**Pass:** All labels render as English.

#### Step 6.4 — GUI subfolder organisation (~1h)

**Code:** Lighting menu collapsed "Shadow tweaks" sub-folder per §3.9. Terrain menu organisation.

**Validation:** GUI looks tidy. Shadow controls grouped under collapsible folder. Per-view toggle on each view's tweaks.

**Pass:** Layout matches §3.9 spec.

**Phase 6 gate test:** Save a custom sitch with all knobs set to non-defaults. Reload. Every value preserved. UI labels all English. Defaults-off counter check still passes.

---

### Phase 7 — Tests + local fixture + perf trace (8-12h)

#### Step 7.1 — Unit tests (~2h)

**Code:** Add Jest tests per §4.1:
- `tests/applyShadowFrustum.test.js`
- `tests/applyMaterialMode.test.js`
- `tests/defaultsOffInvariant.test.js`
- `tests/throttleCadence.test.js`
- `tests/shadowSerialisationRoundTrip.test.js`

**Validation:** `npm test`.

**Pass:** All tests pass.

#### Step 7.2 — Local tile fixture (or credential-gated decision) (~2h)

**Code:** Either:
- (a) Bundle a tiny local 3D Tiles set into `tests_regression/` (preferred), or
- (b) Document that credential-gated regression tests skip on CI without credentials.

**Validation:** `npm run test-regression` runs successfully on a fresh checkout without API keys.

**Pass:** Decision made and documented in CLAUDE.md or the plan.

#### Step 7.3 — Regenerate existing GUI-bearing baselines (~2h)

**Code:** Identify which existing snapshots include the right-sidebar GUI panels (audit `test-registry.js`). Regenerate via `npm run test-ui-update`.

**Validation:** `npm run test-regression` passes. Eyeball the regenerated baselines — only GUI rows shifted, not actual scene content.

**Pass:** All existing baselines pass with regenerated PNGs. New PNGs committed.

#### Step 7.4 — Add 6 new regression baselines (~2h)

**Code:** Per §4.2, add `chicago-buildings-shadows-*` cases to `regression.test.js` + `test-registry.js`. Run `npm run test-ui-update` to capture initial baselines.

**Validation:** Eyeball each new baseline — shadows visible, correct material, no obvious bugs. `npm run test-regression` passes.

**Pass:** 6 new baselines committed and passing.

#### Step 7.5 — Performance trace per tier (~2h)

**Code:** Per §5. Instrument with `EXT_disjoint_timer_query_webgl2` (or `performance.now()` fallback). Test on desktop discrete GPU + integrated laptop.

**Validation:** Per-update shadow render cost recorded for each tier. Document in plan or developer notes.

**Pass:** Numbers within budget (§5 table) OR exceed budget and the exceedance is documented + acceptable.

**Phase 7 gate test:** `npm test && npm run test-regression` both pass. Perf numbers within budget on at least desktop tier.

---

### Phase 8 — Ship (2-3h)

#### Step 8.1 — Manual run on urban sitch (~1h)

**Validation:** Load chicago. Toggle all combinations. Take screenshots. Open in Preview. Visually confirm: shadows direction matches sun, no acne, no Peter-Pan, no flicker during playback.

**Pass:** Visual sanity check passes.

#### Step 8.2 — WhatsNew + commit (~1h)

**Code:** Add WhatsNew entry per §6 draft. Commit all changes (the explicit "git commit" greenlight required per `feedback_explicit_git_authorization.md`).

**Validation:** `git status` clean after commit. `git log -1` shows the new commit.

**Pass:** Single clean commit with full feature.

#### Step 8.3 — `/ship` as 2.57.0 minor (~30 min)

**Code:** Per `feedback_explicit_ship_only.md`, REQUIRES explicit per-push user authorization. Do not ship without it.

**Validation:** After `/ship` runs: `git ls-remote --tags origin | grep 2.57.0`. WhatsNew shows new entry. Build banner reads 2.57.0.

**Pass:** Tag pushed, build deployed, WhatsNew live.

---

### Total time budget

| Phase | Hours |
|---|---:|
| 0 — Architecture spike | 6-10 |
| 1 — Infrastructure | 6-8 |
| 2 — Renderer config | 4-6 |
| 3 — Caster/receiver opt-ins | 4-6 |
| 4 — Material modes | 4-6 |
| 5 — Throttle + exporter | 4-5 |
| 6 — Serialisation + i18n | 3-5 |
| 7 — Tests + fixtures + perf | 8-12 |
| 8 — Ship | 2-3 |
| **Total** | **41-61 (~5-8 days)** |

Each step ends with the working tree in a buildable, loadable, defaults-off-invariant-respecting state. If any step fails its validation, revert to the prior step's state before debugging — don't accumulate broken state across steps.

---

## 9. Out of scope (V1) + DO-NOT-DO list

V1 explicitly excludes:
- Cascaded Shadow Maps.
- VSM / PCSS soft shadows. (Phase 0 may reveal need; if so, defer to V1.5.)
- On-the-fly material mode toggle on already-loaded tiles. (Breaks `TilesFadePlugin`.)
- `vertexColor` material mode. (Tile sources don't ship `COLOR_0`.)
- Camera-following shadow frustum. (Bounds-fitting in §3.3 covers the common case.)
- Single-renderer-with-viewports refactor.
- Atmospheric scattering ↔ shadows integration beyond Three.js defaults.
- IR mode + shadows interaction.
- `MeshDepthMaterial` shader-discard correctness for edges plugin.
- Per-tile material customisation.
- Skirt `receiveShadow` (always off due to seam artifacts).

**DO NOT DO (anti-patterns from prior plan revisions):**
- **DO NOT** set `Globals.sunLight.layers.mask = MASK_WORLD | MASK_TARGET` (v3's approach). Three.js filters light layers against the *render camera*, not per-mesh — this design produces double-lighting on combined-layer meshes. Use render-scoped sun swap (§2) instead.
- **DO NOT** set `shadowSun.intensity = 0` and expect shadows to be visible. Intensity-0 lights have zero contribution to the lighting equation; their shadow term is multiplied by zero. There is no "shadow-only" light in Three.js.
- **DO NOT** share a `shadow.map` across renderers. Each `WebGLRenderer` has its own GL context; `WebGLRenderTarget` is context-bound.
- **DO NOT** re-walk loaded tiles to apply a new material mode. `TilesFadePlugin.FadeMaterialManager` keys WeakMap by material identity; replacing materials orphans entries and pops fading tiles. Mode change applies on next tile load only.
- **DO NOT** use `PCFSoftShadowMap` — deprecated in three@0.183.1, downgrades silently to `PCFShadowMap` with console warning.
- **DO NOT** call `applyMaterialMode` in the default `photo` path. Skip the call entirely; even a no-op function call is observable to §0 invariant verification.
- **DO NOT** assume `node.constructor.name === "X"` is mangled — `webpack.common.js:361` keeps class names. Just use it.

---

## 10. Files touched manifest

For PR checklist + reviewer orientation:

**Source files modified:**
- `src/Globals.js`
- `src/nodes/CNodeLighting.js`
- `src/nodes/CNodeSunlight.js`
- `src/nodes/CNodeView3D.js`
- `src/nodes/CNode3DObject.js`
- `src/nodes/CNodeBuildings3DTiles.js`
- `src/nodes/CNodeTerrain.js`
- `src/nodes/CNodeTerrainUI.js`
- `src/QuadTreeTile.js`
- `src/TilesDayNightPlugin.js`
- `src/CustomManagerSerialize.js`
- `src/ExportImageSet.js`
- `src/i18n/en.js`

**Tests added:**
- `tests/applyShadowFrustum.test.js`
- `tests/applyMaterialMode.test.js`
- `tests/defaultsOffInvariant.test.js`
- `tests/throttleCadence.test.js`
- `tests/shadowSerialisationRoundTrip.test.js`
- `tests_regression/regression.test.js` (new cases)
- `test-registry.js` (new entries)
- `tests_regression/regression.test.js-snapshots/` (new + regenerated PNGs)

**Docs:**
- `docs/WhatsNew.md` (new entry at top, version bumped)

---

## 11. Glossary

- **`Globals.sunLight`** — the existing single shared `DirectionalLight` on `MASK_LIGHTING`. Stays the single source of *direction* + *intensity* + *colour* truth. Its `visible` flag is toggled per-render in shadow-system mode.
- **`viewSun`** — per-`CNodeView3D` `DirectionalLight` instance, created lazily on first transition to effective-on. Lives in GlobalScene with `visible = false`; flipped to `true` only during its owning view's render. Its `shadow.map` is owned by its view's renderer's GL context.
- **`shadowsEnabled`** (per view) — the user-facing toggle on each `CNodeView3D`. Serialised.
- **`allowMobileShadows`** (per view) — override for the mobile auto-disable.
- **`areShadowsEffective()`** (per view) — the runtime gate: `shadowsEnabled && (!isMobile || allowMobileShadows)`. Used everywhere the effective state matters.
- **`Globals.shadowsEnabled`** — module-level flag set to `true` when at least one view is effectively-on. Read by load-model handlers, terrain construction, throttle loop, etc. for fast §0 short-circuits.
- **"Shadow-system mode"** — when at least one view has `areShadowsEffective() === true`. In this mode, `Globals.sunLight.visible` is render-scoped (false during view renders, true outside). When no view is effective, the system is in **"legacy mode"** — `Globals.sunLight.visible = true` always.
- **"Defaults-off invariant"** — the §0 rule: legacy mode runtime is byte-identical to pre-PR runtime.
- **"Throttle"** — the per-view rate-limit on `viewSun.shadow.needsUpdate` writes from §3.8.

---

## 12. Shadow bias tuning debugging guide

Symptoms → causes → fixes:

| Symptom | Cause | Fix |
|---|---|---|
| Dark stripes/spots on lit surfaces ("shadow acne") | `bias` too small / `normalBias` too small for shadow camera scale | Increase `\|bias\|` (more negative) by 0.0001 increments; increase `normalBias` by 0.5 increments. |
| Shadows look disconnected from caster ("Peter-Pan") | `bias` too negative | Reduce `\|bias\|`. |
| Shadows appear and disappear as camera flies | Frustum too small for scene; bounds-fitting failing | Raise `shadowRadius`; check Phase 0 bounds-fit logs. |
| Shadows on terrain are blocky/staircased | `shadowMapSize` too small for scene | Bump to 2048 or 4096 if GPU memory allows. |
| Shadows lag behind sun motion during playback | Throttle too aggressive | Lower `shadowUpdateAngleThreshold` or `shadowUpdateMinIntervalMs`. |
| Performance tanks during scrubbing | Throttle too permissive at scrub speeds | Raise `shadowUpdateMinIntervalMs`. |
| Frame rate drops sharply when enabling shadows | Map size too high for hardware tier | Drop to 1024; check `renderer.info.memory.textures`. |

Tuning workflow:
1. Disable terrain receive first (eliminate variables).
2. Start with `bias = -0.0005, normalBias = 5, mapSize = 1024, shadowRadius = 5000`.
3. Scrub through dawn/noon/dusk; tune `bias`/`normalBias` until acne and Peter-Pan are both absent.
4. Enable terrain receive; re-tune if needed.
5. Test on lowest-tier hardware before committing.

---

## Appendix A — Reviewer findings consolidated into v5

### Lighting specialist
- **REJECTED V3's lighting-mask flip** — Three.js light layers filter against render camera, not per-mesh. V5 §2 uses V4's render-scoped sun swap. (See DO-NOT-DO list.)
- Adopted V4 per-view bounds-fitting with origin-radius fallback.
- Adopted `PCFShadowMap` (V3/V4 agree).
- `normalBias = (shadowRadius / 5000) × 5 ≈ 5` at default radius (~1 texel at 2048²), scaling V3's formula with the lighting reviewer's corrected magnitude.
- Mirror `viewSun.position`, `.color`, `.intensity`, `.target.position` per V4.
- Flagged: `DayNightStandardMaterial.js:130-140` night-side multiply runs after `<fog_fragment>`, dimming fog colour on the night side — pre-existing bug, documented in §3.13.
- Confirmed: shadow + HDR-tone-mapping interaction is correct (shadow in linear HDR space, then tone-mapped).

### Architecture synthesis reviewer
- Confirmed all-agreed items (defaults-off, PCFShadowMap, per-view independence, material mode dropdown, etc.).
- Resolved disagreements with explicit verdicts (now in §0 headline table).
- Cherry-picked V3's §3.12 throttle, §3.14 exporter hook, §0.1 invariant + verification gates, edges-plugin caveat, deferred-first-apply rationale.
- Cherry-picked V4's render-scoped sun swap, bounds-fitting, instrumentation counters, mobile semantics.
- Cherry-picked V2's per-renderer enable simplicity and budget tier table.
- Dropped V3's MASK_LIGHTING flip narrative, V3's universal ms perf budgets, V2's deprecated TBD lists.

### Implementation realism reviewer
- 4 days = wrong; v5 budgets 5-8 days (~41-61h) with Phase 0 blocking spike.
- Added: files-touched manifest (§10), glossary (§11), shadow bias debugging guide (§12), exact WhatsNew draft text (§6), known-issues section (§3.13), DO-NOT-DO list (§9).
- Cut: V3's 56 KB length; removed "v1/v2.1/v3 findings applied" appendix that recapped plan history; consolidated GUI duplication; cut `EPSILON_FOR_SHADOW = 0.001` rejected-alternative discussion.
- Phase ordering: adopted V4's blocking Phase 0 spike; rejected V3's "½ day for phase 3" optimism.
- Test plan: explicit baseline regeneration as a ship step; explicit local-fixture-or-credential-gated decision.
- Worst under-budgeted item across plans: regression baseline work — v5 §4.2 + Phase 7 give it 8-12 hours.

### User direction baked in (2026-05-20)
- Defaults-off invariant elevated to §0.
- Per-view independent shadow rendering (different LOD geometry → different shadow geometry; multi-context texture sharing impossible anyway).
- Smooth-but-not-every-millisecond temporal coherence (§3.8 throttle with named knobs).
- No blind file overwrite: v5 was created with explicit `[ -e ]` pre-check (no v5 existed prior to write).
