// Execute-test for the flare rate model (rate/rateModel.js) and its year table:
//   * the model's shell list is the measured table (../starlinkShells.js) merged within
//     altitude bands, with the whole constellation and every inclination group, and every
//     shell's measured planes dated to the night (the Sun-synchronous ones at their fixed
//     local times, the others moved at the generator's J2 rate, placed for one longitude's
//     night or spread over the observer's longitude);
//   * the year span is 365 nights from the 1st of the month of the table's reference epoch;
//   * the model reproduces a FROZEN engine-truth snapshot (fixtures/rate-truth.json: single-
//     shell constellations scanned with the flare engine, 11 sets x 2 kinds x 14 latitudes)
//     within stated tolerances, and the generator's simulated year (fixtures/rate-year.json:
//     the whole constellation, 12 latitudes x 24 nights x 3 longitudes) per latitude and on
//     single nights;
//   * dating the planes moves nights, not years: the per-latitude year totals stay within a
//     stated tolerance of the evenly-spread (uniform) planes' totals;
//   * the Sun-synchronous local-time convention (mean solar time, anchored to the mean Sun)
//     stays as the engine check proved it;
//   * the precomputed year table (rate/rateTable.json) covers the span at every half degree
//     of latitude (every slider position, so nothing is interpolated) and its rows equal the
//     live model to the stored resolution;
//   * the night chart's hours hold every flare, the model is finite at the poles, and one
//     night computes within the speed bound.
import fs from "node:fs";
import * as M from "../rate/rateModel.js";

let fails = 0;
function ok(name, cond, extra = "") {
    console.log((cond ? "  ok   " : "  FAIL ") + name + (extra ? "  " + extra : ""));
    if (!cond) fails++;
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

console.log("== rate: the model's constellation ==");
const table = M.STARLINK_SHELLS;
ok(`merged shells (${M.MERGE_BAND_KM} km bands) hold the whole constellation`, sum(M.SHELLS.map((s) => s.count)) === table.total,
    `${M.SHELLS.length} model shells from ${table.shells.length} measured, ${table.total} satellites`);
ok("fewer model shells than measured shells", M.SHELLS.length < table.shells.length);
ok("the Sun-synchronous shells are the polar group, and only them", M.SHELLS.every((s) => s.sso === (s.group === "97")));
ok("every member sits within one band of its model shell", M.SHELLS.every((s) => s.members.every((m) => Math.abs(m.alt - s.alt) <= M.MERGE_BAND_KM)));
const groups = {};
for (const s of M.SHELLS) groups[s.group] = (groups[s.group] || 0) + s.count;
ok("the four inclination groups are present", M.GROUP_INCS.every((g) => groups[String(g)] > 0),
    Object.entries(groups).map(([g, c]) => `${g}: ${(100 * c / table.total).toFixed(1)}%`).join(", "));
ok("Sun-synchronous shells carry their plane local times", M.SHELLS.filter((s) => s.sso).every((s) => s.ltan.length > 0 && sum(s.ltan.map((p) => p[1])) === s.count));
ok("every model shell has measured planes", M.SHELLS.every((s) => s.planes > 0), `${sum(M.SHELLS.map((s) => s.planes))} planes in all`);

console.log("== rate: the year span and the dated planes ==");
// 365 nights from the 1st of the month of the table's reference epoch.
const ref = new Date(table.refEpoch);
ok("the span starts on the 1st of the month of the shell table's reference epoch", M.SPAN.start === `${ref.getUTCFullYear()}-${String(ref.getUTCMonth() + 1).padStart(2, "0")}-01` && M.DAYS === 365,
    `${M.SPAN.start} to ${M.SPAN.end}, reference epoch ${table.refEpoch}`);
ok("dateOfDay and dayOfDate are inverse, and the span has 12 months", M.dateOfDay(M.DAYS - 1) === M.SPAN.end && M.dayOfDate(M.SPAN.end) === M.DAYS - 1 && M.dayOfDate(M.SPAN.start) === 0 && M.spanMonths().length === 12 && M.spanMonths()[0].day === 0);
// Dated planes: a non-Sun-synchronous shell's planes are written as local times of the
// ascending node at the night's noon; on the reference epoch's own date they are the measured
// RAANs against GMST at noon; every plane list keeps the shell's count. A Sun-synchronous
// shell's list is unchanged on any date.
{
    const refDate = table.refEpoch.slice(0, 10);
    const dated = M.shellsForNight(refDate), uniform = M.shellsForNight(refDate, { planes: "uniform" }), atLon0 = M.shellsForNight(refDate, { lon: 0 });
    ok("shellsForNight keeps the order and the counts of SHELLS", dated.length === M.SHELLS.length && dated.every((s, i) => s.count === M.SHELLS[i].count && s.inc === M.SHELLS[i].inc));
    ok("every dated shell has a plane list holding its whole count", dated.every((s) => s.ltan && Math.abs(sum(s.ltan.map((p) => p[1])) - s.count) < 1e-9));
    ok("uniform planes leave the non-Sun-synchronous shells without a plane list", uniform.every((s) => !!s.ltan === !!s.sso));
    ok("Sun-synchronous shells keep the same plane list on any date", dated.filter((s) => s.sso).every((s, i) => s.ltan === M.SHELLS.filter((x) => x.sso)[i].ltan) &&
        M.shellsForNight("2027-06-21").filter((s) => s.sso).every((s, i) => s.ltan === M.SHELLS.filter((x) => x.sso)[i].ltan));
    // The largest 53° shell on the reference date, at longitude 0: plane k's local time = 12 h + (RAAN - GMST at noon) / 15.
    const big = M.SHELLS.findIndex((s) => !s.sso && s.members.length === 1), s0 = M.SHELLS[big];
    const gmstDeg = M._debug.gmstDeg(new Date(refDate + "T12:00:00Z"));
    const expect = s0.members[0].raan.map(([raan, c]) => [(((12 + (raan - gmstDeg) / 15) % 24) + 24) % 24, c]);
    const maxDiff = Math.max(...expect.map((p, k) => Math.abs(p[0] - atLon0[big].ltan[k][0]) + Math.abs(p[1] - atLon0[big].ltan[k][1])));
    ok("on the reference date, at longitude 0, a shell's planes are its measured RAANs against GMST at noon", maxDiff < 1e-9, `${s0.inc}°/${s0.alt} km, ${expect.length} planes, max difference ${maxDiff.toExponential(1)} h`);
    // One day later every plane has moved by the generator's J2 rate (a 53°/470 km plane moves 4.7° west = 0.31 h earlier against the Sun's 1°).
    const next = M.shellsForNight(M.dateOfDay(M.dayOfDate(refDate) + 1), { lon: 0 })[big];
    const rate = M.nodalRate(s0.alt, s0.inc), gmst2 = M._debug.gmstDeg(new Date(M.dateOfDay(M.dayOfDate(refDate) + 1) + "T12:00:00Z"));
    const shift = (((next.ltan[0][0] - atLon0[big].ltan[0][0]) % 24) + 36) % 24 - 12, expectShift = (rate - ((gmst2 - gmstDeg + 540) % 360 - 180)) / 15;
    ok("a day later the planes have turned at the generator's J2 rate", Math.abs(shift - expectShift) < 1e-9, `${rate.toFixed(2)}°/day; local time shift ${shift.toFixed(3)} h = ${expectShift.toFixed(3)} h`);
    // The night at longitude L starts L / 360 day before 12:00 UT: at 120°E the planes have
    // drifted a third of a day less against the mean Sun than at longitude 0.
    const at120 = M.shellsForNight(refDate, { lon: 120 })[big];
    const shift120 = (((at120.ltan[0][0] - atLon0[big].ltan[0][0]) % 24) + 36) % 24 - 12, expect120 = -(rate - M.SUN_RATE) / 3 / 15;
    ok("at 120°E the planes are a third of a day of drift behind longitude 0", Math.abs(shift120 - expect120) < 1e-9, `${(shift120 * 15).toFixed(3)}° = ${(expect120 * 15).toFixed(3)}°`);
    // Without a longitude each plane is spread over its day of drift against the mean Sun,
    // in sub-planes at most SPREAD_STEP_DEG apart, so the count is the mean over longitude.
    const planes0 = atLon0[big].ltan.length, parts = dated[big].ltan.length / planes0;
    const sub = dated[big].ltan.slice(0, parts).map((p) => p[0]), pitch = Math.abs(sub[1] - sub[0]) * 15, width = Math.abs(sub[parts - 1] - sub[0]) * 15 + pitch;
    ok("the longitude spread covers one day of drift in sub-planes at most 0.25° apart", Number.isInteger(parts) && pitch <= M.SPREAD_STEP_DEG + 1e-9 && Math.abs(width - Math.abs(rate - M.SUN_RATE)) < 1e-9,
        `${planes0} planes x ${parts} sub-planes, pitch ${pitch.toFixed(3)}°, width ${width.toFixed(3)}° = ${Math.abs(rate - M.SUN_RATE).toFixed(3)}°/day`);
    // The simulation's night at longitude L is the night at L: its counts at the three
    // longitudes of the simulated year differ (25°S on 8 May 2026: 386, 304 and 240 visible
    // flares at 0, 120 and 240), and the model placed at each longitude follows them.
    const sim = { 0: 386, 120: 304, 240: 240 };
    const atEach = Object.fromEntries(Object.keys(sim).map((lon) => [lon, M.expectedNight({ lat: -25, date: "2026-05-08", kind: "visible", lon: Number(lon) }).total]));
    ok("the model at each longitude follows the simulation's count at that longitude (25°S 8 May 2026, within 5%)",
        Object.keys(sim).every((lon) => Math.abs(atEach[lon] / sim[lon] - 1) < 0.05), Object.keys(sim).map((lon) => `lon ${lon}: ${atEach[lon].toFixed(0)} vs ${sim[lon]}`).join(", "));
    const spread = M.expectedNight({ lat: -25, date: "2026-05-08", kind: "visible" }).total, simMean = (386 + 304 + 240) / 3;
    ok("the longitude mean lies between the single longitudes and near the simulation's mean (within 20%)", spread < atEach[0] && spread > atEach[240] && Math.abs(spread / simMean - 1) < 0.2, `${spread.toFixed(0)} vs ${simMean.toFixed(0)}`);
    // Dating changes a night (the few-plane 70° shells): 55°N 24 March 2026 in the simulation
    // gave 43 visible flares (38, 37 and 53 at the three longitudes), the uniform planes 80.
    const u = M.expectedNight({ lat: 55, date: "2026-03-24", kind: "visible", planes: "uniform" }).total;
    const d = M.expectedNight({ lat: 55, date: "2026-03-24", kind: "visible" }).total;
    ok("dated planes change a night that the uniform planes get wrong (55°N 24 Mar 2026: simulation 43 ± 9)", Math.abs(d - 43) < 10 && u > 70, `uniform ${u.toFixed(1)}, dated ${d.toFixed(1)}`);
}

console.log("== rate: the Sun-synchronous local-time convention ==");
// The table stores local MEAN solar time; the model anchors it to the mean Sun (GMST at the
// night's noon). private/probes/FlareLtanSignCheck.mjs proved it against engine scans of a
// generator-built two-plane shell (8,000 satellites, LTAN 8 h and 20 h): on 2026-02-11
// (equation of time -14 min) at 50°N the engine saw 2,694 visible flares, the model 2,671;
// with the equation of time ignored it gives 1,041, with the opposite sign 0.
const eot = M.equationOfTimeHours("2026-11-03"), eot2 = M.equationOfTimeHours("2026-02-11");
ok("equation of time: +16 min in early November, -14 min in mid-February",
    Math.abs(eot * 60 - 16.4) < 1 && Math.abs(eot2 * 60 + 14.2) < 1, `${(eot * 60).toFixed(1)} min, ${(eot2 * 60).toFixed(1)} min`);
const twoPlane = { inc: 97.289, alt: 472.8, count: 8000, ltan: [[8.0, 4000], [20.0, 4000]] };
const meanAnchored = M.expectedNight({ lat: 50, date: "2026-02-11", kind: "visible", shells: [twoPlane] }).total;
const noEot = M.expectedNight({ lat: 50, date: "2026-02-11", kind: "visible", shells: [{ ...twoPlane, ltanTime: "apparent" }] }).total;
ok("mean-time planes reproduce the engine's two-plane count (2,694 ± 5%)", Math.abs(meanAnchored / 2694.5 - 1) < 0.05, `${meanAnchored.toFixed(0)}`);
ok("ignoring the equation of time changes that count by more than 30%", Math.abs(noEot / 2694.5 - 1) > 0.3, `${noEot.toFixed(0)}`);

console.log("== rate: engine truth (frozen snapshot) ==");
// Tolerances: the truth is one random draw of 8,000 planes per set, shared by all its
// cells, and its per-latitude ratios scatter by up to ±7% from that draw alone (the worst
// in the snapshot is 1.066 ± 0.013). So: every latitude with at least 100 flares within 8%,
// the pooled chi-squared per latitude below 8, and each set's total within 2%.
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/rate-truth.json", import.meta.url), "utf8"));
let t0 = performance.now(), nights = 0;
for (const set of fixture.sets) {
    for (const [kind, rows] of Object.entries(set.kinds)) {
        let chi2 = 0, n = 0, worst = 0, worstAt = "", truthSum = 0, predSum = 0;
        for (const [lat, truth, se] of rows) {
            let pred = 0;
            for (const date of set.dates) { pred += M.expectedNight({ lat, date, kind, shells: [set.shell] }).total; nights++; }
            truthSum += truth; predSum += pred;
            if (truth >= 100) {
                const err = Math.max(se, Math.sqrt(truth));
                chi2 += ((pred - truth) / err) ** 2; n++;
                const e = Math.abs(pred / truth - 1);
                if (e > worst) { worst = e; worstAt = `lat ${lat}: ${pred.toFixed(0)} vs ${truth} ± ${se}`; }
            }
        }
        const ratio = predSum / truthSum;
        ok(`${set.id} ${set.label} (${kind}): total within 2%, every latitude within 8%, chi2/lat < 8`,
            Math.abs(ratio - 1) < 0.02 && worst < 0.08 && chi2 / n < 8,
            `total ${ratio.toFixed(4)}, worst ${(100 * worst).toFixed(1)}% at ${worstAt}, chi2/lat ${(chi2 / n).toFixed(2)}`);
    }
}
console.log(`     (${nights} nights in ${((performance.now() - t0) / 1000).toFixed(1)} s)`);

console.log("== rate: the simulated year (frozen snapshot, dated planes) ==");
// The whole constellation (the generator, dated planes) scanned by the engine on 12 latitudes
// x 24 nights of 2026 x 3 longitudes; the fixture holds the 3-longitude means, which the
// model's longitude mean is compared with. Tolerances: the per-latitude year sums were
// 0.990-1.006 (visible) and 0.987-1.003 (all) of the simulation when the fixture was frozen,
// with the simulation's own standard error 0.3-1%: every latitude within 3%. The single
// nights, chosen where the dated and the uniform planes differ by 4-7%, were within 2.1%:
// each within 5%.
const yearFixture = JSON.parse(fs.readFileSync(new URL("./fixtures/rate-year.json", import.meta.url), "utf8"));
t0 = performance.now(); nights = 0;
for (const kind of M.KINDS) {
    let worst = 0, worstAt = "", predAll = 0, truthAll = 0;
    for (const [lat, truth] of yearFixture.years[kind]) {
        let pred = 0;
        for (const date of yearFixture.dates) { pred += M.expectedNight({ lat, date, kind }).total; nights++; }
        predAll += pred; truthAll += truth;
        const e = Math.abs(pred / truth - 1);
        if (e > worst) { worst = e; worstAt = `${lat}°: ${pred.toFixed(0)} vs ${truth}`; }
    }
    ok(`simulated year (${kind}): every latitude's year sum within 3%`, worst < 0.03, `total ${(predAll / truthAll).toFixed(4)}, worst ${(100 * worst).toFixed(1)}% at ${worstAt}`);
    let worstNight = 0, worstNightAt = "";
    for (const [lat, date, truth, sd] of yearFixture.nights[kind]) {
        const pred = M.expectedNight({ lat, date, kind }).total; nights++;
        const e = Math.abs(pred / truth - 1);
        if (e > worstNight) { worstNight = e; worstNightAt = `${lat}° ${date}: ${pred.toFixed(0)} vs ${truth} ± ${sd}`; }
    }
    ok(`simulated year (${kind}): single nights within 5%`, worstNight < 0.05, `worst ${(100 * worstNight).toFixed(1)}% at ${worstNightAt}`);
}
console.log(`     (${nights} nights in ${((performance.now() - t0) / 1000).toFixed(1)} s)`);

console.log("== rate: the year table ==");
const tableFile = new URL("../rate/rateTable.json", import.meta.url);
if (!fs.existsSync(tableFile)) {
    ok("rate/rateTable.json exists (run tools/build-rate-table.mjs)", false);
} else {
    const raw = JSON.parse(fs.readFileSync(tableFile, "utf8"));
    let T = null, why = "";
    try { T = M.decodeRateTable(raw); } catch (err) { why = err.message; }     // refuses another span or shell table
    ok("the year table decodes: its format, span and shell table are the model's (else run tools/build-rate-table.mjs)", T !== null, why);
    if (!T) { T = { span: {}, days: 0, nLat: 0, visible: [], all: [] }; }
    ok("table header: format, span, shell table", T.span.start === M.SPAN.start && T.span.end === M.SPAN.end && T.days === M.DAYS && T.source === table.source && T.refEpoch === table.refEpoch,
        `${raw.format} ${T.span.start} to ${T.span.end}, ${T.source}; ${T.nLat} latitudes from ${T.latMin} step ${T.latStep}`);
    ok("decodeRateTable refuses a table for another span", (() => { try { M.decodeRateTable({ ...raw, span: { start: "2020-01-01", end: "2020-12-30" } }); return false; } catch { return true; } })());
    // Every slider position (half degrees) has its own row: no interpolation. Where the
    // Sun's deepest point just reaches a shell's window, the count changes by a factor of
    // several within one degree of latitude, so interpolation between whole degrees was
    // measured to be wrong by up to a factor of 5 in such cells.
    ok("table covers 90°S to 90°N at every half degree", T.latMin === -90 && T.latStep === 0.5 && T.latMin + (T.nLat - 1) * T.latStep === 90);
    const at = (kind, i, n) => T[kind][i * T.days + n];
    const rowOf = (lat) => Math.round((lat - T.latMin) / T.latStep);
    // Rows against the live model (dated planes): the stored value is the live value rounded to 1/scale.
    let worstRow = 0, worstRowAt = "";
    for (const lat of [-35, 0, 20.5, 45, 54.5, 71.5]) for (const kind of M.KINDS) for (const n of [5, 41, 95, 140, 185, 230, 275, 320, 360]) {
        const live = M.expectedNight({ lat, date: M.dateOfDay(n), kind }).total;
        const e = Math.abs(at(kind, rowOf(lat), n) - live);
        if (e > worstRow) { worstRow = e; worstRowAt = `${lat}° ${M.dateOfDay(n)} ${kind}: ${at(kind, rowOf(lat), n)} vs ${live.toFixed(2)}`; }
    }
    ok("table rows equal the live model to the stored resolution (0.1 flares)", worstRow <= 0.5 / raw.scale + 1e-9, `worst difference ${worstRow.toFixed(3)} flares at ${worstRowAt}`);
    ok("all flares are never fewer than visible flares", T.all.every((v, k) => v >= T.visible[k] - 1e-9));
    // Dating the planes moves nights, not years: the table's year total at a latitude (dated,
    // every night) against the uniform planes' total over every second night, scaled. Measured
    // over every night at every 5° from 60°S to 70°N: within 1.8% (visible) and 1.6% (all),
    // the worst at 55°S; the half-night sample adds under 0.5%. Tolerance 2.5%.
    let worstYear = 0, worstYearAt = "";
    for (const lat of [-55, 45, 55]) {
        let dated = 0, uniform = 0;
        for (let n = 0; n < T.days; n += 2) { dated += at("visible", rowOf(lat), n); uniform += M.expectedNight({ lat, date: M.dateOfDay(n), kind: "visible", planes: "uniform" }).total; }
        const e = Math.abs(dated / uniform - 1);
        if (e > worstYear) { worstYear = e; worstYearAt = `${lat}°: ${dated.toFixed(0)} dated vs ${uniform.toFixed(0)} uniform`; }
    }
    ok("the dated planes' year total at a latitude is within 2.5% of the uniform planes' (dating moves nights, not years)", worstYear < 0.025, `worst ${(100 * worstYear).toFixed(2)}% at ${worstYearAt}`);
}

console.log("== rate: night chart range, poles and speed ==");
// The page's night chart shows 14:00 to 10:00. No flare may fall outside it.
let outside = 0, where = "";
for (let lat = -90; lat <= 90; lat += 15) {
    for (let day = 0; day < M.DAYS; day += 20) {
        const bins = M.expectedNight({ lat, date: M.dateOfDay(day), kind: "all" }).bins;
        let early = 0, late = 0;
        for (let b = 0; b < M.NBINS; b++) { const h = 12 + b * M.BIN_MIN / 60; if (h < 14) early += bins[b]; else if (h >= 34) late += bins[b]; }
        if (early > 1e-9 || late > 1e-9) { outside++; where ||= `${lat}° day ${day}: ${early.toFixed(2)} before 14:00, ${late.toFixed(2)} after 10:00`; }
    }
}
ok("no flares before 14:00 or after 10:00 local solar time", outside === 0, where);

const poleDates = [M.dateOfDay(0), M.dateOfDay(90), M.dateOfDay(180), M.dateOfDay(270)];
const finite = [-90, -89.5, 89.5, 90].every((lat) => poleDates.every((date) => {
    const r = M.expectedNight({ lat, date, kind: "visible" });
    return Number.isFinite(r.total) && r.bins.every(Number.isFinite);
}));
ok("finite at and near the poles", finite);
ok("finite night profile and depression at the poles", [-90, 90].every((lat) => Number.isFinite(M.nightProfile(lat, 100).total) && Number.isFinite(M.maxDepression(lat, 100))));
ok("no flares at the north pole in midsummer (the Sun never sets)", M.expectedNight({ lat: 90, date: M.dateOfDay(M.dayOfDate(`${M.SPAN.end.slice(0, 4)}-06-21`)), kind: "all" }).total === 0);

M.expectedNight({ lat: 45, date: M.dateOfDay(100), kind: "visible" });      // warm the lobe tables
t0 = performance.now();
const r45 = M.expectedNight({ lat: 45, date: "2026-10-27", kind: "visible" });
const ms = performance.now() - t0;
ok("one night of the whole constellation computes within 200 ms", ms < 200, `${ms.toFixed(1)} ms, ${r45.total.toFixed(1)} flares at 45°N on 27 Oct 2026`);
ok("the night's bins, hours and shells all add up to its total",
    Math.abs(sum(r45.bins) - r45.total) < 1e-6 && Math.abs(sum(r45.hour) - r45.total) < 1e-6 && Math.abs(sum(r45.byShell) - r45.total) < 1e-6);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
