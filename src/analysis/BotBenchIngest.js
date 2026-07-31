/**
 * BotBenchIngest.js — turn a file into a traverse-analysis dataset plus an
 * honest description of how good its source data is.
 *
 * Two shapes go in and one comes out:
 *
 *   BOT interchange CSV   sensor position + LOS unit vector, already in a local
 *   (+ .scenario.json)    ENU frame, with a sidecar carrying the frame origin,
 *                         epoch, rate, declared pointing sigma, sensor FOV and
 *                         an ANALYST wind estimate. See
 *                         benchmarks/botbench/BOT-Interchange-Format.html.
 *
 *   MISB FMV (.ts/.klv)   sensor lat/lon/alt + platform attitude + gimbal
 *                         angles per KLV record; the sightline is rebuilt with
 *                         the shared MISBSightline rotation order.
 *
 * The output dataset is the {n, fps, S, D, W} shape TraverseAnalysis works in
 * (see TraverseAnalysisData.buildAnalysisDataset for the live-sitch equivalent).
 *
 * WHY NOT JUST LOAD THE FILE INTO THE SITCH. Two reasons, both about measuring
 * the right thing. A BOT scenario is 51 samples at 1 Hz; imported into a 30 fps
 * sitch it becomes 1,500 interpolated frames, so every fit is run against
 * resampled data and 29 of every 30 "measurements" are invented. And a bulk run
 * over a folder would have to tear down and rebuild the whole scene per file.
 * Reading the file natively keeps each scenario at its own rate — which is also
 * what benchmarks/botbench measures, so the two are comparable.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not georeference a BOT file onto
 * real terrain. BOT scenarios are generated on a FLAT plane ("altitude = Z +
 * groundElevationMSL" at any horizontal distance), so the analysis runs with
 * flat terrain probes at the site's ground elevation, exactly as the Jest
 * benchmark does. Dropping the same file into the app instead (CTrackFileBOT)
 * places it on the ellipsoid and accepts a curvature difference of ~2 m at
 * 5 km and ~196 m at 50 km; that path exists and is the right one for LOOKING
 * at a scenario, but it is not the one to score it with.
 */

import {ECEF2ENU_radii, ECEFToLLA_radii, LLAToECEF} from "../LLA-ECEF-ENU";
import {Globals} from "../Globals";
import {MISB} from "../MISBFields";
import {findColumn} from "../ParseUtils";
import {isBOTCSV, BOT_DEFAULT_ORIGIN, BOT_DEFAULT_EPOCH_ISO} from "../TrackFiles/CTrackFileBOT";
import {misbSightlineHeading} from "../MISBSightline";
import {assessLinearFitConditioning} from "../LOSFitting";
import {sensorMotionStats} from "../TraverseAnalysis";
import {ensureGeoidLoaded, isGeoidLoaded, meanSeaLevelOffset} from "../EGM96Geoid";
import {
    analyzeVideoFileLike, KLV_EXTENSIONS, TRANSPORT_STREAM_EXTENSIONS,
} from "./AnalyzeVideoFile";

const DEG = Math.PI / 180;

// A BOT interchange member: the data CSV, or its sidecar.
const BOT_CSV_RE = /\.(input|truth|all)\.csv$/i;
const BOT_SIDECAR_RE = /\.scenario\.json$/i;
const BOT_LABELS_RE = /\.truth\.json$/i;
const BOT_TRUTH_CSV_RE = /\.truth\.csv$/i;

/**
 * What role a filename plays in a BotBench run. Sidecars are collected but
 * never queued as their own row — they belong to a CSV.
 */
export function botBenchFileRole(name = "") {
    if (BOT_SIDECAR_RE.test(name)) return "bot-sidecar";
    if (BOT_LABELS_RE.test(name)) return "bot-labels";
    // A .truth.csv is the ANSWER KEY — positions with no sightlines. Queuing it
    // guaranteed an error row on every scenario in an answers folder and
    // doubled the apparent failure count; it is a sidecar, not a problem.
    if (BOT_TRUTH_CSV_RE.test(name)) return "bot-truth-csv";
    if (BOT_CSV_RE.test(name) || /\.csv$/i.test(name)) return "bot-csv";
    // Only the containers that can actually be scanned. isVideoAnalysisCandidateName
    // also matches mp4/mov/mkv, which AnalyzeVideoFile explicitly reports as
    // unsupported — so a folder of ordinary video produced a row per file, each
    // one a guaranteed error, burying the real results in the error tally.
    const ext = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
    if (TRANSPORT_STREAM_EXTENSIONS.has(ext) || KLV_EXTENSIONS.has(ext)) return "fmv";
    return null;
}

/** True for anything BotBench will queue as a row (sidecars are not rows). */
export function isBotBenchCandidateName(name = "") {
    const role = botBenchFileRole(name);
    return role === "bot-csv" || role === "fmv";
}

/** `bot-0001` from `bot-0001.input.csv` — the key a sidecar is matched on. */
export function botBenchScenarioBase(name = "") {
    return String(name)
        .replace(/\.[^/.]+$/, "")
        .replace(/\.(input|truth|all|scenario)$/i, "");
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

// BOT interchange files are machine-generated: plain numeric cells, no quoting,
// no embedded separators (see the exporter, benchmarks/botbench/lib/
// exportInterchange.js). A full RFC-4180 parser would buy nothing here, and the
// detector below rejects anything that is not this format anyway.
function toRows(text) {
    return String(text).trim().split(/\r?\n/).map((line) => line.split(","));
}

// Number(""), Number("   ") and Number(null) are all 0, which would silently
// put a point at the frame origin. Empty cells are MISSING here — the truth
// triple is deliberately blank for a direction-only target — so map them to NaN
// and let the callers reject them.
function cell(v) {
    if (v === undefined || v === null) return NaN;
    const s = String(v).trim();
    return s === "" ? NaN : Number(s);
}

/**
 * The longest run of items that is UNIFORMLY SAMPLED IN TIME.
 *
 * The fits index time as `frame / rate`, so the frame grid must be evenly
 * spaced. Compacting past a gap silently rewrites WHEN every later sample
 * happened, which corrupts every speed, acceleration and g-load downstream —
 * invisibly, because the resulting track still looks perfectly smooth.
 *
 * CONTINUITY IS A PROPERTY OF THE TIMESTAMPS, NOT OF THE ARRAY. An earlier
 * version tested array adjacency, which is only equivalent when the array holds
 * exactly one entry per source frame — and that is false in every case that
 * matters:
 *
 *   - a KLV stream that drops packets simply has FEWER records; the survivors
 *     sit next to each other with a two-frame jump between their timestamps
 *   - a CSV can omit a row outright, so Time steps 0,1,2,4 while the indices
 *     step 0,1,2,3
 *   - an interleaved multi-track CSV puts other tracks' rows in between, so
 *     one track's own samples are never array-adjacent at all
 *
 * Testing the times instead handles all three, and lets the caller filter to
 * one track first without that filtering looking like a dropout.
 *
 * A run BREAKS on a dropout — an interval more than `gapFactor` times the
 * median — and not on ordinary jitter, which is a separate measurement
 * (timingStats.cv) and a separate warning. Items with a non-finite time break
 * the run too: an unknown timestamp cannot be shown to be contiguous.
 *
 * `items` must already be filtered to the ones worth keeping and sorted by
 * time. Returns the longest such run, and how many were left out.
 */
export function longestUniformRun(items, timeOf, gapFactor = 1.5, expectedDt = null) {
    if (items.length <= 1) {
        return {items: items.slice(), medianDt: NaN, breaks: 0, observedDt: NaN,
            degenerateClock: true, declaredMismatch: false};
    }

    const deltas = [];
    for (let i = 1; i < items.length; i++) {
        const dt = timeOf(items[i]) - timeOf(items[i - 1]);
        if (Number.isFinite(dt) && dt > 0) deltas.push(dt);
    }
    // No usable timing at all: every interval is unknown or non-positive, so no
    // gap can be proven and none ruled out. Return the whole list and let the
    // caller decide — but say DEGENERATE, and set declaredMismatch, because a
    // constant or non-advancing Time column is exactly the case where applying
    // a declared FPS regardless produces confident nonsense. Returning early
    // without that flag let the caller treat the declared rate as validated.
    if (!deltas.length) {
        return {items: items.slice(), medianDt: NaN, breaks: 0, observedDt: NaN,
            degenerateClock: true,
            declaredMismatch: Number.isFinite(expectedDt) && expectedDt > 0};
    }
    // PREFER THE DECLARED RATE. Deriving the expected spacing from the observed
    // median is circular when the drops are REGULAR: lose every other sample
    // and the median interval becomes 2x nominal, every remaining step matches
    // it, no gap is detected, and the clip is compacted onto the nominal
    // cadence — doubling every speed and quadrupling every acceleration. A
    // sidecar that states the generator's rate is the ground truth for what a
    // step SHOULD be; the observed median is only the fallback.
    const observedDt = median(deltas);
    // The declared rate is only authoritative if the timestamps AGREE with it.
    // Checking one direction is not enough: a gapFactor test alone catches
    // samples arriving too SLOWLY, and silently accepts a stream arriving twice
    // as fast — which is then replayed at the slower nominal rate, halving
    // every speed and quartering every acceleration. Disagreement in either
    // direction means the metadata and the data are describing different
    // things, and the timestamps are the data.
    const declaredUsable = Number.isFinite(expectedDt) && expectedDt > 0
        && observedDt > 0 && Math.abs(observedDt / expectedDt - 1) <= 0.1;
    const medianDt = declaredUsable ? expectedDt : observedDt;
    const limit = medianDt * gapFactor;

    let bestStart = 0, bestLen = 1, start = 0, breaks = 0;
    for (let i = 1; i <= items.length; i++) {
        let contiguous = false;
        if (i < items.length) {
            const dt = timeOf(items[i]) - timeOf(items[i - 1]);
            contiguous = Number.isFinite(dt) && dt > 0 && dt <= limit;
        }
        if (!contiguous) {
            if (i - start > bestLen) { bestLen = i - start; bestStart = start; }
            if (i < items.length) { breaks++; start = i; }
        }
    }
    return {
        items: items.slice(bestStart, bestStart + bestLen),
        medianDt, breaks, observedDt,
        // True when a declared rate was supplied but the timestamps contradict
        // it; the caller reports this rather than quietly preferring one.
        declaredMismatch: Number.isFinite(expectedDt) && expectedDt > 0 && !declaredUsable,
    };
}

// ---------------------------------------------------------------------------
// Quality metrics
// ---------------------------------------------------------------------------

// Math.max(...array) passes every element as an ARGUMENT, and blows the engine's
// argument limit (~65k in V8) with a RangeError. These arrays are one entry per
// frame, and a 30 fps clip passes 65k frames in half an hour — so the spread
// form turns a long real-world FMV file into an ingestion crash. Loop instead.
function maxOf(values) {
    let m = -Infinity;
    for (let i = 0; i < values.length; i++) if (values[i] > m) m = values[i];
    return m;
}

function median(values) {
    if (!values.length) return NaN;
    const s = Float64Array.from(values).sort();
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The angle statistics of the sightline series: how far the bearing swept, how
 * fast it moved, and how much it jitters frame to frame.
 *
 * `jitterDeg` is the MEDIAN SECOND-DIFFERENCE ANGLE — the angle between D[f]
 * and the direction midway between its two neighbours. On a smooth trajectory
 * sampled fast enough that per-frame curvature is small, this is dominated by
 * pointing noise, so it is a usable noise proxy WITHOUT any model of the
 * target. It is not a calibrated sigma: on a slow clip of a manoeuvring object
 * the curvature term is real and inflates it, which is why the raw statistic is
 * reported alongside the derived estimate rather than instead of it.
 *
 * `noiseEstDeg` converts it under an explicit assumption: isotropic Gaussian
 * pointing error of per-axis sigma on a locally straight path. The midpoint of
 * two neighbours has variance sigma^2/2, so the difference has sigma*sqrt(1.5),
 * and the median of a 2-D Rayleigh magnitude is sigma*sqrt(2 ln 2) = 1.1774
 * sigma — giving median = 1.4422 sigma. Stated so a reader can reject the
 * assumption rather than having to guess it.
 */
export function losAngleStats(dataset) {
    const {n, D, fps} = dataset;
    const dt = 1 / fps;
    const stepDeg = [];
    const jitter = [];
    let sweepPathDeg = 0;

    const dot = (a, b) => Math.max(-1, Math.min(1,
        D[a * 3] * D[b * 3] + D[a * 3 + 1] * D[b * 3 + 1] + D[a * 3 + 2] * D[b * 3 + 2]));

    for (let f = 1; f < n; f++) {
        const a = Math.acos(dot(f - 1, f)) / DEG;
        if (Number.isFinite(a)) { stepDeg.push(a); sweepPathDeg += a; }
    }
    for (let f = 1; f < n - 1; f++) {
        // Midpoint of the neighbours, renormalized.
        let mx = D[(f - 1) * 3] + D[(f + 1) * 3];
        let my = D[(f - 1) * 3 + 1] + D[(f + 1) * 3 + 1];
        let mz = D[(f - 1) * 3 + 2] + D[(f + 1) * 3 + 2];
        const len = Math.hypot(mx, my, mz);
        if (!(len > 1e-12)) continue;
        mx /= len; my /= len; mz /= len;
        const c = Math.max(-1, Math.min(1,
            D[f * 3] * mx + D[f * 3 + 1] * my + D[f * 3 + 2] * mz));
        const a = Math.acos(c) / DEG;
        if (Number.isFinite(a)) jitter.push(a);
    }

    // End-to-end bearing change: how much NEW geometry the clip actually saw.
    // Small with a long path means the sightline went out and came back.
    const netSweepDeg = n >= 2 ? Math.acos(dot(0, n - 1)) / DEG : NaN;
    const jitterDeg = median(jitter);

    return {
        netSweepDeg,
        sweepPathDeg,
        rateMedianDegPerS: median(stepDeg) / dt,
        rateMaxDegPerS: stepDeg.length ? maxOf(stepDeg) / dt : NaN,
        jitterDeg,
        noiseEstDeg: Number.isFinite(jitterDeg) ? jitterDeg / 1.4422 : NaN,
    };
}

/** Uniformity of a timestamp series (seconds). */
export function timingStats(times) {
    const d = [];
    for (let i = 1; i < times.length; i++) {
        const dt = times[i] - times[i - 1];
        if (Number.isFinite(dt) && dt > 0) d.push(dt);
    }
    if (!d.length) return {meanDt: NaN, cv: NaN, gaps: 0, maxDt: NaN};
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const varr = d.reduce((a, b) => a + (b - mean) * (b - mean), 0) / d.length;
    const med = median(d);
    // A "gap" is an interval more than 3x the median — a dropout, not jitter.
    const gaps = d.filter((x) => x > 3 * med).length;
    return {meanDt: mean, cv: mean > 0 ? Math.sqrt(varr) / mean : NaN,
        gaps, maxDt: maxOf(d)};
}

/**
 * Everything about the SOURCE DATA that governs whether a bearings-only
 * reconstruction can work at all — computed before any fit is attempted, so a
 * row can be read as "the analysis failed because the data cannot support it"
 * rather than "the analysis failed".
 */
export function assessSourceQuality(dataset, {times = null, declaredLosSigmaDeg = null,
    invalidFrames = 0, droppedRows = 0} = {}) {
    const motion = sensorMotionStats(dataset);
    const angles = losAngleStats(dataset);
    const cond = assessLinearFitConditioning(dataset);
    const timing = times ? timingStats(times) : null;

    // Altitude range of the sensor: a purely horizontal baseline leaves the
    // vertical component of range poorly constrained even when rcond looks fine.
    let zMin = Infinity, zMax = -Infinity;
    for (let f = 0; f < dataset.n; f++) {
        const z = dataset.S[f * 3 + 2];
        if (z < zMin) zMin = z;
        if (z > zMax) zMax = z;
    }

    const durationS = (dataset.n - 1) / dataset.fps;
    return {
        frames: dataset.n,
        fps: dataset.fps,
        durationS,
        // How much the sensor moved, and how much of that was net translation.
        // straightness ~1 is a straight run (the degenerate case for range);
        // low means it orbited or wove, which is what creates a baseline.
        sensorPathM: motion.pathLen,
        sensorSpanM: motion.span,
        straightness: motion.pathLen > 0 ? motion.span / motion.pathLen : NaN,
        sensorAltSpanM: Number.isFinite(zMin) ? zMax - zMin : NaN,
        ...angles,
        rcond: cond.rcond,
        log10Rcond: cond.log10Rcond,
        conditioning: cond.conditioning,
        effectiveRank: cond.effectiveRank,
        declaredLosSigmaDeg,
        timeCv: timing ? timing.cv : null,
        timeGaps: timing ? timing.gaps : null,
        invalidFrames,
        droppedRows,
    };
}

/**
 * A one-word triage of the source data. NOT a calibrated score — it is a
 * summary of the individual measurements above, offered so a 100-row table can
 * be sorted, and every row that carries it also carries the numbers it came
 * from. The thresholds are the ones already used elsewhere in the codebase
 * (LOSFitting's rcond bands) plus two obvious degeneracies.
 */
export function sourceQualityGrade(q) {
    const reasons = [];
    if (!(q.frames >= 10)) reasons.push("fewer than 10 frames");
    if (!(q.sensorSpanM > 100)) reasons.push("sensor barely moved");
    if (!(q.netSweepDeg > 0.05) && !(q.sweepPathDeg > 0.2)) reasons.push("sightline barely swept");
    if (q.conditioning === "poor") reasons.push("CV-family conditioning poor");
    else if (q.conditioning === "marginal") reasons.push("CV-family conditioning marginal");
    if (q.timeCv !== null && q.timeCv > 0.25) reasons.push("irregular sample timing");
    if (q.timeGaps > 0) reasons.push(`${q.timeGaps} timing gap(s)`);
    if (q.frameStated === false) reasons.push("coordinate frame/origin unstated (no sidecar)");

    const hard = reasons.some((r) => /fewer than|barely/.test(r));
    const grade = hard ? "weak" : q.conditioning === "poor" ? "hard"
        : q.conditioning === "marginal" ? "fair" : reasons.length ? "fair" : "good";
    return {grade, reasons};
}

// ---------------------------------------------------------------------------
// BOT interchange
// ---------------------------------------------------------------------------

const BOT_COLS = {
    trackId: ["TrackID"], time: ["Time"],
    sensorX: ["SensorPositionX"], sensorY: ["SensorPositionY"], sensorZ: ["SensorPositionZ"],
    losX: ["LOSUnitVectorX"], losY: ["LOSUnitVectorY"], losZ: ["LOSUnitVectorZ"],
    maxRange: ["MaxRange"], losUncertainty: ["LOSUncertainty"],
    truthX: ["TruePositionX"], truthY: ["TruePositionY"], truthZ: ["TruePositionZ"],
};

/**
 * Read a BOT interchange CSV (any of the three shapes) into a dataset.
 *
 * TRUTH IS QUARANTINED, exactly as benchmarks/botbench/lib/readInterchange.js
 * does it: the TruePosition columns land in `truth`, which is used for SCORING
 * after the fact. Nothing that reaches the analysis is derived from them.
 */
export function ingestBotCSV(text, {sidecar = null, label = "", labels = null} = {}) {
    const rows = toRows(text);
    if (!isBOTCSV(rows)) {
        throw new Error("Not a BOT interchange CSV (no SensorPosition+LOSUnitVector or TruePosition columns).");
    }
    const col = (names) => findColumn(rows, names, true);
    const idx = {};
    for (const [k, names] of Object.entries(BOT_COLS)) idx[k] = col(names);

    // Rows carrying a sensor position AND a sightline. A truth-only file has no
    // sightlines and therefore nothing to analyse — it is the answer key, not a
    // problem, and is rejected with a message that says so.
    if (idx.sensorX === -1 || idx.losX === -1) {
        throw new Error("This is a Truth-only BOT file (no sightlines) — there is nothing to analyse. "
            + "Use the .input.csv or .all.csv.");
    }

    const warnings = [];
    const parsed = [];
    let droppedRows = 0;
    let degenerateLOS = 0;
    const ids = [];
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const t = cell(r[idx.time]);
        const s = [cell(r[idx.sensorX]), cell(r[idx.sensorY]), cell(r[idx.sensorZ])];
        const d = [cell(r[idx.losX]), cell(r[idx.losY]), cell(r[idx.losZ])];
        // Simply skipped. A dropped row leaves a hole in TIME, and time is what
        // the run selector below tests, so it needs no placeholder to notice.
        if (!Number.isFinite(t) || !s.every(Number.isFinite) || !d.every(Number.isFinite)) {
            droppedRows++;
            continue;
        }
        // A DEGENERATE SIGHTLINE IS NOT A SIGHTLINE. `0,0,0` parses as three
        // finite numbers and survives every check above, and normalizing it
        // divides by a guarded 1 and leaves it zero — so a ray pointing nowhere
        // reaches every fitter, where it contributes a meaningless residual to
        // each of them. The format's column is a UNIT vector, so anything that
        // is not close to unit length is a broken row, not a hint.
        const dLen = Math.hypot(d[0], d[1], d[2]);
        if (!(dLen > 0.5) || dLen > 2) {
            degenerateLOS++;
            droppedRows++;
            continue;
        }
        const truth = idx.truthX === -1 ? null
            : [cell(r[idx.truthX]), cell(r[idx.truthY]), cell(r[idx.truthZ])];
        const id = idx.trackId === -1 ? "" : String(r[idx.trackId] ?? "").trim();
        if (!ids.includes(id)) ids.push(id);
        parsed.push({
            // ORIGINAL frame number, kept because everything the sidecars say
            // about this clip is indexed by it. `invalidFrames` and the label
            // file's `directionTruth` are both keyed to the file's own row
            // order, so once ANY row is dropped the compacted array's index no
            // longer names the same frame — an out-of-FOV mark would land on an
            // innocent frame and the direction truth would shear against the
            // sightlines by however many rows went missing.
            origIndex: i - 1,
            t, s, d, dLen, id,
            truth: truth && truth.every(Number.isFinite) ? truth : null,
            maxRange: idx.maxRange === -1 ? NaN : cell(r[idx.maxRange]),
            losSigma: idx.losUncertainty === -1 ? NaN : cell(r[idx.losUncertainty]),
        });
    }
    if (degenerateLOS) {
        warnings.push(`${degenerateLOS} row(s) dropped for a non-unit LOS vector `
            + `(zero-length rays would otherwise reach every fitter).`);
    }
    if (droppedRows > degenerateLOS) {
        warnings.push(`${droppedRows - degenerateLOS} row(s) dropped for missing/non-numeric values.`);
    }

    // ONE SCENARIO PER FILE, and the extra rows are DISCARDED, not concatenated.
    // Two scenarios share only a coordinate frame; joining them produces a
    // trajectory that teleports between them and an analysis that completes
    // and means nothing. CTrackFileBOT makes the same choice on the drag-drop
    // path, so both importers agree about what a multi-TrackID file is.
    // NOTE the single-ID branch must not alias `parsed` and then clear it — an
    // earlier version did exactly that (`kept = parsed` then `parsed.length = 0`),
    // which emptied both through the shared reference and produced a dataset
    // with n = 0. Nothing downstream noticed: the length guard had already run
    // against the pre-clear array, so an empty dataset reached the fitters and
    // died deep inside traversePlausible with "undefined is not iterable".
    // Bind a new array and never mutate `parsed` again.
    // FILTER FIRST, THEN TEST CONTINUITY — and in that order for a reason.
    //
    // `invalidFrames` marks frames whose pointing error exceeded FOV/2: the ray
    // records where the CAMERA was looking, not where the target was, so fitting
    // it asks a solver to explain a measurement that was never a measurement of
    // this object. Those frames and any second scenario's rows are removed here.
    //
    // Removing them BEFORE the continuity test is what makes an interleaved
    // multi-track file work. An earlier version tested the unfiltered array, so
    // another track's rows sitting between this track's samples read as
    // dropouts and collapsed every run to a single frame. Time is the arbiter:
    // this track's own samples are contiguous in TIME whatever else the file
    // interleaves between them.
    const invalidSet = new Set(Array.isArray(sidecar?.invalidFrames) ? sidecar.invalidFrames : []);
    const candidates = parsed.filter((p) =>
        (ids.length <= 1 || p.id === ids[0]) && !invalidSet.has(p.origIndex));

    if (ids.length > 1) {
        warnings.push(`File holds ${ids.length} TrackIDs (${ids.join(", ")}); only "${ids[0]}" `
            + `was analysed — one scenario per file. Split the file to run the others.`);
    }

    const declaredDt = Number.isFinite(sidecar?.nominalFps) && sidecar.nominalFps > 0
        ? 1 / sidecar.nominalFps : null;
    const run = longestUniformRun(candidates, (p) => p.t, 1.5, declaredDt);
    if (run.degenerateClock) {
        throw new Error("The Time column never advances (no positive interval between any two "
            + "rows), so this file carries no usable timing. Every speed, acceleration and "
            + "g-load the analysis reports is derived from it, so there is nothing honest to "
            + "compute here.");
    }
    if (run.declaredMismatch) {
        warnings.push(`The sidecar declares ${(1 / declaredDt).toFixed(3)} Hz but the Time column `
            + `steps every ${run.observedDt.toFixed(4)} s (${(1 / run.observedDt).toFixed(3)} Hz). `
            + `The TIMESTAMPS were used, since they are the data — but one of the two is wrong, `
            + `and every speed and acceleration here depends on which.`);
    }
    const kept = run.items;
    if (kept.length < candidates.length) {
        warnings.push(`Analysed the longest UNIFORMLY SAMPLED span: frames `
            + `${kept[0]?.origIndex}-${kept[kept.length - 1]?.origIndex} `
            + `(${kept.length} of ${candidates.length} usable frames, ${run.breaks} timing `
            + `break(s) at more than 1.5x the median interval of ${run.medianDt?.toFixed(3)} s). `
            + `The fits index time as frame/rate, so a span crossing a gap would silently rewrite `
            + `when every later sample happened.`);
    }
    if (kept.length < 10) {
        throw new Error(`The longest uniformly sampled run is ${kept.length} frame(s) `
            + `(${candidates.length} usable in total, split by ${run.breaks} timing gap(s)); `
            + `the analysis needs at least 10.`);
    }

    const n = kept.length;
    // Rate: the sidecar's declared rate is authoritative (it is what the
    // generator used); without one, derive it from the median sample interval
    // rather than assuming a video frame rate.
    const times = Float64Array.from(kept, (p) => p.t);
    const timing = timingStats(times);
    // The rate the FITS run at must be the one the continuity test just
    // validated, not the declared figure it may have just rejected.
    const fps = (Number.isFinite(sidecar?.nominalFps) && sidecar.nominalFps > 0
        && !run.declaredMismatch)
        ? sidecar.nominalFps
        : (Number.isFinite(run.observedDt) && run.observedDt > 0 ? 1 / run.observedDt
            : (timing.meanDt > 0 ? 1 / timing.meanDt : 1));
    if (!Number.isFinite(sidecar?.nominalFps)) {
        warnings.push(`No sidecar rate; using ${fps.toFixed(3)} Hz from the Time column.`);
    }

    const S = new Float64Array(n * 3);
    const D = new Float64Array(n * 3);
    const W = new Float64Array(n * 3);
    const T = new Float64Array(n * 3);
    const tValid = new Uint8Array(n);

    // The sidecar wind is the ANALYST estimate: the generator's mean field
    // perturbed by a deterministic draw at sigmaMS, published precisely so a
    // solver has something imperfect to work with. Using the generator's exact
    // field would be an inverse crime. Constant over the clip, so the per-frame
    // displacement is just velocity / fps — matching what the app's wind node
    // hands buildAnalysisDataset.
    const windE = Number.isFinite(sidecar?.wind?.E) ? sidecar.wind.E : 0;
    const windN = Number.isFinite(sidecar?.wind?.N) ? sidecar.wind.N : 0;

    let anyTruth = false;
    let maxRangeM = null;
    let sigmaSum = 0, sigmaCount = 0;

    for (let f = 0; f < n; f++) {
        const p = kept[f];
        S[f * 3] = p.s[0]; S[f * 3 + 1] = p.s[1]; S[f * 3 + 2] = p.s[2];
        D[f * 3] = p.d[0] / p.dLen; D[f * 3 + 1] = p.d[1] / p.dLen; D[f * 3 + 2] = p.d[2] / p.dLen;
        W[f * 3] = windE / fps; W[f * 3 + 1] = windN / fps; W[f * 3 + 2] = 0;
        if (p.truth) {
            T[f * 3] = p.truth[0]; T[f * 3 + 1] = p.truth[1]; T[f * 3 + 2] = p.truth[2];
            tValid[f] = 1;
            anyTruth = true;
        } else if (f > 0) {
            // HOLD THE LAST KNOWN POSITION on a frame with no truth, rather than
            // leaving the zero-fill. Scoring already honours `tValid`, but the
            // charts plot the raw array — and a zero triple is the ENU ORIGIN,
            // kilometres away, so a sparse truth track drew a line diving to the
            // origin and back on every gap. Holding makes the gap invisible
            // rather than a fictitious manoeuvre; it is never scored, because
            // tValid stays 0 here.
            T[f * 3] = T[(f - 1) * 3];
            T[f * 3 + 1] = T[(f - 1) * 3 + 1];
            T[f * 3 + 2] = T[(f - 1) * 3 + 2];
        }
        if (Number.isFinite(p.maxRange)) {
            maxRangeM = maxRangeM === null ? p.maxRange : Math.max(maxRangeM, p.maxRange);
        }
        if (Number.isFinite(p.losSigma)) { sigmaSum += p.losSigma; sigmaCount++; }
    }

    // THE SIDECAR'S FRAME DECLARATION IS CHECKED, NOT ASSUMED.
    //
    // Everything below reads the CSV as local ENU metres with X=East, Y=North,
    // Z=Up, directions expressed at the origin, on a flat plane whose altitude
    // rule is `altitude = U + groundElevationMSL`. That is what the shipped
    // release declares — and the format has a specVersion precisely because it
    // need not stay the only shape. A sidecar describing anything else would be
    // read as though it did, producing a confident answer to a question about a
    // different coordinate system, so each field is compared and any mismatch
    // is refused rather than warned about: a silently misread frame is not a
    // degraded result, it is a wrong one.
    const frame = sidecar?.frame ?? null;
    if (sidecar) {
        // FAIL CLOSED. An earlier version only complained when a field was
        // present AND wrong, so a sidecar that simply OMITTED frame.type — or
        // omitted `frame` altogether — sailed through and was read with v1 ENU
        // defaults it never claimed. Absence is not agreement.
        const major = String(sidecar.specVersion ?? "1").split(".")[0];
        if (major !== "1") {
            throw new Error(`This sidecar declares specVersion ${sidecar.specVersion}. This `
                + `importer reads the 1.x frame contract, and a major version exists precisely `
                + `because the later one may mean something different by the same fields.`);
        }
        if (!frame) {
            throw new Error("This BOT sidecar has no `frame` block, so the coordinate system, "
                + "axis order and altitude rule of its CSV are unstated. They are not assumed.");
        }
        const mismatches = [];
        const require_ = (label, actual, want) => {
            if (actual === undefined || actual === null) {
                mismatches.push(`${label} is missing`);
            } else if (String(actual).toLowerCase() !== want) {
                mismatches.push(`${label} is "${actual}", expected "${want}"`);
            }
        };
        require_("frame.type", frame.type, "enu");
        require_("frame.axisOrder", frame.axisOrder, "x=east, y=north, z=up");
        require_("frame.directionBasis", frame.directionBasis, "originlla");
        require_("frame.surfaceModel", frame.surfaceModel, "flat-plane");
        require_("frame.geodeticAltitudeRule", frame.geodeticAltitudeRule,
            "altitude = u + groundelevationmsl");
        if (mismatches.length) {
            throw new Error(`This BOT sidecar declares a frame this importer does not read: `
                + `${mismatches.join("; ")}. Reading it anyway would answer a question about a `
                + `different coordinate system.`);
        }
    }

    // Origin: real NUMBERS, in range. Not strings that happen to coerce — a
    // quoted latitude means the producer's schema is not what is assumed here,
    // and Number("35") succeeding would hide that.
    const originLLA = frame?.originLLA;
    if (sidecar) {
        const ok = Array.isArray(originLLA) && originLLA.length >= 2
            && originLLA.slice(0, 2).every((v) => typeof v === "number" && Number.isFinite(v))
            && Math.abs(originLLA[0]) <= 90 && Math.abs(originLLA[1]) <= 180;
        if (!ok) {
            throw new Error(`Sidecar frame.originLLA must be finite numeric [lat, lon] in range; `
                + `got ${JSON.stringify(originLLA)}.`);
        }
    }
    // The forward hold in the fill loop cannot reach frames BEFORE the first
    // valid truth, so back-fill those from it. Both halves are needed and this
    // one was lost in a later edit to this block: without it a truth track that
    // starts blank keeps the zero-fill on its opening frames, and zero is the
    // ENU ORIGIN — kilometres away — so the report drew a trajectory sweeping
    // in from nowhere. Never scored either way; tValid stays 0.
    if (anyTruth) {
        let first = -1;
        for (let f = 0; f < n; f++) if (tValid[f]) { first = f; break; }
        for (let f = 0; f < first; f++) {
            T[f * 3] = T[first * 3];
            T[f * 3 + 1] = T[first * 3 + 1];
            T[f * 3 + 2] = T[first * 3 + 2];
        }
    }

    const [oLat, oLon, oAlt] = sidecar ? originLLA
        : [BOT_DEFAULT_ORIGIN.latDeg, BOT_DEFAULT_ORIGIN.lonDeg, 0];

    const groundZ = 0;
    const siteElevationMSL = Number.isFinite(sidecar?.frame?.groundElevationMSL)
        ? sidecar.frame.groundElevationMSL : 0;

    // Reported as "how many the file declared", which after the trim above is
    // also how many were removed — every frame that reaches the fits is one the
    // sidecar says the sensor actually observed.
    const invalidFrames = invalidSet.size;
    // A uniform-cadence assumption is baked into the fits (times are f / fps),
    // so irregular sampling is a real distortion of every speed and
    // acceleration, not a cosmetic detail. Say so rather than let the derived
    // rate imply the data is even.
    if (timing && (timing.cv > 0.05 || timing.gaps > 0)) {
        warnings.push(`Sample timing is not uniform (CV ${(timing.cv * 100).toFixed(1)}%, `
            + `${timing.gaps} gap(s)). The fits assume an even cadence of ${fps.toFixed(3)} Hz, so `
            + `speeds, accelerations and g-loads are distorted wherever the real spacing differs.`);
    }
    const declaredSigma = Number.isFinite(sidecar?.losError?.sigmaDeg) ? sidecar.losError.sigmaDeg
        : (sigmaCount ? sigmaSum / sigmaCount : null);
    // WHAT THE DECLARED FIGURE MEANS depends on the error model, and the two are
    // not comparable. A "white" sigmaDeg is a per-axis 1-sigma, which the
    // sightline-derived estimate should reproduce. A "correlated" one is
    // operator tracking wobble, whose sigmaDeg the format documents as the
    // DEADBAND AMPLITUDE and explicitly "NOT a white 1-sigma" — and because
    // wobble is smooth in time, the second-difference estimator sees only its
    // white residue and reads far lower. Carrying the model through is what
    // stops a summary from reporting that a wobble clip is three times quieter
    // than it claims.
    const losErrorModel = sidecar?.losError?.model ?? null;
    const losErrorCorrelated = sidecar?.losError?.correlated ?? null;

    const dataset = {n, fps, S, D, W, frame0: 0, frame1: n - 1};
    const quality = assessSourceQuality(dataset, {
        times, declaredLosSigmaDeg: declaredSigma, invalidFrames, droppedRows,
    });
    quality.frameStated = !!sidecar;
    quality.losErrorModel = losErrorModel;
    quality.losErrorCorrelated = losErrorCorrelated;
    quality.losErrorNote = sidecar?.losError?.note ?? null;

    // DIRECTION-ONLY TRUTH. A celestial target has a bearing and no finite
    // range, so the All CSV's TruePosition triple is deliberately blank for it
    // and positional truth does not exist. The label sidecar carries the answer
    // in the only form it has — a per-frame unit vector — and without reading
    // that, the one direction-only scenario in the set reports "no truth" and
    // is silently never scored, which reads as an absence of evidence rather
    // than the presence of a different kind of it.
    let directionTruth = null;
    const maxOrig = kept.length ? kept[kept.length - 1].origIndex : -1;
    if (!anyTruth && labels?.truthKind === "direction" && Array.isArray(labels.directionTruth)
        && labels.directionTruth.length >= (maxOrig + 1) * 3) {
        // Gathered BY ORIGINAL FRAME INDEX. The sidecar array is keyed to the
        // file's own row order, so reading it positionally after rows have been
        // dropped or the clip trimmed would shear the truth against the
        // sightlines by exactly the number of missing rows — a silent, uniform
        // bearing error that looks like a real result.
        const dir = new Float64Array(n * 3);
        for (let f = 0; f < n; f++) {
            const o = kept[f].origIndex * 3;
            dir[f * 3] = labels.directionTruth[o];
            dir[f * 3 + 1] = labels.directionTruth[o + 1];
            dir[f * 3 + 2] = labels.directionTruth[o + 2];
        }
        directionTruth = {
            dir,
            // Every frame that survived the trim is an observed one.
            valid: new Uint8Array(n).fill(1),
            label: `Direction truth (${labels.objectClass ?? "celestial"})`,
        };
    }

    return {
        kind: "bot",
        label: label || sidecar?.label || sidecar?.trackId || "BOT scenario",
        dataset,
        originLat: oLat * DEG,
        originLon: oLon * DEG,
        // Ground is the Z = 0 plane — see the note where groundZ is set.
        groundZ,
        clipStartMs: Date.parse(sidecar?.epochISO ?? BOT_DEFAULT_EPOCH_ISO),
        truth: anyTruth ? {
            track: T, valid: tValid,
            validCount: tValid.reduce((a, b) => a + b, 0),
            usable: tValid.reduce((a, b) => a + b, 0) >= 5,
            label: (labels?.objectClass ? `Truth (${labels.objectClass})` : "Truth"),
            trackID: null,
        } : null,
        directionTruth,
        // ONLY THESE FIELDS OF THE LABEL SIDECAR ARE KEPT.
        //
        // bot-NNNN.truth.json also contains `provenance.spec`, which is the
        // complete generating specification INCLUDING initialHorizontalRangeM —
        // the answer to the question the analysis is being asked. None of it is
        // fed to the analysis today, but keeping the whole parsed object on the
        // record leaves it one careless `record.labels.provenance` away from
        // being used, and a range anchor taken from there would look like a
        // spectacular result rather than a leak. An allowlist makes that
        // impossible to do by accident.
        labels: labels ? {
            objectClass: labels.objectClass ?? null,
            truthKind: labels.truthKind ?? null,
            anomalous: labels.anomalous ?? null,
        } : null,
        meta: {
            trackId: sidecar?.trackId ?? ids[0] ?? null,
            siteElevationMSL,
            originLLA: [oLat, oLon, oAlt],
            epochISO: sidecar?.epochISO ?? BOT_DEFAULT_EPOCH_ISO,
            fovFullDeg: sidecar?.sensor?.fovFullDeg ?? null,
            windEstimate: sidecar?.wind
                ? {E: windE, N: windN, sigmaMS: sidecar.wind.sigmaMS ?? null,
                    provenance: sidecar.wind.provenance ?? null}
                : null,
            maxRangeM,
            surfaceModel: sidecar?.frame?.surfaceModel ?? "flat-plane",
            hasSidecar: !!sidecar,
        },
        quality,
        warnings,
    };
}

// ---------------------------------------------------------------------------
// MISB FMV
// ---------------------------------------------------------------------------

/**
 * The angles that MUST be present for a record to define a sightline.
 *
 * ALL THREE PLATFORM ANGLES ARE REQUIRED, none of them defaulted. The boresight
 * is the platform attitude composed with the gimbal angles, so a missing
 * platform term is an unknown in that composition, not a zero one.
 *
 * PLATFORM ROLL IS NOT A ROLL ABOUT THE BORESIGHT. Read the order in
 * MISBSightline.misbSensorMatrix: heading, pitch and platform ROLL build the
 * platform frame, and only THEN are the gimbal azimuth and elevation applied
 * about that frame's axes. So a platform roll re-orients the very axes az/el
 * are measured about, and for any off-boresight gimbal angle it swings the
 * sightline somewhere else entirely — a 30 deg bank with the camera 45 deg off
 * the nose is not a small correction. Substituting zero would assert wings
 * level and produce confidently wrong bearings with nothing anywhere to fail.
 *
 * (The angle that genuinely is a roll about the boresight is SENSOR roll, the
 * LAST rotation applied. It spins the image about the pointing direction and
 * leaves that direction — the matrix's forward column, which is all
 * misbSightlineHeading reads — unchanged. That one is safe to default, and is.)
 *
 * Requiring the platform triple turns "wrong bearings" into "this file cannot
 * be analysed", which is the honest outcome for a tool whose whole job is
 * measuring how good an analysis is.
 */
function misbHasSightline(row) {
    return Number.isFinite(row?.[MISB.SensorRelativeAzimuthAngle])
        && Number.isFinite(row?.[MISB.SensorRelativeElevationAngle])
        && Number.isFinite(row?.[MISB.PlatformHeadingAngle])
        && Number.isFinite(row?.[MISB.PlatformPitchAngle])
        && Number.isFinite(row?.[MISB.PlatformRollAngle]);
}

/**
 * Build a dataset from decoded MISB ST 0601 records.
 *
 * ALTITUDE DATUM. SensorTrueAltitude is MSL by MISB convention (the same
 * assumption CNodeMISBData makes on import), so the geoid offset is added to
 * reach the HAE the ECEF conversion needs. SensorEllipsoidHeight (tag 75) is
 * already ellipsoidal and is preferred when present. Getting this backwards is
 * a ~16 m error in CONUS — small against a 20 km range, but it is free to get
 * right and it keeps these numbers comparable with the app's.
 */
export function ingestMISBRecords(misb, {label = "", geoid = true} = {}) {
    const warnings = [];
    const usable = [];
    let noSightline = 0, noPosition = 0, noRoll = 0;

    // Per-record PES PTS, paired by index with the MISB array (MISBUtils sets it
    // on the array itself when the TS demuxer supplied PES entries).
    const pesPTS = Array.isArray(misb.pesPTSus) && misb.pesPTSus.length === misb.length
        ? misb.pesPTSus : null;
    let rowIndex = -1;
    for (const row of misb) {
        rowIndex++;
        if (!row) continue;
        const lat = row[MISB.SensorLatitude];
        const lon = row[MISB.SensorLongitude];
        const hae = row[MISB.SensorEllipsoidHeight];
        const msl = row[MISB.SensorTrueAltitude];
        const t = row[MISB.UnixTimeStamp];
        // Skipped, not held. The run selector below judges continuity on the
        // TIMESTAMPS, so a missing record shows up as a jump in time whether or
        // not anything stands in for it — which is just as well, because a KLV
        // stream that drops packets has no placeholder to offer.
        if (!Number.isFinite(lat) || !Number.isFinite(lon)
            || (!Number.isFinite(hae) && !Number.isFinite(msl))) { noPosition++; continue; }
        if (!misbHasSightline(row)) { noSightline++; continue; }
        if (!Number.isFinite(row[MISB.SensorRelativeRollAngle])) noRoll++;
        usable.push({
            // MICROSECONDS. Tag 2 is µs since the Unix epoch per ST 0601, and
            // parseKLVFile stores the raw value (computeMisbSpans divides by
            // 1e6 for the same reason). Beware: the CSV importers in MISBUtils
            // put MILLISECONDS in this same column, so the units of
            // MISB.UnixTimeStamp depend on which reader produced the array.
            // This function is only ever handed a KLV-decoded one.
            t: Number.isFinite(t) ? t / 1e6 : NaN,
            // PES PTS for the SAME record, when the demuxer supplied it. This is
            // the SYNCHRONOUS timebase — locked to the encoder's clock — and on
            // a stream whose UnixTimeStamp is absent or erratic it is the better
            // one. Without it such a file fell back to "assume 30 Hz", which is
            // a guess presented as a measurement.
            pts: Number.isFinite(pesPTS?.[rowIndex]) ? pesPTS[rowIndex] / 1e6 : NaN,
            lat, lon,
            altHAE: Number.isFinite(hae) ? hae : null,
            altMSL: Number.isFinite(hae) ? null : msl,
            // The whole platform triple and the gimbal az/el are guaranteed
            // finite by misbHasSightline. ONLY sensorRoll falls back to 0, and
            // only because it is the final rotation about the boresight, which
            // leaves the pointing direction untouched.
            angles: {
                platformHeading: row[MISB.PlatformHeadingAngle],
                platformPitch: row[MISB.PlatformPitchAngle],
                platformRoll: row[MISB.PlatformRollAngle],
                sensorAz: row[MISB.SensorRelativeAzimuthAngle],
                sensorEl: row[MISB.SensorRelativeElevationAngle],
                sensorRoll: Number.isFinite(row[MISB.SensorRelativeRollAngle])
                    ? row[MISB.SensorRelativeRollAngle] : 0,
            },
        });
    }

    if (noPosition) warnings.push(`${noPosition} record(s) had no usable sensor position.`);
    if (noSightline) {
        warnings.push(`${noSightline} record(s) were dropped for incomplete pointing — a sightline `
            + `needs SensorRelativeAzimuth/Elevation AND the full PlatformHeading/Pitch/Roll `
            + `triple. None of the three is assumed: platform roll re-orients the axes the `
            + `gimbal angles are measured about, so assuming wings level would swing every `
            + `off-boresight sightline. See misbHasSightline.`);
    }
    if (noRoll) {
        warnings.push(`${noRoll} record(s) carry no SensorRelativeRollAngle, taken as 0. That is `
            + `the roll about the BORESIGHT — it spins the image, not the pointing direction — `
            + `so it does not move the sightlines.`);
    }
    // The longest UNIFORMLY SAMPLED span — see longestUniformRun. This is where
    // a real metadata dropout is caught: the surviving records sit next to each
    // other in the array with a multi-frame jump between their timestamps, and
    // only the timestamps reveal it.
    const complete = usable.filter(Boolean);
    let chosenTimebaseNote = "";
    // Pick the timebase BEFORE judging continuity: a stream with good PES PTS
    // and a broken wall clock is a normal FMV case, and trimming it on the
    // broken clock would discard perfectly timed data.
    // WHICH CLOCK MEASURES REAL SECONDS.
    //
    // Four rules for this have now been wrong, and the last one was wrong for
    // an interesting reason, so the reasoning is worth keeping:
    //
    //   "all values finite"        picked an erratic wall clock over a clean PTS.
    //   "fraction of clean steps"  ignores WHERE the bad steps fall; one
    //     duplicate mid-clip scores 0.9986, beats a perfect PTS, halves the run.
    //   "longest retained run"     is not a correctness test: a DAMAGED clock
    //     can retain more precisely BECAUSE it is too uniform, winning by
    //     hiding the dropout the good clock honestly reports.
    //   "always prefer PES PTS"    assumes the encoder clock runs at real time.
    //     It does not always: MISBUtils' encoder-cadence analysis exists for the
    //     "ffmpeg -r N without an fps filter" footgun, where PES PTS values are
    //     written at one cadence while frames were captured at another. Prefer
    //     PTS there and every speed, acceleration and g-load is scaled by the
    //     ratio between them. A warning does not make wrong numbers right.
    //
    // MISBUtils also supplies the test: real_fps = pcr_fps x (klvPesSpan /
    // klvUtsSpan). That ratio IS the question — it says whether the encoder
    // clock advances at one second per real second. So:
    //
    //   ratio ~ 1  the encoder clock is real-time. Prefer PES PTS: it is
    //              synchronous, finer, and immune to wall-clock steps.
    //   otherwise  the encoder clock is not measuring real seconds. Use the
    //              WALL CLOCK, which by definition is, because kinematics are
    //              metres per REAL second.
    //
    // The wall clock always supplies the epoch regardless; the two roles stay
    // separate.
    //
    // Neither series need be complete — parseKLVFile deliberately writes a null
    // PTS for a record it cannot pair (MISBUtils.js) — and no minimum length is
    // applied HERE: a short-but-honest timeline is a "not enough frames"
    // result, not a "this clip has no timing" one, and that distinction is
    // already drawn further down.
    const trialOf = (get) => {
        if (complete.length < 2) return null;
        if (complete.filter((u) => Number.isFinite(get(u))).length < 2) return null;
        const trial = longestUniformRun(complete, get);
        if (trial.degenerateClock || !trial.items.length) return null;
        return {get, run: trial, kept: trial.items.length, dt: trial.observedDt};
    };
    const utsTrial = trialOf((u) => u.t);
    const ptsTrial = trialOf((u) => u.pts);

    // Spans measured over the records where BOTH clocks are finite, so the
    // ratio compares like with like.
    const paired = complete.filter((u) => Number.isFinite(u.t) && Number.isFinite(u.pts));
    const utsSpan = paired.length >= 2 ? paired[paired.length - 1].t - paired[0].t : NaN;
    const pesSpan = paired.length >= 2 ? paired[paired.length - 1].pts - paired[0].pts : NaN;
    const spanRatio = utsSpan > 0 && pesSpan > 0 ? pesSpan / utsSpan : NaN;
    const encoderIsRealTime = Number.isFinite(spanRatio) && Math.abs(spanRatio - 1) <= 0.02;

    let best = null, why = "";
    if (ptsTrial && utsTrial) {
        // Retention still matters: partial PES pairing can leave a short PTS
        // run beside a long clean wall-clock one, and taking the encoder clock
        // then throws away most of the clip for a purity that buys nothing.
        const ptsKeepsEnough = ptsTrial.kept >= utsTrial.kept * 0.9;
        if (encoderIsRealTime && ptsKeepsEnough) {
            best = ptsTrial;
            why = "PES PTS (encoder clock verified real-time against UnixTimeStamp)";
        } else if (!encoderIsRealTime) {
            best = utsTrial;
            why = `UnixTimeStamp (the encoder clock runs at ${spanRatio.toFixed(3)}x real time, `
                + `so it does not measure real seconds)`;
            warnings.push(`The KLV PES timeline spans ${spanRatio.toFixed(3)}x the wall-clock `
                + `interval over the same records — the "-r N without an fps filter" encoder `
                + `footgun. Cadence was taken from UnixTimeStamp, because speeds and g-loads are `
                + `per REAL second.`);
        } else {
            best = utsTrial;
            why = "UnixTimeStamp (PES PTS is only partially paired)";
            warnings.push(`PES PTS is paired on too little of this clip to use for cadence `
                + `(${ptsTrial.kept} usable frames against ${utsTrial.kept} on the wall clock), `
                + `so UnixTimeStamp was used.`);
        }
    } else if (ptsTrial || utsTrial) {
        best = ptsTrial ?? utsTrial;
        why = ptsTrial ? "PES PTS (no usable UnixTimeStamp)" : "UnixTimeStamp (no usable PES PTS)";
        if (ptsTrial && !utsTrial) {
            warnings.push("UnixTimeStamp gives no usable timeline, so cadence came from the KLV "
                + "PES timestamps. Without a wall clock this clip has no absolute time, and the "
                + "encoder clock could not be checked against one — treat derived speeds as "
                + "conditional on the encoder having run at real time.");
        }
    }
    const chosenName = best ? (best === ptsTrial ? "pts" : "uts") : "none";
    const useTimeOf = best ? best.get : ((u) => u.t);
    const chosen = best;
    if (best) chosenTimebaseNote = why;

    if (utsTrial && ptsTrial && Math.abs(ptsTrial.kept - utsTrial.kept) > 0.1 * complete.length) {
        warnings.push(`The clocks retain different amounts of this clip — PES PTS `
            + `${ptsTrial.kept} frames, UnixTimeStamp ${utsTrial.kept}, of ${complete.length}. `
            + `One of them is either hiding a real dropout or inventing one.`);
    }
    const haveAllTimes = !!chosen;
    if (!haveAllTimes) {
        throw new Error("Neither UnixTimeStamp nor KLV PES PTS gives a usable, advancing "
            + "timeline for these records, so this clip carries no timing. Every speed, "
            + "acceleration and g-load the analysis reports is derived from it, so there is "
            + "nothing honest to compute here.");
    }
    const run = longestUniformRun(complete, useTimeOf);
    const kept = run.items;
    if (kept.length < complete.length) {
        warnings.push(`Analysed the longest UNIFORMLY SAMPLED span: ${kept.length} of `
            + `${complete.length} complete records (${usable.length} decoded), split by `
            + `${run.breaks} dropout(s) longer than 1.5x the median `
            + `${run.medianDt?.toFixed(4)} s interval. The fits index time as frame/rate, so a `
            + `span crossing a dropout would silently rewrite when every later sample happened.`);
    }
    if (kept.length < 10) {
        throw new Error(`The longest uniformly sampled run is ${kept.length} record(s) `
            + `(${complete.length} complete in total, split by ${run.breaks} dropout(s)); the `
            + `analysis needs at least 10. A record needs a sensor position AND the full `
            + `platform attitude plus gimbal az/el.`);
    }

    const n = kept.length;
    const times = Float64Array.from(kept, useTimeOf);

    // THE EPOCH IS A PROPERTY OF THE SELECTED RUN, not of the file.
    //
    // A previous version gated this on "a usable UTS run exists somewhere",
    // which says nothing about the run actually chosen: when cadence came from
    // PES PTS, kept[0] is a PTS-selected record whose own wall-clock stamp may
    // be absent — and `new Date(NaN).toISOString()` throws a RangeError, taking
    // down ingestion of an otherwise perfectly good clip. Read the value that
    // will actually be used, and fall back to the first record in the run that
    // has one.
    let clipStartS = NaN;
    for (const u of kept) {
        if (Number.isFinite(u.t)) { clipStartS = u.t; break; }
    }
    const haveEpoch = Number.isFinite(clipStartS);
    if (!haveEpoch) {
        warnings.push("No record in the analysed span carries a UnixTimeStamp, so this clip has "
            + "no absolute time. Anything date-dependent (sun/moon position, satellite passes) "
            + "cannot be computed for it.");
    }
    const timing = haveAllTimes ? timingStats(times) : null;
    // Always derived — the no-clock case was refused above, so there is no
    // assumed rate anywhere in this path.
    const dSteps = [];
    for (let i = 1; i < n; i++) dSteps.push(times[i] - times[i - 1]);
    const fps = 1 / median(dSteps);

    if (haveAllTimes && timing && (timing.cv > 0.05 || timing.gaps > 0)) {
        warnings.push(`Metadata cadence is not uniform (CV ${(timing.cv * 100).toFixed(1)}%, `
            + `${timing.gaps} gap(s) over 3x the median interval). The fits assume an even `
            + `${fps.toFixed(2)} Hz, so every speed, acceleration and g-load is distorted across `
            + `the uneven stretches — read the kinematics with that in mind.`);
    }

    if (geoid && !isGeoidLoaded()) {
        warnings.push("The EGM96 geoid was not loaded, so MSL sensor altitudes were used as "
            + "ellipsoidal heights (up to ~100 m off, ~30 m in CONUS).");
    }

    // WHICH EARTH. LLAToECEF and ECEF2ENU_radii read the app's GLOBAL radii,
    // which `updateEarthRadii(useEllipsoid)` can switch to a sphere for a
    // legacy sitch. So the same file can convert differently depending on what
    // happens to be loaded, and calling the result WGS84 regardless would be a
    // false label. Record what was actually in force; the row reports it.
    const usingEllipsoid = Math.abs(Globals.equatorRadius - Globals.polarRadius) > 1;
    if (!usingEllipsoid) {
        warnings.push("The app is currently in SPHERICAL Earth mode, so this file's positions "
            + "were converted on a sphere rather than the WGS84 ellipsoid. Geometry will differ "
            + "from an ellipsoid run of the same file — switch the sitch to ellipsoid mode for "
            + "comparable numbers.");
    }

    // ECEF first, then a local ENU frame at the MEAN sensor position — the same
    // frame buildAnalysisDataset uses for a live sitch, so a dataset read here
    // and one read from the loaded file are in the same coordinates.
    const ecef = [];
    const headings = [];
    let mx = 0, my = 0, mz = 0;
    for (const u of kept) {
        let alt = u.altHAE;
        if (alt === null) {
            const nOff = (geoid && isGeoidLoaded()) ? meanSeaLevelOffset(u.lat, u.lon) : 0;
            alt = u.altMSL + (Number.isFinite(nOff) ? nOff : 0);
        }
        const p = LLAToECEF(u.lat, u.lon, alt);
        ecef.push(p);
        headings.push(misbSightlineHeading(p, u.angles));
        mx += p.x; my += p.y; mz += p.z;
    }
    mx /= n; my /= n; mz /= n;
    const [originLat, originLon] = ECEFToLLA_radii(mx, my, mz);

    const S = new Float64Array(n * 3);
    const D = new Float64Array(n * 3);
    const W = new Float64Array(n * 3);   // no wind source for a bare FMV file
    for (let f = 0; f < n; f++) {
        const pENU = ECEF2ENU_radii(ecef[f], originLat, originLon);
        S[f * 3] = pENU.x; S[f * 3 + 1] = pENU.y; S[f * 3 + 2] = pENU.z;
        const dENU = ECEF2ENU_radii(headings[f], originLat, originLon, true).normalize();
        D[f * 3] = dENU.x; D[f * 3 + 1] = dENU.y; D[f * 3 + 2] = dENU.z;
    }

    // Resolve the ground datum ONCE and remember whether the geoid was actually
    // available, so the manifest reports what was used rather than what was
    // wanted. Claiming "sea level via EGM96" after the grid failed to load
    // would describe a correction that never happened.
    let geoidN = 0;
    let geoidApplied = false;
    if (geoid && isGeoidLoaded()) {
        const nOff = meanSeaLevelOffset(originLat / DEG, originLon / DEG);
        if (Number.isFinite(nOff)) { geoidN = nOff; geoidApplied = true; }
    }

    const dataset = {n, fps, S, D, W, frame0: 0, frame1: n - 1};
    const quality = assessSourceQuality(dataset, {
        times: haveAllTimes ? times : null,
        declaredLosSigmaDeg: null,
        droppedRows: noPosition + noSightline,
    });

    return {
        kind: "fmv",
        label: label || "FMV clip",
        dataset,
        originLat, originLon,
        // GROUND, WITH THE DATUM SPELLED OUT. ECEF2ENU_radii puts the frame
        // origin at ALTITUDE 0 for the origin lat/lon — i.e. on the WGS84
        // ELLIPSOID — so Z = 0 in this dataset is the ellipsoid surface, not
        // mean sea level. The two differ by the geoid height N, which reaches
        // ~100 m globally and about -30 m over CONUS, so taking Z = 0 as "sea
        // level" would put the ground plane tens of metres out and could read a
        // genuinely low track as underground.
        //
        // There is still no terrain: this is sea level, which is right over
        // water and wrong by the local relief anywhere inland. That limitation
        // is reported on the row rather than assumed away — but the datum part
        // of it is free to get right.
        groundZ: geoidN,
        clipStartMs: haveEpoch ? clipStartS * 1000 : null,
        truth: null,
        labels: null,
        meta: {
            records: misb.length,
            usableRecords: n,
            completeRecords: complete.length,
            originLLA: [originLat / DEG, originLon / DEG, 0],
            epochISO: haveEpoch ? new Date(clipStartS * 1000).toISOString() : null,
            fovFullDeg: null,
            windEstimate: null,
            maxRangeM: null,
            timebase: chosenTimebaseNote || null,
            surfaceModel: (usingEllipsoid ? "" : "SPHERICAL Earth mode; ")
                + (geoidApplied
                    ? "sea level via EGM96 (no terrain)"
                    : "ellipsoid height (no terrain, geoid unavailable)"),
            earthModel: usingEllipsoid ? "WGS84 ellipsoid" : "sphere",
            geoidAppliedM: geoidApplied ? geoidN : null,
            hasSidecar: false,
        },
        quality,
        warnings,
    };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Ingest one queued entry.
 *
 * `entry` is {name, relativePath, getFile(), sidecarText?, labelsText?}. The
 * dialog pairs a BOT CSV with its sidecar during the folder walk, because the
 * sidecar is a sibling file and only the walk can see it.
 */
export async function ingestBotBenchEntry(entry) {
    const role = botBenchFileRole(entry.name);
    if (role === "fmv") {
        const file = await entry.getFile();
        const analysis = await analyzeVideoFileLike(file, {
            name: entry.name, relativePath: entry.relativePath, includeMisb: true,
        });
        if (analysis.status !== "ok") {
            throw new Error(analysis.message || `No MISB metadata in this ${analysis.container} file.`);
        }
        // The geoid is only needed for MSL sensor altitudes; load it lazily so a
        // BOT-only run never pays for it.
        try { await ensureGeoidLoaded(); } catch (e) { /* warned about in ingestMISBRecords */ }

        // WHICH METADATA STREAM. A transport stream can carry several, and
        // `selectedAnalysis` is the one AnalyzeVideoFile picked for TIMING
        // quality — most records, best severity. That is the right choice for
        // the FMV timing report and the wrong one here: the stream with the
        // cleanest timestamps need not be the stream carrying sensor position
        // and gimbal angles, and picking it made a file with perfectly good
        // pointing data on another PID fail with "no gimbal angles".
        //
        // So try the preferred stream first and fall back through the rest,
        // keeping the first that actually yields a dataset. The reasons the
        // others were rejected are kept, because "no stream had pointing data"
        // and "the pointing stream was 8 records long" are different problems.
        const candidates = [];
        if (analysis.selectedAnalysis) candidates.push(analysis.selectedAnalysis);
        for (const a of analysis.analyses ?? []) if (a !== analysis.selectedAnalysis) candidates.push(a);

        const rejected = [];
        for (const cand of candidates) {
            const misb = cand?.misb;
            if (!Array.isArray(misb) || !misb.length) {
                rejected.push(`PID ${cand?.pid ?? "?"}: no records returned`);
                continue;
            }
            try {
                const record = ingestMISBRecords(misb, {label: entry.relativePath || entry.name});
                if (candidates.length > 1) {
                    record.warnings.push(`This file has ${candidates.length} metadata stream(s); `
                        + `PID ${cand.pid ?? "?"} was used because it carries usable pointing data.`
                        + (rejected.length ? ` Rejected: ${rejected.join("; ")}.` : ""));
                }
                // Carry the FMV timing analysis through: it is the
                // source-quality measurement for this file type, and it is
                // already computed. It belongs to the SAME stream now.
                record.fmvSummary = cand.summary;
                record.fmvReport = cand.report;
                record.meta.klvPid = cand.pid ?? null;
                return record;
            } catch (e) {
                rejected.push(`PID ${cand.pid ?? "?"}: ${e.message}`);
            }
        }
        throw new Error(`No metadata stream in this file carries usable sensor position and `
            + `gimbal angles. ${rejected.join("; ")}`);
    }

    if (role === "bot-csv") {
        const file = await entry.getFile();
        const text = await file.text();
        let sidecar = null, labels = null;
        // A sidecar that EXISTS and cannot be used is a different thing from no
        // sidecar at all: the producer stated the frame and we failed to read
        // it. Treating the two alike quietly substituted the shipped set's
        // default site for whatever the file actually declares.
        //
        // PRESENCE IS TESTED AGAINST undefined, NOT TRUTHINESS. `sidecarText`
        // is undefined when the walk found no sidecar, and an EMPTY STRING when
        // it found an empty file — and `if (text)` cannot tell those apart, so
        // an empty sidecar silently became "no sidecar". Likewise a file
        // containing `null`, `false` or `0` parses successfully to a falsy
        // value, which every later `if (sidecar)` then read as absent.
        if (entry.sidecarText !== undefined && entry.sidecarText !== null) {
            let parsed;
            try {
                parsed = JSON.parse(entry.sidecarText);
            } catch (e) {
                throw new Error(`This scenario's .scenario.json could not be parsed `
                    + `(${e.message}). It states the coordinate frame, origin and rate, so it `
                    + `cannot be skipped — fix or remove it.`);
            }
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error(`This scenario's .scenario.json parsed to `
                    + `${Array.isArray(parsed) ? "an array" : JSON.stringify(parsed)} rather than `
                    + `an object, so it states no coordinate frame. Fix or remove it.`);
            }
            sidecar = parsed;
        }
        if (entry.labelsText) {
            try { labels = JSON.parse(entry.labelsText); } catch (e) { labels = null; }
        }
        return ingestBotCSV(text, {sidecar, labels, label: entry.relativePath || entry.name});
    }

    throw new Error(`Unsupported file type for BotBench: ${entry.name}`);
}
