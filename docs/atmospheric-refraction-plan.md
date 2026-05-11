# Atmospheric Refraction — Celestial Objects (Plan)

Goal: render Sun, Moon, planets, and stars at their **apparent** (refracted)
positions, matching Stellarium under default atmospheric conditions. Scope
of this pass is celestial only; satellites and terrestrial objects come later.

## 1. Formula

Use Stellarium's blended **Saemundsson** forward model (geometric → apparent).
We have geometric altitudes from astronomy-engine / the BSC catalog and want
apparent positions, so the forward direction is what we need; Bennett (the
apparent → geometric inverse) is not used in this pass.

With pressure `P` (hPa), temperature `T` (°C), geometric altitude `h` (deg):

```
f       = (P / 1010) * 283 / (273 + T) / 60     // arcmin → deg
R(h)    = f * ( 1.02 / tan( (h + 10.3/(h+5.11)) * π/180 ) + 0.0019279 )
```

Domain handling, matching Stellarium:

- `h ≥ −3.54°` — apply `R(h)` directly.
- `−5° ≤ h < −3.54°` — linear taper from `R(−3.54°)` to 0 at `−5°`.
- `h < −5°` — zero correction.

Defaults: `P = 1010 hPa`, `T = 10 °C` (Stellarium's defaults; under these the
formula gives ≈ 34′ at the horizon and ≈ 0.95′ at 30°).

Sanity targets (P=1010, T=10):
- `h = 0°`   → `R ≈ 28.7′` (Saemundsson; horizon classic value 34–35′ comes
  from `h = −0.5°` apparent ↔ Bennett; Stellarium agrees).
- `h = 5°`   → `R ≈ 9.9′`
- `h = 30°`  → `R ≈ 0.95′`
- `h = 90°`  → `R ≈ 0`

A small unit test will pin these.

## 2. Geometry — bending the direction

All renderers feed through `raDec2Celestial(ra, dec, sphereRadius)` at
`src/CelestialMath.js:15`, which produces an equatorial-ECEF direction on a
fixed celestial sphere. The cleanest place to bolt refraction on is *after*
that conversion, in equatorial-ECEF, with no detour through alt/az:

```
Given unit direction d (equatorial ECEF) and local zenith z (same frame):
  alt   = asin(d · z)                  // signed
  Δ     = R_saemundsson(alt_deg)       // in degrees, then to radians
  axis  = normalize(d × z)             // rotation axis, lifts d toward z
  d'    = rotate(d, axis, Δ)
```

`d'` is then scaled by the sphere radius the caller is using
(`sphereRadius` for stars/planets, `sunSphereRadius` for the Sun).

Notes:

- Direction-only — distance is preserved, which is correct because all of
  these objects are far enough that refraction shifts angle, not range.
- For the Moon disk, applying refraction to the *center* direction is the
  first-pass correct behavior. Differential refraction across the disk
  (the visible flattening near the horizon) is a smaller second-order
  effect; not in this pass.
- Numerical care: clamp `(h + 5.11)` away from zero before `tan(...)` for
  altitudes close to `−5.11°` (well outside the active range, but cheap
  insurance).

## 3. Where to apply

### 3a. CPU — Sun, Moon, planets

In `src/nodes/CPlanets.js`:
- `updatePlanetSprite` — after `raDec2Celestial(...)` at line 496, bend
  the resulting direction before computing `sunPosition` / `sprite.position`.
- `updateMoonMesh` — after `raDec2Celestial(...)` at line 401, bend the
  result before `moonMesh.position.set(...)`.
- The Moon-lighting basis (`sunDir`, `sunInMoonLocal`, body axes) must
  **not** use the refracted position — lighting is a physical Moon→Sun
  vector and is unaffected by Earth's atmosphere. Only the *visible*
  position of the Moon in the sky changes. Same for the planet sprites'
  RA/Dec stored on `this.planetSprites` (keep those geometric).

Cost: ~10 objects/frame, trivial.

### 3b. GPU — stars

`src/nodes/CStarField.js:181` bakes star positions into `CPointLightCloud`
**once** at setup. Re-baking each frame as the local zenith rotates with
sidereal time would cost an N-vertex CPU pass for thousands of stars.

Instead, do refraction in the star **vertex shader**:

- Bake unrefracted equatorial-ECEF positions as today.
- Pass the per-frame local zenith as a uniform: `uZenithECEF` (vec3).
- Pass an enable flag and `(P, T)` packed into a single uniform.
- Vertex shader: same math as §2, computed per-vertex on GPU.

Per-frame uniform update only — no per-vertex CPU work, no buffer re-upload.

The local zenith `z` in equatorial-ECEF is computed once per frame on the
JS side from observer lat/lon and GMST (sitrec already does this for
satellite glints in `CNodeDisplayNightSky.js`). This is path (a) from the
discussion — preferred over computing it inside the shader.

### 3c. Shared helper

One JS function and one GLSL function, kept formula-identical:

```
src/atmosphere/refraction.js
  applyRefractionDirECEF(dir, zenithECEF, opts) -> Vector3
  refractionDeltaDeg(altDeg, opts) -> number     // exposed for tests/UI

src/shaders/refraction.glsl   (or inlined into the existing star shader)
  vec3 applyRefraction(vec3 dir, vec3 zenith, float pressure, float tempC);
```

A small Vitest pins `refractionDeltaDeg` against Stellarium values at
`h ∈ {0, 1, 5, 10, 30, 60, 90, −1, −3, −4}` degrees. Same vectors used as
a sanity check on the GPU path during dev (read back one bent vertex once
and compare to the JS result).

## 4. Settings / UI

Minimal first cut, on the existing night-sky / astronomy panel:

- `Atmospheric refraction` — boolean, default **on**.
- `Pressure (hPa)` — default `1010`.
- `Temperature (°C)` — default `10`.

These flow through `Sit` (or the relevant celestial node options), are read
once per frame, and update both the CPU helper and the GPU uniforms.

When the toggle is off, the JS helper is a no-op (returns `dir` unchanged)
and the shader sets `Δ = 0`.

## 5. File-level changes (planned)

| File | Change |
| --- | --- |
| `src/atmosphere/refraction.js` *(new)* | `refractionDeltaDeg`, `applyRefractionDirECEF`, defaults |
| `src/CelestialMath.js` | (no change — keep `raDec2Celestial` geometric) |
| `src/nodes/CPlanets.js` | bend after `raDec2Celestial` in `updateMoonMesh` (line 401) and `updatePlanetSprite` (line 496); keep stored RA/Dec geometric |
| `src/nodes/CStarField.js` | pass refraction uniforms each frame; bake unchanged |
| `src/nodes/CPointLightCloud.*` (or the star material) | extend vertex shader with refraction block; add `uZenithECEF`, `uRefractionEnabled`, `uPressure`, `uTempC` uniforms |
| `src/Globals.js` or astronomy-panel UI | add the three settings + persistence |
| tests | unit test for `refractionDeltaDeg`; one render-side smoke check |

## 6. Out of scope (this pass)

- Differential refraction across the Moon/Sun disk (horizon flattening).
- Refraction for satellites and aircraft (will reuse the same helper later
  but needs additional handling for finite range and intervening atmosphere).
- Refraction for terrestrial / ground objects across the line of sight.
- Wavelength dependence (chromatic refraction).
- Non-standard atmosphere profiles (temperature inversions etc.) — Stellarium
  doesn't model these either at the basic level.

## 7. Test sitch

Moon-at-horizon scenario (good visual test — refraction is most obvious here):

```
http://localhost:8080/?custom=http%3A//localhost%3A8080/sitrec-upload/1/Moon%20horizon%20test/20260508_064051.js
```

Toggling refraction on should lift the Moon by ~½° at the horizon — about
one Moon diameter — and squash to zero by ~30° altitude. MCP screenshots
before/after make a clean visual diff.

## 8. Open questions

1. Confirm the local-zenith uniform path (§3b option a) over shader-side
   recomputation. Recommended: option a.
2. UI surface — own panel section, or fold into an existing "Atmosphere"
   panel if one already exists?
3. Should the toggle/values be per-sitch (saved with the scenario) or
   global user preferences? Default suggestion: per-sitch with sensible
   defaults, since pressure/temperature are scenario-relevant.
