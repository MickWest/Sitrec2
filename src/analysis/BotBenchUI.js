/**
 * BotBenchUI.js — the "BotBench" bulk traverse-analysis window.
 *
 * Point it at a folder of BOT interchange scenarios or FMV clips and it runs
 * the shipping traverse analysis on each one in turn, filling a table as the
 * results land. Two column groups, because they answer two different questions:
 *
 *   SOURCE     what the data can support, measured BEFORE any fit — frames,
 *              duration, sensor baseline, how far the sightline swept,
 *              CV-family conditioning, and an estimate of the pointing noise
 *              read off the sightlines themselves.
 *   ANALYSIS   what the analysis concluded — the executive verdict, the
 *              top-ranked interpretation with its residual and range, and,
 *              when the file carries truth, how far that interpretation
 *              actually was from it.
 *
 * Every row keeps its full results object, so "Gallery" opens the same
 * full-screen candidate gallery the Analyze button produces, with no
 * re-computation, and "Report" builds the same HTML report on demand.
 *
 * Structure and idiom follow VideoFolderAnalysisUI.js deliberately — this is
 * the second tool in the File Analysis folder and they should feel like one
 * pair.
 */

import {saveAs} from "file-saver";
import {setRenderOne} from "../Globals";
import {
    isAbortLikeError, showLocalFolderAccessUnsupportedMessage, supportsDirectoryPicker,
} from "../CFileManagerUtils";
import {showError} from "../showError";
import {showTimingAnalysis} from "../showTimingAnalysis";
import {isLocal} from "../configUtils";
import {par} from "../par";
import {showTraverseGallery} from "../AnalyzeTraverse";
import {METERS_PER_NM} from "../TraverseAnalysis";
import {
    botBenchFileRole, botBenchScenarioBase, ingestBotBenchEntry, sourceQualityGrade,
} from "./BotBenchIngest";
import {ABSENT_HYPOTHESES, DEFAULT_ANCHOR_M, runBotBenchAnalysis} from "./BotBenchRunner";

let activeDialog = null;
let botBenchController = null;

const BUTTON_TOOLTIPS = {
    "Close": "Close this window and restore the previous Sitrec playback state. Results are discarded.",
    "Choose Folder": "Pick a folder of BOT interchange scenarios and/or FMV clips. Sidecars (.scenario.json) are paired automatically.",
    "Choose Files": "Pick individual files to run. Without their .scenario.json sidecars, BOT files fall back to the shipped set's default origin and rate.",
    "Cancel Run": "Stop after the file currently being analysed finishes.",
    "Clear Results": "Remove every result from the table and start fresh.",
    "Export JSON": "Save every row's measurements and conclusions (not the fitted tracks).",
    "Export CSV": "Save one row per file for spreadsheet analysis.",
    "Summary": "Open a combined overview: what the run covered, how the source data scored, and where the analysis landed.",
    "Gallery": "Open the full candidate gallery for this file — the same view the Analyze Traverse Methods button produces.",
    "Report": "Build and open the full HTML analysis report for this file.",
};

const SUMMARY_TOOLTIPS = {
    "Queued": "Files queued for this run.",
    "Analysed": "Files that produced a result.",
    "Errors": "Files that could not be ingested or analysed.",
    "Good source": "Files whose source data has no flagged degeneracy — enough frames, a real sensor baseline, a swept sightline and good CV-family conditioning.",
    "Range unobservable": "Files where the sensor baseline is too small for any free-range method to determine distance. No fit can recover range here; that is a property of the data, not the analysis.",
    "Resolved": "Files whose executive verdict was something other than 'unresolved' AND whose top candidate does not contradict the file's declared MaxRange. A parenthesised figure is how many were excluded for that contradiction — a verdict resting on a candidate the measurement says is impossible is not a resolution.",
    "With truth": "Files whose conclusion can be scored — a TruePosition column, or a direction truth for a target that has a bearing but no finite range. The two are scored in different units and are never averaged together; the counts are shown as positional+direction.",
    "Median |err|": "Median LOS residual of the top-ranked interpretation across the run, in degrees.",
    "Median rel. sep": "Median of (top interpretation's mean 3D separation from truth) / (mean true range), over the files that carry truth. Scale-free, so a 2 km and a 50 km scenario compare.",
};

// [label, width, tooltip, group]
//
// Widths are deliberately MEAN with the numeric columns — they hold 3-6
// characters and every percent spent on them is taken from File and Verdict,
// which are the two that actually have something to say. The numerics are also
// nowrap, so a column can never silently grow a second line and double the
// height of the whole row.
const TABLE_COLUMNS = [
    ["File", "12%", "The file's path relative to the chosen folder.", ""],
    ["Status", "4.5%", "Progress while running, then the final state.", ""],

    ["n", "2.5%", "Usable samples in the file, at its own native rate — not resampled to a video frame rate.", "source"],
    ["Dur", "3%", "Clip duration in seconds.", "source"],
    ["Rate", "2.5%", "Samples per second: the sidecar's declared rate, or the median sample interval.", "source"],
    ["Base", "4.5%", "Straight-line extent of the sensor path. This is the aperture of the whole problem: with no baseline there is no parallax and no range.", "source"],
    ["Sweep", "3.5%", "Total angular path travelled by the sightline, in degrees. A bearing that never moves carries no information about motion.", "source"],
    ["rcond", "3.5%", "CV-family design conditioning (0-1, higher is better). Says whether a LINEAR fit can determine range here — physics and stationary-point methods may still work when this is poor. One-way: 'good' is not a guarantee.", "source"],
    ["Noise", "3.5%", "Pointing noise estimated FROM THE SIGHTLINES: the median second-difference angle, de-biased under an assumption of isotropic Gaussian error on a locally straight path. Compare with 'Decl' — agreement is evidence the declared figure is honest.", "source"],
    ["Decl", "3.5%", "Pointing sigma the file DECLARES (BOT sidecar losError.sigmaDeg, or the LOSUncertainty column). A trailing * means a CORRELATED error model, whose figure is not comparable with the estimate to the left. Blank for FMV, which declares none.", "source"],
    ["Src", "3.5%", "One-word triage of the columns to the left. Not a calibrated score — hover it for the specific reasons.", "source"],

    ["Verdict", "18%", "The executive assessment for this file. Shortened to fit — hover for the full headline.", "analysis"],
    ["Top interpretation", "16%", "The highest-ranked candidate, and its rank tier.", "analysis"],
    ["|err|", "3.5%", "The top interpretation's mean LOS residual, in degrees.", "analysis"],
    ["Range", "4%", "Start range of the top interpretation, in nautical miles.", "analysis"],
    ["Truth", "4.5%", "Where truth exists: the top interpretation's separation from it as a fraction of the true range — or, for a target with no finite range, its bearing error in degrees.", "analysis"],
    ["", "7.5%", "Open this file's full analysis.", "analysis"],
];

// Minimum table width. With 17 columns, a percentage layout inside a narrow
// window gives every column a few characters and wraps ALL of them — measured
// at an 893 px viewport, rows ran to 121 px and eight fitted on screen. Fixing
// the table's floor and letting the wrapper scroll horizontally instead keeps
// every cell on ONE line, which is what makes the table scannable; on a wide
// display the percentages take over and nothing scrolls.
const TABLE_MIN_WIDTH_PX = 1500;

/**
 * The verdict headline, shortened for a table cell.
 *
 * The assessment's own wording is a full sentence written for a report — good
 * prose, but at 14% of the width it wrapped to six lines and made every row
 * tall enough that only four fitted on screen. The boilerplate tails carry no
 * per-row information (every "unresolved" row ends the same way), so they are
 * cut here and the untouched original stays in the tooltip.
 */
function shortVerdict(headline, code) {
    if (!headline) return code ?? "";
    return headline
        // LEAD WITH THE DISTINGUISHING WORD. Every "consistent" headline opens
        // with the same twenty-odd characters of framing, so at column width
        // the cell clipped to "Consistent with …" on every such row — the part
        // that differs between rows was precisely the part cut off, which is
        // the one thing a truncation must never do.
        .replace(/^Consistent with several conventional interpretations.*$/i,
            "Consistent: several")
        .replace(/^Consistent with (?:an?|the) (?:conventional )?/i, "Consistent: ")
        .replace(/^Consistent with /i, "Consistent: ")
        // Trailing boilerplate carries no per-row information: every
        // "unresolved" row ends the same way.
        .replace(/\s*—\s*no completed tested conventional model passes the current screen\.?$/i, "")
        .replace(/,?\s*but not identified\.?$/i, "")
        .replace(/\.$/, "");
}

const GROUP_COLOURS = {source: "#e8f1fb", analysis: "#eef7ee", "": "#f5f7fa"};

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

const n0 = (v) => (Number.isFinite(v) ? v.toFixed(0) : "");
const n1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "");
const n2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "");
const n3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : "");

function fmtMetres(v) {
    if (!Number.isFinite(v)) return "";
    return v >= 10000 ? `${(v / 1000).toFixed(1)} km` : `${v.toFixed(0)} m`;
}

function csvEscape(value) {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_COLUMNS = [
    "file", "kind", "status", "trackId",
    "frames", "durationS", "fps", "sensorSpanM", "sensorPathM", "straightness",
    "sensorAltSpanM", "netSweepDeg", "sweepPathDeg", "rateMedianDegPerS",
    "jitterDeg", "noiseEstDeg", "declaredLosSigmaDeg",
    "rcond", "log10Rcond", "conditioning", "effectiveRank",
    "losErrorModel", "losErrorCorrelated",
    "timeCv", "timeGaps", "invalidFrames", "droppedRows",
    "sourceGrade", "sourceReasons", "earthModel", "surfaceModel",
    "verdictCode", "headline", "viableClasses", "rangeUnobservable",
    "declaredMaxRangeM", "maxRangeViolationCount", "topViolatesMaxRange",
    "optAnchorNM", "optRangeBands", "optMcSweep",
    "topKey", "topName", "topTier", "topErrDeg", "topRangeM", "topSpeedKt",
    "candidates", "failures",
    "truthLabel", "truthTopSepM", "truthTopRelSep", "truthBestSepM", "truthBestName",
    "truthResidualDeg",
    "directionTruthLabel", "directionTopDeg", "directionBestDeg", "directionBestName",
    "elapsedMs", "error",
];

function rowToCsvRecord(entry) {
    const r = entry.row;
    const q = r?.quality ?? {};
    const grade = r ? sourceQualityGrade(q) : null;
    return {
        file: entry.relativePath,
        kind: r?.kind ?? "",
        status: entry.status,
        trackId: r?.trackId ?? "",
        frames: q.frames, durationS: q.durationS, fps: q.fps,
        sensorSpanM: q.sensorSpanM, sensorPathM: q.sensorPathM, straightness: q.straightness,
        sensorAltSpanM: q.sensorAltSpanM,
        netSweepDeg: q.netSweepDeg, sweepPathDeg: q.sweepPathDeg,
        rateMedianDegPerS: q.rateMedianDegPerS,
        jitterDeg: q.jitterDeg, noiseEstDeg: q.noiseEstDeg,
        declaredLosSigmaDeg: q.declaredLosSigmaDeg,
        losErrorModel: q.losErrorModel ?? "", losErrorCorrelated: q.losErrorCorrelated ?? "",
        rcond: q.rcond, log10Rcond: q.log10Rcond, conditioning: q.conditioning,
        effectiveRank: q.effectiveRank,
        timeCv: q.timeCv, timeGaps: q.timeGaps,
        invalidFrames: q.invalidFrames, droppedRows: q.droppedRows,
        sourceGrade: grade?.grade ?? "", sourceReasons: grade?.reasons.join("; ") ?? "",
        earthModel: r?.earthModel ?? "", surfaceModel: r?.surfaceModel ?? "",
        verdictCode: r?.verdictCode ?? "", headline: r?.headline ?? "",
        viableClasses: (r?.viableClasses ?? []).join("+"),
        rangeUnobservable: r?.rangeUnobservable ?? "",
        optAnchorNM: entry.options ? (entry.options.anchorM / METERS_PER_NM).toFixed(2) : "",
        optRangeBands: entry.options ? entry.options.solutionFamilies : "",
        optMcSweep: entry.options ? entry.options.mcOrderSweep : "",
        declaredMaxRangeM: r?.declaredMaxRangeM,
        maxRangeViolationCount: r?.maxRangeViolations?.length ?? "",
        topViolatesMaxRange: r ? (r.maxRangeViolations ?? []).some((v) => v.key === r.top?.key
            && v.name === r.top?.name) : "",
        topKey: r?.top?.key ?? "", topName: r?.top?.name ?? "", topTier: r?.top?.tier ?? "",
        topErrDeg: r?.top?.errDeg, topRangeM: r?.top?.rangeStartM, topSpeedKt: r?.top?.speedKt,
        candidates: r?.candidates, failures: (r?.failures ?? []).join("; "),
        truthLabel: r?.truthScore?.label ?? "",
        truthTopSepM: r?.truthScore?.topSepM, truthTopRelSep: r?.truthScore?.topRelSep,
        truthBestSepM: r?.truthScore?.bestSepM, truthBestName: r?.truthScore?.bestName ?? "",
        truthResidualDeg: r?.truthScore?.truthResidualDeg,
        directionTruthLabel: r?.directionScore?.label ?? "",
        directionTopDeg: r?.directionScore?.topDeg,
        directionBestDeg: r?.directionScore?.bestDeg,
        directionBestName: r?.directionScore?.bestName ?? "",
        elapsedMs: r?.elapsedMs, error: entry.error ?? "",
    };
}

function resultsToCsv(entries) {
    const lines = [CSV_COLUMNS.join(",")];
    for (const e of entries) {
        const rec = rowToCsvRecord(e);
        lines.push(CSV_COLUMNS.map((c) => csvEscape(rec[c])).join(","));
    }
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// summary report
// ---------------------------------------------------------------------------

function median(values) {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return NaN;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function padCell(value, width, right = false) {
    let s = String(value ?? "");
    if (s.length > width) s = s.slice(0, Math.max(1, width - 1)) + "…";
    return right ? s.padStart(width) : s.padEnd(width);
}

function buildSummaryReport(entries, options) {
    // Which option sets are actually represented among these rows. If a run
    // spans more than one, the header says so instead of quoting the controls'
    // current state as though it applied to everything.
    const optionSets = [...new Set(entries.filter((e) => e.options)
        .map((e) => JSON.stringify(e.options)))];
    const done = entries.filter((e) => e.status === "done" && e.row);
    const errors = entries.filter((e) => e.status === "error");
    const rows = done.map((e) => e.row);
    const withTruth = rows.filter((r) => r.truthScore);

    const L = [];
    L.push("=== Sitrec BotBench — bulk traverse analysis ===");
    L.push("");
    L.push("RUN");
    L.push("─".repeat(72));
    L.push(`  Files queued:            ${entries.length}`);
    L.push(`  Analysed:                ${done.length}`);
    L.push(`  Errors:                  ${errors.length}`);
    if (optionSets.length > 1) {
        L.push(`  MIXED SETTINGS — this table holds ${optionSets.length} batches run under`);
        L.push("  different options. Rows are NOT comparable across them; the per-row settings");
        L.push("  are in the CSV/JSON export.");
        for (const set of optionSets) {
            const o = JSON.parse(set);
            L.push(`    anchor ${(o.anchorM / METERS_PER_NM).toFixed(1)} NM, `
                + `bands ${o.solutionFamilies ? "on" : "off"}, `
                + `MC sweep ${o.mcOrderSweep ? "on" : "off"}`);
        }
    } else {
        const o = optionSets.length ? JSON.parse(optionSets[0]) : options;
        L.push(`  Range anchor:            ${(o.anchorM / METERS_PER_NM).toFixed(1)} NM `
            + `(the same for every file — see the note below)`);
        L.push(`  Range bands:             ${o.solutionFamilies ? "on" : "off"}`);
        L.push(`  Monte Carlo order sweep: ${o.mcOrderSweep ? "on" : "off"}`);
    }
    L.push("");
    L.push("  A bulk run has no loaded scene, so the following are ABSENT from every");
    L.push("  result. They are not failures and must not be read as negative evidence:");
    for (const a of ABSENT_HYPOTHESES) L.push(`    - ${a}`);
    L.push("");
    L.push("  The range anchor is fixed across the run on purpose. The interactive");
    L.push("  analysis anchors its search bracket on the Tgt Start Dist slider, which a");
    L.push("  user has usually already nudged toward the answer. Letting each file pick");
    L.push("  its own anchor would make the bracket a function of the answer and the");
    L.push("  cross-file comparison meaningless.");
    L.push("");

    if (done.length) {
        const grades = {};
        for (const r of rows) {
            const g = sourceQualityGrade(r.quality).grade;
            grades[g] = (grades[g] ?? 0) + 1;
        }
        const unobs = rows.filter((r) => r.rangeUnobservable).length;
        const poor = rows.filter((r) => r.quality.conditioning === "poor").length;
        const marginal = rows.filter((r) => r.quality.conditioning === "marginal").length;

        L.push("SOURCE DATA");
        L.push("─".repeat(72));
        for (const [g, c] of Object.entries(grades)) L.push(`  ${padCell(g + ":", 24)}${c}`);
        L.push(`  ${padCell("Range unobservable:", 24)}${unobs}`);
        L.push(`  ${padCell("CV conditioning poor:", 24)}${poor}`);
        L.push(`  ${padCell("CV conditioning marginal:", 24)}${marginal}`);
        L.push(`  ${padCell("Median sensor baseline:", 24)}${fmtMetres(median(rows.map((r) => r.quality.sensorSpanM)))}`);
        L.push(`  ${padCell("Median LOS sweep:", 24)}${n2(median(rows.map((r) => r.quality.sweepPathDeg)))}°`);

        // The estimated-vs-declared noise check is the single most useful
        // statement this tool can make about a set that declares its own error:
        // it says whether the files are as noisy as they claim.
        //
        // ONLY for white-noise files. A correlated (operator wobble) declaration
        // is a deadband amplitude, not a per-axis sigma, and wobble is smooth in
        // time so the second-difference estimator sees only its white residue.
        // Pooling the two would report wobble clips as several times quieter
        // than declared, which is an artefact of the estimator and not a fact
        // about the data.
        const comparable = rows.filter((r) => Number.isFinite(r.quality.noiseEstDeg)
            && Number.isFinite(r.quality.declaredLosSigmaDeg) && r.quality.declaredLosSigmaDeg > 0
            && !r.quality.losErrorCorrelated);
        const correlated = rows.filter((r) => r.quality.losErrorCorrelated);
        if (comparable.length) {
            const ratios = comparable.map((r) => r.quality.noiseEstDeg / r.quality.declaredLosSigmaDeg);
            L.push(`  ${padCell("Est/declared noise:", 24)}median ${n2(median(ratios))}x `
                + `over ${comparable.length} WHITE-noise file(s)`);
            L.push("      1.0 means the sightlines carry exactly the pointing error they declare.");
        }
        if (correlated.length) {
            const ratios = correlated
                .map((r) => r.quality.noiseEstDeg / r.quality.declaredLosSigmaDeg)
                .filter(Number.isFinite);
            L.push(`  ${padCell("Correlated-error files:", 24)}${correlated.length}, excluded from the `
                + `ratio above`);
            if (ratios.length) {
                L.push(`      Their estimate/declared median is ${n2(median(ratios))}x, which measures`);
                L.push("      the WHITE RESIDUE of operator wobble against a declared deadband");
                L.push("      amplitude. A large gap is the signature of wobble, not a disagreement.");
            }
        }
        L.push("");

        L.push("ANALYSIS");
        L.push("─".repeat(72));
        const codes = {};
        for (const r of rows) codes[r.verdictCode ?? "none"] = (codes[r.verdictCode ?? "none"] ?? 0) + 1;
        for (const [c, n] of Object.entries(codes).sort((a, b) => b[1] - a[1])) {
            L.push(`  ${padCell(c + ":", 24)}${n}`);
        }
        L.push(`  ${padCell("Median top |err|:", 24)}${n3(median(rows.map((r) => r.top?.errDeg)))}°`);
        const topKeys = {};
        for (const r of rows) if (r.top) topKeys[r.top.key] = (topKeys[r.top.key] ?? 0) + 1;
        L.push("  Top-ranked interpretation, by count:");
        for (const [k, n] of Object.entries(topKeys).sort((a, b) => b[1] - a[1])) {
            L.push(`    ${padCell(k, 20)}${n}`);
        }
        const failCounts = {};
        for (const r of rows) for (const f of r.failures) failCounts[f] = (failCounts[f] ?? 0) + 1;
        if (Object.keys(failCounts).length) {
            L.push("  Fits that failed at least once:");
            for (const [f, n] of Object.entries(failCounts).sort((a, b) => b[1] - a[1])) {
                L.push(`    ${padCell(f, 40)}${n}`);
            }
        }
        L.push("");

        if (withTruth.length) {
            L.push("AGAINST TRUTH");
            L.push("─".repeat(72));
            L.push(`  Files carrying truth:    ${withTruth.length}`);
            const rel = withTruth.map((r) => r.truthScore.topRelSep).filter(Number.isFinite);
            L.push(`  Median relative sep:     ${n3(median(rel))} `
                + `(top interpretation's mean separation / mean true range)`);
            const within10 = rel.filter((x) => x <= 0.10).length;
            L.push(`  Within 10% of range:     ${within10} / ${rel.length}`);
            // Whether the RANKING picked the best available candidate is a
            // different question from whether any candidate was close.
            const pickedBest = withTruth.filter((r) => Number.isFinite(r.truthScore.topSepM)
                && Number.isFinite(r.truthScore.bestSepM)
                && r.truthScore.topSepM <= r.truthScore.bestSepM * 1.05).length;
            L.push(`  Ranking picked the closest candidate: ${pickedBest} / ${withTruth.length}`);
            L.push("");
        } else {
            L.push("AGAINST TRUTH");
            L.push("─".repeat(72));
            L.push("  No file in this run carried a TruePosition column, so nothing here is");
            L.push("  scored positionally. The challenge set is published without truth by");
            L.push("  design; the answers/All release carries it.");
            L.push("");
        }

        // Direction truth is a SEPARATE table, in degrees. Merging it into the
        // metre-valued block above would average two different quantities.
        const dirRows = rows.filter((r) => r.directionScore);
        if (dirRows.length) {
            L.push("AGAINST DIRECTION TRUTH (degrees of bearing error)");
            L.push("─".repeat(72));
            L.push(`  Files with direction truth: ${dirRows.length}`);
            L.push(`  Median top bearing error:   ${n3(median(dirRows.map((r) => r.directionScore.topDeg)))}°`);
            L.push(`  Median best-candidate:      ${n3(median(dirRows.map((r) => r.directionScore.bestDeg)))}°`);
            L.push("  These targets have no finite range, so they carry no separation in metres");
            L.push("  and are deliberately excluded from every figure in the block above.");
            L.push("");
        }
    }

    if (errors.length) {
        L.push("ERRORS");
        L.push("─".repeat(72));
        for (const e of errors) L.push(`  ${e.relativePath}: ${e.error}`);
        L.push("");
    }

    L.push("FILES");
    L.push("─".repeat(72));
    const cols = [
        {h: "File", w: 30, get: (e) => e.relativePath},
        {h: "n", w: 5, get: (e) => e.row?.quality.frames ?? "", right: true},
        {h: "Base", w: 8, get: (e) => fmtMetres(e.row?.quality.sensorSpanM), right: true},
        {h: "Sweep", w: 7, get: (e) => n2(e.row?.quality.sweepPathDeg), right: true},
        {h: "rcond", w: 8, get: (e) => n3(e.row?.quality.rcond), right: true},
        {h: "Src", w: 5, get: (e) => (e.row ? sourceQualityGrade(e.row.quality).grade : "")},
        {h: "Verdict", w: 26, get: (e) => e.row?.headline ?? e.error ?? ""},
        {h: "Top", w: 22, get: (e) => e.row?.top?.name ?? ""},
        {h: "|err|", w: 7, get: (e) => n3(e.row?.top?.errDeg), right: true},
        {h: "RelSep", w: 7, get: (e) => n3(e.row?.truthScore?.topRelSep), right: true},
    ];
    L.push(cols.map((c) => padCell(c.h, c.w, c.right)).join(" "));
    L.push(cols.map((c) => "─".repeat(c.w)).join(" "));
    for (const e of entries) L.push(cols.map((c) => padCell(c.get(e), c.w, c.right)).join(" "));
    return L.join("\n");
}

// ---------------------------------------------------------------------------
// file collection
// ---------------------------------------------------------------------------

/**
 * Pair each analysable file with its sidecars.
 *
 * A BOT scenario is two or three sibling files (`bot-0001.input.csv`,
 * `bot-0001.scenario.json`, sometimes `bot-0001.truth.json`), and only the
 * directory walk can see them together — by the time a file reaches the
 * ingest it is a lone Blob. So the walk collects every candidate, then this
 * attaches the sidecar TEXT to the row that needs it.
 */
async function pairSidecars(found) {
    const sidecars = new Map();
    const labels = new Map();
    const rows = [];
    for (const f of found) {
        const role = botBenchFileRole(f.name);
        const key = (f.relativePath.replace(/[^/]*$/, "")) + botBenchScenarioBase(f.name);
        if (role === "bot-sidecar") sidecars.set(key, f);
        else if (role === "bot-labels") labels.set(key, f);
        else if (role === "bot-csv" || role === "fmv") rows.push({...f, key});
    }
    for (const r of rows) {
        const s = sidecars.get(r.key);
        if (s) {
            try { r.sidecarText = await (await s.getFile()).text(); }
            catch (e) { /* ingest warns about the missing sidecar */ }
        }
        const l = labels.get(r.key);
        if (l) {
            try { r.labelsText = await (await l.getFile()).text(); }
            catch (e) { /* labels are optional */ }
        }
    }
    rows.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return rows;
}

// Anything BotBench might want from a walk, including the sidecars that are not
// themselves rows.
function isCollectable(name) {
    return botBenchFileRole(name) !== null;
}

function fsEntryToFile(fsEntry) {
    return new Promise((resolve, reject) => fsEntry.file(resolve, reject));
}

/**
 * @param depth 0 for the dropped item itself.
 *
 * A DROPPED FOLDER IS ALWAYS OPENED, whatever "Recursive" says. That checkbox
 * means "descend into SUBfolders" — dropping a folder and being told "no files
 * found" because the one directory the user explicitly handed over was never
 * read is not a setting, it is a dead end with no way to reach the files short
 * of guessing that the checkbox is at fault.
 */
function collectFsEntry(fsEntry, basePath, out, recursive, depth = 0) {
    return new Promise((resolve) => {
        const rel = basePath ? `${basePath}/${fsEntry.name}` : fsEntry.name;
        if (fsEntry.isFile) {
            if (isCollectable(fsEntry.name)) {
                out.push({name: fsEntry.name, relativePath: rel, getFile: () => fsEntryToFile(fsEntry)});
            }
            resolve();
        } else if (fsEntry.isDirectory && (recursive || depth === 0)) {
            const reader = fsEntry.createReader();
            const readBatch = () => reader.readEntries(async (batch) => {
                if (!batch.length) { resolve(); return; }
                for (const child of batch) await collectFsEntry(child, rel, out, recursive, depth + 1);
                readBatch();
            }, () => resolve());
            readBatch();
        } else {
            resolve();
        }
    });
}

async function entriesFromDataTransfer(dataTransfer, recursive) {
    const out = [];
    const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
    const fsEntries = items
        .filter((it) => it.kind === "file" && typeof it.webkitGetAsEntry === "function")
        .map((it) => it.webkitGetAsEntry())
        .filter(Boolean);
    if (fsEntries.length) {
        for (const fe of fsEntries) await collectFsEntry(fe, "", out, recursive);
    }
    if (!out.length) {
        for (const file of Array.from(dataTransfer.files || [])) {
            if (isCollectable(file.name)) {
                out.push({name: file.name, relativePath: file.name, getFile: () => Promise.resolve(file)});
            }
        }
    }
    return pairSidecars(out);
}

// The CHOSEN folder is always read; `recursive` governs its subfolders only —
// the same rule as the drop path above.
async function walkDirectoryHandle(directoryHandle, {recursive, basePath = "", onFound = null} = {}) {
    const files = [];
    for await (const [name, handle] of directoryHandle.entries()) {
        const relativePath = basePath ? `${basePath}/${name}` : name;
        if (handle.kind === "file") {
            if (isCollectable(name)) {
                const entry = {name, relativePath, getFile: () => handle.getFile()};
                files.push(entry);
                onFound?.(entry);
            }
        } else if (recursive && handle.kind === "directory") {
            files.push(...await walkDirectoryHandle(handle, {recursive, basePath: relativePath, onFound}));
        }
    }
    return files;
}

// ---------------------------------------------------------------------------
// dialog chrome
// ---------------------------------------------------------------------------

function makeButton(label, color = "#1976d2", tooltip = BUTTON_TOOLTIPS[label]) {
    const button = document.createElement("button");
    button.textContent = label;
    if (tooltip) {
        button.title = tooltip;
        button.setAttribute("aria-label", tooltip);
    }
    button.style.cssText = `
        background: ${color}; color: white; border: none;
        padding: 8px 12px; border-radius: 4px; cursor: pointer; font-size: 13px;
        min-height: 34px;
    `;
    return button;
}

function smallButton(label, color, tooltip) {
    const b = makeButton(label, color, tooltip);
    b.style.padding = "2px 5px";
    b.style.minHeight = "20px";
    b.style.fontSize = "10px";
    b.style.whiteSpace = "nowrap";
    return b;
}

function setButtonDisabled(button, disabled) {
    button.disabled = disabled;
    button.style.opacity = disabled ? "0.5" : "1";
    button.style.cursor = disabled ? "default" : "pointer";
}

/**
 * Hold playback paused for the duration of the run.
 *
 * Not cosmetic: these fits are a multi-second main-thread number-crunch each,
 * and letting the render loop and the node graph keep recalculating alongside
 * them roughly doubles the wall clock of a long run for output nobody is
 * looking at. Restored exactly on close, like the FMV analyser does.
 */
function acquireAnalysisPauseLock(state) {
    if (state.pauseLock) return;
    const hadNoLogic = Object.prototype.hasOwnProperty.call(par, "noLogic");
    state.pauseLock = {paused: par.paused, noLogic: par.noLogic, hadNoLogic, timer: null};
    const enforcePause = () => { par.paused = true; par.noLogic = true; };
    enforcePause();
    state.pauseLock.timer = setInterval(enforcePause, 250);
    setRenderOne(true);
}

function releaseAnalysisPauseLock(state) {
    const lock = state.pauseLock;
    if (!lock) return;
    if (lock.timer) clearInterval(lock.timer);
    if (lock.hadNoLogic) par.noLogic = lock.noLogic;
    else delete par.noLogic;
    par.paused = lock.paused;
    state.pauseLock = null;
    setRenderOne(true);
}

function labelledCheckbox(text, tooltip, checked = false) {
    const label = document.createElement("label");
    label.title = tooltip;
    label.style.cssText = "display: inline-flex; align-items: center; gap: 6px; font-size: 13px;";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.title = tooltip;
    label.appendChild(input);
    label.appendChild(document.createTextNode(text));
    return {label, input};
}

function createDialog() {
    if (activeDialog?.overlay?.parentNode) {
        releaseAnalysisPauseLock(activeDialog);
        document.body.removeChild(activeDialog.overlay);
    }

    const overlay = document.createElement("div");
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0, 0, 0, 0.5); z-index: 10000;
        display: flex; align-items: center; justify-content: center;
    `;

    const modal = document.createElement("div");
    modal.style.cssText = `
        background: white; border-radius: 8px; padding: 16px;
        width: 98vw; height: 98vh; max-width: none;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        font-family: Arial, sans-serif; display: flex; flex-direction: column;
        box-sizing: border-box; color: #222; position: relative;
    `;

    const title = document.createElement("h3");
    title.textContent = "BotBench — bulk traverse analysis";
    title.title = "Run the traverse analysis over many files and compare the results. "
        + "Drag a folder of BOT interchange scenarios or FMV clips anywhere onto this window.";
    title.style.cssText = "margin: 0; color: #1976d2; font-size: 18px; flex: 0 0 auto;";

    const header = document.createElement("div");
    header.style.cssText = "display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px;";
    header.appendChild(title);
    const closeButton = makeButton("Close", "#757575");
    header.appendChild(closeButton);

    const controls = document.createElement("div");
    controls.style.cssText = `
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        border: 1px solid #ddd; border-radius: 6px; padding: 10px; margin-bottom: 8px;
    `;

    const recursive = labelledCheckbox("Recursive",
        "Include candidate files in subfolders of a chosen or dropped folder.", true);
    const families = labelledCheckbox("Range bands",
        "Re-fit each physics model at a ladder of held ranges to find the range interval it still "
        + "admits. Several extra fits per model — roughly triples the time per file.", false);
    const mcSweep = labelledCheckbox("Monte Carlo sweep",
        "Add the two Monte Carlo curve-fit strategies across polynomial orders. A method "
        + "diagnostic; adds 10 candidates per file and is the bulk of the sweep's cost.", false);

    const anchorLabel = document.createElement("label");
    anchorLabel.title = "The start range the search bracket is centred on, in nautical miles — "
        + "the SAME for every file in the run. The interactive analysis uses the Tgt Start Dist "
        + "slider here, but a bulk run must not tune the bracket per file or the comparison "
        + "stops meaning anything.";
    anchorLabel.style.cssText = "display: inline-flex; align-items: center; gap: 6px; font-size: 13px;";
    const anchorInput = document.createElement("input");
    anchorInput.type = "number";
    anchorInput.min = "0.3";
    anchorInput.max = "90";
    anchorInput.step = "0.5";
    anchorInput.value = String(DEFAULT_ANCHOR_M / METERS_PER_NM);
    anchorInput.style.cssText = "width: 64px; font-size: 13px; padding: 3px;";
    anchorLabel.appendChild(document.createTextNode("Range anchor"));
    anchorLabel.appendChild(anchorInput);
    anchorLabel.appendChild(document.createTextNode("NM"));

    const chooseFolderButton = makeButton("Choose Folder");
    const chooseFilesButton = makeButton("Choose Files");
    const cancelButton = makeButton("Cancel Run", "#d32f2f");
    const clearButton = makeButton("Clear Results", "#d32f2f");
    const exportJsonButton = makeButton("Export JSON", "#455a64");
    const exportCsvButton = makeButton("Export CSV", "#455a64");
    const summaryButton = makeButton("Summary", "#00695c");

    for (const el of [recursive.label, families.label, mcSweep.label, anchorLabel,
        chooseFolderButton, chooseFilesButton, cancelButton, clearButton,
        exportJsonButton, exportCsvButton, summaryButton]) {
        controls.appendChild(el);
    }

    const status = document.createElement("div");
    status.textContent = "Ready — choose a folder or drag one onto this window. "
        + "BOT interchange scenarios (.input/.all.csv + .scenario.json) and FMV clips (.ts/.klv).";
    status.style.cssText = "font-size: 13px; margin: 0 0 6px 0; min-height: 18px; color: #333;";

    const progress = document.createElement("progress");
    progress.max = 1;
    progress.value = 0;
    progress.title = "Progress across the queued files.";
    progress.style.cssText = "width: 100%; height: 12px; margin-bottom: 8px; flex: 0 0 auto;";

    const summary = document.createElement("div");
    summary.style.cssText = `
        display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 8px; margin-bottom: 8px; font-size: 12px;
    `;

    const tableWrap = document.createElement("div");
    tableWrap.style.cssText = "flex: 1 1 auto; min-height: 0; overflow: auto; border: 1px solid #ddd; border-radius: 6px;";

    const table = document.createElement("table");
    table.style.cssText = `width: 100%; min-width: ${TABLE_MIN_WIDTH_PX}px;`
        + " border-collapse: collapse; font-size: 12px; table-layout: fixed;";
    // COLUMN WIDTHS LIVE IN A <colgroup>, NOT ON THE HEADER CELLS.
    //
    // With `table-layout: fixed` the browser takes its column widths from the
    // table's FIRST ROW — and the first row here is the group band
    // ("SOURCE DATA" / "ANALYSIS RESULT"), whose colSpan cells describe no
    // individual column. So width set on the second header row was ignored
    // outright and all 17 columns came out identical (measured: 109px each,
    // 1848/17), which is why the numeric columns looked padded while Verdict
    // and Top interpretation were clipped. A colgroup is honoured whatever the
    // header rows do.
    const colgroup = document.createElement("colgroup");
    for (const [, width] of TABLE_COLUMNS) {
        const col = document.createElement("col");
        col.style.width = width;
        colgroup.appendChild(col);
    }
    table.appendChild(colgroup);

    const thead = document.createElement("thead");
    thead.style.cssText = "position: sticky; top: 0; z-index: 1;";

    // A group band above the column names, so "Frames..Source describe the data"
    // and "Verdict..Truth describe the conclusion" is visible rather than
    // something a reader has to work out from the tooltips.
    const groupRow = document.createElement("tr");
    const groupSpans = [];
    for (const [, , , group] of TABLE_COLUMNS) {
        const last = groupSpans[groupSpans.length - 1];
        if (last && last.group === group) last.span++;
        else groupSpans.push({group, span: 1});
    }
    for (const {group, span} of groupSpans) {
        const th = document.createElement("th");
        th.colSpan = span;
        th.textContent = group === "source" ? "SOURCE DATA (measured before any fit)"
            : group === "analysis" ? "ANALYSIS RESULT" : "";
        th.style.cssText = `text-align: left; padding: 4px 8px; font-size: 11px; letter-spacing: .04em;
            color: #4a5b6b; background: ${GROUP_COLOURS[group]}; border-bottom: 1px solid #ccd;`;
        groupRow.appendChild(th);
    }
    const headerRow = document.createElement("tr");
    for (const [label, , tooltip, group] of TABLE_COLUMNS) {
        const th = document.createElement("th");
        th.textContent = label;
        th.title = tooltip || label;
        th.style.cssText = "text-align: left; padding: 5px 5px; border-bottom: 1px solid #ddd; "
            + `background: ${GROUP_COLOURS[group]}; font-size: 11px; `
            + "white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
        headerRow.appendChild(th);
    }
    thead.appendChild(groupRow);
    thead.appendChild(headerRow);
    const tbody = document.createElement("tbody");
    table.appendChild(thead);
    table.appendChild(tbody);
    tableWrap.appendChild(table);

    const dropHint = document.createElement("div");
    dropHint.textContent = "Drop a folder of BOT scenarios or FMV clips";
    dropHint.style.cssText = `
        position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
        background: rgba(25,118,210,0.10); border: 3px dashed #1976d2; border-radius: 8px;
        color: #1976d2; font-size: 22px; font-weight: 700; pointer-events: none; z-index: 5;
    `;

    modal.appendChild(header);
    modal.appendChild(controls);
    modal.appendChild(status);
    modal.appendChild(progress);
    modal.appendChild(summary);
    modal.appendChild(tableWrap);
    modal.appendChild(dropHint);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const state = {
        overlay, modal, dropHint,
        recursiveInput: recursive.input,
        familiesInput: families.input,
        mcSweepInput: mcSweep.input,
        anchorInput,
        chooseFolderButton, chooseFilesButton, cancelButton, clearButton,
        closeButton, exportJsonButton, exportCsvButton, summaryButton,
        status, progress, summary, tbody,
        entries: [],
        nextRowId: 0,
        cancelled: false,
        running: false,
        pauseLock: null,
        heldFrames: 0,
        memoryNote: "",
    };
    acquireAnalysisPauseLock(state);
    activeDialog = state;
    return state;
}

function summaryCell(label, value) {
    const tooltip = SUMMARY_TOOLTIPS[label] || label;
    const cell = document.createElement("div");
    cell.title = tooltip;
    cell.style.cssText = "border: 1px solid #ddd; border-radius: 6px; padding: 6px; background: #fafafa; min-width: 0;";
    const labelEl = document.createElement("div");
    labelEl.textContent = label;
    labelEl.style.cssText = "color: #607d8b; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    const valueEl = document.createElement("div");
    valueEl.textContent = value;
    valueEl.style.cssText = "font-size: 15px; font-weight: 700; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    cell.appendChild(labelEl);
    cell.appendChild(valueEl);
    return cell;
}

function updateSummary(state) {
    const done = state.entries.filter((e) => e.status === "done" && e.row);
    const rows = done.map((e) => e.row);
    const errors = state.entries.filter((e) => e.status === "error").length;
    const good = rows.filter((r) => sourceQualityGrade(r.quality).grade === "good").length;
    const unobs = rows.filter((r) => r.rangeUnobservable).length;
    // A verdict whose top candidate contradicts the file's own declared
    // MaxRange is not a resolution — counting it as one advertises agreement
    // the evidence does not support.
    const contradicted = (r) => (r.maxRangeViolations ?? []).some((v) =>
        v.key === r.top?.key && v.name === r.top?.name);
    const wouldResolve = (r) => r.verdictCode && r.verdictCode !== "unresolved";
    const resolved = rows.filter((r) => wouldResolve(r) && !contradicted(r)).length;
    // Only the rows this actually SUBTRACTS. Counting every contradicted row
    // included ones already unresolved for other reasons, so the parenthetical
    // claimed to have excluded more than it did.
    const contradictedCount = rows.filter((r) => wouldResolve(r) && contradicted(r)).length;
    const truthRows = rows.filter((r) => r.truthScore);
    // Direction-truth rows ARE scored — in degrees rather than metres — so
    // counting only the positional ones reported Venus as unscored in the
    // summary while its row showed a number. Counted together, kept separate.
    const dirRows = rows.filter((r) => r.directionScore);

    state.summary.innerHTML = "";
    state.summary.appendChild(summaryCell("Queued", state.entries.length));
    state.summary.appendChild(summaryCell("Analysed", done.length));
    state.summary.appendChild(summaryCell("Errors", errors));
    state.summary.appendChild(summaryCell("Good source", good));
    state.summary.appendChild(summaryCell("Range unobservable", unobs));
    state.summary.appendChild(summaryCell("Resolved",
        contradictedCount ? `${resolved} (−${contradictedCount})` : resolved));
    state.summary.appendChild(summaryCell("With truth",
        dirRows.length ? `${truthRows.length}+${dirRows.length}` : truthRows.length));
    state.summary.appendChild(summaryCell("Median |err|",
        n3(median(rows.map((r) => r.top?.errDeg)))));
    if (truthRows.length) {
        state.summary.appendChild(summaryCell("Median rel. sep",
            n3(median(truthRows.map((r) => r.truthScore.topRelSep)))));
    }
}

function makeRow(state, entry) {
    const tr = document.createElement("tr");
    tr.style.cssText = "border-bottom: 1px solid #eee;";
    const cells = [];
    for (let i = 0; i < TABLE_COLUMNS.length; i++) {
        const td = document.createElement("td");
        // One line, always. Anything too long is clipped with an ellipsis and
        // carries its full text in the cell's title — a wrapped cell costs
        // every OTHER column in the row its height.
        td.style.cssText = "padding: 4px 5px; vertical-align: middle; white-space: nowrap; "
            + "overflow: hidden; text-overflow: ellipsis;";
        cells.push(td);
        tr.appendChild(td);
    }
    cells[0].textContent = entry.relativePath;
    cells[0].title = entry.relativePath;
    // A deep relative path is identified by its END, so clip the front.
    cells[0].style.direction = "rtl";
    cells[0].style.textAlign = "left";
    cells[1].textContent = "Queued";
    state.tbody.appendChild(tr);
    entry.tr = tr;
    entry.cells = cells;
    return entry;
}

function setRowStatus(entry, text, tooltip = "") {
    if (!entry.cells) return;
    entry.cells[1].textContent = text;
    if (tooltip) entry.cells[1].title = tooltip;
}

// Shade a source-quality cell so a scan down the column shows where the data
// stops supporting the question, without needing to read the numbers.
const GRADE_COLOURS = {good: "#2e7d32", fair: "#f9a825", hard: "#ef6c00", weak: "#c62828"};

function fillRow(state, entry) {
    const c = entry.cells;
    const r = entry.row;
    if (!r) return;
    const q = r.quality;
    const grade = sourceQualityGrade(q);

    c[1].textContent = "done";
    c[1].title = r.warnings.length ? r.warnings.join("\n") : "";
    c[2].textContent = n0(q.frames);
    c[3].textContent = n1(q.durationS);
    c[4].textContent = q.fps >= 1 ? n0(q.fps) : n2(q.fps);
    c[5].textContent = fmtMetres(q.sensorSpanM);
    c[5].title = `Path length ${fmtMetres(q.sensorPathM)}; straightness `
        + `${n2(q.straightness)} (1 = a straight run, which is the degenerate case for range); `
        + `altitude span ${fmtMetres(q.sensorAltSpanM)}`;
    c[6].textContent = n2(q.sweepPathDeg);
    c[6].title = `Net end-to-end bearing change ${n2(q.netSweepDeg)}°; median rate `
        + `${n3(q.rateMedianDegPerS)}°/s. A large path with a small net change means the `
        + `sightline went out and came back.`;
    c[7].textContent = n3(q.rcond);
    c[7].title = `${q.conditioning} (effective rank ${q.effectiveRank ?? "?"} of 6). `
        + `This is a CV-FAMILY statement only.`;
    c[8].textContent = n3(q.noiseEstDeg);
    c[8].title = `Median second-difference angle ${n3(q.jitterDeg)}°, de-biased by 1.4422 `
        + `under an assumption of isotropic Gaussian pointing error on a locally straight `
        + `path. On a slowly-sampled manoeuvring target the curvature term inflates this.`;
    c[9].textContent = n3(q.declaredLosSigmaDeg)
        + (q.losErrorCorrelated ? "*" : "");
    c[9].title = q.declaredLosSigmaDeg == null ? "This file declares no pointing error."
        : q.losErrorCorrelated
            ? `Error model: ${q.losErrorModel ?? "correlated"} — NOT comparable with the `
                + `estimate to the left. ${q.losErrorNote ?? ""}\n\nCorrelated (operator wobble) `
                + `error is smooth in time, so a second-difference estimator sees only its white `
                + `residue and reads much lower. The GAP is the signature of wobble, not a `
                + `disagreement about magnitude.`
            : `Error model: ${q.losErrorModel ?? "white"} — a per-axis 1-sigma, directly `
                + `comparable with the estimate to the left. ${q.losErrorNote ?? ""}`;
    c[10].textContent = grade.grade;
    c[10].style.color = GRADE_COLOURS[grade.grade] ?? "";
    c[10].style.fontWeight = "700";
    c[10].title = (grade.reasons.length ? grade.reasons.join("\n") : "No flagged degeneracy.")
        + (r.earthModel ? `\n\nEarth model in force: ${r.earthModel}.` : "")
        + (r.surfaceModel ? `\nGround: ${r.surfaceModel}.` : "");

    c[11].textContent = shortVerdict(r.headline, r.verdictCode);
    c[11].title = (r.headline ? r.headline + "\n\n" : "")
        + (r.viableClasses.length
        ? `Viable classes: ${r.viableClasses.join(", ")}.` : "No class reached viable.")
        + (r.rangeUnobservable
            ? "\n\nRange is UNOBSERVABLE from this sensor baseline — no free-range method can "
            + "determine distance here, whatever the residuals say." : "")
        + (r.failures.length ? `\n\nFits that failed: ${r.failures.join(", ")}` : "");
    // A top candidate that contradicts the file's declared MaxRange must SAY so
    // on the row. The cap can only constrain the searches that take a range
    // bound, so a violation is a real possibility, and one that silently
    // ranking first is the whole problem.
    const topViolates = (r.maxRangeViolations ?? []).some((v) => v.key === r.top?.key
        && v.name === r.top?.name);
    c[12].textContent = (topViolates ? "⚠ " : "") + (r.top?.name ?? "");
    const otherViolators = (r.maxRangeViolations ?? []).length - (topViolates ? 1 : 0);
    c[12].title = (r.top ? `Rank tier: ${r.top.tier}. ${r.candidates} candidates considered.` : "")
        + (topViolates
            ? `\n\nCONTRADICTS THE DECLARED MaxRange of ${fmtMetres(r.declaredMaxRangeM)}: this `
                + `candidate places the object beyond the range the file itself says the sensor `
                + `could measure. The cap constrains the searches that take a range bound; it `
                + `cannot constrain the physics, polynomial or stationary fits, nor any track's `
                + `range later in the clip.`
            : "")
        // The count belongs on BOTH branches. It was previously only on the
        // compliant one, so the rows where it mattered most — a violating top —
        // were the rows that never showed how many others were violating too.
        + (otherViolators > 0
            ? `\n\n${otherViolators} other candidate(s) also exceed the declared MaxRange of `
                + `${fmtMetres(r.declaredMaxRangeM)}.`
            : "");
    if (topViolates) c[12].style.color = "#c62828";
    c[13].textContent = n3(r.top?.errDeg);
    c[14].textContent = Number.isFinite(r.top?.rangeStartM)
        ? n2(r.top.rangeStartM / METERS_PER_NM) : "";
    c[14].title = Number.isFinite(r.top?.rangeStartM)
        ? `${fmtMetres(r.top.rangeStartM)}` + (Number.isFinite(r.top?.speedKt)
            ? `, mean air speed ${n0(r.top.speedKt)} kt` : "") : "";

    if (r.truthScore) {
        const ts = r.truthScore;
        c[15].textContent = Number.isFinite(ts.topRelSep)
            ? `${(ts.topRelSep * 100).toFixed(1)}%` : (Number.isFinite(ts.topSepM) ? fmtMetres(ts.topSepM) : "—");
        c[15].title = `Top interpretation is ${fmtMetres(ts.topSepM)} from truth`
            + (Number.isFinite(ts.topRelSep) ? ` (${(ts.topRelSep * 100).toFixed(1)}% of the true range)` : "")
            + `.\nClosest candidate of any: ${fmtMetres(ts.bestSepM)} (${ts.bestName ?? "—"}).`
            + (Number.isFinite(ts.truthResidualDeg)
                ? `\nTruth's own LOS residual — the achievable floor — is ${n3(ts.truthResidualDeg)}°.` : "");
        // Green when the analysis both picked well and landed close.
        const good = Number.isFinite(ts.topRelSep) && ts.topRelSep <= 0.10;
        c[15].style.color = good ? "#2e7d32" : (Number.isFinite(ts.topRelSep) ? "#c62828" : "");
    } else if (r.directionScore) {
        // DEGREES, not metres, and labelled so. A direction-only target has no
        // range to be right or wrong about; the comparable quantity is bearing
        // error. Showing a blank here previously read as "could not be scored".
        const ds = r.directionScore;
        c[15].textContent = Number.isFinite(ds.topDeg) ? `${n2(ds.topDeg)}°` : "—";
        c[15].title = `${ds.label}. The top interpretation's mean BEARING error is `
            + `${n3(ds.topDeg)}°; the closest candidate of any was ${ds.bestName} at `
            + `${n3(ds.bestDeg)}°.\n\nThis target has no finite range, so 3-D separation and `
            + `relative separation are undefined for it — this column is in degrees for this `
            + `row and metres/percent for the others, and the two are never averaged together.`;
        c[15].style.color = Number.isFinite(ds.topDeg) && ds.topDeg <= 1 ? "#2e7d32" : "#c62828";
    } else {
        c[15].textContent = "";
        c[15].title = "This file carries no TruePosition column and no direction truth, "
            + "so nothing here is scored.";
    }

    // Actions: the full gallery, and the HTML report.
    c[16].innerHTML = "";
    const galleryButton = smallButton("Gallery", "#1976d2", BUTTON_TOOLTIPS["Gallery"]);
    galleryButton.onclick = () => {
        try {
            showTraverseGallery(entry.results);
        } catch (e) {
            showError("Could not open the gallery for this result: " + (e && e.message), e);
        }
    };
    c[16].appendChild(galleryButton);
    const reportButton = smallButton("Report", "#455a64", BUTTON_TOOLTIPS["Report"]);
    reportButton.style.marginLeft = "3px";
    reportButton.onclick = () => openReport(entry, reportButton);
    c[16].appendChild(reportButton);

    entry.tr.style.background = grade.grade === "weak" ? "#fff5f5"
        : grade.grade === "hard" ? "#fffaf0" : "#f7fff7";
}

function openReport(entry, button) {
    const original = button.textContent;

    // OPEN THE WINDOW FIRST, SYNCHRONOUSLY IN THE CLICK.
    //
    // The report is dozens of chart encodes and ~10 MB of string — seconds of
    // work. A browser only honours window.open while the user's transient
    // activation is still live (a few seconds), and it does not survive a timer
    // plus a long synchronous build, so opening AFTER the build meant the
    // Report button silently did nothing on exactly the heavy reports people
    // most want to read. Claim the window on the click, fill it once the HTML
    // exists.
    const w = window.open("", "_blank");
    if (!w) {
        showError("The report window was blocked by the browser's popup blocker. "
            + "Allow popups for this site and click Report again.");
        return;
    }
    w.document.open();
    w.document.write("<!doctype html><meta charset=\"utf-8\">"
        + "<title>Building report…</title>"
        + "<body style=\"font:14px system-ui;padding:24px;background:#12161c;color:#cfd8e3\">"
        + "Building the traverse analysis report…");

    button.textContent = "…";
    setButtonDisabled(button, true);
    // Yield once so the placeholder paints before the build locks the thread.
    setTimeout(() => {
        try {
            // NOT cached on the entry. The report is ~10 MB of string per file,
            // and a bulk run holds every row for the lifetime of the dialog —
            // caching it turned "opened a few reports" into hundreds of
            // megabytes retained for no benefit, since the window keeps the
            // copy it was handed. Rebuilding costs a few seconds on the rare
            // second look.
            const html = entry.results.buildHtml();
            w.document.open();
            w.document.write(html);
            w.document.close();
        } catch (e) {
            try { w.close(); } catch (_) { /* already gone */ }
            showError("Could not build the report: " + (e && e.message), e);
        } finally {
            button.textContent = original;
            setButtonDisabled(button, false);
        }
    }, 0);
}

function setRowError(entry, message) {
    const c = entry.cells;
    c[1].textContent = "error";
    c[1].title = message;
    c[11].textContent = message;
    c[11].title = message;
    entry.tr.style.background = "#fff5f5";
}

function refreshControls(state) {
    const running = state.running;
    const has = state.entries.length > 0;
    setButtonDisabled(state.chooseFolderButton, running);
    setButtonDisabled(state.chooseFilesButton, running);
    setButtonDisabled(state.cancelButton, !running);
    setButtonDisabled(state.clearButton, running || !has);
    setButtonDisabled(state.exportJsonButton, running || !has);
    setButtonDisabled(state.exportCsvButton, running || !has);
    setButtonDisabled(state.summaryButton, running || !has);
    state.recursiveInput.disabled = running;
    state.familiesInput.disabled = running;
    state.mcSweepInput.disabled = running;
    state.anchorInput.disabled = running;
}

function clearResults(state) {
    if (state.running) return;
    state.entries = [];
    state.heldFrames = 0;
    state.memoryNote = "";
    state.tbody.innerHTML = "";
    state.progress.value = 0;
    state.status.textContent = "Cleared. Choose a folder or drag one onto this window.";
    updateSummary(state);
    refreshControls(state);
}

// The bracket the anchor may sit in. These are the clamps adaptiveRangeList
// itself applies (lo >= 0.3 NM, hi <= 90 NM); an anchor outside them produces a
// grid whose low end has been clamped UP while its high end is clamped DOWN —
// i.e. a DESCENDING range list, which every downstream sweep reads as a valid
// ascending one. A number input's min/max attributes are advisory for typed
// text, so the clamp has to happen here.
const ANCHOR_MIN_NM = 0.3;
const ANCHOR_MAX_NM = 90;

function runOptions(state) {
    const raw = Number(state.anchorInput.value);
    const nm = Number.isFinite(raw) && raw > 0
        ? Math.min(ANCHOR_MAX_NM, Math.max(ANCHOR_MIN_NM, raw))
        : DEFAULT_ANCHOR_M / METERS_PER_NM;
    // Show the value that was actually used, so a silently clamped entry cannot
    // be mistaken for the one on screen.
    if (String(nm) !== state.anchorInput.value) state.anchorInput.value = String(nm);
    return {
        anchorM: nm * METERS_PER_NM,
        solutionFamilies: state.familiesInput.checked,
        mcOrderSweep: state.mcSweepInput.checked,
    };
}

// A macrotask yield that background-tab throttling does not clamp (unlike
// setTimeout, which Chrome drops to ~1/minute in a hidden tab — that would drag
// a 30-file run out to hours). Same reasoning as AnalyzeTraverse's makeYield.
function makeYield() {
    if (typeof MessageChannel === "undefined") {
        return () => new Promise((resolve) => setTimeout(resolve, 0));
    }
    const channel = new MessageChannel();
    let pending = null;
    channel.port1.onmessage = () => { const r = pending; pending = null; if (r) r(); };
    return () => new Promise((resolve) => { pending = resolve; channel.port2.postMessage(0); });
}

async function analyzeEntries(state, found) {
    if (state.running) return;
    if (!found.length) {
        state.status.textContent = "No BOT interchange or FMV files found.";
        return;
    }
    state.running = true;
    state.cancelled = false;
    refreshControls(state);

    const options = runOptions(state);
    const yieldToDOM = makeYield();

    for (let i = 0; i < found.length; i++) {
        if (state.cancelled) break;
        // The options this file was actually run under, frozen per entry. The
        // dialog's controls stay live between batches, so a run at one anchor
        // followed by a run at another used to have BOTH batches labelled with
        // whatever the controls read at export time — making a deliberately
        // mixed comparison look uniform, which is the one thing it must not do.
        const entry = {...found[i], key: state.nextRowId++, status: "queued", row: null,
            results: null, options: {...options}};
        state.entries.push(entry);
        makeRow(state, entry);
        state.progress.value = i / found.length;
        state.status.textContent = `Analysing ${i + 1} of ${found.length}: `
            + `${entry.relativePath}${state.memoryNote ?? ""}`;
        await yieldToDOM();

        try {
            setRowStatus(entry, "reading");
            await yieldToDOM();
            const record = await ingestBotBenchEntry(entry);

            const {results, row} = await runBotBenchAnalysis(record, {
                ...options,
                isCancelled: () => state.cancelled,
                onProgress: async (frac, label) => {
                    setRowStatus(entry, `${Math.round(frac * 100)}%`, label);
                    state.progress.value = (i + frac) / found.length;
                    await yieldToDOM();
                },
            });
            entry.results = results;
            entry.row = row;
            entry.status = "done";
            fillRow(state, entry);
        } catch (error) {
            if (state.cancelled) {
                entry.status = "cancelled";
                setRowStatus(entry, "cancelled");
                break;
            }
            entry.status = "error";
            entry.error = error?.message || String(error);
            setRowError(entry, entry.error);
        }
        updateSummary(state);
        // EVERY ROW HOLDS ITS FULL RESULTS — that is what makes "Gallery"
        // instant, and it means memory grows with files x frames x candidates.
        // Checked EVERY FILE, not once at the end: a warning that arrives after
        // the batch arrives after the browser has already struggled. Shown in
        // the visible status line rather than a tooltip nobody hovers.
        state.heldFrames = state.entries.reduce((sum, e) =>
            sum + (e.results?.dataset?.n ?? 0) * (e.results?.hypotheses?.length ?? 0), 0);
        if (state.heldFrames > 2e6) {
            state.memoryNote = ` — holding ~${(state.heldFrames / 1e6).toFixed(1)}M `
                + `candidate-frames; use Clear Results before another large batch`;
        }
        await yieldToDOM();
    }

    state.progress.value = state.cancelled ? state.progress.value : 1;
    const done = state.entries.filter((e) => e.status === "done").length;

    state.status.textContent = (state.cancelled
        ? `Cancelled. ${done} result(s) in the table.`
        : `Done. ${done} result(s) in the table.`) + (state.memoryNote ?? "");
    state.running = false;
    refreshControls(state);
    updateSummary(state);
}

async function runFolderScan(state) {
    if (!supportsDirectoryPicker()) {
        showLocalFolderAccessUnsupportedMessage();
        return;
    }
    let directoryHandle;
    try {
        directoryHandle = await window.showDirectoryPicker({mode: "read"});
    } catch (error) {
        if (!isAbortLikeError(error)) showError(error);
        return;
    }
    state.status.textContent = "Scanning folder...";
    let count = 0;
    let found = [];
    try {
        const raw = await walkDirectoryHandle(directoryHandle, {
            recursive: state.recursiveInput.checked,
            onFound: () => { state.status.textContent = `Found ${++count} file(s)...`; },
        });
        found = await pairSidecars(raw);
    } catch (error) {
        state.status.textContent = error.message || String(error);
        return;
    }
    await analyzeEntries(state, found);
}

async function runChooseFiles(state) {
    let files;
    try {
        if (typeof window.showOpenFilePicker === "function") {
            const handles = await window.showOpenFilePicker({multiple: true});
            files = handles.map((h) => ({name: h.name, relativePath: h.name, getFile: () => h.getFile()}));
        } else {
            const input = document.createElement("input");
            input.type = "file";
            input.multiple = true;
            const picked = await new Promise((resolve) => {
                input.onchange = () => resolve(Array.from(input.files || []));
                input.click();
            });
            files = picked.map((f) => ({name: f.name, relativePath: f.name, getFile: () => Promise.resolve(f)}));
        }
    } catch (error) {
        if (!isAbortLikeError(error)) showError(error);
        return;
    }
    const found = await pairSidecars((files || []).filter((e) => isCollectable(e.name)));
    if (!found.length) {
        state.status.textContent = "None of the selected files are BOT interchange or FMV files.";
        return;
    }
    await analyzeEntries(state, found);
}

function wireDragAndDrop(state) {
    const overlay = state.overlay;
    let depth = 0;
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    overlay.addEventListener("dragenter", (e) => {
        stop(e);
        depth++;
        if (!state.running) state.dropHint.style.display = "flex";
    });
    overlay.addEventListener("dragover", (e) => {
        stop(e);
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    overlay.addEventListener("dragleave", (e) => {
        stop(e);
        depth = Math.max(0, depth - 1);
        if (depth === 0) state.dropHint.style.display = "none";
    });
    overlay.addEventListener("drop", async (e) => {
        stop(e);
        depth = 0;
        state.dropHint.style.display = "none";
        if (state.running) {
            state.status.textContent = "Busy — wait for the current run to finish before dropping more.";
            return;
        }
        state.status.textContent = "Reading dropped items...";
        let found = [];
        try {
            found = await entriesFromDataTransfer(e.dataTransfer, state.recursiveInput.checked);
        } catch (error) {
            showError(error);
            return;
        }
        if (!found.length) {
            state.status.textContent = "No BOT interchange or FMV files in the drop.";
            return;
        }
        await analyzeEntries(state, found);
    });
}

export function openBotBenchDialog() {
    const state = createDialog();

    state.closeButton.onclick = () => {
        state.cancelled = true;
        releaseAnalysisPauseLock(state);
        if (state.overlay.parentNode) document.body.removeChild(state.overlay);
        if (activeDialog === state) activeDialog = null;
    };
    state.cancelButton.onclick = () => {
        state.cancelled = true;
        state.status.textContent = "Cancelling after the current file...";
        setButtonDisabled(state.cancelButton, true);
    };
    state.clearButton.onclick = () => clearResults(state);
    state.chooseFolderButton.onclick = () => runFolderScan(state);
    state.chooseFilesButton.onclick = () => runChooseFiles(state);
    state.exportJsonButton.onclick = () => {
        // Option sets AS RUN, not the controls' current state. The controls stay
        // live between batches, so a single top-level `options` block was a
        // second, contradicting description of a mixed run.
        const optionSets = [...new Set(state.entries.filter((e) => e.options)
            .map((e) => JSON.stringify(e.options)))].map((t) => JSON.parse(t));
        const payload = {
            generatedAt: new Date().toISOString(),
            optionSets,
            mixedOptions: optionSets.length > 1,
            absentHypotheses: ABSENT_HYPOTHESES,
            // Rows only — the fitted tracks stay in memory. A run over 100
            // scenarios would otherwise be hundreds of megabytes of JSON.
            results: state.entries.map((e) => ({
                file: e.relativePath, status: e.status, error: e.error ?? null,
                // Per row, because the controls are live between batches.
                options: e.options ?? null,
                row: e.row,
            })),
        };
        saveAs(new Blob([JSON.stringify(payload, null, 2)], {type: "application/json;charset=utf-8"}),
            "sitrec-botbench.json");
    };
    state.exportCsvButton.onclick = () => {
        saveAs(new Blob([resultsToCsv(state.entries)], {type: "text/csv;charset=utf-8"}),
            "sitrec-botbench.csv");
    };
    state.summaryButton.onclick = () => {
        showTimingAnalysis(buildSummaryReport(state.entries, runOptions(state)),
            "sitrec-botbench-summary.txt");
    };

    wireDragAndDrop(state);
    updateSummary(state);
    refreshControls(state);
    return state;
}

/**
 * Add "BotBench..." to the File Analysis folder, next to the FMV timing
 * analyser. Idempotent; the folder is created by addFileAnalysisMenu.
 */
export function addBotBenchMenu(fileAnalysisFolder) {
    if (!fileAnalysisFolder || botBenchController) return botBenchController;
    // Local-only debug hook, mirroring window._traverseDebug in AnalyzeTraverse.
    // The folder picker and drag-and-drop are OS-level and cannot be driven from
    // a test harness, so this exposes the same entry point they both funnel into:
    // hand it {name, relativePath, getFile} entries and it runs the real path.
    if (isLocal && !window._botBench) {
        window._botBench = {
            open: openBotBenchDialog,
            run: (state, entries) => analyzeEntries(state, entries),
            pairSidecars, ingestBotBenchEntry, runBotBenchAnalysis,
            buildSummaryReport, resultsToCsv,
            get state() { return activeDialog; },
        };
    }
    botBenchController = fileAnalysisFolder.add({botBench: openBotBenchDialog}, "botBench")
        .name("BotBench...")
        .tooltip("Run the traverse analysis over many files at once and compare the results — "
            + "BOT interchange scenarios or FMV clips")
        .perm();
    return botBenchController;
}
