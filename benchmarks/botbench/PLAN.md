# BOT Bench — synthetic scenario families for bearings-only tracking (BOT) evaluation

STATUS: v2 — AGREED CONTRACT (2026-07-22). This version supersedes the v1
draft. Two review passes compared the draft with the codebase. The contract
includes all corrections from those reviews. The sections below are the
reviewed text, with small layout edits.

## Purpose and scope

Build an auto-generated suite of test scenarios for the traverse analysis.
The suite measures how well the analysis recovers truth from bearings alone.
Each scenario pairs one maneuvering sensor platform with one target. The
platform is a fixed-wing aircraft. The targets are the classes that an
analyst meets: balloons, birds, aircraft, celestial objects, and physically
impossible controls. The scenarios cover a range of geometries, durations,
winds, and pointing-error models.

The end goal is a paper on bearings-only tracking (BOT). The paper will give
detailed metrics on three questions:

- Which solvers give good results in which situations?
- How can observable features alone identify those situations?
- How much of a practical situation can the analysis recover?

The generator makes each scenario on demand, deterministically. It does not
store them. Similar sets collapse where possible. The first round uses only
the fast solvers.

## The five paper-facing questions

- **Q1**: When does the Kalman/RTS smoother beat constant velocity, and by how much?
- **Q2**: How does recovery degrade from orbit through curve/S-weave to straight flight?
- **Q3**: At matched angular RMS, what changes when white pointing error becomes
  autocorrelated operator wobble?
- **Q4**: Can observable diagnostics select the appropriate solver or regime?
- **Q5**: Can residual and recovery behavior distinguish anomalous motion from
  noise and ordinary maneuvering?

## Design laws (from tests/TraverseBalloonRecovery.test.js, upheld throughout)

1. **No inverse crime**: truth generators must not live inside any benchmarked
   solver's model class, and sightlines must carry noise — except in cells
   *deliberately labeled* oracle-compatible controls (CV aircraft, constant-wind
   floater, clean-noise block).
2. **Report LOS residual and truth error separately** — their divergence is a
   headline result, not an inconvenience. (Measured case in the balloon test:
   residual improved 0.074°→0.049° while truth error rose ~6× from 8 m to 49 m.)
3. **Determinism**: every stochastic component seeded via mulberry32 with seeds
   derived from a stable hash of (scenarioId, scenarioSeed, componentLabel,
   generatorVersion). No Date.now, no Math.random. Component streams are
   independent: adding a random call in one generator must not perturb another.
   Seed 0 maps to 1 (BalloonPhysics and wobble both do this; keep it uniform).

## Existing code reused (verified by both parties)

- `src/LOSFitting.js` — dataset `{sensorPos, losDir, times, count, maxRange}`
  (+ optional `minRange`), Float64. Solvers: `fitConstantVelocity`,
  `fitConstantAcceleration`, `fitKalmanFilter` (RTS, seeds from CV;
  `{processNoise, measurementNoise}` — measurementNoise is on the projected
  positional pseudo-measurement, NOT angular variance), `fitAlternatingLSQ`
  (`{order, iterations}`, CV-seeded, near-free), `fitMonteCarlo2` (sentinels
  only). CAUTION: CV/CA/KS `result.residuals` are metres; MC/ALSQ are radians —
  never compare raw residuals across solvers; all cross-solver comparison goes
  through one shared clamped dot-angle reducer (`meanAngularError` semantics).
- `src/TraverseAnalysis.js` — dataset `{n, fps, S, D, W}` (W = displacement per
  frame, not velocity). `compareTrackToTruth`, `meanAngularError`,
  `trackMetrics` (0.5 s smoothing), `fitFixedPoint`, `fitFixedDirection`
  (returns `{dir, errDeg}` only — no track). `sensorMotionStats` /
  `isRangeUnobservable` are NOT a general observability detector (they miss the
  straight-CV sensor collapse); the real diagnostic is `cvDesignRcond` below.
- `src/BalloonPhysics.js` — `integrateBalloonPositions(params, windAt)`;
  kinematic riser with seeded gusts (constant ascentRate — not full buoyancy
  dynamics; labeled accordingly).
- `src/TrackingWobbleMath.js` — `generateWobbleOffsets(params, frames, fps)`;
  deterministic drift→notice→correct operator model, pan/tilt degrees, applied
  in the clean-LOS local tangent basis.
- `src/TrackExportMath.js` — `enuBasisAt`, `ecefDisplacementToENU`.
- `src/CelestialMath.js` — astronomy-engine wrapper for time-dependent Venus
  direction (Jest-safe; see tests/CelestialMath.test.js).
- `src/DifferentialEvolution.js` — `mulberry32`.
- `benchmarks/losFitting.bench.test.js` — the harness convention this follows.
- NOT used for truth: `simulateAircraft` (would be an inverse crime when
  `fitAircraft` is benchmarked later); test-local helpers (not exported);
  the balloon test's component-wise noise construction (not isotropic).

## Common defaults

- Sample rate 10 Hz; `frames = round(durationSeconds * fps) + 1` (both endpoints).
- Core site `flat-reference`: lat 40°, lon −105°, flat ground 0 m MSL —
  explicitly a site/altitude proxy, NOT a terrain test (these solvers are
  translation-invariant; real terrain interaction is a later in-app phase).
- Full FOV 0.50° unless overridden. Frames whose pointing error exceeds FOV/2
  are marked out-of-frame and passed to solvers via `excluded`.
- Sensor: fixed-wing, 70 m/s TAS, 3,000 m AGL. Initial target bearing: north.
- Low-target horizontal ranges {2, 5, 20} km where range is an axis; else 5 km.
  Aircraft/anomalous default range 20 km.
- Primary observation noise: isotropic tangent-plane Gaussian, component
  σ = 0.03°, Box–Muller over a named mulberry32 stream.
- Every platform path must pass `R >= v² / (g·tan 30°)`; generation fails
  loudly, never silently altering speed or bank.

## Platform configurations (8)

| ID | Definition |
|---|---|
| `orbit-point` | Horizontal orbit around the target's initial ground reference point; radius = initial horizontal separation. |
| `orbit-direction-0.5` | Orbit around the position inferred from the initial LOS at 0.5× true horizontal range. |
| `orbit-direction-1.0` | Same, at 1.0× true range. |
| `orbit-direction-2.0` | Same, at 2.0× true range. |
| `curve` | Initial course perpendicular to LOS; constant 10° bank toward the target. |
| `straight` | Straight and level, initial course perpendicular to LOS (the degenerate control). |
| `s-curve-toward` | Mean course toward the target; bank 15°·sin(2πt/12 s). |
| `s-curve-perp` | Mean course perpendicular to LOS; same ±15°, 12 s bank cycle. |

## Target definitions (9 + anomalous variants)

- `party-rising` — riser generator (BalloonPhysics), 300 m AGL start, 3 m/s ascent.
- `weather-rising` — riser generator, 300 m AGL start, 5 m/s ascent.
- `party-neutral` — floater generator, 500 m AGL, zero commanded vertical rate.
- `hab-stable` — floater at {18, 20} km MSL (HAB-LONG-RANGE block only).
- `tethered-aerostat` — 600 m tether, nominal 500 m AGL, max 30° tether tilt,
  5 s response, 12 s low-amplitude sway. Labeled a simplified tether
  constraint, not a validated aerostat model.
- `bird` — 500 m AGL, mean airspeed 15 m/s, seeded correlated heading meander
  (6 s correlation), 10 m / 8 s altitude porpoising.
- `aircraft-cruise` — independent truth equations (NOT simulateAircraft),
  150 m/s straight & level at 3,000 m AGL. Oracle-compatible CV control.
- `aircraft-turn` — independent truth equations, 150 m/s, 15° bank, 2 m/s climb.
- `venus` — `CelestialMath` Venus direction at epoch 2025-02-01T02:00:00Z,
  per-frame direction truth. No pseudo-track is ever created.
- `anomalous` — aircraft-like base with parameterized events (see below).

Deferred to round 2 (recorded, not silently dropped): burst/parachute descent,
superpressure balloon, UWYO/GFS sounding fixtures, thermalling bird.

## Wind configurations (low-altitude; 4)

| ID | Definition |
|---|---|
| `zero` | u=0, v=0, variability 0%. |
| `fixed` | u=6, v=−2 m/s, variability 0%. |
| `fixed-gust` | Same mean wind, variability 12%. |
| `layered-gust` | Base u=4, v=−1 m/s; shear 8e-4 m⁻¹; kink 30 m above start; 25° veer over next 60 m; variability 12%. |

Non-climbing targets sample only their local layer — not claimed to exercise
vertical shear. HAB block uses u=20, v=8 m/s, no gust.

## Block matrix — 765 scenarios

| Block | Exact axes | Count | Questions |
|---|---|---:|---|
| `GEO-DURATION` | 8 platforms × ranges {2,5,20} km × durations {5,15,60} s × seeds {101,102,103}; target party-neutral, fixed wind, white σ=0.03° | 216 | Q1,Q2,Q4 |
| `TARGET-WIND` | (4 low balloon/aerostat targets × 4 winds) + bird + aircraft-cruise + aircraft-turn + venus = 20 cases; platforms {orbit-point, curve, straight}; 15 s; seeds {201,202}; white σ=0.03° | 120 | Q1,Q2,Q4 |
| `HAB-LONG-RANGE` | floater MSL {18,20} km × range {20,50,100} km × platforms {orbit-point, orbit-direction-0.5/1.0/2.0, curve, straight} × seeds {211,212}; 60 s; wind u=20,v=8; white σ=0.03° | 72 | Q1,Q2,Q4 |
| `MATCHED-NOISE` | platforms {orbit-point, curve, straight} × targets {party-neutral, aircraft-cruise} × durations {5,15,60} s × seeds {301,302,303} × {wobble, matched-white}; FOV 0.90° | 108 | Q1,Q3,Q4 |
| `ANOMALY-CONTROL` | 6 event tuples × {anomalous, ordinary-control} × platforms {orbit-point, straight} × noise {clean, matched-white, wobble} × seeds {401,402}; 15 s; 20 km | 144 | Q4,Q5 |
| `CLEAN-CONTROL` | GEO-DURATION geometry matrix (8×3×3), seed-101 truth, zero observation error | 72 | Q1,Q2,Q4 |
| `RATE-30HZ` | platforms {orbit-point, straight, s-curve-perp} × ranges {2,20} km × durations {15,60} s; party-neutral, seed 101, white σ=0.03°, 30 Hz | 12 | Q1,Q2 robustness |
| `DURATION-120S` | platforms {orbit-point, straight, s-curve-perp} × targets {party-neutral, bird, aircraft-cruise, venus}; seed 101, white σ=0.03°, 10 Hz, 120 s | 12 | Q1,Q2,Q4 robustness |
| `SITE-PROXY` | sites {ocean, denver, cheyenne-mountain} × targets {party-rising, hab-19km, venus}; orbit-point, 15 s, seed 501, white σ=0.03° | 9 | Q2/Q4 invariance sentinel |
| `RECOVERABLE-NOISE` (round 1.1, audit R3) | platforms {orbit-point, curve} × targets {party-neutral, bird, aircraft-turn} × range 2 km × 60 s / 10 Hz × wind fixed × obs {clean, wobble, matched-white} (FOV 0.90°) × seeds {601–605} | 90 | Q1, Q3 in the RECOVERABLE regime |

Site sentinels (all still flat elevation; no result may be described as a
terrain result): `ocean` 35°, −125°, 0 m; `denver` 39.7392°, −104.9903°,
1,609 m; `cheyenne-mountain` 38.744°, −104.846°, 2,900 m.

A scenario = one generated observation stream; solver configs do not multiply
the count. Wobble params for MATCHED-NOISE: amplitude 0.15°, driftSpeed
0.10°/s, reactionTime 0.40 s, correctionSpeed 1.00°/s, accuracy 0.80. Realized
2D angular RMS is measured post-generation; the paired white draw is rescaled
by one scalar to match it exactly (no extra white noise on the wobble member).
The predefined seeds must produce zero FOV exclusions in this 0.90° block —
asserted, not regenerated. Other blocks retain native FOV exclusions as an
operational result.

## Anomaly events (6 tuples + control derivation)

| ID | Anomalous event |
|---|---|
| `pulse-20g` | onset 5 s, half-sine accel pulse, 2.0 s, peak 20 g, lateral-left |
| `pulse-100g` | onset 9 s, half-sine pulse, 0.5 s, peak 100 g, lateral-right |
| `transition-90` | onset 5 s, 2.0 s, speed 120→250 m/s, 90° heading change right |
| `transition-180` | onset 9 s, 1.0 s, speed 120→300 m/s, 180° heading change left |
| `impulse-east` | onset 5 s, discontinuous ENU Δv = [150, 0, 0] m/s |
| `impulse-north` | onset 9 s, discontinuous ENU Δv = [0, 150, 0] m/s |

Each ordinary control shares the same initial trajectory, onset, direction,
platform, and EXACT pointing-error realization. Pulse controls: same
duration/profile at peak 2.5 g. Transition controls: same duration/direction,
velocity-change vector scaled to the largest magnitude achievable without
exceeding 2.5 g. Impulse controls: discontinuity replaced by a 2 s
raised-cosine acceleration capped at 2.5 g.

## Solver configurations (8 primary = 6,120 runs)

`cv`, `ca`, `ks-default` (q=1e-4), `ks-q1e-5`, `ks-q1e-3` (KS grid reported as
a sensitivity study, not calibration), `alsq2` (`{order:2, iterations:12}`),
`fixed-point`, `fixed-direction`. MC2 (order 2, 500 trials,
losUncertaintyDeg = scenario's realized RMS) runs on 8 named sentinel
scenarios only.

## Conditioning diagnostic (the Q4 regime feature)

For active frames: center/normalize time `tau = (t − midpoint)/halfSpan`;
build CV design blocks `P_i = I − d_i d_iᵀ`, `B_i = P_i[I, tau_i·I]`,
`G = Σ B_iᵀ B_i`; equilibrate `C = D^-1/2 G D^-1/2` with `D = diag(G)`;
`cvDesignRcond = sqrt(λmin(C)/λmax(C))` — dimensionless, invariant to units
and time origin, comparable across 5–120 s clips (design-matrix conditioning,
not squared normal-matrix). Recorded: `cvDesignRcondObserved` (classifier
feature; post-FOV-exclusion), `cvDesignLog10RcondObserved`,
`cvDesignEffectiveRank` (eigenvalues > 1e-10·λmax), `cvDesignRcondCleanOracle`
(diagnosis only, never a classifier input), `cvNormalLambdaMinOverTrace`
(secondary). Never thresholded into observable/unobservable at generation
time — kept continuous. Note NaN/Infinity must be sanitized before JSON
(JSON.stringify silently nulls them).

## Module API (locked)

`generateScenario(spec, {scenarioSeed, generatorVersion})` → `BotScenario`.
Synchronous, deterministic, no filesystem or network access.

```ts
type BotScenario = {
    schemaVersion: 1;
    generatorVersion: string;
    scenarioId: string;       // hash of canonical spec + seed + generatorVersion
    scenarioGroupId: string;  // same family with noise/rate/site/duration controls grouped
    blockId: string;
    pairId: string | null;    // matched-noise or anomaly/control pair
    scenarioSeed: number;
    rngSeeds: {platform; target; wind; observation; event};   // all uint32

    spec: {
        durationSeconds; fps; initialHorizontalRangeM: number | null; siteId;
        platform: {kind; speedMS; altitudeAGL; bankDeg?; bankAmplitudeDeg?;
                   bankPeriodSeconds?; rangeErrorFactor?};
        target: {kind; family; parameters: Record<string, number|string|boolean>};
        wind: {kind; parameters: Record<string, number|string|boolean>};
        observation: {kind: "clean"|"white"|"wobble"; fovFullDeg;
                      gaussianSigmaDeg?; wobble?: {amplitude; driftSpeed;
                      reactionTime; correctionSpeed; accuracy};
                      matchedToPairId?};
    };

    n: number; fps: number; durationSeconds: number;
    times: Float64Array;                     // n, seconds from start

    site: {id; latDeg; lonDeg; groundElevationMSL;
           surfaceModel: "flat-elevation-proxy"; epochISO};

    platform: {
        positionENU: Float64Array;           // 3n
        feasibility: {valid; phiMaxDeg: 30; minimumRadiusM;
                      minimumActualRadiusM; offendingFrame: number|null};
    };

    target:
        | {kind: "track"; family; positionENU: Float64Array /*3n*/;
           valid: Uint8Array}
        | {kind: "direction"; family: "venus"; body: "Venus";
           directionENU: Float64Array /*3n; may vary with time*/;
           valid: Uint8Array};

    wind: {displacementPerFrameENU: Float64Array;   // 3n; final triple zero
           sampledVelocityENU: Float64Array};        // 3n, m/s

    observation: {
        cleanDirectionENU: Float64Array;     // 3n
        observedDirectionENU: Float64Array;  // 3n
        tangentErrorDeg: Float64Array;       // 2n (pan/tilt in tangent basis)
        angularErrorDeg: Float64Array;       // n
        inFov: Uint8Array;                   // 1 iff error <= FOV/2
        excluded: ReadonlySet<number>;
        fovFullDeg; outOfFrameCount; outOfFrameFraction;
        realizedRmsDegAllFrames; realizedRmsDegActiveFrames;
        realizedMeanDeg; realizedMaxDeg;
    };

    events: Array<{eventId; pairId; family: "pulse"|"transition"|"impulse";
                   anomalous: boolean; onsetSeconds; endSeconds;
                   directionENU: [n,n,n]; parameters}>;

    constraints: {minRangeM: number|null; maxRangeM: Float64Array|null};

    diagnostics: {sensorPathLengthM; sensorSpanM;
                  cvDesignRcondObserved; cvDesignLog10RcondObserved;
                  cvDesignEffectiveRank; cvDesignRcondCleanOracle;
                  cvNormalLambdaMinOverTrace};   // all number|null
};
```

Adapters (views, not copies — `sensorPos/S`, `losDir/D`, `times` alias the
canonical buffers):

```js
toLOSDataset(scenario, {los = "observed"} = {})
  -> {sensorPos, losDir, times, count, maxRange, minRange}
  // caller passes scenario.observation.excluded to the LOS fitters

toTraverseDataset(scenario, {los = "observed"} = {})
  -> {n, fps, S, D, W}

toActiveTraverseDataset(scenario, {los = "observed"} = {})
  -> {dataset: {n, fps, S, D, W}, frameIndices: Uint32Array}
  // the ONLY compacting adapter; used ONLY for fitFixedPoint /
  // fitFixedDirection (they accept no exclusion set). Fixed-point results
  // expand back to the full grid as the same point; fixed-direction stays
  // direction-kind. Ordinary track metrics are never compacted (skipped
  // frames would desync W and fixed fps).
```

`runSolver(scenario, solverSpec)` → `BotBenchRunRecord`. Catches exceptions
and null/non-finite results so one failed solver cannot abort the sweep.

```ts
type BotBenchRunRecord = {
    schemaVersion: 1; generatorVersion: string;
    runId; scenarioId; scenarioGroupId; blockId; pairId; scenarioSeed;

    axes: {platformKind; targetFamily; truthKind: "track"|"direction";
           windKind; noiseKind; durationSeconds; fps;
           initialHorizontalRangeM: number|null; siteId; fovFullDeg;
           eventFamily: string|null; anomalous: boolean|null};

    solver: {id; family; options; outputKind: "track"|"direction"};

    status: "ok"|"insufficient-active-frames"|"null-result"
          |"non-finite-result"|"exception";
    error: null | {name; message};
    timing: {wallMs};

    samples: {totalFrames; activeFrames; excludedFrames; outOfFrameFraction;
              analysisMask: "native-fov"|"pair-common"};

    scenarioDiagnostics: {sensorPathLengthM; sensorSpanM;
        cvDesignRcondObserved; cvDesignLog10RcondObserved;
        cvDesignEffectiveRank; cvDesignRcondCleanOracle;
        observedNoiseRmsDeg; activeNoiseRmsDeg};

    estimateSummary:
        | {kind: "track"; finiteFrameFraction; behindSensorFraction;
           rangeStartM; rangeMidM; rangeEndM; rangeMeanM;  // number|null
           parameterSummary}
        | {kind: "direction"; directionENU: [n,n,n]; parameterSummary};

    metrics: {
        angular: {observedMeanDeg; cleanMeanDeg; observedP95Deg;
                  observedMaxDeg; cleanP95Deg; cleanMaxDeg},  // number|null
                  // ONE shared clamped dot-angle definition for all solvers

        truth:
            | {kind: "track"; comparable; reason; framesUsed;
               meanSeparationM; maxSeparationM; meanHorizontalSeparationM;
               meanAbsAltitudeErrorM; meanSignedAltitudeErrorM;
               meanSpeedAbsErrorMS; meanHeadingAbsErrorDeg; meanTruthRangeM;
               rangeError: {startM; startFraction; midM; midFraction;
                            endM; endFraction}}
            | {kind: "direction"; body: "Venus"; framesUsed;
               meanDirectionErrorDeg; p95DirectionErrorDeg;
               maxDirectionErrorDeg;
               fittedRange: null | {startM; midM; endM; meanM}};
               // finite solvers vs direction truth: fitted positions become
               // per-frame sensor→estimate directions; fitted ranges recorded
               // ONLY as cross-seed instability diagnostics. fixed-direction
               // has fittedRange:null. No 3D separation / speed / pseudo-range
               // accuracy is invented. Venus's true direction drifts over the
               // clip while fixed-direction is constant — measured, not hidden.

        kinematics: null | {groundSpeed; airSpeed; verticalSpeed; gLoad;
                            turnRate; altitude; range}; // StatSummary each

        anomaly: null | {global: EventBlindAnomalySummary;
                         events: EventLocalMetric[]};
    };

    failureFlags: {solverFailed; nonFinite; behindSensor;
                   activeCoverageBelow50Pct;
                   relativeRangeErrorAbove50Pct: boolean|null};
                   // range-failure rule never applies to direction truth
};
```

Full fitted tracks / Kalman state are NOT written into records; only
summaries. An opt-in debug artifact may store selected tracks separately.

## Anomaly metrics (event-local + event-blind)

Windows (truth annotations used for EVALUATION only): `pre = [onset−2 s,
onset)`, `event = [onset, end)`, `post = [end, end+2 s]`, `local` = union;
impulse `end = onset + 1/fps` for window purposes; clipped to the scenario;
all statistics on the FOV-active mask; a window with fewer than
`max(5, ceil(0.5·fps))` active frames reports null + coverage, never zero.
Pair contrasts use the common active mask.

`EventLocalMetric`: coverage {pre,event,post,local}; observed + clean
`WindowedResidualMetrics`; truthError (track: pre/event/post mean, event/local
max, metres; direction: same in degrees); kinematicRecovery (null for
direction estimates): truth/estimated peak g + ratio, truth/estimated ΔvENU +
magnitude ratio + direction error, heading-change error, estimated half-max
width, peak timing error. Δv recovery via independent LSQ line fits of
position vs time over `[onset−1.0, onset−0.2]` and `[end+0.2, end+1.0]`
(each side ≥5 active samples). Peak g / half-max width from the 0.5 s-smoothed
trackMetrics series. Impulses: truth peak g and width are null — the declared
Δv IS the truth metric.

`WindowedResidualMetrics`: per-window {count, mean, rms, p95, max};
`eventMeanLift = event.mean − pre.mean`; `postMeanLift`; `localPeakLift =
local.max − pre.mean`; `excessAreaDegSeconds = Σ max(0, residual − pre.mean)·dt`
over event+post; `localPeakRobustZ` (median(pre), scale
max(1.4826·MAD(pre), 1e-4°)); `peakDelaySeconds`.

Event-blind (global) metrics, kept separate: whole-clip observed/clean
mean/p95/max residual; whole-clip truth error and kinematics;
`globalPeakRobustZ` from the whole residual series; event-blind max 2 s
excess-area score; event-blind time of largest excursion.

Q5 reports: event-local sensitivity; event-blind anomaly-vs-control ROC
AUC + precision/recall; paired excess-area differences under identical
platform/onset/direction/seed/noise. No anomaly threshold selected on final
test data.

## Q4 classifier protocol (milestone M3)

Data unit = one scenario (its solver records joined). MC2 excluded from
training. Oracle action label: direction truth → `fixed-direction`; track
truth → eligible finite solver (CV, CA, 3×KS, ALSQ2, fixed-point) minimizing
`meanSeparationM / meanTruthRangeM`; failed/non-finite = infinite loss; ties
within `max(1e-4, 0.01·bestLoss)` broken by simplicity order `cv,
fixed-point, ca, alsq2, ks-default, ks-q1e-5, ks-q1e-3`.

Allowed features (observable only): duration, rate, FOV, active fraction;
sensor path length/span; cvDesignRcondObserved + log + effective rank;
observed LOS drift/autocorrelation summaries; each cheap solver's observed
residuals + pairwise gaps; fitted-range summaries + within-fit instability;
non-finite/behind-sensor flags; fitted kinematic summaries.
Forbidden: target family, truth kind, platform label, noise label/σ, clean
LOS, truth range/trajectory, clean conditioning, event annotations, site
label, scenario seed.

Split: core pool = GEO-DURATION + TARGET-WIND + HAB-LONG-RANGE +
MATCHED-NOISE + ANOMALY-CONTROL + CLEAN-CONTROL + RECOVERABLE-NOISE (822
scenarios; the original text said 732, before round 1.1 added
RECOVERABLE-NOISE, which joins the core pool); external sentinel pool =
RATE-30HZ + DURATION-120S + SITE-PROXY (33), never used for
fitting/features/thresholds.

**Grouping (as implemented; supersedes the original "truth+seed stay
together" wording)**: groups use the canonical TRUTH-CONTENT KEY, built from
the complete generating spec (platform, target minus the anomalous flag,
wind, range — never pairId/blockId, which carry seeds and block prefixes),
with the seed appended ONLY for stochastic generators (gusty wind, bird,
tethered aerostat). Deterministic content merges across seeds AND noise
variants, so identical truth can never straddle the split; an INDEPENDENT
signature assertion in classify.bench.test.js enforces
one-group-one-partition. Stratified (truth-kind × target-motion family ×
platform family) hash-sort with split seed 0xB07B3C; 70/15/15 train/val/test
by GROUP; equal group weights with 1/variantsInGroup; the cluster bootstrap
resamples groups using the ORIGINAL weight function (recomputing weights on
the resample cancels multiplicity and collapses the CI).

**Models (as implemented)**: the OPERATIONAL paper-facing rule is a
cost-sensitive depth-3 tree whose splits and leaves minimize expected clamped
normalized action loss (track truth: min(1, relSep); fixed-direction chosen
on a track: 1; direction truth: fixed-direction 0, any finite solver 1). The
originally-contracted class-BALANCED CART is retained as the preregistered
sensitivity model only — its balanced weights inflate rare classes (measured
multipliers up to ~59×) and are not fit for the operational rule. Also
reported: an unbalanced group-weighted CART, and the multinomial L2 logistic
regression (standardized; C from {0.01,0.1,1,10} by validation macro-F1) as
a post-hoc/internal sensitivity model. The depth-1 rcond stump is NOT an
action picker: it is a BINARY regime detector (target: CV loss > 0.10),
reported with weighted ROC-AUC and PR-AUC and TWO operating points — Youden J
(paper-facing, prevalence-robust) and accuracy-optimal (labeled
prevalence-sensitive: at ~0.87 prevalence raw accuracy barely beats "always
unrecoverable"). Baselines: always-CV; lowest-observed-residual;
most-common-training-action.

**Evaluation (as implemented)**: ALL metrics group-weighted, including the
confusion matrix and macro-F1 (over the UNION of true and predicted labels)
and the regret quantiles. Predicting fixed-direction on track truth counts as
infinite regret AND catastrophic — never excluded. Catastrophe is reported as
the ORACLE FLOOR (best achievable; a property of geometry) plus POLICY-ADDED
EXCESS, and the excess is the headline. The abstain (rcond-floor) curve uses
group-weighted coverage and is a coverage/excess trade, NOT a
safety-improving abstention rule (the floor concentrates unavoidable-failure
cases). Direction-regime conclusions rely on the sentinel pool (core
direction groups are too few to reach test). Regime-stratified results
(oracle loss ≤0.10 recoverable / >0.5 structurally-collapsed / else
intermediate) and leave-one-platform-family-out are secondary checks.
Cluster-bootstrap 95% CIs by group; sentinel pools reported separately.

**Post-hoc caveat (recorded)**: the original test partition was observed
before the audit corrections; models were refit on the repaired grouping with
unchanged form and no test-driven hyperparameters. The re-evaluation is
labeled audit-corrected, not freshly preregistered.

## File layout & execution

```
benchmarks/botbench/PLAN.md                  # this contract
benchmarks/botbench/lib/rng.js               # seed hash, streams, gaussian
benchmarks/botbench/lib/platforms.js         # 8 paths + feasibility check
benchmarks/botbench/lib/targets.js           # risers/floaters/aerostat/bird/aircraft/venus/anomalous
benchmarks/botbench/lib/wind.js              # 4 configs -> windAt closures + sampled series
benchmarks/botbench/lib/observation.js       # clean LOS, white, wobble, FOV mask, realized stats
benchmarks/botbench/lib/generateScenario.js  # assembles BotScenario
benchmarks/botbench/lib/adapters.js          # the three adapters
benchmarks/botbench/lib/diagnostics.js       # cvDesignRcond (6x6 Jacobi eigen)
benchmarks/botbench/lib/solvers.js           # 8 solver configs + MC2 sentinel wrapper
benchmarks/botbench/lib/metrics.js           # angular/truth/kinematics/anomaly
benchmarks/botbench/lib/blocks.js            # the 9-block matrix -> specs
benchmarks/botbench/lib/runner.js            # runSolver, sweep, aggregation
benchmarks/botbench/botbench.bench.test.js   # deliberate Jest entry; writes results/
tests/botbench/generator.test.js             # fast CI smoke: determinism, feasibility,
                                             # adapter aliasing, schema invariants
```

- npm script `bench-bot` following the `bench-losfit` convention (explicit
  path + `--testPathIgnorePatterns /node_modules/ --forceExit`); Jest in-band
  for reproducible timings.
- Results to `benchmarks/botbench/results/` — gitignored via the exact root
  rule `/benchmarks/botbench/results/`. the in-progress analysis notes live in the
  private repo (`private/botbench/`), not in this tree.
- Generate each scenario once; run all solvers against it; retain compact
  records only. Timings under Jest/Babel are ratios, not absolute (~17×
  slower than the bundle).
- Runtime budget: laptop minutes. 765 scenarios × 8 cheap solvers; KS is the
  only one needing a timing check before scaling; MC2 sentinel-only; no live
  fetches, no DE physics fits, no real terrain, Venus ephemeris computed once
  per scenario block and interpolated.

## Post-audit amendments (2026-07-22, findings review — all agreed)

Round 1 total is now **855** scenarios (765 + RECOVERABLE-NOISE). Fixes and
explicit deviations from the original contract text:

1. **On-sensor collapse convention**: an estimate within 1e-6 m of the sensor
   scores a defined **180°** residual (matching `meanAngularError`'s on-sensor
   convention), is counted as a NON-DETECTION in anomaly pools (flat series →
   robust-Z 0), and is flagged (`onSensorFraction`, `collapsedOnSensor`) —
   never silently omitted. Non-finite frames are a DIFFERENT failure: they
   stay NaN/excluded and set `nonFinite`. (The original silent NaN-drop
   inflated CV's anomaly AUC from 0.55 to 0.74 — a selection bias.)
2. **Seed streams**: balloon gusts draw from `rngSeeds.wind` (they are wind
   stochasticity), keeping component streams genuinely independent.
   generatorVersion bumped to "1.1" accordingly.
3. **MC2 sentinels** pass a scenario-derived `seed` to `fitMonteCarlo2`.
4. **Event statistics** (peak-g, half-max width) use the FOV-active mask; the
   0.5 s smoothing window may still SPAN excluded frames (differentiation
   support, not statistics inclusion). Whole-clip `kinematics` remain
   properties of the ESTIMATE over all frames by design — the active mask
   governs measurement-derived statistics.
5. **Transition event metadata**: `directionENU` is the normalized APPLIED
   velocity-change direction; impulse controls record
   `appliedDeltaVMagnitudeMS` (capped), not just the requested Δv.
6. **Q3 is a PAIRED design with a clean-recoverability gate**: per-pair (same
   truth/seed) wobble−white separation deltas with guarded ratios; pairs with
   a failed/collapsed member are counted (`pairsFailed`), never dropped. In
   RECOVERABLE-NOISE each contrast is additionally GATED on the same solver's
   paired clean run recovering (clean relSep ≤ 0.10;
   `pairsCleanUnrecoverable` counts gate drops) — a noise contrast only means
   "noise did this" when the solver works at all on clean data.
   MATCHED-NOISE has no clean members: its ungated rows are an
   observability-loss statement, not an accuracy comparison.
7. **Q5 adds paired anomaly−control excess-area differences** per contract,
   alongside pooled AUC (with per-solver collapsed-rate column).
8. **failRate** is real: non-ok status, on-sensor collapse, or >50% median
   relative range error, over all group members; Q1/Q2 tables group by range
   (the 15 s "bimodality" was range strata, not stochastic).
9. **Documented deviations**: (a) the tethered aerostat conflates PLAN's
   "nominal 500 m AGL / 600 m tether" — with a rigid 600 m tether and a 30°
   tilt cap, altitude lives in [520, 600] m; kept as the simplified model,
   labeled as such. (b) `wind.sampledVelocityENU` records the MEAN wind only;
   the gust realization lives inside the truth integrators — M3 must exclude
   or downweight air-relative kinematic features on gusty balloon cells.
10. **M3 additions** (from the audit): depth-1 rcond-only decision-stump
    baseline (threshold learned on training data — the −3/−2/−1 bucket edges
    are exploratory only); rcond treated as a CV-FAMILY failure predictor,
    not universal recoverability (fixed-point succeeds where CV collapses);
    an explicit abstain/unrecoverable sensitivity analysis with a
    coverage-vs-catastrophic-risk curve; missingness / residual coverage /
    on-sensor fraction as features; co-grouping of deterministic clean
    duplicates across seeds; regret reported separately for
    clean-recoverable, noise-induced-failure, and structurally-collapsed
    regimes.

## Milestones

- **M1** — lib/rng, platforms, targets, wind, observation, generateScenario,
  diagnostics, adapters + tests/botbench smoke tests green.
- **M2** — solvers, metrics, blocks, runner, bench entry; full 765-scenario
  sweep runs locally; results JSON + aggregated per-block markdown tables
  answering Q1–Q3, Q5 descriptively and exporting Q4 features.
- **M3** — classifier protocol (CART + baselines + split hygiene) over M2
  records; paper-facing tables and figures.
- **M4 (Mick, 2026-07-22)** — a USER-FACING document with diagrams and tables
  explaining what was done and the results, written after the current tasks
  (M1/M2 sweep + initial analysis) are complete. DONE 2026-07-22 (after the
  audit's "M4-GO"): private/botbench/BOTBench-Report.html — also
  published as a private artifact.
- **Round 2 (deferred, recorded)** — physics/spline solvers on interesting
  cells; UWYO/GFS wind fixtures; burst/superpressure balloons; real terrain
  in-app; sitch-JSON bridge for visual MCP inspection of selected scenarios.
  - **Sitch bridge DONE (2026-07-22)**: `lib/exportKml.js` +
    `export.bench.test.js` (`npm run bench-bot-export`) emit per-track KML
    (one file per track — sibling placemarks in one Document import as
    SEGMENTS and concatenate, verified live). Import via serve-file.sh +
    `DragDropHandler.uploadURL`; wire with setMenuValue
    (cameraLocation/*Position, target/*Target Track, cameraHeading/*Camera
    Heading=To Target). Use the `ocean` site for visual exports (flat-proxy
    altitudes render correctly only where real ground ≈ 0; `flat-reference`
    at 40/−105 sits under mile-high Colorado terrain) and a daytime epochISO.
  - **End-to-end validation PASSED**: orbit-balloon-5km-60s bridged into the
    live app; `window._traverseDebug.runTraverseAnalysis()` ran the full
    gallery; the "Constructed LOS — validation only" banner fired correctly;
    Constant Altitude recovered the truth exactly (3.0 NM slant, 12.3 kt =
    the true 6.3 m/s wind drift), Constant Air Speed found the slow-drift
    valley at 12.2 kt, CV/KS passed broad screen at the right range —
    matching the benchmark's 0.6%-error prediction for this cell.
  - **Round-2 lead**: the Sky Lantern/Balloon tile came back "Provisional
    fit — Optimizer incomplete" on a GENUINE balloon scenario (right range,
    but flagged). Investigate the in-app DE budget/window against this cell.

## Q6 — Solution families and calibrated class percentages (2026-07-27)

Added after the round-2 sitch bridge, on the same contract terms as the rest of
this file: the numbers must be measurable, and every limit on what they mean
must be printed with them rather than left to a reader's charity.

**The question.** Two things the gallery could not do. It drew ONE trajectory
per interpretation even when the evidence supports a family, so a reader could
not see the uncertainty; and with ~100 tracks there was no way to triage
without reading ~20 tiles each. Q6 is: *can the analysis report the range it
actually admits, and can a bulk run assign calibrated per-class percentages?*

**Range bands (`src/TraverseFamily.js`).** Each physics model is re-fitted with
its start range LOCKED at each rung of a ladder; the rungs whose fit stays
acceptable are the model's admitted band. Locking is a reduced search vector in
`fitPhysicsModel` (`options.paramLocks`) because Nelder-Mead degenerates on a
zero-width bound; `fitAircraft` needs no change, since DE and pattern search
both take one safely and `assessBoundPins` already skips zero-span coordinates
so a lock can never be reported as a capability limit. The march is a
continuation (each rung seeded from its solved neighbour), with a global
DE probe at both ladder ends to catch a march that followed the wrong basin —
these landscapes are multimodal, which is why the production fits use DE.
Non-contiguous admitted sets are reported as SEPARATE intervals: a gap was
tested and rejected, and filling it would invent excluded solutions.

**Acceptance width.** `accept = max(bestErr·K, bestErr + 0.02°, 0.05°)`. K is
the one free knob and is NOT derivable — there is no calibrated σ_LOS here
(`params.errFloor` is a generic CA-fit residual, explicitly not a noise
estimate). It is calibrated against truth coverage: pick the SMALLEST K
reaching 90% containment on train, report achieved coverage on test. A class
that never reaches the target is a finding (the band construction is missing a
degree of freedom), not something to fix by widening.

**Bulk runner (`lib/verdictRunner.js`, `verdict.bench.test.js`).** Calls the
SHIPPING analysis — `buildHypotheses` / `rankAllHypotheses` /
`assessExecutiveVerdict` — so a change to the app shows up in the numbers.
~18 s per scenario without bands, ~30-60 s with; the full matrix is an
overnight job, hence `BOTBENCH_VERDICT=smoke|pilot|full` plus OFFSET/LIMIT
chunking.

**Percentages (`lib/classProbability.js`).** NOT a cross-model likelihood —
Sitrec computes none and none is implied. They are measured frequencies over
this population: of the scenarios whose analysis produced the same evidence
signature, this fraction actually were each class. Equal weight per
`truthContentKey` group (so repeated seeds cannot outvote distinct content),
intervals from resampling GROUPS (a Jeffreys binomial would be incoherent with
fractional weights), split by group so no truth content appears on both sides,
and a hierarchical backoff whose coarser keys are strict prefixes of the finer
ones. A bin under 8 independent groups abstains to Unknown rather than guessing.

**What this matrix CANNOT calibrate — reported as such, never as 0%:**

- `multirotor`: no multirotor target exists. Adding one needs independent truth
  equations; generating it from `QuadcopterModel` would violate design law 1.
- `stationary`: no stationary or ground-bound target.
- `bird`, `aerostat`, `anomalous`/`anomalous-control`: no Sitrec class. They
  count as Unknown, which is the correct answer. How often a bird instead reads
  as a balloon is a headline result, not a rounding error.

**Why the balloon class tops out at "consistent with".** A scenario's wind is a
hand-set constant, which `rateBalloonWindEvidence` already classifies as an
assumption and rates *inconclusive*. Feeding it in as though it were a measured
sounding would MANUFACTURE the corroboration that licenses "Probably a
wind-blown balloon". So the benchmark deliberately cannot reach that verdict,
and `verdictRunner.test.js` asserts it never does. Calibrating that verdict
needs real sounding fixtures (the deferred UWYO/GFS work).

**Reduced profile.** The runner omits the wind-pinned balloon variant, the
drone-control fit, live LOS-fit method nodes, and balloon wind evidence. The
list is exported as `ABSENT_HYPOTHESES` and printed in every report, so a
coverage claim cannot quietly omit half the analysis.

## Round 3 amendment (2026-08-15) — real-track and maneuver arms, tractability study

This amendment adds two scenario arms and one study to the contract. Round 1
and round 2 above are unchanged.

### Why the scope grows

Rounds 1 and 2 measured recovery over a synthetic matrix. Three questions
stayed open, and each needs data the matrix cannot supply:

- Which sightline sets are worth solving at all, and can that be decided
  BEFORE fitting?
- How much confidence does a verdict deserve, and does the verdict code carry
  that confidence honestly?
- Can a genuine anomaly be told apart from hard geometry, at a controlled
  false-positive rate?

### Arm R — real-track targets

Target truth is cut from recorded GPS tracks (radiosondes, amateur balloons,
drone flight logs). The observation layer stays synthetic and declared, so the
noise model is still controlled. Modules: `lib/realSegments.js` (loader) and
`lib/realScenarioSet.js` (the scenario set). Bench: `bench-bot-real`.

Contract rules for this arm:

1. **Window selection is a declared rule**, never a hand-typed row range. The
   rules are `offset`, `altitude` (first crossing), `burst` (altitude maximum),
   and `peak-speed` (fastest run of the requested duration).
2. **A scenario commits to the source bytes.** The loader records a sha256 of
   the file it read, the rule, the rule arguments, the resolved window start,
   the rate, and the cleaning caps. The registry key includes every one of
   them, so a stale registration cannot satisfy a newer spec.
3. **Truth hygiene is declared, not silent.** Real logs carry two artifact
   classes: isolated position excursions (despiked) and datum-shift steps
   across telemetry gaps (bridged under a per-file speed cap). Both counts
   travel in provenance. Altitude bridges only on its own evidence.
4. **Anomaly pairs are spliced, not simulated.** An anomalous member adds a
   constant delta-v to the real motion from a declared onset; its control is
   the same segment with the same noise realization and the same event window
   at zero delta-v. The two members differ by nothing else, which is what the
   arm exists to provide: the control carries real texture.
5. **Source data stays local.** The tracks are not redistributed with the
   repository (see `.gitignore`); the README in `real-tracks/` documents the
   APIs and the fetch recipes.

Case geometries in the first set: a fast high platform over a mid-altitude
drifter; a low platform arcing past a near-surface riser; two-orbit passes of
slow movers; a radiosonde burst window (a mundane object with a violent
dynamics discontinuity, used as a false-positive probe); a fast drone segment
seen from long range; and tight fixed-wing circuits.

### Arm M — maneuver-class targets

Thirteen shape classes spanning the model-violation ladder: static point,
straight constant-velocity, straight constant-acceleration, slow
constant-radius turn, instantaneous acceleration (speed step, direction
held), instantaneous 90-degree turn, zig-zag, sustained high-g turn,
hypersonic glide, sine wave, corkscrew, vertical loop, and figure-eight.
Modules: `lib/maneuverTargets.js` and `lib/maneuverSet.js`.
Bench: `bench-bot-maneuver`.

**The maneuver botsets** (`lib/botsetManeuvers.js`, `bench-bot-maneuvers`)
sweep the full taxonomy as 23 parameter variants — both directions of the speed
step; 20 g and 50 g high-g turns with and without a lead-in; hypersonic at
Mach ~6 (dive and pull-up) and Mach 50; plausible and impossible sine, loop
(aero / too slow / too fast) and figure-eight members — at four clip durations
(20/60/120/300 s) and three operator-error levels.

The taxonomy is PARTITIONED BY ANOMALY into two published sets:
`botset_anomalies` (15 variants, no conventional model should fit) and
`botset_mundane` (8 variants, a conventional model exists and must be found).
They share a spec builder, a seed and both ladders, so results are directly
comparable; what the split buys is that "did we find the mundane answer" and
"did we correctly report an anomaly" stop being one mixed number over one mixed
folder.

The ERROR LADDER IS A PERCENTAGE OF THE FIELD OF VIEW (0 / 5 / 20 pct), not an
absolute angle — see `lib/botsetErrors.js`. Field of view is sized per scenario
from the target and its range, spanning 0.46 to 3.82 deg, so a fixed angular
error would be 33% of the frame in one scenario and 3.9% in another and the
ladder would sweep difficulty and geometry together. The resolved degrees are
still published in `scenario.json`'s `losError` and in every manifest row.

Output tree: `results/botset_<set>/batch_<D>s/<E>pct/{Input,Truth,All,meta}`
with a manifest per folder and per-batch generation times in
`results/botset_<set>/timing.json`. Both sidecars live in `meta/` so the CSV
folders hold only CSVs; that trades the folder-level blinding a sealed release
needs, which is why `writeInterchange` keeps the sibling layout as its default
and refuses to combine `sidecarDir` with `descriptiveName`. Error level lives
outside the truth key, so one variant's three error members are the same flight
observed three ways.

Batch generation and its integrity checks live in `lib/botsetManeuverBatch.js`,
shared by the sequential bench and by `run-botset-maneuvers.mjs`
(`bench-bot-maneuvers-par`): the twenty-four batch folders are independent, so
the driver runs each in its own
worker thread from a single esbuild-built worker bundle (the lazy
non-maneuver target modules are stubbed, so accidentally pulling the app
stack into a worker is a loud failure). Generation is deterministic, so the
parallel tree is byte-identical to a sequential run — verified by per-file
sha256 over all 1,944 files — with only `timing.json` differing; wall time
drops from ~8–10 s to under 1 s. The physics bench parallelizes differently
(Jest process shards) because its solvers need the app stack; see
`run-physics-parallel.mjs`.

Contract rules for this arm:

1. **Anomalousness is a parameter, not a shape.** A loop is aerobatic, a
   corkscrew is a thermalling bird. Each generator takes overridable
   parameters and records its realized peaks, so a later sweep can walk one
   shape from mundane to impossible. `MANEUVER_ANOMALOUS` holds the default
   per kind; an explicit spec value overrides it.
2. **The declared flag is part of the truth and part of the name.** Names
   carry `anom-` or `ctrl-`, so a member and its twin can never overwrite
   each other.
3. **Sustained anomalies carry whole-track event windows**, so event-local
   scoring has something to score.

### Visualization and the run registry

`vizBotBench.mjs` (`npm run bench-bot-viz -- results/<set>`) turns any results
set into a self-contained HTML page under `results/viz/runs/`: stat tiles, a
truth-track shape gallery, an animated scene player (platform, target,
observed line of sight, event windows), a peak-speed vs peak-g envelope
scatter, a realized pointing-error strip per folder, and generation timing.
Every visualized run is appended to `results/viz/registry.json` with compact
per-scenario stats, and `results/viz/index.html` is rebuilt from the registry:
the run history plus dataset-wide aggregates (counts by kind, duration ×
operator-error coverage, the whole-dataset kinematic envelope). Pages embed
their data, so old runs stay viewable after the source results are
regenerated; `--index-only` rebuilds just the index.

### Study T — tractability

`tractability.bench.test.js` runs the shipping analysis over both arms plus a
GEO-DURATION ladder, and records, per scenario, the pre-fit observables an
analyst could triage on together with the scored outcome.
`analyzeTractability.mjs` joins them. Bench: `bench-bot-tract`.

Method rules, all load-bearing:

1. The range-ladder anchor is FIXED for every scenario (20 NM, the bulk-analysis
   default). The generating range is never handed to the search.
2. The triage block contains pre-fit observables only.
3. The primary outcome is the RANK-1 hypothesis's separation from truth. The
   best eligible separation is an ORACLE CEILING and is labeled as one, because
   truth selects the winner.
4. Rates carry exact (Clopper-Pearson) intervals. Correlations are
   tie-corrected and are exploratory: the cells vary geometry, target class,
   duration, and noise jointly.
5. Verdict codes are scored on per-code semantic endpoints, not one threshold.
   The wording is "observed reliability on these designed scenarios".
6. One seed per scenario in round 1: claims are about these realizations.

Findings and the derived programme live in `analysis/BOT-Tractability-Study.md`
and `analysis/BOT-Tractability-Plan.md`. The programme's near-term tier is
adopted as the next round of contract work: harden the conditioning statistic
into a per-class stack, add sham-splice controls and a triviality gate,
certify coverage with exact bounds, add an empirical noise self-check, install
a routing layer in front of the verdict, add a class-conditioned predicted
precision score, and run the envelope-feasibility calibration pilot.
