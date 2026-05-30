// compare-views.mjs — render the "view from here" (full-sky flare map) for the
// SYNTHETIC vs the REAL constellation at the same place/time, side by side, so the
// synthetic distribution can be tuned until it matches reality.
//
// All-sky polar projection: zenith at centre, horizon at the rim; North up, East
// right. Each flare is a dot (radius/opacity ~ intensity). Also prints quantitative
// distribution stats (count, azimuth & elevation histograms).
//
// Usage: node tools/compare-views.mjs [latlon] [YYYY-MM-DD]
//   e.g. node tools/compare-views.mjs 34,-118 2026-05-30
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import * as astro from "../astro.js";
import { generateDummyTLE } from "../dummyTLE.js";

const A = await import("satellite.js"); const sat = A.default ?? A;
const { createFlareEngine } = await import("../flareEngine.js");
const engine = createFlareEngine(sat);

// ---- params ----
const [latS, lonS] = (process.argv[2] || "34,-118").split(",").map(Number);
const dateStr = process.argv[3] || "2026-05-30";
const [Y, M, D] = dateStr.split("-").map(Number);
const lat = latS, lon = lonS;
const startMs = Date.UTC(Y, M - 1, D, 0, 0, 0);
const endMs = startMs + 24 * 3600 * 1000;     // scan a full day; band gate skips daytime

const realText = readFileSync(process.env.TMPDIR + "/real-starlink.tle", "utf8");
const realSats = engine.parseTLE(realText);
const synthSats = engine.parseTLE(generateDummyTLE(new Date(startMs)));

function flaresFor(sats) {
  return engine.scan({
    sats,
    observerAt: () => ({ lat, lon, altKm: 0 }),
    startMs, endMs,
    options: { filterStepSec: 60, fineStepSec: 4 },
    onProgress: () => {},
  }).flares;
}

console.log(`Location ${lat},${lon}  date ${dateStr}  (real sats ${realSats.length}, synth ${synthSats.length})`);
const realF = flaresFor(realSats);
const synthF = flaresFor(synthSats);

// ---- stats ----
function stats(flares, label) {
  const az = flares.map((f) => f.azDeg), el = flares.map((f) => f.elDeg);
  const azBins = new Array(16).fill(0);
  for (const a of az) azBins[Math.floor(((a % 360) + 360) % 360 / 22.5)]++;
  const elBins = new Array(9).fill(0);   // 0-90 in 10° bins
  for (const e of el) elBins[Math.min(8, Math.floor(e / 10))]++;
  const compass = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  console.log(`\n${label}: ${flares.length} flares`);
  console.log("  elevation 10° bins [0-90]:", elBins.join(" "), `(max el ${Math.max(0, ...el).toFixed(0)}°)`);
  console.log("  azimuth by compass:", compass.map((c, i) => azBins[i] ? `${c}:${azBins[i]}` : "").filter(Boolean).join(" "));
  return { azBins, elBins };
}
stats(realF, "REAL");
stats(synthF, "SYNTH");

// ---- all-sky polar plot SVG ----
function plot(flares, title, n) {
  const R = 210, cx = 230, cy = 250;
  const ring = (el) => { const r = (90 - el) / 90 * R; return `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="#2a3344" stroke-width="1"/>`; };
  const dots = flares.map((f) => {
    const r = (90 - f.elDeg) / 90 * R;
    const a = f.azDeg * Math.PI / 180;
    const x = cx + r * Math.sin(a), y = cy - r * Math.cos(a);
    const op = 0.25 + 0.6 * (f.intensity ?? 1);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="#ffd24a" opacity="${op.toFixed(2)}"/>`;
  }).join("");
  const labels = [["N", cx, cy - R - 6], ["E", cx + R + 10, cy + 4], ["S", cx, cy + R + 16], ["W", cx - R - 14, cy + 4]]
    .map(([t, x, y]) => `<text x="${x}" y="${y}" fill="#9fb0c8" font-size="14" text-anchor="middle">${t}</text>`).join("");
  return `<svg width="470" height="520" xmlns="http://www.w3.org/2000/svg" style="background:#0b0f17">
    <text x="${cx}" y="26" fill="#eaf1ff" font-size="17" text-anchor="middle" font-weight="600">${title}</text>
    <text x="${cx}" y="46" fill="#7f8ca3" font-size="12" text-anchor="middle">${n} flares · zenith centre, horizon rim</text>
    ${ring(0)}${ring(30)}${ring(60)}${labels}${dots}
    <circle cx="${cx}" cy="${cy}" r="2" fill="#5566aa"/></svg>`;
}

const html = `<!doctype html><html><body style="margin:0;background:#0b0f17;display:flex;font-family:system-ui">
  <div>${plot(synthF, "SYNTHETIC", synthF.length)}</div>
  <div>${plot(realF, "REAL (current TLE)", realF.length)}</div>
</body></html>`;

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: "load" });
const out = (process.env.TMPDIR || "/tmp") + "/compare-views.png";
await page.screenshot({ path: out });
await browser.close();
console.log("\nwrote", out);
