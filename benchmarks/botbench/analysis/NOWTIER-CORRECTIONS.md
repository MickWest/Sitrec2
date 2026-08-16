# Near-term tier — corrections queued from the execution review (2026-08-15)

An independent execution review of the six near-term work packages ran while they
were being implemented. Four of its findings land AFTER the packages, either
because they correct a premise the brief got wrong or because they are couplings
the parallel launch ignored. They are recorded here so none of them is lost, with
what to do and why it matters.

## C1 — The "geometry floor" in the precision score is not a floor (blocking)

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
