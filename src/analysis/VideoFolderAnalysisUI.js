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
import {par} from "../par";

let activeDialog = null;
let fileAnalysisFolder = null;

function fmtNumber(value, digits = 3) {
    return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "";
}

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
        "path",
        "status",
        "severity",
        "verdict",
        "container",
        "sizeBytes",
        "recordCount",
        "ptsAvailable",
        "fullRecordPts",
        "ptsRecordCount",
        "ptsRecordCoverage",
        "ptsFramePairCount",
        "ptsFrameCoverage",
        "exactFrameCoverage",
        "ptsPairToleranceUs",
        "ptsMeanAbsDeltaUs",
        "ptsMaxDeltaUs",
        "klvUtsSpanS",
        "klvUtsMeanIntervalS",
        "klvUtsCv",
        "klvUtsGapCount",
        "klvUtsMaxGapS",
        "klvPesSpanS",
        "klvPesGapCount",
        "videoPtsCount",
        "videoPtsSpanS",
        "videoPtsCv",
        "spanDiffS",
        "pcrFps",
        "realFps",
        "flags",
        "message",
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

function allPtsRows(results) {
    const rows = [];
    for (const result of results) {
        const path = result.file?.relativePath || result.file?.name || "";
        for (const row of result.ptsRows || []) {
            rows.push({
                path,
                status: result.status,
                severity: result.summary?.severity,
                verdict: result.summary?.verdict,
                ...row,
            });
        }
    }
    return rows;
}

function ptsRowsToCsv(results) {
    const columns = [
        "path",
        "status",
        "severity",
        "ptsAvailable",
        "videoPid",
        "klvPid",
        "frameIndex",
        "videoPtsUs",
        "videoTimeS",
        "klvRecordIndex",
        "klvPesPtsUs",
        "klvUtsUs",
        "deltaUs",
        "absDeltaUs",
        "pairingMethod",
        "pairingQuality",
        "verdict",
    ];
    const lines = [columns.join(",")];
    for (const row of allPtsRows(results)) {
        lines.push(columns.map(column => csvEscape(row[column])).join(","));
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

function stripPtsRowsForJson(result) {
    const stripAnalysis = analysis => {
        if (!analysis) return analysis;
        const copy = {
            ...analysis,
            ptsRowCount: analysis.ptsRows?.length ?? 0,
        };
        delete copy.ptsRows;
        return copy;
    };
    const copy = {
        ...result,
        ptsRowCount: result.ptsRows?.length ?? 0,
        selectedAnalysis: stripAnalysis(result.selectedAnalysis),
        analyses: Array.isArray(result.analyses) ? result.analyses.map(stripAnalysis) : result.analyses,
    };
    delete copy.ptsRows;
    return copy;
}

async function walkDirectoryHandle(directoryHandle, {
    recursive,
    basePath = "",
    onFound = null,
} = {}) {
    const files = [];
    for await (const [name, handle] of directoryHandle.entries()) {
        const relativePath = basePath ? `${basePath}/${name}` : name;
        if (handle.kind === "file") {
            if (isVideoAnalysisCandidateName(name)) {
                const entry = {name, relativePath, handle};
                files.push(entry);
                onFound?.(entry);
            }
        } else if (recursive && handle.kind === "directory") {
            const childFiles = await walkDirectoryHandle(handle, {
                recursive,
                basePath: relativePath,
                onFound,
            });
            files.push(...childFiles);
        }
    }
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return files;
}

function makeButton(label, color = "#1976d2") {
    const button = document.createElement("button");
    button.textContent = label;
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
    state.pauseLock = {
        paused: par.paused,
        noLogic: par.noLogic,
        hadNoLogic,
        timer: null,
    };

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
    if (lock.timer) {
        clearInterval(lock.timer);
    }
    if (lock.hadNoLogic) {
        par.noLogic = lock.noLogic;
    } else {
        delete par.noLogic;
    }
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
        background: white; border-radius: 8px; padding: 18px;
        width: 92vw; max-width: 1280px;
        height: calc(100vh - 44px);
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        font-family: Arial, sans-serif; display: flex; flex-direction: column;
        box-sizing: border-box; color: #222;
    `;

    const title = document.createElement("h3");
    title.textContent = "Analyze Video Folder";
    title.style.cssText = "margin: 0; color: #1976d2; font-size: 18px; flex: 0 0 auto;";

    const header = document.createElement("div");
    header.style.cssText = "display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px;";
    header.appendChild(title);

    const closeButton = makeButton("Close", "#757575");
    header.appendChild(closeButton);

    const controls = document.createElement("div");
    controls.style.cssText = `
        display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
        border: 1px solid #ddd; border-radius: 6px; padding: 10px; margin-bottom: 10px;
    `;

    const recursiveLabel = document.createElement("label");
    recursiveLabel.style.cssText = "display: inline-flex; align-items: center; gap: 7px; font-size: 13px;";
    const recursiveInput = document.createElement("input");
    recursiveInput.type = "checkbox";
    recursiveInput.checked = true;
    recursiveLabel.appendChild(recursiveInput);
    recursiveLabel.appendChild(document.createTextNode("Recursive"));

    const chooseButton = makeButton("Choose Folder");
    const cancelButton = makeButton("Cancel Scan", "#d32f2f");
    const exportJsonButton = makeButton("Export JSON", "#455a64");
    const exportCsvButton = makeButton("Export CSV", "#455a64");
    const exportPtsButton = makeButton("Export PTS Rows", "#455a64");
    const exportReportsButton = makeButton("Export Reports", "#455a64");
    setButtonDisabled(cancelButton, true);
    setButtonDisabled(exportJsonButton, true);
    setButtonDisabled(exportCsvButton, true);
    setButtonDisabled(exportPtsButton, true);
    setButtonDisabled(exportReportsButton, true);

    controls.appendChild(recursiveLabel);
    controls.appendChild(chooseButton);
    controls.appendChild(cancelButton);
    controls.appendChild(exportJsonButton);
    controls.appendChild(exportCsvButton);
    controls.appendChild(exportPtsButton);
    controls.appendChild(exportReportsButton);

    const status = document.createElement("div");
    status.textContent = "Ready";
    status.style.cssText = "font-size: 13px; margin: 0 0 8px 0; min-height: 18px; color: #333;";

    const progress = document.createElement("progress");
    progress.max = 1;
    progress.value = 0;
    progress.style.cssText = "width: 100%; height: 12px; margin-bottom: 10px; flex: 0 0 auto;";

    const summary = document.createElement("div");
    summary.style.cssText = `
        display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
        gap: 8px; margin-bottom: 10px; font-size: 12px;
    `;

    const tableWrap = document.createElement("div");
    tableWrap.style.cssText = "flex: 1 1 auto; min-height: 0; overflow: auto; border: 1px solid #ddd; border-radius: 6px;";

    const table = document.createElement("table");
    table.style.cssText = `
        width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed;
    `;
    const thead = document.createElement("thead");
    thead.style.cssText = "position: sticky; top: 0; background: #f5f7fa; z-index: 1;";
    const headerRow = document.createElement("tr");
    const headers = [
        ["File", "22%"],
        ["Status", "7%"],
        ["Verdict", "20%"],
        ["Records", "6%"],
        ["PES PTS Rec", "7%"],
        ["Frame Pair", "7%"],
        ["KLV Span", "7%"],
        ["Gaps", "5%"],
        ["CV", "5%"],
        ["Video PTS", "6%"],
        ["Diff", "5%"],
        ["Report", "5%"],
    ];
    for (const [label, width] of headers) {
        const th = document.createElement("th");
        th.textContent = label;
        th.style.cssText = `text-align: left; padding: 8px; border-bottom: 1px solid #ddd; width: ${width};`;
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    const tbody = document.createElement("tbody");
    table.appendChild(thead);
    table.appendChild(tbody);
    tableWrap.appendChild(table);

    modal.appendChild(header);
    modal.appendChild(controls);
    modal.appendChild(status);
    modal.appendChild(progress);
    modal.appendChild(summary);
    modal.appendChild(tableWrap);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const state = {
        overlay,
        recursiveInput,
        chooseButton,
        cancelButton,
        closeButton,
        exportJsonButton,
        exportCsvButton,
        exportPtsButton,
        exportReportsButton,
        status,
        progress,
        summary,
        tbody,
        rowsByPath: new Map(),
        results: [],
        folderName: "",
        cancelled: false,
        running: false,
        pauseLock: null,
    };
    acquireAnalysisPauseLock(state);
    activeDialog = state;
    return state;
}

function summaryCell(label, value) {
    const cell = document.createElement("div");
    cell.style.cssText = "border: 1px solid #ddd; border-radius: 6px; padding: 7px; background: #fafafa; min-width: 0;";
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

function updateSummary(state, fileCount = 0) {
    const results = state.results;
    const ok = results.filter(result => result.status === "ok").length;
    const warn = results.filter(result => result.summary?.severity === "warn").length;
    const errors = results.filter(result => result.status === "error" || result.summary?.severity === "error").length;
    const gaps = results.filter(result => (result.summary?.klvUtsGapCount ?? 0) > 0).length;
    const noMisb = results.filter(result => result.status === "no_misb").length;
    const unsupported = results.filter(result => result.status === "unsupported").length;
    const ptsFiles = results.filter(result => result.summary?.ptsAvailable).length;
    const totalRecords = results.reduce((sum, result) => sum + (Number(result.summary?.recordCount) || 0), 0);
    const ptsRecords = results.reduce((sum, result) => sum + (Number(result.summary?.ptsRecordCount) || 0), 0);
    const ptsRecordPct = totalRecords > 0 ? ptsRecords / totalRecords : null;

    state.summary.innerHTML = "";
    state.summary.appendChild(summaryCell("Candidates", fileCount || results.length));
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
    for (let i = 0; i < 12; i++) {
        const td = document.createElement("td");
        td.style.cssText = "padding: 7px 8px; vertical-align: top; overflow-wrap: anywhere;";
        cells.push(td);
        tr.appendChild(td);
    }
    cells[0].textContent = entry.relativePath;
    cells[1].textContent = "Queued";
    cells[2].textContent = fmtBytes(entry.size);
    state.tbody.appendChild(tr);
    state.rowsByPath.set(entry.relativePath, {tr, cells});
    return {tr, cells};
}

function setRowProgress(state, entry, text) {
    const row = state.rowsByPath.get(entry.relativePath) || makeRow(state, entry);
    row.cells[1].textContent = text;
}

function setRowResult(state, result) {
    const path = result.file?.relativePath || result.file?.name || "";
    const row = state.rowsByPath.get(path) || makeRow(state, {relativePath: path, size: result.file?.size});
    const summary = result.summary || {};
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
    row.cells[11].innerHTML = "";
    if (result.report) {
        const reportButton = makeButton("View", "#1976d2");
        reportButton.style.padding = "5px 8px";
        reportButton.style.minHeight = "26px";
        reportButton.onclick = () => showTimingAnalysis(result.report, `${path.replace(/[\/\\]+/g, "_")}-timing.txt`);
        row.cells[11].appendChild(reportButton);
    }
    if (summary.severity === "error" || result.status === "error") {
        row.tr.style.background = "#fff5f5";
    } else if (summary.severity === "warn") {
        row.tr.style.background = "#fffaf0";
    } else if (result.status === "ok") {
        row.tr.style.background = "#f7fff7";
    } else {
        row.tr.style.background = "";
    }
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
        if (!isAbortLikeError(error)) {
            showError(error);
        }
        return;
    }

    state.running = true;
    state.cancelled = false;
    state.results = [];
    state.rowsByPath.clear();
    state.tbody.innerHTML = "";
    state.folderName = directoryHandle.name || "folder";
    state.status.textContent = "Scanning folder...";
    state.progress.value = 0;
    setButtonDisabled(state.chooseButton, true);
    setButtonDisabled(state.cancelButton, false);
    setButtonDisabled(state.exportJsonButton, true);
    setButtonDisabled(state.exportCsvButton, true);
    setButtonDisabled(state.exportPtsButton, true);
    setButtonDisabled(state.exportReportsButton, true);
    state.recursiveInput.disabled = true;
    updateSummary(state, 0);

    let entries = [];
    try {
        entries = await walkDirectoryHandle(directoryHandle, {
            recursive: state.recursiveInput.checked,
            onFound: entry => {
                makeRow(state, entry);
                state.status.textContent = `Found ${state.rowsByPath.size} candidate file(s)...`;
            },
        });
    } catch (error) {
        state.status.textContent = error.message || String(error);
        state.running = false;
        setButtonDisabled(state.chooseButton, false);
        setButtonDisabled(state.cancelButton, true);
        state.recursiveInput.disabled = false;
        return;
    }

    updateSummary(state, entries.length);
    if (entries.length === 0) {
        state.status.textContent = "No candidate video/KLV files found.";
        state.running = false;
        setButtonDisabled(state.chooseButton, false);
        setButtonDisabled(state.cancelButton, true);
        state.recursiveInput.disabled = false;
        return;
    }

    for (let i = 0; i < entries.length; i++) {
        if (state.cancelled) break;
        const entry = entries[i];
        setRowProgress(state, entry, "Reading");
        state.progress.value = i / entries.length;
        state.status.textContent = `Analyzing ${i + 1} of ${entries.length}: ${entry.relativePath}`;

        try {
            const file = await entry.handle.getFile();
            entry.size = file.size;
            const result = await analyzeVideoFileLike(file, {
                name: entry.name,
                relativePath: entry.relativePath,
                onProgress: progress => {
                    if (state.cancelled) {
                        throw new Error("Scan cancelled");
                    }
                    const fileFraction = progress.total > 0 ? progress.loaded / progress.total : 0;
                    state.progress.value = (i + fileFraction) / entries.length;
                    const phase = progress.phase === "probe" ? "Probing" : "Extracting";
                    setRowProgress(state, entry, phase);
                },
            });
            state.results.push(result);
            setRowResult(state, result);
            updateSummary(state, entries.length);
        } catch (error) {
            if (state.cancelled) break;
            const result = {
                file: {name: entry.name, relativePath: entry.relativePath, size: entry.size},
                status: "error",
                container: "",
                message: error.message || String(error),
                summary: {
                    severity: "error",
                    verdict: error.message || String(error),
                    flags: "error",
                },
                report: "",
            };
            state.results.push(result);
            setRowResult(state, result);
            updateSummary(state, entries.length);
        }
    }

    state.progress.value = state.cancelled ? state.progress.value : 1;
    state.status.textContent = state.cancelled
        ? `Cancelled after ${state.results.length} of ${entries.length} file(s).`
        : `Done. Analyzed ${state.results.length} of ${entries.length} file(s).`;
    state.running = false;
    setButtonDisabled(state.chooseButton, false);
    setButtonDisabled(state.cancelButton, true);
    setButtonDisabled(state.exportJsonButton, state.results.length === 0);
    setButtonDisabled(state.exportCsvButton, state.results.length === 0);
    setButtonDisabled(state.exportPtsButton, allPtsRows(state.results).length === 0);
    setButtonDisabled(state.exportReportsButton, !allReportsText(state.results));
    state.recursiveInput.disabled = false;
}

export function openVideoFolderAnalysisDialog() {
    const state = createDialog();

    state.closeButton.onclick = () => {
        state.cancelled = true;
        releaseAnalysisPauseLock(state);
        if (state.overlay.parentNode) {
            document.body.removeChild(state.overlay);
        }
        if (activeDialog === state) activeDialog = null;
    };
    state.cancelButton.onclick = () => {
        state.cancelled = true;
        state.status.textContent = "Cancelling...";
        setButtonDisabled(state.cancelButton, true);
    };
    state.chooseButton.onclick = () => runFolderScan(state);
    state.exportJsonButton.onclick = () => {
        const payload = {
            generatedAt: new Date().toISOString(),
            folderName: state.folderName,
            recursive: state.recursiveInput.checked,
            results: state.results.map(stripPtsRowsForJson),
        };
        saveAs(
            new Blob([JSON.stringify(payload, null, 2)], {type: "application/json;charset=utf-8"}),
            "sitrec-video-folder-analysis.json"
        );
    };
    state.exportCsvButton.onclick = () => {
        saveAs(
            new Blob([resultsToCsv(state.results)], {type: "text/csv;charset=utf-8"}),
            "sitrec-video-folder-analysis.csv"
        );
    };
    state.exportPtsButton.onclick = () => {
        saveAs(
            new Blob([ptsRowsToCsv(state.results)], {type: "text/csv;charset=utf-8"}),
            "sitrec-video-folder-pts-rows.csv"
        );
    };
    state.exportReportsButton.onclick = () => {
        saveAs(
            new Blob([allReportsText(state.results)], {type: "text/plain;charset=utf-8"}),
            "sitrec-video-folder-analysis-reports.txt"
        );
    };

    updateSummary(state, 0);
    return state;
}

export function addFileAnalysisMenu() {
    if (!guiMenus.file || fileAnalysisFolder) return;
    fileAnalysisFolder = guiMenus.file.addFolder("File Analysis")
        .perm()
        .close()
        .tooltip("Batch file analysis tools");
    fileAnalysisFolder.add({analyzeVideoFolder: openVideoFolderAnalysisDialog}, "analyzeVideoFolder")
        .name("Analyze Video Folder...")
        .tooltip("Scan a local folder for MISB timing statistics")
        .perm();
}
