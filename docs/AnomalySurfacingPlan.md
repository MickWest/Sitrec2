# Anomaly Surfacing in Traverse Analysis — Implementation Plan

> **Status (2026-07-19).** This is a design/planning document, not a record of
> shipped work. Of the pieces below, the **fitRank / ordinariness split** in
> `TraverseRanking.js` (§1 "Grafted in") **is shipped** — a candidate's tier now
> names whichever of fit quality or kinematic ordinariness is binding. A related
> but distinct mechanism not described here has also shipped: a **balloon-
> consistency ranking nudge** (`balloonConsistency` in `TraverseRanking.js`) that
> boosts a *Physically based* balloon whose fitted motion is genuinely balloon-
> like and demotes one that is not — a bounded within-tier tie-break, not an
> anomaly gate. Of the four Milestone-1 prerequisites, fixed-wing prior
> disclosure and duration-scaled drone knots have shipped, as has knot-count-
> invariant speed/climb effort; cross-model turn-prior calibration, seed-relative
> drone effort, and envelope-relative climb pricing remain planned. The core
> **Envelope Feasibility Profile** (`EnvelopeFeasibility.js`, Milestone 0 onward)
> and the `DwellDashModel` are **not yet built**. Treat the rest of this file as the intended
> direction, and verify against the code before relying on any specific claim.

## 1. What is being built, and what is deliberately not

**Primary mechanism: the Envelope Feasibility Profile (EFP).**

An anomaly claim is made *only* as a statement about the **catalogue**, computed from range geometry:

> Over every admissible range, the least-demanding trajectory the sightlines allow still requires speed / climb / sustained g outside **every single airframe envelope** in `src/VehicleModels.js`.

That is falsifiable by naming an aircraft. It needs no noise model, no null distribution, no prior relaxation, and has no unpriced optimiser direction to game. It is what two of the four adversarial critiques independently converged on as the only surviving construct, and it is what the other two designs' conjunctions collapse to anyway.

**What was considered and is being dropped, with reasons:**

| Dropped | Why |
|---|---|
| Structured-residual anomaly verdict (SR / F-test / whiteness gate) | The F-test is invalid under the coloured noise the design itself posits; there is no model-adequacy tolerance, so SR → ∞ as data quality improves; a `structured` mundane residual is the normal case (camera pose error is autocorrelated). Fires on prior-straightened aircraft, not on anomalies. |
| Priced/unpriced twin fits + exchange rate | `R = ΔErr/ΔPrior ≤ 1` by construction for any converged priced fit — the cost function already fixes the rate at `errSigma`. The gate is algebraically inert and duplicates the cross-polish check. |
| `priorScale = 0` / "prior sigma ×5" wall probes | Re-opens the exact 4.7 rev/s quadcopter degeneracy that was just closed, and deletes *evidence* priors (measured winds-aloft) alongside *taste* priors. |
| `gfPolyALS` order-5 as a data-quality floor | 18 coefficients cannot represent an orbit over an 11-minute clip, and it minimises metres-perpendicular, not angle — a near-collapsed solution reads as a small floor. |
| Capability/habit static term map + capability debt column | The capability column is empty: capability is expressed as **hard bounds** in this codebase, habit as soft cost. `min capabilityDebtDeg ≈ 0` unconditionally, so the verdict can never fire. |
| A sixth "Anomalous" gallery category | A category is always populated and therefore carries no information — the failure mode of the current `Implausible` tier. Use a **flag that is usually absent**. |
| Odd/even cross-validation | At 30 fps with multi-second knot spacing, no model in the set can distinguish odd from even frames. In-sample ≡ out-of-sample. |

**Grafted in, because they genuinely compose:**

- The **fitRank / ordinariness split** in `TraverseRanking.js` — this, not any detector, is what makes a well-fitting energetic solution visible at all.
- A **`DwellDashModel`** — as a *mundane* forward model, closing a real coverage hole (nothing in the set can express hover-dash-hover, the most ordinary drone behaviour there is).
- **Signed residual components + a truth-measured noise figure**, as *disclosure only* (an "inconclusive (noise-limited)" badge), never as an anomaly gate.
- The four **prerequisite prior repairs**, which are independently correct bugs.

## 2. What is fundamentally not solvable

**Distinguishing "anomalous" from "a mundane object my catalogue does not contain" is impossible inside this subsystem.** They are the same measurement. No statistic, ledger, holdout, or residual structure separates them; only adding models does.

Consequently the verdict is never worded "anomalous". The strongest thing the system may ever print is:

> **Exceeds every catalogued envelope** — at every distance the sightlines allow, the least-demanding path requires ≥ *X* kt / ≥ *Y* g / ≥ *Z* m/s climb. No airframe in the catalogue can fly it. This is a statement about the catalogue, not about the object.

Additionally not solved, and must be stated in the UI rather than buried:

- **Smooth, wrong LOS** (slowly drifting camera attitude, timing offset, FOV scale error) is indistinguishable from smooth object motion. Provenance flags (`provenance.circular`, `rangeUnobservable`, `azSweep`) are the only defence and they are incomplete.
- The forward-model set currently has **zero coverage of "far AND manoeuvring"** (fixed-wing turn cage ±4 °/s, quad ≤ 20 km, lantern ≤ 30 km). Until that is filled, an EFP infeasibility that lands in that region must be reported as **`coverage-gap`**, not as an envelope claim.

## 3. Milestone 0 — the falsifiable first step (small, standalone)

**New file: `src/EnvelopeFeasibility.js`** (pure, DOM-free, jest-testable).

```js
export const EFP_G_MARGIN      = 1.15;   // charity factor on peak g
export const EFP_SPEED_MARGIN  = 1.10;   // charity factor on peak speed
export const EFP_CLIMB_MARGIN  = 1.25;   // charity factor on climb
export const EFP_MIN_FEASIBLE_RANGES = 1; // ≥1 feasible range ⇒ no claim

// violation of one summarised metric set against ONE catalogued envelope,
// in normalised units (0 = inside the envelope)
export function envelopeViolation(metrics, envelope) -> {
    speedOver, climbOver, gOver, altitudeOver, total, binding: [names]
}

// min over EVERY single envelope in FIXED_WING_MODELS ∪ QUADCOPTER_MODELS,
// EXCLUDING the two `auto` pseudo-entries (a union of disjoint envelopes is
// not a realisable envelope — see §7)
export function bestEnvelopeAt(metrics) -> {model, violation}

// the profile: one row per range on the existing grid
export function envelopeFeasibilityProfile(rangeProfileRows) -> {
    rows: [{startDist, bestModel, violation, feasible}],
    feasibleRanges: [...],
    minViolation, minViolationRange, minViolationModel,
    infeasibleEverywhere: boolean,
}
```

Inputs come from the **existing** `rangeProfile()` (`src/TraverseAnalysis.js:1503`), which already returns per-range `metrics` from the *least-manoeuvring* ray-consistent track at that range — the charitable choice, exactly right for an infeasibility argument.

Two charity requirements, both load-bearing:

1. `trackMetrics` works in the **air frame** (wind subtracted). For a hover-capable multirotor the relevant envelope test is **ground-relative**. Compute both metric sets and take the **lower** violation. A wind-drifting balloon must never read as infeasible because its air-relative speed is ~0 while its ground speed is 20 kt.
2. `metrics.gLoad` is ~1 s smoothed, so peak g is *understated*. That biases toward feasible — i.e. toward not claiming — which is the correct direction. Document it; do not "fix" it.

**Wiring for M0: none beyond one line.** Call `envelopeFeasibilityProfile()` in `runTraverseAnalysis` after the existing range profile is computed, and attach the result to the analysis manifest under `assumptions.envelopeFeasibility`. **No gallery change, no ordering change, no badge.**

### Falsification runs (this is the gate on proceeding)

| Sitch | Required result |
|---|---|
| **Generated Orbit Test** (mundane, truth available) | `infeasibleEverywhere === false`; a multirotor envelope (`racer`/`djifpv`/`air3`) feasible at or near the true range. |
| **agua** (mundane, parallax/lantern) | `infeasibleEverywhere === false`; feasible at short range. |
| **GoFast** | `infeasibleEverywhere === false`. |

If either of the first two reports `infeasibleEverywhere`, **the metric is wrong and the plan stops here.** That is the point of M0: it can fail cheaply and visibly, before any UI, verdict, or model work exists.

**Tests (`tests/EnvelopeFeasibility.test.js`):**
- `envelopeViolation` returns 0 for a 15 m/s / 3 m/s-climb track against `air3`, > 0 against `mini4`.
- `bestEnvelopeAt` never returns an `auto` entry.
- Synthetic profile with one feasible range ⇒ `infeasibleEverywhere === false`.
- Synthetic 800 kt / 12 g profile at all ranges ⇒ `infeasibleEverywhere === true`, `binding` names `speed` and `g`.
- Ground-vs-air charity: a pure wind-drift track with 0 air speed and 20 m/s ground speed is feasible.

## 4. Milestone 1 — the four prerequisite prior repairs

Each is an independent bias generator and should land as its **own commit**, so regression-baseline movement is attributable. Current status, verified against source:

1. **Shipped — `fitAircraft` prior disclosure.** The return value now itemises straight-flight, level-flight, cruise-speed, and ground terms in the same `{total, terms}` schema used by the other physics fits, with regression coverage in `tests/PhysicsPriorDisclosure.test.js`.
2. **Planned — cross-model turn-rate calibration.** Turn pricing remains incoherent across `FixedWingModel`, `DroneControlFit`, and `QuadcopterModel`. Add a shared duration-invariant `turnEffortCost` and call it from all three sites, including the inline `fitAircraft` cost.
3. **Shipped — duration-scaled drone knots.** The gallery construction now calls `knotsForDuration(clipDurationSec)` instead of hardcoding K=4, so long clips retain maneuver resolution.
4. **Partly shipped.** Drone speed/climb change effort is now knot-count-invariant total variation. Seed-relative effort and envelope-relative fixed-wing climb pricing remain planned.

**Test:** a 3 °/s standard-rate turn must cost < 0.05° of fit budget in *every* model. Cross-model: a 20 °/s sustained turn costs the same within 10% across all three.

## 5. Milestone 2 — the ranking split (this is what actually surfaces findings)

In `src/TraverseRanking.js`, split `plausibilityRating`'s single `rank`:

- **`fitRank`** — residual, convergence, active pins, boundary limits. Orders the flat gallery.
- **`ordinariness`** — the existing `gMax > 1.5 / 4 / 9`, `speedMaxKt > 650 / 900` caps, now **annotating** rather than screening.

Split rank 0: a candidate failing *only* on kinematics with a small residual gets `{label: "Kinematically extreme", rank: 0, extreme: true}` in its own colour. `passedScreen` in `makeComparator` treats `extreme` as passing, so "the sightlines require 12 g" is no longer sorted below "this fit diverged" — they are currently the identical badge and the identical position.

`rankTieScore`'s `straightFlightScore` term stays for `RAY_KEYS` and the `gf*` approximations (which carry **no** in-fit kinematic prior, so it is the only "plausible not merely possible" pressure they have) and is **subtracted out for `FORWARD_KEYS`** by the model's own disclosed `priors.total` in degrees — so manoeuvre is charged once, not twice.

**Tests:** extend `tests/TraverseRanking.test.js` — a 12 g / 0.01° candidate must outrank a 1 g / 0.49° candidate; a corkscrewing order-5 polynomial must still lose to a clean balloon at equal residual.

## 6. Milestone 3 — `DwellDashModel` (mundane) and the noise badge

- **`src/DwellDashModel.js`**: hover → dash → hover, `[initialRange, hoverOffset, dashDir(2), dashSpeed, t1, t2, tau]`, tanh transitions. Registered in `FORWARD_KEYS`, categorised **Physically based**, priced with `TurnPrior` and the quadcopter speed envelope. `tau` and `dashSpeed` **must** be wired into `assessBoundPins` — a pinned `tau` reported as "41 g in 0.34 s" would be the quadcopter-spin bug wearing a new hat.
- **`losResidualVectorDeg(dataset, track)`** in `src/EnvelopeFeasibility.js`'s sibling `src/TraverseResidual.js`: signed cross-track and vertical components (the existing `losErrorSeriesDeg` at `AnalyzeTraverse.js:5350` is an unsigned `acos`). Used for the residual chart and one badge only: **`Inconclusive (noise-limited)`**, set when the residual spread across all hypotheses is smaller than the measured per-clip angular scatter. This is the system's first honest "we cannot tell" state and it is worth shipping on its own.

**Calibration study, run once, no shipped code:** on any synthetic sitch with `analyzeTweaks.truthTrack`, compute `losResidualVectorDeg(dataset, truthTrack)`. That is the residual of a *perfect* model — the true noise floor, measured not estimated, magnitude and spectrum. Everything the badge threshold claims must be checked against it. If truth's own residual is already strongly autocorrelated (I expect it is, from camera pose error), that permanently closes the door on any whiteness-based verdict and the finding should be written into a comment.

## 7. Milestone 4 — the verdict, and only then

`sceneEnvelopeVerdict(efp, provenance, solutionSpace, hypotheses)` in `src/EnvelopeFeasibility.js`, returning one of:

- `feasible` — some catalogued envelope works at some range. **The overwhelming default.**
- `not-assessable` — `provenance.circular`, `rangeUnobservable`, `azSweep` below the degeneracy threshold, or `analyzeSolutionSpace().degenerate`. Hard veto, evaluated first.
- `coverage-gap` — infeasible everywhere, **but** the binding requirement falls in the known model-set hole (far + manoeuvring). Reports the missing model as a specification.
- `exceeds-catalogued-envelopes` — infeasible everywhere, provenance clean, requirement outside the hole, and the leading hypotheses are converged.

Never `anomalous`. Single-airframe comparison only — the union of an F-16 and a hovering quad is not a flyable envelope, and a track that hovers then does 500 m/s is inside the union and inside nothing real.

**Tests (`tests/EnvelopeFeasibilityVerdict.test.js`)** plus fast-regression scenarios:
- Generated Orbit Test ⇒ `feasible`. A truth-known mundane scene returning an envelope claim falsifies the design.
- agua ⇒ `feasible`.
- Circular-provenance sitch ⇒ `not-assessable`, regardless of profile.
- **Positive control**, built with the existing synthetic-truth pipeline (`project_video_csv_truth_generation`): generate truth at ~20 NM, 800 kt, 12 g sustained; export MISB; re-import; assert `exceeds-catalogued-envelopes` or `coverage-gap`. `feasible` here is a failure. *This is the only test that proves the verdict is reachable at all* — three of the four source designs had no such test.
- **Graceful degradation**: same anomalous truth with rising injected tracking wobble must walk `exceeds-catalogued-envelopes` → `not-assessable` / noise-limited. It must never flip to a confident mundane answer.

## 8. What the user sees

Gallery ordering stays flat best-first with coloured category corner labels. Anomaly surfacing adds **no sixth category**.

**A tile gains a corner chip only when it applies:**
- `Kinematically extreme` (amber) — fits well, requires energetic motion. Purely descriptive, no verdict implied. This alone fixes the "12 g fit buried below a diverged fit" problem.
- `Outside DJI Air 3 envelope` — the named binding envelope, from `classifyFixedWing` / `classifyQuadcopter`, in the details pane.

**A scene banner appears above the grid only in the non-default cases:**

> **Exceeds every catalogued envelope.** Between 3 and 90 NM, the least-demanding path consistent with these sightlines requires at least **480 kt** and **6.2 g sustained**. No airframe in Sitrec's catalogue can fly that at any of those distances.
> This is a statement about the catalogue, not a conclusion about the object. A vehicle Sitrec does not model would produce the same result. Sensor pointing error that drifts smoothly over the clip would also produce it.

and for the coverage case:

> **Coverage gap.** The sightlines require something fast *and* far. Sitrec's forward models do not reach that region (fixed-wing turning is capped at ±4 °/s; multirotor range at 20 km). No conclusion is available.

Wording rules: never the word "anomalous", "unexplained", or "unidentified"; always a number with units and a named catalogue; always the falsifier ("name an aircraft that does this"). A claim a reader can check is a claim that cannot cry wolf.

## 9. Honest bottom line

**How much confidence should a positive `exceeds-catalogued-envelopes` verdict carry? Low — it is a lead, not a finding.**

Concretely, it licenses exactly this: *given Sitrec's LOS reconstruction, its range grid, and its aircraft catalogue, no catalogued airframe fits at any distance.* It does **not** license "this object is anomalous", because three unresolved confounders sit underneath it, in descending order of how often they will bite:

1. **A mundane vehicle outside the catalogue** — unsolvable here, by anything. Only more models help.
2. **Smooth LOS error** — camera attitude drift, timing offset, FOV scale. Indistinguishable from smooth object motion by construction; only provenance guards it, and provenance is incomplete.
3. **Range-grid and model-set holes** — routed to `coverage-gap`, but only where the hole is known.

What would raise confidence, in order of value per unit of work:

- **Fill the far-and-manoeuvring coverage hole.** Every `coverage-gap` that becomes a real fit is a false lead removed. This is the single highest-value follow-on.
- **Independent LOS validation** — a second sensor, a star/landmark calibration, or a known-object cross-check in the same clip. This is the only thing that touches confounder 2, and it is worth more than every statistic in the four candidate designs combined.
- **A measured mundane corpus.** Run M0's profile across every mundane sitch available and record the distribution of `minViolation`. Until that distribution exists, the feasibility margins (`EFP_*_MARGIN`) are guesses, and guessed constants are precisely the disease the bias map indicts in the existing `1.5 / 4 / 9 g` tiers.
- **Broaden the catalogue** with sourced envelopes and cite them, so "name an aircraft that does this" is a question with a documented answer space.

Until at least the first and third of those exist, the correct posture is that this feature **surfaces cases worth a human looking at**, and nothing stronger. Its main value is not the rare positive verdict; it is Milestone 2, which stops the system from burying a well-fitting energetic solution under a diverged one, and the `Inconclusive (noise-limited)` badge, which lets the tool admit for the first time that it cannot tell.
