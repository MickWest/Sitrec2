// rate.js — the flare rate page: flares per night through the year, and per hour through
// one night, at a chosen latitude, from the flux-integral model in rateModel.js.
//
// The year curve comes from a precomputed table (rateTable.json, built by
// ../tools/build-rate-table.mjs: every night of the model's year span at every half degree
// of latitude, that is every position of the slider, both kinds), fetched when the page
// opens, so that the latitude slider is instant. The chosen night's profile is computed live
// by the model in a worker (rateWorker.js), so the page never waits on it. If the table
// cannot be loaded (offline before the first visit), the worker fills the year curve in,
// coarse to fine.
//
// The nights are real dates: the model places every shell's measured orbital planes where
// they are on that night, so the page covers the year span of its shell table (model.SPAN:
// 365 nights from the 1st of the month the table was measured in). "Tonight", or a link's
// date, outside the span is clamped to its nearest end, with a caution.
//
// The address always holds the current settings (?lat=35&date=2027-06-21), so the address
// itself is the link to the graph; an older link with date=06-21 opens that month and day
// inside the span. "Save image" draws both charts again off screen at a fixed width and
// saves them as one PNG, so a phone and a desktop give the same picture.

// Cache-busting, as in ../app.js: index.html loads this file as rate.js?v=<build>, and
// the same query goes on every module, worker and file this file loads.
const VERSION = new URL(import.meta.url).search;
const [model, { createLineChart }] = await Promise.all([
    import("./rateModel.js" + VERSION),
    import("../lineChart.js" + VERSION),
]);

const $ = (id) => document.getElementById(id);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December"];
const DAY_MS = 86400000;
const NIGHT_FROM = 14, NIGHT_TO = 34;  // hours shown on the night chart: 14:00 to 10:00 next day
const EXPORT_WIDTH = 1200;
const YEAR_Y_MAX = 2000;            // the year chart's fixed y axis, unless "Scale to fit" is on
                                    // (the table's highest value is 1,844 all / 1,633 visible flares, 32°S on 2 February 2027)
const DAYS = model.DAYS, SPAN = model.SPAN;

// Nights are counted from the start of the span (its first night = 0): night n is the
// night of dateOfDay(n). The labels show the full date.
const dayDate = (n) => new Date(SPAN.startMs + n * DAY_MS);
const dayName = (n) => { const d = dayDate(n); return `${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const dayShort = (n) => { const d = dayDate(n); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const dayParam = (n) => model.dateOfDay(n);
// "Night of 21 to 22 June 2027", "30 September to 1 October 2026", "31 December 2026 to 1 January 2027".
function nightName(n) {
    const a = dayDate(n), b = dayDate(n + 1);
    if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${dayName(n)} to ${dayName(n + 1)}`;
    if (a.getUTCMonth() !== b.getUTCMonth()) return `${a.getUTCDate()} ${MONTHS_LONG[a.getUTCMonth()]} to ${dayName(n + 1)}`;
    return `${a.getUTCDate()} to ${dayName(n + 1)}`;
}
const spanName = `${dayName(0)} to ${dayName(DAYS - 1)}`;
const clampDay = (n) => Math.max(0, Math.min(DAYS - 1, n));
// The night of a date parameter: "YYYY-MM-DD", or the older "MM-DD", which is the month and
// day inside the span. A date outside the span gives its nearest end, with outside set, so
// that the page can say so (a link from last year, or for a night the table does not cover).
function dayFromParam(text) {
    const full = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text || ""), short = /^(\d{1,2})-(\d{1,2})$/.exec(text || "");
    const m = full || short;
    if (!m) return null;
    const month = Number(m[full ? 2 : 1]), date = Number(m[full ? 3 : 2]);
    if (month < 1 || month > 12 || date < 1 || date > 31) return null;
    let year = full ? Number(m[1]) : null;
    if (year == null) {
        const start = dayDate(0);
        year = month - 1 >= start.getUTCMonth() ? start.getUTCFullYear() : start.getUTCFullYear() + 1;
    }
    const n = Math.round((Date.UTC(year, month - 1, date) - SPAN.startMs) / DAY_MS);
    return { day: clampDay(n), outside: n < 0 || n >= DAYS };
}
// Tonight's night index (the local date), and whether it lies outside the span.
function tonight() {
    const now = new Date();
    const n = Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - SPAN.startMs) / DAY_MS);
    return { day: clampDay(n), outside: n < 0 || n >= DAYS };
}

const latLabel = (lat) => (lat === 0 ? "0°" : `${formatLat(Math.abs(lat))}°${lat > 0 ? "N" : "S"}`);
const formatLat = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const clock = (hours) => {
    const minutes = Math.round(hours * 60) % 1440;
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};
const round = (v) => (v >= 10 ? Math.round(v).toLocaleString() : v.toFixed(1));

// ---------------------------------------------------------------------------
// State, and the address that holds it
// ---------------------------------------------------------------------------
// Latitude: from the link, else the user's position when the browser already has
// permission to give it, else 45°N (see useKnownLocation).
const DEFAULT_LAT = 45;
// outsideSpan: false, or what asked for a night outside the span ("tonight" or "link"),
// for the caution; the nearest night of the span is shown instead.
const tonightAtOpen = tonight();
const state = { lat: DEFAULT_LAT, latFromLink: false, day: tonightAtOpen.day, outsideSpan: tonightAtOpen.outside && "tonight", fit: false,
    table: null, year: null, yearPartial: false, night: null };

function readAddress() {
    const q = new URLSearchParams(location.search);
    const lat = Number(q.get("lat"));
    if (q.has("lat") && Number.isFinite(lat)) {
        state.lat = Math.max(-90, Math.min(90, Math.round(lat * 2) / 2));
        state.latFromLink = true;
    }
    const night = dayFromParam(q.get("date"));
    if (night) { state.day = night.day; state.outsideSpan = night.outside && "link"; }
    state.fit = q.get("fit") === "1";
}

function shareUrl() {
    const url = new URL(location.href);
    url.search = `?lat=${formatLat(state.lat)}&date=${dayParam(state.day)}&fit=${state.fit ? 1 : 0}`;
    url.hash = "";
    return url.href;
}

let addressTimer = 0;
function writeAddress() {
    // replaceState, not pushState: moving a slider must not fill the Back history.
    clearTimeout(addressTimer);
    addressTimer = setTimeout(() => history.replaceState(null, "", shareUrl()), 250);
}

// ---------------------------------------------------------------------------
// The model: the year table, and the worker for the live parts
// ---------------------------------------------------------------------------
const worker = new Worker("rateWorker.js" + VERSION, { type: "module" });
let requestId = 0, workerReady = false;
const requests = new Map();      // channel -> { id, onResults, onDone }
const queued = [];               // messages posted before the worker said it is ready
worker.onmessage = (e) => {
    const m = e.data;
    if (m.ready) { workerReady = true; for (const q of queued.splice(0)) worker.postMessage(q); return; }
    const req = requests.get(m.channel);
    if (!req || req.id !== m.id) return;        // a stale answer, cancelled by a newer request
    if (m.results) req.onResults(m.results);
    if (m.done) { requests.delete(m.channel); if (req.onDone) req.onDone(); }
};
function ask(channel, message, onResults, onDone) {
    const id = ++requestId;
    requests.set(channel, { id, onResults, onDone });
    const msg = { id, channel, ...message };
    if (workerReady) worker.postMessage(msg); else queued.push(msg);
}

// The year curve at the latitude. The table has a row at every slider position (half
// degrees); any other latitude takes the rows either side, mixed linearly.
function yearFromTable(lat, kind) {
    const t = state.table;
    const f = Math.max(0, Math.min(t.nLat - 1, (lat - t.latMin) / t.latStep));
    const i0 = Math.floor(f), i1 = Math.min(t.nLat - 1, i0 + 1), u = f - i0;
    const rows = t[kind], out = new Array(t.days);
    for (let n = 0; n < t.days; n++) {
        const a = rows[i0 * t.days + n], b = rows[i1 * t.days + n];
        out[n] = a + u * (b - a);
    }
    return out;
}

async function loadTable() {
    try {
        const resp = await fetch("rateTable.json" + VERSION);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        // decodeRateTable refuses a table built for another span or shell table.
        state.table = model.decodeRateTable(await resp.json());
    } catch (err) {
        console.warn("The year table could not be loaded; computing the year live.", err);
        state.table = null;
    }
    schedule({ year: true, night: false });
}

// Without the table: the worker fills the year in, every 8th night first, so that the
// curve's shape shows within a second and sharpens after.
function yearOrder() {
    const seen = new Set(), order = [];
    for (const step of [8, 4, 2, 1]) for (let n = 0; n < DAYS; n += step) if (!seen.has(n)) { seen.add(n); order.push(n); }
    return order;
}
let yearLive = null;
function computeYear() {
    if (state.table) {
        state.year = { visible: yearFromTable(state.lat, "visible"), all: yearFromTable(state.lat, "all") };
        state.yearPartial = false;
        return;
    }
    const lat = state.lat;
    if (yearLive && yearLive.lat === lat) return;
    yearLive = { lat };
    state.year = { visible: new Array(DAYS).fill(null), all: new Array(DAYS).fill(null) };
    state.yearPartial = true;
    let left = 2;
    for (const kind of ["visible", "all"]) {
        ask("year-" + kind, { lat, kind, days: yearOrder() }, (results) => {
            for (const r of results) state.year[kind][r.day] = r.total;
            renderCharts();
        }, () => { if (--left === 0) { state.yearPartial = false; renderText(); renderCharts(); } });
    }
}

// The night result carries the latitude and day it was computed for. While a new night is
// being computed, the old result stays for the chart but is not current: the summary shows
// "…" and Save image waits, so old numbers never appear (or export) under the new labels.
const nightIsCurrent = () => !!state.night && state.night.lat === state.lat && state.night.day === state.day;

function computeNight() {
    if (nightIsCurrent()) return;
    const lat = state.lat, day = state.day;
    const got = { lat, day };
    for (const kind of ["visible", "all"]) {
        ask("night-" + kind, { lat, kind, days: [day], profile: true }, (results) => {
            got[kind] = results[0];
            // A late reply for a night the user has already left is dropped.
            if (got.visible && got.all && lat === state.lat && day === state.day) {
                state.night = got;
                renderText();
                renderCharts();
            }
        });
    }
}

// First and last times with a visible-flare rate, and the busiest time.
function nightShape(profile) {
    let first = null, last = null, peak = 0, peakAt = null;
    profile.times.forEach((t, i) => {
        const r = profile.rates[i];
        if (r > 0.05) {
            if (first == null) first = t;
            last = t;
        }
        if (r > peak) { peak = r; peakAt = t; }
    });
    return { first, last, peak, peakAt };
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------
const SERIES = [
    { key: "visible", name: "Visible", colorVar: "--series-1" },
    { key: "all", name: "All (incl. faint)", colorVar: "--series-2" },
];

// Desktop layout (the same query as rate.css): the charts fill their cards, so the chart
// height is the card's space less the key above the plot. Elsewhere, fixed heights.
const FILL = matchMedia("(min-width: 900px) and (min-height: 560px)");
function chartHeight(host, fallback) {
    if (!FILL.matches) return fallback;
    const key = host.querySelector(".lc-key");
    const keyHeight = key ? key.offsetHeight + 10 : 30;    // 10 = the key's vertical margins
    return Math.max(140, host.clientHeight - keyHeight);
}

// The year axis: a tick at the 1st of each month of the span, the year on the first tick and
// on each January. A narrow chart shows every other month, but keeps those two.
function monthTicks(width) {
    const step = width < 560 ? 2 : 1;
    return model.spanMonths()
        .filter((m, i) => i % step === 0 || i === 0 || m.month === 0)
        .map((m, i) => ({ pos: m.day, label: i === 0 || m.month === 0 ? `${MONTHS[m.month]} ${m.year}` : MONTHS[m.month] }));
}

function yearOptions(width, interactive) {
    const x = Array.from({ length: DAYS }, (_, n) => ({ pos: n, label: `Night of ${dayShort(n)}` }));
    const xTicks = monthTicks(width);
    const values = (key) => (state.year ? state.year[key].map((v) => (v == null ? null : Math.round(v * 10) / 10)) : new Array(DAYS).fill(null));
    return {
        x, xTicks,
        series: SERIES.map((s) => ({ name: s.name, colorVar: s.colorVar, values: values(s.key) })),
        yLabel: "Flares per night",
        yMax: state.fit ? undefined : YEAR_Y_MAX,
        markers: [{ pos: state.day, label: dayShort(state.day).replace(/ \d{4}$/, "") }],   // the axis shows the year
        onPick: interactive ? (i) => setDay(i) : undefined,
        height: chartHeight($("chartYear"), width < 560 ? 240 : 300),
    };
}

function nightOptions(width) {
    const idx = [];
    const times = state.night ? state.night.visible.times : [];
    times.forEach((t, i) => { if (t >= NIGHT_FROM - 1e-9 && t <= NIGHT_TO + 1e-9) idx.push(i); });
    const x = idx.map((i) => ({ pos: times[i], label: `${clock(times[i])} local solar time` }));
    const every = width < 560 ? 4 : 2;
    const xTicks = [];
    for (let h = NIGHT_FROM; h <= NIGHT_TO; h += every) xTicks.push({ pos: h, label: clock(h) });
    return {
        x, xTicks,
        series: SERIES.map((s) => ({ name: s.name, colorVar: s.colorVar,
            values: idx.map((i) => Math.round(state.night[s.key].rates[i] * 10) / 10) })),
        yLabel: "Flares per hour",
        height: chartHeight($("chartNight"), width < 560 ? 220 : 280),
    };
}

let yearChart = null, nightChart = null;
function renderCharts() {
    const yearHost = $("chartYear"), nightHost = $("chartNight");
    const yo = yearOptions(yearHost.clientWidth, true);
    if (yearChart) yearChart.update(yo); else yearChart = createLineChart(yearHost, yo);
    if (!state.night) return;
    const no = nightOptions(nightHost.clientWidth);
    if (nightChart) nightChart.update(no); else nightChart = createLineChart(nightHost, no);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------
function summaryText() {
    const when = `Night of ${nightName(state.day)}, at ${latLabel(state.lat)}.`;
    if (!nightIsCurrent()) return { total: "…", when, detail: "" };
    const vis = state.night.visible.total, all = state.night.all.total;
    const shape = nightShape(state.night.visible);
    const depth = model.maxDepression(state.lat, state.day);
    const need = model.MIN_DEPRESSION.visible;
    const lines = { total: vis < 0.5 ? "0" : `≈ ${round(vis)}`, when, detail: "" };
    if (vis < 0.5) {
        lines.detail = depth < need
            // One decimal place: near the limit, whole degrees would print the same number twice.
            ? `No flares: the Sun goes only ${Math.max(0, depth).toFixed(1)}° below the horizon this night. ` +
              `A flare needs it at least about ${need.toFixed(1)}° below.`
            : `Almost no flares: the Sun goes ${depth.toFixed(0)}° below the horizon, which is only just deep ` +
              "enough, and few satellites are in the right place at that depth.";
    } else {
        lines.detail = `${round(all)} including faint glints. Flares from about ${clock(shape.first)} to ` +
            `${clock(shape.last)} local solar time. The busiest time is ${clock(shape.peakAt)}, ` +
            `at about ${round(shape.peak)} visible flares per hour.`;
    }
    return lines;
}

function cautionText() {
    // The model was checked against the full simulation from 60°S to 70°N, and the synthetic
    // constellation against the real one from 50°S to 60°N (see formula.html).
    if (state.outsideSpan === "tonight") return `Tonight is outside the year this page covers (${spanName}): the nearest night is shown. ` +
        "The shell table needs refreshing.";
    if (state.outsideSpan === "link") return `This link's night is outside the year this page covers (${spanName}): the nearest night is shown.`;
    if (state.lat > 70 || state.lat < -60) return "This latitude is outside the range the model was checked on (60°S to 70°N). Treat it as a rough guide.";
    if (state.yearPartial) return "The year curve is being computed; it fills in over about a minute.";
    return "";
}

function renderText() {
    const t = summaryText();
    $("nightTotal").textContent = t.total;
    $("nightWhen").textContent = t.when;
    $("nightDetail").textContent = t.detail;
    const caution = cautionText();
    $("caution").textContent = caution;
    $("caution").hidden = !caution;
    $("yearLat").textContent = latLabel(state.lat);
    $("yearSpan").textContent = spanName;
    $("yearSpan2").textContent = spanName;
    for (const id of ["formulaLink", "formulaLink2"]) $(id).href = `formula.html?lat=${formatLat(state.lat)}`;
    $("latLabel").textContent = latLabel(state.lat);
    $("dayLabel").textContent = dayName(state.day);
    document.title = `Starlink Flare Rate — ${latLabel(state.lat)}, ${dayShort(state.day)}`;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
// Slider input can arrive faster than the page is drawn; do the work once per frame.
let pending = { year: false, night: false }, frame = 0;
function schedule(what) {
    pending.year ||= what.year;
    pending.night ||= what.night;
    if (frame) return;
    frame = requestAnimationFrame(() => {
        frame = 0;
        if (pending.year) computeYear();
        if (pending.night) computeNight();
        pending = { year: false, night: false };
        renderText();
        renderCharts();
        writeAddress();
    });
}

function setLat(value) {
    const lat = Math.max(-90, Math.min(90, Math.round(Number(value) * 2) / 2));
    if (!Number.isFinite(lat) || lat === state.lat) return;
    state.lat = lat;
    $("latRange").value = lat;
    if (document.activeElement !== $("latNumber")) $("latNumber").value = lat;
    schedule({ year: true, night: true });
}

function setDay(value, outsideSpan = false) {
    const day = clampDay(Math.round(Number(value)));
    if (!Number.isFinite(day)) return;
    const changed = day !== state.day || outsideSpan !== state.outsideSpan;
    state.day = day;
    state.outsideSpan = outsideSpan;
    $("dayRange").value = day;
    if (changed) schedule({ year: false, night: true });
}

$("latRange").addEventListener("input", (e) => { state.userMovedLat = true; setLat(e.target.value); });
$("latNumber").addEventListener("input", (e) => { state.userMovedLat = true; if (e.target.value !== "" && e.target.value !== "-") setLat(e.target.value); });
$("latNumber").addEventListener("change", (e) => { e.target.value = state.lat; });
$("dayRange").addEventListener("input", (e) => setDay(e.target.value));
$("today").addEventListener("click", () => { const t = tonight(); setDay(t.day, t.outside && "tonight"); });

// The user's position. Only the latitude is used, and it stays in this page.
function locate(onDone) {
    navigator.geolocation.getCurrentPosition(
        (pos) => onDone(null, pos.coords.latitude),
        (err) => onDone(err),
        { enableHighAccuracy: false, maximumAge: 24 * 3600 * 1000, timeout: 15000 });
}

// Without a latitude in the link, use the position only when permission is already
// granted, so that opening the page never shows a permission prompt.
async function useKnownLocation() {
    if (state.latFromLink || !navigator.geolocation || !navigator.permissions) return;
    try {
        const status = await navigator.permissions.query({ name: "geolocation" });
        if (status.state !== "granted") return;
    } catch { return; }
    locate((err, lat) => {
        if (!err && !state.userMovedLat) { setLat(lat); showStatus("Latitude from your location."); }
    });
}

if (navigator.geolocation) {
    $("myLocation").hidden = false;
    $("myLocation").addEventListener("click", () => {
        showStatus("Finding your location…");
        locate((err, lat) => {
            if (err) showStatus(err.code === 1 ? "Location permission was not given." : "Your location could not be found.");
            else { setLat(lat); showStatus("Latitude from your location."); }
        });
    });
}
$("scaleToFit").addEventListener("change", (e) => {
    state.fit = e.target.checked;
    schedule({ year: false, night: false });
});
// The tick spacing and the chart heights depend on the size of the chart areas, so draw
// again when either changes size. The areas' sizes come from the layout, not from the
// charts inside them, so a new drawing does not start another resize.
const sizes = new Map();
const chartResize = new ResizeObserver((entries) => {
    let changed = false;
    for (const e of entries) {
        const size = `${Math.round(e.contentRect.width)}x${Math.round(e.contentRect.height)}`;
        if (sizes.get(e.target) !== size) { sizes.set(e.target, size); changed = true; }
    }
    if (changed && yearChart) schedule({ year: false, night: false });
});
chartResize.observe($("chartYear"));
chartResize.observe($("chartNight"));

// ---------------------------------------------------------------------------
// Link
// ---------------------------------------------------------------------------
function showStatus(text) {
    $("status").textContent = text;
    clearTimeout(showStatus.timer);
    showStatus.timer = setTimeout(() => { $("status").textContent = ""; }, 4000);
}

$("copyLink").addEventListener("click", async () => {
    const url = shareUrl();
    history.replaceState(null, "", url);
    try {
        await navigator.clipboard.writeText(url);
        $("linkBox").hidden = true;
        showStatus("Link copied. It opens this latitude and night.");
    } catch {
        // No clipboard access (an old browser, or an insecure page): show the link to copy by hand.
        const box = $("linkBox");
        box.value = url;
        box.hidden = false;
        box.focus();
        box.select();
        showStatus("Copy this link:");
    }
});

if (navigator.share) {
    $("shareLink").hidden = false;
    $("shareLink").addEventListener("click", () => {
        navigator.share({ title: document.title, url: shareUrl() }).catch(() => { /* the user closed the share sheet */ });
    });
}

// ---------------------------------------------------------------------------
// Image export
// ---------------------------------------------------------------------------
// Chart SVG takes its colors and fonts from CSS classes. A saved SVG has no stylesheet, so
// copy the computed values onto each element as attributes.
const STYLE_PROPS = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linejoin", "stroke-linecap",
    "font-size", "font-weight", "font-family", "font-variant-numeric", "opacity"];
function inlineStyles(source, target) {
    const cs = getComputedStyle(source);
    for (const p of STYLE_PROPS) target.setAttribute(p, cs.getPropertyValue(p));
    target.removeAttribute("class");
    target.removeAttribute("style");
    [...source.children].forEach((child, i) => inlineStyles(child, target.children[i]));
}

// Draw a chart off screen at the export width and return its SVG markup, styled.
function chartSvg(optionsFor, width) {
    const holder = document.createElement("div");
    holder.style.cssText = `position:fixed; left:-${width + 100}px; top:0; width:${width}px;`;
    const host = document.createElement("div");
    host.className = "chart";
    holder.appendChild(host);
    document.body.appendChild(holder);
    try {
        createLineChart(host, optionsFor(width));
        const svg = host.querySelector("svg");
        const copy = svg.cloneNode(true);
        inlineStyles(svg, copy);   // matches children by position, so remove nothing before it
        // The crosshair group and the hit area are for the pointer only.
        const kids = [...svg.children], copies = [...copy.children];
        kids.forEach((el, i) => {
            const cls = el.getAttribute("class") || "";
            if (cls.includes("lc-cross") || cls.includes("lc-hit")) copies[i].remove();
        });
        return { markup: copy.outerHTML, height: Number(svg.getAttribute("height")) };
    } finally {
        holder.remove();
    }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function exportSvg() {
    const root = getComputedStyle(document.documentElement);
    const token = (name) => root.getPropertyValue(name).trim();
    const font = getComputedStyle(document.body).fontFamily;
    const pad = 32, innerW = EXPORT_WIDTH - 2 * pad;
    const year = chartSvg((w) => ({ ...yearOptions(w, false), height: 300 }), innerW);
    const night = chartSvg((w) => ({ ...nightOptions(w), height: 280 }), innerW);
    const t = summaryText();
    const parts = [];
    let y = pad;
    // One text line per call, wrapped at word breaks. SVG does not wrap, so the width of a
    // character is estimated (about 0.55 of the font size for this font).
    const text = (str, size, color, weight = 400) => {
        const perLine = Math.floor(innerW / (size * 0.55));
        const lines = [];
        let line = "";
        for (const word of str.split(" ")) {
            if (line && (line + " " + word).length > perLine) { lines.push(line); line = word; }
            else line = line ? line + " " + word : word;
        }
        if (line) lines.push(line);
        for (const l of lines) {
            y += size * 1.3;
            parts.push(`<text x="${pad}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}" font-family="${esc(font)}">${esc(l)}</text>`);
        }
    };
    const legend = () => {
        y += 22;
        let x = pad;
        for (const s of SERIES) {
            parts.push(`<rect x="${x}" y="${y - 6}" width="18" height="3" rx="1" fill="${token(s.colorVar)}"/>`);
            parts.push(`<text x="${x + 24}" y="${y}" font-size="14" fill="${token("--ink-2")}" font-family="${esc(font)}">${esc(s.name)}</text>`);
            x += 24 + s.name.length * 8 + 24;
        }
    };
    text(`Starlink flares at ${latLabel(state.lat)}`, 28, token("--ink"), 700);
    text(`${t.total} visible flares on the night of ${dayName(state.day)}.`, 18, token("--ink"), 600);
    text(t.detail, 15, token("--ink-2"));
    y += 12;
    text("Flares per night through the year", 18, token("--ink"), 600);
    legend();
    y += 6;
    parts.push(`<g transform="translate(${pad} ${y})">${year.markup}</g>`);
    y += year.height + 12;
    text(`Flares per hour through the night of ${dayName(state.day)} (local solar time)`, 18, token("--ink"), 600);
    y += 6;
    parts.push(`<g transform="translate(${pad} ${y})">${night.markup}</g>`);
    y += night.height + 10;
    text(`Expected numbers from a model of the flare geometry and the Starlink constellation measured on ${model.STARLINK_SHELLS.refEpoch.slice(0, 10)}, checked against a full simulation.`, 12, token("--muted"));
    text("One observer, the whole sky; sky conditions not included. " + shareUrl(), 12, token("--muted"));
    y += pad - 8;
    const height = Math.ceil(y);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${EXPORT_WIDTH}" height="${height}" viewBox="0 0 ${EXPORT_WIDTH} ${height}">` +
        `<rect width="100%" height="100%" fill="${token("--page")}"/>${parts.join("")}</svg>`;
    return { svg, height };
}

async function exportPng() {
    const { svg, height } = exportSvg();
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await img.decode();
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = EXPORT_WIDTH * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, EXPORT_WIDTH, height);
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no image"))), "image/png"));
}

$("saveImage").addEventListener("click", async () => {
    if (!nightIsCurrent() || !state.year) { showStatus("The charts are still being computed."); return; }
    const name = `starlink-flares-${latLabel(state.lat).replace("°", "")}-${dayParam(state.day)}.png`;
    try {
        const blob = await exportPng();
        const file = new File([blob], name, { type: "image/png" });
        // On a phone, the share sheet is the natural way to keep an image ("Save Image").
        const coarse = matchMedia("(pointer: coarse)").matches;
        if (coarse && navigator.canShare?.({ files: [file] })) {
            try {
                await navigator.share({ files: [file], title: document.title });
                return;
            } catch (err) {
                if (err?.name === "AbortError") return;
            }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        showStatus(`Saved ${name}.`);
    } catch (err) {
        showStatus(`The image could not be made: ${err.message || err}`);
    }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
readAddress();
$("latRange").value = state.lat;
$("latNumber").value = state.lat;
$("dayRange").max = DAYS - 1;
$("dayRange").value = state.day;
$("scaleToFit").checked = state.fit;
renderText();
renderCharts();
computeNight();
loadTable();
writeAddress();
useKnownLocation();

// Local debugging hook for the SitrecBridge MCP tools, as in ../app.js; never on the live site.
if (/^(localhost|127\.0\.0\.1|local\.metabunk\.org)$/.test(location.hostname)) {
    window.shfRate = { state, model, exportSvg, setLat, setDay };
}
