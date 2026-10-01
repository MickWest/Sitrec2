// Validates the offline synthetic constellation (dummyTLE.js): the generated TLEs must parse
// with the REAL satellite.js (correct columns + checksums), reproduce the measured shell
// table (inclination groups, their shares, the altitude distribution), keep the
// Sun-synchronous planes at their local times on any date, and run through the flare
// engine without error.
import { generateDummyTLE, STARLINK_SHELLS } from "../dummyTLE.js";
import * as astro from "../astro.js";

let fails = 0;
const ok = (name, cond, extra = "") => { console.log((cond ? "  ok   " : "  FAIL ") + name + (extra ? "  " + extra : "")); if (!cond) fails++; };
const near = (a, b, t) => Math.abs(a - b) <= t;

const realSat = await import("satellite.js");
const sat = realSat.default ?? realSat;
const DEG = 180 / Math.PI;
const MU = 398600.4418, RE = 6371;      // the altitude convention of the shell table

const date = new Date("2026-05-29T00:00:00Z");
const text = generateDummyTLE(date);

// Parse via the engine's parseTLE (groups name/line1/line2, skips error!==0).
const { createFlareEngine } = await import("../flareEngine.js");
const engine = createFlareEngine(sat);
const sats = engine.parseTLE(text);

console.log("== dummy TLE: parsing ==");
const triples = text.trim().split("\n").length / 3;
ok("generated the table's count", sats.length === STARLINK_SHELLS.total, `n=${sats.length} of ${STARLINK_SHELLS.total}`);
ok("every generated TLE parsed (none skipped by satrec.error)", sats.length === triples, `${sats.length}/${triples}`);

console.log("== dummy TLE: orbital elements match the measured table ==");
// Elements straight from line 2: inclination, RAAN, and the altitude from the mean motion.
const line2 = text.split("\n").filter((l) => l.startsWith("2 "));
const elements = line2.map((l) => {
    const n = Number(l.slice(52, 63)) * 2 * Math.PI / 86400;
    return { inc: Number(l.slice(8, 16)), raan: Number(l.slice(17, 25)), alt: Math.cbrt(MU / (n * n)) - RE };
});
const incs = sats.map((s) => +(s.satrec.inclo * DEG).toFixed(1));
const incSet = [...new Set(incs)].sort((a, b) => a - b);
ok("inclination groups 43.0, 53.2, 70.0 and 97.3 are present (SGP4 decoded them)",
    [43.0, 53.2, 70.0, 97.3].every((g) => incSet.some((i) => near(i, g, 0.05))), incSet.join(", "));
const share = (lo, hi) => elements.filter((e) => e.inc >= lo && e.inc < hi).length / elements.length;
const tableShare = (lo, hi) => STARLINK_SHELLS.shells.filter((s) => s.inc >= lo && s.inc < hi).reduce((a, s) => a + s.count, 0) / STARLINK_SHELLS.total;
for (const [name, lo, hi] of [["43°", 40, 48], ["53°", 48, 60], ["70°", 60, 85], ["97°", 85, 110]]) {
    ok(`${name} group share equals the table's`, near(share(lo, hi), tableShare(lo, hi), 0.002),
        `${(100 * share(lo, hi)).toFixed(2)}% vs ${(100 * tableShare(lo, hi)).toFixed(2)}%`);
}
ok("53° and 43° shells dominate (>75%)", share(40, 60) > 0.75, `${(100 * share(40, 60)).toFixed(0)}%`);
ok("polar orbits are a minority (about 14%)", share(85, 110) > 0.1 && share(85, 110) < 0.2, `${(100 * share(85, 110)).toFixed(1)}%`);

const alts = elements.map((e) => e.alt).sort((a, b) => a - b);
const median = alts[Math.floor(alts.length / 2)];
const tableAlts = STARLINK_SHELLS.shells.flatMap((s) => Array(s.count).fill(s.alt)).sort((a, b) => a - b);
const tableMedian = tableAlts[Math.floor(tableAlts.length / 2)];
ok("median altitude equals the table's (about 473 km, not 490 or 550)", near(median, tableMedian, 2), `${median.toFixed(1)} km vs ${tableMedian} km`);
ok("all satellites in 230-600 km", alts[0] > 230 && alts[alts.length - 1] < 600, `${alts[0].toFixed(0)}-${alts[alts.length - 1].toFixed(0)} km`);
const lowShare = alts.filter((a) => a < 460).length / alts.length;
ok("a real fraction sits below 460 km (raising and decaying shells, about 10%)", lowShare > 0.07 && lowShare < 0.14, `${(100 * lowShare).toFixed(1)}%`);
// SGP4 propagation of a sample stays in the LEO band.
let bad = 0;
for (let i = 0; i < sats.length; i += 20) {
    const pv = sat.propagate(sats[i].satrec, date);
    if (!pv || !pv.position || !Number.isFinite(pv.position.x)) { bad++; continue; }
    const h = sat.eciToGeodetic(pv.position, sat.gstime(date)).height;
    if (h < 200 || h > 620) bad++;
}
ok("SGP4 propagates every sampled satellite to 200-620 km", bad === 0, `bad=${bad}`);

console.log("== dummy TLE: planes ==");
// The measured planes: the 53°/470 km shell's RAAN histogram (10° bins) at the table's
// reference epoch equals the table's, and a different date precesses the whole pattern.
const shell53 = STARLINK_SHELLS.shells[0];
const refDate = new Date(STARLINK_SHELLS.refEpoch);
const atRef = generateDummyTLE(refDate).split("\n").filter((l) => l.startsWith("2 ")).map((l) => ({ inc: Number(l.slice(8, 16)), raan: Number(l.slice(17, 25)), alt: Math.cbrt(MU / (Number(l.slice(52, 63)) * 2 * Math.PI / 86400) ** 2) - RE }));
const hist = (vals, bin, period) => { const h = new Array(Math.round(period / bin)).fill(0); for (const v of vals) h[Math.floor((((v % period) + period) % period) / bin)]++; return h; };
const gen53 = hist(atRef.filter((e) => near(e.inc, shell53.inc, 0.01) && near(e.alt, shell53.alt, 5)).map((e) => e.raan), 10, 360);
const tab53 = hist(shell53.raan.flatMap(([r, k]) => Array(k).fill(r)), 10, 360);
const histDiff = Math.max(...gen53.map((v, i) => Math.abs(v - tab53[i])));
ok("the 53°/470 km planes at the reference epoch match the table (10° RAAN bins within 4)", histDiff <= 4, `worst bin difference ${histDiff}`);

// Sun-synchronous planes: local MEAN solar time of the ascending node, LTAN = UT + (RAAN - GMST)/15,
// the same on any date, and equal to the table's plane list. For each table plane, the
// generated satellites within 0.02 h of its local time (the RAAN jitter is ±0.15° = ±0.01 h).
const tablePlanes = STARLINK_SHELLS.shells.filter((s) => s.sso).flatMap((s) => s.ltan);
function planeCounts(d) {
    const rows = generateDummyTLE(d).split("\n").filter((l) => l.startsWith("2 ")).map((l) => ({ inc: Number(l.slice(8, 16)), raan: Number(l.slice(17, 25)) }));
    const gmstDeg = astro.gmstRad(d) * DEG, ut = (d.getTime() % 86400000) / 3600000;
    const ltans = rows.filter((e) => e.inc > 90).map((e) => (((ut + (e.raan - gmstDeg) / 15) % 24) + 24) % 24);
    return tablePlanes.map(([h]) => ltans.filter((v) => Math.min(Math.abs(v - h), 24 - Math.abs(v - h)) <= 0.02).length);
}
const c1 = planeCounts(new Date("2026-05-29T00:00:00Z")), c2 = planeCounts(new Date("2027-02-12T18:30:00Z"));
// Planes closer than 0.04 h share satellites in the count, so each plane must hold at least its own.
const short1 = Math.max(...tablePlanes.map(([, k], i) => k - c1[i])), d12 = Math.max(...c1.map((v, i) => Math.abs(v - c2[i])));
ok("every Sun-synchronous plane holds its satellites at the table's local time (±0.02 h)", short1 <= 0, `${tablePlanes.length} planes, worst shortfall ${short1}`);
ok("...and keeps them on another date, nine months later", d12 <= 0, `worst count difference ${d12}`);

console.log("== dummy TLE: engine scan runs ==");
let threw = false, res;
try {
    res = engine.scanForward({
        sats,
        observerAt: () => ({ lat: 34, lon: -118, altKm: 0 }),
        startMs: Date.UTC(2026, 4, 29, 4, 0, 0),
        maxLookAheadSec: 2 * 86400,
        options: {},
        onProgress: () => {},
    });
} catch (e) { threw = true; console.log("    scan threw:", e && e.message); }
ok("scanForward completes on the dummy set", !threw && !!res && Array.isArray(res.flares),
    res ? `flares=${res.flares.length}` : "");
// Realism regression: a real-sized constellation gives MANY flares per session
// (the old sparse set gave a handful), and crucially they reach the HORIZON and
// spread in elevation — satellites at a single altitude would produce only a thin band.
ok("synthetic density is realistic (busy session, >100 flares)", !!res && res.flares.length > 100,
    res ? `flares=${res.flares.length}` : "");
if (res && res.flares.length) {
    const fe = res.flares.map((f) => f.elDeg);
    const minEl = Math.min(...fe), maxEl = Math.max(...fe);
    const nearHorizon = fe.filter((e) => e < 3).length;
    ok("flares reach the horizon (some below 3°)", nearHorizon > 0, `min=${minEl.toFixed(1)}° (${nearHorizon} below 3°)`);
    ok("flares span a realistic elevation range (>10°, not a thin band)", (maxEl - minEl) > 10,
        `${minEl.toFixed(1)}–${maxEl.toFixed(1)}°`);
}

console.log("== engine: horizon flares persist into deep night (band fix) ==");
// At Sun ~-48° (well within the current -56° productive band) a high-flying aircraft
// should still see horizon flares — they don't stop at the end of twilight.
let deepStart = null;
for (let h = 0; h < 96; h++) {
    const t = Date.UTC(2026, 11, 22, 0, 0, 0) + h * 15 * 60000;   // winter night, mid-lat
    const el = astro.sunElevationDeg(45, -100, new Date(t));
    if (el < -44 && el > -52) { deepStart = t; break; }
}
const obsFlight = { observerAt: () => ({ lat: 45, lon: -100, altKm: 11.3 }), startMs: deepStart, endMs: deepStart + 146 * 60000, onProgress: () => {} };
const deepOld = engine.scan({ sats, ...obsFlight, options: { minSunElevationDeg: -40 } });
const deepNew = engine.scan({ sats, ...obsFlight, options: {} });   // default band (-56)
ok("narrower old band (-40°) skipped deep night (no productive steps)", deepOld.stats.productiveSteps === 0,
    `productiveSteps=${deepOld.stats.productiveSteps}`);
ok("new band scans deep night instead of skipping it", deepNew.stats.productiveSteps > 0,
    `productiveSteps=${deepNew.stats.productiveSteps}`);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
