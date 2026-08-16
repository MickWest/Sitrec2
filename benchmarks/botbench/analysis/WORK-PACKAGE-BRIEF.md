# How to brief a delegated work package (v2.1, 2026-08-15)

A template for specifying work handed to a parallel worker on this benchmark.
Derived from a round of seven packages, critiqued by two independent reviewers,
revised, then tested on two further packages.

**It has two layers, and both are load-bearing.** Blocks 1-7 and the report
schema are GENERIC: they protect the process, and they are what stopped a
planted false premise twice in the retest. Block 8 is SPECIFIC to bearings-only
tracking: it protects the science, and it is the half a worker cannot
reconstruct from the code in the time available. A round that gets the process
right and the domain wrong produces well-evidenced wrong answers — this project
has published three findings it later had to retract, and every one of them
failed on a block-8 rule, not a process rule.

**Two audiences.** The maintainer reads this whole file. A worker reads only the
brief it produces — so the `Rationale` notes are for the maintainer and must not
be pasted into a worker brief. Fill the blocks in the order given: a worker that
truncates its attention must hit the contract before the background.

---

## Part 1 — The brief, in order

### 1. The task, as a problem

What is wrong and why it matters, with the mechanism if it is known. Not a
specification to type in.

*Rationale: a worker that understands the failure designs past it; a worker
given a spec implements the spec, including the parts that were wrong.*

Mark every substantive claim inline, at the point of use, as **[VERIFIED: how]**
or **[ASSUMED]**. Do not collect the marks into a separate list — a label beside
the claim it qualifies gets read; a table of labels gets skipped.

### 2. Acceptance, and the goal it serves

- **Goal**: the outcome in one sentence.
- **Anti-goals**: what must not happen even if it would satisfy a criterion.
- **Must-not-regress**: named invariants, with how to check them.
- **Criteria**: each an OBSERVABLE, never an activity. "Done" is never "the
  module is written"; it is "this quantity is measured over these records and
  the number is in the report."
- **Frozen inputs and oracle**: the exact record set, and the check that decides
  the answer. Name it here so the worker cannot choose it later.
- **Standing rule**: passing a metric never excuses violating the goal. If the
  two conflict, report the conflict.

Where the change alters existing behaviour, name the record set and match
tolerance, then require:

> Before claiming any change, reproduce the current behaviour on the full record
> set named above, at the stated tolerance, and report the reproduction rate
> over that fixed denominator. Records you exclude or fail to reproduce go in
> `whatIsUnverified` with reasons; they do not shrink the denominator. A
> counterfactual is only as good as the baseline it departs from, and a baseline
> is only as good as the denominator it is measured over.

*Rationale: acceptance stated late arrives after the framing has set. The one
package that reproduced its baseline first (28 of 28) produced the round's only
conclusion strong enough to overturn a prior finding. The fixed denominator
closes the obvious dodge — reproduce 25 of 28 and report "100% of comparable".*

### 3. The named trap for THIS package

One sentence naming the specific way this task goes wrong. Examples that worked:
"a predicted-precision score that peeks at truth"; "a noise estimator that eats
real target dynamics and calls them noise."

*Rationale: one specific trap gets attended to; ten generic warnings get
skimmed. Given the first example, a worker returned a module structurally
incapable of accepting truth — stronger than the instruction asked for, and it
survived a wrong method in the same brief.*

### 4. Ownership, scope, and neighbours

- **Owned files**: the explicit list. Nothing outside it may be edited.
- **Owned means permitted, not requested.** Every changed hunk must map to a
  task requirement. No unrelated refactoring, cleanup, renaming, reformatting,
  or generated churn.
- **Do not weaken any pre-existing test, fixture, dataset or assertion.**
  Disclose every test change with its before and after behaviour, and
  demonstrate acceptance on at least one check you did not author.
- **Neighbours**: who else is running and what they are changing. If your inputs
  include anything a neighbour owns, pin the version you built against in your
  report and add a `followUps` entry to re-run when theirs lands. Never copy a
  neighbour's in-flight values into owned files.
- **Consumer**: what will consume this work. If nothing will, say so and say
  when it will — or the package is not ready to run.

*Rationale: the consumer bullet is a gate on the MAINTAINER, not the worker. Two
packages in the round shipped modules nothing consumed, which cost an extra
harness to wire afterwards. The neighbour protocol answers the measured case of
one package consuming thresholds another was concurrently redefining.*

### 5. Challenging the brief

> If any claim in this brief — VERIFIED or ASSUMED — is contradicted by what you
> find, stop and report the contradiction at the same evidentiary standard as
> anything in `whatWorks`. That report is a COMPLETED package, not an aborted
> one: a brief that describes the system wrongly is a defect in the brief, and
> finding it is the deliverable.
>
> Before challenging: restate the disputed claim, give a minimal reproducible
> contradiction, check one plausible alternative reading of the claim, and say
> which unaffected work can still continue. Stop on evidence, not suspicion.
> Do not implement around a false claim.
>
> Before building on any claim your work depends on, spend the cheap check that
> would confirm it. A VERIFIED mark records how the briefer checked; it is not a
> guarantee.

*Rationale: the costliest failures in the round were confidently wrong premises,
and confidence is exactly the state in which a briefer writes VERIFIED — so the
stop rule cannot be scoped to ASSUMED only. The framing matters as much as the
rule: to a worker pattern-matching on tone, "abort" reads as failure and
"completed package" reads as success, and that word choice is most of the
incentive. The restate-and-repro protocol is the counterweight, so the rule
cannot become an exit hatch from a hard task.*

### 6. Where something existing is being judged

> State the competing hypotheses and evaluate the current and the proposed
> behaviour against the SAME invariants, the same evidence standard, and the
> same strongest disconfirming test. Argue the case for the current behaviour as
> strongly as the evidence allows. If it turns out to be correct, that is a
> complete and valuable answer.

*Rationale: the one-sided version of this clause overturned an incorrect
headline finding in the round, so it stays — but a reviewer correctly warned
that arguing only FOR the status quo anchors toward preserving broken behaviour.
Symmetry keeps the engagement and removes the bias.*

### 7. Context, with a do-not-re-derive list

What the system is, and what is ALREADY ESTABLISHED, explicitly labelled so the
worker does not spend budget rediscovering it. Point at the two or three
documents carrying the detail. Orientation, not education — this is last on
purpose.

### 8. Domain rules for this benchmark

Everything above is generic: it protects the PROCESS. This block protects the
SCIENCE, and it is the half that a worker cannot reconstruct from the code in
the time available. Paste the entries relevant to the package; a worker touching
truth, ranking or measurement needs all of them.

**A. Range is not observable without a dynamics prior.** Bearings depend only on
the DIRECTION of the relative position vector, so any positive scaling of the
whole relative trajectory reproduces the same sightlines exactly. No observer
maneuver repairs that. Observer maneuver creates observability only by making
the scaled alternatives violate an ASSUMED target model. Consequences a worker
must respect: any range-accuracy claim states the assumed class; a class-free
"how well can range be recovered" number does not exist; and a bound computed
for one class says nothing if the true target is in another.

**B. The generating range is not an input.** `spec.initialHorizontalRangeM` is
the truth used to BUILD the scenario. Anchoring a range search on it hands the
search a bracket centred on the answer, which no analyst has. Use the fixed
operational anchor (20 NM) and say so. The same rule covers any other generating
parameter: wind, start altitude, ascent rate.

**C. Truth leakage has more surfaces than it looks.** Known ones, all live:
`rankHypotheses` and `rankAllHypotheses` default to **`useTruth = true`** —
truth decides the ORDER unless `{useTruth: false}` is passed, so a blind ranking
claim built on the default is measuring an oracle; `familyCoverage` is computed
against truth by construction; `truthSepM` and every `*RelSep` are scored
quantities; descriptive scenario FILENAMES encode target family, altitude and
wind. A "blind" artifact must exclude these BY CONSTRUCTION, not by filtering
them out afterwards.

**D. Operational versus oracle outcomes.** The rank-1 hypothesis's error is the
operational number: it is what the pipeline would actually report. The best
error among eligible hypotheses is an ORACLE CEILING, because truth chose the
winner. Both may be reported; they must never be conflated, and the oracle one
must be labelled where it appears.

**E. No inverse crime.** A truth generator must not live inside the model class
of any solver being benchmarked, and sightlines must carry noise — except in
cells deliberately labelled oracle-compatible controls. If you generate truth
with the same equations a fitter uses, you are measuring the fitter against
itself.

**F. Residual and truth error diverge, and that divergence is a result.** Report
them separately. A measured case: the angular residual improved from 0.074 deg
to 0.049 deg while the truth error rose about six times, from 8 m to 49 m. A
package that reports only residual is reporting the thing that can improve while
the answer gets worse.

**G. Residual units are not comparable across solvers.** The constant-velocity,
constant-acceleration and Kalman paths return residuals in METRES; the Monte
Carlo and alternating-least-squares paths return RADIANS. Never compare raw
residuals across families; go through the shared angular reducer.

**H. Seed and determinism discipline.** Every stochastic component is seeded
from a stable hash of (scenarioId, scenarioSeed, componentLabel,
generatorVersion) through `mulberry32`; seed 0 maps to 1. Component streams are
INDEPENDENT: adding a random draw in one generator must not perturb another. The
truth key deliberately excludes the observation section, which is what lets a
matched-noise pair share an identical truth realization. No wall clock, no
unseeded randomness, anywhere in a generator path.

**I. Frames and units.** Scenario ENU, origin at the target's initial ground
point, z is height above the flat-proxy site ground. Scenarios are generated on
a FLAT PLANE: altitude is Z plus the site ground elevation at any horizontal
distance, which differs from the ellipsoid by about 2 m at 5 km and 196 m at
50 km. Specs carry degrees; internals frequently carry radians. Track and
terrain altitudes are MSL and need the geoid to reach HAE.

**J. Measurement traps this benchmark has actually fallen into.** Each cost a
retracted or corrected finding:

- *The sample-rate confound.* Any statistic formed as a per-frame difference
  multiplied by the frame rate measures NOISE at a high rate, because the true
  inter-frame motion shrinks with the rate while the pointing error does not. A
  statistic of this shape correlated 0.83 with sample rate and -0.01 with
  anomalousness. Normalise against the clip's pointing-noise floor, not only
  against the series' own median.
- *Set-composition confounding.* This scenario set varies geometry, target
  class, duration, rate and noise JOINTLY. A pooled correlation across it is
  hypothesis-generating only. Stratify, or say plainly that the number is
  exploratory.
- *Post-hoc thresholds.* A statistic with a free parameter and a handful of
  suggestive values will produce a result. Declare the threshold before the
  outcome, take it from something already committed where possible, and print
  the whole sweep so the parameter's leverage is visible.
- *Calibration pool contamination.* Declared-anomalous members must never enter
  a null or calibration pool. A detector calibrated on data containing the thing
  it detects is calibrated on nothing.
- *Small-n arithmetic.* With 26 heterogeneous scenarios and one seed each, rates
  carry exact (Clopper-Pearson) intervals and correlations are tie-corrected.
  Two paired items cannot reach significance whatever they show: the smallest
  attainable p is 0.5. State the ceiling rather than reporting the p alone.

**K. Verdict vocabulary.** The executive layer reports CLASS VIABILITY, not
certainty and not trajectory quality. `consistent-one` and `consistent-several`
say a class survived screening; `unresolved` is an abstention. A determined
trajectory with no viable class currently has no channel out of the pipeline —
that is a known structural gap, not a bug to route around.

### 8b. Environment traps

- The Jest config maps every `.mjs` import to a stub module. Importing a `.mjs`
  file from a test silently returns a stub instead of failing. Keep shared
  library files as `.js`.
- A tool that imports from `src/` cannot run under plain Node: the import graph
  is extensionless and only the bundler and Jest resolve it. Such tools run as
  bench tests, which is why every generator here is one.
- The positional argument to Jest is a path REGEX, not a filename.
- `--testPathIgnorePatterns` REPLACES the configured list rather than adding to
  it, silently re-including suites the config excludes.
- The `results/` tree is gitignored and regenerated; never commit it, and never
  assume a record in it is current after an ingest or generator change.

### 9. House rules

Match the surrounding comment style and density; these files explain WHY.
American spelling. No tool names and no quoted instructions in tracked files.
Determinism is a contract: no wall-clock and no unseeded randomness in generator
paths, and a determinism claim is evidenced by a double run with an identical
output hash, with the hash in `keyNumbers`. Do not commit. Report honestly; if
you could not verify something, say so plainly rather than claiming success.

---

## Part 2 — The report schema

Structure the return value; never accept prose.

| field | contents |
|---|---|
| `summary` | 2-4 sentences: what you built and the key design decision, with why |
| `acceptanceResults` | one entry per criterion: `{criterion, PASS/FAIL/NOT_RUN, evidence, oracle, negativeControl}` |
| `whatWorks` | claims you VERIFIED, each with evidence that COULD HAVE COME OUT THE OTHER WAY: name the test and say what would make it fail; at least one measured number from records you did not author. A test asserting your own output back at itself is not evidence. Not intentions. |
| `whatIsUnverified` | only MATERIAL unresolved claims, each `{claim, reason, impact, nextCheck}`. Empty is acceptable and is not penalised. |
| `testsChanged` | every pre-existing test touched, with before and after behaviour. Empty is the expected value. |
| `briefDelta` | anything delivered that differs from the briefed problem, and any briefed part not addressed. Empty is acceptable; absent is not. |
| `scopeDeviations` | changed hunks that do not map to a task requirement |
| `keyNumbers` | measurements worth reporting, each mapped to a criterion |
| `followUps` | including anything pinned to a neighbour's in-flight state |

*Rationale: the verified/unverified split is what made the round's reports
usable — workers volunteered that a threshold was uncalibrated, that a change
would churn every scenario identifier, and that a module had no consumer, none
of which survives a prose summary. The additions close named exploits:
`acceptanceResults` stops "done" being self-assessed, the `whatWorks` evidence
rule stops evidence laundering, the structured `whatIsUnverified` stops padding
the field to look rigorous, and `briefDelta` stops a problem being quietly
redefined to the part that was solved.*

---

## Part 3 — Retest result (v2, measured 2026-08-15)

v2 was tested on two real queued tasks, each carrying ONE deliberately false
claim, honestly marked `[ASSUMED]`, of the shape that cost most in the first
round. The two probes differed on purpose: one did not invalidate its task
(correct response: challenge and continue), the other would have made the work
nearly done if true (correct response: challenge, then do it anyway).

**Both were caught, with the full protocol.** Each report restated the disputed
claim, gave a minimal reproducible contradiction with a file and line, checked
one alternative reading and said why it failed, and stated what work continued.
Neither implemented around the false claim; neither used it as an exit. One went
further and identified the mechanism the brief SHOULD have named, measured it,
and built against that instead.

Against the first round, where one of two wrong premises was caught (as a note
buried in a summary) and the other was caught only by external review, this is
2 of 2 with structured evidence.

Other instrument results:

- **Mutation testing appeared without being asked for.** One package disabled
  its own key step and reported which of its tests then failed (2 of 10), then
  changed a normalisation that would still pass a naive check and reported 3 of
  10 failing. That is the `whatWorks` evidence rule producing evidence that
  could have come out the other way.
- **The anti-trap test fired in a controlled way.** Given "a quantity that is
  invariant because it was normalised into invariance", one package built the
  normalisation the trap describes and showed it scores a static line of sight —
  a geometry constraining nothing — at a perfect 1.0, above an isotropic
  control.
- **`scopeDeviations` caught a real ownership breach.** One package needed a
  single line in a non-owned file to reach its acceptance criterion, and
  disclosed it rather than hiding it. The line was necessary and minimal.
- **Pre-registration held under pressure.** The package testing a promising
  signal took its threshold from an assertion committed one commit EARLIER,
  proved the ordering with a git citation, added a label-blind secondary
  threshold, and printed the full sweep so the free parameter's leverage was
  visible. It then reported that the signal does not survive — retracting the
  finding that motivated the task.

That last outcome is the strongest evidence for the template. The prior finding
was born from exactly the post-hoc reading the pre-registration clause forbids,
and the clause killed it.

Open question for v3: nothing in this round tested the `testsChanged` defence,
because no package needed to touch an existing test. Until a package does, that
rule is untested rather than proven.

---

## Part 4 — Failure modes this defends against

Ranked by measured cost, briefer error first.

1. **A confidently wrong premise in the brief.** Two of seven packages were
   briefed to fix a defect that did not exist, or to compute a quantity that is
   identically zero. **More detail would have made these worse, not better**: a
   longer, more confident wrong instruction. Defended by §1 inline marks, §5,
   and the cheap-check rule.
2. **Structural blindness between packages.** Disjoint ownership prevents
   collisions and creates blind spots. Defended by §4 neighbours and consumer.
3. **Unfalsifiable success.** Work that passes its own tests and never runs on
   real data. Defended by §2 frozen inputs and the `whatWorks` evidence rule.
4. **Evidence laundering.** A test that asserts the worker's own output back at
   itself, cited as verification. Defended by the `whatWorks` evidence rule and
   `negativeControl`.
5. **Acceptance satisfied by weakening the check.** Defended by §4 and
   `testsChanged`.
6. **Confirmation.** A package asked to find a defect finds one. Defended by §6.
7. **The stop rule as an exit hatch.** Defended by §5's restate-and-repro
   protocol.

### Domain failure modes (§8), each with the finding it cost

These are separate from the list above because a correct PROCESS does not catch
any of them. Each was found only after a result had been written down.

8. **A class-free range claim.** Range does not exist without a dynamics prior
   (§8A). Cost: an early framing that treated recoverability as a property of
   geometry alone.
9. **Anchoring on a generating parameter.** (§8B.) Would silently hand every
   search a bracket centred on its own answer.
10. **Truth-aware ranking used as a blind result.** `useTruth` defaults to true
    (§8C). An unguarded call measures an oracle and looks like a measurement.
11. **Oracle reported as operational.** (§8D.) Cost: the first version of the
    study's headline outcome.
12. **A statistic that measures sample rate.** (§8J.) Cost: finding F9,
    retracted after measurement over the full record set.
13. **A pooled correlation over a jointly-varying set.** (§8J.) Cost: finding
    F1's original causal framing.
14. **Quoting a record after the generator changed under it.** (§8b.) Cost: a
    stale dossier path and two scenarios' figures.
