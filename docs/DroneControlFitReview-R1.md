<!-- Round-1 multi-agent review of src/DroneControlFit.js (96 agents, 30 findings, 25 verified by 3 independent skeptics each). Line numbers as of the uncommitted working tree. -->

# DroneControlFit — Round 1 Refinement Plan

Everything below is from reading the code at the cited lines plus closed-form algebra on the cost terms. **I ran no fits.** Where a number comes from the brief's replication rather than from the source or my own arithmetic, I say so.

---

## 1. THE ONE THING

**Make the yaw effort term an effort *integral* rather than a sum of squared per-interval rates.**
`src/DroneControlFit.js:247-252`

```js
const span = (T || this._T || 1) / (K - 1);   // :247
const rate = dh / span;                        // :251
yaw += this.wHeadingRate * rate * rate;        // :252
```

Take a fixed physical flight with total heading change `H` spread over the clip. Then `Δh_k = H/(K-1)`, `rate = H/T` in every interval, and

```
yaw_total = (K-1) · w · (H/T)²
```

**The price of the same real manoeuvre is linear in K.** Going K=4 → 8 doubles the cost of an ordinary turn; K=4 → 12 more than triples it. This is the term that is supposed to be neutral about *where* you spend heading and only care about *how hard* you fly, and it is neither: it is also biased toward smearing, because concentrating `Δ` into one interval costs `m×` what spreading it over `m` intervals costs.

Why this is first, above the more visible defects: **every candidate fix for the measured 90°→39° under-recovery makes things worse until this is fixed.** Raising K (the remedy named at `src/AnalyzeTraverse.js:128-132`) adds resolution and simultaneously multiplies the turn price. Free knot times (the remedy I recommend below) shrink an interval to localise a turn, and `span` at `:247` is hard-coded uniform, so the prior would either not see the sharpening at all, or — if naively changed to the true interval duration — actively pay the optimizer to *widen* the turn interval, reintroducing smearing through the prior. The prior and the parameterisation are coupled; the prior has to move first.

The fix that keeps every existing calibration intact:

```js
const sRef = (T || this._T || 1) / 3;            // nominal span at the reference K=4
const span = spanOf(k);                          // per-interval duration
const rate = dh / span;
yaw += this.wHeadingRate * rate * rate * (span / sRef);
```

At K=4 with uniform knots `span === sRef`, so this is **bit-identical to today's shipped behaviour** and reproduces the pinned values in `tests/DroneControlFit.test.js:256-262` exactly (held 0, orbit 0.54, corkscrew 3266.7). It becomes K-invariant for a fixed physical flight, and it becomes correct for non-uniform spans, which is what unblocks items 7 and 8.

Ship it as a no-op-today enabler, in the same commit as the comment fix (item 4). Do **not** replace the quadratic with total variation — see WHAT NOT TO DO.

---

## 2. Ranked refinements

Tags: **(a)** display-only · **(b)** changes the drone fit · **(c)** changes other hypotheses.

---

### 1. Yaw term as an effort integral — **(b)**, no-op at K=4
`src/DroneControlFit.js:247-252`. Mechanism and rationale above. **Risk: none today** (identical arithmetic at uniform K=4); it only takes effect once K or knot spacing varies. **Size: ~4 lines.**

---

### 2. Guard the seed against silent bound-clamping — **(b)** + **(a)**
`src/AnalyzeTraverse.js:2823-2830`, `src/DroneControlFit.js:180, 184`, `src/DifferentialEvolution.js:62-63`

The control model bounds `initialRange` to `[50, 20000] m` (`:180`) and each speed knot to `[0, 30] m/s` (`:184`). The seed comes from `plausible.track`, whose range search runs out to `plausRangeMax` — up to **55 NM = 101 km** (`src/AnalyzeTraverse.js:2513, 2670-2671`). `seedParams()` is passed straight through as `paramOverrides` → `x0`, and DE **silently clamps it**: `P[i] = clampVec(seeds[i].slice(), lo, hi)` (`src/DifferentialEvolution.js:63`), as does Nelder-Mead (`src/NelderMead.js:129`).

So on any far-field scene the advertised behaviour — "seeded from the geometric solution" (`src/AnalyzeTraverse.js:1298`) — **does not happen**. The range starts pinned at 20 km, the speed knots start pinned at 30 m/s (58 kt) while the seed track was doing hundreds of knots, and the heading knots are the ones inverted from a track at 50 km. The fit is then a badly-started unseeded DE. The tile still renders, still prints a `describe()` string, and — because `ownErr` is large — inflates `plausibleVsPossibleGapDeg` (`:1279`), which the notes at `:1307-1312` narrate as *"the sightlines demand unusual motion."*

**Mechanism of harm: a spurious anomaly signal on exactly the far-field scenes where the drone hypothesis should simply have declined to run.**

Fix: after `seedFromTrack`, compare the seed against `getParameterDefs()` bounds. If `seed.range` or any speed knot is outside its box, either (i) skip the hypothesis with an explicit note ("no drone-scale geometric seed exists for this scene — the least-manoeuvring track is at 27 NM and 340 kt"), or (ii) run it and surface `seedClamped: true` in `params`. Option (i) is more honest; option (ii) preserves the tile. Do not silently proceed.

**Risk: low** — it removes output rather than adding it, and it cannot suppress a manoeuvring answer on any scene where a drone-scale seed exists. **Size: ~15 lines.** **Uncertainty: I have not confirmed this fires on Gimbal**; it follows from the bounds and `clampVec`, and should be checked by logging `m.seedParams()[0]` against `defs[0].max` on a far-field sitch before writing the guard.

---

### 3. Stop seeding the drone from the jet-targeted plausible track — **(b)**
`src/AnalyzeTraverse.js:2487, 2667-2672` → `src/TraverseAnalysis.js:1638-1646, 1608`

`speedTarget` defaults to **380 kt** (`src/AnalyzeTraverse.js:2487`) and is passed as `vTarget` into the single `fitPlausibleBestRange` call (`:2668`) whose output seeds the drone fit (`:2824`). Inside, `usedSpeedTarget` is **true unless the geometry is decisive** (`src/TraverseAnalysis.js:1638-1643`) — i.e. true on most narrow-baseline scenes. So the drone hypothesis's starting range is frequently chosen by a soft pull toward *jet* speed, `vSigma = 60 kt` (`src/AnalyzeTraverse.js:2669`).

This is a bias, but **not toward slow** — toward far and fast, and it feeds directly into item 2's clamping failure.

Cheap fix with no extra compute: `fitPlausibleBestRange` already computes the pure-smoothness sweep unconditionally (`src/TraverseAnalysis.js:1625`, `pureSweep`). Return `pureSweep.best.track` and `pureSweep.best.R` alongside the existing result, and seed the drone fit from **that** — geometry only, no speed prior of any kind. Report which seed was used in the tile.

**Risk: low-moderate.** It changes the drone tile's answer on most scenes, so it must be re-measured (section 5). It does not touch any other hypothesis provided you *add* returned fields rather than change `track`. **Size: ~20 lines across two files.**

---

### 4. Delete the two false comments — **(a)**, doc only
`src/DroneControlFit.js:130-133` and `146-149`

Both claim the seed is "the reference the effort term measures deviation from, so a fit that simply reproduces the geometric seed pays nothing extra." `extraCostTerms` (`:244-263`) reads only `params`; `this.seed` appears at `:156-166`, `:171-172` and `:191-192` and nowhere else. Reproducing the seed is **not** free.

The code is right and the comment is wrong — say that the seed supplies the initial guess (`seedParams`, `:170-173`) and the seed-relative heading bounds (`:191-193`) only, and that effort is measured in absolute knot-to-knot control change *by design*, because the seed is itself straightness-selected. **Risk: none. Size: 6 lines.** Do not "fix" this by changing the code — see WHAT NOT TO DO.

---

### 5. Test the budget that actually ships — test-only
`tests/DroneControlFit.test.js:57, 216` vs `src/AnalyzeTraverse.js:2744-2748`

Three different budgets are in play and **none of the tests use the shipped one**:

| | dePop | deGens | sampleStride |
|---|---|---|---|
| test default `OPTS` (`:57`) | 24 | 40 | 4 |
| turning test override (`:216`) | 40 | 90 | 4 |
| **shipped `physicsOpts` (`:2745`)** | **48** | **120** | **5** |

The file's own comment at `:208-215` records that the budget moves the recovered turn from ~65° to ~39° and warns *"whatever budget ships must be validated on a turning case."* It then validates a budget that does not ship. The brief's corrections report that at shipped settings the turning assertions (`travel > 25` at `:242`, `sep < 400` at `:244`) **fail**, with run-to-run spread of 18–40° and 145–794 m across rng seeds — I could not verify that here, but the structural gap is plain from the three lines above.

Change `fitControls` to accept the shipped options as a named preset and run the turning test at it, across ≥3 `options.seed` values (`src/LOSFitting.js` passes `mulberry32(options.seed ?? 0xF17DE5)`). If it fails, that is the honest current state and it should be recorded as a failing/skipped test with the measured spread, not tuned around. **Risk: none to product. Size: ~20 lines.** Do this before items 7 and 8 — they are unmeasurable without it.

---

### 6. Disclose what the model actually claims — **(a)**
`src/AnalyzeTraverse.js:1288-1296, 1303-1312`

Four additions, all display:

- **`knotSpacingSec: T/(K-1)`** next to `knots: 4` (`:1291`). On a 60 s clip that is 20 s; on a 20,000-frame clip (`:2845`) it is minutes. An analyst reading "knots: 4" has no way to know the temporal resolution of the claim.
- **`seedHeadingTravelDeg`** alongside `headingTravelDeg` (`:1290`). The difference between the seed's turn and the fitted turn is the direct measure of whether the refinement is doing anything or just polishing the seed — which is the open question in section 3.
- **`seedClamped` / seed provenance** (`usedSpeedTarget`, seed range) — from item 2 and item 3.
- **Fix the gap narrative** (`:1307-1312`). `gap = ownErr − freeErr` (`:1279`), so any under-recovery of a real turn *raises* `ownErr` and *widens* the gap. The current wording reads a wide gap as "the sightlines need unusual motion" — but a wide gap is equally produced by a K=4 basis that cannot represent an ordinary turn. The note should say that, and should stop being the only interpretation offered.

Note the compounding: the subtitle at `:1283` → `describe()` → `travel < 20 ? "on a steady heading"` (`src/DroneControlFit.js:284`) **understates** manoeuvring, while the gap and the ranking **overstate** the anomaly. Same root cause, opposite directions, both wrong.

**Risk: none. Size: ~25 lines.**

---

### 7. Reparameterise heading as (h0, δ1…δ_{K−1}) — **(b)**
`src/DroneControlFit.js:191-193, 202-208, 249-257, 266-273`

Heading enters the dynamics only through `Math.sin`/`Math.cos` (`:224`) and the cost only through differences (`:250`, `:270`). Adding 360° to **all** heading knots is therefore an exact symmetry — a null direction in a 13-dimensional search. The bounds `[d−720, d+720]` (`:192`) contain four wraps of it, and DE initialises the whole population uniformly across them (`src/DifferentialEvolution.js:57-59`) with a single seeded member (`src/LOSFitting.js` `seeds: [x0]`).

Reparameterising to an anchor plus increments removes the null direction, makes each parameter's `scale` meaningful to the Nelder-Mead polish, and makes `extraCostTerms`/`headingTravelDeg` read the parameters directly instead of differencing them.

Two constraints on how it is done:

- **Keep the δ bounds seed-relative**, e.g. `δ_k ∈ [Δd_k − A, Δd_k + A]`, not a fixed ±1440. A fixed ±1440 reproduces exactly today's ~4320° (12 revolution) cap at K=4 while *losing* the seed-relative headroom the current bounds give a seed that is already turning.
- **State the cap as a design choice.** As shipped, the ±720 box means total heading travel is capped at roughly seed spread + (K−1)×1440 — so the 61-revolution corkscrew is *forbidden by bounds*, not priced by effort, contradicting `:38-40` ("It is not banned, it is priced") and `:189-191` ("the bounds do not forbid it"). A sustained 20°/s orbit over 300 s (16.7 revolutions) is unreachable at K=4. If the effort term is doing its job — and my arithmetic says the corkscrew costs 3267 units = 65° of residual budget against the 0.011° it ever bought — the cap is redundant where it is inert and harmful where it binds. Prefer a duration-scaled allowance (a stated max sustained yaw rate × interval span) over a fixed one, and bring the comments into line either way.

**Risk: low-moderate.** It cannot make anything unreachable relative to today provided the bounds stay seed-relative; it *does* shift every measured number, so item 5 must land first. The temptation to shrink the box afterward "for convergence" is a hard foreclosure of fast-orbiting solutions and must be resisted. **Size: ~30 lines, plus the positional vectors in `tests/DroneControlFit.test.js:251-253`.**

---

### 8. Free interior knot times, and K scaled to duration — **(b)**, together, after 1 / 5 / 7
`src/DroneControlFit.js:99-107, 110-116`; `src/AnalyzeTraverse.js:133`

`knotValue` interpolates on `u = t/T*(K-1)` with knots hard-wired uniform (`:112`), and `toKnots` point-samples at `Math.round(k*(count-1)/(K-1))` (`:103`). At K=4 on a 60 s clip the knots sit at t = 0, 20, 40, 60, so a course change at t=45 can only be rendered as a ramp starting at t=40 — the ramp is wrong on both sides, so the residual-optimal amplitude is strictly less than the true step. That is the representation ceiling behind the measured 39°-of-90°.

Two changes, and they belong together:

- **Free interior knot times.** Append K−2 time parameters **at the end of the vector** (inserting them mid-vector silently corrupts `_controls` `:202-208`, `extraCostTerms` `:249-257`, `headingTravelDeg` `:266-273`, `describe` `:275-288`, and `solvedVector` consumers at `src/AnalyzeTraverse.js:1270, 1284`). Order-constrain them as **boxed monotone increments**, not by sorting inside the model — `getParameterDefs` flattens to per-dimension `lo`/`hi` in `src/LOSFitting.js` and both optimizers repair per-dimension only, so a cross-dimension constraint is not expressible; and in-model sorting creates permutation plateaus that stall Nelder-Mead, which on this budget is doing most of the work. Enforce a `minGap` well above `maxDt = 1/30` (`src/DroneControlFit.js:125`) — ≥1 s is comfortable, and it doubles as the plausibility statement that a stick input is not instantaneous.
- **Scale K with duration**, e.g. `K = clamp(round(T/15) + 1, 4, 12)` at `src/AnalyzeTraverse.js:133`. Be honest that this saturates: any clip over ~165 s gets K=12, so an 11-minute clip has 60 s spacing, not 15 s.

Both are gated on item 1 (without it, more knots = a higher price on real turns) and on the search budget. At K=12 the vector is 37+ parameters against `dePop: 48` — DE's own default is `Math.max(40, 15*dim)` = 555 (`src/DifferentialEvolution.js:49`). **The budget is already 3.7× below that default at K=4.** Raising K without raising `dePop` ships an inert change at best and a worse, straighter answer at likely.

Known gap I have no answer for: `_controls` (`:202-208`) uses **one** time grid for speed, heading and climb. At K=4 with free times, a single sharp turn consumes both interior knots, leaving nothing for a speed change elsewhere. Per-channel times (+6 params) or a higher K is the fix, and both cost search budget.

**Risk: moderate — the largest on this list.** **Size: ~60 lines + budget retuning + re-measurement.**

---

### 9. K-normalise the speed and climb terms — **(b)**
`src/DroneControlFit.js:253-256`

`wSpeedChange * ds²` and `wClimbChange * dc²` carry **no time normalisation at all** and are K-dependent in the *opposite* direction from yaw: a total speed change ΔS split across K−1 intervals costs `ΔS²/(K-1)`, so it gets *cheaper* as K rises. Under item 8 the two terms would drift apart. Total variation (`Σ|ds|`) is exactly K-invariant for a monotone change and matches the "count of input movements" semantics better than a squared rate.

Note that **this is currently untested**: all three vectors in `tests/DroneControlFit.test.js:251-253` hold speed at 8 and climb at 0, so both terms are identically zero in every assertion. Any change here is invisible to the existing suite — add cases before touching it. **Risk: low. Size: ~10 lines + 2 test cases.**

---

## 3. Does seeding from the least-manoeuvring track bias the answer toward straight flight?

**Partly, through one channel, and the channel is not the one the code comments worry about.** Three candidate mechanisms; two are weaker than they look, one is real.

**Smoothing — weak.** `smoothSpacingSec: 4` (`src/TraverseAnalysis.js:1599`) puts a B-spline control point every 4 s, and `inverseControls` differences over ±3 frames (`src/DroneControlFit.js:62, 70`) = ±0.3 s at 10 fps. Neither erases a course change on the 10–45 s scale. The seed track is also pinned to the rays, so a real turn survives in the seed's heading history as a detectable ramp — smeared at ~4 s resolution, not deleted. "Corners have been explicitly removed" overstates it.

**The effort term anchoring to the seed — does not exist.** The comments at `:130-133` and `:146-149` say it does; the code does not (item 4). So this channel is currently zero.

**Range selection — real, and this is the one.** `fitPlausibleBestRange` chooses range by minimising `straightFlightScore` (`src/TraverseAnalysis.js:1608`), whose terms are `4·gLoad.rms + 1·gLoad.max + 0.05·turnRate.std + …` (`:734-742`). Range is the weakly-observable direction; the cost surface along it is nearly flat. **So among a family of ranges that fit the sightlines about equally well, the seed selects the one whose reconstructed flight manoeuvres least** — and the drone fit then starts there, at 13 parameters with `dePop: 48` (≈3.7× dim, against DE's own 15× default), where the search is plausibly a local polish rather than a global search. If it is a polish, the drone tile is reporting the *least-manoeuvring range's* flight, laundered through a control parameterisation, and its independence from the plausible-track hypothesis is smaller than the gallery implies. Compounding it, that same range choice may be pulled by a 380 kt speed target (item 3).

**What to do — in this order:**

1. **Measure whether it matters before engineering around it.** Run the control fit from **two** seeds — the current `plausible.track` and the pure-smoothness `pureSweep.best.track` (`src/TraverseAnalysis.js:1625`, already computed, no extra solve) — and report the spread in `headingTravelDeg`, `range` and `errDeg`. If the two converge, the seed is only an initial guess and the concern is discharged empirically. If they diverge, the fit is a polish and the tile is seed-determined. **This is one extra fit and no new parameters, and it cannot manufacture motion.** It is the cheapest decisive experiment on this whole list; do it before item 7 or 8.
2. **Report `seedHeadingTravelDeg` next to `headingTravelDeg`** (item 6). If they are always equal, the refinement stage is doing nothing.
3. **If the seed does determine the answer, fix the search, not the seed** — raise `dePop` toward `15·dim` and re-check seed sensitivity. Adding parameters (item 8) to a search that is already only polishing will not help.
4. **Do not** anchor knot placement to the seed's changepoints as fixed positions — that hard-codes the straightness-selected seed's structure into the basis. Seed changepoints are fine as an *initial guess* for free knot times (item 8); never as the placement itself.

There is a countervailing consideration worth stating plainly: the seed is also what keeps the fit off the degenerate zero-range solution on the sensor's own path. Any move to "de-bias" the seed by weakening it risks the fit escaping along the weakly-observable range direction — which is where LOS residual and truth accuracy diverge, and where a better-scoring answer is further from truth. Measure first.

---

## 4. WHAT NOT TO DO

**Do not switch the yaw term to total variation (L1 on Δh).** It is tempting — it is K-invariant, T-invariant, and it is the textbook sparsity prior for "held inputs." It is also wrong here in the harmful direction. At K=4, T=60 s the current form charges a single-interval turn `w(Δ/20)² = 5e-5·Δ²`: **0.045 units at Δ=30°, 0.405 at Δ=90°.** At the proposed `wYaw = 0.01`, TV charges `0.3` and `0.9` — **6.7× dearer at 30°, 2.2× dearer at 90°.** L1's constant marginal price dominates L2's vanishing one below about 100°, which is exactly where ordinary turns live. TV also collapses the corkscrew:orbit ratio from ~6000× to ~78×, breaking `tests/DroneControlFit.test.js:262`, and — more seriously — breaking `:260` (orbit < 1 unit), which encodes a real requirement (`src/DroneControlFit.js:34-35`); only `wYaw < 0.0037` satisfies it, and at that weight the corkscrew defence is thin. TV is additionally **rate-blind**: a 270° orbit costs the same at 3°/s and 30°/s, so it needs a separate rate hinge to remain a drone model at all. Fix the K-scaling (item 1); do not change the functional form.

**Do not make the effort term measure deviation from the seed** — i.e. do not implement what the comment at `:131-133` claims. The seed is chosen by minimising `straightFlightScore`; making it the zero of the effort measure would make the straightest available reading **free** and charge every sightline-demanded departure from it. That imports the seed's straightness selection directly into the prior — the exact failure mode this whole reformulation exists to remove. It would also break `cost(held) === 0` (`:259`), make `extraCost` depend on mutable `this.seed` inside the optimizer's inner loop, and leave the corkscrew guarantee untestable without a seed. Fix the comment, keep the code.

**Do not raise K without item 1.** More knots multiply the price of the manoeuvre the knots were added to represent. `src/AnalyzeTraverse.js:128-132` already recommends raising K; done today it deepens the bias it is meant to cure.

**Do not tighten the heading bounds, or lower K, to stabilise a noisy fit.** A bound leaves no trace anywhere — `errDeg` excludes `extraCost` by construction, and unlike a price a bound does not appear in `priors`. It is invisible foreclosure. If the fit is unstable, raise `dePop`.

**Do not add residual-driven knot insertion without a wobble-null test.** With `errSigma = 0.02°` against ~0.04° tracker wobble, residual run-length maxima are largely noise features, and inserting control authority at them manufactures manoeuvre to absorb wobble — the Aguadilla failure arriving through the front door as "adaptive resolution." Any such scheme needs: straight truth + wobble, assert no increase in `headingTravelDeg`, insertion threshold in units of `errSigma`.

**Do not tune any weight against the corkscrew case alone.** Both poles, every time: Aguadilla (must die) *and* the 90° course change (must be recovered). One-sided validation is how this term got its current shape.

**Do not treat a lower `errDeg` as a better answer.** Residual and truth accuracy provably diverge in this codebase. Every measurement in section 5 pairs residual with truth separation for that reason.

**Do not drop or replace the free `QuadcopterModel` tile** (`src/AnalyzeTraverse.js:2794-2797`). Running both is what keeps the drone hypothesis non-foreclosing, and `plausibleVsPossibleGapDeg` is undefined without it.

**Do not let `describe()`'s "on a steady heading" branch** (`src/DroneControlFit.js:284`) stay at a fixed 20° threshold once knot resolution varies with clip length. A 20° readout on a 20 s clip and on a 10-minute clip are not the same claim.

---

## 5. Confirming measurements

Build one synthetic scene with truth, using the existing pipeline (MISB truth export + Tracking Wobble, per the `custom` sitch — **not** gimbal/gofast): **DRONE-TURN** — 10 m/s constant, heading 20° for 45 s then 110° for 45 s, constant altitude, sensor on a slow arc, 0.04° per-frame tracker wobble. Keep **AGUA** (the real sitch, no truth) as the corkscrew guard, and add **DRONE-STRAIGHT** (constant velocity + wobble) as the invention guard. Read every number off the drone tile's `params` (`src/AnalyzeTraverse.js:1288-1296`) plus separation against the truth track.

Baseline the three scenes at the **shipped** `physicsOpts` (`:2745`) across ≥3 `options.seed` values, and record the *spread*, not the mean. Every criterion below is against that baseline.

| # | Refinement | Measurement | Pass criterion |
|---|---|---|---|
| 1 | Yaw integral | All three scenes, K=4 | **Byte-identical** `errDeg`, `headingTravelDeg`, `priors.total`. Any change means the reference-span factor is wrong. |
| 1 | — (enabling check) | DRONE-TURN at K=4 and K=8, prior on | `priors.terms["yaw input"]` for the same recovered turn within 5% across K. Today it should differ by ~2×. |
| 2 | Seed clamp guard | Log `m.seedParams()[0]` vs `defs[0].max` and `max(seed.speed)` vs 30 on a far-field sitch (Gimbal-scale) | Confirm the clamp fires; after the guard, the tile either declines or carries `seedClamped: true`. No far-field scene silently reports a 10.8 NM drone. |
| 3 | Seed provenance | DRONE-TURN and AGUA, seeded from `plausible.track` vs `pureSweep.best.track` | Report both. **Diagnostic, not pass/fail**: if `headingTravelDeg` and `range` agree within ~10%, the seed is only a guess; if not, the fit is a polish and item 8 is premature. |
| 5 | Shipped-budget test | DRONE-TURN, shipped opts, ≥3 rng seeds | Record actual `travel` and `sep` spread. If it fails `>25°` / `<400 m`, that is the finding — record it, do not retune to pass. |
| 6 | Disclosure | Any scene | `knotSpacingSec` matches `T/(K-1)`; `seedHeadingTravelDeg` present; gap note no longer asserts a single interpretation. |
| 7 | Heading deltas | DRONE-TURN, ≥3 rng seeds, shipped opts | `travel` **spread across seeds shrinks** vs baseline (the null direction is what makes it seed-sensitive). Median `travel` ≥ baseline median. AGUA `headingTravelDeg` unchanged within noise. |
| 7 | Bounds honesty | Construct a 300 s scene with a 16-revolution truth orbit | The fit reaches ≥12 revolutions if the sightlines demand it. Today it cannot (≈12 rev hard cap at K=4). |
| 8 | Free knot times + K | DRONE-TURN, shipped opts (with `dePop` raised toward 15·dim), ≥3 seeds | Median recovered `travel` **≥ 65°** of the 90° truth and `sep` **< 200 m**, with spread no wider than baseline. Below ~65° the change is not worth its parameters. |
| 8 | Non-regression | AGUA + DRONE-STRAIGHT, same settings | AGUA drone `headingTravelDeg` stays **< 720°**; DRONE-STRAIGHT `travel` stays **< 90°** and `sep` **< 50 m**. If either moves, free knots bought manoeuvre from wobble. |
| 9 | Speed/climb | New scene: constant heading, speed 4 → 12 m/s at mid-clip | Recovered speed range covers ≥70% of the true 8 m/s change; `priors.terms["speed changes"]` within 10% across K=4 and K=8. |

Two standing rules for reading these: **always report truth separation next to `errDeg`** — a refinement that lowers residual while moving away from truth has failed, and this codebase has measured cases where that happens; and **always report the spread across rng seeds**, because on a near-degenerate surface a single deterministic run (`mulberry32(0xF17DE5)`) is one sample, not a measurement.

---

**Uncertainty, stated plainly.** I ran no fits. Items 1 and 9 rest on algebra I did from the source and I am confident in them. Item 2 rests on reading bounds (`:180, 184`), `plausRangeMax` (`src/AnalyzeTraverse.js:2513`) and `clampVec` (`src/DifferentialEvolution.js:63`) — the mechanism is certain, that it fires on a real sitch is not, and should be logged before writing the guard. Item 3's `usedSpeedTarget` branch (`src/TraverseAnalysis.js:1638-1643`) is read correctly but how often it evaluates true in practice is unmeasured. The claim that the shipped budget fails the turning assertions is from the brief's replication, not from me; item 5 exists to settle it. The expected magnitudes in item 8's pass criteria (65°, 200 m) are targets I chose from the brief's reported representation ceiling (~51° at K=4 uniform from a truth-like start), not measurements — treat them as provisional until the baseline in item 5 exists.