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
import {trackFileFromCSVType, trackCSVConventions, detectCSVType} from "../TrackFiles/TrackCSV";
import {CTrackFileSRT} from "../TrackFiles/CTrackFileSRT";
import {CTrackFileSTANAG} from "../TrackFiles/CTrackFileSTANAG";
import {parseXml} from "../parseXml";
import csv from "../utils/CSVParser";
import {misbSightlineHeading} from "../MISBSightline";
import {assessLinearFitConditioning} from "../LOSFitting";
import {sensorMotionStats} from "../TraverseAnalysis";
import {ensureGeoidLoaded, isGeoidLoaded, meanSeaLevelOffset} from "../EGM96Geoid";
import {
    analyzeVideoFileLike, KLV_EXTENSIONS, TRANSPORT_STREAM_EXTENSIONS,
} from "./AnalyzeVideoFile";
import {
    longestUniformRun, maxOf, measureAnchorRate, median, timingStats, trimmedMean,
} from "./BotBenchClock";

const DEG = Math.PI / 180;

// Frame-center elevations needed before their median is trusted as the ground
// plane. Same threshold the truth track uses for "enough points to mean
// something": one or two centers in a long clip are as likely to be a producer
// emitting a stray row as they are to be a survey of the terrain.
const MIN_GROUND_SAMPLES = 5;

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
    // Non-CSV track containers the app imports and that can carry pointing.
    //
    // .srt IS A TRACK FORMAT HERE, not a subtitle one: a DJI sidecar carries
    // per-frame position, platform attitude and gimbal angles. The name alone
    // cannot tell that from an ordinary subtitle file, or from a drone sidecar
    // logging position only — so the WALK reads it before queuing it, which is
    // the one content check in an otherwise name-based sweep (srtHasPointing).
    if (ext === "srt") return "track-file";
    // .xml IS DELIBERATELY NOT WALKED. BOTBench reads it only as STANAG 4676,
    // and XML is a container a folder may hold for a hundred unrelated reasons
    // — build config, sidecar metadata, an export manifest. Queuing each one
    // would put a guaranteed error row in every run, which is the failure the
    // mp4/mov exclusion above already exists to prevent. A file the user
    // PICKED is a different statement of intent: see botBenchExplicitFileRole.
    return null;
}

/**
 * The role for a file the user selected BY HAND, which is a statement that
 * they mean this file — so formats too ambiguous to sweep a folder for are
 * accepted here, and refuse with a reason if they turn out to be something
 * else. A folder walk keeps using botBenchFileRole.
 */
export function botBenchExplicitFileRole(name = "") {
    const role = botBenchFileRole(name);
    if (role) return role;
    return /\.xml$/i.test(name) ? "track-file" : null;
}

/** `bot-0001` from `bot-0001.input.csv` — the key a sidecar is matched on. */
export function botBenchScenarioBase(name = "") {
    return String(name)
        .replace(/\.[^/.]+$/, "")
        .replace(/\.(input|truth|all|scenario)$/i, "");
}

/**
 * The keys that pair one walked file with its sidecars.
 *
 * The key is DIRECTORY + scenario base, never the base alone: a recursive walk
 * over a swept tree sees the same basename in every batch folder, and a
 * bare-name key would pair a scenario with another batch's frame origin — a
 * wrong answer that looks like a right one.
 *
 * TWO LAYOUTS ARE SUPPORTED.
 *   sibling  Input/x.input.csv + Input/x.scenario.json    (sealed releases)
 *   meta     Input/x.input.csv + meta/x.scenario.json     (the botset trees)
 *
 * A sidecar found inside a `meta/` directory describes the CSVs in that
 * directory's SIBLINGS, so it indexes one level up (`indexKey`). A CSV looks
 * up its own directory first and falls back to its parent (`altKey`). Both
 * keys still carry the full batch path, so the cross-batch collision the
 * directory scoping exists to prevent stays impossible.
 *
 * @param relativePath  path as the directory walk reported it, e.g.
 *                      "botset_mundane/batch_20s/5pct/All/x.all.csv"
 * @param name          the file's own name (defaults to the path's last segment)
 * @returns {{key, altKey, indexKey, dir, base, inMetaDir}}
 */
export function botBenchPairingKeys(relativePath = "", name = null) {
    const fileName = name ?? relativePath.replace(/^.*\//, "");
    const dir = relativePath.replace(/[^/]*$/, "");
    const parent = dir.replace(/[^/]+\/$/, "");
    const base = botBenchScenarioBase(fileName);
    const inMetaDir = /(^|\/)meta\/$/i.test(dir);
    return {
        dir, base, inMetaDir,
        key: dir + base,
        altKey: parent + base,
        indexKey: inMetaDir ? parent + base : dir + base,
    };
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


// ---------------------------------------------------------------------------
// Quality metrics
// ---------------------------------------------------------------------------




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
    if (q.conditioning === "poor") reasons.push("Constant Velocity (CV) family conditioning poor");
    else if (q.conditioning === "marginal") reasons.push("Constant Velocity (CV) family conditioning marginal");
    if (q.timeCv !== null && q.timeCv > 0.25) reasons.push("irregular sample timing");
    if (q.timeGaps > 0) reasons.push(`${q.timeGaps} timing gap(s)`);
    if (q.frameStated === false) reasons.push("coordinate frame/origin unstated (no sidecar)");

    const hard = reasons.some((r) => /fewer than|barely/.test(r));
    const grade = hard ? "weak" : q.conditioning === "poor" ? "hard"
        : q.conditioning === "marginal" ? "fair" : reasons.length ? "fair" : "good";
    return {grade, reasons};
}

/**
 * Mean angular residual a PERFECT track scores against white pointing noise.
 *
 * The per-frame pointing error is two independent Gaussians in the pan/tilt
 * tangent plane, so its MAGNITUDE is Rayleigh-distributed and its mean is
 * sigma*sqrt(pi/2) — not sigma, and not sigma*sqrt(2). This matters because it
 * is the only honest yardstick for a residual: a candidate at or below this
 * value is fitting the noise, and no candidate can beat it for an honest
 * reason.
 *
 * Checked against the ten real-arm scenarios, whose truth tracks carry their
 * own measured residual: predicted 0.0376 deg at the declared 0.03 deg sigma,
 * measured 0.0365 to 0.0401 across the nine white-noise files.
 *
 * It lives here rather than in the runner because it is a property of the
 * SOURCE DATA's declared error, alongside assessSourceQuality — the runner and
 * the notes both read it from here.
 */
export const RAYLEIGH_MEAN = Math.sqrt(Math.PI / 2);

// Standard deviation of the same Rayleigh magnitude, as a multiple of sigma.
// Used for the standard error of a residual MEAN over n frames, which sets the
// scale below which two candidates' residuals are not telling you anything.
export const RAYLEIGH_SD = Math.sqrt(2 - Math.PI / 2);

// Platform path shapes, in words. The generator's enum is hyphenated and reads
// as a code identifier; the table wants the thing a person would say.
const PLATFORM_WORDS = {
    "orbit-point": "orbits the target",
    "orbit-direction": "orbits a fixed bearing",
    "curve": "curving",
    "straight": "straight line",
    "s-curve-toward": "S-turns, toward",
    "s-curve-perp": "S-turns, across",
    "static": "stationary",
    "hover": "hovering",
};

/**
 * Two prose strings: what the TARGET was, and what the PLATFORM flew.
 *
 * WHAT THIS MAY AND MAY NOT READ. The generating spec on a label sidecar holds
 * `initialHorizontalRangeM`, which is the answer to the question the analysis is
 * being asked, so this reads a NAMED ALLOWLIST of fields and never the object.
 * Three rules decide what is on it:
 *
 *   safe      Anything a reader could already measure from the input CSV. The
 *             platform's kind, speed and altitude are all visible in the sensor
 *             columns, so naming them tells nobody anything new.
 *   safe      Categorical identity: target kind, family, editorial label, the
 *             anomalous flag, an event's family and onset time. None of these
 *             constrains range.
 *   NOT SAFE  Any target distance, altitude or speed. Target speed with a
 *             measured angular rate GIVES range, and target altitude with the
 *             platform's own altitude nearly does. So `startAGL`, `segmentKey`
 *             (which embeds startAGL), and every target speed field stay off
 *             this list. Adding one would leak the answer into a column that
 *             looks purely descriptive.
 *
 * Returns {} when the sidecar carries no spec, so a challenge file simply has
 * no description rather than a misleading partial one.
 */
function describeScene(labels) {
    const spec = labels?.provenance?.spec;
    if (!spec) return {};

    const out = {};

    const p = spec.platform;
    if (p?.kind) {
        const words = PLATFORM_WORDS[p.kind] ?? String(p.kind);
        // Speed and altitude are read straight off the sensor columns by any
        // reader, so quoting them costs nothing and saves a lookup.
        const bits = [];
        if (Number.isFinite(p.speedMS)) bits.push(`${Math.round(p.speedMS)} m/s`);
        if (Number.isFinite(p.altitudeAGL)) bits.push(`${Math.round(p.altitudeAGL)} m`);
        out.platformDescription = bits.length ? `${words}, ${bits.join(", ")}` : words;
    }

    const t = spec.target;
    if (t?.kind) {
        const tp = t.parameters ?? {};
        // The editorial label ("hover", "dash", "circuits") is the most
        // informative single word when there is one; the kind is the fallback.
        const head = typeof tp.label === "string" && tp.label ? tp.label : String(t.kind);
        const bits = [];
        if (t.family && t.family !== head) bits.push(String(t.family));
        // Which recorded flight the segment came from — identity, not geometry.
        const src = tp.source?.file;
        if (typeof src === "string") bits.push(src.replace(/\.[a-z]+$/i, ""));
        out.targetDescription = bits.length ? `${head} (${bits.join(", ")})` : head;
    }

    // Spliced events, by family and onset. An onset TIME is not a range, and
    // saying an impulse was injected at 30 s is exactly what makes a reader able
    // to check whether the analysis noticed it.
    //
    // SHAM SPLICES MUST NOT READ AS REAL ONES. The control member of a matched
    // pair carries a zero-magnitude event through the identical splice
    // machinery — that is the point of it, since a difference between the pair
    // then cannot be an artefact of splicing. But an undifferentiated "impulse
    // @ 30s" on the control row says the opposite of what is true, so the two
    // are labelled apart.
    const events = Array.isArray(labels.events) ? labels.events : [];
    if (events.length) {
        out.eventDescription = events.map((e) => {
            const fam = e.family ?? e.eventId ?? "event";
            const sham = e.anomalous === false || e.parameters?.spliced === false;
            const at = Number.isFinite(e.onsetSeconds) ? ` @ ${e.onsetSeconds}s` : "";
            return sham ? `sham ${fam}${at} (matched control)` : `${fam}${at}`;
        }).join("; ");
    }
    return out;
}

function fmtM(v) {
    if (!Number.isFinite(v)) return null;
    return v >= 10000 ? `${(v / 1000).toFixed(1)} km` : `${Math.round(v)} m`;
}

/**
 * The scenario's sidecars, as prose for the sitch Notes panel.
 *
 * WHY. Opening a scenario in Sitrec gives you tracks and nothing else — the
 * declared pointing error, the frame datum, the wind, the provenance seal and
 * (on an answers file) what the object actually was all live in JSON sidecars
 * the app's importer has no route for. Without them a reader is looking at
 * lines in space with no idea what they were told about them.
 *
 * THE ANSWER KEY IS SECTIONED AND LABELLED, never mixed into the description.
 * It is included only when a truth sidecar is present — a challenge file has
 * no answer to leak — and on such a file the truth track is already drawn in
 * the scene, so withholding the number that describes it would be theatre
 * rather than blinding. The separation is so that nobody quotes an answer-key
 * figure believing it came from the measurement.
 *
 * @param sidecar   parsed <name>.scenario.json, or null
 * @param labels    parsed <name>.truth.json, or null
 * @param fileName  the CSV the notes accompany
 */
export function buildScenarioNotes(sidecar, labels, fileName = "") {
    const L = [];
    const id = sidecar?.trackId ?? labels?.trackId ?? fileName;
    L.push(`BOT SCENARIO — ${id}`);

    const scene = describeScene(labels);
    if (scene.targetDescription || scene.platformDescription) {
        L.push("");
        L.push("WHAT THIS IS");
        if (scene.targetDescription) L.push(`  Target:    ${scene.targetDescription}`);
        if (scene.platformDescription) L.push(`  Platform:  ${scene.platformDescription}`);
        if (scene.eventDescription) L.push(`  Events:    ${scene.eventDescription}`);
        if (labels?.anomalous) {
            L.push("  DECLARED ANOMALOUS — no conventional model is expected to fit, so");
            L.push("  \"unresolved\" is the correct outcome here and not a failure.");
        }
    }

    L.push("");
    L.push("MEASUREMENT");
    const n = sidecar?.frameCount, dur = sidecar?.durationSeconds, fps = sidecar?.nominalFps;
    if (Number.isFinite(n)) {
        L.push(`  ${n} samples`
            + (Number.isFinite(dur) ? ` over ${dur} s` : "")
            + (Number.isFinite(fps) ? ` at ${fps}/s` : ""));
    }
    const le = sidecar?.losError;
    if (le) {
        const sig = Number.isFinite(le.sigmaDeg) ? le.sigmaDeg : null;
        L.push(`  Pointing error: ${le.model ?? "unstated"}`
            + (sig !== null ? `, ${sig}°` : ""));
        if (le.note) L.push(`    ${le.note}`);
        // The single most useful thing a reader can be told about a residual,
        // and it is not derivable from anything else on screen.
        if (sig !== null && !le.correlated) {
            L.push(`  A PERFECT track scores ${(sig * RAYLEIGH_MEAN).toFixed(4)}° mean residual `
                + `against this noise`);
            L.push(`  (sigma x 1.2533, because the error is two Gaussians in the tangent plane).`);
            L.push(`  A fit at or below that is fitting the noise, not the object.`);
        } else if (sig !== null && le.correlated) {
            L.push(`  CORRELATED error: ${sig}° is a deadband AMPLITUDE, not a standard`);
            L.push(`  deviation, so it does not convert to a residual floor.`);
        }
    }
    if (Number.isFinite(sidecar?.sensor?.fovFullDeg)) {
        L.push(`  Sensor field of view: ${sidecar.sensor.fovFullDeg}°`);
    }
    const w = sidecar?.wind ?? labels?.windTruth;
    if (w) {
        L.push(`  Wind: ${w.kind ?? "declared"}`
            + (Number.isFinite(w.sigmaMS) ? `, sigma ${w.sigmaMS} m/s` : ""));
    }

    const fr = sidecar?.frame;
    if (fr) {
        L.push("");
        L.push("FRAME");
        if (Array.isArray(fr.originLLA)) {
            L.push(`  ${fr.type ?? "ENU"} about ${fr.originLLA[0]}, ${fr.originLLA[1]}`
                + `, ground ${fr.groundElevationMSL ?? 0} m MSL`);
        }
        L.push(`  ${fr.surfaceModel ?? "flat-plane"}, ${fr.ellipsoid ?? "WGS84"}`);
        if (sidecar?.epochISO) L.push(`  Epoch ${sidecar.epochISO}`);
    }

    if (labels) {
        L.push("");
        L.push("ANSWER KEY — declared by the scenario, NOT measured from the sightlines.");
        L.push("The truth track is drawn in the scene, so these describe what you can see.");
        const bits = [];
        if (labels.truthKind) bits.push(`truth ${labels.truthKind}`);
        if (labels.objectClass) bits.push(`class ${labels.objectClass}`);
        if (labels.targetKind) bits.push(labels.targetKind);
        if (bits.length) L.push(`  ${bits.join(", ")}`);
        const r0 = labels.provenance?.spec?.initialHorizontalRangeM;
        if (Number.isFinite(r0)) L.push(`  Initial horizontal range: ${fmtM(r0)}`);
        const rn = labels.realizedNoise;
        if (Number.isFinite(rn?.meanDeg)) {
            L.push(`  Truth's own mean LOS residual, as realised: ${rn.meanDeg.toFixed(4)}°`);
        }
        const g = labels.geometry;
        if (g) {
            if (Number.isFinite(g.sensorSpanM)) {
                L.push(`  Sensor baseline ${fmtM(g.sensorSpanM)}`
                    + (Number.isFinite(g.losSweepDeg) ? `, LOS sweep ${g.losSweepDeg.toFixed(2)}°` : ""));
            }
            if (g.cvConditioningBucket) L.push(`  CV conditioning: ${g.cvConditioningBucket}`);
        }
    }

    const p = labels?.provenance;
    const seal = sidecar?.seal;
    if (p || seal) {
        L.push("");
        L.push("PROVENANCE");
        if (p?.generator) {
            L.push(`  ${p.generator} ${p.generatorVersion ?? ""}`.trimEnd()
                + (p.scenarioId ? `, scenario ${p.scenarioId}` : "")
                + (Number.isFinite(p.scenarioSeed) ? `, seed ${p.scenarioSeed}` : ""));
        }
        const src = p?.spec?.target?.parameters?.source;
        if (src?.file) L.push(`  Source recording: ${src.file}`
            + (src.rule ? ` (${src.rule})` : ""));
        // Truncated: the point of showing it is that a reader can check a file
        // is the one a result was quoted against, and 12 hex digits does that.
        if (seal?.inputCsvSha256) {
            L.push(`  Input CSV sha256: ${String(seal.inputCsvSha256).slice(0, 12)}…`);
        }
    }
    return L.join("\n");
}

/**
 * What the PLATFORM flew, measured rather than declared.
 *
 * The fallback for every file with no label sidecar — FMV, challenge sets,
 * anything third-party. `straightness` is the sensor's straight-line span over
 * its travelled path, so it separates the shapes on its own: 1.0 is a straight
 * run, and a closed orbit drives it toward zero because the path grows while
 * the span does not. The sweep distinguishes a single curve from a full circuit.
 */
export function describeMeasuredPlatform(q) {
    if (!q || !Number.isFinite(q.straightness)) return null;
    const s = q.straightness;
    const sweep = q.sweepPathDeg ?? 0;
    if (!(q.sensorSpanM > 100) && !(q.sensorPathM > 100)) return "stationary";
    if (s > 0.98) return "straight line";
    if (s < 0.45) return sweep > 300 ? "orbit (closed)" : "orbit (partial)";
    if (s < 0.9) return "curving";
    return "near-straight";
}

// ---------------------------------------------------------------------------
// BOT interchange
// ---------------------------------------------------------------------------

const BOT_COLS = {
    trackId: ["TrackID"], time: ["Time"],
    sensorX: ["SensorPositionX"], sensorY: ["SensorPositionY"], sensorZ: ["SensorPositionZ"],
    losX: ["LOSUnitVectorX"], losY: ["LOSUnitVectorY"], losZ: ["LOSUnitVectorZ"],
    maxRange: ["MaxRange"], losUncertainty: ["LOSUncertainty"],
    // v1.2. UPPER BOUND on the target's observed angular diameter, degrees. A
    // measurement, not truth: with a minimum plausible diameter for an assumed
    // object class it gives a range FLOOR (R >= D_min / theta_max), which is the
    // only quantity in the file that opposes the scale degeneracy of
    // bearings-only geometry. Absent in v1.1 files, which is why it is optional.
    angularDiameterMax: ["AngularDiameterMaxDeg"],
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
            angDiaMax: idx.angularDiameterMax === -1 ? NaN
                : cell(r[idx.angularDiameterMax]),
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
        warnings.push(`Sample timing is not uniform (intervals vary by `
            + `${(timing.cv * 100).toFixed(1)}% of their mean, ${timing.gaps} gap(s)). The fits `
            + `assume an even sample rate of ${fps.toFixed(3)} Hz, so speeds, accelerations and `
            + `g-loads are distorted wherever the real spacing differs.`);
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

    // MEDIAN, not mean: the bound's floor is one IFOV, so a clip whose target
    // recedes past the resolution limit has a long flat tail that a mean would
    // let dominate. Null when the column is absent (a v1.1 file) or entirely
    // blank (a scenario that declares no target size) — those are different from
    // a bound of zero and must not be reported as one.
    //
    // Taken over `kept`, NOT `parsed`: the same reason the direction truth
    // above is gathered by origIndex. `parsed` still holds rows that were
    // dropped as invalid, rows belonging to another TrackID, and rows outside
    // the longest uniform run. A median over those describes data the analysis
    // never saw, and it reaches the reader as an implied object size and as the
    // size term of the ordinariness score.
    const angDiaSamples = kept.map((r) => r.angDiaMax).filter(Number.isFinite)
        .sort((a, b) => a - b);
    const medianAngularDiameterMax = angDiaSamples.length
        ? angDiaSamples[Math.floor(angDiaSamples.length / 2)] : null;

    // The angular measurement rides on the DATASET, not only on meta, because
    // the traverse analysis is handed a dataset and nothing else. Absent on a
    // v1.1 file, and every consumer must treat it as optional.
    dataset.angularDiameterMaxDeg = medianAngularDiameterMax;
    dataset.fovFullDeg = sidecar?.sensor?.fovFullDeg ?? null;
    dataset.pixelsAcross = sidecar?.sensor?.pixelsAcross ?? null;

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
            // Two PROSE strings saying what the object and the platform were
            // doing, so a reader can judge a verdict against the answer instead
            // of decoding a filename. Built by describeScene from a per-field
            // allowlist — see the warning on that function about which fields
            // are and are not safe to put in front of a reader.
            ...describeScene(labels),
        } : null,
        meta: {
            trackId: sidecar?.trackId ?? ids[0] ?? null,
            // Human-meaningful scenario name, carried only by answer-key
            // (All/) sidecars of a sealed release; null for challenge files.
            descriptiveName: typeof sidecar?.descriptiveName === "string"
                ? sidecar.descriptiveName : null,
            siteElevationMSL,
            originLLA: [oLat, oLon, oAlt],
            epochISO: sidecar?.epochISO ?? BOT_DEFAULT_EPOCH_ISO,
            fovFullDeg: sidecar?.sensor?.fovFullDeg ?? null,
            // Frame width the angular bound was computed against. Needed to
            // read how tight that bound is: its floor is one IFOV.
            pixelsAcross: sidecar?.sensor?.pixelsAcross ?? null,
            // Median of the per-frame angular-diameter bound, or null on a v1.1
            // file that has no such column. A single number because the bound
            // is what it is for the whole clip; per-frame values live on the
            // dataset for anything that needs them.
            angularDiameterMaxDeg: medianAngularDiameterMax,
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
 * THE OTHER POINTING CONVENTION: THE FRAME CENTER.
 *
 * A large family of MISB exports carries no platform attitude and no gimbal
 * angles at all — pointing is stated as the geodetic point the optical axis
 * lands on (ST 0601 tags 23/24 plus 25 or 78). The app already treats that as
 * pointing: CTrackFileMISB derives a "Center" track from those columns and the
 * camera looks along it. Refusing it here made BOTBench unable to analyse
 * files the app opens without complaint.
 *
 * The sightline is then sensor -> frame center, which is the boresight BY
 * DEFINITION of what a frame center is. What it is NOT is an independent
 * measurement: the producer computed it by intersecting the boresight with
 * ITS terrain model, so the direction inherits that model's error, and the
 * error is CORRELATED with the geolocation solution rather than independent
 * of it. A 100 m elevation error at 5 km slant range tilts the sightline by
 * about a degree — small in absolute terms, systematic in character, and not
 * the same kind of quantity as a gimbal encoder reading. Callers are told so.
 *
 * AN ALTITUDE IS REQUIRED, NOT DEFAULTED. Lat/lon alone place the center
 * somewhere on a vertical line, and picking a height for it (sea level, say)
 * would invent the elevation angle outright — the one component the caller
 * most wants measured. Tag 78 (already ellipsoidal) wins over tag 25 (MSL)
 * for the same reason SensorEllipsoidHeight wins over SensorTrueAltitude.
 *
 * @returns {lat, lon, altHAE, altMSL} or null when the row cannot state one
 */
function misbFrameCenter(row) {
    const lat = row?.[MISB.FrameCenterLatitude];
    const lon = row?.[MISB.FrameCenterLongitude];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const hae = row[MISB.FrameCenterHeightAboveEllipsoid];   // tag 78, HAE
    const msl = row[MISB.FrameCenterElevation];              // tag 25, MSL
    if (Number.isFinite(hae)) return {lat, lon, altHAE: hae, altMSL: null};
    if (Number.isFinite(msl)) return {lat, lon, altHAE: null, altMSL: msl};
    return null;
}

/** Whether the row states a frame center position at all (altitude aside). */
function misbHasFrameCenterLL(row) {
    return Number.isFinite(row?.[MISB.FrameCenterLatitude])
        && Number.isFinite(row?.[MISB.FrameCenterLongitude]);
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
/**
 * An epoch timestamp in SECONDS, from whatever representation the producing
 * importer used: KLV stores MICROSECONDS (ST 0601 tag 2), Airdata builds a
 * Date OBJECT, and the MISB CSV importer passes the file's numbers through
 * VERBATIM — real MISB CSVs carry microseconds, but nothing enforces it.
 * So normalize per VALUE and never trust a per-format label (a static
 * "CSV = milliseconds" declaration turned a real MISB fixture's 0.2 s
 * cadence into 200 s).
 *
 * A number is accepted only when EXACTLY one unit interpretation lands in a
 * plausible sensor-data era (1980-2100): the era is ~13x wide but the units
 * are 1000x apart, so the three acceptance windows cannot overlap, and any
 * value between them returns NaN instead of being misread — a 1971
 * microsecond stamp falls in the gap below the milliseconds window and
 * fails loud rather than ingesting 1000x wrong. Date objects are
 * unit-unambiguous and pass through regardless of era.
 */
const EPOCH_ERA_MIN = Date.UTC(1980, 0, 1) / 1e3;
const EPOCH_ERA_MAX = Date.UTC(2100, 0, 1) / 1e3;
export function epochStampSeconds(v) {
    if (v instanceof Date) return v.getTime() / 1e3;
    if (!Number.isFinite(v)) return NaN;
    for (const div of [1, 1e3, 1e6]) {          // seconds, ms, µs
        const s = v / div;
        if (s >= EPOCH_ERA_MIN && s <= EPOCH_ERA_MAX) return s;
    }
    return NaN;     // no unit reading lands in the era — refuse, don't guess
}

/**
 * The MISB rows a track file offers a SIGHTLINE consumer, given its format's
 * pointing convention. Formats that state the sightline as its two ENDS
 * (STANAG's platform + ground positions) pair them per track point; every
 * other format's track 0 already carries whatever pointing it has.
 *
 * This is where "multi-role" stops meaning "ambiguous". A STANAG file draws
 * as two or three tracks in the app, and BOTBench used to refuse it for that
 * reason — but the roles are not competing candidates for "the sensor", they
 * are the two ends of one ray plus the producer's estimate on it, and which
 * is which is stated by the format.
 */
function sightlineMISB(trackFile, conv) {
    return conv.pointing === "endpoints"
        ? trackFile.toSightlineMISB()
        : trackFile.toMISB(0);
}

/**
 * Ingest ANY Sitrec-loadable track file that carries camera pointing —
 * MISB-column CSVs (gimbal angles OR frame-center), Airdata drone logs, DJI
 * SRT sidecars, STANAG 4676 — through the SAME parsers the live import uses,
 * then the same sightline/clock pipeline as FMV. Position-only tracks refuse
 * with the reason: BOTBench needs, at minimum, a sensor track and a sensor
 * line of sight.
 *
 * @param made  {trackFile, pointing, multiRole} — the shape
 *              trackFileFromCSVType returns, so every format reaches the
 *              pipeline through one door
 */
function ingestTrackFile(made, {label = "", geoid = true, type = ""} = {}) {
    const misb = sightlineMISB(made.trackFile, made);
    if (!misb || !misb.length) {
        throw new Error(made.pointing === "endpoints"
            ? `This ${type} file parsed, but no track point carries BOTH ends of the sensor `
              + `line of sight (the platform and ground positions). A target-only STANAG track `
              + `is a position track with no sightline — it could serve as a truth reference, `
              + `but not as the sensor.`
            : `This ${type} file parsed but contained no usable track rows.`);
    }
    const record = ingestMISBRecords(misb, {
        label, geoid,
        boresightPointing: made.pointing === "boresight",
    });
    record.meta.sourceFormat = type;
    if (made.pointing === "endpoints") {
        record.warnings.push(`This ${type} file states its sightline as the two ENDS of the `
            + `ray (the platform and ground positions of each track point), so the sensor `
            + `position and its aim point are both measured rather than reconstructed from `
            + `angles. Its THIRD position — the producer's own target estimate — lies ON `
            + `that same ray, so it is a solution and not an independent observation; it is `
            + `deliberately not scored here as truth.`);
    }
    return record;
}

export function ingestGenericTrackCSV(text, {label = "", geoid = true} = {}) {
    const rows = csv.toArrays(String(text));
    const type = detectCSVType(rows);
    // Judge the TYPE before parsing the file: several parsers legitimately
    // touch scene state, which a file we are about to refuse must not
    // trigger — and the refusal reasons are properties of the format anyway.
    const conv = trackCSVConventions(type);
    if (!conv) {
        throw new Error(`This CSV is not a track file Sitrec recognises (detected: `
            + `${type}). BOTBench needs a sensor track with camera pointing — a BOT `
            + `interchange CSV, an Airdata drone log, a STANAG 4676 CSV, or a `
            + `MISB-column CSV.`);
    }
    if (conv.pointing === "none") {
        throw new Error(`This ${type} track is position-only — it carries no camera `
            + `pointing, so there are no lines of sight to analyse. It could serve as `
            + `a truth reference, but not as the sensor.`);
    }
    return ingestTrackFile(trackFileFromCSVType(type, rows), {label, geoid, type});
}

/**
 * A DJI-style SRT sidecar: drone position plus platform attitude and gimbal
 * angles, which is a complete gimbal-pointing sightline. Same parser the app
 * uses (CTrackFileSRT), so the two cannot drift.
 */
/**
 * Whether an .srt carries camera POINTING, not just position.
 *
 * A folder walk decides what to queue from the FILENAME, which is right for
 * every other format here — but ".srt" names both a drone telemetry sidecar
 * and an ordinary subtitle file, and even a genuine DJI sidecar often carries
 * position with no gimbal angles at all (data/test/DJI_20231217152755_0007_D.SRT
 * is exactly that). Queuing those puts a guaranteed error row in every bulk
 * run, which is the noise the .xml exclusion already exists to prevent.
 *
 * So this one extension is judged on CONTENT. It parses with the same parser
 * the ingest uses, so the walk's answer and the ingest's answer cannot
 * disagree. A file the user picked BY HAND skips this entirely: there the
 * refusal is the answer they asked for.
 */
export function srtHasPointing(text) {
    try {
        const misb = new CTrackFileSRT(String(text)).toMISB(0);
        return Array.isArray(misb) && misb.some(misbHasSightline);
    } catch (e) {
        return false;
    }
}

export function ingestSRT(text, {label = "", geoid = true} = {}) {
    const trackFile = new CTrackFileSRT(String(text));
    if (!trackFile.doesContainTrack()) {
        throw new Error("This .srt file holds no track points Sitrec can read — a track SRT "
            + "carries per-frame latitude, longitude, altitude and gimbal angles, and an "
            + "ordinary subtitle file carries none of them.");
    }
    return ingestTrackFile({trackFile, pointing: "gimbal", multiRole: false},
        {label, geoid, type: "SRT"});
}

/**
 * A STANAG 4676 XML track. The CSV flavour arrives through
 * ingestGenericTrackCSV; both end up in the same place, because the two
 * containers share CTrackFileSTANAGBase.
 */
export function ingestSTANAGXML(text, {label = "", geoid = true} = {}) {
    const trackFile = new CTrackFileSTANAG(parseXml(String(text)));
    if (!trackFile.doesContainTrack()) {
        throw new Error("This XML is not a STANAG 4676 track message (no message/track "
            + "element with usable track points). BOTBench reads XML only as STANAG 4676.");
    }
    return ingestTrackFile({trackFile, pointing: "endpoints", multiRole: true},
        {label, geoid, type: "STANAG_XML"});
}

export function ingestMISBRecords(misb, {label = "", geoid = true,
    boresightPointing = false} = {}) {
    const warnings = [];
    const usable = [];
    let noSightline = 0, noPosition = 0, noRoll = 0, boresightRows = 0;
    // Frame-center pointing: rows that used it, and rows that STATED a center
    // but gave it no height — a distinct failure worth naming, because the fix
    // is one column rather than a different file.
    let centerRows = 0, centerNoAlt = 0;

    // Per-record PES PTS, paired by index with the MISB array (MISBUtils sets it
    // on the array itself when the TS demuxer supplied PES entries).
    const pesPTS = Array.isArray(misb.pesPTSus) && misb.pesPTSus.length === misb.length
        ? misb.pesPTSus : null;
    // When the no-timeline refusal fires, the difference between "no stamps at
    // all" and "stamps present but unclassifiable" is the whole diagnosis —
    // the latter names a relative clock, a spreadsheet date serial, or a
    // mangled export, and showing one raw value lets the user see which.
    let stampsUnclassifiable = 0;
    let stampSample = null;
    let rowIndex = -1;
    for (const row of misb) {
        rowIndex++;
        if (!row) continue;
        const lat = row[MISB.SensorLatitude];
        const lon = row[MISB.SensorLongitude];
        const hae = row[MISB.SensorEllipsoidHeight];
        const msl = row[MISB.SensorTrueAltitude];
        const rawStamp = row[MISB.UnixTimeStamp];
        const t = epochStampSeconds(rawStamp);
        if (rawStamp !== null && rawStamp !== undefined && !Number.isFinite(t)) {
            stampsUnclassifiable++;
            if (stampSample === null) stampSample = rawStamp;
        }
        // Skipped, not held. The run selector below judges continuity on the
        // TIMESTAMPS, so a missing record shows up as a jump in time whether or
        // not anything stands in for it — which is just as well, because a KLV
        // stream that drops packets has no placeholder to offer.
        if (!Number.isFinite(lat) || !Number.isFinite(lon)
            || (!Number.isFinite(hae) && !Number.isFinite(msl))) { noPosition++; continue; }
        // Boresight-pointing formats (Airdata): the importer BUILDS the
        // platform frame as the pointing frame (drone heading + gimbal
        // pitch) and leaves the sensor-relative angles empty on purpose.
        // With the full platform triple present and BOTH relative angles
        // absent, the sightline is the platform's forward axis — relative
        // az/el zero by that format's own convention, never as a guess.
        const hasAngles = misbHasSightline(row);
        const boresightRow = boresightPointing && !hasAngles
            && Number.isFinite(row[MISB.PlatformHeadingAngle])
            && Number.isFinite(row[MISB.PlatformPitchAngle])
            && Number.isFinite(row[MISB.PlatformRollAngle])
            && !Number.isFinite(row[MISB.SensorRelativeAzimuthAngle])
            && !Number.isFinite(row[MISB.SensorRelativeElevationAngle]);
        // THE FRAME CENTER IS TWO DIFFERENT FACTS AT ONCE, and this file used
        // to read it as only one of them. It can be the POINTING (below), and
        // it is always a HEIGHT the producer measured for the ground under the
        // optical axis — the only terrain measurement an FMV file carries.
        // Read once, unconditionally, so a clip that points by gimbal angles
        // still contributes its ground samples: truck.ts is exactly that file,
        // and its FrameCenterElevation column reads 1867 m over Cheyenne while
        // the ingest was calling the ground sea level.
        const frameCenter = misbFrameCenter(row);
        // ANGLES FIRST, CENTER SECOND. When a row carries both, the gimbal
        // angles are the measurement and the frame center is derived FROM
        // them through the producer's terrain model — so the angles are the
        // shorter path to the same direction, with one less model in it.
        let centerLLA = null;
        if (boresightRow) boresightRows++;
        else if (!hasAngles) {
            centerLLA = frameCenter;
            if (!centerLLA) {
                if (misbHasFrameCenterLL(row)) centerNoAlt++; else noSightline++;
                continue;
            }
            // A center at the sensor's own position states no direction. This
            // is not the nadir case — straight down has the same lat/lon but a
            // different height, and survives.
            const centerAlt = centerLLA.altHAE ?? centerLLA.altMSL;
            if (centerLLA.lat === lat && centerLLA.lon === lon
                && centerAlt === (Number.isFinite(hae) ? hae : msl)) { noSightline++; continue; }
            centerRows++;
        }
        // Only meaningful where the sensor MATRIX builds the direction. A
        // frame-center row derives its direction from two positions, so a
        // missing roll there is not a defaulted value, it is an unused one.
        if (!centerLLA && !Number.isFinite(row[MISB.SensorRelativeRollAngle])) noRoll++;
        // Truth columns (truth_lat/truth_long/truth_alt in the client files,
        // mapped to the Truth tags by parseMISB1CSV). All three are required:
        // a truth point without an altitude cannot be placed in 3D, and
        // guessing one would corrupt the very reference errors are scored
        // against. truth_alt carries no units label in the source CSV;
        // observed client data is in FEET, so feet is the app's default
        // interpretation (CTrackFileMISB._truthTrackMISB has a per-track GUI
        // switch to meters — bulk ingest has no switch, so it applies the
        // same default and says so in a warning).
        const truthLat = row[MISB.TruthLatitude];
        const truthLon = row[MISB.TruthLongitude];
        const truthAlt = row[MISB.TruthAltitude];
        // Same {lat, lon, altHAE, altMSL} shape as the sensor and frame-center
        // positions, so the one datum resolver below handles all three. There
        // is no HAE variant of TruthAltitude, hence altHAE: null.
        const truthLLA = Number.isFinite(truthLat) && Number.isFinite(truthLon)
            && Number.isFinite(truthAlt)
            ? {lat: truthLat, lon: truthLon, altHAE: null, altMSL: truthAlt * 0.3048}
            : null;
        usable.push({
            truthLLA,
            // Already normalized to SECONDS by epochStampSeconds — see it
            // for why per-value normalization beats any per-format label.
            t,
            // PES PTS for the SAME record, when the demuxer supplied it. This is
            // the SYNCHRONOUS timebase — locked to the encoder's clock — and on
            // a stream whose UnixTimeStamp is absent or erratic it is the better
            // one. Without it such a file fell back to "assume 30 Hz", which is
            // a guess presented as a measurement.
            pts: Number.isFinite(pesPTS?.[rowIndex]) ? pesPTS[rowIndex] / 1e6 : NaN,
            lat, lon,
            altHAE: Number.isFinite(hae) ? hae : null,
            altMSL: Number.isFinite(hae) ? null : msl,
            // EXACTLY ONE of these two is set, and which one names the
            // pointing convention this row used. The ECEF pass below reads
            // `angles` first and falls to `centerLLA`, so a row can never
            // silently get a direction from a source it did not declare.
            //
            // The whole platform triple and the gimbal az/el are guaranteed
            // finite by misbHasSightline. ONLY sensorRoll falls back to 0, and
            // only because it is the final rotation about the boresight, which
            // leaves the pointing direction untouched.
            angles: centerLLA ? null : {
                platformHeading: row[MISB.PlatformHeadingAngle],
                platformPitch: row[MISB.PlatformPitchAngle],
                platformRoll: row[MISB.PlatformRollAngle],
                sensorAz: boresightRow ? 0 : row[MISB.SensorRelativeAzimuthAngle],
                sensorEl: boresightRow ? 0 : row[MISB.SensorRelativeElevationAngle],
                sensorRoll: Number.isFinite(row[MISB.SensorRelativeRollAngle])
                    ? row[MISB.SensorRelativeRollAngle] : 0,
            },
            centerLLA,
            // The same point again, kept whatever supplied the pointing —
            // here it is an ELEVATION SAMPLE, not a direction. Null on rows
            // that state no frame center, or state one with no height.
            groundLLA: frameCenter,
        });
    }

    if (boresightRows) {
        warnings.push(`${boresightRows} record(s) use BORESIGHT pointing: this format's `
            + `importer builds the platform frame as the pointing frame (e.g. Airdata's `
            + `drone heading + gimbal pitch) and carries no sensor-relative angles, so the `
            + `sightline is the platform's forward axis by the format's own convention.`);
    }
    if (centerRows) {
        warnings.push(`${centerRows} record(s) point by FRAME CENTER: they carry no platform `
            + `attitude or gimbal angles, so the sightline is the direction from the sensor to `
            + `the stated frame-center position — the boresight by definition. Note what that `
            + `direction is made of: the producer computed the center by intersecting the `
            + `boresight with ITS terrain model, so the elevation angle inherits that model's `
            + `error instead of coming from an encoder, and the error is correlated with the `
            + `geolocation solution rather than independent of it. At a 5 km slant range a 100 m `
            + `terrain error is about a degree of tilt.`);
    }
    if (centerNoAlt) {
        warnings.push(`${centerNoAlt} record(s) state a frame-center latitude and longitude but `
            + `no height for it (neither FrameCenterElevation nor FrameCenterHeightAboveEllipsoid), `
            + `so the center sits somewhere on a vertical line and the sightline's ELEVATION `
            + `angle is unknown. Choosing a height would invent exactly the component being `
            + `measured, so those records were dropped instead.`);
    }
    if (noPosition) warnings.push(`${noPosition} record(s) had no usable sensor position.`);
    if (noSightline) {
        warnings.push(`${noSightline} record(s) were dropped for incomplete pointing — a sightline `
            + `needs EITHER SensorRelativeAzimuth/Elevation AND the full PlatformHeading/Pitch/Roll `
            + `triple, OR a frame-center position (lat, lon and a height). None of the three angles `
            + `is assumed: platform roll re-orients the axes the gimbal angles are measured about, `
            + `so assuming level flight would swing every sightline that points away from straight `
            + `ahead.`);
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

    // NAME THE COLUMN THAT IS ACTUALLY MISSING.
    //
    // Every refusal below this point is about TIMING, and with fewer than two
    // surviving records they all fire — the clock trials need two records to
    // measure an interval, so an EMPTY array reports "this clip carries no
    // timing" no matter how good its timestamps are. A file whose only fault
    // was an unrecognised pointing convention therefore sent the reader after
    // the one column that was fine. Rows are only ever dropped above for
    // POSITION or POINTING, so that is what the message says.
    if (complete.length < 2) {
        const why = [];
        if (noPosition) why.push(`${noPosition} had no usable sensor position`);
        if (noSightline) why.push(`${noSightline} had no camera pointing (neither the gimbal `
            + `az/el plus platform attitude triple, nor a frame-center position)`);
        if (centerNoAlt) why.push(`${centerNoAlt} stated a frame center with no height for it, `
            + `which leaves the sightline's elevation angle unknown`);
        throw new Error(`Only ${complete.length} of ${misb.length} record(s) carry both a sensor `
            + `position and a sightline, so there is nothing to analyse — this is a POINTING or `
            + `POSITION problem, not a timing one`
            + (why.length ? `: ${why.join("; ")}.` : `.`)
            + ` BOTBench needs, per record, a sensor position plus either gimbal angles or a `
            + `frame-center position to aim at.`);
    }

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
        if (complete.filter((rec) => Number.isFinite(get(rec))).length < 2) return null;
        const trial = longestUniformRun(complete, get);
        if (trial.degenerateClock || !trial.items.length) return null;
        return {get, kept: trial.items.length};
    };
    const utsTrial = trialOf((rec) => rec.t);
    const ptsTrial = trialOf((rec) => rec.pts);

    // COMPARE TYPICAL STEP SIZES, NOT TYPICAL STEP RATIOS.
    //
    // Two wrong measurements preceded this one:
    //
    //   RATIO OF ENDPOINT SPANS  is destroyed by a single discontinuity. One
    //     GPS relock adds its whole offset to the wall-clock span, and a
    //     healthy PES timeline is rejected on the strength of one bad sample.
    //
    //   MEDIAN OF PER-STEP RATIOS  is robust to outliers but BIASED by jitter,
    //     because E[1/x] != 1/E[x]. A correct 10 Hz wall clock dithering
    //     0.09/0.11 s against an exact PES 0.1 s yields per-step ratios of
    //     1.111 and 0.909 — and any asymmetry in how they fall pushes the
    //     median off 1.0 and starts reporting a rate disagreement that does
    //     not exist.
    //
    //   MEDIAN OF EACH CLOCK'S STEPS  removes that bias but inherits another:
    //     the median of a BIMODAL series is one of its two modes. The same
    //     0.09/0.1101 clock has median step 0.09 and is reported at 11.1 Hz.
    //
    // A rate is an average, so use a TRIMMED MEAN of each clock's own steps and
    // divide those: robust to each clock's outliers, unbiased for the quantity
    // actually being measured, and jitter cancels instead of accumulating.
    const dU = [], dP = [];
    for (let i = 1; i < complete.length; i++) {
        const prev = complete[i - 1], rec = complete[i];
        const du = rec.t - prev.t, dp = rec.pts - prev.pts;
        if (Number.isFinite(du) && Number.isFinite(dp) && du > 0 && dp > 0) {
            dU.push(du); dP.push(dp);
        }
    }
    // Enough overlapping steps to tell a RATE ERROR from JITTER. Five is not:
    // on a handful of samples the spread of ordinary dither is comparable to
    // the 2% band below, so a verdict either way is noise. Below this the
    // ratio is reported as unknown, which already has its own branch and its
    // own honest message.
    const RATIO_MIN_STEPS = 20;
    const ratioKnown = dU.length >= RATIO_MIN_STEPS;
    const medU = ratioKnown ? trimmedMean(dU) : NaN;
    const medP = ratioKnown ? trimmedMean(dP) : NaN;
    const rateRatio = ratioKnown && medU > 0 ? medP / medU : NaN;
    const encoderIsRealTime = Number.isFinite(rateRatio) && Math.abs(rateRatio - 1) <= 0.02;
    // A ratio we could measure and that came out wrong is a POSITIVE finding
    // about the encoder clock, and must outrank any retention argument.
    const encoderProvenWrong = Number.isFinite(rateRatio) && Math.abs(rateRatio - 1) > 0.02;

    let best = null, why = "";
    if (ptsTrial && utsTrial) {
        // RETENTION GATES BOTH DIRECTIONS. Falling back to the wall clock
        // whenever the encoder clock could not be verified assumed the wall
        // clock was there to fall back TO — and on a stream where only a
        // handful of records carry a UnixTimeStamp, that "fallback" retains
        // three frames and the whole clip is refused for want of ten. A clock
        // that cannot support a run is not a fallback, whatever its pedigree.
        const ptsKeepsEnough = ptsTrial.kept >= utsTrial.kept * 0.9;
        const utsKeepsEnough = utsTrial.kept >= ptsTrial.kept * 0.9;

        if (encoderProvenWrong) {
            // MEASURED-WRONG BEATS BETTER-RETAINED. The retention gate below
            // used to be reached first, so a wall clock split by a relock could
            // hand cadence to a PES timeline we had just measured as 2x off —
            // selecting a clock already proven not to measure real seconds, and
            // scaling every speed by that factor. A positive finding about a
            // clock outranks how much of the clip it happens to cover; if the
            // wall clock is then too short to fit, the insufficient-run error
            // says so accurately rather than silently substituting a bad clock.
            best = utsTrial;
            why = `UnixTimeStamp (the clocks disagree by ${rateRatio.toFixed(3)}x)`;
            warnings.push(`THE CLOCKS DISAGREE ABOUT RATE by ${rateRatio.toFixed(3)}x (typical `
                + `step ${medP.toFixed(4)} s on PES PTS against ${medU.toFixed(4)} s on `
                + `the wall clock — trimmed means over ${dU.length} overlapping steps)`
                + `${Math.abs(rateRatio - 1) > 0.2
                    ? ` — a factor that size is the classic "-r N without an fps filter" encoder `
                      + `misconfiguration` : ""}`
                + `. Cadence was taken from UnixTimeStamp, because it is a real-time clock by `
                + `definition while PES PTS is a presentation timebase. This does NOT prove the `
                + `PES timeline is the faulty one — if the wall clock is the damaged one here, `
                + `every speed and g-load below is off by that factor.`
                + `${utsTrial.kept < ptsTrial.kept
                    ? ` The wall clock also covers less of the clip (${utsTrial.kept} frames `
                      + `against ${ptsTrial.kept}), so this costs data as well.` : ""}`);
        } else if (encoderIsRealTime && ptsKeepsEnough) {
            best = ptsTrial;
            why = "PES PTS (encoder clock verified real-time against UnixTimeStamp)";
        } else if (!ptsKeepsEnough) {
            best = utsTrial;
            why = "UnixTimeStamp (PES PTS is only partially paired)";
            warnings.push(`PES PTS is paired on too little of this clip to use for cadence `
                + `(${ptsTrial.kept} usable frames against ${utsTrial.kept} on the wall clock), `
                + `so UnixTimeStamp was used.`);
        } else if (!utsKeepsEnough) {
            best = ptsTrial;
            why = "PES PTS (UnixTimeStamp is too sparse to give a cadence)";
            warnings.push(`UnixTimeStamp supports only ${utsTrial.kept} of `
                + `${complete.length} records, so it cannot give a cadence and could not be used `
                + `to check the encoder clock against real time. Spacing came from PES PTS; treat `
                + `derived speeds as conditional on the encoder having run at real time.`);
        } else {
            // Both retain the clip, neither can be checked against the other
            // (too few overlapping steps). Fall back to the clock that is
            // real-time BY DEFINITION rather than assume the other one is.
            best = utsTrial;
            why = "UnixTimeStamp (too few overlapping steps to verify the encoder clock)";
            warnings.push("The two clocks overlap on too few records to check whether the encoder "
                + "clock runs at real time, so cadence came from UnixTimeStamp.");
        }
    } else if (ptsTrial || utsTrial) {
        best = ptsTrial ?? utsTrial;
        why = ptsTrial ? "PES PTS (no usable UnixTimeStamp cadence)"
            : "UnixTimeStamp (no usable PES PTS)";
        if (ptsTrial && !utsTrial) {
            // Says nothing about the EPOCH — a wall clock too broken for
            // spacing can still carry one usable absolute stamp, and the epoch
            // check below is the authority on that.
            warnings.push("UnixTimeStamp gives no usable cadence, so spacing came from the KLV "
                + "PES timestamps and the encoder clock could not be checked against real time. "
                + "Treat derived speeds as conditional on the encoder having run at real time.");
        }
    }
    const useTimeOf = best ? best.get : ((rec) => rec.t);
    const chosen = best;
    if (best) chosenTimebaseNote = why;

    if (utsTrial && ptsTrial && Math.abs(ptsTrial.kept - utsTrial.kept) > 0.1 * complete.length) {
        warnings.push(`The clocks retain different amounts of this clip — PES PTS `
            + `${ptsTrial.kept} frames, UnixTimeStamp ${utsTrial.kept}, of ${complete.length}. `
            + `One of them is either hiding a real dropout or inventing one.`);
    }
    const haveAllTimes = !!chosen;
    if (!haveAllTimes) {
        const stampDiag = stampsUnclassifiable
            ? ` ${stampsUnclassifiable} record(s) DO carry a UnixTimeStamp value `
              + `(e.g. ${String(stampSample).slice(0, 40)}) that is not recognizable as an `
              + `epoch stamp — seconds, milliseconds or microseconds for dates 1980-2100 — `
              + `so the column likely holds a relative clock, a spreadsheet date serial, or `
              + `a mangled export.`
            : "";
        throw new Error("Neither UnixTimeStamp nor KLV PES PTS gives a usable, advancing "
            + "timeline for these records, so this clip carries no timing. Every speed, "
            + "acceleration and g-load the analysis reports is derived from it, so there is "
            + "nothing honest to compute here." + stampDiag);
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
    const timing = timingStats(times);
    // Always derived from the selected timebase — the no-clock case was refused
    // above, so no assumed rate exists anywhere in this path.
    // Total elapsed over intervals. The retained run is dropout-free by
    // construction, so nothing outlying is left for a median to protect against
    // — and a median step would misreport a bimodally jittering clock by
    // returning one of its modes rather than its average rate.
    let fps = (n - 1) / (times[n - 1] - times[0]);

    // Jitter WITHIN the retained span is flattened into this single rate, and
    // that is a real distortion of every derived quantity — the fits index time
    // as frame/rate, so a sample that actually arrived early or late is
    // reported at the nominal instant regardless. The run selection removes
    // DROPOUTS; it does not and cannot remove jitter. This warning was present,
    // then lost in a rewrite of this block; without it the flattening is silent.
    if (timing && (timing.cv > 0.05 || timing.gaps > 0)) {
        warnings.push(`Retained sample spacing is not uniform (intervals vary by `
            + `${(timing.cv * 100).toFixed(1)}% of their mean`
            + `${timing.gaps ? `, ${timing.gaps} interval(s) over 3x the median` : ""}). The fits `
            + `assume an even ${fps.toFixed(3)} Hz, so speeds, accelerations and g-loads are `
            + `distorted wherever the real spacing differs from it.`);
    }

    // THE EPOCH IS FRAME ZERO'S TIME, BACK-PROJECTED IF NEED BE.
    //
    // Two separate mistakes lived here. The first gated this on "a usable UTS
    // run exists somewhere", which says nothing about the run actually chosen —
    // with cadence from PES PTS, kept[0] is a PTS-selected record whose own
    // wall-clock stamp may be absent, and new Date(NaN).toISOString() throws.
    //
    // The second was subtler: taking the first record that HAPPENS to carry a
    // stamp and using it as frame zero. If the run's first three records have
    // no UnixTimeStamp, that is the time of frame THREE, and the whole clip is
    // reported as starting late — silently shifting every date-dependent
    // calculation (sun and moon position, satellite passes) by the offset.
    // Project it back along the cadence instead.
    //
    // Cadence availability and epoch availability are also different questions:
    // a wall clock too broken to give SPACING can still carry one usable
    // absolute stamp, which is all an epoch needs.
    // FRAME ZERO'S ABSOLUTE TIME, FROM THE WALL-CLOCK ANCHORS THEMSELVES.
    //
    // Every wall-clock stamp in the analysed span is an anchor, and TWO of them
    // are enough to measure real seconds per frame directly — no dependence on
    // whether the cadence timebase runs at real time. That matters, because
    // there are branches above that select PES PTS without being able to verify
    // it, and projecting along a 2x-off encoder clock puts frame zero minutes
    // out.
    //
    // With one anchor and a verified real-time cadence, project along it. With
    // one anchor and an UNVERIFIED cadence, the offset cannot be converted to
    // real seconds at all — and the earlier version still exported that stamp
    // as clipStartMs, so every celestial and satellite calculation ran at a
    // time the clip was never at. There is no honest number in that case, so
    // there is no number: the epoch is null and the row says why. A missing
    // epoch disables the date-dependent hypotheses; a wrong one corrupts them
    // silently.
    const anchors = [];
    for (let i = 0; i < kept.length; i++) if (Number.isFinite(kept[i].t)) anchors.push(i);

    const offsetsAreRealSeconds = (best === utsTrial) || encoderIsRealTime;
    let clipStartS = NaN;
    let epochBasis = null;
    // Real seconds per frame, measured from the anchors themselves.
    //
    // A RATE IS A WEIGHTED QUANTITY: total elapsed over total frames. Averaging
    // the per-pair rates unweighted gives a short pair the same say as a long
    // one, and on sparse anchors that is badly wrong — pairs spanning 1 frame
    // at 0.2 s and 100 frames at 9.9 s average to 0.1495 s/frame (6.7 Hz) when
    // the true rate is 0.1 (10 Hz). The 100-frame measurement is a hundred
    // times the evidence and must count as such.
    //
    // So the per-pair rates are computed for OUTLIER DETECTION only, and the
    // estimate itself is the weighted sum over the pairs that survive: one
    // wall-clock relock is excluded as a pair, and the rest contribute in
    // proportion to how much of the clip they actually measure.
    // The measurement itself lives in BotBenchClock.measureAnchorRate, which is
    // pure and has regression tests covering every case that has ever been
    // wrong here — majority agreement, even splits, non-advancing intervals,
    // unequal evidence, and the argument-limit hazard. It had been revised six
    // times with nothing but hand checks behind it.
    const cadenceDt = (times[n - 1] - times[0]) / (n - 1);
    const anchorFit = measureAnchorRate(anchors, (f) => kept[f].t, cadenceDt);
    const realDt = anchorFit.realDt;
    const anchorPairsUsed = anchorFit.pairsUsed;
    const anchorsInconsistent = anchorFit.inconsistent;
    const epochAnchor = anchorFit.epochAnchor;

    if (anchorFit.stepDetected) {
        // A STEP COSTS THE EPOCH, NOT THE RATE. The surviving intervals prove a
        // consistent STEP SIZE; they say nothing about which side of the jump
        // carries the correct absolute offset, and picking one was an arbitrary
        // choice presented as a measurement — shifting clipStartMs, and every
        // celestial and satellite result, by the whole step. The rate is still
        // measured; the absolute time is not recoverable and is not invented.
        warnings.push(`The wall clock steps part-way through this span. The RATE is still `
            + `measured from the ${anchorPairsUsed} intervals that agree, but which side of the `
            + `step carries the correct absolute time cannot be known from the file — so this `
            + `clip is reported with NO absolute time rather than one that may be out by the `
            + `whole jump. Date-dependent results are unavailable for it.`);
    }

    if (Number.isFinite(realDt) && realDt > 0 && epochAnchor >= 0) {
        const i0 = epochAnchor;
        clipStartS = kept[i0].t - i0 * realDt;
        epochBasis = `measured across ${anchors.length} wall-clock stamps `
            + `(${anchorPairsUsed} interval(s) used, projected from frame ${i0})`;
    } else if (anchorFit.stepDetected) {
        // Already warned above: the rate survived the step, the epoch cannot.
        // This branch exists to stop the single-anchor fallback below from
        // quietly reinstating anchors[0] — which is precisely the stamp on the
        // far side of the jump.
    } else if (anchorsInconsistent) {
        // A CLOCK THAT CONTRADICTS ITSELF CANNOT VOUCH FOR ANY OF ITS STAMPS.
        // The fallback below trusts frame 0 unconditionally, which is right
        // when nothing disputes it — and wrong here: several anchors that
        // cannot produce one agreeing interval are positive evidence the wall
        // clock is unreliable, so a stamp from it (frame zero's included) is
        // not a fact to build an epoch on. Better no time than a wrong one.
        warnings.push(`The wall-clock stamps in this span contradict each other `
            + `(${anchorFit.reason ?? "no interval between them is usable"}), so none of them `
            + `can be trusted as an absolute time, frame zero's included. This clip is reported `
            + `with NO absolute time; date-dependent results are unavailable for it.`);
    } else if (anchors.length >= 1) {
        // A single anchor, with nothing to contradict it.
        const i0 = anchors[0];
        if (i0 === 0) {
            clipStartS = kept[0].t;
            epochBasis = "the wall-clock stamp on frame 0";
        } else if (offsetsAreRealSeconds) {
            clipStartS = kept[i0].t - (times[i0] - times[0]);
            epochBasis = `projected back from the earliest wall-clock stamp (frame ${i0}) `
                + `along a cadence measured in real seconds`;
        } else {
            warnings.push(`No usable interval could be measured between the wall-clock stamps in `
                + `this span (the earliest is at frame ${i0}), and the cadence timebase could not `
                + `be verified against real time — so there is no way to convert that frame's `
                + `offset into real seconds and no honest value for frame zero. This clip is `
                + `reported with NO absolute time rather than a shifted one; date-dependent `
                + `results are unavailable for it.`);
        }
    }
    // THE ANCHORS ALSO SETTLE THE SCALE. Two wall-clock stamps measure real
    // seconds per frame directly, and that outranks a cadence clock which may
    // not run at real time at all: without this, a clip whose PES timeline is
    // 2x off reported half the true rate — halving every speed — while the
    // information needed to correct it sat right here, already computed for the
    // epoch. The cadence clock still decides WHICH frames are contiguous; the
    // anchors decide what a frame is worth in seconds.
    if (Number.isFinite(realDt) && realDt > 0 && best !== utsTrial && !encoderIsRealTime) {
        const wasFps = fps;
        fps = 1 / realDt;
        warnings.push(`Cadence was rescaled to ${fps.toFixed(3)} Hz using the `
            + `${anchors.length} wall-clock stamps in this span; the ${
                chosenTimebaseNote.startsWith("PES") ? "PES" : "selected"} timeline alone implied `
            + `${wasFps.toFixed(3)} Hz. Spacing still comes from that timeline, but its scale `
            + `does not run at real time.`);
    }

    const haveEpoch = Number.isFinite(clipStartS);
    if (!haveEpoch && anchors.length === 0) {
        warnings.push("No record in the analysed span carries a UnixTimeStamp, so this clip has "
            + "no absolute time. Anything date-dependent (sun/moon position, satellite passes) "
            + "cannot be computed for it.");
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
    const truthEcef = [];
    const groundEcef = [];
    let mx = 0, my = 0, mz = 0;
    // An MSL altitude plus its geoid offset, i.e. the height above the
    // ELLIPSOID that LLAToECEF wants. Every point in this loop — sensor, frame
    // center, truth — goes through it, because the moment two of them use
    // different datums the difference becomes a fake vertical error nothing
    // downstream can distinguish from a real one.
    const haeOf = ({lat, lon, altHAE, altMSL}) => {
        if (altHAE !== null) return altHAE;
        const geoidN = (geoid && isGeoidLoaded()) ? meanSeaLevelOffset(lat, lon) : 0;
        return altMSL + (Number.isFinite(geoidN) ? geoidN : 0);
    };
    for (const rec of kept) {
        const sensorECEF = LLAToECEF(rec.lat, rec.lon, haeOf(rec));
        ecef.push(sensorECEF);
        if (rec.angles) {
            headings.push(misbSightlineHeading(sensorECEF, rec.angles));
        } else {
            // Frame-center pointing: the direction between two ECEF POSITIONS.
            const centerECEF = LLAToECEF(rec.centerLLA.lat, rec.centerLLA.lon,
                haeOf(rec.centerLLA));
            headings.push(centerECEF.sub(sensorECEF).normalize());
        }
        mx += sensorECEF.x; my += sensorECEF.y; mz += sensorECEF.z;
        if (rec.truthLLA) {
            // TruthAltitude is meters with no HAE variant, so it gets the same
            // MSL treatment as SensorTrueAltitude — the truth and the sensor
            // must sit on the SAME datum or every scored error inherits the
            // geoid offset as a fake vertical miss.
            truthEcef.push(LLAToECEF(rec.truthLLA.lat, rec.truthLLA.lon,
                haeOf(rec.truthLLA)));
        } else {
            truthEcef.push(null);
        }
        // Through the SAME datum resolver as everything else: a frame center
        // stated by tag 25 is MSL and needs the geoid, one stated by tag 78 is
        // already ellipsoidal. Mixing those two would put the ground plane out
        // by the geoid height — the very error this whole block exists to stop.
        groundEcef.push(rec.groundLLA
            ? LLAToECEF(rec.groundLLA.lat, rec.groundLLA.lon, haeOf(rec.groundLLA))
            : null);
    }
    mx /= n; my /= n; mz /= n;
    const [originLat, originLon] = ECEFToLLA_radii(mx, my, mz);

    const S = new Float64Array(n * 3);
    const D = new Float64Array(n * 3);
    const W = new Float64Array(n * 3);   // no wind source for a bare FMV file
    const T = new Float64Array(n * 3);
    const tValid = new Uint8Array(n);
    let anyTruth = false;
    // Frame-center heights in the DATASET'S OWN ENU Z, which is what groundZ is
    // compared against — not geodetic altitude. Converting each one properly
    // rather than treating its HAE as a Z costs nothing here and removes the
    // Earth-curvature drop between the origin and the aim point.
    const groundSamples = [];
    for (let f = 0; f < n; f++) {
        const pENU = ECEF2ENU_radii(ecef[f], originLat, originLon);
        S[f * 3] = pENU.x; S[f * 3 + 1] = pENU.y; S[f * 3 + 2] = pENU.z;
        if (groundEcef[f]) {
            groundSamples.push(ECEF2ENU_radii(groundEcef[f], originLat, originLon).z);
        }
        const dENU = ECEF2ENU_radii(headings[f], originLat, originLon, true).normalize();
        D[f * 3] = dENU.x; D[f * 3 + 1] = dENU.y; D[f * 3 + 2] = dENU.z;
        if (truthEcef[f]) {
            const tENU = ECEF2ENU_radii(truthEcef[f], originLat, originLon);
            T[f * 3] = tENU.x; T[f * 3 + 1] = tENU.y; T[f * 3 + 2] = tENU.z;
            tValid[f] = 1;
            anyTruth = true;
        } else if (f > 0) {
            // Hold the last known position on frames with no truth — same
            // reasoning as the BOT ingest: scoring honours tValid, but the
            // charts plot the raw array, and a zero triple is the ENU origin.
            T[f * 3] = T[(f - 1) * 3];
            T[f * 3 + 1] = T[(f - 1) * 3 + 1];
            T[f * 3 + 2] = T[(f - 1) * 3 + 2];
        }
    }
    // The forward hold cannot reach frames BEFORE the first valid truth, so
    // back-fill those from it — same as the BOT ingest, and lost the same way
    // once there: without it a truth track that starts blank keeps the
    // zero-fill on its opening frames, and zero is the ENU ORIGIN, so the
    // chart drew a trajectory sweeping in from kilometres away. Never scored
    // either way; tValid stays 0.
    if (anyTruth) {
        let firstValid = -1;
        for (let f = 0; f < n; f++) if (tValid[f]) { firstValid = f; break; }
        for (let f = 0; f < firstValid; f++) {
            T[f * 3] = T[firstValid * 3];
            T[f * 3 + 1] = T[firstValid * 3 + 1];
            T[f * 3 + 2] = T[firstValid * 3 + 2];
        }
        warnings.push(`Truth altitudes were interpreted as FEET — truth_alt carries no units `
            + `label, and feet is the app's default for this client column (the app has a `
            + `per-track "Source Altitude is Meters" switch; bulk ingest applies the default). `
            + `If this file's truth is in meters, its truth altitudes read 3.28x low here.`);
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

    // ------------------------------------------------------------------
    // THE GROUND PLANE.
    //
    // A bulk run has no terrain, so the analysis grades "does this candidate
    // pass underground" against a flat level plane (see flatTerrainProbes in
    // BotBenchRunner). Sea level is the only answer available with no other
    // information, and inland it is a badly wrong one: over Cheyenne it sits
    // 1,867 m below the real surface, which lets every buried candidate through
    // the screen and puts the Ground Vehicle and Fixed Point fits on a plane
    // more than a kilometre under the road they are meant to ride.
    //
    // The file usually knows better. FrameCenterElevation / -HeightAboveEllipsoid
    // is the producer's own terrain height where the optical axis meets the
    // earth, sampled once per record — a real measurement of exactly this
    // quantity, already in the file, costing nothing to read. The MEDIAN of it
    // is what gets used: a mean would be dragged by the odd wild center a
    // producer emits when the axis swings off its terrain model, and half the
    // samples being sane is a much weaker thing to need than all of them.
    //
    // What this is NOT is terrain. It remains one level plane, so it is right
    // for flat ground and wrong by the local relief in a valley or on a slope —
    // better ground, not real ground, and the row says which one it got.
    let groundZ = geoidN;
    let groundSource = geoidApplied ? "sea level (EGM96)" : "the ellipsoid";
    if (groundSamples.length >= MIN_GROUND_SAMPLES) {
        const sorted = groundSamples.slice().sort((a, b) => a - b);
        const mid = sorted.length >> 1;
        const median = (sorted.length % 2)
            ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
        // A ground ABOVE the aircraft is not a ground, it is a broken column,
        // and accepting one would reject every candidate in the file as
        // underground — including the sensor's own sightlines — with nothing
        // on the row to say why. Refuse it and keep sea level, out loud.
        let lowestSensorZ = Infinity;
        for (let f = 0; f < n; f++) lowestSensorZ = Math.min(lowestSensorZ, S[f * 3 + 2]);
        if (median < lowestSensorZ) {
            groundZ = median;
            groundSource = "the file's own frame-center elevations";
            warnings.push(`Ground was taken as a level plane at ${Math.round(median)} m, the `
                + `MEDIAN of ${groundSamples.length} frame-center elevation(s) in the file, `
                + `rather than sea level. That is the producer's own terrain height under the `
                + `optical axis, so it is far closer to the real surface than sea level inland `
                + `— but it is still ONE LEVEL PLANE, so it is wrong by the local relief on a `
                + `slope or in a valley, and every underground and ground-contact judgement `
                + `inherits that.`);
        } else {
            warnings.push(`The file's ${groundSamples.length} frame-center elevation(s) give a `
                + `median of ${Math.round(median)} m, which is at or above the lowest sensor `
                + `height (${Math.round(lowestSensorZ)} m). A ground above the aircraft cannot `
                + `be right, so it was rejected and sea level used instead — treat this file's `
                + `frame-center columns as suspect.`);
        }
    } else if (groundSamples.length) {
        warnings.push(`Only ${groundSamples.length} record(s) state a frame-center elevation, `
            + `too few to take a ground height from, so sea level was used. Inland that is far `
            + `below the real surface, and candidates that pass underground will not be rejected.`);
    }

    const dataset = {n, fps, S, D, W, frame0: 0, frame1: n - 1};
    const quality = assessSourceQuality(dataset, {
        times: haveAllTimes ? times : null,
        declaredLosSigmaDeg: null,
        droppedRows: noPosition + noSightline + centerNoAlt,
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
        // The plane itself is chosen above: the median of the file's own
        // frame-center elevations where it has enough of them, and sea level
        // where it has none. Either way it is ONE LEVEL PLANE and not terrain,
        // and the row reports which one it got.
        groundZ,
        clipStartMs: haveEpoch ? clipStartS * 1000 : null,
        // Truth from the file's own truth columns, in the exact shape the BOT
        // ingest returns, so scoring and the gallery treat both sources alike.
        truth: anyTruth ? {
            track: T, valid: tValid,
            validCount: tValid.reduce((a, b) => a + b, 0),
            usable: tValid.reduce((a, b) => a + b, 0) >= 5,
            label: "Truth (file truth columns)",
            trackID: null,
        } : null,
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
            // WHERE THE SIGHTLINES CAME FROM. Not cosmetic: a frame-center
            // sightline is a derived quantity carrying the producer's terrain
            // error, so a reader comparing two runs needs to know which
            // convention each one used before comparing their residuals.
            pointing: centerRows === 0
                ? (boresightRows ? "boresight (platform frame)" : "gimbal angles")
                : (centerRows === complete.length
                    ? "frame center"
                    : `mixed (${centerRows} of ${complete.length} by frame center)`),
            epochBasis,
            // WHICH GROUND WAS GRADED AGAINST. Not cosmetic: every underground
            // and ground-contact verdict on the row is only as good as this
            // plane, and a reader comparing two files needs to know that one
            // was screened against the producer's terrain height and the other
            // against sea level a kilometre below it.
            surfaceModel: (usingEllipsoid ? "" : "SPHERICAL Earth mode; ")
                + `level plane at ${groundSource}`
                + (geoidApplied ? "" : "; geoid unavailable")
                + " (no terrain)",
            groundZM: groundZ,
            groundSamples: groundSamples.length,
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
    const role = botBenchExplicitFileRole(entry.name);
    if (role === "track-file") {
        const text = await (await entry.getFile()).text();
        const label = entry.relativePath || entry.name;
        // The geoid is only needed for MSL altitudes, and these formats carry
        // some — load it lazily, exactly as the FMV branch does.
        try { await ensureGeoidLoaded(); } catch (e) { /* warned about in ingestMISBRecords */ }
        return /\.srt$/i.test(entry.name)
            ? ingestSRT(text, {label})
            : ingestSTANAGXML(text, {label});
    }
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
        // Not a BOT interchange file? Any Sitrec-loadable track CSV with
        // camera pointing is analysed through the same shared import
        // dispatch the live app uses; anything else refuses with the reason.
        if (!isBOTCSV(toRows(text))) {
            // A generic track CSV states MSL altitudes, so it needs the geoid
            // for the same reason the FMV branch does. Without this the CSV
            // path silently ran on whatever happened to be loaded already and
            // warned about it — right in the app (the sitch loads the grid),
            // wrong anywhere the grid had not been fetched yet.
            try { await ensureGeoidLoaded(); } catch (e) { /* warned about in ingest */ }
            return ingestGenericTrackCSV(text,
                {label: entry.relativePath || entry.name});
        }
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
