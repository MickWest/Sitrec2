// Validates the offline dummy constellation: the generated TLEs must parse with
// the REAL satellite.js (correct columns + checksums), carry the intended
// inclinations (proves column alignment), match the real altitude distribution
// (~360–580 km, median ~490), and run through the flare engine without error.
import { generateDummyTLE } from "../dummyTLE.js";
import * as astro from "../astro.js";

let fails = 0;
const ok = (name, cond, extra = "") => { console.log((cond ? "  ok   " : "  FAIL ") + name + (extra ? "  " + extra : "")); if (!cond) fails++; };
const near = (a, b, t) => Math.abs(a - b) <= t;

const realSat = await import("satellite.js");
const sat = realSat.default ?? realSat;
const DEG = 180 / Math.PI;

const date = new Date("2026-05-29T00:00:00Z");
const text = generateDummyTLE(date);

// Parse via the engine's parseTLE (groups name/line1/line2, skips error!==0).
const { createFlareEngine } = await import("../flareEngine.js");
const engine = createFlareEngine(sat);
const sats = engine.parseTLE(text);

console.log("== dummy TLE: parsing ==");
ok("generated a large set (>1500)", sats.length > 1500, `n=${sats.length}`);
const triples = text.trim().split("\n").length / 3;
ok("every generated TLE parsed (none skipped by satrec.error)", sats.length === triples, `${sats.length}/${triples}`);

console.log("== dummy TLE: orbital elements decoded correctly ==");
const incs = sats.map((s) => +(s.satrec.inclo * DEG).toFixed(1));
const incSet = [...new Set(incs)].sort((a, b) => a - b);
ok("inclinations match the real shells (43, 53.2, 70, 97.5)",
    incSet.length === 4 && near(incSet[0], 43, 0.2) && near(incSet[3], 97.5, 0.2), incSet.join(", "));
const at53 = incs.filter((i) => i >= 52.8 && i <= 53.4).length;
const at43 = incs.filter((i) => Math.abs(i - 43) < 0.3).length;
ok("53° + 43° shells dominate (>75%)", (at53 + at43) / sats.length > 0.75,
    `${(((at53 + at43) / sats.length) * 100).toFixed(0)}%`);
const polar = incs.filter((i) => i > 90).length;
ok("polar orbits are a minority ('a few')", polar > 0 && polar < sats.length * 0.15, `${polar}/${sats.length}`);

console.log("== dummy TLE: altitude distribution matches reality (~360–580 km) ==");
let bad = 0, lowCount = 0;
const altsKm = [];
for (let i = 0; i < sats.length; i += 20) {
    const pv = sat.propagate(sats[i].satrec, date);
    if (!pv || !pv.position || !Number.isFinite(pv.position.x)) { bad++; continue; }
    const h = sat.eciToGeodetic(pv.position, sat.gstime(date)).height;
    altsKm.push(h);
    if (h < 300 || h > 620) bad++;
    if (h < 460) lowCount++;   // the real "low" populations (~360–490 km)
}
altsKm.sort((a, b) => a - b);
const median = altsKm[Math.floor(altsKm.length / 2)];
ok("all sampled sats in ~300–620 km", bad === 0, `bad=${bad}`);
ok("median altitude ≈ real (~490 km, not 550)", median > 460 && median < 510, `median=${median.toFixed(0)}km`);
ok("a real fraction sits below 460 km (low shells / raising, real ≈12%)",
    lowCount / altsKm.length > 0.08, `${((lowCount / altsKm.length) * 100).toFixed(0)}%`);

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
