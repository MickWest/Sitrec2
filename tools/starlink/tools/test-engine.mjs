// Execute-test for flareEngine.js.
//
// (1) DETERMINISTIC physics/scanner test using an INJECTED MOCK satellite library.
//     We place a satellite at a fixed ECEF point and make the mock's eciToEcf return,
//     for the Sun, exactly the engine's own *reflected* ray — forcing glint = 0, a
//     guaranteed flare — then assert the engine reports it with the right az/el/time.
// (2) SMOKE test against the REAL satellite.js + a few valid TLEs: parseTLE + a full
//     scan must complete without throwing and return well-formed output.
import * as geo from "../geo.js";
import * as astro from "../astro.js";
import { createFlareEngine, FLARE_DEFAULTS } from "../flareEngine.js";

let fails = 0;
function ok(name, cond, extra = "") {
    console.log((cond ? "  ok   " : "  FAIL ") + name + (extra ? "  " + extra : ""));
    if (!cond) fails++;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("== engine: deterministic horizon-flare (mock satellite) ==");

// Construct a PHYSICALLY REALIZABLE horizon flare: a low-elevation satellite whose
// nadir-mirror reflection of the line-of-sight grazes the limb; the Sun sits a few
// degrees outward of that reflected ray so the satellite is still SUNLIT and the
// glint angle falls inside the 5° cone. (A forced glint=0 is unrealizable — the
// reflected ray would point into the Earth, putting the satellite in shadow.)
const OBS = geo.llaToEcef(0, 0, 0);
let S = null;
outer:
for (const dlon of [24, 23.5, 23, 22.5, 22, 21, 20, 19, 18]) {
    const sp = geo.llaToEcef(0, dlon, 550);
    const d = geo.vsub(sp, OBS);
    if (geo.rayHitsEllipsoid(OBS, d)) continue;          // must be above the observer's horizon
    const ae = geo.azElFromObserver(OBS, sp);
    if (ae.elDeg <= 0.3) continue;
    const nrm = geo.geocentricUp(sp);
    const reflected = geo.vnorm(geo.vreflect(d, nrm));
    for (let eps = 0; eps <= 0.4; eps += 0.005) {        // nudge outward until sunlit & within cone
        const ts = geo.vnorm(geo.vadd(reflected, geo.vscale(nrm, eps)));
        if (geo.rayHitsEllipsoid(sp, ts)) continue;      // require sunlit (sat->Sun ray misses Earth)
        const glint = Math.acos(Math.max(-1, Math.min(1, geo.vdot(reflected, ts)))) * 180 / Math.PI;
        if (glint < 4.0) { S = { dlon, sp, ts, ae, glint, eps }; break outer; }
    }
}
ok("constructed a realizable sunlit horizon flare", !!S,
    S ? `dlon=${S.dlon} el=${S.ae.elDeg.toFixed(2)}° glint=${S.glint.toFixed(2)}°` : "none found");
if (!S) { console.log("\nCannot build scenario — aborting"); process.exit(1); }

const SAT_POS = S.sp;
const DESIRED_TOSUN = S.ts;
const refAzEl = S.ae;
ok("scenario: sat above horizon", !geo.rayHitsEllipsoid(OBS, geo.vsub(SAT_POS, OBS)));
ok("scenario: sat sunlit", !geo.rayHitsEllipsoid(SAT_POS, DESIRED_TOSUN));
ok("scenario: low positive elevation", refAzEl.elDeg > 0.3 && refAzEl.elDeg < 25, refAzEl.elDeg.toFixed(2));
ok("scenario: azimuth ~ east (90)", near(refAzEl.azDeg, 90, 1), refAzEl.azDeg.toFixed(2));

const mockSat = {
    twoline2satrec: (l1) => ({ error: 0, _l1: l1 }),
    gstime: () => 0,
    propagate: () => ({ position: { ...SAT_POS }, velocity: { x: 0, y: 0, z: 0 } }),
    eciToEcf: (p) => {
        const L = Math.hypot(p.x, p.y, p.z);
        return L < 1.5 ? { ...DESIRED_TOSUN } : { x: p.x, y: p.y, z: p.z };
    },
};

const engine = createFlareEngine(mockSat);
const sats = engine.parseTLE("MOCKSAT-1\n1 00001U 00000A   00000.0  .0  0  0 0  01\n2 00001  53.0 0 0 0 0 15.0 01\n");
ok("parseTLE returns 1 mock sat", sats.length === 1, `len=${sats.length}`);

const startMs = Date.UTC(2026, 4, 28, 0, 0, 0);
const windowSec = 120;
const res = engine.scan({
    sats,
    observerAt: () => ({ lat: 0, lon: 0, altKm: 0 }),
    startMs,
    endMs: startMs + windowSec * 1000,
    options: { fineStepSec: 1, filterStepSec: 30, maxSunElevationDeg: 90, minSunElevationDeg: -90 },
    onProgress: () => {},
});
ok("scan finds the forced flare", res.flares.length >= 1, `n=${res.flares.length}`);
if (res.flares.length) {
    const f = res.flares[0];
    ok("peak glint matches constructed value", near(f.peakGlintDeg, S.glint, 0.3), `${f.peakGlintDeg?.toFixed?.(3)} vs ${S.glint.toFixed(3)}`);
    ok("intensity ~ 1 (glint well inside cone)", near(f.intensity, 1, 1e-6), String(f.intensity));
    ok("azimuth ~ east", near(f.azDeg, 90, 1), f.azDeg?.toFixed?.(2));
    ok("compass = E", f.compass === "E", f.compass);
    ok("elevation matches scenario", near(f.elDeg, refAzEl.elDeg, 0.5), f.elDeg?.toFixed?.(2));
    ok("sat altitude ~ 550 km", near(f.satAltKm, 550, 5), f.satAltKm?.toFixed?.(1));
    ok("peak time within window", f.peakMs >= startMs && f.peakMs <= startMs + windowSec * 1000);
    ok("start<=peak<=end", f.startMs <= f.peakMs && f.peakMs <= f.endMs);
    ok("event has satName & noradId", typeof f.satName === "string" && Number.isFinite(f.noradId));
    ok("event carries observer position (≈0,0)", near(f.obsLat, 0, 1e-6) && near(f.obsLon, 0, 1e-6),
        `${f.obsLat},${f.obsLon}`);
    ok("event carries apparent-motion deltas (finite)", Number.isFinite(f.dAzDeg) && Number.isFinite(f.dElDeg),
        `dAz=${f.dAzDeg},dEl=${f.dElDeg}`);
}

console.log("== engine: minElevation gate ==");
const resHighMin = engine.scan({
    sats,
    observerAt: () => ({ lat: 0, lon: 0, altKm: 0 }),
    startMs, endMs: startMs + windowSec * 1000,
    options: { fineStepSec: 1, filterStepSec: 30, minElevationDeg: 30, maxSunElevationDeg: 90, minSunElevationDeg: -90 }, // el < 30 -> gated out
    onProgress: () => {},
});
ok("minElevation 30° suppresses the ~10° flare", resHighMin.flares.length === 0, `n=${resHighMin.flares.length}`);

console.log("== engine: geodetic nadir model also detects ==");
const resGeo = engine.scan({
    sats,
    observerAt: () => ({ lat: 0, lon: 0, altKm: 0 }),
    startMs, endMs: startMs + windowSec * 1000,
    options: { fineStepSec: 1, filterStepSec: 30, flareModel: "geodetic", maxSunElevationDeg: 90, minSunElevationDeg: -90 },
    onProgress: () => {},
});
ok("geodetic model finds a flare (equatorial ~ same geometry)", resGeo.flares.length >= 1, `n=${resGeo.flares.length}`);

console.log("== engine: twilight-band clip (real Sun) ==");
// With the DEFAULT band, PASS A only scans when the real Sun is in [-40°, +6°] at the
// observer. At the synthetic test's timestamp the real Sun at (0,0) is out of band,
// so the (synthetic) flare must be suppressed and productiveSteps must be 0.
const realSunEl = astro.sunElevationDeg(0, 0, new Date(startMs));
const resBand = engine.scan({
    sats,
    observerAt: () => ({ lat: 0, lon: 0, altKm: 0 }),
    startMs, endMs: startMs + windowSec * 1000,
    options: { fineStepSec: 1, filterStepSec: 30 }, // default band
    onProgress: () => {},
});
const outOfBand = realSunEl > 6 || realSunEl < -40;
ok("test timestamp's real Sun is out of band", outOfBand, `sunEl=${realSunEl.toFixed(1)}°`);
ok("default band reports 0 productive steps when out of band", resBand.stats.productiveSteps === 0,
    `productiveSteps=${resBand.stats.productiveSteps}`);
ok("default band suppresses the out-of-band flare", resBand.flares.length === 0, `n=${resBand.flares.length}`);

console.log("== engine: scanForward finds the NEXT flaring session ==");
// Start in full daylight at (0,0). The mock satellite flares whenever a band is
// scanned, so scanForward must skip ahead to the next real twilight band and find it.
const noonMs = Date.UTC(2026, 4, 28, 12, 0, 0);
ok("start time is daytime (out of band)", astro.sunElevationDeg(0, 0, new Date(noonMs)) > 6,
    `sunEl=${astro.sunElevationDeg(0, 0, new Date(noonMs)).toFixed(1)}°`);
const fwd = engine.scanForward({
    sats,
    observerAt: () => ({ lat: 0, lon: 0, altKm: 0 }),
    startMs: noonMs,
    maxLookAheadSec: 2 * 86400,
    options: { fineStepSec: 5, filterStepSec: 60 },
    onProgress: () => {},
});
ok("scanForward found a session", fwd.foundSession === true && fwd.flares.length >= 1, `n=${fwd.flares.length}`);
ok("session is after the start time", fwd.stats.sessionStartMs >= noonMs);
ok("first flare is on/after the start time", fwd.flares[0] && fwd.flares[0].peakMs >= noonMs);
ok("session starts within the next ~16 h (next dusk)", (fwd.stats.sessionStartMs - noonMs) < 16 * 3600 * 1000,
    `+${((fwd.stats.sessionStartMs - noonMs) / 3600000).toFixed(1)} h`);
{
    const elAtSession = astro.sunElevationDeg(0, 0, new Date(fwd.stats.sessionStartMs));
    ok("session start is at/near the twilight band", elAtSession <= 6 + 3 && elAtSession >= -40 - 3,
        `sunEl=${elAtSession.toFixed(1)}°`);
}

console.log("== engine: scanForward reports 'exhausted' when none reachable ==");
const deepNight = Date.UTC(2026, 4, 28, 0, 0, 0); // sun ~-68° at (0,0)
const fwdNone = engine.scanForward({
    sats,
    observerAt: () => ({ lat: 0, lon: 0, altKm: 0 }),
    startMs: deepNight,
    maxLookAheadSec: 600, // only 10 min — cannot reach the next twilight
    options: { fineStepSec: 5, filterStepSec: 60 },
    onProgress: () => {},
});
ok("no session within tiny look-ahead", fwdNone.foundSession === false && fwdNone.flares.length === 0);
ok("stats.exhausted is true", fwdNone.stats.exhausted === true);

console.log("== engine: SMOKE test with REAL satellite.js + valid TLEs ==");
const realSat = await import("satellite.js");
const satLib = realSat.default ?? realSat;
const TLE = `ISS (ZARYA)
1 25544U 98067A   26100.50000000  .00016717  00000-0  10270-3 0  9001
2 25544  51.6400 208.9163 0006317  69.9862 290.1956 15.49814556    10
STARLINK-TESTA
1 44713U 19074A   26100.50000000  .00001000  00000-0  10000-3 0  9990
2 44713  53.0540 100.0000 0001400  90.0000 270.0000 15.06000000    13
STARLINK-TESTB
1 44714U 19074B   26100.50000000  .00001000  00000-0  10000-3 0  9991
2 44714  53.0540 120.0000 0001400  90.0000 270.0000 15.06000000    19`;
const e2eEngine = createFlareEngine(satLib);
const e2eSats = e2eEngine.parseTLE(TLE);
ok("parseTLE parsed >=1 real TLE", e2eSats.length >= 1, `len=${e2eSats.length}`);
ok("noradIds parsed", e2eSats.every((s) => Number.isFinite(s.noradId)), e2eSats.map((s) => s.noradId).join(","));
let e2e;
let threw = false;
try {
    const t0 = Date.UTC(2026, 3, 10, 18, 0, 0); // near the TLE epoch (day 100 of 2026)
    e2e = e2eEngine.scan({
        sats: e2eSats,
        observerAt: () => ({ lat: 40, lon: 0, altKm: 0 }),
        startMs: t0,
        endMs: t0 + 3600 * 1000,
        options: {},
        onProgress: () => {},
    });
} catch (e) {
    threw = true;
    console.log("    scan threw:", e && e.message);
}
ok("real-data scan completes without throwing", !threw);
ok("returns well-formed stats", !!e2e && Array.isArray(e2e.flares) && Number.isFinite(e2e.stats?.satsTotal),
    e2e ? `flares=${e2e.flares.length} satsTotal=${e2e.stats.satsTotal}` : "");

console.log("\nFLARE_DEFAULTS:", JSON.stringify(FLARE_DEFAULTS));
console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
