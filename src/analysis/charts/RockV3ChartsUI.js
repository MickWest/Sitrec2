// RockV3ChartsUI.js — the in-app chart window for BOT Bench results.
//
// Opens from File > File Analysis > Result Charts..., or straight from a
// finished BOT Bench run. Plotly is fetched on demand by PlotlyLoader, so
// nothing here costs anything until the window is opened.
//
// Two data sources, because the charts are useful at two different moments:
//   * the entries of a BOT Bench run that just finished, adapted in memory;
//   * a joined results JSONL dropped onto the window, which is what the offline
//     pipeline writes and what the matplotlib reference reads.
//
// Export is the publication path. Plotly's own toImage gives an SVG with live
// text, or a PNG at three times the layout size, which is past 300 dpi for a
// full-page figure. Neither needs a browser to be automated, because the reader
// is already in one.

import {buildAllFigures, FIGURES} from "./RockV3ChartSpecs";
import {drawFigure, purgeFigure, figureToImage, loadPlotly} from "./PlotlyLoader";
import {showError} from "../../showError";
import {isLocal} from "../../configUtils";

let activeWindow = null;

// ---------------------------------------------------------------------------
// adapting a live BOT Bench run
// ---------------------------------------------------------------------------

/**
 * Flatten BOT Bench entries into the row shape the figures expect.
 *
 * The offline pipeline gets these fields by joining against the generator's
 * manifest; in the app only the entry, its row and its truth sidecar are to
 * hand, so a few come from the interchange path instead. A field that cannot be
 * recovered is left undefined and the figures that need it simply skip those
 * rows, which is why every figure builder filters on `Number.isFinite`.
 *
 * Path shape assumed: <set>/batch_<n>sec/<rung>deg/All/<base>.all.csv
 */
export function rowsFromBotBenchEntries(entries) {
    const out = [];
    for (const entry of entries) {
        if (!entry?.row) continue;
        const row = entry.row;
        const path = String(entry.relativePath ?? entry.name ?? "");
        const base = String(entry.name ?? "").replace(/\.all\.csv$/i, "");
        let truth = null;
        try { truth = entry.labelsText ? JSON.parse(entry.labelsText) : null; } catch (e) { /* absent */ }

        const durationFromPath = Number(path.match(/batch_(\d+)sec/)?.[1]);
        // The rung is only in the path when the folder ABOVE it was the one chosen.
        // Pick the rung folder itself and the relative paths start at "All/", so the
        // fallback is the analysis's own declared sigma, which on a wobble rung IS
        // the amplitude and is 0 on the clean rung. Without this the whole figure
        // set is empty for the commonest way of choosing a folder.
        const rungFromPath = Number(path.match(/(\d+(?:\.\d+)?)deg/)?.[1]);
        const declared = row.quality?.declaredLosSigmaDeg;
        const rung = Number.isFinite(rungFromPath) ? rungFromPath
            : (Number.isFinite(declared) ? declared : null);
        // The three rock_v3 classes are distinguishable from the target kind:
        // "party-rising" and "weather-rising" are both objectClass "balloon".
        const kind = truth?.targetKind ?? "";
        const cls = kind.startsWith("weather") ? "weather_balloon"
            : kind.startsWith("drone") ? "drone"
                : truth?.objectClass === "balloon" ? "balloon"
                    : (base.match(/^([a-z_]+?)_\d+$/)?.[1] ?? null);

        out.push({
            base, set: path.split("/")[0] ?? null,
            d_class: cls,
            d_durationSeconds: Number.isFinite(durationFromPath) ? durationFromPath
                : truth?.provenance?.spec?.durationSeconds ?? null,
            d_errorDeg: rung,
            d_classCorrect: classCorrect(truth?.objectClass, row.viableClasses),
            q_frames: row.quality?.frames,
            q_log10Rcond: row.quality?.log10Rcond,
            q_noiseEst: row.quality?.noiseEstDeg,
            r_verdict: row.verdictCode,
            r_viable: (row.viableClasses ?? []).join("+"),
            r_topKey: row.top?.key, r_topName: row.top?.name,
            r_topErr: row.top?.errDeg, r_topRange: row.top?.rangeStartM,
            r_topBlind: row.topRangeBlind ? 1 : 0,
            r_topRelSep: row.truthScore?.topRelSep,
            r_bestRelSep: row.truthScore?.bestRelSep,
            r_bestName: row.truthScore?.bestName,
            in_realizedRmsDeg: truth?.realizedNoise?.rmsDegAllFrames,
            in_objectClass: truth?.objectClass,
            in_trueRangeMeanM: row.truthScore?.meanTruthRangeM,
            // The parallax aperture is measured from the All CSV by the offline
            // join. losSweepDeg is the closest thing the sidecar carries, and it
            // is the same angle for a straight sensor path, so it stands in.
            in_apertureDeg: truth?.geometry?.losSweepDeg,
        });
    }
    return out;
}

const CLASS_KEY = {balloon: "balloon", aircraft: "fixedWing", drone: "fixedWing"};
function classCorrect(objectClass, viableClasses) {
    const key = CLASS_KEY[objectClass];
    if (!key) return null;
    return (viableClasses ?? []).includes(key);
}

/** Parse a joined results JSONL, dropping the header line the pipeline writes. */
export function rowsFromJsonl(text) {
    const rows = [];
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const row = JSON.parse(trimmed);
            if (!row.header) rows.push(row);
        } catch (e) { /* one bad line must not lose the file */ }
    }
    return rows;
}

// ---------------------------------------------------------------------------
// the window
// ---------------------------------------------------------------------------

const css = (element, styles) => Object.assign(element.style, styles);

function makeButton(label, color = "#1976d2") {
    const button = document.createElement("button");
    button.textContent = label;
    css(button, {
        backgroundColor: color, color: "#fff", border: "none", borderRadius: "4px",
        padding: "6px 12px", fontSize: "13px", cursor: "pointer",
    });
    return button;
}

/**
 * Say WHY no figure could be built. Every figure compares cells, so one rung or
 * one clip length leaves nothing to compare, and a reader given a blank panel
 * has no way to tell that from a bug.
 */
function describeGap(rows) {
    if (!rows.length) {
        return " Load a joined results JSONL, or run BOTBench over a folder of scenarios and "
            + "press Charts.";
    }
    const rungs = [...new Set(rows.map((r) => r.d_errorDeg).filter((v) => Number.isFinite(v)))];
    const durations = [...new Set(rows.map((r) => r.d_durationSeconds).filter((v) => Number.isFinite(v)))];
    const classes = [...new Set(rows.map((r) => r.d_class).filter(Boolean))];
    const scored = rows.filter((r) => Number.isFinite(r.r_topRelSep)).length;
    const parts = [];
    parts.push(`<br><br>These rows cover <b>${rungs.length || "no"}</b> pointing-error rung`
        + `${rungs.length === 1 ? ` (${rungs[0]}\u00b0)` : "s"}, `
        + `<b>${durations.length || "no"}</b> clip length${durations.length === 1 ? ` (${durations[0]} s)` : "s"}, `
        + `and <b>${classes.length || "no"}</b> target class${classes.length === 1 ? ` (${classes[0]})` : "es"}. `
        + `${scored} of ${rows.length} have a score against truth.`);
    if (rungs.length < 2 && durations.length < 2) {
        parts.push("<br><br>Every figure compares one cell against another, so a single rung at a "
            + "single clip length leaves nothing to compare. Analyse a folder that spans several "
            + "rungs or several clip lengths, choosing the folder ABOVE them with Recursive on.");
    }
    if (!classes.length) {
        parts.push("<br><br>No target class could be worked out for any row, which usually means the "
            + "truth sidecars were not paired with the scenarios.");
    }
    if (!scored) {
        parts.push("<br><br>No row carries a score against truth, so there is nothing to plot. "
            + "The scenarios need their truth sidecars.");
    }
    return parts.join("");
}

export function openResultCharts(rows = null, {sourceLabel = ""} = {}) {
    if (activeWindow?.overlay?.parentNode) {
        document.body.removeChild(activeWindow.overlay);
        activeWindow = null;
    }
    const overlay = document.createElement("div");
    css(overlay, {
        position: "fixed", inset: "0", background: "rgba(0,0,0,0.5)", zIndex: "10000",
        display: "flex", alignItems: "center", justifyContent: "center",
    });
    const modal = document.createElement("div");
    css(modal, {
        background: "#fff", borderRadius: "8px", width: "94vw", height: "92vh",
        display: "flex", flexDirection: "column", overflow: "hidden",
        boxShadow: "0 8px 40px rgba(0,0,0,0.4)",
    });
    overlay.appendChild(modal);

    // toolbar
    const bar = document.createElement("div");
    css(bar, {
        display: "flex", gap: "8px", alignItems: "center", padding: "10px 12px",
        borderBottom: "1px solid #ddd", flexWrap: "wrap",
    });
    const picker = document.createElement("select");
    css(picker, {fontSize: "13px", padding: "5px 8px", minWidth: "300px"});
    const status = document.createElement("div");
    css(status, {fontSize: "12px", color: "#52514e", marginLeft: "auto"});
    const svgButton = makeButton("Export SVG", "#00695c");
    svgButton.title = "Vector, with the text still text. This is the format a journal wants.";
    const pngButton = makeButton("Export PNG", "#00695c");
    pngButton.title = "Raster at three times the layout size, about 4500 pixels wide, "
        + "which is past 300 dpi for a full-page figure.";
    const loadButton = makeButton("Load JSONL…", "#5c6bc0");
    loadButton.title = "Open a joined results JSONL, the file the offline pipeline writes.";
    const closeButton = makeButton("Close", "#757575");
    bar.append(picker, loadButton, svgButton, pngButton, closeButton, status);
    modal.appendChild(bar);

    // plot area
    const plot = document.createElement("div");
    css(plot, {flex: "1", minHeight: "0", overflow: "auto", background: "#fff"});
    modal.appendChild(plot);
    const chart = document.createElement("div");
    plot.appendChild(chart);

    const state = {overlay, rows: rows ?? [], figures: [], current: null, sourceLabel};

    const setStatus = (text) => { status.textContent = text; };

    const rebuild = async () => {
        picker.innerHTML = "";
        state.figures = buildAllFigures(state.rows);
        if (!state.figures.length) {
            setStatus(`${state.rows.length} row(s), no figure`);
            chart.innerHTML = `<div style='padding:40px;color:#444;max-width:60em;line-height:1.6'>`
                + `<b>Nothing to draw from these ${state.rows.length} row(s).</b>${describeGap(state.rows)}</div>`;
            return;
        }
        for (const figure of state.figures) {
            const option = document.createElement("option");
            option.value = figure.key;
            const meta = FIGURES.find((f) => f.key === figure.key);
            option.textContent = meta ? `${meta.group}: ${meta.name}` : figure.key;
            picker.appendChild(option);
        }
        await show(state.figures[0]);
    };

    const show = async (figure) => {
        state.current = figure;
        if (figure.error) {
            chart.innerHTML = `<div style='padding:40px;color:#b00'>${figure.key}: ${figure.error}</div>`;
            return;
        }
        setStatus(`${state.rows.length} rows${state.sourceLabel ? ` from ${state.sourceLabel}` : ""} — drawing…`);
        try {
            await drawFigure(chart, figure);
            setStatus(`${state.rows.length} rows${state.sourceLabel ? ` from ${state.sourceLabel}` : ""}`);
        } catch (error) {
            setStatus("");
            showError(`Could not draw the chart: ${error?.message ?? error}`);
        }
    };

    picker.addEventListener("change", () => {
        const figure = state.figures.find((f) => f.key === picker.value);
        if (figure) show(figure);
    });

    const exportAs = async (format) => {
        if (!state.current) return;
        setStatus(`Rendering ${format.toUpperCase()}…`);
        try {
            const url = await figureToImage(state.current, {format});
            const link = document.createElement("a");
            link.href = url;
            link.download = `${state.current.key}.${format}`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setStatus(`${format.toUpperCase()} saved.`);
        } catch (error) {
            showError(`Export failed: ${error?.message ?? error}`);
            setStatus("");
        }
    };
    svgButton.addEventListener("click", () => exportAs("svg"));
    pngButton.addEventListener("click", () => exportAs("png"));

    loadButton.addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".jsonl,.json,.txt";
        input.addEventListener("change", async () => {
            const file = input.files?.[0];
            if (!file) return;
            setStatus(`Reading ${file.name}…`);
            state.rows = rowsFromJsonl(await file.text());
            state.sourceLabel = file.name;
            await rebuild();
        });
        input.click();
    });

    // Dropping the file on the window does the same thing, since that is how
    // anyone with the file in a folder will reach for it first.
    overlay.addEventListener("dragover", (event) => { event.preventDefault(); });
    overlay.addEventListener("drop", async (event) => {
        event.preventDefault();
        const file = event.dataTransfer?.files?.[0];
        if (!file) return;
        setStatus(`Reading ${file.name}…`);
        state.rows = rowsFromJsonl(await file.text());
        state.sourceLabel = file.name;
        await rebuild();
    });

    const close = () => {
        purgeFigure(chart);
        if (overlay.parentNode) document.body.removeChild(overlay);
        activeWindow = null;
    };
    closeButton.addEventListener("click", close);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });

    document.body.appendChild(overlay);
    activeWindow = state;
    setStatus("Loading the chart library…");
    loadPlotly().then(rebuild).catch((error) => {
        showError(`Could not load the chart library: ${error?.message ?? error}`);
    });
    return state;
}

/** Open the window on the entries of a BOT Bench run that has just finished. */
export function openResultChartsForEntries(entries) {
    const rows = rowsFromBotBenchEntries(entries.filter((e) => e.status === "done"));
    return openResultCharts(rows, {sourceLabel: "this BOTBench run"});
}

/** Add "Result Charts..." to the File Analysis folder. Idempotent. */
let chartsController = null;
export function addResultChartsMenu(fileAnalysisFolder) {
    if (!fileAnalysisFolder || chartsController) return chartsController;
    if (isLocal && !window._botCharts) {
        window._botCharts = {
            open: openResultCharts, openForEntries: openResultChartsForEntries,
            rowsFromJsonl, rowsFromBotBenchEntries, buildAllFigures,
        };
    }
    chartsController = fileAnalysisFolder.add({charts: () => openResultCharts()}, "charts")
        .name("Result Charts...")
        .tooltip("Interactive charts of a BOT Bench result set: accuracy against clip length and pointing "
            + "error, what the verdict concluded, and what ranking blind cost. Drop a joined results JSONL "
            + "on the window, or open it from a finished run. Export SVG or a 300 dpi PNG for a paper.")
        .perm();
    return chartsController;
}
