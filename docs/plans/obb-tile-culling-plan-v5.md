# Plan V5: Conservative OBB-Based Tile Culling

**Status:** Draft V5 after multi-agent critique of V4.
**Supersedes:** `docs/plans/obb-tile-culling-plan-v4.md`.
**Targets:** `src/QuadTreeTile.js`, `src/QuadTreeMap.js`, `src/QuadTreeMapTexture.js`, `src/QuadTreeMapElevation.js`, `src/QuadTreeTileMaterial.js`, `src/nodes/CNodeTerrainUI.js`, `src/nodes/CNodeView3D.js`, plus a new helper module `src/QuadTreeCullingBounds.js` and tests.

---

## 0. What changed since V4

V4 had the right safety posture and most of the design. Review found several concrete issues. V5 corrections:

| V4 issue | V5 fix |
| --- | --- |
| §9 claims "Performance Tweaks" folder doesn't exist | It does — `CustomSupport.js:474`. GUI controls land there. |
| §5.1 says skirt vertices share the main vertex loop. Skirts are built/repositioned in `updateSkirtGeometry()` (`QuadTreeTile.js:386-486`), a *separate* pass that runs AFTER the main loop and reads its output. | V5 commits to **skirt measurement in the existing `updateSkirtGeometry()` pass**, not inline. Drops the "inflate downward" alternative. |
| §6.1 grid threshold (z<6 → 5×5, z≥6 → 3×3) is a round number with no rationale | V5 derives the threshold from the bow-vs-margin ratio: at z=6 the worst-case Web-Mercator face bow ≈ 5 km, which is `BOUNDS_INFLATE_M × 500` — a 3×3 grid captures it adequately. Documented. |
| §6.2 pole fallback: the first fallback `north = (0, 0, ±1)` projects to zero at the exact pole, never producing a usable vector — falls through to the second always | V5 drops the first fallback. Direct second fallback `north = (1, 0, 0).projectOnPlane(up)`. Unit test at exact pole. |
| §8.1 `calculateTileVisibility(tile, camera, diag=null, options={})` — default `{}` silently disables every new field; the cache key becomes `undefined\|undefined\|...` | V5 makes options **required**, diag remains last optional: `calculateTileVisibility(tile, camera, options, diag = null)`. Throws in development if `options.viewId`/`passId` missing. |
| §8.2 string-concat cache key on every visibility call | V5 specifies a bit-packed numeric key (matches `LayerMasks.js` convention) and a 4-entry cap per tile, evicting oldest. |
| §3 stores 5 fields on QuadTreeTile (`altitudeBounds`, `cullingSphere`, `cullingOBB`, `cullingBoundsGeneration`, `visibilityCache`) at top level | V5 splits: `tile.altitudeBounds` (input, source-tracked) vs `tile.cullingState = { sphere, obb, localFrame, generation, visibilityCache }` (derived, cohesive lifecycle). |
| §4 helper module list is missing pieces the algorithm needs: skirt vertex generation, local-frame `→` ECEF transform, dilated projection construction | V5 adds `buildSkirtVertexSet`, `localToECEF`, `buildDilatedProjectionMatrix`. |
| §4 `buildFallbackPointSet(tile, ...)` is over-coupled to `QuadTreeTile` — unit-testing requires instantiating a real tile | V5 takes pure data: `buildFallbackPointSet(tileBounds, altitudeBounds, options)` where `tileBounds = {z, x, y, getNorthLatitude, getLeftLongitude, mapProjection}`. |
| §4 helper file name `TileCullingBounds.js` doesn't sort with its callers | Rename to `QuadTreeCullingBounds.js`. |
| Missing **forward inheritance refresh**: when parent commits `renderedGeometry` measurement, descendants with `source: "inherited"` keep slack computed against the parent's *old* (smaller) bounds — child becomes non-conservative if the new parent max exceeds inherited slack | V5 mandates: parent `commit()` walks `source: "inherited"` descendants and bumps their `cullingBoundsGeneration`. Next visibility call re-derives inherited bounds against the new parent. This is forward propagation (ancestor→descendant), distinct from the prohibited back-propagation. |
| §9 declares `Globals.visibilityPassId` without specifying when it bumps | V5: bumps **once per outer render frame** (in the main animate tick), not per `subdivideTilesViewSpecific` call. |
| §9 lists `Sit.forceLegacyCull` once; precedence vs URL vs runtime undefined; storage scope undefined | V5: drops `Sit.forceLegacyCull` as redundant. The existing `Globals.tileBoundsMode` plus URL parameter cover the same need. Sitch override goes via `Sit.tileBoundsMode = {...}` in the sitch JSON if needed. Precedence: URL > sitch > runtime > default. |
| §2 inventories the reach-cull at `QuadTreeMap.js:1047-1081` as "existing behavior" — but that code is uncommitted from the prior session | V5 labels it explicitly as **in-flight scaffolding**, gates it behind a new flag `Globals.enableReachCull` (default `true` in `legacy`/`metrics`, default `false` in `sphere`/`obb`), and the Phase 4 redesign is the disposition. |
| Phase 0A bundles options-plumbing with bounds-source counters that can't exist until Phase 1's measurement lands | V5 splits Phase 0 into 0.0 (fixture), 0.1 (pass id + options plumbing only), 0.2 (helper module + unit tests). Bounds-source counters move to Phase 1. |
| Phase 1 bundles 5 distinct edits | V5 splits Phase 1 into 1.0 (data model + activateTile reorder + bounds construction from existing `highestAltitude`), 1.1 (transactional measurement in `recalculateCurveOptimized` only, behind flag), 1.2 (other recalc paths + skirt coverage via `updateSkirtGeometry`). |
| `visibleAreaCoveredByDescendants` recursion never had `options` threading specified | V5 specifies the full thread: `deactivateParentsWithLoadedChildren(tileLayers, camera, options)` → `visibleAreaCoveredByDescendants(tile, mask, camera, options)` → recursive call injects `coverageMode: "coverageSphereOnly"`. |
| Cache key uses "tileLayers" without specifying whether it's the view mask or `tile.tileLayers` (the latter changes mid-pass during cascade) | V5: cache key uses **the view's** `tileLayers` mask, not the tile's. |
| §10.3 scenario 13 "aborted tile load/recalc" had no concrete recipe | V5: direct abort via MCP: pick a loading tile from `map.allTiles` filtered on `isLoading`, then `sitrec_eval('tile.elevationAbortController.abort()')`. |
| Phase 1.5 soak gating relied on absence-of-feedback from a non-existent telemetry pipeline | V5 replaces with Playwright sweep + `activeTileHash` parity across a recorded camera path between `metrics` and `legacy` modes. |
| `OBB` import path: `"3d-tiles-renderer/three"` pulls shared rollup chunks vs `"3d-tiles-renderer/src/three/renderer/math/OBB.js"` for tree-shaken minimal | V5: prefer the minimal path. Bundle measurement in Phase 0.2 confirms. |
| `getWorldSphere()` migration described as fan-out; actually has **one** caller | V5: rename in place, delete the alias the same release Phase 2 ships. |
| `OBB` construction has no guard against empty point set (returns Box3 in `+Inf/-Inf` state silently) | V5: `buildCullingOBB` asserts `points.length >= 1` and throws on invalid bounds. |

V4 claims V5 keeps unchanged:
- `import { OBB }` from NASA's package resolves cleanly via `package.json` `exports` (already verified in v3 review and re-verified now via the minimal path).
- Plane orientation conventions between Three.js Frustum and NASA OBB are compatible (Three.js extracts inward-pointing frustum normals; NASA's `_intersectsPlaneShape` rejects when `maxDistance < 0` — same convention, no catastrophic sign bug).
- `Matrix4.makeBasis(...).setPosition(...)` chain works as written.
- `Vector3.applyMatrix4` does the perspective divide; the §7 unproject-via-inverse-VP is correct.
- NASA's `OBB.intersectsFrustum` two-pass SAT is conservative (overdraws, doesn't underdraw).
- Three.js 0.183.1 + 3d-tiles-renderer 0.4.21 are version-compatible.

---

## 1. Goals (unchanged from V4)

1. **No false negatives in production-default paths.** Drawing extra terrain is acceptable; hiding visible terrain is not.
2. **Rendered geometry is authoritative.** Only completed vertex + skirt geometry sets `measured: true`.
3. **Predictive bounds are conservative and clearly labelled.** `global`/`inherited`/`elevationData` never become `measured: true`.
4. **REPLACE-refinement invariants remain intact.**
5. **Every rollout step is flag-revertible.** Legacy stays available until OBB mode survives at least one release.
6. **MCP is the primary development validation tool.** Playwright is the narrow CI gate.

---

## 2. Current behavior inventory

These facts shape the work. All verified against the current code.

| Current behavior | Citation |
| --- | --- |
| `QuadTreeTile.getWorldSphere()` caches a permanent four-corner sea-level sphere | `QuadTreeTile.js:168` |
| Visibility shifts that sphere radially by `highestAltitude` or a parent's `highestAltitude` | `QuadTreeMap.js:930` |
| Strict and dilated Three.js frustums already built in subdivide pass | `QuadTreeMap.js:492-511` |
| SSE computed from tile span, latitude, viewport height, FOV, projected distance | `QuadTreeMap.js` SSE block |
| **In-flight, uncommitted** ancestor-guarded frustum max-reach cull from the prior session | `QuadTreeMap.js:1066-1082` |
| Texture activation kicks off `recalculateCurve()` before assigning `tile.parent` | `QuadTreeMapTexture.js:528` kickoff vs `:541` parent |
| Elevation activation has the safer order | `QuadTreeMapElevation.js` |
| `Globals.showTileStats` exists; `Globals.frameCounter` and `Globals.visibilityPassId` do not | confirmed via MCP `sitrec_eval` |
| `visibleAreaCoveredByDescendants()` recurses through children calling `calculateTileVisibility()` | `QuadTreeMapTexture.js:286-327` |
| "Main Use Look Layers" rewrites terrain/building masks during `CNodeView3D` render | `CNodeView3D.js:1673` |
| `getWorldSphere()` has exactly **one** non-definition caller | `QuadTreeMap.js:931` |
| Skirts are built at construction by `buildSkirtGeometry()` and repositioned by `updateSkirtGeometry()` after each main-mesh recalc | `QuadTreeTile.js:265-486`; called from each recalc path (Old `:1009-1011`, Optimized `:1190-1192`, Flat `:1265-1267`, WebMercator `:1393-1395`) |
| Skirt depth is per-tile: `this.size * 0.1` | `QuadTreeTile.js:269,390` |
| Elevation decode paths populate `tile.elevation` but track no min/max stats | `QuadTreeTile.js:1864/1888/1911` |
| `elevationAbortController` set in `recalculateCurveWebMercator` | `QuadTreeTile.js:1363` |
| Performance Tweaks GUI folder exists | `CustomSupport.js:474` |

---

## 3. Data model

Two structs on `QuadTreeTile`:

```js
// INPUT: source-tracked altitude band.
this.altitudeBounds = {
    min: GLOBAL_UNMEASURED_MIN_ALT_M,
    max: GLOBAL_UNMEASURED_MAX_ALT_M,
    source: "global",   // "global" | "inherited" | "elevationData" | "renderedGeometry"
    measured: false,
    generation: 0,      // bumps on commit + on forward inheritance refresh
};

// DERIVED: bounding volumes + per-frame visibility memo.
this.cullingState = {
    sphere: null,          // built from same point set as obb
    obb: null,             // null for z<3 or unsafe point sets
    localFrame: null,      // { east, north, up } for re-projection / debug
    generation: 0,         // matches altitudeBounds.generation when fresh
    visibilityCache: null, // bit-packed-key → result, capped at 4 entries
};
```

Constants:

```js
const GLOBAL_UNMEASURED_MIN_ALT_M = -1500;
const GLOBAL_UNMEASURED_MAX_ALT_M = 10000;     // 30,000 ft + headroom
const INHERITED_MIN_SLACK_M       = 500;
const INHERITED_MAX_SLACK_M       = 1500;
const BOUNDS_INFLATE_M            = 10;
const VIS_CACHE_CAP_PER_TILE      = 4;
```

### 3.1 Inheritance (`source: "inherited"`)

```js
function inheritBoundsFromParent(parent) {
    const inheritedMin = parent?.altitudeBounds?.measured
        ? parent.altitudeBounds.min - INHERITED_MIN_SLACK_M
        : GLOBAL_UNMEASURED_MIN_ALT_M;
    const inheritedMax = parent?.altitudeBounds?.measured
        ? parent.altitudeBounds.max + INHERITED_MAX_SLACK_M
        : GLOBAL_UNMEASURED_MAX_ALT_M;

    return {
        min: Math.min(inheritedMin, GLOBAL_UNMEASURED_MIN_ALT_M),
        max: Math.max(inheritedMax, GLOBAL_UNMEASURED_MAX_ALT_M),
        source: "inherited",
        measured: false,
        generation: 0,
    };
}
```

### 3.2 Forward inheritance refresh (new, addresses false-negative risk)

When a tile commits a `renderedGeometry` measurement, **walk descendants whose `source` is `"inherited"` and bump their `cullingBoundsGeneration`.** Their next visibility access re-runs `inheritBoundsFromParent()` against the parent's now-measured (and possibly higher) bounds.

```js
QuadTreeTile.prototype.commitRenderedBounds = function (min, max) {
    this.altitudeBounds = {
        min, max, source: "renderedGeometry",
        measured: true,
        generation: this.altitudeBounds.generation + 1,
    };
    this.cullingState.generation = -1;  // force rebuild on next access
    refreshInheritedDescendants(this);  // forward propagation
};
```

Without this rule, a child inheriting `parent.max + 1500m` against an early parent measurement of `parent.max = 200m` can stay at `child.max = 1700m` when the parent later refines to `parent.max = 3500m` — child becomes non-conservative, violating §1.1.

Back-propagation (child → parent) remains prohibited.

### 3.3 `cullingBoundsGeneration` bump rules (exhaustive)

Bump on:
1. `commitRenderedBounds()` (own measurement landed).
2. Forward refresh: ancestor commits → walk descendants whose `source: "inherited"` and bump.
3. `Globals.equatorRadius` / `Globals.polarRadius` change (ellipsoid model). Whole-terrain rebuild already disposes tiles, so generally moot — but if any tile survives, it must bump.
4. `Globals.elevationScale` change: at the **start** of `recalculateCurveMap`, mark all affected tiles' `cullingState.generation = -1` so subdivision passes mid-recalc don't read stale OBBs.
5. `tileSegments` change (full terrain rebuild already disposes; defensive).
6. `dispose()` / recreation: state goes with the tile.

Do NOT bump on:
- `tile.tileLayers` changes from activate/deactivate (geometry didn't change).
- Camera movement (visibility cache key handles this via `cameraGeneration`).

---

## 4. Helper module: `src/QuadTreeCullingBounds.js`

Pure module. Owns geometry math. `QuadTreeTile` owns state. Co-locates alphabetically with the six `QuadTree*.js` callers.

### 4.1 Public surface

```js
// Inheritance
export function inheritBoundsFromParent(parentAltitudeBounds);

// Local frame
// Returns { east, north, up, polarFallbackUsed }. Three new Vector3s per call.
export function buildLocalFrame(centerECEF, lat, lon);

// Point sets
// Pure data inputs; no QuadTreeTile reference.
export function buildFallbackPointSet(tileBounds, altitudeBounds, options);
// tileBounds = { z, x, y, getNorthLatitude, getLeftLongitude, mapProjection }

// Skirt
// Returns the additional vertex point set generated from a tile's main-mesh
// outer edge plus its known skirtDepth = tile.size * 0.1.
export function buildSkirtVertexSet(outerEdgeVerticesECEF, originECEF, skirtDepth);

// Sphere + OBB
// Both return freshly allocated objects. Callers replace tile.cullingState.{sphere|obb}.
export function buildCullingSphere(points, count);
export function buildCullingOBB(points, count, localFrame, originECEF);  // asserts count >= 1

// Local-to-ECEF helper for debug / re-projection
export function localToECEF(originECEF, localFrame, localVec, outECEF);

// Frustum shape (write into preallocated scratch)
// shape = { planes: Plane[6], points: Vector3[8], frustum: Frustum }
export function buildFrustumShape(shape, camera, projectionMatrix);

// Dilated projection (factor 1.0 returns the same matrix object)
export function buildDilatedProjectionMatrix(camera, dilationFactor, outMatrix);
```

### 4.2 Cache key — NOT in this module

Inlined at the `calculateTileVisibility` callsite as a private function. Bit-packed numeric key:

```js
// passId          16 bits (frame-relative, wraps)
// viewIdEnum      4 bits  (mainView=1, lookView=2, future=3..15)
// tileLayersMask  8 bits  (current LayerMasks fit in 6)
// modeEnum        2 bits  (legacy=0, metrics=1, sphere=2, obb=3)
// coverageModeEnum 1 bit  (main=0, coverageSphereOnly=1)
// boundsGen       16 bits (per-tile, monotonic, wraps)
// cameraGen       16 bits (per-view, monotonic, wraps)
// Total: 63 bits, fits in a JS Number (53-bit safe integer would need a smaller layout; if so, split into two numbers and key a Map<number, Map<number, result>>).
function makeKey(passId, viewIdEnum, tileLayersMask, modeEnum, coverageModeEnum, boundsGen, cameraGen) {
    // Two-Number split to stay safe-integer:
    const lo = (passId & 0xffff) | ((viewIdEnum & 0xf) << 16) | ((tileLayersMask & 0xff) << 20) | ((modeEnum & 0x3) << 28) | ((coverageModeEnum & 0x1) << 30);
    const hi = (boundsGen & 0xffff) | ((cameraGen & 0xffff) << 16);
    return lo * 0x100000000 + hi;  // 64-bit-ish but stays safe via the high half being unsigned
}
```

Per-tile cache cap: 4 entries (one per `(mode, coverageMode)` combination times the two views in practice). Eviction: oldest entry on insert when at cap. Tiny `Map` is fine.

### 4.3 Internal allocation discipline

- `buildLocalFrame` allocates three new `Vector3` (intentional — outputs are stored on the tile).
- `buildCullingSphere` allocates one new `Sphere` (stored).
- `buildCullingOBB` allocates one new `OBB` (stored).
- `buildFrustumShape` writes into the **passed** scratch; allocates nothing. Module-internal `_invMat4` and `_viewProjMat4` scratches used during construction.
- `buildFallbackPointSet` writes into a **passed** Vector3 pool; allocates nothing for points (only the pool itself, owned by the caller).
- `buildSkirtVertexSet` likewise writes into a passed pool.

---

## 5. Rendered measurement

### 5.1 Transactional measurement (main mesh pass)

Each recalc path (`recalculateCurveOld`, `recalculateCurveOptimized`, `recalculateCurveFlat`, `recalculateCurveWebMercator`) calls the dispatcher (`recalculateCurve()` at `QuadTreeTile.js:1020`). Add measurement to each path's existing vertex loop:

```js
const measurement = tile.beginRenderedBoundsMeasurement({
    expectedMainVertices: (segments + 1) * (segments + 1),
    expectSkirt: true,
});

for (each main vertex) {
    if (abortSignal?.aborted) { measurement.abort(); return; }
    const elevation = ...;  // after all transforms/clamps
    LLAToECEFInto(lat, lon, elevation, _vertexScratch).sub(tileCenter);
    geometry.attributes.position.setXYZ(i, _vertexScratch.x, _vertexScratch.y, _vertexScratch.z);
    measurement.addMainVertex(_vertexScratch, tileCenter, elevation);
}
// Note: skirt measurement happens later, in §5.2. measurement.commit() is gated on BOTH.
```

Rules:
- Initialise `minAlt = +Infinity`, `maxAlt = -Infinity`.
- `measurement.commit()` requires `mainVerticesCount === expectedMainVertices` AND `skirtCommitted === true`.
- On any abort, error, or count mismatch: do NOT mark `source: "renderedGeometry"`. Existing bounds (inherited/predictive) remain.
- If a recalc path falls back (Optimized → Old at `:1098`, WebMercator → Old at `:1343`), only the final successful path commits.
- `tile.highestAltitude` may remain for compatibility during rollout; new culling reads `altitudeBounds.max`.

### 5.2 Skirt coverage (in `updateSkirtGeometry`, NOT inline)

Skirts are repositioned by `updateSkirtGeometry()` (`QuadTreeTile.js:386-486`), which runs after the main-mesh recalc and reads the just-written main-mesh outer-edge positions. This is where skirt vertices acquire their world positions.

Integration point:

```js
updateSkirtGeometry() {
    const measurement = this._pendingMeasurement; // set by beginRenderedBoundsMeasurement
    const skirtDepth = this.size * 0.1;

    for (each outer edge vertex) {
        // existing: compute mainX/Y/Z + downVector * skirtDepth, write to skirtPositions
        // new: feed the skirt vertex world position to the measurement
        if (measurement) measurement.addSkirtVertex(skirtX, skirtY, skirtZ);
    }

    if (measurement) {
        measurement.markSkirtCommitted();
        // commit() can now safely run; called by the recalc path after this method returns
    }
}
```

Two consequences:
- Bounds measurement runs in the **two-pass** structure that the existing geometry already has. No need to merge passes.
- The skirt vertex set is taken from actual generated skirt vertices, not from "inflate downward by skirt depth" — which is approximation-prone given the per-tile `skirtDepth = tile.size * 0.1`.

### 5.3 Elevation data bounds (predictive)

Three decode paths in `QuadTreeTile.js` populate `tile.elevation` but currently track no min/max:
- `computeElevationFromRGBA` (`:1864`)
- `computeElevationFromRGBA_MB` (`:1888`)
- `computeElevationFromGeoTIFF` (`:1911`)

Plus `buildElevationFromAncestor` in `QuadTreeTileMaterial.js:507`.

Phase 1.1 adds explicit `min/max` tracking to each. The stats describe elevation values **as consumed by the vertex pass**: if z-scale, geoid clamp, etc. apply later, the predictive bounds must be inflated enough to remain conservative.

`source: "elevationData"` is never `measured: true`. It's a better-than-inherited predictive seed.

---

## 6. Bounding volumes

### 6.1 Fallback point set (when measured is unavailable)

For z < 3: sphere only; OBB is `null`. The local-ENU approximation is too loose for tiles spanning a quarter-hemisphere.

For 3 ≤ z < 6: 5×5 grid on min and max altitude planes (50 points). Web-Mercator face bow at z=5 is ~10 km at the equator; 5×5 captures it within `BOUNDS_INFLATE_M`.

For z ≥ 6: 3×3 grid on min and max altitude planes (18 points). At z=6 face bow is ~5 km, well-captured by 3×3.

Grid is in lat/lon space, then `LLAToECEFInto` at min and max altitudes. Transform into the local frame, derive `Box3`, inflate by `BOUNDS_INFLATE_M`.

### 6.2 Local frame with pole fallback

```js
const up = getLocalUpVector(centerECEF).normalize();
let north = getLocalNorthVector(centerECEF).projectOnPlane(up);

let polarFallbackUsed = false;
if (north.lengthSq() < 1e-12) {
    // At exact pole, getLocalNorthVector returns a vector parallel to up,
    // which projects to zero. Direct fallback to a perpendicular basis.
    north.set(1, 0, 0).projectOnPlane(up);
    polarFallbackUsed = true;
    if (north.lengthSq() < 1e-12) {
        // up is along x-axis (impossible on Earth, but defensive)
        north.set(0, 1, 0).projectOnPlane(up);
    }
}

north.normalize();
const east = up.clone().cross(north).normalize();
north = east.clone().cross(up).normalize();

return { east, north, up, polarFallbackUsed };
```

Right-handed check at lat 0/lon 0: `east ≈ (0,1,0)`, `north ≈ (0,0,1)`, `up ≈ (1,0,0)`, `east × north = up`. Unit test required, including exact-pole and 1m-from-pole cases.

`polarFallbackUsed` count increments §10's diagnostics counter.

### 6.3 Sphere

```js
center = average(points);
radius = max(distance(center, point));
```

Conservative, not minimal. Replaces `getWorldSphere()` content via internal rename to `getCullingSphere()`; old alias deleted in Phase 2.

### 6.4 OBB (with centre offset preserved)

```js
const local = new Box3();
for (let i = 0; i < count; i++) {
    _scratchLocal.set(
        points[i].clone().sub(originECEF).dot(east),
        points[i].clone().sub(originECEF).dot(north),
        points[i].clone().sub(originECEF).dot(up)
    );
    local.expandByPoint(_scratchLocal);
}

assert(count >= 1 && local.min.x !== Infinity, "buildCullingOBB: empty point set");

const _boxCenter = local.getCenter(new Vector3());
const half = local.getSize(new Vector3()).multiplyScalar(0.5).addScalar(BOUNDS_INFLATE_M);

const obbCenterECEF = originECEF.clone()
    .addScaledVector(east,  _boxCenter.x)
    .addScaledVector(north, _boxCenter.y)
    .addScaledVector(up,    _boxCenter.z);

const obb = new OBB();
obb.box.min.set(-half.x, -half.y, -half.z);
obb.box.max.set( half.x,  half.y,  half.z);
obb.transform.makeBasis(east, north, up).setPosition(obbCenterECEF);
obb.update();   // recompute 8 points + 6 planes
return obb;
```

Assert defends against empty-point-set silent corruption.

`OBB.update()` runs **only** on `cullingBoundsGeneration` transitions (via `buildCullingOBB`). Never per-frame.

### 6.5 Import path

```js
// Phase 0.2: try the minimal path first; measure bundle delta
import { OBB } from "3d-tiles-renderer/src/three/renderer/math/OBB.js";
```

The package's `exports` field maps `./src/*` so this resolves cleanly. If `webpack --profile` shows the bundle delta is negligible vs. `"3d-tiles-renderer/three"`, switch to the convenience path for clarity. Phase 0.2 records the choice.

---

## 7. Frustum shape

```js
// Per-view scratch, created once, reused across passes:
view.strictFrustumShape = { frustum: new Frustum(), planes: <ref>, points: 8 × new Vector3() };
view.dilatedFrustumShape = { frustum: new Frustum(), planes: <ref>, points: 8 × new Vector3() };

// Per pass:
buildFrustumShape(view.strictFrustumShape, camera, camera.projectionMatrix);
buildFrustumShape(view.dilatedFrustumShape, camera, buildDilatedProjectionMatrix(camera, SUBDIVISION_FOV_DILATION, _scratchMat));
```

`buildFrustumShape`:

```js
function buildFrustumShape(shape, camera, projectionMatrix) {
    const viewProj = _viewProjMat4.multiplyMatrices(projectionMatrix, camera.matrixWorldInverse);
    shape.frustum.setFromProjectionMatrix(viewProj);
    shape.planes = shape.frustum.planes;

    const inv = _invMat4.copy(viewProj).invert();
    for (let i = 0; i < 8; i++) {
        shape.points[i].copy(NDC_CORNERS[i]).applyMatrix4(inv);
    }
}
```

`Vector3.applyMatrix4` performs the perspective divide (Three.js `Vector3.js:446-459`), so NDC corners map to world-space frustum corners even when `inv` has a non-affine bottom row.

**Why not `Vector3.unproject(camera)`:** unproject uses `camera.projectionMatrixInverse`, which is the strict-frustum inverse. For the dilated frustum the projection matrix has been modified ad hoc (elements [0] and [5] divided by the dilation factor); the strict inverse is the wrong matrix. The explicit `inv` here uses the dilated projection. Future contributors should not "simplify" back to unproject for the dilated case.

NASA's `OBB.intersectsFrustum` calls `frustum.planes[i].distanceToPoint` (allocation-free per Three.js `Plane.js:175-179`) and `_intersectsPlaneShape` rejects only when all 8 points lie strictly outside a plane — same sign convention as Three.js inward-normal planes. No orientation bug.

### 7.1 Dilated projection construction

```js
function buildDilatedProjectionMatrix(camera, dilationFactor, outMatrix) {
    if (dilationFactor === 1.0) return outMatrix.copy(camera.projectionMatrix);
    outMatrix.copy(camera.projectionMatrix);
    outMatrix.elements[0] /= dilationFactor;
    outMatrix.elements[5] /= dilationFactor;
    return outMatrix;
}
```

The factor-1 fast path avoids redundant work when dilation is disabled.

---

## 8. Visibility logic

### 8.1 Required-options signature

```js
calculateTileVisibility(tile, camera, options, diag = null) {
    const { viewId, passId, tileLayers, mode, coverageMode, cameraGeneration } = options;
    if (process.env.NODE_ENV !== "production") {
        assert(viewId !== undefined && passId !== undefined && cameraGeneration !== undefined,
            "calculateTileVisibility: missing required options");
    }
    // ... compute ...
}
```

**`tileLayers` in the cache key is the view's mask, not `tile.tileLayers`** (the latter changes mid-pass during cascade and would invalidate cache entries for unrelated reasons).

### 8.2 Cache key + cap

```js
const cache = tile.cullingState.visibilityCache ??= new Map();
const key = makeCacheKey(passId, viewIdEnum, tileLayersMask, modeEnum, coverageModeEnum, tile.altitudeBounds.generation, cameraGeneration);

const cached = cache.get(key);
if (cached !== undefined) {
    diag && diag.visCacheHits++;
    return cached;
}

const result = computeVisibility(tile, camera, options);
cache.set(key, result);
diag && diag.visCacheMisses++;

if (cache.size > VIS_CACHE_CAP_PER_TILE) {
    // Evict the oldest entry (Maps preserve insertion order)
    cache.delete(cache.keys().next().value);
}

return result;
```

Stale-but-harmless contract: cache entries with old generations never match again; eviction handles them on insert pressure.

### 8.3 Options threading through coverage recursion

```js
// QuadTreeMap.subdivideTilesViewSpecific (outer pass):
const outerOptions = {
    viewId, passId, tileLayers, mode, coverageMode: "main", cameraGeneration
};

// PASS 2: deactivateParentsWithLoadedChildren (currently lives at QuadTreeMap.js:881-917)
this.deactivateParentsWithLoadedChildren(tileLayers, camera, outerOptions);

// Inside deactivateParentsWithLoadedChildren, when recursing into visibleAreaCoveredByDescendants:
const coverageOptions = { ...outerOptions, coverageMode: "coverageSphereOnly" };
this.visibleAreaCoveredByDescendants(tile, mask, camera, coverageOptions);

// Inside visibleAreaCoveredByDescendants recursion (QuadTreeMapTexture.js:302):
this.calculateTileVisibility(child, camera, coverageOptions, null);
```

Coverage recursion uses `coverageMode: "coverageSphereOnly"` regardless of the view's `mode`. The check skips OBB; SSE uses sphere distance only.

### 8.4 Modes

| Mode | Sphere | OBB | SSE distance | Notes |
| --- | --- | --- | --- | --- |
| `legacy` | sea-level + altitude-shift (current code) | none | sphere-center | The current path; default for both views in v5 initial rollout. |
| `metrics` | sea-level + altitude-shift | computed but unused | sphere-center | Same as `legacy` for rendering; collects new bounds + counters. |
| `sphere` | `cullingState.sphere` | computed but unused | sphere-center | First behavior change. |
| `obb` | `cullingState.sphere` | `cullingState.obb` | OBB.distanceToPoint, fallback to sphere when `obb === null` (z<3) | Full new path. |

Coverage recursion ignores `mode` and uses sphere only.

### 8.5 Existing reach cull

The in-flight reach-cull code at `QuadTreeMap.js:1066-1082` is **scaffolding from the prior session**, not validated stable behavior. Gate it behind a new flag:

```js
Globals.enableReachCull = (Globals.tileBoundsMode.<view> === "legacy" || "metrics");
// Phase 0.1 sets the flag wiring; the underlying code is unchanged.
```

In `sphere` and `obb` modes, default `enableReachCull = false`. Operators can re-enable per-view at runtime if the OBB narrow-phase proves insufficient. Phase 4's "redesign" disposition is the long-term decision.

---

## 9. Flags and runtime safety

### 9.1 Flag set

```js
Globals.tileBoundsMode = { mainView: "legacy", lookView: "legacy" };
Globals.enableReachCull = true;     // legacy default; auto-false in sphere/obb
Globals.showTileOBB = false;
Globals.tileCullBudgetMs = 4;
Globals.visibilityPassId = 0;       // bumps once per outer render frame
```

### 9.2 Precedence

URL `?tileBoundsMode=obb` > `?tileBoundsMode.lookView=legacy` > `Sit.tileBoundsMode` (if set in sitch JSON) > `Globals.tileBoundsMode` (runtime) > defaults.

Mode changes take effect at the **next** `subdivideTilesViewSpecific` boundary (not mid-pass). Any code path reading `tile.cullingState.obb` directly must guard against the value being stale relative to the current mode (the cache-key `mode` field handles `calculateTileVisibility`; direct readers must check too).

### 9.3 Controls

- **URL parameters** as above.
- **GUI** under the existing "Performance Tweaks" folder (`CustomSupport.js:474`), not a new folder.
- **Console** runtime mutation: `Globals.tileBoundsMode.lookView = "legacy"`.
- **Sitch JSON** field `Sit.tileBoundsMode` (object form) for sitch-author overrides.

### 9.4 Runtime safety nets

- Try/catch around the new cull body with auto-fallback to `mode = "legacy"` for the affected view on first throw. Log once.
- First-frame sanity check: when mode flips from `sphere` → `obb`, compare active-tile count to the prior frame's count. If drop > 50%, revert and log.
- Active terrain mesh count and `activeTileHash` (defined below) as cheap signals.
- Defer `readPixels` black-frame detection unless cheaper signals miss a real failure.

### 9.5 Stats reset entrypoint

```js
window.__sitrecTileCullStats.reset = function() {
    for (const view of ["mainView", "lookView"]) {
        const s = this[view];
        for (const k of Object.keys(s)) if (typeof s[k] === "number") s[k] = 0;
    }
};
```

For flag-flip A/B comparisons via MCP.

### 9.6 `activeTileHash`

```js
function computeActiveTileHash(map, layerMask) {
    let h = 0x811c9dc5; // FNV-1a 32-bit
    const tiles = [];
    for (const t of map.allTiles) if (t.tileLayers & layerMask) tiles.push((t.z << 24) ^ (t.x << 12) ^ t.y);
    tiles.sort((a, b) => a - b);
    for (const v of tiles) { h ^= v; h = Math.imul(h, 0x01000193) | 0; }
    return h >>> 0;
}
```

Defined once in `QuadTreeCullingBounds.js`; used by MCP, Playwright, and visual debug.

---

## 10. Diagnostics

Counters (in addition to v4's):

```js
window.__sitrecTileCullStats = {
    mainView: {
        sphereRejected: 0,
        obbRejectedDilated: 0,
        obbRejectedStrict: 0,
        reachRejected: 0,
        unmeasuredBoundsUsed: 0,
        inheritedBoundsUsed: 0,
        elevationDataBoundsUsed: 0,
        renderedBoundsUsed: 0,
        visCacheHits: 0,
        visCacheMisses: 0,
        polarFallbackUsed: 0,
        activeTerrainMeshes: 0,
        activeTileHash: 0,
        cullSelfTimeMs: 0,
    },
    lookView: { ...same... },
    reset: function() { ... },
};
```

Visual: `showTileOBB` builds `LineSegments` on OBB recompute (never per-frame), colour-coded green=`renderedGeometry`, yellow=`inherited`, red=`global`/`elevationData`.

Perf budget warn: `if (cullSelfTimeMs > Globals.tileCullBudgetMs) console.warn(...)` per view per pass.

---

## 11. Tests and validation

Three tiers as established in v3/v4.

### 11.1 Unit tests (Jest, Phase 0.2)

- `min/max` measurement starts at `Infinity/-Infinity`.
- Local frame right-handedness at equator, mid-latitudes, **exact pole**, and 1m-from-pole. `polarFallbackUsed` toggles correctly.
- Inherited bounds never tighter than `GLOBAL_UNMEASURED_*`.
- **Forward inheritance refresh**: a child with `source: "inherited"` bumps its generation when its parent commits.
- PNG/GeoTIFF/ancestor elevation stats are stored and conservative.
- Transactional measurement commits only when both main-vertex count and skirt commit are present.
- Skirt vertex set encloses generated skirt vertices.
- Fallback 3×3/5×5 grid encloses synthetic curved tile meshes.
- Sphere encloses every source point.
- OBB encloses every source point and preserves non-zero box-centre offsets.
- `buildCullingOBB` throws on empty point set.
- Strict vs. dilated frustum points differ when the projection differs.
- `OBB.intersectsFrustum` accepts the wrapper shape.
- Plane-orientation smoke test: known-outside OBB returns false; known-inside returns true.
- Bit-packed cache key differs when any field differs; LRU evicts at cap.

### 11.2 CI regression gates (Playwright)

Three pixel-diff tests; existing `tests_regression/regression.test.js` + `test-registry.js` plumbing.

1. **`obb-cull-empty-lookview-repro`** — locked Subdivide Test sitch; both views non-blank; pixel diff against baseline.
2. **`obb-cull-mainview-baseline`** — representative mainView; pixel diff + active-tile-count.
3. **`obb-cull-elevated-terrain-baseline`** — Sierras/Andes; pixel diff + active-tile-count.

Fixture determinism: the empty-lookview fixture must include an `activeTileHash` self-check at fixture entry. If the hash doesn't match the canonical broken-state value, the test aborts with a clear "fixture state drifted" message rather than producing flaky results.

### 11.3 MCP development validation

Per stage:

```js
return {
    stats: window.__sitrecTileCullStats,
    mode: Globals.tileBoundsMode,
    activeTilesByZoom: ...,
    activeTileHash: ...,
    errors: window.__sitrecErrors ?? [],
};
```

Scenarios (13):
1. Empty-lookView repro.
2. Elevated terrain.
3. Ocean/flat.
4. Root/low-zoom fallback.
5. Polar tile.
6. Antimeridian crossing.
7. Ellipsoid mode.
8. z=18 low-altitude drone footage.
9. Sky-dominant frame.
10. Rapid panning: frame N/N+1 active-tile hash delta < 5%.
11. "Main Use Look Layers" ON.
12. Partial measured/inherited siblings.
13. Aborted recalc: `sitrec_eval` picks a tile with `isLoading=true` and calls `tile.elevationAbortController?.abort()`; assert `altitudeBounds.measured` remains `false` and rendering doesn't tear.

Procedures live under `docs/mcp-procedures/obb-cull/`.

### 11.4 Build gates

```bash
npm test
npm run check-three-imports
npm run build
npm run test-regression
```

---

## 12. Phased rollout

### Phase 0.0 — fixture (0.5 day)

Build and commit the empty-lookview Playwright fixture **before any code changes**. Lock the sitch state via `activeTileHash` self-check. Establish legacy baseline `__sitrecTileCullStats` for all 13 MCP scenarios; save to `docs/mcp-procedures/obb-cull/baselines/<scenario>.json`. This is the **first** thing to land — without it, regressions in subsequent phases have no reference.

### Phase 0.1 — diagnostics + options plumbing (0.5–1 day)

- Add `Globals.visibilityPassId` (bumps once per outer render frame in `animate`).
- Add `Globals.tileBoundsMode`, `Globals.enableReachCull`, `Globals.tileCullBudgetMs`, `Globals.showTileOBB` flags.
- Add URL parsing, GUI controls under Performance Tweaks, sitch override.
- Change `calculateTileVisibility(tile, camera, diag=null)` → `calculateTileVisibility(tile, camera, options, diag=null)`. Update all three callers (`QuadTreeMap.js:646`, `:723`, `QuadTreeMapTexture.js:302`) and thread options through `deactivateParentsWithLoadedChildren` + `visibleAreaCoveredByDescendants`.
- Add `__sitrecTileCullStats` window export + `activeTileHash` + `cullSelfTimeMs` + `reset()`.
- Add try/catch fallback around any new branch (no new branches yet — but the wiring is there).
- Wire `Globals.enableReachCull` to gate the existing reach-cull at `QuadTreeMap.js:1066-1082`.

No bounds computed yet. No render decisions change. MCP scenarios must all pass with hash parity vs. baseline.

### Phase 0.2 — helper module + unit tests (0.5–1 day)

- Create `src/QuadTreeCullingBounds.js` with the full §4 surface.
- Land all §11.1 unit tests.
- Bundle measurement: confirm minimal `OBB` import path doesn't bloat.
- Import smoke test: `npm run build` succeeds.

No render behavior change. Helper module unused by runtime yet.

### Phase 1.0 — data model + activate order (0.5–1 day)

- Add `tile.altitudeBounds` and `tile.cullingState` per §3.
- Fix `QuadTreeMapTexture.activateTile()` order: set parent + call `inheritBoundsFromParent` before `recalculateCurve()` starts.
- Compute `cullingState.sphere` and `cullingState.obb` from current `highestAltitude` (no new measurement yet — uses what already exists).
- Run all MCP scenarios in `metrics` mode; assert `activeTileHash` parity vs. legacy.

### Phase 1.1 — transactional measurement (Optimized path only, 0.5–1 day)

- Add transactional measurement to `recalculateCurveOptimized` (the production-default path).
- Add `updateSkirtGeometry` integration for skirt vertices.
- Add forward inheritance refresh on commit.
- Add elevation decode stats (`computeElevationFromRGBA*`, `_GeoTIFF`, `buildElevationFromAncestor`).
- Gated behind a new dev-only flag so it can be flipped off if it regresses.

### Phase 1.2 — extend to other recalc paths (0.5 day)

- Apply the same measurement pattern to `recalculateCurveOld`, `recalculateCurveFlat`, `recalculateCurveWebMercator`.
- Verify fallback chains (Optimized → Old, WebMercator → Old) don't leak half-committed measurements.

### Phase 1.5 — soak (one release in `metrics` default)

Ship `metrics` default-on for one Sitrec release. **Gate**: a Playwright sweep through 8–12 fixed sitches at fixed frames asserts `activeTileHash` parity between `metrics` and `legacy` across a deterministic camera path. Plus the existing Playwright pixel-diff gates pass. Plus no recurring cull errors logged.

Replaces v4's vague "no false-negative reports" gate.

### Phase 2 — measured sphere (mainView first, 0.5 day)

- Switch `Globals.tileBoundsMode.mainView` default to `"sphere"`.
- `Globals.tileBoundsMode.lookView` stays `"legacy"`.
- Keep current altitude-shifted sphere under `legacy`.
- Validate via MCP scenarios + Playwright gates.

### Phase 2.5 — measured sphere (lookView, 0.5 day)

Once mainView is stable for 3 consecutive releases or 2 weeks without false-negative reports, flip lookView default to `"sphere"`.

### Phase 3 — OBB narrow phase (1–1.5 days)

- Wire frustum shape construction (per-view scratch) into `subdivideTilesViewSpecific`.
- Add sphere broad phase + OBB narrow phase in `obb` mode.
- Use OBB distance for SSE in `obb` mode.
- `visibleAreaCoveredByDescendants` recursion forces `coverageMode: "coverageSphereOnly"`.
- Validate "Main Use Look Layers" explicitly.
- Run all MCP scenarios + Playwright gates.

Default for mainView flips to `obb` after the same 3-release / 2-week gate.

### Phase 4 — reach-cull disposition (deferred)

Decide one of:
- Keep `Globals.enableReachCull` as an independent flag; current implementation stays as-is.
- Redesign with whole-volume OBB occlusion (must prove all OBB corners or a documented support set are occluded; not a single clamp point).
- Remove entirely if `obb` mode alone is sufficient.

Total: 4.5–7 days engineering + 1 release calendar soak.

---

## 13. Code-specific reminders

- **`getWorldSphere()` has one caller** (`QuadTreeMap.js:931`). Rename in place; delete alias when Phase 2 ships. No migration drama.
- **Texture vs. elevation `activateTile(..., 0)` defaults are asymmetric on purpose.** Don't normalize as part of this work.
- **`tile.tileLayers` changes mid-pass during cascade.** The cache key uses the **view's** mask, not the tile's.
- **`Sit.tileBoundsMode`** if used must be serialised in the sitch JSON via `simpleSerials`.
- **`Globals.visibilityPassId` bumps once per outer render frame**, not per `subdivideTilesViewSpecific` call.
- **Skirts run in `updateSkirtGeometry()`, not the main loop.** Bounds measurement integrates there.
- **`OBB.update()` runs only on `cullingBoundsGeneration` transitions.** Never per-frame, never per-visibility-pass.
- **Empty point set guard** in `buildCullingOBB` — throws to fail fast.
- **`Vector3.unproject` not used for the dilated frustum** because it would use the strict-projection inverse. Comment in §7 explains.
- **Reach-cull at `QuadTreeMap.js:1066-1082` is in-flight scaffolding** — already gated behind `Globals.enableReachCull`. Phase 4 decides its fate.

---

## 14. Open questions for v6 (small)

Most v4 open questions are resolved. The remaining ones:

1. **Bit-packed cache key layout** — V5 proposes 63 bits split across two Numbers. Confirm safe-integer arithmetic doesn't break the multiplication trick on all platforms (it should — `0x100000000 * 0xffff < 2^53`).
2. **`Sit.tileBoundsMode` serialisation** — opt-in `simpleSerials`? Or read-only from sitch JSON? If serialised, every save writes a new field — risk of save-file bloat.
3. **Phase 2.5 gate duration** — "3 consecutive releases or 2 weeks" is plausible. Pick one (or both); release cadence isn't fixed.
4. **`refreshInheritedDescendants` walk cost** — for a tile with O(4^n) descendants, walking on commit could be O(n²) total work during cascade. Almost certainly fine in practice (most descendants are `measured`, not `inherited`), but worth measuring during Phase 1.1.

---

## 15. Bottom line

V5 is V4 with the right corrections: forward inheritance refresh prevents non-conservative children, skirts measure in their own existing pass instead of an impossible inline loop, `options` is required not defaulted, the cache key is bit-packed and capped, helper module surface is complete and pure, the existing reach-cull is gated behind its own flag, and phase boundaries match what can actually ship without coupling.

The path is unchanged: instrument, measure, soak, swap sphere (mainView then lookView), add OBB. Each step is flag-revertible; legacy stays available through Phase 3.
