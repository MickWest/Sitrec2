import {saveAs} from "file-saver";
import {guiMenus, setRenderOne} from "../Globals";
import {
    isAbortLikeError,
    showLocalFolderAccessUnsupportedMessage,
    supportsDirectoryPicker
} from "../CFileManagerUtils";
import {showError} from "../showError";
import {showTimingAnalysis} from "../showTimingAnalysis";
import {analyzeVideoFileLike, isVideoAnalysisCandidateName} from "./AnalyzeVideoFile";
import {addBotBenchMenu} from "./BotBenchUI";
import {par} from "../par";

let activeDialog = null;
let fileAnalysisFolder = null;

const BUTTON_TOOLTIPS = {
    "Close": "Close this analysis window and restore the previous Sitrec playback state.",
    "Choose Folder": "Pick a folder of video files to scan. Results are added to the table.",
    "Choose File": "Pick a single video/KLV file to analyze. Its result is added to the table.",
    "Cancel Scan": "Stop the current scan after the current file finishes.",
    "Clear Results": "Remove every result from the table and start fresh.",
    "Export JSON": "Save a compact machine-readable summary of all results.",
    "Export CSV": "Save one summary row per file for spreadsheet analysis.",
    "Export Reports": "Save detailed text timing reports for files that decoded MISB metadata.",
    "Summary Report": "Open a combined overview report: overall stats, analysis, and the video table.",
    "View": "Open the detailed text timing report for this file.",
    "Export": "Save a per-frame CSV (virtual frames, gap-fill flag, and all populated MISB columns) for this file.",
};

const SUMMARY_TOOLTIPS = {
    "Candidates": "How many files have been added to the table.",
    "Analyzed": "How many files have finished processing.",
    "MISB": "How many files decoded at least one MISB ST 0601 metadata stream.",
    "PES PTS Files": "How many files have enough KLV PES-header PTS data to use synchronous PTS pairing.",
    "PES PTS Records": "The percentage of all decoded MISB records that have KLV PES-header PTS values.",
    "Warnings": "How many analyzed files have timing warnings.",
    "Errors": "How many files could not be analyzed because of an error.",
    "Gaps": "How many files have detected gaps in their MISB UnixTimeStamp timing.",
    "No MISB": "How many files were scanned but did not decode MISB ST 0601 metadata.",
    "Unsupported": "How many files use containers this tool does not scan yet.",
};

const TABLE_HEADER_TOOLTIPS = {
    "File": "The file's path relative to the chosen folder (or just the file name for single-file analysis).",
    "Status": "The analysis state for this file: progress text while scanning, then the final state (analyzed, error, unsupported, no MISB, etc.).",
    "Verdict": "A short plain-English summary of the file's timing health. On error, shows the error message instead.",
    "Records": "The number of decoded MISB ST 0601 metadata records (KLV packets) found in the file.",
    "PES PTS Rec": "The percentage of MISB records that carry a PTS (Presentation Time Stamp) in their KLV PES header. PES-header PTS allows precise, synchronous pairing of metadata to video frames; without it, pairing falls back to looser methods.",
    "Frame Pair": "The percentage of video PTS rows (frames) that can be matched to a nearby KLV PES PTS record. High coverage means nearly every frame has directly paired metadata.",
    "KLV Span": "The elapsed time (seconds) covered by the KLV UnixTimeStamp metadata (MISB Tag 2), from the first to last timestamp in the metadata stream.",
    "Gaps": "The number of large discontinuities detected in the KLV UnixTimeStamp sequence — places where metadata timing jumps instead of advancing smoothly.",
    "CV": "Coefficient of variation (as a %) of the intervals between consecutive KLV UnixTimeStamps. Near 0% means metronome-regular metadata; higher values mean scattered/jittery timing.",
    "Video PTS": "The count of video presentation timestamps found in the transport stream — effectively the number of video frame timing entries.",
    "Diff": "KLV span minus video PTS span, in seconds. Near zero means metadata and video cover the same duration; a large value means one stream runs longer than the other (a timing red flag).",
    "Frames": "Export a per-frame CSV for this file: virtual frame timing fields plus every populated MISB tag column.",
    "Report": "Open the detailed text timing report for this file.",
};

const TABLE_HEADERS = [
    ["File", "20%"],
    ["Status", "6%"],
    ["Verdict", "18%"],
    ["Records", "6%"],
    ["PES PTS Rec", "6%"],
    ["Frame Pair", "6%"],
    ["KLV Span", "6%"],
    ["Gaps", "4%"],
    ["CV", "5%"],
    ["Video PTS", "6%"],
    ["Diff", "5%"],
    ["Frames", "6%"],
    ["Report", "6%"],
];

const FRAME_TIMING_COLUMNS = [
    "frame", "isDuplicate", "sourceFrame", "virtualTimeS", "virtualPtsUs",
    "sourcePtsUs", "pairingMode", "klvRecordIndex", "klvPesPtsUs", "klvUtsUs", "klvDeltaUs",
];

function fmtSeconds(value) {
    return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "";
}

function fmtPct(value) {
    return typeof value === "number" && Number.isFinite(value) ? (value * 100).toFixed(2) : "";
}

function fmtBytes(bytes) {
    if (!(bytes > 0)) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function csvEscape(value) {
    if (value === null || value === undefined) return "";
    const text = String(value);
    if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function resultsToCsv(results) {
    const columns = [
        "path", "status", "severity", "verdict", "container", "sizeBytes",
        "recordCount", "ptsAvailable", "fullRecordPts", "ptsRecordCount",
        "ptsRecordCoverage", "ptsFramePairCount", "ptsFrameCoverage", "exactFrameCoverage",
        "ptsPairToleranceUs", "ptsMeanAbsDeltaUs", "ptsMaxDeltaUs",
        "klvUtsSpanS", "klvUtsMeanIntervalS", "klvUtsCv", "klvUtsGapCount", "klvUtsMaxGapS",
        "klvPesSpanS", "klvPesGapCount", "videoPtsCount", "videoPtsSpanS", "videoPtsCv",
        "spanDiffS", "pcrFps", "realFps", "flags", "message",
    ];
    const lines = [columns.join(",")];
    for (const result of results) {
        const row = {
            path: result.file?.relativePath || result.file?.name || "",
            status: result.status,
            severity: result.summary?.severity,
            verdict: result.summary?.verdict,
            container: result.container,
            sizeBytes: result.file?.size,
            ...(result.summary || {}),
            message: result.message,
        };
        lines.push(columns.map(column => csvEscape(row[column])).join(","));
    }
    return lines.join("\n");
}

// Per-frame CSV for one file. Columns = fixed timing fields + this file's
// populated MISB tag names (result.frameMisbColumns). Requires the result to
// have been produced with {includeFrameRows: true}.
function frameRowsToCsv(result) {
    const misbCols = result.frameMisbColumns || [];
    const header = [...FRAME_TIMING_COLUMNS, ...misbCols];
    const lines = [header.join(",")];
    for (const row of result.frameRows || []) {
        const base = FRAME_TIMING_COLUMNS.map(c => csvEscape(row[c]));
        const misb = misbCols.map(name => csvEscape(row.misb?.[name]));
        lines.push([...base, ...misb].join(","));
    }
    return lines.join("\n");
}

function allReportsText(results) {
    const reports = [];
    for (const result of results) {
        if (!result.report) continue;
        reports.push(result.report);
    }
    return reports.join("\n\n");
}

function stripForJson(result) {
    const copy = {...result};
    delete copy.frameRows;
    delete copy.__entry;
    return copy;
}

// ---- Summary Report (overall stats + plain analysis + video table) ----

function padCell(value, width, right = false) {
    let s = String(value ?? "");
    if (s.length > width) s = s.slice(0, Math.max(1, width - 1)) + "…";
    return right ? s.padStart(width) : s.padEnd(width);
}

function summaryTableText(results) {
    const cols = [
        {h: "File", w: 34, get: r => r.file?.relativePath || r.file?.name || ""},
        {h: "Status", w: 9, get: r => r.status || ""},
        {h: "Verdict", w: 32, get: r => r.summary?.verdict || r.message || ""},
        {h: "Records", w: 8, get: r => r.summary?.recordCount ?? "", right: true},
        {h: "PES%", w: 7, get: r => fmtPct(r.summary?.ptsRecordCoverage), right: true},
        {h: "Pair%", w: 7, get: r => fmtPct(r.summary?.ptsFrameCoverage), right: true},
        {h: "KLVSpan", w: 9, get: r => fmtSeconds(r.summary?.klvUtsSpanS), right: true},
        {h: "Gaps", w: 5, get: r => r.summary?.klvUtsGapCount ?? "", right: true},
        {h: "CV%", w: 7, get: r => fmtPct(r.summary?.klvUtsCv), right: true},
        {h: "VidPTS", w: 8, get: r => r.summary?.videoPtsCount ?? "", right: true},
        {h: "Diff", w: 8, get: r => fmtSeconds(r.summary?.spanDiffS), right: true},
    ];
    const lines = [];
    lines.push(cols.map(c => padCell(c.h, c.w, c.right)).join(" "));
    lines.push(cols.map(c => "─".repeat(c.w)).join(" "));
    for (const r of results) {
        lines.push(cols.map(c => padCell(c.get(r), c.w, c.right)).join(" "));
    }
    return lines.join("\n");
}

function buildSummaryReport(results) {
    const n = results.length;
    const ok = results.filter(r => r.status === "ok").length;
    const ptsFiles = results.filter(r => r.summary?.ptsAvailable).length;
    const totalRecords = results.reduce((s, r) => s + (Number(r.summary?.recordCount) || 0), 0);
    const ptsRecords = results.reduce((s, r) => s + (Number(r.summary?.ptsRecordCount) || 0), 0);
    const warn = results.filter(r => r.summary?.severity === "warn").length;
    const errors = results.filter(r => r.status === "error" || r.summary?.severity === "error").length;
    const gaps = results.filter(r => (r.summary?.klvUtsGapCount ?? 0) > 0).length;
    const noMisb = results.filter(r => r.status === "no_misb").length;
    const unsupported = results.filter(r => r.status === "unsupported").length;
    const cvs = results.map(r => r.summary?.klvUtsCv).filter(v => typeof v === "number" && Number.isFinite(v));
    const meanCv = cvs.length ? cvs.reduce((a, b) => a + b, 0) / cvs.length : null;
    const bigDiff = results.filter(r => Math.abs(r.summary?.spanDiffS ?? 0) > 0.5).length;

    const L = [];
    L.push("=== Sitrec FMV Data — Summary Report ===");
    L.push(`Files analyzed:    ${n}`);
    L.push("");
    L.push("OVERALL");
    L.push("─".repeat(60));
    L.push(`  With MISB metadata:     ${ok}`);
    L.push(`  Synchronous (PES PTS):  ${ptsFiles} / ${n}`);
    L.push(`  MISB records (total):   ${totalRecords}`);
    L.push(`  Records w/ PES PTS:     ${ptsRecords}${totalRecords > 0 ? ` (${(100 * ptsRecords / totalRecords).toFixed(1)}%)` : ""}`);
    L.push(`  Files with warnings:    ${warn}`);
    L.push(`  Files with errors:      ${errors}`);
    L.push(`  Files with KLV gaps:    ${gaps}`);
    L.push(`  No MISB metadata:       ${noMisb}`);
    L.push(`  Unsupported container:  ${unsupported}`);
    if (typeof meanCv === "number" && Number.isFinite(meanCv)) {
        L.push(`  Mean KLV UTS CV:        ${(meanCv * 100).toFixed(2)}%`);
    }
    L.push("");
    L.push("ANALYSIS");
    L.push("─".repeat(60));
    if (ok === 0) {
        L.push("  • No files decoded MISB ST 0601 metadata.");
    } else {
        L.push(`  • ${ptsFiles} of ${ok} MISB file(s) carry KLV PES PTS (synchronous, PCR-locked);`);
        L.push("    the rest rely on the UnixTimeStamp wall-clock fallback.");
        if (gaps > 0) L.push(`  • ${gaps} file(s) have UnixTimeStamp gaps — telemetry timing is interrupted.`);
        if (bigDiff > 0) L.push(`  • ${bigDiff} file(s) have a KLV-vs-video span difference over 0.5 s.`);
        if (warn > 0) L.push(`  • ${warn} file(s) raised timing warnings.`);
        if (errors > 0) L.push(`  • ${errors} file(s) could not be analyzed.`);
        if (gaps === 0 && bigDiff === 0 && warn === 0 && errors === 0) {
            L.push("  • No gaps, large span differences, warnings, or errors across the set.");
        }
    }
    L.push("");
    L.push("VIDEOS");
    L.push("─".repeat(60));
    L.push(summaryTableText(results));
    return L.join("\n");
}

// ---- drag-and-drop entry collection ----

function fsEntryToFile(fsEntry) {
    return new Promise((resolve, reject) => fsEntry.file(resolve, reject));
}

function collectFsEntry(fsEntry, basePath, out, recursive) {
    return new Promise(resolve => {
        const rel = basePath ? `${basePath}/${fsEntry.name}` : fsEntry.name;
        if (fsEntry.isFile) {
            if (isVideoAnalysisCandidateName(fsEntry.name)) {
                out.push({
                    name: fsEntry.name,
                    relativePath: rel,
                    getFile: () => fsEntryToFile(fsEntry),
                });
            }
            resolve();
        } else if (fsEntry.isDirectory && recursive) {
            const reader = fsEntry.createReader();
            const readBatch = () => reader.readEntries(async batch => {
                if (!batch.length) {
                    resolve();
                    return;
                }
                for (const child of batch) await collectFsEntry(child, rel, out, recursive);
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
        .filter(it => it.kind === "file" && typeof it.webkitGetAsEntry === "function")
        .map(it => it.webkitGetAsEntry())
        .filter(Boolean);
    if (fsEntries.length) {
        for (const fe of fsEntries) await collectFsEntry(fe, "", out, recursive);
    }
    if (!out.length) {
        for (const file of Array.from(dataTransfer.files || [])) {
            if (isVideoAnalysisCandidateName(file.name)) {
                out.push({name: file.name, relativePath: file.name, getFile: () => Promise.resolve(file)});
            }
        }
    }
    out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return out;
}

async function walkDirectoryHandle(directoryHandle, {recursive, basePath = "", onFound = null} = {}) {
    const files = [];
    for await (const [name, handle] of directoryHandle.entries()) {
        const relativePath = basePath ? `${basePath}/${name}` : name;
        if (handle.kind === "file") {
            if (isVideoAnalysisCandidateName(name)) {
                const entry = {name, relativePath, getFile: () => handle.getFile()};
                files.push(entry);
                onFound?.(entry);
            }
        } else if (recursive && handle.kind === "directory") {
            files.push(...await walkDirectoryHandle(handle, {recursive, basePath: relativePath, onFound}));
        }
    }
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return files;
}

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
    button.disabled = false;
    return button;
}

function setButtonDisabled(button, disabled) {
    button.disabled = disabled;
    button.style.opacity = disabled ? "0.5" : "1";
    button.style.cursor = disabled ? "default" : "pointer";
}

function acquireAnalysisPauseLock(state) {
    if (state.pauseLock) return;
    const hadNoLogic = Object.prototype.hasOwnProperty.call(par, "noLogic");
    state.pauseLock = {paused: par.paused, noLogic: par.noLogic, hadNoLogic, timer: null};
    const enforcePause = () => {
        par.paused = true;
        par.noLogic = true;
    };
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
        box-sizing: border-box; color: #222;
    `;

    const title = document.createElement("h3");
    title.textContent = "Analyze Video FMV Data";
    title.title = "Scan video/KLV files and summarize MISB timing, PES PTS pairing, and gaps. Drag files or a folder anywhere onto this window.";
    title.style.cssText = "margin: 0; color: #1976d2; font-size: 18px; flex: 0 0 auto;";

    const header = document.createElement("div");
    header.style.cssText = "display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px;";
    header.appendChild(title);
    const closeButton = makeButton("Close", "#757575");
    header.appendChild(closeButton);

    const controls = document.createElement("div");
    controls.style.cssText = `
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        border: 1px solid #ddd; border-radius: 6px; padding: 10px; margin-bottom: 10px;
    `;

    const recursiveLabel = document.createElement("label");
    recursiveLabel.title = "When checked, include candidate files in subfolders of a chosen or dropped folder.";
    recursiveLabel.style.cssText = "display: inline-flex; align-items: center; gap: 7px; font-size: 13px;";
    const recursiveInput = document.createElement("input");
    recursiveInput.type = "checkbox";
    recursiveInput.checked = true;
    recursiveInput.title = recursiveLabel.title;
    recursiveLabel.appendChild(recursiveInput);
    recursiveLabel.appendChild(document.createTextNode("Recursive"));

    const chooseFolderButton = makeButton("Choose Folder");
    const chooseFileButton = makeButton("Choose File");
    const cancelButton = makeButton("Cancel Scan", "#d32f2f");
    const clearButton = makeButton("Clear Results", "#d32f2f");
    const exportJsonButton = makeButton("Export JSON", "#455a64");
    const exportCsvButton = makeButton("Export CSV", "#455a64");
    const exportReportsButton = makeButton("Export Reports", "#455a64");
    const summaryButton = makeButton("Summary Report", "#00695c");

    controls.appendChild(recursiveLabel);
    controls.appendChild(chooseFolderButton);
    controls.appendChild(chooseFileButton);
    controls.appendChild(cancelButton);
    controls.appendChild(clearButton);
    controls.appendChild(exportJsonButton);
    controls.appendChild(exportCsvButton);
    controls.appendChild(exportReportsButton);
    controls.appendChild(summaryButton);

    const status = document.createElement("div");
    status.textContent = "Ready — choose a folder or file, or drag files/folders onto this window.";
    status.title = "Shows the current scan state and the file being analyzed.";
    status.style.cssText = "font-size: 13px; margin: 0 0 8px 0; min-height: 18px; color: #333;";

    const progress = document.createElement("progress");
    progress.max = 1;
    progress.value = 0;
    progress.title = "Progress across the current batch of files.";
    progress.style.cssText = "width: 100%; height: 12px; margin-bottom: 10px; flex: 0 0 auto;";

    const summary = document.createElement("div");
    summary.style.cssText = `
        display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
        gap: 8px; margin-bottom: 10px; font-size: 12px;
    `;

    const tableWrap = document.createElement("div");
    tableWrap.style.cssText = "flex: 1 1 auto; min-height: 0; overflow: auto; border: 1px solid #ddd; border-radius: 6px;";

    const table = document.createElement("table");
    table.style.cssText = "width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed;";
    const thead = document.createElement("thead");
    thead.style.cssText = "position: sticky; top: 0; background: #f5f7fa; z-index: 1;";
    const headerRow = document.createElement("tr");
    for (const [label, width] of TABLE_HEADERS) {
        const th = document.createElement("th");
        th.textContent = label;
        th.title = TABLE_HEADER_TOOLTIPS[label] || label;
        th.style.cssText = `text-align: left; padding: 8px; border-bottom: 1px solid #ddd; width: ${width};`;
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    const tbody = document.createElement("tbody");
    table.appendChild(thead);
    table.appendChild(tbody);
    tableWrap.appendChild(table);

    const dropHint = document.createElement("div");
    dropHint.textContent = "Drop video / KLV files or a folder to analyze";
    dropHint.style.cssText = `
        position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
        background: rgba(25,118,210,0.10); border: 3px dashed #1976d2; border-radius: 8px;
        color: #1976d2; font-size: 22px; font-weight: 700; pointer-events: none; z-index: 5;
    `;
    modal.style.position = "relative";

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
        recursiveInput,
        chooseFolderButton, chooseFileButton, cancelButton, clearButton,
        closeButton, exportJsonButton, exportCsvButton, exportReportsButton, summaryButton,
        status, progress, summary, tbody,
        rowsByKey: new Map(),
        results: [],
        nextRowId: 0,
        cancelled: false,
        running: false,
        pauseLock: null,
    };
    acquireAnalysisPauseLock(state);
    activeDialog = state;
    return state;
}

function summaryCell(label, value) {
    const tooltip = SUMMARY_TOOLTIPS[label] || label;
    const cell = document.createElement("div");
    cell.title = tooltip;
    cell.style.cssText = "border: 1px solid #ddd; border-radius: 6px; padding: 7px; background: #fafafa; min-width: 0;";
    const labelEl = document.createElement("div");
    labelEl.textContent = label;
    labelEl.title = tooltip;
    labelEl.style.cssText = "color: #607d8b; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    const valueEl = document.createElement("div");
    valueEl.textContent = value;
    valueEl.title = tooltip;
    valueEl.style.cssText = "font-size: 15px; font-weight: 700; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    cell.appendChild(labelEl);
    cell.appendChild(valueEl);
    return cell;
}

function updateSummary(state) {
    const results = state.results;
    const ok = results.filter(r => r.status === "ok").length;
    const warn = results.filter(r => r.summary?.severity === "warn").length;
    const errors = results.filter(r => r.status === "error" || r.summary?.severity === "error").length;
    const gaps = results.filter(r => (r.summary?.klvUtsGapCount ?? 0) > 0).length;
    const noMisb = results.filter(r => r.status === "no_misb").length;
    const unsupported = results.filter(r => r.status === "unsupported").length;
    const ptsFiles = results.filter(r => r.summary?.ptsAvailable).length;
    const totalRecords = results.reduce((s, r) => s + (Number(r.summary?.recordCount) || 0), 0);
    const ptsRecords = results.reduce((s, r) => s + (Number(r.summary?.ptsRecordCount) || 0), 0);
    const ptsRecordPct = totalRecords > 0 ? ptsRecords / totalRecords : null;

    state.summary.innerHTML = "";
    state.summary.appendChild(summaryCell("Candidates", results.length));
    state.summary.appendChild(summaryCell("Analyzed", results.length));
    state.summary.appendChild(summaryCell("MISB", ok));
    state.summary.appendChild(summaryCell("PES PTS Files", ptsFiles));
    state.summary.appendChild(summaryCell("PES PTS Records", fmtPct(ptsRecordPct)));
    state.summary.appendChild(summaryCell("Warnings", warn));
    state.summary.appendChild(summaryCell("Errors", errors));
    state.summary.appendChild(summaryCell("Gaps", gaps));
    state.summary.appendChild(summaryCell("No MISB", noMisb));
    state.summary.appendChild(summaryCell("Unsupported", unsupported));
}

function makeRow(state, entry) {
    const tr = document.createElement("tr");
    tr.style.cssText = "border-bottom: 1px solid #eee;";
    const cells = [];
    for (let i = 0; i < TABLE_HEADERS.length; i++) {
        const td = document.createElement("td");
        td.style.cssText = "padding: 7px 8px; vertical-align: top; overflow-wrap: anywhere;";
        cells.push(td);
        tr.appendChild(td);
    }
    cells[0].textContent = entry.relativePath;
    cells[1].textContent = "Queued";
    state.tbody.appendChild(tr);
    const row = {tr, cells, entry};
    state.rowsByKey.set(entry.key, row);
    return row;
}

function setRowProgress(state, entry, text) {
    const row = state.rowsByKey.get(entry.key) || makeRow(state, entry);
    row.cells[1].textContent = text;
}

function smallButton(label, color, tooltip) {
    const b = makeButton(label, color, tooltip);
    b.style.padding = "5px 8px";
    b.style.minHeight = "26px";
    return b;
}

function setRowResult(state, result, entry) {
    const row = state.rowsByKey.get(entry.key) || makeRow(state, entry);
    const summary = result.summary || {};
    row.cells[0].textContent = result.file?.relativePath || result.file?.name || entry.relativePath;
    row.cells[1].textContent = result.status;
    row.cells[2].textContent = summary.verdict || result.message || "";
    row.cells[3].textContent = summary.recordCount ?? "";
    row.cells[4].textContent = fmtPct(summary.ptsRecordCoverage);
    row.cells[5].textContent = fmtPct(summary.ptsFrameCoverage);
    row.cells[6].textContent = fmtSeconds(summary.klvUtsSpanS);
    row.cells[7].textContent = summary.klvUtsGapCount ?? "";
    row.cells[8].textContent = fmtPct(summary.klvUtsCv);
    row.cells[9].textContent = summary.videoPtsCount ?? "";
    row.cells[10].textContent = fmtSeconds(summary.spanDiffS);

    // Frames export (per-frame CSV) — only when the file actually has video frames.
    row.cells[11].innerHTML = "";
    if ((summary.videoPtsCount ?? 0) > 0 && typeof entry.getFile === "function") {
        const exportButton = smallButton("Export", "#455a64", BUTTON_TOOLTIPS["Export"]);
        exportButton.onclick = () => exportFramesForFile(state, result, entry, exportButton);
        row.cells[11].appendChild(exportButton);
    }

    // Detailed text report.
    row.cells[12].innerHTML = "";
    if (result.report) {
        const reportButton = smallButton("View", "#1976d2", BUTTON_TOOLTIPS["View"]);
        const path = result.file?.relativePath || result.file?.name || "report";
        reportButton.onclick = () => showTimingAnalysis(result.report, `${path.replace(/[\/\\]+/g, "_")}-timing.txt`);
        row.cells[12].appendChild(reportButton);
    }

    if (summary.severity === "error" || result.status === "error") row.tr.style.background = "#fff5f5";
    else if (summary.severity === "warn") row.tr.style.background = "#fffaf0";
    else if (result.status === "ok") row.tr.style.background = "#f7fff7";
    else row.tr.style.background = "";
}

async function exportFramesForFile(state, result, entry, button) {
    const original = button.textContent;
    button.textContent = "…";
    setButtonDisabled(button, true);
    try {
        const file = await entry.getFile();
        const full = await analyzeVideoFileLike(file, {
            name: result.file?.name || entry.name,
            relativePath: result.file?.relativePath || entry.relativePath,
            includeFrameRows: true,
        });
        if (!full.frameRows || full.frameRows.length === 0) {
            state.status.textContent = "No virtual frames to export for this file (no video PTS).";
            return;
        }
        const base = (result.file?.relativePath || result.file?.name || "frames").replace(/[\/\\]+/g, "_");
        saveAs(new Blob([frameRowsToCsv(full)], {type: "text/csv;charset=utf-8"}), `${base}-frames.csv`);
    } catch (error) {
        if (!isAbortLikeError(error)) showError(error);
    } finally {
        button.textContent = original;
        setButtonDisabled(button, false);
    }
}

function refreshControls(state) {
    const running = state.running;
    const hasResults = state.results.length > 0;
    setButtonDisabled(state.chooseFolderButton, running);
    setButtonDisabled(state.chooseFileButton, running);
    setButtonDisabled(state.cancelButton, !running);
    setButtonDisabled(state.clearButton, running || !hasResults);
    setButtonDisabled(state.exportJsonButton, running || !hasResults);
    setButtonDisabled(state.exportCsvButton, running || !hasResults);
    setButtonDisabled(state.exportReportsButton, running || !allReportsText(state.results));
    setButtonDisabled(state.summaryButton, running || !hasResults);
    state.recursiveInput.disabled = running;
}

function clearResults(state) {
    if (state.running) return;
    state.results = [];
    state.rowsByKey.clear();
    state.tbody.innerHTML = "";
    state.progress.value = 0;
    state.status.textContent = "Cleared. Choose a folder or file, or drag files/folders onto this window.";
    updateSummary(state);
    refreshControls(state);
}

// Core: analyze a batch of entries and APPEND them to the accumulated results.
async function analyzeEntries(state, entries) {
    if (state.running) return;
    if (!entries.length) {
        state.status.textContent = "No supported video/KLV files found.";
        return;
    }
    state.running = true;
    state.cancelled = false;
    refreshControls(state);

    for (let i = 0; i < entries.length; i++) {
        if (state.cancelled) break;
        const entry = entries[i];
        entry.key = state.nextRowId++;
        makeRow(state, entry);
        setRowProgress(state, entry, "Reading");
        state.progress.value = i / entries.length;
        state.status.textContent = `Analyzing ${i + 1} of ${entries.length}: ${entry.relativePath}`;

        try {
            const file = await entry.getFile();
            entry.size = file.size;
            const result = await analyzeVideoFileLike(file, {
                name: entry.name,
                relativePath: entry.relativePath,
                onProgress: progress => {
                    if (state.cancelled) throw new Error("Scan cancelled");
                    const fileFraction = progress.total > 0 ? progress.loaded / progress.total : 0;
                    state.progress.value = (i + fileFraction) / entries.length;
                    setRowProgress(state, entry, progress.phase === "probe" ? "Probing" : "Extracting");
                },
            });
            state.results.push(result);
            setRowResult(state, result, entry);
        } catch (error) {
            if (state.cancelled) break;
            const result = {
                file: {name: entry.name, relativePath: entry.relativePath, size: entry.size},
                status: "error",
                container: "",
                message: error.message || String(error),
                summary: {severity: "error", verdict: error.message || String(error), flags: "error"},
                report: "",
            };
            state.results.push(result);
            setRowResult(state, result, entry);
        }
        updateSummary(state);
    }

    state.progress.value = state.cancelled ? state.progress.value : 1;
    state.status.textContent = state.cancelled
        ? `Cancelled. ${state.results.length} result(s) in the table.`
        : `Done. ${state.results.length} result(s) in the table.`;
    state.running = false;
    refreshControls(state);
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
    let entries = [];
    try {
        entries = await walkDirectoryHandle(directoryHandle, {
            recursive: state.recursiveInput.checked,
            onFound: () => {
                state.status.textContent = `Found ${++count} candidate file(s)...`;
            },
        });
    } catch (error) {
        state.status.textContent = error.message || String(error);
        return;
    }
    await analyzeEntries(state, entries);
}

async function runChooseFile(state) {
    let files;
    try {
        if (typeof window.showOpenFilePicker === "function") {
            const handles = await window.showOpenFilePicker({multiple: true});
            files = handles.map(h => ({name: h.name, relativePath: h.name, getFile: () => h.getFile()}));
        } else {
            const input = document.createElement("input");
            input.type = "file";
            input.multiple = true;
            const picked = await new Promise(resolve => {
                input.onchange = () => resolve(Array.from(input.files || []));
                input.click();
            });
            files = picked.map(f => ({name: f.name, relativePath: f.name, getFile: () => Promise.resolve(f)}));
        }
    } catch (error) {
        if (!isAbortLikeError(error)) showError(error);
        return;
    }
    const entries = (files || []).filter(e => isVideoAnalysisCandidateName(e.name));
    if (!entries.length) {
        state.status.textContent = "Selected file(s) are not supported video/KLV containers.";
        return;
    }
    await analyzeEntries(state, entries);
}

function setDropHighlight(state, on) {
    state.dropHint.style.display = on ? "flex" : "none";
}

function wireDragAndDrop(state) {
    const overlay = state.overlay;
    let depth = 0;
    const stop = e => {
        e.preventDefault();
        e.stopPropagation();
    };
    overlay.addEventListener("dragenter", e => {
        stop(e);
        depth++;
        if (!state.running) setDropHighlight(state, true);
    });
    overlay.addEventListener("dragover", e => {
        stop(e);
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    overlay.addEventListener("dragleave", e => {
        stop(e);
        depth = Math.max(0, depth - 1);
        if (depth === 0) setDropHighlight(state, false);
    });
    overlay.addEventListener("drop", async e => {
        stop(e);
        depth = 0;
        setDropHighlight(state, false);
        if (state.running) {
            state.status.textContent = "Busy — wait for the current scan to finish before dropping more.";
            return;
        }
        state.status.textContent = "Reading dropped items...";
        let entries = [];
        try {
            entries = await entriesFromDataTransfer(e.dataTransfer, state.recursiveInput.checked);
        } catch (error) {
            showError(error);
            return;
        }
        if (!entries.length) {
            state.status.textContent = "No supported video/KLV files in the drop.";
            return;
        }
        await analyzeEntries(state, entries);
    });
}

export function openVideoFolderAnalysisDialog() {
    const state = createDialog();

    state.closeButton.onclick = () => {
        state.cancelled = true;
        releaseAnalysisPauseLock(state);
        if (state.overlay.parentNode) document.body.removeChild(state.overlay);
        if (activeDialog === state) activeDialog = null;
    };
    state.cancelButton.onclick = () => {
        state.cancelled = true;
        state.status.textContent = "Cancelling...";
        setButtonDisabled(state.cancelButton, true);
    };
    state.clearButton.onclick = () => clearResults(state);
    state.chooseFolderButton.onclick = () => runFolderScan(state);
    state.chooseFileButton.onclick = () => runChooseFile(state);
    state.exportJsonButton.onclick = () => {
        const payload = {
            generatedAt: new Date().toISOString(),
            results: state.results.map(stripForJson),
        };
        saveAs(new Blob([JSON.stringify(payload, null, 2)], {type: "application/json;charset=utf-8"}),
            "sitrec-fmv-data-analysis.json");
    };
    state.exportCsvButton.onclick = () => {
        saveAs(new Blob([resultsToCsv(state.results)], {type: "text/csv;charset=utf-8"}),
            "sitrec-fmv-data-analysis.csv");
    };
    state.exportReportsButton.onclick = () => {
        saveAs(new Blob([allReportsText(state.results)], {type: "text/plain;charset=utf-8"}),
            "sitrec-fmv-data-reports.txt");
    };
    state.summaryButton.onclick = () => {
        showTimingAnalysis(buildSummaryReport(state.results), "sitrec-fmv-data-summary.txt");
    };

    wireDragAndDrop(state);
    updateSummary(state);
    refreshControls(state);
    return state;
}

export function addFileAnalysisMenu() {
    if (!guiMenus.file || fileAnalysisFolder) return;
    fileAnalysisFolder = guiMenus.file.addFolder("File Analysis")
        .perm()
        .close()
        .tooltip("Tools that scan files without loading them into the current sitch");
    fileAnalysisFolder.add({analyzeVideoFMV: openVideoFolderAnalysisDialog}, "analyzeVideoFMV")
        .name("Analyze Video FMV Data...")
        .tooltip("Open the FMV timing/MISB analyzer — drag in files or a folder, or choose them")
        .perm();
    addBotBenchMenu(fileAnalysisFolder);
}
