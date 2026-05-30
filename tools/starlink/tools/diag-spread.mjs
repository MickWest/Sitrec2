// Diagnostic: how broadly do the synthetic flares spread in elevation/azimuth?
// A uniform spherical shell should give a spread comparable to real data, not a
// thin band. Run before/after generator changes to compare.
import { generateDummyTLE } from "../dummyTLE.js";

const realSat = await import("satellite.js");
const sat = realSat.default ?? realSat;
const { createFlareEngine } = await import("../flareEngine.js");
const engine = createFlareEngine(sat);

// Optional arg: path to a real .tle to compare against; otherwise synthetic.
const arg = process.argv[2];
const date = new Date("2026-05-30T00:00:00Z");
let tleText;
if (arg) {
    const { readFileSync } = await import("node:fs");
    tleText = readFileSync(arg, "utf8");
    console.log("source: REAL", arg);
} else {
    tleText = generateDummyTLE(date);
    console.log("source: SYNTHETIC");
}
const sats = engine.parseTLE(tleText);
console.log("sats:", sats.length);

const res = engine.scanForward({
    sats,
    observerAt: () => ({ lat: 34, lon: -118, altKm: 0 }),
    startMs: Date.UTC(2026, 4, 30, 2, 0, 0),
    maxLookAheadSec: 2 * 86400,
    options: {},
    onProgress: () => {},
});

const els = res.flares.map((f) => f.elDeg).sort((a, b) => a - b);
const azs = res.flares.map((f) => f.azDeg);
const min = (a) => Math.min(...a), max = (a) => Math.max(...a);
const pct = (a, p) => a[Math.floor(a.length * p)] ?? NaN;
console.log("flares:", res.flares.length);
if (res.flares.length) {
    console.log(`elevation: min=${min(els).toFixed(1)}  p50=${pct(els, 0.5).toFixed(1)}  p90=${pct(els, 0.9).toFixed(1)}  max=${max(els).toFixed(1)}  (range ${(max(els) - min(els)).toFixed(1)}°)`);
    console.log(`azimuth:   min=${min(azs).toFixed(0)}  max=${max(azs).toFixed(0)}  (span ${(max(azs) - min(azs)).toFixed(0)}°)`);
    // elevation histogram
    const bins = new Array(10).fill(0);
    for (const e of els) bins[Math.min(9, Math.floor(e / 3))]++;  // 3° bins, 0..30
    console.log("el histogram (3° bins 0–30°):", bins.join(" "));
}
