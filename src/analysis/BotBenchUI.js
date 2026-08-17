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
    botBenchExplicitFileRole, botBenchFileRole, botBenchScenarioBase,
    buildScenarioNotes, ingestBotBenchEntry, srtHasPointing,
    ingestMISBRecords, sourceQualityGrade,
} from "./BotBenchIngest";
import {longestUniformRun, measureAnchorRate} from "./BotBenchClock";
import {putFileHandoff} from "../FileHandoff";
import {ABSENT_HYPOTHESES, DEFAULT_ANCHOR_M, runBotBenchAnalysis} from "./BotBenchRunner";
import {botENUToLLA} from "../TrackFiles/CTrackFileBOT";
import {
    candidateNotes, consistentTrackCSVs, lookCameraFraming, openHandoffWindow,
} from "../TraverseHandoff";
import {CNodeCustomGraphView} from "../nodes/CNodeCustomGraphView";
import {NodeMan} from "../Globals";

let activeDialog = null;
let botBenchController = null;

const BUTTON_TOOLTIPS = {
    "Close": "Close this window and restore the previous Sitrec playback state. Results are discarded.",
    "Folder (Read)": "Pick a folder of BOT interchange scenarios and/or FMV clips with READ-ONLY access. Sidecars (.scenario.json) are paired automatically. Existing .botbench-cache.json results are still reused when their hashes match, but no new caches are generated and Flush Cache cannot delete them.",
    "Folder (Caching)": "Pick a folder of BOT interchange scenarios and/or FMV clips, granting FULL WRITE access to the folder and all its subfolders (the browser will ask). Results are cached in a .botbench-cache.json beside the files in each leaf folder, so an unchanged file is instant on the next run; Flush Cache deletes those files.",
    "Choose Files": "Pick individual files to run. Without their .scenario.json sidecars, BOT files fall back to the shipped set's default origin, with the rate read from the CSV's own Time column.",
    "Cancel Run": "Stop the run. The file currently being analysed is abandoned and marked cancelled; completed rows keep their results.",
    "Clear Results": "Remove every result from the table and start fresh.",
    "Flush Cache": "Delete the .botbench-cache.json result cache from every folder in the current run, so the next run analyses every file from scratch. The cache reuses a file's result only when its content hashes and the analysis options both match; flush it after an analysis-code change, or to force fresh runs (cached rows have no Gallery/Report).",
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
    "Good source": "Files whose source data has no flagged degeneracy — enough frames, a real sensor baseline, a swept sightline and good Constant Velocity (CV) family conditioning.",
    "Range unobservable": "Files where the sensor baseline is too small for any free-range method to determine distance. No fit can recover range here; that is a property of the data, not the analysis.",
    "Resolved": "Files whose executive verdict was something other than 'unresolved' AND whose top candidate does not contradict the file's declared MaxRange. A parenthesised figure is how many were excluded for that contradiction — a verdict resting on a candidate the measurement says is impossible is not a resolution.",
    "With truth": "Files whose conclusion can be scored — a TruePosition column, or a direction truth for a target that has a bearing but no finite range. The two are scored in different units and are never averaged together; the counts are shown as positional+direction.",
    "Median |err|": "Median line-of-sight (LOS) residual of the top-ranked interpretation across the run, in degrees — how far the winning candidates' tracks lie off the measured sightlines.",
    "Median rel. sep": "Median of (top interpretation's mean 3D separation from truth) / (mean true range), over the files that carry truth. Scale-free, so a 2 km and a 50 km scenario compare. Read it beside 'Best candidate': this tile scores the RANKING, that one scores the fits.",
    "Best candidate": "The same measure for the CLOSEST candidate any method produced on each file. An ORACLE — truth picks the winner — so it is a ceiling and not a score the analysis could claim. Its distance from 'Median rel. sep' is what the ranking costs.",
    "Ranking cost": "Median of (top interpretation's error / closest candidate's error). 1x means the ranking chose the best available answer every time. A large figure means the fits already found the object and the selection stage discarded it — a different repair from the fits missing it.",
};

// [label, width, tooltip, group]
//
// Widths are deliberately MEAN with the numeric columns — they hold 3-6
// characters and every percent spent on them is taken from File and Verdict,
// which are the two that actually have something to say. The numerics are also
// nowrap, so a column can never silently grow a second line and double the
// height of the whole row.
const TABLE_COLUMNS = [
    ["File", "9%", "The file's path relative to the chosen folder.", ""],
    ["Status", "3.5%", "Progress while running, then the final state.", ""],

    // WHAT THE ANSWER WAS. Without it a reader cannot tell a correct verdict
    // from a lucky one, and had to decode the filename to find out. These are
    // SOURCE columns rather than analysis ones on purpose: they describe the
    // scenario, and nothing derived from them reaches any fit. They lead the
    // group because they are what the rest of the row should be read against.
    ["Target", "9%", "What the object actually was and what it was doing, from the answer-key sidecar. A flag marks a scenario DECLARED anomalous, where 'unresolved' is the correct outcome. Blank on challenge files, which carry no answer by design. Never seen by the analysis — it is shown so a verdict can be judged against it.", "source"],
    ["Platform", "8%", "What the sensor flew. Declared by the sidecar where there is one, otherwise MEASURED from the sensor path (straightness and sweep) and shown in italics. The platform's path is what makes range solvable at all, so this is the first thing to read when a file fails.", "source"],
    ["n", "2.5%", "Usable samples in the file, at its own native rate — not resampled to a video frame rate.", "source"],
    ["Dur", "3%", "Clip duration in seconds.", "source"],
    ["Base", "4%", "Straight-line extent of the sensor path. This is what makes distance solvable at all: a moving sensor sees near things shift against far ones (parallax); with no baseline there is no parallax and no range.", "source"],
    ["Sweep", "3.5%", "Total angular path travelled by the sightline, in degrees. A bearing that never moves carries no information about motion.", "source"],
    ["CV rcond", "3.5%", "Conditioning of the Constant Velocity (CV) family of fits (0-1, higher is better) — CV-specific by design. Says whether a LINEAR fit can determine range here; physics and stationary-point methods may still work when this is poor. One-way: 'good' is not a guarantee.", "source"],
    ["Noise", "4%", "Pointing noise estimated FROM THE SIGHTLINES, over the noise the file DECLARES, as a ratio. 1.0 means the sightlines carry exactly the error they claim. A trailing * means a CORRELATED (wobble) declaration, whose amplitude is not a standard deviation and does not compare — hover for both figures.", "source"],
    ["Src", "3%", "One-word triage of the columns to the left. Not a calibrated score — hover it for the specific reasons.", "source"],

    ["Verdict", "12%", "The executive assessment for this file. Shortened to fit — hover for the full headline.", "analysis"],
    ["Top interpretation", "10%", "The highest-ranked candidate, and its rank tier. Long method names are shortened — hover for the full name.", "analysis"],
    ["|err|", "5%", "The top interpretation's mean line-of-sight residual in degrees, and after the slash the NOISE FLOOR — the residual a perfect track would score against the declared pointing error. A residual at or below the floor is fitting the noise, not the object, and cannot be read as a good answer.", "analysis"],
    ["Range", "3.5%", "Start range of the top interpretation, in nautical miles.", "analysis"],
    ["Spd (Knots)", "4%", "The top interpretation's air speed over the clip, min-max, in knots.", "analysis"],
    ["Alt (ft)", "3.5%", "The top interpretation's mean altitude, in feet.", "analysis"],
    ["Truth", "4%", "Where truth exists: the top interpretation's separation from it as a fraction of the true range — or, for a target with no finite range, its bearing error in degrees.", "analysis"],
    // The oracle, and the single most diagnostic column in the table: it splits
    // "the fits could not find it" from "the fits found it and the ranking
    // discarded it", which the Truth column alone cannot distinguish.
    ["Best", "4%", "The CLOSEST candidate any method produced, as a fraction of true range — truth picks this winner, so it is a ceiling and not an achievable score. Read it against Truth: a small Best beside a large Truth means the answer was found and then out-ranked. Hover for which method it was.", "analysis"],
    ["", "5%", "Open this file's full analysis.", "analysis"],
];

// Cell indices, BY NAME. fillRow used to address twenty cells as c[0]..c[19],
// so inserting one column meant renumbering every line below it and a missed
// one wrote the right text into the wrong column silently. Derived from the
// table above so the two cannot drift apart.
const COL = (() => {
    const names = ["file", "status", "target", "platform", "n", "dur", "base", "sweep",
        "rcond", "noise", "src", "verdict", "top", "err", "range", "spd", "alt",
        "truth", "best", "actions"];
    if (names.length !== TABLE_COLUMNS.length) {
        throw new Error(`BotBenchUI: ${names.length} cell names for `
            + `${TABLE_COLUMNS.length} columns — they must correspond one to one.`);
    }
    return Object.fromEntries(names.map((k, i) => [k, i]));
})();

// ---------------------------------------------------------------------------
// Column scatter plots. Every numeric column has an extractor pulling the RAW
// value from the result row (parsing the formatted cell text would mix units:
// fmtMetres switches m/km within one column). Click a numeric header to
// assign it to a plot axis — left = X, right = Y, middle = dot size — and the
// selected columns plot as a sized scatter in a floating CustomGraph window,
// light-themed by default so it prints.
// ---------------------------------------------------------------------------
const SCATTER_COLUMNS = {
    n:     {label: "Samples",              get: (r) => r.quality?.frames},
    dur:   {label: "Duration (s)",         get: (r) => r.quality?.durationS},
    base:  {label: "Baseline (m)",         get: (r) => r.quality?.sensorSpanM},
    sweep: {label: "Sweep (°)",            get: (r) => r.quality?.sweepPathDeg},
    rcond: {label: "CV rcond",             get: (r) => r.quality?.rcond},
    noise: {label: "Noise ratio",          get: (r) =>
        (Number.isFinite(r.quality?.noiseEstDeg) && r.quality?.declaredLosSigmaDeg > 0)
            ? r.quality.noiseEstDeg / r.quality.declaredLosSigmaDeg : null},
    err:   {label: "Top |err| (°)",        get: (r) => r.top?.errDeg},
    range: {label: "Top range (NM)",       get: (r) =>
        Number.isFinite(r.top?.rangeStartM) ? r.top.rangeStartM / METERS_PER_NM : null},
    // The column shows min–max; a scatter needs one number, so it plots the MAX.
    spd:   {label: "Top max speed (kt)",   get: (r) => r.top?.speedMaxKt},
    alt:   {label: "Top mean alt (ft)",    get: (r) =>
        Number.isFinite(r.top?.altMeanM) ? r.top.altMeanM * 3.28084 : null},
    // Positional truth only — direction rows score in degrees, a different
    // unit, and must not land on the same axis.
    truth: {label: "Truth rel. sep",       get: (r) => r.truthScore?.topRelSep},
    best:  {label: "Best rel. sep",        get: (r) => r.truthScore?.bestRelSep},
};

const SCATTER_VIEW_ID = "botBenchScatter";

function scatterMarker(state, name) {
    const m = [];
    if (state.scatter.x === name) m.push("X");
    if (state.scatter.y === name) m.push("Y");
    if (state.scatter.size === name) m.push("size");
    return m.length ? ` [${m.join(",")}]` : "";
}

function updateScatterHeaders(state) {
    for (const {name, th, label} of state.scatterThs) {
        const mark = scatterMarker(state, name);
        th.textContent = label + mark;
        th.style.background = mark ? "#dce9f7" : "";
    }
}

// Mirror a scatter-dot hover onto the table: outline the row (the grade
// background stays untouched underneath) and scroll it into view.
function highlightScatterRow(state, entry) {
    const tr = entry?.tr ?? null;
    if (state.scatterHighlightTr && state.scatterHighlightTr !== tr) {
        state.scatterHighlightTr.style.outline = "";
        state.scatterHighlightTr = null;
    }
    if (tr) {
        tr.style.outline = "2px solid #1976d2";
        tr.style.outlineOffset = "-2px";
        tr.scrollIntoView({block: "nearest"});
        state.scatterHighlightTr = tr;
    }
}

function disposeScatterView(state) {
    if (state.scatter?.view && NodeMan.exists(SCATTER_VIEW_ID)) {
        NodeMan.disposeRemove(SCATTER_VIEW_ID, true);
    }
    if (state.scatter) state.scatter.view = null;
}

function updateScatterPlot(state) {
    const sel = state.scatter;
    if (!sel || !sel.x || !sel.y) { disposeScatterView(state); return; }
    const gx = SCATTER_COLUMNS[sel.x], gy = SCATTER_COLUMNS[sel.y];
    const gs = sel.size ? SCATTER_COLUMNS[sel.size] : null;

    const points = [];
    const pointEntries = [];
    for (const e of state.entries) {
        if (e.status !== "done" || !e.row) continue;
        const x = gx.get(e.row), y = gy.get(e.row);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const size = gs ? gs.get(e.row) : null;
        points.push({x, y, size: Number.isFinite(size) ? size : null,
            label: e.row.displayName ?? e.relativePath,
            // Declared-anomalous scenarios in the analysis theme's red; the
            // rest in its blue — same meaning as the flag on the Target column.
            color: e.row.anomalousDeclared ? "#c00" : "#06c"});
        pointEntries.push(e);
    }

    if (!sel.view || !NodeMan.exists(SCATTER_VIEW_ID)) {
        if (NodeMan.exists(SCATTER_VIEW_ID)) NodeMan.disposeRemove(SCATTER_VIEW_ID, true);
        sel.view = new CNodeCustomGraphView({
            id: SCATTER_VIEW_ID,
            menuName: "BOT Bench scatter",
            title: "",
            dark: false,               // light, so a printed/pasted copy reads
            showLegend: false,
            visible: true,
            left: 0.52, top: 0.06, width: 0.44, height: 0.55,
            draggable: true, resizable: true, freeAspect: true, shiftDrag: false,
        });
        // The bench dialog is a modal overlay at z-index 10000; the graph is a
        // normal app view and the view manager keeps re-stacking view
        // z-indices, so a one-shot style assignment ends up back behind the
        // modal. The view re-asserts this every scatter render.
        sel.view.scatterElevateZ = 10001;
    }
    // A header click on a CLOSED graph window must bring it back — otherwise
    // the selections keep updating an invisible view and the clicks appear to
    // do nothing (a hidden view also stops rendering, so even its axis labels
    // freeze at whatever was on screen when it was closed).
    if (!sel.view.visible) sel.view.show(true);
    // Hovering a dot highlights (and scrolls to) its table row.
    sel.view.onScatterHover = (idx) =>
        highlightScatterRow(state, idx == null ? null : pointEntries[idx]);
    sel.view.title = `${gy.label} vs ${gx.label}`
        + (gs ? ` (dot size: ${gs.label})` : "");
    sel.view.emptyMessage = "No completed rows have numbers for both selected columns";
    sel.view.setScatterData({
        points,
        xLabel: gx.label,
        yLabel: gy.label,
        sizeLabel: gs ? gs.label : null,
    });
}

// Minimum table width. With 20 columns, a percentage layout inside a narrow
// window gives every column a few characters and wraps ALL of them — measured
// at an 893 px viewport, rows ran to 121 px and eight fitted on screen. Fixing
// the table's floor and letting the wrapper scroll horizontally instead keeps
// every cell on ONE line, which is what makes the table scannable; on a wide
// display the percentages take over and nothing scrolls.
const TABLE_MIN_WIDTH_PX = 1660;

/**
 * The verdict headline, shortened for a table cell.
 *
 * The assessment's own wording is a full sentence written for a report — good
 * prose, but at 14% of the width it wrapped to six lines and made every row
 * tall enough that only four fitted on screen. The boilerplate tails carry no
 * per-row information (every "unresolved" row ends the same way), so they are
 * cut here and the untouched original stays in the tooltip.
 */
/**
 * Long method names overflow their column; the cell shows a compressed form
 * and the tooltip keeps the full name. "Global Fit: Polynomial LSQ (order 5)"
 * becomes "Polynomial LSQ (5)"; "Fixed-Wing Aircraft (generic prior)" becomes
 * "Fixed-Wing Aircraft".
 */
function shortTopName(name) {
    if (!name) return "";
    return String(name)
        .replace(/^Global Fit:\s*/i, "")
        .replace(/\s*\(generic prior\)/i, "")
        .replace(/\(order\s+(\d+)\)/i, "($1)")
        .replace(/\s*\(measured wind\)/i, " (wind)")
        .trim();
}

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
    "file", "displayName", "kind", "status", "trackId",
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
    "probeGeometryPinned", "probeSpeedOverride", "probeRangeM",
    "probeDecisiveness", "probeValleyWidthLog",
    "topKey", "topName", "topTier", "topErrDeg", "topRangeM", "topSpeedKt",
    "topSpeedMinKt", "topSpeedMaxKt", "topAltM",
    "candidates", "failures",
    "targetDescription", "platformDescription", "platformMeasured", "eventDescription",
    "anomalousDeclared", "topRangeBlind",
    "noiseFloorDeg", "residualSeDeg", "candidatesBelowFloor", "topBelowFloor",
    "winnerMarginDeg",
    "truthLabel", "truthTopSepM", "truthTopRelSep", "truthBestSepM", "truthBestRelSep",
    "truthBestName", "meanTruthRangeM", "rankingCost", "truthResidualDeg",
    "directionTruthLabel", "directionTopDeg", "directionBestDeg", "directionBestName",
    "elapsedMs", "error",
];

function rowToCsvRecord(entry) {
    const r = entry.row;
    const q = r?.quality ?? {};
    const grade = r ? sourceQualityGrade(q) : null;
    return {
        file: entry.relativePath,
        displayName: r?.displayName ?? "",
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
        probeGeometryPinned: r?.probe ? (r.probe.geometryPinned ? 1 : 0) : "",
        probeSpeedOverride: r?.probe ? (r.probe.speedOverride ? 1 : 0) : "",
        probeRangeM: r?.probe?.rangeM, probeDecisiveness: r?.probe?.decisiveness,
        probeValleyWidthLog: r?.probe?.valleyWidthLog,
        topErrDeg: r?.top?.errDeg, topRangeM: r?.top?.rangeStartM, topSpeedKt: r?.top?.speedKt,
        topSpeedMinKt: r?.top?.speedMinKt, topSpeedMaxKt: r?.top?.speedMaxKt,
        topAltM: r?.top?.altMeanM,
        candidates: r?.candidates, failures: (r?.failures ?? []).join("; "),
        targetDescription: r?.targetDescription ?? "",
        platformDescription: r?.platformDescription ?? "",
        platformMeasured: r ? (r.platformMeasured ? 1 : 0) : "",
        eventDescription: r?.eventDescription ?? "",
        anomalousDeclared: r?.anomalousDeclared == null ? "" : (r.anomalousDeclared ? 1 : 0),
        topRangeBlind: r ? (r.topRangeBlind ? 1 : 0) : "",
        noiseFloorDeg: r?.separability?.floorDeg,
        residualSeDeg: r?.separability?.seDeg,
        candidatesBelowFloor: r?.separability?.belowFloor,
        topBelowFloor: r?.separability ? (r.separability.topBelowFloor ? 1 : 0) : "",
        winnerMarginDeg: r?.separability?.marginDeg,
        truthLabel: r?.truthScore?.label ?? "",
        truthTopSepM: r?.truthScore?.topSepM, truthTopRelSep: r?.truthScore?.topRelSep,
        truthBestSepM: r?.truthScore?.bestSepM, truthBestRelSep: r?.truthScore?.bestRelSep,
        truthBestName: r?.truthScore?.bestName ?? "",
        meanTruthRangeM: r?.truthScore?.meanTruthRangeM,
        // Precomputed because every downstream analysis wants it and deriving
        // it from two columns invites the wrong division.
        rankingCost: (Number.isFinite(r?.truthScore?.topSepM)
            && r?.truthScore?.bestSepM > 0)
            ? r.truthScore.topSepM / r.truthScore.bestSepM : "",
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
    L.push("=== Sitrec BOTBench — Bearings-Only Traversal bulk analysis ===");
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
        // One line each rather than one line per category. The counts were nine
        // lines of mostly-zero and pushed the findings below the fold.
        L.push(`  Grade:      ${Object.entries(grades).map(([g, c]) => `${g} ${c}`).join(", ")}`
            + `   |   CV conditioning: poor ${poor}, marginal ${marginal}`);
        L.push(`  Geometry:   median baseline ${fmtMetres(median(rows.map((r) => r.quality.sensorSpanM)))}`
            + `, median sweep ${n2(median(rows.map((r) => r.quality.sweepPathDeg)))}°`
            + `, range unobservable on ${unobs}`);
        // Platform path shape drives whether range is solvable at all, so the
        // mix is worth a line — and it is the one source statistic that a
        // reader can act on when planning a collection.
        const shapes = {};
        for (const r of rows) if (r.platformDescription) {
            const k = r.platformDescription.split(",")[0];
            shapes[k] = (shapes[k] ?? 0) + 1;
        }
        if (Object.keys(shapes).length) {
            L.push(`  Platforms:  ${Object.entries(shapes).sort((a, b) => b[1] - a[1])
                .map(([k, c]) => `${k} ${c}`).join(", ")}`);
        }
        const anomCount = rows.filter((r) => r.anomalousDeclared).length;
        if (anomCount) {
            L.push(`  Targets:    ${anomCount} of ${rows.length} declared ANOMALOUS — on those, `
                + `"unresolved" is the correct outcome.`);
        }

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
            L.push(`  Noise:      estimated/declared median ${n2(median(ratios))}x over `
                + `${comparable.length} white-noise file(s) — 1.0 means the sightlines carry`);
            L.push(`              exactly the pointing error they declare.`
                + (correlated.length ? `  ${correlated.length} correlated file(s) excluded:` : ""));
            if (correlated.length) {
                const cr = correlated
                    .map((r) => r.quality.noiseEstDeg / r.quality.declaredLosSigmaDeg)
                    .filter(Number.isFinite);
                L.push(`              their ${cr.length ? n2(median(cr)) + "x" : "ratio"} is the `
                    + `signature of wobble, not a disagreement (a deadband amplitude is not`);
                L.push(`              a sigma, and a frame-to-frame estimator sees only the fast part of a slow drift).`);
            }
        }
        L.push("");

        L.push("ANALYSIS");
        L.push("─".repeat(72));
        const codes = {};
        for (const r of rows) codes[r.verdictCode ?? "none"] = (codes[r.verdictCode ?? "none"] ?? 0) + 1;
        L.push(`  Verdicts:   ${Object.entries(codes).sort((a, b) => b[1] - a[1])
            .map(([c, n]) => `${c} ${n}`).join(", ")}`);
        const topKeys = {};
        for (const r of rows) if (r.top) topKeys[r.top.key] = (topKeys[r.top.key] ?? 0) + 1;
        L.push(`  Top pick:   ${Object.entries(topKeys).sort((a, b) => b[1] - a[1])
            .map(([k, n]) => `${k} ${n}`).join(", ")}`);
        L.push(`  Median top |err|: ${n3(median(rows.map((r) => r.top?.errDeg)))}°`);

        // RANGE-BLIND WINNERS. A curve-fitting strategy taking first place is a
        // finding in itself: TraverseHypotheses documents that family as a
        // diagnostic and not a ranking, and its distance comes from the anchor.
        const blind = rows.filter((r) => r.topRangeBlind);
        if (blind.length) {
            L.push("");
            L.push(`  RANGE-BLIND WINNER on ${blind.length} of ${rows.length} file(s). The top`);
            L.push("  interpretation there is one of the curve-fitting strategies, which the");
            L.push("  analysis documents as a METHOD DIAGNOSTIC and not a ranking: a higher-order");
            L.push("  curve hugs the sightlines more closely because it bends more, so its low");
            L.push("  residual is arithmetic. Its distance is inherited from the range anchor, so");
            L.push("  the range it reports is not a measurement.");
        }

        // SEPARABILITY. Whether the residual was entitled to choose at all.
        const sepRows = rows.filter((r) => r.separability);
        if (sepRows.length) {
            const belowFloor = sepRows.filter((r) => r.separability.topBelowFloor).length;
            const insideNoise = sepRows.filter((r) => Number.isFinite(r.separability.marginDeg)
                && Number.isFinite(r.separability.seDeg)
                && r.separability.marginDeg < 2 * r.separability.seDeg).length;
            L.push("");
            L.push("  RESIDUAL AGAINST THE NOISE FLOOR");
            L.push(`  A perfect track does not score zero. Against a declared per-axis sigma the`);
            L.push(`  mean angular residual of TRUTH ITSELF is sigma x 1.2533 (the error is two`);
            L.push(`  Gaussians in the tangent plane, so its magnitude is Rayleigh-distributed).`);
            L.push(`  Median floor over ${sepRows.length} file(s): `
                + `${n3(median(sepRows.map((r) => r.separability.floorDeg)))}°.`);
            L.push(`    Top pick BELOW the floor:            ${belowFloor} / ${sepRows.length}`);
            L.push(`    Winner's lead inside the noise:      ${insideNoise} / ${sepRows.length}`);
            if (belowFloor) {
                L.push("  A residual below the floor means the model fits the sightlines better than");
                L.push("  the true trajectory does — it is fitting the pointing noise, and its low");
                L.push("  residual is not evidence about the object.");
            }
            if (insideNoise) {
                L.push("  A lead inside the noise means the residual did not separate the winner from");
                L.push("  the runner-up; which one placed first is a property of this noise draw.");
            }
        }

        const failCounts = {};
        for (const r of rows) for (const f of r.failures) failCounts[f] = (failCounts[f] ?? 0) + 1;
        if (Object.keys(failCounts).length) {
            L.push("");
            L.push(`  Fits that failed at least once: ${Object.entries(failCounts)
                .sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} (${n})`).join(", ")}`);
        }
        L.push("");

        if (withTruth.length) {
            L.push("AGAINST TRUTH");
            L.push("─".repeat(72));
            L.push(`  Files carrying truth: ${withTruth.length}`);
            const rel = withTruth.map((r) => r.truthScore.topRelSep).filter(Number.isFinite);
            const best = withTruth.map((r) => r.truthScore.bestRelSep).filter(Number.isFinite);
            const within10 = rel.filter((x) => x <= 0.10).length;
            const bestWithin10 = best.filter((x) => x <= 0.10).length;

            // ACHIEVED beside ORACLE, on adjacent lines, because the pair is
            // what carries the diagnosis and the achieved figure alone was
            // being read as "how good the analysis is". It is not: it is how
            // good the RANKING is, and the two differ by a factor that this
            // block now states rather than leaving to be worked out.
            L.push("");
            L.push(`                            achieved      oracle (truth picks the winner)`);
            L.push(`    Median relative sep:    ${padCell(n3(median(rel)), 14)}`
                + `${best.length ? n3(median(best)) : "—"}`);
            L.push(`    Within 10% of range:    ${padCell(`${within10} / ${rel.length}`, 14)}`
                + `${best.length ? `${bestWithin10} / ${best.length}` : "—"}`);

            // Whether the RANKING picked the best available candidate is a
            // different question from whether any candidate was close.
            const pickedBest = withTruth.filter((r) => Number.isFinite(r.truthScore.topSepM)
                && Number.isFinite(r.truthScore.bestSepM)
                && r.truthScore.topSepM <= r.truthScore.bestSepM * 1.05).length;
            L.push(`    Ranking picked closest: ${pickedBest} / ${withTruth.length}`);

            const costs = withTruth
                .map((r) => (Number.isFinite(r.truthScore.topSepM)
                    && Number.isFinite(r.truthScore.bestSepM) && r.truthScore.bestSepM > 0)
                    ? r.truthScore.topSepM / r.truthScore.bestSepM : null)
                .filter(Number.isFinite);
            if (costs.length) {
                const medCost = median(costs);
                L.push("");
                L.push(`  RANKING COST: median ${medCost < 10 ? medCost.toFixed(1) : Math.round(medCost)}x`
                    + ` (top interpretation's error / closest candidate's error).`);
                L.push("  The oracle column is a CEILING and not a score the analysis could claim —");
                L.push("  truth chose its winner. But the gap between the two columns is real, and it");
                L.push("  says where the work is: a large gap means the fits already found the answer");
                L.push("  and the ranking discarded it, which is a different repair from a small");
                L.push("  oracle figure, where no method found it at all.");
                // Name the worst file. A median hides the case worth opening.
                let worstName = null, worstCost = 0;
                for (const r of withTruth) {
                    const ts = r.truthScore;
                    if (!(Number.isFinite(ts.topSepM) && ts.bestSepM > 0)) continue;
                    const c = ts.topSepM / ts.bestSepM;
                    if (c > worstCost) { worstCost = c; worstName = r.targetDescription ?? r.label; }
                }
                if (worstName) {
                    L.push(`  Worst: ${worstName} at `
                        + `${worstCost < 10 ? worstCost.toFixed(1) : Math.round(worstCost)}x.`);
                }
            }
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
        // The scenario NAME, not the path. A flat folder of generated files
        // shares a long common suffix, so a right-clipped path column showed
        // the same characters on every row.
        {h: "Scenario", w: 26, get: (e) => e.row?.displayName ?? e.relativePath},
        // What the answer was, next to what was concluded. Reading a verdict
        // without it is guesswork.
        {h: "Target (truth)", w: 22,
            get: (e) => (e.row?.anomalousDeclared ? "* " : "") + (e.row?.targetDescription ?? "")},
        {h: "Platform", w: 18, get: (e) => e.row?.platformDescription ?? ""},
        {h: "n", w: 5, get: (e) => e.row?.quality.frames ?? "", right: true},
        {h: "Sweep", w: 7, get: (e) => n2(e.row?.quality.sweepPathDeg), right: true},
        {h: "CVrcond", w: 8, get: (e) => n3(e.row?.quality.rcond), right: true},
        {h: "Src", w: 5, get: (e) => (e.row ? sourceQualityGrade(e.row.quality).grade : "")},
        {h: "Verdict", w: 22, get: (e) => e.row?.headline ?? e.error ?? ""},
        {h: "Top", w: 20, get: (e) => (e.row?.topRangeBlind ? "<> " : "") + (e.row?.top?.name ?? "")},
        {h: "|err|", w: 7, get: (e) => n3(e.row?.top?.errDeg), right: true},
        // The floor beside the residual, so no reader can take a small number
        // for a good one without seeing what a perfect track would score.
        {h: "floor", w: 7, get: (e) => n3(e.row?.separability?.floorDeg), right: true},
        {h: "RelSep", w: 7, get: (e) => n3(e.row?.truthScore?.topRelSep), right: true},
        {h: "Best", w: 7, get: (e) => n3(e.row?.truthScore?.bestRelSep), right: true},
    ];
    L.push(cols.map((c) => padCell(c.h, c.w, c.right)).join(" "));
    L.push(cols.map((c) => "─".repeat(c.w)).join(" "));
    for (const e of entries) L.push(cols.map((c) => padCell(c.get(e), c.w, c.right)).join(" "));
    L.push("");
    L.push("  * = declared anomalous, so 'unresolved' is the CORRECT outcome on that row.");
    L.push("  <> = the winner is a range-blind curve fit; its range came from the anchor.");
    L.push("  floor = the residual a PERFECT track scores against the declared pointing");
    L.push("          error. An |err| at or below it is fitting noise, not the object.");
    L.push("  Best = closest candidate any method produced (ORACLE — truth picked it).");
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
async function pairSidecars(found, {explicit = false} = {}) {
    const sidecars = new Map();
    const labels = new Map();
    const rows = [];
    for (const f of found) {
        const role = explicit ? botBenchExplicitFileRole(f.name) : botBenchFileRole(f.name);
        const key = (f.relativePath.replace(/[^/]*$/, "")) + botBenchScenarioBase(f.name);
        if (role === "bot-sidecar") sidecars.set(key, f);
        else if (role === "bot-labels") labels.set(key, f);
        else if (role === "bot-csv" || role === "fmv" || role === "track-file") {
            rows.push({...f, key});
        }
    }
    const queued = explicit ? rows : await keepOnlyPointingSRT(rows);
    for (const r of queued) {
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
    queued.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return queued;
}

/**
 * Drop the .srt entries that carry no camera pointing — ordinary subtitles,
 * and drone sidecars logging position only. Every other extension is judged
 * by NAME; ".srt" is the one that names two unrelated things, so it is the
 * one that gets read. See srtHasPointing for why the alternative (an error
 * row per file) is worse than a slightly slower walk.
 */
async function keepOnlyPointingSRT(rows) {
    const kept = [];
    for (const row of rows) {
        if (!/\.srt$/i.test(row.name)) { kept.push(row); continue; }
        try {
            if (srtHasPointing(await (await row.getFile()).text())) kept.push(row);
        } catch (e) {
            // Unreadable during the walk. Queue it and let the ingest report
            // the real reason — silently dropping a file the user can see in
            // the folder is the one outcome with no explanation anywhere.
            kept.push(row);
        }
    }
    return kept;
}

// Anything BotBench might want from a walk, including the sidecars that are not
// themselves rows.
function isCollectable(name) {
    return botBenchFileRole(name) !== null;
}

// The same question for files the user PICKED BY HAND. Hand-picking is a
// statement of intent, so it accepts formats too ambiguous to sweep a folder
// for (.xml, read only as STANAG 4676) — see botBenchExplicitFileRole.
function isExplicitlyCollectable(name) {
    return botBenchExplicitFileRole(name) !== null;
}

// ---------------------------------------------------------------------------
// Per-folder result cache.
//
// A `.botbench-cache.json` in each LEAF folder holds, per scenario filename,
// the sha256 of every input that shaped its row (the CSV bytes, the
// .scenario.json sidecar, the .truth.json answer key), the analysis options it
// ran under, and the finished row. On a re-run, a file whose hashes AND
// options both match is filled from the cache instead of re-analysed; its
// Status cell says "cached" so a reused row is never silent. The hashes also
// ride on every row (row.fileSha256), so an Export JSON records exactly which
// bytes produced each result.
//
// Writing needs a directory handle, so the cache is read/write for Choose
// Folder (picked with readwrite permission) and inert for drag-and-drop,
// whose FileSystemEntry API is read-only. The cache stores rows, not the full
// in-memory results, so a cached row's Gallery/Report need a real re-run
// (Flush Cache) — same trade as Export JSON, and what keeps the file small.
// ---------------------------------------------------------------------------
const CACHE_FILENAME = ".botbench-cache.json";
const CACHE_SCHEMA = 1;

async function sha256Hex(data) {
    const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Hash EVERY input that shapes the row. The sidecar and answer key travel as
// text on the entry (pairSidecars), so a changed sidecar with an unchanged CSV
// correctly misses the cache.
async function entryFileHashes(entry) {
    const hashes = {csv: await sha256Hex(await (await entry.getFile()).arrayBuffer())};
    if (entry.sidecarText != null) hashes.sidecar = await sha256Hex(entry.sidecarText);
    if (entry.labelsText != null) hashes.truth = await sha256Hex(entry.labelsText);
    return hashes;
}

const combinedHash = (h) => [h.csv, h.sidecar ?? "-", h.truth ?? "-"].join("|");

// One memoized cache record per leaf folder for the life of the dialog.
async function loadDirCache(state, entry) {
    if (!entry.dirHandle) return null;   // drag-and-drop: no writable folder
    const key = entry.dirPath ?? "";
    if (!state.dirCaches) state.dirCaches = new Map();
    if (state.dirCaches.has(key)) return state.dirCaches.get(key);
    let data = {schema: CACHE_SCHEMA, results: {}};
    try {
        const fh = await entry.dirHandle.getFileHandle(CACHE_FILENAME);
        const parsed = JSON.parse(await (await fh.getFile()).text());
        if (parsed?.schema === CACHE_SCHEMA && parsed.results) data = parsed;
    } catch (e) { /* absent or unreadable — start fresh */ }
    const rec = {handle: entry.dirHandle, data,
        // "Folder (Read)" runs reuse existing caches but never write them.
        writable: entry.cacheWritable !== false};
    state.dirCaches.set(key, rec);
    return rec;
}

async function writeDirCache(rec) {
    rec.data.schema = CACHE_SCHEMA;
    rec.data.savedAt = new Date().toISOString();
    rec.data.appVersion = process.env.BUILD_VERSION_STRING;
    const fh = await rec.handle.getFileHandle(CACHE_FILENAME, {create: true});
    const writable = await fh.createWritable();
    await writable.write(JSON.stringify(rec.data, null, 1));
    await writable.close();
}

async function flushCaches(state) {
    if (state.running) return;
    // Every leaf folder this dialog has touched: entries from the current run
    // plus any cache records already loaded.
    const dirs = new Map();
    for (const e of state.entries) {
        if (e.dirHandle) dirs.set(e.dirPath ?? "", e.dirHandle);
    }
    if (state.dirCaches) {
        for (const [k, rec] of state.dirCaches) dirs.set(k, rec.handle);
    }
    if (!dirs.size) {
        state.status.textContent = "No cacheable folders in this session — "
            + "caching needs Choose Folder (drag-and-drop folders are read-only).";
        return;
    }
    let removed = 0, denied = 0;
    for (const [, handle] of dirs) {
        try { await handle.removeEntry(CACHE_FILENAME); removed++; }
        catch (e) {
            // NotFound = nothing to flush there; NotAllowed = read-only grant.
            if (e?.name === "NotAllowedError" || e?.name === "SecurityError") denied++;
        }
    }
    state.dirCaches = new Map();
    state.status.textContent = `Flushed ${removed} cache file(s) from ${dirs.size} `
        + `folder(s). The next run will analyse every file from scratch.`
        + (denied ? ` ${denied} folder(s) were opened read-only — reopen with `
            + `Folder (Caching) to delete their caches.` : "");
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
                // The containing (leaf) directory handle travels with the
                // entry so the result cache can live beside the files.
                const entry = {name, relativePath, getFile: () => handle.getFile(),
                    dirHandle: directoryHandle, dirPath: basePath};
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
    title.textContent = "BOTBench — Bearings-Only Traversal bulk analysis";
    title.title = "Run the traverse analysis over many files and compare the results. "
        + "BOT = Bearings-Only Traversal: working out where something was from pointing "
        + "directions alone. Drag a folder of BOT interchange scenarios or FMV clips "
        + "anywhere onto this window.";
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

    const chooseFolderReadButton = makeButton("Folder (Read)");
    const chooseFolderCacheButton = makeButton("Folder (Caching)");
    const chooseFilesButton = makeButton("Choose Files");
    const cancelButton = makeButton("Cancel Run", "#d32f2f");
    const clearButton = makeButton("Clear Results", "#d32f2f");
    const flushCacheButton = makeButton("Flush Cache", "#6d4c41");
    const exportJsonButton = makeButton("Export JSON", "#455a64");
    const exportCsvButton = makeButton("Export CSV", "#455a64");
    const summaryButton = makeButton("Summary", "#00695c");

    for (const el of [recursive.label, families.label, mcSweep.label, anchorLabel,
        chooseFolderReadButton, chooseFolderCacheButton, chooseFilesButton,
        cancelButton, clearButton,
        flushCacheButton, exportJsonButton, exportCsvButton, summaryButton]) {
        controls.appendChild(el);
    }

    const status = document.createElement("div");
    status.textContent = "Ready — choose a folder or drag one onto this window. "
        + "BOT interchange scenarios (.input/.all.csv + .scenario.json), FMV clips — "
        + "video with embedded camera metadata (.ts/.klv) — and track files with camera "
        + "pointing (Airdata drone logs, MISB CSVs by gimbal angles or frame center, "
        + "STANAG 4676, DJI .srt). STANAG .xml is read when you choose files by hand.";
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
    const scatterThs = [];
    const colNames = Object.keys(COL);
    TABLE_COLUMNS.forEach(([label, , tooltip, group], i) => {
        const th = document.createElement("th");
        th.textContent = label;
        th.title = tooltip || label;
        th.style.cssText = "text-align: left; padding: 5px 5px; border-bottom: 1px solid #ddd; "
            + `background: ${GROUP_COLOURS[group]}; font-size: 11px; `
            + "white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
        const name = colNames[i];
        if (SCATTER_COLUMNS[name]) {
            th.title += "\n\nScatter plot: left-click = X axis, right-click = Y axis, "
                + "middle-click = dot size. Click the same header again to clear it.";
            th.style.cursor = "pointer";
            scatterThs.push({name, th, label});
            // `state` does not exist yet when the header is built; resolve the
            // live dialog at click time instead.
            const assign = (slot) => {
                const s = activeDialog;
                if (!s || !s.scatter) return;
                s.scatter[slot] = s.scatter[slot] === name ? null : name;
                updateScatterHeaders(s);
                updateScatterPlot(s);
            };
            th.addEventListener("click", () => assign("x"));
            th.addEventListener("contextmenu", (e) => { e.preventDefault(); assign("y"); });
            // Middle click: suppress the browser's autoscroll on mousedown,
            // assign on auxclick.
            th.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
            th.addEventListener("auxclick", (e) => {
                if (e.button === 1) { e.preventDefault(); assign("size"); }
            });
        }
        headerRow.appendChild(th);
    });
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
        chooseFolderReadButton, chooseFolderCacheButton, chooseFilesButton,
        cancelButton, clearButton,
        flushCacheButton,
        closeButton, exportJsonButton, exportCsvButton, summaryButton,
        status, progress, summary, tbody,
        entries: [],
        nextRowId: 0,
        cancelled: false,
        running: false,
        pauseLock: null,
        heldFrames: 0,
        memoryNote: "",
        // Column-scatter selections (header clicks) + the floating graph view.
        scatter: {x: null, y: null, size: null, view: null},
        scatterThs,
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
        // THE ORACLE, ON THE TILE ROW. "Median rel. sep" standing alone reads
        // as a verdict on the whole analysis; beside the best any method
        // produced it reads as what it is — a verdict on the RANKING. The two
        // tiles differ by the ranking cost, and a large gap points at the
        // selection stage rather than at the fits.
        const bestRel = truthRows.map((r) => r.truthScore.bestRelSep).filter(Number.isFinite);
        if (bestRel.length) {
            state.summary.appendChild(summaryCell("Best candidate", n3(median(bestRel))));
        }
        const costs = truthRows
            .map((r) => (Number.isFinite(r.truthScore.topSepM) && r.truthScore.bestSepM > 0)
                ? r.truthScore.topSepM / r.truthScore.bestSepM : null)
            .filter(Number.isFinite);
        if (costs.length) {
            const m = median(costs);
            state.summary.appendChild(summaryCell("Ranking cost",
                `${m < 10 ? m.toFixed(1) : Math.round(m)}x`));
        }
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
    // The filename OPENS the file, in a fresh Sitrec. A bulk row says a fit
    // landed 97% of range from truth and the immediate question is always
    // "let me look at it" — which meant finding the file on disk and dragging
    // it in by hand. See openInNewSitrec for why this cannot be a plain href.
    const link = document.createElement("a");
    link.textContent = entry.relativePath;
    link.href = "#";
    link.style.cssText = "color: #1565c0; text-decoration: none; cursor: pointer;";
    link.onmouseenter = () => { link.style.textDecoration = "underline"; };
    link.onmouseleave = () => { link.style.textDecoration = "none"; };
    link.onclick = (ev) => { ev.preventDefault(); openInNewSitrec(entry, link); };
    cells[COL.file].appendChild(link);
    cells[COL.file].title = entry.relativePath
        + "\n\nClick to open this scenario in a new Sitrec window.";
    // WHICH END TO CLIP. A deep relative path is identified by its tail, so
    // clipping the front is right for `.../2026-run/sub/bot-0042.csv`. It is
    // exactly wrong for a flat folder of generated scenarios, whose names share
    // a long common SUFFIX — measured on a ten-file run, nine rows clipped to
    // the identical "…_wzero_white0p03deg_s901.all.csv" and the column carried
    // no information at all. So clip the end only when there is a directory to
    // identify the file by.
    const deepPath = entry.relativePath.includes("/");
    cells[COL.file].style.direction = deepPath ? "rtl" : "ltr";
    cells[COL.file].style.textAlign = "left";
    cells[COL.status].textContent = "Queued";
    state.tbody.appendChild(tr);
    entry.tr = tr;
    entry.cells = cells;
    return entry;
}

function setRowStatus(entry, text, tooltip = "") {
    if (!entry.cells) return;
    entry.cells[COL.status].textContent = text;
    if (tooltip) entry.cells[COL.status].title = tooltip;
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

    // An answer-key sidecar carries the human-meaningful scenario name;
    // show it in place of the opaque filename, keeping the path in the
    // tooltip. Challenge files (no name) keep showing their path.
    // The cell holds a link element, so the descriptive name replaces the link
    // TEXT — writing textContent on the cell would delete the anchor and with
    // it the click handler, leaving a name that looks clickable and is not.
    if (r.displayName) {
        const link = c[COL.file].firstChild;
        if (link) link.textContent = r.displayName;
        c[COL.file].title = `${r.displayName}\n${entry.relativePath}`
            + "\n\nClick to open this scenario in a new Sitrec window.";
    }

    // WHAT THE ANSWER WAS. An anomalous scenario is marked, because "the
    // analysis found nothing conventional" is a correct result on one of these
    // and a failure on the others, and the two look identical without it.
    if (r.targetDescription) {
        c[COL.target].textContent = (r.anomalousDeclared ? "⚑ " : "") + r.targetDescription;
        c[COL.target].title = `The object actually was: ${r.targetDescription}.`
            + (r.anomalousDeclared ? `\n\nDECLARED ANOMALOUS. "Unresolved" is the CORRECT `
                + `outcome here, not a failure.` : "")
            + (r.eventDescription ? `\nInjected events: ${r.eventDescription}.` : "")
            + `\n\nFrom the answer-key sidecar. The analysis never sees it.`;
        if (r.anomalousDeclared) c[COL.target].style.color = "#6a1b9a";
    } else {
        c[COL.target].textContent = "";
        c[COL.target].title = "No answer key for this file — it declares no target. "
            + "Challenge files are published this way by design.";
    }

    if (r.platformDescription) {
        c[COL.platform].textContent = r.platformDescription;
        // Italic marks a MEASURED description, so a reader never mistakes an
        // inference from the sensor path for something the file declared.
        c[COL.platform].style.fontStyle = r.platformMeasured ? "italic" : "";
        c[COL.platform].title = (r.platformMeasured
            ? `MEASURED from the sensor path, not declared by the file.`
            : `Declared by the scenario sidecar.`)
            + `\n\nPath length ${fmtMetres(q.sensorPathM)}, straight-line span `
            + `${fmtMetres(q.sensorSpanM)}, straightness ${n2(q.straightness)} `
            + `(1 = a straight run, the degenerate case for range), altitude span `
            + `${fmtMetres(q.sensorAltSpanM)}.`;
    }

    c[COL.status].textContent = "done";
    c[COL.status].title = r.warnings.length ? r.warnings.join("\n") : "";
    c[COL.n].textContent = n0(q.frames);
    c[COL.dur].textContent = n1(q.durationS);
    // Rate lost its own column to Target/Platform; it is duration and frames
    // divided, so it costs a reader nothing to keep it in the tooltip.
    c[COL.dur].title = `${n1(q.durationS)} s at `
        + `${q.fps >= 1 ? n0(q.fps) : n2(q.fps)} samples/s.`;
    c[COL.base].textContent = fmtMetres(q.sensorSpanM);
    c[COL.base].title = `Path length ${fmtMetres(q.sensorPathM)}; straightness `
        + `${n2(q.straightness)} (1 = a straight run, which is the degenerate case for range); `
        + `altitude span ${fmtMetres(q.sensorAltSpanM)}`;
    c[COL.sweep].textContent = n2(q.sweepPathDeg);
    c[COL.sweep].title = `Net end-to-end bearing change ${n2(q.netSweepDeg)}°; median rate `
        + `${n3(q.rateMedianDegPerS)}°/s. A large path with a small net change means the `
        + `sightline went out and came back.`;
    c[COL.rcond].textContent = n3(q.rcond);
    c[COL.rcond].title = `${q.conditioning} — the data pins down ${q.effectiveRank ?? "?"} of the 6 `
        + `numbers a constant-velocity fit needs. This is a statement about the Constant `
        + `Velocity (CV) family only.`;

    // NOISE AS A RATIO. Two columns of raw degrees asked every reader to do the
    // same division; one column does it once. The ratio is also the number that
    // carries the finding — 1.0 means the file is as noisy as it claims — and
    // both raw figures stay in the tooltip.
    const noiseRatio = Number.isFinite(q.noiseEstDeg) && q.declaredLosSigmaDeg > 0
        ? q.noiseEstDeg / q.declaredLosSigmaDeg : null;
    c[COL.noise].textContent = Number.isFinite(noiseRatio)
        ? `${n2(noiseRatio)}x` + (q.losErrorCorrelated ? "*" : "")
        : n3(q.noiseEstDeg);
    c[COL.noise].title = `Estimated ${n3(q.noiseEstDeg)}° against a declared `
        + `${n3(q.declaredLosSigmaDeg)}°.\n\n`
        + `The estimate is the raw frame-to-frame deviation ${n3(q.jitterDeg)}° (median) `
        + `divided by 1.4422 — valid when the pointing error is random in every direction `
        + `and the true path is locally straight. On a slowly-sampled manoeuvring target, `
        + `real curvature inflates it.\n\n`
        + (q.declaredLosSigmaDeg == null ? "This file declares no pointing error."
            : q.losErrorCorrelated
                ? `Error model: ${q.losErrorModel ?? "correlated"} — the declared figure is a `
                    + `deadband AMPLITUDE, not a standard deviation, so this ratio is not a `
                    + `like-for-like comparison and reads far below 1. The gap is the `
                    + `signature of wobble, not a disagreement. ${q.losErrorNote ?? ""}`
                : `Error model: ${q.losErrorModel ?? "white"} — a per-axis standard deviation `
                    + `(1-sigma), so the ratio is like-for-like. ${q.losErrorNote ?? ""}`);
    // Only a WHITE declaration can be off; flag a real mismatch, never a wobble.
    if (!q.losErrorCorrelated && Number.isFinite(noiseRatio)
        && (noiseRatio < 0.7 || noiseRatio > 1.4)) {
        c[COL.noise].style.color = "#ef6c00";
        c[COL.noise].style.fontWeight = "700";
    }

    c[COL.src].textContent = grade.grade;
    c[COL.src].style.color = GRADE_COLOURS[grade.grade] ?? "";
    c[COL.src].style.fontWeight = "700";
    c[COL.src].title = (grade.reasons.length ? grade.reasons.join("\n") : "No flagged degeneracy.")
        + (r.earthModel ? `\n\nEarth model in force: ${r.earthModel}.` : "")
        + (r.surfaceModel ? `\nGround: ${r.surfaceModel}.` : "")
        // The Probe column used to sit in the analysis group and was read by
        // nobody; its one genuinely useful statement — did pure geometry pin a
        // range without a speed assumption — belongs here, with the rest of
        // what the SOURCE can support.
        + (r.probe ? `\n\nGeometry probe: ${r.probe.speedOverride
            ? `pinned a range but the implied speed exceeded twice the fit's target, so it fell `
                + `back to the prior — read as RECOVERABLE, a fast object at pinned range is a finding`
            : r.probe.geometryPinned
                ? `pure smoothness PINNED the range at ${fmtMetres(r.probe.rangeM)}, with no `
                    + `speed assumption`
                : `geometry left range ambiguous; the Minimum Acceleration fit used its speed prior`}`
            + `. Speaks for geometry only — physics and stationary methods may still succeed.` : "");

    c[COL.verdict].textContent = shortVerdict(r.headline, r.verdictCode);
    c[COL.verdict].title = (r.headline ? r.headline + "\n\n" : "")
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
    c[COL.top].textContent = (topViolates ? "⚠ " : "") + (r.topRangeBlind ? "◇ " : "")
        + shortTopName(r.top?.name);
    const otherViolators = (r.maxRangeViolations ?? []).length - (topViolates ? 1 : 0);
    c[COL.top].title = (r.top ? `${r.top.name}\nRank tier: ${r.top.tier}. ${r.candidates} candidates considered.` : "")
        + (r.topRangeBlind
            ? `\n\n◇ RANGE-BLIND FAMILY. This is one of the curve-fitting strategies, which `
                + `TraverseHypotheses documents as a method diagnostic rather than a ranking: a `
                + `higher-order curve hugs the sightlines more closely simply because it bends `
                + `more, so its low residual is arithmetic and not evidence about the object. `
                + `Its distance is inherited from the range anchor, so the Range cell beside it `
                + `is not a measurement.`
            : "")
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
    if (topViolates) c[COL.top].style.color = "#c62828";
    if (r.topRangeBlind) c[COL.top].style.color = "#ef6c00";

    // RESIDUAL AGAINST THE NOISE FLOOR. A bare residual invites the reading
    // "small means good", which on bearings-only data is false: the residual is
    // nearly invariant to how far away the track is placed, so a candidate can
    // post the best number in the run and sit at the wrong range entirely. The
    // floor makes the comparison the reader should be making visible in the cell.
    const sep = r.separability;
    c[COL.err].textContent = n3(r.top?.errDeg)
        + (sep ? ` / ${n3(sep.floorDeg)}` : "");
    c[COL.err].title = `Top interpretation's mean LOS residual: ${n3(r.top?.errDeg)}°.`
        + (sep
            ? `\n\nNoise floor ${n3(sep.floorDeg)}° — what a PERFECT track scores against the `
                + `declared ${n3(q.declaredLosSigmaDeg)}° pointing error. (The per-frame error `
                + `is two Gaussians in the tangent plane, so its magnitude is Rayleigh and its `
                + `mean is sigma x 1.2533.)`
                + (sep.topBelowFloor
                    ? `\n\nTHIS RESIDUAL IS BELOW THE FLOOR. The winning model fits the `
                        + `sightlines better than the true trajectory does, which means it is `
                        + `fitting the pointing noise. Its low residual is not evidence.`
                    : "")
                + (sep.belowFloor > 0
                    ? `\n${sep.belowFloor} of ${sep.candidates} candidates beat the floor.` : "")
                + (Number.isFinite(sep.marginDeg) && Number.isFinite(sep.seDeg)
                    ? `\n\nThe winner led the runner-up by ${n3(sep.marginDeg)}°, against a `
                        + `sampling error of ${n3(sep.seDeg)}° on a residual mean over `
                        + `${q.frames} frames`
                        + (sep.marginDeg < 2 * sep.seDeg
                            ? ` — the lead is INSIDE the noise, so the residual did not `
                                + `separate these two candidates.` : `.`)
                    : "")
            : `\n\nNo noise floor: this file declares no white pointing sigma.`);
    if (sep && (sep.topBelowFloor
        || (Number.isFinite(sep.marginDeg) && Number.isFinite(sep.seDeg)
            && sep.marginDeg < 2 * sep.seDeg))) {
        c[COL.err].style.color = "#ef6c00";
    }

    c[COL.range].textContent = Number.isFinite(r.top?.rangeStartM)
        ? n2(r.top.rangeStartM / METERS_PER_NM) : "";
    c[COL.range].title = Number.isFinite(r.top?.rangeStartM)
        ? `${fmtMetres(r.top.rangeStartM)}` + (Number.isFinite(r.top?.speedKt)
            ? `, mean air speed ${n0(r.top.speedKt)} kt` : "")
            + (r.topRangeBlind ? `\n\nInherited from the range anchor — see the ◇ note on the `
                + `interpretation to the left. Not a measurement.` : "")
        : "";
    c[COL.spd].textContent = Number.isFinite(r.top?.speedMinKt) && Number.isFinite(r.top?.speedMaxKt)
        ? `${Math.round(r.top.speedMinKt)}-${Math.round(r.top.speedMaxKt)}`
        : "";
    c[COL.spd].title = Number.isFinite(r.top?.speedKt)
        ? `Air speed of the top interpretation over the clip: `
            + `${Math.round(r.top.speedMinKt)}-${Math.round(r.top.speedMaxKt)} kt `
            + `(mean ${n0(r.top.speedKt)} kt).`
        : "";
    c[COL.alt].textContent = Number.isFinite(r.top?.altMeanM)
        ? `${Math.round(r.top.altMeanM * 3.28084)}` : "";
    c[COL.alt].title = Number.isFinite(r.top?.altMeanM)
        ? `Mean altitude of the top interpretation's track: `
            + `${Math.round(r.top.altMeanM * 3.28084)} ft (${Math.round(r.top.altMeanM)} m).`
        : "";

    if (r.truthScore) {
        const ts = r.truthScore;
        c[COL.truth].textContent = Number.isFinite(ts.topRelSep)
            ? `${(ts.topRelSep * 100).toFixed(1)}%` : (Number.isFinite(ts.topSepM) ? fmtMetres(ts.topSepM) : "—");
        c[COL.truth].title = `Top interpretation is ${fmtMetres(ts.topSepM)} from truth`
            + (Number.isFinite(ts.topRelSep) ? ` (${(ts.topRelSep * 100).toFixed(1)}% of the true range)` : "")
            + `.\nClosest candidate of any: ${fmtMetres(ts.bestSepM)} (${ts.bestName ?? "—"}).`
            + (Number.isFinite(ts.truthResidualDeg)
                ? `\nTruth's own LOS residual — the achievable floor — is ${n3(ts.truthResidualDeg)}°.` : "");
        // Green when the analysis both picked well and landed close.
        const good = Number.isFinite(ts.topRelSep) && ts.topRelSep <= 0.10;
        c[COL.truth].style.color = good ? "#2e7d32" : (Number.isFinite(ts.topRelSep) ? "#c62828" : "");

        // THE ORACLE, beside the achieved score. The pair is the whole point:
        // Truth alone cannot say whether a bad result means the fits missed or
        // the ranking discarded a good fit, and those need different repairs.
        c[COL.best].textContent = Number.isFinite(ts.bestRelSep)
            ? `${(ts.bestRelSep * 100).toFixed(1)}%` : "—";
        const cost = Number.isFinite(ts.bestSepM) && ts.bestSepM > 0
            && Number.isFinite(ts.topSepM) ? ts.topSepM / ts.bestSepM : null;
        c[COL.best].title = `Closest candidate any method produced: ${ts.bestName ?? "—"} at `
            + `${fmtMetres(ts.bestSepM)}`
            + (Number.isFinite(ts.bestRelSep)
                ? ` (${(ts.bestRelSep * 100).toFixed(1)}% of true range)` : "") + `.`
            + `\n\nAn ORACLE: truth picked this winner, so it is a ceiling and not a score the `
            + `analysis could claim.`
            + (Number.isFinite(cost) && cost > 1.05
                ? `\n\nThe ranking cost a factor of ${cost < 10 ? cost.toFixed(1) : Math.round(cost)}x `
                    + `on this file — the answer was among the candidates and was not chosen.`
                : `\n\nThe ranking picked this candidate, so nothing was lost to ranking here.`);
        // Amber when the fits found it and the ranking threw it away — a
        // DIFFERENT failure from the red in the Truth column beside it.
        c[COL.best].style.color = Number.isFinite(cost) && cost > 3 ? "#ef6c00" : "";
        c[COL.best].style.fontWeight = Number.isFinite(cost) && cost > 3 ? "700" : "";
    } else if (r.directionScore) {
        // DEGREES, not metres, and labelled so. A direction-only target has no
        // range to be right or wrong about; the comparable quantity is bearing
        // error. Showing a blank here previously read as "could not be scored".
        const ds = r.directionScore;
        c[COL.truth].textContent = Number.isFinite(ds.topDeg) ? `${n2(ds.topDeg)}°` : "—";
        c[COL.truth].title = `${ds.label}. The top interpretation's mean BEARING error is `
            + `${n3(ds.topDeg)}°; the closest candidate of any was ${ds.bestName} at `
            + `${n3(ds.bestDeg)}°.\n\nThis target has no finite range, so 3-D separation and `
            + `relative separation are undefined for it — this column is in degrees for this `
            + `row and metres/percent for the others, and the two are never averaged together.`;
        c[COL.truth].style.color = Number.isFinite(ds.topDeg) && ds.topDeg <= 1 ? "#2e7d32" : "#c62828";
        c[COL.best].textContent = Number.isFinite(ds.bestDeg) ? `${n2(ds.bestDeg)}°` : "—";
        c[COL.best].title = `Closest candidate by BEARING error: ${ds.bestName} at `
            + `${n3(ds.bestDeg)}°. Degrees for this row, percent for the others.`;
    } else {
        c[COL.truth].textContent = "";
        c[COL.truth].title = "This file carries no TruePosition column and no direction truth, "
            + "so nothing here is scored.";
        c[COL.best].textContent = "";
        c[COL.best].title = c[COL.truth].title;
    }

    // Actions: the full gallery, and the HTML report. A CACHED row has no
    // in-memory analysis (the cache stores rows, like Export JSON), so both
    // are disabled with the reason on the tooltip rather than failing on click.
    c[COL.actions].innerHTML = "";
    const galleryButton = smallButton("Gallery", "#1976d2", BUTTON_TOOLTIPS["Gallery"]);
    galleryButton.onclick = () => {
        try {
            showTraverseGallery(entry.results);
        } catch (e) {
            showError("Could not open the gallery for this result: " + (e && e.message), e);
        }
    };
    c[COL.actions].appendChild(galleryButton);
    const reportButton = smallButton("Report", "#455a64", BUTTON_TOOLTIPS["Report"]);
    reportButton.style.marginLeft = "3px";
    reportButton.onclick = () => openReport(entry, reportButton);
    c[COL.actions].appendChild(reportButton);
    if (!entry.results) {
        for (const b of [galleryButton, reportButton]) {
            setButtonDisabled(b, true);
            b.title = "This row came from the folder's result cache, which holds the "
                + "row only. Flush Cache and re-run to load the full analysis.";
        }
    }

    entry.tr.style.background = grade.grade === "weak" ? "#fff5f5"
        : grade.grade === "hard" ? "#fffaf0" : "#f7fff7";

    // A completed row may extend the open column-scatter plot.
    if (state.scatter?.x && state.scatter?.y) updateScatterPlot(state);
}

/**
 * Open one scenario in a fresh Sitrec window.
 *
 * WHY THIS IS NOT A PLAIN href. The rows come from a folder picker or a drag,
 * so the file is an in-memory Blob with no URL and no path — there is nothing
 * for a link to point AT. The bytes are put in the handoff store instead
 * (src/FileHandoff.js) and the new window is sent a key.
 *
 * THE SIDECARS TRAVEL AS NOTES, NOT AS FILES. The interchange sidecars are read
 * by the BENCHMARK's ingest, not by the app's importer — CTrackFileBOT
 * deliberately does not require one and falls back to BOT_DEFAULT_ORIGIN. So
 * handing the app a .scenario.json would produce an unsupported-file error
 * beside a track that loaded fine, which reads as a failure and is not one.
 * Everything they say that a reader needs is rendered to prose instead and
 * carried in the handoff's meta, to land in the sitch Notes panel.
 *
 * ONE KEY, NOT A LIST. The handoff record holds an ARRAY of files plus the
 * meta, so the scenario, every consistent candidate and the notes travel under
 * a single key — there is no need to join keys with a separator in the URL,
 * and nothing can arrive half-transferred because the record is written in one
 * transaction.
 *
 * WHAT TRAVELS: the scenario CSV (sensor track, and truth where the file
 * carries it), one CUSTOM1 CSV per consistent candidate named c_<key>, and the
 * notes. The candidates are the point — the scenario alone shows what was
 * observed, and the reason to open a row is to see what the analysis made of it.
 *
 * The window is claimed synchronously, before the store write, for the same
 * reason openReport does it: window.open is only honoured while the click's
 * transient activation is live, and an await drops it.
 */
function openInNewSitrec(entry, link) {
    const original = link.textContent;
    link.textContent = "opening…";
    openHandoffWindow({
        buildFiles: async () => {
            const file = await entry.getFile();
            // The sidecar TEXT is already on the entry — pairSidecars attached
            // it during the folder walk, which is the only moment the siblings
            // were visible together. Parsed leniently: a malformed sidecar
            // must cost the notes, never the file open.
            const parse = (text, what) => {
                if (!text) return null;
                try { return JSON.parse(text); }
                catch (e) { console.warn(`BotBench: could not parse the ${what}:`, e); return null; }
            };
            const notes = buildScenarioNotes(
                parse(entry.sidecarText, "scenario sidecar"),
                parse(entry.labelsText, "truth sidecar"),
                entry.relativePath);

            // botENUToLLA, the SCENARIO'S OWN conversion, and MSL rather than
            // HAE — see the note on consistentTrackCSVs for why a general
            // ENU->ECEF->LLA is wrong on a BOT file in two compounding ways.
            const origin = entry.results?.botOrigin;
            const candidates = (entry.results && origin) ? consistentTrackCSVs(entry.results, {
                toLLA: (x, y, z) => botENUToLLA(x, y, z, origin),
                altitudeIsHAE: false,
                startMs: entry.results.clipStartMs,
            }) : [];

            return {
                files: [file, ...candidates.map((c) =>
                    new File([c.text], `${c.name}.csv`, {type: "text/csv"}))],
                meta: {
                    source: "botbench", relativePath: entry.relativePath,
                    // The scenario CSV already carries the sensor and truth
                    // tracks, so unlike the gallery this sends no context
                    // tracks — adding them would import each one twice.
                    lookCameraFraming: lookCameraFraming(entry.results, candidates),
                    notes: `${notes}\n\n${candidateNotes(candidates)}`,
                },
            };
        },
        // action=new gives the custom sitch, which is the neutral scene a BOT
        // track should land in — it carries no target of its own to conflict
        // with the one being imported. The live gallery does the opposite and
        // keeps its own sitch, because there the candidates belong in the scene
        // they were computed from.
        urlFor: (key) => {
            const url = new URL(window.location.href);
            url.hash = "";
            url.search = "";
            url.searchParams.set("action", "new");
            url.searchParams.set("handoff", key);
            return url.toString();
        },
        onDone: () => { link.textContent = original; },
    });
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
    c[COL.status].textContent = "error";
    c[COL.status].title = message;
    c[COL.verdict].textContent = message;
    c[COL.verdict].title = message;
    entry.tr.style.background = "#fff5f5";
}

function refreshControls(state) {
    const running = state.running;
    const has = state.entries.length > 0;
    setButtonDisabled(state.chooseFolderReadButton, running);
    setButtonDisabled(state.chooseFolderCacheButton, running);
    setButtonDisabled(state.chooseFilesButton, running);
    setButtonDisabled(state.cancelButton, !running);
    setButtonDisabled(state.clearButton, running || !has);
    // Flush needs a folder with handles; entries or loaded caches signal one.
    setButtonDisabled(state.flushCacheButton, running
        || !(state.entries.some((e) => e.dirHandle) || state.dirCaches?.size));
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
    // The selections survive a clear (the next run plots straight into them);
    // the now-empty plot just says so.
    if (state.scatter?.x && state.scatter?.y) updateScatterPlot(state);
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

        // Cache lookup, best-effort: any failure here (hashing, an unreadable
        // cache file) falls through to a normal run rather than an error row.
        let hashes = null, dirCache = null, cachedHit = false;
        try {
            setRowStatus(entry, "hashing");
            hashes = await entryFileHashes(entry);
            dirCache = await loadDirCache(state, entry);
            const hit = dirCache?.data.results[entry.name];
            if (hit && hit.hash === combinedHash(hashes)
                && JSON.stringify(hit.options ?? null) === JSON.stringify(entry.options ?? null)) {
                entry.row = hit.row;
                entry.status = "done";
                entry.fromCache = true;
                cachedHit = true;
                fillRow(state, entry);
                setRowStatus(entry, "cached",
                    `Reused from ${CACHE_FILENAME} (saved ${hit.savedAt ?? "?"}, `
                    + `app ${dirCache.data.appVersion ?? "?"}).\n`
                    + `Every input hash and every analysis option matches this file's `
                    + `cached run.\nGallery/Report need the in-memory analysis — `
                    + `Flush Cache and re-run to get them.`);
            }
        } catch (cacheError) {
            console.warn("BotBench cache lookup failed for", entry.relativePath, cacheError);
        }

        if (!cachedHit) try {
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
            // The hashes ride on the ROW, so Export JSON records exactly which
            // bytes produced each result.
            if (hashes) row.fileSha256 = hashes;
            entry.status = "done";
            fillRow(state, entry);
            if (dirCache?.writable && hashes) {
                dirCache.data.results[entry.name] = {
                    hash: combinedHash(hashes), hashes,
                    savedAt: new Date().toISOString(),
                    options: {...entry.options}, row,
                };
                try { await writeDirCache(dirCache); }
                catch (writeError) {
                    console.warn("BotBench cache write failed for",
                        entry.relativePath, writeError);
                }
            }
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

// mode "read": existing caches are still REUSED (reading needs no write
// grant), but no new cache is written and Flush Cache cannot delete them.
// mode "readwrite": the browser grants write access to the folder and every
// subfolder, and each leaf folder gets its cache written back.
async function runFolderScan(state, mode) {
    if (!supportsDirectoryPicker()) {
        showLocalFolderAccessUnsupportedMessage();
        return;
    }
    let directoryHandle;
    try {
        directoryHandle = await window.showDirectoryPicker({mode});
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
        for (const e of raw) e.cacheWritable = (mode === "readwrite");
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
    const found = await pairSidecars((files || []).filter((e) => isExplicitlyCollectable(e.name)),
        {explicit: true});
    if (!found.length) {
        state.status.textContent = "None of the selected files are ones BOTBench can analyse "
            + "(BOT interchange CSV, FMV .ts/.klv, a track CSV or .srt with camera pointing, "
            + "or a STANAG 4676 .xml).";
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
        disposeScatterView(state);
        if (state.overlay.parentNode) document.body.removeChild(state.overlay);
        if (activeDialog === state) activeDialog = null;
    };
    state.cancelButton.onclick = () => {
        state.cancelled = true;
        state.status.textContent = "Cancelling after the current file...";
        setButtonDisabled(state.cancelButton, true);
    };
    state.clearButton.onclick = () => clearResults(state);
    state.flushCacheButton.onclick = () => flushCaches(state).then(() => refreshControls(state));
    state.chooseFolderReadButton.onclick = () => runFolderScan(state, "read");
    state.chooseFolderCacheButton.onclick = () => runFolderScan(state, "readwrite");
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
            "sitrec-botbench-summary.txt", "BOTBench Run Summary");
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
            // The two ingest internals worth exercising directly: a timebase
            // choice and a continuity decision are hard to provoke through a
            // real file and trivial to provoke through a synthetic one.
            ingestMISBRecords, longestUniformRun, measureAnchorRate,
            buildSummaryReport, resultsToCsv,
            get state() { return activeDialog; },
        };
    }
    botBenchController = fileAnalysisFolder.add({botBench: openBotBenchDialog}, "botBench")
        .name("BOTBench...")
        .tooltip("Run the traverse analysis over many files at once and compare the results — "
            + "BOT (bearings-only traversal) interchange scenarios, or FMV video clips with "
            + "embedded camera metadata")
        .perm();
    return botBenchController;
}
