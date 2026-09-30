// Execute-test for the approximate flare rate formula (rate/rateModel.js): its shell list
// matches the synthetic constellation, it reproduces the formula means recorded when the
// constant K was fitted, the night chart's hours hold every flare, and it stays finite
// at the poles.
import { SHELLS, yearTotals, nightProfile, rateAt, declination } from "../rate/rateModel.js";
import { generateDummyTLE } from "../dummyTLE.js";

let fails = 0;
function ok(name, cond, extra = "") {
    console.log((cond ? "  ok   " : "  FAIL ") + name + (extra ? "  " + extra : ""));
    if (!cond) fails++;
}

console.log("== rate: shell list matches dummyTLE.js ==");
// generateDummyTLE writes the shells in order, so walk its satellites shell by shell.
// Altitude from mean motion (rev/day): a = (mu / n^2)^(1/3).
const MU = 398600.4418, RE = 6371;   // the same Earth radius as meanMotion() in dummyTLE.js
const lines = generateDummyTLE(new Date("2026-06-01T00:00:00Z")).split("\n").filter((l) => l.startsWith("2 "));
let at = 0, shellsOk = true, detail = "";
for (const s of SHELLS) {
    for (let i = 0; i < s.count; i++, at++) {
        const line = lines[at];
        const inc = line ? Number(line.slice(8, 16)) : NaN;
        const n = line ? Number(line.slice(52, 63)) * 2 * Math.PI / 86400 : NaN;
        const alt = Math.cbrt(MU / (n * n)) - RE;
        if (!(Math.abs(inc - s.inc) < 1e-3 && Math.abs(alt - s.alt) <= 8.5)) {
            shellsOk = false;
            detail ||= `satellite ${at}: inc ${inc} alt ${alt.toFixed(1)}, expected shell ${s.inc}/${s.alt}`;
        }
    }
}
ok("every shell has the same inclination, altitude and count", shellsOk && at === lines.length,
    detail || `${at} of ${lines.length} satellites`);

console.log("== rate: reproduces the fitted formula means ==");
// Year means of the formula as recorded with the fit (visible flares, 2026, every night).
const FITTED = { 0: 248, 20: 381, 35: 598, 45: 340, 55: 136, 65: 135, "-35": 598 };
for (const [lat, want] of Object.entries(FITTED)) {
    const year = yearTotals(Number(lat), "visible", 5);
    const mean = year.reduce((a, b) => a + b, 0) / year.length;
    ok(`mean per night at ${lat}° within 1.5%`, Math.abs(mean / want - 1) < 0.015, `${mean.toFixed(1)} vs ${want}`);
}
const allMean = yearTotals(35, "all", 5).reduce((a, b) => a + b, 0) / 365;
const visMean = yearTotals(35, "visible", 5).reduce((a, b) => a + b, 0) / 365;
ok("all flares exceed visible flares", allMean > visMean, `${allMean.toFixed(0)} > ${visMean.toFixed(0)}`);

const step2 = nightProfile(35, 100, "visible", 2).total, step5 = nightProfile(35, 100, "visible", 5).total;
ok("5-minute steps agree with 2-minute steps", Math.abs(step5 / step2 - 1) < 0.005, `${step5.toFixed(1)} vs ${step2.toFixed(1)}`);

console.log("== rate: night chart range and poles ==");
// The page's night chart shows 14:00 to 10:00. No flare may fall outside it.
let outside = 0, where = "";
for (let lat = -90; lat <= 90; lat += 2.5) {
    for (let day = 0; day < 365; day += 5) {
        const dec = declination(day);
        for (let t = 12; t < 14; t += 0.1) if (rateAt(lat, dec, t) > 0) { outside++; where ||= `${lat}° day ${day} ${t.toFixed(1)} h`; }
        for (let t = 34; t <= 36; t += 0.1) if (rateAt(lat, dec, t) > 0) { outside++; where ||= `${lat}° day ${day} ${t.toFixed(1)} h`; }
    }
}
ok("no flares before 14:00 or after 10:00 local solar time", outside === 0, where);

const finite = [-90, -89.5, 89.5, 90].every((lat) => yearTotals(lat, "visible", 30).every(Number.isFinite));
ok("finite at and near the poles", finite);
ok("no flares at the poles (Sun never 28° down)", yearTotals(90, "visible", 30).every((v) => v === 0));

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
