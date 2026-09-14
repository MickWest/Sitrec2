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
 * Rows keep their summary and chart facts. A small recent set keeps its full
 * analysis; older rows rebuild it from stored fits when Gallery or Report opens.
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
import {showError, showConfirm} from "../showError";
import {openResultChartsForEntries} from "./charts/RockV3ChartsUI";
import {apertureFromPositions, candidateErrorsFrom, sensorTurnFromPositions} from "./charts/BotBenchChartRows";
import {showTimingAnalysis} from "../showTimingAnalysis";
import {isLocal} from "../configUtils";
import {par} from "../par";
import {showTraverseGallery} from "../AnalyzeTraverse";
import {METERS_PER_NM} from "../TraverseAnalysis";
import {
    botBenchExplicitFileRole, botBenchFileRole, botBenchPairingKeys, interchangeFoldersToSkip,
    buildScenarioNotes, ingestBotBenchEntry, srtHasPointing,
    ingestMISBRecords, sourceQualityGrade,
} from "./BotBenchIngest";
import {longestUniformRun, measureAnchorRate} from "./BotBenchClock";
import {putFileHandoff} from "../FileHandoff";
import {ABSENT_HYPOTHESES, DEFAULT_ANCHOR_M, runBotBenchAnalysis} from "./BotBenchRunner";
import {botBenchConcurrency, createBotBenchYield, runBotBenchQueue} from "./BotBenchWorkerPool";
import {BotBenchAnalysisPool} from "./BotBenchAnalysisPool";
import {entryFileHashes, readEntrySidecars} from "./BotBenchEntryFiles";
import {packForCache, unpackFromCache, sameFittedRow} from "./BotBenchCacheCodec";
import {
    SOLVERS, allSolverIds, describeSolvers, isEverySolver, normalizeSolvers, planUnits, selectionKey,
    unitVersionsFor,
} from "./BotBenchSolvers";
import {
    CACHE_BLOB_DIR, CACHE_FILENAME, CACHE_SCHEMA, LEGACY_UNITS, adoptRecord, combinedHash, emptyIndex,
    isLegacyEntry, legacyUnitsFromBattery, normalizeIndex, packUnitBlob, recordRowMemo, recordUnit,
    rowMemoUsable, unitBlobName, unitMetaFromBlob, unitRecord, unitRecordFromMeta,
    unitRecordUsable, unitResultAgrees, valuesAgree, elapsedFromUnits, describeDuration, formatBytes, measureCacheOnDisk, recordedFitMs,
} from "./BotBenchCacheIndex";
import {
    runImageCapture, captureScenarioImage, captureViewBlob, waitForSettle, clearImportedTracks,
    captureEntryImage, createCaptureQueue, captureQueueIdle, imageDirFor, imageNameFor, imageStaleness,
} from "./BotBenchImageCapture";
import {
    botHandoffFrame, candidateNotes, handoffCandidateCSVs, lookCameraFraming, openHandoffWindow,
} from "../TraverseHandoff";
import {CNodeCustomGraphView} from "../nodes/CNodeCustomGraphView";
import {NodeMan} from "../Globals";
import {WindowedTableBody} from "./WindowedTableBody";

let activeDialog = null;
let botBenchController = null;

const BUTTON_TOOLTIPS = {
    "Close": "Close this window and restore the previous Sitrec playback state. Results are discarded.",
    "Folder (Read)": "Pick a folder of BOT interchange scenarios and/or FMV clips with READ-ONLY access. Sidecars (.scenario.json) are paired automatically. Existing .botbench-cache.json results are still reused when their hashes match, but no new caches are generated and Flush Cache cannot delete them.",
    "Folder (Caching)": "Pick a folder of BOT interchange scenarios and/or FMV clips, granting FULL WRITE access to the folder and all its subfolders (the browser will ask). Each leaf folder gets a .botbench-cache.json index and a .botbench-cache/ folder holding the fitted analyses, so an unchanged file skips the optimizers on the next run and still gives a complete result — Gallery, Report and Open in Sitrec all work from cache. Flush Cache deletes both.",
    "Choose Files": "Pick individual files to run. Without their .scenario.json sidecars, BOT files fall back to the shipped set's default origin, with the rate read from the CSV's own Time column.",
    "Cancel Run": "Stop the run. The file currently being analysed is abandoned and marked cancelled; completed rows keep their results.",
    "Clear Results": "Remove every result from the table and start fresh.",
    "Flush Cache": "Delete the .botbench-cache.json index and the .botbench-cache/ fits from every folder in the current run, so the next run fits every file from scratch. Fits are stored per solver and reused only when the input hashes, the unit's version and the analysis options all match, and a new build reuses a unit only after re-fitting a sample of files reproduces it — so a stale cache normally re-runs itself rather than needing this. It first counts what it would delete and asks you to type Flush before it does.",
    "Solvers…": "Choose which solvers the next run fits and ranks. Fits are stored per solver, so a run with more solvers than the last one fits only the missing ones.",
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
// background stays untouched underneath) and scroll it into view. The outline is
// recorded against the ENTRY and drawn by paintTableRow, because a row element is
// reused for other entries as the table scrolls and would carry the outline to them.
function highlightScatterRow(state, entry) {
    const previous = state.scatterHighlightEntry ?? null;
    state.scatterHighlightEntry = entry ?? null;
    if (previous && previous !== entry) state.rowView?.refreshRow(previous.rowIndex);
    if (entry) {
        state.rowView?.scrollToIndex(entry.rowIndex);
        if (entry !== previous) state.rowView?.refreshRow(entry.rowIndex);
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

// Every results row is exactly this tall. The table draws only the rows in view
// (see WindowedTableBody), which turns a row index into a pixel offset by
// multiplication, so a row one pixel taller would put every row below it in the
// wrong place. Cells therefore have no vertical padding and one line of content,
// and the tallest thing a row holds, the 20 px Gallery button, fits inside it.
const ROW_HEIGHT_PX = 28;

// Rows drawn beyond the viewport on each side, so a scroll shows rows that are
// already in the page. With twenty to thirty rows in view the table holds about
// 60-70 rows, some 1,500 elements, however many files the run has.
const ROW_OVERSCAN = 20;

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

// THE EXPORT IS THIS LIST, NOT THE RECORD. `resultsToCsv` maps over these
// names, so a key that `rowToCsvRecord` populates but this array omits is
// dropped in silence — the CSV simply lacks the column and nothing complains.
// That has happened; `csvColumnsCoverRecord` in the tests is the guard.
export const CSV_COLUMNS = [
    "file", "displayName", "kind", "status", "trackId",
    "frames", "durationS", "fps", "sensorSpanM", "sensorPathM", "straightness",
    "sensorAltSpanM", "netSweepDeg", "sweepPathDeg", "rateMedianDegPerS",
    "jitterDeg", "noiseEstDeg", "declaredLosSigmaDeg",
    "rcond", "log10Rcond", "conditioning", "effectiveRank",
    "losErrorModel", "losErrorCorrelated",
    "timeCv", "timeGaps", "invalidFrames", "droppedRows",
    "sourceGrade", "sourceReasons", "earthModel", "surfaceModel",
    "verdictCode", "headline", "viableClasses", "rangeUnobservable",
    "ordTop", "ordTopClass", "ordTopSize", "ordTopSpeed", "ordTopG",
    "ordTopSizeOneSided",
    "ordMin", "ordMinClass", "ordMinName", "ordMinErrDeg",
    "declaredMaxRangeM", "maxRangeViolationCount", "topViolatesMaxRange",
    "optAnchorNM", "optRangeBands", "optMcSweep", "optSolvers",
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

export function rowToCsvRecord(entry) {
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
        // Mundaneness, exported so an offline study can score it. The per-term
        // breakdown is what makes a cost falsifiable — a total alone cannot say
        // whether size, speed or acceleration carried it.
        ordTop: r?.mundaneness?.top?.total, ordTopClass: r?.mundaneness?.top?.label ?? "",
        ordTopSize: r?.mundaneness?.top?.sizeCost,
        ordTopSpeed: r?.mundaneness?.top?.speedCost,
        ordTopG: r?.mundaneness?.top?.gCost,
        // Whether the size term had a lower bound at all. On a sub-pixel target
        // it does not, and a study that missed that would read a zero size cost
        // as evidence of ordinary size rather than as an absent measurement.
        ordTopSizeOneSided: r?.mundaneness?.top?.sizeOneSided ?? "",
        ordMin: r?.mundaneness?.mostOrdinary?.total,
        ordMinClass: r?.mundaneness?.mostOrdinary?.label ?? "",
        ordMinName: r?.mundaneness?.mostOrdinary?.name ?? "",
        ordMinErrDeg: r?.mundaneness?.mostOrdinary?.errDeg,
        rangeUnobservable: r?.rangeUnobservable ?? "",
        optAnchorNM: entry.options ? (entry.options.anchorM / METERS_PER_NM).toFixed(2) : "",
        optRangeBands: entry.options ? entry.options.solutionFamilies : "",
        optMcSweep: entry.options ? entry.options.mcOrderSweep : "",
        // The solvers the row was built from: "all", or the ids joined with +.
        optSolvers: entry.options ? (isEverySolver(entry.options.solvers) ? "all"
            : normalizeSolvers(entry.options.solvers).join("+")) : "",
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
                + `MC sweep ${o.mcOrderSweep ? "on" : "off"}, `
                + describeSolvers(o.solvers));
        }
    } else {
        const o = optionSets.length ? JSON.parse(optionSets[0]) : options;
        L.push(`  Range anchor:            ${(o.anchorM / METERS_PER_NM).toFixed(1)} NM `
            + `(the same for every file — see the note below)`);
        L.push(`  Range bands:             ${o.solutionFamilies ? "on" : "off"}`);
        L.push(`  Monte Carlo order sweep: ${o.mcOrderSweep ? "on" : "off"}`);
        L.push(`  Solvers:                 ${describeSolvers(o.solvers)}`
            + (isEverySolver(o.solvers) ? "" : ` — ${normalizeSolvers(o.solvers).join(", ")}`));
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
        // HOW ORDINARY. Two columns because they are two claims: what we PICKED
        // scored, and what the data ALLOWED anywhere in the gallery. On a
        // bearings-only problem the second is routinely far lower — a different
        // range makes almost any motion ordinary — and one column would hide it.
        {h: "Ord", w: 5, get: (e) => n2(e.row?.mundaneness?.top?.total), right: true},
        {h: "OrdMin", w: 6, get: (e) => n2(e.row?.mundaneness?.mostOrdinary?.total), right: true},
        // OrdMin's own residual, and it must sit beside it. Ungated, the most
        // ordinary candidate can be one that fits badly, and a bare "0.00"
        // would then read as "an ordinary explanation fits" when it does not.
        {h: "OrdErr", w: 7, get: (e) => n3(e.row?.mundaneness?.mostOrdinary?.errDeg), right: true},
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
    L.push("  Ord  = how ordinary the TOP candidate is, in decades outside the nearest");
    L.push("         real object's envelope. 0 = every quantity inside some class.");
    L.push("  OrdMin = the most ordinary candidate ANYWHERE in the gallery, ungated by");
    L.push("         residual — so READ IT WITH OrdErr, that candidate's own |err|. A low");
    L.push("         OrdMin at a high OrdErr is an ordinary explanation that does not fit.");
    L.push("         A low OrdMin at a low OrdErr beside a high Ord is the real finding:");
    L.push("         an ordinary explanation exists AT A DIFFERENT RANGE and the");
    L.push("         sightlines alone cannot choose between them.");
    L.push("  Neither Ord nor OrdMin moves the ranking. Both are disclosure.");
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
 * attaches a file reference to the row that needs it. Text is read only while
 * hashing, ingesting or opening that row, not retained for the whole folder.
 *
 * TWO LAYOUTS, ONE LOOKUP. The pairing key is DIRECTORY + scenario base, not
 * the base alone: a recursive walk over a swept tree sees the same basename in
 * every batch folder, and a bare-name key would pair a scenario with another
 * batch's frame origin — a wrong answer that looks like a right one.
 *
 * The botset trees put both sidecars in a `meta/` folder beside Input/, Truth/
 * and All/ instead of beside each CSV, so a sidecar there is registered under
 * its PARENT directory as well. A CSV then tries its own directory first (the
 * sibling layout) and falls back to its parent (the meta layout). Both keys
 * still carry the batch path, so the cross-batch collision stays impossible.
 */
export async function pairSidecars(found, {explicit = false} = {}) {
    const sidecars = new Map();
    const labels = new Map();
    const rows = [];
    for (const f of found) {
        const role = explicit ? botBenchExplicitFileRole(f.name) : botBenchFileRole(f.name);
        const {key, altKey, indexKey} = botBenchPairingKeys(f.relativePath, f.name);
        if (role === "bot-sidecar") sidecars.set(indexKey, f);
        else if (role === "bot-labels") labels.set(indexKey, f);
        else if (role === "bot-csv" || role === "fmv" || role === "track-file") {
            rows.push({...f, key, altKey});
        }
    }
    const queued = explicit ? rows : await keepOnlyPointingSRT(rows);
    for (const r of queued) {
        const s = sidecars.get(r.key) ?? sidecars.get(r.altKey);
        if (s) r.sidecarFile = s;
        const l = labels.get(r.key) ?? labels.get(r.altKey);
        if (l) r.labelsFile = l;
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
// the sha256 of every input that shaped the result (the CSV bytes, the
// .scenario.json sidecar, the .truth.json answer key), one record per FIT UNIT
// stored for it, and the finished row of the last few solver selections. The
// units themselves are blobs under `.botbench-cache/`, one per unit. The rules
// — what is stored, when a stored unit or row may be used, how a schema-2 blob
// is split into units — live in BotBenchCacheIndex.js; this file owns the folder
// handles and the run. The hashes also ride on every row (row.fileSha256), so an
// Export JSON records exactly which bytes produced each result.
//
// WHAT IS CACHED IS THE FIT, NOT THE ANSWER. The expensive part of a run is the
// battery's fits — the optimizers. Everything after them (the candidate set, its
// grading, the verdict, truth scoring, the row) is cheap arithmetic, and it is
// rebuilt from the stored units by the same code that builds it on a fresh
// analysis, in the same worker. So a run that selects more solvers than the last
// one fits only the units it lacks; a change to one fitter invalidates one unit;
// and a new build costs a rebuild of the rows, never the fits it can show it
// reproduces.
//
// THREE THINGS MAKE A UNIT SAFE TO REUSE, and all three are checked:
//   - the input hashes, so a changed file or sidecar misses;
//   - the unit's version and the options that shape it, so a changed fitter or
//     another anchor misses;
//   - THE APP VERSION, because fitting code can change without its version being
//     bumped. Before a big run under a new build a sample of files is fitted for
//     real, and each unit is reused only where every fresh fit reproduces the
//     stored one (the adoption section below).
// A stored ROW is shown as it is only under the build that made it, or after the
// same sample has shown the rebuilt rows identical; otherwise it is rebuilt from
// the units, which takes a fraction of a second a file.
//
// Every blob repeats its index record as `meta`, so an index line lost between
// batched writes is recovered from the blob on disk and the fit is not made
// twice. Writing needs a directory handle, so the cache is read/write for
// Choose Folder (picked with readwrite permission) and inert for drag-and-drop,
// whose FileSystemEntry API is read-only.
// ---------------------------------------------------------------------------

// One handle record per leaf folder for the life of the dialog. Its index is
// loaded while needed and released when the run finishes that folder.
//
// KEYED BY THE HANDLE ITSELF, not by dirPath. A walk numbers its paths relative
// to the folder that was chosen, so the chosen root is always "" — and picking
// a second folder in the same dialog gave it the FIRST folder's cache record,
// handle and writable flag. The second folder's results were then read from and
// written into the first folder's cache, in the first folder's directory. A
// list keyed by handle identity is exact, and stays iterable — which a
// WeakMap is not, and flushCaches has to walk every folder it has touched.
async function loadDirCache(state, entry) {
    if (!entry.dirHandle) return null;   // drag-and-drop: no writable folder
    if (!state.dirCaches) state.dirCaches = [];
    const already = state.dirCaches.find((r) => r.handle === entry.dirHandle);
    if (already?.loading) return already.loading;
    const rec = already ?? {handle: entry.dirHandle, data: null,
        writable: entry.cacheWritable !== false};
    if (!already) state.dirCaches.push(rec);
    rec.loading = (async () => {
        let data = emptyIndex();
        try {
            const fh = await entry.dirHandle.getFileHandle(CACHE_FILENAME);
            data = normalizeIndex(JSON.parse(await (await fh.getFile()).text()));
        } catch (e) { /* absent or unreadable — start fresh */ }
        rec.data = data;
        return rec;
    })();
    return rec.loading;
}

async function releaseDirCache(rec) {
    if (!rec?.data || rec.resultReaders > 0) return;
    // A writer reads rec.data when its turn comes, so finish it before releasing.
    try { await flushDirCache(rec); }
    catch (e) { console.warn("BotBench cache write failed", e); return; }
    if (rec.resultReaders > 0) return;
    rec.recordedFitMs = recordedFitMs(rec.data);
    rec.data = null;
    rec.loading = null;
    rec.writing = null;
}

// THE CACHE INDEX IS WRITTEN IN BATCHES. It is one JSON file per folder holding a
// row for every file in that folder, so rewriting it after each file made every
// completion cost as much as all the earlier ones in that folder put together. A
// folder's index is now written after CACHE_WRITE_BATCH result changes or
// CACHE_WRITE_DELAY_MS, whichever comes first, and every folder is written when the
// run ends, cancelled or not. The unit blobs are still written per file and first, so
// a tab lost mid-run costs at most one batch of index entries — and those are
// recovered from the blobs' own meta on the next run.
// Adopting an unchanged row only changes its build stamp. Those updates use the
// timer or folder-completion flush, not the row-count trigger: repeatedly writing
// the full index to acknowledge a cache hit can cost more than loading the row.
const CACHE_WRITE_BATCH = 25;
const CACHE_WRITE_DELAY_MS = 3000;

function writeDirCache(rec, {metadataOnly = false} = {}) {
    rec.pendingChanges = (rec.pendingChanges ?? 0) + 1;
    if (!metadataOnly && rec.pendingChanges >= CACHE_WRITE_BATCH) return flushDirCache(rec);
    if (!rec.flushTimer) {
        rec.flushTimer = setTimeout(() => {
            flushDirCache(rec).catch((e) => console.warn("BotBench cache write failed", e));
        }, CACHE_WRITE_DELAY_MS);
    }
    return Promise.resolve();
}

function flushDirCache(rec) {
    if (rec.flushTimer) { clearTimeout(rec.flushTimer); rec.flushTimer = null; }
    if (!rec.pendingChanges) return rec.writing ?? Promise.resolve();
    rec.pendingChanges = 0;
    rec.writing = (rec.writing ?? Promise.resolve()).catch(() => {}).then(() => saveDirCache(rec));
    return rec.writing;
}

async function flushAllDirCaches(state) {
    await Promise.all((state.dirCaches ?? []).map((rec) =>
        flushDirCache(rec).catch((e) => console.warn("BotBench cache write failed", e))));
}

async function saveDirCache(rec) {
    rec.data.schema = CACHE_SCHEMA;
    rec.data.savedAt = new Date().toISOString();
    rec.data.appVersion = APP_VERSION;
    const fh = await rec.handle.getFileHandle(CACHE_FILENAME, {create: true});
    const writable = await fh.createWritable();
    await writable.write(JSON.stringify(rec.data, null, 1));
    await writable.close();
}

async function readBlobText(rec, name) {
    const dir = await rec.handle.getDirectoryHandle(CACHE_BLOB_DIR);
    const fh = await dir.getFileHandle(name);
    return (await fh.getFile()).text();
}

async function writeBlobText(rec, name, text) {
    const dir = await rec.handle.getDirectoryHandle(CACHE_BLOB_DIR, {create: true});
    const fh = await dir.getFileHandle(name, {create: true});
    const writable = await fh.createWritable();
    await writable.write(text);
    await writable.close();
}

async function removeBlob(rec, name) {
    try {
        const dir = await rec.handle.getDirectoryHandle(CACHE_BLOB_DIR);
        await dir.removeEntry(name);
    } catch (e) { /* already gone, or a read-only grant */ }
}

// ---------------------------------------------------------------------------
// the memory and main-thread cost of a long run
// ---------------------------------------------------------------------------
//
// MEASURED 2026-09-13 on the whole rock_v3 folder, 37,800 files: with 837 finished
// the dialog was holding 15.1 M candidate-frames, the page's JavaScript heap read
// 5.3 GB against a 4.2 GB limit, and throughput kept falling. Two causes, both
// growing with the number of files already done:
//   * every row kept its FULL analysis — the dataset, every candidate's track for
//     every frame, and the report builder that closes over all of it;
//   * each completion re-scanned every earlier row (summary medians, a memory
//     total, the progress fraction) and rewrote its folder's whole cache index.
// Garbage collection work rises with the live heap, so the first cause alone makes
// each file slower than the one before.
//
// So a finished row keeps its row and a few small facts. The full analysis is held
// only for the last LIVE_RESULTS rows and for rows the user opens, and is rebuilt
// on demand otherwise: from the folder's stored units when it holds this file's
// fits, re-fitted in a one-off worker where it does not.

// THE CHART FACTS, STORED BESIDE THE ROW. The charts need three things from a file
// that its row does not hold: the parallax aperture, every candidate's error against
// truth, and how far the sensor turned. All come from the full analysis, which a long
// run releases once a row is done and a remembered row never rebuilds, so they are
// taken while the analysis exists and stored with the row. Bump the version whenever
// what is taken changes: a row stored with another version is rebuilt once.
const CHART_DATA_VERSION = 2;

/** Take the chart facts from an entry's analysis, while it still has one. */
function captureChartData(entry) {
    entry.apertureDeg ??= apertureFromPositions(entry.results?.dataset?.S,
        entry.results?.truth?.track, entry.results?.truth?.valid);
    entry.candidateErrors ??= candidateErrorsFrom(entry.results);
    entry.sensorTurnDeg ??= sensorTurnFromPositions(entry.results?.dataset?.S);
}

function chartDataFrom(entry) {
    return {version: CHART_DATA_VERSION, apertureDeg: entry.apertureDeg ?? null,
        candidateErrors: entry.candidateErrors ?? null, sensorTurnDeg: entry.sensorTurnDeg ?? null};
}

/** Finished rows that keep their full analysis: enough that the ones just
 * finished open instantly, few enough that memory stays flat however long the run. */
const LIVE_RESULTS = 6;

/** Put an entry's analysis in the live set, releasing the oldest beyond the cap. */
function holdResults(state, entry) {
    if (!entry?.results) return;
    state.liveResults ??= [];
    const at = state.liveResults.indexOf(entry);
    if (at >= 0) state.liveResults.splice(at, 1);
    state.liveResults.push(entry);
    while (state.liveResults.length > LIVE_RESULTS) {
        const released = state.liveResults.shift();
        if (released !== entry) released.results = null;
    }
    state.heldFrames = state.liveResults.reduce((sum, e) =>
        sum + (e.results?.dataset?.n ?? 0) * (e.results?.hypotheses?.length ?? 0), 0);
}

// The build that produced a cache record. Rows are rebuilt under a new build and
// units are re-checked under it — see the section note above.
const APP_VERSION = process.env.BUILD_VERSION_STRING ?? "dev";

/**
 * The stored units a file's run can start from, as blob text for the fitter, and
 * the index records they came from. A unit is taken only when BotBenchCacheIndex
 * says it may be; a blob whose index line was lost is found by its name and its
 * own meta is put back in the index. A schema-2 entry lends its old blob for the
 * units it holds, which the fitter splits.
 *
 * @param adoptUnits  the units another build's fits may be used for, after the
 *                    run's sample check; the legacy blob's units count individually
 */
async function gatherCachedUnits(dirCache, hit, {hash, plan, options, adoptUnits = new Set()}) {
    const texts = {plan: plan.slice(), cached: {}, legacy: null, legacyUnits: [], legacyElapsedMs: null};
    const records = {};
    if (!dirCache || !hit || hit.hash !== hash) return {texts, records};
    const usable = (record, unitId) => unitRecordUsable(record,
        {unitId, options, appVersion: APP_VERSION, adoptable: adoptUnits.has(unitId)});
    for (const unitId of plan) {
        let record = hit.units?.[unitId] ?? null;
        if (!record) {
            try {
                const text = await readBlobText(dirCache, unitBlobName(hash, unitId));
                const recovered = unitRecordFromMeta(unitMetaFromBlob(text));
                if (recovered && usable(recovered, unitId)) {
                    hit.units ??= {};
                    hit.units[unitId] = recovered;
                    texts.cached[unitId] = {text};
                    records[unitId] = recovered;
                }
            } catch (e) { /* no such blob: the unit is fitted */ }
            continue;
        }
        if (!usable(record, unitId)) continue;
        try {
            texts.cached[unitId] = {text: await readBlobText(dirCache, record.blob)};
            records[unitId] = record;
        } catch (e) {
            console.warn("BotBench: a stored fit could not be read; fitting it again", unitId, e);
        }
    }
    if (isLegacyEntry(hit) && (hit.options?.anchorM ?? null) === (options.anchorM ?? null)) {
        const sameBuild = (hit.appVersion ?? null) === APP_VERSION;
        const allowed = LEGACY_UNITS.filter((unitId) => plan.includes(unitId) && !texts.cached[unitId]
            && (sameBuild || adoptUnits.has(unitId)));
        if (allowed.length) {
            try {
                texts.legacy = await readBlobText(dirCache, hit.battery);
                texts.legacyUnits = allowed;
                texts.legacyElapsedMs = hit.elapsedMs ?? null;
            } catch (e) {
                console.warn("BotBench: the old battery blob could not be read; fitting", e);
            }
        }
    }
    return {texts, records};
}

/**
 * Write what a run fitted, and what it split out of a schema-2 blob, as unit blobs,
 * and put their records in the index. A schema-2 entry whose old blob has been
 * split completely is turned into a schema-3 entry and its old blob removed.
 *
 * @returns the records written, by unit id
 */
async function storeUnits(dirCache, entry, {hash, hashes, options, out, legacyHit = null, adoptUnits = new Set()}) {
    const results = dirCache.data.results;
    const written = {};
    for (const [unitId, rec] of Object.entries(out.units ?? {})) {
        // A fit made from a seed a full battery would not have used is this run's
        // result, not the unit (TraverseBattery `seedComplete`).
        if (!rec || rec.cacheable === false) continue;
        const blob = unitBlobName(hash, unitId);
        const record = unitRecord({unitId, blob, options, appVersion: APP_VERSION,
            elapsedMs: rec.elapsedMs, failures: rec.failures});
        try {
            await writeBlobText(dirCache, blob, packUnitBlob({unitId, hash, ...record}, rec.result));
            recordUnit(results, entry.name, {hash, hashes}, unitId, record);
            written[unitId] = record;
        } catch (e) {
            // The codec refuses anything it cannot represent exactly. Skipping the
            // cache costs a re-run next time; writing a lossy blob would cost a
            // wrong answer.
            console.warn("BotBench: not caching the fit for", entry.relativePath, unitId, e);
        }
    }
    const migrated = Object.entries(out.migrated ?? {});
    for (const [unitId, rec] of migrated) {
        // A unit this run fitted afresh is this build's own; the copy split from
        // the old blob is the one the run's check declined, and is not stored.
        if (written[unitId]) continue;
        const blob = unitBlobName(hash, unitId);
        const legacyVersion = legacyHit?.appVersion ?? APP_VERSION;
        const record = unitRecord({unitId, blob, options, appVersion: legacyVersion,
            elapsedMs: null, failures: rec.failures, legacyBatteryMs: rec.legacyBatteryMs,
            adopted: legacyHit?.adopted === true, adoptedFrom: legacyHit?.adoptedFrom ?? null,
            adoptedAt: legacyHit?.adoptedAt ?? null});
        // Stamped with this build only where the run's check allowed the unit to
        // be used; a unit the check never saw keeps the build that fitted it.
        if (legacyVersion !== APP_VERSION && adoptUnits.has(unitId)) adoptRecord(record, APP_VERSION);
        try {
            await writeBlobText(dirCache, blob, packUnitBlob({unitId, hash, ...record}, rec.result));
            recordUnit(results, entry.name, {hash, hashes}, unitId, record);
            written[unitId] = record;
        } catch (e) {
            console.warn("BotBench: could not store a unit split from the old cache", entry.relativePath, unitId, e);
        }
    }
    // The old blob held these units together; once every one it held is a unit of
    // its own (split out, or fitted afresh under this build), it has nothing left to
    // give. The blob's name is taken before the entry's schema-2 fields go: the
    // index entry and `legacyHit` are one object.
    const held = out.legacyHeld ?? [];
    if (legacyHit && held.length && held.every((unitId) => results[entry.name]?.units?.[unitId])) {
        const legacyBlob = legacyHit.battery;
        const hit = results[entry.name];
        if (hit) {
            for (const key of ["battery", "row", "options", "chartData", "elapsedMs", "appVersion",
                "adopted", "adoptedFrom", "adoptedAt"]) delete hit[key];
        }
        await removeBlob(dirCache, legacyBlob);
    }
    return written;
}

/**
 * The fit time a row reports: the time of every unit it was built from, from
 * whichever run fitted it, plus this run's own assembly.
 */
function rowElapsedMs(records, out) {
    const fitted = Object.values(out.units ?? {}).reduce((sum, r) => sum + (r?.elapsedMs ?? 0), 0);
    const assembly = Math.max(0, (out.elapsedMs ?? 0) - fitted);
    return Math.round(elapsedFromUnits({...records, ...(out.units ?? {})}) + assembly);
}

/**
 * Analyse one entry through the cache: show its remembered row when there is
 * one for this selection, otherwise fit what is missing, rebuild the row and
 * store both. The one road for the run and for a row opened later.
 *
 * @param ctx {options, plan, key, pool, adoptUnits, adoptRows, forceRows, hashes,
 *             dirCache, onProgress, isCancelled, yieldToDOM, needResults}
 * @returns {Promise<{row, results, rowReused, hit}>}
 */
export async function analyseEntryWithCache(entry, ctx) {
    const {options, plan, key, pool, dirCache, hashes} = ctx;
    const adoptUnits = ctx.adoptUnits ?? new Set();
    const hash = combinedHash(hashes);
    const hit = dirCache?.data.results[entry.name] ?? null;
    const entryMatches = !!hit && hit.hash === hash;

    // 1. The remembered row, when this selection has one under this build (or an
    //    adopted one), unless the caller needs the full analysis or a rebuild.
    if (entryMatches && !ctx.forceRows && !ctx.needResults) {
        const memo = hit.rows?.[key];
        if (rowMemoUsable(memo, {appVersion: APP_VERSION, unitVersions: unitVersionsFor(plan),
            adoptable: ctx.adoptRows === true}) && memo.chartData?.version === CHART_DATA_VERSION) {
            if ((memo.appVersion ?? null) !== APP_VERSION && dirCache.writable) {
                // The row, and the units it was built from that the sample check
                // cleared, are this build's from now on; otherwise the next run
                // would check them all over again.
                adoptRecord(memo, APP_VERSION);
                for (const unitId of plan) {
                    const record = hit.units?.[unitId];
                    if (record && adoptUnits.has(unitId)) adoptRecord(record, APP_VERSION);
                }
                try { await writeDirCache(dirCache, {metadataOnly: true}); }
                catch (e) { console.warn("BotBench: could not re-stamp the adopted row", e); }
            }
            return {row: unpackFromCache(memo.row), results: null, rowReused: true, hit, memo,
                chartData: memo.chartData, unitsUsed: Object.keys(hit.units ?? {}).length,
                adopted: memo.adopted === true, adoptedFrom: memo.adoptedFrom ?? null};
        }
    }

    // 2. The stored units this selection can start from.
    const {texts, records} = entryMatches
        ? await gatherCachedUnits(dirCache, hit, {hash, plan, options, adoptUnits})
        : {texts: {plan: plan.slice(), cached: {}, legacy: null, legacyUnits: [], legacyElapsedMs: null}, records: {}};
    const fromStore = Object.keys(texts.cached).length + texts.legacyUnits.length;
    if (fromStore) ctx.onStatus?.(fromStore === plan.length ? "cached" : "partly cached",
        `${fromStore} of ${plan.length} fit units read from ${CACHE_FILENAME}; ${plan.length - fromStore} to fit.`);
    // A stored unit used under another build's stamp was allowed by the sample
    // check; it is this build's from now on, so the next run does not check it again.
    let restamped = false;
    for (const [unitId, record] of Object.entries(records)) {
        if ((record.appVersion ?? null) !== APP_VERSION && adoptUnits.has(unitId)) {
            adoptRecord(record, APP_VERSION);
            restamped = true;
        }
    }

    // 3. Fit the rest and build the row, in the worker.
    const record = await ingestBotBenchEntry(entry);
    const out = await pool.run(record, {
        ...options, units: texts,
        onProgress: ctx.onProgress, isCancelled: ctx.isCancelled, yieldToDOM: ctx.yieldToDOM,
    });
    if (ctx.isCancelled?.()) throw new Error("cancelled");
    const {results, row} = out;
    row.fileSha256 = hashes;
    row.elapsedMs = rowElapsedMs(records, out);
    entry.results = results;
    entry.apertureDeg = null; entry.candidateErrors = null; entry.sensorTurnDeg = null;
    captureChartData(entry);

    // 4. Store the fits and the row.
    if (dirCache?.writable) {
        try {
            if (restamped) await writeDirCache(dirCache, {metadataOnly: true});
            await storeUnits(dirCache, entry, {hash, hashes, options, out,
                legacyHit: entryMatches && isLegacyEntry(hit) ? hit : null, adoptUnits});
            recordRowMemo(dirCache.data.results, entry.name, {hash, hashes}, key, {
                row: packForCache(row), chartData: chartDataFrom(entry), elapsedMs: row.elapsedMs,
                appVersion: APP_VERSION, solvers: options.solvers ?? null, unitVersions: unitVersionsFor(plan),
            });
            await writeDirCache(dirCache);
        } catch (e) {
            console.warn("BotBench cache write failed for", entry.relativePath, e);
        }
    }
    return {row, results, rowReused: false, hit, chartData: chartDataFrom(entry),
        unitsUsed: fromStore, fitted: Object.keys(out.units ?? {}), adopted: false, adoptedFrom: null};
}

/**
 * The full analysis for a finished row, rebuilding it if it was released.
 *
 * The result must be the analysis that produced THE ROW IN THE TABLE, never merely
 * one for the same file. The row was built from the folder's stored units under this
 * build, so rebuilding from them reproduces it; the rebuilt row is compared with the
 * table's row all the same, and a mismatch is said out loud. Concurrent requests
 * share one rebuild.
 */
async function ensureResults(state, entry) {
    if (entry.results) {
        holdResults(state, entry);
        return entry.results;
    }
    if (entry.status !== "done") throw new Error("this row has no finished analysis");
    if (!entry.rebuilding) {
        entry.rebuilding = (async () => {
            const options = entry.options ?? runOptions(state);
            const hashes = entry.row?.fileSha256 ?? await entryFileHashes(entry);
            // Compared through the codec, as the run's own self-check is, so NaN and
            // Infinity are seen as themselves rather than flattened to null.
            const tableRow = entry.row ? packForCache(entry.row) : null;
            const dirCache = entry.dirHandle ? await loadDirCache(state, entry) : null;
            if (dirCache) dirCache.resultReaders = (dirCache.resultReaders ?? 0) + 1;
            const pool = new BotBenchAnalysisPool(1);
            let results;
            try {
                const plan = planUnits(options.solvers, options);
                // A row built from this cache may use any unit it holds, whatever
                // build fitted it: that is the unit the row came from.
                const adoptUnits = new Set(entry.fromCache ? plan : []);
                const out = await analyseEntryWithCache(entry, {
                    options, plan, key: selectionKey(options.solvers, options), pool, dirCache, hashes,
                    adoptUnits, adoptRows: false, forceRows: true, needResults: true,
                    isCancelled: () => false, yieldToDOM: async () => {},
                });
                results = out.results;
                // elapsedMs is left out of the comparison: it is the wall-clock time the
                // analysis took, so no fresh fit can ever match it. sameFittedRow holds
                // that rule for every comparison of this kind.
                if (tableRow && !sameFittedRow(out.row, tableRow)) {
                    console.warn("BotBench: rebuilding this row did not reproduce it exactly; the gallery "
                        + "may differ from the table", entry.relativePath);
                }
            } finally {
                pool.dispose();
                if (dirCache) dirCache.resultReaders--;
                if (!state.running) await releaseDirCache(dirCache);
            }
            entry.results = results;
            holdResults(state, entry);
            return results;
        })().finally(() => { entry.rebuilding = null; });
    }
    return entry.rebuilding;
}

/**
 * Run fn at most once per intervalMs: at once when the interval has passed, and
 * otherwise once more at its end, so the last update is never lost. `flush` runs a
 * pending call now; `cancel` drops it.
 */
function makeThrottle(fn, intervalMs) {
    let last = -Infinity;
    let timer = null;
    const run = () => { timer = null; last = performance.now(); fn(); };
    const throttled = () => {
        const wait = intervalMs - (performance.now() - last);
        if (wait <= 0) {
            if (timer) { clearTimeout(timer); timer = null; }
            run();
        } else if (!timer) {
            timer = setTimeout(run, wait);
        }
    };
    throttled.flush = () => { if (timer) { clearTimeout(timer); run(); } };
    throttled.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    return throttled;
}

// ---------------------------------------------------------------------------
// adopting a cache written by an older build
// ---------------------------------------------------------------------------
//
// Any new build changes APP_VERSION. A stored unit fitted by another build is not
// simply trusted: the code of one fitter may have changed without anyone bumping
// that unit's version. Nor is it simply discarded, because most builds do not
// touch the fitting at all, and a large folder would then re-run every optimizer
// for nothing.
//
// So: before a big run whose stored units are stale ONLY on the build, actually FIT
// a random sample of files and compare each unit with its stored copy. A unit that
// reproduces on every sampled file is reused everywhere; one that differs anywhere
// is fitted again for every file, and the others are still reused. The same sample
// says whether the rebuilt rows equal the remembered ones, so those can be shown
// as they are too.
//
// The sample has to be a real fit, not a replay: only running the optimizers says
// whether today's fitter lands where the stored fit did. Adopting is recorded: a
// record keeps the build that really fitted it in `adoptedFrom` and carries
// `adopted: true` forever after, so a cache carried across builds never passes
// itself off as a fresh one.
const CACHE_ADOPT_MIN_FILES = 20;
const CACHE_ADOPT_SAMPLE = 10;

/**
 * Candidates for the compatibility sample, selected from index metadata only.
 * The sample and the run each verify input hashes before using stored results;
 * a current-build run must not read every source file twice just to find none.
 */
export async function findVersionStaleEntries(state, found, options, plan) {
    const stale = [];
    let previous = null;
    for (const source of found) {
        if (state.cancelled) break;
        try {
            if (previous?.handle !== source.dirHandle) {
                await releaseDirCache(previous);
                previous = null;
            }
            const dirCache = await loadDirCache(state, source);
            previous = dirCache;
            const hit = dirCache?.data.results[source.name];
            if (!hit) continue;
            const units = [];
            for (const unitId of plan) {
                const record = hit.units?.[unitId];
                if (record) {
                    if ((record.appVersion ?? null) !== APP_VERSION && unitRecordUsable(record,
                        {unitId, options, appVersion: APP_VERSION, adoptable: true})) units.push(unitId);
                } else if (isLegacyEntry(hit) && LEGACY_UNITS.includes(unitId)
                    && (hit.appVersion ?? null) !== APP_VERSION
                    && (hit.options?.anchorM ?? null) === (options.anchorM ?? null)) {
                    units.push(unitId);
                }
            }
            // Do not retain hit or dirCache.data here: only ten candidates will
            // be sampled, and keeping all their indexes can cost hundreds of MB.
            if (units.length) stale.push({source, units,
                appVersion: hit.units?.[units[0]]?.appVersion ?? hit.appVersion});
        } catch (e) { /* unreadable cache: it will simply re-run */ }
    }
    await releaseDirCache(previous);
    return stale;
}

/** Deterministic-shuffle sample, so the choice is spread over the folder. */
function sampleN(items, n) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
}

/**
 * The stored copy of one unit, as blob text, for a comparison: the unit's own blob,
 * or the same unit split out of a schema-2 blob and packed the same way. The
 * comparison itself (unitResultAgrees) allows floating-point noise, so a fit made
 * on another build of the JavaScript engine still counts as reproduced.
 */
async function storedUnitText(dirCache, hit, hash, unitId, legacySplit) {
    const record = hit.units?.[unitId];
    if (record?.blob) return readBlobText(dirCache, record.blob);
    if (isLegacyEntry(hit) && LEGACY_UNITS.includes(unitId)) {
        if (!legacySplit.units) {
            const battery = unpackFromCache(JSON.parse(await readBlobText(dirCache, hit.battery)));
            legacySplit.units = legacyUnitsFromBattery(battery, {elapsedMs: hit.elapsedMs ?? null});
        }
        const split = legacySplit.units[unitId];
        return split ? packUnitBlob({unitId}, split.result) : null;
    }
    return null;
}

/**
 * Fit a sample for real and compare each unit, and the row, with the stored copy.
 * The fresh fits are stored: they are this build's own, and the sampled files then
 * need no second fit in the run.
 *
 * @returns {Promise<{checked, units: {unitId: {checked, matched, mismatched}}, rows: {checked, matched}}>}
 */
async function probeCacheAdoption(state, stale, options, plan, key, pool, {onProgress = null} = {}) {
    const sample = sampleN(stale, Math.min(CACHE_ADOPT_SAMPLE, stale.length));
    const result = {checked: 0, units: {}, rows: {checked: 0, matched: 0, mismatched: []}};
    for (const unitId of plan) result.units[unitId] = {checked: 0, matched: 0, mismatched: []};
    for (const candidate of sample) {
        if (state.cancelled) break;
        const {source} = candidate;
        let dirCache;
        try {
            dirCache = await loadDirCache(state, source);
            const hit = dirCache?.data.results[source.name];
            if (!hit) continue;
            const hashes = await entryFileHashes(source);
            const hash = combinedHash(hashes);
            if (hit.hash !== hash) continue;
            const entry = {...source};
            const record = await ingestBotBenchEntry(entry);
            // A fresh fit of every planned unit. A schema-2 blob still travels, with
            // nothing allowed from it, so its units are split out and stored beside
            // the fresh ones and the old blob can go.
            let legacy = null;
            if (isLegacyEntry(hit)) {
                try { legacy = await readBlobText(dirCache, hit.battery); } catch (e) { legacy = null; }
            }
            const out = await pool.run(record, {...options,
                units: {plan: plan.slice(), cached: {}, legacy, legacyUnits: [], legacyElapsedMs: hit.elapsedMs ?? null},
                isCancelled: () => state.cancelled});
            result.checked++;
            const legacySplit = {};
            for (const unitId of plan) {
                const fresh = out.units?.[unitId];
                if (!fresh) continue;
                let stored = null;
                try { stored = await storedUnitText(dirCache, hit, hash, unitId, legacySplit); }
                catch (e) { stored = null; }
                if (stored === null) continue;
                const tally = result.units[unitId];
                tally.checked++;
                if (unitResultAgrees(fresh.result, stored)) tally.matched++;
                else tally.mismatched.push(source.relativePath ?? source.name);
            }
            // The remembered row for this selection, from whatever build made it.
            const memo = hit.rows?.[key];
            if (memo?.row) {
                const row = {...out.row, fileSha256: hashes};
                result.rows.checked++;
                // To floating-point noise, and without the fit time, which no two
                // runs share (see valuesAgree in BotBenchCacheIndex).
                if (valuesAgree(row, unpackFromCache(memo.row))) result.rows.matched++;
                else result.rows.mismatched.push(source.relativePath ?? source.name);
            }
            // Keep the work: this build fitted these for real.
            if (dirCache.writable) {
                out.row.fileSha256 = hashes;
                out.row.elapsedMs = rowElapsedMs({}, out);
                entry.results = out.results;
                captureChartData(entry);
                await storeUnits(dirCache, entry, {hash, hashes, options, out,
                    legacyHit: isLegacyEntry(hit) ? hit : null});
                recordRowMemo(dirCache.data.results, entry.name, {hash, hashes}, key, {
                    row: packForCache(out.row), chartData: chartDataFrom(entry), elapsedMs: out.row.elapsedMs,
                    appVersion: APP_VERSION, solvers: options.solvers ?? null, unitVersions: unitVersionsFor(plan),
                });
                await writeDirCache(dirCache);
            }
        } catch (e) {
            // A file that will not fit today tells us nothing about the cache.
            console.warn("BotBench cache probe skipped", candidate.source.name, e);
        } finally {
            await releaseDirCache(dirCache);
        }
        onProgress?.(result);
    }
    return result;
}

/** What the sample said, per unit, in a form a person can decide on. */
function describeAdoptionProbe(probe, plan) {
    const reuse = [], refit = [], unseen = [];
    for (const unitId of plan) {
        const t = probe.units[unitId];
        if (!t || !t.checked) unseen.push(unitId);
        else if (t.matched === t.checked) reuse.push(`${unitId} (${t.matched}/${t.checked})`);
        else refit.push(`${unitId} (differs on ${t.checked - t.matched} of ${t.checked})`);
    }
    const rows = probe.rows.checked
        ? (probe.rows.matched === probe.rows.checked
            ? `Rows: all ${probe.rows.checked} remembered rows were reproduced exactly, so they are shown as they are.`
            : `Rows: ${probe.rows.checked - probe.rows.matched} of ${probe.rows.checked} remembered rows differ, so every row is rebuilt from the fits.`)
        : "Rows: none remembered for this selection; every row is built from the fits.";
    return {reuse, refit, unseen, rows,
        adoptUnits: new Set(plan.filter((u) => probe.units[u]?.checked && probe.units[u].matched === probe.units[u].checked)),
        adoptRows: probe.rows.checked > 0 && probe.rows.matched === probe.rows.checked};
}

async function flushCaches(state) {
    if (state.running || state.flushing) return;
    // Every leaf folder this dialog has touched: entries from the current run
    // plus any cache records already loaded.
    const dirs = new Map();
    for (const e of state.entries) {
        // Keyed by the handle, for the same reason loadDirCache is: two chosen
        // folders both report a dirPath of "", so keying by path would flush
        // one of them and silently leave the other's cache in place.
        if (e.dirHandle) dirs.set(e.dirHandle, e.dirHandle);
    }
    for (const rec of state.dirCaches ?? []) dirs.set(rec.handle, rec.handle);
    if (!dirs.size) {
        state.status.textContent = "No cacheable folders in this session — "
            + "caching needs Choose Folder (drag-and-drop folders are read-only).";
        return;
    }
    state.flushing = true;
    setButtonDisabled(state.flushCacheButton, true);
    try {
        // COUNT IT FIRST. The question has to say what it is asking about: a cache
        // is hours of fitting, and the button sits beside the harmless ones.
        const totals = {indexFiles: 0, indexBytes: 0, blobs: 0, blobBytes: 0};
        const progress = makeThrottle(() => {
            state.status.textContent = `Measuring the cache… ${totals.blobs.toLocaleString()} fitted unit(s), `
                + `${formatBytes(totals.blobBytes)} so far`;
        }, 250);
        progress();
        for (const [, handle] of dirs) {
            const found = await measureCacheOnDisk(handle, (bytes) => {
                totals.blobs++;
                totals.blobBytes += bytes;
                progress();
            });
            totals.indexFiles += found.indexFiles;
            totals.indexBytes += found.indexBytes;
        }
        progress.cancel();
        if (!totals.indexFiles && !totals.blobs) {
            state.status.textContent = `No cache in the ${dirs.size} folder(s) of this session; nothing to flush.`;
            return;
        }
        const readOnly = (state.dirCaches ?? []).filter((rec) => rec.writable === false).length;
        const fitMs = (state.dirCaches ?? []).reduce((sum, rec) => sum
            + (rec.data ? recordedFitMs(rec.data) : rec.recordedFitMs ?? 0), 0);
        const bytes = totals.blobBytes + totals.indexBytes;
        state.status.textContent = `Cache measured: ${totals.blobs.toLocaleString()} fitted unit(s), ${formatBytes(bytes)}.`;
        const message = `This deletes the cache from ${dirs.size} folder(s):\n\n`
            + `    ${totals.blobs.toLocaleString()} fitted unit(s), ${formatBytes(totals.blobBytes)}\n`
            + `    ${totals.indexFiles} index file(s) with the remembered rows, ${formatBytes(totals.indexBytes)}\n\n`
            + (fitMs > 0 ? `The fits they hold took ${describeDuration(fitMs)} to compute. ` : "")
            + `The next run over these folders fits every file from scratch. `
            + `The scenario files and any screenshots are not touched.`
            + (readOnly ? `\n\n${readOnly} folder(s) were opened read-only and will be skipped; `
                + `reopen them with Folder (Caching) to flush them.` : "");
        const ok = await showConfirm(message, {
            title: "Flush the cache?", yesLabel: "Flush the cache", noLabel: "Keep the cache",
            typeToConfirm: "Flush",
        });
        if (!ok) {
            state.status.textContent = "The cache was kept.";
            return;
        }
        for (const rec of state.dirCaches ?? []) {
            // Index writes are batched, so one may still be pending. Drop it: written
            // after the delete below, it would put back the index this just removed.
            // Only now, once the answer is yes: a kept cache keeps its pending writes.
            if (rec.flushTimer) { clearTimeout(rec.flushTimer); rec.flushTimer = null; }
            rec.pendingChanges = 0;
        }
        let removed = 0, denied = 0;
        for (const [, handle] of dirs) {
            try { await handle.removeEntry(CACHE_FILENAME); removed++; }
            catch (e) {
                // NotFound = nothing to flush there; NotAllowed = read-only grant.
                if (e?.name === "NotAllowedError" || e?.name === "SecurityError") denied++;
            }
            // The analyses the index pointed at. Removed even when the index was
            // already gone, or a flushed folder would keep the bulk of its cache on
            // disk with nothing left that could ever read it.
            try { await handle.removeEntry(CACHE_BLOB_DIR, {recursive: true}); }
            catch (e) { /* absent, or the same read-only grant counted above */ }
        }
        state.dirCaches = [];
        state.status.textContent = `Flushed ${removed} cache file(s) and ${formatBytes(bytes)} from ${dirs.size} `
            + `folder(s). The next run will analyse every file from scratch.`
            + (denied ? ` ${denied} folder(s) were opened read-only — reopen with `
                + `Folder (Caching) to delete their caches.` : "");
    } finally {
        state.flushing = false;
        refreshControls(state);
    }
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
export function collectFsEntry(fsEntry, basePath, out, recursive, depth = 0, onSkip = null) {
    return new Promise((resolve) => {
        const rel = basePath ? `${basePath}/${fsEntry.name}` : fsEntry.name;
        if (fsEntry.isFile) {
            if (isCollectable(fsEntry.name)) {
                out.push({name: fsEntry.name, relativePath: rel, getFile: () => fsEntryToFile(fsEntry)});
            }
            resolve();
        } else if (fsEntry.isDirectory && (recursive || depth === 0)) {
            if (fsEntry.name === CACHE_BLOB_DIR) { resolve(); return; }
            // Every child is read before any is followed, because whether a subfolder
            // is walked depends on which folders sit beside it (see
            // interchangeFoldersToSkip). A read error ends the listing; what was read
            // before it is still walked, as it always was.
            const reader = fsEntry.createReader();
            const children = [];
            const walkChildren = async () => {
                const skip = recursive
                    ? interchangeFoldersToSkip(children.filter((c) => c.isDirectory).map((c) => c.name))
                    : new Set();
                for (const child of children) {
                    if (child.isDirectory && skip.has(child.name)) {
                        onSkip?.(`${rel}/${child.name}`);
                        continue;
                    }
                    await collectFsEntry(child, rel, out, recursive, depth + 1, onSkip);
                }
                resolve();
            };
            const readBatch = () => reader.readEntries((batch) => {
                if (!batch.length) { walkChildren(); return; }
                children.push(...batch);
                readBatch();
            }, () => walkChildren());
            readBatch();
        } else {
            resolve();
        }
    });
}

// ---------------------------------------------------------------------------
// naming where the files came from
// ---------------------------------------------------------------------------
//
// A browser will not tell a page where a chosen folder is on disk. The File
// System Access API exposes only the handle's own NAME, deliberately: the full
// path is considered identifying, and there is no API that returns it. So this
// reports the best thing available and says which it is, rather than printing a
// folder name that looks like a path and is not one.
//
// Two cases do better:
//   * the desktop build, where a File carries a real absolute `path`;
//   * a drop, where webkitGetAsEntry gives a fullPath relative to the drop root,
//     which at least recovers the folders between the root and each file.

/** The folder part of a file path, with either separator. */
function parentPath(filePath) {
    const cut = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
    return cut > 0 ? filePath.slice(0, cut) : filePath;
}

/**
 * Describe the source of a set of entries.
 * @returns {Promise<{text: string, exact: boolean, title: string}>}
 */
export async function describeEntrySource(entries, {folderName = null} = {}) {
    const count = entries?.length ?? 0;
    if (!count) return {text: "No folder chosen", exact: false, title: ""};

    // The desktop build hands out real paths; a browser does not.
    let absolute = null;
    try {
        const first = entries[0];
        const file = await first.getFile();
        const real = typeof file?.path === "string" && file.path ? file.path : null;
        if (real) {
            const rel = String(first.relativePath ?? first.name ?? "");
            absolute = rel && real.endsWith(rel)
                ? real.slice(0, real.length - rel.length).replace(/[/\\]$/, "")
                : parentPath(real);
        }
    } catch (e) { /* no path available: fall through */ }

    if (absolute) {
        return {text: absolute, exact: true,
            title: `The folder these ${count} file(s) were read from.`};
    }

    // No real path, so show the most of one that IS knowable: the chosen folder's
    // own name, followed by the deepest folder every entry shares. Choosing
    // rock_v3 with Recursive on gives "rock_v3/batch_120sec/0.0deg/All", which
    // identifies the set; choosing the rung folder itself gives "0.0deg/All".
    const dirs = (entries ?? []).map((e) => {
        const parts = String(e.relativePath ?? e.name ?? "").split("/");
        parts.pop();                              // drop the file name
        return parts;
    });
    let common = dirs[0] ?? [];
    for (const parts of dirs) {
        let i = 0;
        while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
        common = common.slice(0, i);
    }
    const shown = [folderName, ...common].filter(Boolean).join("/");
    const text = shown ? `${shown}/  \u2014 chosen folder` : `${count} file(s), no folder`;
    return {
        text, exact: false,
        title: `The chosen folder and the deepest sub-folder all ${count} file(s) share.\n`
            + "This is not the full path: a browser will not tell a web page where on disk a "
            + "folder you picked actually is, only its own name. The desktop build shows the "
            + "real path, and so does a run started from the command line.",
    };
}

/** Put a source description under the dialog title. */
export function setDialogSource(state, description) {
    if (!state?.sourceLine || !description) return;
    state.sourceLine.textContent = description.text;
    state.sourceLine.title = description.title || description.text;
    state.sourceLine.style.color = description.exact ? "#3a6b3a" : "#52514e";
}

async function entriesFromDataTransfer(dataTransfer, recursive, {onSkip = null} = {}) {
    const out = [];
    const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
    const fsEntries = items
        .filter((it) => it.kind === "file" && typeof it.webkitGetAsEntry === "function")
        .map((it) => it.webkitGetAsEntry())
        .filter(Boolean);
    if (fsEntries.length) {
        // Dropping All, Input and Truth together is the same layout as dropping the
        // folder that holds them, so the same rule keeps All.
        const skip = interchangeFoldersToSkip(fsEntries.filter((fe) => fe.isDirectory).map((fe) => fe.name));
        for (const fe of fsEntries) {
            if (fe.isDirectory && skip.has(fe.name)) {
                onSkip?.(fe.name);
                continue;
            }
            await collectFsEntry(fe, "", out, recursive, 0, onSkip);
        }
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
// the same rule as the drop path above. Where a folder holds All, Input and Truth
// side by side, Input and Truth are left out (see interchangeFoldersToSkip) and
// `onSkip` is told the path of each one.
export async function walkDirectoryHandle(directoryHandle, {recursive, basePath = "", onFound = null, parentHandle = null,
    onSkip = null} = {}) {
    const files = [];
    if (directoryHandle.name === CACHE_BLOB_DIR) return files;
    // Every child is listed before any is followed, because whether a subfolder is
    // walked depends on which folders sit beside it.
    const children = [];
    for await (const child of directoryHandle.entries()) children.push(child);
    const skip = recursive
        ? interchangeFoldersToSkip(children.filter(([, handle]) => handle.kind === "directory").map(([name]) => name))
        : new Set();
    for (const [name, handle] of children) {
        const relativePath = basePath ? `${basePath}/${name}` : name;
        if (handle.kind === "file") {
            if (isCollectable(name)) {
                // The containing (leaf) directory handle travels with the
                // entry so the result cache can live beside the files. The
                // PARENT travels too, because there is no way up from a handle
                // and the scenario screenshots belong beside the All folder
                // rather than inside it.
                const entry = {name, relativePath, getFile: () => handle.getFile(),
                    dirHandle: directoryHandle, dirPath: basePath, parentHandle};
                files.push(entry);
                onFound?.(entry);
            }
        } else if (recursive && handle.kind === "directory") {
            // Fit blobs are generated output, never scenario inputs. A processed
            // folder can have hundreds of thousands of these file handles.
            if (name === CACHE_BLOB_DIR) continue;
            if (skip.has(name)) {
                onSkip?.(relativePath);
                continue;
            }
            files.push(...await walkDirectoryHandle(handle,
                {recursive, basePath: relativePath, onFound, parentHandle: directoryHandle, onSkip}));
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

    // Where the files came from, under the title. Long paths get an ellipsis at
    // the START, because the tail of a path is the part that identifies it.
    const sourceLine = document.createElement("div");
    sourceLine.style.cssText = "margin: 3px 0 0; color: #52514e; font-size: 12px; "
        + "font-family: ui-monospace, Menlo, Consolas, monospace; direction: rtl; text-align: left; "
        + "overflow: hidden; text-overflow: ellipsis; white-space: nowrap; unicode-bidi: plaintext;";
    sourceLine.textContent = "No folder chosen";

    const titleBlock = document.createElement("div");
    titleBlock.style.cssText = "min-width: 0; flex: 1 1 auto;";
    titleBlock.appendChild(title);
    titleBlock.appendChild(sourceLine);

    const header = document.createElement("div");
    header.style.cssText = "display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px;";
    header.appendChild(titleBlock);
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
    const screenshots = labelledCheckbox("Scenario screenshots",
        "Also save a picture of each scenario into a SitrecImage folder beside it, so the Track "
        + "Browser can show the real scene instead of a plotted plan view. Each file is imported "
        + "into the live 3D view, framed and captured, which REPLACES what is currently loaded in "
        + "Sitrec. An existing picture is kept unless it is older than its scenario file. Needs a "
        + "folder chosen with write access; about a second per file, on the main thread, so it "
        + "runs alongside the fits rather than instead of them.", false);
    const rebuildRows = labelledCheckbox("Rebuild rows",
        "Do not show a remembered row as it is: rebuild every row from the stored fits, which takes "
        + "a fraction of a second a file. The fits themselves are still reused. Use it after a change "
        + "to the candidates, the ranking or the verdict, which the cache cannot see.", false);
    const solversButton = makeButton("Solvers…", "#5c6bc0");

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
    const chartsButton = makeButton("Charts", "#5c6bc0",
        "Open the result charts for the rows in this table: accuracy against clip length and "
        + "pointing error, what the verdict concluded, and what ranking blind cost. Exports SVG "
        + "or a 300 dpi PNG for a paper.");

    for (const el of [recursive.label, families.label, mcSweep.label, screenshots.label, rebuildRows.label,
        anchorLabel, solversButton,
        chooseFolderReadButton, chooseFolderCacheButton, chooseFilesButton,
        cancelButton, clearButton,
        flushCacheButton, exportJsonButton, exportCsvButton, summaryButton, chartsButton]) {
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
        overlay, modal, dropHint, sourceLine,
        recursiveInput: recursive.input,
        familiesInput: families.input,
        mcSweepInput: mcSweep.input,
        screenshotsInput: screenshots.input,
        rebuildRowsInput: rebuildRows.input,
        anchorInput,
        // The solvers the next run uses: the last choice, remembered across sessions.
        solvers: loadStoredSolvers(),
        solversButton,
        chooseFolderReadButton, chooseFolderCacheButton, chooseFilesButton,
        cancelButton, clearButton,
        flushCacheButton,
        closeButton, exportJsonButton, exportCsvButton, summaryButton, chartsButton,
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
        scatterHighlightEntry: null,
    };
    // The table body draws only the rows in view, straight from state.entries. Every
    // result stays in state.entries, so exports, the summary and the charts see all of
    // them; only the page's copy of the table is limited to what can be seen.
    state.rowView = new WindowedTableBody({
        tbody, scroller: tableWrap, header: thead, columnCount: TABLE_COLUMNS.length,
        rowHeight: ROW_HEIGHT_PX, overscan: ROW_OVERSCAN,
        getCount: () => state.entries.length,
        getItem: (index) => state.entries[index],
        createRow: () => createTableRow(state),
        paintRow: (row, entry) => paintTableRow(state, row, entry),
    });
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

// ---------------------------------------------------------------------------
// The results table. The DATA is state.entries, every entry of the run; the PAGE
// holds only the rows in view (see WindowedTableBody). So nothing below writes to a
// cell when the data changes. It records the change on the entry and asks for that
// row to be drawn, which happens in the next batch and only if the row is in view:
// a file that finishes off screen costs the table nothing.
//
// This is what stopped a long run slowing down. A table with one row per file lays
// out every row whenever any cell changes: at 4,191 rows one status edit cost
// 380-480 ms of layout, and the page spent more than half its time on layout.
// ---------------------------------------------------------------------------

/**
 * Add an entry to the table's data. Its index is fixed here, together with the
 * push, so the two can never disagree.
 */
function addRow(state, entry) {
    entry.rowIndex = state.entries.length;
    entry.statusText = "Queued";
    entry.statusTitle = "";
    state.entries.push(entry);
    state.rowView?.countChanged();
    return entry;
}

/** Ask for an entry's row to be drawn again, in the next batch, if it is in view. */
function invalidateRow(state, entry) {
    if (Number.isInteger(entry?.rowIndex)) state.rowView?.invalidate(entry.rowIndex);
}

// Progress and state changes update the entry at once; the row follows in the
// next batch.
function setRowStatus(state, entry, text, tooltip = "") {
    entry.statusText = text;
    if (tooltip) entry.statusTitle = tooltip;
    invalidateRow(state, entry);
}

// A short-lived state the user has just caused: a gallery being rebuilt, a report
// being built, a window being opened. Kept on the entry rather than on the button,
// because by the time the work finishes that button may be showing another entry.
// Drawn at once rather than in the next batch, since it answers a click.
function setRowBusy(state, entry, key, value) {
    const busy = {...entry.busy};
    if (value) busy[key] = value;
    else delete busy[key];
    entry.busy = Object.keys(busy).length ? busy : null;
    if (Number.isInteger(entry.rowIndex)) state.rowView?.refreshRow(entry.rowIndex);
}

/**
 * One reusable row. It is built once and shows whichever entry scrolls into its
 * place, so nothing here may capture an entry; paintTableRow writes one in.
 */
function createTableRow(state) {
    const tr = document.createElement("tr");
    tr.style.height = `${ROW_HEIGHT_PX}px`;
    const cells = [];
    for (let i = 0; i < TABLE_COLUMNS.length; i++) {
        const td = document.createElement("td");
        // One line, always. Anything too long is clipped with an ellipsis and
        // carries its full text in the cell's title — a wrapped cell costs
        // every OTHER column in the row its height. No vertical padding either:
        // the row must be exactly ROW_HEIGHT_PX tall (see there). The rule under
        // the row is a shadow, not a border, because a collapsed border can add
        // to a row's height and a shadow cannot.
        td.style.cssText = `padding: 0 5px; height: ${ROW_HEIGHT_PX}px; vertical-align: middle; `
            + "white-space: nowrap; overflow: hidden; text-overflow: ellipsis; "
            + "box-shadow: inset 0 -1px 0 #eee;";
        cells.push(td);
        tr.appendChild(td);
    }
    // The filename OPENS the file, in a fresh Sitrec. A bulk row says a fit
    // landed 97% of range from truth and the immediate question is always
    // "let me look at it" — which meant finding the file on disk and dragging
    // it in by hand. See openInNewSitrec for why this cannot be a plain href.
    const link = document.createElement("a");
    link.href = "#";
    link.style.cssText = "color: #1565c0; text-decoration: none; cursor: pointer;";
    link.onmouseenter = () => { link.style.textDecoration = "underline"; };
    link.onmouseleave = () => { link.style.textDecoration = "none"; };
    const row = {tr, cells, link, item: null};
    // The entry is looked up when the link is clicked, since the row shows others.
    link.onclick = (ev) => {
        ev.preventDefault();
        if (row.item) openInNewSitrec(state, row.item);
    };
    cells[COL.file].appendChild(link);
    cells[COL.file].style.textAlign = "left";
    return row;
}

/**
 * Write one entry into a reused row. The row may have shown any other entry last,
 * so every property a branch below can set is cleared first: a color or a tooltip
 * left over from the previous entry would be read as belonging to this one.
 */
function paintTableRow(state, row, entry) {
    const {tr, cells: c, link} = row;
    tr.style.background = "";
    tr.style.outline = "";
    for (let i = 0; i < c.length; i++) {
        const td = c[i];
        if (i !== COL.file) td.textContent = "";
        td.title = "";
        td.style.color = "";
        td.style.fontWeight = "";
        td.style.fontStyle = "";
    }

    const r = entry.row;
    // WHICH END TO CLIP. A deep relative path is identified by its tail, so
    // clipping the front is right for `.../2026-run/sub/bot-0042.csv`. It is
    // exactly wrong for a flat folder of generated scenarios, whose names share
    // a long common SUFFIX — measured on a ten-file run, nine rows clipped to
    // the identical "…_wzero_white0p03deg_s901.all.csv" and the column carried
    // no information at all. So clip the end only when there is a directory to
    // identify the file by.
    c[COL.file].style.direction = entry.relativePath.includes("/") ? "rtl" : "ltr";
    // An answer-key sidecar carries the human-meaningful scenario name; show it in
    // place of the opaque filename, keeping the path in the tooltip. Challenge
    // files (no name) keep showing their path.
    link.textContent = entry.busy?.link ?? r?.displayName ?? entry.relativePath;
    c[COL.file].title = (r?.displayName ? `${r.displayName}\n` : "") + entry.relativePath
        + "\n\nClick to open this scenario in a new Sitrec window.";

    if (entry.filled && r) paintResultCells(state, entry, c, tr);

    c[COL.status].textContent = entry.statusText ?? "Queued";
    c[COL.status].title = entry.statusTitle ?? "";
    if (entry.rowError != null) {
        c[COL.verdict].textContent = entry.rowError;
        c[COL.verdict].title = entry.rowError;
        tr.style.background = "#fff5f5";
    }
    if (state.scatterHighlightEntry === entry) {
        tr.style.outline = "2px solid #1976d2";
        tr.style.outlineOffset = "-2px";
    }
}

// Shade a source-quality cell so a scan down the column shows where the data
// stops supporting the question, without needing to read the numbers.
const GRADE_COLOURS = {good: "#2e7d32", fair: "#f9a825", hard: "#ef6c00", weak: "#c62828"};

/**
 * A finished analysis has landed on this entry. Only the data changes here. The
 * row is drawn by paintResultCells, in the next batch, if it is in view.
 */
function fillRow(state, entry) {
    const r = entry.row;
    if (!r) return;
    entry.filled = true;
    entry.statusText = "done";
    entry.statusTitle = r.warnings.length ? r.warnings.join("\n") : "";
    invalidateRow(state, entry);

    // A completed row may extend the open column-scatter plot. Throttled: the plot
    // redraws every row, and this runs once per finished file.
    if (state.scatter?.x && state.scatter?.y) {
        state.scatterThrottle ??= makeThrottle(() => {
            if (state.scatter?.x && state.scatter?.y) updateScatterPlot(state);
        }, 1000);
        state.scatterThrottle();
    }
}

/**
 * Draw a finished analysis into a row's cells. Called only by paintTableRow, which
 * has already cleared the row and draws the file link, status and error itself.
 */
function paintResultCells(state, entry, c, tr) {
    const r = entry.row;
    const q = r.quality;
    const grade = sourceQualityGrade(q);

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

    // Actions: the full gallery, and the HTML report. Both need the in-memory
    // analysis. A cached row HAS one — the cache stores the fit and the run is
    // replayed around it — so these are live for cached rows too; they are
    // disabled only for a row that has no results at all, which now means an
    // error or a cancelled run. A button reads "\u2026" while the work it started is
    // under way; that state lives on the entry, not the button (see setRowBusy).
    const galleryButton = smallButton(entry.busy?.gallery ? "\u2026" : "Gallery", "#1976d2",
        BUTTON_TOOLTIPS["Gallery"]);
    galleryButton.onclick = async () => {
        // A released analysis is rebuilt first, which takes a moment; say so.
        const rebuilding = !entry.results;
        if (rebuilding) setRowBusy(state, entry, "gallery", true);
        try {
            showTraverseGallery(await ensureResults(state, entry));
        } catch (e) {
            showError("Could not open the gallery for this result: " + (e && e.message), e);
        } finally {
            if (rebuilding) setRowBusy(state, entry, "gallery", false);
        }
    };
    c[COL.actions].appendChild(galleryButton);
    const reportButton = smallButton(entry.busy?.report ? "\u2026" : "Report", "#455a64",
        BUTTON_TOOLTIPS["Report"]);
    reportButton.style.marginLeft = "3px";
    reportButton.onclick = () => openReport(state, entry);
    c[COL.actions].appendChild(reportButton);
    // Only a row with no finished analysis is disabled. A finished row whose full
    // analysis was released to save memory rebuilds it when either button is used.
    if (entry.status !== "done") {
        for (const b of [galleryButton, reportButton]) {
            setButtonDisabled(b, true);
            b.title = "This row has no finished analysis \u2014 the run errored or was "
                + "cancelled before it finished.";
        }
    } else {
        if (entry.busy?.gallery) setButtonDisabled(galleryButton, true);
        if (entry.busy?.report) setButtonDisabled(reportButton, true);
    }

    tr.style.background = grade.grade === "weak" ? "#fff5f5"
        : grade.grade === "hard" ? "#fffaf0" : "#f7fff7";
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
 * When NO candidate passed the consistency screen, the WEAK band travels
 * instead, named w_<key> — see the fallback below for why that is a fallback
 * and not an addition.
 *
 * The window is claimed synchronously, before the store write, for the same
 * reason openReport does it: window.open is only honoured while the click's
 * transient activation is live, and an await drops it.
 */
function openInNewSitrec(state, entry) {
    // The row's link may show another entry by the time the window opens, so
    // "opening…" is kept on the entry, not written into the link.
    setRowBusy(state, entry, "link", "opening…");
    openHandoffWindow({
        buildFiles: async () => {
            const file = await entry.getFile();
            const sidecars = await readEntrySidecars(entry);
            // Parsed leniently: a malformed sidecar must cost the notes,
            // never the file open.
            const parse = (text, what) => {
                if (!text) return null;
                try { return JSON.parse(text); }
                catch (e) { console.warn(`BotBench: could not parse the ${what}:`, e); return null; }
            };
            const notes = buildScenarioNotes(
                parse(sidecars.sidecarText, "scenario sidecar"),
                parse(sidecars.labelsText, "truth sidecar"),
                entry.relativePath);

            // The candidates need the full analysis. A released one is rebuilt;
            // a row that never finished opens without candidates, as before.
            let results = null;
            try { results = entry.status === "done" ? await ensureResults(state, entry) : null; }
            catch (e) { console.warn("BotBench: opening without candidates", entry.relativePath, e); }
            // IN THE RECEIVER'S FRAME, NOT THE SIDECAR'S. The new window dates
            // and places the scenario from the BOT defaults, because the sidecar
            // does not travel as a file; the candidates must use the same clock
            // and site or they land away from it — see botHandoffFrame, and the
            // scenario's own MSL conversion (consistentTrackCSVs) for why a
            // general ENU->ECEF->LLA is wrong on a BOT file.
            const frame = botHandoffFrame(results);
            const csvOpts = frame ? {toLLA: frame.toLLA, altitudeIsHAE: frame.altitudeIsHAE, startMs: frame.startMs} : null;

            // Consistent if there are any, weak in their place if there are
            // not — handoffCandidateCSVs owns that rule and the reasoning for
            // it. A bench row has ONE link, so it decides; the live gallery
            // offers the same choice as two buttons instead.
            const candidates = csvOpts ? handoffCandidateCSVs(results, csvOpts) : [];

            return {
                files: [file, ...candidates.map((c) =>
                    new File([c.text], `${c.name}.csv`, {type: "text/csv"}))],
                meta: {
                    source: "botbench", relativePath: entry.relativePath,
                    // The scenario CSV already carries the sensor and truth
                    // tracks, so unlike the gallery this sends no context
                    // tracks — adding them would import each one twice.
                    lookCameraFraming: lookCameraFraming(results, candidates),
                    // WHICH TRACKS ARE RECONSTRUCTIONS, stated rather than
                    // inferred. The receiver puts the camera on the SCENARIO's
                    // own sensor track, and the only thing separating that from
                    // a candidate is which file it came from — knowledge only
                    // this side has. Sending the exact names beats having the
                    // receiver sniff the c_/w_ prefixes, which would quietly
                    // capture any real track a user happened to name that way.
                    candidateTrackNames: candidates.map((c) => c.name),
                    // The camera belongs on the sensor, looking along the
                    // angles the sensor actually recorded — see
                    // applyHandoffCameraTrack for why arrival order cannot be
                    // trusted to arrange that.
                    cameraOnScenarioTrack: true,
                    // RAISE UNDERGROUND MARKERS ALONG THE SIGHTLINE, NOT UP.
                    //
                    // A bench run has no terrain: its ground is the flat sea
                    // level plane at `groundZ` (see the note where the FMV
                    // ingest sets it), so the underground screen that rejects
                    // candidates in a live analysis only ever tested them
                    // against sea level. Inland that is far below the real
                    // surface — about 1,860 m below it for a clip shot over
                    // Cheyenne — so candidates the bench accepted arrive here,
                    // where the terrain IS loaded, buried under it.
                    //
                    // Every one of them is a fit to recorded lines of sight, so
                    // the direction is measurement and the range is not: the
                    // honest way to lift them is along the sightline, which
                    // spends the correction on the unconstrained quantity and
                    // leaves each marker where the camera saw it. This is only
                    // a default — the Object menu's checkbox still decides.
                    forceAboveSurfaceAlongLOS: true,
                    notes: `${notes}\n\n${frame?.note ? `${frame.note}\n\n` : ""}${candidateNotes(candidates)}`,
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
        onDone: () => setRowBusy(state, entry, "link", null),
    });
}

function openReport(state, entry) {

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

    // The button shows "…" until the report is written. Kept on the entry, since
    // the button may be showing another entry by then (see setRowBusy).
    setRowBusy(state, entry, "report", true);
    // Yield once so the placeholder paints before the build locks the thread.
    setTimeout(async () => {
        try {
            // NOT cached on the entry. The report is ~10 MB of string per file,
            // and a bulk run holds every row for the lifetime of the dialog —
            // caching it turned "opened a few reports" into hundreds of
            // megabytes retained for no benefit, since the window keeps the
            // copy it was handed. Rebuilding costs a few seconds on the rare
            // second look.
            const html = (await ensureResults(state, entry)).buildHtml();
            w.document.open();
            w.document.write(html);
            w.document.close();
        } catch (e) {
            try { w.close(); } catch (_) { /* already gone */ }
            showError("Could not build the report: " + (e && e.message), e);
        } finally {
            setRowBusy(state, entry, "report", false);
        }
    }, 0);
}

// The file could not be analysed. Recorded on the entry; the row shows the message
// in its Verdict cell when it is drawn.
function setRowError(state, entry, message) {
    entry.rowError = message;
    entry.statusText = "error";
    entry.statusTitle = message;
    invalidateRow(state, entry);
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
        || !(state.entries.some((e) => e.dirHandle) || state.dirCaches?.length));
    setButtonDisabled(state.exportJsonButton, running || !has);
    setButtonDisabled(state.exportCsvButton, running || !has);
    setButtonDisabled(state.summaryButton, running || !has);
    setButtonDisabled(state.chartsButton, running
        || !state.entries.some((e) => e.status === "done"));
    state.recursiveInput.disabled = running;
    state.familiesInput.disabled = running;
    state.mcSweepInput.disabled = running;
    state.screenshotsInput.disabled = running;
    state.rebuildRowsInput.disabled = running;
    state.anchorInput.disabled = running;
    setButtonDisabled(state.solversButton, running);
    refreshSolversButton(state);
}

function clearResults(state) {
    if (state.running) return;
    state.entries = [];
    state.liveResults = [];
    state.heldFrames = 0;
    state.memoryNote = "";
    state.scatterHighlightEntry = null;
    state.rowView?.reset();
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
        // In candidate order, so two runs of one choice read as one option set.
        solvers: normalizeSolvers(state.solvers),
    };
}

// ---------------------------------------------------------------------------
// the solver choice
// ---------------------------------------------------------------------------

const SOLVERS_STORAGE_KEY = "botbench.solvers";

function loadStoredSolvers() {
    try {
        const raw = localStorage.getItem(SOLVERS_STORAGE_KEY);
        const ids = raw ? JSON.parse(raw) : null;
        return Array.isArray(ids) && ids.length ? normalizeSolvers(ids) : allSolverIds();
    } catch (e) {
        return allSolverIds();
    }
}

function storeSolvers(ids) {
    try { localStorage.setItem(SOLVERS_STORAGE_KEY, JSON.stringify(ids)); } catch (e) { /* private mode */ }
}

function refreshSolversButton(state) {
    state.solversButton.textContent = `Solvers: ${describeSolvers(state.solvers)}`;
}

/**
 * The solver choice, as a dialog over the window: one checkbox per solver, grouped
 * as the candidates are, with the last choice already ticked. Resolves to the
 * chosen ids, or null when the user backs out. With `fileCount` the confirm button
 * starts the run; without it the choice is kept for the next run.
 */
function chooseSolvers(state, {fileCount = 0} = {}) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 10002;
            display: flex; align-items: center; justify-content: center;
        `;
        const panel = document.createElement("div");
        panel.style.cssText = `
            background: #fff; color: #222; border-radius: 8px; padding: 16px 18px; width: min(680px, 94vw);
            max-height: 92vh; overflow: auto; box-shadow: 0 8px 40px rgba(0,0,0,0.4);
            font-family: Arial, sans-serif; font-size: 13px;
        `;
        const title = document.createElement("h3");
        title.textContent = fileCount ? `Solvers for this run of ${fileCount} file(s)` : "Solvers for the next run";
        title.style.cssText = "margin: 0 0 6px; color: #1976d2; font-size: 16px;";
        const note = document.createElement("p");
        note.style.cssText = "margin: 0 0 10px; color: #52514e; line-height: 1.45;";
        note.textContent = "Only the ticked solvers are fitted, and only their candidates are ranked, so the "
            + "top candidate and the verdict are those of this selection. Fits are stored per solver in the "
            + "folder: a later run with more solvers reuses these fits and fits only the missing ones, and a "
            + "run with fewer reads what it needs.";
        panel.append(title, note);

        const boxes = new Map();
        const chosen = new Set(normalizeSolvers(state.solvers));
        const groups = [...new Set(SOLVERS.map((s) => s.group))];
        const grid = document.createElement("div");
        grid.style.cssText = "display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 18px;";
        for (const group of groups) {
            const head = document.createElement("div");
            head.textContent = group;
            head.style.cssText = "grid-column: 1 / -1; margin: 8px 0 2px; font-weight: 700; color: #4a5b6b; "
                + "font-size: 11px; letter-spacing: .04em; text-transform: uppercase;";
            grid.appendChild(head);
            for (const solver of SOLVERS.filter((s) => s.group === group)) {
                const label = document.createElement("label");
                label.style.cssText = "display: flex; align-items: flex-start; gap: 6px; cursor: pointer; line-height: 1.35;";
                if (solver.note) label.title = solver.note;
                const box = document.createElement("input");
                box.type = "checkbox";
                box.checked = chosen.has(solver.id);
                box.style.marginTop = "2px";
                boxes.set(solver.id, box);
                label.append(box, document.createTextNode(solver.name));
                grid.appendChild(label);
            }
        }
        panel.appendChild(grid);

        const buttons = document.createElement("div");
        buttons.style.cssText = "display: flex; gap: 8px; align-items: center; margin-top: 14px; flex-wrap: wrap;";
        const allButton = makeButton("All", "#757575", "Tick every solver.");
        const noneButton = makeButton("None", "#757575", "Untick every solver.");
        const count = document.createElement("span");
        count.style.cssText = "color: #52514e; margin-left: auto;";
        const okButton = makeButton(fileCount ? "Run" : "Use these", "#1976d2");
        const cancelButton = makeButton("Cancel", "#757575");
        const refresh = () => {
            const n = [...boxes.values()].filter((b) => b.checked).length;
            count.textContent = `${n} of ${SOLVERS.length} selected`;
            setButtonDisabled(okButton, n === 0);
            okButton.textContent = fileCount ? `Run with ${n} solver(s)` : `Use ${n} solver(s)`;
        };
        for (const box of boxes.values()) box.addEventListener("change", refresh);
        allButton.addEventListener("click", () => { for (const b of boxes.values()) b.checked = true; refresh(); });
        noneButton.addEventListener("click", () => { for (const b of boxes.values()) b.checked = false; refresh(); });
        refresh();
        buttons.append(allButton, noneButton, count, okButton, cancelButton);
        panel.appendChild(buttons);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        const finish = (ids) => {
            if (overlay.parentNode) document.body.removeChild(overlay);
            if (ids) {
                state.solvers = ids;
                storeSolvers(ids);
                refreshSolversButton(state);
            }
            resolve(ids);
        };
        okButton.addEventListener("click", () => {
            const ids = normalizeSolvers([...boxes.entries()].filter(([, b]) => b.checked).map(([id]) => id));
            finish(ids);
        });
        cancelButton.addEventListener("click", () => finish(null));
        overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(null); });
    });
}

// A macrotask yield that background-tab throttling does not clamp (unlike
// setTimeout, which Chrome drops to ~1/minute in a hidden tab — that would drag
// a 30-file run out to hours). Same reasoning as AnalyzeTraverse's makeYield.
function makeYield() {
    if (typeof MessageChannel === "undefined") {
        return createBotBenchYield(() => new Promise((resolve) => setTimeout(resolve, 0)));
    }
    const channel = new MessageChannel();
    const pending = [];
    channel.port1.onmessage = () => pending.shift()?.();
    const yieldTask = createBotBenchYield(() => new Promise((resolve) => {
        pending.push(resolve); channel.port2.postMessage(0);
    }));
    yieldTask.dispose = () => { channel.port1.close(); channel.port2.close(); };
    return yieldTask;
}

export async function analyzeEntries(state, found, {askSolvers = false} = {}) {
    if (state.running) return;
    if (!found.length) {
        state.status.textContent = "No BOT interchange or FMV files found.";
        return;
    }
    // A run starts with the solver choice. The dialog remembers the last choice,
    // so the usual answer is one click; a caller that already knows what it wants
    // (the MCP API, a bulk script) skips it.
    if (askSolvers) {
        const chosen = await chooseSolvers(state, {fileCount: found.length});
        if (!chosen) {
            state.status.textContent = `Run not started. ${found.length} file(s) found.`;
            return;
        }
    }
    state.running = true;
    state.cancelled = false;
    refreshControls(state);

    const options = runOptions(state);
    const plan = planUnits(options.solvers, options);
    const key = selectionKey(options.solvers, options);
    // A remembered row is shown as it is by default; this rebuilds every row from
    // the stored fits instead, which is the cheap way to be sure of them.
    const forceRows = state.rebuildRowsInput.checked;
    // Deliberately NOT part of runOptions: those options are hashed into the cache
    // key, and whether a picture was taken has no bearing on the numbers. A run
    // with screenshots on must still hit the cache written by a run with them off.
    const wantShots = state.screenshotsInput.checked;
    const shotStats = {written: 0, skipped: 0, failed: 0};
    // The queue is held on the state so Cancel Run can stop it: captures are queued
    // as each analysis finishes, so a cancelled run can otherwise have hundreds
    // still to go, at about a second each.
    //
    // drainingShots says who owns the status line. It is NOT state.running, which
    // stays true until the finally block — that is AFTER the drain, so guarding on
    // it froze the count at whatever it read when the drain began.
    let drainingShots = false;
    const shotQueue = createCaptureQueue({
        onProgress: (q) => {
            if (drainingShots) {
                state.progress.value = q.total ? q.done / q.total : 1;
                state.status.textContent = `Finishing scenario screenshots… ${q.done} of ${q.total}`
                    + (q.current ? ` — ${q.current}` : "");
            } else {
                updateProgress();       // the fits still own the line; fold the backlog in
            }
        },
    });
    state.shotQueue = shotQueue;
    const yieldToDOM = makeYield();

    const concurrency = typeof Worker === "undefined" ? 1 : botBenchConcurrency(found.length);
    const pool = new BotBenchAnalysisPool(concurrency);
    state.workerPool = pool;
    const remainingByDirectory = new Map();
    for (const source of found) {
        if (source.dirHandle) remainingByDirectory.set(source.dirHandle,
            (remainingByDirectory.get(source.dirHandle) ?? 0) + 1);
    }
    let completed = 0;
    const fractions = new Float64Array(found.length);
    // A running sum, not a reduce over every file: the progress callback fires many
    // times per file, and summing 37,800 fractions on each call was steady main-thread
    // load from the very first file.
    let fractionSum = 0;
    const setFraction = (i, f) => { fractionSum += f - fractions[i]; fractions[i] = f; };
    // Throttled: it runs on every progress tick of every worker, and a DOM write per
    // tick is work no reader can see.
    const updateProgress = makeThrottle(() => {
        // A trailing throttled call can land after the run has ended, and would
        // overwrite the final "Done" or "Cancelled" line with a stale count.
        if (!state.running) return;
        state.progress.value = fractionSum / found.length;
        // The captures run one at a time beside the fits and are much slower, so
        // their backlog is worth showing rather than appearing as a wait at the end.
        const shots = wantShots && shotQueue.total
            ? `, screenshots ${shotQueue.done} of ${shotQueue.total}` : "";
        state.status.textContent = `Analysing ${completed} of ${found.length} complete`
            + (pool.workers?.slots.length && !pool.workers.closed ? ` (${pool.workers.slots.length} workers)` : "")
            + `, ${describeSolvers(options.solvers)}` + shots + (state.memoryNote ?? "");
    }, 250);
    // The summary tiles take medians over EVERY finished row, so recomputing them
    // after each file made each file cost more than the last. Once a second is plenty,
    // and the run ends with a full recompute.
    const updateSummaryThrottled = makeThrottle(() => updateSummary(state), 1000);

    // Before anything else: is this whole run about to re-fit units that are stale
    // only because the build changed? Worth ten real fits to find out — per unit.
    let adoptUnits = new Set();
    let adoptRows = false;
    let adoptNote = "";
    if (found.length > CACHE_ADOPT_MIN_FILES) {
        try {
            state.status.textContent = "Checking the cache…";
            await yieldToDOM();
            const stale = await findVersionStaleEntries(state, found, options, plan);
            if (stale.length >= CACHE_ADOPT_SAMPLE) {
                const first = stale[0];
                const fitted = first.appVersion ?? "an earlier build";
                state.status.textContent = `Fits stored by ${fitted}: fitting `
                    + `${CACHE_ADOPT_SAMPLE} of ${stale.length} files to see which units still hold…`;
                await yieldToDOM();
                const probe = await probeCacheAdoption(state, stale, options, plan, key, pool, {
                    onProgress: (r) => {
                        state.progress.value = r.checked / CACHE_ADOPT_SAMPLE;
                        const held = plan.filter((u) => r.units[u].checked && r.units[u].matched === r.units[u].checked).length;
                        state.status.textContent = `Checking the cache: ${r.checked} of `
                            + `${CACHE_ADOPT_SAMPLE} fitted, ${held} of ${plan.length} units reproduced so far…`;
                    },
                });
                state.progress.value = 0;
                if (!state.cancelled && probe.checked > 0) {
                    const verdict = describeAdoptionProbe(probe, plan);
                    if (verdict.adoptUnits.size) {
                        const ok = await showConfirm(
                            `${stale.length} of the ${found.length} files have fits stored by ${fitted}, `
                            + `which this build (${APP_VERSION}) would otherwise fit again.\n\n`
                            + `${probe.checked} of them were just fitted for real and compared with the store, `
                            + `one fit unit at a time.\n\n`
                            + `Reproduced exactly, so reused as they are: ${verdict.reuse.join(", ")}.\n`
                            + (verdict.refit.length
                                ? `Differ under this build, so fitted again for every file: ${verdict.refit.join(", ")}.\n` : "")
                            + (verdict.unseen.length
                                ? `Not stored for the sampled files, so fitted where missing: ${verdict.unseen.join(", ")}.\n` : "")
                            + `${verdict.rows}\n\n`
                            + `Reuse the units that reproduced? Every candidate, verdict and row is still built `
                            + `by today's code from them. The records are stamped with this build and marked as `
                            + `adopted, so they never read as a fresh run.`,
                            {title: "Reuse fits from an earlier build?",
                                yesLabel: `Reuse ${verdict.reuse.length} unit(s)`, noLabel: "Fit everything again"});
                        if (ok) {
                            adoptUnits = verdict.adoptUnits;
                            adoptRows = verdict.adoptRows;
                            adoptNote = ` Reused ${verdict.reuse.length} of ${plan.length} fit unit(s) from ${fitted} `
                                + `after checking ${probe.checked} file(s)`
                                + (verdict.refit.length ? `; ${verdict.refit.length} unit(s) differed and were fitted again` : "")
                                + ".";
                        }
                    } else {
                        console.log("BotBench: not offering cache adoption; no unit reproduced on every sampled file:",
                            probe.units);
                    }
                }
            }
        } catch (probeError) {
            console.warn("BotBench cache probe failed; fitting normally.", probeError);
        }
    }

    try {
        await runBotBenchQueue(found, concurrency, async (source, i) => {
            // The options this file was actually run under, frozen per entry. The
            // dialog's controls stay live between batches, so a run at one anchor
            // followed by a run at another used to have BOTH batches labelled with
            // whatever the controls read at export time — making a deliberately
            // mixed comparison look uniform, which is the one thing it must not do.
            const entry = {...source, key: state.nextRowId++, status: "queued", row: null,
                results: null, options: {...options, solvers: options.solvers.slice()}};
            addRow(state, entry);
            updateProgress();
            await yieldToDOM();

            let dirCache = null;
            try {
                setRowStatus(state, entry, "hashing");
                const hashes = await entryFileHashes(entry);
                // Cache lookup, best-effort: an unreadable cache file falls through to
                // a normal run rather than an error row.
                try { dirCache = await loadDirCache(state, entry); }
                catch (cacheError) { console.warn("BotBench cache lookup failed for", entry.relativePath, cacheError); }
                setRowStatus(state, entry, "reading");
                await yieldToDOM();
                const out = await analyseEntryWithCache(entry, {
                    options, plan, key, pool, dirCache, hashes, adoptUnits, adoptRows, forceRows,
                    needResults: false,
                    onStatus: (text, tooltip) => setRowStatus(state, entry, text, tooltip),
                    onProgress: (frac, label) => {
                        setRowStatus(state, entry, `${Math.round(frac * 100)}%`, label);
                        setFraction(i, frac);
                        updateProgress();
                    },
                    isCancelled: () => state.cancelled, yieldToDOM,
                });
                if (state.cancelled) throw new Error("cancelled");
                entry.row = out.row;
                entry.apertureDeg = out.chartData?.apertureDeg ?? null;
                entry.candidateErrors = out.chartData?.candidateErrors ?? null;
                entry.sensorTurnDeg = out.chartData?.sensorTurnDeg ?? null;
                entry.rowReused = out.rowReused;
                entry.fromCache = out.rowReused || out.unitsUsed > 0;
                entry.cacheAdopted = out.adopted;
                entry.cacheAdoptedFrom = out.adoptedFrom;
                entry.status = "done";
                fillRow(state, entry);
                const fittedCount = out.fitted?.length ?? 0;
                if (out.rowReused) {
                    setRowStatus(state, entry, out.adopted ? "adopted" : "cached",
                        `Remembered row from ${CACHE_FILENAME} for this solver selection`
                        + (out.adopted ? `, built by ${out.adoptedFrom} and adopted after a sample of `
                            + `rebuilt rows reproduced it exactly.\n` : `, built by this build.\n`)
                        + `Input hashes, analysis options and unit versions all match. The full analysis `
                        + `is rebuilt from the stored fits when Gallery, Report or Open in Sitrec needs it.`);
                } else if (fittedCount === 0) {
                    setRowStatus(state, entry, "rebuilt",
                        `Every fit unit this row needs was read from ${CACHE_FILENAME} (${out.unitsUsed} unit(s)); `
                        + `the candidates, verdict and row were built from them by this build.`);
                } else if (out.unitsUsed) {
                    setRowStatus(state, entry, "partly cached",
                        `${out.unitsUsed} fit unit(s) read from ${CACHE_FILENAME}; ${fittedCount} fitted now `
                        + `(${out.fitted.join(", ")}). The row was built from all of them by this build.`);
                } else {
                    setRowStatus(state, entry, "done", `Every fit unit was fitted in this run (${out.fitted.join(", ")}).`);
                }
            } catch (error) {
                if (state.cancelled) {
                    entry.status = "cancelled";
                    setRowStatus(state, entry, "cancelled");
                    return;
                }
                entry.status = "error";
                entry.error = error?.message || String(error);
                setRowError(state, entry, entry.error);
            } finally {
                if (source.dirHandle) {
                    const remaining = remainingByDirectory.get(source.dirHandle) - 1;
                    remainingByDirectory.set(source.dirHandle, remaining);
                    if (remaining === 0) await releaseDirCache(dirCache);
                }
            }
            // KEEP THE ROW, RELEASE THE ANALYSIS. The chart facts are the only things
            // the charts need from the full analysis, so they are taken now, while
            // the positions exist.
            if (entry.status === "done") {
                captureChartData(entry);
                holdResults(state, entry);
            }

            // The picture, once the numbers are in and whether they came from the
            // cache or from a fresh fit. Queued rather than awaited: captures run
            // one at a time because they drive the single live 3D view, while the
            // fits carry on in their workers.
            if (wantShots && entry.status === "done" && entry.dirHandle) {
                shotQueue.add(entry.name, async () => {
                    try {
                        const shot = await captureEntryImage(entry);
                        if (shot.written) shotStats.written++; else shotStats.skipped++;
                        entry.screenshot = shot;
                    } catch (shotError) {
                        shotStats.failed++;
                        entry.screenshot = {written: false, reason: String(shotError?.message ?? shotError)};
                        console.warn("BotBench screenshot failed for", entry.relativePath, shotError);
                    }
                });
            }

            setFraction(i, 1);
            completed++;
            updateProgress();
            updateSummaryThrottled();
            await yieldToDOM();
        }, () => state.cancelled);
        // The fits finish first; the captures are one-at-a-time on the main thread
        // and are normally still going. Drain them before the run calls itself done,
        // so the status line's count is the real one.
        if (wantShots) {
            if (state.cancelled) {
                shotQueue.cancel();
            } else if (shotQueue.remaining || shotQueue.running) {
                drainingShots = true;
                state.status.textContent = `Finishing scenario screenshots… `
                    + `${shotQueue.done} of ${shotQueue.total}`;
                await yieldToDOM();
                await shotQueue.idle();
                drainingShots = false;
            }
        }
    } finally {
        updateProgress.cancel();
        updateSummaryThrottled.cancel();
        // The cache indexes are written in batches during a run; write what is left,
        // on a cancel too, since every file finished so far has its fits on disk.
        await flushAllDirCaches(state);
        for (const rec of state.dirCaches ?? []) await releaseDirCache(rec);
        pool?.dispose();
        state.workerPool = null;
        yieldToDOM.dispose?.();
        state.running = false;
        refreshControls(state);
    }

    state.progress.value = state.cancelled ? state.progress.value : 1;
    const done = state.entries.filter((e) => e.status === "done").length;

    const shotNote = wantShots
        ? ` Screenshots: ${shotStats.written} written, ${shotStats.skipped} already current`
          + (shotStats.failed ? `, ${shotStats.failed} failed` : "")
          + (shotQueue.skipped ? `, ${shotQueue.skipped} skipped on cancel` : "") + "."
        : "";
    state.shotQueue = null;
    state.status.textContent = (state.cancelled
        ? `Cancelled. ${done} result(s) in the table.`
        : `Done. ${done} result(s) in the table, ${describeSolvers(options.solvers)}.`)
        + adoptNote + shotNote + (state.memoryNote ?? "");
    state.running = false;
    refreshControls(state);
    updateSummary(state);
    state.scatterThrottle?.flush();
}

/**
 * Say on the line under the title that Input and Truth copies were left out, so a
 * run over an interchange tree is not read as one that lost half its files. The
 * tooltip says why, and lists the folders.
 */
function noteSkippedCopies(description, skippedFolders) {
    if (!description || !skippedFolders?.length) return description;
    const parents = new Set(skippedFolders.map((p) => (p.includes("/") ? p.replace(/\/[^/]*$/, "") : "")));
    const listed = skippedFolders.slice(0, 20).join("\n")
        + (skippedFolders.length > 20 ? `\n… and ${skippedFolders.length - 20} more` : "");
    const note = `${parents.size} folder(s) hold All, Input and Truth side by side. Only All was read there: `
        + "it carries every scenario once, with its truth, while Input repeats the same tracks without "
        + `truth and Truth holds only the answer key. Left out:\n${listed}`;
    return {
        ...description,
        text: `${description.text}  ·  All tracks only`,
        title: [description.title, note].filter(Boolean).join("\n\n"),
    };
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
    const skippedFolders = [];
    try {
        const raw = await walkDirectoryHandle(directoryHandle, {
            recursive: state.recursiveInput.checked,
            onFound: () => { state.status.textContent = `Found ${++count} file(s)...`; },
            onSkip: (path) => skippedFolders.push(path),
        });
        for (const e of raw) e.cacheWritable = (mode === "readwrite");
        found = await pairSidecars(raw);
        setDialogSource(state, noteSkippedCopies(
            await describeEntrySource(found, {folderName: directoryHandle?.name}), skippedFolders));
    } catch (error) {
        state.status.textContent = error.message || String(error);
        return;
    }
    await analyzeEntries(state, found, {askSolvers: true});
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
    setDialogSource(state, await describeEntrySource(found));
    await analyzeEntries(state, found, {askSolvers: true});
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
        const skippedFolders = [];
        try {
            found = await entriesFromDataTransfer(e.dataTransfer, state.recursiveInput.checked,
                {onSkip: (path) => skippedFolders.push(path)});
            setDialogSource(state, noteSkippedCopies(await describeEntrySource(found), skippedFolders));
        } catch (error) {
            showError(error);
            return;
        }
        if (!found.length) {
            state.status.textContent = "No BOT interchange or FMV files in the drop.";
            return;
        }
        await analyzeEntries(state, found, {askSolvers: true});
    });
}

/**
 * Open BOTBench and immediately analyse a caller-supplied list of files.
 *
 * The dialog's own entry points all start from a picker (a folder, or a hand-
 * picked set). This is the same road from further along: a caller that has
 * ALREADY chosen the files — the Track Browser's "Open in BOTBench" — hands them
 * straight over, and they go through pairSidecars and analyzeEntries exactly as a
 * folder scan's would, so a run started this way is indistinguishable from one
 * started here.
 *
 * `entries` are {name, relativePath, getFile} records; sidecars must be present
 * in the list for pairSidecars to find them, which is why the caller passes its
 * whole walk rather than just the files it wants rows for.
 *
 * @returns {Promise<number>} how many files were actually queued
 */
export async function openBotBenchWithEntries(entries) {
    openBotBenchDialog();
    const state = activeDialog;
    if (!state) return 0;
    state.status.textContent = "Reading selected files...";
    const found = await pairSidecars(Array.from(entries ?? [])
        .filter((e) => isExplicitlyCollectable(e.name)), {explicit: true});
    if (!found.length) {
        state.status.textContent = "None of the selected files are ones BOTBench can analyse "
            + "(BOT interchange CSV, FMV .ts/.klv, a track CSV or .srt with camera pointing, "
            + "or a STANAG 4676 .xml).";
        return 0;
    }
    await analyzeEntries(state, found, {askSolvers: true});
    return found.length;
}

export function openBotBenchDialog() {
    const state = createDialog();

    state.closeButton.onclick = () => {
        state.cancelled = true;
        state.workerPool?.dispose();
        state.shotQueue?.cancel();
        state.rowView?.dispose();
        releaseAnalysisPauseLock(state);
        disposeScatterView(state);
        if (state.overlay.parentNode) document.body.removeChild(state.overlay);
        if (activeDialog === state) activeDialog = null;
    };
    state.cancelButton.onclick = () => {
        state.cancelled = true;
        state.workerPool?.dispose();
        // Without this the run still waits for every queued screenshot, which is
        // about a second each and looks like a hang.
        state.shotQueue?.cancel();
        state.status.textContent = "Cancelling active analyses...";
        setButtonDisabled(state.cancelButton, true);
    };
    state.clearButton.onclick = () => clearResults(state);
    state.solversButton.onclick = () => { if (!state.running) chooseSolvers(state); };
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
    state.chartsButton.onclick = () => openResultChartsForEntries(state.entries);
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
            run: (state, entries, opts) => analyzeEntries(state, entries, opts),
            // The solver choice: every id, the current choice, and a setter that the
            // next run reads (the interactive run starts with the dialog instead).
            solverIds: allSolverIds, SOLVERS,
            setSolvers: (state, ids) => { state.solvers = normalizeSolvers(ids); storeSolvers(state.solvers); refreshSolversButton(state); },
            pairSidecars, ingestBotBenchEntry, runBotBenchAnalysis,
            createAnalysisPool: (size) => new BotBenchAnalysisPool(size),
            // The two ingest internals worth exercising directly: a timebase
            // choice and a continuity decision are hard to provoke through a
            // real file and trivial to provoke through a synthetic one.
            ingestMISBRecords, longestUniformRun, measureAnchorRate,
            buildSummaryReport, resultsToCsv,
            // The cache codec, so the fit-reuse round trip can be exercised
            // without a directory picker (which needs a user gesture).
            packForCache, unpackFromCache,
            describeEntrySource, setDialogSource,
            // The walk a picked folder goes through, so the All/Input/Truth rule can be
            // checked on a folder built in the browser's private storage.
            walkDirectoryHandle, noteSkippedCopies, interchangeFoldersToSkip,
            // The results table's data functions, so the windowed table can be
            // checked at thousands of rows without analysing thousands of files.
            rows: {add: addRow, fill: fillRow, setStatus: setRowStatus, setError: setRowError,
                highlight: highlightScatterRow},
            get state() { return activeDialog; },
        };
    }
    // Scenario screenshots: import each All CSV, let the app frame it, and read
    // the main view back as an image. Separate global from _botBench because it
    // drives the LIVE scene rather than the worker pool, so the two must not run
    // at the same time.
    if (isLocal && !window._botImages) {
        window._botImages = {
            run: runImageCapture, capture: captureScenarioImage,
            captureView: captureViewBlob, waitForSettle, clearTracks: clearImportedTracks,
            captureEntry: captureEntryImage, queueIdle: captureQueueIdle, createQueue: createCaptureQueue,
            imageDirFor, imageNameFor, imageStaleness,
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
