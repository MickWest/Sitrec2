# How to brief a delegated work package (v2, 2026-08-15)

A template for specifying work handed to a parallel worker. Derived from a round
of seven packages run on this benchmark, then critiqued by two independent
reviewers and revised. Every rule exists because its absence cost something
measurable, or because a reviewer named the exploit it prevents.

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

### 8. Known traps in this repository

Environment hazards that cost time to rediscover. Keep this list running.

- The Jest config maps every `.mjs` import to a stub module. Importing a `.mjs`
  file from a test silently returns a stub instead of failing. Keep shared
  library files as `.js`.
- A tool that imports from `src/` cannot run under plain Node: the import graph
  is extensionless and only the bundler and Jest resolve it. Such tools run as
  bench tests, which is why every generator here is one.
- The positional argument to Jest is a path REGEX, not a filename.
- `--testPathIgnorePatterns` REPLACES the configured list rather than adding to
  it, silently re-including suites the config excludes.

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
