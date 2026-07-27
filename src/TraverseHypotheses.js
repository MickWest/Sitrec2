/**
 * TraverseHypotheses.js — build the traverse-analysis hypothesis set.
 *
 * The pure half of what used to be AnalyzeTraverse.buildHypotheses(): every
 * hypothesis that is a function of the dataset and the fit results alone.
 * Kept free of the node graph, three.js and lil-gui for the same reason
 * TraverseAnalysis.js is — so the analysis the app actually ranks can be run
 * and measured headless, without a harness re-implementing it and drifting.
 *
 * Three things stayed behind in AnalyzeTraverse.js because they genuinely need
 * the live scene: the two astronomical-catalogue searches (they read the LOS
 * node and the night-sky star field) and the user's own LOS-fit method nodes.
 * They are injected through the `extraHypotheses` callback at exactly the point
 * in the sequence they previously occupied, so hypothesis ORDER is unchanged —
 * which matters, because ranking ties break on it.
 *
 * GUI state that was read from the module-level analyzeTweaks object is now
 * passed in (aoFixedPoint, groundMode); the caller owns it.
 */

import {
    METERS_PER_NM, KNOTS_TO_MS, EARTH_RADIUS_M, meanAngularError, trackMetrics,
    fitFixedPoint, fitFixedDirection, fitGroundPoint, fitGroundVehicle,
    pickConstAirRegime, traverseMinSpeed, straightFlightScore, traversePlausible,
} from "./TraverseAnalysis";
import {unpackTrackToECEF} from "./TraverseAnalysisData";
import {fitConstantAcceleration, assessLinearFitConditioning} from "./LOSFitting";
import {classifyFixedWing, classifyQuadcopter} from "./VehicleModels";
import {satelliteECEF, satelliteTrackENU, satelliteSunlit} from "./SatelliteSearch";
import {localFitCompletionWarnings, settledButUnidentifiable} from "./TraverseRanking";
import {solvedHorizontalWindAt} from "./TraverseWind";

export const UNDERGROUND_TOL = 40;
export const GROUND_CONTACT_TOL = 150;
export const VIZ = {
    surface: "#14161a",
    ink: "#e8eaed",
    ink2: "#b9bfc7",
    muted: "#8a9099",
    grid: "#262b33",
    axis: "#3c434c",
    constAir: "#3987e5",   // constant-air-speed traverse (sweep best)
    aircraft: "#199e70",   // parametric aircraft fit
    slowObj: "#c98500",    // slow-object plausible trajectory / profile
    fastObj: "#9085e9",    // fast-object plausible profile
    sensor: "#c3c2b7",     // sensor (jet) path
    ray: "#4a5058",        // LOS rays
    truth: "#e0569f",      // ground-truth reference track (dashed in 3D graphs)
};
export function losAngularRateSeries(dataset) {
    const {n, D, fps} = dataset;
    const rate = new Float64Array(n);
    for (let f = 1; f < n; f++) {
        let d = D[f * 3] * D[(f - 1) * 3] + D[f * 3 + 1] * D[(f - 1) * 3 + 1] + D[f * 3 + 2] * D[(f - 1) * 3 + 2];
        d = d > 1 ? 1 : d < -1 ? -1 : d;
        rate[f] = Math.acos(d) * fps * 180 / Math.PI;
    }
    if (n > 1) rate[0] = rate[1];
    return rate;
}
export function sliceAnalysisDataset(dataset, f0, f1) {
    const lo = Math.max(0, Math.min(dataset.n - 1, f0));
    const hi = Math.max(lo, Math.min(dataset.n - 1, f1));
    const n = hi - lo + 1;
    const copy = (src) => {
        const out = new Float64Array(n * 3);
        for (let f = 0; f < n; f++) {
            const a = (lo + f) * 3, b = f * 3;
            out[b] = src[a];
            out[b + 1] = src[a + 1];
            out[b + 2] = src[a + 2];
        }
        return out;
    };
    return {
        n,
        fps: dataset.fps,
        S: copy(dataset.S),
        D: copy(dataset.D),
        W: copy(dataset.W),
    };
}
export function syncRangeProfile(dataset, ranges, options = {}) {
    const out = [];
    const vTarget = options.vTarget ?? null;
    const vSigma = options.vSigma ?? 50 * KNOTS_TO_MS;
    const scoreSpeedWeight = options.scoreSpeedWeight ?? 0;
    for (const startDist of ranges) {
        const {track, lam} = traversePlausible(dataset, startDist, options);
        const m = trackMetrics(dataset, track);
        let score = straightFlightScore(m);
        if (vTarget !== null && scoreSpeedWeight > 0) {
            score += scoreSpeedWeight * ((m.airSpeed.mean - vTarget) / vSigma) ** 2;
        }
        out.push({
            startDist,
            endDist: lam[dataset.n - 1],
            minDist: Math.min(...lam),
            score,
            metrics: m,
        });
    }
    return out;
}
export function pinLabel(pin) {
    return pin.name + (pin.side === "lo" ? " (min)" : " (max)");
}

/**
 * Wall-clock time of dataset frame f, from an injected clip start.
 *
 * dataset.fps is EFFECTIVE frames per real second — buildAnalysisDataset sets
 * it to Sit.fps / simSpeed — so elapsed real time is simply frames /
 * dataset.fps. This is algebraically identical to the scene-bound original
 * (dateStart + globalFrame * 1000 * simSpeed / Sit.fps); applying simSpeed on
 * top of dataset.fps as well squares it.
 */
/**
 * Terrain probes for a FLAT-PLANE dataset (surfaceModel "flat-plane"): ground
 * is a level surface at groundZ, so height above ground is just the ENU height
 * minus that. Returns BOTH probes, because supplying only one is the bug this
 * helper exists to prevent — see the both-or-neither check in buildHypotheses.
 */
export function flatTerrainProbes(groundZ = 0) {
    return {
        signedAGL: (_ecefPoint, enuZ) => enuZ - groundZ,
        localGroundZ: () => groundZ,
    };
}

export function clipFrameDate(clipStartMs, dataset, f) {
    return new Date(clipStartMs + ((dataset.frame0 ?? 0) + f) * 1000 / dataset.fps);
}

export const DRONE_CONTROL_KNOTS = 4;
export const toNM = (m) => m / METERS_PER_NM;
export const toKt = (ms) => ms / KNOTS_TO_MS;
export const nm1 = (m) => toNM(m).toFixed(1);
export const kt1 = (ms) => toKt(ms).toFixed(1);

export const ORDER_NAMES = {
    1: "linear (constant velocity)",
    2: "quadratic (constant acceleration)",
    3: "cubic",
    4: "quartic",
    5: "quintic",
};

export function computeSaddle(dataset, slowProfile, slowOpts) {
    const {n, fps} = dataset;
    if (!slowProfile || slowProfile.length < 3 || n < 4) return null;

    // 1) Low-motion window: smooth the LOS rate, find its minimum, and grow a
    //    contiguous window around it while the rate stays near that minimum.
    const rate = losAngularRateSeries(dataset);
    const W = Math.max(1, Math.round(fps));           // ~1 s smoothing
    const sm = new Float64Array(n);
    for (let f = 0; f < n; f++) {
        let s = 0, c = 0;
        for (let k = -W; k <= W; k++) { const g = f + k; if (g >= 0 && g < n) { s += rate[g]; c++; } }
        sm[f] = s / c;
    }
    let fStar = 0;
    for (let f = 1; f < n; f++) if (sm[f] < sm[fStar]) fStar = f;
    const sorted = Array.from(sm).sort((a, b) => a - b);
    const minRate = sm[fStar];
    const medRate = sorted[Math.floor(n / 2)];
    const cut = minRate + 0.35 * (medRate - minRate);
    let f0 = fStar, f1 = fStar;
    while (f0 > 0 && sm[f0 - 1] <= cut) f0--;
    while (f1 < n - 1 && sm[f1 + 1] <= cut) f1++;

    // Genuine-window gate: a saddle window only means something if the LOS
    // rate genuinely DIPS (min well below the median) for a sustained stretch.
    // On a continuously rotating LOS (a sensor orbiting a crossing object) the
    // "minimum" is just the boxcar-smoothing tail at the clip edge — a
    // sub-second window over which EVERY range trivially fits, yielding a
    // bogus "all ranges fit equally" family.
    const genuineWindow = (minRate < 0.35 * medRate) && ((f1 - f0 + 1) / fps >= 2);

    // 2) Family band: score the same range grid over ONLY the low-motion window.
    //    The full-clip slow profile can reject the visually obvious saddle
    //    because later high-rate frames force any close, slow object into a hard
    //    maneuver. For the saddle interpretation, the family lives where the
    //    bearing barely moves. Without a genuine window, the family comes from
    //    the FULL-CLIP slow profile (already computed by the caller — free).
    let rows;
    if (genuineWindow) {
        const ranges = slowProfile.map((p) => p.startDist).filter((v) => isFinite(v) && v > 0);
        const windowDataset = sliceAnalysisDataset(dataset, f0, f1);
        const windowOpts = {
            ...slowOpts,
            K: Math.min(slowOpts.K ?? 25, Math.max(7, Math.floor(windowDataset.n / 2))),
        };
        rows = syncRangeProfile(windowDataset, ranges, windowOpts).filter((p) => isFinite(p.score));
    } else {
        rows = slowProfile.filter((p) => isFinite(p.score) && isFinite(p.startDist) && p.startDist > 0);
    }
    if (rows.length < 3) return null;
    let bi = 0;
    for (let i = 1; i < rows.length; i++) if (rows[i].score < rows[bi].score) bi = i;
    const sBest = rows[bi].score;
    const sSorted = rows.map((p) => p.score).sort((a, b) => a - b);
    const sMed = sSorted[Math.floor(sSorted.length / 2)];
    const sThresh = sBest + 0.5 * (sMed - sBest);
    let lo = bi, hi = bi;
    while (lo > 0 && rows[lo - 1].score <= sThresh) lo--;
    while (hi < rows.length - 1 && rows[hi + 1].score <= sThresh) hi++;
    // 3) Representative traversal: the SLOWEST object consistent with the whole
    //    clip (minimum air speed on the rays). The saddle exists precisely
    //    because a sensor orbiting a slow object shows mostly parallax, so the
    //    minimum-speed member is the natural representative — a barely-drifting
    //    lantern/balloon — not the fast least-maneuvering path a fixed range
    //    would force outside the low-motion window. (Anchoring one range and
    //    minimizing maneuvering gave tens of kt here; minimizing speed gives
    //    the ~10 kt drift that actually matches these cases.)
    const {track, lam} = traverseMinSpeed(dataset, {minDist: 120});
    let windowMetrics = null;
    if (genuineWindow) {
        const windowDataset = sliceAnalysisDataset(dataset, f0, f1);
        const windowTrack = new Float64Array(windowDataset.n * 3);
        for (let f = 0; f < windowDataset.n; f++) {
            const s = (f0 + f) * 3, d = f * 3;
            windowTrack[d] = track[s]; windowTrack[d + 1] = track[s + 1]; windowTrack[d + 2] = track[s + 2];
        }
        windowMetrics = trackMetrics(windowDataset, windowTrack);
    }
    const errDeg = meanAngularError(dataset, track) * 180 / Math.PI;
    // headline range = the min-speed track's median slant range (lam = range on ray)
    const lamSorted = Array.from(lam).sort((a, b) => a - b);
    const medRange = lamSorted[Math.floor(lamSorted.length / 2)];

    return {
        track, errDeg,
        window: genuineWindow
            ? {f0, f1, fStar, t0: f0 / fps, t1: f1 / fps, minRateDegS: minRate, medRateDegS: medRate}
            : null,
        family: {
            loM: rows[lo].startDist, hiM: rows[hi].startDist, repM: medRange,
            count: hi - lo + 1, total: rows.length,
        },
        boundaryLimited: lo === 0 || hi === rows.length - 1 || !!slowProfile.boundaryLimited,
        boundarySides: {
            lo: lo === 0 || !!slowProfile.boundarySides?.lo,
            hi: hi === rows.length - 1 || !!slowProfile.boundarySides?.hi,
        },
        windowMetrics,
    };
}
// signedAGL(ecefPoint, enuZ) -> metres above local ground. INJECTED, because
// the real implementation reaches getPointBelow/calculateAltitude in threeExt
// and therefore the loaded scene.
//
// The ENU height is passed alongside the ECEF point so a flat-plane probe can
// answer directly (enuZ - groundZ) instead of converting back out of ECEF; the
// scene-backed probe ignores it. See flatTerrainProbes().
export function trackGroundStats(track, n, originLat, originLon, signedAGL, samples = 48) {
    if (!track || n < 1 || typeof signedAGL !== "function") return null;
    const ecef = unpackTrackToECEF(track, n, originLat, originLon);
    const step = Math.max(1, Math.floor((n - 1) / samples) || 1);
    let minAGL = Infinity, maxAGL = -Infinity, below = 0, tested = 0;
    // Frozen ground TRACE: the local terrain level directly under each
    // sampled track point ([x, y, zGround] metres, ENU). At the same
    // horizontal location the geodetic-altitude difference IS the local-z
    // difference, so zGround = trackZ - AGL with no extra conversions. The
    // 3D graphs draw this under an underground-flagged candidate so a local
    // burial is visible against the LOCAL terrain, which a single flat
    // minimum plane cannot show on sloped ground.
    const trace = [];
    for (let f = 0; f < n; f += step) {
        const agl = signedAGL(ecef[f].position, track[f * 3 + 2]);
        if (agl < minAGL) minAGL = agl;
        if (agl > maxAGL) maxAGL = agl;
        if (agl < -UNDERGROUND_TOL) below++;
        tested++;
        if (Number.isFinite(agl)) {
            trace.push(track[f * 3], track[f * 3 + 1], track[f * 3 + 2] - agl);
        }
    }
    return {
        minAGL, maxAGL,
        startAGL: signedAGL(ecef[0].position, track[2]),
        endAGL: signedAGL(ecef[n - 1].position, track[(n - 1) * 3 + 2]),
        fracBelow: tested ? below / tested : 0,
        trace: Float64Array.from(trace),
    };
}
export function groundContactViolation(stats, mode) {
    if (!stats) return null;
    switch (mode) {
        case "On the ground":
            return stats.maxAGL > GROUND_CONTACT_TOL ? "airborne (not a ground vehicle)" : null;
        case "Starts on ground":
            return stats.startAGL > GROUND_CONTACT_TOL ? "does not start on the ground" : null;
        case "Ends on ground":
            return stats.endAGL > GROUND_CONTACT_TOL ? "does not end on the ground" : null;
        default:
            return null;
    }
}
export function datasetForSolvedModelWind(dataset, track, solved, modelKind) {
    if (!solved || !Number.isFinite(solved.windE) || !Number.isFinite(solved.windN)) {
        return dataset;
    }
    const W = new Float64Array(dataset.n * 3);
    const dt = 1 / dataset.fps;
    const x0 = track[0], y0 = track[1], z0 = track[2];
    const h0 = z0 + (x0 * x0 + y0 * y0) / (2 * EARTH_RADIUS_M);
    const nm1 = Math.max(1, dataset.n - 1);   // normalised time runs 0..1 over the clip
    for (let f = 0; f < dataset.n; f++) {
        const x = track[f * 3], y = track[f * 3 + 1], z = track[f * 3 + 2];
        const altitudeM = z + (x * x + y * y) / (2 * EARTH_RADIUS_M);
        const wind = solvedHorizontalWindAt(solved, {
            modelKind,
            normalizedTime: f / nm1,
            altitudeM,
            referenceAltitudeM: h0,
        });
        W[f * 3] = wind.u * dt;
        W[f * 3 + 1] = wind.v * dt;
    }
    return {...dataset, W};
}
export function splitBoundPins(records, include, constraintId = (p) => p.name) {
    const active = new Map();
    const inactive = new Map();
    const unstable = new Map();
    for (const pin of records || []) {
        if (!include(pin)) continue;
        const target = pin.inwardBetter ? unstable : pin.loadBearing === false ? inactive : active;
        const id = constraintId(pin);
        if (!target.has(id)) target.set(id, pinLabel(pin));
    }
    return {active, inactive, unstable};
}
export function physicsBoundSubtitle(base, active, inactive, unstable = []) {
    const parts = [];
    if (active.length) parts.push(`locally load-bearing limit${active.length === 1 ? "" : "s"}: ${active.join(", ")}`);
    if (inactive.length) parts.push(`unconstrained at bound: ${inactive.join(", ")}`);
    if (unstable.length) parts.push(`inward probe improved the fit: ${unstable.join(", ")}`);
    return parts.length ? `${base} — ${parts.join("; ")}` : base;
}
export function lanternHypothesis(fit, dataset, errFloor, {key, name, notes, windPolicy, windEvidenceRole}) {
    if (!fit || !fit.positions) {
        return {
            key, name, subtitle: "Wind-drift model unavailable", color: VIZ.slowObj,
            track: null, metricsFull: null, errDeg: NaN, params: {}, windEvidenceRole,
            notes: "Fit failed — no plausible buoyant-object trajectory converged.",
        };
    }
    const S = dataset.S;
    const track = fit.positions;
    const range0 = Math.hypot(track[0] - S[0], track[1] - S[1], track[2] - S[2]);
    const solved = fit.params.solved || {};
    const lanternMetrics = trackMetrics(
        datasetForSolvedModelWind(dataset, track, solved, "lantern"), track);
    // Side-aware bound pins: a pin at a natural ZERO (vRise/vSink lo bound =
    // "not rising/sinking") is physical for a becalmed balloon; only capability
    // MAX pins and range/wind extremes mean "the data wants more than a balloon".
    const lanSplit = splitBoundPins(fit.params.pinned,
        (p) => (["initialRange", "windE", "windN", "shearPerM",
            "windDriftE", "windDriftN", "windCurveE", "windCurveN"].includes(p.name))
            || (["vRise", "vSink"].includes(p.name) && p.side === "hi"),
        (p) => p.name === "shearPerM" ? "windShear" : p.name);
    const lanClamps = [];
    if (Number.isFinite(solved.shearPerM)) {
        const x0 = track[0], y0 = track[1], z0 = track[2];
        const h0 = z0 + (x0 * x0 + y0 * y0) / (2 * EARTH_RADIUS_M);
        let hitsShearClamp = false;
        for (let f = 0; f < dataset.n; f++) {
            const x = track[f * 3], y = track[f * 3 + 1], z = track[f * 3 + 2];
            const h = z + (x * x + y * y) / (2 * EARTH_RADIUS_M);
            const raw = 1 + solved.shearPerM * (h - h0);
            if (raw <= 0.25 * 1.001 || raw >= 3 / 1.001) { hitsShearClamp = true; break; }
        }
        if (hitsShearClamp) lanClamps.push("wind shear multiplier (0.25–3× clamp)");
    }
    const lanPins = Array.from(lanSplit.active.values());
    const lanInactive = Array.from(lanSplit.inactive.values());
    const lanUnstable = Array.from(lanSplit.unstable.values());
    // Identifiability vs incompleteness: with flame-out solved at/beyond the
    // clip end the sink/cool-down parameters never affect the fitted window,
    // so they legitimately hold the Nelder-Mead simplex wide and the
    // iteration-limit stop is NOT an unfinished search (measured: a genuine
    // easy balloon was badged "Optimizer incomplete" for exactly this). The
    // note replaces the warning ONLY when the objective is settled and the
    // wide dimensions are exactly the lifecycle set — see
    // settledButUnidentifiable in TraverseRanking.js.
    // The gate requires the WHOLE final simplex's tBurn at/beyond the clip
    // end (requireMinAtLeast), not just the best vertex — a simplex
    // straddling the clip end is a real still-burning/already-cooling
    // ambiguity and stays a genuine incomplete.
    const lanternClipT = (dataset.n - 1) / dataset.fps;
    const lanternLifecycleNote = (Number.isFinite(solved.tBurn)
        && solved.tBurn >= lanternClipT)
        ? settledButUnidentifiable(fit.params.optimizer, ["vSink", "tauCool", "tBurn"],
            {tBurn: lanternClipT})
        : null;
    return {
        key, name,
        subtitle: physicsBoundSubtitle("Bounded wind-drift/life-cycle model", lanPins, lanInactive, lanUnstable)
            + (lanClamps.length ? `; internal clamp reached: ${lanClamps.join(", ")}` : "")
            + (lanternLifecycleNote ? `; ${lanternLifecycleNote}` : ""),
        color: VIZ.slowObj,
        windEvidenceRole,
        track,
        metricsFull: lanternMetrics,
        errDeg: fit.params.errDeg,
        boundPinned: lanPins,
        boundInactive: lanInactive,
        modelClamps: lanClamps,
        // Includes the optimizer's own completion state (iteration-limit
        // stops), matching the drone fit — this also gates the wind-evidence
        // rating, which must not call an unconverged fit "supporting".
        optimizerWarnings: [
            ...lanUnstable.map((w) => `inward bound probe improved ${w}`),
            // Suppressed when the stop is a settled-objective identifiability
            // limit (lanternLifecycleNote above) — the note is carried in the
            // subtitle instead, and those parameters are still reported as
            // NOT measured.
            ...(lanternLifecycleNote ? [] : localFitCompletionWarnings(fit.params.optimizer)),
        ],
        ...(lanternLifecycleNote ? {identifiabilityNote: lanternLifecycleNote} : {}),
        params: {
            range: range0,
            windE: solved.windE, windN: solved.windN, shearPerM: solved.shearPerM,
            // Time-varying wind coefficients (linear + quadratic change in each
            // component across the clip), disclosed so the fit is reproducible
            // from the visible parameters — see TA-04.
            windDriftE: solved.windDriftE, windDriftN: solved.windDriftN,
            windCurveE: solved.windCurveE, windCurveN: solved.windCurveN,
            vRise: solved.vRise, vSink: solved.vSink, tBurn: solved.tBurn, tauCool: solved.tauCool,
            clipT: (dataset.n - 1) / dataset.fps,
            windPolicy,
            // Soft-prior cost at the solution, so a tile that says its wind was
            // INFERRED can be checked against what the calm-wind prior paid.
            priors: fit.params.priors,
            errFloor,
        },
        notes,
    };
}

export function buildHypotheses({dataset, sweep, ca, plausible, aircraft, lantern, lanternMeasured,
    quad, satellite, slowProfile, slowOpts, originLat, originLon, provenance = null,
    failures = null, windPrior = null, mcSweep = null, droneCtl = null,
    // GUI state, previously read from the enclosing module.
    aoFixedPoint = true, groundMode = "Airborne (any)",
    // Absolute clip start, in epoch ms. Previously read from
    // GlobalDateTimeNode / Sit, which are null without a scene — so every
    // date-dependent hypothesis threw headless. Passing it in makes the builder
    // a function of its arguments. Null disables the hypotheses that need a
    // wall-clock time (currently the catalogued-satellite pass).
    //
    // There is deliberately NO simSpeed parameter: dataset.fps is already
    // EFFECTIVE frames per real second (buildAnalysisDataset sets it to
    // Sit.fps / simSpeed), so elapsed time is frames / dataset.fps. Passing
    // simSpeed as well applied it twice — harmless at the default 1, but a
    // 10x-speed sitch got 100x the time offset.
    clipStartMs = null,
    // Terrain probes. The real implementations reach getPointBelow /
    // calculateAltitude in threeExt and therefore the loaded scene, so they are
    // injected. Null disables the ground-dependent hypotheses and checks — the
    // correct behaviour for a flat-plane dataset with no terrain. A headless
    // caller on flat ground should pass localGroundZ: () => 0 explicitly rather
    // than let a default guess for it.
    signedAGL = null, localGroundZ = null,
    // Scene-coupled hypotheses (astronomy, satellite, live method nodes),
    // spliced in where sections 8-9 used to sit so ordering — and therefore
    // tie-breaking — is exactly what it was.
    extraHypotheses = null}) {
    // Both terrain probes or neither. With only localGroundZ the ground
    // hypotheses are built but trackGroundStats returns null, so the
    // underground and ground-contact rejections never fire and a trajectory
    // diving below the surface ranks as an eligible candidate — silent
    // app-vs-headless ranking drift. With only signedAGL the ground
    // hypotheses vanish instead. Fail loudly; flatTerrainProbes() returns a
    // correct pair for flat-plane datasets.
    if (Boolean(signedAGL) !== Boolean(localGroundZ)) {
        throw new Error("buildHypotheses: signedAGL and localGroundZ must be "
            + "supplied together (got "
            + (signedAGL ? "signedAGL only" : "localGroundZ only")
            + "). Use flatTerrainProbes() for a flat-plane dataset.");
    }
    const S = dataset.S;
    const globalFrame = (f) => (dataset.frame0 ?? 0) + f;
    const dateForDatasetFrame = clipStartMs == null ? null
        : (f) => clipFrameDate(clipStartMs, dataset, f);
    const list = [];
    // Surface motion is constrained relative to Earth, not the air mass. Use a
    // zero-wind metric view so road speed, acceleration/g and headings are
    // ground-relative; otherwise a head/tailwind changes the vehicle verdict.
    const groundMetricDataset = {...dataset, W: new Float64Array(dataset.W.length)};

    // Generic reference residual (degrees): the mean angular error left by a
    // deterministic constant-acceleration path with no object-type assumption.
    // It combines pointing error, real target maneuver, and model mismatch; it
    // is useful scale context but is not a measured sensor-noise floor.
    let errFloor = NaN;
    try {
        const fTimes = new Float64Array(dataset.n);
        for (let f = 0; f < dataset.n; f++) fTimes[f] = f / dataset.fps;
        // minRange keeps the free fit off its degenerate optimum: on a
        // straight-and-level sensor the unconstrained CA fit collapses onto
        // the sensor's own path (zero perpendicular residual, ~90 deg angular
        // error) and the floor annotation would silently lie.
        const caFree = fitConstantAcceleration(
            {sensorPos: dataset.S, losDir: dataset.D, times: fTimes, count: dataset.n,
                maxRange: null, minRange: 500},
            new Set());
        if (caFree && caFree.positions) {
            errFloor = meanAngularError(dataset, caFree.positions) * 180 / Math.PI;
        }
    } catch (e) { /* annotation degrades gracefully; floor stays NaN */ }

    // 1. Constant air speed — smoothest ray-following path that holds a fixed
    //    air speed (QP solve; honest small residual). The sweep's family
    //    representative is prior-anchored on the Target Speed GUI value (a
    //    fast-jet default), so a genuinely SLOW object (balloon, drifting
    //    debris) can live in the slow range-profile valley the sweep never
    //    represents. Build an honest constant-air-speed candidate at the slow
    //    valley's best range too, re-score both on the same neutral metric
    //    (their internal scores use different priors/smoothing and must never
    //    be compared raw), and keep the fast pick unless the slow candidate
    //    wins DECISIVELY (see slowRegimeWins).
    {
        const regimePick = pickConstAirRegime(dataset, sweep, slowProfile);
        const fastTrack = regimePick.fast.track;
        const fastScored = regimePick.fast.scored;
        const slowPick = regimePick.useSlow
            ? {...regimePick.slow, fastScore: fastScored.score}
            : null;

        const boundaryPins = [];
        if (slowPick) {
            if (slowProfile.boundaryLimited) boundaryPins.push("range (slow-profile search edge)");
        } else {
            if (sweep.boundaryAxes?.range) {
                const rLo = Math.min(...sweep.ranges), rHi = Math.max(...sweep.ranges);
                if (sweep.familyBand?.rangeLo <= rLo * 1.001) boundaryPins.push("range (lower search edge)");
                if (sweep.familyBand?.rangeHi >= rHi * 0.999) boundaryPins.push("range (upper search edge)");
            }
            if (sweep.boundaryAxes?.speed) {
                const vLo = Math.min(...sweep.speeds), vHi = Math.max(...sweep.speeds);
                if (sweep.familyBand?.speedLo <= vLo * 1.001) boundaryPins.push("speed (lower search edge)");
                if (sweep.familyBand?.speedHi >= vHi * 0.999) boundaryPins.push("speed (upper search edge)");
            }
        }

        if (slowPick) {
            list.push({
                key: "constAir",
                name: "Constant Air Speed",
                subtitle: `Slow-drift valley: ~${kt1(slowPick.speed)} kt near ${nm1(slowPick.row.startDist)} NM`,
                color: VIZ.constAir,
                track: slowPick.track,
                metricsFull: slowPick.scored.metrics,
                errDeg: slowPick.scored.errDeg,
                searchBounds: boundaryPins.length ? boundaryPins : undefined,
                params: {
                    range: slowPick.row.startDist, airSpeed: slowPick.speed, errFloor,
                    regime: "slow",
                    slowScore: slowPick.scored.score, fastScore: slowPick.fastScore,
                    boundaryLimited: slowProfile.boundaryLimited ? 1 : 0,
                },
                notes: "The smoothest path following the LOS rays while holding air speed fixed. "
                    + `The slow-object range valley (${nm1(slowPick.row.startDist)} NM at ~${kt1(slowPick.speed)} kt) `
                    + `outscored the fast sweep's prior-anchored representative on the shared smoothness metric `
                    + `(${slowPick.scored.score.toFixed(2)} vs ${slowPick.fastScore.toFixed(2)}, lower is better) — `
                    + `the evidence prefers a slow drifting object over anything near the Target Speed prior.`,
            });
        } else {
            list.push({
                key: "constAir",
                name: "Constant Air Speed",
                subtitle: (sweep.familyBand && sweep.familyBand.count > 1)
                    ? `Family: ${kt1(sweep.familyBand.speedLo)}–${kt1(sweep.familyBand.speedHi)} kt at ` +
                      `${nm1(sweep.familyBand.rangeLo)}–${nm1(sweep.familyBand.rangeHi)} NM fit about equally`
                    : "Fixed airspeed, wind-corrected",
                color: VIZ.constAir,
                track: fastTrack,
                metricsFull: fastScored.metrics,
                errDeg: fastScored.errDeg,
                searchBounds: boundaryPins.length ? boundaryPins : undefined,
                params: {
                    range: sweep.best.startDist, airSpeed: sweep.best.speed, errFloor,
                    familyRangeLo: sweep.familyBand?.rangeLo, familyRangeHi: sweep.familyBand?.rangeHi,
                    familySpeedLo: sweep.familyBand?.speedLo, familySpeedHi: sweep.familyBand?.speedHi,
                    familyCount: sweep.familyBand?.count,
                    boundaryLimited: sweep.boundaryLimited ? 1 : 0,
                },
                notes: "The smoothest path following the LOS rays while holding air speed fixed."
                    + ((sweep.familyBand && sweep.familyBand.count > 1)
                        ? ` ${sweep.familyBand.count} grid cells fit about equally — the shown cell is the`
                          + ` family member closest to the Target Speed prior, not a uniquely determined answer.`
                        : "")
                    + (sweep.boundaryLimited
                        ? ` The supported family reaches the ${[
                            sweep.boundaryAxes?.range ? "range" : null,
                            sweep.boundaryAxes?.speed ? "speed" : null,
                        ].filter(Boolean).join(" and ")} search boundary — treat the affected value as a bound, not a resolved optimum.`
                        : ""),
            });
        }
    }

    // 2. Constant altitude — level flight crossing each ray at a fixed height.
    //    The displayed track is the lightly SMOOTHED ray-rider (honest small
    //    errDeg); near-horizontal sightlines never cross a constant-altitude
    //    plane, in which case the fit reports failure and gets a null tile.
    if (ca && !ca.failed) {
        const track = ca.track;
        list.push({
            key: "constAlt",
            name: "Constant Altitude",
            subtitle: "Level flight at a fixed height",
            color: "#d05fb0",
            track,
            metricsFull: trackMetrics(dataset, track),
            errDeg: ca.errDeg ?? 0,
            params: {range: ca.startDist, altZ: ca.altZ, errFloor,
                boundaryLimited: ca.boundaryLimited ? 1 : 0},
            notes: "Object held at a fixed geodetic altitude, following the sightlines to a small residual."
                + (ca.boundaryLimited ? " The selected altitude reaches the search edge and is unresolved." : ""),
        });
    } else {
        list.push({
            key: "constAlt",
            name: "Constant Altitude",
            subtitle: "Level flight at a fixed height",
            color: "#d05fb0",
            track: null,
            metricsFull: null,
            errDeg: NaN,
            params: {},
            notes: "Fit failed — the sightlines are near-horizontal and never cross a constant-altitude plane.",
        });
    }

    // 3. Least-maneuvering plausible path — smoothest ray-riding trajectory.
    //    Two-stage: geometry-decisive scenes pick the range purely by
    //    smoothness; narrow-baseline scenes fall back to the soft speed target.
    {
        const track = plausible.track;
        list.push({
            key: "plausible",
            name: "Minimum Acceleration",
            subtitle: plausible.usedSpeedTarget
                ? "Acceleration-minimizing path at any range (soft speed target)"
                : "Acceleration-minimizing path at any range (geometry-picked)",
            color: VIZ.fastObj,
            track,
            metricsFull: trackMetrics(dataset, track),
            errDeg: meanAngularError(dataset, track) * 180 / Math.PI,
            searchBounds: plausible.boundaryLimited ? [
                plausible.boundarySides?.lo ? "range (lower search edge)" : null,
                plausible.boundarySides?.hi ? "range (upper search edge)" : null,
            ].filter(Boolean) : undefined,
            params: {
                range: plausible.startDist,
                usedSpeedTarget: plausible.usedSpeedTarget,
                decisiveness: plausible.decisiveness,
                boundaryLimited: plausible.boundaryLimited ? 1 : 0,
                errFloor,
            },
            notes: (plausible.usedSpeedTarget
                ? "The smoothest trajectory that follows every line of sight; the geometry left the range " +
                  "ambiguous, so the soft speed target picked the representative member."
                : "The smoothest trajectory that follows every line of sight; the smoothness-vs-range " +
                  "profile picks the range on its own, so no speed assumption was needed.")
                + (plausible.boundaryLimited
                    ? " The selected range is on the search edge and is therefore unresolved."
                    : ""),
        });
    }

    // 3b. Saddle traversal — the slow/near-static family anchored on the region
    //     of least LOS motion (a sensor orbiting a slow object). Represents the
    //     "it's a mundane slow thing and the motion is parallax" reading, and
    //     the family (range band) that the low-motion geometry leaves open.
    {
        const saddle = computeSaddle(dataset, slowProfile, slowOpts);
        if (saddle) {
            const m = trackMetrics(dataset, saddle.track);
            const w = saddle.window, fam = saddle.family;
            // Window params/notes only when a GENUINE low-motion window exists
            // (w is null on a continuously rotating LOS — then the family band
            // comes from the full-clip slow profile and the range is pinned
            // rather than ambiguous).
            const windowParams = w ? {
                saddleT0: w.t0, saddleT1: w.t1, saddleFStar: w.fStar,
                minRateDegS: w.minRateDegS, medRateDegS: w.medRateDegS,
                windowAirMean: saddle.windowMetrics.airSpeed.mean,
                windowAirMax: saddle.windowMetrics.airSpeed.max,
                windowGMax: saddle.windowMetrics.gLoad.max,
            } : {};
            const familyNote = w
                ? `Over the ${w.t0.toFixed(1)}–${w.t1.toFixed(1)} s low-motion window the bearing barely moves, `
                    + `so a whole range band (${nm1(fam.loM)}–${nm1(fam.hiM)} NM) fits about equally.`
                : `The slow-object cost valley pins the range to ${nm1(fam.loM)}–${nm1(fam.hiM)} NM `
                    + `(${fam.count} of ${fam.total} grid ranges); no low-motion window exists in this clip.`;
            list.push({
                key: "saddle",
                name: "Minimum Speed",
                subtitle: "Slowest object consistent with the sightlines",
                color: "#e0a35e",
                track: saddle.track,
                metricsFull: m,
                errDeg: saddle.errDeg,
                params: {
                    range: fam.repM,
                    ...windowParams,
                    familyLoM: fam.loM, familyHiM: fam.hiM, familyCount: fam.count, familyTotal: fam.total,
                    boundaryLimited: saddle.boundaryLimited ? 1 : 0,
                    errFloor,
                },
                searchBounds: saddle.boundaryLimited ? [
                    saddle.boundarySides?.lo ? "range (lower search edge)" : null,
                    saddle.boundarySides?.hi ? "range (upper search edge)" : null,
                ].filter(Boolean) : undefined,
                notes: `The slowest object that stays on the sightlines (${kt1(m.airSpeed.mean)} kt mean). `
                    + familyNote
                    + (saddle.boundaryLimited ? " The supported family reaches the search boundary and is incomplete." : ""),
            });
        }
    }

    // 4. Fixed-wing aircraft model — parametric fit with a small residual error.
    if (aircraft && aircraft.track) {
        const track = aircraft.track;
        const aircraftMetrics = trackMetrics(dataset, track);
        // Only locally load-bearing bounds demote the model. Coordinates that
        // happen to sit at a bound in a flat/inactive direction are reported as
        // unresolved rather than misrepresented as capability violations.
        const fwSplit = splitBoundPins(aircraft.pinned,
            (p) => ["startDist", "tas", "turnRate", "turnAccel", "climb"].includes(p.name));
        const fwPins = Array.from(fwSplit.active.values());
        const fwInactive = Array.from(fwSplit.inactive.values());
        const fwUnstable = Array.from(fwSplit.unstable.values());
        // Name the nearest common fixed-wing type from the solved TAS/climb —
        // a closest PERFORMANCE ENVELOPE, never an identification.
        const totalAirSpeed = Math.hypot(aircraft.params.tas, aircraft.params.climb);
        const fwClass = classifyFixedWing(totalAirSpeed, aircraft.params.climb,
            aircraftMetrics.gLoad.max, aircraftMetrics.altitude.max);
        const nearFW = !fwPins.length && fwClass.compatible ? fwClass.model : null;
        list.push({
            key: "aircraft",
            name: "Fixed-Wing Aircraft (generic prior)",
            subtitle: physicsBoundSubtitle(
                nearFW ? "Closest containing envelope: " + nearFW.name + " (not an ID)"
                    : "Generic fixed-wing fit; no named catalog envelope contains the solved motion",
                fwPins, fwInactive, fwUnstable),
            color: VIZ.aircraft,
            track,
            metricsFull: aircraftMetrics,
            errDeg: aircraft.errDeg,
            boundPinned: fwPins,
            boundInactive: fwInactive,
            optimizerWarnings: fwUnstable.map((w) => `inward bound probe improved ${w}`),
            params: {
                range: aircraft.params.startDist,
                heading: aircraft.params.heading,
                tas: aircraft.params.tas,
                totalAirSpeed,
                turn: aircraft.params.turnRate,
                climb: aircraft.params.climb,
                closest: nearFW ? nearFW.name : null,
                priors: aircraft.params.priors,
                errFloor,
            },
            notes: "Constant horizontal-air-speed fixed-wing model fit to the sightlines by differential evolution."
                + (fwPins.length ? " Locally load-bearing parameters reach the generic prior limits (" + fwPins.join(", ")
                    + ") — treat this model test as incomplete, not as excluding every fixed-wing aircraft."
                    : (nearFW ? " Closest common type by performance envelope: " + nearFW.name + " (not an identification)." : "")),
        });
    }

    // 5. balloon (Sky Lantern / Balloon) — TWO reconstructions from the same
    //    wind-tracer model, the two ways of treating wind:
    //      (a) FINDING the wind: fitted freely, no wind input at all;
    //      (b) USING the existing wind: drift softly pinned to the sitch's wind.
    //    Both keyed "lantern" so they share the forward-model group, apply path,
    //    and prose. The pinned variant is named for its PROVENANCE — a measured
    //    sounding/GFS profile and a hand-set constant are both usable, but they
    //    are not equally good evidence, so the label says which one it was.
    const windMeasured = windPrior ? windPrior.measured : false;
    const pinnedWindLabel = windMeasured ? "measured wind" : "sitch wind";
    list.push(lanternHypothesis(lantern, dataset, errFloor, {
        key: "lantern",
        name: lanternMeasured ? "Sky Lantern / Balloon (free wind)" : "Sky Lantern / Balloon",
        // The free fit's solved wind is the only balloon wind that can be
        // INDEPENDENTLY checked against an external reference — see
        // attachBalloonWindEvidence.
        windEvidenceRole: "free",
        windPolicy: "free-diagnostic: wind fitted by this model, no wind input",
        notes: "FREE reconstruction: wind-drift lantern kinematics (rise, buoyancy decay, terminal "
            + "sink; altitude-sheared wind) fit to the sightlines with the wind INFERRED, not assumed. "
            + "The inferred wind is what a plausible balloon here would require.",
    }));
    if (lanternMeasured) {
        const windDesc = windPrior && windPrior.statusText ? ` (${windPrior.statusText})` : "";
        list.push(lanternHypothesis(lanternMeasured, dataset, errFloor, {
            key: "lantern",
            name: `Sky Lantern / Balloon (${pinnedWindLabel})`,
            // This fit CONSUMED the wind reference, so its agreement with that
            // wind is expected, not independent evidence.
            windEvidenceRole: "externally-conditioned",
            windPolicy: windMeasured
                ? `measured-corrected: drift wind pinned loosely to the loaded ${windPrior.source} profile`
                : "assumed-wind: drift wind pinned loosely to the hand-set sitch wind (an assumption, not a measurement)",
            notes: windMeasured
                ? "MEASURED-wind reconstruction: the same model with its drift wind softly anchored "
                    + `to the loaded winds aloft${windDesc} (kept loose — a sonde can be 200+ mi and 12 h away). `
                    + "Compare its residual and inferred profile against the free fit."
                : "SITCH-wind reconstruction: the same model with its drift wind softly anchored to the "
                    + `sitch's hand-set wind${windDesc}. That wind is an ASSUMPTION, not a measurement, so `
                    + "treat this as \"what a balloon would look like IF the wind is as set\" — the free fit, "
                    + "which infers the wind the sightlines actually require, is the stronger evidence.",
        }));
    }

    // 5b. Quadcopter (multirotor drone) physics model — a hover-capable
    //     near-field object. Its range is capped at 20 km, so far-field
    //     scenes give a poor (correctly implausible) fit. Degrade gracefully.
    if (quad && quad.positions) {
        const track = quad.positions;
        const range0 = Math.hypot(track[0] - S[0], track[1] - S[1], track[2] - S[2]);
        const solved = quad.params.solved || {};
        const quadMetrics = trackMetrics(
            datasetForSolvedModelWind(dataset, track, solved, "quadcopter"), track);
        const T = (dataset.n - 1) / dataset.fps;
        const peakSpeed = Math.max(Math.abs(solved.speed || 0),
            Math.abs((solved.speed || 0) + (solved.accel || 0) * T));
        // Side-aware: zero air-relative speed is passive drift and is not a
        // capability violation; speed MAX, range extremes, and climb extremes are.
        const quadSplit = splitBoundPins(quad.params.pinned,
            (p) => (p.name === "initialRange")
                || (p.name === "speed" && p.side === "hi")
                || ["accel", "turnRate", "turnAccel", "climb", "windE", "windN"].includes(p.name),
            (p) => p.name === "speed" ? "speedEnvelope" : p.name);
        // Acceleration can drive the derived speed beyond the model envelope
        // even when the initial-speed parameter itself is not pinned.
        if (peakSpeed > 60 * 1.001) {
            quadSplit.active.set("speedEnvelope", "derived speed (above max)");
            quadSplit.inactive.delete("speedEnvelope");
        }
        const quadPins = Array.from(quadSplit.active.values());
        const quadInactive = Array.from(quadSplit.inactive.values());
        const quadUnstable = Array.from(quadSplit.unstable.values());
        // Signed climb: a descent must be checked against maxDescent, not
        // Math.max(ascent, descent) — see classifyQuadcopter.
        const quadClass = classifyQuadcopter(peakSpeed, solved.climb || 0);
        const near = !quadPins.length && quadClass.compatible ? quadClass.model : null;
        list.push({
            key: "quadcopter",
            name: "Quadcopter",
            subtitle: physicsBoundSubtitle(
                near ? "Closest containing envelope: " + near.name + " (not an ID)"
                    : "Generic multirotor fit; no named catalog envelope contains the solved motion",
                quadPins, quadInactive, quadUnstable),
            color: "#5bb1c9",
            track,
            metricsFull: quadMetrics,
            errDeg: quad.params.errDeg,
            boundPinned: quadPins,
            boundInactive: quadInactive,
            optimizerWarnings: quadUnstable.map((w) => `inward bound probe improved ${w}`),
            params: {
                range: range0,
                speed: solved.speed,
                peakSpeed,
                climb: solved.climb,
                windE: solved.windE,
                windN: solved.windN,
                closest: near ? near.name : null,
                windPolicy: "wind fitted by this model",
                // Nothing wires a wind prior into this model, so its calm-wind
                // fallback is ALWAYS the active branch — worth showing.
                priors: quad.params.priors,
                errFloor,
            },
            notes: "Hover-capable multirotor kinematics (bounded/penalized air-relative speed, climb and turn rate) "
                + "fit to the sightlines"
                + (quadPins.length ? "; the solve rammed the model's own limits (" + quadPins.join(", ")
                    + ") — this generic multirotor test is boundary-limited."
                    : (near ? "; closest common model by envelope: " + near.name + " (not an identification)." : ".")),
        });
    } else {
        list.push({
            key: "quadcopter",
            name: "Quadcopter",
            subtitle: "Multirotor model unavailable",
            color: "#5bb1c9",
            track: null,
            metricsFull: null,
            errDeg: NaN,
            params: {},
            notes: "Fit failed — no plausible multirotor trajectory converged "
                + "(e.g. the object is too far or too fast for a drone).",
        });
    }

    // 5c. Drone as CONTROL INPUTS — the plausible-flight counterpart to the
    //     free multirotor above. Same object class, different question: not
    //     "is there ANY path inside the drone envelope that fits?" (almost
    //     always yes, which is why the free fit produced a 61-revolution
    //     corkscrew on Aguadilla) but "is there a path a drone is actually
    //     FLOWN along that fits?" — a few held inputs with occasional changes.
    //     Plausibility is priced in the control effort, so nothing is
    //     foreclosed: an aggressive manoeuvre is affordable if the sightlines
    //     genuinely demand it, and only motion that buys nothing is priced out.
    if (droneCtl && droneCtl.positions) {
        const track = droneCtl.positions;
        const m = droneCtl.model;
        const pv = droneCtl.solvedVector || [];
        const dm = trackMetrics(dataset, track);
        const range0 = Math.hypot(track[0] - S[0], track[1] - S[1], track[2] - S[2]);
        const headingTravel = m ? m.headingTravelDeg(pv) : NaN;
        // The comparison that makes this hypothesis mean something: how much
        // better the UNCONSTRAINED multirotor did. A small gap says an ordinary
        // flight explains the sightlines as well as any contortion; a large one
        // says they demand motion outside ordinary drone flight, which is a
        // finding rather than something to hide behind a contorted "fit".
        const freeErr = (quad && quad.params && Number.isFinite(quad.params.errDeg))
            ? quad.params.errDeg : null;
        const ownErr = droneCtl.params.errDeg;
        const gap = freeErr !== null ? ownErr - freeErr : null;
        // Convergence + seed-clamp status (TA-09). The fast local fit remains
        // useful when it reaches the 400-iteration budget, but that is a
        // provisional iterate rather than demonstrated convergence, so retain the
        // tile and mark it incomplete/ineligible. Seed clamping is independently
        // incomplete because it means refinement began somewhere unintended.
        const dcOpt = droneCtl.params.optimizer || null;
        const dcClamp = m && typeof m.seedClamping === "function" ? m.seedClamping() : null;
        const droneWarnings = localFitCompletionWarnings(dcOpt);
        if (dcClamp) {
            droneWarnings.push(`seed clamped to bounds (${dcClamp.intervals} interval(s), worst ${dcClamp.worstExcessDeg.toFixed(0)}° over) — fit started off the intended seed`);
        }
        list.push({
            key: "droneControl",
            name: "Drone (flown inputs)",
            subtitle: m ? m.describe(pv) : "Control-input fit",
            color: "#7fc4d0",
            track,
            metricsFull: dm,
            errDeg: ownErr,
            optimizerWarnings: droneWarnings,
            params: {
                range: range0,
                headingTravelDeg: headingTravel,
                knots: m ? m.K : DRONE_CONTROL_KNOTS,
                freeModelErrDeg: freeErr,
                plausibleVsPossibleGapDeg: gap,
                priors: droneCtl.params.priors,
                optimizer: dcOpt,
                seedClamping: dcClamp,
                errFloor,
            },
            notes: (m ? `Fitted as the control inputs a drone would be flown with — ${m.describe(pv)}. ` : "")
                + "Seeded from the best geometric path (Kalman smoother or least-manoeuvring track), "
                + "inverted into the speed, heading and climb history needed to fly it, then refined "
                + "against the sightlines. "
                + "Holding an input costs nothing; changing one costs, so an ordinary flight is free "
                + "and only motion that buys no residual is priced out. Nothing is forbidden — an "
                + "aggressive manoeuvre remains reachable if the sightlines require it.\n\n"
                + (Number.isFinite(headingTravel)
                    ? `Total heading change over the clip: ${headingTravel.toFixed(0)}°`
                        + (headingTravel > 720 ? ` (${(headingTravel / 360).toFixed(1)} revolutions — unusual for a deliberate flight).` : ".")
                    : "")
                + (gap !== null
                    ? ` The unconstrained multirotor reaches ${freeErr.toFixed(3)}°, so an ordinary flight `
                        + (gap <= 0
                            ? "matches or beats it — the sightlines need no unusual motion."
                            : `costs ${gap.toFixed(3)}° more. Compare that against the scene's own `
                                + `${Number.isFinite(errFloor) ? errFloor.toFixed(2) : "?"}° reference before reading it as significant.`)
                    : "")
                + (dcOpt
                    ? `\n\nLocal refinement: ${dcOpt.iterations} Nelder-Mead iteration(s), `
                        + (dcOpt.stopReason === "iteration_limit"
                            ? "stopped at the iteration budget before convergence — the path is retained as a provisional result and marked optimizer-incomplete."
                            : "converged to tolerance.")
                        + (dcClamp ? " NOTE: the seed was clamped to its bounds, so the fit began off the intended seed — read this tile with caution." : "")
                    : ""),
        });
    }

    // 6. Ground object — a stationary light pinned to the LOCAL SURFACE height
    //    (terrain where loaded, sea level over ocean — localGroundZ), not raw
    //    ENU z=0: over land a z=0 pin sits below the terrain and was wrongly
    //    auto-flagged Underground. Always runs; cheap closed-form fit.
    if (localGroundZ) {
        const groundZ0 = localGroundZ(dataset, originLat, originLon);
        const ground = fitGroundPoint(dataset, groundZ0);
        list.push({
            key: "ground",
            name: "Ground Object",
            subtitle: "A fixed light on the surface",
            color: "#8a6f4a",
            track: ground.track,
            metricsFull: trackMetrics(groundMetricDataset, ground.track),
            errDeg: ground.errDeg,
            params: {distance: ground.distance, groundZ: groundZ0, motionFrame: "ground"},
            notes: "A stationary light on the local surface; high LOS error means the sightlines don't converge on a ground point.",
        });
    }

    // 7. Fixed point in space — a stationary object at an unknown location, or a
    //    fixed (parallax-free / astronomical) direction if very distant. Cheap;
    //    gated only so the user can hide it (default on).
    if (aoFixedPoint) {
        const fixedPt = fitFixedPoint(dataset, {});
        const fixedDir = fitFixedDirection(dataset);
        // A stationary object is either a finite point (sightlines converge on
        // it) or — if the fixed-DIRECTION fit is as good — an object so distant
        // the sightlines stay parallel: a "fixed point in the sky" like the Moon
        // or a star, effectively at infinity. Draw the latter as parallel rays,
        // not a converging point.
        const atInfinity = fixedDir.errDeg <= fixedPt.errDeg;
        list.push({
            key: "fixedPoint",
            name: atInfinity ? "Fixed Point in the Sky" : "Stationary Point in Space",
            subtitle: atInfinity ? "Distant light, effectively at infinity (e.g. the Moon)"
                                 : "Stationary object at a fixed location",
            color: "#9aa0a8",
            track: fixedPt.track,
            atInfinity,
            identity: atInfinity,   // a point at infinity has no finite traverse to apply
            metricsFull: trackMetrics(dataset, fixedPt.track),
            errDeg: Math.min(fixedPt.errDeg, fixedDir.errDeg),
            params: {distance: fixedPt.distance, dirErrDeg: fixedDir.errDeg},
            notes: atInfinity
                ? "A fixed point in the sky — a light so far the sightlines stay parallel (like the Moon or a star). The LOS error says whether one fixed direction explains the sightlines."
                : "A single stationary point in space; the LOS error says whether the object could be sitting still at one location.",
        });
    }

    // 7b. Satellite (LEO pass) — a real catalogued object propagated by SGP4,
    //     the best match out of the whole LEO catalogue for the sitch's date.
    if (satellite && satellite.best && dateForDatasetFrame) {
        const b = satellite.best;
        const track = satelliteTrackENU(b.satrec, dataset.n, dateForDatasetFrame, originLat, originLon);
        const midF = Math.floor(dataset.n / 2);
        const satEcefMid = satelliteECEF(b.satrec, dateForDatasetFrame(midF));
        const sunlit = satEcefMid ? satelliteSunlit(satEcefMid, dateForDatasetFrame(midF)) : null;
        const altKm = satEcefMid ? Math.round((satEcefMid.length() - 6371000) / 1000) : null;
        list.push({
            key: "satellite",
            name: "Satellite: " + b.name,
            subtitle: `Best LEO pass of ${satellite.loaded} checked`,
            color: "#6fd3c9",
            track,
            identity: true,   // an identification, not a selectable traverse method
            metricsFull: trackMetrics(dataset, track),
            errDeg: b.errDeg,
            params: {satellite: b.name, satnum: b.satnum, offsetDeg: b.errDeg, sunlit,
                altitudeKm: altKm, loaded: satellite.loaded},
            notes: `${b.name} passes ${b.errDeg.toFixed(2)}° from the sightlines`
                + (sunlit === false ? ", but is in Earth's shadow (not sunlit)"
                    : sunlit ? " and is sunlit" : "") + ".",
        });
    }

    // ---- Scene-coupled hypotheses ----------------------------------------
    // Sections 8 and 9 (astronomical catalogue searches) and the user's live
    // LOS-fit method nodes need the node graph, so they live in
    // AnalyzeTraverse.js and are spliced in here, where they used to be.
    if (extraHypotheses) {
        for (const h of extraHypotheses({
            dataset, originLat, originLon, sweep, globalFrame, dateForDatasetFrame,
        })) {
            if (h) list.push(h);
        }
    }


    // ---- Curve-fit polynomial-order sweep tiles ---------------------------
    // Each fitting strategy is swept over polynomial order and every order gets
    // its own tile. The sitch's single shared "MC Polynomial Order" control
    // (mcOrder) is almost always left at its default 1 — where the curve is a
    // straight line in time, i.e. constant velocity — so without the sweep the
    // Monte Carlo tiles were near-duplicates of the constant-velocity fit and
    // the effect of order was invisible.
    //
    // Swept here rather than read off the live CNodeLOSFitMonteCarlo nodes (as
    // the other Global Fit methods are), because driving them would mean
    // mutating that shared GUI value once per order and firing its change
    // handlers. Every strategy is still reproducible — the Monte Carlo pair via
    // a fixed random seed, the alternating fit because it uses no randomness —
    // and "Use exact" installs the reviewed trajectory via applyContext below.
    //
    // READ THESE AS A METHOD DIAGNOSTIC, NOT A RANKING. A higher-order curve can
    // always hug the sightlines more closely simply because it bends more, so a
    // low residual high in the sweep is arithmetic rather than evidence about
    // the object. Measured on a real sitch, one strategy beat another on
    // residual at every order while being FURTHER from the truth track at every
    // order. What the sweep genuinely shows is how much curvature the
    // sightlines admit, and where extra order stops buying anything.
    //
    // The fits themselves run in runTraverseAnalysis (far too slow to do
    // synchronously here — see sweepPolynomialOrders); this only turns the
    // finished results into tiles.
    {
        const mcTrials = mcSweep?.numTrials;
        for (const {variant, order, result: res} of (mcSweep?.results ?? [])) {
            {
                const track = Float64Array.from(res.positions);
                const m = trackMetrics(dataset, track);
                const errDeg = meanAngularError(dataset, track) * 180 / Math.PI;
                const nonPhysical = !isFinite(m.airSpeed.mean)
                    || m.airSpeed.mean / KNOTS_TO_MS > 20000 || !(m.gLoad.max < 2000);
                const ranges = new Float64Array(dataset.n);
                for (let f = 0; f < dataset.n; f++) {
                    ranges[f] = Math.hypot(track[f * 3] - S[f * 3],
                        track[f * 3 + 1] - S[f * 3 + 1], track[f * 3 + 2] - S[f * 3 + 2]);
                }
                const sortedR = Array.from(ranges).sort((a, b) => a - b);
                // CV-family conditioning: the MC pair samples only near the
                // CV seed and the alternating fit seeds from it, so all three
                // inherit the linear family's range degeneracy. The caution
                // sentence is rank-neutral (notes only).
                const sweepConditioning = assessLinearFitConditioning(dataset, {positions: track});
                const sweepCollapseNote = !sweepConditioning.collapse ? ""
                    : sweepConditioning.collapseReason === "near-camera-weak-geometry"
                        ? " CAUTION: near-camera result under poor CV-family "
                            + "conditioning — high artifact risk; treat its range "
                            + "and speed as unreliable."
                        : " CAUTION: this fit has collapsed onto the sensor path — "
                            + "its range and speed are artifacts, not measurements.";
                list.push({
                    key: variant.key,
                    linearConditioning: sweepConditioning,
                    name: `${variant.name} (order ${order})`,
                    subtitle: `${ORDER_NAMES[order] ?? ("order " + order)} — ${variant.flavour}`
                        + (variant.key === "gfPolyALS" ? "" : ", fixed seed"),
                    color: variant.color,
                    track, metricsFull: m, errDeg, nonPhysical,
                    params: {
                        range: sortedR[Math.floor(dataset.n / 2)],
                        mcOrder: order,
                        // The alternating fit doesn't sample, so the trial count
                        // and LOS-uncertainty settings don't apply to it.
                        ...(variant.key === "gfPolyALS" ? {} : {
                            mcTrials,
                            mcLOSUncertaintyDeg: mcSweep?.losUncertaintyDeg,
                        }),
                    },
                    notes: (variant.key === "gfPolyALS"
                        ? `A curve of degree ${order} (${ORDER_NAMES[order] ?? "higher order"}) fitted to `
                            + "the sightlines by repeated best-fit: guess how far away the object was on each "
                            + "sightline, draw the best curve through those points, slide each point along its "
                            + "own sightline to sit nearest that curve, and repeat. No random guessing, so it "
                            + "gives the same answer every time. Its distances are free to move well away from "
                            + "the constant-velocity starting guess, unlike the Monte Carlo fits."
                        : `Monte-Carlo curve fit of degree ${order} `
                            + `(${ORDER_NAMES[order] ?? "higher order"}) to the sightlines, `
                            + `${mcTrials ?? 500} random trials at a fixed seed. Its distances are only `
                            + "ever sampled within 0.9x to 1.1x of the constant-velocity fit"
                            + (Number.isFinite(mcSweep?.seedMedian)
                                ? ` (median ${(mcSweep.seedMedian / METERS_PER_NM).toFixed(2)} NM)`
                                : "")
                            + ", so it cannot propose a much nearer or further object than that fit "
                            + "already found.")
                        + " "
                        + (order === 1
                            ? "Degree 1 is a straight line in time — a constant-speed, constant-direction path — "
                                + "so this tile should closely match the constant-velocity fit."
                            : "A higher degree can always hug the sightlines more closely, simply because it has "
                                + "more freedom to bend, so a lower error here is NOT by itself proof of a better "
                                + "answer — in testing, higher degrees sometimes matched the sightlines better "
                                + "while drifting further from the real path. Compare against the lower degrees: "
                                + "a large improvement suggests the sightlines genuinely require a curved path, a "
                                + "small one suggests the extra freedom is just absorbing noise. Note also that a "
                                + `degree-${order} curve can only change direction about ${Math.max(1, Math.floor(order / 2))} `
                                + "time(s) across the whole clip.")
                        + " Shown as a fitting-method diagnostic, not an independent object hypothesis."
                        + sweepCollapseNote,
                });
            }
        }
    }

    // Ground Vehicle — where the sightlines meet a curved constant-elevation shell at the
    // local terrain height. A moving ground point, distinct from the stationary
    // Ground Object. Offered when the analysis is constrained to on-ground
    // solutions; only meaningful if most sightlines actually reach the ground.
    if (groundMode === "On the ground" && localGroundZ) {
        const groundZ = localGroundZ(dataset, originLat, originLon);
        const gv = fitGroundVehicle(dataset, groundZ);
        if (gv.fracValid >= 0.98) {
            const track = gv.track;
            list.push({
                key: "groundVehicle",
                name: "Ground Vehicle",
                subtitle: "A vehicle moving on the surface",
                color: "#9c7a4a",
                track,
                metricsFull: trackMetrics(groundMetricDataset, track),
                errDeg: meanAngularError(dataset, track) * 180 / Math.PI,
                params: {groundZ, fracValid: gv.fracValid, errFloor, motionFrame: "ground"},
                notes: "The moving point where each sightline meets the ground. A high implied speed means "
                    + "no ordinary ground vehicle can be the object.",
            });
        } else {
            list.push({
                key: "groundVehicle",
                name: "Ground Vehicle",
                subtitle: "A vehicle moving on the surface",
                color: "#9c7a4a",
                track: null, metricsFull: null, errDeg: NaN,
                params: {fracValid: gv.fracValid},
                notes: `Only ${(100 * gv.fracValid).toFixed(0)}% of sightlines reach the ground surface. `
                    + "A track made by holding the last intersection through invalid frames would be artificial, "
                    + "so this candidate is rejected.",
            });
        }
    }

    // Ground-contact / underground flagging. In EVERY mode, reject candidates
    // that pass underground (never a valid solution). In a constrained mode,
    // additionally flag candidates that don't meet the requested ground
    // contact. Only near-field physical tracks are tested — not points at
    // infinity, astronomical bodies, or satellite identifications.
    {
        const mode = groundMode;
        for (const h of list) {
            if (!h.track || h.atInfinity || h.identity) continue;
            if (h.params && (h.params.object !== undefined || h.params.satellite !== undefined)) continue;
            const stats = trackGroundStats(h.track, h.track.length / 3, originLat, originLon, signedAGL);
            if (!stats) continue;
            h.groundStats = stats;
            // Even ground-native solvers use an idealized curved shell sampled
            // from one terrain point. Validate them against the actual terrain;
            // otherwise a shell can pass through a ridge and still be promoted.
            if (stats.minAGL < -UNDERGROUND_TOL && stats.fracBelow >= 0.05) {
                h.underground = {depth: -stats.minAGL, frac: stats.fracBelow};
                // The tile draws the LOCAL terrain under this track, so the
                // burial is visible even where sloped ground sits above the
                // flat area-minimum plane.
                h.groundTrace = stats.trace;
            }
            const violation = groundContactViolation(stats, mode);
            if (violation) h.groundMismatch = {mode, reason: violation};
        }
    }

    // Metadata needed to install the exact reviewed ENU trajectory into the
    // live scene without re-running a different solver.
    for (const h of list) {
        if (h.track) {
            h.applyContext = {
                originLat,
                originLon,
                frame0: dataset.frame0 ?? 0,
            };
        }
    }
    return list;
}
