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
    boxStatsLinear, boxStatsLog, clopperPearson, equalCountMedians, jitterOffsets, median, tally, finiteSorted,
} from "./ChartStats";
import {localPlotlyConfig} from "./PlotlyConfig";
import {solverById} from "../BotBenchSolvers";
import {datasetLabelOf} from "./BotBenchChartRows";

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
export const BATCH_DURATIONS = [20, 40, 60, 120, 180, 240, 300];
export const FLOOR = 1e-4;          // drawing floor for a fraction-of-range axis
export const TOL5 = 0.05, TOL1 = 0.01;

const HALO = "rgba(255,255,255,0.82)";
const PANELS_ACROSS = 3;
const panelRowCount = (count) => Math.ceil(count / PANELS_ACROSS);

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const fin = (v) => typeof v === "number" && Number.isFinite(v);
const same = (a, b) => fin(a) && fin(b) && Math.abs(a - b) < 1e-9;
const atLeast = (v, floor) => Math.max(v, floor);
// A track in a hover label: its path under the scanned folder when the row came from a
// BOTBench run, so files of the same name in different folders can be told apart.
const trackLabel = (r) => r.path ?? r.base ?? "";
const solverLabel = (r, name) => `${trackLabel(r)}<br>Solver: ${name || "Unknown"}`;
const errorDotLabel = (r, measure) => solverLabel(r, measure.solverName(r));

// ---------------------------------------------------------------------------
// how the dots are marked
// ---------------------------------------------------------------------------

export const STRAIGHT_MARK_COLOR = "#111111";
// Without a turn level, a track counts as straight when its sensor turned less than this, degrees.
export const STRAIGHT_TURN_DEG = 1;
// A square of side d * sqrt(pi) / 2 has the area of a circle of diameter d.
const SQUARE_SIDE_PER_DIAMETER = Math.sqrt(Math.PI) / 2;

/**
 * Whether the sensor flew straight for a track: its turn level is 0, or, where the answer
 * key gives no level, it turned less than STRAIGHT_TURN_DEG. Null when neither is known.
 */
export function isStraightTrack(r) {
    if (fin(r?.d_turnDeg)) return r.d_turnDeg === 0;
    if (fin(r?.in_sensorTurnDeg)) return r.in_sensorTurnDeg < STRAIGHT_TURN_DEG;
    return null;
}

/**
 * HOW THE DOTS ARE MARKED, the same in every figure that draws one dot per track.
 *
 * Off by default: every dot is a circle of the figure size, in its class color.
 * sizeByLength gives each dot an area in proportion to its clip length, on one scale for
 * all the rows, with the middle clip length at the figure size. markStraight draws a track
 * whose sensor flew straight as a black square with the area a circle would have, so
 * the shape and color change and the area does not.
 */
export function makeMarks({sizeByLength = false, markStraight = false} = {}, rows = []) {
    const lengths = durationsOf(rows);
    const reference = sizeByLength && lengths.length ? lengths[Math.floor((lengths.length - 1) / 2)] : null;
    const byLength = reference !== null;
    const active = byLength || markStraight;
    const notes = [];
    if (markStraight) {
        notes.push(`Black squares are tracks whose sensor flew straight (turn level 0, or a turn under `
            + `${STRAIGHT_TURN_DEG}°); circles turned.`);
    }
    if (byLength) {
        notes.push(`Each dot has an area in proportion to its clip length, from ${lengths[0]} s to `
            + `${lengths[lengths.length - 1]} s.`);
    }
    return {
        sizeByLength: byLength, markStraight, active, note: notes.join(" "),
        /** The marker fields for one track: none when no marks are on. */
        style(r, size, color) {
            if (!active) return {};
            const diameter = byLength && fin(r.d_durationSeconds) && r.d_durationSeconds > 0
                ? size * Math.sqrt(r.d_durationSeconds / reference) : size;
            return markStraight && isStraightTrack(r) === true
                ? {size: diameter * SQUARE_SIDE_PER_DIAMETER, symbol: "square", color: STRAIGHT_MARK_COLOR}
                : {size: diameter, symbol: "circle", color};
        },
    };
}

/** A trace marker size, color and symbol for its tracks: arrays when marks are on, one value each when not. */
function markerFor(tracks, size, color, marks) {
    if (!marks?.active) return {size, color};
    const styles = tracks.map((r) => marks.style(r, size, color));
    return {size: styles.map((m) => m.size), color: styles.map((m) => m.color), symbol: styles.map((m) => m.symbol)};
}

/** Add a sentence to the end of a figure caption, wrapped again as a whole. */
function appendCaption(figure, sentence) {
    const annotations = figure.layout?.annotations;
    const caption = annotations?.[annotations.length - 1];
    if (!caption || !sentence) return;
    caption.text = wrapText(`${String(caption.text).replace(/<br>/g, " ")} ${sentence}`);
}

export function formatPercent(v) {
    if (!fin(v)) return "-";
    if (v < FLOOR) return `<${FLOOR * 100}%`;
    if (v >= 0.1) return `${(v * 100).toFixed(0)}%`;
    if (v >= 0.01) return `${(v * 100).toFixed(1)}%`;
    return `${(v * 100).toPrecision(2)}%`;
}

export const rungLabel = (e) => {
    if (e === null || e === undefined) return "unstated";
    const rounded = Math.round(e * 1e7) / 1e7;
    return `${Object.is(rounded, -0) ? 0 : rounded}°`;
};

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
        (cls === null || chartClass(r) === cls)
        && (duration === null || same(r.d_durationSeconds, duration))
        && (rung === null || same(r.d_errorDeg, rung)));
}

export const durationsOf = (rows) =>
    [...new Set(rows.map((r) => r.d_durationSeconds).filter(fin))].sort((a, b) => a - b);
export const batchDurationsOf = (rows) => {
    const present = [...new Set(rows.map((r) => r.d_batchDurationSeconds).filter(fin))].sort((a, b) => a - b);
    return [...BATCH_DURATIONS.filter((duration) => present.includes(duration)),
        ...present.filter((duration) => !BATCH_DURATIONS.includes(duration))];
};
export const rungsOf = (rows) =>
    [...new Set(rows.map((r) => r.d_errorDeg).filter(fin))].sort((a, b) => a - b);

/**
 * k of n rows whose value is finite and under `tol`; n counts every row. `value` is a
 * row field's name or a function of the row.
 */
export function withinTolerance(rows, tol, value = "r_topRelSep") {
    const read = typeof value === "function" ? value : (r) => r[value];
    return {k: rows.filter((r) => fin(read(r)) && read(r) < tol).length, n: rows.length};
}

// ---------------------------------------------------------------------------
// which error a figure plots
// ---------------------------------------------------------------------------

export function formatMetres(v) {
    if (!fin(v)) return "-";
    if (v < 1) return `${(v * 100).toPrecision(2)} cm`;
    if (v < 1000) return `${v.toPrecision(3)} m`;
    return `${(v / 1000).toPrecision(3)} km`;
}

export function formatDegrees(v) {
    if (!fin(v)) return "-";
    return v >= 1 ? `${v.toFixed(2)}°` : `${v.toPrecision(2)}°`;
}

export function formatSpeed(v) {
    if (!fin(v)) return "-";
    return v >= 100 ? `${v.toFixed(0)} m/s` : v >= 1 ? `${v.toFixed(1)} m/s` : `${v.toPrecision(2)} m/s`;
}

/**
 * The units an error can be plotted in. Each names the row fields holding it for the
 * blind top candidate and for the best candidate, and the field holding it in a row's
 * candidate list. A null row field means the value is found in the candidate list, by
 * the name of the top or best candidate. The floor and the ceiling are drawing limits:
 * a value outside them is drawn at the limit, and every statistic uses the value itself.
 * `needsLists` marks a unit found only in the candidate lists, which a joined JSONL
 * does not carry; the chart window offers it only when the rows have them.
 */
export const ERROR_METRICS = {
    relSep: {
        label: "Error / range", noun: "mean 3D error / mean true range", unit: "",
        floor: FLOOR, ceiling: 1e3, ceilingLabel: "a thousand times the mean true range",
        tolerance: {value: TOL5, label: "5%"}, format: formatPercent,
        topField: "r_topRelSep", bestField: "r_bestRelSep", candidateField: "relSep",
    },
    sepM: {
        label: "Mean absolute error (m)", noun: "mean 3D error (m)", unit: "m",
        floor: 0.01, ceiling: 1e7, ceilingLabel: "10,000 km", tolerance: null, format: formatMetres,
        topField: "r_topSepM", bestField: "r_bestSepM", candidateField: "sepM",
    },
    angDeg: {
        label: "Angular error (deg)", noun: "mean angular error seen from the sensor (deg)", unit: "deg",
        floor: 1e-5, ceiling: 180, ceilingLabel: "180°", tolerance: null, format: formatDegrees,
        topField: null, bestField: null, candidateField: "angDeg", needsLists: true,
    },
    headingDeg: {
        label: "Mean 2D heading error (deg)", noun: "mean 2D heading error (deg)", unit: "deg",
        // A heading error is bounded, 0 to 180, so it gets a fixed LINEAR axis rather than
        // the log axis the open-ended units need, and no drawing floor.
        floor: 0, ceiling: 180, ceilingLabel: "180°", tolerance: null, format: formatDegrees,
        axis: {type: "linear", range: [0, 180], dtick: 25},
        topField: null, bestField: null, candidateField: "headingDeg", needsLists: true,
    },
    velocityMS: {
        label: "Mean 3D velocity error (m/s)", noun: "mean 3D velocity error (m/s)", unit: "m/s",
        floor: 0.01, ceiling: 1e4, ceilingLabel: "10 km/s", tolerance: null, format: formatSpeed,
        topField: null, bestField: null, candidateField: "velocityMS", needsLists: true,
    },
};

export const SUBJECT_TOP = "top";
export const SUBJECT_BEST = "best";

const capitalize = (text) => String(text).charAt(0).toUpperCase() + String(text).slice(1);

/**
 * WHICH ERROR A FIGURE PLOTS: whose error, and in what unit.
 *
 * `subject` is the blind top candidate (the default), the best candidate (an oracle
 * pick, knowable only with truth in hand), or one solver by name. `metric` is a key of
 * ERROR_METRICS. Every error figure reads its values, floor, tolerance line and labels
 * through one of these. `logError` selects the error scale; heading error keeps
 * its fixed linear scale. The defaults preserve the original figures.
 */
export function makeMeasure({metric = "relSep", subject = SUBJECT_TOP, logError = true,
    boxPercent = 50, whiskerK = 1.5, whiskerSpace = "raw"} = {}) {
    const key = ERROR_METRICS[metric] ? metric : "relSep";
    const m = ERROR_METRICS[key];
    const axis = m.axis ?? (logError ? null : {type: "linear"});
    const central = Number.isFinite(boxPercent) ? Math.min(90, Math.max(20, boxPercent)) : 50;
    const whisker = Number.isFinite(whiskerK) ? Math.min(3, Math.max(0, whiskerK)) : 1.5;
    const space = whiskerSpace === "axis" ? "axis" : "raw";
    const tail = (100 - central) / 2;
    const compact = (value) => String(Number(value.toFixed(2)));
    const spanName = central === 50 ? "IQR" : "the box span";
    const fromList = (row, name, field) => (row.r_candidates ?? []).find((c) => c.name === name)?.[field];
    const read = (row, who, spec) => {
        let v;
        if (who === SUBJECT_TOP) v = spec.topField ? row[spec.topField] : fromList(row, row.r_topName, spec.candidateField);
        else if (who === SUBJECT_BEST) v = spec.bestField ? row[spec.bestField] : fromList(row, row.r_bestName, spec.candidateField);
        else v = fromList(row, who, spec.candidateField);
        return fin(v) ? v : null;
    };
    const who = subject === SUBJECT_TOP ? "blind top candidate"
        : subject === SUBJECT_BEST ? "best candidate (oracle)" : shortSolverName(subject);
    return {
        metric: key, subject, who, logError, boxPercent: central, whiskerK: whisker, whiskerSpace: space,
        label: m.label, noun: m.noun, unit: m.unit, needsLists: !!m.needsLists,
        /** Linear axis settings, or null for the shared log axis. */
        axis,
        /** The y range for a figure whose data peaks at `peak`. Linear errors start at zero. */
        yRange: (peak) => axis ? (axis.range ?? [0, (peak || m.floor || 1) * 1.1])
            : [Math.log10(m.floor * 0.55), Math.log10(peak * 2.2)],
        /** Box statistics in raw values by default, with an optional log-space fence. */
        boxStats: (values) => (axis
            ? boxStatsLinear(values, {boxPercent: central, whiskerK: whisker})
            : boxStatsLog(values, {boxPercent: central, whiskerK: whisker, whiskerSpace: space})),
        /** The caption's sentence on the central interval. */
        boxNote: central === 50
            ? "Box: quartiles (middle 50%) and median on the raw values."
            : `Box: middle ${compact(central)}% (${compact(tail)}-${compact(100 - tail)} percentiles) and median on the raw values.`,
        /** The caption's sentence on the whiskers, matching boxStats. */
        fenceNote: axis || space === "raw"
            ? `Whiskers: extreme values inside fences ${compact(whisker)}×${spanName} beyond the box, computed on the raw values.`
            : `Whiskers: extreme values inside fences ${compact(whisker)}×${spanName} beyond the box, computed on log10 so the fence is symmetric on this axis.`,
        /** The caption's sentence on the floor, given a count or the word "Values"; nothing on a linear axis. */
        floorNote: (floored) => (axis ? "" : (typeof floored === "number"
            ? `${floored} values below ${m.format(m.floor)} are drawn at the floor. `
            : `Values below ${m.format(m.floor)} are drawn at the floor. `)),
        floor: axis ? 0 : m.floor, ceiling: m.ceiling, ceilingLabel: m.ceilingLabel, tolerance: m.tolerance, format: m.format,
        isDefault: key === "relSep" && subject === SUBJECT_TOP,
        axisTitle: `${capitalize(who)} ${m.noun}`,
        // Only the top candidate's row says whether it came from the range-blind family.
        marksBlind: subject === SUBJECT_TOP,
        /** The solver that produced the displayed error, including the per-track top or oracle pick. */
        solverName: (row) => subject === SUBJECT_TOP ? (row.r_topName || row.r_topKey || "Unknown")
            : subject === SUBJECT_BEST ? (row.r_bestName || "Unknown") : subject,
        /** The subject's error on a row, or null. */
        value: (row) => read(row, subject, m),
        /** The best candidate's error on a row, in the same unit. */
        best: (row) => read(row, SUBJECT_BEST, m),
        /** One entry of a row's candidate list, in this unit. */
        candidate: (c) => (fin(c?.[m.candidateField]) ? c[m.candidateField] : null),
        /** The subject's error as a share of range, which is what a tolerance is set in. */
        relSep: (row) => read(row, subject, ERROR_METRICS.relSep),
    };
}

/**
 * The pointing-error rungs a figure should panel by.
 *
 * The rungs asked for when the rows have them; otherwise whichever rungs the rows
 * do carry; and when no row carries one at all, a single pooled group drawn as
 * "unstated". That last case is not rare: choose a scenario's All folder on its
 * own and its sidecars, which hold the declared pointing error, stay behind in
 * the sibling meta folder. Before this, such a run drew no figure at all.
 */
export function rungGroups(rows, wanted) {
    const present = [...new Set(rows.map((r) => r.d_errorDeg).filter(fin))].sort((a, b) => a - b);
    const known = wanted.filter((e) => present.some((value) => same(value, e)));
    if (known.length) return known;
    if (present.length) return present.slice(0, 2);
    return rows.length ? [null] : [];
}

/**
 * The clip lengths a figure should panel by: the counterpart of rungGroups.
 *
 * The lengths asked for when the rows have them; otherwise the first two lengths
 * the rows do carry. Without the fallback, a sweep of the pointing-error ladder at
 * one clip length drew none of the rung figures: a 40 s run over nine rungs got
 * two figures, because every rung figure asked only for 20 s and 120 s clips, the
 * two lengths of the first rock_v3 report.
 */
export function durationGroups(rows, wanted) {
    const present = durationsOf(rows);
    const known = wanted.filter((d) => present.some((value) => same(value, d)));
    if (known.length) return known;
    return present.length ? present.slice(0, 2) : rows.length ? [null] : [];
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
export function boxTrace(positions, stats, color, {axis = "", width = 0.62, floor = null, ceiling = null,
    fillAlpha = 0.125, lineColor = color, lineWidth = 1.1} = {}) {
    const keep = positions.map((x, i) => [x, stats[i]]).filter(([, s]) => s);
    // The floor is a DRAWING device, exactly as in the matplotlib reference: the
    // statistics are computed on the raw values and only the drawn geometry is
    // clipped. Without this a cell whose whole distribution sits at 1e-7 drags
    // the shared log axis down three decades and squashes every other panel. The
    // ceiling does the same at the top, where one runaway fit would otherwise
    // stretch the axis to 1e59.
    const clip = (v) => {
        const raised = floor === null ? v : Math.max(v, floor);
        return ceiling === null ? raised : Math.min(raised, ceiling);
    };
    return {
        type: "box",
        x: keep.map(([x]) => x),
        q1: keep.map(([, s]) => clip(s.q1)),
        median: keep.map(([, s]) => clip(s.median)),
        q3: keep.map(([, s]) => clip(s.q3)),
        lowerfence: keep.map(([, s]) => clip(s.lowerFence)),
        upperfence: keep.map(([, s]) => clip(s.upperFence)),
        // A light default tint lets the dots read through the box. Individual
        // figures can strengthen it when they also draw darker points.
        fillcolor: hexToRgba(color, fillAlpha),
        line: {color: lineColor, width: lineWidth},
        marker: {color},
        median_color: INK,
        width,
        hoverinfo: "y",
        showlegend: false,
        xaxis: `x${axis}`, yaxis: `y${axis}`,
    };
}

/**
 * Every observation as a jittered dot beside its box. Hollow marks a subset.
 *
 * A position may carry `id`, the row's index, and `label`, the track's name. The id
 * rides in `customdata`, which is how the chart window finds the row, and so the
 * screenshot, for the dot under the pointer.
 */
export function stripTrace(positions, color, {axis = "", hollow = false, name = "", size = 5,
    text = null, seed = 805, amount = 0.26, opacity = 1} = {}) {
    const offsets = jitterOffsets(positions.length, amount, seed);
    const labels = text ?? (positions.some((p) => p.label) ? positions.map((p) => p.label ?? "") : null);
    // Per-dot size, color and symbol when any dot carries them (makeMarks); one of each otherwise.
    const each = (field, fallback) => (positions.some((p) => p[field] !== undefined)
        ? positions.map((p) => p[field] ?? fallback) : fallback);
    const sizes = each("size", size), colors = each("color", color), symbols = each("symbol", undefined);
    const shape = symbols === undefined ? {} : {symbol: symbols};
    return {
        type: "scattergl",
        mode: "markers",
        x: positions.map((p, i) => p.x + offsets[i]),
        y: positions.map((p) => p.y),
        customdata: positions.map((p) => p.id ?? null),
        text: labels,
        hovertemplate: labels ? "%{text}<br>%{y:.3g}<extra></extra>" : "%{y}<extra></extra>",
        opacity,
        marker: hollow
            ? {size: Array.isArray(sizes) ? sizes.map((v) => v + 2) : sizes + 2, color: "rgba(0,0,0,0)",
                line: {color: colors, width: 1}, ...shape}
            : {size: sizes, color: colors, line: {color: "#ffffff", width: 0.4}, ...shape},
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
    yRange = null, yAxis = null}) {
    const layout = {};
    const panelW = (1 - hGap * (cols - 1)) / cols;
    const plotTop = topPad, plotBottom = bottomPad;
    const panelH = ((plotTop - plotBottom) - vGap * (rows - 1)) / rows;
    layout.annotations = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            if (titles && i >= titles.length) continue;
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
                range: yRange ?? undefined,
                matches: shareY && i > 0 ? "y" : undefined,
                // A unit with a fixed axis (the heading error's 0 to 180) sets its own type,
                // range and tick step over the defaults above.
                ...(yAxis ?? {}),
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

// The height of one legend row, in pixels, at the legend's font size.
const LEGEND_ROW_PX = 26;

/**
 * The standard page furniture: title, caption, paper colors, margins, and the legend.
 *
 * THE LEGEND GOES UNDER THE PANELS, above the caption, in one row or, past four
 * entries, two. At the top right it ran into the title, and eight entries crowded
 * into one line of small type. `legendEntries` is how many entries the figure shows;
 * zero means no legend.
 */
export function pageLayout(layout, {title, caption, height = 900, width = 1500, legendEntries = 0}) {
    const legendRows = legendEntries > 4 ? 2 : (legendEntries > 0 ? 1 : 0);
    const perRow = legendRows === 2 ? Math.ceil(legendEntries / 2) : Math.max(1, legendEntries);
    const legendPx = legendRows ? legendRows * LEGEND_ROW_PX + 14 : 0;
    const margin = {l: 78, r: 24, t: 52, b: 130 + legendPx};
    // Paper coordinates span the plot area only, so a pixel offset below it is divided
    // by that area's height.
    const plotPx = Math.max(1, height - margin.t - margin.b);
    return {
        ...layout,
        title: {text: title, x: 0.005, xanchor: "left", font: {size: 16, color: INK}},
        annotations: [
            ...(layout.annotations ?? []),
            {
                x: 0, y: -0.02 - legendPx / plotPx, xref: "paper", yref: "paper",
                text: wrapText(caption), showarrow: false,
                xanchor: "left", yanchor: "top", align: "left",
                font: {size: 10.5, color: INK2},
            },
        ],
        paper_bgcolor: "#ffffff",
        plot_bgcolor: SURFACE,
        height, width,
        margin,
        showlegend: legendRows > 0,
        legend: legendRows ? {
            orientation: "h", x: 0, xanchor: "left", y: -0.02, yanchor: "top",
            font: {size: 13, color: INK},
            entrywidth: 1 / perRow, entrywidthmode: "fraction",
            traceorder: "normal", bgcolor: "rgba(0,0,0,0)",
        } : undefined,
        hovermode: "closest",
        boxgap: 0.35,
    };
}

/** A dashed reference line on an error axis, with a haloed label. */
export function toleranceShapes(panelCount, value, label, {logY = true} = {}) {
    const shapes = [], annotations = [];
    for (let i = 0; i < panelCount; i++) {
        const suffix = i === 0 ? "" : String(i + 1);
        shapes.push({
            type: "line", xref: `x${suffix} domain`, yref: `y${suffix}`,
            x0: 0, x1: 1, y0: value, y1: value,
            line: {color: MUTED, width: 1, dash: "dot"}, layer: "below",
        });
        annotations.push({
            // On log axes, annotations use log10 coordinates; shapes use data values.
            xref: `x${suffix} domain`, yref: `y${suffix}`, x: 1, y: logY ? Math.log10(value) : value,
            text: label, showarrow: false, xanchor: "right", yanchor: "bottom",
            font: {size: 10, color: MUTED}, bgcolor: HALO, borderpad: 1,
        });
    }
    return {shapes, annotations};
}

export const BASE_CONFIG = localPlotlyConfig({
    displaylogo: false,
    responsive: true,
    // The publication export. SVG keeps the text as text, which is what a journal
    // wants; the PNG scale of 3 on a 1500px figure gives 4500px, comfortably past
    // the 300 dpi a full-page figure needs.
    toImageButtonOptions: {format: "svg", scale: 1},
    modeBarButtonsToAdd: ["toggleSpikelines"],
    modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
});

// ---------------------------------------------------------------------------
// figures
// ---------------------------------------------------------------------------

/** The tolerance line, when the measure has one: 5% of range for error/range, none in metres or degrees. */
function addTolerance(layout, panelCount, measure) {
    if (!measure.tolerance) return;
    const tol = toleranceShapes(panelCount, measure.tolerance.value, measure.tolerance.label, {logY: !measure.axis});
    layout.shapes = [...(layout.shapes ?? []), ...tol.shapes];
    layout.annotations = [...(layout.annotations ?? []), ...tol.annotations];
}

/** ", in metres" or ", in degrees" for a title, and nothing for error/range. */
const unitSuffix = (measure) => (measure.unit === "m" ? ", in metres" : measure.unit === "deg" ? ", in degrees"
    : measure.unit === "m/s" ? ", in metres per second" : "");

/** The caption's sentence about hollow dots, which only the top candidate has. */
const hollowNote = (measure) => (measure.marksBlind
    ? "Dots: every track; hollow means the top candidate came from the range-blind polynomial family. "
    : "Dots: every track. ");

/** Error against one duration dimension, one panel per class and rung. */
function figErrorByDurationDimension(rows, {
    values, readValue, key, dimensionName, xTitle, comparisonNote,
    rungsWanted = [0, 0.2], measure = makeMeasure(), marks = makeMarks(),
}) {
    const rungs = rungGroups(rows, rungsWanted);
    const presentRungs = [...new Set(rows.map((r) => r.d_errorDeg).filter(fin))].sort((a, b) => a - b);
    const groups = rungs.map((rung) => ({rung, key: `${rung}deg`, label: `${rungLabel(rung)} pointing error`, pooled: false}));
    // The named rows remain useful reference slices, while this final row answers
    // the broader question with every finite pointing-error level in the loaded
    // result set. Do not duplicate a run that contains only one level.
    if (presentRungs.length > 1) {
        groups.push({rung: null, key: "all", label: "All Pointing Errors", pooled: true});
    }
    // One duration is one box per panel, which compares nothing. The
    // by-class figures below cover that case.
    if (values.length < 2 || !groups.length) return null;
    const floor = measure.floor;

    const data = [];
    const titles = [];
    let drawn = 0, missing = 0, floored = 0, peak = floor;
    const medians = {};
    for (const group of groups) {
        for (const cls of classesOf(rows)) {
            const i = titles.length;
            const suffix = i === 0 ? "" : String(i + 1);
            const stats = [], points = [], hollow = [];
            for (let d = 0; d < values.length; d++) {
                const here = rows.filter((r) => chartClass(r) === cls && same(readValue(r), values[d])
                    && (group.pooled ? fin(r.d_errorDeg) : group.rung === null || same(r.d_errorDeg, group.rung)));
                const errors = here.map(measure.value).filter(fin);
                missing += here.length - errors.length;
                drawn += errors.length;
                floored += errors.filter((v) => v < floor).length;
                stats.push(measure.boxStats(errors));
                for (const r of here) {
                    const v = measure.value(r);
                    if (!fin(v)) continue;
                    peak = Math.max(peak, v);
                    (measure.marksBlind && r.r_topBlind ? hollow : points)
                        .push({x: d, y: atLeast(v, floor), id: r.rowIndex ?? null, label: errorDotLabel(r, measure), ...marks.style(r, 5, classHue(cls))});
                }
                const box = stats[stats.length - 1];
                if (box) medians[`${group.key}/${cls}/${values[d]}`] = box.median;
            }
            data.push(boxTrace(values.map((unused, d) => d), stats, classHue(cls), {axis: suffix, floor}));
            data.push(stripTrace(points, classHue(cls), {axis: suffix}));
            if (hollow.length) data.push(stripTrace(hollow, classHue(cls), {axis: suffix, hollow: true, seed: 806}));
            titles.push(`${classLabel(cls, rows)}, ${group.label}`);
        }
    }
    if (!drawn) return null;
    const layout = gridLayout({
        rows: panelRowCount(titles.length), cols: PANELS_ACROSS, titles,
        xTitle,
        yTitle: measure.axisTitle,
        tickvals: values.map((unused, d) => d),
        ticktext: values.map(String),
        yRange: measure.yRange(peak), logY: !measure.axis, yAxis: measure.axis,
    });
    addTolerance(layout, titles.length, measure);

    const first = values[0], last = values[values.length - 1];
    const parts = [];
    for (const group of groups) {
        for (const cls of classesOf(rows)) {
            const a = medians[`${group.key}/${cls}/${first}`], b = medians[`${group.key}/${cls}/${last}`];
            if (fin(a) && fin(b)) {
                parts.push(`${classLabel(cls, rows)} ${group.label}: ${measure.format(a)} at ${first} s, `
                    + `${measure.format(b)} at ${last} s`);
            }
        }
    }
    const title = `${datasetLabelOf(rows)}: ${measure.who} error by ${dimensionName}${classCountNote(rows)}${unitSuffix(measure)}`;
    return {
        key,
        title,
        data,
        layout: pageLayout(layout, {
            title,
            height: 420 * panelRowCount(titles.length) + 190,
            caption: `${drawn} track values drawn across the panels (${missing} with no value for the ${measure.who} are not drawn). `
                + `Each individual-error row uses one pointing-error level. `
                + (presentRungs.length > 1
                    ? `All Pointing Errors pools all ${presentRungs.length} available levels at each ${dimensionName}. ` : "")
                + comparisonNote
                + `${measure.boxNote} ${measure.fenceNote} ${hollowNote(measure)}`
                + `${measure.floorNote(floored)}${parts.join("; ")}.`,
        }),
        config: BASE_CONFIG,
        stats: medians,
    };
}

/** Error against measured clip length, one panel per class and rung. */
export function figErrorByLength(rows, {rungsWanted = [0, 0.2], measure = makeMeasure(), marks = makeMarks()} = {}) {
    return figErrorByDurationDimension(rows, {
        values: durationsOf(rows), readValue: (row) => row.d_durationSeconds,
        key: "errorByLength", dimensionName: "clip length", xTitle: "Clip length (s)",
        comparisonNote: "Clip lengths are grouped from the available folder names, answer keys or measured durations. ",
        rungsWanted, measure, marks,
    });
}

/** Error against the requested batch duration, one panel per class and rung. */
export function figErrorByDuration(rows, {rungsWanted = [0, 0.2], measure = makeMeasure(), marks = makeMarks()} = {}) {
    return figErrorByDurationDimension(rows, {
        values: batchDurationsOf(rows), readValue: (row) => row.d_batchDurationSeconds,
        key: "errorByDuration", dimensionName: "batch duration", xTitle: "Batch duration (s)",
        comparisonNote: "The duration is read from each batch_Nsec folder and kept separate from the measured clip length. ",
        rungsWanted, measure, marks,
    });
}

/** Error in six equal-width bands over the full mean true distance of the selected rows. */
export function figErrorByTrueDistance(rows, {measure = makeMeasure(), marks = makeMarks()} = {}) {
    const ranged = rows.filter((r) => fin(r.in_trueRangeMeanM) && r.in_trueRangeMeanM >= 0);
    if (!ranged.length) return null;
    const minM = ranged.reduce((v, r) => Math.min(v, r.in_trueRangeMeanM), Infinity);
    const maxM = ranged.reduce((v, r) => Math.max(v, r.in_trueRangeMeanM), -Infinity);
    if (maxM === minM) return null; // There is no distance comparison to draw.

    const bandCount = 6;
    const edges = Array.from({length: bandCount + 1}, (_, i) =>
        i === bandCount ? maxM : minM + (maxM - minM) * i / bandCount);
    const bands = Array.from({length: bandCount}, () => []);
    // Set the bounds before excluding missing candidate errors. Changing the selected
    // solver must not change which distance band a track belongs to.
    for (const r of ranged) {
        let band = 0;
        while (band < bandCount - 1 && r.in_trueRangeMeanM >= edges[band + 1]) band++;
        bands[band].push(r);
    }

    const color = CLASS_HUE.balloon;
    const points = [], hollow = [], boxes = [], stats = [];
    let drawn = 0, missing = 0, floored = 0, capped = 0, peak = measure.floor;
    bands.forEach((here, band) => {
        const values = here.map(measure.value).filter(fin);
        const box = measure.boxStats(values);
        boxes.push(box);
        stats.push({minM: edges[band], maxM: edges[band + 1], total: here.length,
            count: values.length, median: box?.median ?? null});
        drawn += values.length;
        missing += here.length - values.length;
        floored += values.filter((v) => v < measure.floor).length;
        capped += values.filter((v) => v > measure.ceiling).length;
        for (const r of here) {
            const value = measure.value(r);
            if (!fin(value)) continue;
            const y = Math.min(measure.ceiling, atLeast(value, measure.floor));
            peak = Math.max(peak, y);
            (measure.marksBlind && r.r_topBlind ? hollow : points).push({
                x: band, y, id: r.rowIndex ?? null,
                label: `${errorDotLabel(r, measure)}<br>Mean true distance: ${formatMetres(r.in_trueRangeMeanM)}`,
                ...marks.style(r, 5, color),
            });
        }
    });
    const positions = bands.map((unused, i) => i);
    const data = [
        boxTrace(positions, boxes, color, {floor: measure.floor, ceiling: measure.ceiling}),
        stripTrace(points, color),
    ];
    if (hollow.length) data.push(stripTrace(hollow, color, {hollow: true, seed: 806}));
    const layout = gridLayout({
        rows: 1, cols: 1,
        xTitle: "Mean platform-to-true-target distance (six equal-width bands)",
        yTitle: measure.axisTitle,
        tickvals: positions,
        ticktext: stats.map((s) => `${formatMetres(s.minM)}–${formatMetres(s.maxM)}<br>n=${s.count}`),
        yRange: measure.yRange(peak), logY: !measure.axis, yAxis: measure.axis,
    });
    // Keep empty bands visible, including those at either end of the distance range.
    layout.xaxis.range = [-0.5, bandCount - 0.5];
    addTolerance(layout, 1, measure);
    const title = `${datasetLabelOf(rows)}: ${measure.who} error by true distance${unitSuffix(measure)}`;
    return {
        key: "errorByTrueDistance", title, data,
        layout: pageLayout(layout, {
            title, height: 750,
            caption: `Six equal-width distance bands from ${formatMetres(minM)} to ${formatMetres(maxM)}. `
                + "Distance is the mean 3D platform-to-true-target distance over each clip. "
                + "Each band includes its lower bound; only the final band includes its upper bound. "
                + "Target classes, clip lengths and pointing-error levels are pooled within the current selection. "
                + `${drawn} track evaluations drawn; n is the number drawn in each band. `
                + `${rows.length - ranged.length} with no valid true distance and ${missing} with no value for the `
                + `${measure.who} are not drawn. Empty bands have no box. `
                + `${measure.boxNote} ${measure.fenceNote} ${hollowNote(measure)}`
                + measure.floorNote(floored)
                + (capped ? `${capped} values above ${measure.ceilingLabel} are drawn at the ceiling. ` : ""),
        }),
        config: BASE_CONFIG, stats,
    };
}

/**
 * Mean absolute position error against mean true range: the range on a linear axis
 * from zero, the error on a logarithmic axis clamped at ABSOLUTE_ERROR_FLOOR_M. A value
 * below the floor, an exact zero included, is drawn at the floor with its hover label
 * keeping the value itself, and the axis never goes below the floor. Unchecking
 * "log Error" gives a linear error axis from zero with no floor.
 */
export const ABSOLUTE_ERROR_FLOOR_M = 1e-3;

export function figAbsoluteErrorVsTrueRange(rows, {measure = makeMeasure(), marks = makeMarks()} = {}) {
    // This figure always compares distances in metres, whatever unit another figure uses.
    const absolute = makeMeasure({metric: "sepM", subject: measure.subject, logError: measure.logError});
    const floor = absolute.logError ? ABSOLUTE_ERROR_FLOOR_M : 0;
    const groups = new Map();
    let count = 0, floored = 0, minRange = Infinity, maxRange = 0, minError = Infinity, maxError = 0;
    for (const r of rows) {
        const range = r.in_trueRangeMeanM, error = absolute.value(r);
        // A distance must be positive; an error must be finite and not negative. Zero is
        // valid on both error scales: at zero on the linear axis, at the floor on the log one.
        if (!fin(range) || range <= 0 || !fin(error) || error < 0) continue;
        const cls = chartClass(r);
        if (!groups.has(cls)) groups.set(cls, []);
        groups.get(cls).push(r);
        count++;
        if (error < floor) floored++;
        minRange = Math.min(minRange, range); maxRange = Math.max(maxRange, range);
        minError = Math.min(minError, error); maxError = Math.max(maxError, error);
    }
    if (!count) return null;
    const drawnError = (r) => Math.max(absolute.value(r), floor);
    const dotLabel = (r) => {
        const v = absolute.value(r);
        return errorDotLabel(r, absolute) + (v < floor ? ` (${v.toPrecision(3)} m, drawn at the floor)` : "");
    };
    const data = [...groups].map(([cls, here]) => ({
        type: "scattergl", mode: "markers",
        x: here.map((r) => r.in_trueRangeMeanM), y: here.map(drawnError),
        marker: {...markerFor(here, 5, classHue(cls), marks), opacity: 0.55},
        text: here.map(dotLabel), customdata: here.map((r) => r.rowIndex ?? null),
        hovertemplate: "%{text}<br>Mean true range: %{x:.6g} m<br>Mean absolute error: %{y:.6g} m<extra></extra>",
        name: classLabel(cls, rows),
        showlegend: true,
    }));
    // The log axis runs from 0.15 decades below the smallest drawn error, never below the
    // floor, to 0.15 decades above the largest.
    const logRange = [Math.log10(Math.max(minError, floor)) - 0.15, Math.log10(Math.max(maxError, floor)) + 0.15];
    const layout = gridLayout({
        rows: 1, cols: 1,
        xTitle: "Mean true range (m)", yTitle: "Mean absolute error (m)",
        yRange: absolute.logError ? logRange : absolute.yRange(maxError),
        logY: absolute.logError,
    });
    Object.assign(layout.xaxis, {
        type: "linear", gridcolor: GRID, exponentformat: "none", separatethousands: true,
        range: [0, maxRange * 1.05],
    });
    const title = `${datasetLabelOf(rows)}: ${absolute.who} mean absolute error vs. mean true range`;
    return {
        key: "absoluteErrorVsTrueRange", title, data,
        layout: pageLayout(layout, {
            title, height: 750, legendEntries: groups.size,
            caption: `${count} track evaluations drawn, with target classes, clip lengths and pointing-error levels `
                + "pooled within the current selection. Each dot is one track evaluation. "
                + "Horizontal: mean 3D platform-to-true-target distance over the clip, on a linear scale from zero. "
                + `Vertical: mean 3D distance between the ${absolute.who} and the true target at matching times, `
                + (absolute.logError
                    ? "on a logarithmic scale, each decade a factor of ten, clamped at 1 mm: "
                        + `${floored} values below 1 mm (exact zeros included) are drawn at the floor, where the hover `
                        + "label gives the value itself. No ceiling is applied. "
                    : "on a linear scale starting at zero, without a drawing floor or ceiling, zero errors included. ")
                + "Both axes use metres. "
                + `${rows.length - count} evaluations with missing or invalid values or nonpositive range are omitted.`,
        }),
        config: BASE_CONFIG,
        stats: {count, floored, omitted: rows.length - count,
            byClass: Object.fromEntries([...groups].map(([cls, here]) => [cls, here.length])),
            rangeM: [minRange, maxRange], errorM: [minError, maxError]},
    };
}

/** Error against the pointing-error ladder, one panel per class and clip length. */
export function figErrorByRung(rows, {durationsWanted = [20, 120], measure = makeMeasure(), marks = makeMarks()} = {}) {
    const rungs = rungsOf(rows);
    const durations = durationGroups(rows, durationsWanted);
    if (rungs.length < 2 || !durations.length) return null;
    const floor = measure.floor;

    const data = [], titles = [];
    let drawn = 0, missing = 0, floored = 0, peak = floor;
    const medians = {};
    for (const duration of durations) {
        for (const cls of classesOf(rows)) {
            const i = titles.length;
            const suffix = i === 0 ? "" : String(i + 1);
            const stats = [], points = [], hollow = [];
            for (let e = 0; e < rungs.length; e++) {
                const here = cell(rows, cls, duration, rungs[e]);
                const values = here.map(measure.value).filter(fin);
                missing += here.length - values.length;
                drawn += values.length;
                floored += values.filter((v) => v < floor).length;
                const box = measure.boxStats(values);
                stats.push(box);
                if (box) medians[`${duration}s/${cls}/${rungs[e]}`] = box.median;
                for (const r of here) {
                    const v = measure.value(r);
                    if (!fin(v)) continue;
                    peak = Math.max(peak, v);
                    (measure.marksBlind && r.r_topBlind ? hollow : points)
                        .push({x: e, y: atLeast(v, floor), id: r.rowIndex ?? null, label: errorDotLabel(r, measure), ...marks.style(r, 5, classHue(cls))});
                }
            }
            data.push(boxTrace(rungs.map((unused, e) => e), stats, classHue(cls), {axis: suffix, floor}));
            data.push(stripTrace(points, classHue(cls), {axis: suffix}));
            if (hollow.length) data.push(stripTrace(hollow, classHue(cls), {axis: suffix, hollow: true, seed: 806}));
            titles.push(`${classLabel(cls, rows)}, ${duration === null ? "clip length unstated" : `${duration} s clips`}`);
        }
    }
    if (!drawn) return null;
    const layout = gridLayout({
        rows: panelRowCount(titles.length), cols: PANELS_ACROSS, titles,
        xTitle: "Pointing-error rung (wobble amplitude)",
        yTitle: measure.axisTitle,
        tickvals: rungs.map((unused, e) => e),
        ticktext: rungs.map(rungLabel),
        yRange: measure.yRange(peak), logY: !measure.axis, yAxis: measure.axis,
    });
    addTolerance(layout, titles.length, measure);

    const parts = [];
    for (const duration of durations) {
        for (const cls of classesOf(rows)) {
            const a = medians[`${duration}s/${cls}/${rungs[0]}`];
            const b = medians[`${duration}s/${cls}/${rungs[rungs.length - 1]}`];
            if (fin(a) && fin(b)) {
                const clip = duration === null ? "clip length unstated" : `${duration} s`;
                parts.push(`${classLabel(cls, rows)} ${clip}: ${measure.format(a)} at ${rungLabel(rungs[0])}, `
                    + `${measure.format(b)} at ${rungLabel(rungs[rungs.length - 1])}`);
            }
        }
    }
    const title = `${datasetLabelOf(rows)}: ${measure.who} error against the pointing-error ladder${unitSuffix(measure)}`;
    return {
        key: "errorByRung",
        title,
        data,
        layout: pageLayout(layout, {
            title,
            height: 420 * panelRowCount(titles.length) + 190,
            caption: `${drawn} tracks drawn (${missing} with no value for the ${measure.who} are not drawn). The rung is the `
                + `operator-wobble amplitude; the realized RMS pointing error is about 0.64 times the rung. Box, whiskers, `
                + `dots and floor as in the clip-length figure${measure.axis ? "" : `; ${floored} values drawn at the floor`}. `
                + `${parts.join("; ")}.`,
        }),
        config: BASE_CONFIG,
        stats: medians,
    };
}

// Sensor-turn levels and clip lengths as lines, light to dark. One hue each,
// because both are ordered amounts rather than categories: more turn, or a
// longer clip, is a darker line.
const TURN_RAMP = ["#8b80cf", "#6a5cc0", "#4b37a3", "#2e1a78"];
const LENGTH_RAMP = ["#6fb0a7", "#3f9186", "#227166", "#0c4f46"];

export const turnLevelsOf = (rows) =>
    [...new Set(rows.map((r) => r.d_turnDeg).filter(fin))].sort((a, b) => a - b);

/** Up to four clip lengths to draw as lines: the wanted ones present, else four spread ones. */
function pickLengths(durations, wanted) {
    const known = wanted.filter((d) => durations.some((v) => same(v, d)));
    if (known.length >= 2) return known;
    if (durations.length <= 4) return durations;
    return [0, 1, 2, 3].map((k) => durations[Math.round((k * (durations.length - 1)) / 3)]);
}

/**
 * Error against clip length with one line per sensor-turn level (`across: "length"`),
 * or against the turn level with one line per clip length (`across: "turn"`).
 *
 * Each point is the median of its cell's tracks, with a bar from the lower to the
 * upper quartile. rock_v3 flies every clip length at every turn level, so the two
 * factors are crossed and a line that stays flat says that factor does not help on
 * its own. Individual tracks are not drawn: four lines of up to seven cells of 100
 * tracks each would bury the medians.
 */
export function figErrorByTurn(rows, {across = "length", rungsWanted = [0, 0.2], lengthsWanted = [20, 60, 120, 300],
    measure = makeMeasure()} = {}) {
    const turns = turnLevelsOf(rows);
    const durations = durationsOf(rows);
    if (turns.length < 2 || durations.length < 2) return null;
    const rungs = rungGroups(rows, rungsWanted);
    if (!rungs.length) return null;
    const floor = measure.floor;
    const byLength = across === "length";
    const series = byLength ? turns : pickLengths(durations, lengthsWanted);
    const xs = byLength ? durations : turns;
    const ramp = byLength ? TURN_RAMP : LENGTH_RAMP;
    const seriesLabel = (s) => (byLength ? `${s}° turn` : `${s} s clips`);
    const xLabel = (x) => (byLength ? `${x} s` : `${x}°`);

    const data = [], titles = [];
    const medians = {};
    let peak = floor, cells = 0, flooredMedians = 0;
    for (const rung of rungs) {
        for (const cls of classesOf(rows)) {
            const i = titles.length;
            const suffix = i === 0 ? "" : String(i + 1);
            series.forEach((s, j) => {
                const color = ramp[Math.min(j, ramp.length - 1)];
                // Offset each line a little sideways, so the quartile bars do not overlap.
                const dx = (j - (series.length - 1) / 2) * 0.09;
                const points = [];
                xs.forEach((x, k) => {
                    const turn = byLength ? s : x, duration = byLength ? x : s;
                    const values = cell(rows, cls, duration, rung).filter((r) => same(r.d_turnDeg, turn))
                        .map(measure.value).filter(fin);
                    const box = measure.boxStats(values);
                    if (!box) return;
                    cells++;
                    if (box.median < floor) flooredMedians++;
                    medians[`${rung}deg/${cls}/${turn}/${duration}`] = box.median;
                    peak = Math.max(peak, box.q3);
                    points.push({x: k + dx, box, n: values.length, where: xLabel(x)});
                });
                if (!points.length) return;
                const drawn = (v) => atLeast(v, floor);
                data.push({
                    type: "scatter",
                    mode: "lines+markers",
                    x: points.map((p) => p.x),
                    y: points.map((p) => drawn(p.box.median)),
                    error_y: {
                        type: "data", symmetric: false,
                        array: points.map((p) => drawn(p.box.q3) - drawn(p.box.median)),
                        arrayminus: points.map((p) => drawn(p.box.median) - drawn(p.box.q1)),
                        color, thickness: 1, width: 2,
                    },
                    text: points.map((p) => `${seriesLabel(s)}, ${p.where}: median ${measure.format(p.box.median)}, `
                        + `quartiles ${measure.format(p.box.q1)} to ${measure.format(p.box.q3)}, ${p.n} tracks`),
                    hovertemplate: "%{text}<extra></extra>",
                    line: {color, width: 1.8},
                    marker: {color, size: 7},
                    name: seriesLabel(s),
                    legendgroup: seriesLabel(s),
                    showlegend: i === 0,
                    xaxis: `x${suffix}`, yaxis: `y${suffix}`,
                });
            });
            titles.push(`${classLabel(cls, rows)}, ${rungLabel(rung)} pointing error`);
        }
    }
    if (!cells) return null;
    const layout = gridLayout({
        rows: panelRowCount(titles.length), cols: PANELS_ACROSS, titles,
        xTitle: byLength ? "Clip length (s)" : "Sensor heading change over the clip",
        yTitle: measure.axisTitle,
        tickvals: xs.map((unused, k) => k),
        ticktext: xs.map((x) => (byLength ? String(x) : `${x}°`)),
        yRange: measure.yRange(peak), logY: !measure.axis, yAxis: measure.axis,
    });
    addTolerance(layout, titles.length, measure);

    // The caption quotes the first and last line at the first rung, at both ends of the x axis.
    const rung0 = rungs[0];
    const first = xs[0], last = xs[xs.length - 1];
    const parts = [];
    for (const cls of classesOf(rows)) {
        const ends = [series[0], series[series.length - 1]].map((s) => {
            const key = (x) => (byLength ? `${rung0}deg/${cls}/${s}/${x}` : `${rung0}deg/${cls}/${x}/${s}`);
            const a = medians[key(first)], b = medians[key(last)];
            return fin(a) && fin(b)
                ? `${seriesLabel(s)} ${measure.format(a)} at ${xLabel(first)}, ${measure.format(b)} at ${xLabel(last)}` : null;
        }).filter(Boolean);
        if (ends.length) parts.push(`${classLabel(cls, rows)}: ${ends.join("; ")}`);
    }
    const title = byLength
        ? `${datasetLabelOf(rows)}: ${measure.who} error by clip length at each sensor turn${unitSuffix(measure)}`
        : `${datasetLabelOf(rows)}: ${measure.who} error by sensor turn at each clip length${unitSuffix(measure)}`;
    return {
        key: byLength ? "errorByLengthAndTurn" : "errorByTurn",
        title,
        data,
        layout: pageLayout(layout, {
            title,
            height: 420 * panelRowCount(titles.length) + 190,
            legendEntries: series.length,
            caption: `Each point is the median ${measure.noun} of the tracks in its cell, with a bar from the lower to the `
                + `upper quartile; the lines sit a little apart so the bars do not overlap. The sensor flies straight, `
                + `turns at a constant rate through its turn level over the middle half of the clip, and flies straight `
                + `again, at every clip length, so the heading change does not grow with the clip. `
                + (byLength
                    ? "A line that stays flat says a longer clip does not help at that amount of turn. "
                    : `A line that stays flat says turning does not help at that clip length. Lines for ${series.join(", ")} s clips. `)
                + `${cells} cells. `
                + (flooredMedians ? `${flooredMedians} medians below ${measure.format(floor)} are drawn at the floor. ` : "")
                // Nothing to compare when the rows lack the first or last length.
                + (parts.length ? `At ${rungLabel(rung0)} pointing error: ${parts.join(". ")}.` : ""),
        }),
        config: BASE_CONFIG,
        stats: medians,
    };
}

/** Share of tracks inside a tolerance, against either axis, with exact intervals. */
export function figWithinTolerance(rows, {axis = "rung", fixed = [20, 120], measure = makeMeasure()} = {}) {
    const byRung = axis === "rung";
    const xs = byRung ? rungsOf(rows) : durationsOf(rows);
    // The panels hold the other axis fixed: clip lengths for a rung sweep, rungs for a
    // length sweep. Each uses the values asked for, or else the values the rows carry.
    const panels = byRung ? durationGroups(rows, fixed) : rungGroups(rows, fixed);
    if (xs.length < 2 || !panels.length) return null;

    const data = [], titles = [];
    const summary = {};
    for (const panelValue of panels) {
        for (const tol of [TOL5, TOL1]) {
            const i = titles.length;
            const suffix = i === 0 ? "" : String(i + 1);
            classesOf(rows).forEach((cls, ci) => {
                // A tolerance is a share of range, so this reads the chosen candidate's
                // error/range whatever unit the other figures are drawn in.
                const counts = xs.map((x) => withinTolerance(
                    byRung ? cell(rows, cls, panelValue, x) : cell(rows, cls, x, panelValue), tol, measure.relSep));
                summary[`${panelValue}/${formatPercent(tol)}/${cls}`] = counts;
                data.push(proportionTrace(xs.map((unused, k) => k), counts, classHue(cls),
                    classLabel(cls, rows), {axis: suffix, dx: (ci - (classesOf(rows).length - 1) / 2) * 0.1}));
            });
            titles.push(byRung
                ? `Within ${formatPercent(tol)} of range, ${panelValue === null ? "clip length unstated" : `${panelValue} s clips`}`
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
    // One legend, on the first panel only: the same groups repeat in each.
    data.slice(0, classesOf(rows).length).forEach((trace) => { trace.showlegend = true; });

    const title = `${datasetLabelOf(rows)}: share of tracks with the ${measure.who} within tolerance, by `
        + `${byRung ? "pointing error" : "clip length"}`;
    return {
        key: byRung ? "withinByRung" : "withinByLength",
        title,
        data,
        layout: {
            ...pageLayout(layout, {
                title,
                height: 380 * panels.length + 190,
                width: 1300,
                caption: `Points: k of n tracks (n is the number in that group) whose ${measure.who} lies within the tolerance, as a `
                    + `share of the mean true range; a track with no value for it counts as outside. Bars: exact 95% `
                    + `Clopper-Pearson intervals, which are conservative by construction, so their true coverage is at `
                    + `least 95%.`,
                legendEntries: classesOf(rows).length,
            }),
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
    // A missing answer key is not a wrong classification.
    rows = rows.filter((r) => r.d_classCorrect === true || r.d_classCorrect === false);
    const rungs = rungsOf(rows);
    const durations = durationGroups(rows, durationsWanted);
    if (rungs.length < 2 || !durations.length) return null;

    const data = [], titles = [];
    const summary = {};
    for (const duration of durations) {
        for (const cls of classesOf(rows)) {
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
            titles.push(`${classLabel(cls, rows)}, ${duration === null ? "clip length unstated" : `${duration} s clips`}`);
        }
    }
    const layout = gridLayout({
        rows: panelRowCount(titles.length), cols: PANELS_ACROSS, titles,
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
        title: `${datasetLabelOf(rows)}: what the verdict says about the object class`,
        data,
        layout: {
            ...pageLayout(layout, {
                title: `${datasetLabelOf(rows)}: what the verdict says about the object class`,
                height: 380 * panelRowCount(titles.length) + 210,
                caption: `Each bar includes all tracks in its group. The verdict names the interpretation classes that still pass the screen. `
                    + `"true class viable" means that list contains the true class: party and weather balloons map to the `
                    + `balloon class, the drone to the fixed-wing class. "only other classes viable" means it named classes `
                    + `but not the right one. "nothing viable" is the unresolved verdict, which the analysis states is a `
                    + `safety valve and not an anomaly claim. Separating the last two matters, because a plain class-correct `
                    + `fraction counts them the same.`,
                legendEntries: OUTCOMES.length,
            }),
            barmode: "stack",
        },
        config: BASE_CONFIG,
        stats: summary,
    };
}

/** What the blind ranking cost, against the best candidate that was on offer. */
export function figRankingCost(rows, {rungsWanted = [0, 0.2], measure = makeMeasure(), marks = makeMarks()} = {}) {
    // The best candidate set against itself is a diagonal line and nothing else.
    if (measure.subject === SUBJECT_BEST) return null;
    const rungs = rungGroups(rows, rungsWanted);
    if (!rungs.length) return null;
    const floor = measure.floor;
    const data = [], titles = [];
    const summary = {};
    let lo = 1, hi = 1e-6;
    for (const rung of rungs) {
        for (const cls of classesOf(rows)) {
            const i = titles.length;
            const suffix = i === 0 ? "" : String(i + 1);
            const here = cell(rows, cls, null, rung)
                .filter((r) => fin(measure.value(r)) && fin(measure.best(r)));
            const xs = here.map((r) => atLeast(measure.best(r), floor));
            const ys = here.map((r) => atLeast(measure.value(r), floor));
            for (const v of xs.concat(ys)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
            const chose = here.filter((r) =>
                Math.abs(measure.value(r) - measure.best(r)) <= 1e-9 * Math.max(1, measure.best(r))).length;
            const ratio = median(here.filter((r) => measure.best(r) > 0)
                .map((r) => measure.value(r) / measure.best(r)));
            summary[`${rung}deg/${cls}`] = {n: here.length, topIsBest: chose, medianRatio: ratio};
            data.push({
                type: "scattergl", mode: "markers", x: xs, y: ys,
                marker: {...markerFor(here, 4.5, classHue(cls), marks), opacity: 0.75,
                    line: {color: "#ffffff", width: 0.3}},
                text: here.map((r) => `${errorDotLabel(r, measure)}<br>Best solver: ${r.r_bestName || "Unknown"}`),
                customdata: here.map((r) => r.rowIndex ?? null),
                hovertemplate: "%{text}<br>best %{x:.3g}, chosen %{y:.3g}<extra></extra>",
                showlegend: false, xaxis: `x${suffix}`, yaxis: `y${suffix}`,
            });
            titles.push(`${classLabel(cls, rows)}, ${rungLabel(rung)}: `
                + `${measure.subject === SUBJECT_TOP ? "top" : shortSolverName(measure.subject)} is the best on `
                + `${chose} of ${here.length}`);
        }
    }
    if (!data.some((trace) => trace.x.length)) return null;
    const layout = gridLayout({
        rows: panelRowCount(titles.length), cols: PANELS_ACROSS, titles,
        xTitle: `Best candidate ${measure.noun} (an oracle pick)`,
        yTitle: measure.axisTitle,
        tickvals: undefined, ticktext: undefined,
        logY: !measure.axis,
    });
    layout.shapes = [];
    for (let i = 0; i < titles.length; i++) {
        const suffix = i === 0 ? "" : String(i + 1);
        // The same number format as the error/range y axes: powers of ten, one label
        // per decade. Left to Plotly's default, this axis read "100µ, 0.001, 0.01"
        // beside a y axis reading "10^-4, 10^-3", two notations for one quantity.
        // Both axes carry error, so apply the same scale and range to both.
        const [from, to] = measure.axis ? measure.yRange(hi) : [lo * 0.7, hi * 1.4];
        const shared = measure.axis
            ? {...measure.axis, range: [from, to], gridcolor: GRID}
            : {type: "log", gridcolor: GRID, exponentformat: "power", dtick: 1, range: [Math.log10(from), Math.log10(to)]};
        Object.assign(layout[`xaxis${suffix}`], shared);
        Object.assign(layout[`yaxis${suffix}`], {...shared, matches: undefined});
        layout.shapes.push({
            type: "line", xref: `x${suffix}`, yref: `y${suffix}`,
            x0: from, y0: from, x1: to, y1: to,
            line: {color: MUTED, width: 1, dash: "dot"}, layer: "below",
        });
    }
    const title = measure.subject === SUBJECT_TOP
        ? `${datasetLabelOf(rows)}: the cost of blind ranking, chosen candidate against the best on offer${unitSuffix(measure)}`
        : `${datasetLabelOf(rows)}: the ${measure.who} against the best candidate on offer${unitSuffix(measure)}`;
    const chosen = measure.subject === SUBJECT_TOP ? "the candidate the blind ranking put first" : `the ${measure.who}`;
    return {
        key: "rankingCost",
        title,
        data,
        layout: pageLayout(layout, {
            title,
            height: 430 * panelRowCount(titles.length) + 190,
            caption: `Each dot is one track, all clip lengths pooled. x: the error of the candidate closest to truth, which `
                + `is an oracle pick only knowable with truth in hand. y: the error of ${chosen}. A dot on the dashed `
                + `diagonal means it was the best candidate on offer, and the vertical distance above the diagonal is what `
                + `choosing it cost on that track. ${measure.floorNote("Values")}`.trimEnd(),
        }),
        config: BASE_CONFIG,
        stats: summary,
    };
}

/** Error against the two geometry axes, with a median trend over equal-count bins. */
export function figErrorVsGeometry(rows, {rungsWanted = [0, 0.2], measure = makeMeasure(), marks = makeMarks()} = {}) {
    const rungs = rungGroups(rows, rungsWanted);
    if (!rungs.length) return null;
    const floor = measure.floor;
    let peak = floor;
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
            for (const cls of classesOf(rows)) {
                const here = cell(rows, cls, null, rung).filter((r) =>
                    fin(measure.value(r)) && fin(r[axisSpec.field]) && r[axisSpec.field] > 0);
                if (!here.length) continue;
                const xs = here.map((r) => r[axisSpec.field] * axisSpec.scale);
                const ys = here.map((r) => atLeast(measure.value(r), floor));
                for (const y of ys) peak = Math.max(peak, y);
                data.push({
                    type: "scattergl", mode: "markers", x: xs, y: ys,
                    marker: {...markerFor(here, 3.5, classHue(cls), marks), opacity: 0.35},
                    // Hoverable, so a dot can name its track and show its screenshot.
                    text: here.map((r) => errorDotLabel(r, measure)),
                    customdata: here.map((r) => r.rowIndex ?? null),
                    hovertemplate: "%{text}<br>%{y:.3g}<extra></extra>",
                    showlegend: false,
                    xaxis: `x${suffix}`, yaxis: `y${suffix}`,
                });
                const trend = equalCountMedians(xs, ys, {bins: 8, minPerBin: 5});
                summary[`${rung}deg/${cls}/${axisSpec.field}`] = trend;
                data.push({
                    type: "scatter", mode: "lines+markers",
                    x: trend.map((b) => b.x), y: trend.map((b) => b.y),
                    line: {color: classHue(cls), width: 2.4},
                    marker: {color: classHue(cls), size: 7, line: {color: "#ffffff", width: 1}},
                    text: trend.map((b) => `${b.n} tracks`),
                    hovertemplate: `${classLabel(cls, rows)}: median %{y:.3g}, %{text}<extra></extra>`,
                    name: classLabel(cls, rows), showlegend: i === 0,
                    xaxis: `x${suffix}`, yaxis: `y${suffix}`,
                });
            }
            titles.push(`${axisSpec.label.split(" (")[0]}, ${rungLabel(rung)} pointing error`);
        }
    }
    if (!data.length) return null;
    const layout = gridLayout({
        rows: rungs.length, cols: 2, titles,
        xTitle: "", yTitle: measure.axisTitle,
        // Log error/range keeps its fixed top at 300% of range; other units and
        // linear axes use the data to set the top.
        yRange: measure.yRange(measure.metric === "relSep" && !measure.axis ? 3 / 2.2 : peak),
        logY: !measure.axis, yAxis: measure.axis,
    });
    for (let i = 0; i < titles.length; i++) {
        const suffix = i === 0 ? "" : String(i + 1);
        Object.assign(layout[`xaxis${suffix}`], {
            type: "log", gridcolor: GRID, tickvals: undefined, ticktext: undefined,
            title: {text: AXES[i % 2].label, font: {size: 12, color: INK}},
        });
    }
    addTolerance(layout, titles.length, measure);
    const title = `${datasetLabelOf(rows)}: ${measure.who} error against the viewing geometry${unitSuffix(measure)}`;
    return {
        key: "errorVsGeometry",
        title,
        data,
        layout: {
            ...pageLayout(layout, {
                title,
                height: 430 * rungs.length + 190, width: 1300,
                caption: `Each faint dot is one track, all clip lengths pooled, so a longer clip sits further right on the `
                    + `aperture axis. The heavy line is that class's median over equal-count bins, at least 5 tracks per `
                    + `point and up to 8 points; the line is what to read and the dots only show the spread. The parallax `
                    + `aperture is the angle at the target between the first and the last sensor position. `
                    + `${measure.tolerance ? "Dashed line: 5% of range. " : ""}${measure.floorNote("Values")}`.trimEnd(),
                legendEntries: classesOf(rows).length,
            }),
        },
        config: BASE_CONFIG,
        stats: summary,
    };
}

/** A 100% stacked mix of any categorical result field, by rung. */
export function figCategoryMix(rows, {field, key, title, caption, order = null, labels = null,
    durationsWanted = [20, 120], limit = 7} = {}) {
    const rungs = rungsOf(rows);
    const durations = durationGroups(rows, durationsWanted);
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
        for (const cls of classesOf(rows)) {
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
            titles.push(`${classLabel(cls, rows)}, ${duration === null ? "clip length unstated" : `${duration} s clips`}`);
        }
    }
    const layout = gridLayout({
        rows: panelRowCount(titles.length), cols: PANELS_ACROSS, titles,
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
            ...pageLayout(layout, {title, height: 380 * panelRowCount(titles.length) + 210, caption, legendEntries: keys.length}),
            barmode: "stack",
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
// one cell: compare the target classes
// ---------------------------------------------------------------------------
//
// Every figure above compares cells along a sweep, across pointing-error rungs or
// across clip lengths. That fits a whole scenario grid and nothing smaller: a run
// over one folder is a single cell, and it drew no figure even with three hundred
// scored tracks in it. These compare the target classes instead. They build only
// when the rows ARE one cell, so a sweep never gets a pooled figure that quietly
// mixes its rungs together.

const distinctFinite = (values) => [...new Set(values.filter(fin))].sort((a, b) => a - b);

/** At most one pointing-error rung, clip length and requested batch duration. */
export function isSingleCell(rows) {
    return rows.length > 0
        && distinctFinite(rows.map((r) => r.d_errorDeg)).length <= 1
        && durationsOf(rows).length <= 1
        && batchDurationsOf(rows).length <= 1;
}

// Preserve the reference set's order and colors, while keeping every other class
// and rows with no class. Missing truth labels must never discard scored tracks.
const UNCLASSIFIED = "(unclassified)";
const chartClass = (row) => row.d_class || UNCLASSIFIED;
export function classesOf(rows) {
    const present = new Set(rows.map(chartClass));
    return [...CLASSES.filter((cls) => present.has(cls)),
        ...[...present].filter((cls) => !CLASSES.includes(cls))];
}
const classLabel = (cls, rows) => CLASS_LABEL[cls]
    ?? (cls === UNCLASSIFIED ? datasetLabelOf(rows) : cls);
const classHue = (cls) => CLASS_HUE[cls] ?? MUTED;
const classAxisTitle = (rows) => rows.some((r) => r.d_class) ? "Target class" : "Dataset";
const classCountNote = (rows) => {
    const classes = classesOf(rows);
    if (classes.includes(UNCLASSIFIED)) return "";
    return classes.length === 3 ? ", three target classes" : `, ${classes.length} target class${classes.length === 1 ? "" : "es"}`;
};

/** "20 s clips, 0.2° pointing error", saying plainly when either is not known. */
export function cellDescription(rows) {
    const rungs = distinctFinite(rows.map((r) => r.d_errorDeg));
    const durations = durationsOf(rows);
    return `${durations.length === 1 ? `${durations[0]} s clips` : "clip length unstated"}, `
        + `${rungs.length === 1 ? `${rungs[0]}° pointing error` : "pointing error unstated"}`;
}

/** The sentence a caption owes the reader when the rung is missing, and why. */
export function unstatedNote(rows) {
    if (distinctFinite(rows.map((r) => r.d_errorDeg)).length) return "";
    const unpaired = rows.some((r) => r.in_sidecarPaired === false);
    return " The pointing error is unstated"
        + (unpaired
            ? ": no scenario sidecar was paired with these files, and the declared pointing error lives in the "
              + "sidecar. In the interchange layout the sidecars sit in a meta folder beside All, so choosing All "
              + "on its own leaves them behind. Choose the folder above All, with Recursive on, to pair them."
            : ".");
}

const classAxis = (classes, rows) => ({
    tickvals: classes.map((unused, i) => i),
    ticktext: classes.map((cls) => classLabel(cls, rows)),
});

const PERCENT_TICKS = {tickvals: [0, 0.25, 0.5, 0.75, 1], ticktext: ["0%", "25%", "50%", "75%", "100%"]};

/** The chosen candidate's error, one box per target class. */
export function figErrorByClass(rows, {measure = makeMeasure(), marks = makeMarks()} = {}) {
    if (!isSingleCell(rows)) return null;
    const classes = classesOf(rows);
    if (!classes.length) return null;
    const floor = measure.floor;
    const data = [];
    const medians = {};
    let drawn = 0, missing = 0, floored = 0, peak = floor;
    classes.forEach((cls, i) => {
        const here = cell(rows, cls);
        const values = here.map(measure.value).filter(fin);
        missing += here.length - values.length;
        drawn += values.length;
        floored += values.filter((v) => v < floor).length;
        const box = measure.boxStats(values);
        if (!box) return;
        medians[cls] = box.median;
        const points = [], hollow = [];
        for (const r of here) {
            const v = measure.value(r);
            if (!fin(v)) continue;
            peak = Math.max(peak, v);
            (measure.marksBlind && r.r_topBlind ? hollow : points)
                .push({x: i, y: atLeast(v, floor), id: r.rowIndex ?? null, label: errorDotLabel(r, measure), ...marks.style(r, 5, classHue(cls))});
        }
        data.push(boxTrace([i], [box], classHue(cls), {floor}));
        data.push(stripTrace(points, classHue(cls), {seed: 805 + i}));
        if (hollow.length) data.push(stripTrace(hollow, classHue(cls), {hollow: true, seed: 905 + i}));
    });
    if (!drawn) return null;
    const title = `${datasetLabelOf(rows)}: ${measure.who} error by ${classAxisTitle(rows).toLowerCase()}${unitSuffix(measure)}`;
    const layout = gridLayout({
        rows: 1, cols: 1, titles: [cellDescription(rows)],
        xTitle: classAxisTitle(rows), yTitle: measure.axisTitle,
        ...classAxis(classes, rows),
        yRange: measure.yRange(peak), logY: !measure.axis, yAxis: measure.axis,
    });
    addTolerance(layout, 1, measure);
    const parts = classes.filter((cls) => fin(medians[cls]))
        .map((cls) => `${classLabel(cls, rows)} median ${measure.format(medians[cls])} over ${cell(rows, cls).length} tracks`);
    return {
        key: "errorByClass", title, data,
        layout: pageLayout(layout, {
            title, width: 1050, height: 660,
            caption: `${drawn} tracks drawn (${missing} with no value for the ${measure.who} are not drawn). `
                + `${measure.boxNote} ${measure.fenceNote} ${hollowNote(measure)}`
                + `${measure.floorNote(floored)}${parts.join("; ")}.${unstatedNote(rows)}`,
        }),
        config: BASE_CONFIG,
        stats: medians,
    };
}

/** Share of tracks inside 5% and 1% of range, per class, with exact intervals. */
export function figWithinByClass(rows, {measure = makeMeasure()} = {}) {
    if (!isSingleCell(rows)) return null;
    const classes = classesOf(rows);
    if (!classes.length || !rows.some((r) => fin(measure.relSep(r)))) return null;
    // One hue in two steps: the series are an ORDERED pair of tolerances, not two
    // unrelated categories, so darker means stricter.
    const TOLERANCES = [
        {tol: TOL5, color: "#6aa9e0", label: "within 5% of range"},
        {tol: TOL1, color: "#14487f", label: "within 1% of range"},
    ];
    const data = [];
    const summary = {};
    TOLERANCES.forEach((spec, ti) => {
        // A tolerance is a share of range, whatever unit the error figures are drawn in.
        const counts = classes.map((cls) => withinTolerance(cell(rows, cls), spec.tol, measure.relSep));
        classes.forEach((cls, i) => { summary[`${formatPercent(spec.tol)}/${cls}`] = counts[i]; });
        const trace = proportionTrace(classes.map((unused, i) => i), counts, spec.color, spec.label,
            {dx: (ti - 0.5) * 0.18});
        trace.mode = "markers";
        trace.marker = {color: spec.color, size: 11, line: {color: "#ffffff", width: 1}};
        trace.showlegend = true;
        data.push(trace);
    });
    const title = `${datasetLabelOf(rows)}: share of tracks with the ${measure.who} within tolerance, by ${classAxisTitle(rows).toLowerCase()}`;
    const layout = gridLayout({
        rows: 1, cols: 1, titles: [cellDescription(rows)],
        xTitle: classAxisTitle(rows), yTitle: "Fraction of tracks", ...classAxis(classes, rows), logY: false,
    });
    Object.assign(layout.yaxis, {range: [-0.02, 1.04], ...PERCENT_TICKS});
    const parts = classes.map((cls) => {
        const five = summary[`${formatPercent(TOL5)}/${cls}`];
        const one = summary[`${formatPercent(TOL1)}/${cls}`];
        return `${classLabel(cls, rows)} ${five.k} of ${five.n} within 5%, ${one.k} within 1%`;
    });
    return {
        key: "withinByClass", title, data,
        layout: {
            ...pageLayout(layout, {
                title, width: 1050, height: 660,
                caption: `Points: k of n tracks whose ${measure.who} lies within the tolerance, as a share of the mean `
                    + `true range; a track with no value for it counts as outside. Bars: exact 95% Clopper-Pearson `
                    + `intervals, which are conservative by construction. ${parts.join("; ")}.${unstatedNote(rows)}`,
                legendEntries: data.length,
            }),
        },
        config: BASE_CONFIG,
        stats: summary,
    };
}

/** The verdict's class outcome, one stacked bar per target class. */
export function figOutcomeByClass(rows) {
    if (!isSingleCell(rows)) return null;
    const classes = classesOf(rows);
    // A track whose true class is not known cannot be sorted into "true" or "only
    // other", so it is left out and counted in the caption, never scored a miss.
    const judged = rows.filter((r) => r.d_classCorrect === true || r.d_classCorrect === false);
    if (!classes.length || !judged.length) return null;
    const data = [];
    const summary = {};
    for (const outcome of OUTCOMES) {
        const fractions = classes.map((cls) => {
            const here = cell(judged, cls);
            const n = here.filter((r) => outcomeOf(r) === outcome).length;
            summary[`${cls}/${outcome}`] = n;
            return here.length ? n / here.length : 0;
        });
        data.push({
            type: "bar", x: classes.map((unused, i) => i), y: fractions, name: outcome, width: 0.6,
            marker: {color: OUTCOME_HUE[outcome], line: {color: "#ffffff", width: 1}},
            hovertemplate: `${outcome}: %{y:.0%}<extra></extra>`,
        });
    }
    const title = `${datasetLabelOf(rows)}: what the verdict says about the object class`;
    const layout = gridLayout({
        rows: 1, cols: 1, titles: [cellDescription(rows)],
        xTitle: classAxisTitle(rows), yTitle: "Share of tracks", ...classAxis(classes, rows), logY: false, topPad: 0.87,
    });
    Object.assign(layout.yaxis, {range: [0, 1], ...PERCENT_TICKS, gridcolor: "rgba(0,0,0,0)"});
    const leftOut = rows.length - judged.length;
    return {
        key: "outcomeByClass", title, data,
        layout: {
            ...pageLayout(layout, {
                title, width: 1050, height: 660,
                caption: `Each bar is every judged track of that class, ${judged.length} of ${rows.length}`
                    + `${leftOut ? `; ${leftOut} with no known true class are left out` : ""}. "true class viable" means `
                    + `the verdict's viable list contains the true class: party and weather balloons map to the balloon `
                    + `class, the drone to the fixed-wing class. "only other classes viable" means it named classes but `
                    + `not the right one. "nothing viable" is the unresolved verdict, a safety valve and not an anomaly `
                    + `claim.${unstatedNote(rows)}`,
                legendEntries: OUTCOMES.length,
            }),
            barmode: "stack",
        },
        config: BASE_CONFIG,
        stats: summary,
    };
}

/** A 100% stacked mix of a categorical result field, one bar per target class. */
export function figMixByClass(rows, {field, key, title, caption, order = null, labels = null, limit = 7} = {}) {
    if (!isSingleCell(rows)) return null;
    const classes = classesOf(rows);
    if (!classes.length) return null;
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
    const data = keys.map((name) => ({
        type: "bar",
        x: classes.map((unused, i) => i),
        y: classes.map((cls) => {
            const here = cell(rows, cls);
            if (!here.length) return 0;
            const n = name === "Other"
                ? here.filter((r) => !keys.includes(String(r[field] ?? "null"))).length
                : here.filter((r) => String(r[field] ?? "null") === name).length;
            return n / here.length;
        }),
        name: labels?.[name] ?? name,
        width: 0.6,
        marker: {color: hue[name], line: {color: "#ffffff", width: 1}},
        hovertemplate: `${labels?.[name] ?? name}: %{y:.0%}<extra></extra>`,
    }));
    const layout = gridLayout({
        rows: 1, cols: 1, titles: [cellDescription(rows)],
        xTitle: classAxisTitle(rows), yTitle: "Share of tracks", ...classAxis(classes, rows), logY: false, topPad: 0.87,
    });
    Object.assign(layout.yaxis, {range: [0, 1], ...PERCENT_TICKS, gridcolor: "rgba(0,0,0,0)"});
    return {
        key, title, data,
        layout: {
            ...pageLayout(layout, {title, width: 1050, height: 660, caption: caption + unstatedNote(rows),
                legendEntries: keys.length}),
            barmode: "stack",
        },
        config: BASE_CONFIG,
    };
}

// ---------------------------------------------------------------------------
// every candidate, by solver
// ---------------------------------------------------------------------------

/** A solver's name, short enough for an axis label. */
export function shortSolverName(name) {
    return String(name ?? "?")
        .replace(/^Global Fit:\s*/i, "")
        .replace(/\s*\(generic prior\)/i, "")
        .replace(/Polynomial LSQ \(order (\d+)\)/i, "Polynomial LSQ $1");
}

const isLanternCandidate = (candidate) => /^Possible sky lantern\b/i.test(candidate?.name ?? "");

/** The compact solver label, retaining wind variants except for the pooled lantern group. */
export function solverAxisName(candidate) {
    if (isLanternCandidate(candidate)) return "lantern";
    const supplied = solverById(candidate?.key)?.shortName;
    const name = String(candidate?.name ?? candidate?.key ?? "?");
    if (supplied) {
        const windSuffix = /\(supplied wind \+ correction\)$/i.test(name) ? "/GW+"
            : /\(supplied wind\)$/i.test(name) ? "/GW"
            : /\(fitted wind\)$/i.test(name) ? "/FW"
            : /\(wind undetermined\)$/i.test(name) ? "/UW" : "";
        return supplied + windSuffix;
    }
    const order = name.match(/\(order\s+(\d+)\)/i)?.[1];
    if (order && candidate?.key === "gfPolyALS") return `poly_${order}`;
    if (order && candidate?.key === "gfMC1") return `mc1_${order}`;
    if (order && candidate?.key === "gfMC2") return `mc2_${order}`;
    return shortSolverName(name);
}

// The comparison chart used for the compact solver review. Match both stable
// solver IDs and names because imported result files can carry either one.
const CUSTOM_SOLVER_KEYS = new Map([
    ["gfca", 0], ["gfcv", 1], ["gfkalman", 2],
    ["mc_100k", 3], ["mc_1m", 4], ["mc_250k", 5], ["mc_500k", 6], ["mc_50k", 7],
]);

function customSolverRank(candidate) {
    const byKey = CUSTOM_SOLVER_KEYS.get(String(candidate?.key ?? "").toLowerCase());
    if (byKey !== undefined) return byKey;
    const name = shortSolverName(candidate?.name ?? candidate?.key).trim();
    if (/^(?:constant acceleration|ca)$/i.test(name)) return 0;
    if (/^(?:constant velocity|cv)$/i.test(name)) return 1;
    if (/^kalman(?: smoother)?$/i.test(name)) return 2;
    const mc = name.match(/^(?:monte carlo|mc)\s*(100k|1m|250k|500k|50k)(?:\s*\(gpu\))?$/i);
    if (!mc) return null;
    return {"100k": 3, "1m": 4, "250k": 5, "500k": 6, "50k": 7}[mc[1].toLowerCase()];
}

/**
 * Every candidate's error against truth, one box per solver variant. The
 * rise-then-fall lantern candidates share one box across wind variants.
 *
 * The other error figures follow the candidate the blind ranking put first. This one
 * scores every candidate each solver produced, chosen or not, which separates a
 * solver that cannot find the answer from one that finds it and is out-ranked. It
 * builds only from rows carrying every candidate's error (r_candidates), which a
 * BOTBench run keeps; a joined JSONL without them gets no figure.
 */
export function figErrorBySolver(rows, {rungsWanted = [0, 0.2], measure = makeMeasure(), marks = makeMarks(),
    sortByMedian = false, customOrder = false} = {}) {
    const scored = rows.filter((r) => Array.isArray(r.r_candidates) && r.r_candidates.length);
    if (!scored.length) return null;
    const rungs = rungGroups(scored, rungsWanted);
    const presentRungs = [...new Set(scored.map((r) => r.d_errorDeg).filter(fin))].sort((a, b) => a - b);
    const groups = rungs.map((rung) => ({rung, key: `${rung}deg`, label: `${rungLabel(rung)} pointing error`, pooled: false}));
    if (presentRungs.length > 1) {
        groups.push({rung: null, key: "all", label: "All Pointing Errors", pooled: true});
    }
    if (!groups.length) return null;
    const floor = measure.floor, ceiling = measure.ceiling;
    // Dots of 3 px would shrink to 1 px at the shortest length, so area by length starts from 4.
    const dotSize = marks.sizeByLength ? 4 : 3;
    const nameOf = (c) => c.name ?? c.key ?? "?";
    const groupOf = (c) => isLanternCandidate(c) ? "Possible sky lantern (rise then fall)" : nameOf(c);

    // The ordinary figure preserves the solver order carried by the candidate
    // lists. The sorted companion derives EACH panel's order from the same
    // values used to build that panel's boxes. Sorting a separate pooled list
    // can put a solver with a visibly lower box to the right in a particular
    // panel, which defeats the purpose of the sorted view.
    const pooled = new Map();
    const customRanks = new Map();
    const axisNames = new Map();
    for (const r of scored) {
        for (const c of r.r_candidates) {
            const v = measure.candidate(c);
            if (!fin(v)) continue;
            const name = groupOf(c);
            if (!pooled.has(name)) pooled.set(name, []);
            pooled.get(name).push(v);
            if (!axisNames.has(name)) axisNames.set(name, solverAxisName(c));
            const rank = customSolverRank(c);
            if (rank !== null && (!customRanks.has(name) || rank < customRanks.get(name))) customRanks.set(name, rank);
        }
    }
    const solvers = [...pooled.keys()];
    if (!solvers.length) return null;
    const analysisOrder = new Map(solvers.map((name, i) => [name, i]));
    const customSolvers = solvers.slice().sort((a, b) => {
        const ar = customRanks.get(a), br = customRanks.get(b);
        if (ar !== undefined && br !== undefined) return ar - br;
        if (ar !== undefined) return -1;
        if (br !== undefined) return 1;
        return analysisOrder.get(a) - analysisOrder.get(b);
    });

    const data = [], titles = [];
    const medians = {};
    const solverOrders = [];
    const lowest = [];
    // Twenty percent taller than the compact solver layout, with a stable
    // pixel band for the long rotated solver labels above the caption.
    const chartHeight = 336 * panelRowCount(groups.length * classesOf(rows).length) + 120;
    const plotHeight = chartHeight - 52 - 130; // pageLayout's top and bottom margins
    const bottomPad = Math.min(0.36, 92 / plotHeight);
    let drawn = 0, floored = 0, capped = 0, peak = floor;
    // Pack available class and pointing-error panels three across, including unclassified datasets.
    for (const group of groups) {
        for (const cls of classesOf(rows)) {
            const i = titles.length;
            const suffix = i === 0 ? "" : String(i + 1);
            const here = group.pooled
                ? scored.filter((r) => chartClass(r) === cls && fin(r.d_errorDeg))
                : cell(scored, cls, null, group.rung);
            const valuesBySolver = new Map(solvers.map((name) => [name, []]));
            for (const r of here) {
                for (const c of r.r_candidates) {
                    const v = measure.candidate(c);
                    if (fin(v) && valuesBySolver.has(groupOf(c))) valuesBySolver.get(groupOf(c)).push(v);
                }
            }
            const panelSolvers = (customOrder ? customSolvers : solvers).slice();
            if (sortByMedian) {
                panelSolvers.sort((a, b) => {
                    const ma = median(valuesBySolver.get(a));
                    const mb = median(valuesBySolver.get(b));
                    if (fin(ma) && fin(mb)) return ma - mb || a.localeCompare(b);
                    if (fin(ma)) return -1;
                    if (fin(mb)) return 1;
                    return a.localeCompare(b);
                });
            }
            solverOrders.push(panelSolvers);
            const slot = new Map(panelSolvers.map((name, s) => [name, s]));
            const values = panelSolvers.map((name) => valuesBySolver.get(name));
            const points = [];
            for (const r of here) {
                for (const c of r.r_candidates) {
                    const s = slot.get(groupOf(c));
                    const v = measure.candidate(c);
                    if (s === undefined || !fin(v)) continue;
                    points.push({x: s, y: Math.min(atLeast(v, floor), ceiling), id: r.rowIndex ?? null, ...marks.style(r, dotSize, classHue(cls)),
                        label: solverLabel(r, nameOf(c))});
                    // A value past the ceiling is drawn at it; its label keeps the value itself.
                    if (v > ceiling) {
                        points[points.length - 1].label += ` (${v.toPrecision(3)}, drawn at the ceiling)`;
                        capped++;
                    }
                    peak = Math.max(peak, Math.min(v, ceiling));
                    if (v < floor) floored++;
                    drawn++;
                }
            }
            const stats = panelSolvers.map((name, s) => {
                const box = measure.boxStats(values[s]);
                if (box) medians[`${group.key}/${cls}/${name}`] = box.median;
                return box;
            });
            data.push(boxTrace(panelSolvers.map((unused, s) => s), stats, classHue(cls), {
                axis: suffix, floor, ceiling, width: 0.82, fillAlpha: 0.24, lineColor: INK, lineWidth: 0.8,
            }));
            if (points.length) data.push(stripTrace(points, classHue(cls), {axis: suffix, size: dotSize, opacity: 0.65}));
            const best = panelSolvers.map((name) => [name, medians[`${group.key}/${cls}/${name}`]])
                .filter(([, m]) => fin(m)).sort((a, b) => a[1] - b[1])[0];
            if (best) {
                lowest.push(`${classLabel(cls, rows)} ${group.label}: ${axisNames.get(best[0]) ?? shortSolverName(best[0])} ${measure.format(best[1])}`);
            }
            titles.push(`${classLabel(cls, rows)}, ${group.label}`);
        }
    }
    if (!drawn) return null;
    const layout = gridLayout({
        rows: panelRowCount(titles.length), cols: PANELS_ACROSS, titles,
        xTitle: "", yTitle: `Candidate ${measure.noun}`,
        vGap: 0.14, bottomPad,
        // The custom metre view uses a stable comparison range. Plotly log ranges
        // are exponents; a linear view uses the equivalent values in metres.
        yRange: customOrder && measure.metric === "sepM"
            ? (measure.axis ? [10 ** 0.5, 10 ** 6.2] : [0.5, 6.2])
            : measure.yRange(peak),
        logY: !measure.axis, yAxis: measure.axis,
    });
    for (let i = 0; i < titles.length; i++) {
        const suffix = i === 0 ? "" : String(i + 1);
        const panelSolvers = solverOrders[i];
        Object.assign(layout[`xaxis${suffix}`], {
            tickvals: panelSolvers.map((unused, s) => s),
            ticktext: panelSolvers.map((name) => axisNames.get(name) ?? shortSolverName(name)),
            tickangle: -45, tickfont: {size: 10, color: INK2},
        });
    }
    addTolerance(layout, titles.length, measure);
    const modeSuffix = customOrder ? ", custom solver order" : sortByMedian ? ", sorted by median" : "";
    const key = customOrder ? "errorBySolverCustom" : sortByMedian ? "errorBySolverSorted" : "errorBySolver";
    const title = `${datasetLabelOf(rows)}: every candidate's error, by solver${modeSuffix}`
        + unitSuffix(measure);
    return {
        key, title, data,
        layout: {...pageLayout(layout, {
            title, height: chartHeight,
            caption: `${drawn} candidate errors drawn across the panels from ${scored.length} tracks, all clip lengths pooled. `
                + (presentRungs.length > 1
                    ? `All Pointing Errors pools all ${presentRungs.length} available levels for each target class. ` : "")
                + `One box per solver variant: `
                + `every candidate in that group, scored against truth whether or not the blind ranking put it `
                + `first. A solver with a low box can find the answer; set it beside the blind top candidate's error in `
                + `the clip-length figure to see what the ranking passed over. `
                + ([...axisNames.values()].some((name) => /\/(?:FW|GW\+?|UW)$/.test(name))
                    ? `FW = fitted wind; GW = supplied wind; GW+ = supplied wind + correction; UW = wind undetermined. ` : "")
                + ([...axisNames.values()].includes("lantern")
                    ? `The lantern box pools rise-then-fall candidates across all wind variants. ` : "")
                + (customOrder
                    ? `CA, CV, Kalman, MC 100k, MC 1M, MC 250K, MC 500K and MC 50K appear first in that order when present; remaining solvers keep the order supplied by the analysis. `
                    : sortByMedian
                    ? `Each panel's solvers are ordered by that panel's median error, best first. `
                    : `Solvers keep the order supplied by the analysis. `)
                + (customOrder && measure.metric === "sepM"
                    ? `The metre-error Y axis is fixed from 10^0.5 m to 10^6.2 m. ` : "")
                + `${measure.boxNote} ${measure.fenceNote} Dots show every candidate value`
                + (measure.axis ? "" : `; ${floored} values below ${measure.format(floor)} are drawn at the floor`)
                + (capped ? `${measure.axis ? ";" : ", and"} ${capped} above ${measure.ceilingLabel} at the ceiling, where the `
                    + "hover label gives the value itself" : "")
                + `. Lowest median per panel: ${lowest.join("; ")}.`
                + (measure.subject === SUBJECT_TOP ? "" : " The candidate choice does not apply here: every candidate is shown."),
        }), boxgap: 0.12},
        config: BASE_CONFIG,
        stats: {solvers: (sortByMedian || customOrder) ? solverOrders[0] : solvers, solverOrders, medians},
    };
}

// ---------------------------------------------------------------------------
// the registry both front ends walk
// ---------------------------------------------------------------------------

// Each entry says what the figure reads beyond the rows: `dots` marks a figure whose
// points are tracks (the dot marks apply), `measure` which error choices it honours
// ("full": the candidate and the unit; "subject": the candidate only, since the
// tolerance figures always use a share of range), and `allTurnLevels` that it takes
// every sensor-turn level whatever the turn choice. The window's full-size view
// shows only the choices a figure reads.
export const FIGURES = [
    {key: "errorByClass", name: "Error by target class", group: "This run",
        dots: true, measure: "full", build: (rows, {measure, marks} = {}) => figErrorByClass(rows, {measure, marks})},
    {key: "withinByClass", name: "Within tolerance, by target class", group: "This run",
        measure: "subject", build: (rows, {measure} = {}) => figWithinByClass(rows, {measure})},
    {key: "outcomeByClass", name: "What the verdict says, by target class", group: "This run",
        build: (rows) => figOutcomeByClass(rows)},
    {key: "verdictByClass", name: "Verdict code, by target class", group: "This run",
        build: (rows) => figMixByClass(rows, {
            field: "r_verdict", key: "verdictByClass", order: VERDICT_ORDER,
            title: `${datasetLabelOf(rows)}: executive verdict code by ${classAxisTitle(rows).toLowerCase()}`,
            caption: "Each bar is every track of that class, ordered by how far the verdict narrows the answer: "
                + "'consistent-one' leaves a single viable interpretation class, 'consistent-several' leaves more "
                + "than one, and 'unresolved' means no tested conventional model passed the screen.",
        })},
    {key: "topCandidateByClass", name: "First-ranked hypothesis, by target class", group: "This run",
        build: (rows) => figMixByClass(rows, {
            field: "r_topKey", key: "topCandidateByClass", labels: labelMapFrom(rows, "r_topKey", "r_topName"),
            title: `${datasetLabelOf(rows)}: which hypothesis the blind ranking puts first, by ${classAxisTitle(rows).toLowerCase()}`,
            caption: "Each bar is every track of that class. Balloon and Quadcopter are object models; "
                + "Polynomial LSQ, Constant Altitude and Saddle are curve fits that carry no object claim.",
        })},
    {key: "errorByLength", name: "Error by clip length", group: "Accuracy",
        dots: true, measure: "full", build: (rows, {measure, marks} = {}) => figErrorByLength(rows, {measure, marks})},
    {key: "errorByDuration", name: "Error by Duration", group: "Accuracy",
        dots: true, measure: "full", build: (rows, {measure, marks} = {}) => figErrorByDuration(rows, {measure, marks})},
    {key: "errorByTrueDistance", name: "Error by true distance", group: "Accuracy",
        dots: true, measure: "full", build: (rows, {measure, marks} = {}) => figErrorByTrueDistance(rows, {measure, marks})},
    {key: "absoluteErrorVsTrueRange", name: "Mean absolute error vs. mean true range", group: "Accuracy",
        dots: true, measure: "subject", fixedMetric: "sepM",
        build: (rows, {measure, marks} = {}) => figAbsoluteErrorVsTrueRange(rows, {measure, marks})},
    {key: "errorByRung", name: "Error by pointing error", group: "Accuracy",
        dots: true, measure: "full", build: (rows, {measure, marks} = {}) => figErrorByRung(rows, {measure, marks})},
    {key: "withinByLength", name: "Within tolerance, by length", group: "Accuracy",
        measure: "subject", build: (rows, {measure} = {}) => figWithinTolerance(rows, {axis: "length", fixed: [0, 0.2], measure})},
    {key: "withinByRung", name: "Within tolerance, by pointing error", group: "Accuracy",
        measure: "subject", build: (rows, {measure} = {}) => figWithinTolerance(rows, {axis: "rung", fixed: [20, 120], measure})},
    {key: "errorByLengthAndTurn", name: "Error by clip length, per sensor turn", group: "Sensor turn", allTurnLevels: true,
        measure: "full", build: (rows, {measure} = {}) => figErrorByTurn(rows, {across: "length", measure})},
    {key: "errorByTurn", name: "Error by sensor turn, per clip length", group: "Sensor turn", allTurnLevels: true,
        measure: "full", build: (rows, {measure} = {}) => figErrorByTurn(rows, {across: "turn", measure})},
    {key: "errorBySolver", name: "Error by solver", group: "Accuracy",
        dots: true, measure: "full", build: (rows, {measure, marks} = {}) => figErrorBySolver(rows, {measure, marks})},
    {key: "errorBySolverSorted", name: "Error by solver (Sorted)", group: "Accuracy",
        dots: true, measure: "full",
        build: (rows, {measure, marks} = {}) => figErrorBySolver(rows, {measure, marks, sortByMedian: true})},
    {key: "errorBySolverCustom", name: "Error by solver (Custom)", group: "Accuracy",
        dots: true, measure: "full",
        build: (rows, {measure, marks} = {}) => figErrorBySolver(rows, {measure, marks, customOrder: true})},
    {key: "errorVsGeometry", name: "Error against geometry", group: "Geometry",
        dots: true, measure: "full", build: (rows, {measure, marks} = {}) => figErrorVsGeometry(rows, {measure, marks})},
    {key: "classOutcome", name: "What the verdict says about the class", group: "Interpretation",
        build: (rows) => figClassOutcome(rows)},
    {key: "verdictMix", name: "Verdict code", group: "Interpretation",
        build: (rows) => figCategoryMix(rows, {
            field: "r_verdict", key: "verdictMix", order: VERDICT_ORDER,
            title: `${datasetLabelOf(rows)}: executive verdict code by pointing error`,
            caption: "Each bar includes all tracks in its group, ordered by how far the verdict narrows the answer: "
                + "'consistent-one' leaves a single viable interpretation class, 'consistent-several' leaves more "
                + "than one, and 'unresolved' means no tested conventional model passed the screen, which the "
                + "analysis states is a safety valve and not an anomaly claim.",
        })},
    {key: "topCandidateMix", name: "First-ranked hypothesis", group: "Interpretation",
        build: (rows) => figCategoryMix(rows, {
            field: "r_topKey", key: "topCandidateMix",
            labels: labelMapFrom(rows, "r_topKey", "r_topName"),
            title: `${datasetLabelOf(rows)}: which hypothesis the blind ranking puts first`,
            caption: "Each bar includes all tracks in its group. The bar shows the hypothesis family the ranking placed first without "
                + "seeing truth. Balloon and Quadcopter are object models; Polynomial LSQ, Constant "
                + "Altitude and Saddle are curve fits that carry no object claim.",
        })},
    {key: "rankingCost", name: "Cost of blind ranking", group: "Ranking",
        dots: true, measure: "full", build: (rows, {measure, marks} = {}) => figRankingCost(rows, {measure, marks})},
];

/**
 * Build every figure the rows can support. Nulls (too little data) are dropped.
 *
 * measure says whose error the error figures plot, and in what unit. The default
 * is the blind top candidate as a share of range, which is what every figure drew
 * before the choice existed.
 *
 * turnDeg limits the rows to one sensor-turn level, and each figure's title says so.
 * The figures that compare turn levels (allTurnLevels) always take every row.
 *
 * marks says how the dots are marked (makeMarks). The area scale is set once from every
 * row, so a dot of one clip length has one area in every figure.
 */
export function buildAllFigures(rows, {only = null, measure = makeMeasure(), turnDeg = null, marks = null} = {}) {
    const oneLevel = fin(turnDeg) ? rows.filter((r) => same(r.d_turnDeg, turnDeg)) : rows;
    const dotMarks = makeMarks(marks ?? {}, rows);
    return FIGURES
        .filter((f) => !only || only.includes(f.key))
        .map((f) => {
            try {
                const figure = f.build(f.allTurnLevels ? rows : oneLevel, {measure, marks: dotMarks});
                if (figure && !f.allTurnLevels && fin(turnDeg)) markTurnLevel(figure, turnDeg);
                if (figure && f.dots && dotMarks.active) appendCaption(figure, dotMarks.note);
                return figure;
            } catch (e) { return {key: f.key, error: String(e?.message ?? e)}; }
        })
        .filter(Boolean);
}

/** Add to a figure's title the sensor-turn level its rows were limited to. */
function markTurnLevel(figure, turnDeg) {
    const note = `, sensor turn ${turnDeg}°`;
    figure.title = `${figure.title}${note}`;
    if (figure.layout?.title?.text) figure.layout.title = {...figure.layout.title, text: `${figure.layout.title.text}${note}`};
}
