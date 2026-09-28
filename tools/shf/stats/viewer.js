// viewer.js — charts for the output of flare-stats.mjs, drawn in the browser.
//
// Reads the CSV files and run.json of one output folder: from a folder or file picker,
// from files dropped on the page, or from ?data=<folder URL>/. Nothing is uploaded.

import { createLineChart } from "./lineChart.js";

const MAX_SERIES = 8;     // the categorical palette has 8 slots; colors are never cycled
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86400000;
const NEEDED = ["flares_per_night_visible.csv", "flares_per_night_all.csv",
    "flares_per_hour_year_visible.csv", "flares_per_hour_year_all.csv",
    "flares_per_hour_by_month_visible.csv", "flares_per_hour_by_month_all.csv", "summary.csv"];

const $ = (id) => document.getElementById(id);
const state = { data: null, kind: "visible", hidden: new Set() };
const charts = {};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
function parseCsv(text) {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.length);
    const rows = lines.map((l) => l.split(","));
    return { header: rows[0], rows: rows.slice(1) };
}

// files: Map name -> text
function ingest(files) {
    const missing = NEEDED.filter((n) => !files.has(n));
    if (missing.length) throw new Error(`These files are missing: ${missing.join(", ")}. ` +
        "Choose the folder that flare-stats.mjs wrote.");
    const data = { run: files.has("run.json") ? JSON.parse(files.get("run.json")) : null };
    for (const name of NEEDED) data[name.replace(".csv", "")] = parseCsv(files.get(name));
    return data;
}

async function readFileList(list) {
    const files = new Map();
    for (const file of list) {
        if (/\.(csv|json)$/.test(file.name)) files.set(file.name, await file.text());
    }
    return files;
}

async function loadFromUrl(base) {
    const dir = base.endsWith("/") ? base : base + "/";
    const files = new Map();
    for (const name of [...NEEDED, "run.json"]) {
        const resp = await fetch(new URL(name, new URL(dir, location.href)), { cache: "no-store" });
        if (resp.ok) files.set(name, await resp.text());
        else if (name !== "run.json") throw new Error(`Could not load ${dir}${name} (HTTP ${resp.status}).`);
    }
    return files;
}

async function load(getFiles) {
    const error = $("loadError");
    error.hidden = true;
    try {
        state.data = ingest(await getFiles());
        state.hidden.clear();
        $("loader").hidden = true;
        $("report").hidden = false;
        renderAll();
    } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        $("loader").hidden = false;
    }
}

for (const id of ["pickFolder", "pickFiles", "pickAgain"]) {
    $(id).addEventListener("change", (e) => {
        // Copy the files first: clearing the input (so the same folder can be chosen
        // again) empties its live FileList while the files are still being read.
        const list = [...e.target.files];
        e.target.value = "";
        if (list.length) load(() => readFileList(list));
    });
}
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
    e.preventDefault();
    const list = [...e.dataTransfer.files];
    if (list.length) load(() => readFileList(list));
});

// ---------------------------------------------------------------------------
// Series and controls
// ---------------------------------------------------------------------------
// Series identity comes from the column position in the CSV header, so a latitude keeps
// its color when others are hidden.
function seriesFrom(header, rows, firstCol) {
    return header.slice(firstCol, firstCol + MAX_SERIES).map((name, k) => ({
        name,
        colorVar: `--series-${k + 1}`,
        values: rows.map((r) => (r[firstCol + k] === "" ? null : Number(r[firstCol + k]))),
    })).filter((s) => !state.hidden.has(s.name));
}

function renderControls() {
    document.querySelectorAll(".segmented button").forEach((b) => {
        b.setAttribute("aria-checked", String(b.dataset.kind === state.kind));
    });
    const header = state.data.summary.rows.map((r) => r[0]).slice(0, MAX_SERIES);
    const legend = $("legend");
    legend.replaceChildren();
    header.forEach((name, k) => {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("aria-pressed", String(!state.hidden.has(name)));
        const swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.background = `var(--series-${k + 1})`;
        button.append(swatch, document.createTextNode(name));
        button.addEventListener("click", () => {
            if (state.hidden.has(name)) state.hidden.delete(name); else state.hidden.add(name);
            renderAll();
        });
        legend.appendChild(button);
    });
    const total = state.data.summary.rows.length;
    const note = $("seriesNote");
    note.hidden = total <= MAX_SERIES;
    note.textContent = `This run has ${total} latitudes. The charts show the first ${MAX_SERIES}; ` +
        "the tables show all of them.";
}

document.querySelectorAll(".segmented button").forEach((b) => {
    b.addEventListener("click", () => { state.kind = b.dataset.kind; renderAll(); });
});

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------
function chart(id, host, options) {
    if (charts[id] && charts[id].host === host) charts[id].chart.update(options);
    else charts[id] = { host, chart: createLineChart(host, options) };
}

function describeRun(run) {
    if (!run) return "Loaded results (no run.json, so the settings are unknown).";
    const where = [`longitude ${run.lon}°`];
    if (run.altKm) where.push(`altitude ${run.altKm} km`);
    if (run.minElevationDeg) where.push(`flares above ${run.minElevationDeg}°`);
    const source = run.source === "synthetic" ? "synthetic constellation" : `element set ${run.tle || run.source}`;
    return `${run.from} to ${run.to}, ${run.nights} nights (every ${run.stepDays} day${run.stepDays > 1 ? "s" : ""}), ` +
        `${where.join(", ")}, ${source}${run.model ? `, model ${run.model}` : ""}.`;
}

function nightChart() {
    const { header, rows } = state.data[`flares_per_night_${state.kind}`];
    const t0 = Date.parse(rows[0][0] + "T00:00:00Z");
    const multiYear = rows[0][0].slice(0, 4) !== rows[rows.length - 1][0].slice(0, 4);
    const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    const x = rows.map((r) => {
        const ms = Date.parse(r[0] + "T00:00:00Z");
        return { pos: (ms - t0) / DAY_MS, label: `Night of ${dateFmt.format(ms)}` };
    });
    // A tick on the first of each month in the range.
    const xTicks = [];
    const last = Date.parse(rows[rows.length - 1][0] + "T00:00:00Z");
    const first = new Date(t0);
    for (let d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1)); d <= last;
         d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
        if (d.getTime() < t0) continue;
        const m = d.getUTCMonth();
        xTicks.push({ pos: (d.getTime() - t0) / DAY_MS, label: MONTHS[m] + (multiYear && m === 0 ? ` ${d.getUTCFullYear()}` : "") });
    }
    // Thin the ticks on a narrow screen.
    const step = $("chartNight").clientWidth < 600 ? 2 : 1;
    chart("night", $("chartNight"), {
        x, xTicks: xTicks.filter((_, i) => i % step === 0),
        series: seriesFrom(header, rows, 1), yLabel: "Flares per night",
    });
    table($("tableNight"), header, rows);
}

function hourAxis(hourLabels) {
    const x = hourLabels.map((label, i) => {
        const h = Number(label.slice(0, 2));
        return { pos: i, label: `${label}–${String((h + 1) % 24).padStart(2, "0")}:00 local solar time` };
    });
    const xTicks = hourLabels.map((label, i) => ({ pos: i, label: label.slice(0, 2) })).filter((_, i) => i % 3 === 0);
    return { x, xTicks };
}

function hourChart() {
    const { header, rows } = state.data[`flares_per_hour_year_${state.kind}`];
    chart("hour", $("chartHour"), {
        ...hourAxis(rows.map((r) => r[0])),
        series: seriesFrom(header, rows, 1), yLabel: "Mean flares per night in the hour",
    });
    table($("tableHour"), header, rows);
}

function monthCharts() {
    const { header, rows } = state.data[`flares_per_hour_by_month_${state.kind}`];
    const months = [];
    for (const r of rows) {
        if (!months.length || months[months.length - 1].name !== r[0]) months.push({ name: r[0], rows: [] });
        months[months.length - 1].rows.push(r);
    }
    // One y scale for every month, over the latitudes on show.
    const shown = seriesFrom(header, rows, 2);
    const yMax = Math.max(1, ...shown.flatMap((s) => s.values));
    const grid = $("chartMonths");
    if (grid.children.length !== months.length) {
        grid.replaceChildren();
        for (const k in charts) if (k.startsWith("month")) delete charts[k];
        for (const month of months) {
            const box = document.createElement("div");
            box.className = "multiple";
            const title = document.createElement("h3");
            title.textContent = month.name;
            const host = document.createElement("div");
            host.className = "chart";
            box.append(title, host);
            grid.appendChild(box);
        }
    }
    months.forEach((month, i) => {
        chart(`month${i}`, grid.children[i].querySelector(".chart"), {
            ...hourAxis(month.rows.map((r) => r[1])),
            series: seriesFrom(header, month.rows, 2), yLabel: `${month.name}: mean flares per night in the hour`,
            yMax, height: 170, compact: true,
        });
    });
    table($("tableMonths"), header, rows);
}

// ---------------------------------------------------------------------------
// Tables (every value reachable without hovering)
// ---------------------------------------------------------------------------
function table(host, header, rows) {
    const t = document.createElement("table");
    const head = t.createTHead().insertRow();
    for (const h of header) {
        const th = document.createElement("th");
        th.textContent = h;
        head.appendChild(th);
    }
    const body = t.createTBody();
    for (const r of rows) {
        const tr = body.insertRow();
        for (const v of r) tr.insertCell().textContent = v;
    }
    host.replaceChildren(t);
}

function renderAll() {
    $("runInfo").textContent = describeRun(state.data.run);
    renderControls();
    nightChart();
    hourChart();
    monthCharts();
    const s = state.data.summary;
    table($("tableSummary"), s.header, s.rows);
}

// ?data=<folder URL>/ loads straight from a server.
const dataParam = new URLSearchParams(location.search).get("data");
if (dataParam) load(() => loadFromUrl(dataParam));
