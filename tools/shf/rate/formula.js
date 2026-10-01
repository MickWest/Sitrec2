// formula.js — the live parts of the formula page: the shell table, each inclination group's
// density by latitude, and the flares per night at a latitude split by inclination group.
// The numbers come from rateModel.js, the same code the flare rate page uses; the breakdown
// chart shows one calendar year of the span (a year control, as on the rate page) and runs
// the model in a worker (rateWorker.js), coarse to fine, so the slider stays live.

const VERSION = new URL(import.meta.url).search;   // cache-busting, as in rate.js
const [model, { createLineChart }] = await Promise.all([
    import("./rateModel.js" + VERSION),
    import("../lineChart.js" + VERSION),
]);

const $ = (id) => document.getElementById(id);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December"];
const DAY_MS = 86400000, DAYS = model.DAYS;
const YEARS = model.spanYears();    // [{ year, day, days }]: the calendar years of the span
const formatLat = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const latLabel = (lat) => (lat === 0 ? "0°" : `${formatLat(Math.abs(lat))}°${lat > 0 ? "N" : "S"}`);
const dayDate = (n) => new Date(model.SPAN.startMs + n * DAY_MS);
const dayName = (n) => { const d = dayDate(n); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const dayLong = (n) => { const d = dayDate(n); return `${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
// The span and the table's date, where the text names them.
for (const el of document.querySelectorAll(".span-name")) el.textContent = `${dayLong(0)} to ${dayLong(DAYS - 1)}`;
for (const el of document.querySelectorAll(".span-short")) el.textContent = `${MONTHS[dayDate(0).getUTCMonth()]} ${dayDate(0).getUTCFullYear()} to ${MONTHS[dayDate(DAYS - 1).getUTCMonth()]} ${dayDate(DAYS - 1).getUTCFullYear()}`;
for (const el of document.querySelectorAll(".ref-date")) el.textContent = dayLong(model.dayOfDate(model.STARLINK_SHELLS.refEpoch.slice(0, 10)));

// The inclination groups; the colors match their order in the breakdown chart.
const GROUPS = [
    { key: "43", inc: 43.0, name: "43° shells", colorVar: "--series-3" },
    { key: "53", inc: 53.16, name: "53° shells", colorVar: "--series-2" },
    { key: "70", inc: 70.0, name: "70° shells", colorVar: "--series-4" },
    { key: "97", inc: 97.29, name: "97.3° shells (polar)", colorVar: "--series-5" },
];

// ---------------------------------------------------------------------------
// Shell table
// ---------------------------------------------------------------------------
const table = model.STARLINK_SHELLS;
$("tableSource").textContent = `${table.source}, ${table.measuredAt.slice(0, 10)}`;
$("tableTotal").textContent = table.total.toLocaleString();
$("tableShells").textContent = String(table.shells.length);
$("tableMerged").textContent = String(model.SHELLS.length);
$("tableCaption").textContent = `${model.SHELLS.length} shells, ${table.total.toLocaleString()} satellites`;
for (const s of model.SHELLS) {
    const row = $("shellTable").insertRow();
    row.insertCell().textContent = `${s.inc.toFixed(2)}°`;
    row.insertCell().textContent = `${s.alt.toFixed(0)} km` + (s.members.length > 1 ? ` (${s.members.map((m) => m.alt.toFixed(0)).join(", ")})` : "");
    row.insertCell().textContent = s.count.toLocaleString();
    row.insertCell().textContent = s.sso ? `${s.planes} at fixed local times` : `${s.planes}, turning ${nodalRateText(s)} a day`;
}
// The J2 nodal rate of a shell, as the generator computes it (the model dates the planes with it).
function nodalRateText(s) {
    const rate = model.nodalRate(s.alt, s.inc);
    return `${rate < 0 ? "west" : "east"} ${Math.abs(rate).toFixed(1)}°`;
}

// ---------------------------------------------------------------------------
// Density by latitude
// ---------------------------------------------------------------------------
const lats = [];
for (let y = -90; y <= 90; y += 0.5) lats.push(y);
createLineChart($("chartDensity"), {
    x: lats.map((y) => ({ pos: y, label: `Latitude ${latLabel(y)}` })),
    xTicks: [-90, -60, -30, 0, 30, 60, 90].map((y) => ({ pos: y, label: latLabel(y) })),
    series: GROUPS.map((g) => ({ name: g.name, colorVar: g.colorVar,
        values: lats.map((y) => Math.round(model.relativeDensity(y, g.inc) * 100) / 100) })),
    yLabel: "Density (equator = 1)",
    height: 260,
});

// ---------------------------------------------------------------------------
// Flares per night split by inclination group (the worker, coarse to fine)
// ---------------------------------------------------------------------------
const q = new URLSearchParams(location.search);
const linkLat = Number(q.get("lat"));
let lat = q.has("lat") && Number.isFinite(linkLat) ? Math.max(-90, Math.min(90, Math.round(linkLat * 2) / 2)) : 45;
// The calendar year on show: the year of the link's date (the rate page passes its night),
// else the current year; either is moved to the nearest year of the span.
const nearestYear = (y) => YEARS.reduce((best, o) => (Math.abs(o.year - y) < Math.abs(best.year - y) ? o : best));
const linkDate = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(q.get("date") || "");
let year = nearestYear(linkDate ? Number(linkDate[1]) : new Date().getFullYear());
const openedYear = year;

// The "← Flare Rate" link returns to the night the rate page sent: the link's date when its
// year is the year on show, else its month and day in the year on show (a day past the end
// of the month moved back to its last day, as the rate page's year control does). Without a
// link date the rate page opens on tonight, so the date is left out unless the year was
// changed, and then it is today's month and day in that year.
function backHref() {
    const today = new Date();
    const month = linkDate ? Number(linkDate[2]) - 1 : today.getMonth(), date = linkDate ? Number(linkDate[3]) : today.getDate();
    if (!linkDate && year === openedYear) return `./?lat=${formatLat(lat)}`;
    const last = new Date(Date.UTC(year.year, month + 1, 0)).getUTCDate();
    const pad = (v) => String(v).padStart(2, "0");
    return `./?lat=${formatLat(lat)}&date=${year.year}-${pad(month + 1)}-${pad(Math.min(date, last))}`;
}

const worker = new Worker("rateWorker.js" + VERSION, { type: "module" });
let requestId = 0, results = null, breakdown = null, frame = 0, workerReady = false, queued = null;

// The nights of the year on show, in the order the worker computes them: every 16th first
// (23 nights, about a second on a desktop at 40 ms a night, four times more on a phone), so
// that the curve's shape shows at once, then the rest, to every night in about 15 s (a
// minute on a phone). A slider move cancels the nights still to come.
function nightOrder() {
    const seen = new Set(), order = [];
    for (const step of [16, 8, 4, 2, 1]) for (let n = year.day; n < year.day + year.days; n += step) if (!seen.has(n)) { seen.add(n); order.push(n); }
    return order;
}

// The year axis as on the rate page: the 1st of each month of the year on show, the year on
// the January tick; every other month on a narrow chart.
function monthTicks(width) {
    const step = width < 560 ? 2 : 1;
    return model.spanMonths()
        .filter((m) => m.year === year.year)
        .filter((m, i) => i % step === 0)
        .map((m) => ({ pos: m.day, label: m.month === 0 ? `${MONTHS[m.month]} ${m.year}` : MONTHS[m.month] }));
}

function drawBreakdown() {
    const days = [...results.keys()].sort((a, b) => a - b);
    const width = $("chartBreakdown").clientWidth;
    const options = {
        x: days.map((n) => ({ pos: n, label: `Night of ${dayName(n)}` })),
        xTicks: monthTicks(width),
        series: [{ name: "Total", colorVar: "--series-1", values: days.map((n) => Math.round(results.get(n).total)) },
            ...GROUPS.map((g) => ({ name: g.name, colorVar: g.colorVar, values: days.map((n) => Math.round(results.get(n).byGroup[g.key] || 0)) }))],
        yLabel: "Visible flares per night",
        height: width < 560 ? 260 : 320,
    };
    if (breakdown) breakdown.update(options); else breakdown = createLineChart($("chartBreakdown"), options);
}

function requestBreakdown() {
    results = new Map();
    const id = ++requestId;
    const msg = { id, channel: "breakdown", lat, kind: "visible", days: nightOrder() };
    if (workerReady) worker.postMessage(msg); else queued = msg;      // sent when the worker is ready
    $("bLatLabel").textContent = latLabel(lat);
    $("bLat").value = lat;
    for (const button of $("bYear").children) button.setAttribute("aria-pressed", String(Number(button.value) === year.year));
    $("backLink").href = backHref();
    $("breakdownStatus").textContent = `Computing the nights of ${year.year} at ${latLabel(lat)}…`;
}

// The year control: one button per calendar year of the span, as on the rate page; the
// arrow keys move between the years from the keyboard.
for (const y of YEARS) {
    const button = document.createElement("button");
    button.type = "button";
    button.value = String(y.year);
    button.textContent = String(y.year);
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => { if (y !== year) { year = y; requestBreakdown(); } });
    $("bYear").appendChild(button);
}
$("bYear").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = YEARS[Math.max(0, Math.min(YEARS.length - 1, YEARS.indexOf(year) + (e.key === "ArrowLeft" ? -1 : 1)))];
    if (next !== year) { year = next; requestBreakdown(); }
    $("bYear").children[YEARS.indexOf(next)].focus();
});

worker.onmessage = (e) => {
    const m = e.data;
    if (m.ready) { workerReady = true; if (queued) { worker.postMessage(queued); queued = null; } return; }
    if (m.id !== requestId) return;                 // a stale answer from a request the slider replaced
    if (m.results) {
        for (const r of m.results) results.set(r.day, r);
        drawBreakdown();
        $("breakdownStatus").textContent = `Visible flares per night at ${latLabel(lat)}, split by the inclination of the shells ` +
            `that make them. ${results.size} of ${year.days} nights of ${year.year} computed…`;
    }
    if (m.done) {
        $("breakdownStatus").textContent = `Visible flares per night at ${latLabel(lat)}, split by the inclination of the shells ` +
            `that make them (the model, every night from ${dayName(year.day)} to ${dayName(year.day + year.days - 1)}).`;
    }
};

$("bLat").addEventListener("input", (e) => {
    lat = Number(e.target.value);
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; requestBreakdown(); });
});
requestBreakdown();

// Local debugging hook for the SitrecBridge MCP tools, as in rate.js; never on the live site.
if (/^(localhost|127\.0\.0\.1|local\.metabunk\.org)$/.test(location.hostname)) {
    window.shfFormula = { model, get results() { return results; }, get year() { return year; }, requestBreakdown };
}
