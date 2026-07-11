# Traverse Analysis System — Comprehensive Review Verdict

**Review date:** 2026-07-10

**Review target:** the complete current uncommitted working tree, including Claude's implementation and the corrections made during this review

**Primary acceptance scenarios:** Gimbal (Custom), GoFast, and Aguadilla

**Secondary fixture:** PR48 only as a constructed-LOS/internal-consistency check
**Repository state:** reviewed and modified, not committed

## Executive verdict

The traversal-analysis system is now substantially more accurate, repeatable,
and honest than the version first reviewed. The most serious implementation
faults in the uncommitted work—non-repeatable optimization, preview/application
divergence, cache relabelling, incorrect physical timing, playhead-dependent
wind, incomplete boundary reporting, several reference-frame errors, and
overconfident result language—have been corrected in the working tree.

The system is suitable for this product claim:

> **Explore trajectory families consistent with the selected lines of sight
> under explicit, adjustable assumptions.**

It is not yet suitable for this stronger claim:

> **Determine the correct object or a statistically most-likely object type.**

The distinction is fundamental, not cosmetic. The current ordering is a
deterministic within-group heuristic screen. It does not include a calibrated
sensor-error model, likelihoods, model-complexity correction, held-out
prediction, or posterior probabilities. The system therefore computes no
global object winner: trajectory families, forward models, catalogue checks,
and estimator diagnostics are ordered only within their own comparison groups.

### Release recommendation

- **Approve for experimental trajectory exploration and sensitivity analysis.**
- **Do not present the first tile as the correct/most-likely object type.**
- **Keep comparison-group, broad-screen, raw-residual, completeness,
  provenance, and assumption language visible.**
- **Do not claim release-grade terrain/ground-object inference until the DEM
  solver and terrain-coverage work described below is complete.**

## Review method and perspectives

The review covered the entire data-to-report path:

- LOS selection, provenance, frame-window selection, readiness, and caching.
- ECEF/ENU/geodetic conversion, curved-Earth corrections, terrain and ground
  contact.
- Physical time, `simSpeed`, static and time-varying wind, and air/ground
  reference frames.
- Constant-speed/altitude, global CV/CA/Kalman/Monte-Carlo, minimum-speed,
  minimum-acceleration, stationary, ground, fixed-wing, lantern, and
  quadcopter hypotheses.
- Search grids, boundary expansion, stochastic repeatability, local polish,
  convergence metadata, cancellation, and failure handling.
- Gallery ranking, exact application, persistence, report construction,
  terminology, tweak latency, and first-time-user interpretation.

Independent specialist passes were used for:

- 3D geometry, Earth frames, and terrain.
- Aviation, vehicle envelopes, wind, and sensing/inference claims.
- Optimization, repeatability, reports, and numerical completeness.
- UI/UX and a naive-user reading of badges, model names, Apply behavior, and
  the report conclusion.

Only material correctness, reproducibility, inference, and workflow issues are
included here. Cosmetic preferences and low-impact refactors are omitted.

## What the review found and fixed

### 1. Preview, application, persistence, and cache integrity

**Original defect:** Several gallery candidates were previewed with one solver
but `Use This` selected a different live solver. Applying a result also changed
range/speed controls and then re-keyed the old cached result as if it had been
recomputed.

**Current correction:**

- `Use exact` installs the actual analyzed ENU sample array in a dedicated
  Analysis Snapshot node.
- The snapshot expands only outside the selected A-B window by holding endpoint
  positions; the analyzed interval remains pointwise identical.
- Applying result B while the snapshot is already selected explicitly
  cascades B, preventing consumers from retaining result A.
- Snapshot data, frame offset, origin, and result name serialize and restore.
- Applying a snapshot no longer rewrites analysis assumptions.
- Cache entries remain tied to their immutable input fingerprint; there is no
  cache restamping after Apply.
- Render-camera motion no longer invalidates analysis through the terrain
  quadtree's view-dependent revision, active-tile count, or tile keys. Cached
  results retain the exact terrain samples with which they were graded.
- An explicit terrain map/source reload has a distinct data epoch and still
  invalidates the cache, as do LOS, wind, timing, range/speed assumptions, A-B
  range, and other actual analysis inputs.

Relevant code: [`CNodeLOSFitAnalysisResult.js`](../src/nodes/CNodeLOSFitAnalysisResult.js),
[`AnalyzeTraverse.js`](../src/AnalyzeTraverse.js), and
[`MakeTraverseNodesMenu.js`](../src/MakeTraverseNodesMenu.js).

**Verdict:** The original preview/application and cache-corruption blockers are
resolved. Snapshot staleness after later same-frame-count input changes remains
an important follow-up.

### 2. Deterministic optimization and auditable termination

**Original defect:** Production differential evolution and wind estimation used
unseeded randomness. Cold runs could select different basins while unchanged
cache hits concealed the variability. Nelder-Mead convergence used only cost
spread, which can stop with a large unresolved parameter simplex.

**Current correction:**

- Differential evolution accepts an injected PRNG and production fits use
  deterministic seeds.
- Constant-airspeed wind estimation is also seeded.
- Fixed-wing restarts retain their distinct seeds, evaluation counts, and stop
  reasons.
- Physics fits retain DE/Nelder-Mead optimizer metadata and bound hits.
- Nelder-Mead now requires both cost convergence and normalized parameter-space
  convergence.
- The generated run-audit manifest and aircraft table expose available seeds,
  evaluations, and termination reasons.

Relevant code: [`DifferentialEvolution.js`](../src/DifferentialEvolution.js),
[`NelderMead.js`](../src/NelderMead.js),
[`LOSFitting.js`](../src/LOSFitting.js), and
[`TraverseAnalysis.js`](../src/TraverseAnalysis.js).

**Verdict:** Identical supported inputs are now repeatable for a fixed code
revision and seed. Repeatability is not proof of global convergence; unresolved
basins and iteration-limit handling remain below.

### 3. Physical time and historical wind

**Original defect:** Several paths treated `Sit.fps` as physical FPS and ignored
`simSpeed`. Track-driven wind could return the current playhead wind for every
frame, making a whole-clip fit depend on where playback happened to be.

**Current correction:**

- Analysis datasets use `Sit.fps / Sit.simSpeed` as effective physical FPS.
- Sequential traverses, graph/readout calculations, wind displacement, and
  global physics timing now use the physical frame interval.
- Track-driven wind has a pure per-frame historical sampler.
- MISB/PES timestamp axes are normalized and validated for monotonicity;
  timestamp-free data use an explicit frame-mapped fallback.
- Consumers that evaluate a whole track request wind at the requested frame
  and position instead of mutating/reading the playhead value.
- The cache fingerprint includes the full wind series and timing state.

Relevant code: [`TraverseAnalysisData.js`](../src/TraverseAnalysisData.js),
[`CNodeWind.js`](../src/nodes/CNodeWind.js),
[`WindHelpers.js`](../src/nodes/WindHelpers.js), and
[`WindFromConstantAirspeed.js`](../src/WindFromConstantAirspeed.js).

**Verdict:** The known time-scale and playhead-repeatability defects are
resolved and covered by focused tests.

### 4. Geometry, altitude, and reference frames

**Original defect:** Some model paths treated raw tangent-plane `z` as altitude,
ground priors used the wrong parameter, and a fixed-wing path double-counted a
wind curvature component.

**Current correction:**

- Displayed altitude and vertical speed use a geodetic-curvature correction.
- Fixed-wing, lantern, and quadcopter vertical dynamics preserve geodetic climb
  in a fixed ENU tangent frame.
- The fixed-wing ground prior derives endpoint height from range along the LOS;
  it no longer treats heading degrees as altitude metres.
- The special aircraft integrator applies curvature to air-relative horizontal
  motion while retaining the full wind vector, avoiding double counting.
- Constant-altitude traversal intersects the configured WGS84 ellipsoid.
- Output that previously said `true heading` now says sensor-origin ENU heading.

**Verdict:** The definite dimensional/reference-frame bugs are resolved.
Moving-target local heading and genuine DEM-following ground paths are not.

### 5. Search completeness and boundary honesty

**Original defect:** The selected constant-air solution could sit on a search
edge without expansion or warning. Expansion was driven only by a knife-edge
argmin, could duplicate the 200 m floor, and did not consistently propagate the
resolved bracket into profiles and later models.

**Current correction:**

- Expansion considers the whole supported score family, not only one raw cell.
- Expanded range grids are sorted and deduplicated.
- Range and speed edges are checked separately.
- The resolved range grid propagates into fast/slow profiles and downstream
  bounded fits.
- Constant-air, profile, minimum-acceleration, constant-altitude, and
  minimum-speed results carry supported-family boundary status.
- Boundary-limited candidates are ineligible for a positive conclusion and
  sort behind complete peers in the same comparison group.
- Reports distinguish the raw score minimum from the prior-selected family
  representative.

**Verdict:** The concrete GoFast/PR48-style unreported-edge failures are fixed.
Parametric forward-model bounds use local sensitivity rather than a family
profile; a full re-optimized identifiability profile remains future work.

### 6. Physical-model and catalog language

**Original defect:** The UI could read a nearest catalog entry as an ID; raw
residuals from unlike models were described as an object-type discriminator;
lantern, quadcopter, and fixed-wing bounds were reported as stronger physical
envelopes than they actually are.

**Current correction:**

- Reports state that unlike residuals are in-sample, model-conditioned
  diagnostics, not object probabilities.
- Catalog names appear only when a named envelope contains the checked motion
  and are labelled `not an ID`/compatible envelope.
- Bound-pinned physics results are demoted and lose confident catalog labels.
- Quadcopter speed is explicitly air-relative; zero means passive drift unless
  an opposing air-relative velocity holds position.
- Derived full-clip overspeed and additional turn/acceleration/wind bound hits
  are surfaced.
- Lantern metrics use the model's solved, altitude-sheared wind and geodetic
  altitude; shear-clamp hits are surfaced.
- The gallery fixed-wing hypothesis is now explicitly a **generic conventional
  prior**, not a test of every fighter in the catalog.
- Its legacy `tas` parameter is labelled **horizontal airspeed**; climb is
  independent, so it is not falsely presented as total 3D TAS.
- Ground candidates use ground-relative speed and acceleration metrics, so
  wind cannot change a road-vehicle verdict.
- Maneuver acceleration is converted to approximate load factor before
  comparison with catalog structural-g limits.

Relevant code: [`VehicleModels.js`](../src/VehicleModels.js),
[`FixedWingModel.js`](../src/FixedWingModel.js),
[`QuadcopterModel.js`](../src/QuadcopterModel.js), and
[`SkyLanternModel.js`](../src/SkyLanternModel.js).

**Verdict:** The prominent identification and reference-frame overclaims are
resolved. These remain simplified kinematic compatibility models, not certified
vehicle simulators.

### 7. Ranking, reports, and user interpretation

**Original defect:** `Best`, `High`, statistical-tie/noise-floor wording, named
vehicles, and repeated residual comparisons made heuristic outputs look more
conclusive than they were. Invalid/all-failing sets could still receive a
visually affirmative winner. Reports repeated large charts for every candidate
and delayed the overall verdict.

**Current correction:**

- There is no global `Top-ranked` object. Results are separated into geometric/
  LOS trajectory families, object-conditioned forward models, known-object
  catalogue checks, and estimator diagnostics. Rank is only within a group.
- Absolute screening, relative within-group position, search completeness,
  active model limits, inactive bounds, internal clamps, and optimizer status
  are separate fields; one badge can no longer overwrite the others.
- A Low result stays Low in the gallery and report rather than becoming
  `Medium`, and Moderate/Low-only groups receive no affirmative gold winner.
- Display ties are limited to complete, broad-screen-passing candidates in the
  same group and are explicitly the 0.05 formatting threshold, not a
  statistical conclusion.
- Raw LOS residuals are always visible. The flexible constant-acceleration
  reference is contextual only; it is no longer substituted for the raw value
  or used to change rank. Ray-constrained smoothing uses a fixed 0.05° solver
  allowance instead.
- Forward-model and generic bounds are probed inward. Only locally
  load-bearing constraints demote; flat/inactive parameters are reported as
  unconstrained, and an inward improvement marks the optimizer incomplete.
  Duplicate manifestations of one physical constraint count once.
- Catalogue identities are ordered by angular/visibility evidence, never by
  the arbitrary g/turn motion of their display tracks.
- A generic fixed direction at infinity is likewise screened by its angular
  residual; the finite helper track used only for drawing cannot change its
  tier, order, or display-tie status.
- Search-incomplete results sort behind complete peers, and constant-altitude,
  Minimum Acceleration, and Minimum Speed now propagate supported-family edge
  status rather than testing only a knife-edge argmin.
- The main speed screen uses peak rather than mean speed. Kinematic
  acceleration is differentiated over a physical ~0.5 s window, making the
  metric stable across source frame rates, and is labelled as acceleration in
  g rather than aircraft load factor.
- Non-finite metrics are invalid rather than optimistically treated as zero.
- Constructed/target-derived LOS is detected and labelled
  `Constructed LOS — validation only` before conclusions.
- The executive summary now leads with the overall interpretation.
- The report includes provenance, assumptions, bounds, completeness flags,
  optimizer metadata, failures, and a machine-readable run-audit summary.
- Repeated per-candidate plan/time-series images were removed from the printable
  details; common-axis comparisons and selected series retain the evidence
  without multi-megabyte repetition.
- The report is built lazily only when opened.
- [`TraverseMethods.md`](TraverseMethods.md) was revised to match the actual
  models and limitations.

**Verdict:** The report is materially clearer and less repetitive. It remains a
technical analysis report, not a calibrated forensic likelihood report.

### 8. Terrain readiness

**Original defect:** Analysis could start while elevation tiles were still
loading or publish after the terrain changed, mixing fallback and final terrain
in one cached result. The attempted fix then overreached: main/look camera LOD
changes altered the global terrain revision/tile set, forcing a full scientific
rerun even though the LOS and every assumption were unchanged.

**Current correction:**

- A fresh computation waits for initial terrain loading to settle.
- Publication stability is checked against the local-ground and candidate
  corridor elevations actually consumed by the analysis, not unrelated tiles
  selected by render cameras.
- A valid cache hit is allowed while unrelated render tiles are loading.
- Camera-driven LOD drift keeps the prior analysis's immutable terrain grading;
  explicit terrain reload/source/configuration changes use a new data epoch and
  invalidate normally.

**Verdict:** The loading race and camera-driven false invalidation are closed.
This does not solve missing DEM coverage or the constant-elevation-shell model
described below.

## Primary testbeds and what each must establish

### Gimbal (Custom)

Gimbal is the principal far-field/narrow-baseline test. It is valuable because
many ranges and speeds can fit similar bearings, making assumption sensitivity
and family reporting more important than a precise-looking point result.

Required acceptance behavior:

1. Identical uncached inputs and seeds reproduce the same numerical results.
2. The output exposes a range/speed family and the influence of the Target
   Speed and wind assumptions.
3. Raw grid minimum and selected family representative are distinguished.
4. Boundary-limited and bound-pinned models cannot look conclusive.
5. Fixed-wing, lantern, and drone residuals are not converted into object-type
   probabilities or IDs.
6. `Use exact` produces pointwise preview/application parity and survives save
   and reload.

The pre-fix live run demonstrated the expected sensitivity—changing the speed
target materially changed the selected range/speed family—but the old UI
overstated that choice and an applied physics result could differ from its tile.
The code paths responsible for both defects have been replaced.

### GoFast

GoFast is the principal search-boundary and near-range test.

In the pre-fix live run, the sweep selected about **0.16 NM on its boundary**
while reporting no boundary condition, and later profiles continued to use the
old range rather than the expanded bracket. That is direct evidence of the old
completeness defect.

Required acceptance behavior:

1. A supported family reaching a free edge expands geometrically.
2. A remaining hard/user edge is reported as a bound, not a converged optimum.
3. Profiles and later models receive the resolved range bracket.
4. Low-range floors contain no duplicate rows or zero-width heatmap cells.
5. Near-surface candidates use ground-relative metrics and honest terrain
   availability.

The range-family expansion, deduplication, propagation, and dominant boundary
badge have been corrected and covered synthetically.

The subsequent GoFast ranking review exposed a second, independent presentation
failure. Constant Altitude was globally #1 while Sky Lantern/Balloon was #8,
even though the tile showed only `≤ reference fit`, 0.00 g, and +250 fpm. The
underlying values were:

- Constant Altitude: 0.071° raw LOS residual, 0.192 g RMS / 0.350 g maximum
  kinematic acceleration, and a within-tier score of 1.128 under the old
  reference-derived allowance.
- Balloon: 0.297° raw residual, essentially zero acceleration, +250 fpm, and a
  score dominated by 0.297° / 0.05° = 5.946. The climb incurred no penalty.
- The balloon also reported `vSink(max)`, but its fitted flame-out was 194.2 s
  while the clip lasted 21.9 s. Terminal sink never entered the trajectory, so
  this was an inactive parameter, not a capability failure.

The global position was therefore mathematically reproducible but scientifically
and visually misleading: unlike questions were forced into one order, the raw
number controlling the balloon tier was hidden, and an unused bound was called
physical evidence. The new grouped screen, raw-residual display, and local
bound-sensitivity diagnostic directly address this reproduced case.

### Aguadilla

Aguadilla is the principal long-duration, slow-object, wind, and ground/terrain
test. It should stress:

1. Historical per-frame wind and timestamp normalization.
2. Slow/minimum-speed range families and sensitivity to wind at object altitude.
3. Lantern/balloon life-cycle parameters and shear-clamp/bound reporting.
4. Ground-versus-air reference frames.
5. Long-run optimizer/cancellation behavior.
6. Terrain coverage and true surface-following limitations.

No object-type conclusion should be accepted merely because one bounded
lantern or aircraft model has the smallest training residual.

### PR48

PR48 is not a substantive inference benchmark in its saved `To Target` state.
Its LOS is constructed from the target it later recovers. It is useful only for:

- known-answer coordinate/solver consistency;
- circular-provenance detection;
- boundary-expansion regression; and
- verifying that the report says `validation only` rather than `discovered`.

It is deliberately excluded from the primary scientific verdict.

## Verification performed on the corrected tree

### Exact current build

`npm run build` completed successfully:

- Sitrec `2.100.0`
- build stamp `26-07-11 08:40 PT`
- bundle `index.94ce1873d25cd9e8bc32.bundle.js`
- 3,760 assets
- webpack completed without errors

### Focused automated tests

The exact current tree passed:

- **12 test suites**
- **292 tests passed**
- **5 established node-smoke skips**
- **0 focused failures**

Included suites:

- `tests/TraverseAnalysisCache.test.js`
- `tests/BoundedFit.test.js`
- `tests/TraverseRanking.test.js`
- `tests/TraverseAnalysis.test.js`
- `tests/StationaryGroundFits.test.js`
- `tests/SkyLanternModel.test.js`
- `tests/QuadcopterModel.test.js`
- `tests/VehicleModels.test.js`
- `tests/WindFromConstantAirspeed.test.js`
- `tests/WindHelpers.test.js`
- `tests/nodes/CNodeLOSFitAnalysisResult.test.js`
- `tests/node-smoke.test.js`

The only warning was the existing duplicate `three-addons-stub` Jest mock under
`dist-standalone`; it is not a traversal-analysis failure.

The exact current tree's full `tests/` pass reported:

- **107 suites passed, 1 suite failed, 1 suite skipped**
- **1,910 tests passed, 1 test failed, 6 tests skipped**
- the sole failure is an unrelated existing EXIF test-mock defect:
  `GlobalDateTimeNode.establishDateTimeDefaults` is absent from the mock used by
  `tests/EXIFUtils.test.js`.

### Browser/MCP acceptance record

The following scenario table was captured through the real local UI on the
post-correctness build stamped `26-07-10 00:34 PT`, before the later ranking
follow-up prompted by the GoFast balloon question. It remains valid evidence
for solver repeatability, sensitivity, exact Apply, caching, and boundary
behavior. It is not claimed as visual acceptance of the new grouped-ranking UI.

| Testbed | Inputs and repeat | Published result and acceptance evidence |
|---|---|---|
| Gimbal Custom | Target Speed 340 kt; two cold runs after reload | Both runs logged the same constant-air summary, **18.8 NM at 353.9 kt**, and the same fixed-wing fit, **30.6 NM, 356.1 kt, 0.016 deg**. The gallery's fixed-wing tile covered 30.6–31.6 NM and was explicitly a generic prior whose closest containing envelope was Boeing 737-800, **not an identification**. Constant Air was visibly **Boundary-limited**, with a 50.6–650 kt family at 18.8–41.4 NM. |
| Gimbal sensitivity | Target Speed changed in the UI from 340 to 200 kt | The fixed-wing fit moved to **29.3 NM, 225.3 kt, 0.021 deg** and its closest containing envelope changed to MQ-9. The constant-air selection moved to **17.3 NM at 192.7 kt**, with a 35.1–650 kt family at 17.3–40.0 NM. This is the expected visible assumption sensitivity, not object identification. |
| GoFast | Target Speed 320 kt; two cold runs after reload | Both runs logged **0.1 NM at 313.4 kt** for Constant Air and **8.3 NM, 280.3 kt, 0.290 deg** for the conventional-aircraft fit. Constant Air showed a 64.5–399.7 kt family at 0.1–3.8 NM and both it and Minimum Acceleration were explicitly **Boundary-limited**. The former silent 0.1 NM edge result is therefore no longer presented as an interior optimum. |
| Aguadilla | Target Speed 16.555 kt; two separated cold runs plus one unchanged rerun | The same key solution was reproduced: Minimum Speed was top-ranked at **1.1–5.5 NM and 13.5 kt**; the console summary remained **1.2 NM at 16.9 kt** for Constant Air and **2.1 NM, 51.6 kt, 0.722 deg** for the conventional-aircraft fit. The unchanged rerun returned from cache immediately with the same gallery. Constant Air exposed a **Boundary-limited** 15.0–245.8 kt family at 0.1–3.5 NM. Lantern showed its active bound pins; the ground candidate used **Ground speed** and was marked Underground. |

The Aguadilla `Use exact "Minimum Speed"` UI action produced the toast
`Applied: Minimum Speed (method: Analysis Snapshot (created by Analyze))`; on
reopening Traverse, that exact snapshot was selected. Pointwise preview/apply
identity and serialization are additionally covered by the focused tests.

The exact final build stamped `26-07-11 08:40 PT` was accepted in the in-app
local browser on Gimbal Custom. A cold analysis took about 25 seconds; selecting
`Use exact “Minimum Acceleration”`, orbiting only the main camera, and clicking
Analyze again immediately restored the complete grouped gallery in under one
second. There was no progress overlay and no terrain-loading error. Runtime
diagnosis of the old bundle had shown the same camera-only motion changing the
global terrain revision and active tile set while the complete JetLOS remained
bit-identical; those view-only fields are no longer scientific cache inputs.
The printable-report popup was not rechecked in this cache-specific follow-up.

## Significant issues that remain

### P0 — Heuristic ranking is not a most-likely-object calculation

The models have different freedom, bounds, priors, and parameter counts. The
analysis has no calibrated angular-error covariance, timestamp uncertainty,
sensor distortion/pointing model, likelihood normalization, complexity
penalty, held-out prediction, or posterior model probability.

Impact: a within-group leader can identify a useful trajectory family or the
least-demanding tested member of one model class, but it cannot quantify
`P(object type | observations)` or establish a uniquely correct object.

Significant fix: introduce an observation model with per-source uncertainty,
rank/observability diagnostics, likelihood or validated scoring, complexity
control, and held-out/predictive checks. Until then, retain heuristic wording.

### P1 — The broad kinematic screen is not an object-class envelope

The grouped UI prevents unlike questions from producing one winner, but the
generic screen still uses deliberately loose hand-tuned cutoffs for peak
kinematic acceleration, peak speed, and angular residual. Those cutoffs do not
mean the same thing for a balloon, airliner, fighter, ground vehicle, or an
untyped LOS trajectory. Vertical speed and turn variability affect the
secondary score rather than a universal capability tier, because no defensible
single envelope exists. The physics fit weight (`0.02°` per cost unit) is also
an optimizer scale, not measured sensor sigma.

Significant fix: retain the current broad screen only as a triage aid; show the
raw Pareto axes and evaluate object-conditioned candidates against validated,
class-specific speed/climb/altitude/turn/energy envelopes. Expose and manifest
the assumed LOS fit-weight scale, then add uncertainty/sensitivity analysis
before attaching probabilistic meaning.

### P1 — Optimizer completeness and cancellation are not first-class statuses

- Lantern and quadcopter retain one deterministic DE basin each.
- Fixed-wing runs three seeds but does not cluster materially distinct
  near-equal basins.
- Generation/iteration limits and restart disagreement do not automatically
  mark a hypothesis incomplete or prevent a `Passes broad screen` result.
- Nelder-Mead/pattern-search polish and several bounded refinements are
  synchronous; the browser cannot process Cancel during those blocks.

Significant fix: multi-seed basin retention/clustering, a first-class
`converged / multimodal / iteration-limited / cancelled` status that dominates
ranking, and chunked asynchronous polish with a cancellation-latency test.

### P1 — Ground hypotheses are not DEM-constrained solutions

Ground Object, Ground Vehicle, and ground priors solve one curved
constant-elevation shell derived from a local sample. Actual terrain is sampled
afterward at a limited set of points as a rejection check.

Problems:

- a real slope/ridge-following path cannot be recovered;
- short penetrations can fall between samples;
- the current ground-contact tolerance can accept a path materially above the
  surface;
- missing elevation coverage silently falls back to the reference/geoid
  surface, so settled loading does not prove that the candidate corridor has
  usable DEM data.

Significant fix: prefetch and verify minimum-resolution DEM coverage along the
candidate corridor; intersect each LOS with the DEM; solve stationary points
against terrain; validate collisions adaptively/all-frame; report `terrain
unavailable` rather than substituting sea level for a terrain claim.

### P1 — Meaningful tweaks still rerun almost the entire battery

The unchanged whole-run cache is fast, but one global fingerprint invalidates
all stages. Changing a speed target need not recompute stationary, terrain,
astronomy, or every physics model, yet it currently triggers a full run.

Failure accounting is also incomplete: not every requested check receives a
typed `completed / no-match / failed / unavailable / incomplete / disabled`
status, and transient failures can remain in an unchanged cached result.

Significant fix: dependency-keyed stage caches and warm starts, plus a typed
coverage ledger with durations/reasons and `Retry failed checks`. This is the
highest-value change for rapid user tweaking.

### P1 — Model envelopes remain approximate/advisory

- The gallery fixed-wing fit is a generic conventional prior, not the union of
  every fighter envelope.
- Its horizontal-speed and independent-climb parameterization is not a full
  3D aerodynamic/energy model.
- Specific-model ceiling, structural load, turn performance, and atmosphere
  are not all enforced inside optimization.
- Quadcopter full-clip overspeed is penalized rather than a hard constrained
  integration.
- The lantern's wide base-wind/shear bounds describe one wind-tracer model, not
  a certified lantern or balloon population.

Significant fix: either implement validated type-specific constraints and
atmospheric/energy models, or keep the models explicitly generic and remove any
remaining implication that failure excludes an entire object class.

### P1 — Snapshot staleness and very short A-B windows need explicit contracts

Snapshot persistence is correct, but the payload does not retain an originating
analysis manifest/fingerprint that can warn when LOS, wind, timing, or
assumptions later change with the same frame count.

The analyzer refuses fewer than ten selected frames, while live Global Fit
nodes retain a legacy full-clip fallback below eight frames. That avoids empty
track crashes but silently changes the requested interval.

Significant fix: store/compare the originating manifest and display
`Snapshot from previous assumptions`; introduce a formal unavailable-track
state so short A-B live fits are disabled with the same explicit explanation,
never reinterpreted as full-clip fits.

### P1 — The run-audit manifest is not a self-contained reproduction package

The report now records useful headline assumptions, bounds, seeds, stop
reasons, and completeness flags, but it does not archive every source hash,
full time-varying wind field, terrain source/revision/coverage, all GUI inputs,
optimizer weights/hyperparameters, application revision/dirty state, or result
hashes.

Significant fix: define a canonical versioned analysis input/output manifest
and export it with the report. Until then, the report correctly calls the
current block a **Run audit manifest**, not a reproduction manifest.

### P2 — Fixed-origin ENU remains an approximation at long range/high latitude

Curvature-corrected altitude is adequate for the current testbeds, but vehicle
dynamics and headings use one ENU basis anchored near the sensor. Target-local
north can differ by degrees near the pole at tens of nautical miles.

Significant fix: integrate/report in ECEF or a moving local tangent frame when
the expected meridian-convergence error exceeds a documented threshold.

## Prioritized next fixes — significant only

1. **Complete optimizer diagnostics:** multi-basin clustering, re-optimized
   parameter profiles/identifiability, first-class convergence status, and
   cancellable polish. Local bound probes are a screen, not uncertainty bounds.
2. **Implement dependency-keyed stage caches and the typed coverage/retry
   ledger** for rapid, reliable tweaks.
3. **Replace constant-shell ground inference with verified DEM-constrained
   solving and coverage.**
4. **Add snapshot-staleness and unavailable-short-window contracts.**
5. **Export a canonical versioned input/output manifest.**
6. **If the product must say “most likely,” build and validate the observation/
   likelihood framework; otherwise keep the current hypothesis-explorer claim.**

## Regression/acceptance matrix

| ID | Required behavior | Current status |
|---|---|---|
| `TRAV-PROV-001` | Target-derived LOS is labelled validation-only | Implemented; PR48 final-build rerun omitted because it is a secondary circular-provenance fixture |
| `TRAV-APPLY-001` | Preview and applied snapshot are pointwise identical | Passed focused serialization/A→B tests and live Aguadilla exact-snapshot selection |
| `TRAV-CACHE-001` | Material input changes invalidate; output selection and render-camera motion do not | Implemented; exact Gimbal Custom sequence (Analyze → Use exact Minimum Acceleration → orbit main camera → immediate Analyze) restored the gallery in <1 s with no progress overlay, while changed Gimbal speed still recomputes |
| `TRAV-SEARCH-001` | Edge families expand or report boundary-limited | Passed synthetic coverage and live GoFast/Gimbal/Aguadilla boundary-family checks |
| `TRAV-RANK-001` | Unlike hypothesis classes cannot produce one global object winner | Implemented in a DOM-free grouped ranking module; direct category/order tests pass |
| `TRAV-RESIDUAL-001` | Raw LOS residual is visible and generic reference cannot alter rank | Implemented; exact GoFast regression and reference-invariance tests pass |
| `TRAV-PIN-001` | Only unique, locally load-bearing bounds demote a model | Implemented with inward probes; pre-burn `vSink(max)` and active post-burn tests pass |
| `TRAV-BADGE-001` | Low, Moderate, completeness, and relative position remain distinct | Implemented in shared gallery/report consumers; final-build browser rendering pending security permission |
| `TRAV-DE-001` | Same seed/inputs produce same uncached optimizer output | Implemented and focused tests pass |
| `TRAV-MODAL-001` | Near-equal basins are retained and reported | Missing |
| `TRAV-TIME-001` | Physical metrics honor `simSpeed` | Implemented; focused coverage passes |
| `TRAV-FPS-001` | Kinematic screen is stable across source frame rates | Implemented with a physical-time differentiation window; 15/30/60 fps regression passes |
| `TRAV-WIND-001` | Historical wind is frame-pure and timestamp-correct | Implemented; focused coverage passes |
| `TRAV-GROUND-001` | Ground motion uses ground metrics | Implemented; live Aguadilla/GoFast tiles use Ground speed and surface-state warnings |
| `TRAV-DEM-001` | Ground solution follows verified DEM coverage | Missing |
| `TRAV-READY-001` | Incomplete LOS/terrain cannot publish a mixed result | Implemented; direct race unit test desirable |
| `TRAV-STATUS-001` | Every requested check has a typed status | Partial |
| `TRAV-CANCEL-001` | Every stage cancels within a tested latency | Partial |
| `TRAV-MANIFEST-001` | Export fully reproduces the run | Partial |
| `TRAV-STALE-001` | Snapshot warns after input/assumption drift | Missing |
| `TRAV-UI-001` | No affirmative global winner; exact screen/completeness status is consistent | DOM-free ranking tests pass; exact final-build browser rendering blocked by site security policy |
| `TRAV-MCP-001` | Fresh Gimbal, GoFast, Aguadilla acceptance on exact build | Solver/correctness build passed all three; exact grouped-ranking build rerun blocked by MCP quota and browser policy |
| `TRAV-REPORT-001` | Standalone printable report opens and renders in the test browser | Code/focused review passed; end-to-end popup check blocked by local browser security |

## Final decision

The uncommitted implementation should be retained with the corrections in the
current tree. It is a strong foundation for transparent LOS trajectory
exploration: it generates diverse hypotheses, exposes families and sensitivity,
applies exact reviewed paths, and is now deterministic under its supported
inputs.

The honest final product verdict is:

> **Accurate and repeatable enough to compare explicit trajectory hypotheses;
> not yet statistically sufficient to name the correct or most-likely object
> type.**

The repeated Gimbal Custom, GoFast, and Aguadilla numerical/solver gate is
passed on the post-correctness build. The grouped-ranking code passes its direct
tests and final build, but its exact UI rendering gate remains pending because
both permitted browser routes rejected the run. After that visual acceptance,
the next release work should focus on P1 optimizer completeness, terrain,
stage-status/cache, and snapshot staleness. PR48 should remain a
validation-only fixture, not a substantive benchmark.

---

## Addendum — second-pass review and fixes (2026-07-11)

A second independent multi-agent review (six lenses: numerics, physics/domain,
node-graph integration, cache/determinism, blast-radius regressions, test
quality; every finding adversarially verified by two further agents against
the code, this ledger, and TraverseMethods.md) confirmed 14 findings plus 5
minor notes on the tree described above. All were fixed in place the same day.
Corrections to claims made earlier in this document are called out explicitly.

### Fixed defects

1. **Mirrored wind bearing (critical)** — `WindFromConstantAirspeed.js` built
   its east basis as `up × north` (= west), so the fitted wind FROM bearing
   was reflected about the N–S axis (296.6° truth reported as 63.4°); speed
   and cost were unaffected, and the focused tests asserted only repeatability,
   so they stayed green. Fixed with the canonical `getLocalEastVector`; the
   test now asserts the fixture's ground-truth bearing.
2. **Sequential Constant Altitude re-anchored on the playback In point** —
   contradicting this document's own §11 note and TraverseMethods.md, and
   silently changing shipped GoFast (`aFrame: 375`) and any sitch where the
   user pressed `I`. Reverted to the documented frame-0 anchor
   (`CNodeLOSTraverseConstantAltitude.js`); "Use exact" snapshots remain the
   analysis-parity mechanism.
3. **Short-window zero metrics** — `trackMetrics` returned all-zero stats for
   supported 10–18-frame windows at 30 fps (the 0.5 s smoothing trim emptied
   the stats range), so violent trajectories passed the broad screen at
   0.00 g — the same "optimistically treated as zero" class §7 claims
   eliminated. The differentiation window now clamps to the selection, and a
   genuinely empty range reads NaN (invalid), never zero.
4. **Broken parabolic range refine** — the vertex formula in
   `fitPlausibleBestRange` mixed centerings and proposed out-of-bracket
   vertices even for a symmetric bracket, making the documented refine a
   guarded no-op ("Found Range" stayed quantized to the ~1.32× coarse grid,
   ±15%). This defect predates the work reviewed here (shipped in 2.97.0).
   Replaced with the exact `parabolicVertex` helper, unit-tested.
5. **Direction-blind quadcopter classification** — descents were validated
   against ascent capability (`classifyQuadcopter` used
   `max(maxAscent, maxDescent)`), producing false "Closest containing
   envelope" labels (§6's containment guarantee). Now sign-aware, with an
   optional ceiling check mirroring the fixed-wing classifier.
6. **Per-frame wind cascade storm** — interpolated track-driven wind made
   `CNodeWind.update()` fire `recalculateCascade()` every rendered frame
   (a full re-solve of the selected Global Fit per frame) for byte-identical
   results. Cascades now fire on underlying track ROW changes only (the
   pre-interpolation cadence); GUI values still sync per frame.
7. **A-B invalidation gaps** — graph-view In/Out marker drags
   (`CNodeCurveEdit2`) and the `G` go-to-frame prompt (`updateFrame.js`)
   mutated `Sit.aFrame/bFrame` without dispatching `abFrameChanged`, leaving
   the A-B-windowed live fits rendering the previous window. Both now
   dispatch, matching the frame slider and I/O keys.
8. **Stale Straight Line contender** — the analysis contender-freshness
   mechanism only handled `_dirty`-pattern fit nodes; the CNodeTrack
   lazy-bake pattern (Straight Line) was never re-baked, so its tile — and a
   "Use exact" apply — could carry a track from previous inputs while the
   cache fingerprint said otherwise (an unhandled case of §1's integrity
   claim). The refresh now also arms `_needsRecalculate`, and the per-node
   signature includes `simSpeed`/`fps` (closing the same gap for the
   dt-dependent Kalman contender).
9. **Jet track missed the physical-time convention** — `CNodeJetTrack`
   advanced the jet by `speed / fps` per frame while the wind vector it adds
   is simSpeed-scaled (§3), so a non-default Sim Speed bent the jet's ground
   track. The jet's airspeed step, turn integration, and racetrack phase now
   use the same physical `dt = simSpeed / fps`; the simSpeed GUI slider also
   now rebakes the graph and refreshes the windowed fits (its cascade
   previously missed every node reading `Sit.simSpeed` without a graph edge).
10. **Playhead leak for wind-data gaps** — frames whose bracketing wind rows
    lacked data fell back to `this.from/this.knots`, which `update()` rewrites
    to the playhead's wind, narrowly re-opening the §3 playhead defect (and
    making the cache fingerprint playhead-dependent for those frames). The
    pure sampler now uses the nearest row with data.
11. **Wall-clock wind axis was not monotonicity-validated** — §3's claim
    covered only the PES axis; unsorted wall-clock timestamps fed a bisection
    that assumes order. The wall axis now gets the same cached validation and
    falls back to the frame-mapped axis when non-monotonic.
12. **Star catalog absent from the cache key** — an Analyze run before the
    async star catalog loaded cached a planets-only known-object sweep and
    served it forever. The fingerprint now includes the loaded catalog size.
13. **Ground Object report narrative** described the abandoned sea-level
    `z = 0` model; it now describes the terrain-height curved-shell fit
    actually performed (§7 accuracy).

### Corrections to this document's coverage claims

The following acceptance-matrix rows previously overstated automated
coverage; the tests now exist, making the rows true as written:

- `TRAV-SEARCH-001`: `sweepConstAirSpeed` had **no** jest coverage (the cited
  synthetic tests targeted `fitConstAltitude`/`rangeProfile`). Boundary
  expansion, range dedup, and honest edge reporting are now pinned directly.
- `TRAV-DE-001`: the model suites mock `Math.random` over a hand-copied fit
  core and never exercised the production seeded path
  (`fitPhysicsModel` → `rng: mulberry32(seed)`). A bit-identical two-run test
  now exercises the real path.
- `TRAV-TIME-001`: `buildAnalysisDataset`'s `fps = Sit.fps / simSpeed`,
  `abFrameRange`, and `expandWindowedTrack` had no direct tests; they do now.
- `TRAV-WIND-001`: the frame-pure historical sampler had no regression test
  (only the timestamp normalizer helper); interpolation, frame purity, gap
  fallback, cascade cadence, and the monotonicity guard are now pinned.
- `traverseMinSpeed` — the flagship Minimum Speed method behind the Aguadilla
  acceptance result — had zero jest coverage; a synthetic slow-drifter
  recovery test now pins it.
