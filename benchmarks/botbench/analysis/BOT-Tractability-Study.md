# BOT tractability study — round 1 (2026-08-15)

The question this study measures: given many bearings-only LOS sets, which are
worth solving, how much can the automated verdict be trusted, can genuine
anomalies be separated from hard geometry, and does escalation to an AI agent
add value. This is the first end-to-end measurement of the SHIPPING analysis
(verdictRunner → buildHypotheses → rankAllHypotheses → assessExecutiveVerdict)
over the two new scenario arms plus a known-gradient baseline.

Companion program: `BOT-Tractability-Plan.md` (the 35-step research-derived
program). Raw records: `results/tractability/records*.jsonl` (regenerate with
`npm run bench-bot-tract`, chunked via `BOTBENCH_TRACT_*` env). Full tables:
`results/tractability/summary.md` (regenerate with
`node benchmarks/botbench/analyzeTractability.mjs`).

## Scope and honesty rules

- 26 scenarios, one noise seed each: 10 real-GPS-segment case geometries
  (Go Fast pair, Aguadilla, two Rubber Ducks, burst probe, dash, circuits,
  hover pair), 10 maneuver-taxonomy shapes, 6 GEO-DURATION ladder cells.
- Fixed 20 NM range anchor for every run (the BotBench dialog's policy); the
  generating range is never handed to the search.
- Triage features are strictly pre-fit observables; the analysis result never
  enters them.
- PRIMARY outcome: `topRelSep` — the rank-1 eligible hypothesis's mean track
  separation over mean truth range. `bestRelSep` (truth picks the winner among
  eligibles) is reported only as an oracle ceiling.
- Single-seed, designed-scenario caveat: every rate below is about these
  realizations, not a population. Exact (Clopper–Pearson) intervals throughout.

## Findings

**F1 — Conditioning does not predict end-to-end outcome on this pooled set.**
Spearman(log10rcond, topRelSep) = −0.02 over the 14 finite outcomes, and the
bins even invert: the deep-degenerate bin solved 5/6 (four ladder cells whose
balloon prior pins range, plus Go Fast — right range, wrong class), while the
well-conditioned bin solved 1/7 (its failures are three declared anomalies,
two real in-catalog targets lost to yield blockers, and one aerobatic shape).
The inversion is set-composition confounding, exactly as the methodology
review predicted — but the operational lesson survives it: pipeline outcome
is dominated by class-match and yield, not geometry. `cvDesignLog10Rcond`
predicts CV-family collapse (a prior 855-run result, not re-verified here);
it is not an end-to-end triage score. Triage must be two-axis: geometry AND
does-any-catalog-class-apply. (Program steps 1, 7, 9.)

**F2 — The verdict code is not a certainty statement.** `consistent-one`
spanned topRelSep 0.033 (Go Fast balloon — right range, though it named
multirotor) to 0.933 (hypersonic — confidently wrong), and scored 0/2 on
truth-class inclusion where scorable. `consistent-several` scored 6/6.
The more committed code was less reliable on this set. (Steps 5, 8, 16, 19.)

**F3 — The fast-far trap is real and confident.** The Mach-5 glide at 116 km
was reported `consistent-one: fixed-wing` at 7 km — the geometry admits a
slow-near reading and the verdict took it without flagging the alternative.
(turn90's topRelSep 0.998 is numerically worse, but that verdict abstained.)
A confident false negative is the worst kind of cell in the matrix. (Steps 17, 21.)

**F4 — The pipeline abstains honestly but yields little on real data, and one
abstention class is a defect.** 15/26 scenarios landed `unresolved`, including
10 mundane. On the real dash, the quadcopter fit landed 874 m from truth
(4.3% of range, 0.046°, ranked first) and was then withheld because the class
screen treats optimizer bound-pins as a blocker. Found, then refused.
The `search incomplete (bound pins…)` blocker is the top yield thief on real
segments. (Steps 7, 22; the co-leader/validated-selector thread.)

**F5 — Multiple orbits recover the trajectory; they do not recover the class.**
Two 2-km orbits produced the study's single best track recovery (hexarotor,
topRelSep 0.001) and located the climbing balloon to 15% — but both winning
fits are GENERIC Constant-Altitude tracks; the class fits failed (quadcopter
rejected at 0.761°, balloon at 0.925°). Orbiting is what a platform should fly
when it can — it buys range through geometry alone — and both verdicts still
said `unresolved`, so the yield problem persists even at the geometry optimum.
(Step 22's probe menu; F4's blockers.)

**F6 — Class-viability alarms detect but do not discriminate.** Naive
(`unresolved` ⇒ anomaly) and geometry-gated (observable AND no viable class)
alarms both fire on 5/6 anomalies — but also on 10/20 mundane scenarios
(Fisher p=0.20): the four class-less aerobatics, the burst probe (as
designed), and five ordinary real cases (Aguadilla, dash, circuits, both
Rubber Ducks). The missed anomaly is F3's hypersonic. Discrimination must be
envelope-based (α*, GLRT over an extended mundane battery) with the burst as
a permanent false-positive gate. (Steps 3, 10, 11, 17, 18.)

**F7 — Real tracks carry artifact classes synthetic data never shows.** Two
distinct classes appeared. The circuits log has genuine datum-shift steps
(60–95 m across lengthened telemetry gaps; 14 bridged) that a naive ingest
scores as impulse anomalies. The dash log's 119 bridged intervals (of 20,402
intervals / 20,403 samples; counts in the real-scenario manifest, not the
tractability records) are mostly a different thing: 111 are sub-5-m estimator
jitter whose tiny 0.013-s intervals cross the speed cap — only 3 are true
60–95 m steps. The bridge rule therefore needs a minimum-displacement guard
(queued with program steps 3/6); radiosondes needed zero repairs either way.
Truth hygiene is a first-class pipeline stage for real data. (Steps 3, 6.)

## Per-scenario table

See `results/tractability/summary.md` for the full table with intervals. The
compressed picture, sorted by conditioning:

| scenario | verdict | topRelSep | note |
|---|---|---|---|
| ladder (6 cells) | consistent-* | 0.039–0.114 | balloon prior defeats geometry |
| real/gofast | consistent-one | 0.033 | range right, class wrong (multirotor) |
| maneuver/hypersonic | consistent-one | 0.933 | the fast-far trap, confident |
| real/gofast-anom | unresolved | — | impulse correctly breaks every model |
| maneuver/static-point | consistent-several | 0.003 | triangulation ceiling |
| maneuver/straight-ca | consistent-one | 0.509 | CA read as fixed-wing at wrong range |
| mundane maneuvers (5) | unresolved | — | no catalog class flies a loop |
| real/dash | unresolved | — | found at 4.3%, refused on bound-pins |
| real/burst | unresolved | — | false-positive probe fires as designed |
| real/hover | consistent-several | 0.014 | |
| real/hover-anom | unresolved | — | impulse detected by abstention |
| real/rubberduck-drone | unresolved | 0.001 | best track recovery — via a GENERIC fit |
| real/rubberduck-balloon | unresolved | 0.151 | climbing drifter; generic fit, class fits fail |

## Escalation pilot — eight truth-blind AI adjudicators

Eight ambiguous/trap cases, one blind analyst agent each (dossier only, truth
withheld), one scorer with the answer key. Dossiers: `results/escalation/`.

Scores: class calls 0/8 correct (7 abstentions, 1 wrong commitment); anomaly
detection 0/3 true positives with 0/5 false positives; **3/8 better than the
automated baseline, 1/8 worse**.

What "better" looked like — the agents' value is AUDIT, not solving:

- **C07 (hypersonic trap):** the agent refused the baseline's confident-wrong
  fixed-wing verdict, called it "a screening technicality" resting on a
  0.049° vs 0.047° dead heat with an incomplete quadcopter search, and
  prescribed the one probe that discriminates — a baseline-changing dogleg.
- **C08 (Go Fast):** the agent avoided the baseline's wrong multirotor call and
  pointed at the truth: "the best-fitting concrete class (balloon, 0.043°) was
  excluded on a procedural blocker, not physics."
- **C04 (circuits):** the agent flagged the below-terrain rejection of the
  0.139° fixed-wing-like solution as a datum artifact candidate — the truth is
  a fixed-wing.

What "worse" looked like: the single confident class commitment in the set
(C02: multirotor for a lantern-like balloon riser) — the exact confident-error
pattern the baseline avoided.

Why every anomaly was missed: the impulses were absorbed into scalar residual
summaries. Smooth generic models fit the spliced tracks at 0.075–0.151°, so
the agents read "ordinary motion." The scorer's diagnosis: the dossier lacks a
**time-resolved residual/implied-speed trace** — a speed-vs-time profile would
show a physically impossible step at the splice instant, and ~1700 m/s at the
bracket ceiling for the hypersonic. Second gap: pins should say WHICH bound
they sit on. Both go into dossier v2 (program step 14, extended).

Pilot conclusion: at this dossier fidelity, agent escalation is worth running
as a VERDICT AUDITOR on committed codes (it caught both confident-wrong
baselines and never added a false alarm), and is not yet an anomaly detector
or an independent solver. That division of labor matches the program's router
design (step 7) and the offline-adjudicator protocol (step 15).

## Provenance

Built and audited 2026-08-15: real-tracks arm (`lib/realSegments.js`,
`lib/realScenarioSet.js`, `realtracks.bench.test.js`), maneuver arm
(`lib/maneuverTargets.js`, `lib/maneuverSet.js`, `maneuver.bench.test.js`),
tractability runner (`tractability.bench.test.js`, `analyzeTractability.mjs`),
dossier machinery (`lib/dossier.mjs`, `buildDossiers.mjs`). Two adversarial
implementation reviews (11 + 8 findings) were applied before the measured runs;
the methodology corrections (oracle-vs-operational outcome, tie-corrected
correlation, exact intervals, per-code endpoints) are reflected above.
