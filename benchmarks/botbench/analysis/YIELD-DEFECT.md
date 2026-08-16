# The yield defect: `search incomplete (bound pins…)` — diagnosis (2026-08-15)

Study finding F4 named the `search incomplete (bound pins, clamps, or an
unconverged optimizer)` blocker as the top yield thief on real segments: on the
real `dash` segment the quadcopter fit landed 874 m from truth (4.3% of mean
truth range) at 0.046 deg angular residual, ranked FIRST in the gallery, and the
class screen withheld it. The verdict was `unresolved`.

This document establishes what actually fired, argues the case FOR the current
rule as strongly as the evidence allows, and lays out the options with the
experiment that would decide between them.

**INVESTIGATION ONLY. No source file was changed.** Every option below alters
production analysis behavior and needs a decision before anything is written.

> **Provenance note (2026-08-15, added after the near-term tier landed).** The
> real-arm numbers below were measured BEFORE the ingest guard that corrected
> the datum-step bridge (dash: 119 repairs down to 5). That guard moves the
> dash window by 0.774 s and changes the noise draw for the six unpaired real
> scenarios, so every real-arm figure here is superseded by the regenerated
> records. The maneuver arm, the ladder, and every finding's DIRECTION are
> unaffected. Figures are refreshed by re-running `bench-bot-tract` for the
> real set and `analyzeTractability.mjs`.

## 1. Where the blocker is raised, and exactly what fired

The call chain is short and entirely inside the shipping analysis:

| step | file:line | what it does |
|---|---|---|
| bound diagnosis | `src/BoundedFit.js:13-53` | `assessBoundPins` finds parameters that finish within 1% of a bound and probes 5% inward; a bound is `loadBearing` when the probe worsens the cost by more than `max(0.02, 0.001·cost)` |
| pin filtering | `src/TraverseHypotheses.js:324-334` | `splitBoundPins` splits the pin records into `active` (load-bearing), `inactive`, `unstable`, per a caller-supplied predicate |
| pin naming | `src/TraverseHypotheses.js:105-107` | `pinLabel` renders `name (min)` / `name (max)` — the strings that appear in the record |
| quadcopter predicate | `src/TraverseHypotheses.js:844-856` | which quad bounds count as capability limits: `initialRange` (either side), `speed` at the hi side, and `accel/turnRate/turnAccel/climb/windE/windN` |
| rating | `src/TraverseRanking.js:474-486` | `plausibilityRating` returns `activePins`, `modelClamps`, and `incomplete = boundaryLimited \|\| optimizerWarnings.length > 0` — note that **pins are NOT part of `incomplete`** here |
| class screen | `src/TraverseRanking.js:592-598` | `judgeRepresentative`: `complete = !incomplete && !activePins.length && !modelClamps.length`; `if (!complete) blocker = "search incomplete (bound pins, clamps, or an unconverged optimizer)"` |
| verdict | `src/TraverseRanking.js:753-768` | with no viable class, `code: "unresolved"`, listing each class's blocker |

The intent is stated at `src/TraverseRanking.js:540-543`: the executive
predicates are "deliberately STRICTER than gallery eligibility … a fit that only
works pressed against its own limits cannot carry an executive conclusion."

### Which of the three flags fired on `dash`

From `results/tractability/records-real-6.jsonl` (label `dash`, scenario
`bb-325f3d68`), the quadcopter hypothesis carries:

```
errDeg 0.046374   tier "Not fully tested"   rank 1   eligible false
activePins ["initialRange (max)", "speed (max)"]
modelClamps []    incomplete false    optimizerWarnings []
truthSepM 874.19
band {rangeLoM: 592.64, rangeHiM: 19997.55, boundaryLimited: true, screenedCount: 11}
```

**`activePins` fired, alone.** `incomplete` is `false` (the optimizer converged;
nothing was boundary-limited in the family sense) and `modelClamps` is empty. The
class screen's extra clause is the whole of the block: remove `activePins` from
line 593 and this class becomes viable.

A second realization of the same scenario exists in `records-0.jsonl`
(`bb-b94ee1f9`, taken before the truth-hygiene caps entered the segment key —
the same source window, start 294.705 s vs 294.674 s). It is the sharper case:

| run | pins | errDeg | truthSepM | rel. to mean truth range | tier |
|---|---|---|---|---|---|
| `records-0` (`bb-b94ee1f9`) | `initialRange (max)` | 0.0463 | **144.3 m** | **0.7%** | Not fully tested |
| `records-real-6` (`bb-325f3d68`) | `initialRange (max)`, `speed (max)` | 0.0464 | 874.2 m | 4.3% | Not fully tested |

Both were withheld by the same clause. The declared pointing noise is
`gaussianSigmaDeg = 0.03`, so a 0.046 deg residual is about 1.5 sigma — this is a
fit at the noise floor, not a marginal one.

### Why it ranked first, and why that is not a contradiction

The flat comparator (`src/TraverseRanking.js:837-845`) orders by: passed-screen,
then `eligible`, then **`incomplete` ascending**, then tier rank, then pin count.
On `dash` the three ray-constrained generics (`saddle`, `constAlt`, `plausible`)
all carry `incomplete: true`, and the quadcopter does not — so the quadcopter
takes the top tile on the third key. The ranking's `incomplete` (line 480) and
the class screen's `complete` (line 592) are **two different predicates over the
same rating**: pins are excluded from the first and included in the second. The
same fact that promoted the tile to rank 1 is not the fact that disqualified it,
but the two live four hundred lines apart and are not reconciled anywhere. That
is the surface an analyst reads as "found, then refused".

## 2. The case FOR the current behavior

This is the strongest form of the argument, and parts of it are measured, not
speculative.

**(a) On `dash` the truth really is outside the box.** The quadcopter model's
range bound is a class statement, not a numerical convenience
(`src/QuadcopterModel.js:74-78`): "A visible multirotor is a near-field object —
keep the range search local (50 m .. 20 km)." Mean truth range on `dash` is
20 236 m. The multirotor range band's admitted set tops out at 19 997.55 m, and
the record's `familyCoverage.perClass["quadcopter|"].coverageFrac` is **0** —
at no frame of the clip does the truth range fall inside the multirotor family's
admitted envelope. The optimum genuinely lies outside the searched box, by about
1% of range. This is precisely the failure the rule exists to catch, and it
caught it.

**(b) Releasing the rule would have produced a confidently wrong verdict on the
study's worst cell.** On `maneuver/hypersonic-glide` the quadcopter fit reaches
0.0468 deg — a hair better than the fixed-wing's 0.0489 — with
`activePins: ["initialRange (min)"]`, i.e. jammed against the *near* bound at
50 m, while the truth is 116 km away (`truthSepM` 116 222, relSep 1.000). Only
the pin rule keeps `multirotor` out of that verdict. F3 already calls the
existing `consistent-one: fixed-wing` there the worst kind of cell in the matrix;
adding a second wrong class to it would be worse.

**(c) A pinned fit's PARAMETERS are meaningless even when its track is close.**
This is the general form and it is sound. The fixed-wing path says it in the
code itself (`src/TraverseHypotheses.js:780-782`): load-bearing pins mean "treat
this model test as incomplete, not as excluding every fixed-wing aircraft". The
class screen is a **confirmation** screen. "This model, searched inside its own
declared envelope, did not find an interior optimum" is a correct reason to
decline to confirm the class. On `dash` the multirotor class is arguably the
wrong answer anyway: the truth is a VTOL in forward flight, and the fitted object
sits beyond the range at which this model claims a multirotor is a plausible
subject at all.

**(d) The pin test is conservative by design and documented as such.**
`src/BoundedFit.js:5-11` states the probe is "deliberately a local diagnostic,
not an uncertainty interval. A full identifiability analysis would re-optimize
the remaining parameters." Under-claiming completeness is the safe direction for
a verdict that will be read as a conclusion.

**(e) The rule is not indiscriminate.** It already distinguishes load-bearing
from inactive pins, is side-aware per model (a lantern at `vSink (min)` is a
becalmed balloon, not a violation — `src/TraverseHypotheses.js:357-364`), and
excludes locked coordinates from the pin scan (`src/LOSFitting.js:1629-1638`:
"A LOCKED coordinate was never searched, so it cannot be a load-bearing search
limit"). A lot of false-alarm surface has already been removed.

## 3. Was the pinned parameter one that matters?

Yes on both counts for `dash` — this is not a nuisance-parameter block. Across
all 28 records the active-pin vocabulary splits three ways:

| kind | pins seen | count |
|---|---|---|
| RANGE (the decision variable) | `initialRange (max)` 7, `initialRange (min)` 2, `startDist (min)` 2 | 11 |
| ENVELOPE (class capability) | `vRise (max)` 13, `derived speed (above max)` 5, `speed (max)` 3, `vSink (max)` 2 | 23 |
| NUISANCE (wind/shear terms) | `windE (max)` 12, `shearPerM` 12, `windDriftE` 13, `windDriftN (max)` 4, `windCurve*` 7 | 48 |

`dash` is blocked by one RANGE pin and one ENVELOPE pin. Both are
decision-relevant by any reasonable definition, so **option (b) does not rescue
this case** (confirmed by replay in section 4).

One nuance about the `speed (max)` pin, measured from the truth track: with the
scenario's wind set to zero, ground speed equals air-relative speed, so the
model's 60 m/s bound is directly comparable to the truth. Over the 30 s window
the truth's horizontal speed is mean 40.1 m/s, median 40.2, 1-second-smoothed
peak 50.5 (raw 0.1 s finite differences peak at 73.5, which is interpolation
jitter), profile 26 → 48 → 30 m/s with a 65 deg heading change. **The truth is
inside the model's 60 m/s envelope.** So `speed (max)` is not evidence that the
object exceeds multirotor capability; the more likely reading is that a
constant-acceleration model, forced to sit ~1% short in range, buys its fit with
a high initial speed and a negative acceleration — and that the 1-D inward probe
then reports the bound as load-bearing because it moves `speed` without
re-optimizing `accel`. That mechanism matters: in bearings-only geometry, range
and speed lie along a narrow diagonal valley (this scenario's
`cvDesignLog10RcondObserved` is -2.36), and a coordinate-aligned probe measures
the wrong curvature — it measures across the valley, not along its floor. That
reading is a mechanism argument, not a measurement; confirming it needs a re-fit
(section 6).

`initialRange (max)` is the opposite: the coverage measurement in section 2(a)
shows that pin is real.

## 4. Counterfactual replay over the existing records

The class screen can be re-run offline from the records, because they carry
`fitRank`, `kinematicRank`, `activePins`, `modelClamps` and `incomplete` per
hypothesis (`benchmarks/botbench/lib/verdictRunner.js:387-401`, whose comment
already flags that the class blocker "names the symptom and hides the cause").

Replaying the shipped rule reproduced the recorded verdict code on **28/28**
records, which is the warrant for the variants below.

| variant | scenario verdicts changed | detail |
|---|---|---|
| as shipped | — | baseline (28/28 reproduced) |
| block only on decision-relevant pins (RANGE + ENVELOPE, ignore wind/shear) | **0** | every blocking pin in this set is already a range or capability pin |
| ignore active pins entirely | **4 records / 3 scenarios** | see below |

Ignoring pins entirely:

| scenario | before | after | newly viable class | truth separation |
|---|---|---|---|---|
| `real/dash` (run A) | unresolved | consistent-one: multirotor | quadcopter 0.046 deg | 144 m (0.7%) — **gain** |
| `real/dash` (run B) | unresolved | consistent-one: multirotor | quadcopter 0.046 deg | 874 m (4.3%) — **gain** |
| `real/gofast` | consistent-one: multirotor | consistent-several: balloon + multirotor | lantern 0.043 deg | 782 m (9.2%) — **gain: truth IS a balloon**, the class the wrong single call had missed |
| `maneuver/hypersonic-glide` | consistent-one: fixed-wing | consistent-several: fixed-wing + multirotor | quadcopter 0.047 deg | 116 222 m (100%) — **harm** |

Only **4 of 140 class judgements** (28 records x 5 classes) are blocked by active
pins *alone*; every other `search incomplete` block is over-determined (the fit
also fails `close` or `ordinary`). So the F4 framing needs a correction: the
blocker is the most frequent single blocker string (33 of 140 class slots), but
it is the *sole* obstacle on only three distinct scenarios of 26, and `dash`
is two of the four instances.

And the discriminator between the gains and the harm is not "is there a pin" but
**which bound, and on which side**: the three range pins among those four split
perfectly, both
`(max)` pins being releases worth making and the single `(min)` pin being the one
that must stay blocked. A near-bound pin at 50 m is the degenerate slow-near
corner where any motion fits; a far-bound pin is the data asking for more range
than the class allows. That is a real mechanism, but n = 3. It must not be
shipped as a rule on this evidence.

### The wider yield picture

The pin rule is not the only thing costing yield. Of 17 `unresolved` records,
the **blind rank-1 tile** lands within 5% of truth on five (four distinct
scenarios):

| scenario | blind rank-1 | errDeg | relSep | why no verdict |
|---|---|---|---|---|
| `rubberduck-drone` | constAlt | 0.038 | 0.001 | generic screen, not an interpretation class — can never yield a verdict |
| `corkscrew` | quadcopter | 0.037 | 0.003 | `requires non-ordinary kinematics` |
| `dash` (run A) | quadcopter | 0.046 | 0.007 | **pins** |
| `dash` (run B) | quadcopter | 0.046 | 0.043 | **pins** |
| `aguadilla` | quadcopter | 0.139 | 0.047 | `LOS fit not close` |

Only `dash` is pin-blocked. The common thread is structural: the executive layer
reports **class viability only**, so a well-determined *trajectory* has no
channel out of the pipeline at all — `rubberduck-drone`'s 3 m recovery (F5) is
invisible to the verdict by design, not by blocker.

## 5. Options

| # | option | what improves | what breaks / risk | evidence that would settle it |
|---|---|---|---|---|
| a | leave as is | nothing changes; the conservative confirmation contract stays intact and `hypersonic-glide` stays free of a second wrong class | the measured cost is a 0.7%-of-range recovery on a real segment being reported as "unresolved"; the escalation pilot flagged this pattern unprompted on two of eight cases (C07, C08), so it is visibly wrong to a careful reader | none needed — this is the status quo |
| b | distinguish WHICH bound is pinned; block only on decision-relevant ones | removes wind/shear nuisance pins from the block | **changes nothing on any case in this set (0/28)**; the balloon reps that carry wind pins are independently blocked by `incomplete` or `close`. It is a cosmetic fix that would be mistaken for a real one | already settled by the replay in section 4: measure any variant's verdict deltas offline before implementing it |
| b' | classify each bound as SEARCH-BOX vs PHYSICAL ENVELOPE and split the blocker text: an envelope pin becomes a substantive class *exclusion* ("requires range/speed outside the multirotor envelope"), a search-box pin stays procedural | the honest wording fix. Today one string covers three unrelated conditions (unconverged optimizer, arbitrary box edge, model envelope exceeded), and only the third is a finding | requires a per-bound declaration in every model's `getParameterDefs`; some bounds are genuinely hybrid (the quad's 20 km is both a search-locality choice and a near-field claim). Mislabelling a box edge as an envelope would manufacture false exclusions | inspect each model's bounds against its documented physical envelope; no re-run needed for the classification itself |
| c | auto-widen and re-fit when a pin is detected, then re-screen | the only option that answers the question the pin poses ("is the optimum outside the box?") instead of declining to answer it | cost: an extra physics fit per pinned model (the quad fit is the slowest phase of the analysis — `src/TraverseBattery.js:676-686`). Worse, widening a bound **changes what the class means**: a multirotor admitted at 40 km is no longer the class whose viability was asked about. Needs a re-screen against the ORIGINAL envelope after the widened fit, or it silently redefines the catalog | the experiment in section 6 |
| d | surface the fit as a lower-confidence tier rather than withholding it | recovers the yield on `dash` without weakening the class contract, and is the only option that also reaches the `rubberduck-drone` case, where nothing is pinned at all. The vocabulary already exists at tile level ("Not fully tested", `src/TraverseRanking.js:407-431`) and in the signature (`bands: {"quadcopter\|": "boundary"}`); it is the executive layer that has no tier below `consistent-one` | a new verdict code is a public-surface change (interchange signature, dossiers, `scoreInterchangeVerdict.mjs`). The real risk is that a lower tier reads as a conclusion anyway — `hypersonic-glide` would emit "multirotor, boundary-limited" at 116 km error, and F2 already measured that the more committed code was the less reliable one on this set | score a proposed tier against all 28 records for how often it fires on a >50% relSep case; the harm is countable offline |

A combination is available and is what the evidence points at: **b' + d**. Split
the blocker so the three conditions stop sharing a sentence, keep envelope
exclusions blocking class viability (they are findings, not gaps), and give the
executive layer a channel for "the geometry is determined even though no class is
confirmed". Neither half requires widening any model's envelope.

## 6. The experiment that would decide it

**Widen-and-refit probe over the pinned records.** Scope it to the 11
range-pinned model instances (across 6 records: `dash` x2, `straight-ca`,
`turn90-instant`, `highg-turn`, `hypersonic-glide`) plus `gofast`'s
`vRise (max)` lantern, which is the remaining pin-only-blocked representative.
Do not re-run whole scenarios.

For each pinned model instance, re-run *only* that fit with the pinned bound
relaxed by a factor of two (quad `initialRange` max 20 000 → 40 000 and min
50 → 25; lantern `vRise` max doubled), with everything else — seeds, DE
population, generations, `fitMaxDt` — held. The fits are deterministic
(`mulberry32`, `src/DifferentialEvolution.js:12-19`), so the comparison is exact.
Record for each: does the pin clear; the new `errDeg`; the new solved parameters;
`truthSepM`; and whether the solution lands inside or outside the ORIGINAL
envelope.

The discriminator:

- **Settles interior, similar residual** → the bound was a search-box artifact
  (or a 1-D probe artifact of the range/speed correlation). The block was a false
  alarm; option (c) is safe and (b') should classify that bound as SEARCH-BOX.
- **Runs to the new bound, or improves the residual materially while leaving the
  original envelope** → the class is genuinely excluded. The block is correct but
  the wording is not: the blocker should read as an exclusion, and the recovered
  trajectory should still reach the analyst — options (b') and (d), not (c).

Prediction, stated in advance so the result can falsify it: `dash`'s
`initialRange (max)` will run to the new bound (truth is outside the 20 km
envelope by measurement) while `speed (max)` will settle interior once range is
free; `hypersonic-glide`'s `initialRange (min)` will run to the new near bound
and land further from truth. If that is what comes out, the answer is b' + d and
NOT (c).

Cost: twelve model fits. The scenario-level cost for reference is
`timingMs: 77 949` for the whole `dash` analysis, of which the quad fit is one
phase. Harness: `npm run bench-bot-tract` with `BOTBENCH_TRACT_SET` /
`_OFFSET` / `_LIMIT` already chunks by scenario; the probe needs a small
dedicated runner rather than a full re-run.

## 7. Honest limits of this diagnosis

- Single seed per scenario. Every rate here is about these 28 realizations, not a
  population. The pin-side discriminator in section 4 rests on n = 3 range pins.
- The offline replay reproduces the shipped verdict codes 28/28, but it
  approximates `scoredErrDeg` with the raw `errDeg` for class representatives.
  No representative in this set is ray-constrained (`groundVehicle` never
  appears), so the approximation is exact here and would not be in general.
- No fit was re-run for this diagnosis. The claim that `speed (max)` is a
  coupled-parameter artifact is a mechanism argument supported by the truth's
  measured speed profile, not a measurement of the fit. Section 6 is what would
  test it.
- Truth speeds in section 3 were computed by finite-differencing the loaded
  segment (`loadSegment` for `drone_px4_0de00c98.csv`, rule `peak-speed`, window
  start 294.674 s, 30 s at 10 fps) in a scratch script outside the repo; the
  numbers are reproducible from that call but are not currently produced by any
  harness. That load reproduced the record's own provenance (window start
  294.674 s, 119 bridged steps), so it is the same truth the record was scored
  against — worth re-checking once F7's minimum-displacement bridge guard lands,
  since it changes which steps are bridged on this file.
- `dash`'s fixed-wing class is blocked by a different rule entirely
  ("trajectory passes below the sampled terrain", `aircraft` at 0.086 deg,
  52 km from truth). For a VTOL in 40 m/s forward flight that is plausibly the
  better class description, and releasing the multirotor pin would hand the
  scenario a `consistent-one: multirotor` verdict with the fixed-wing reading
  still suppressed. The below-terrain blocker is a separate yield question — the
  escalation pilot's C04 raised it independently — and is out of scope here.
