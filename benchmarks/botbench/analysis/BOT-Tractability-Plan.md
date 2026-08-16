# BOT tractability program — research synthesis (2026-08-15)

Produced by a five-question research fan-out (triage, certainty, anomaly,
escalation, dataset design) plus a conflict-resolving synthesis, mapped to
this pipeline. Steps are dependency-ordered. Citations are the researchers';
verify before external use. Companion measurements: BOT-Tractability-Study.md.

## The program

### 1. [now/hours] Harden the rcond triage statistic: rebuild the CV design matrix on a centered, column-equilibrated time basis, extend it to a nested per-class conditioning stack (CV, +acceleration, +jerk) emitting 'maximum observable dynamics order', and recalibrate the -3/-2/-1 => 84%/8%/0% thresholds per order on the 855 synthetic scenarios (lib/diagnostics.js cvDesignRcond, lib/solvers.js).

- Rationale: R1: rcond is not parameterization-invariant (cond(AD) != cond(A); Golub & Van Loan equilibration), so the validated thresholds do not transfer to the real-GPS arm's heterogeneous durations/rates without re-basing; and Fogel & Gavish 1988 (https://ieeexplore.ieee.org/document/192098/) show CV observability conditions are necessary but NOT sufficient for higher-order targets — a scenario can pass CV-rcond and still be unobservable for the accelerating targets the anomaly arm exists to find (Nardone & Aidala 1981, https://www.semanticscholar.org/paper/3e40ae620c1a3619efb1c84a4fb228727b5f28d4, ground the CV row). Unblocks steps 2, 7, 10, 13. [Testable on existing data — recompute over stored LOS sets/tractability records.]
- Depends on: none

### 2. [now/hours] Re-tag the existing 855 synthetic scenarios into a generator manifest (generator version, factor vector, seed, arm tag, hardened-rcond stratum, target class, sigma, sample rate, duration) and audit occupancy against the target design matrix of step 13 before generating anything new.

- Rationale: R5: converts 855 sunk scenarios into Arm-A inventory instead of duplicating dense regions while the rcond transition zone stays thin; manifest storage follows Stone Soup's componentized scenario architecture (FUSION 2023, liverpool.ac.uk/3173692) and makes every published number reproducible from a manifest hash. Uses step 1's hardened statistic so strata are stable. [Testable on existing data — batch job.]
- Depends on: 1

### 3. [now/hours] Sham-splice all anomaly controls (identical splice machinery, zero-magnitude impulse) and add a primitive-detector triviality gate (max bearing-rate jump, max innovation) that every anomaly exemplar must NOT be solved by before it counts toward any ROC (lib/realScenarioSet.js splice construction).

- Rationale: R5: Wu & Keogh (IEEE TKDE 2021, arXiv:2009.13807) showed whole literatures measured benchmark artifacts, not anomalies; the splice seam is the single most likely way the anomaly ROC becomes fiction, and the fix is hours of harness code. Must land before any FP/FN number is trusted. [Triviality gate testable on existing exemplars now; sham-splice controls need new generation through existing machinery.]
- Depends on: none

### 4. [now/hours] Switch spliced-impulse analysis to paired form: per-pair score differences, McNemar-style detection contrasts per ladder cell, DeLong correlated ROC; report paired vs pooled once to demonstrate the variance reduction. Rule: anomalous pair members never enter any null/calibration pool.

- Rationale: Dedup of R5 (shared noise realizations = common random numbers; Nelson & Matejcik, Mgmt Sci 1995; Yang & Nelson, Oper Res 1991) with R3 (pairs are a POWER instrument, not a calibration instrument — leakage into the null destroys FPR control) and R2 (matched-pairs design measures FN power sharply). Analysis-code change only; roughly halves required N. [Testable on existing pairs/runs now.]
- Depends on: 3

### 5. [now/hours] Attach coverage certification to every printed coverage number: group-level covered/N per signature bin with a Clopper-Pearson 95% lower bound (clusterBootstrap for weighted bins), and a MIN_GROUPS_COVERAGE floor (~30-50 effective groups) below which the report says 'coverage not certified at this signature level' and backs off (lib/classProbability.js, lib/verdictRunner.js buildSignature).

- Rationale: R2: MIN_GROUPS=8 licenses a class-distribution report but cannot license a 90% coverage claim — 8/8 covered certifies only ~69% at 95% confidence (Vovk, PMLR v25 2012; arXiv:2502.07497 reduces certification to binomial CIs). Reconciled with R5's sizing rule in conflicts: 30-50 groups certifies a bound, ~150 scenarios gives +/-5% Wilson precision. [Testable on existing coverage records — arithmetic plus wording.]
- Depends on: none

### 6. [now/hours] Add the noise self-check to every LOS set: robust empirical bearing-noise estimate (short-window local-polynomial detrend + MAD) vs declared sigma; flag mismatch beyond a calibrated ratio and recompute all precision predictions with the empirical value.

- Rationale: R1: every FIM/CRLB quantity scales as sigma^2, so a 2x misdeclaration is a 4x variance error that silently corrupts both triage ordering and band coverage; the real-GPS arm inherits GPS-artifact noise rather than declared sigma, and the shared-noise anomaly pairs assume the noise model is right. [Testable on existing bearing series in both arms now.]
- Depends on: none

### 7. [now/days] Install the unified router in front of the verdict: four terminal buckets — consistent-one (auto-commit), consistent-several (report set), unresolved-escalate (rcond above floor OR named auxiliary data plausibly exists), unresolved-collapsed/untestable (terminal) — with per-class solver gating from the step-1 conditioning stack; sweep/bearing-rate features may only DOWNGRADE a bucket; geometry-dead cases still ship modified-polar observable products (bearing, bearing rate, r-dot/r; Aidala & Hammel, https://www.semanticscholar.org/paper/b7a06ada714a420c6678f9b251968ce000d3c8d8) plus alpha* status, and their anomaly verdict is 'untestable/undetectable', never 'clean'. Emit the bucket in the interchange signature (verdictRunner.js, exportInterchange.js).

- Rationale: Merge of R1's fail-closed A/B/C buckets, R3's three-way anomaly output {anomalous, mundane-consistent, untestable} (below log10 rcond ~ -3 the mundane family is a superset of all bearing-consistent hypotheses, so the anomaly test has zero power BY GEOMETRY — the measured 84%/8%/0% collapse rates give the routing thresholds), and R4's four-bucket L2D router (reject-option methods that defer purely on confidence are non-adaptive to what the downstream expert can do). Nardone & Aidala's nonzero-bearing-rate trap is why sweep features are downgrade-only. Prevents agent/human tiers drowning in provably hopeless straight-path cases and creates the routing labels every later evaluation needs. [Bucket assignment testable on existing tractability records.]
- Depends on: 1

### 8. [now/days] Refactor calibrateK into group-level split conformal: per truth-content GROUP compute score s = 95th-percentile-over-frames smallest K covering truth; per signature (Mondrian) bin set K to the ceil((n+1)*0.9)-th smallest of n group scores; calibration split disjoint from anything used to tune solvers or signature thresholds; keep smallest-K semantics and 'reachedTarget:false is a finding' (lib/classProbability.js calibrateK/splitByGroup, verdictRunner.js containment).

- Rationale: R2: calibrateK is already split-conformal minus the finite-sample correction — the refactor buys an EXACT finite-sample 90% marginal guarantee per bin regardless of model misspecification (Romano/Patterson/Candes CQR, arXiv:1905.03222; Angelopoulos & Bates, arXiv:2107.07511); per-signature bins are the strongest honest conditioning since exact per-case coverage is provably impossible (Barber et al., arXiv:1903.04684); the 95th-percentile-over-frames score matches the deployed containment metric without union-bound conservatism (Lindemann et al., arXiv:2210.10254); group-level scoring preserves exchangeability under the block matrix. Explicitly rejects Kuleshov-style CDF recalibration (arXiv:1807.00263) — marginal calibration is satisfiable by uninformative intervals. [Testable on existing bench results — recalibration pass.]
- Depends on: 5

### 9. [now/days] Add the class-conditioned predicted-precision score: CRLB-derived fractional range error sigma_r/r (and velocity analog) on a coarse range-speed hypothesis grid per dynamics class (rankAllHypotheses grid, useTruth:false), reporting min/median/max; use it to order the queue and pre-size per-class range bands; emit the noise-limited vs geometry-limited label (sigma_r/r at current N vs the N->infinity geometry floor) in verdicts and escalation tickets.

- Rationale: R1: the FIM composes geometry, N, and declared sigma into one parameterization-invariant physical number (canonical in bearings-only work — Passerieux & Van Cappel, IEEE TAES 34:777-788, 1998; FIM-determinant trajectory optimization, researchgate.net/publication/3003085); FIM additivity is exactly the pipeline's measured sqrt(N)-on-noise/nothing-on-geometry result, so the label tells the escalation tier whether 'get more data' is actionable or provably futile. Cost: a few small matrix inversions per scenario, no fitting. [Testable on existing LOS sets now.]
- Depends on: 1, 6

### 10. [now/days] Run the alpha* calibration pilot: >=20 lambda=1 mundane controls per geometry class (matched platform path, sample times, FOV mask, sigma — real-track arm plus synthetic mundanes), null alpha-hat distributions per rcond bin, calibration artifacts satisfying isValidCalibration (family, catalogId, nControls, provenance, detectorConfigKey for alpha-v3.1) so CAPABILITY_THRESHOLD_CALIBRATED can flip (lib/envelopeFeasibility.js, lib/capabilityDetect.js). Until it lands, every dossier carries an explicit 'alpha*: uncalibrated-withheld' status line.

- Rationale: R3: the entire capability-claim path is measurement-only today; fail-closed contract, config binding, and null-generator machinery all exist — only the pilot run and artifact files are missing, and every later anomaly recommendation reuses this null-generation harness. Empirical nulls are mandatory, not optional: alpha-hat is a sup/min-over-nuisance statistic in Davies' setting (Biometrika 1977/1987, https://academic.oup.com/biomet/article-abstract/74/1/33/217600) with optimizer noise on top. The status line is R4's guard against agents imputing feasibility from silence. Resolves the R3-now vs R4-later conflict (see conflicts). [Needs new runs — control generation.]
- Depends on: 1

### 11. [now/days] Add a burst-capable balloon model (ascent / burst / terminal-velocity wind-advected descent) to the physics battery (src/VehicleModels + lib/physicsSolvers.js), iterated by capabilityDetect S1', with the radiosonde-burst probe as an acceptance gate: the probe must classify mundane at the calibrated threshold.

- Rationale: R3: FDI isolability — to separate anomaly from burst you need a burst-representing model INSIDE the null; without it every jump/GLR-style statistic (and plausibly S1') flags the burst probe and the false-positive control the probe was built to measure fails by construction. A burst's tight physical signature (near-vertical transition to terminal descent, horizontal motion still wind-locked) is discriminating structure that just isn't in the battery yet. Converts the probe from known embarrassment into regression test. [Needs new runs — model + probe re-run.]
- Depends on: none

### 12. [now/days] Run the sim-to-real coverage audit: freeze synthetic-calibrated per-bin K, score the entire real-GPS-track arm against it, publish per-bin coverage deltas as the measured exchangeability gap in the bench report; any bin whose real-arm coverage misses its certified lower bound is a red finding.

- Rationale: R2: conformal validity is model-agnostic but distribution-dependent; the synthetic-to-real coverage gap is bounded by an unknowable TV distance (Barber/Candes/Ramdas/Tibshirani, Ann. Statist. 2023, arXiv:2202.13415), so measuring it on the one real dataset available is the only honest move — and this single number decides whether bench guarantees transfer to the deployment goal at all. It also decides (conflict 6) whether R2's weighted conformal or R4's per-arm calibration is the right repair. [Needs a scoring pass over existing real-arm scenarios — no new data collection.]
- Depends on: 8

### 13. [now/days] Adopt the three-arm dataset structure: Arm A triage (~400 scenarios rcond-stratified with the transition zone [-3.5,-0.5] deliberately oversampled, Latin-hypercube over continuous nuisances within strata, >=100 collapses AND >=100 non-collapses, triage validated by logistic/isotonic fit on continuous rcond with CI band, not per-bin binomials); Arm B frozen calibration holdout (~450-600 scenarios from a WRITTEN-DOWN operational mixture prior, ~150 per quoted verdict code, never used for tuning); Arm C anomaly ladder (3 impulse delta-V levels x 2 observability strata x ~35 matched pairs plus ~450 confusable negatives). Categorical factorial backbone + LHS inside cells, not a full grid.

- Rationale: R5: the minimal matrix that simultaneously powers triage validation (Riley et al., Stat Med 2021, doi 10.1002/sim.9025 — 100/100 events floor, imprecise for calibration slope hence transition-zone concentration), per-code coverage at +/-5% (n=150, p=0.9 Wilson), and low-FPR ROC (+/-2% at FPR=5% needs ~450 negatives); DOE literature (MDPI Energies 14:512; arXiv:2505.09596) for factorial+LHS. Arm B is the resolution of conflict 2: per-signature conformal is legitimate on designed data, aggregate deployment claims come only from the operational-mixture holdout. Net new work after the step-2 re-tag is ~700-1000 mostly cheap synthetic scenarios. [Needs new runs.]
- Depends on: 2

### 14. [now/days] Build the dossier exporter as two deterministic variants over the interchange format (extending existing dossier.mjs/buildDossiers.mjs/exportInterchange.js): 'blind' (no executive code or ranking order, hypothesis rows shuffled by scenario seed) and 'full'. Contents: interpreted rcond with calibrated meaning and bench percentile; hypothesis table with per-band MEASURED coverage rates; residual summary statistics and flags (runs test, autocorrelation, step detection — never raw arrays); the S2 range-vs-envelope sweep table; ENU-local human-scaled units only (never raw lat/lon/ECEF); explicit alpha* status enum {calibrated, uncalibrated-withheld}; 2-3 nearest-neighbor truth-known bench cases as few-shot grounding.

- Rationale: R4: the dossier is the load-bearing interface of the whole escalation ladder. The blind/full split is the STRUCTURAL fix for anchoring — LLMs anchor hard on provided conclusions, stronger models anchor MORE, and prompt-level mitigation is ineffective (arXiv:2412.06593; arXiv:2511.05766), while blind evaluation makes the bias nearly disappear (arXiv:2603.12123). Precompute-every-number is dictated by documented LLM arithmetic-spatial failures (GeoGramBench arXiv:2505.17653; small-angle confusion arXiv:2505.21649; GPSBench arXiv:2602.16105): the agent compares and contextualizes, it never computes. [Buildable now against existing interchange records.]
- Depends on: 7

### 15. [now/days] Run the offline blind-adjudicator experiment BEFORE any live agent integration: agent verdicts on every case the router would escalate, scored against truth via scoreInterchangeVerdict.mjs (truth kept out-of-band, never in the dossier); include the blind-vs-anchored ablation (anchored arm = null hypothesis of zero added value) and the paired McNemar test on spliced-impulse pairs with the radiosonde-burst probe as FP canary; also produce the deferral-curve dominance test (verdict quality vs escalation rate must dominate pure-automated at matched budget).

- Rationale: R4: decides with ground truth whether the agent tier adds ANY adjudication value before paying for it in production (Auditing for Human Expertise, arXiv:2306.01646 — conditional-independence test; conformal-set complementarity arXiv:2508.06997; risk-coverage methodology from the L2D/reject-option surveys). The dataset's shared-noise pairing makes this unusually powerful for its size. [Uses existing scenarios and truth; needs new agent runs, no new data.]
- Depends on: 14, 4, 7

### 16. [next/days] Conformalize the class/candidate verdict into prediction sets: nonconformity score from classProbability.js/classifier.js evidence, calibrated per arm (synthetic and real-GPS separately, pending step 12's audit); |set|=1 -> consistent-one, small set -> consistent-several, large set -> escalate; publish the chosen miscoverage level and measured truth-in-set rate beside existing band-coverage numbers.

- Rationale: Dedup of R2 and R4 (identical proposal): top-1 ranking at 3/18 is not a shippable product, but conformal validity does not require a good ranker — weakness becomes honest set size, not broken coverage (Angelopoulos & Bates arXiv:2107.07511; conformal-abstention cascades, UCCI arXiv:2605.18796), and set size is the principled quantitative escalation trigger the GOAL's agent/human ladder needs. Makes the consistent-several code's size distribution a measured, guaranteed quantity. [Calibration testable on existing bench evidence records.]
- Depends on: 7, 8, 12

### 17. [next/days] Implement the composite-null GLRT as the primary anomaly detector: D = min over the EXTENDED mundane battery of the range-profiled fit statistic (S1'-style angular residual + envelope pressure), thresholded against geometry-conditional parametric-bootstrap nulls stored in the step-10 artifact schema (keyed additionally by rcond bin), with the hard three-way output {anomalous, mundane-consistent, untestable} routed by the step-7 buckets. H0 = 'some member of the mundane battery, at SOME admissible range profile, explains the bearings' — rejecting it survives range unobservability.

- Rationale: R3: detection is possible where estimation is not — the identifiability-vs-attributability split (FDI theory; Nardone & Aidala 1981; Fogel & Gavish 1988 make range-point-estimate-conditioned tests unsound). Davies (1977/1987) makes analytic chi-square/GLR thresholds untrustworthy for sup-over-nuisance statistics, so empirical nulls are mandatory; the untestable branch is the false-negative control — 'no anomaly' must be unemittable where the test has zero power by geometry. [Needs new runs — bootstrap nulls.]
- Depends on: 10, 11, 7

### 18. [next/days] Wrap fleet-scale anomaly triage in Mondrian-stratified conformal p-values + Benjamini-Hochberg: calibration pool from real-track mundane scores plus synthetic mundanes (burst probe included in the null), stratified by rcond bin; conformal p-value per incoming LOS set from the composite-null statistic; BH at the target fleet FDR = the escalation budget; FN power scored on the matched pairs.

- Rationale: Dedup of R2 and R3 (identical construction; resolution of conflict 8 — the GLRT statistic IS the conformal score, conformal/BH is the fleet wrapper, not a competing detector): Bates/Candes/Lei/Romano/Sesia (Ann. Statist. 2023, arXiv:2104.08279) — conformal p-values from a clean calibration set are PRDS so BH controls FDR exactly, in finite samples; per-scenario FPR control does not compose into fleet guarantees, and the GOAL is MANY LOS sets. splitByGroup/clusterBootstrap already handle the leakage-safe split. [Needs new runs for the calibration pool.]
- Depends on: 17, 3, 4

### 19. [next/hours] Adopt the five-clause verdict template for every calibrated claim: (1) signature scope; (2) bench-population scope with the measured real-arm gap; (3) k/N groups with 95%-confidence coverage lower bound; (4) abstention rate among same-signature cases; (5) simultaneity note when multiple class bands are shown. Wire into interchange verdict text and scoreInterchangeVerdict.mjs so no claim ships without its clauses.

- Rationale: R2: each clause guards a documented failure mode — conditional-coverage impossibility (arXiv:1903.04684), exchangeability break (arXiv:2202.13415), small-N (Vovk PMLR v25; arXiv:2502.07497), selection bias (El-Yaniv & Wiener 2010; SelectiveNet arXiv:1901.09192), multiplicity (Bonferroni first principles). Omitting any clause converts a true statement into a misleading one; extends the pipeline's existing 'no percentage without its N and interval' rule. [Wording + scorer change, testable now.]
- Depends on: 5, 12

### 20. [next/days] Publish every coverage statement as the PAIR (coverage among non-abstained, abstention rate) per signature bin, and produce the risk-coverage curve by sweeping the rcond gate threshold (and alpha* once calibrated) per bin; freeze gates into the versioned configKey artifact BEFORE measuring, gates depending only on truth-free statistics.

- Rationale: R2: the pipeline's gates (rcond triage, fail-closed alpha*, 'not calibrated' fallbacks, unresolved code) constitute a selective-prediction system — a 90% guarantee at 80% abstention is a different product from one at 5%, and hiding the denominator is the classic way calibrated systems mislead (El-Yaniv & Wiener 2010; Geifman & El-Yaniv 2017). The curve tells triage exactly what coverage each escalation budget buys. [Sweep computable from existing tractability/verdict records.]
- Depends on: 7, 10

### 21. [next/days] Compute the per-scenario anomaly DETECTABILITY floor: CRLB on the spliced-impulse parameters (magnitude/onset) given the geometry; report 'undetectable' rather than 'clean' whenever the injected-anomaly scale is below the floor; later cross-validate against step 30's empirical MDA surface — disagreement between the analytic floor and the measured surface is itself a finding.

- Rationale: R1: controls false negatives at the source — a null result on the burst probe or an anomaly pair is only evidence if the geometry could have seen the effect; makes measured FP/FN rates interpretable per geometry stratum. Same FIM machinery as step 9 applied to impulse parameters. [Testable on existing LOS sets now.]
- Depends on: 9

### 22. [next/days] Build the empirical VOI table and probe menu: for each (rcond bin x maneuver class x probe) deterministically regenerate scenarios with the counterfactual probe applied (extend window — recomputed rcond is cheap and exact; pointing calibration; run physics fit X) and measure realized ambiguity reduction (class-set entropy or band-width shrinkage); attach per-case VOI to the full dossier; gate expensive differential-evolution fits on the rcond floor from this table (new lib/probeVOI.js over generateScenario.js/rng.js determinism; real-arm window extensions use the retained full source tracks).

- Rationale: R4: converts the pipeline's central scientific result (geometry dominates; sqrt(N) on noise only) into an operational triage asset — probe ranking is (1) extend window, (2) auxiliary data that bypasses geometry (ADS-B, soundings, star/landmark pointing calibration — systematic error sqrt(N) cannot touch), (3) physics fits above an rcond floor, (4) FIM-determinant sensor maneuver for live observations (researchgate.net/publication/3003085; Nardone & Aidala 1981). The deterministic generator makes counterfactual probes exact, which almost no real-world VOI system gets; also directly cuts compute. [Needs new runs — counterfactual regeneration.]
- Depends on: 2, 7

### 23. [next/days] Export per-model innovation diagnostics from fitKalmanFilter: frame-wise NIS, whiteness statistic, max-over-onset Willsky-Jones jump GLR with bootstrap-calibrated thresholds; use estimated onset time as CORROBORATION in the escalation packet ('all mundane filters break at t=15s') — never as a standalone detector.

- Rationale: R3: innovation statistics are cheap and localize the anomaly in time (which the batch GLRT cannot), giving the agent/human tier something inspectable; standalone they are UNSAFE in BOT — under weak geometry the filter absorbs anomalies into unobservable range (whiteness proves nothing), under strong geometry mundane discontinuities trip the jump test (Willsky & Jones, IEEE TAC 21:108-112, 1976; NIS/whiteness per Bar-Shalom). Gated by the step-1 conditioning statistic. [Needs code + bootstrap runs.]
- Depends on: 17

### 24. [next/days] Label Arm C positives with BOTH the impulse instant and the post-impulse effect window (Exathlon-style dual labels, PVLDB 14(11) 2021) and make scoring interval-aware so late-but-correct detections are not scored as false positives; grow the confusable-negative family to ~450 real segments (burst+descent, aggressive-but-benign drone racing/photography maneuvers, gust/shear, thermalling), each tagged with its confusion mechanism.

- Rationale: R5: escalation is gated on FPR in the CONFUSABLE region, not on easy controls — 450 negatives pins FPR=5% to +/-2% (Wilson); the low-FPR region is what matters operationally (anomaly-AUC critique, researchgate 370605457); dual-interval labels prevent a known benchmark mislabeling failure mode. [Needs new segments/runs.]
- Depends on: 13

### 25. [next/days] Set the replicate policy (3-5 noise seeds per synthetic scenario) with a variance-decomposition step (between-geometry vs between-seed variance per metric) in the bench report to direct future growth; replace blanket growth with straddle-style adaptive top-ups where the fitted triage curve and (post step-10) the alpha* feasibility boundary have widest CI (predicted probability 0.2-0.8). Hard rule from conflict 4: calibration draws ONE conformal score per truth-content group regardless of replicate count.

- Rationale: R5: Stone Soup-style MC replication (FUSION 2023) makes noise variance measurable for pennies, and the decomposition names the axis that is actually starving instead of growing everything; level-set active learning (straddle heuristic, Gotovos et al. IJCAI 2013; randomized straddle arXiv:2408.03144) concentrates expensive runs at the decision boundaries triage and alpha* calibration depend on — the cheapest route to un-fail-closing alpha*. [Variance decomposition partially testable now if existing blocks carry seed replicates; top-ups need new runs.]
- Depends on: 13, 10

### 26. [next/days] Move dataset storage fully to generator manifests (generator version + factor vector + seed + arm tag; synthetic trajectories regenerated on demand; only real GPS source segments and splice recipes stored as data); freeze Arm B behind this mechanism and regenerate it with fresh seeds whenever verdict logic changes materially.

- Rationale: R5: keeps growth from becoming unwieldy — the benchmark becomes a program whose scenarios are cheap to enumerate, diff, and re-stratify; holdout refresh prevents the verdict from slowly overfitting a static holdout across development cycles. [Infrastructure; builds on step 2's manifest.]
- Depends on: 2, 13

### 27. [next/days] Expand ranking evaluation from 18 to 100+ multi-candidate scenarios by reusing Arm B (every holdout scenario with >=2 candidates is a ranking trial); report the chance-adjusted top-1 rate with a Wilson CI conditioned on candidate count.

- Rationale: R5: 3/18 has a Wilson 95% CI of roughly [6%, 39%] — statistically empty, cannot distinguish the ranker from random selection; reusing Arm B gets adequate power with zero new scenario generation beyond step 13. Complements step 16 (the set, not top-1, is the deliverable meanwhile). [CI recomputation testable now; adequate power needs Arm B.]
- Depends on: 13

### 28. [next/days] Define the joint escalation operating point by sweeping rcond gate x conformal alpha x adjudicator-disagreement margin against an explicit ASYMMETRIC cost model (false consistent-one >> unnecessary escalation >> wasted agent call on a hopeless case); publish the chosen point with its measured error rates in the interchange release notes (interchangeRelease.js).

- Rationale: R4: cost-sensitive deferral is the central design variable in the L2D literature (UCCI arXiv:2605.18796 — per-tier thresholds controlling miscoverage at target cost); ad-hoc thresholds silently drift the FP/FN balance the anomaly arm exists to control, and publishing the operating point with rates is the same honesty contract the range bands already follow. [Sweep runs on existing + Arm B records.]
- Depends on: 16, 20

### 29. [next/weeks] Implement the probe-planner agent role: fixed action menu (extend window, request ADS-B, request sounding, request pointing calibration, run physics fit X, escalate to human, close as unresolvable) with step-22 VOI precomputed per option; PAL-style tool wrappers (recompute sub-window rcond, evaluate class envelope at assumed range, interpolate band) over solvers.js/capabilityDetect.js/classProbability.js; free-form arithmetic forbidden in the prompt contract, menu choice + cited dossier line required; scored offline by REGRET against the best-in-menu probe. Keep the three agent jobs separated: probe planner (full dossier), blind adjudicator (blind dossier), human-brief narrator.

- Rationale: R4: this is where LLM world knowledge (Venus plausibility — venus.js already encodes one such hypothesis — balloon launch sites/schedules, ADS-B coverage, weather) genuinely complements the numeric pipeline (amplified-oversight complementarity, arXiv:2510.26518), while menu + executed-code tools keep it away from documented arithmetic-spatial failures (PAL, arXiv:2211.10435 — offloading computation removes that error class wholesale). Regret scoring needs no human labels thanks to generator determinism. One agent call doing all three jobs invites the anchoring failure. [Needs new agent runs; regret harness needs step 22.]
- Depends on: 22, 14, 15

### 30. [later/weeks] Trace the minimum-detectable-anomaly (MDA) surface: sweep impulse delta-V over the paired shared-noise machinery on real segments per (rcond bin, sigma); estimate detection power at the calibrated operating point via within-pair statistic differences; attach the local MDA to every non-anomalous verdict ('would have detected >= X m/s at this geometry').

- Rationale: R3: controlled false negatives require quantifying what the detector could NOT have seen — a 'consistent' verdict without an MDA is unfalsifiable; the paired design makes the estimate cheap and low-variance, and the sqrt(N)-vs-geometry result fixes the surface's axes (geometry-limited, not sample-limited) so it generalizes beyond the bench. Cross-validates step 21's analytic CRLB floor. [Needs new runs — magnitude ladder sweep.]
- Depends on: 17, 18, 24

### 31. [later/days] Upgrade stochastic-class triage (balloon-in-wind, multirotor) to PCRB: Tichavsky/Muravchik/Nehorai recursion (IEEE TSP 1998, https://www.ese.wustl.edu/~nehorai/paper/ieeetsp98-1.pdf) Monte-Carlo'd over ~100 draws from each class prior (Stone Soup PCRB metric generator as reference, https://stonesoup.readthedocs.io/en/v0.1b9/stonesoup.metricgenerator.pcrbmetric.html); and/or Krener-Ide empirical observability Gramians — unobservability index 1/sqrt(lambda_min) and condition number (CDC 2009, https://www.math.ucdavis.edu/~krener/101-125/125.CDC09.pdf) — around nominal hypotheses of the nonlinear forward models, deciding per class whether a DE fit is worth launching.

- Rationale: R1: grid-CRLB ignores process noise, which matters exactly for the physics classes the differential-evolution fits serve; PCRB is the principled prior-averaged bound computable BEFORE any fit, and the empirical Gramian is the fit-free identifiability test for nonlinear models — both orders cheaper than one DE fit. Second-generation triage after step 9 proves out. [Needs new computation, existing scenarios.]
- Depends on: 9

### 32. [later/days] Add weighted-conformal reweighting via the discrete signature-bin frequency ratio real/synthetic once the real arm has ~30+ independent segments per coarse bin (Tibshirani/Barber/Candes/Ramdas, NeurIPS 2019, arXiv:1904.06019 — exact coverage repair under covariate shift, unusually cheap here because signatures are a small discrete key); if step 12 shows coverage-given-signature itself differs between arms, split calibration per arm instead and say so.

- Rationale: R2: deferred because the estimator is noise until the real arm has volume, and step 12's audit determines whether the shift is covariate-type at all. Resolves conflict 6's endgame. [Needs real-arm growth.]
- Depends on: 12, 24

### 33. [later/weeks] Add a certified LOWER bound on alpha* via convex/interval relaxation (dual feasible point bounds the primal) over the bandwidth-limited log-range spline family, alongside the Nelder-Mead upper bound alpha-hat; bump DETECTOR_VERSION; reserve 'exceedance forced' for lower-bound > 1 and downgrade calibrated alpha-hat exceedances to 'evidence of exceedance'; universal inference (Wasserman/Ramdas/Balakrishnan, PNAS 2020, arXiv:1912.11436) as the conservative finite-sample backstop.

- Rationale: R3: alpha-hat >= alpha* means today's statistic can never PROVE the claim its name suggests — a dual certificate is the only path to an attribution-grade statement under range unobservability, and it hardens the flagship anomaly claim against the exact adversarial reading (optimizer failed to find the feasible mundane track) a skeptical reviewer will raise.
- Depends on: 10

### 34. [later/weeks] Certify the remaining ad-hoc thresholds (consistency buckets 0.45/0.75, band-ratio buckets 1.25/2.5, rcond cuts, alpha* cut) via Learn-then-Test / conformal risk control: binomial p-value per candidate threshold that its risk (bird-reads-as-balloon rate, missed-collapse rate) is within budget on calibration groups, selection with multiplicity control, chosen thresholds versioned in configKey.

- Rationale: R2: turns every remaining tuned constant into a certified operating point under the same distribution-free umbrella (Conformal Risk Control, ICLR 2024; Learn then Test, Ann. Appl. Stat. 2025); lower priority because these constants currently sit inside the signature, so miscalibration degrades bin sharpness rather than validity — but it is the endgame for 'attach calibrated certainty' to the whole verdict.
- Depends on: 13, 20

### 35. [later/weeks] Fit the thin calibrated triage classifier (features: per-class rcond stack, min/median grid sigma_r/r, N, noise-mismatch ratio, sweep features) with isotonic calibration, coverage-validated separately on the synthetic and real-GPS arms; feed its per-class posterior into candidate ranking as a prior weight.

- Rationale: R1: the ranking picks the closest candidate 3/18 partly because it weights candidates blind to geometry-conditional attainable precision; a calibrated triage posterior is the missing prior. Keeping it a thin layer over physically-derived features keeps it defensible/auditable; two-arm validation guards synthetic-to-real drift. Waits on its feature inputs (steps 1, 9) and enough evaluation power (step 27).
- Depends on: 9, 13, 27

### 36. [later/weeks] Stand up the human tier as three typed queues — (1) alpha*-exceedance anomaly candidates with the paired control twin displayed (ask: genuine anomaly vs data defect), (2) probe approvals needing authority/resources, (3) adjudicator-vs-automated disagreements above a margin (ask: break the tie) — with analyst decision + time logging joined to buildSignature records; anything else reaching the human is a routing failure to be measured. After ~50 cases run the conditional-independence audit (arXiv:2306.01646) on both agent and human verdicts to decide whether human review stays inline or becomes a sampled audit.

- Rationale: R4: typed asks are what make human minutes (the scarcest resource) productive; value concentrates where the human has information the system lacks (arXiv:2510.26518) — anomaly adjudication and resource authority; the audit identifies signals that should migrate down into tier-0 features. alpha*-exceedance routing opens only after step 10's calibration.
- Depends on: 15, 18, 29

### 37. [later/days] Re-measure the sampling-rate/sqrt(N) result on real radiosonde/drone segments: estimate noise autocorrelation and report effective-N (N(1-rho)/(1+rho) for AR(1)-like noise) alongside raw N before the result drives any sampling-rate or triage guidance.

- Rationale: R5: real GPS texture is autocorrelated (wind, pilot control, thermal cycles), so the white-noise sqrt(N) result will overstate the value of faster sampling on real segments; interacts with step 9's noise-limited label, which should carry the real-texture correction when applied to the real arm. [Needs runs on existing real segments.]
- Depends on: 6, 9

### 38. [later/weeks] Record the IMM decision: do NOT build an IMM detector. If maneuver-onset marginalization proves necessary after the composite-null GLRT ships, add the mundane-bank mixture likelihood as one more evidence feature with FROZEN transition priors, calibrated through the same bootstrap-null pipeline as everything else.

- Rationale: R3: IMM posterior model probabilities are uncalibrated and tuning-sensitive (transition priors; range initialization), bearings-only IMM is documented as fragile (e.g. sciencedirect.com/science/article/abs/pii/S1051200422001142), and the physics battery already supplies per-model evidences via S1'; spending IMM effort before the calibration pilot, burst model, and conformal wrapper would optimize the weakest link last. Recorded as a plan item so the decision is not relitigated.
- Depends on: 17

## Conflicts found between researchers, and their resolutions

1. alpha* calibration timing — R3 says now/days (calibration pilot), R4 says later/weeks. RESOLVED: run R3's pilot now (step 10) — the fail-closed contract, configKey binding, and null-generator machinery already exist in envelopeFeasibility.js/capabilityDetect.js, and every downstream anomaly step reuses the null harness; R4's concern is honored by the explicit 'alpha*: uncalibrated-withheld' dossier status line and by keeping the anomaly escalation route closed until artifacts pass isValidCalibration.

2. Calibration philosophy — R2 (conformal guarantees calibrated on the bench) vs R5 (calibration on a DESIGNED dataset is not deployment calibration; aggregate ECE/coverage integrates over a deliberately distorted distribution). RESOLVED by scope: per-signature (Mondrian) conditional coverage is legitimate on designed data (R2's construction, step 8); AGGREGATE/deployment-facing claims come only from Arm B, the frozen holdout drawn from a written-down operational mixture prior (R5, step 13), or later from weighted-conformal reweighting (R2, step 32). R2's sim-to-real audit (step 12) measures the gap that decides which repair applies.

3. Geometry-dead terminal handling — R1 (bucket A still ships modified-polar observable products + alpha* envelope) vs R4 (unresolved-collapsed is terminal auto-close). RESOLVED: terminal for escalation and compute (no fits, no agent/human time), but the closure record ships the always-observable angular products (bearing, bearing rate, r-dot/r per Aidala & Hammel) and the anomaly status 'untestable/undetectable' — never 'clean' (R1 and R3 agree on the never-clean rule). Encoded in step 7.

4. Exchangeable unit vs replicate policy — R2 requires one conformal score per truth-content GROUP (scenario-level exchangeability is violated by the block matrix); R5 recommends 3-5 noise-seed replicates per scenario. COMPATIBLE only if the calibration harness collapses replicates to one score per group; encoded as a hard rule in step 25. Otherwise the nominal n in the conformal quantile overstates the evidence and the guarantee silently weakens.

5. rcond threshold reuse — R5's re-tag/stratification and routing use the current rcond and its -3/-2/-1 thresholds; R1 shows rcond is not parameterization-invariant (units, time origin, column scaling) and the CV-only test is silent about higher-order dynamics (Fogel & Gavish 1988). RESOLVED by ordering: harden the basis and build the per-class stack first (step 1, hours), recalibrate thresholds per dynamics order on the 855, THEN re-tag (step 2) and route (step 7). Nothing on the real-GPS arm trusts the old thresholds.

6. Per-arm vs pooled conformal calibration — R4 says calibrate synthetic and real-GPS arms separately from the start; R2 says measure the exchangeability gap first, then use weighted conformal if the shift is covariate-like, per-arm split only if coverage-given-signature itself differs. RESOLVED: start per-arm (safe, fail-closed; step 16), and let step 12's audit decide whether pooling via weighted conformal (step 32) is admissible.

7. Sample-size floors — R2's ~30-50 effective groups per bin (MIN_GROUPS_COVERAGE) vs R5's ~150 scenarios per verdict-code cell. NOT actually inconsistent: 30-50 groups is the floor to certify ANY nontrivial coverage lower bound at 95% confidence (8/8 covered certifies only ~69%); ~150 scenarios gives +/-5% Wilson precision on the quoted number. Both adopted: certify at 30+ groups (step 5), quote precision at ~150 per cell (step 13, Arm B).

8. Identity of the anomaly detector — R2 frames the anomaly leg as conformal p-values on 'the anomaly score'; R3 requires the score to be the composite-null GLRT over the extended mundane battery, gated by rcond, with Davies-mandated bootstrap nulls. RESOLVED: not competing designs — the GLRT statistic IS the conformal nonconformity score; conformal p-values + BH (step 18) are the fleet-level wrapper over the per-scenario detector (step 17). R3's rcond-bin stratification (Mondrian) is adopted as the exchangeability repair R2's construction needs.

9. Analytic vs empirical detectability — R1's CRLB detectability floor on impulse parameters (cheap, per-scenario, model-based) vs R3's empirical MDA surface (measured power at the calibrated operating point, expensive). RESOLVED: both, sequenced — CRLB floor next (step 21) so 'undetectable' vs 'clean' ships early; empirical MDA later (step 30) once the detector and operating point exist; disagreement between floor and surface is itself a finding (model error vs measurement).

10. IMM — R3 explicitly recommends NOT building an IMM detector (uncalibrated posteriors, tuning-sensitive, fragile in bearings-only); no other researcher proposes one. No live conflict, but the do-not-build decision is recorded as step 38 so it is not relitigated when maneuver-onset localization comes up.

11. Escalation trigger authority — R1's bucket policy, R2/R4's conformal set size, and R4's cost-weighted operating point all propose escalation triggers. RESOLVED as layers, not rivals: step 7's buckets gate WHICH cases may escalate (fail-closed, geometry-based); step 16's set size decides WHETHER an escalatable case is ambiguous enough to escalate; step 28's cost-model sweep picks the joint thresholds and publishes their measured error rates.

## Testable with data that already exists

- Step 1 (rcond hardening + per-class conditioning stack + per-order threshold recalibration): pure recomputation over stored LOS sets and the tractability records now being generated; no new scenarios.
- Step 2 (re-tag the 855 into a manifest + occupancy audit): batch job over existing scenarios; rcond is pre-fit and cheap.
- Step 3, gate half (primitive-detector triviality gate on existing anomaly exemplars): runs on existing spliced pairs now; the sham-splice CONTROLS need new generation through the existing splice machinery.
- Step 4 (paired analysis of spliced-impulse pairs — per-pair differences, McNemar, DeLong): analysis-code change over existing runs; the shared-noise-realization design already paid for it.
- Step 5 (Clopper-Pearson coverage lower bounds + MIN_GROUPS_COVERAGE backoff): arithmetic plus wording over existing coverage records in classProbability.js/verdictRunner.js outputs.
- Step 6 (empirical noise self-check, MAD vs declared sigma): post-processing of existing bearing series in both the 855-synthetic and real-GPS arms.
- Step 7 (router bucket assignment): derivable from existing tractability records once step 1 lands; the bucket labels can be back-filled onto every past run.
- Step 8 (conformal calibrateK refactor): recalibration pass over existing bench results — per-scenario band/truth containment is already recorded.
- Step 9 (CRLB sigma_r/r grid score + noise-limited vs geometry-limited label): a few small matrix inversions per existing scenario, no fitting.
- Step 12 (sim-to-real coverage audit): needs only a scoring pass over the EXISTING real-GPS-arm scenarios against frozen synthetic K — new verdict runs but no new data collection.
- Step 15 (offline blind-adjudicator experiment): uses existing scenarios and out-of-band truth; needs the dossier exporter plus agent inference runs, but zero new scenario data.
- Step 20 (risk-coverage curve via rcond-gate sweep): computable from existing tractability/verdict records at multiple thresholds.
- Step 21 (CRLB anomaly detectability floor): computable per existing scenario from geometry alone.
- Step 25, decomposition half (between-geometry vs between-seed variance): computable now if existing blocks already carry seed replicates per truth-content group (the block matrix suggests they do).
- Step 27, baseline half (Wilson CI on the 3/18 ranking result, conditioned on candidate count): recomputable now; ADEQUATE power needs Arm B.
- NEEDS NEW RUNS (everything else): step 10 alpha* pilot controls (>=20 lambda=1 mundanes per geometry class); step 11 burst-balloon model + probe re-run; step 13 Arm A/B/C generation (~700-1000 net new scenarios after the re-tag); step 17 bootstrap nulls; step 18 fleet calibration pool; step 22 VOI counterfactual regeneration; step 24 confusable negatives + interval relabeling; step 25 straddle top-ups; step 29 probe-planner agent runs; step 30 MDA magnitude-ladder sweep; step 31 PCRB/Gramian computation; step 32 real-arm volume growth; step 37 sqrt(N) re-measure on real texture.
