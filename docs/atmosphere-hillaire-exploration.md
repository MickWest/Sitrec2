# Atmosphere rendering: Hillaire 2020 (and friends) for Sitrec

Exploratory design notes, not a decided spec.

## TL;DR

Sitrec's current atmosphere is an analytic Koschmieder extinction plus a
hand-tuned horizon gradient, composited only in the Look view (see
[`AtmosphericAerialPerspective.md`](./AtmosphericAerialPerspective.md)).
It works at sea level, degrades at altitude, ignores the radiosonde data
Sitrec already loads, and isn't wavelength-aware. This doc proposes adding
Hillaire 2020 (LUT-based, physically-based, multi-scattering) as a second
backend, leaving the analytic path in place as a deterministic / low-end
fallback. Sitrec-specific extensions the paper doesn't cover: LEO-altitude
observers, ECEF coordinates, multi-view LUT sharing, radiosonde-driven
density profiles, IR band, and refraction coupling. Realistic engineer-
effort total ≈ 18–30 e-weeks across four phases, each phase shippable and
snapshot-stable. Open questions remain around radiometric calibration,
GPU-determinism in tests, and the right benchmark target for the per-frame
pass cost.

## Glossary (Sitrec terms used below)

- **Sitch** — a saved scenario; a JSON bundle defining the node graph,
  loaded media, and view state.
- **Node / `CNode*` / NodeMan** — Sitrec is a node graph. Every visible
  thing is a `CNode` subclass; `NodeMan` is the global registry.
- **Main view / Look view** — Sitrec renders two synced 3D viewports:
  *Main* is the user's free-roam camera, *Look* is the reconstructed
  sensor. Both must reach the same physical conclusion.
- **ECEF** — Earth-Centred Earth-Fixed Cartesian coordinates. Sitrec
  stores world positions in ECEF, not a local Y-up frame. "Up" varies
  by location.
- **Koschmieder visibility** — meteorological optical range; the
  Koschmieder constant gives `β = 3.912 / V_meteor_m`. Sitrec's
  "Atmo Visibility (km)" slider feeds this.
- **Froxel** — frustum-aligned voxel; a 3D texture parameterised by
  (screen xy, view-space depth slice). Hillaire's aerial-perspective LUT
  is a froxel volume.

## 1. What Sitrec has today

| Piece | Where | Notes |
|---|---|---|
| Koschmieder extinction | `CNodeView3D` aerial pass | `β = 3.912 / vis_m`, then `T = exp(-β·d)` (verified at `CNodeView3D.js:2345`) |
| Distance pre-pass | `CNodeView3D.renderAerialPerspectiveDepth()` | Normalised distance render target — avoids depth-buffer precision loss at Earth-scale far planes. Implemented as a full scene render with `overrideMaterial` |
| Horizon air-mass clamp | `CNodeView3D` aerial-pass shader | Analytic horizon distance as a lower bound when terrain shader doesn't report a usable depth |
| Height-integrated optical depth | `CNodeView3D` (high-altitude branch) | `τ = β·∫exp(-h/H_scale) ds` with Rayleigh H=8000 m, aerosol H=1500 m |
| Horizon-to-zenith sky gradient | `CNodeDaySky` + view3d uniforms (`coolHorizon`, `warmHorizon`) | Replaced by the aerial-pass sky-ray color when atmosphere is on |
| Alternative sky paths | `CNodeDisplaySkyOverlay`, `CNodeDisplayNightSky` | Independent of the aerial pass. Any LUT model needs to coordinate with these (night sky, day overlay) rather than replace them outright |
| HDR tone-mapping pass | `CNodeView3D` (`atmosphereHDR`, `atmosphereExposure`) | Gated on `useLookViewHDR && atmosphereEnabled && hdrToneMappingPass !== null` — a subtle interaction Phase 0 must preserve |
| Atmospheric profile from radiosondes | `CNodeAtmosphericProfile` | Per-altitude T/P/RH/wind. Consumed by the wind field (`CNodeDisplayWindField.js:1636`), **not** by the atmosphere shader |
| Refraction (geometry only) | [`atmospheric-refraction-plan.md`](./atmospheric-refraction-plan.md) | Bends rays for apparent-position correctness; not coupled to the atmosphere shader |

Two GUI toggles to keep distinct:

- **`lighting.atmosphere`** (relabelled "Daylight Sky" in the UI but the
  property and serialised key remain `atmosphere`) — global "render the
  blue daytime sky at all". Off = stars visible in daylight.
- **`view3d.atmosphere`** (per-view, `atmosphereEnabled` on `CNodeView3D`)
  — turns on the aerial-perspective + horizon-haze pass for *this* view.
  Currently lookView-only (gated at `CNodeView3D.js:1079`).

Both keys keep their meaning under any new model; old sitches keep
working unchanged.

## 2. What hurts

- **No multi-scattering anywhere.** Twilight near the horizon is wrong,
  and zenith sky brightness at high sun zenith is biased low.
- **Wavelength-neutral extinction.** Distant terrain doesn't redden;
  sunset/sunrise tints live in a separate hand-tuned gradient instead of
  emerging from physics.
- **Two parallel sky/aerial paths.** They share `_aerialPerspectiveSkyColor`
  but compute through different code; they look consistent because they're
  both crude. A LUT model lets both fall out of the same evaluation.
- **`CNodeAtmosphericProfile` is unused at render time.** Sitrec already
  loads real soundings. We don't use them.
- **High-altitude sky darkening is hand-tuned**, exactly the problem a
  transmittance LUT solves cleanly.

## 3. What Sitrec actually asks of an atmosphere

1. **Ground-to-LEO observer altitudes.** A single sitch can switch the
   main view from a ship deck to a 400 km satellite vantage. Horizon must
   darken; ground must stay bright when viewed from above most of the air.
2. **Low-elevation sensor reconstruction.** Many UAP videos sit at 1°–5°
   depression, where path length is at its maximum and refraction starts
   to bend rays ~30+ arcmin.
3. **Main and Look views agree.** They must share the same physics so
   "what would the sensor see at this geometry" answers stay defensible
   when the user rotates the Main view.
4. **Real meteorology gets used.** Visibility slider and radiosonde
   profiles must drive the render, not just sit on disk.
5. **IR vs visible bands.** ATFLIR/MX-15 footage is largely 3–5 µm or
   8–12 µm; Rayleigh is negligible at those wavelengths and other terms
   dominate.
6. **Science-defensible, not photoreal.** Relative magnitudes within a
   stated tolerance; document where the model breaks (twilight,
   horizontal gradients, refraction).

## 4. Why Hillaire 2020 is the right base

| | Bruneton 2008 | Hillaire 2020 |
|---|---|---|
| Multi-scattering | iterative ordered scattering baked into a 4D LUT | analytic isotropic-MS approximation, evaluated per sample |
| Per-frame cost | one 4D LUT fetch | 2 per-view passes (sky-view + AP) + 2 shared per-atmosphere passes |
| Param changes | recompute the 4D LUT (slow) | recompute the two shared 2D LUTs (cheap) |
| Reference impl | `ebruneton/precomputed_atmospheric_scattering` | `sebh/UnrealEngineSkyAtmosphere`, `JolifantoBambla/webgpu-sky-atmosphere` |
| Shipped in | research demos, takram three-atmosphere | Unreal 4/5 SkyAtmosphere, Frostbite |

Hillaire wins on Sitrec axes because the camera and sun move freely, the
atmosphere parameters change (visibility / sounding swaps), and the
per-frame LUT cost is amortised across the cases that matter.

LUT defaults from the paper:

| LUT | Dimensions | Parameterisation | Cost |
|---|---|---|---|
| Transmittance | 256×64 2D | (height, view zenith) | One-time per atmosphere |
| Multi-scattering | 32×32 2D | (height, sun zenith) | One-time per atmosphere |
| Sky-view | 200×100 2D (16:9 ports often use 192×108) | (view longitude/latitude in camera frame) | Per frame |
| Aerial perspective | 32×32×32 froxel, 32 km depth | (screen xy, depth slice) | Per frame |

At RGBA16F: transmittance ≈128 KB, multi-scatter ≈8 KB, sky-view ≈160 KB
per view, AP ≈260 KB per view. Order of half a megabyte total per
atmosphere + per view, not 150 KB as a back-of-envelope draft of this
doc had.

## 5. Sitrec-specific extensions the paper doesn't cover

### 5.1 Altitude range

Hillaire's 32 km AP slice and ~100 km atmosphere top assume a game
camera near sea level. Sitrec needs the *transmittance LUT* parameter
extended so observers at 100–600 km altitude get clean lookups (the LUT
returns T≈1 above the Kármán line; we don't need to actually model
density there, just not extrapolate).

The *aerial-perspective froxel* needs either an adaptive depth range per
view or a non-uniform depth distribution: a near-vertical look-down from
400 km cares about the first ~80 km of atmosphere plus the surface layer,
not 32 km of dense ground air.

### 5.2 Sky-view LUT parameterisation for high observers

Hillaire's sky-view LUT uses a non-linear, horizon-warped V axis tuned
for a ground observer's horizon precision. Above ~10 km altitude that
warp wastes resolution. The satellite-vantage case wants a different
parameterisation — Earth + lit limb against black — and probably its own
small LUT rather than reusing the ground-observer one stretched.

### 5.3 ECEF integration

Hillaire's reference code is local-Y-up. Sitrec lives in ECEF (with a
trail of bugs from the EUS→ECEF migration showing what happens when this
is assumed wrong). Two strategies:

1. **Per-view local frame.** Build an ENU basis at the camera each
   frame, transform rays into it, sample LUTs, transform back. One
   matrix per view per frame, reference code unchanged.
2. **ECEF-native shader.** Pass planet centre, derive "up" per sample as
   `normalize(p - center)`, fold Earth radius into the LUT parameterisation.

Strategy 1 first — keeps us bit-comparable with the reference. Move to
strategy 2 only if precision at LEO altitudes forces it. This is not
optional polish; it ships with the initial Hillaire integration.

### 5.4 Multi-view LUT sharing

Sitrec usually runs Main + Look simultaneously; some sitches add
overlays. Shared transmittance + multi-scattering LUTs (atmosphere
parameters are global) — these are the rebuilds you want to amortise.
Sky-view LUT can be shared between views with the same
(observer_position, sun_direction). AP volume is per-view. This is
day-one work for the initial Hillaire ship, not a later optimisation.

(*Caveat:* sharing assumes a single atmosphere parameter set across
views. The day Sitrec adds per-view IR vs visible, or per-view
radiosonde swap, the shared-LUT story changes — but those are deferred,
see §6.)

### 5.5 Ozone

Hillaire models ozone as a triangular profile peaked at ~25 km. Omitting
ozone is the single biggest reason naïve Rayleigh-only skies look too
purple at the zenith. We're doing this because we want science-
defensible blue, so ozone is in the v1 atmosphere, not a v2 add-on.

### 5.6 Tone-mapping calibration

The reference path expects scene radiance in physical units paired with
a calibrated tonemap. Sitrec's existing `atmosphereHDR`/
`atmosphereExposure` was tuned to the analytic model and will need
re-tuning against Hillaire's LUT outputs — typically symptomatic as
washed-out or crushed sky on first integration. Budget time for this in
phase 3, not phase 4.

### 5.7 Refraction (deferred coupling)

Refraction lives in `atmospheric-refraction-plan.md` and is currently
geometry-only. Coupling is "fire the bent ray, sample the LUT along the
bent path" — almost free if the bender exposes sample positions
(which needs verifying — if it only exposes bent endpoints, that's
additional work). No mainstream production renderer ships
refraction-correct atmosphere; this is genuinely novel territory and
worth flagging in the science-caveats panel.

### 5.8 IR band (deferred)

Visible-band Rayleigh ∝ 1/λ⁴ → near zero at 3–10 µm. Replacing the LUTs
with IR-band ones isn't enough — at MWIR/LWIR the dominant *background*
term is atmospheric thermal *emission* (Planck-weighted at the radiosonde
T(h) profile), not transmission. A correct minimal IR model needs an
emission integrator on top of the LUT pipeline.

For v1: document the gap explicitly, leave IR views on the analytic path,
don't ship a half-right IR LUT. v2 wires emission to T(h) from the
existing `CNodeAtmosphericProfile`.

## 6. Architecture

Two backends only:

| Name | Class | What it is | When to use |
|---|---|---|---|
| `analytic` | current `CNodeView3D` aerial-perspective code | Koschmieder + scale-height integration | Default fallback. Low-end GPUs, deterministic regression tests, IR views (until §5.8 ships) |
| `hillaire` | own port (§7 roadmap) | Hillaire 2020 + Sitrec extensions (§5) | Production target for new sitches |

`Sit.atmosphereModel: "analytic" | "hillaire"`. String not boolean so a
third real backend (e.g. WebGPU port) can be added without a save
migration; unknown values fall back to `analytic`. No capabilities
interface, no per-view override in the UI (a `?atmosphere=` URL param
for dev/debug is fine).

The headline restraint: only two backends ship. Earlier drafts of this
doc proposed five (none, analytic, takram, hillaire, webgpu-hillaire);
that's design theatre with zero current callers. Takram is a 4D-LUT
Bruneton port — it would not validate the Hillaire froxel integration
that matters, and would burn the coordinate-frame work twice. WebGPU is
a 2027 problem at the earliest.

The lighting toggle (`lighting.atmosphere` aka Daylight Sky) stays
boolean and gates the sky-view contribution in either backend. The
per-view toggle (`view3d.atmosphere`) gates the aerial-perspective
composite. Both keys keep their existing serialisation; saved sitches
are unaffected.

## 7. Roadmap

### Phase 0 — refactor for pluggability (1.5–3 e-weeks)

Pull the current aerial-perspective code out of `CNodeView3D` into an
`AtmosphereModelAnalytic` class. Looks straightforward on the surface
because the methods are already named (`renderAerialPerspectiveDepth`,
the shader material, dispose) — but the *state* is entangled: HDR
tone-mapping pass ownership, ping-pong render targets, fog push/pop, the
distance pre-pass's full scene traversal with `overrideMaterial`. The
extraction has to preserve all of these bit-identical or regression
snapshots drift.

Add `Sit.atmosphereModel = "analytic"` as a no-op selector.

*Done when:* `Atmos vis test` and `startup hills fog` regression snapshots
are pixel-identical to pre-refactor.

### Phase 1 — Hillaire core port (6–10 e-weeks)

Port the four-LUT pipeline from the Unreal reference into Three.js
WebGL2. Hillaire defaults — sea-level observer, 32 km AP — no Sitrec
extensions yet. Validate LUT contents against the reference (a small
LUT-debug overlay is week-1 work and pays for itself many times over).

Ship together with §5.3 ECEF (per-view local frame) and §5.4 multi-view
LUT sharing — both are day-one requirements, not later polish, because
Sitrec runs multi-view by default and ECEF is the world coordinate
system. Also §5.5 ozone (correctness, not optimisation) and §5.6 tone-
mapping recalibration (will look wrong otherwise).

*Done when:* turning on `hillaire` in a sea-level sitch matches the
analytic model perceptually under standard visibility, and matches the
Unreal reference's LUT outputs within an agreed radiometric tolerance
(decide this number before phase 1 starts — see open question below).

*Rollback plan:* if Hillaire ships and is slower than acceptable on the
median user's GPU, the user (or the sitch) drops back to `analytic`.
The analytic path stays maintained.

### Phase 2 — high-altitude work (3–5 e-weeks)

§5.1 transmittance LUT extension to 600 km, §5.2 satellite-vantage
sky-view parameterisation, AP depth-distribution rework. This is the
phase that delivers the "ship-deck to LEO" promise.

*Done when:* a sitch can switch the Main view continuously from sea
level to 400 km with no visible discontinuity in sky color or terrain
haze.

### Phase 3 — refraction coupling (2–4 e-weeks)

§5.7. Confirm the refraction integrator exposes sample positions, not
just bent endpoints. Add the bent-ray sample path to Hillaire's LUT
evaluation.

*Done when:* a known-test low-elevation observation matches the bent-ray
geometric solution plus the LUT radiometry within tolerance.

### Phase 4 — radiosonde + IR (4–8 e-weeks; defer until phase 1–3 land)

§4 of the use-case list. §5.8 IR band including thermal emission. Wires
`CNodeAtmosphericProfile` into the transmittance / multi-scattering
rebuild path. This is the highest-risk, highest-payoff phase — Sitrec
gets to be different from every game engine here, because we have the
actual atmosphere for some sitches.

Defer until the vanilla Hillaire pipeline is proven; landing this on a
shaky base hides bugs.

### (Footnote) WebGPU

If Sitrec adopts WebGPU as a target, the existing
`JolifantoBambla/webgpu-sky-atmosphere` is a drop-in for the
`webgpu-hillaire` slot. Not in scope for this roadmap.

### Realistic total

Phases 0–3: **~12–22 e-weeks** to "Hillaire at all altitudes with
refraction".
Phase 4: another **4–8 e-weeks** for radiosondes + IR.

A draft of this doc implicitly suggested ~10 e-weeks total. That was
optimistic.

## 8. Open questions

These need answers before phase 1 starts, not after.

- **Radiometric tolerance for "matches the reference".** Decide the
  number now. "Within ±X% on a daytime sea-level test scene" makes
  phase 1 closable; without it, phase 1 is open-ended.
- **GPU-determinism in regression tests.** Per-frame LUT rebuilds are
  GPU floating-point; snapshots will drift across drivers. Either
  accept per-driver tolerance, or run Hillaire tests in a separate
  GPU-id-gated suite. The analytic path stays as the default regression
  baseline.
- **Benchmark target for the per-frame atmosphere pass.** "Acceptable
  for 2 views, uncomfortable above 4" is vibes. Pick a frame-budget
  number (e.g. ≤2 ms per view at 1080p on a baseline GPU) so we can
  tell when we've blown it.
- **LUT lifecycle ownership.** Where do the shared transmittance and
  multi-scattering LUTs live? `Sit.atmosphereState`? `NodeMan.get`-able
  singleton? The wrong answer here causes per-view duplication and
  defeats §5.4.
- **Calibration validation.** For UAP "could this target be visible at
  X depression angle and Y airmass" questions, we eventually want a
  reference comparison against libRadtran. Not a phase-1 blocker, but
  the answer to "how accurate is Sitrec actually" eventually requires
  this.
- **Material BRDF compatibility.** Sitrec uses lit
  (`MeshLambertMaterial`, `MeshStandardMaterial`) terrain and
  buildings. Hillaire models sky + additive aerial perspective, not the
  surface BRDF. The composite should multiply transmittance into the
  already-lit fragment. Confirm this works through Sitrec's existing
  composite — `takram` explicitly *doesn't* support this.
- **UI caveats copy.** When Hillaire is on, the Atmosphere panel should
  state plainly: physically-based but visual, ±~10% relative magnitudes
  under typical conditions, horizontally uniform assumption, simplified
  multi-scattering, refraction-aware only when phase 3 is on. These are
  real limits of the underlying technique, not bugs to hide.

## 9. References

- Hillaire, S. (2020). *A Scalable and Production Ready Sky and
  Atmosphere Rendering Technique.* EGSR 2020.
  <https://github.com/sebh/UnrealEngineSkyAtmosphere>
- Bruneton, E. & Neyret, F. (2008). *Precomputed Atmospheric
  Scattering.* EGSR 2008. 2017 rewrite:
  <https://github.com/ebruneton/precomputed_atmospheric_scattering>
- takram. *three-atmosphere* — Three.js Bruneton port.
  `npm @takram/three-atmosphere`
- JolifantoBambla. *webgpu-sky-atmosphere* — Hillaire 2020 WebGPU port.
  <https://github.com/JolifantoBambla/webgpu-sky-atmosphere>
- jeantimex. *precomputed_atmospheric_scattering* — Bruneton WebGL demo
  ported to Three.js.
- Schneegans et al. (2024). *Physically Based Real-Time Rendering of
  Atmospheres using Mie Theory* — relevant if non-standard aerosols
  (volcanic ash, smoke) become a sitch requirement.
- libRadtran — free, well-documented ground-truth for visible + IR sky
  radiance. <http://www.libradtran.org/>
- Sitrec internal:
  [`AtmosphericAerialPerspective.md`](./AtmosphericAerialPerspective.md),
  [`atmospheric-refraction-plan.md`](./atmospheric-refraction-plan.md).
