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
// Error controls select whose error (the blind top candidate, the best candidate,
// or one solver), its unit and a log or linear scale. See makeMeasure in RockV3ChartSpecs.
//
// Hovering a track's dot shows its scenario screenshot beside Plotly's label, when
// the run made one (see wireHoverImages).
//
// Full size shows one figure on the whole browser window, drawn to fit it, with
// only the choices that figure reads. The export is unchanged: it still renders the
// figure at its own layout size.

import {
    buildAllFigures, FIGURES, CLASSES, ERROR_METRICS, SUBJECT_BEST, SUBJECT_TOP, makeMeasure, wrapText,
} from "./RockV3ChartSpecs";
import {drawFigure, purgeFigure, figureToImage, loadPlotly} from "./PlotlyLoader";
import {showError} from "../../showError";
import {isLocal} from "../../configUtils";
import {imageDirFor, imageNameFor} from "../BotBenchImageCapture";
import {chooseSolverSelection, loadStoredSolvers, solverButtonText, storeSolvers} from "../BotBenchSolverDialog";
import {normalizeSolvers} from "../BotBenchSolvers";
// The adapter is pure data, kept apart so it can be tested without a DOM. Re-exported
// for anything that imported it from here.
import {filterRowsToSolvers, rowsFromBotBenchEntries, rowsFromJsonl} from "./BotBenchChartRows";
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

// The width the figures are laid out for, and the caption wrap that goes with it
// (pageLayout in RockV3ChartSpecs). A figure drawn wider or narrower re-wraps its
// caption in proportion, so the text still fills the width without running off it.
const LAYOUT_WIDTH = 1500;
const CAPTION_COLS = 165;

/**
 * A copy of a figure laid out for a given size. The panels scale with the plot
 * area; the margins stay in pixels, so the title, legend and caption keep their
 * size. The caption is the last paper annotation and is re-wrapped for the width.
 */
export function fitFigureTo(figure, width, height) {
    const layout = {...figure.layout, width, height};
    const annotations = (layout.annotations ?? []).slice();
    const caption = annotations[annotations.length - 1];
    if (caption && caption.xref === "paper" && caption.yanchor === "top" && typeof caption.text === "string") {
        const cols = Math.max(40, Math.round(CAPTION_COLS * width / LAYOUT_WIDTH));
        annotations[annotations.length - 1] = {...caption, text: wrapText(caption.text.replace(/<br>/g, " "), cols)};
    }
    layout.annotations = annotations;
    return {...figure, layout};
}

/**
 * Return a copy whose layout height is a percentage of the figure's authored
 * height. Always start from the authored figure so dragging the control back
 * and forth cannot compound previous scaling.
 */
export function scaleFigureHeight(figure, percent = 100) {
    const baseHeight = Number(figure?.layout?.height);
    if (!Number.isFinite(baseHeight) || baseHeight <= 0) return figure;
    const requested = Number(percent);
    const scale = Math.min(2, Math.max(0.5, Number.isFinite(requested) ? requested / 100 : 1));
    return fitFigureTo(figure, Number(figure.layout.width) || LAYOUT_WIDTH, Math.round(baseHeight * scale));
}

/** Return a copy with every X axis drawn in the opposite direction. */
export function flipFigureXAxis(figure, flipped = false) {
    if (!flipped || !figure?.layout) return figure;
    const layout = {...figure.layout};
    for (const [name, axis] of Object.entries(figure.layout)) {
        if (!/^xaxis\d*$/.test(name) || !axis || typeof axis !== "object") continue;
        if (Array.isArray(axis.range) && axis.range.length >= 2) {
            layout[name] = {...axis, range: [...axis.range].reverse()};
        } else {
            layout[name] = {...axis, autorange: axis.autorange === "reversed" ? true : "reversed"};
        }
    }
    return {...figure, layout};
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
        const row = Number.isInteger(id) ? state.chartRows[id] : null;
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

export function openResultCharts(rows = null, {sourceLabel = "", selectedSolvers = null, onSolversChanged = null} = {}) {
    if (activeWindow?.overlay?.parentNode) {
        document.body.removeChild(activeWindow.overlay);
        activeWindow = null;
    }
    const overlay = document.createElement("div");
    css(overlay, {
        position: "fixed", inset: "0", background: "rgba(0,0,0,0.5)", zIndex: "10000",
        display: "flex", alignItems: "center", justifyContent: "center",
    });
    // The InteractionRouter owns document wheel events and hands each one to the view under
    // the pointer, which zooms and cancels the scroll, so the wheel did nothing here. Declared
    // native, as the traverse gallery is, the wheel scrolls the figure.
    overlay.dataset.interactionNative = "true";
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
    const makeToggle = (text, title) => {
        const label = document.createElement("label");
        css(label, {display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "#333",
            cursor: "pointer", whiteSpace: "nowrap"});
        label.title = title;
        const box = document.createElement("input");
        box.type = "checkbox";
        label.append(box, text);
        return {label, box};
    };
    const makeRangeControl = (text, title, {min, max, step, value, width = "76px", format}) => {
        const label = document.createElement("label");
        label.title = title;
        css(label, {display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "#333",
            whiteSpace: "nowrap"});
        const input = document.createElement("input");
        input.type = "range";
        Object.assign(input, {min: String(min), max: String(max), step: String(step), value: String(value)});
        input.setAttribute("aria-label", text);
        css(input, {width, margin: "0"});
        const output = document.createElement("span");
        css(output, {display: "inline-block", minWidth: "34px", textAlign: "right"});
        const update = () => { output.textContent = format(Number(input.value)); };
        update();
        label.append(text, input, output);
        return {label, input, output, update};
    };
    const logToggle = makeToggle("log Error",
        "Use logarithmic error axes. Uncheck for linear error axes starting at zero. "
        + "Heading error always uses its fixed 0–180 degree scale.");
    logToggle.box.checked = true;
    const boxControl = makeRangeControl("Box", "The central percentage enclosed by each box. "
        + "50% is the conventional first-to-third-quartile box.",
    {min: 20, max: 90, step: 5, value: 50, format: (value) => `${value}%`});
    const whiskerControl = makeRangeControl("Whisker", "How far each whisker fence extends beyond the box, "
        + "as a multiple of the box span. 1.5× with a 50% box is Tukey's standard 1.5×IQR rule.",
    {min: 0, max: 3, step: 0.1, value: 1.5, format: (value) => `${value.toFixed(1)}×`});
    const whiskerSpaceControl = document.createElement("label");
    whiskerSpaceControl.title = "On a logarithmic error axis, compute the whisker fence on the raw values, "
        + "as standard plotting packages do, or in log10 space for visual symmetry.";
    css(whiskerSpaceControl, {display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "#333",
        whiteSpace: "nowrap"});
    const whiskerSpacePicker = makeSelect(whiskerSpaceControl.title, "105px");
    for (const [value, text] of [["raw", "Raw values"], ["axis", "Axis space"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        whiskerSpacePicker.appendChild(option);
    }
    whiskerSpaceControl.append("Fence", whiskerSpacePicker);
    // Two ways to mark the dots, both off to begin with (makeMarks in RockV3ChartSpecs.js).
    const lengthToggle = makeToggle("Area by clip length",
        "Give each track dot an area in proportion to its clip length, on one scale for every figure.");
    const straightToggle = makeToggle("Straight as black squares",
        "Draw a track whose sensor flew straight (turn level 0, or a turn under 1 degree) as a black square "
        + "with the same area as a circle.");
    const flipXToggle = makeToggle("Flip X Axis",
        "Reverse the direction of every X axis in the current chart and in SVG and PNG exports.");
    const selectedToggle = makeToggle("Selected Solvers",
        "Limit candidate-backed chart values to the solvers ticked in the adjacent selector. "
        + "The selected top and best candidates are recalculated within that subset.");
    const initialSolvers = normalizeSolvers(selectedSolvers ?? loadStoredSolvers());
    const solversButton = makeButton(solverButtonText(initialSolvers), "#5c6bc0");
    solversButton.title = "Choose the solvers included when Selected Solvers is checked.";
    const fullButton = makeButton("Full size", "#455a64");
    fullButton.title = "Show this figure alone, drawn to fill the browser window, with only the choices it reads. "
        + "Exports are unchanged.";
    const heightControl = document.createElement("label");
    heightControl.title = "Scale the chart height from 50% to 200%. This also changes exported chart height.";
    css(heightControl, {display: "flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "#333",
        whiteSpace: "nowrap"});
    const heightInput = document.createElement("input");
    heightInput.type = "range";
    heightInput.min = "50";
    heightInput.max = "200";
    heightInput.step = "10";
    heightInput.value = "100";
    heightInput.setAttribute("aria-label", "Chart height percentage");
    css(heightInput, {width: "90px", margin: "0"});
    const heightValue = document.createElement("span");
    heightValue.textContent = "100%";
    css(heightValue, {display: "inline-block", width: "34px", textAlign: "right"});
    heightControl.append("Height", heightInput, heightValue);
    bar.append(picker, subjectPicker, metricPicker, logToggle.label, boxControl.label, whiskerControl.label,
        whiskerSpaceControl, turnPicker, lengthToggle.label, straightToggle.label,
        selectedToggle.label, solversButton, flipXToggle.label, heightControl, fullButton,
        loadButton, svgButton, pngButton, closeButton, status);
    modal.appendChild(bar);

    // plot area
    const plot = document.createElement("div");
    css(plot, {flex: "1", minHeight: "0", overflow: "auto", background: "#fff"});
    modal.appendChild(plot);
    const chart = document.createElement("div");
    plot.appendChild(chart);

    const state = {
        overlay, rows: rows ?? [], chartRows: rows ?? [], figures: [], current: null, sourceLabel,
        imageUrls: new Map(), measure: makeMeasure(), turnDeg: null, turnLevels: [],
        marks: {sizeByLength: false, markStraight: false},
        selectedSolvers: initialSolvers, selectedOnly: false, onSolversChanged,
        flipX: false,
        heightPercent: 100, heightInput, heightValue, boxControl, whiskerControl, whiskerSpacePicker, fullSize: false,
    };
    const currentMeasure = () => {
        const fixedMetric = FIGURES.find((f) => f.key === state.current?.key)?.fixedMetric;
        return fixedMetric ? makeMeasure({metric: fixedMetric, subject: state.measure.subject,
            logError: state.measure.logError, boxPercent: state.measure.boxPercent,
            whiskerK: state.measure.whiskerK, whiskerSpace: state.measure.whiskerSpace}) : state.measure;
    };
    const canChooseErrorScale = () => {
        const meta = FIGURES.find((f) => f.key === state.current?.key);
        return (meta?.measure === "full" || !!meta?.fixedMetric) && !ERROR_METRICS[currentMeasure().metric].axis;
    };

    // The window's chrome in the two modes. Full size fills the browser window and
    // shows, of the choices, only those the current figure reads; the figure picker
    // and the file loader are hidden, since the view is of one figure.
    const applyChrome = () => {
        const full = state.fullSize;
        const meta = state.current ? FIGURES.find((f) => f.key === state.current.key) : null;
        css(modal, full
            ? {width: "100vw", height: "100vh", borderRadius: "0"}
            : {width: "94vw", height: "92vh", borderRadius: "8px"});
        const hide = (el, hidden) => { el.style.display = hidden ? "none" : ""; };
        hide(picker, full);
        hide(loadButton, full);
        const usesMeasure = !full || !!meta?.measure;
        hide(subjectPicker, !state.chartRows.length || !usesMeasure);
        hide(metricPicker, !state.chartRows.length || !usesMeasure || !!meta?.fixedMetric || (full && meta?.measure !== "full"));
        hide(logToggle.label, !state.chartRows.length || (full && !canChooseErrorScale()));
        logToggle.box.disabled = !canChooseErrorScale();
        const usesBoxes = !!state.current?.data?.some((trace) => trace.type === "box");
        hide(boxControl.label, !usesBoxes);
        hide(whiskerControl.label, !usesBoxes);
        hide(whiskerSpaceControl, !usesBoxes || !!currentMeasure().axis);
        hide(turnPicker, state.turnLevels.length < 2 || (full && !!meta?.allTurnLevels));
        hide(lengthToggle.label, full && !meta?.dots);
        hide(straightToggle.label, full && !meta?.dots);
        hide(heightControl, full);
        fullButton.textContent = full ? "Exit full size" : "Full size";
        fullButton.style.display = state.current ? "" : "none";
    };
    // Always use the available width, so a three-panel figure reaches the right
    // edge of the results window instead of retaining its 1500 px export width.
    // Normal mode keeps the authored/slider height; full size also fills height.
    const figureToDraw = (figure) => {
        const oriented = flipFigureXAxis(figure, state.flipX);
        const width = Math.max(320, plot.clientWidth - 2);
        if (!state.fullSize) {
            const scaled = scaleFigureHeight(oriented, state.heightPercent);
            return fitFigureTo(scaled, width, scaled.layout.height);
        }
        const height = Math.max(240, plot.clientHeight - 2);
        return fitFigureTo(oriented, width, height);
    };
    let resizeTimer = null;
    const onResize = () => {
        if (!state.current) return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { show(state.current); }, 120);
    };
    window.addEventListener("resize", onResize);

    const setStatus = (text) => { status.textContent = text; };
    const boxSettingsSuffix = (separator = " — ") => {
        if (!state.current?.data?.some((trace) => trace.type === "box")) return "";
        const measure = currentMeasure();
        if (measure.boxPercent === 50 && measure.whiskerK === 1.5 && measure.whiskerSpace === "raw") return "";
        return `${separator}box ${measure.boxPercent}%, whiskers ${measure.whiskerK}× ${measure.axis ? "raw" : measure.whiskerSpace}`;
    };
    const sourceText = () => {
        const measure = currentMeasure();
        return `${state.chartRows.length} rows${state.sourceLabel ? ` from ${state.sourceLabel}` : ""}`
            + (state.selectedOnly ? ` — ${solverButtonText(state.selectedSolvers).replace("Solvers: ", "")}` : "")
            + (measure.isDefault ? "" : ` — ${measure.who}, ${measure.label.toLowerCase()}`)
            + (state.turnLevels.length < 2 ? ""
                : Number.isFinite(state.turnDeg) ? ` — sensor turn ${state.turnDeg}°`
                : ` — ${state.turnLevels.length} sensor-turn levels pooled`)
            + (state.flipX ? " — X axis flipped" : "")
            + boxSettingsSuffix();
    };

    // The choices, filled from what the rows can support. A choice that is no
    // longer offered falls back to the default rather than drawing empty figures.
    const fillChoices = () => {
        const names = candidateNames(state.chartRows);
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
            option.disabled = !!spec.needsLists && !hasLists;
            metricPicker.appendChild(option);
        }
        const keepMetric = metricPicker.querySelector(`option[value="${state.measure.metric}"]:not([disabled])`)
            ? state.measure.metric : "relSep";
        metricPicker.value = keepMetric;
        subjectPicker.style.display = state.chartRows.length ? "" : "none";
        metricPicker.style.display = state.chartRows.length ? "" : "none";
        state.measure = makeMeasure({metric: keepMetric, subject: keepSubject, logError: logToggle.box.checked,
            boxPercent: Number(boxControl.input.value), whiskerK: Number(whiskerControl.input.value),
            whiskerSpace: whiskerSpacePicker.value});
        // A sensor-turn level, offered only when the rows hold more than one.
        state.turnLevels = [...new Set(state.chartRows.map((r) => r.d_turnDeg).filter(Number.isFinite))]
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
        applyChrome();
    };

    const rebuild = async () => {
        const keepKey = state.current?.key ?? null;
        picker.innerHTML = "";
        state.chartRows = state.selectedOnly
            ? filterRowsToSolvers(state.rows, state.selectedSolvers) : state.rows;
        // Every row's index, which the figures put on each dot so the hover can find
        // the row again (see wireHoverImages).
        state.chartRows.forEach((row, i) => { row.rowIndex = i; });
        fillChoices();
        state.figures = buildAllFigures(state.chartRows, {measure: state.measure, turnDeg: state.turnDeg, marks: state.marks});
        const rungKnown = state.chartRows.some((r) => Number.isFinite(r.d_errorDeg));
        const unpaired = state.chartRows.some((r) => r.in_sidecarPaired === false);
        state.note = state.chartRows.length && !rungKnown
            ? ` — pointing error unstated${unpaired ? " (no scenario sidecars paired)" : ""}` : "";
        if (!state.figures.length) {
            state.current = null;
            setStatus(`${state.chartRows.length} row(s), no figure`);
            chart.innerHTML = `<div style='padding:40px;color:#444;max-width:60em;line-height:1.6'>`
                + `<b>Nothing to draw from these ${state.chartRows.length} row(s).</b>${describeGap(state.chartRows)}</div>`;
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
        applyChrome();
        if (figure.error) {
            chart.innerHTML = `<div style='padding:40px;color:#b00'>${figure.key}: ${figure.error}</div>`;
            return;
        }
        setStatus(`${sourceText()} — drawing…`);
        try {
            await drawFigure(chart, figureToDraw(figure));
            wireHoverImages(state, chart);
            setStatus(sourceText() + (state.note ?? "") + (state.fullSize ? " — full size" : ""));
        } catch (error) {
            setStatus("");
            showError(`Could not draw the chart: ${error?.message ?? error}`);
        }
    };
    fullButton.addEventListener("click", () => {
        state.fullSize = !state.fullSize;
        applyChrome();
        if (state.current) show(state.current);
    });
    let heightTimer = null;
    heightInput.addEventListener("input", () => {
        state.heightPercent = Number(heightInput.value);
        heightValue.textContent = `${state.heightPercent}%`;
        clearTimeout(heightTimer);
        heightTimer = setTimeout(() => { if (state.current) show(state.current); }, 50);
    });

    picker.addEventListener("change", () => {
        const figure = state.figures.find((f) => f.key === picker.value);
        if (figure) show(figure);
    });
    const onChoice = () => {
        state.measure = makeMeasure({metric: metricPicker.value, subject: subjectPicker.value,
            logError: logToggle.box.checked, boxPercent: Number(boxControl.input.value),
            whiskerK: Number(whiskerControl.input.value), whiskerSpace: whiskerSpacePicker.value});
        state.turnDeg = turnPicker.value === "all" ? null : Number(turnPicker.value);
        state.marks = {sizeByLength: lengthToggle.box.checked, markStraight: straightToggle.box.checked};
        rebuild();
    };
    subjectPicker.addEventListener("change", onChoice);
    metricPicker.addEventListener("change", onChoice);
    logToggle.box.addEventListener("change", onChoice);
    turnPicker.addEventListener("change", onChoice);
    lengthToggle.box.addEventListener("change", onChoice);
    straightToggle.box.addEventListener("change", onChoice);
    flipXToggle.box.addEventListener("change", () => {
        state.flipX = flipXToggle.box.checked;
        // Rebuild the figure list as well as changing the displayed layout. This
        // gives Plotly a fresh specification and forces the axis direction to be
        // redrawn immediately, including after an interactive zoom or pan.
        rebuild();
    });
    let boxTimer = null;
    const onBoxInput = () => {
        boxControl.update();
        whiskerControl.update();
        clearTimeout(boxTimer);
        boxTimer = setTimeout(onChoice, 50);
    };
    boxControl.input.addEventListener("input", onBoxInput);
    whiskerControl.input.addEventListener("input", onBoxInput);
    whiskerSpacePicker.addEventListener("change", onChoice);
    selectedToggle.box.addEventListener("change", () => {
        state.selectedOnly = selectedToggle.box.checked;
        rebuild();
    });
    solversButton.addEventListener("click", async () => {
        const ids = await chooseSolverSelection(state.selectedSolvers, {charts: true});
        if (!ids) return;
        state.selectedSolvers = storeSolvers(ids);
        solversButton.textContent = solverButtonText(state.selectedSolvers);
        state.onSolversChanged?.(state.selectedSolvers);
        if (state.selectedOnly) rebuild();
    });

    const exportAs = async (format) => {
        if (!state.current) return;
        setStatus(`Rendering ${format.toUpperCase()}…`);
        try {
            const exportFigure = flipFigureXAxis(scaleFigureHeight(state.current, state.heightPercent), state.flipX);
            const url = await figureToImage(exportFigure, {format});
            const link = document.createElement("a");
            link.href = url;
            // The choice goes in the name, so two exports of one figure do not collide.
            // A turn level too, except on the figures that always use every level.
            const measure = currentMeasure();
            const choice = (measure.isDefault ? ""
                : `-${measure.metric}-${String(measure.subject).replace(/[^A-Za-z0-9]+/g, "_")}`)
                + (canChooseErrorScale() && !measure.logError ? "-linear" : "")
                + (Number.isFinite(state.turnDeg) && !FIGURES.find((f) => f.key === state.current.key)?.allTurnLevels
                    ? `-turn${state.turnDeg}` : "")
                + (state.marks.sizeByLength ? "-area" : "") + (state.marks.markStraight ? "-straight" : "")
                + (state.flipX ? "-flipx" : "")
                + boxSettingsSuffix("-").replace(/[ .×%]+/g, "_");
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
        window.removeEventListener("resize", onResize);
        clearTimeout(resizeTimer);
        clearTimeout(heightTimer);
        clearTimeout(boxTimer);
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
export function openResultChartsForEntries(entries, options = {}) {
    const rows = rowsFromBotBenchEntries(entries.filter((e) => e.status === "done"));
    return openResultCharts(rows, {sourceLabel: "this BOTBench run", ...options});
}

/** Add "Result Charts..." to the File Analysis folder. Idempotent. */
let chartsController = null;
export function addResultChartsMenu(fileAnalysisFolder) {
    if (!fileAnalysisFolder || chartsController) return chartsController;
    if (isLocal && !window._botCharts) {
        window._botCharts = {
            open: openResultCharts, openForEntries: openResultChartsForEntries,
            rowsFromJsonl, rowsFromBotBenchEntries, buildAllFigures, makeMeasure, fitFigureTo, scaleFigureHeight,
            flipFigureXAxis,
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
