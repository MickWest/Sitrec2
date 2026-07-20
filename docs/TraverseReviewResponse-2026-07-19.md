# Response to the Traverse Analysis Review (July 19, 2026)

**Review reviewed:** the external (Codex) review of traverse-analysis work since
2026-07-09, covering documentation, implementation, tests, live UX, result
accuracy/disclosure, solution surfacing, caching, and performance. It raised
findings TA-01…TA-29 and DOC-01…DOC-19, prioritised P0…P3.

**Status of this document:** a per-finding ledger of what was done in response.
Each finding is **Fixed**, **Partial**, **Deferred**, or **Now accurate**, with
the commit that resolved it where one exists. A **current working-tree follow-up**
is implemented and tested locally but is not yet committed or released. Verify
against the code before relying on any specific claim; line numbers drift.

The review's central, correct catch was a **P0 that the original testing masked**:
the Kalman-seed path was verified by calling the solver with `{}` (defaults),
which happen to equal the *converted* GUI values — so it never exercised the
production GUI path, where the raw log₁₀ exponents produced an all-NaN seed. The
lesson (verify through the production GUI path, not just the solver) is recorded
in the memory notes.

## Result integrity and accuracy

| ID | Pri | Status | Resolution |
|---|---|---|---|
| TA-01 | P0 | **Fixed** (`79d37523`) | Kalman-seed GUI values are log₁₀ exponents; convert with `Math.pow(10, v0)` like the live node, clamp non-positive/non-finite covariances inside `fitKalmanFilter`, guard the seed track. Verified live: raw −4 → 0% finite; converted 1e-4 → 100% finite at 0.108°. |
| TA-02 | P0 | **Fixed in current working tree** (`79d37523` + uncommitted follow-up) | `fitPhysicsModel` fails closed on non-finite objective cost, errDeg, parameter, active residual, or coordinate. The standalone fixed-wing fitter likewise rejects non-finite final cost, parameters, trajectory, or residual, which is surfaced as a failed/unavailable check rather than a tile. Optimizers normalize non-finite objectives to `Infinity`. Tests cover an all-NaN seed, a finite track whose model prior returns NaN, and an all-invalid fixed-wing search. |
| TA-03 | P1 | **Fixed** (`0e2f6a3a`) | The KS seed's constant-velocity start can collapse onto the sensor path without a range floor; both the gallery and live seeds now pass `minRange` 500, and the "cannot collapse" comment is corrected to the conditional truth. |
| TA-04 | P1 | **Fixed in current working tree** (`0e2f6a3a` + uncommitted follow-up) | Time-varying balloon wind is reconstructed through one shared helper (base + drift·s + curve·s², then altitude shear) for both air-relative metrics and disclosure. The tile/report prose states start/midpoint/end wind, and the profile table shows all three across altitude. Unit tests pin the quadratic and shear clamp. |
| TA-05 | P1 | **Fixed** (`0e2f6a3a`) | The live Sky Lantern node now sets `clipDuration` (enabling time-varying wind) and seeds from the Kalman smoother like the gallery, filling only parameters the user has not overridden. |
| TA-06 | P1 | **Deferred** | Drone Control derives ground-relative speed/heading and bounds *ground* speed (0–30 m/s), while `trackMetrics` interprets *air*-relative motion (subtracting sitch wind), so wind can make the true airspeed exceed the claimed envelope. Fixing it means either integrating wind advection into `DroneControlModel` (air-relative controls) or independently enforcing/displaying an air-relative envelope — a change to the model's control frame, not a disclosure tweak. Left for a dedicated change with headwind/tailwind/hover-in-wind tests. |
| TA-07 | P1 | **Fixed in current working tree** (`0e2f6a3a` + uncommitted follow-up) | A material authoritative terrain-dependency mismatch invalidates the cached grading. Adjacent LODs reconstructing the same surface within 0.1 m are treated as equivalent, preventing millimetre/centimetre interpolation jitter from forcing another full fit; a regression test uses the exact observed rerun deltas. |
| TA-08 | P1 | **Fixed** (`0d7a9a4f`) | `fitAircraft` now itemises its soft priors (turn, climb, cruise-speed, ground) in the `{total, terms}` schema so the fixed-wing tile discloses them; test added through `fitAircraft`. |
| TA-09 | P2 | **Fixed in current working tree** (`d577cfd5` + uncommitted follow-up) | The drone discloses Nelder-Mead iterations, stop reason, and normalized simplex spread. Reaching the iteration budget is now an optimizer-incomplete warning: the provisional path remains visible but is ineligible, and completed fits sort before it even in truth mode. Seed clamping remains an independent incomplete warning. |
| TA-10 | P2 | **Fixed** (`3a0afaae`) | Drone speed/climb effort is now total-variation-squared (knot- and duration-invariant) instead of sum-of-squared per-knot differences that fell ~(K−1)² with knot count; weights recalibrated; K=4/8/12 invariance tests added. |
| TA-11 | P2 | **Deferred** | The Kalman process covariance uses `dt²` for position/velocity/cross terms, so regularisation changes with FPS/sampling; the July-19 seeding made this load-bearing. A standard discretized constant-acceleration covariance is the right fix, but it changes the smoother output that now seeds the physical fits — deferred to a change accompanied by 15/30/60-fps equivalence tests so the seed can be re-validated. |
| TA-12 | P2 | **Deferred** | The aircraft optimizer cost uses midpoint/exact heading while the displayed track and reported residual use end-step Euler; with nonzero turn acceleration they diverge. Pre-existing debt; unifying the integrators changes the displayed track, g-force graph, and residual for every aircraft fit, so it is deferred to a change with a nonzero-turn-acceleration equality test. |
| TA-13 | P2 | **Fixed** (`0e2f6a3a`) | The quoted truth-track residual now averages only over the truth's valid frames (`meanAngularError` gained an optional mask). |

## Ranking and solution surfacing

| ID | Pri | Status | Resolution |
|---|---|---|---|
| TA-14 | P1 | **Fixed in current working tree** (`79d37523` + uncommitted follow-up) | The gallery lead and truth banner describe the flat, best-first *screening* order and, with a usable truth track, the global ordering of completed fits first and then mean 3D separation; optimizer-incomplete fits follow completed ones. |
| TA-15 | P1 | **Fixed** (`0e2f6a3a`) | Global Fit / Kalman / curve-fit tiles get a geometric-curve-fit explanation instead of falling through to "a stationary-object test"; the generic fallback is neutral. |
| TA-16 | P1 | **Partial** (`0e2f6a3a`) | Report factual errors fixed: the forward-models list now includes the quadcopter and drone, "all criteria are soft targets" is corrected (physical fits also carry hard bounds), and `terrainChangedDuringRun` is passed through and shown. **Deferred:** fully unifying the report's *grouped* layout with the gallery's *flat* order (a moderate rewrite with its own regression risk). |
| TA-17 | P1 | **Partial / Deferred** | The run-health / analyst-summary panel above the grid is not built (deferred UX work); the related clutter is reduced by TA-27 (Monte Carlo sweep off by default → 10 fewer tiles). |
| TA-18 | P2 | **Fixed** (`3dbfdd76`) | The balloon-consistency nudge now discloses its magnitude in residual-equivalent and that it only reorders within a fit tier; the near-level threshold scales with the horizontal extent instead of a fixed 20 m. |
| TA-19 | P2 | **Fixed** (`d6a09f44`) | Truth mode is gated on usable overlap (≥ 5 frames): below that the banners say the truth track does not overlap this A-B window instead of claiming truth ordering, and the comparator keeps screening order. |
| TA-20 | P2 | **Fixed** (`9d2e1d16`) | Truth auto-selection memory is scoped to `Globals.loadGeneration`, so it re-selects per sitch after a reload while respecting an explicit in-session deselection. |
| TA-21 | P2 | **Fixed** (`7b55421d`) | "Restore Closed" → "Restore set-aside" (code + changelog). |

## Workflow reliability and UX

| ID | Pri | Status | Resolution |
|---|---|---|---|
| TA-22 | P1 | **Fixed** (`0e2f6a3a`) | A run-in-flight guard (`_analysisRunning`) blocks a second concurrent Analyze from racing the shared cache and stacking a second gallery. |
| TA-23 | P2 | **Fixed** (`f6314978`) | The lazy full-report callback now catches, logs, and shows a user error while keeping the gallery open. |
| TA-24 | P2 | **Partial** (`ea0ebcf2`) | Gallery now has `role=dialog`, `aria-modal`, an aria-label, focus-on-open, and focus-restore-on-close. **Deferred:** full ARIA/keyboard coverage of the tile grid, focus trap, live-region progress/toasts, and narrow-window stacking. |

## Speed, responsiveness, caching

| ID | Pri | Status | Resolution |
|---|---|---|---|
| TA-25 | P1 | **Fixed** (`14b76d84`) | The quadcopter search integrates at `fitMaxDt` 0.5 s (final trajectory unchanged); 13.9 s → 3.5 s (3.9×) with an identical 0.5408° result. |
| TA-26 | P1 | **Fixed in current working tree** (`5b2676ee` + uncommitted follow-up) | Differential evolution now checks/yields between individual objective evaluations, including the initial population; asynchronous Nelder-Mead and pattern-search polish do the same. Fixed-wing and all physics fits use the same ~60 ms wall-clock pulse and cancellation check, with production-path cancellation tests for both. One individual objective evaluation remains atomic. |
| TA-27 | P1/P2 | **Fixed** (`2c63caa6`) | The two Monte Carlo order sweeps are now an opt-in diagnostic (off by default); only the deterministic Polynomial LSQ sweep runs by default (10 fewer fits/tiles). |
| TA-28 | P2 | **Deferred** | Staged immutable caches (evidence → geometric fits → each physical model → terrain grading → truth → ranking) so changing truth/terrain/display reuses the expensive battery. A large architectural change; a partial version (e.g. removing truth from the fingerprint) risks serving stale truth comparisons, so the whole-run cache is retained for now. |
| TA-29 | P3 | **Fixed in current working tree** (uncommitted follow-up) | The cooperative-yield helper now uses Node's one-shot `setImmediate` path under tests and retains `MessageChannel` only in the browser. The targeted optimizer/physics suites exit normally under `--detectOpenHandles`; no persistent message-port handle remains. |

## Documentation

| ID | Pri | Status | Resolution |
|---|---|---|---|
| DOC-01/02/03 | P1/P2 | **Fixed** | Status/superseded banners added to `TraverseAnalysisReview.md`, `TraverseSlowObjectReview.md`, and `DroneControlFitReview-R1.md`, pointing here. |
| DOC-04 | P2 | **Fixed in current working tree** (`986022e0` + uncommitted follow-up) | `AnomalySurfacingPlan.md` now itemises which prerequisite repairs shipped and which remain, while keeping the Envelope Feasibility Profile explicitly planned. |
| DOC-05 | P2 | **Partial** | `TraverseMethods.md` gained the Kalman-seeding note, the Drone (flown inputs) candidate, and the balloon-consistency tie-break (`986022e0`); the Quick Reference table still does not itemise Polynomial LSQ / the flown-input drone — a smaller follow-up. |
| DOC-06 | P2 | **Deferred** | Monte Carlo documentation still describes one generic method rather than MC1/MC2 + the order-sweep diagnostic role. |
| DOC-07 | P2 | **Deferred** | "Use exact / Use exact result / Use This" naming still varies across docs and UI. |
| DOC-08 | P1 | **Fixed** | Best-first language narrowed to "flat screening order, not an object probability" in the gallery lead (`79d37523`) and `TraverseMethods.md`. |
| DOC-09 | P1 | **Fixed** | `WhatsNew.md` Ground Vehicle wording corrected to a curved constant-elevation shell (not a DEM-following solver). |
| DOC-10 | P1 | **Fixed** | `WhatsNew.md` now states the current boundary precisely: DE, Nelder-Mead, and pattern polish cooperate between individual objective evaluations; one evaluation remains atomic (see TA-26). |
| DOC-11 | P1 | **Fixed** | The unsupported "same result" claim is removed. The changelog now says the fast fit is provisional and optimizer-incomplete if it reaches its budget. |
| DOC-12 | P1 | **Fixed** | Seed wording now states that regularisation alone does not remove radial degeneracy, the 500 m floor prevents the collapse, and an assumption-free seed can still affect convergence/the retained basin. |
| DOC-13 | P2 | **Deferred** | Make/model "approximate containing envelope, not an ID" is already accurate in `TraverseMethods.md`; the `WhatsNew.md` phrasing is a minor follow-up. |
| DOC-16 | P2 | **Fixed** | The balloon-nudge magnitude (≤ 0.3° residual-equivalent, within-tier only) is now disclosed on the tile (TA-18). |
| DOC-17 | P1 | **Fixed** | Terrain wording describes the ground samples actually consumed during fitting/grading plus the 0.1 m LOD-equivalence rule, not a misleading single start-of-run sample. |
| DOC-18 | P3 | **Fixed** | "Restore Closed" → "Restore set-aside" (TA-21). |
| DOC-19 | P2 | **Fixed** | Monte Carlo trial default corrected to 1000 (the GUI value) in `TraverseMethods.md`. |

## Deferred, grouped by reason

- **Change would alter a load-bearing/rendered path and needs its own validation:** TA-11 (Kalman covariance → re-validate the seed), TA-12 (aircraft integrator → displayed track/g-force), TA-06 (drone control frame).
- **Large architectural / UX effort:** TA-16 remainder (report/gallery unification), TA-17 (analyst-summary panel), TA-24 remainder (full accessibility), TA-28 (staged cache).
- **Test infrastructure, not a traverse defect:** TA-29 (jest open handle).
- **Minor documentation polish:** DOC-05 remainder, DOC-06, DOC-07, DOC-13.

Verification is recorded per path rather than inferred from a green suite. Added regressions cover terrain LOD tolerance, solved temporal-wind reconstruction, iteration-limited eligibility and truth ordering, per-evaluation cancellation in DE/Nelder-Mead/pattern polish, and non-finite composite cost. The Generated Orbit Test remains the live end-to-end acceptance case; live values are reported separately from unit-test claims.
