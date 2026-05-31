// Altitude distribution of a TLE set (from mean motion). arg = real .tle, else synthetic.
import { readFileSync } from "node:fs";
import { generateDummyTLE } from "../dummyTLE.js";
const mu = 398600.4418, Re = 6371;
const arg = process.argv[2];
const txt = (arg ? readFileSync(arg, "utf8") : generateDummyTLE(new Date("2026-05-30T05:00:00Z"))).split(/\r?\n/);
console.log(arg ? "REAL " + arg : "SYNTHETIC");
const alts = [];
for (const l of txt) {
    if (l.startsWith("2 ")) {
        const mm = parseFloat(l.slice(52, 63));
        if (!(mm > 0)) continue;
        const n = mm * 2 * Math.PI / 86400;
        alts.push(Math.cbrt(mu / (n * n)) - Re);
    }
}
alts.sort((x, y) => x - y);
const pct = (p) => alts[Math.floor(alts.length * p)].toFixed(0);
console.log(`n=${alts.length} min=${alts[0].toFixed(0)} p05=${pct(0.05)} p25=${pct(0.25)} p50=${pct(0.5)} p75=${pct(0.75)} p95=${pct(0.95)} max=${alts[alts.length - 1].toFixed(0)} km`);
const bins = {};
for (const a of alts) { const b = Math.floor(a / 20) * 20; bins[b] = (bins[b] || 0) + 1; }
for (const k of Object.keys(bins).map(Number).sort((a, b) => a - b)) {
    console.log(`  ${k}-${k + 20}km: ${"#".repeat(Math.round(bins[k] / alts.length * 200))} ${bins[k]}`);
}
