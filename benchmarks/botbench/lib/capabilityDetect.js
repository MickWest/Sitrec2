// capabilityDetect.js — detection/attribution statistics for the
// emerging-threats capability blocks (v2, redesigned after the smoke run +
// Codex review).
//
// S1'  NOMINAL catalog-model failure: fit the constrained model at the
//      NOMINAL catalog envelope (lambda=1) and measure how badly it fits —
//      active-frame angular residual PLUS the model's own envelope-pressure
//      (soft prior cost in residual-equivalent degrees + load-bearing pins +
//      derived-speed/climb violation from the SOLVED params, not from a 3-D
//      track metric). This says "the nominal catalog model cannot explain the
//      sightlines", not "the vehicle exceeded Vmax by X%". A coarse {1,2}
//      relaxation is an auxiliary counterfactual only (and is near-useless for
//      fixed-wing speed, which enforces constant TAS and can't represent a
//      transient dash).
//
// S2   KINEMATIC exceedance from a RANGE-PROFILE FAMILY, never one preferred
//      track: traversePlausible with vTarget=null over admissible ranges (no
//      speed prior — fitPlausibleBestRange's 300 kt default produced spurious
//      188 m/s peaks even on the lambda=1 control). Report the exceedance
//      LOWER BOUND across the supported family: an exceedance is claimed only
//      if EVERY admissible track requires it. Metric corrections: horizontal
//      airspeed vs maxSpeed/tasMax (not 3-D), signed vertical vs ascent limit,
//      load factor hypot(1, maneuverAccelG) vs gMax.
//
// Gates: active coverage, positive/finite ranges, conditioning adequacy
//      (one-way — "good" never validates range), collapse.

import {fitPhysicsModel} from "../../../src/LOSFitting";
import {QuadcopterModel} from "../../../src/QuadcopterModel";
import {FixedWingModel} from "../../../src/FixedWingModel";
import {quadcopterById, fixedWingById} from "../../../src/VehicleModels";
import {traversePlausible, trackMetrics, meanAngularError, straightFlightScore} from "../../../src/TraverseAnalysis";
import {minEnvelopeScale, resolveDetectorConfig, configKey} from "./envelopeFeasibility";
import {toLOSDataset, toTraverseDataset} from "./adapters";

// FAIL-CLOSED calibration for the constrained-envelope detector. Notation: α*
// is the TRUE (unknown) minimum feasible envelope scale; α̂ (field alphaStar)
// is the Nelder-Mead UPPER-BOUND estimate the solver returns (α̂ ≥ α*). A
// binary "exceedance forced" CLAIM from a bare α̂ > 1 threshold is unsound:
// (a) no calibrated margin — the pilot must set the threshold from the null
// (lambda=1 control) α̂ distribution; (b) because α̂ only upper-bounds α*,
// α̂ > 1 does NOT prove the true minimum α* exceeds 1.
//
// The gate is FAIL-CLOSED BY CONSTRUCTION: a claim is emitted ONLY when a
// valid calibration ARTIFACT is passed to capabilityVerdict at the call site.
// There is no module-level enable flag to flip — the DEFAULT (no calibration
// argument) always yields a measurement with a null claim. This makes the
// safe state the default and requires positive, auditable input to emit a
// claim; a misconfiguration (missing/malformed/no-provenance calibration)
// degrades to measurement-only rather than to an unsupported claim.
//
// No calibration artifact exists yet (the pilot has not run), so every call in
// the repo today is measurement-only. This constant documents that state for
// the CI gate test; it is NOT the runtime switch.
export const CAPABILITY_THRESHOLD_CALIBRATED = false;

// Validate a calibration artifact. Fail-closed: any missing/mismatched field
// makes it invalid. CRITICALLY, the artifact is BOUND TO THE DETECTOR CONFIG
// it was computed under (detectorConfigKey) — a threshold calibrated at one
// bandwidth/curvature/optimizer-budget/alpha-math-version is meaningless under
// another, because the null α̂ distribution shifts. runningConfigKey is
// the key of the config actually being executed; a mismatch fails closed.
export function isValidCalibration(cal, family, catalogId, runningConfigKey) {
    return !!cal
        && Number.isFinite(cal.alphaThreshold)
        && cal.family === family
        && cal.catalogId === catalogId
        && Number.isInteger(cal.nControls) && cal.nControls >= 20
        && typeof cal.provenance === "string" && cal.provenance.length > 0
        && typeof cal.detectorConfigKey === "string"
        && cal.detectorConfigKey === runningConfigKey;   // config binding
}

// PRIMARY capability detector (v3): the constrained-envelope existence test.
// α* = the minimum envelope scale any bearings-consistent trajectory requires;
// the reported α̂ (field alphaStar) is an optimizer UPPER-BOUND estimate of it.
// Validated on known truth (v3.1, quad-speed at strong geometry): α̂ medians
// 0.82/1.00/1.76 for true λ 1.0/1.2/2.0; conservative (1.28) at weak geometry.
// The load-bearing numbers live in results/capability-validation.md (do not
// hardcode drifting copies here). See envelopeFeasibility.js.
//
// options.calibration (optional): a validated calibration artifact. ONLY when
// present and valid is a binary exceedanceForced claim emitted. Absent =>
// measurement only (fail closed).
export async function capabilityVerdict(scenario, family, catalogId, options = {}) {
    const env = family === "quad" ? quadcopterById(catalogId) : fixedWingById(catalogId);
    const trav = toTraverseDataset(scenario);
    // Resolve the config ONCE and pass it to the solver, so the key that binds
    // a calibration is exactly the config that produced α̂.
    const cfg = resolveDetectorConfig(options);
    const runningKey = configKey(cfg);
    const feas = await minEnvelopeScale(trav, env, family, {...options, _resolvedConfig: cfg});

    const cal = options.calibration ?? null;
    const calibrated = isValidCalibration(cal, family, catalogId, runningKey);
    const exceedanceForced = calibrated ? feas.alphaStar > cal.alphaThreshold : null;

    return {
        detector: "alpha-star-existence",
        catalogId, family,
        alphaStar: feas.alphaStar,             // α̂: the measurement (upper-bound estimate of α*)
        alphaStarIsUpperBound: true,
        bindingDimension: feas.bindingDimension,
        detectorConfigKey: runningKey,         // the config that produced α̂
        calibrated,
        exceedanceForced,                      // null unless a config-bound valid artifact was passed
        calibrationProvenance: calibrated ? cal.provenance : null,
        claimStatus: calibrated ? "calibrated" : "uncalibrated-measurement",
        speedRatio: feas.speedRatio,
        climbRatio: feas.climbRatio,
        gRatio: feas.gRatio,
        K: feas.K, bandwidthSec: feas.bandwidthSec,
    };
}

const DE_OPTS = {optimizer: "de", dePop: 30, deGens: 40, sampleStride: 2};
const RAD2DEG = 180 / Math.PI;
const G = 9.80665;

// HARD STOP GATE for S2 positive exceedance claims. The current
// smoothness-valley range family is known to pin the wrong (shortest) range,
// so any "measured" exceedance it produces is unsound. This flag keeps the
// positive path structurally disabled — the exceedance lower bounds are nulled
// regardless of the valley result — until the parallax-based S2 redesign is
// implemented and passes a true-range-pinning test. DO NOT flip to true
// without that test. Enforced in rangeFamilyExceedance below and asserted by
// tests/botbench/capabilityGate.test.js.
export const S2_POSITIVE_ENABLED = false;

function nominalQuad(catalogId, dim) {
    // NOMINAL envelope (lambda=1): the catalog as-is. The exceedance is in the
    // TRUTH, not the model — we measure how badly the nominal model fits.
    return {...quadcopterById(catalogId)};
}

// Solve the constrained physics model at the nominal catalog envelope and
// return the S1' failure metrics.
export async function nominalModelFailure(scenario, dim, catalogId, family) {
    const los = toLOSDataset(scenario);
    let model;
    if (family === "quad") { model = new QuadcopterModel(); model.envelope = nominalQuad(catalogId, dim); }
    else { model = new FixedWingModel(); model.envelope = {...fixedWingById(catalogId)}; }
    const fit = await fitPhysicsModel(los, scenario.observation.excluded, model, DE_OPTS);
    if (!fit || !fit.positions) return null;

    // Active-frame residual: fit.params.errDeg already excludes masked frames.
    const residualDeg = Number.isFinite(fit.params?.errDeg) ? fit.params.errDeg
        : meanAngularError(toTraverseDataset(scenario), fit.positions) * RAD2DEG;
    // Envelope-pressure: the model's soft prior cost at the solution, in
    // residual-equivalent degrees. params.priors is {total, terms} (the
    // earlier Number.isFinite check silently nulled it — Codex catch).
    const priorDeg = (fit.params?.priors && Number.isFinite(fit.params.priors.total))
        ? fit.params.priors.total : 0;
    // Load-bearing bound pins on the exceeded dimension. Pins are objects
    // {name, side, loadBearing, ...} (BoundedFit.js) — the earlier String(p)
    // test stringified "[object Object]" and always matched zero (Codex catch).
    const pins = Array.isArray(fit.params?.pinned) ? fit.params.pinned : [];
    const dimPins = pins.filter((p) => p && p.loadBearing
        && /speed|tas|climb|accel|ascent/i.test(String(p.name ?? ""))).length;

    return {
        catalogId,
        residualDeg,
        priorDeg,
        failureScore: residualDeg + priorDeg,   // total budget the nominal model spent
        dimPins,
        solved: fit.params?.solved ?? null,
    };
}

// S2: range-profile family exceedance. traversePlausible over a log range grid
// with NO speed prior.
//
// CRITICAL (stop-hook fix): a traversePlausible track is a RAY-FOLLOWING
// spline, so it threads the sightlines at EVERY range (residual is tiny
// everywhere) and never sits on/behind the sensor — so residual and collapse
// gates are silently ineffective (they pass every range). The range family is
// instead defined by the GEOMETRIC PLAUSIBILITY VALLEY: straightFlightScore
// (the smoothness/maneuvering cost) rises at the WRONG range because a wrong
// assumed distance forces implausible acceleration.
//
// KNOWN LIMITATION (found while fixing the gate, flagged for redesign): the
// pure-smoothness valley floor sits at the SHORTEST/SLOWEST range, not the
// true range — the classic slow-object degeneracy this whole benchmark
// documents. So this S2 correctly reports range-INDETERMINATE at strong
// geometry (the valley is broad toward short range) and must NOT be trusted to
// report a positive "measured" exceedance yet; the sensor-parallax range
// constraint (not smoothness alone) is what should define the admissible
// family. Treated as a warning gauge only pending the S2 range-pinning
// redesign — a "measured" verdict here is provisional.
export function rangeFamilyExceedance(scenario, family, catalogId, options = {}) {
    const trav = toTraverseDataset(scenario);
    const {n} = trav;
    const grid = options.grid ?? [200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200];
    const cat = family === "quad" ? quadcopterById(catalogId) : fixedWingById(catalogId);
    const per = [];
    for (const R of grid) {
        let out;
        try { out = traversePlausible(trav, R, {vTarget: null, K: 20, iters: 6, minDist: 120}); }
        catch { continue; }
        if (!out || !out.track) continue;
        const km = trackMetrics(trav, out.track, {smoothSeconds: 0.5});
        const horizSpeed = robustHorizontalSpeed(out.track, trav, n);
        const loadFactor = Math.hypot(1, km.gLoad.max);
        per.push({
            rangeM: R,
            plausScore: straightFlightScore(km),   // maneuvering cost: the range discriminator
            speedMarginFrac: family === "quad"
                ? (horizSpeed - cat.maxSpeed) / cat.maxSpeed
                : (horizSpeed - cat.tasMax) / cat.tasMax,
            climbMarginFrac: (km.verticalSpeed.max - (family === "quad" ? cat.maxAscent : cat.climbMax))
                / (family === "quad" ? cat.maxAscent : cat.climbMax),
            gMarginFrac: family === "quad" ? null : (loadFactor - cat.gMax) / cat.gMax,
        });
    }
    if (!per.length) return {perRange: per, supportedCount: 0, verdict: "no-fit",
        s2Enabled: S2_POSITIVE_ENABLED,
        speedExceedanceLB: null, climbExceedanceLB: null, gExceedanceLB: null};

    // Supported family = ranges within a factor of the minimum plausibility
    // score (the valley floor). A wide band (most of the grid) => range
    // unobservable => indeterminate.
    const scores = per.map((p) => p.plausScore).filter(Number.isFinite);
    const minScore = Math.min(...scores);
    // band tolerance: within 2x the valley floor (or +0.5 absolute for tiny floors)
    const band = per.filter((p) => Number.isFinite(p.plausScore)
        && p.plausScore <= Math.max(2 * minScore, minScore + 0.5));
    const fracOfGrid = band.length / per.length;
    const decisiveByValley = band.length > 0 && fracOfGrid <= 0.5;

    // ENFORCED STOP GATE (not just a comment): the smoothness valley is known
    // to pin the WRONG (shortest) range — the slow-object degeneracy — so a
    // positive "measured" exceedance from this S2 is unsound. Until the
    // parallax-based redesign lands, S2_POSITIVE_ENABLED is false and the
    // exceedance lower bounds are HARD-NULLED here, so no broken positive
    // verdict can reach the bench summary, pilot calibration, or the paper.
    // Flip the flag only when the redesign passes a true-range-pinning test.
    const decisive = S2_POSITIVE_ENABLED && decisiveByValley;
    const lb = (key) => {
        if (!decisive) return null;
        const vals = band.map((p) => p[key]).filter(Number.isFinite);
        return vals.length ? Math.min(...vals) : null;
    };
    // While the gate is closed, STRIP the per-range exceedance margins from the
    // exported object entirely (they are the untrusted numbers — e.g. the
    // spurious weak-geometry +234%). Only rangeM + plausScore survive, which
    // the parallax redesign needs and which carry no capability claim. This
    // makes it structurally impossible for any consumer (records, summary,
    // pilot) to read an untrusted exceedance value.
    const exportedPerRange = S2_POSITIVE_ENABLED ? per
        : per.map((p) => ({rangeM: p.rangeM, plausScore: p.plausScore}));
    return {
        perRange: exportedPerRange,
        supportedCount: band.length,
        bandFracOfGrid: fracOfGrid,
        s2Enabled: S2_POSITIVE_ENABLED,
        decisiveByValley,               // diagnostic only while disabled
        decisive,
        verdict: !S2_POSITIVE_ENABLED ? "held-pending-redesign"
            : decisive ? "measured" : "range-indeterminate",
        speedExceedanceLB: lb("speedMarginFrac"),
        climbExceedanceLB: lb("climbMarginFrac"),
        gExceedanceLB: lb("gMarginFrac"),
    };
}

// Robust horizontal airspeed peak: 90th-percentile of per-frame 2-D speed over
// a 0.5 s window (sustained, not a single-frame spike).
function robustHorizontalSpeed(track, dataset, n) {
    const fps = dataset.fps;
    const h = Math.max(1, Math.round(0.25 * fps));
    const speeds = [];
    for (let f = h; f < n - h; f++) {
        const dt = 2 * h / fps;
        const vx = (track[(f + h) * 3] - track[(f - h) * 3]) / dt;
        const vy = (track[(f + h) * 3 + 1] - track[(f - h) * 3 + 1]) / dt;
        speeds.push(Math.hypot(vx, vy));
    }
    speeds.sort((a, b) => a - b);
    return speeds.length ? speeds[Math.floor(0.9 * (speeds.length - 1))] : 0;
}

// Identifiability: clean LOS separation between two truth realizations at the
// same geometry (e.g. lambda=1 vs a given rung). RMS + max angular, degrees.
export function cleanSeparationDeg(cleanDirA, cleanDirB, n) {
    let sum = 0, mx = 0, c = 0;
    for (let f = 0; f < n; f++) {
        const b = f * 3;
        const dot = Math.max(-1, Math.min(1,
            cleanDirA[b] * cleanDirB[b] + cleanDirA[b + 1] * cleanDirB[b + 1]
            + cleanDirA[b + 2] * cleanDirB[b + 2]));
        const a = Math.acos(dot) * RAD2DEG;
        sum += a * a; if (a > mx) mx = a; c++;
    }
    return {rmsDeg: Math.sqrt(sum / Math.max(1, c)), maxDeg: mx};
}
