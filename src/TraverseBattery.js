/**
 * TraverseBattery.js — the traverse analysis's fit battery, with the scene cut out.
 *
 * This is the sequence of fits that turns a dataset into a ranked hypothesis set:
 *
 *   constant-air-speed sweep -> fast/slow range profiles -> fixed-wing fit ->
 *   constant-altitude -> least-manoeuvring -> Kalman seed -> balloon (free wind,
 *   and optionally wind-pinned) -> quadcopter -> drone control inputs ->
 *   range bands -> polynomial-order sweep -> satellite -> buildHypotheses ->
 *   executive verdict
 *
 * WHY IT LIVES HERE. It previously lived inline in AnalyzeTraverse.runTraverseAnalysis,
 * which reads the node graph, the terrain model, the GUI tweaks and a progress
 * overlay — so anything that wanted to run the same analysis on data that is not
 * the loaded sitch had to re-implement it. Two callers already did
 * (benchmarks/botbench/lib/verdictRunner.js for Jest, and now the BotBench bulk
 * runner), and verdictRunner's own header records what that costs: "a benchmark
 * that re-implements the analysis measures the re-implementation". A third copy
 * would have made drift certain.
 *
 * WHAT IS AND IS NOT INJECTED. Everything that reaches the scene is a hook, and
 * every hook is optional — omit it and that part of the analysis is simply absent
 * rather than silently approximated:
 *
 *   buildHypotheses   REQUIRED. The live app passes its wrapper (GUI state,
 *                     terrain probes, scene-coupled astronomy / live method
 *                     nodes); a headless caller passes the core builder with
 *                     flatTerrainProbes().
 *   groundPrior       A VALUE, not a hook — the caller samples terrain and
 *                     decides, because that sample is also a cache dependency.
 *   sampleWindPrior   Called AFTER the least-manoeuvring fit, because the wind
 *                     is sampled at that track's mean altitude.
 *   searchSatellites  Network + catalogue; null means the check did not run.
 *   afterHypotheses   Runs between the hypothesis set and the executive verdict,
 *                     which is where the live path attaches balloon wind
 *                     evidence — the verdict reads it, so the order is load-bearing.
 *   familyScreen      The physical screen a range-band member must pass. The
 *                     default is kinematic-only (g and speed); the live app adds
 *                     terrain and the ground-contact mode.
 *
 * The battery never touches Sit, NodeMan, the DOM or terrain directly. It is
 * async only so the progress hook can yield — every fit inside is a synchronous
 * number-crunch.
 */

import {
    fitAircraft,
    fitConstAltitude,
    fitPlausibleBestRange,
    isRangeUnobservable,
    KNOTS_TO_MS,
    rangeProfile,
    sensorMotionStats,
    sweepConstAirSpeed,
} from "./TraverseAnalysis";
import {
    assessLinearFitConditioning,
    fitAlternatingLSQ,
    fitConstantVelocity,
    fitKalmanFilter,
    fitMonteCarlo,
    fitMonteCarlo2,
    fitPhysicsModel,
} from "./LOSFitting";
import {DroneControlModel, knotsForDuration} from "./DroneControlFit";
import {SkyLanternModel} from "./SkyLanternModel";
import {QuadcopterModel} from "./QuadcopterModel";
import {assessExecutiveVerdict, hypothesisFitKind} from "./TraverseRanking";
import {gradeHypotheses} from "./TraversePlatformMirror";
import {buildRangeLadder, rangeConditionedFamily} from "./TraverseFamily";

// Slow-object range-profile settings. Exported because the hypothesis builder
// needs the SAME options the slow profile was computed with (it re-derives the
// slow-regime track from them), and the report quotes them.
export const SLOW_OPTS = Object.freeze({
    vTarget: 5 * KNOTS_TO_MS,
    vSigma: 20 * KNOTS_TO_MS,
    scoreSpeedWeight: 0.2,
});

// Metres. The range floor handed to the constant-velocity seed inside the Kalman
// smoother. Without it that seed treats the sensor's own path as a zero-residual
// solution whenever the sensor flies a CV-representable trajectory
// (LOSFitting.js fitConstantVelocity), so the seed collapses onto the camera.
// 500 m sits below every physical model's own floor, so it excludes the
// degenerate optimum without foreclosing a near-field solution.
const KS_SEED_MIN_RANGE = 500;

export const MC_SWEEP_MAX_ORDER = 5;

// The three curve-fitting strategies swept over polynomial order. They all fit
// the same sightlines with the same degree of curve; they differ only in HOW
// they search for it, so putting them side by side at matching orders shows how
// much of a result is the data and how much is the method.
export const SWEEP_VARIANTS = [
    {key: "gfMC1", name: "Global Fit: Monte Carlo 1", fit: fitMonteCarlo, mc: true,
        color: "#b79be0", flavour: "best-of-N sampled polynomial"},
    {key: "gfMC2", name: "Global Fit: Monte Carlo 2", fit: fitMonteCarlo2, mc: true,
        color: "#9b7fd0", flavour: "least-squares over perturbed frames"},
    // Deterministic alternative. Ignores numTrials/losUncertainty (it doesn't
    // sample at all), and unlike the two above it lets range move freely rather
    // than staying within 0.9-1.1x of the constant-velocity seed — so a far or
    // fast solution stays reachable if the sightlines support one.
    {key: "gfPolyALS", name: "Global Fit: Polynomial LSQ", fit: fitAlternatingLSQ,
        color: "#7fc4d0", flavour: "deterministic alternating least squares"},
];

// Kinematic ceiling a range-band member must stay under to count as a physical
// solution. These are the rank-0 boundaries plausibilityRating already uses, so
// a member the band admits is one the gallery would not call kinematically
// extreme.
export const FAMILY_MAX_G = 9;
export const FAMILY_MAX_SPEED_KT = 900;

/**
 * True only if every element of a numeric array is finite. Used to keep a
 * non-finite fit result (e.g. a Kalman seed that went NaN) out of the physical
 * fits and the gallery — see the TA-01/TA-02 seed and hypothesis guards.
 */
export function allFinite(arr) {
    if (!arr) return false;
    for (let i = 0; i < arr.length; i++) {
        if (!Number.isFinite(arr[i])) return false;
    }
    return true;
}

/** Normalise a fitPhysicsModel result into what rangeConditionedFamily wants. */
export function toFamilyFit(fit) {
    if (!fit || !fit.positions) return null;
    return {track: fit.positions, errDeg: fit.params?.errDeg, solved: fit.params?.solved ?? null};
}

/**
 * The kinematic half of the range-band screen: a member can thread the
 * sightlines perfectly and still require 40 g or 3,000 kt, and including those
 * would widen a band that is supposed to describe REAL solutions.
 *
 * Terrain and ground-contact rejection are NOT here — they need a scene. The
 * live app wraps this; a flat-plane caller can pass its own ground test.
 */
export function kinematicFamilyScreen(member) {
    const m = member.metrics;
    const gMax = m?.gLoad?.max;
    const vMaxKt = m?.airSpeed?.max / KNOTS_TO_MS;
    if (!Number.isFinite(gMax) || !Number.isFinite(vMaxKt)) {
        return {ok: false, reason: "metrics are not finite"};
    }
    if (gMax > FAMILY_MAX_G) return {ok: false, reason: `requires ${gMax.toFixed(1)} g`};
    if (vMaxKt > FAMILY_MAX_SPEED_KT) return {ok: false, reason: `requires ${vMaxKt.toFixed(0)} kt`};
    return {ok: true, reason: null};
}

/**
 * Set up the shared inputs for the polynomial-order sweep. Cheap and
 * synchronous; the actual fits are driven by sweepPolynomialOrders so they can
 * report progress.
 *
 * `overrides` supplies numTrials / losUncertaintyDeg, which the live app reads
 * off its Monte Carlo GUI sliders. Absent, the fitters use their own defaults.
 */
export function prepareSweep(dataset, overrides = null) {
    const times = new Float64Array(dataset.n);
    for (let f = 0; f < dataset.n; f++) times[f] = f / dataset.fps;
    const ds = {
        sensorPos: dataset.S, losDir: dataset.D, times,
        count: dataset.n, maxRange: null,
        // The closed-form fits minimise PERPENDICULAR DISTANCE IN METRES, and
        // that objective falls monotonically as a trajectory scales toward the
        // sensor — the sensor's own path is an exact zero-residual solution
        // whenever the sensor flies a CV-representable trajectory (see the
        // contract in LOSFitting.js, above fitConstantVelocity). Without this floor the seed below
        // can collapse onto the camera, and because the Monte Carlo fits sample
        // range only within 0.9-1.1x of that seed, a collapsed seed silently
        // pins ALL of their tiles to a near-zero range. 500 m matches the
        // existing noise-floor caller and sits below every model's own floor,
        // so it excludes the degenerate optimum without foreclosing any
        // physically plausible near-field solution.
        minRange: KS_SEED_MIN_RANGE,
    };
    const opts = {};
    if (Number.isFinite(overrides?.numTrials)) opts.numTrials = overrides.numTrials;
    if (Number.isFinite(overrides?.losUncertaintyDeg)) opts.losUncertaintyDeg = overrides.losUncertaintyDeg;
    // Per-frame range estimates from a constant-velocity fit focus the random
    // range sampling, as CNodeLOSFitMonteCarlo does (the live node seeds WITHOUT
    // the minRange floor above, so its seed can still collapse) — without them the
    // sampler draws blindly out to 10x the scene extent and the higher orders
    // degenerate into noise. (Only the Monte Carlo fits use these; the
    // alternating fit derives and then freely moves its own ranges.)
    let seedMedian = null;
    const cv = fitConstantVelocity(ds, new Set());
    if (cv) {
        const rangeEstimates = new Float32Array(dataset.n);
        for (let i = 0; i < dataset.n; i++) {
            const b = i * 3;
            rangeEstimates[i] = Math.max(1,
                (cv.positions[b] - dataset.S[b]) * dataset.D[b]
                + (cv.positions[b + 1] - dataset.S[b + 1]) * dataset.D[b + 1]
                + (cv.positions[b + 2] - dataset.S[b + 2]) * dataset.D[b + 2]);
        }
        opts.rangeEstimates = rangeEstimates;
        // Median seed range, so the Monte Carlo tiles can name the range their
        // sampling window is actually centred on instead of referring vaguely
        // to "the constant-velocity fit". A visibly tiny median is the symptom
        // of the collapse the minRange floor above guards against.
        const sorted = Array.from(rangeEstimates).sort((a, b) => a - b);
        seedMedian = sorted[Math.floor(sorted.length / 2)];
    }
    return {ds, opts, seedMedian};
}

/**
 * Run every (strategy, order) fit, reporting progress between each one.
 *
 * This is async purely so the progress bar can move: each individual fit is a
 * synchronous number-crunch that locks the main thread (Monte Carlo 2 alone is
 * ~5 s per order on a 20,000-frame clip, because its cost is trials x frames),
 * and without a yield in between the whole sweep would appear as one long
 * freeze with a stalled bar and a dead Cancel button.
 *
 * `report(done, total, label)` is awaited between fits — that await is what
 * actually lets the browser repaint.
 */
export async function sweepPolynomialOrders(dataset, report, {mcOrderSweep = false, sweepOverrides = null} = {}) {
    const {ds, opts, seedMedian} = prepareSweep(dataset, sweepOverrides);
    const results = [];
    // Only the deterministic Polynomial LSQ sweep runs by default; the two Monte
    // Carlo strategies are an opt-in diagnostic (they add 10 tiles and are the
    // bulk of the sweep's cost — ~5 s per order each on a 20k-frame clip). TA-27.
    const variants = SWEEP_VARIANTS.filter((v) => mcOrderSweep || !v.mc);
    const total = variants.length * MC_SWEEP_MAX_ORDER;
    let done = 0;
    for (const variant of variants) {
        for (let order = 1; order <= MC_SWEEP_MAX_ORDER; order++) {
            await report(done, total, `${variant.name} (order ${order})`);
            let res = null;
            try {
                // A short clip can't support the higher orders (needs order + 1
                // points); the fit returns null rather than guessing.
                res = variant.fit(ds, new Set(), {...opts, order});
            } catch (e) {
                res = null;
            }
            done++;
            if (res && res.positions) results.push({variant, order, result: res});
        }
    }
    return {results, numTrials: opts.numTrials, losUncertaintyDeg: opts.losUncertaintyDeg, seedMedian};
}

/**
 * Build a {name: value} initial-guess override from a seeded model's
 * seedParams() vector (feeds fitPhysicsModel's paramOverrides, which becomes
 * the DE seed and the Nelder-Mead start).
 */
function seededOverrides(model) {
    const v = model.seedParams();
    if (!v) return null;
    const o = {};
    model.getParameterDefs().forEach((d, i) => { o[d.name] = v[i]; });
    return o;
}

/**
 * Trace the range band for each physically-based interpretation.
 *
 * ONE band per interpretation CLASS, on the independent member only: the
 * free-wind balloon (the wind-pinned variant is conditioned on an external
 * prior, so its band would answer a different question) and the free
 * quadcopter (the drone-control fit is a seeded refinement of one path, not a
 * family), plus the fixed-wing fit.
 *
 * Keyed by `key|windEvidenceRole` because the two balloon hypotheses share the
 * key "lantern"; the caller attaches by the same identity after buildHypotheses.
 */
export async function buildSolutionFamilies({
    dataset, physicsDS, physicsOpts, clipDurationSec, seedTrack,
    lantern, quad, aircraft, resolvedRanges, speedTarget, groundPrior,
    screen, failures, progress, shouldCancel,
}) {
    const out = new Map();
    const ladderBracket = {
        loM: resolvedRanges[0],
        hiM: resolvedRanges[resolvedRanges.length - 1],
    };

    // Each entry describes one class: where its anchor sits, what its own
    // initialRange bounds are, and how to fit it at a held range (cheap, seeded
    // — the continuation march) or from cold (the basin probe).
    const specs = [];

    if (lantern && Number.isFinite(lantern.params?.solved?.initialRange)) {
        const defs = new SkyLanternModel().getParameterDefs();
        const rd = defs.find((d) => d.name === "initialRange");
        const makeModel = () => {
            const m = new SkyLanternModel();
            m.clipDuration = clipDurationSec;
            if (seedTrack) m.seedFromTrack(seedTrack, physicsDS);
            return m;
        };
        specs.push({
            id: "lantern|free",
            label: "Sky Lantern / Balloon",
            anchorM: lantern.params.solved.initialRange,
            anchorFit: toFamilyFit(lantern),
            modelLoM: rd.min, modelHiM: rd.max,
            fitAt: async (rangeM, seed) => {
                const m = makeModel();
                const overrides = seed?.solved
                    ? {...seed.solved} : (seedTrack ? seededOverrides(m) : null);
                return toFamilyFit(await fitPhysicsModel(physicsDS, new Set(), m, {
                    ...physicsOpts, optimizer: "nm", maxIter: 600,
                    ...(overrides ? {paramOverrides: overrides} : {}),
                    paramLocks: {initialRange: rangeM},
                }));
            },
            basinProbe: async (rangeM) => toFamilyFit(
                await fitPhysicsModel(physicsDS, new Set(), makeModel(), {
                    ...physicsOpts, dePop: 24, deGens: 40,
                    paramLocks: {initialRange: rangeM},
                })),
        });
    }

    if (quad && Number.isFinite(quad.params?.solved?.initialRange)) {
        const defs = new QuadcopterModel().getParameterDefs();
        const rd = defs.find((d) => d.name === "initialRange");
        specs.push({
            id: "quadcopter|",
            label: "Quadcopter",
            anchorM: quad.params.solved.initialRange,
            anchorFit: toFamilyFit(quad),
            modelLoM: rd.min, modelHiM: rd.max,
            fitAt: async (rangeM, seed) => toFamilyFit(
                await fitPhysicsModel(physicsDS, new Set(), new QuadcopterModel(), {
                    ...physicsOpts, optimizer: "nm", maxIter: 600, fitMaxDt: 0.5,
                    ...(seed?.solved ? {paramOverrides: {...seed.solved}} : {}),
                    paramLocks: {initialRange: rangeM},
                })),
            basinProbe: async (rangeM) => toFamilyFit(
                await fitPhysicsModel(physicsDS, new Set(), new QuadcopterModel(), {
                    ...physicsOpts, dePop: 24, deGens: 40, fitMaxDt: 0.5,
                    paramLocks: {initialRange: rangeM},
                })),
        });
    }

    if (aircraft && Number.isFinite(aircraft.params?.startDist)) {
        // fitAircraft is DE + pattern search, and both take a zero-width bound
        // safely, so "locking" its range is just rangeMin === rangeMax — and
        // assessBoundPins skips zero-span coordinates, so the lock can never be
        // misreported as a load-bearing capability limit.
        const aircraftAt = async (rangeM, runs) => {
            const fit = await fitAircraft(dataset, {
                tasTarget: speedTarget, rangeMin: rangeM, rangeMax: rangeM,
                runs, groundPrior, shouldCancel,
            });
            return fit ? {track: fit.track, errDeg: fit.errDeg, solved: fit.params} : null;
        };
        specs.push({
            id: "aircraft|",
            label: "Fixed-Wing Aircraft",
            anchorM: aircraft.params.startDist,
            anchorFit: {track: aircraft.track, errDeg: aircraft.errDeg, solved: aircraft.params},
            modelLoM: 0, modelHiM: Infinity,
            fitAt: (rangeM) => aircraftAt(rangeM, 1),
            basinProbe: (rangeM) => aircraftAt(rangeM, 2),
        });
    }

    let done = 0;
    for (const spec of specs) {
        if (shouldCancel && shouldCancel()) throw new Error("cancelled");
        const {ranges, clippedLow, clippedHigh, noModelOverlap} = buildRangeLadder({
            ...ladderBracket, anchorM: spec.anchorM,
            modelLoM: spec.modelLoM, modelHiM: spec.modelHiM,
        });
        // No range in the searched bracket is inside this model's own envelope,
        // so there is nothing it can honestly be asked. No band, rather than a
        // band traced at ranges the model cannot represent.
        if (!ranges.length || noModelOverlap) { done++; continue; }
        const slice = (frac) => (done + frac) / specs.length;
        try {
            const family = await rangeConditionedFamily({
                dataset, ranges, anchorM: spec.anchorM, anchorFit: spec.anchorFit,
                fitAt: spec.fitAt, basinProbe: spec.basinProbe, screen,
                shouldCancel,
                progress: progress ? (frac) => progress(slice(frac), spec.label) : null,
            });
            family.modelClippedLow = clippedLow;
            family.modelClippedHigh = clippedHigh;
            out.set(spec.id, family);
        } catch (e) {
            if (e && e.message === "cancelled") throw e;
            failures.push({method: `${spec.label} range band`, error: (e && e.message) || "failed"});
        }
        done++;
    }
    return out;
}

/**
 * Run the fit battery over one dataset.
 *
 * Throws Error("cancelled") if `isCancelled()` goes true — the caller owns what
 * that means (the app tears down its progress overlay and returns null).
 *
 * Everything a fit failed at goes into `failures` as {method, error} and the run
 * continues: a hypothesis set missing one interpretation is a result, an
 * exception is not.
 */
export async function runTraverseBattery({
    dataset, originLat, originLon,
    // Mutated in place with the dataset-derived observability diagnostics, and
    // returned, so the caller's provenance object and the one the hypotheses
    // were built against are the same object.
    provenance = {},
    anchorDist, speedTarget,
    // The requested bracket. `rangeIsDefault` is what decides whether the sweep
    // may EXPAND it — expansion extends the grid geometrically by up to two
    // rounds of x2.5, so a user who pinned a band must not have it widened
    // underneath them (AnalyzeTraverse: `expand: rangeIsDefault`).
    ranges, rangeIsDefault = true,
    fitRangeMin, fitRangeMax, caRangeMin, caRangeMax, plausRangeMin, plausRangeMax,

    // Toggles (the analyzeTweaks subset the battery reads).
    solutionFamilies = false, mcOrderSweep = false,

    // Injected environment — see the module header. All optional but buildHypotheses.
    buildHypotheses,
    groundPrior = null,
    sampleWindPrior = null,
    kalmanNoise = null,
    searchSatellites = null,
    afterHypotheses = null,
    familyScreen = kinematicFamilyScreen,
    sweepOverrides = null,

    // phase(base, span, label) -> async (frac) => void, matching the app's
    // progress-overlay helper. Null runs with no progress reporting at all.
    phase = null,
    isCancelled = () => false,
}) {
    const failures = [];
    const noPhase = () => async () => {};
    const at = phase ?? noPhase;
    const cancelled = () => isCancelled();
    const throwIfCancelled = () => { if (cancelled()) throw new Error("cancelled"); };
    // A physics fit that threw AND a cancel that landed during it are the same
    // observable event from here; re-raise the cancel so the caller unwinds.
    const rethrowIfCancelled = (e) => {
        if ((e && e.message === "cancelled") || cancelled()) throw new Error("cancelled");
    };

    // Sensor-baseline observability: with a (near-)static LOS origin no
    // free-range method can determine distance — every range along the ray
    // fan admits a trajectory, and smoothness scoring then collapses the
    // solution toward the sensor. Detect it here and warn everywhere.
    const sensorStats = sensorMotionStats(dataset);
    provenance.sensorPathLen = sensorStats.pathLen;
    provenance.sensorSpan = sensorStats.span;
    provenance.rangeUnobservable = isRangeUnobservable(sensorStats, anchorDist);
    // CV-family conditioning of these sightlines (BOT Bench diagnostic).
    // DELIBERATELY SEPARATE from rangeUnobservable: that flag is a global
    // evidence veto (wind evidence, executive verdict, report banners), while
    // poor CV conditioning only says the LINEAR fit family cannot determine
    // range here — stationary-point, physics and ray-constrained methods may
    // still be fine. One-way warning: "good" is never a guarantee of recovered
    // range.
    provenance.linearFitConditioning = assessLinearFitConditioning(dataset);

    const sweep = await sweepConstAirSpeed(dataset, {
        ranges,
        speedTarget,
        // Auto-expand the range bracket when the winner sits on a grid
        // edge (only when the user hasn't pinned an explicit band).
        expand: rangeIsDefault,
        progress: at(0.00, 0.18, "Sweeping constant-air-speed grid..."),
    });
    // Expansion is part of the search result, not a display-only detail.
    // Every downstream profile/model must inspect the same resolved bracket.
    const resolvedRanges = sweep.ranges;
    fitRangeMin = Math.min(fitRangeMin, resolvedRanges[0]);
    fitRangeMax = Math.max(fitRangeMax, resolvedRanges[resolvedRanges.length - 1]);
    caRangeMin = Math.min(caRangeMin, resolvedRanges[0]);
    caRangeMax = Math.max(caRangeMax, resolvedRanges[resolvedRanges.length - 1]);
    plausRangeMin = Math.min(plausRangeMin, resolvedRanges[0]);
    plausRangeMax = Math.max(plausRangeMax, resolvedRanges[resolvedRanges.length - 1]);

    const fastProfile = await rangeProfile(dataset, {
        ranges: resolvedRanges,
        vTarget: speedTarget,
        vSigma: 60 * KNOTS_TO_MS,
        progress: at(0.18, 0.12, "Range profile: fast object..."),
    });
    const slowOpts = {...SLOW_OPTS};
    const slowProfile = await rangeProfile(dataset, {
        ...slowOpts,
        ranges: resolvedRanges,
        progress: at(0.30, 0.12, "Range profile: slow object..."),
    });

    let aircraft = null;
    try {
        aircraft = await fitAircraft(dataset, {
            tasTarget: speedTarget,
            rangeMin: fitRangeMin, rangeMax: fitRangeMax,
            runs: 3,
            groundPrior,
            shouldCancel: cancelled,
            progress: at(0.42, 0.34, "Fitting fixed-wing aircraft model..."),
        });
    } catch (e) {
        rethrowIfCancelled(e);
        failures.push({method: "Fixed-Wing Aircraft", error: (e && e.message) || "fit failed"});
    }

    // --- Extra interpretation fits for the hypothesis gallery ---------
    await at(0.76, 0.02, "Fitting constant-altitude path...")(0);
    const ca = fitConstAltitude(dataset, {rangeMin: caRangeMin, rangeMax: caRangeMax});

    await at(0.79, 0.02, "Fitting least-maneuvering path...")(0);
    const plausible = fitPlausibleBestRange(dataset, {
        vTarget: speedTarget,
        vSigma: 60 * KNOTS_TO_MS,
        rangeMin: plausRangeMin,
        rangeMax: plausRangeMax,
    });

    // Wind input for the wind-tracer fits (Sky Lantern / Balloon and
    // Quadcopter): sampled at the plausible track's mean altitude by the
    // caller, because reaching a wind field is a scene operation. A wind
    // tracer's drift SHOULD match the winds aloft, not slide slow to trade
    // range against an invented calm (the coupled range/wind unobservable pair).
    let windPrior = null;
    if (sampleWindPrior && plausible && plausible.track) {
        try {
            windPrior = sampleWindPrior({dataset, track: plausible.track, originLat, originLon}) ?? null;
        } catch (e) {
            // A wind problem must degrade to "no wind-pinned hypothesis", never
            // abort the whole analysis — the free-wind fit still runs.
            console.warn("Wind sample for the balloon prior failed; "
                + "continuing with the free-wind fit only:", e);
            windPrior = null;
        }
    }

    // Shared physics-fit dataset shape (frame-0-indexed sensor/LOS arrays +
    // uniform times) reused by the lantern and quadcopter model fits.
    const physicsTimes = new Float64Array(dataset.n);
    for (let f = 0; f < dataset.n; f++) physicsTimes[f] = f / dataset.fps;
    const physicsDS = {
        sensorPos: dataset.S, losDir: dataset.D, times: physicsTimes,
        count: dataset.n, maxRange: null,
    };
    const clipDurationSec = (dataset.n - 1) / dataset.fps;
    const physicsOpts = {
        optimizer: "de", sampleStride: 5, dePop: 48, deGens: 120,
        // let the caller's Cancel actually stop the DE search
        shouldCancel: cancelled,
    };
    if (groundPrior) physicsOpts.groundPrior = groundPrior;

    // Geometric SEED for the physically-based fits, so they start on a path
    // that already fits the sightlines and refine from there (the balloon's
    // time-varying wind and the drone's control inputs are otherwise
    // unsearchable at the shipping DE budget — see SkyLanternModel.seedFromTrack
    // and DroneControlFit).
    //
    // Seed from the KALMAN SMOOTHER specifically — not "whichever geometric
    // track has the lowest LOS residual". An LOS fit is degenerate along
    // range: a track that collapses toward the sensor and speeds up rides the
    // rays with an arbitrarily small residual while being physically
    // meaningless (measured here: a 222 m / 255 kt "plausible" member scored
    // 0.05 deg but seeded the drone into a 24-revolution corkscrew). The
    // Kalman smoother is regularised (it penalises acceleration) AND we give
    // its constant-velocity seed an explicit range floor (minRange), because
    // that seed treats the sensor's own path as a zero-residual solution for
    // a CV-representable sensor motion unless a floor is supplied
    // (LOSFitting.js fitConstantVelocity). Regularisation alone does not
    // create the missing radial observability. With both, the smoother stays
    // a good basin to refine from; the least-manoeuvring track is only a
    // fallback for the rare case it returns nothing. The seed carries NO truth
    // and NO object assumptions, but a local optimizer can still retain a
    // different basin from a different seed; the free quadcopter is deliberately
    // NOT seeded (the unconstrained, anomaly-reachable envelope fit).
    let seedTrack = null;
    try {
        // The kalmanProcessNoise / kalmanMeasurementNoise GUI sliders hold
        // log10 EXPONENTS, not variances — the live Kalman node converts them
        // with Math.pow(10, v0) (see CNodeLOSFitKalman._doCompute), which is
        // why the caller resolves them rather than this module reading nodes.
        // Undefined leaves fitKalmanFilter on its own 1e-4 / 1.0 defaults.
        const ks = fitKalmanFilter({...physicsDS, minRange: KS_SEED_MIN_RANGE}, new Set(), {
            processNoise: kalmanNoise ? kalmanNoise("kalmanProcessNoise") : undefined,
            measurementNoise: kalmanNoise ? kalmanNoise("kalmanMeasurementNoise") : undefined,
        });
        // Only seed from a finite smoother track. A non-finite result must
        // fall through to the plausible track (or no seed), never poison the
        // physical fits with NaN initial parameters.
        if (ks && ks.positions && allFinite(ks.positions)) {
            seedTrack = Float64Array.from(ks.positions);
        } else if (ks && ks.positions) {
            console.warn("Kalman seed produced a non-finite track; "
                + "falling back to the least-manoeuvring track.");
        }
    } catch (e) {
        // Non-fatal: a seeding failure must never abort the analysis.
        console.warn("Kalman seed for the physics fits failed; "
            + "falling back to the least-manoeuvring track:", e);
    }
    // Fall back to the least-manoeuvring plausible track only if the smoother
    // is unavailable.
    if (!seedTrack && plausible && plausible.track) seedTrack = plausible.track;

    await at(0.82, 0.05, "Fitting balloon model (free wind)...")(0);
    let lantern = null;
    try {
        // FREE reconstruction: fit wind + lift together with NO measured-wind
        // input — "does a plausible balloon fit these sightlines?" — and yield
        // the inferred wind + lift profile.
        const freeModel = new SkyLanternModel();
        // lets the model's wind vary across the clip in duration-invariant
        // units (see SkyLanternModel._windAt)
        freeModel.clipDuration = clipDurationSec;
        // Seed the time-varying wind from the best geometric path so DE
        // starts in the right basin instead of scattering in 12-D.
        let freeOpts = physicsOpts;
        if (seedTrack) {
            freeModel.seedFromTrack(seedTrack, physicsDS);
            const ov = seededOverrides(freeModel);
            if (ov) freeOpts = {...physicsOpts, paramOverrides: ov};
        }
        lantern = await fitPhysicsModel(physicsDS, new Set(), freeModel, freeOpts);
    } catch (e) {
        rethrowIfCancelled(e);
        failures.push({method: "Sky Lantern / Balloon (free wind)", error: (e && e.message) || "fit failed"});
        lantern = null;
    }
    throwIfCancelled();
    if (!lantern && !failures.some((f) => f.method === "Sky Lantern / Balloon (free wind)")) {
        failures.push({method: "Sky Lantern / Balloon (free wind)", error: "fit returned no solution"});
    }

    // "USING EXISTING WIND" reconstruction: a second balloon fit whose drift
    // wind is softly pinned to the caller's wind (kept loose — even a real
    // sounding is only loosely representative). The prior carries its
    // provenance so the hypothesis can say whether that wind was measured or
    // hand-set. Kept SEPARATE from the free fit so both modes coexist and the
    // inferred-vs-existing wind comparison is available.
    let lanternMeasured = null;
    if (windPrior) {
        await at(0.87, 0.02,
            `Fitting balloon model (${windPrior.measured ? "measured" : "sitch"} wind)...`)(0);
        try {
            const m = new SkyLanternModel();
            m.clipDuration = clipDurationSec;
            m.windPriorE = windPrior.E; m.windPriorN = windPrior.N;
            let measuredOpts = physicsOpts;
            if (seedTrack) {
                m.seedFromTrack(seedTrack, physicsDS);
                const ov = seededOverrides(m);
                if (ov) measuredOpts = {...physicsOpts, paramOverrides: ov};
            }
            lanternMeasured = await fitPhysicsModel(physicsDS, new Set(), m, measuredOpts);
        } catch (e) {
            rethrowIfCancelled(e);
            lanternMeasured = null;  // non-fatal — the free fit is the primary
        }
        throwIfCancelled();
    } else {
        // SAY THAT IT WAS NOT TESTED. This interpretation is conditioned on a
        // wind the caller has to supply, and there is no honest substitute:
        // "no wind given" is not evidence for calm, and a zero prior would pin
        // the balloon to zero drift, which is a different claim entirely.
        //
        // What must not happen is the fit simply not appearing. A reader
        // comparing two runs cannot tell "the balloon was tested against the
        // winds aloft and did not survive" from "nobody ever asked", and those
        // are opposite conclusions. Measured on a clean synthetic balloon clip,
        // this fit recovered the truth EXACTLY (0 m, against 168 m for the
        // free-wind fit) when the real wind was supplied — so its absence is a
        // real gap in what was checked, not a formality.
        //
        // It is stated here rather than in each caller's own list of missing
        // checks, because this line is the only one that knows whether a prior
        // arrived. The bulk runner used to carry a blanket "measured wind is
        // never available" entry; that was removed when this was added.
        failures.push({
            method: "Sky Lantern / Balloon (measured wind)",
            error: "not tested — no wind was supplied to pin the drift to "
                + "(load winds aloft, or set the sitch wind, to include it)",
        });
    }

    // Quadcopter (multirotor drone) — hover-capable near-field object. Runs
    // the generic multirotor envelope; the hypothesis classifies the solved
    // trajectory to the nearest common model. May fail / be implausible for
    // far-field scenes (its range is capped at 20 km) — degrade gracefully.
    await at(0.89, 0.04, "Fitting quadcopter (drone) model...")(0);
    let quad = null;
    try {
        // Coarsen the SEARCH integration (fitMaxDt): the quadcopter's dynamics
        // (linearly-varying turn rate, along-track accel, constant climb, wind)
        // are smooth, so a 0.5 s step is accurate for the plausible solutions
        // the turning-effort prior admits, while the frame-rate 1/30 s step ran
        // ~20k RK4 substeps per DE evaluation and made this the slowest phase of
        // the whole analysis (TA-25). The final full-resolution trajectory still
        // integrates at the model's own maxDt.
        quad = await fitPhysicsModel(physicsDS, new Set(), new QuadcopterModel(),
            {...physicsOpts, fitMaxDt: 0.5});
    } catch (e) {
        rethrowIfCancelled(e);
        failures.push({method: "Quadcopter", error: (e && e.message) || "fit failed"});
        quad = null;
    }
    throwIfCancelled();
    if (!quad && !failures.some((f) => f.method === "Quadcopter")) {
        failures.push({method: "Quadcopter", error: "fit returned no solution"});
    }

    // Drone as CONTROL INPUTS — the plausible-flight counterpart to the
    // free quadcopter above. Seeded from the best geometric path (Kalman
    // smoother or least-manoeuvring track; geometry only, no drone
    // assumptions and no truth), inverted into the speed/heading/climb
    // history a drone would need to fly it, compressed onto a few knots,
    // then refined against the sightlines while paying for control EFFORT
    // rather than for path shape.
    //
    // The knot count scales with clip length (knotsForDuration): 4 knots on
    // a 667 s clip is one held input per 167 s, too coarse to describe any
    // real flight let alone follow the seeded path, so the seed's detail was
    // thrown away before the fit began.
    //
    // Run alongside, never instead of, the free fit: the difference between
    // the two residuals is the informative quantity (an ordinary flight
    // explaining the rays as well as a contorted one, versus not), and
    // keeping the free fit means nothing is foreclosed.
    let droneCtl = null;
    if (seedTrack) {
        await at(0.93, 0.01, "Fitting drone control inputs...")(0);
        try {
            const m = new DroneControlModel(knotsForDuration(clipDurationSec));
            m.seedFromTrack(seedTrack, physicsDS);
            const seeded = m.seedParams();
            const defs = m.getParameterDefs();
            const paramOverrides = {};
            defs.forEach((d, i) => { paramOverrides[d.name] = seeded[i]; });
            // This is the highest-dimensional fit in the analysis (1 + 3K
            // params, K up to 12 => 37), and the seed already sits on the
            // smoother path — so it is a LOCAL-REFINEMENT problem, not a
            // global search. Skip differential evolution entirely (optimizer
            // "nm" runs Nelder-Mead straight from the seed) and integrate the
            // search cost coarsely (fitMaxDt 1 s — the controls are linear
            // over ~60 s knots, so a 1 s step is plenty; the final
            // full-resolution trajectory still uses the model's 0.25 s step)
            // on a wider stride.
            //
            // maxIter is deliberately low. Nelder-Mead makes almost all its
            // progress from a good seed in the first few hundred iterations
            // (measured: 1500 iters -> 0.199 deg in 3.6 s, 400 -> 0.23 deg in
            // 1.2 s, 150 -> 0.36 deg in 0.5 s — all plausible flights), and
            // unlike the DE phases NM does not yield, so every iteration is
            // frozen UI. 400 keeps the fit well under a couple of seconds and
            // the residual excellent; the drone's exact residual is not the
            // deciding factor anyway (see balloonConsistency ranking). Safe:
            // NM is monotonic from the seed, so it can never return worse than
            // the seed — a corkscrew (huge residual) can't appear.
            droneCtl = await fitPhysicsModel(physicsDS, new Set(), m,
                {...physicsOpts, paramOverrides, optimizer: "nm",
                    sampleStride: 20, fitMaxDt: 1.0, maxIter: 400});
            if (droneCtl) {
                droneCtl.model = m;
                droneCtl.solvedVector = defs.map((d) => droneCtl.params.solved[d.name]);
            }
        } catch (e) {
            rethrowIfCancelled(e);
            failures.push({method: "Drone (control inputs)", error: (e && e.message) || "fit failed"});
            droneCtl = null;
        }
        throwIfCancelled();
        // A null return means the fit produced no finite solution (fail-closed
        // in fitPhysicsModel); record it as a typed failure rather than
        // silently omitting the candidate.
        if (!droneCtl && !failures.some((f) => f.method === "Drone (control inputs)")) {
            failures.push({method: "Drone (control inputs)", error: "fit returned no finite solution"});
        }
    }

    // Range BANDS for the physically-based interpretations: refit each model
    // at a ladder of held ranges and keep the ranges it still admits. Gated
    // off by default — it is several extra fits per model — but when on it
    // is the difference between "the balloon is at 3.1 NM" and "any range
    // from 2.1 to 7.4 NM fits a balloon equally well".
    let families = null;
    if (solutionFamilies) {
        try {
            families = await buildSolutionFamilies({
                dataset, physicsDS, physicsOpts, clipDurationSec, seedTrack,
                lantern, quad, aircraft, resolvedRanges, speedTarget, groundPrior,
                screen: familyScreen, failures,
                shouldCancel: cancelled,
                progress: (frac, label) =>
                    at(0.92, 0.03, `Tracing range band: ${label}...`)(frac),
            });
        } catch (e) {
            rethrowIfCancelled(e);
            failures.push({method: "Solution families", error: (e && e.message) || "failed"});
        }
        throwIfCancelled();
    }

    // Polynomial-order sweep across the three curve-fitting strategies. This
    // is the longest single block in the analysis (Monte Carlo 2 is ~5 s per
    // order on a 20,000-frame clip), so it gets a real slice of the progress
    // bar and reports which fit is running — the progress callback awaits a
    // DOM yield, which is what keeps the bar moving and Cancel responsive.
    const mcSweep = await sweepPolynomialOrders(dataset, async (done, total, label) => {
        await at(0.93, 0.05,
            `Sweeping curve fits (${done + 1}/${total}): ${label}...`)(done / total);
    }, {mcOrderSweep, sweepOverrides});
    throwIfCancelled();

    // Satellite (LEO pass) — the caller owns it: it loads the historical
    // catalogue for the sitch's date through the server (network, slow first
    // time) and finds the pass best matching the sightlines. Null hook means
    // the check did not run, which is different from running and finding
    // nothing.
    let satellite = null;
    if (searchSatellites) {
        await at(0.98, 0.01, "Loading LEO satellites for the date...")(0);
        try {
            satellite = await searchSatellites({dataset});
        } catch (e) {
            console.warn("Satellite search skipped:", e);
            satellite = {error: (e && e.message) || "failed", loaded: 0, best: null};
            failures.push({method: "Satellite catalogue", error: satellite.error});
        }
    }

    const hypotheses = buildHypotheses({
        dataset, sweep, ca, plausible, aircraft, lantern, lanternMeasured, quad, satellite,
        slowProfile, slowOpts,
        originLat, originLon,
        provenance, failures, windPrior, mcSweep, droneCtl,
    });

    // Attach the range bands AFTER the hypothesis set is built, keyed by the
    // same identity buildSolutionFamilies used. Attaching rather than
    // threading another builder argument keeps the (deliberately pure)
    // hypothesis builder unaware of them, and handles the two balloon
    // hypotheses sharing the key "lantern".
    if (families) {
        for (const h of hypotheses) {
            const fam = families.get(`${h.key}|${h.windEvidenceRole ?? ""}`);
            if (fam) h.family = fam;
        }
    }

    // Grade every hypothesis BEFORE anything reads them: the scene residual
    // scale and the platform-mirror record. The executive assessment below
    // consumes both (a candidate whose solved path is the camera's own must not
    // make its class viable), and BOT Bench drives this same battery, so
    // grading in a caller would have the blind ranking measuring a different
    // gallery from the one it renders. See gradeHypotheses.
    gradeHypotheses(hypotheses, dataset, hypothesisFitKind);

    // Anything that must be frozen onto the hypotheses BEFORE the verdict reads
    // them — in the app, the independent balloon wind evidence. It runs here and
    // not in the caller because assessExecutiveVerdict consumes it.
    if (afterHypotheses) {
        try {
            afterHypotheses({hypotheses, dataset, originLat, originLon, provenance});
        } catch (e) {
            console.warn("Post-hypothesis evidence capture failed (non-fatal):", e);
        }
    }

    // Executive assessment: the corroboration-first headline ("Probably a
    // wind-blown balloon" / "Consistent with ..." / "Unresolved"), frozen
    // here so the gallery, verdict, and report all render ONE record.
    // Reads ranking + wind evidence; never feeds back into ordering.
    let executiveAssessment = null;
    try {
        executiveAssessment = assessExecutiveVerdict(hypotheses, {provenance});
    } catch (e) {
        console.warn("Executive assessment failed (non-fatal):", e);
    }

    return {
        sweep, resolvedRanges, fastProfile, slowProfile, slowOpts,
        aircraft, ca, plausible, seedTrack,
        lantern, lanternMeasured, quad, droneCtl,
        families, mcSweep, satellite,
        hypotheses, executiveAssessment,
        failures, windPrior, groundPrior,
        physicsDS, clipDurationSec,
        // The brackets AS RESOLVED — expansion widens them, and the report's
        // searchBounds must quote what was actually searched.
        fitRangeMin, fitRangeMax, caRangeMin, caRangeMax, plausRangeMin, plausRangeMax,
        provenance,
    };
}
