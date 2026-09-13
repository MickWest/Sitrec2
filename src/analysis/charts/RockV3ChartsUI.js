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
//
// Two choices apply to every error figure at once: whose error (the blind top
// candidate, the best candidate, or one solver) and in what unit (a share of range,
// metres, or degrees). See makeMeasure in RockV3ChartSpecs.
//
// Hovering a track's dot shows its scenario screenshot beside Plotly's label, when
// the run made one (see wireHoverImages).

import {
    buildAllFigures, FIGURES, CLASSES, ERROR_METRICS, SUBJECT_BEST, SUBJECT_TOP, makeMeasure,
} from "./RockV3ChartSpecs";
import {drawFigure, purgeFigure, figureToImage, loadPlotly} from "./PlotlyLoader";
import {showError} from "../../showError";
import {isLocal} from "../../configUtils";
import {imageDirFor, imageNameFor} from "../BotBenchImageCapture";
// The adapter is pure data, kept apart so it can be tested without a DOM. Re-exported
// for anything that imported it from here.
import {rowsFromBotBenchEntries, rowsFromJsonl} from "./BotBenchChartRows";
export {rowsFromBotBenchEntries, rowsFromJsonl};

let activeWindow = null;

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

function makeSelect(title, minWidth) {
    const select = document.createElement("select");
    select.title = title;
    css(select, {fontSize: "13px", padding: "5px 8px", minWidth});
    return select;
}

/**
 * Say WHY no figure could be built, from what the rows actually contain.
 *
 * A blank window cannot be told apart from a bug, and a wrong reason is worse than
 * none: an earlier version told a 300-track run it had "no clip lengths" when the
 * lengths were on every row and the adapter had simply not read them.
 */
function describeGap(rows) {
    if (!rows.length) {
        return " Load a joined results JSONL, or run BOTBench over a folder of scenarios and press Charts.";
    }
    const scored = rows.filter((r) => Number.isFinite(r.r_topRelSep)).length;
    const classes = [...new Set(rows.map((r) => r.d_class).filter((c) => CLASSES.includes(c)))];
    const parts = [];
    if (!scored) {
        parts.push("<br><br>None of them has a score against truth, and every figure plots error against "
            + "truth. BOTBench scores a file only when it carries the true target positions.");
    }
    if (!classes.length) {
        parts.push("<br><br>No target class could be worked out for any of them. The figures group by class, "
            + "which comes from the answer-key sidecar or from a file named by class "
            + `(${CLASSES.map((c) => `${c}_001`).join(", ")}).`);
    }
    if (!parts.length) {
        parts.push(`<br><br>${scored} of ${rows.length} are scored and ${classes.length} class(es) were found, `
            + "so a figure should have been drawn. That is a fault in the charts, not in the data.");
    }
    return parts.join("");
}

/** The solver names the rows' candidate lists hold, in order of first appearance. */
function candidateNames(rows) {
    const names = [];
    const seen = new Set();
    for (const row of rows) {
        for (const c of row.r_candidates ?? []) {
            if (c?.name && !seen.has(c.name)) { seen.add(c.name); names.push(c.name); }
        }
    }
    return names;
}

// ---------------------------------------------------------------------------
// the screenshot beside the hover label
// ---------------------------------------------------------------------------

// The image's width in the hover panel, in CSS pixels. Captures are 1024 px wide.
const HOVER_IMAGE_WIDTH = 320;
// Object URLs kept per window, most recently used last. Each one keeps a JPEG alive,
// so a quick sweep of the pointer over thousands of dots must not keep them all.
const HOVER_IMAGE_CACHE = 60;

/**
 * The scenario screenshot for a row, as an object URL, or null when there is none.
 * Only a row made from a BOTBench run over a chosen folder can have one: its image is
 * read from the SitrecImage folder the run's screenshots were written to.
 */
async function hoverImageUrl(state, row) {
    const entry = row?.entry;
    if (!entry) return null;
    const key = entry.relativePath ?? entry.name;
    if (state.imageUrls.has(key)) {
        const url = state.imageUrls.get(key);
        state.imageUrls.delete(key);
        state.imageUrls.set(key, url);
        return url;
    }
    let url = null;
    try {
        const dir = await imageDirFor(entry, {create: false});
        if (dir) {
            const file = await (await dir.getFileHandle(imageNameFor(entry.name))).getFile();
            url = URL.createObjectURL(file);
        }
    } catch (e) { /* this scenario has no screenshot */ }
    state.imageUrls.set(key, url);
    while (state.imageUrls.size > HOVER_IMAGE_CACHE) {
        const [oldest, oldUrl] = state.imageUrls.entries().next().value;
        if (oldUrl) URL.revokeObjectURL(oldUrl);
        state.imageUrls.delete(oldest);
    }
    return url;
}

/**
 * Show the scenario screenshot beside Plotly's hover label.
 *
 * Plotly's label holds text only, so the image goes in a panel of its own that
 * follows the pointer. A dot finds its row through `customdata`, which the figure
 * specifications set to the row's index; a figure whose points are not tracks sets
 * none, and nothing is shown for it.
 */
function wireHoverImages(state, chart) {
    if (chart.__botHoverImages || typeof chart.on !== "function") return;
    chart.__botHoverImages = true;

    const panel = document.createElement("div");
    css(panel, {
        position: "fixed", zIndex: "10001", pointerEvents: "none", display: "none",
        background: "#fff", border: "1px solid #c8c8c8", borderRadius: "6px",
        boxShadow: "0 4px 18px rgba(0,0,0,0.25)", padding: "4px",
    });
    const image = document.createElement("img");
    css(image, {display: "block", width: `${HOVER_IMAGE_WIDTH}px`, height: "auto"});
    const caption = document.createElement("div");
    css(caption, {
        font: "11px system-ui, sans-serif", color: "#333", padding: "3px 2px 0",
        maxWidth: `${HOVER_IMAGE_WIDTH}px`, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    });
    panel.append(image, caption);
    state.overlay.appendChild(panel);

    let pending = 0;
    let lastPointer = null;
    // Beside the pointer, and turned back inside the window near an edge.
    const place = () => {
        if (!lastPointer) return;
        const gap = 18;
        const rect = panel.getBoundingClientRect();
        let x = lastPointer.clientX + gap;
        let y = lastPointer.clientY + gap;
        if (x + rect.width > window.innerWidth - 4) x = lastPointer.clientX - gap - rect.width;
        if (y + rect.height > window.innerHeight - 4) y = window.innerHeight - rect.height - 4;
        panel.style.left = `${Math.max(4, x)}px`;
        panel.style.top = `${Math.max(4, y)}px`;
    };
    // The size is known only once the image has loaded.
    image.addEventListener("load", place);

    chart.on("plotly_hover", async (event) => {
        const id = event?.points?.[0]?.customdata;
        const row = Number.isInteger(id) ? state.rows[id] : null;
        const mine = ++pending;
        if (event?.event) lastPointer = {clientX: event.event.clientX, clientY: event.event.clientY};
        const url = row ? await hoverImageUrl(state, row) : null;
        if (mine !== pending) return;           // the pointer has already moved on
        if (!url) {
            panel.style.display = "none";
            return;
        }
        if (image.src !== url) image.src = url;
        caption.textContent = row.entry.relativePath ?? row.base ?? "";
        panel.style.display = "block";
        place();
    });
    chart.on("plotly_unhover", () => {
        pending++;
        panel.style.display = "none";
    });
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
    const picker = makeSelect("The figure to show", "300px");
    const subjectPicker = makeSelect("Whose error the error figures plot: the candidate the blind ranking put "
        + "first, the candidate closest to truth (an oracle pick, knowable only with truth in hand), or one "
        + "solver's candidate on every track.", "220px");
    const metricPicker = makeSelect("The unit of error: a share of the mean true range, the mean 3D distance "
        + "from truth in metres, or the mean angle between the candidate and the truth as seen from the "
        + "sensor. The tolerance figures always use a share of range.", "190px");
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
    const turnPicker = makeSelect("Which sensor-turn level the figures use: every level pooled, or one level. "
        + "The figures that compare turn levels always use every level.", "150px");
    bar.append(picker, subjectPicker, metricPicker, turnPicker, loadButton, svgButton, pngButton, closeButton, status);
    modal.appendChild(bar);

    // plot area
    const plot = document.createElement("div");
    css(plot, {flex: "1", minHeight: "0", overflow: "auto", background: "#fff"});
    modal.appendChild(plot);
    const chart = document.createElement("div");
    plot.appendChild(chart);

    const state = {
        overlay, rows: rows ?? [], figures: [], current: null, sourceLabel,
        imageUrls: new Map(), measure: makeMeasure(), turnDeg: null, turnLevels: [],
    };

    const setStatus = (text) => { status.textContent = text; };
    const sourceText = () => `${state.rows.length} rows${state.sourceLabel ? ` from ${state.sourceLabel}` : ""}`
        + (state.measure.isDefault ? "" : ` — ${state.measure.who}, ${state.measure.label.toLowerCase()}`)
        + (state.turnLevels.length < 2 ? ""
            : Number.isFinite(state.turnDeg) ? ` — sensor turn ${state.turnDeg}°`
            : ` — ${state.turnLevels.length} sensor-turn levels pooled`);

    // The choices, filled from what the rows can support. A choice that is no
    // longer offered falls back to the default rather than drawing empty figures.
    const fillChoices = () => {
        const names = candidateNames(state.rows);
        const subjects = [
            [SUBJECT_TOP, "Top candidate (blind ranking)"],
            [SUBJECT_BEST, "Best candidate (oracle)"],
            ...names.map((name) => [name, name]),
        ];
        const keepSubject = subjects.some(([value]) => value === state.measure.subject) ? state.measure.subject : SUBJECT_TOP;
        subjectPicker.innerHTML = "";
        for (const [value, label] of subjects) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            subjectPicker.appendChild(option);
        }
        subjectPicker.value = keepSubject;
        // A solver's own error, and any angle, come from the candidate lists, which a
        // joined JSONL does not carry.
        const hasLists = names.length > 0;
        metricPicker.innerHTML = "";
        for (const [value, spec] of Object.entries(ERROR_METRICS)) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = spec.label;
            option.disabled = value === "angDeg" && !hasLists;
            metricPicker.appendChild(option);
        }
        const keepMetric = metricPicker.querySelector(`option[value="${state.measure.metric}"]:not([disabled])`)
            ? state.measure.metric : "relSep";
        metricPicker.value = keepMetric;
        subjectPicker.style.display = state.rows.length ? "" : "none";
        metricPicker.style.display = state.rows.length ? "" : "none";
        state.measure = makeMeasure({metric: keepMetric, subject: keepSubject});
        // A sensor-turn level, offered only when the rows hold more than one.
        state.turnLevels = [...new Set(state.rows.map((r) => r.d_turnDeg).filter(Number.isFinite))]
            .sort((a, b) => a - b);
        const keepTurn = state.turnLevels.includes(state.turnDeg) ? state.turnDeg : null;
        turnPicker.innerHTML = "";
        for (const [value, label] of [["all", "All turn levels"],
            ...state.turnLevels.map((turn) => [String(turn), `Sensor turn ${turn}°`])]) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            turnPicker.appendChild(option);
        }
        turnPicker.value = keepTurn === null ? "all" : String(keepTurn);
        turnPicker.style.display = state.turnLevels.length > 1 ? "" : "none";
        state.turnDeg = state.turnLevels.length > 1 ? keepTurn : null;
    };

    const rebuild = async () => {
        const keepKey = state.current?.key ?? null;
        picker.innerHTML = "";
        // Every row's index, which the figures put on each dot so the hover can find
        // the row again (see wireHoverImages).
        state.rows.forEach((row, i) => { row.rowIndex = i; });
        fillChoices();
        state.figures = buildAllFigures(state.rows, {measure: state.measure, turnDeg: state.turnDeg});
        const rungKnown = state.rows.some((r) => Number.isFinite(r.d_errorDeg));
        const unpaired = state.rows.some((r) => r.in_sidecarPaired === false);
        state.note = state.rows.length && !rungKnown
            ? ` — pointing error unstated${unpaired ? " (no scenario sidecars paired)" : ""}` : "";
        if (!state.figures.length) {
            state.current = null;
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
        // Stay on the figure being read when a choice changes, if it still builds.
        const next = state.figures.find((f) => f.key === keepKey) ?? state.figures[0];
        picker.value = next.key;
        await show(next);
    };

    const show = async (figure) => {
        state.current = figure;
        if (figure.error) {
            chart.innerHTML = `<div style='padding:40px;color:#b00'>${figure.key}: ${figure.error}</div>`;
            return;
        }
        setStatus(`${sourceText()} — drawing…`);
        try {
            await drawFigure(chart, figure);
            wireHoverImages(state, chart);
            setStatus(sourceText() + (state.note ?? ""));
        } catch (error) {
            setStatus("");
            showError(`Could not draw the chart: ${error?.message ?? error}`);
        }
    };

    picker.addEventListener("change", () => {
        const figure = state.figures.find((f) => f.key === picker.value);
        if (figure) show(figure);
    });
    const onChoice = () => {
        state.measure = makeMeasure({metric: metricPicker.value, subject: subjectPicker.value});
        state.turnDeg = turnPicker.value === "all" ? null : Number(turnPicker.value);
        rebuild();
    };
    subjectPicker.addEventListener("change", onChoice);
    metricPicker.addEventListener("change", onChoice);
    turnPicker.addEventListener("change", onChoice);

    const exportAs = async (format) => {
        if (!state.current) return;
        setStatus(`Rendering ${format.toUpperCase()}…`);
        try {
            const url = await figureToImage(state.current, {format});
            const link = document.createElement("a");
            link.href = url;
            // The choice goes in the name, so two exports of one figure do not collide.
            // A turn level too, except on the figures that always use every level.
            const choice = (state.measure.isDefault ? ""
                : `-${state.measure.metric}-${String(state.measure.subject).replace(/[^A-Za-z0-9]+/g, "_")}`)
                + (Number.isFinite(state.turnDeg) && !FIGURES.find((f) => f.key === state.current.key)?.allTurnLevels
                    ? `-turn${state.turnDeg}` : "");
            link.download = `${state.current.key}${choice}.${format}`;
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
        for (const url of state.imageUrls.values()) if (url) URL.revokeObjectURL(url);
        state.imageUrls.clear();
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
            rowsFromJsonl, rowsFromBotBenchEntries, buildAllFigures, makeMeasure,
            get active() { return activeWindow; },
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
