# Atmosphere: Horizon Haze Color + Sky Gradient V3

**Status:** Draft V3. Supersedes V2 (`atmosphere-horizon-gradient-V2.md`) for implementation guidance. V2 fixed V1's ray math, default-flip, and XR/DaySky omissions; V3 fixes V2's HDR exposure divergence, sunset directionality, gradient-shader opacity gap, and grounds every "verify in codebase" claim with file:line references checked against the actual tree on 2026-05-21.

**Date:** 2026-05-21.

**Scope:** `lookView` atmosphere only. Make distant geometry fog and the sky background meet at a plausible pale horizon color, while preserving legacy rendering unless a sitch or saved mod explicitly opts in.

**Hard exclusions:**
- No global missing-field default flip. Old sitches and old custom URLs stay legacy.
- No XR gradient (the sky material is shared with XR but XR has no per-eye unprojection path here).
- No `GlobalDaySkyScene` integration (analytic Three `Sky` mesh, when present, draws after the sky quad and would fight any gradient).
- No mainView atmosphere; no night-sky behavior change; no celestial-elements changes.

---

## What V3 changes from V2 (TL;DR)

| Area | V2 prescription | V3 change | Reason |
|---|---|---|---|
| HDR exposure for fog vs. sky | Not addressed | **No compensation required**, but add an HDR-on visual regression to keep it that way. Sky quad and scene/fog both render into the same float target before the single ACES tone-map at `CNodeView3D.js:2254`, so both see the same `skyExposure * atmosphereExposure * sceneExposureHDR` multiplier | Documented as a verification path rather than a code change. See §Color-space contract for the full trace |
| Sunset model | Uniform warm tint when `-6° < sunAngle < 10°` | Warm tint is **sun-azimuth-weighted at shader time** via `dot(viewDir, sunDirHoriz)`. CPU passes both `coolHorizon` and `warmHorizon` plus `sunDirHoriz`; shader blends per pixel | V2's uniform tint paints the *eastern* sky orange at sunset, which is physically wrong (eastern sky is the cool/violet anti-solar twilight) |
| Gradient shader uniforms | `zenithColor`, `horizonColor`, `opacity`, ray inputs | Adds `coolHorizon`, `warmHorizon`, `sunDirHoriz`, `warmStrength`. **`opacity` applies to entire gradient** so twilight night-sky blend is consistent | V2 omitted `opacity` from the gradient shader, breaking the twilight star-fade-in path that the flat material currently supports |
| Banding | Not mentioned | Add a branchless hash-based 1-bit dither in the gradient fragment shader (Bayer-table variant rejected after review — local float arrays + dynamic int indexing are fragile on WebGL1/mobile drivers) | The horizon→zenith fade across 8-bit sRGB output exhibits visible banding when `||zenith - horizon||` is small |
| XR safety gate | `!this.renderer.xr.isPresenting` | Use `renderer.xr.isPresenting ?? (renderer.xr.getSession?.() != null)` | `isPresenting` is correct in three@0.183.1 but a defensive fallback costs nothing and matches existing XR-aware code paths elsewhere in the file |
| Mobile gate | Not addressed | Phase 0 reads `Globals.isMobile` and disables the gradient shader by default on mobile *even when sitch opts in*, mirroring the `allowMobileShadows` pattern (`CNodeView3D.js:1036`). User can override with a per-view `allowMobileSkyGradient` field | Codex agent flagged this; the existing convention is "mobile gets the cheaper path unless explicitly opted up" |
| Test sitch | "Atmo Visibility custom URL" | New committed sitch `SitAtmoTest.js` (clear daytime + 3D Buildings on a fixed locale) and `SitAtmoSunset.js` (low sun) registered as deterministic regression targets | Custom URL depends on the production server and is not reproducible in CI |
| Field plumbing — nested vs. flat | Reads `v.atmosphereHaze ?? atmosphereDef.haze ?? false` | Same shape kept. Phase 0 deliberately *introduces* the nested path: today only `v.atmosphere` initial-def is nested (`CNodeView3D.js:125`), `modDeserialize` is flat. V3 documents this asymmetry explicitly so reviewers don't think the plan is wrong | Audit agent flagged the asymmetry — V2 was already correct here but underspecified the reasoning |
| Corner-ray fallback | "Move unprojection to vertex shader if measured" | Concrete fallback shader sketch included in §Performance; gated by Phase 2 GPU-timer measurement | No corner-ray pattern exists in Sitrec yet — needs to be a fully-specified contingency, not a hand-wave |
| `pow(h, 0.4)` curve | Single fixed exponent | Exposed as `horizonExponent` uniform; **defaults documented per sun-elevation regime** (noon: 0.35, golden hour: 0.55, twilight: 0.75) and modulated by `calculateSkyBrightness()` in Phase 3 | Visuals agent: real zenith/horizon luminance ratio is 1.5–3, not the implied ~6 from 0.4; coupling to sun elevation gives plausible behavior across times |

---

## Codebase ground-truth (verified 2026-05-21)

These facts were checked against current `main` before drafting V3. Implementers should re-verify if substantial time has passed.

| Fact | File:line | Verified |
|---|---|---|
| `renderer.outputColorSpace = SRGBColorSpace` | `CNodeView3D.js:1522` | ✓ |
| Sky shader applies `sRGBTransferEOTF` to uniform `color` | `CNodeView3D.js:2298` | ✓ |
| Fog assigned via `this._lookViewFog.color.copy(this.getAtmosphereSkyColor())` | `CNodeView3D.js:1403` | ✓ |
| `getAtmosphereSkyColor` returns cached `_atmosphereSkyColor`, falls back to `this.background` | `CNodeView3D.js:1015` | ✓ |
| `pushLookViewAtmosphereFog` is gated on `id === "lookView"` and `atmosphereEnabled` | `CNodeView3D.js:1399` | ✓ |
| HDR tone-mapping exposure = `skyExposure * atmosphereExposure * sceneExposureHDR` | `CNodeView3D.js:2254` | ✓ |
| Sky tone-map (non-HDR) uses only `theSky.effectController.exposure * sceneExposure` | `CNodeView3D.js:2061` | ✓ |
| `modSerialize` / `modDeserialize` exist (not `serialize`/`deserialize`) | `CNodeView3D.js:2560, 2574` | ✓ |
| Atmosphere fields in modDeserialize: `atmosphereEnabled`, `atmosphereVisibilityKm`, `atmosphereHDR`, `atmosphereExposure` (all flat) | `CNodeView3D.js:2579-2582` | ✓ |
| Initial-def nested path: `const atmosphereDef = v.atmosphere ?? {}` | `CNodeView3D.js:125` | ✓ |
| `setRenderOne(value=true)` exists | `Globals.js:339` | ✓ |
| `getLocalUpVector(position)` returns geodetic up | `SphericalMath.js:250` | ✓ |
| `Globals.isMobile`, `allowMobileShadows` pattern | `CNodeView3D.js:1036` | ✓ |
| Three version | `package.json` → `three: ^0.183.1` | ✓ |
| `MathUtils.clamp` available from `"three"` | three@0.183 API | ✓ |
| `t()` supports `{defaultValue: "..."}` | `i18n/index.js:140` | ✓ |
| Profiler wraps sky pass under `skyRender` (color `#80b1d3`) | `CNodeView3D.js:2027, 2074` | ✓ |
| `GlobalDaySkyScene` may be `undefined` (`if (Globals.renderDebugFlags.dbg_renderDaySky)`) | `CNodeView3D.js:2029, 2042` | ✓ |
| No corner-ray / vertex-unprojection sky pattern exists | grep | ✓ (none found) |
| Built-in sitches with `atmosphere.enabled: true` | grep `src/sitch/` | ✗ **zero** — Phase 0 cannot rely on an existing fog-enabled sitch baseline |

Two items still need verification *during Phase 0* (not blockers, but cheap to confirm):
- **Q-A.** Does `renderer.xr.isPresenting` work in three@0.183.1 outside an active XR session? (Falls back to `getSession?.() != null` if not.)
- **Q-B.** Does the active code path ever call `pushLookViewAtmosphereFog` for any built-in sitch today? (Audit says no, but a single demo-truck or custom permalink could surface one — verify with a one-line console.log in dev.)

---

## Rendering model recap

Current pipeline (lookView):

1. `renderSky()` (`CNodeView3D.js:2330`) — draws the full-screen sky quad with `skyBrightnessMaterial`. Uniform `color` is the sun-modulated zenith blue from `CNodeSunlight.calculateSkyColor`. Output is `sRGBTransferEOTF(color)` (i.e., sRGB-encoded → linear), written to the active render target.
2. Main scene render (`CNodeView3D.js:2168`) — `GlobalScene` rendered into the same target. `FogExp2` blends each fragment toward `fog.color` based on `exp(-density * depth)²`. **Three.js fog mixes in linear space** (the same space the material is shading in), so `fog.color` is interpreted as a *linear* value by the fragment shader.
3. (HDR only) Final tone-map pass (`CNodeView3D.js:2254`) — ACES filmic with `exposure = skyExposure * atmosphereExposure * sceneExposureHDR` applied to the composite.
4. (Non-HDR atmosphere) ACES tone-map applied to *sky only* before the scene render (`CNodeView3D.js:2061`), with `exposure = skyExposure * sceneExposure` (no `atmosphereExposure`). Scene/fog never gets a separate tone-map pass; relies on three's per-material `toneMapped: true`.

**Two color-space mismatches result:**

- **Path A — sRGB vs. linear:** `calculateSkyColor` returns numerical RGB ≈ `(0.53, 0.81, 0.92)` interpreted as sRGB by the sky shader (`sRGBTransferEOTF` decodes it → linear `(0.241, 0.617, 0.827)`). The same numerical RGB copied into `fog.color` is interpreted as *already linear*. Fog renders brighter & more saturated than sky.
- **Path B — exposure asymmetry in HDR mode:** Sky quad written sRGB→linear into the float target → tone-mapped with full `skyExposure * atmosphereExposure * sceneExposureHDR`. Fog mixed into scene pixels in linear at the *unscaled* fog color → then those scene pixels go through the same tone-map. Both pass through the same exposure, so HDR is fine *here* — the divergence appears only if fog is computed in a different stage (it isn't, but Phase 0 must verify by inspection).

V3 fixes Path A explicitly. Path B is verified by a unit + visual test (see Phase 1 tests).

---

## Compatibility contract (unchanged from V2, sharpened)

**Missing field means legacy.** All new fields default to `false` when absent in *every* deserialization path:

```js
// CNodeView3D constructor, inside the v.atmosphere block at line ~125
const atmosphereDef = v.atmosphere ?? {};
this.atmosphereHaze   = v.atmosphereHaze   ?? atmosphereDef.haze        ?? false;
this.skyGradient      = v.skyGradient      ?? atmosphereDef.skyGradient ?? false;
// Mobile is opt-up:
this.allowMobileSkyGradient =
    v.allowMobileSkyGradient ?? atmosphereDef.allowMobileSkyGradient ?? false;
```

Why both nested and flat shapes:
- Initial sitch definitions in `src/sitch/Sit*.js` use the nested `lookView.atmosphere` block — that's how V2's existing fields were authored.
- `modDeserialize` flattens per-view fields (because mods store flat keys). New fields follow the same convention.

Add to `modSerialize` at `CNodeView3D.js:2566` and `modDeserialize` at `2579` exactly as the existing atmosphere fields are. Each gets its own line. No new nested mod block.

**Phase boundary rule:** A sitch with `atmosphereEnabled: true` but neither haze nor gradient flag (i.e., legacy fog-enabled sitch) is bit-equivalent under V3 to today. The flags are pure dead-code activation per the existing v5 dead-code activation convention.

---

## Color-space contract (V3 is concrete where V2 was provisional)

V2 deferred the color-space decision behind helpers named `getAtmosphereHazeColorSRGB` / `getAtmosphereHazeColorLinear`. V3 picks the option and specifies it:

**Decision:** `calculateSkyColor()` and `calculateHazeColor()` return sRGB-encoded values (matching the existing `skyBrightnessMaterial` EOTF contract). The fog path converts to linear at the point of assignment.

Concretely, in `getAtmosphereHazeColorLinear()`:

```js
getAtmosphereHazeColorLinear(target = this._atmosphereHazeColorLinear) {
    target.copy(this.getAtmosphereHazeColorSRGB(this._atmosphereHazeColorSRGB));
    target.convertSRGBToLinear();   // three Color built-in, no allocation
    return target;
}
```

Then `pushLookViewAtmosphereFog`:

```js
if (this.atmosphereHaze) {
    // Opt-in path: convert sRGB sky-derived haze to linear for correct fog blending.
    this._lookViewFog.color.copy(this.getAtmosphereHazeColorLinear());
} else {
    // Legacy path: preserve byte-identity. Today the renderer assigns the sRGB-
    // encoded numerical RGB straight into fog.color, which Three.js then treats
    // as linear. That's a pre-existing latent bug, but "fixing" it here would
    // change pixels for every legacy fog-enabled sitch. Leave it alone.
    this._lookViewFog.color.copy(this.getAtmosphereSkyColor());
}
this._lookViewFog.density = this.getAtmosphereDensity();
```

**HDR exposure compensation:** When `useLookViewHDR && atmosphereHDR` is on (`CNodeView3D.js:1896`), the final tone-map pass multiplies the *whole composite* by `skyExposure * atmosphereExposure * sceneExposureHDR`. Sky and fog both pass through it, so no compensation is needed. The visuals agent's "fog burned in before tone-map" concern is **incorrect** — the scene render writes into the float target, which is what gets tone-mapped. **V3 still adds an HDR-on visual regression** to catch any future pipeline change that would re-introduce divergence (see Phase 1 tests T-1d/e).

---

## Phase 0 — scaffolding (no pixel change)

Goal: install fields, methods, GUI toggles, and material variants. Bit-identical output.

### 0.1 `CNodeSunlight` haze stub

In `src/nodes/CNodeSunlight.js` next to `calculateSkyColor`:

```js
calculateHazeColor(position, date, opts = {}, target = new Color()) {
    // Phase 0: return the existing sky color unchanged; Phase 1 replaces.
    const sky = this.calculateSkyColor(position, date);
    return target.setRGB(sky.r, sky.g, sky.b);
}
```

The 4-arg signature with passable `target` lets render-loop callers avoid allocation.

### 0.2 Cached colors on `CNodeView3D`

After `_atmosphereSkyColor` (`CNodeView3D.js:225`) add:

```js
this._atmosphereHazeColorSRGB   = new Color(this.background);
this._atmosphereHazeColorLinear = new Color(this.background);
```

### 0.3 Color accessors

```js
getAtmosphereHazeColorSRGB(target = this._atmosphereHazeColorSRGB) {
    const sunNode = NodeMan.get("theSun", false);
    if (!sunNode?.calculateHazeColor) {
        return target.copy(this.background);
    }
    return sunNode.calculateHazeColor(
        this.camera.position,
        undefined,
        {
            visibilityKm: this.atmosphereVisibilityKm,
            // sunAngle: Globals.sunAngle, // Phase 3 will add
        },
        target
    );
}

getAtmosphereHazeColorLinear(target = this._atmosphereHazeColorLinear) {
    target.copy(this.getAtmosphereHazeColorSRGB(this._atmosphereHazeColorSRGB));
    return target.convertSRGBToLinear();
}
```

### 0.4 New fields (legacy-default)

In the constructor block at `CNodeView3D.js:125`:

```js
this.atmosphereHaze         = v.atmosphereHaze         ?? atmosphereDef.haze              ?? false;
this.skyGradient            = v.skyGradient            ?? atmosphereDef.skyGradient       ?? false;
this.allowMobileSkyGradient = v.allowMobileSkyGradient ?? atmosphereDef.allowMobileSkyGradient ?? false;
```

### 0.5 Serialize / deserialize

In `modSerialize` (`CNodeView3D.js:2566`), add three lines next to the existing atmosphere fields. In `modDeserialize` (`:2579`), add the matching three reads.

### 0.6 GUI toggles — **deferred until Phase 2**

V2 originally placed both `atmosphereHaze` and `skyGradient` toggles in Phase 0. V3 moves them to Phase 2 because the right-side lil-gui panel is in the regression screenshot frame for every existing lookView baseline (visible in the user-supplied screenshot at the start of this design). Adding two new controls to that panel changes the panel's height/scroll state and is *not* byte-identical to today's snapshots, contradicting the Phase 0 "no pixel change" gate.

Phase 0 instead does *only* the data plumbing (fields, accessors, gate, two-material allocator). The toggles ship in Phase 2 alongside the new visual behavior — i.e., in the same commit that anyway updates regression baselines for the gradient. See §Phase 2.4 for the GUI code.

Until then, Phase 0–1 testing flips the fields via URL params (`?atmosphereHaze=on`) or directly in the sitch JSON.

*Alternative considered:* mask the GUI panel out of regression screenshots via Playwright clip-region. Rejected because the current regression suite uses full-viewport snapshots and changing that has broader knock-on effects; safer to defer the GUI.

### 0.7 Material variants (preserve exact legacy path)

In `initSky()` (`CNodeView3D.js:2278`), create the legacy material exactly as today, then *lazily* create the gradient material on first opt-in. Phase 0 only creates a one-liner stub field:

```js
this.skyFlatMaterial     = /* the existing ShaderMaterial */;
this.skyBrightnessMaterial = this.skyFlatMaterial; // legacy alias kept for compat
this.skyGradientMaterial = null; // built lazily on first skyGradient=true
```

The lazy build is a separate method `_ensureSkyGradientMaterial()` filled in Phase 2. Until then any reference returns `null` and the consumer must use `skyFlatMaterial`.

**Disposal.** The existing `dispose()` at `CNodeView3D.js:2643` calls `this.skyBrightnessMaterial.dispose()`. After Phase 0, `skyBrightnessMaterial === skyFlatMaterial` (an alias), so a single dispose covers it. Extend the dispose block to also clean up the lazy gradient material, guarding against double-dispose and the alias:

```js
// In CNodeView3D.dispose() around line 2643:
if (this.skyFlatMaterial) {
    this.skyFlatMaterial.dispose();
}
if (this.skyGradientMaterial && this.skyGradientMaterial !== this.skyFlatMaterial) {
    this.skyGradientMaterial.dispose();
}
// Clear the alias so any later reference is a clean null.
this.skyBrightnessMaterial = null;
this.skyFlatMaterial = null;
this.skyGradientMaterial = null;
```

This replaces the existing single `this.skyBrightnessMaterial.dispose()` line. Add a Phase 0 unit/integration test that constructs a view, disposes it, and confirms no second dispose on the same material (Three logs a warning on double-dispose in dev builds).

### 0.8 Mobile gate (always applied from Phase 0 onward)

Add a derived getter:

```js
get effectiveSkyGradient() {
    if (!this.skyGradient) return false;
    if (!this.atmosphereEnabled) return false;
    if (Globals.isMobile && !this.allowMobileSkyGradient) return false;
    if (this.id !== "lookView") return false;
    if (this.isIR) return false;
    if (this.renderer?.xr?.isPresenting ?? this.renderer?.xr?.getSession?.() != null) return false;
    if (GlobalDaySkyScene !== undefined) return false;
    return true;
}
```

This is the single source of truth used everywhere downstream. Phase 0 doesn't *use* it yet (no consumers exist until Phase 2), but defining it now keeps Phase 1/2/3 diffs small.

### Phase 0 tests

`CNodeView3D` cannot be directly constructed in jest — it asserts `v.camera` and has renderer/UI side effects. The pattern below extracts the small pure functions into helpers that *can* be unit-tested. Phase 0 implementers should add these helpers as part of the same commit:

```js
// New module, src/nodes/atmosphereFieldsDefaults.js
export function resolveAtmosphereFields(v) {
    const atmosphereDef = v.atmosphere ?? {};
    return {
        atmosphereHaze:         v.atmosphereHaze         ?? atmosphereDef.haze              ?? false,
        skyGradient:            v.skyGradient            ?? atmosphereDef.skyGradient       ?? false,
        allowMobileSkyGradient: v.allowMobileSkyGradient ?? atmosphereDef.allowMobileSkyGradient ?? false,
    };
}

export function computeEffectiveSkyGradient({
    skyGradient, allowMobileSkyGradient, isMobile, viewId, isIR, xrPresenting, daySkyPresent,
}) {
    if (!skyGradient) return false;
    if (isMobile && !allowMobileSkyGradient) return false;
    if (viewId !== "lookView") return false;
    if (isIR) return false;
    if (xrPresenting) return false;
    if (daySkyPresent) return false;
    return true;
}
```

The CNodeView3D constructor calls `resolveAtmosphereFields(v)` and the `effectiveSkyGradient` getter calls `computeEffectiveSkyGradient({...})` with `this`-derived inputs. Both helpers are pure and jest-friendly.

- **T-0a unit** (`tests/CNodeSunlight.test.js`, new): `calculateHazeColor` equals `calculateSkyColor` within `1e-6` per channel for several sun angles. Constructs a `CNodeSunlight` with a stubbed `calculateSunAt` or via the same minimal-mock pattern existing sunlight tests use — see `tests/CNodeAtmosphericProfile.test.js` for the convention.
- **T-0b unit** (`tests/atmosphereFieldsDefaults.test.js`, new): `resolveAtmosphereFields({})` returns all `false`. With `atmosphereHaze: true` flat, returns `{atmosphereHaze: true, ...}`. With nested `atmosphere: {haze: true, skyGradient: true}`, returns both true. Flat key wins over nested when both present.
- **T-0c unit** (same file): mod round-trip — given a plain-object representation of the three new fields, run them through the JSON shape `modSerialize` produces and back through the inverse, assert all three persist. Pure data; no node needed.
- **T-0d unit** (same file): `computeEffectiveSkyGradient` truth table — iterate every disable predicate and assert it dominates.
- **T-0e visual regression**: run `npm run test-regression` headless. *Every existing snapshot must pass byte-identical.* This is the load-bearing test for Phase 0 since the GUI has been deferred to Phase 2.
- **T-0f integration** (Playwright, lightweight): load `?sitch=gimbal&atmosphereHaze=on` and `?sitch=gimbal` — both should render identical pixels because gimbal does not have `atmosphereEnabled: true`, so the haze flag is dead code activation. Confirms Phase 0 truly is no-op at the renderer level.

Gate: all six green; T-0e is the load-bearing one.

---

## Phase 1 — opt-in horizon haze for fog

Goal: opted-in sitches see fog asymptote a desaturated horizon color in the correct linear color space.

### 1.1 Concrete haze model

Replace the stub in `calculateHazeColor`:

```js
calculateHazeColor(position, date, opts = {}, target = new Color()) {
    const sky = this.calculateSkyColor(position, date);             // sRGB-encoded zenith blue * sunTotal
    const sunTotal = this.calculateSkyBrightness(position, date);   // 0..1
    const visKm = opts.visibilityKm ?? 50;

    // Log-mapped desaturation. 5 km → 0.92 (near grey), 100 km → 0.30 (mostly blue).
    const t = MathUtils.clamp(
        (Math.log(visKm) - Math.log(5)) / (Math.log(100) - Math.log(5)),
        0, 1
    );
    const desat = 0.95 - 0.65 * t;
    // Horizon lifts in luminance relative to zenith (multiple-scatter + Mie).
    const lum = 0.70 * sunTotal + 0.15;

    target.setRGB(
        sky.r * (1 - desat) + lum * desat,
        sky.g * (1 - desat) + lum * desat,
        sky.b * (1 - desat) + lum * desat,
    );
    return target;
}
```

`MathUtils` imported from `"three"`. Phase 3 will add `sunAngle` handling.

### 1.2 Fog source switch

In `pushLookViewAtmosphereFog` (`CNodeView3D.js:1398`):

```js
pushLookViewAtmosphereFog() {
    if (this.id !== "lookView" || !this.atmosphereEnabled || !this.scene) return null;

    if (this.atmosphereHaze || this.skyGradient) {
        // Correct color-space path: convert sRGB sky-derived haze to linear for fog.
        this._lookViewFog.color.copy(this.getAtmosphereHazeColorLinear());
    } else {
        // Legacy path (preserved, including the pre-existing sRGB-as-linear quirk).
        this._lookViewFog.color.copy(this.getAtmosphereSkyColor());
    }
    this._lookViewFog.density = this.getAtmosphereDensity();

    const previousFog = this.scene.fog;
    this.scene.fog = this._lookViewFog;
    return {previousFog};
}
```

That's the entire Phase 1 code change. Sky background still flat & unchanged.

### Phase 1 tests

- **T-1a unit** (`tests/CNodeSunlight.test.js`): chroma test. For a noon position with `sunTotal ≈ 1`, compare `haze` chroma `max(rgb) - min(rgb)` at `visibilityKm = 5` vs `100`. Expect the 5-km value strictly less than the 100-km value. *Do not test "blue lower than sky"* — V1's mistake.
- **T-1b unit**: `visibilityKm = 5` produces a near-grey (chroma < 0.05). `visibilityKm = 100` retains chroma > 0.15.
- **T-1c unit** (`tests/CNodeView3D.fog.test.js`, new): `atmosphereHaze = false` → `getAtmosphereHazeColorLinear` is not invoked (or its result is not assigned to fog). `atmosphereHaze = true` → fog.color matches `getAtmosphereHazeColorLinear()` byte-for-byte.
- **T-1d visual regression**: new test entry `atmo-haze-on` using the committed `SitAtmoTest` (see §Test Sitches). Expect a pale-grey haze fade for the NYC-style skyline. Baseline reviewed manually before commit.
- **T-1e visual regression** `atmo-haze-on-hdr`: same sitch with `atmosphereHDR=true`. Confirm fog and sky stay aligned in HDR. (Catches future pipeline regressions; today the math says they should agree.)
- **T-1f visual** `atmo-haze-off-legacy`: existing legacy sitch with `atmosphereEnabled: true, atmosphereHaze: false` (none exist today — see §Test Sitches `SitAtmoLegacy`). Must be byte-identical to its Phase 0 baseline.

Gate: T-1a..c green; T-1d/e baselines reviewed and committed; T-1f bit-identical.

---

## Phase 2 — opt-in sky gradient

Goal: when `effectiveSkyGradient === true`, sky background fades from zenith blue to horizon haze, meeting fog by construction.

### 2.1 Two-material strategy

`_ensureSkyGradientMaterial()` creates the gradient material lazily on first effective opt-in. Avoids paying compile cost in sessions that never opt in.

```js
_ensureSkyGradientMaterial() {
    if (this.skyGradientMaterial !== null) return this.skyGradientMaterial;

    this.skyGradientMaterial = new ShaderMaterial({
        uniforms: {
            zenithColor:         { value: new Color(0,0,0) },
            coolHorizon:         { value: new Color(0,0,0) },   // Phase 3 will fill with day-side haze
            warmHorizon:         { value: new Color(0,0,0) },   // Phase 3 sunset color
            warmStrength:        { value: 0.0 },                // 0 in Phase 2
            opacity:             { value: 1.0 },
            cameraWorldPosition: { value: new Vector3() },
            cameraWorldX:        { value: new Vector3(1,0,0) },
            cameraWorldY:        { value: new Vector3(0,1,0) },
            cameraWorldZ:        { value: new Vector3(0,0,1) },
            upCamera:            { value: new Vector3(0,1,0) },
            upWorld:             { value: new Vector3(0,1,0) },
            sunDirHoriz:         { value: new Vector3(1,0,0) }, // sun direction projected to horizon plane
            cameraTanHalfFov:    { value: 1.0 },
            cameraAspect:        { value: 1.0 },
            horizonDip:           { value: 0.0 },                // geometric dip below local horizontal
            horizonHazeBand:      { value: 0.03 },               // angular band kept at fog/haze color
            horizonElevationScale:{ value: 12.0 },               // expands the visible low-elevation gradient
            horizonExponent:     { value: 0.4 },
            ditherStrength:      { value: 1.0/255.0 },
        },
        vertexShader: /* glsl */`
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            uniform vec3  zenithColor;
            uniform vec3  coolHorizon;
            uniform vec3  warmHorizon;
            uniform float warmStrength;
            uniform float opacity;
            uniform vec3  cameraWorldPosition;
            uniform vec3  cameraWorldX;
            uniform vec3  cameraWorldY;
            uniform vec3  cameraWorldZ;
            uniform vec3  upCamera;
            uniform vec3  upWorld;
            uniform vec3  sunDirHoriz;
            uniform float cameraTanHalfFov;
            uniform float cameraAspect;
            uniform float horizonDip;
            uniform float horizonHazeBand;
            uniform float horizonElevationScale;
            uniform float horizonExponent;
            uniform float ditherStrength;
            varying vec2 vUv;

            // Hash-based value-noise dither in [-0.5, 0.5]. Branchless and safe on
            // WebGL1/mobile (avoids GLSL ES local float arrays + dynamic int indexing
            // which can fail to compile or hit slow paths on older drivers).
            float hashDither(vec2 p) {
                float h = fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
                return h - 0.5;
            }

            void main() {
                // 1. View direction from camera through this pixel
                vec2 ndc = vUv * 2.0 - 1.0;
                vec3 dirCamera = normalize(vec3(
                    ndc.x * cameraAspect * cameraTanHalfFov,
                    ndc.y * cameraTanHalfFov,
                    -1.0
                ));
                vec3 dir = normalize(
                    cameraWorldX * dirCamera.x +
                    cameraWorldY * dirCamera.y +
                    cameraWorldZ * dirCamera.z
                );

                // 2. Elevation t in [0,1] above local horizon
                float upDot = dot(dirCamera, upCamera);
                float horizonDistance = upDot + horizonDip;
                float h = clamp((horizonDistance - horizonHazeBand) * horizonElevationScale, 0.0, 1.0);
                float t = smoothstep(0.0, 1.0, h);

                // 3. Pick a sun-azimuth-weighted horizon color.
                //    Project view direction onto the horizon plane, dot with sun dir.
                //    Guard against zero-length horizontal projection (looking straight
                //    up/down) — normalize() of a zero vector is undefined in GLSL.
                vec3 horizProj = dir - upWorld * upDot;
                float horizLen = length(horizProj);
                vec3 horizonColor;
                if (horizLen > 1e-4) {
                    vec3 dirHoriz = horizProj / horizLen;
                    float sunAlignment = clamp(dot(dirHoriz, sunDirHoriz), 0.0, 1.0);
                    horizonColor = mix(coolHorizon, warmHorizon, sunAlignment * warmStrength);
                } else {
                    // Looking near zenith or nadir: sun-azimuth is undefined; use cool.
                    horizonColor = coolHorizon;
                }

                vec3 c = mix(horizonColor, zenithColor, t);

                // 4. Dither to break 8-bit banding
                float d = hashDither(gl_FragCoord.xy) * ditherStrength;
                c += vec3(d);

                gl_FragColor = sRGBTransferEOTF(vec4(c, opacity));
            }
        `,
        transparent: true,
        blending: NormalBlending,
        depthTest: false,
        depthWrite: false,
    });
    return this.skyGradientMaterial;
}
```

Critical: `opacity` is preserved as a uniform and applied at output — twilight night-sky blend (the only consumer of opacity today) keeps working.

### 2.2 Uniform updates in `renderSky`

In `renderSky()` (`CNodeView3D.js:2330`), *after* the FOV/aspect restoration at `:2344-2348`, *after* `preRenderCameraUpdate()`, but *before* the fullscreen-quad draw at `:2422-2427`:

```js
const useGradient = this.effectiveSkyGradient;
const skyMat = useGradient
    ? this._ensureSkyGradientMaterial()
    : this.skyFlatMaterial;

if (useGradient) {
    const u = skyMat.uniforms;
    const visT = Math.max(0, Math.min(1, (50 - this.atmosphereVisibilityKm) / 45));
    const blueBoost = 0.35 + 0.25 * visT;
    this._atmosphereZenithColor.copy(skyColor).lerp(this._atmosphereBlueZenith, blueBoost);
    u.zenithColor.value.copy(this._atmosphereZenithColor);  // sRGB, biased toward clear blue
    u.coolHorizon.value = this.getAtmosphereHazeColorSRGB();// same sRGB space as sky shader expects
    u.warmHorizon.value.copy(u.coolHorizon.value);          // Phase 3 will replace
    u.warmStrength.value = 0.0;                             // Phase 3
    u.opacity.value      = skyOpacity;

    // Camera-relative ray uniforms, computed at the latest possible moment.
    // Do not reconstruct ECEF-sized world positions in the fragment shader:
    // WebGL float precision around ~6e6 meter coordinates collapses the
    // small direction deltas and makes the gradient look flat. Use a
    // camera-space ray and camera-space local-up instead.
    const e = this.camera.matrixWorld.elements;
    u.cameraWorldX.value.set(e[0], e[1], e[2]).normalize();
    u.cameraWorldY.value.set(e[4], e[5], e[6]).normalize();
    u.cameraWorldZ.value.set(e[8], e[9], e[10]).normalize();
    u.cameraWorldPosition.value.setFromMatrixPosition(this.camera.matrixWorld);
    u.upWorld.value.copy(getLocalUpVector(u.cameraWorldPosition.value)).normalize();
    u.upCamera.value.set(
        u.upWorld.value.dot(u.cameraWorldX.value),
        u.upWorld.value.dot(u.cameraWorldY.value),
        u.upWorld.value.dot(u.cameraWorldZ.value),
    ).normalize();
    u.cameraTanHalfFov.value = Math.tan(this.camera.fov * Math.PI / 360);
    u.cameraAspect.value = this.camera.aspect;
    const cameraLLA = ECEFToLLAVD_radii(u.cameraWorldPosition.value);
    const cameraAltM = Math.max(cameraLLA.z, 0);
    u.horizonDip.value = Math.min(Math.sqrt(2 * cameraAltM / wgs84.RADIUS), 0.08);
    u.horizonHazeBand.value = 0.015 + 0.04 * visT;
    // Phase 3 fills sunDirHoriz; Phase 2 leaves the default.
} else {
    // Legacy flat-material path: use existing updateSkyUniforms exactly as today.
    this.updateSkyUniforms(skyColor, skyOpacity);
}

this.fullscreenQuad.material = skyMat;
this.renderer.render(this.fullscreenQuadScene, this.fullscreenQuadCamera);
```

`cameraWorldPosition` and `upWorld` scratch lives inside the uniform values themselves.

### 2.3 Flat material untouched

`updateSkyUniforms` is **not modified**. The flat path uses `this.skyFlatMaterial`'s existing `color` uniform exactly as today. Bit-identity for `effectiveSkyGradient === false` is by construction.

### 2.4 GUI toggles (deferred from Phase 0)

Inside the existing atmosphere folder near `CNodeView3D.js:189`, lookView-only:

```js
guiTweaks.add(this, "atmosphereHaze")
    .name(t("view3d.atmosphereHaze.label", {defaultValue: "Horizon Haze"}))
    .listen()
    .onChange(() => setRenderOne(true))
    .tooltip(t("view3d.atmosphereHaze.tooltip", {defaultValue: "Fog asymptote uses pale horizon color rather than zenith blue"}));

guiTweaks.add(this, "skyGradient")
    .name(t("view3d.skyGradient.label", {defaultValue: "Sky Gradient"}))
    .listen()
    .onChange(() => setRenderOne(true))
    .tooltip(t("view3d.skyGradient.tooltip", {defaultValue: "Sky fades from zenith blue to horizon haze"}));
```

`setRenderOne(true)` matches the existing convention. `defaultValue` suppresses missing-key warnings until the i18n entries are filled in across all locales.

**Baseline impact:** This commit adds two rows to the right-panel lil-gui. Every existing lookView regression snapshot must be re-baselined in the same commit. Reviewers should diff each snapshot pair to confirm the only delta is the two new GUI rows.

### 2.5 Mobile / XR / DaySky behavior

Driven by `effectiveSkyGradient`. When any of these conditions hold, `useGradient = false` and the flat material draws exactly as today:
- `atmosphereEnabled` is false
- Mobile + `!allowMobileSkyGradient`
- `isIR`
- XR session active
- `GlobalDaySkyScene !== undefined` (Three `Sky` mesh covers the gradient anyway; leave alone)

### Phase 2 tests

- **T-2a unit** (`tests/sky-gradient-math.test.js`, new): ray-reconstruction math, expressed in local-up coordinates so it's independent of how the camera happens to sit in ECEF. Setup: place a `PerspectiveCamera` at any world position `P` (use `(6378000, 0, 0)` to exercise large coordinates), explicitly orient it via `camera.lookAt(P + tangent)` where `tangent` is any direction perpendicular to the local up at `P`. Call `camera.updateMatrixWorld()`. Use `projectionMatrixInverse` and `camera.matrixWorld` exactly as the shader does, and `localUp = getLocalUpVector(P)`. Then for each test UV:
  - Reconstruct `dir` in JS using the same math as the shader.
  - Assert via `dot(dir, localUp)`, not `dir.y`:
    - Screen center (`vUv = (0.5, 0.5)`) at horizontal orientation → `dot(dir, localUp) ≈ 0` (camera looks at horizon). Tolerance `1e-3`.
    - Top center (`vUv = (0.5, 1.0)`) at half-FOV-60° → `dot(dir, localUp) ≈ sin(30°) = 0.5`. Tolerance `1e-3`.
    - Bottom center → `dot(dir, localUp) ≈ -sin(30°)`.
  - This phrasing is what the shader actually computes (`h = clamp(dot(dir, upWorld), 0, 1)`), so any drift in the world-orientation setup surfaces as a test failure rather than a silent ECEF/local-frame confusion.
- **T-2b unit**: With camera at large ECEF coord, compare the old `invViewProj` world-position subtraction path against the camera-relative direction path. The camera-relative path must keep `dot(dir, localUp)` ordered from bottom < center < top; this guards the WebGL float-precision regression that made the wide-view gradient look flat.
- **T-2c unit**: legacy path stub — assert `effectiveSkyGradient` returns false in any condition where it should and the flat material is still used. (Iterates each disable predicate.)
- **T-2d visual regression** `atmo-gradient-on`: `SitAtmoTest` with `skyGradient: true, atmosphereHaze: true`. Inspect: smooth gradient, no banding, sky meets fog at the horizon.
- **T-2e visual regression** `atmo-gradient-off-legacy`: same sitch with both flags off. Bit-identical to Phase 1 `atmo-haze-off-legacy`. *Both* tests guard against accidental flat-material drift.
- **T-2f visual** (manual): pan lookView through full 360° azimuth + ±90° pitch. Horizon stays at horizon (i.e. gradient is world-locked, not camera-locked). Camera roll does *not* roll the gradient.
- **T-2g visual** (manual): `matchVideoAspect` synced sitch (gimbal). Gradient remains correct when the projection is asymmetric.
- **T-2h visual regression** `atmo-gradient-mobile-off`: set `Globals.isMobile=true` via test harness, `skyGradient: true`, `allowMobileSkyGradient: false`. Snapshot must equal `atmo-gradient-off-legacy`.
- **T-2i unit** (banding sanity): sample 256 rows of the gradient at a fixed column with bayer dither enabled; assert ≥ 200 unique RGB triples across the column. With dither off, expect ≤ 60 unique triples (depends on zenith/horizon contrast).

Gate: T-2a..c, T-2e, T-2h, T-2i green; T-2d/f/g baselines reviewed.

---

## Phase 3 — sunset warmth (sun-direction-weighted)

Goal: low-sun horizon shows warmth on the *sun-facing* side only; opposite horizon stays cool.

### 3.1 Augment `calculateHazeColor` to return *both* colors

V3 splits "haze" into a cool component (today's haze) and a warm component (sunset), keeping them separate until the shader blends per-pixel based on view direction. This is the V3 fix for the V2 sunset bug.

```js
// Returns {cool, warm, warmStrength}: the shader will mix at runtime.
calculateHazeColors(position, date, opts = {}, out = this._hazeOut ??= {
    cool: new Color(), warm: new Color(), warmStrength: 0
}) {
    this.calculateHazeColor(position, date, opts, out.cool);

    const sunAngle = opts.sunAngle ?? Globals.sunAngle ?? 90;
    const sunTotal = this.calculateSkyBrightness(position, date);

    if (sunAngle < 12 && sunAngle > -8) {
        // 0 at +12° (no warming), 1 at -8° (max warming, but sunTotal will be near zero anyway)
        const w = MathUtils.clamp((12 - sunAngle) / 20, 0, 1);
        const warmRGB = { r: 1.00, g: 0.69, b: 0.48 };       // ~#FFB07A
        const floor = Math.max(sunTotal, 0.15);
        // The warm color is independent of the cool, so the shader can blend per pixel.
        out.warm.setRGB(
            warmRGB.r * floor,
            warmRGB.g * floor,
            warmRGB.b * floor
        );
        out.warmStrength = w;
    } else {
        out.warm.copy(out.cool);
        out.warmStrength = 0;
    }
    return out;
}
```

### 3.2 Shader already supports it

The Phase 2 shader already reads `coolHorizon`, `warmHorizon`, `warmStrength`, and `sunDirHoriz`. Phase 3 just fills them with non-trivial values.

### 3.3 Uniform push in `renderSky`

Extend the Phase 2 block to populate `coolHorizon`, `warmHorizon`, `warmStrength`, `sunDirHoriz`:

```js
const hazeOut = sunNode.calculateHazeColors(this.camera.position, undefined, {
    visibilityKm: this.atmosphereVisibilityKm,
    sunAngle: Globals.sunAngle,
});
u.coolHorizon.value = hazeOut.cool;
u.warmHorizon.value = hazeOut.warm;
u.warmStrength.value = hazeOut.warmStrength;

// sunDirHoriz: project sun direction onto the local horizon plane and normalize.
const sunPos = Globals.sunLight?.position;
if (sunPos) {
    const sunDirWorld = this._sunDirScratch.copy(sunPos).sub(u.cameraWorldPosition.value).normalize();
    const vertical = this._scratchVec.copy(u.upWorld.value).multiplyScalar(sunDirWorld.dot(u.upWorld.value));
    u.sunDirHoriz.value.copy(sunDirWorld).sub(vertical).normalize();
} else {
    u.sunDirHoriz.value.set(1, 0, 0);
}
```

### 3.4 Fog gets the cool color only

Fog is a single asymptote color — no per-pixel sun-direction info. It should match the *azimuth-averaged* horizon, which physically is closer to the cool value than the warm one (the warm wedge is a fraction of the full circle). V3 keeps fog = cool haze. The sky directly facing the sun will be warmer than the fog there; this is correct because fog represents light scattered from *all* sky directions toward the camera, not the sky color in any one direction.

```js
// In pushLookViewAtmosphereFog (Phase 1 already routes through getAtmosphereHazeColorLinear);
// Phase 3 makes that helper call calculateHazeColors and return only .cool.
```

### Phase 3 tests

- **T-3a unit**: at `sunAngle = 90°`, `warmStrength = 0` and `cool == warm`.
- **T-3b unit**: at `sunAngle = 0°` (sunrise), `warmStrength > 0.5`, `warm.r/warm.b > 1.2`, `cool.r/cool.b < 1.0`.
- **T-3c unit**: at `sunAngle = -20°` (deep night), `warmStrength → 0` again *or* the warm value times sunTotal is effectively black; no orange ghost at midnight.
- **T-3d visual regression** `atmo-sunset-on`: `SitAtmoSunset` with `skyGradient: true, atmosphereHaze: true`, sunAngle ≈ 5°. Sun-facing horizon is orange; anti-sun horizon is cool. Camera azimuth set to face the sun.
- **T-3e visual regression** `atmo-sunset-on-anti`: same sitch, camera rotated 180° to face away from sun. Horizon must be cool/violet, not orange. *This catches the V2 bug directly.*
- **T-3f visual** (manual): pan camera through full 360°; warmth band tracks the sun position.
- **T-3g visual regression** `atmo-noon`: noon sun. `warmStrength = 0`. Snapshot equals Phase 2 `atmo-gradient-on`.
- **T-3h performance**: Phase 3 adds ~6 vector ops per frame on CPU (uniform updates) and ~10 ops per fragment (sun-azimuth dot+mix). Measure with EXT_disjoint_timer_query_webgl2 on a mid-range mobile (if accessible) and on desktop. Budget 0.3 ms desktop, 1.0 ms mobile.

Gate: T-3a..c green; T-3d/e baselines reviewed; T-3g bit-identical to Phase 2 baseline; T-3h within budget or corner-ray fallback engaged.

---

## Phase 4 — altitude and slant-path accuracy

Goal: make the same controls behave plausibly for observers from sea level through aircraft altitude (0-50,000 ft) and for long-distance oblique satellite/image views. The current Phase 1-3 model treats `visibilityKm` as a single near-ground scene scalar. That is adequate for the NYC skyline test, but it is not enough when the camera is above most aerosols or when a ray crosses hundreds of kilometers of atmosphere at a shallow angle.

### 4.1 Distinguish surface visibility from path optical depth

Keep the UI field name `atmosphereVisibilityKm` because that matches aviation/weather usage, but define it precisely:

- `atmosphereVisibilityKm` is **surface horizontal meteorological visibility near observer ground level**, not "every ray fades after this many km."
- Convert it to a sea-level extinction coefficient using Koschmieder's law:

```js
const beta0 = 3.912 / Math.max(visibilityKm * 1000, 1); // 2% contrast threshold, 1/m
```

Then scale extinction with altitude rather than applying the same beta everywhere:

```js
function aerosolDensityAtAltitude(hMeters, scaleHeightMeters = 1200) {
    return Math.exp(-Math.max(hMeters, 0) / scaleHeightMeters);
}
```

This means a 14.4 km day at sea level remains hazy near the horizon, but a camera at 35,000 ft is above most boundary-layer aerosol and should see a deeper blue upper sky with much less local fogging.

### 4.2 Fast slant-path approximation

For each sky pixel, estimate the aerosol optical depth along the view ray. We do **not** raymarch in Phase 4; use a closed-form exponential atmosphere approximation:

```js
// h0: observer altitude above ellipsoid/terrain in meters
// mu: dot(viewDir, localUp), positive upward, negative downward
// H: aerosol scale height, default 1200 m
function aerosolOpticalDepthApprox(h0, mu, maxDistanceMeters, H = 1200) {
    const betaClamp = Math.max(Math.abs(mu), 0.02); // avoid singularity at true horizon
    const density0 = Math.exp(-Math.max(h0, 0) / H);

    if (mu > 0) {
        // Looking upward: finite column above observer.
        return density0 * H * (1 - Math.exp(-maxDistanceMeters * betaClamp / H)) / betaClamp;
    }

    // Looking level/downward: density increases toward lower altitude. In the
    // flat-Earth exponential approximation, ground distance along the ray is
    // h0 / |mu|. Clamp to terrain/scene limit when available.
    if (h0 < 10) {
        // Sea-level horizon/near-ground rays stay inside the dense boundary
        // layer; do not collapse to zero just because the flat approximation's
        // ground intersection is immediately below the camera.
        return Math.min(maxDistanceMeters, H / betaClamp);
    }

    const distanceToGround = Math.max(h0, 0) / betaClamp;
    const L = Math.min(maxDistanceMeters, distanceToGround);
    if (L <= 0) return 0;

    // Integral exp(-(h0 - |mu| s) / H) ds from 0..L.
    // Clamp exponent for numerical safety; once it is this large, the ray has
    // effectively reached dense lower atmosphere and/or should be terrain-limited.
    const x = Math.min(betaClamp * L / H, 20);
    return density0 * H * (Math.exp(x) - 1) / betaClamp;
}
```

Use it to derive an effective per-ray extinction/fade:

```js
const tau = beta0 * aerosolOpticalDepthApprox(observerAltitudeM, mu, rayLimitM);
const transmittance = Math.exp(-tau);
const hazeAmount = 1 - transmittance;
```

This gives the right qualitative behavior:

- Sea-level, near-horizon rays: large optical depth, milky horizon.
- Sea-level, upward rays: smaller optical depth, blue zenith.
- Aircraft at 30,000-50,000 ft, looking upward: very little aerosol haze.
- Aircraft looking down through the boundary layer: haze appears over distant terrain/cities.
- Oblique satellite imagery: strongest haze near the limb/low elevation path, weaker for near-nadir views.

### 4.3 Observer altitude source

Do not use `camera.position.length() - earthRadius` ad hoc in the shader. Compute observer altitude on CPU using the existing ellipsoid helpers:

```js
const observerLLA = ECEFToLLAVD_radii(this.camera.position);
const observerAltitudeM = observerLLA.alt;
```

Pass it to the sky gradient as `observerAltitudeM`. For terrain-clamped cameras, this is effectively AGL/MSL as already represented by the active camera; for planes and satellites it preserves the true observer height.

For rays that point downward, Phase 4 should optionally use a terrain/building ray-limit when one is cheaply available. If no limit exists, cap `rayLimitM` conservatively:

| View type | Default ray limit |
|---|---:|
| Ground skyline | 80 km |
| Aircraft lookView | 250 km |
| High-altitude balloon / U-2-like | 600 km |
| Satellite oblique | 1500 km |

These are not hard physical horizons; they prevent the approximate integral from producing absurd haze for rays that never intersect visible terrain in the current render.

### 4.4 Fog and object fading at altitude

Three's `FogExp2` is distance-only, so it cannot know that the camera is above the aerosol layer. Phase 4 should replace the single density used for lookView fog with an altitude-aware effective density:

```js
const observerDensity = aerosolDensityAtAltitude(observerAltitudeM);
const effectiveFogDensity = baseFogDensity * Math.max(observerDensity, 0.05);
```

That keeps a small residual molecular/aerosol floor but prevents aircraft-at-cruise scenes from washing out nearby objects as if the plane were inside sea-level haze. For downward-looking aircraft/satellite views, terrain haze should eventually move out of `FogExp2` and into a terrain/building material or post-process depth pass, because distance-only fog from a high camera is not physically expressive enough. Phase 4 can start with the effective-density clamp; Phase 5 can do per-fragment terrain aerial perspective if needed.

### 4.5 Sky color at altitude

The zenith boost added in Phase 2 should be altitude-aware:

```js
const altitudeT = MathUtils.clamp(observerAltitudeM / 12000, 0, 1); // ~39,000 ft
const blueBoost = baseBlueBoost + 0.20 * altitudeT;
```

But do not make the horizon equally blue at altitude. Even from aircraft, long low-angle paths through the lower atmosphere stay pale. This is the key visual rule:

> Altitude makes the upper sky darker/bluer faster than it clears the horizon.

### 4.6 Satellite and long slant images

For satellite/space-like cameras, do not use the ground-level fog asymptote as a full-screen background. The view contains two regimes:

- Space/upward/background rays: black or very dark sky, stars/satellites may remain visible.
- Earth/downward/limb rays: atmosphere contributes blue limb and white aerosol veil over terrain/clouds.

Phase 4's sky-gradient shader should be gated by altitude:

```js
const spaceBlend = MathUtils.smoothstep(observerAltitudeM, 80000, 160000);
```

Above that range, blend the upper sky toward black rather than brighter blue, while retaining a bright blue/white atmospheric limb near Earth. This should **not** replace the existing night-sky/star path; it should preserve the current night sky, satellites, Sun/Moon passes, and only affect the daytime atmospheric background/aerial perspective.

### Phase 4 tests

- **T-4a unit**: `aerosolDensityAtAltitude(0) ≈ 1`, `1200 m ≈ e^-1`, `10668 m / 35,000 ft < 0.001`.
- **T-4b unit**: for fixed `visibilityKm = 14.4`, upward optical depth at 35,000 ft is at least 100× smaller than upward optical depth at sea level.
- **T-4c unit**: at 35,000 ft, downward/near-horizon optical depth remains non-zero and greater than upward optical depth.
- **T-4d visual regression** `atmo-altitude-0ft`: existing skyline baseline, horizon milky, upper sky blue.
- **T-4e visual regression** `atmo-altitude-35000ft`: aircraft camera over same region, upper sky darker/bluer, distant ground still has haze.
- **T-4f visual regression** `atmo-altitude-50000ft`: stronger blue/black upper sky transition, weak local fog.
- **T-4g visual/manual** `atmo-satellite-oblique`: long slanted view over Earth; limb/path haze visible, space/background not filled with pale fog.
- **T-4h regression**: night-sky sitches with stars/satellites and daytime Moon still render; sky-opacity and Sun/Moon ordering are unchanged.

Gate: T-4a..c green; T-4d/e/f baselines reviewed; T-4g manually inspected; T-4h confirms no day/night or satellite regression.

---

## Test sitches (new, committed)

V2 prescribed regression tests but used a server-hosted custom sitch (not safe for CI). V3 creates two committed deterministic sitches.

### `src/sitch/SitAtmoTest.js`

- Fixed time/date: noon UTC on a clear day in mid-2024 (so sun is high, atmospheric model is stable).
- Camera at a fixed ECEF position over NYC (40.7128°N, 74.0060°W) looking south.
- 3D Buildings on (Cesium OSM tiles, deterministic version pin) **or**, to remove tile dependency entirely, a procedural skyline geometry (preferred — see §Open Questions Q-C below).
- `atmosphere: { enabled: true, visibilityKm: 14.4, hdr: false }`.
- Two opt-in variants registered as separate URL params: `?sitch=atmo-test&haze=on&gradient=on`. Variants are read via `GlobalURLParams` (`import { GlobalURLParams } from "../Globals"`, declared at `Globals.js:272`) in the sitch setup, not hardcoded.

### `src/sitch/SitAtmoSunset.js`

- Same camera geometry, time set so sun is 5° above horizon to the west.
- Camera azimuth knob (`look=sun` or `look=anti`) toggles facing direction for `atmo-sunset-on` vs `atmo-sunset-on-anti` tests.
- `atmosphere: { enabled: true, visibilityKm: 18, hdr: false, haze: true, skyGradient: true }`.

### Registry entries

Append to `tests_regression/regression.test.js` and `test-registry.js` per CLAUDE.md's "Adding a Visual Regression Test" guide:

| id | url | Phase |
|---|---|---|
| `atmo-haze-off-legacy` | `?sitch=atmo-test&haze=off&gradient=off` | 1 |
| `atmo-haze-on` | `?sitch=atmo-test&haze=on&gradient=off` | 1 |
| `atmo-haze-on-hdr` | `?sitch=atmo-test&haze=on&gradient=off&hdr=on` | 1 |
| `atmo-gradient-on` | `?sitch=atmo-test&haze=on&gradient=on` | 2 |
| `atmo-gradient-off-legacy` | `?sitch=atmo-test&haze=off&gradient=off` (duplicate of haze-off; kept separate for naming clarity) | 2 |
| `atmo-gradient-mobile-off` | `?sitch=atmo-test&haze=on&gradient=on&forceMobile=on` | 2 |
| `atmo-sunset-on` | `?sitch=atmo-sunset&haze=on&gradient=on&look=sun` | 3 |
| `atmo-sunset-on-anti` | `?sitch=atmo-sunset&haze=on&gradient=on&look=anti` | 3 |
| `atmo-noon` | `?sitch=atmo-test&haze=on&gradient=on` (Phase-3 idempotency check) | 3 |
| `atmo-altitude-0ft` | `?sitch=atmo-altitude&cameraAltFt=0&look=horizon&vis=14.4` | 4 |
| `atmo-altitude-35000ft` | `?sitch=atmo-altitude&cameraAltFt=35000&look=horizon&vis=14.4` | 4 |
| `atmo-altitude-50000ft` | `?sitch=atmo-altitude&cameraAltFt=50000&look=horizon&vis=14.4` | 4 |
| `atmo-satellite-oblique` | `?sitch=atmo-altitude&cameraAltKm=500&look=oblique&vis=14.4` | 4 |

Also re-baseline (manually verify identical) these existing tests after each phase since they share the lookView code path: `gimbal`, `agua`, `nightsky-permalink`, `ocean surface`, `demo-truck`.

---

## Performance plan (V3)

Targets and measurement:
- Legacy-off path: **bit-identical to today** and same shader, same uniforms, same draw call. Verified by `atmo-haze-off-legacy` byte-identity test.
- Gradient-on, desktop: **< 0.3 ms** added per lookView frame at 1080p, 1.0x render scale.
- Gradient-on, mid-mobile: **< 1.0 ms** added, or gradient auto-disables via `effectiveSkyGradient`.
- No new render targets, no new framebuffer attachments.
- One new gradient shader compile, on first opt-in only.

CPU-side per-frame cost (Phase 3):
- 1× projection-matrix copy + invert, plus 1× camera-world-matrix copy
- 1× `getLocalUpVector` (∼10 scalar ops per SphericalMath.js:250)
- 1× `calculateHazeColors` (one `calculateSkyBrightness` + ~20 ops)
- 1× sun-direction projection (~10 ops)
- Total: well under 50 µs typical.

CPU-side per-frame cost (Phase 4 altitude path):
- 1× `ECEFToLLAVD_radii` for observer altitude, cached per frame/view.
- A few scalar ops to derive `observerDensity`, `spaceBlend`, and fog-density scale.
- No CPU raymarching. Per-pixel slant behavior remains shader-side.

GPU-side fragment cost (Phase 2/3 shader):
- 1× camera-space ray construction from FOV/aspect, plus 1× world direction rotation from three basis vectors
- 2× `normalize`
- 1× `pow`
- 2× `mix`
- 1× hash dither
- ~30 ops × ~2M pixels (1080p) × 60 fps = ~3.6 G ops/s. Trivial for desktop GPUs; possibly meaningful on integrated mobile GPUs.

Phase 4 adds only scalar exponential/`exp` math to the gradient shader. If that is measurable on mobile, use a 1D lookup texture or a low-order approximation for `exp(-h/H)` before engaging the corner-ray fallback.

Corner-ray fallback (engaged in Phase 2 only if measurement shows mobile > 1 ms):

```glsl
// Vertex shader for fullscreen quad: emit ray direction per corner
attribute vec3 position;
varying vec3 vRayDir;
uniform float cameraTanHalfFov;
uniform float cameraAspect;
uniform vec3 cameraWorldX;
uniform vec3 cameraWorldY;
uniform vec3 cameraWorldZ;
void main() {
    // position is already in NDC [-1,1]; camera-relative corner ray.
    vec3 dirCamera = normalize(vec3(
        position.x * cameraAspect * cameraTanHalfFov,
        position.y * cameraTanHalfFov,
        -1.0
    ));
    vRayDir = normalize(
        cameraWorldX * dirCamera.x +
        cameraWorldY * dirCamera.y +
        cameraWorldZ * dirCamera.z
    );
    gl_Position = vec4(position, 1.0);
}
```

The fragment shader receives the interpolated `vRayDir`, skipping the per-pixel matrix multiply. With four corners of a fullscreen quad this gives correct linear interpolation across the screen (the math is exact for an affine projection of the unit sphere onto screen space — a small acceptable error near the edges of very wide-FOV cameras, immaterial at typical 60° FOV).

This fallback is *fully spec'd* in V3 (V2 just hand-waved at it) so it can be dropped in without re-design.

Profiler instrumentation (under existing `skyRender` block at `CNodeView3D.js:2027/2074`):

```js
if (globalProfiler) globalProfiler.push('#88ccee', 'skyGradientUniforms');
// uniform setup
if (globalProfiler) globalProfiler.pop();
```

No new label for the actual draw (it's already under `skyRender`).

---

## Visual regression plan (V3, condensed)

Cases & responsibility:

| Case | Phase | Type | Source |
|---|---|---|---|
| Legacy lookView unchanged | 0 | snapshot | existing `gimbal`, `agua`, `ocean`, `demo-truck`, `nightsky-permalink` |
| Haze opt-in, gradient off | 1 | snapshot | `atmo-haze-on` (new) |
| Haze opt-in, HDR on | 1 | snapshot | `atmo-haze-on-hdr` (new) |
| Haze opt-out fully legacy | 1 | byte-id | `atmo-haze-off-legacy` (new) |
| Gradient opt-in | 2 | snapshot | `atmo-gradient-on` (new) |
| Gradient opt-out byte-id | 2 | byte-id | `atmo-gradient-off-legacy` (new) |
| Mobile gate forces flat | 2 | byte-id | `atmo-gradient-mobile-off` (new) |
| Camera-roll independence | 2 | manual | T-2f |
| matchVideoAspect path | 2 | manual | T-2g |
| Sunset sun-facing | 3 | snapshot | `atmo-sunset-on` (new) |
| Sunset anti-sun | 3 | snapshot | `atmo-sunset-on-anti` (new) — V2 bug check |
| Noon idempotent | 3 | byte-id | `atmo-noon` matches Phase 2 baseline |
| Sea-level altitude baseline | 4 | snapshot | `atmo-altitude-0ft` |
| Aircraft cruise altitude | 4 | snapshot | `atmo-altitude-35000ft` |
| High aircraft / balloon altitude | 4 | snapshot | `atmo-altitude-50000ft` |
| Satellite oblique slant path | 4 | manual + snapshot if stable | `atmo-satellite-oblique` |
| Day/night celestial safety | 4 | snapshot/manual | `nightsky-permalink`, daytime Moon case, satellite display case |
| Visibility sweep | 1 | snapshot ×4 | re-run `atmo-haze-on` with `?vis=5`, `14.4`, `30`, `80` |

XR, mainView, and night-sky-only sitches must not regress; if they share the sky material, the `effectiveSkyGradient` gate is what prevents them from running gradient code, so the byte-id tests above prove it.

---

## Rollout

1. **Phase 0** — fields, helpers, gate, and two-material plumbing. No pixel change. Land first.
2. **Phase 1** — opt-in haze fog with correct color-space conversion. Land when T-1f byte-identity is proven.
3. **Phase 2** — opt-in sky gradient with dither + mobile/XR/DaySky gates. Land when T-2e/h are bit-identical and T-2d/f/g visually reviewed.
4. **Phase 3** — sun-azimuth-weighted sunset. Land when T-3e shows the cool anti-sun horizon.
5. **Phase 4** — altitude/slant-path correction. Land before enabling the feature on aircraft, balloon, or satellite-oriented sitches.
6. (Optional) Flip default to opt-in for a curated set of built-in sitches (e.g., the Atmo Visibility demo). Each opt-in is a single-line sitch edit + a new baseline; no code changes.

Rollback:
- Each phase is reverted by flipping its own opt-in flag back to false. No data migration. Old custom URLs already default to legacy by construction.

---

## Open questions / verify-in-Phase-0

- **Q-A.** Confirm `renderer.xr.isPresenting` returns `false` outside XR in three@0.183.1 (audit cites no usage in `CNodeView3D.js`). Fallback to `getSession?.()` in `effectiveSkyGradient`.
- **Q-B.** Console.log inside `pushLookViewAtmosphereFog` during a normal dev session: does any built-in sitch hit it? If yes, that sitch will *not* see Phase 1 changes (it has `atmosphereEnabled: true` but `atmosphereHaze: false`), but we should know which ones for re-baseline planning.
- **Q-C.** `SitAtmoTest.js` skyline source: 3D Buildings tiles (network-dependent) vs procedural building geometry committed to `data/`? Procedural is strictly better for CI determinism; cost is a few hundred lines of geometry-builder code.
- **Q-D.** Does `Globals.sunAngle` always reflect the active view's camera? `CNodeSunlight.update()` (`CNodeSunlight.js:144`) computes it from the look or main camera — verify lookView wins when both exist, otherwise Phase 3's sun-direction will be wrong in split-screen.
- **Q-E.** `t()` keys added with `defaultValue` — should we also add proper entries to `src/i18n/en.js`? If yes, document in a follow-up TODO; if no, leave the defaultValue scaffolding and ship with `en` showing the default.
- **Q-F.** Once Phase 0 has shipped, run the byte-identity test once more after a Three.js point release. Any change in how Three handles fog color encoding internally would silently shift the legacy path, and our byte-id tests are the only safety net.
- **Q-G.** Which altitude reference should Phase 4 expose in the UI: observer HAE/MSL from `ECEFToLLAVD_radii`, AGL above terrain, or both? Rendering should use HAE/MSL for atmospheric column density, but pilots often think in MSL/flight levels and terrain-relative AGL for low-altitude cases.
- **Q-H.** For satellite/space cameras, where should the atmosphere transition from sky-gradient background to Earth-limb/aerial-perspective rendering? Phase 4 proposes 80-160 km as a practical `spaceBlend`, but this should be visually verified against existing satellite/night-sky sitches.

---

## Appendix: V1 → V2 → V3 changelog

- **V1 → V2 (Codex):** fixed ray math (camera-relative), removed default-flip ambiguity, added XR/DaySky gates, called out the color-space contract as needing explicit decision, added two-material strategy, corrected Phase 1 chroma test claim, prescribed `setRenderOne` + `MathUtils.clamp` from `three`.
- **V2 → V3 (Claude + agents):** verified every codebase claim against actual file:line, added concrete color-space implementation (sRGB returned by both functions, `.convertSRGBToLinear()` at fog-assignment), fixed sunset to be sun-azimuth-weighted in the shader (V2's uniform tint was physically wrong), added `opacity` uniform to the gradient shader (V2 omitted), added dither against banding, added explicit mobile gate (`allowMobileSkyGradient`), spelled out the corner-ray fallback shader, added committed deterministic test sitches `SitAtmoTest`/`SitAtmoSunset` (replacing V2's server-hosted custom URL), added HDR exposure verification path with regression coverage, exposed `horizonExponent` as a sun-elevation-modulated uniform.
- **V3 altitude extension (Mick review 2026-05-21):** added Phase 4 for altitude/slant-path accuracy across sea-level, aircraft 0-50,000 ft, high-altitude, and satellite/oblique imagery. Separates surface visibility from per-ray optical depth, uses an exponential aerosol scale-height model, gates space-like cameras, and adds altitude/satellite regression cases while preserving night-sky, daytime Moon, stars, and satellites.
- **V3 revision pass (review feedback 2026-05-21):**
  - **P1 — HDR self-contradiction:** dropped V3 TL;DR's "pre-multiply fog by inverse exposure" prescription. The §Color-space contract section was right: fog and sky both render into the same float target before the single tone-map pass, so no compensation is needed. The TL;DR now matches.
  - **P1 — legacy fog byte-identity:** the §Color-space code sample was converting `this.background` with `.convertSRGBToLinear()` in the legacy branch, contradicting the prose immediately below that said legacy must stay unconverted. Rewrote the sample to use `getAtmosphereSkyColor()` unchanged in the legacy branch, matching the Phase 1 implementation.
  - **P1 — Phase 0 GUI vs. byte-identity:** the GUI controls have been moved from Phase 0 to Phase 2.4. The lil-gui panel is in regression screenshots; adding rows to it breaks byte-identity. Phase 0 is now pure data plumbing; toggles ship with the visible gradient.
  - **P1 — unit tests can't instantiate `CNodeView3D`:** Phase 0 tests now drive pure helpers (`resolveAtmosphereFields`, `computeEffectiveSkyGradient`) extracted from the constructor, plus one lightweight Playwright integration for the "Phase 0 is no-op" claim.
  - **P1 — `Globals.urlParams` → `GlobalURLParams`:** corrected the `SitAtmoTest` description to reference the actual exported name (`Globals.js:272`).
  - **P2 — zero-vector normalize:** added a `horizLen > 1e-4` guard in the gradient shader before `normalize(horizProj)`, with a fallback to `coolHorizon` when the camera is looking near zenith/nadir.
  - **P2 — Bayer table fragility:** replaced the local-array `bayer4()` with a branchless hash-based dither (`hashDither`) to avoid WebGL1/mobile compile issues with local float arrays + dynamic int indexing.
  - **P2 — disposal coverage:** extended `dispose()` to handle `skyFlatMaterial` + lazy `skyGradientMaterial`, with explicit aliasing/double-dispose guards.
  - **P2 — T-2a coordinate confusion:** rewrote the ray-reconstruction test to express assertions via `dot(dir, localUp)` after explicit `camera.lookAt` orientation. At ECEF `(6378000, 0, 0)`, local up is mostly +X, not +Y; the V3.0 test would have silently passed or failed for the wrong reason.
