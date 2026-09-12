// RockV3ChartSpecs.js — the BOT Bench result figures, as plain Plotly specs.
//
// Every function here takes the joined result rows and returns
// `{key, title, data, layout, config, caption}` — plain objects, no Plotly
// import, no DOM. That is what lets the same figure be drawn interactively in
// the app, exported as a publication SVG from the same page, and rendered by
// the command-line tool, from one definition.
//
// The reference implementation is private/probes/RockV3Charts.py, which stays in
// the tree. Statistics come from ChartStats.js and match numpy and scipy; see
// the note at the top of that file for the two conventions that matter.
//
// PLOTLY NOTES that shaped the code:
//   * Boxes are drawn from PRECOMPUTED statistics: the `box` trace accepts
//     q1/median/q3 with explicit lowerfence/upperfence, so the Tukey-in-log-space
//     rule survives intact rather than being recomputed by the library.
//   * Category axes are NUMERIC (0, 1, 2 …) with tickvals/ticktext, not Plotly
//     category axes. Jittered strip points need fractional x, and a category
//     axis will not take one.
//   * Captions are annotations in paper coordinates with manual line breaks:
//     Plotly does not wrap annotation text.

import {
    boxStatsLog, clopperPearson, equalCountMedians, jitterOffsets, median, tally, finiteSorted,
} from "./ChartStats";

// ---------------------------------------------------------------------------
// theme, shared with the matplotlib reference so the two look related
// ---------------------------------------------------------------------------

export const CLASSES = ["balloon", "drone", "weather_balloon"];
export const CLASS_LABEL = {
    balloon: "Party balloon", drone: "Fixed-wing drone", weather_balloon: "Weather balloon",
};
export const CLASS_HUE = {balloon: "#2a78d6", drone: "#eb6834", weather_balloon: "#1baf7a"};
export const MIX_HUES = ["#2a78d6", "#eb6834", "#1baf7a", "#8e5bd6", "#d6a12a", "#c23f6e", "#4fa3c9", "#8f8c84"];
export const INK = "#0b0b0b", INK2 = "#52514e", MUTED = "#898781";
export const GRID = "#e1e0d9", AXIS = "#c3c2b7", SURFACE = "#fcfcfb";

export const RUNGS = [0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0];
export const FLOOR = 1e-4;          // drawing floor for a fraction-of-range axis
export const TOL5 = 0.05, TOL1 = 0.01;

const HALO = "rgba(255,255,255,0.82)";

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const same = (a, b) => fin(a) && fin(b) && Math.abs(a - b) < 1e-9;
const atLeast = (v, floor) => Math.max(v, floor);

export function formatPercent(v) {
    if (!fin(v)) return "-";
    if (v < FLOOR) return `<${FLOOR * 100}%`;
    if (v >= 0.1) return `${(v * 100).toFixed(0)}%`;
    if (v >= 0.01) return `${(v * 100).toFixed(1)}%`;
    return `${(v * 100).toPrecision(2)}%`;
}

export const rungLabel = (e) => `${e}°`;

/** Wrap text at roughly `cols` characters, for a caption annotation. */
export function wrapText(text, cols = 165) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = "";
    for (const word of words) {
        if (line && line.length + 1 + word.length > cols) { lines.push(line); line = word; }
        else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
    return lines.join("<br>");
}

/** Rows in one (class, clip length, rung) cell; any argument may be omitted. */
export function cell(rows, cls = null, duration = null, rung = null) {
    return rows.filter((r) =>
        (cls === null || r.d_class === cls)
        && (duration === null || same(r.d_durationSeconds, duration))
        && (rung === null || same(r.d_errorDeg, rung)));
}

export const durationsOf = (rows) =>
    [...new Set(rows.map((r) => r.d_durationSeconds).filter(fin))].sort((a, b) => a - b);
export const rungsOf = (rows) =>
    RUNGS.filter((e) => rows.some((r) => same(r.d_errorDeg, e)));

/** k of n rows whose `field` is finite and under `tol`; n counts every row. */
export function withinTolerance(rows, tol, field = "r_topRelSep") {
    return {k: rows.filter((r) => fin(r[field]) && r[field] < tol).length, n: rows.length};
}

// ---------------------------------------------------------------------------
// trace builders
// ---------------------------------------------------------------------------

/**
 * A box drawn from statistics I computed, not from the sample.
 *
 * Passing q1/median/q3 puts Plotly in its precomputed signature, where
 * lowerfence and upperfence are taken literally rather than derived — which is
 * what keeps the log-space Tukey rule intact.
 */
export function boxTrace(positions, stats, color, {axis = "", width = 0.62, floor = null} = {}) {
    const keep = positions.map((x, i) => [x, stats[i]]).filter(([, s]) => s);
    // The floor is a DRAWING device, exactly as in the matplotlib reference: the
    // statistics are computed on the raw values and only the drawn geometry is
    // clipped. Without this a cell whose whole distribution sits at 1e-7 drags
    // the shared log axis down three decades and squashes every other panel.
    const clip = (v) => (floor === null ? v : Math.max(v, floor));
    return {
        type: "box",
        x: keep.map(([x]) => x),
        q1: keep.map(([, s]) => clip(s.q1)),
        median: keep.map(([, s]) => clip(s.median)),
        q3: keep.map(([, s]) => clip(s.q3)),
        lowerfence: keep.map(([, s]) => clip(s.lowerFence)),
        upperfence: keep.map(([, s]) => clip(s.upperFence)),
        fillcolor: hexToRgba(color, 0.25),
        line: {color, width: 1.1},
        marker: {color},
        median_color: INK,
        width,
        hoverinfo: "y",
        showlegend: false,
        xaxis: `x${axis}`, yaxis: `y${axis}`,
    };
}

/** Every observation as a jittered dot beside its box. Hollow marks a subset. */
export function stripTrace(positions, color, {axis = "", hollow = false, name = "", size = 5,
    text = null, seed = 805, amount = 0.26} = {}) {
    const offsets = jitterOffsets(positions.length, amount, seed);
    return {
        type: "scattergl",
        mode: "markers",
        x: positions.map((p, i) => p.x + offsets[i]),
        y: positions.map((p) => p.y),
        text,
        hovertemplate: text ? "%{text}<extra></extra>" : "%{y}<extra></extra>",
        marker: hollow
            ? {size: size + 2, color: "rgba(0,0,0,0)", line: {color, width: 1}}
            : {size, color, line: {color: "#ffffff", width: 0.4}},
        name,
        showlegend: false,
        xaxis: `x${axis}`, yaxis: `y${axis}`,
    };
}

/** A line of proportions with asymmetric 95% intervals. */
export function proportionTrace(xs, counts, color, name, {axis = "", dx = 0} = {}) {
    const points = counts.map((c, i) => ({x: xs[i] + dx, ...clopperPearson(c.k, c.n), k: c.k, n: c.n}))
        .filter((p) => fin(p.p));
    return {
        type: "scatter",
        mode: "lines+markers",
        x: points.map((p) => p.x),
        y: points.map((p) => p.p),
        error_y: {
            type: "data",
            symmetric: false,
            array: points.map((p) => p.hi - p.p),
            arrayminus: points.map((p) => p.p - p.lo),
            color, thickness: 1, width: 3,
        },
        text: points.map((p) => `${p.k} of ${p.n}`),
        hovertemplate: `${name}: %{text}, %{y:.0%}<extra></extra>`,
        line: {color, width: 1.6},
        marker: {color, size: 7},
        name,
        // Off unless the caller turns it on. The same three series repeat in every
        // panel, so leaving Plotly's default of true printed the legend once per
        // panel — twelve entries for three series.
        showlegend: false,
        legendgroup: name,
        xaxis: `x${axis}`, yaxis: `y${axis}`,
    };
}

function hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// ---------------------------------------------------------------------------
// layout scaffolding
// ---------------------------------------------------------------------------

/**
 * A grid of panels. Plotly has no facet primitive, so the domains are computed
 * here; every panel shares one y range by pointing at the first panel's axis
 * with `matches`.
 */
export function gridLayout({rows, cols, titles, xTitle, yTitle, tickvals, ticktext,
    logY = true, shareY = true, hGap = 0.055, vGap = 0.11, topPad = 0.9, bottomPad = 0.16,
    yRange = null}) {
    const layout = {};
    const panelW = (1 - hGap * (cols - 1)) / cols;
    const plotTop = topPad, plotBottom = bottomPad;
    const panelH = ((plotTop - plotBottom) - vGap * (rows - 1)) / rows;
    layout.annotations = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            const suffix = i === 0 ? "" : String(i + 1);
            const x0 = c * (panelW + hGap);
            const y1 = plotTop - r * (panelH + vGap);
            const y0 = y1 - panelH;
            layout[`xaxis${suffix}`] = {
                domain: [x0, x0 + panelW], anchor: `y${suffix}`,
                tickvals, ticktext,
                title: r === rows - 1 ? {text: xTitle, font: {size: 12, color: INK}} : undefined,
                gridcolor: "rgba(0,0,0,0)", zeroline: false,
                linecolor: AXIS, tickfont: {size: 11, color: INK2},
            };
            layout[`yaxis${suffix}`] = {
                domain: [y0, y1], anchor: `x${suffix}`,
                type: logY ? "log" : "linear",
                title: c === 0 ? {text: yTitle, font: {size: 12, color: INK}} : undefined,
                gridcolor: GRID, zeroline: false,
                linecolor: AXIS, tickfont: {size: 11, color: INK2},
                // Powers of ten. Plotly's default on a log axis is SI prefixes,
                // which turns 1e-4 into "100u" and reads as a unit, not a fraction.
                exponentformat: logY ? "power" : undefined,
                // One label per decade. Plotly adds 2/5 minor labels when a log
                // range is short, which on a six-decade stack of small panels is
                // more ink than information.
                dtick: logY ? 1 : undefined,
                range: logY && yRange ? yRange : undefined,
                matches: shareY && i > 0 ? "y" : undefined,
            };
            if (titles?.[i]) {
                layout.annotations.push({
                    x: x0, y: y1 + 0.022, xref: "paper", yref: "paper",
                    text: titles[i], showarrow: false, xanchor: "left", yanchor: "bottom",
                    font: {size: 12.5, color: INK},
                });
            }
        }
    }
    return layout;
}

/** The standard page furniture: title, caption, paper colors, margins. */
export function pageLayout(layout, {title, caption, height = 900, width = 1500}) {
    return {
        ...layout,
        title: {text: title, x: 0.005, xanchor: "left", font: {size: 16, color: INK}},
        annotations: [
            ...(layout.annotations ?? []),
            {
                x: 0, y: -0.02, xref: "paper", yref: "paper",
                text: wrapText(caption), showarrow: false,
                xanchor: "left", yanchor: "top", align: "left",
                font: {size: 10.5, color: INK2},
            },
        ],
        paper_bgcolor: "#ffffff",
        plot_bgcolor: SURFACE,
        height, width,
        margin: {l: 78, r: 24, t: 52, b: 130},
        showlegend: false,
        hovermode: "closest",
        boxgap: 0.35,
    };
}

/** A dashed reference line across one panel, with a haloed label. */
export function toleranceShapes(panelCount, value, label) {
    const shapes = [], annotations = [];
    for (let i = 0; i < panelCount; i++) {
        const suffix = i === 0 ? "" : String(i + 1);
        shapes.push({
            type: "line", xref: `x${suffix} domain`, yref: `y${suffix}`,
            x0: 0, x1: 1, y0: value, y1: value,
            line: {color: MUTED, width: 1, dash: "dot"}, layer: "below",
        });
        annotations.push({
            xref: `x${suffix} domain`, yref: `y${suffix}`, x: 1, y: value,
            text: label, showarrow: false, xanchor: "right", yanchor: "bottom",
            font: {size: 10, color: MUTED}, bgcolor: HALO, borderpad: 1,
        });
    }
    return {shapes, annotations};
}

export const BASE_CONFIG = {
    displaylogo: false,
    responsive: true,
    // The publication export. SVG keeps the text as text, which is what a journal
    // wants; the PNG scale of 3 on a 1500px figure gives 4500px, comfortably past
    // the 300 dpi a full-page figure needs.
    toImageButtonOptions: {format: "svg", scale: 1},
    modeBarButtonsToAdd: ["toggleSpikelines"],
    modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
};

// ---------------------------------------------------------------------------
// figures
// ---------------------------------------------------------------------------

/** Error against clip length, one panel per class and rung. */
export function figErrorByLength(rows, {rungsWanted = [0, 0.2]} = {}) {
    const durations = durationsOf(rows);
    const rungs = rungsWanted.filter((e) => cell(rows, null, null, e).length);
    if (!durations.length || !rungs.length) return null;

    const data = [];
    const titles = [];
    let drawn = 0, missing = 0, floored = 0, peak = FLOOR;
    const medians = {};
    for (const rung of rungs) {
        for (const cls of CLASSES) {
            const i = titles.length;
            const suffix = i === 0 ? "" : String(i + 1);
            const stats = [], points = [], hollow = [];
            for (let d = 0; d < durations.length; d++) {
                const here = cell(rows, cls, durations[d], rung);
                const values = here.map((r) => r.r_topRelSep).filter(fin);
                missing += here.length - values.length;
                drawn += values.length;
                floored += values.filter((v) => v < FLOOR).length;
                stats.push(boxStatsLog(values));
                for (const r of here) {
                    if (!fin(r.r_topRelSep)) continue;
                    peak = Math.max(peak, r.r_topRelSep);
                    (r.r_topBlind ? hollow : points).push({x: d, y: atLeast(r.r_topRelSep, FLOOR)});
                }
                const box = stats[stats.length - 1];
                if (box) medians[`${rung}deg/${cls}/${durations[d]}`] = box.median;
            }
            data.push(boxTrace(durations.map((unused, d) => d), stats, CLASS_HUE[cls], {axis: suffix, floor: FLOOR}));
            data.push(stripTrace(points, CLASS_HUE[cls], {axis: suffix}));
            if (hollow.length) data.push(stripTrace(hollow, CLASS_HUE[cls], {axis: suffix, hollow: true, seed: 806}));
            titles.push(`${CLASS_LABEL[cls]}, ${rungLabel(rung)} pointing error`);
        }
    }
    const layout = gridLayout({
        rows: rungs.length, cols: 3, titles,
        xTitle: "Clip length (s)",
        yTitle: "Top candidate mean 3D error / mean true range",
        tickvals: durations.map((unused, d) => d),
        ticktext: durations.map(String),
        yRange: [Math.log10(FLOOR * 0.55), Math.log10(peak * 2.2)],
    });
    const tol = toleranceShapes(titles.length, TOL5, "5% of range");
    layout.shapes = tol.shapes;
    layout.annotations = [...layout.annotations, ...tol.annotations];

    const first = durations[0], last = durations[durations.length - 1];
    const parts = [];
    for (const rung of rungs) {
        for (const cls of CLASSES) {
            const a = medians[`${rung}deg/${cls}/${first}`], b = medians[`${rung}deg/${cls}/${last}`];
            if (fin(a) && fin(b)) {
                parts.push(`${CLASS_LABEL[cls]} ${rungLabel(rung)}: ${formatPercent(a)} at ${first} s, `
                    + `${formatPercent(b)} at ${last} s`);
            }
        }
    }
    return {
        key: "errorByLength",
        title: "rock_v3: blind top-candidate error by clip length, three target classes",
        data,
        layout: pageLayout(layout, {
            title: "rock_v3: blind top-candidate error by clip length, three target classes",
            height: 420 * rungs.length + 190,
            caption: `${drawn} tracks drawn (${missing} with no top range are not drawn); 100 tracks per class at `
                + `every length and rung, the same 300 tracks at every length, so a longer clip extends the same track. `
                + `Box: quartiles and median on the raw values. Whiskers: Tukey's 1.5 box-heights, computed on log10 so `
                + `the fence is symmetric on this axis. Dots: every track; hollow means the top candidate came from the `
                + `range-blind polynomial family. ${floored} values below ${FLOOR} are drawn at the floor. ${parts.join("; ")}.`,
        }),
        config: BASE_CONFIG,
        stats: medians,
    };
}

/** Error against the pointing-error ladder, one panel per class and clip length. */
export function figErrorByRung(rows, {durationsWanted = [20, 120]} = {}) {
    const rungs = rungsOf(rows);
    const durations = durationsWanted.filter((d) => cell(rows, null, d).length);
    if (rungs.length < 2 || !durations.length) return null;

    const data = [], titles = [];
    let drawn = 0, missing = 0, floored = 0, peak = FLOOR;
    const medians = {};
    for (const duration of durations) {
        for (const cls of CLASSES) {
            const i = titles.length;
            const suffix = i === 0 ? "" : String(i + 1);
            const stats = [], points = [], hollow = [];
            for (let e = 0; e < rungs.length; e++) {
                const here = cell(rows, cls, duration, rungs[e]);
                const values = here.map((r) => r.r_topRelSep).filter(fin);
                missing += here.length - values.length;
                drawn += values.length;
                floored += values.filter((v) => v < FLOOR).length;
                const box = boxStatsLog(values);
                stats.push(box);
                if (box) medians[`${duration}s/${cls}/${rungs[e]}`] = box.median;
                for (const r of here) {
                    if (!fin(r.r_topRelSep)) continue;
                    peak = Math.max(peak, r.r_topRelSep);
                    (r.r_topBlind ? hollow : points).push({x: e, y: atLeast(r.r_topRelSep, FLOOR)});
                }
            }
            data.push(boxTrace(rungs.map((unused, e) => e), stats, CLASS_HUE[cls], {axis: suffix, floor: FLOOR}));
            data.push(stripTrace(points, CLASS_HUE[cls], {axis: suffix}));
            if (hollow.length) data.push(stripTrace(hollow, CLASS_HUE[cls], {axis: suffix, hollow: true, seed: 806}));
            titles.push(`${CLASS_LABEL[cls]}, ${duration} s clips`);
        }
    }
    const layout = gridLayout({
        rows: durations.length, cols: 3, titles,
        xTitle: "Pointing-error rung (wobble amplitude)",
        yTitle: "Top candidate mean 3D error / mean true range",
        tickvals: rungs.map((unused, e) => e),
        ticktext: rungs.map(rungLabel),
        yRange: [Math.log10(FLOOR * 0.55), Math.log10(peak * 2.2)],
    });
    const tol = toleranceShapes(titles.length, TOL5, "5% of range");
    layout.shapes = tol.shapes;
    layout.annotations = [...layout.annotations, ...tol.annotations];

    const parts = [];
    for (const duration of durations) {
        for (const cls of CLASSES) {
            const a = medians[`${duration}s/${cls}/${rungs[0]}`];
            const b = medians[`${duration}s/${cls}/${rungs[rungs.length - 1]}`];
            if (fin(a) && fin(b)) {
                parts.push(`${CLASS_LABEL[cls]} ${duration} s: ${formatPercent(a)} at ${rungLabel(rungs[0])}, `
                    + `${formatPercent(b)} at ${rungLabel(rungs[rungs.length - 1])}`);
            }
        }
    }
    return {
        key: "errorByRung",
        title: "rock_v3: blind top-candidate error against the pointing-error ladder",
        data,
        layout: pageLayout(layout, {
            title: "rock_v3: blind top-candidate error against the pointing-error ladder",
            height: 420 * durations.length + 190,
            caption: `${drawn} tracks drawn (${missing} with no top range are not drawn). The rung is the operator-wobble `
                + `amplitude; the realized RMS pointing error is about 0.64 times the rung. Box, whiskers, dots and floor `
                + `as in the clip-length figure; ${floored} values drawn at the floor. ${parts.join("; ")}.`,
        }),
        config: BASE_CONFIG,
        stats: medians,
    };
}

/** Share of tracks inside a tolerance, against either axis, with exact intervals. */
export function figWithinTolerance(rows, {axis = "rung", fixed = [20, 120]} = {}) {
    const byRung = axis === "rung";
    const xs = byRung ? rungsOf(rows) : durationsOf(rows);
    const panels = fixed.filter((f) => (byRung ? cell(rows, null, f).length : cell(rows, null, null, f).length));
    if (xs.length < 2 || !panels.length) return null;

    const data = [], titles = [];
    const summary = {};
    for (const panelValue of panels) {
        for (const tol of [TOL5, TOL1]) {
            const i = titles.length;
            const suffix = i === 0 ? "" : String(i + 1);
            CLASSES.forEach((cls, ci) => {
                const counts = xs.map((x) => withinTolerance(
                    byRung ? cell(rows, cls, panelValue, x) : cell(rows, cls, x, panelValue), tol));
                summary[`${panelValue}/${formatPercent(tol)}/${cls}`] = counts;
                data.push(proportionTrace(xs.map((unused, k) => k), counts, CLASS_HUE[cls],
                    CLASS_LABEL[cls], {axis: suffix, dx: (ci - 1) * 0.1}));
            });
            titles.push(byRung
                ? `Within ${formatPercent(tol)} of range, ${panelValue} s clips`
                : `Within ${formatPercent(tol)} of range, ${rungLabel(panelValue)} pointing error`);
        }
    }
    const layout = gridLayout({
        rows: panels.length, cols: 2, titles,
        xTitle: byRung ? "Pointing-error rung" : "Clip length (s)",
        yTitle: "Fraction of tracks",
        tickvals: xs.map((unused, k) => k),
        ticktext: xs.map(byRung ? rungLabel : String),
        logY: false,
    });
    for (let i = 0; i < titles.length; i++) {
        const suffix = i === 0 ? "" : String(i + 1);
        Object.assign(layout[`yaxis${suffix}`], {
            range: [-0.02, 1.04], tickvals: [0, 0.25, 0.5, 0.75, 1],
            ticktext: ["0%", "25%", "50%", "75%", "100%"],
        });
    }
    // One legend, on the first panel only: the same three series repeat in each.
    data.slice(0, 3).forEach((trace) => { trace.showlegend = true; });

    return {
        key: byRung ? "withinByRung" : "withinByLength",
        title: `rock_v3: share of tracks with the blind top candidate within tolerance, by `
            + `${byRung ? "pointing error" : "clip length"}`,
        data,
        layout: {
            ...pageLayout(layout, {
                title: `rock_v3: share of tracks with the blind top candidate within tolerance, by `
                    + `${byRung ? "pointing error" : "clip length"}`,
                height: 380 * panels.length + 190,
                width: 1300,
                caption: `Points: k of n tracks (n = 100 per cell) whose top candidate lies within the tolerance; a track `
                    + `with no top range at all counts as outside. Bars: exact 95% Clopper-Pearson intervals, which are `
                    + `conservative by construction, so their true coverage is at least 95%.`,
            }),
            showlegend: true,
            legend: {orientation: "h", x: 1, y: 1.035, xanchor: "right", yanchor: "bottom",
                font: {size: 11}},
        },
        config: BASE_CONFIG,
        stats: summary,
    };
}

/** Which of the three class outcomes the verdict produced. */
const OUTCOMES = ["true class viable", "only other classes viable", "nothing viable (unresolved)"];
const OUTCOME_HUE = {
    "true class viable": "#2a78d6",
    "only other classes viable": "#eb6834",
    "nothing viable (unresolved)": "#c9c7bf",
};

export function outcomeOf(row) {
    const viable = String(row.r_viable ?? "");
    if (!viable) return OUTCOMES[2];
    return row.d_classCorrect ? OUTCOMES[0] : OUTCOMES[1];
}

export function figClassOutcome(rows, {durationsWanted = [20, 120]} = {}) {
    const rungs = rungsOf(rows);
    const durations = durationsWanted.filter((d) => cell(rows, null, d).length);
    if (rungs.length < 2 || !durations.length) return null;

    const data = [], titles = [];
    const summary = {};
    for (const duration of durations) {
        for (const cls of CLASSES) {
            const i = titles.length;
            const suffix = i === 0 ? "" : String(i + 1);
            for (const outcome of OUTCOMES) {
                const fractions = rungs.map((rung) => {
                    const here = cell(rows, cls, duration, rung);
                    if (!here.length) return 0;
                    const n = here.filter((r) => outcomeOf(r) === outcome).length;
                    summary[`${duration}s/${cls}/${rung}/${outcome}`] = n;
                    return n / here.length;
                });
                data.push({
                    type: "bar",
                    x: rungs.map((unused, e) => e),
                    y: fractions,
                    name: outcome,
                    marker: {color: OUTCOME_HUE[outcome], line: {color: "#ffffff", width: 1}},
                    hovertemplate: `${outcome}: %{y:.0%}<extra></extra>`,
                    showlegend: i === 0,
                    legendgroup: outcome,
                    xaxis: `x${suffix}`, yaxis: `y${suffix}`,
                });
            }
            titles.push(`${CLASS_LABEL[cls]}, ${duration} s clips`);
        }
    }
    const layout = gridLayout({
        rows: durations.length, cols: 3, titles,
        xTitle: "Pointing-error rung", yTitle: "Share of tracks",
        tickvals: rungs.map((unused, e) => e), ticktext: rungs.map(rungLabel),
        logY: false, topPad: 0.87,
    });
    for (let i = 0; i < titles.length; i++) {
        const suffix = i === 0 ? "" : String(i + 1);
        Object.assign(layout[`yaxis${suffix}`], {
            range: [0, 1], tickvals: [0, 0.25, 0.5, 0.75, 1],
            ticktext: ["0%", "25%", "50%", "75%", "100%"], gridcolor: "rgba(0,0,0,0)",
        });
    }
    return {
        key: "classOutcome",
        title: "rock_v3: what the verdict says about the object class",
        data,
        layout: {
            ...pageLayout(layout, {
                title: "rock_v3: what the verdict says about the object class",
                height: 380 * durations.length + 210,
                caption: `Each bar is 100 tracks. The verdict names the interpretation classes that still pass the screen. `
                    + `"true class viable" means that list contains the true class: party and weather balloons map to the `
                    + `balloon class, the drone to the fixed-wing class. "only other classes viable" means it named classes `
                    + `but not the right one. "nothing viable" is the unresolved verdict, which the analysis states is a `
                    + `safety valve and not an anomaly claim. Separating the last two matters, because a plain class-correct `
                    + `fraction counts them the same.`,
            }),
            barmode: "stack",
            showlegend: true,
            legend: {orientation: "h", x: 1, y: 1.045, xanchor: "right", yanchor: "bottom", font: {size: 11}},
        },
        config: BASE_CONFIG,
        stats: summary,
    };
}

/** What the blind ranking cost, against the best candidate that was on offer. */
export function figRankingCost(rows, {rungsWanted = [0, 0.2]} = {}) {
    const rungs = rungsWanted.filter((e) => cell(rows, null, null, e).length);
    if (!rungs.length) return null;
    const data = [], titles = [];
    const summary = {};
    let lo = 1, hi = 1e-6;
    for (const rung of rungs) {
        for (const cls of CLASSES) {
            const i = titles.length;
            const suffix = i === 0 ? "" : String(i + 1);
            const here = cell(rows, cls, null, rung)
                .filter((r) => fin(r.r_topRelSep) && fin(r.r_bestRelSep));
            const xs = here.map((r) => atLeast(r.r_bestRelSep, FLOOR));
            const ys = here.map((r) => atLeast(r.r_topRelSep, FLOOR));
            for (const v of xs.concat(ys)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
            const chose = here.filter((r) =>
                Math.abs(r.r_topRelSep - r.r_bestRelSep) <= 1e-9 * Math.max(1, r.r_bestRelSep)).length;
            const ratio = median(here.filter((r) => r.r_bestRelSep > 0)
                .map((r) => r.r_topRelSep / r.r_bestRelSep));
            summary[`${rung}deg/${cls}`] = {n: here.length, topIsBest: chose, medianRatio: ratio};
            data.push({
                type: "scattergl", mode: "markers", x: xs, y: ys,
                marker: {size: 4.5, color: CLASS_HUE[cls], opacity: 0.75,
                    line: {color: "#ffffff", width: 0.3}},
                text: here.map((r) => r.base ?? ""),
                hovertemplate: "%{text}<br>best %{x:.3g}, chosen %{y:.3g}<extra></extra>",
                showlegend: false, xaxis: `x${suffix}`, yaxis: `y${suffix}`,
            });
            titles.push(`${CLASS_LABEL[cls]}, ${rungLabel(rung)}: top is the best on ${chose} of ${here.length}`);
        }
    }
    const layout = gridLayout({
        rows: rungs.length, cols: 3, titles,
        xTitle: "Best candidate error / range (an oracle pick)",
        yTitle: "Blind top candidate error / range",
        tickvals: undefined, ticktext: undefined,
    });
    layout.shapes = [];
    for (let i = 0; i < titles.length; i++) {
        const suffix = i === 0 ? "" : String(i + 1);
        Object.assign(layout[`xaxis${suffix}`], {type: "log", gridcolor: GRID,
            range: [Math.log10(lo * 0.7), Math.log10(hi * 1.4)]});
        Object.assign(layout[`yaxis${suffix}`], {matches: undefined,
            range: [Math.log10(lo * 0.7), Math.log10(hi * 1.4)]});
        layout.shapes.push({
            type: "line", xref: `x${suffix}`, yref: `y${suffix}`,
            x0: lo * 0.7, y0: lo * 0.7, x1: hi * 1.4, y1: hi * 1.4,
            line: {color: MUTED, width: 1, dash: "dot"}, layer: "below",
        });
    }
    return {
        key: "rankingCost",
        title: "rock_v3: the cost of blind ranking, chosen candidate against the best on offer",
        data,
        layout: pageLayout(layout, {
            title: "rock_v3: the cost of blind ranking, chosen candidate against the best on offer",
            height: 430 * rungs.length + 190,
            caption: `Each dot is one track, all clip lengths pooled. x: the error of the candidate closest to truth, which `
                + `is an oracle pick only knowable with truth in hand. y: the error of the candidate the blind ranking put `
                + `first. A dot on the dashed diagonal means the ranking chose the best candidate on offer, and the vertical `
                + `distance above it is what ranking blind cost on that track. Values below ${FLOOR} are drawn at the floor.`,
        }),
        config: BASE_CONFIG,
        stats: summary,
    };
}

/** Error against the two geometry axes, with a median trend over equal-count bins. */
export function figErrorVsGeometry(rows, {rungsWanted = [0, 0.2]} = {}) {
    const rungs = rungsWanted.filter((e) => cell(rows, null, null, e).length);
    if (!rungs.length) return null;
    const AXES = [
        {field: "in_apertureDeg", label: "Parallax aperture (deg)", scale: 1},
        {field: "in_trueRangeMeanM", label: "Mean true range (km)", scale: 1e-3},
    ];
    const data = [], titles = [];
    const summary = {};
    for (const rung of rungs) {
        for (const axisSpec of AXES) {
            const i = titles.length;
            const suffix = i === 0 ? "" : String(i + 1);
            for (const cls of CLASSES) {
                const here = cell(rows, cls, null, rung).filter((r) =>
                    fin(r.r_topRelSep) && fin(r[axisSpec.field]) && r[axisSpec.field] > 0);
                if (!here.length) continue;
                const xs = here.map((r) => r[axisSpec.field] * axisSpec.scale);
                const ys = here.map((r) => atLeast(r.r_topRelSep, FLOOR));
                data.push({
                    type: "scattergl", mode: "markers", x: xs, y: ys,
                    marker: {size: 3.5, color: CLASS_HUE[cls], opacity: 0.35},
                    hoverinfo: "skip", showlegend: false,
                    xaxis: `x${suffix}`, yaxis: `y${suffix}`,
                });
                const trend = equalCountMedians(xs, ys, {bins: 8, minPerBin: 5});
                summary[`${rung}deg/${cls}/${axisSpec.field}`] = trend;
                data.push({
                    type: "scatter", mode: "lines+markers",
                    x: trend.map((b) => b.x), y: trend.map((b) => b.y),
                    line: {color: CLASS_HUE[cls], width: 2.4},
                    marker: {color: CLASS_HUE[cls], size: 7, line: {color: "#ffffff", width: 1}},
                    text: trend.map((b) => `${b.n} tracks`),
                    hovertemplate: `${CLASS_LABEL[cls]}: median %{y:.3g}, %{text}<extra></extra>`,
                    name: CLASS_LABEL[cls], showlegend: i === 0,
                    xaxis: `x${suffix}`, yaxis: `y${suffix}`,
                });
            }
            titles.push(`${axisSpec.label.split(" (")[0]}, ${rungLabel(rung)} pointing error`);
        }
    }
    const layout = gridLayout({
        rows: rungs.length, cols: 2, titles,
        xTitle: "", yTitle: "Blind top candidate error / range",
        yRange: [Math.log10(FLOOR * 0.55), Math.log10(3)],
    });
    for (let i = 0; i < titles.length; i++) {
        const suffix = i === 0 ? "" : String(i + 1);
        Object.assign(layout[`xaxis${suffix}`], {
            type: "log", gridcolor: GRID, tickvals: undefined, ticktext: undefined,
            title: {text: AXES[i % 2].label, font: {size: 12, color: INK}},
        });
    }
    const tol = toleranceShapes(titles.length, TOL5, "5% of range");
    layout.shapes = tol.shapes;
    layout.annotations = [...layout.annotations, ...tol.annotations];
    return {
        key: "errorVsGeometry",
        title: "rock_v3: blind top-candidate error against the viewing geometry",
        data,
        layout: {
            ...pageLayout(layout, {
                title: "rock_v3: blind top-candidate error against the viewing geometry",
                height: 430 * rungs.length + 190, width: 1300,
                caption: `Each faint dot is one track, all clip lengths pooled, so a longer clip sits further right on the `
                    + `aperture axis. The heavy line is that class's median over equal-count bins, at least 5 tracks per `
                    + `point and up to 8 points; the line is what to read and the dots only show the spread. The parallax `
                    + `aperture is the angle at the target between the first and the last sensor position. Dashed line: `
                    + `5% of range. Values below ${FLOOR} are drawn at the floor.`,
            }),
            showlegend: true,
            legend: {x: 0.005, y: 0.02, xanchor: "left", yanchor: "bottom", font: {size: 11}, bgcolor: HALO},
        },
        config: BASE_CONFIG,
        stats: summary,
    };
}

/** A 100% stacked mix of any categorical result field, by rung. */
export function figCategoryMix(rows, {field, key, title, caption, order = null, labels = null,
    durationsWanted = [20, 120], limit = 7} = {}) {
    const rungs = rungsOf(rows);
    const durations = durationsWanted.filter((d) => cell(rows, null, d).length);
    if (rungs.length < 2 || !durations.length) return null;

    let keys = order;
    if (!keys) {
        keys = tally(rows, field).map((t) => t.name);
        if (keys.length > limit) keys = keys.slice(0, limit).concat(["Other"]);
    } else {
        const present = new Set(rows.map((r) => String(r[field] ?? "null")));
        keys = keys.filter((k) => present.has(k));
    }
    const hue = {};
    keys.forEach((k, i) => { hue[k] = k === "Other" ? "#8f8c84" : MIX_HUES[i % MIX_HUES.length]; });

    const data = [], titles = [];
    for (const duration of durations) {
        for (const cls of CLASSES) {
            const i = titles.length;
            const suffix = i === 0 ? "" : String(i + 1);
            for (const name of keys) {
                const fractions = rungs.map((rung) => {
                    const here = cell(rows, cls, duration, rung);
                    if (!here.length) return 0;
                    const n = name === "Other"
                        ? here.filter((r) => !keys.includes(String(r[field] ?? "null"))).length
                        : here.filter((r) => String(r[field] ?? "null") === name).length;
                    return n / here.length;
                });
                data.push({
                    type: "bar", x: rungs.map((unused, e) => e), y: fractions,
                    name: labels?.[name] ?? name,
                    marker: {color: hue[name], line: {color: "#ffffff", width: 1}},
                    hovertemplate: `${labels?.[name] ?? name}: %{y:.0%}<extra></extra>`,
                    showlegend: i === 0, legendgroup: name,
                    xaxis: `x${suffix}`, yaxis: `y${suffix}`,
                });
            }
            titles.push(`${CLASS_LABEL[cls]}, ${duration} s clips`);
        }
    }
    const layout = gridLayout({
        rows: durations.length, cols: 3, titles,
        xTitle: "Pointing-error rung", yTitle: "Share of tracks",
        tickvals: rungs.map((unused, e) => e), ticktext: rungs.map(rungLabel),
        logY: false, topPad: 0.87,
    });
    for (let i = 0; i < titles.length; i++) {
        const suffix = i === 0 ? "" : String(i + 1);
        Object.assign(layout[`yaxis${suffix}`], {
            range: [0, 1], tickvals: [0, 0.25, 0.5, 0.75, 1],
            ticktext: ["0%", "25%", "50%", "75%", "100%"], gridcolor: "rgba(0,0,0,0)",
        });
    }
    return {
        key, title, data,
        layout: {
            ...pageLayout(layout, {title, height: 380 * durations.length + 210, caption}),
            barmode: "stack",
            showlegend: true,
            legend: {orientation: "h", x: 1, y: 1.045, xanchor: "right", yanchor: "bottom", font: {size: 10.5}},
        },
        config: BASE_CONFIG,
    };
}

export const VERDICT_ORDER = ["probably-balloon", "consistent-one", "consistent-several", "unresolved"];

/** Readable names for a key field, taken from the companion name in the data. */
export function labelMapFrom(rows, keyField, nameField) {
    const out = {};
    for (const row of rows) {
        const k = row[keyField], n = row[nameField];
        if (k != null && n && !(String(k) in out)) out[String(k)] = String(n).split(" (")[0].trim();
    }
    return out;
}

// ---------------------------------------------------------------------------
// the registry both front ends walk
// ---------------------------------------------------------------------------

export const FIGURES = [
    {key: "errorByLength", name: "Error by clip length", group: "Accuracy",
        build: (rows) => figErrorByLength(rows)},
    {key: "errorByRung", name: "Error by pointing error", group: "Accuracy",
        build: (rows) => figErrorByRung(rows)},
    {key: "withinByLength", name: "Within tolerance, by length", group: "Accuracy",
        build: (rows) => figWithinTolerance(rows, {axis: "length", fixed: [0, 0.2]})},
    {key: "withinByRung", name: "Within tolerance, by pointing error", group: "Accuracy",
        build: (rows) => figWithinTolerance(rows, {axis: "rung", fixed: [20, 120]})},
    {key: "errorVsGeometry", name: "Error against geometry", group: "Geometry",
        build: (rows) => figErrorVsGeometry(rows)},
    {key: "classOutcome", name: "What the verdict says about the class", group: "Interpretation",
        build: (rows) => figClassOutcome(rows)},
    {key: "verdictMix", name: "Verdict code", group: "Interpretation",
        build: (rows) => figCategoryMix(rows, {
            field: "r_verdict", key: "verdictMix", order: VERDICT_ORDER,
            title: "rock_v3: executive verdict code by pointing error",
            caption: "Each bar is 100 tracks, ordered by how far the verdict narrows the answer: "
                + "'consistent-one' leaves a single viable interpretation class, 'consistent-several' leaves more "
                + "than one, and 'unresolved' means no tested conventional model passed the screen, which the "
                + "analysis states is a safety valve and not an anomaly claim.",
        })},
    {key: "topCandidateMix", name: "First-ranked hypothesis", group: "Interpretation",
        build: (rows) => figCategoryMix(rows, {
            field: "r_topKey", key: "topCandidateMix",
            labels: labelMapFrom(rows, "r_topKey", "r_topName"),
            title: "rock_v3: which hypothesis the blind ranking puts first",
            caption: "Each bar is 100 tracks. The bar shows the hypothesis family the ranking placed first without "
                + "seeing truth. Sky Lantern / Balloon and Quadcopter are object models; Polynomial LSQ, Constant "
                + "Altitude and Saddle are curve fits that carry no object claim.",
        })},
    {key: "rankingCost", name: "Cost of blind ranking", group: "Ranking",
        build: (rows) => figRankingCost(rows)},
];

/** Build every figure the rows can support. Nulls (too little data) are dropped. */
export function buildAllFigures(rows, {only = null} = {}) {
    return FIGURES
        .filter((f) => !only || only.includes(f.key))
        .map((f) => { try { return f.build(rows); } catch (e) { return {key: f.key, error: String(e?.message ?? e)}; } })
        .filter(Boolean);
}
