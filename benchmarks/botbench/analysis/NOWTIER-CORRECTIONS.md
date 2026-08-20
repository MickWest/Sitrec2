# Near-term tier — corrections queued from the execution review (2026-08-15)

An independent execution review of the six near-term work packages ran while they
were being implemented. Four of its findings land AFTER the packages, either
because they correct a premise the brief got wrong or because they are couplings
the parallel launch ignored. They are recorded here so none of them is lost, with
what to do and why it matters.

## C1 — RESOLVED ON INSPECTION: the implementation did not follow the wrong brief

**Status (checked 2026-08-15, after the package landed): largely moot.** The
correction below stands as written, but `lib/crlbTriage.js` did not implement
the flawed instruction. It derives `rangeObservable` from whether the Fisher
information is finite along the range direction — the STRUCTURAL test this
correction asks for — and reports "no sample count helps" exactly when that
information is singular. What remains is a practical threshold, not a limit
claim: a case is also labelled geometry-limited when reaching the target
precision would need more than a stated factor more samples, which is a
declared operational cutoff and is documented as one.

That is worth recording as evidence about briefing practice rather than about
the code: the brief specified a wrong method, the package was also told the
trap the task had to avoid, and the trap won. The remaining action is
documentation only — state in the module that the two geometry-limited paths
are different claims (one structural, one operational).

## C1 (original text) — The "geometry floor" in the precision score is not a floor

**The brief was wrong.** Work package C was asked to compare predicted fractional
range error at the current sample count against its value "as N tends to
infinity at fixed geometry", and to call the latter a geometry floor. For
independent per-sample noise there is no such floor: the Fisher information adds
across samples, so an identifiable model's bound tends to zero. The comparison as
specified always reports "noise-limited", which is exactly the label that would
tell an escalation tier to go collect more data — the most expensive wrong answer
this score can give.

**The correction, in two parts.**

1. Replace the limit test with a STRUCTURAL test: form the Fisher information at
   the assumed trajectory and examine its rank and null space in the range
   direction. A geometry is "geometry-limited" when the information matrix is
   (numerically) singular along range — no quantity of samples repairs a
   direction the geometry never observed. That is a property of the design, not
   of N, which is why it is the right test.
2. Where a finite comparison is still wanted, declare it honestly: a DENSE
   SAMPLING model over the SAME observation window (the same arc, sampled more
   finely), not N to infinity. Report it as "what denser sampling of this same
   pass would buy", which is the operationally meaningful question.

Also from the same review: min/median/max over a hypothesis grid inherits the
arbitrariness of the grid's bounds and density. Report per-grid-point values, or
quantiles under a declared weighting, and state the grid bounds beside the number.

Alongside the score, always report: the assumed class, the grid bounds and
measure, the noise source and its correlation assumption, the information
matrix's rank and spectrum, any active bounds or priors, and the sentence that
this is a local model-based lower bound for a correctly specified model — not an
expected error and not a precision guarantee.

## C2 — Nested conditioning can be fooled by rescaling (blocking for the stack)

Work package A builds a nested design (constant velocity, plus acceleration,
plus jerk) and reads conditioning off each. An overall conditioning number on the
nested matrix can call a higher order "observable" merely because column
equilibration rescaled it. The defensible quantity per added order is the
RESIDUALIZED INCREMENTAL singular value: how much new information the added
columns carry after projecting out the span of the lower-order ones. Until each
order has outcome labels of its own, higher-order gates are provisional and must
say so where they are printed.

On recalibration: anchoring the new statistic against the legacy one on 26
scenarios establishes a mapping, not a calibration. The defensible version
recomputes both statistics over the stored 855-scenario sightline sets and fits a
grouped, cross-fitted curve against their existing collapse outcomes. That is a
batch job over stored data — no fit sweep needed — and it is the next step for
this package.

## C3 — Repairing the ingest invalidates the existing records (sequencing)

Work package D adds a minimum-displacement guard to the datum-step bridge. That
changes the truth track for any scenario whose source log tripped the old rule,
which the audit showed includes the dash and circuits segments. Every measured
record for those scenarios was computed against the OLD truth.

**Action:** version the ingest and splice policy, then regenerate the affected
tractability records before any further analysis quotes them. Paired seeds and
timestamps must be preserved so the anomaly pairs stay comparable. Until that
rerun lands, any number drawn from those two scenarios is stale.

## C4 — Analysis discipline for the paired and routed sections

Three constraints on work package E's new sections, all of which bound what may
be claimed rather than what may be computed:

- The paired contrast is valid for a predeclared BINARY endpoint with declared
  tie handling. Predeclare it; report discordant counts with exact intervals.
- Anomalous pair members must never enter a calibration or null pool. A detector
  calibrated on data containing the thing it detects is calibrated on nothing.
- A risk-coverage curve swept over the same 26 records that would choose the
  operating point is descriptive only, and can manufacture an attractive point
  by construction. Threshold SELECTION belongs on cross-fitted curves over the
  855-scenario set; the 26-scenario curve is labeled diagnostic.

## C5 — The yield defect may be correct behavior (framing for package F)

The review's independent read agrees with the caution already in F's brief: a fit
that lands close to truth can still be operationally unsafe when its optimum
pins a bound, because proximity to truth is not evidence available at decision
time. The distinction to establish is between an ARTIFICIAL search-box pin and a
PHYSICAL domain violation, recording which bound was active and the boundary
gradient evidence. Relaxation should be proposed only where the same solution
survives expanded bounds and independent restarts with convergence evidence.

## C6 — The lantern wind bound is a box where the physics is a circle

**An artificial search-box pin, in C5's terms, and it now has the evidence C5
asks for.** `SkyLanternModel` bounds `windE` and `windN` independently at
±20 m/s. A per-component box makes wind of magnitude b reachable from EVERY
bearing but b·√2 only on the diagonal — 39 kt omnidirectional against 55 kt
diagonal. The reachable set is a square; the physical quantity is a magnitude,
which is a circle. The corners are the only place the advertised envelope exists.

Measured on `botset_balloons_orbit/batch_20s/0pct`, r3.219 km, steady wind: the
true wind is 21.5 m/s on bearing ~68°, which needs `windE` = 20.0 — exactly the
ceiling. The pin is recorded as `windE (max)`. The wind's MAGNITUDE (41.9 kt)
sits comfortably inside the envelope the model intends; only its direction makes
it unreachable. That is the definition of an artificial pin rather than a
physical domain violation.

**C5's relaxation test is satisfied.** The same solution survives expanded
bounds: at ±20, ±23.2, ±30 and ±40 the shipping (seeded) fit returns the
identical answer — residual 0.000000°, range 6345 m against a truth of 6356 m,
relSep 0.00015. The pin disappears at ≥23.2 and nothing else moves.

**DECIDED: the box was widened to ±40 m/s**, matching `FixedWingModel`, with the
bound's ROLE changed from physical envelope to search range. The reasoning
against a narrower value is recorded because it constrains any future revision:
the intermediate window, 23.15–23.6 m/s, is mostly a knife-edge for the
model-level recovery test, which flips on 0.05 m/s steps (23.15 fail, 23.2 fail,
23.25 fail, 23.3 pass, 23.4 pass, 23.5 fail) while 20/21/22/26/30/40 all pass.
Selecting a value because it is green would have been tuning a physical constant
to a test.

**What widening costs, stated rather than glossed.** The diagonal now admits
110 kt, which is not lantern-like, so the box no longer excludes non-lantern
motion — `SkyLanternModel.test.js` was rewritten to say so instead of asserting a
guarantee that no longer holds. Exclusion rests on the `extraCost` speed prior
and the kinematic ordinariness screen. Measured over the same 43 scenarios, the
change moved two verdicts (one mundane balloon gained the balloon class, one
lost it) and left the anomalous false-positive rate at 2/15. `topRelSep` moved on
seven files: one improved from 0.146 to 0.00010, one degraded from 0.00001 to
0.044, the rest marginally. In aggregate close to a wash; on the file that
prompted it, the balloon class is now viable with relSep 0.00001.

**STILL OPEN — the fix is a magnitude constraint**: reparameterise the wind as
speed and bearing with the speed bounded, or keep a generous box and carry the
limit as a magnitude penalty. The reachable set then matches the physics, the
corner-cutting disappears, and the exclusion the box used to provide can be
restored honestly at the magnitude where it belongs. Widening to ±40 removes the
pin; it does not make the shape right.

**One caveat on the knife-edge, which is a separate finding.** It lives entirely
in the UNSEEDED path: the model test's `fitLantern` helper starts from the
parameter defaults, whereas shipping seeds via `seedFromTrack` (see
`TraverseBattery`). The seeded path was stable across every bound tried. The
unseeded fragility deserves its own look — a fit that marginal is passing by
luck — but it does not affect shipping results.

## C7 — One ranking regression from the completeness fix

Treating a collapsed simplex as convergence (`localFitCompletionWarnings`) was
measured over 43 scenarios and moved six, all mundane balloons, all toward the
correct class; the anomalous false-positive rate was unchanged at 2/15. Because
the flag also feeds `plausibilityRating`'s `eligible`, five files improved their
top candidate's `topRelSep` by roughly three orders of magnitude — the
incompleteness stamp had been demoting the most accurate fits out of the top
slot.

**One file moved the other way**: `anom-figureeight-implausible` went from
`topRelSep` 0.051 to 0.187. Its verdict is unchanged and still correct
(unresolved, no viable class), so nothing user-facing is wrong, but its
top-ranked candidate is 3.7× further from truth than before.

The likely mechanism is that a previously-ineligible fit is now eligible and
outranks the more accurate one under the display-score comparator. Worth
resolving before the RANKING (as distinct from the verdict) is trusted on
anomalous files, since that is precisely where the ordering carries weight.
