// formula.js — the charts on the formula page: each shell's density by latitude, and the
// flares per night at a latitude split by shell inclination. The numbers come from
// rateModel.js, the same code the flare rate page uses.

const VERSION = new URL(import.meta.url).search;   // cache-busting, as in rate.js
const [model, { createLineChart }] = await Promise.all([
    import("./rateModel.js" + VERSION),
    import("../lineChart.js" + VERSION),
]);

const $ = (id) => document.getElementById(id);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86400000;
const formatLat = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const latLabel = (lat) => (lat === 0 ? "0°" : `${formatLat(Math.abs(lat))}°${lat > 0 ? "N" : "S"}`);
const dayName = (n) => { const d = new Date(Date.UTC(2025, 0, 1) + n * DAY_MS); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };

// The shells grouped by inclination; the colors match their order in the breakdown chart.
const GROUPS = [
    { inc: 43, name: "43° shells", colorVar: "--series-3" },
    { inc: 53.17, name: "53° shells", colorVar: "--series-2" },
    { inc: 70, name: "70° shell", colorVar: "--series-4" },
    { inc: 97.5, name: "97.5° shells", colorVar: "--series-5" },
];

// ---------------------------------------------------------------------------
// Shell table
// ---------------------------------------------------------------------------
for (const s of model.SHELLS) {
    const row = $("shellTable").insertRow();
    row.insertCell().textContent = `${s.inc}°`;
    row.insertCell().textContent = `${s.alt} km`;
    row.insertCell().textContent = s.count.toLocaleString();
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
// Flares per night split by inclination
// ---------------------------------------------------------------------------
const q = new URLSearchParams(location.search);
const linkLat = Number(q.get("lat"));
let lat = q.has("lat") && Number.isFinite(linkLat) ? Math.max(-90, Math.min(90, Math.round(linkLat * 2) / 2)) : 45;

let breakdown = null, frame = 0;
function drawBreakdown() {
    const groups = GROUPS.map((g) => ({ ...g,
        values: model.yearTotals(lat, "visible", 5, (s) => s.inc === g.inc).map((v) => Math.round(v)) }));
    const total = groups[0].values.map((_, n) => groups.reduce((sum, g) => sum + g.values[n], 0));
    const width = $("chartBreakdown").clientWidth;
    const options = {
        x: total.map((_, n) => ({ pos: n, label: `Night of ${dayName(n)}` })),
        xTicks: MONTHS.map((m, i) => ({ pos: Math.round((Date.UTC(2025, i, 1) - Date.UTC(2025, 0, 1)) / DAY_MS), label: m }))
            .filter((_, i) => width >= 560 || i % 2 === 0),
        series: [{ name: "Total", colorVar: "--series-1", values: total },
            ...groups.map((g) => ({ name: g.name, colorVar: g.colorVar, values: g.values }))],
        yLabel: "Visible flares per night",
        height: width < 560 ? 260 : 320,
    };
    if (breakdown) breakdown.update(options); else breakdown = createLineChart($("chartBreakdown"), options);
    $("bLatLabel").textContent = latLabel(lat);
    $("bLat").value = lat;
    $("backLink").href = `./?lat=${formatLat(lat)}`;
}

$("bLat").addEventListener("input", (e) => {
    lat = Number(e.target.value);
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; drawBreakdown(); });
});
drawBreakdown();
