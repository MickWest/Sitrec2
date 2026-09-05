/**
 * BotBenchRunner.js — run the shipping traverse analysis over one ingested file.
 *
 * The fits are TraverseBattery's, which is the same code the "Analyze Traverse
 * Methods..." button runs, so a change to the analysis shows up in these
 * numbers. What differs is the ENVIRONMENT, and every difference is a deliberate
 * consequence of there being no loaded scene:
 *
 *   flat terrain          A BOT scenario is generated on a flat plane, so the
 *                         probes are flatTerrainProbes at the site elevation.
 *                         An FMV file gets sea level, which is right over water
 *                         and wrong inland — recorded on the row, not hidden.
 *   no wind-pinned fit    There is no wind field to pin to. The FREE balloon fit
 *                         still runs and infers its own wind; only the
 *                         "using existing wind" variant is absent.
 *   no scene hypotheses   No astronomy sweep, no satellite catalogue, no live
 *                         LOS-fit method nodes. These are listed in
 *                         ABSENT_HYPOTHESES and printed with every result.
 *   fixed range anchor    The live analysis anchors its range bracket on the
 *                         "Tgt Start Dist" slider, which a user has already
 *                         nudged toward the answer. A bulk run has no such
 *                         knowledge and must not acquire any, so ONE anchor is
 *                         used for every file in the run (see the note on
 *                         anchorM below). This is the same discipline
 *                         benchmarks/botbench/lib/verdictRunner.js applies.
 *
 * Truth, when the file carries it, is attached AFTER the hypotheses are built
 * and is used only for scoring. Nothing that reaches buildHypotheses is derived
 * from it.
 */

import {SWEEP_VARIANTS} from "../TraverseBattery";
import {botBenchRangeLimits, cacheableBotBenchBattery, DEFAULT_ANCHOR_M,
    fitBotBenchRecord, SPEED_TARGET_MS, validateBotBenchRecord} from "./BotBenchFit";
export {DEFAULT_ANCHOR_M} from "./BotBenchFit";
import {
    buildTraverseReportHTML, traverseReportSeries,
} from "../AnalyzeTraverse";
import {
    compareTrackToTruth, meanAngularError, KNOTS_TO_MS, METERS_PER_NM,
} from "../TraverseAnalysis";
import {rankAllHypotheses} from "../TraverseRanking";
import {mundanenessCost} from "../TraverseMundaneness";
import {BOT_DEFAULT_EPOCH_ISO, botENUToLLA} from "../TrackFiles/CTrackFileBOT";
// RAYLEIGH_MEAN / RAYLEIGH_SD live in BotBenchIngest, beside assessSourceQuality:
// they describe the SOURCE's declared pointing error, and the notes builder
// needs the same figures. See the comment there for why the constant is
// sqrt(pi/2) and not 1 or sqrt(2).
import {describeMeasuredPlatform, RAYLEIGH_MEAN, RAYLEIGH_SD} from "./BotBenchIngest";

// The curve-fitting strategies swept over polynomial order. TraverseHypotheses
// documents these as a METHOD DIAGNOSTIC and not a ranking — "a higher-order
// curve can always hug the sightlines more closely simply because it bends
// more" — but nothing enforces that downstream, so the flag is computed here
// and reported. A curve fitted through the sightlines carries no independent
// range information: measured over a bulk run, all five polynomial orders in a
// file returned the SAME separation from truth to four significant figures,
// which is the signature of a family whose range comes from the anchor rather
// than from the data.
const DIAGNOSTIC_FAMILY_KEYS = new Set(SWEEP_VARIANTS.map((v) => v.key));

/**
 * What a bulk run cannot produce, named as data so the report and the table can
 * state it rather than leave a reader to infer it from silence.
 */
export const ABSENT_HYPOTHESES = [
    // The wind-pinned balloon fit is NOT listed here. It is absent from a bulk
    // run for the same reason it is absent from a live run with no wind loaded
    // — nothing supplied a wind to pin it to — and runTraverseBattery now says
    // so per run, with the reason. Naming it in both places would state one
    // fact twice and let the two copies drift apart.
    "Drone (flown control inputs) is fitted, but the interactive scene's LOS-fit methods are not",
    "Astronomical (current time / best time)",
    "Catalogued satellite pass",
    "independent balloon wind evidence",
];

/**
 * Run the analysis on one ingested record.
 *
 * @param record  from BotBenchIngest.ingestBotBenchEntry
 * @param options {anchorM, solutionFamilies, mcOrderSweep, onProgress, isCancelled}
 * @returns a results object of the same shape runTraverseAnalysis returns, so
 *          showTraverseGallery(results) opens it with no re-computation.
 */
export async function runBotBenchAnalysis(record, {
    anchorM = DEFAULT_ANCHOR_M,
    solutionFamilies = false,
    mcOrderSweep = false,
    onProgress = null,
    isCancelled = () => false,
    // A battery output restored from the folder's result cache. Supplying it
    // SKIPS THE FITTING and nothing else: every line below the battery call
    // runs exactly as it does on a fresh analysis, so a cached row is built by
    // the same code that built the original rather than by a second code path
    // reconstructing it. See cacheableBattery below for what has to be kept.
    battery: cachedBattery = null,
    // The wall time the ORIGINAL analysis took, when replaying from cache. The
    // row reports it, and a benchmark row that claimed 40 ms because the fit
    // was skipped would misreport the very thing it exists to measure.
    elapsedMs: cachedElapsedMs = null,
    // Worker fitting plus this call's result assembly, excluding queue wait.
    fitElapsedMs = 0,
} = {}) {
    const t0 = Date.now();
    const {dataset, originLat, originLon, groundZ} = record;

    validateBotBenchRecord(record);
    if (isCancelled()) throw new Error("cancelled");
    const {declaredMaxM, gridMaxM} = botBenchRangeLimits(record);
    if (declaredMaxM !== null && gridMaxM === null) {
        record.warnings.push(`The file declares MaxRange ${declaredMaxM} m, too small to space a `
            + `search grid inside. The default bracket was searched instead, and every candidate `
            + `is reported against the declared limit — expect them all to violate it.`);
    }
    const battery = cachedBattery ?? await fitBotBenchRecord(record, {
        anchorM, solutionFamilies, mcOrderSweep, onProgress, isCancelled,
    });
    const provenance = battery.provenance;

    const {hypotheses, sweep, resolvedRanges, fastProfile, slowProfile,
        slowOpts, aircraft, families, executiveAssessment, failures} = battery;

    // EXACTLY WHAT A CACHED RUN NEEDS, and deliberately a named subset rather
    // than the whole battery. runTraverseBattery also returns the physics
    // dataset, the fitted model objects and the raw per-model results, none of
    // which anything below reads — caching them would multiply the file size
    // and, worse, would mean storing class instances that cannot survive JSON.
    //
    // The same subset crosses the worker boundary and goes into the cache.
    //
    // These are LIVE REFERENCES, so by the time a caller serializes them the
    // post-processing below has written truthComparison, truthResidualDeg and
    // exceedsDeclaredMaxRange onto the hypothesis objects. That is harmless
    // rather than lucky: every one of those writes is an unconditional
    // overwrite computed from the record, and a cache entry is only reused when
    // the input hashes, the analysis options AND the app version all match — so
    // the replay recomputes the identical values over the top of them.
    const cacheableBattery = cacheableBotBenchBattery(battery);

    // The green ground plane in the 3D graphs. Flat plane, so this is exact
    // rather than sampled — no terrain can arrive later and move it.
    dataset.groundLevelM = groundZ;

    // --- Truth scoring, strictly after the fact -----------------------------
    const truth = record.truth && record.truth.usable ? record.truth : null;
    if (truth) {
        let validFrac = 0;
        for (let f = 0; f < dataset.n; f++) if (truth.valid[f]) validFrac++;
        validFrac /= Math.max(1, dataset.n);
        // The truth track's OWN LOS residual: what a perfect answer scores
        // against these rays, and therefore the real achievable floor. Only
        // meaningful when truth covers essentially the whole clip.
        const truthResidualDeg = validFrac > 0.99
            ? meanAngularError(dataset, truth.track, truth.valid) * 180 / Math.PI
            : NaN;
        for (const h of hypotheses) {
            if (!h.track) continue;
            h.truthComparison = h.atInfinity
                ? {comparable: false,
                    note: "direction-only hypothesis (at infinity); 3D separation is not meaningful"}
                : compareTrackToTruth(dataset, h.track, truth);
            if (Number.isFinite(truthResidualDeg)) h.truthResidualDeg = truthResidualDeg;
        }
    }

    // --- Declared-range compliance -----------------------------------------
    // The bracket cap above constrains the searches that take a range bound;
    // it cannot constrain the ones that do not, nor any track's range at later
    // frames. So measure it: which candidates actually end up beyond the
    // declared limit, and by how much. A violation is not suppressed — it is a
    // statement that this interpretation contradicts the file's own declared
    // measurement envelope, which is exactly what a reader needs to see.
    let maxRangeViolations = null;
    if (declaredMaxM !== null) {
        maxRangeViolations = [];
        for (const h of hypotheses) {
            if (!h.track) continue;
            // AT-INFINITY IS A VIOLATION, not an exemption. A star or planet
            // interpretation places the object beyond any finite range, so a
            // file declaring "the target is within X" contradicts it outright.
            // Skipping these let exactly the candidates furthest outside the
            // declared envelope pass unremarked.
            if (h.atInfinity) {
                maxRangeViolations.push({name: h.name, key: h.key, maxRangeM: Infinity,
                    atInfinity: true});
                h.exceedsDeclaredMaxRange = {declaredMaxM, maxRangeM: Infinity, atInfinity: true};
                continue;
            }
            let worst = 0;
            for (let f = 0; f < dataset.n; f++) {
                const b = f * 3;
                const r = Math.hypot(h.track[b] - dataset.S[b],
                    h.track[b + 1] - dataset.S[b + 1], h.track[b + 2] - dataset.S[b + 2]);
                if (Number.isFinite(r) && r > worst) worst = r;
            }
            if (worst > declaredMaxM) {
                maxRangeViolations.push({name: h.name, key: h.key, maxRangeM: worst});
                h.exceedsDeclaredMaxRange = {declaredMaxM, maxRangeM: worst};
            }
        }
    }

    // --- Direction truth ----------------------------------------------------
    // A celestial target has a bearing and no finite range, so there is no
    // positional truth to compare against and the All CSV's TruePosition triple
    // is blank by design. That is NOT the same as "no truth": the label sidecar
    // carries the answer as a per-frame unit vector. Scoring it needs a
    // different metric — the angle between each candidate's sensor->estimate
    // direction and the true bearing — and it is reported in degrees, never
    // mixed into the metre-valued separations, because they are not the same
    // quantity. Without this the one direction-only scenario in the set showed
    // an empty Truth cell, which reads as "not scored because we couldn't"
    // rather than "scored differently, because it is a different question".
    const directionScore = record.directionTruth
        ? scoreDirectionTruth(dataset, hypotheses, record.directionTruth) : null;

    const series = traverseReportSeries({
        dataset, sweep, resolvedRanges, hypotheses, slowProfile, slowOpts});

    const windText = record.meta?.windEstimate
        ? `sidecar analyst estimate: E ${record.meta.windEstimate.E.toFixed(1)}, `
            + `N ${record.meta.windEstimate.N.toFixed(1)} m/s`
            + (record.meta.windEstimate.sigmaMS != null
                ? ` (sigma ${record.meta.windEstimate.sigmaMS} m/s, `
                    + `${record.meta.windEstimate.provenance ?? "unstated"})` : "")
        : "zero / none supplied";

    const manifest = Object.freeze({
        inputFingerprint: null,
        situation: `BOTBench: ${record.label}`,
        frames: {start: 0, end: dataset.n - 1, count: dataset.n},
        timing: {sourceFps: dataset.fps, simSpeed: 1, physicalFps: dataset.fps},
        assumptions: {
            speedTargetKt: SPEED_TARGET_MS / KNOTS_TO_MS,
            windMode: record.meta?.windEstimate ? "Sidecar estimate" : "Zero wind",
            windSummary: windText,
            fittedWindModels: ["Sky Lantern / Balloon", "Quadcopter"],
            groundMode: "Airborne (any)",
            truthTrack: truth ? truth.label : null,
            constructedLOS: false,
            losSource: provenance.losSource,
            cameraHeading: null,
            measuredLOSAlternative: null,
            rangeUnobservable: !!battery.provenance.rangeUnobservable,
            sensorBaselineM: Number.isFinite(battery.provenance.sensorSpan)
                ? Math.round(battery.provenance.sensorSpan) : null,
            linearFitConditioning: battery.provenance.linearFitConditioning ?? null,
            // The two things a reader must not have to infer.
            surfaceModel: record.meta?.surfaceModel ?? null,
            rangeAnchorM: anchorM,
        },
        searchBounds: {
            userSpecified: false,
            constantAirRangeM: [resolvedRanges[0], resolvedRanges[resolvedRanges.length - 1]],
            constantAirSpeedMS: [sweep.speeds[0], sweep.speeds[sweep.speeds.length - 1]],
            aircraftRangeM: [battery.fitRangeMin, battery.fitRangeMax],
            constantAltitudeRangeM: [battery.caRangeMin, battery.caRangeMax],
            minimumAccelerationRangeM: [battery.plausRangeMin, battery.plausRangeMax],
        },
        solutionFamilies: families ? Array.from(families.entries()).map(([id, f]) => ({
            id, acceptDeg: f.accept, K: f.K, bestErrDeg: f.bestErrDeg,
            ladderLoM: f.ladderLoM, ladderHiM: f.ladderHiM,
            intervals: f.intervals.map((iv) => ({loM: iv.loM, hiM: iv.hiM, count: iv.count})),
            screenedCount: f.band.screenedCount, residualCount: f.band.residualCount,
            fitted: f.band.fitted, total: f.band.total,
            boundaryLimited: f.boundaryLimited,
            modelClippedLow: !!f.modelClippedLow, modelClippedHigh: !!f.modelClippedHigh,
            basinReseeded: f.basinCheck?.reseeded ?? [],
        })) : null,
        completeness: {
            constantAirBoundaryAxes: sweep.boundaryAxes,
            fastProfileBoundaryLimited: !!fastProfile.boundaryLimited,
            slowProfileBoundaryLimited: !!slowProfile.boundaryLimited,
            minimumAccelerationBoundaryLimited: !!battery.plausible?.boundaryLimited,
        },
        optimizers: {
            aircraftRuns: (aircraft?.runs ?? []).map((r) => ({
                seed: r.de?.seed, deGenerations: r.de?.generations,
                deEvaluations: r.de?.evaluations, deStopReason: r.de?.stopReason,
                polishIterations: r.polishIterations, polishStopReason: r.polishStopReason,
            })),
            lantern: battery.lantern?.params?.optimizer ?? null,
            quadcopter: battery.quad?.params?.optimizer ?? null,
        },
        checks: {
            stationary: true, astronomyAtTime: false, astronomyTimeSearch: false,
            satellite: false,
            failures: failures.map((f) => ({...f})),
        },
        absentHypotheses: ABSENT_HYPOTHESES,
        sourceQuality: record.quality,
        ingestWarnings: record.warnings.slice(),
        // Declared-range compliance, and the direction-truth score. Both live
        // here so the HTML report prints what the table shows — a report that
        // silently omits either would disagree with the row it came from.
        declaredMaxRangeM: declaredMaxM,
        maxRangeViolations: maxRangeViolations
            ? maxRangeViolations.map((v) => ({...v,
                maxRangeM: Number.isFinite(v.maxRangeM) ? v.maxRangeM : null})) : null,
        directionTruth: directionScore ? {
            label: directionScore.label,
            bestName: directionScore.best.name,
            bestMeanDeg: directionScore.best.meanDeg,
            perHypothesisDeg: directionScore.all.map((d) => ({name: d.name, meanDeg: d.meanDeg})),
        } : null,
        executive: executiveAssessment ? {
            code: executiveAssessment.code,
            headline: executiveAssessment.headline,
            gates: executiveAssessment.gates,
            notRun: executiveAssessment.notRun,
            notModelled: executiveAssessment.notModelled,
            classes: executiveAssessment.classes.map((c) => ({
                key: c.key, tested: c.tested, viable: c.viable, complete: c.complete,
                close: c.close, ordinary: c.ordinary, supported: c.supported,
                blocker: c.blocker, bestName: c.bestName, bestErrDeg: c.bestErrDeg,
            })),
        } : null,
    });

    const buildHtml = () => buildTraverseReportHTML({
        sitName: `BOTBench: ${record.label}`,
        dataset, windText, speedTarget: SPEED_TARGET_MS,
        sweep, fastProfile, slowProfile, aircraft,
        bestTrack: series.bestTrack, bestMetrics: series.bestMetrics,
        sweepBestMetrics: series.sweepBestMetrics, constAirPick: series.constAirPick,
        slowBestRow: series.slowBestRow, slowTrack: series.slowTrack,
        closeLoM: series.closeLoM, closeHiM: series.closeHiM,
        hypotheses, provenance: battery.provenance, failures, manifest,
        truth, terrainChangedDuringRun: false,
        executiveAssessment,
    });

    const results = {
        // The file's own local ENU frame and epoch. Carried because a candidate
        // track is only meaningful against them — see consistentTrackCSVs,
        // which is the one thing that turns a hypothesis back into geography.
        // botOrigin is in botENUToLLA's shape so that function can be handed it
        // verbatim, which is what keeps candidates in the same frame as the
        // scenario's own tracks.
        originLat, originLon, clipStartMs: record.clipStartMs ?? null,
        botOrigin: Array.isArray(record.meta?.originLLA) ? {
            latDeg: record.meta.originLLA[0],
            lonDeg: record.meta.originLLA[1],
            groundElevationMSL: record.meta.siteElevationMSL ?? 0,
        } : null,
        dataset, sweep, fastProfile, slowProfile, aircraft,
        best: sweep.best, bestMetrics: series.bestMetrics, slowBestRow: series.slowBestRow,
        hypotheses, families, truth,
        buildHtml, html: null,
        provenance: battery.provenance, failures, manifest,
        terrainChangedDuringRun: false,
        executiveAssessment,
        // Why the gallery's "Use exact result" is disabled for this result: the
        // track is in THIS FILE's local ENU frame at THIS FILE's epoch, and the
        // loaded sitch — whatever it happens to be — never saw this object.
        applyDisabledReason:
            `This result was computed from ${record.label}, not from the loaded sitch. `
            + `Its trajectory is in that file's own local frame and epoch, so applying it here `
            + `would install a track the current scene never observed. Load the file itself to `
            + `work with it.`,
        // Carried so the HTML report can state what the table already shows.
        // `truth` above is the POSITIONAL reference and is null here by design
        // for a direction-only target; without this field the report simply
        // lost the score.
        directionScore, directionTruth: record.directionTruth ?? null,
    };

    const elapsedMs = cachedElapsedMs ?? (fitElapsedMs + Date.now() - t0);
    return {
        results,
        row: summarizeRun(record, results, battery, elapsedMs,
            directionScore, {declaredMaxM, maxRangeViolations}),
        // Handed back so the caller can cache it. Nothing in the analysis reads
        // it again.
        battery: cacheableBattery,
        elapsedMs,
    };
}

/**
 * Score every candidate against a per-frame DIRECTION truth.
 *
 * Each candidate's track becomes a series of sensor->estimate bearings, and the
 * metric is the mean angle between those and the true bearing, in degrees. This
 * is the only comparison a direction-only target admits: it has no range, so
 * 3-D separation is undefined and a fitted range is meaningless — an
 * at-infinity hypothesis's helper track sits at an arbitrary distance along the
 * right ray and would score an arbitrary number of metres.
 *
 * Frames the sidecar marked out-of-FOV are excluded, as they are for positional
 * truth. Returns null if nothing could be compared.
 */
export function scoreDirectionTruth(dataset, hypotheses, directionTruth) {
    const {n, S} = dataset;
    const dir = directionTruth.dir;
    const valid = directionTruth.valid;
    const per = [];

    for (const h of hypotheses) {
        if (!h.track) continue;
        let sum = 0, count = 0;
        for (let f = 0; f < n; f++) {
            if (valid && !valid[f]) continue;
            const b = f * 3;
            let ex = h.track[b] - S[b], ey = h.track[b + 1] - S[b + 1], ez = h.track[b + 2] - S[b + 2];
            const el = Math.hypot(ex, ey, ez);
            // An estimate sitting ON the sensor has no direction at all. That is
            // the on-sensor collapse the BOT Bench contract scores as a defined
            // 180 degrees rather than dropping — dropping it silently rewards a
            // degenerate fit by shrinking its denominator.
            if (!(el > 1e-6)) { sum += 180; count++; continue; }
            ex /= el; ey /= el; ez /= el;
            const tl = Math.hypot(dir[b], dir[b + 1], dir[b + 2]);
            if (!(tl > 1e-9)) continue;
            const c = Math.max(-1, Math.min(1,
                (ex * dir[b] + ey * dir[b + 1] + ez * dir[b + 2]) / tl));
            sum += Math.acos(c) * 180 / Math.PI;
            count++;
        }
        if (!count) continue;
        const meanDeg = sum / count;
        // A DISTINCT property, not `truthComparison`. That name has a positional
        // contract across the ranking comparator, the gallery and the report —
        // it is expected to carry a metre-valued `score` — and putting a
        // degree-valued record there would have those readers compare degrees
        // against metres wherever they do not check `kind` first.
        h.directionTruthComparison = {
            comparable: true, framesUsed: count, meanDirectionErrorDeg: meanDeg,
            note: "direction-only truth: mean bearing error in degrees (no range to compare)",
        };
        per.push({name: h.name, key: h.key, meanDeg});
    }
    if (!per.length) return null;
    per.sort((a, b) => a.meanDeg - b.meanDeg);
    return {label: directionTruth.label, best: per[0], all: per};
}

/**
 * One table row's worth of a completed run: what the analysis concluded, how
 * well it fitted, and — where truth exists — whether it was right.
 */
export function summarizeRun(record, results, battery, elapsedMs, directionScore = null,
    rangeLimit = null) {
    // BLIND RANKING, and the `false` must be explicit.
    //
    // rankAllHypotheses sorts with the truth-AWARE comparator unless it is told
    // `useTruth === false` — an omitted option is not the same as a false one
    // (TraverseRanking.js: `opts.useTruth === false ? blind : aware`). Since the
    // truth comparisons are attached to the hypotheses just above, ranking
    // without this flag would let truth choose the "top interpretation" that is
    // then scored against that same truth. The number that came out of that was
    // not a measure of the analysis; it was a measure of truth agreeing with
    // itself, and it silently flattered every scenario carrying an answer key.
    //
    // The honest pair is reported instead: the top the analysis picked ON ITS
    // OWN, and separately the closest candidate any method produced
    // (bestSepM/bestName). The gap between them is how much the RANKING costs,
    // as distinct from how well the fits did.
    const ranked = rankAllHypotheses(results.hypotheses, {useTruth: false});
    const top = ranked.length ? ranked[0] : null;

    // The classes the executive assessment found viable, in its own words.
    const classes = results.executiveAssessment?.classes ?? [];
    const viable = classes.filter((c) => c.viable).map((c) => c.key);

    // HOW ORDINARY, in bulk. The gallery has shown this per tile since the
    // mundaneness score landed; the bench could not measure what the gallery
    // displayed, which made the score unfalsifiable at scale. Same function,
    // same dataset, so a row and a tile cannot disagree.
    //
    // TWO NUMBERS, AND THEY ARE DIFFERENT CLAIMS. `top` is how ordinary the
    // candidate we PICKED is. `mostOrdinary` is how ordinary the data ALLOWS
    // any candidate to be — which on a bearings-only problem is usually much
    // lower, because choosing a different range makes almost any motion
    // ordinary. Collapsing them to one column would hide exactly that.
    //
    // `mostOrdinary` is deliberately UNGATED. A residual gate needs a threshold
    // and no threshold here is calibrated yet, so the candidate's own residual
    // is reported beside its cost and the reader applies their own bar rather
    // than inheriting an invented one.
    // Both numbers use the SAME admission rule, and an at-infinity winner is
    // excluded from both. An astronomical hypothesis carries an artificial
    // finite helper track so the geometry has something to work with; scoring
    // that track would report a star as "consistent with an ordinary balloon",
    // which is a physical claim about an object the hypothesis says is not one.
    const scorable = (h) => !!h && !!h.track && !h.atInfinity && !!h.metricsFull;
    const topCost = top && scorable(top.h) ? mundanenessCost(results.dataset, top.h) : null;
    let mostOrdinary = null;
    for (const h of results.hypotheses) {
        if (!scorable(h)) continue;
        const c = mundanenessCost(results.dataset, h);
        if (!c) continue;
        if (!mostOrdinary || c.total < mostOrdinary.total) {
            mostOrdinary = {
                total: c.total, key: c.key, label: c.label, name: h.name,
                errDeg: Number.isFinite(h.errDeg) ? h.errDeg : null,
            };
        }
    }
    const mundaneness = (topCost || mostOrdinary) ? {
        top: topCost ? {
            total: topCost.total, key: topCost.key, label: topCost.label,
            sizeCost: topCost.sizeCost, speedCost: topCost.speedCost, gCost: topCost.gCost,
            // Recorded so a reader knows whether the size term had a lower bound
            // to work with at all — see impliedDiameter's `oneSided`.
            sizeOneSided: topCost.impliedM ? !!topCost.impliedM.oneSided : null,
        } : null,
        mostOrdinary,
    } : null;

    // Truth scoring. `relSep` — mean separation over mean truth range — is the
    // scale-free version, and it is the one the BOT Bench classifier protocol
    // treats as the action loss, so a 2 km scene and a 50 km scene compare.
    let truthScore = null;
    if (results.truth) {
        const tc = top && top.h.track && !top.h.atInfinity
            ? compareTrackToTruth(results.dataset, top.h.track, results.truth) : null;
        // The best any candidate managed, which is a different question from
        // whether the analysis PICKED it.
        let bestSepM = Infinity, bestName = null;
        for (const h of results.hypotheses) {
            const c = h.truthComparison;
            if (!c || !c.comparable || !Number.isFinite(c.score)) continue;
            if (c.score < bestSepM) { bestSepM = c.score; bestName = h.name; }
        }
        // Mean sensor-to-target range, taken from whichever comparison carries
        // it. It is a property of TRUTH, not of any candidate, so every
        // comparable hypothesis reports the same value — which is what lets
        // bestSepM be turned into a relative figure alongside topRelSep.
        const meanTruthRangeM = results.hypotheses
            .map((h) => h.truthComparison)
            .find((c) => c && Number.isFinite(c.meanTruthRange) && c.meanTruthRange > 0)
            ?.meanTruthRange ?? null;
        truthScore = {
            topSepM: tc && tc.comparable && Number.isFinite(tc.score) ? tc.score : null,
            topRelSep: tc && tc.comparable && Number.isFinite(tc.score)
                && Number.isFinite(tc.meanTruthRange) && tc.meanTruthRange > 0
                ? tc.score / tc.meanTruthRange : null,
            bestSepM: Number.isFinite(bestSepM) ? bestSepM : null,
            bestName,
            // The ORACLE ceiling, and it must be read as one: truth picked this
            // winner. The gap between it and topRelSep is what the RANKING
            // costs, which is a different quantity from what the FITS achieved
            // and the two were previously indistinguishable in the report.
            bestRelSep: Number.isFinite(bestSepM) && meanTruthRangeM
                ? bestSepM / meanTruthRangeM : null,
            meanTruthRangeM,
            truthResidualDeg: results.hypotheses.find((h) => Number.isFinite(h.truthResidualDeg))
                ?.truthResidualDeg ?? null,
            label: results.truth.label,
        };
    }

    // SEPARABILITY. Whether the residual could legitimately have chosen the top
    // candidate at all, which is prior to whether it chose well. Truth-free: it
    // uses only the DECLARED pointing sigma and the candidates' own residuals,
    // so it computes on a challenge file exactly as it does on an answers file.
    //
    // Correlated (operator wobble) declarations are excluded rather than
    // approximated. Their sigma is a deadband amplitude, not a per-axis
    // standard deviation, so the Rayleigh relation does not hold and a floor
    // computed from it would be wrong in an unstated direction.
    let separability = null;
    {
        const q = record.quality ?? {};
        const sigma = q.declaredLosSigmaDeg;
        const errs = results.hypotheses.map((h) => h.errDeg)
            .filter(Number.isFinite).sort((a, b) => a - b);
        if (Number.isFinite(sigma) && sigma > 0 && !q.losErrorCorrelated && errs.length) {
            const floorDeg = sigma * RAYLEIGH_MEAN;
            const n = Number.isFinite(q.frames) && q.frames > 1 ? q.frames : null;
            separability = {
                floorDeg,
                // A residual MEAN over n frames has this sampling error. Two
                // candidates closer together than about this are not being
                // separated by the data; they are being separated by which
                // noise realisation the clip happens to carry.
                seDeg: n ? sigma * RAYLEIGH_SD / Math.sqrt(n) : null,
                // Candidates that beat what a perfect track scores. Every one
                // of them is fitting the pointing noise, by definition.
                belowFloor: errs.filter((e) => e < floorDeg).length,
                candidates: errs.length,
                // How far the winner led the runner-up. Reported in degrees and
                // as a multiple of the sampling error above.
                marginDeg: errs.length > 1 ? errs[1] - errs[0] : null,
                // The residual spread across the leading candidates, against
                // the declared sigma. A spread well under 1 sigma means the
                // whole ranking decision happened inside the noise.
                leadSpreadDeg: errs.length > 1
                    ? errs[Math.min(4, errs.length - 1)] - errs[0] : null,
                topBelowFloor: Number.isFinite(top?.h?.errDeg) && top.h.errDeg < floorDeg,
            };
        }
    }

    // GEOMETRY PROBE. The Minimum Acceleration fit's stage-1 gate is a cheap
    // extraction ATTEMPT: it either pinned the range from pure smoothness
    // geometry (both valley walls proven, narrow width, no floor shaping) or
    // fell back to the speed prior. That verdict — an actual attempt, not a
    // pre-fit heuristic like CV rcond — is the direct answer to "could a
    // path be extracted from geometry alone", and it rides every row for
    // free because the battery already ran the fit.
    const plausibleH = results.hypotheses.find((h) => h.key === "plausible");
    const probe = plausibleH ? {
        // The PRE-speed-sanity verdict: did pure geometry pin a range? A
        // decisive valley whose implied speed exceeded 2x the target still
        // reads pinned here — the fit declined to trust it (speedOverride),
        // which is a different statement from "geometry was ambiguous".
        geometryPinned: plausibleH.params?.geometryDecisive === 1,
        speedOverride: plausibleH.params?.speedSanityOverride === 1,
        rangeM: Number.isFinite(plausibleH.params?.range)
            ? plausibleH.params.range : null,
        decisiveness: Number.isFinite(plausibleH.params?.decisiveness)
            ? plausibleH.params.decisiveness : null,
        valleyWidthLog: Number.isFinite(plausibleH.params?.valleyWidthLog)
            ? plausibleH.params.valleyWidthLog : null,
        boundaryLimited: !!plausibleH.params?.boundaryLimited,
        floorShaped: plausibleH.params?.valleyFloorShaped === 1,
        errDeg: Number.isFinite(plausibleH.errDeg) ? plausibleH.errDeg : null,
    } : null;

    return {
        label: record.label,
        // Human-meaningful scenario name from an answer-key sidecar (null on
        // challenge files); the table shows it in place of the opaque filename.
        displayName: record.meta?.descriptiveName ?? null,
        kind: record.kind,
        // WHAT THE ANSWER ACTUALLY WAS, in words — "hover (drone_px4_36634f3e)"
        // against a platform that "orbits the target, 70 m/s, 3000 m". Scoring
        // a verdict needs this and nothing in the table used to carry it, so a
        // reader had to decode a filename to tell a rising balloon from a
        // hovering quadcopter. Present only where a label sidecar declared it.
        targetDescription: record.labels?.targetDescription ?? null,
        eventDescription: record.labels?.eventDescription ?? null,
        anomalousDeclared: record.labels?.anomalous ?? null,
        // Declared where a sidecar says so, else measured from the sensor path,
        // so this column is populated on every file including FMV.
        platformDescription: record.labels?.platformDescription
            ?? describeMeasuredPlatform(record.quality),
        platformMeasured: !record.labels?.platformDescription,
        probe,
        trackId: record.meta?.trackId ?? null,
        // Reported on the row because the ingest's comment promises it is: the
        // conversion reads the app's global radii, so the same file can convert
        // differently depending on what sitch is loaded.
        earthModel: record.meta?.earthModel ?? null,
        surfaceModel: record.meta?.surfaceModel ?? null,
        quality: record.quality,
        warnings: record.warnings,
        verdictCode: results.executiveAssessment?.code ?? null,
        headline: results.executiveAssessment?.headline ?? null,
        viableClasses: viable,
        mundaneness,
        top: top ? {
            key: top.h.key, name: top.h.name,
            errDeg: Number.isFinite(top.h.errDeg) ? top.h.errDeg : null,
            tier: top.r.label,
            rangeStartM: Number.isFinite(top.h.params?.startDist) ? top.h.params.startDist
                : (Number.isFinite(top.h.params?.range) ? top.h.params.range
                    : (Number.isFinite(top.h.params?.solved?.initialRange)
                        ? top.h.params.solved.initialRange : null)),
            speedKt: Number.isFinite(top.h.metricsFull?.airSpeed?.mean)
                ? top.h.metricsFull.airSpeed.mean / KNOTS_TO_MS : null,
            speedMinKt: Number.isFinite(top.h.metricsFull?.airSpeed?.min)
                ? top.h.metricsFull.airSpeed.min / KNOTS_TO_MS : null,
            speedMaxKt: Number.isFinite(top.h.metricsFull?.airSpeed?.max)
                ? top.h.metricsFull.airSpeed.max / KNOTS_TO_MS : null,
            // Mean geodetic altitude of the fitted track (metres); the table
            // shows it in feet.
            altMeanM: Number.isFinite(top.h.metricsFull?.altitude?.mean)
                ? top.h.metricsFull.altitude.mean : null,
        } : null,
        // The winner came from a family TraverseHypotheses documents as a
        // method diagnostic rather than a ranking. Worth a flag of its own: a
        // curve fitted through the sightlines will happily post the lowest
        // residual in the run while its range sits wherever the anchor put it.
        topRangeBlind: !!(top && DIAGNOSTIC_FAMILY_KEYS.has(top.h.key)),
        separability,
        candidates: results.hypotheses.length,
        rangeUnobservable: !!results.provenance.rangeUnobservable,
        failures: results.failures.map((f) => f.method),
        truthScore,
        // Scored in DEGREES of bearing error, and kept in its own field so no
        // reader can average it together with the metre-valued truthScore.
        directionScore: directionScore ? {
            label: directionScore.label,
            // `top` is a RANKED ITEM ({h, r}), so the hypothesis is top.h — the
            // same shape every other field here reads through. Matching on
            // top.key instead silently found nothing and reported the top
            // bearing error as blank while the best-candidate figure worked,
            // which looked like "the top could not be scored".
            topDeg: directionScore.all.find((d) => d.key === top?.h?.key
                && d.name === top?.h?.name)?.meanDeg ?? null,
            bestDeg: directionScore.best.meanDeg,
            bestName: directionScore.best.name,
        } : null,
        declaredMaxRangeM: rangeLimit?.declaredMaxM ?? null,
        maxRangeViolations: rangeLimit?.maxRangeViolations ?? null,
        elapsedMs,
    };
}
