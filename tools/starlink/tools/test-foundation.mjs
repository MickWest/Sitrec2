// Execute-test for geo.js and astro.js against known geodetic/astronomical facts.
import * as geo from "../geo.js";
import * as astro from "../astro.js";

let fails = 0;
function ok(name, cond, extra = "") {
    console.log((cond ? "  ok   " : "  FAIL ") + name + (extra ? "  " + extra : ""));
    if (!cond) fails++;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("== geo: LLA<->ECEF round trips ==");
for (const [lat, lon, alt] of [[0, 0, 0], [45, -122, 0.1], [-33.9, 151.2, 0.02], [89.9, 10, 0], [51.47, -0.45, 0.025]]) {
    const e = geo.llaToEcef(lat, lon, alt);
    const r = geo.ecefToLla(e);
    ok(`roundtrip ${lat},${lon},${alt}`,
        near(r.lat, lat, 1e-7) && near(((r.lon - lon + 540) % 360) - 180, 0, 1e-7) && near(r.altKm, alt, 1e-6),
        `-> ${r.lat.toFixed(5)},${r.lon.toFixed(5)},${r.altKm.toFixed(5)}`);
}
const eEq = geo.llaToEcef(0, 0, 0);
ok("equator x = a", near(eEq.x, geo.WGS84.a, 1e-6), eEq.x.toFixed(3));
const ePole = geo.llaToEcef(90, 0, 0);
ok("pole z = b", near(ePole.z, geo.WGS84.b, 1e-6), ePole.z.toFixed(3));

console.log("== geo: local frame ==");
const upEq = geo.localUp(geo.llaToEcef(0, 0, 0));
ok("up at (0,0) = +X", near(upEq.x, 1, 1e-9) && near(upEq.y, 0, 1e-9) && near(upEq.z, 0, 1e-9));
const enu0 = geo.localEnu(geo.llaToEcef(0, 0, 0));
ok("north at (0,0) = +Z", near(enu0.north.z, 1, 1e-9));
ok("east at (0,0) = +Y", near(enu0.east.y, 1, 1e-9));

console.log("== geo: az/el ==");
const obs = geo.llaToEcef(0, 0, 0);
const straightUp = geo.llaToEcef(0, 0, 100);
ok("straight up -> el 90", near(geo.azElFromObserver(obs, straightUp).elDeg, 90, 1e-6));
const toEast = geo.azElFromObserver(obs, geo.llaToEcef(0, 1, 0));
ok("toward +lon -> az ~90", near(toEast.azDeg, 90, 0.5), toEast.azDeg.toFixed(3));
const toNorth = geo.azElFromObserver(obs, geo.llaToEcef(1, 0, 0));
ok("toward +lat -> az ~0", near(toNorth.azDeg, 0, 0.5) || near(toNorth.azDeg, 360, 0.5), toNorth.azDeg.toFixed(3));

console.log("== geo: ray/ellipsoid (horizon & shadow) ==");
const high = geo.llaToEcef(0, 0, 500);                 // 500 km up
ok("ray down to centre hits", geo.rayHitsEllipsoid(high, geo.vscale(high, -1)));
ok("ray straight up misses", !geo.rayHitsEllipsoid(high, high));
// A satellite directly overhead is above the horizon (observer->sat must NOT hit Earth)
const satOverhead = geo.llaToEcef(0, 0, 550);
ok("overhead sat above horizon", !geo.rayHitsEllipsoid(obs, geo.vsub(satOverhead, obs)));
// A satellite on the far side of the Earth is below the horizon (ray hits Earth)
const satFar = geo.llaToEcef(0, 180, 550);
ok("antipodal sat below horizon", geo.rayHitsEllipsoid(obs, geo.vsub(satFar, obs)));

console.log("== geo: great circle ==");
const mid = geo.greatCircleInterpolate(0, 0, 0, 90, 0.5);
ok("GC midpoint equator 0->90E is (0,45)", near(mid.lat, 0, 1e-6) && near(mid.lon, 45, 1e-6), `${mid.lat.toFixed(3)},${mid.lon.toFixed(3)}`);
const dist = geo.greatCircleDistanceKm(51.47, -0.45, 40.64, -73.78); // LHR->JFK ~5550km
ok("LHR->JFK ~5540-5570 km", dist > 5500 && dist < 5600, dist.toFixed(0));
ok("compass 90->E", geo.compass16(90) === "E");
ok("compass 200->SSW", geo.compass16(202) === "SSW", geo.compass16(202));

console.log("== astro: solar declination (solstices/equinoxes) ==");
function dec(dateStr) {
    const d = astro.sunEciDirection(new Date(dateStr));
    return Math.asin(d.z) * 180 / Math.PI;
}
ok("Jun solstice dec ~+23.44", near(dec("2026-06-21T12:00:00Z"), 23.44, 0.2), dec("2026-06-21T12:00:00Z").toFixed(3));
ok("Dec solstice dec ~-23.44", near(dec("2025-12-21T12:00:00Z"), -23.44, 0.2), dec("2025-12-21T12:00:00Z").toFixed(3));
ok("Mar equinox dec ~0", near(dec("2026-03-20T12:00:00Z"), 0, 0.4), dec("2026-03-20T12:00:00Z").toFixed(3));

console.log("== astro: sub-solar & elevation ==");
const sp = astro.subsolarPoint(new Date("2026-06-21T12:00:00Z"));
ok("Jun subsolar lat ~+23.44", near(sp.lat, 23.44, 0.2), sp.lat.toFixed(3));
ok("Jun subsolar lon within [-180,180]", sp.lon >= -180 && sp.lon <= 180, sp.lon.toFixed(2));
// Sun elevation at the sub-solar point must be ~90°.
ok("elevation at subsolar ~90", near(astro.sunElevationDeg(sp.lat, sp.lon, new Date("2026-06-21T12:00:00Z")), 90, 0.5));
// London just before midnight in June: deep daylight gone, sun well below horizon.
const londonMidnight = astro.sunElevationDeg(51.5, -0.12, new Date("2026-06-21T00:00:00Z"));
ok("London June midnight sun below horizon", londonMidnight < 0, londonMidnight.toFixed(2));
// London local noon June: sun high.
const londonNoon = astro.sunElevationDeg(51.5, -0.12, new Date("2026-06-21T12:00:00Z"));
ok("London June noon sun high (>55°)", londonNoon > 55, londonNoon.toFixed(2));

console.log("== astro: equatorialToAltAz (validated against the Sun) ==");
// Feed the Sun's own RA/Dec into the star transform; its altitude must match the
// independent sunElevationDeg, and azimuth must be sane, at several places/times.
for (const [lat, lon, iso] of [
    [40, -105, "2026-05-29T02:00:00Z"], [51.5, -0.12, "2026-06-21T18:00:00Z"], [-33.9, 151.2, "2026-01-15T06:00:00Z"],
]) {
    const date = new Date(iso);
    const s = astro.sunEciDirection(date);
    const raDeg = Math.atan2(s.y, s.x) * 180 / Math.PI;
    const decDeg = Math.asin(s.z) * 180 / Math.PI;
    const aa = astro.equatorialToAltAz(raDeg, decDeg, lat, lon, date);
    const ref = astro.sunElevationDeg(lat, lon, date);
    ok(`Sun alt matches sunElevationDeg @ ${lat},${lon}`, near(aa.altDeg, ref, 0.2),
        `altAz=${aa.altDeg.toFixed(2)} vs ${ref.toFixed(2)}, az=${aa.azDeg.toFixed(1)}`);
    ok(`azimuth in [0,360) @ ${lat},${lon}`, aa.azDeg >= 0 && aa.azDeg < 360);
}
// Polaris is always within ~1° of due north and near alt≈latitude in the N hemisphere.
const pol = astro.equatorialToAltAz(37.954, 89.264, 40, -105, new Date("2026-05-29T08:00:00Z"));
ok("Polaris is near due north", pol.azDeg < 2 || pol.azDeg > 358, `az=${pol.azDeg.toFixed(2)}`);
ok("Polaris altitude ≈ observer latitude", near(pol.altDeg, 40, 1.5), `alt=${pol.altDeg.toFixed(2)}`);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
