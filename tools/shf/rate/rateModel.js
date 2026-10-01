// rateModel.js — the expected Starlink horizon-flare rate: a flux-integral model of what the
// flare engine (../flareEngine.js) counts, with no fitted constant.
//
//   expectedNight({ lat, date, kind, shells }) -> { total, hour, bins, byShell }
//
// Idea. At each instant there is a region of a satellite shell where a satellite flares for
// the observer: the reflected ray is within the glint limit G of the observer's eye, the
// satellite is sunlit, and it is above the horizon. The expected number of flares is the
// number of satellites that ENTER that region: the integral, along the region's boundary, of
// (satellite density) x (inward component of the satellite velocity relative to the moving
// boundary). Each entry is one flare (one contiguous run of flaring samples in the engine),
// less the chance that the engine's 2-second sampling misses a short run. The night total is
// this rate added up over time. ../rate/formula.html explains it; the derivation and the
// measured effect of every approximation are in the project notes.
//
// The constellation comes from ../starlinkShells.js (the measured shell table) merged within
// MERGE_BAND_KM altitude bands per inclination group (SHELLS below), and every shell is
// placed in its MEASURED orbital planes, dated to the night (shellsForNight): a plane of a
// 43°, 53° or 70° shell is moved from the table's reference epoch to the night's noon at
// the shell's J2 nodal rate (the generator's own rate function, ../dummyTLE.js, so the two
// cannot disagree); a Sun-synchronous plane keeps its measured local MEAN solar time. Both
// are fed to the flux integral as a list of plane local times anchored to the mean Sun at
// the night's noon (an engine check proved the convention; see equationOfTimeHours). The
// dated planes matter most for the few-plane 70° shells: against the generator's simulated
// year the uniform-RAAN average was wrong by 3.6% on a median night (worst 87%), the dated
// planes at the scan's own longitude by 1.0% (worst 12%). The night at a longitude L starts
// L / 360 day before 12:00 UT, and in that time the planes drift against the Sun by a good
// part of their spacing, so a night's count depends on the longitude (the simulation's
// three longitudes differ by 5.6% of the count on a median night, by up to 47%). The pages
// have no longitude, so each plane is spread over its day of drift and the count is the
// mean over longitude: 1.7% from the simulation's three-longitude mean on a median night
// (worst 17%), where that mean itself is 1.7% uncertain. The cost is that a night's
// constellation is tied to the table's epoch: the pages cover the year span SPAN, and the
// year table is rebuilt when the shell table is refreshed.
//
// Speed: the glint lobe (the part of the region set by the glint cone alone) depends only on
// the Sun's geocentric depression D and the ratio q = shell radius / observer radius, so it
// is tabulated once per (altitude, kind) in a scale-free model; at run time the lobe is read
// from the table, placed on the real shell, and clipped by the real horizon (geodetic, WGS84
// observer) and the real shadow (WGS84 ellipsoid). About 40 ms per night for the whole
// constellation on a desktop (every shell steps at 100 s and averages its plane density
// along each edge; 20 ms with uniform planes); the rate page's year curve is therefore
// precomputed (tools/build-rate-table.mjs) and only the chosen night is computed live.
//
// Pure ES module: no DOM. Imports ../astro.js, ../geo.js, ../starlinkShells.js and
// ../dummyTLE.js with the same cache-busting query this file was loaded with (see ../app.js).

const VERSION = new URL(import.meta.url).search;
const [astro, geo, { STARLINK_SHELLS }, { nodalRate }] = await Promise.all([
    import("../astro.js" + VERSION),
    import("../geo.js" + VERSION),
    import("../starlinkShells.js" + VERSION),
    import("../dummyTLE.js" + VERSION),
]);
export { STARLINK_SHELLS, nodalRate };     // nodalRate(altKm, incDeg): the J2 rate, deg/day, as the generator

const DEG = Math.PI / 180;
const MU = 398600.4418;            // km^3/s^2, as the shell generator uses
const OMEGA_E = 7.292115e-5;       // Earth rotation, rad/s (ECEF velocity of the satellites)
// SGP4 (WGS72) constants, as satellite.js uses them: they set the real radius and speed.
const J2 = 1.082616e-3, J3 = -2.53881e-6, RE_SGP4 = 6378.135, KE = 0.0743669161;
const WA = geo.WGS84.a, WB = geo.WGS84.b;
const DAY_MS = 86400000, HOUR_MS = 3600000;

// The span of the pages and the year table: two calendar years, from 1 January of the year
// of the shell table's reference epoch to 31 December of the next year (a table measured on
// 30 September 2026 gives 1 January 2026 to 31 December 2027, 730 nights; the count comes
// from the dates, so a leap year is counted). The planes are dated, so a night's count
// belongs to its date; the span is derived from the table, and the year table
// (tools/build-rate-table.mjs) records it. Night n of the span starts at local noon on
// dateOfDay(n). The pages show one calendar year of the span at a time (spanYears).
export function spanOf(refEpoch) {
    const year = new Date(refEpoch).getUTCFullYear();
    const startMs = Date.UTC(year, 0, 1), endMs = Date.UTC(year + 1, 11, 31);
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    return { startMs, days: Math.round((endMs - startMs) / DAY_MS) + 1, start: iso(startMs), end: iso(endMs), years: [year, year + 1] };
}
export const SPAN = spanOf(STARLINK_SHELLS.refEpoch);
export const DAYS = SPAN.days;
export const dateOfDay = (n) => new Date(SPAN.startMs + n * DAY_MS).toISOString().slice(0, 10);
// The night index of a date ("YYYY-MM-DD"); outside the span it is < 0 or >= DAYS.
export const dayOfDate = (date) => Math.round((Date.parse(date + "T00:00:00Z") - SPAN.startMs) / DAY_MS);
// The months of the span: the night index of the 1st of each month, with its month (0-11)
// and year. For the pages' axes.
export function spanMonths() {
    const out = [];
    for (let n = 0; n < DAYS; n++) {
        const d = new Date(SPAN.startMs + n * DAY_MS);
        if (d.getUTCDate() === 1) out.push({ day: n, month: d.getUTCMonth(), year: d.getUTCFullYear() });
    }
    return out;
}
// The calendar years of the span: each with the night index of its 1 January and its number
// of nights. The pages show one of them at a time.
export function spanYears() {
    return SPAN.years.map((year) => {
        const day = dayOfDate(`${year}-01-01`);
        return { year, day, days: dayOfDate(`${year}-12-31`) - day + 1 };
    });
}

// The night is binned at 5-minute steps from local solar noon to the next noon (288 bins):
// the rate page's night chart plots the rate at this step. The hour bins are their sums.
export const BIN_MIN = 5, NBINS = (24 * 60) / BIN_MIN, BIN_MS = BIN_MIN * 60000;

// Glint limit of each kind: "all" = every flare (glint < 5 deg); "visible" = the peak
// sample's glint < 5 - 1.25*sqrt(0.2) (flareRamp >= 0.2; the penumbra fade is always 1 for a
// sunlit satellite, because the WGS84 ellipsoid used for the sunlit test contains the polar
// sphere used for the fade). See ../flarePhysics.js.
export const GLINT_LIMIT = { all: 5, visible: 5 - 1.25 * Math.sqrt(0.2) };
export const KINDS = ["visible", "all"];

export const DEFAULT_OPTS = {
    stepSec: 300,         // time step of the night integration (divides 3600 and BIN_MIN*60)
    ssoStepDiv: 3,        // a Sun-synchronous shell steps stepSec / ssoStepDiv (100 s)
    edgeRefine: 5,        // sub-steps for a step where the rate changes abruptly (onset, turning latitude)
    slices: 12,           // table slices across the lobe (polygon has 2 x slices glint vertices)
    tableDDeg: 0.2,       // table step in the Sun's depression
    velDtSec: 10,         // finite-difference interval for the boundary velocity
    sampleSec: 2,         // engine fine step: a run shorter than this can be missed
    detection: true,      // apply the sampling-detection factor min(1, T / sampleSec)
    keplerDensity: true,  // density factor (r/a)^2 along the orbit (effective eccentricity)
    boundaryVelocity: true, // include the motion of the region's boundary
    clipSegKm: 80,        // max length of a horizon/shadow edge segment
    ltanJitterDeg: 0.25,  // plane width (±deg) about each plane's local time; the generator jitters ±0.15° (difference < 0.1%)
};

// A faster, slightly coarser night for the rate page while a slider moves: the
// Sun-synchronous shells step 300 s instead of 100 s, 8 lobe slices instead of 12, 2 edge
// sub-steps instead of 5. Measured against DEFAULT_OPTS on 40 nights (8 latitudes x 5 dates,
// nights with more than 20 flares): about 3x faster (12 ms against 38 ms a night on a
// desktop), the night total within 1.3% (median 0.4%), the 5-minute profile within 2.8%
// (median 1.4%). The page replaces it with a DEFAULT_OPTS night when the slider rests.
export const PREVIEW_OPTS = { ssoStepDiv: 1, slices: 8, edgeRefine: 2 };

// ---------------------------------------------------------------------------
// The constellation for the model: the measured shells merged within altitude bands, in
// their measured planes dated to the night.
// ---------------------------------------------------------------------------
// Shells of one inclination group and kind (Sun-synchronous or not) whose altitudes round
// to the same MERGE_BAND_KM band are one model shell at their count-weighted altitude; its
// plane list is the members' lists joined (each member's planes dated at the member's own
// altitude). The window of Sun depths that lets a shell flare depends on its altitude
// (about 0.1° per 5 km), so the band is kept small. Measured with dated planes on the
// shipped table (44 -> 36 shells) at every half degree of latitude from -70 to 72 on 12
// nights through the span (285 x 12 cells per kind): the merge changes a night's count by
// at most 1.7% (visible; 40.5°N 14 May 2027, 100.5 -> 102.2) or 2.8% (all; 41°N 14 May
// 2027, 108.0 -> 111.0) in any cell with 20 or more flares, and the total over the grid by
// 0.01%, for 17% less time per night.
export const MERGE_BAND_KM = 15;
// The inclination groups of the constellation (the formula page splits the count by them).
export const GROUP_INCS = [43, 53, 70, 97];
export const groupOf = (inc) => {
    const g = GROUP_INCS.find((v) => Math.abs(v - inc) < 3);
    return g == null ? "other" : String(g);
};

export function mergeShells(table, bandKm = MERGE_BAND_KM) {
    const map = new Map();
    for (const s of table.shells) {
        const key = `${Math.round(s.inc)}|${s.sso ? "S" : "U"}|${Math.round(s.alt / bandKm)}`;
        let m = map.get(key);
        if (!m) map.set(key, m = { inc: 0, alt: 0, count: 0, sso: !!s.sso, ltan: s.sso ? [] : undefined, members: [] });
        m.inc = (m.inc * m.count + s.inc * s.count) / (m.count + s.count);
        m.alt = (m.alt * m.count + s.alt * s.count) / (m.count + s.count);
        m.count += s.count;
        if (s.sso) m.ltan.push(...s.ltan);
        // the member's measured planes (RAAN at the table's reference epoch), for dating
        m.members.push({ inc: s.inc, alt: s.alt, count: s.count, raan: s.sso ? undefined : s.raan });
    }
    return [...map.values()]
        .map((m) => ({ inc: +m.inc.toFixed(3), alt: +m.alt.toFixed(1), count: m.count, sso: m.sso,
            ltan: m.ltan, group: groupOf(m.inc), members: m.members,
            planes: m.sso ? m.ltan.length : m.members.reduce((n, x) => n + (x.raan ? x.raan.length : 0), 0) }))
        .sort((p, q) => q.count - p.count);
}
export const SHELLS = mergeShells(STARLINK_SHELLS);
export const TOTAL_SATELLITES = STARLINK_SHELLS.total;
const REF_EPOCH_MS = Date.parse(STARLINK_SHELLS.refEpoch);

// The model shells for the night of `date` ("YYYY-MM-DD"), in the order of SHELLS. A
// Sun-synchronous shell keeps its plane local times. Every other shell's planes are moved
// from the table's reference epoch to the night's noon at the J2 nodal rate of the member
// they belong to, and written as local mean solar times of the ascending node, as the
// Sun-synchronous ones are: a plane at right ascension RAAN has local time
// 12 h + (RAAN - GMST at 12:00 UT) / 15, because the mean Sun's right ascension then is GMST
// (see equationOfTimeHours). The flux integral then removes each plane's drift during the
// night itself (stepFlux).
//
// The night's noon depends on the observer's longitude L: it is 12:00 UT - L / 15 h, and in
// that time the planes drift against the mean Sun by (rate - SUN_RATE) x L / 360. The drift
// is 5.7° a day for the 53° shells, whose planes are 2.3° apart, so the pattern of the
// planes a night meets, and its count, change with the longitude (measured in section 7 of
// ../rate/formula.html: three longitudes 120° apart differ by 6% of the night's count on a
// typical night, by up to 47%). The pages have no longitude, so by default (lon null) each
// plane is spread over its day of drift, from L = 180° (half a day before 12:00 UT) to
// L = -180°, in sub-planes SPREAD_STEP_DEG apart: the count is then the mean over the
// observer's longitude. With `lon` the planes are placed for that longitude's night (for
// the checks against the simulation, which scans at given longitudes).
// planes: "dated" (the default) or "uniform" (the seasonal average: every non-Sun-synchronous
// shell spread evenly in right ascension; for comparison and tests). shells: a merged list
// (mergeShells) other than SHELLS, for measurements.
export const SUN_RATE = 360 / 365.2422;     // the mean Sun's right ascension, deg/day
export const SPREAD_STEP_DEG = 0.25;        // sub-plane spacing of the longitude spread (half the plane jitter width)
export function shellsForNight(date, { planes = "dated", shells = SHELLS, lon = null } = {}) {
    if (planes === "uniform") return shells;
    const [Y, M, Dd] = date.split("-").map(Number);
    const t0 = Date.UTC(Y, M - 1, Dd, 12);
    const days = (t0 - REF_EPOCH_MS) / DAY_MS;
    const gmstDeg = astro.gmstRad(new Date(t0)) / DEG;
    return shells.map((s) => {
        if (s.sso) return s;
        const ltan = [];
        for (const m of s.members) {
            if (!m.raan) continue;             // a member without a plane list stays uniform (none in the shipped table)
            const rate = nodalRate(m.alt, m.inc), drift = rate - SUN_RATE;
            const parts = lon == null ? Math.max(1, Math.ceil(Math.abs(drift) / SPREAD_STEP_DEG)) : 1;
            for (const [raan, count] of m.raan) {
                const h0 = 12 + (raan + rate * days - gmstDeg) / 15;
                for (let k = 0; k < parts; k++) {
                    // the night's offset from 12:00 UT, in days: -L / 360
                    const f = lon == null ? (k + 0.5) / parts - 0.5 : -lon / 360;
                    const h = h0 + drift * f / 15;
                    ltan.push([((h % 24) + 24) % 24, count / parts]);
                }
            }
        }
        return ltan.length ? { ...s, ltan } : s;
    });
}

// ---------------------------------------------------------------------------
// Shell constants: what SGP4 makes of a TLE with mean motion from a = 6371 + alt,
// e = 1e-4, argp = 0. Radius r(u) = r0 + r1 cos u + r2 cos 2u + s1 sin u (u = argument of
// latitude), speed v(u) = v0 + v2 cos 2u - v0 (s1 sin u + r1 cos u) / r0, apex inclination
// iE (sets the turning latitude), nodal drift. Checked against satellite.js to 3 m and
// 2 m/s. They matter: 6 km of radius moves the window's edge by 0.13° of Sun depression.
// ---------------------------------------------------------------------------
const shellCache = new Map();
function shellConstants(inc, alt) {
    const key = inc + "|" + alt;
    let c = shellCache.get(key);
    if (c) return c;
    const incR = inc * DEG, cosi = Math.cos(incR), sini = Math.sin(incR);
    const e = 1e-4;
    const nK = Math.sqrt(MU / (6371 + alt) ** 3) * 60;           // Kozai mean motion, rad/min
    const k2 = 0.5 * J2, con41 = 3 * cosi * cosi - 1, b32 = (1 - e * e) ** 1.5;
    const a1 = (KE / nK) ** (2 / 3);
    const d1 = 1.5 * k2 / (a1 * a1) * con41 / b32;
    const a0 = a1 * (1 - d1 / 3 - d1 * d1 - 134 / 81 * d1 * d1 * d1);
    const d0 = 1.5 * k2 / (a0 * a0) * con41 / b32;
    const a0pp = a0 / (1 - d0), n0pp = nK / (1 + d0);              // Brouwer a (ER), n (rad/min)
    const aycof = -0.5 * (J3 / J2) * sini;
    const axn = e, ayn = aycof / (a0pp * (1 - e * e));             // argp = 0
    const el2 = axn * axn + ayn * ayn, pl = a0pp * (1 - el2), betal = Math.sqrt(1 - el2);
    const temp1 = 0.5 * J2 / pl, temp2 = temp1 / pl;
    const r0 = a0pp * (1 - 1.5 * temp2 * betal * con41) * RE_SGP4;
    const r2 = 0.5 * temp1 * (1 - cosi * cosi) * RE_SGP4;
    const r1 = -a0pp * axn * RE_SGP4, s1 = -a0pp * ayn * RE_SGP4;
    const v0 = RE_SGP4 / 60 * (KE / Math.sqrt(a0pp) + 0.75 * n0pp * J2 * con41 / pl);
    const v2 = RE_SGP4 / 60 * n0pp * temp1 * (1 - cosi * cosi);
    const iE = incR - 1.5 * temp2 * cosi * sini;                   // osculating inc at the apex
    const raanDot = -1.5 * n0pp * J2 * cosi / (pl * pl) / 60;      // rad/s
    c = { inc, alt, r0, r1, r2, s1, v0, v2, iE, sinIE: Math.sin(iE), cosIE: Math.cos(iE), raanDot,
          rMin: r0 - Math.abs(r1) - r2 - Math.abs(s1), rMax: r0 + Math.abs(r1) + r2 + Math.abs(s1) };
    shellCache.set(key, c);
    return c;
}

// Radius of the shell surface at geocentric latitude phi for family f (+1 ascending,
// -1 descending, 0 = family average). sin u = sin phi / sin iE.
function shellRadius(c, sinPhi, f, familyRadius = true) {
    let su = sinPhi / c.sinIE; if (su > 1) su = 1; else if (su < -1) su = -1;
    const cu = familyRadius && f ? f * Math.sqrt(1 - su * su) : 0;
    return c.r0 + c.r1 * cu + c.r2 * (1 - 2 * su * su) + c.s1 * su;
}

// ---------------------------------------------------------------------------
// Sun-synchronous RAAN density: p(dOmega), dOmega = RAAN - RA(Sun at the night's noon),
// degrees, from the plane list [[ltanHours, satellites], ...], each plane spread uniformly
// over +-0.25 deg (the generator jitters +-0.15 deg; the difference changes the counts by
// less than 0.1%). A lookup on a 0.05 deg grid, normalized so that the mean over
// 360 deg is 1 (so it multiplies the uniform-RAAN density).
// ---------------------------------------------------------------------------
const BINW = 0.05, NBINS_RAAN = Math.round(360 / BINW);
const ltanCache = new WeakMap();
function raanDensity(planes, jitterDeg = 0.25) {
    let t = ltanCache.get(planes);
    if (t && t.jitterDeg === jitterDeg) return t;
    const h = new Float64Array(NBINS_RAAN), half = Math.max(jitterDeg, BINW / 2), nb = Math.ceil(2 * half / BINW) + 1;
    let total = 0;
    for (const [lt, count] of planes) {
        const dOmega = 15 * (lt - 12);
        const lo = dOmega - half, k0 = Math.floor(lo / BINW);
        total += count;
        for (let k = 0; k < nb; k++) {
            const bLo = (k0 + k) * BINW, bHi = bLo + BINW;
            const ov = Math.min(bHi, dOmega + half) - Math.max(bLo, lo);
            if (ov > 0) h[(((k0 + k) % NBINS_RAAN) + NBINS_RAAN) % NBINS_RAAN] += count * ov / (2 * half);
        }
    }
    const mean = total / NBINS_RAAN;
    t = new Float64Array(NBINS_RAAN);
    for (let k = 0; k < NBINS_RAAN; k++) t[k] = h[k] / mean;
    t.jitterDeg = jitterDeg;
    ltanCache.set(planes, t);
    return t;
}
function raanDensityAt(table, dOmegaDeg) {
    let x = dOmegaDeg / BINW; x = ((x % NBINS_RAAN) + NBINS_RAAN) % NBINS_RAAN;
    const k = Math.floor(x), f = x - k, k1 = (k + 1) % NBINS_RAAN;
    return f < 0.5 ? table[(k + NBINS_RAAN - 1) % NBINS_RAAN] * (0.5 - f) + table[k] * (0.5 + f)
                   : table[k] * (1.5 - f) + table[k1] * (f - 0.5);
}

// The equation of time (hours): apparent minus mean solar time, from the same Sun and
// sidereal-time model the rest of the tool uses. The mean Sun's right ascension is
// GMST - 15° x (UT - 12 h); the apparent Sun's comes from astro.sunEquatorial.
// A Sun-synchronous plane keeps its local MEAN time (it precesses at the mean Sun's uniform
// rate), so its RAAN is (mean Sun RA) + 15° x (LTAN - 12 h). At the night's noon (12:00 UT
// for the model's observer at longitude 0) the mean Sun's RA is simply GMST, which is what
// the model anchors a mean-time plane list to; an apparent-time list (ltanTime: "apparent",
// as the engine truth sets are made) is anchored to the apparent Sun's RA. The two anchors
// differ by 15° x the equation of time, up to 4°; the sign was checked against engine scans
// of a generator-built Sun-synchronous shell (tools/shf/tools/test-rate.mjs keeps a check).
export function equationOfTimeHours(date) {
    const d = typeof date === "string" ? new Date(date + "T12:00:00Z") : date;
    const ut = (d.getTime() % DAY_MS) / HOUR_MS;
    const raMean = astro.gmstRad(d) / DEG - 15 * (ut - 12);
    let diff = (raMean - astro.sunEquatorial(d).raDeg) % 360;
    if (diff > 180) diff -= 360; else if (diff < -180) diff += 360;
    return diff / 15;
}

// ---------------------------------------------------------------------------
// Geometry helpers (ECEF, km). Vectors are [x, y, z] arrays.
// ---------------------------------------------------------------------------
function sunEcef(tMs) {
    const d = new Date(tMs);
    const s = astro.sunEciDirection(d), g = astro.gmstRad(d);
    const cg = Math.cos(g), sg = Math.sin(g);
    return [s.x * cg + s.y * sg, -s.x * sg + s.y * cg, s.z];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Glint angle (deg) for a satellite at x seen from O with the Sun direction s: the angle
// between s and the view ray reflected about the geocentric up at x.
function glintDeg(x, O, s) {
    const dx = x[0] - O[0], dy = x[1] - O[1], dz = x[2] - O[2];
    const rn = Math.hypot(x[0], x[1], x[2]);
    const nx = x[0] / rn, ny = x[1] / rn, nz = x[2] / rn;
    const k = 2 * (dx * nx + dy * ny + dz * nz);
    const rx = dx - k * nx, ry = dy - k * ny, rz = dz - k * nz;
    const c = (rx * s[0] + ry * s[1] + rz * s[2]) / Math.hypot(rx, ry, rz);
    return Math.acos(c < -1 ? -1 : c > 1 ? 1 : c) / DEG;
}
// Shadow function: >= 0 when the ray from (x,y,z) toward s misses the WGS84 ellipsoid
// (sunlit), for a satellite on the night side. It is the squared distance of the point from
// the Sun line in ellipsoid-scaled coordinates, minus 1. The gradient is written into g[0..2].
function shadowFnXYZ(x, y, z, s) {
    const X = x / WA, Y = y / WA, Z = z / WB;
    const SX = s[0] / WA, SY = s[1] / WA, SZ = s[2] / WB;
    const ss = SX * SX + SY * SY + SZ * SZ, xs = X * SX + Y * SY + Z * SZ;
    return X * X + Y * Y + Z * Z - xs * xs / ss - 1;
}
function shadowGradXYZ(x, y, z, s, g) {
    const X = x / WA, Y = y / WA, Z = z / WB;
    const SX = s[0] / WA, SY = s[1] / WA, SZ = s[2] / WB;
    const ss = SX * SX + SY * SY + SZ * SZ, xs = X * SX + Y * SY + Z * SZ;
    const k = xs / ss;
    g[0] = 2 * (X - k * SX) / WA; g[1] = 2 * (Y - k * SY) / WA; g[2] = 2 * (Z - k * SZ) / WB;
}
// Velocity of the shadow boundary ON THE SHELL at (x,y,z), written into v[0..2]: the level
// set sh = 0 restricted to the shell surface moves along the tangent plane at
// -(d sh/dt) gradT / |gradT|^2, where gradT is the gradient's tangential part (the 3-D
// gradient is mostly radial there). s2 is the Sun direction dtv seconds later.
function shadowLineVelocityXYZ(x, y, z, s, s2, dtv, g, v) {
    const dsh = (shadowFnXYZ(x, y, z, s2) - shadowFnXYZ(x, y, z, s)) / dtv;
    shadowGradXYZ(x, y, z, s, g);
    const rn = Math.sqrt(x * x + y * y + z * z), ux = x / rn, uy = y / rn, uz = z / rn;
    const gu = g[0] * ux + g[1] * uy + g[2] * uz;
    const tx = g[0] - gu * ux, ty = g[1] - gu * uy, tz = g[2] - gu * uz;
    const k = -dsh / (tx * tx + ty * ty + tz * tz);
    v[0] = k * tx; v[1] = k * ty; v[2] = k * tz;
}

// Everything about the observer and the shells that does not change during the night.
// A shell is { inc, alt, count } (uniform RAAN) or with ltan: [[hours, satellites], ...]
// (Sun-synchronous planes; ltanTime "mean" by default, or "apparent").
function nightSetup(lat, shells, G, ltanJitterDeg = 0.25) {
    const Oo = geo.llaToEcef(lat, 0, 0), O = [Oo.x, Oo.y, Oo.z];
    const Ro = Math.hypot(O[0], O[1], O[2]), Ohat = [O[0] / Ro, O[1] / Ro, O[2] / Ro];
    const upG = geo.localUp(Oo), up = [upG.x, upG.y, upG.z];
    const sh = shells.map((s) => {
        const c = shellConstants(s.inc, s.alt);
        const Eo = Math.acos(Ro / c.r0), Emax = Math.acos(WB / c.rMin), Emin = Math.acos(WA / c.rMax);
        const Mm = Math.asin(Math.tan(Emin) / Math.sqrt(3));
        const Dlo = Math.PI - Mm - 2 * Math.asin(Math.cos(Emin) * Math.cos(Mm)) - G * DEG - 1.5 * DEG;
        const Dhi = 2 * Emax + 1 * DEG;
        return { c, count: s.count, Eo, Emax, Emin, Dlo, Dhi,
                 ltan: s.ltan && s.ltan.length ? raanDensity(s.ltan, ltanJitterDeg) : null,
                 ltanMean: s.ltanTime !== "apparent" };
    });
    return { O, Ro, Ohat, up, sh };
}
// The Sun frame at a time: direction, geocentric depression, azimuth basis at the observer.
function sunFrame(tMs, setup, into) {
    const s = sunEcef(tMs);
    const sinD = -dot(s, setup.Ohat);
    if (sinD <= 0) return null;
    const D = Math.asin(sinD);
    const Oh = setup.Ohat;
    let ax = s[0] + sinD * Oh[0], ay = s[1] + sinD * Oh[1], az = s[2] + sinD * Oh[2];
    const al = Math.sqrt(ax * ax + ay * ay + az * az); ax /= al; ay /= al; az /= al;
    if (into) {
        if (!into.s) { into.s = new Float64Array(3); into.ahat = new Float64Array(3); into.t2 = new Float64Array(3); }
        into.s[0] = s[0]; into.s[1] = s[1]; into.s[2] = s[2]; into.D = D;
        into.ahat[0] = ax; into.ahat[1] = ay; into.ahat[2] = az;
        into.t2[0] = Oh[1] * az - Oh[2] * ay; into.t2[1] = Oh[2] * ax - Oh[0] * az; into.t2[2] = Oh[0] * ay - Oh[1] * ax;
        return into;
    }
    const ahat = [ax, ay, az];
    return { s, D, ahat, t2: cross(Oh, ahat) };
}

// ---------------------------------------------------------------------------
// The glint-lobe table. Scale-free symmetric model: Earth centre at the origin, observer at
// (0, 0, 1), shell a sphere of radius q, Sun direction (cos D, 0, -sin D). The lobe is the
// part of {glint < G} that can be sunlit and above the horizon: from the deepest possible
// shadow line (gStart) to just past the horizon (gCap), sliced across the Sun's vertical
// plane. For each (D, q) the table stores the lobe's axial ends gA, gB and the lateral
// half-width w at K slice positions xi_k = k/(K-1) between them (NaN when there is no lobe).
// ---------------------------------------------------------------------------
const tableCache = new Map();
// Root of f between lo (f<0) and hi (f>=0) by regula falsi.
function rootBetween(f, lo, hi, vlo, vhi, tol) {
    for (let it = 0; it < 40; it++) {
        const m = lo + (hi - lo) * (-vlo) / (vhi - vlo), vm = f(m);
        if (vm < 0) { lo = m; vlo = vm; } else { hi = m; vhi = vm; }
        if (hi - lo < tol) break;
    }
    return (lo + hi) / 2;
}
// The far (sunward) end of the lobe on the axis: the largest g in [gStart, gCap] where the
// axial glint rises through G. A coarse scan from gCap down finds a large lobe; when it
// finds nothing, the lobe may be a small blob near the window's onset, so the axial minimum
// is located (golden section about the lowest coarse sample) and bracketed from there.
// Returns -1 when there is no lobe.
function lobeFarEnd(gl, gStart, gCap, step, tol) {
    let vCap = gl(gCap, 0);
    if (vCap < 0) return gCap;
    let gPrev = gCap, vPrev = vCap, gMin = gCap, vMin = vCap;
    for (let g = gCap - step; g >= gStart - step; g -= step) {
        const v = gl(g, 0);
        if (v < 0) return rootBetween((m) => gl(m, 0), g, gPrev, v, vPrev, tol * 0.1);
        if (v < vMin) { vMin = v; gMin = g; }
        gPrev = g; vPrev = v;
    }
    // no coarse sample inside: look for a small blob around the lowest sample
    let a = gMin - step, b = gMin + step;
    const phi = 0.6180339887;
    let x1 = b - phi * (b - a), x2 = a + phi * (b - a), f1 = gl(x1, 0), f2 = gl(x2, 0);
    for (let it = 0; it < 30; it++) {
        if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - phi * (b - a); f1 = gl(x1, 0); }
        else { a = x1; x1 = x2; f1 = f2; x2 = a + phi * (b - a); f2 = gl(x2, 0); }
        if (b - a < tol) break;
    }
    const gm = (a + b) / 2, vm = gl(gm, 0);
    if (vm >= 0) return -1;
    // bracket the far crossing between gm and gm + step
    return rootBetween((m) => gl(m, 0), gm, Math.min(gm + step, gCap), vm, gl(Math.min(gm + step, gCap), 0), tol * 0.1);
}
function symGlint(gam, w, q, s) {        // glint at slice (gam, w) in the symmetric model
    const cg = Math.cos(gam), sg = Math.sin(gam), cw = Math.cos(w), sw = Math.sin(w);
    const x = q * cw * sg, y = q * sw, z = q * cw * cg;          // observer at (0, 0, 1)
    const dx = x, dy = y, dz = z - 1;
    const nx = x / q, ny = y / q, nz = z / q;
    const k = 2 * (dx * nx + dy * ny + dz * nz);
    const rx = dx - k * nx, ry = dy - k * ny, rz = dz - k * nz;
    const c = (rx * s[0] + ry * s[1] + rz * s[2]) / Math.sqrt(rx * rx + ry * ry + rz * rz);
    return Math.acos(c < -1 ? -1 : c > 1 ? 1 : c) / DEG;
}
function symLobe(D, q, G, K, out) {
    const s = [Math.cos(D), 0, -Math.sin(D)];
    const gl = (g, w) => symGlint(g, w, q, s) - G;
    const Eo = Math.acos(1 / q);
    const gStart = D - Math.acos(Math.min(1, (WB / WA) * 0.9999 / q)) - 0.3 * DEG;
    const gCap = Eo + 0.5 * DEG;
    const step = 0.5 * DEG, tol = 1e-4 * DEG;
    const gB = lobeFarEnd(gl, gStart, gCap, step, tol);
    if (!(gB > gStart)) return false;
    let gA = gStart;
    {
        let gp = gB, vp = gl(gB, 0);
        for (let g = gB - step; g > gStart; g -= step) {
            const v = gl(g, 0);
            if (v >= 0) {
                let lo = g, hi = gp, vlo = v, vhi = vp;
                for (let it = 0; it < 40; it++) {
                    const m = lo + (hi - lo) * vlo / (vlo - vhi), vm = gl(m, 0);
                    if (vm >= 0) { lo = m; vlo = vm; } else { hi = m; vhi = vm; }
                    if (hi - lo < tol * 0.1) break;
                }
                gA = (lo + hi) / 2; break;
            }
            gp = g; vp = v;
        }
    }
    if (gB - gA < 1e-6) return false;
    let guess = 0.5 * DEG;
    for (let k = 0; k < K; k++) {
        const g = gA + (gB - gA) * k / (K - 1);
        const v0 = gl(g, 0);
        if (v0 >= 0) { out.w[k] = 0; continue; }
        let lo = 0, vlo = v0, hi = Math.max(guess, 0.1 * DEG), vhi = gl(g, hi), guard = 0;
        while (vhi < 0 && guard++ < 12) { lo = hi; vlo = vhi; hi *= 1.6; vhi = gl(g, hi); }
        if (vhi < 0) { out.w[k] = hi; continue; }
        let side = 0;
        for (let it = 0; it < 40; it++) {
            const w = lo + (hi - lo) * (-vlo) / (vhi - vlo), vm = gl(g, w);
            if (vm < 0) { lo = w; vlo = vm; if (side === -1) vhi *= 0.5; side = -1; }
            else { hi = w; vhi = vm; if (side === 1) vlo *= 0.5; side = 1; }
            if (hi - lo < tol) break;
        }
        out.w[k] = (lo + hi) / 2; guess = out.w[k];
    }
    out.gA = gA; out.gB = gB;
    return true;
}
function glintTable(c, G, opt) {
    const key = c.alt + "|" + G + "|" + opt.slices + "|" + opt.tableDDeg;
    let T = tableCache.get(key);
    if (T) return T;
    const K = opt.slices, NQ = 5;
    const qLo = (c.rMin - 2) / WA, qHi = (c.rMax + 2) / WB, dq = (qHi - qLo) / (NQ - 1);
    const Emax = Math.acos(1 / qHi), Emin = Math.acos(1 / qLo);
    const Mm = Math.asin(Math.tan(Emin) / Math.sqrt(3));
    const Dlo = Math.PI - Mm - 2 * Math.asin(Math.cos(Emin) * Math.cos(Mm)) - G * DEG - 1 * DEG;
    const Dhi = 2 * Emax + 0.5 * DEG, dD = opt.tableDDeg * DEG;
    const nD = Math.ceil((Dhi - Dlo) / dD) + 1;
    const gA = new Float64Array(nD * NQ).fill(NaN), gB = new Float64Array(nD * NQ).fill(NaN);
    const w = new Float64Array(nD * NQ * K);
    const tmp = { gA: 0, gB: 0, w: new Float64Array(K) };
    for (let i = 0; i < nD; i++) for (let j = 0; j < NQ; j++) {
        if (symLobe(Dlo + i * dD, qLo + j * dq, G, K, tmp)) {
            gA[i * NQ + j] = tmp.gA; gB[i * NQ + j] = tmp.gB;
            w.set(tmp.w, (i * NQ + j) * K);
        }
    }
    T = { K, NQ, qLo, dq, Dlo, dD, nD, gA, gB, w, G };
    tableCache.set(key, T);
    return T;
}
// Table lookup: quadratic (3-point Lagrange) in q, linear in D. Near the window's lower
// edge the lobe exists only for some (D, q) entries (the onset depression depends on q):
// a missing neighbour is left out of the q interpolation, and when only one D row has a
// lobe the lobe is scaled by the fraction toward that row (it grows from nothing there).
// Returns false when no lobe exists. The lookup state is kept in `out` for lobeWidth.
// q weights for one table row (3 neighbours), over the valid entries only; returns their count.
function qWeights(gA, a, u, W) {
    const v0 = !Number.isNaN(gA[a]), v1 = !Number.isNaN(gA[a + 1]), v2 = !Number.isNaN(gA[a + 2]);
    if (v0 && v1 && v2) { W[0] = 0.5 * u * (u - 1); W[1] = 1 - u * u; W[2] = 0.5 * u * (u + 1); return 3; }
    if (v1 && v2) { W[0] = 0; W[1] = 1 - u; W[2] = u; return 2; }
    if (v0 && v1) { W[0] = -u; W[1] = 1 + u; W[2] = 0; return 2; }
    if (v1) { W[0] = 0; W[1] = 1; W[2] = 0; return 1; }
    if (v2) { W[0] = 0; W[1] = 0; W[2] = 1; return 1; }
    if (v0) { W[0] = 1; W[1] = 0; W[2] = 0; return 1; }
    return 0;
}
// (a missing entry is NaN and 0 * NaN is NaN: skip zero weights)
function mix3(arr, a, W) { return (W[0] ? W[0] * arr[a] : 0) + (W[1] ? W[1] * arr[a + 1] : 0) + (W[2] ? W[2] * arr[a + 2] : 0); }
function lobeAt(T, D, q, out) {
    const fi = (D - T.Dlo) / T.dD, i0 = Math.floor(fi);
    if (i0 < 0 || i0 + 1 >= T.nD) return false;
    const fD = fi - i0;
    const fj = (q - T.qLo) / T.dq; let j1 = Math.round(fj);
    if (j1 < 1) j1 = 1; else if (j1 > T.NQ - 2) j1 = T.NQ - 2;
    const u = fj - j1;
    const { NQ } = T;
    const a0 = i0 * NQ + j1 - 1, a1 = (i0 + 1) * NQ + j1 - 1;
    const nLo = qWeights(T.gA, a0, u, out.Wlo || (out.Wlo = new Float64Array(3)));
    const nHi = qWeights(T.gA, a1, u, out.Whi || (out.Whi = new Float64Array(3)));
    out.partial = nLo < 3 || nHi < 3;
    if (nLo === 0 && nHi === 0) return false;
    const Wlo = out.Wlo, Whi = out.Whi;
    const gAlo = nLo ? mix3(T.gA, a0, Wlo) : NaN, gBlo = nLo ? mix3(T.gB, a0, Wlo) : NaN;
    const gAhi = nHi ? mix3(T.gA, a1, Whi) : NaN, gBhi = nHi ? mix3(T.gB, a1, Whi) : NaN;
    if (nLo && nHi) { out.gA = gAlo + fD * (gAhi - gAlo); out.gB = gBlo + fD * (gBhi - gBlo); out.scale = 1; out.mode = 0; }
    else if (nHi) { // lobe appears between the rows: use the upper row's shape, scaled down
        out.gA = gAhi; out.gB = gBhi; out.scale = fD; out.mode = 1;
        const m = (gAhi + gBhi) / 2; out.gA = m + (gAhi - m) * fD; out.gB = m + (gBhi - m) * fD;
    } else { out.gA = gAlo; out.gB = gBlo; out.scale = 1 - fD; out.mode = -1;
        const m = (gAlo + gBlo) / 2; out.gA = m + (gAlo - m) * (1 - fD); out.gB = m + (gBlo - m) * (1 - fD); }
    out.fD = fD; out.a0 = a0; out.a1 = a1; out.nLo = nLo; out.nHi = nHi;
    return true;
}
function lobeWidth(T, lk, k) {        // the width at slice k for the lookup state lk
    const { K } = T, w = T.w;
    const b0 = lk.a0 * K + k, b1 = lk.a1 * K + k;
    const W0 = lk.Wlo, W1 = lk.Whi;
    const wlo = lk.nLo ? (W0[0] ? W0[0] * w[b0] : 0) + (W0[1] ? W0[1] * w[b0 + K] : 0) + (W0[2] ? W0[2] * w[b0 + 2 * K] : 0) : 0;
    const whi = lk.nHi ? (W1[0] ? W1[0] * w[b1] : 0) + (W1[1] ? W1[1] * w[b1 + K] : 0) + (W1[2] ? W1[2] * w[b1 + 2 * K] : 0) : 0;
    let v;
    if (lk.mode === 0) v = wlo + lk.fD * (whi - wlo);
    else if (lk.mode === 1) v = whi * lk.scale;
    else v = wlo * lk.scale;
    return v > 0 ? v : 0;
}

// ---------------------------------------------------------------------------
// Polygons on the shell: parallel typed arrays. type = 0 glint edge, 1 horizon, 2 shadow
// (the type of the edge that starts at the vertex). vel = the glint boundary's velocity at
// the vertex (used by glint edges).
// ---------------------------------------------------------------------------
function makePoly(cap) {
    return { n: 0, x: new Float64Array(cap), y: new Float64Array(cap), z: new Float64Array(cap),
             vx: new Float64Array(cap), vy: new Float64Array(cap), vz: new Float64Array(cap), type: new Uint8Array(cap), cap };
}
// Place the lobe from the table on the real shell for the Sun frame fr. Fills P with 2K
// vertices (-w side outward, +w side back). Returns false when there is no lobe.
// reuse: when given (the previous call's slice state), the lobe's (gA, gB, widths) are
// reused and only the frame changes -- for the velocity of a directly built onset lobe.
function placeLobe(T, c, setup, fr, P, lk, tmpQ, reuse) {
    const { Ohat, Ro } = setup, { ahat, t2, D } = fr, K = T.K;
    if (reuse) {
        const wk = lk.wk;
        lobeVertices(P, c, Ohat, ahat, t2, lk.gAd, lk.gBd, wk, K);
        return true;
    }
    // q at a rough centre of the lobe, for the axial ends
    const gc = D - Math.acos(Ro / c.r0) + 1.5 * DEG;
    const zc = Math.cos(gc) * Ohat[2] + Math.sin(gc) * ahat[2];
    const qc = shellRadius(c, zc, 0) / Ro;
    const inTable = (D - T.Dlo) / T.dD >= 0 && (D - T.Dlo) / T.dD + 1 < T.nD;
    if (!inTable) return false;
    const wk = lk.wk || (lk.wk = tmpQ.subarray(K, 2 * K));
    let gA, gB;
    lk.direct = false;
    if (lobeAt(T, D, qc, lk) && !lk.partial) {
        gA = lk.gA; gB = lk.gB;
        // per-slice q: the lobe's lateral width at a slice depends on the local shell radius
        for (let k = 0; k < K; k++) {
            const g = gA + (gB - gA) * k / (K - 1);
            const zk = Math.cos(g) * Ohat[2] + Math.sin(g) * ahat[2];
            wk[k] = lobeAt(T, D, shellRadius(c, zk, 0) / Ro, lk) && !lk.partial ? lobeWidth(T, lk, k) : 0;
        }
    } else {
        // near the window's onset the lobe exists only for some (D, q): a lookup there would
        // mix lobes with no-lobes, so build the small lobe directly for the centre q
        if (!symLobe(D, qc, T.G, K, lk.tmp || (lk.tmp = { gA: 0, gB: 0, w: new Float64Array(K) }))) return false;
        gA = lk.tmp.gA; gB = lk.tmp.gB; wk.set(lk.tmp.w);
        lk.direct = true; lk.gAd = gA; lk.gBd = gB;
    }
    lobeVertices(P, c, Ohat, ahat, t2, gA, gB, wk, K);
    return true;
}
// The 2K polygon vertices of a lobe (gA..gB, half-widths wk) in the frame (Ohat, ahat, t2).
function lobeVertices(P, c, Ohat, ahat, t2, gA, gB, wk, K) {
    let n = 0;
    for (let m = 0; m < 2 * K; m++) {
        const k = m < K ? m : 2 * K - 1 - m, w = m < K ? -wk[k] : wk[k];
        const g = gA + (gB - gA) * k / (K - 1);
        const cg = Math.cos(g), sg = Math.sin(g), cw = Math.cos(w), sw = Math.sin(w);
        const ux = cw * (cg * Ohat[0] + sg * ahat[0]) + sw * t2[0];
        const uy = cw * (cg * Ohat[1] + sg * ahat[1]) + sw * t2[1];
        const uz = cw * (cg * Ohat[2] + sg * ahat[2]) + sw * t2[2];
        const r = shellRadius(c, uz, 0);
        P.x[n] = r * ux; P.y[n] = r * uy; P.z[n] = r * uz; P.type[n] = 0; n++;
    }
    P.n = n;
}
// Sutherland-Hodgman clip of P by fn(x,y,z) >= 0 into Q; new vertices on the clip line get
// `type`. fn is linear (horizon) or quadratic (shadow) along an edge; one secant refinement.
function clipPoly(P, Q, fn, type, vals) {
    const n = P.n;
    let allIn = true, allOut = true;
    for (let i = 0; i < n; i++) { const v = fn(P.x[i], P.y[i], P.z[i]); vals[i] = v; if (v < 0) allIn = false; else allOut = false; }
    if (allOut) { Q.n = 0; return; }
    if (allIn) { copyPoly(P, Q); return; }
    let m = 0;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, va = vals[i], vb = vals[j], ain = va >= 0, bin = vb >= 0;
        if (ain) { Q.x[m] = P.x[i]; Q.y[m] = P.y[i]; Q.z[m] = P.z[i]; Q.vx[m] = P.vx[i]; Q.vy[m] = P.vy[i]; Q.vz[m] = P.vz[i]; Q.type[m] = P.type[i]; m++; }
        if (ain !== bin) {
            let t = va / (va - vb);
            let px = P.x[i] + t * (P.x[j] - P.x[i]), py = P.y[i] + t * (P.y[j] - P.y[i]), pz = P.z[i] + t * (P.z[j] - P.z[i]);
            const vp = fn(px, py, pz);
            if (vp !== 0) {
                const t2 = ain ? t - vp / (vp - vb) * (1 - t) : t - vp / (vp - va) * t;
                if (t2 > 0 && t2 < 1) { t = t2; px = P.x[i] + t * (P.x[j] - P.x[i]); py = P.y[i] + t * (P.y[j] - P.y[i]); pz = P.z[i] + t * (P.z[j] - P.z[i]); }
            }
            Q.x[m] = px; Q.y[m] = py; Q.z[m] = pz;
            Q.vx[m] = P.vx[i] + t * (P.vx[j] - P.vx[i]); Q.vy[m] = P.vy[i] + t * (P.vy[j] - P.vy[i]); Q.vz[m] = P.vz[i] + t * (P.vz[j] - P.vz[i]);
            Q.type[m] = ain ? type : P.type[i];
            m++;
        }
    }
    Q.n = m;
}
function copyPoly(P, Q) {
    const n = P.n;
    Q.x.set(P.x.subarray(0, n)); Q.y.set(P.y.subarray(0, n)); Q.z.set(P.z.subarray(0, n));
    Q.vx.set(P.vx.subarray(0, n)); Q.vy.set(P.vy.subarray(0, n)); Q.vz.set(P.vz.subarray(0, n));
    Q.type.set(P.type.subarray(0, n)); Q.n = n;
}
// Split long clip edges (type 1 or 2) and put the new vertices on the true clip curve on
// the shell: the horizon circle and the shadow boundary are curved, and a straight edge
// hundreds of km long cuts off a segment many km deep. P -> Q.
const G3 = new Float64Array(3), V3 = new Float64Array(3);
function refineClip(P, Q, c, setup, s, segKm) {
    const n = P.n, { O, up } = setup;
    let m = 0;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        Q.x[m] = P.x[i]; Q.y[m] = P.y[i]; Q.z[m] = P.z[i]; Q.vx[m] = P.vx[i]; Q.vy[m] = P.vy[i]; Q.vz[m] = P.vz[i]; Q.type[m] = P.type[i]; m++;
        const ty = P.type[i];
        if (ty === 0) continue;
        const dx = P.x[j] - P.x[i], dy = P.y[j] - P.y[i], dz = P.z[j] - P.z[i];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const parts = Math.ceil(len / segKm);
        if (parts < 2) continue;
        for (let k = 1; k < parts; k++) {
            if (m >= Q.cap - 1) break;
            const t = k / parts;
            let x = P.x[i] + t * dx, y = P.y[i] + t * dy, z = P.z[i] + t * dz;
            for (let it = 0; it < 3; it++) {
                const rr0 = Math.sqrt(x * x + y * y + z * z);
                const rr = shellRadius(c, z / rr0, 0);
                x *= rr / rr0; y *= rr / rr0; z *= rr / rr0;
                let v, gx, gy, gz;
                if (ty === 1) { v = (x - O[0]) * up[0] + (y - O[1]) * up[1] + (z - O[2]) * up[2]; gx = up[0]; gy = up[1]; gz = up[2]; }
                else { v = shadowFnXYZ(x, y, z, s); shadowGradXYZ(x, y, z, s, G3); gx = G3[0]; gy = G3[1]; gz = G3[2]; }
                const ux = x / rr, uy = y / rr, uz = z / rr;
                const gu = gx * ux + gy * uy + gz * uz;
                const tx = gx - gu * ux, tyy = gy - gu * uy, tz = gz - gu * uz;
                const t2 = tx * tx + tyy * tyy + tz * tz;
                if (t2 < 1e-30) break;
                const kk = v / t2;
                if (Math.abs(kk) * Math.sqrt(t2) < 1e-5) break;
                x -= kk * tx; y -= kk * tyy; z -= kk * tz;
            }
            Q.x[m] = x; Q.y[m] = y; Q.z[m] = z; Q.vx[m] = 0; Q.vy[m] = 0; Q.vz[m] = 0; Q.type[m] = ty; m++;
        }
    }
    Q.n = m;
}

// ---------------------------------------------------------------------------
// Flux through a clipped polygon for both families (ascending and descending passes):
// entries per second. With `acc` (a sparse bin accumulator) the step's counts are added to
// the 5-minute bins by the time of the run's peak, and the step's count is returned; with
// acc null the rate (per second) is returned.
// ---------------------------------------------------------------------------
const twoPi2 = 4 * Math.PI * Math.PI;
// Sparse accumulator of (bin, count) pairs: a step touches only a few bins.
function makeAcc(cap = 32) { return { n: 0, idx: new Int32Array(cap), val: new Float64Array(cap) }; }
function accAdd(acc, bin, v) {
    for (let i = 0; i < acc.n; i++) if (acc.idx[i] === bin) { acc.val[i] += v; return; }
    if (acc.n < acc.idx.length) { acc.idx[acc.n] = bin; acc.val[acc.n] = v; acc.n++; }
    else acc.val[acc.n - 1] += v;      // never reached: a step spans at most a few bins
}
function accCopy(from, to) { to.n = from.n; to.idx.set(from.idx.subarray(0, from.n)); to.val.set(from.val.subarray(0, from.n)); }
// Chord (in seconds of relative motion) from entry edge i's midpoint to the exit chain.
function chordAt(i, n, sA, bA, q1, q2) {
    const j = (i + 1) % n, sm = (sA[i] + sA[j]) / 2, bm = (bA[i] + bA[j]) / 2;
    let best = Infinity;
    for (let k = 0; k < n; k++) {
        if (k === i || q1[k] >= 0) continue;
        const kk = (k + 1) % n, b0 = bA[k], b1 = bA[kk];
        if ((bm - b0) * (bm - b1) > 0) continue;
        const u = b1 === b0 ? 0.5 : (bm - b0) / (b1 - b0);
        const se = sA[k] + u * (sA[kk] - sA[k]) - sm;
        if (se > 0 && se < best) best = se;
    }
    return best < Infinity ? best / q2[i] : -1;
}
function stepFlux(P, x, t, t0, s, s2, dtv, gmst, anchorRA, opt, acc, stepSec, scratch, perType) {
    const n = P.n, c = x.c;
    if (n < 3) return 0;
    const { sinPhi, phiV, Fv, nxA, nyA, nzA, bvx, bvy, bvz, mSin, mCos, mUx, mUy, mR, dens2, q1, q2, sA, bA, Tch } = scratch;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
        const r = Math.sqrt(P.x[i] * P.x[i] + P.y[i] * P.y[i] + P.z[i] * P.z[i]);
        sinPhi[i] = P.z[i] / r; phiV[i] = Math.asin(sinPhi[i]);
        let a = sinPhi[i] / c.sinIE; a = a > 1 ? 1 : a < -1 ? -1 : a;
        Fv[i] = Math.asin(a);
        cx += P.x[i]; cy += P.y[i]; cz += P.z[i];
    }
    const cl = Math.sqrt(cx * cx + cy * cy + cz * cz); cx /= cl; cy /= cl; cz /= cl;
    // tangent basis at the centre for the chord search
    const e1l = Math.sqrt(cx * cx + cy * cy), e1x = -cy / e1l, e1y = cx / e1l;
    const e2x = -cz * e1y, e2y = cz * e1x, e2z = cx * e1y - cy * e1x;
    // per-edge geometry: midpoint, outward normal (|n| = edge length), boundary velocity, density
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const mx = (P.x[i] + P.x[j]) / 2, my = (P.y[i] + P.y[j]) / 2, mz = (P.z[i] + P.z[j]) / 2;
        const rm = Math.sqrt(mx * mx + my * my + mz * mz);
        const ux = mx / rm, uy = my / rm, uz = mz / rm;
        const tx = P.x[j] - P.x[i], tyy = P.y[j] - P.y[i], tz = P.z[j] - P.z[i];
        nxA[i] = tyy * uz - tz * uy; nyA[i] = tz * ux - tx * uz; nzA[i] = tx * uy - tyy * ux;
        mR[i] = rm; mSin[i] = uz; mCos[i] = Math.sqrt(1 - uz * uz);
        mUx[i] = ux; mUy[i] = uy;
        const ty = P.type[i];
        if (ty === 1 || !opt.boundaryVelocity) { bvx[i] = 0; bvy[i] = 0; bvz[i] = 0; }
        else if (ty === 2) { shadowLineVelocityXYZ(mx, my, mz, s, s2, dtv, G3, V3); bvx[i] = V3[0]; bvy[i] = V3[1]; bvz[i] = V3[2]; }
        else { bvx[i] = (P.vx[i] + P.vx[j]) / 2; bvy[i] = (P.vy[i] + P.vy[j]) / 2; bvz[i] = (P.vz[i] + P.vz[j]) / 2; }
        // density along the edge: exact average of 1/sqrt(sin^2 iE - sin^2 phi), which handles
        // the 1/sqrt peak at the shell's turning latitude
        const phiA = phiV[i], phiB = phiV[j];
        let d;
        if (Math.abs(phiB - phiA) < 1e-7) { const d2 = c.sinIE * c.sinIE - uz * uz; d = d2 > 0 ? 1 / Math.sqrt(d2) : 0; }
        else d = (Fv[j] - Fv[i]) / ((phiB - phiA) * mCos[i]);
        dens2[i] = d > 0 ? x.count / (twoPi2 * rm * rm) * d : 0;
    }
    let total = 0;
    for (let f = 1; f >= -1; f -= 2) {
        let dirx = 0, diry = 0;
        for (let i = 0; i < n; i++) {
            const sp = mSin[i], cp = mCos[i];
            let su = sp / c.sinIE; su = su > 1 ? 1 : su < -1 ? -1 : su;
            const cu = f * Math.sqrt(1 - su * su);
            const vmag = c.v0 + c.v2 * (1 - 2 * su * su) - c.v0 * (c.s1 * su + c.r1 * cu) / c.r0;
            const vn = f * vmag * Math.sqrt(Math.max(0, cp * cp - c.cosIE * c.cosIE)) / cp;
            const ve = vmag * c.cosIE / cp - OMEGA_E * mR[i] * cp;
            // east = (-uy, ux, 0)/cos(phi), north = (-uz ux, -uz uy, cos^2 phi)/cos(phi)
            const cl2 = mUx[i] / cp, sl2 = mUy[i] / cp;
            const vx = -ve * sl2 - vn * sp * cl2 - bvx[i], vy = ve * cl2 - vn * sp * sl2 - bvy[i], vz = vn * cp - bvz[i];
            q1[i] = -(vx * nxA[i] + vy * nyA[i] + vz * nzA[i]);
            q2[i] = Math.sqrt(vx * vx + vy * vy + vz * vz);
            dirx += vx * e1x + vy * e1y; diry += vx * e2x + vy * e2y + vz * e2z;
        }
        const dl = Math.sqrt(dirx * dirx + diry * diry) || 1; dirx /= dl; diry /= dl;
        // vertex coordinates along (s) and across (b) the mean relative flow
        for (let i = 0; i < n; i++) {
            const px = P.x[i] * e1x + P.y[i] * e1y, py = P.x[i] * e2x + P.y[i] * e2y + P.z[i] * e2z;
            sA[i] = px * dirx + py * diry; bA[i] = -px * diry + py * dirx;
        }
        // Chord from an entry edge midpoint to the exit chain at the same b. A chord is only
        // needed where it can be short (< sampleSec x speed): near the two vertices where the
        // flow is tangent to the boundary, or everywhere when the whole polygon is thin.
        for (let i = 0; i < n; i++) Tch[i] = -1;
        if (opt.detection) {
            // thickness probe: the entry edge with the largest flux
            let ib = -1, qb = 0;
            for (let i = 0; i < n; i++) if (q1[i] > qb) { qb = q1[i]; ib = i; }
            const thin = ib >= 0 && (Tch[ib] = chordAt(ib, n, sA, bA, q1, q2)) >= 0 && Tch[ib] < 2 * opt.sampleSec;
            if (thin) { for (let i = 0; i < n; i++) if (q1[i] > 0 && i !== ib) Tch[i] = chordAt(i, n, sA, bA, q1, q2); }
            else for (let i = 0; i < n; i++) {
                if (q1[i] <= 0) continue;
                // within 3 edges of a sign change of q1
                let near = false;
                for (let d = -3; d <= 3 && !near; d++) { const k = (i + d + n) % n; if (q1[k] <= 0) near = true; }
                if (near) Tch[i] = chordAt(i, n, sA, bA, q1, q2);
            }
        }
        for (let i = 0; i < n; i++) {
            if (q1[i] <= 0) continue;
            let rho = dens2[i];
            if (rho <= 0) continue;
            let su = mSin[i] / c.sinIE; su = su > 1 ? 1 : su < -1 ? -1 : su;
            const cu = f * Math.sqrt(1 - su * su);
            if (opt.keplerDensity) rho *= 1 + 2 * (c.r1 * cu + c.s1 * su) / c.r0;
            if (x.ltan) {
                // The plane density p(RAAN) varies on 0.1-0.3 deg scales, and near the pole a
                // short edge spans degrees of RAAN: average p over the edge at <= 0.1 deg steps
                // of the node longitude, from each end's own node longitude. The plane's RAAN
                // is mapped back to the night's noon (the nodal drift since then is removed)
                // and compared with the Sun's right ascension at noon (anchorRA).
                const j = (i + 1) % n, drift = c.raanDot * (t - t0) / 1000;
                let sa = sinPhi[i] / c.sinIE, sb = sinPhi[j] / c.sinIE;
                sa = sa > 1 ? 1 : sa < -1 ? -1 : sa; sb = sb > 1 ? 1 : sb < -1 ? -1 : sb;
                const ca = f * Math.sqrt(1 - sa * sa), cb = f * Math.sqrt(1 - sb * sb);
                let oA = Math.atan2(P.y[i], P.x[i]) + gmst - Math.atan2(c.cosIE * sa, ca) - drift;
                let oB = Math.atan2(P.y[j], P.x[j]) + gmst - Math.atan2(c.cosIE * sb, cb) - drift;
                if (oB - oA > Math.PI) oB -= 2 * Math.PI; else if (oA - oB > Math.PI) oB += 2 * Math.PI;
                let m = Math.ceil(Math.abs(oB - oA) / (0.1 * DEG)); if (m < 2) m = 2; else if (m > 64) m = 64;
                let pm = 0;
                for (let k = 0; k < m; k++) pm += raanDensityAt(x.ltan, (oA + (oB - oA) * (k + 0.5) / m) / DEG - anchorRA);
                rho *= pm / m;
            }
            let flux = rho * q1[i];
            const T = Tch[i];
            if (opt.detection && T >= 0 && T < opt.sampleSec) flux *= T / opt.sampleSec;
            if (perType) perType[P.type[i]] = (perType[P.type[i]] || 0) + flux;
            if (acc) {
                const cnt2 = flux * stepSec;
                total += cnt2;
                // binned at the run's peak: entry time + half the chord
                const tPeak = t + (T > 0 ? T * 500 : 0);
                let b = Math.floor((tPeak - t0) / BIN_MS);
                if (b < 0) b = 0; else if (b >= NBINS) b = NBINS - 1;
                accAdd(acc, b, cnt2);
            } else total += flux;
        }
    }
    return total;
}

function makeScratch(cap) {
    const o = {};
    for (const k of ["sinPhi", "phiV", "Fv", "nxA", "nyA", "nzA", "bvx", "bvy", "bvz", "mSin", "mCos", "mUx", "mUy", "mR", "dens2", "q1", "q2", "sA", "bA", "Tch", "vals"]) o[k] = new Float64Array(cap);
    return o;
}
const bufferCache = new Map();
function buffers(opt) {
    const key = opt.slices + "|" + opt.clipSegKm;
    let b = bufferCache.get(key);
    if (b) return b;
    const cap = 2 * opt.slices + 2 * Math.ceil(1500 / opt.clipSegKm) + 16;
    b = { P1: makePoly(cap), P2: makePoly(cap), Q1: makePoly(cap), Q2: makePoly(cap), Q3: makePoly(cap),
          lk: {}, tmpQ: new Float64Array(2 * opt.slices), scratch: makeScratch(cap),
          accCoarse: makeAcc(), accFine: makeAcc(), accPrev: makeAcc() };
    bufferCache.set(key, b);
    return b;
}

const CLIP = { O: null, up: null, s: null };
const horizonClipFn = (px, py, pz) => (px - CLIP.O[0]) * CLIP.up[0] + (py - CLIP.O[1]) * CLIP.up[1] + (pz - CLIP.O[2]) * CLIP.up[2];
const shadowClipFn = (px, py, pz) => shadowFnXYZ(px, py, pz, CLIP.s);
// One time step for one shell: region at t and t + dtv (for the boundary velocity), clip,
// refine, flux. Returns -1 when there is no lobe at all, else the step's count.
function shellStep(x, T, setup, fr, fr2, t, t0, dtv, gmst, anchorRA, opt, acc, stepSec, B, perType) {
    const { P1, P2, Q1, Q2, Q3, lk, tmpQ, scratch } = B;
    if (!placeLobe(T, x.c, setup, fr, P1, lk, tmpQ)) return -1;
    const direct = lk.direct;
    if (opt.boundaryVelocity && placeLobe(T, x.c, setup, fr2, P2, lk, tmpQ, direct ? tmpQ : null) && P2.n === P1.n) {
        for (let i = 0; i < P1.n; i++) { P1.vx[i] = (P2.x[i] - P1.x[i]) / dtv; P1.vy[i] = (P2.y[i] - P1.y[i]) / dtv; P1.vz[i] = (P2.z[i] - P1.z[i]) / dtv; }
    } else for (let i = 0; i < P1.n; i++) { P1.vx[i] = 0; P1.vy[i] = 0; P1.vz[i] = 0; }
    const s = fr.s;
    CLIP.O = setup.O; CLIP.up = setup.up; CLIP.s = s;
    clipPoly(P1, Q1, horizonClipFn, 1, scratch.vals);
    if (Q1.n < 3) return 0;
    clipPoly(Q1, Q2, shadowClipFn, 2, scratch.vals);
    if (Q2.n < 3) return 0;
    refineClip(Q2, Q3, x.c, setup, s, opt.clipSegKm);
    return stepFlux(Q3, x, t, t0, s, fr2.s, dtv, gmst, anchorRA, opt, acc, stepSec, scratch, perType);
}

// ---------------------------------------------------------------------------
// expectedNight: the expected flares for one observer at sea level at latitude `lat`, in
// the night from local mean solar noon on `date` ("YYYY-MM-DD") to the next noon. kind is
// "visible" or "all". shells defaults to the model's constellation on that date
// (shellsForNight; `planes` and `lon` as there: by default the count is the mean over the
// observer's longitude, with `lon` it is that longitude's night).
//   total    flares in the night
//   bins     Float64Array(NBINS): flares in each 5-minute bin from noon, by the flare's peak
//   hour     24 numbers: flares in each local solar hour (0..23)
//   byShell  flares per shell, in the order of `shells`
// ---------------------------------------------------------------------------
export function expectedNight({ lat, date, kind, shells, planes, lon }, opts) {
    const opt = opts ? { ...DEFAULT_OPTS, ...opts } : DEFAULT_OPTS;
    const G = GLINT_LIMIT[kind];
    if (G === undefined) throw new Error("kind must be visible or all");
    if (!shells) shells = shellsForNight(date, { planes, lon });
    const [Y, M, Dd] = date.split("-").map(Number);
    const t0 = Date.UTC(Y, M - 1, Dd, 12);
    const bins = new Float64Array(NBINS);
    const byShell = new Array(shells.length).fill(0);
    const setup = nightSetup(lat, shells, G, opt.ltanJitterDeg);
    // Anchors of the plane local times (see equationOfTimeHours): the mean Sun's right
    // ascension at the night's noon is GMST there; the apparent Sun's comes from astro.
    const anchorMean = astro.gmstRad(new Date(t0)) / DEG, anchorApparent = astro.sunEquatorial(new Date(t0)).raDeg;
    const tables = setup.sh.map((x) => glintTable(x.c, G, opt));
    const B = buffers(opt), { accCoarse, accFine, accPrev } = B;
    const dtv = opt.velDtSec, fr = {}, fr2 = {};
    let total = 0;
    const addAcc = (acc, sign) => { for (let i = 0; i < acc.n; i++) { bins[acc.idx[i]] += sign * acc.val[i]; total += sign * acc.val[i]; } };
    // one step (midpoint t, length stepSec) of shell k into acc; returns the step's count
    const doStep = (k, t, stepSec, acc) => {
        const x = setup.sh[k];
        if (!sunFrame(t, setup, fr) || fr.D <= x.Dlo || fr.D >= x.Dhi) return 0;
        if (!sunFrame(t + dtv * 1000, setup, fr2)) return 0;
        const gmst = x.ltan ? astro.gmstRad(new Date(t)) : 0;
        const anchorRA = x.ltanMean ? anchorMean : anchorApparent;
        const r = shellStep(x, tables[k], setup, fr, fr2, t, t0, dtv, gmst, anchorRA, opt, acc, stepSec, B, null);
        return r < 0 ? 0 : r;
    };
    for (let k = 0; k < setup.sh.length; k++) {
        const before = total;
        // A Sun-synchronous shell's planes sweep past the observer at ~1 deg per 4 min and
        // its plane density has 0.1-0.3 deg structure, so it gets a finer step.
        const stepSec = setup.sh[k].ltan ? opt.stepSec / opt.ssoStepDiv : opt.stepSec;
        const stepMs = stepSec * 1000;
        let pr = 0, prevT = 0, prevRefined = true;
        const refine = (tm, acc) => {
            acc.n = 0;
            const subMs = stepMs / opt.edgeRefine;
            for (let j = 0; j < opt.edgeRefine; j++) doStep(k, tm - stepMs / 2 + subMs / 2 + j * subMs, stepSec / opt.edgeRefine, acc);
        };
        for (let t = t0 + stepMs / 2; t < t0 + DAY_MS; t += stepMs) {
            accCoarse.n = 0;
            const cnt = doStep(k, t, stepSec, accCoarse);
            const rate = cnt / stepSec;
            // The rate can change abruptly: the region appears or vanishes at the window's edges,
            // or sweeps past the shell's turning latitude. The change can sit in this step or in
            // the previous one, so redo both in fine sub-steps (the previous step's coarse
            // contribution, kept in accPrev, is taken back).
            if (opt.edgeRefine > 1 && ((rate > 0) !== (pr > 0) || Math.abs(rate - pr) > 0.5 * Math.max(rate, pr))) {
                if (!prevRefined && prevT) {
                    addAcc(accPrev, -1);
                    refine(prevT, accFine);
                    addAcc(accFine, 1);
                }
                refine(t, accCoarse);
                prevRefined = true;
            } else prevRefined = false;
            pr = rate; prevT = t;
            addAcc(accCoarse, 1);
            accCopy(accCoarse, accPrev);
        }
        byShell[k] = total - before;
    }
    const hour = new Array(24).fill(0);
    for (let b = 0; b < NBINS; b++) hour[(12 + Math.floor(b * BIN_MIN / 60)) % 24] += bins[b];
    return { total, hour, bins, byShell };
}

// ---------------------------------------------------------------------------
// What the pages use
// ---------------------------------------------------------------------------
// One night (local solar noon on night n of the span to the next noon) at 5-minute steps:
// the rate (flares per hour) at the centre of each bin, the night's total, the hour bins,
// and the total of each inclination group.
export function nightProfile(lat, night, kind = "visible", opts, planes) {
    const r = expectedNight({ lat, date: dateOfDay(night), kind, planes }, opts);
    const times = new Array(NBINS), rates = new Array(NBINS);
    for (let b = 0; b < NBINS; b++) { times[b] = 12 + (b + 0.5) * BIN_MIN / 60; rates[b] = r.bins[b] * 60 / BIN_MIN; }
    const byGroup = {};
    SHELLS.forEach((s, i) => { byGroup[s.group] = (byGroup[s.group] || 0) + r.byShell[i]; });
    return { times, rates, total: r.total, hour: r.hour, bins: r.bins, byGroup };
}

// Flares per night for every night of the span, computed live (about 16 s on a desktop; the
// rate page reads the precomputed table instead). With byGroup, also one array per
// inclination group. `nights` limits it to those night indices (the others stay 0).
export function yearTotals(lat, kind = "visible", { byGroup = false, opts, planes, nights } = {}) {
    const total = new Float64Array(DAYS), groups = {};
    if (byGroup) for (const g of GROUP_INCS) groups[String(g)] = new Float64Array(DAYS);
    for (const n of nights || total.keys()) {
        const r = expectedNight({ lat, date: dateOfDay(n), kind, planes }, opts);
        total[n] = r.total;
        if (byGroup) SHELLS.forEach((s, i) => { if (groups[s.group]) groups[s.group][n] += r.byShell[i]; });
    }
    return byGroup ? { total, groups } : total;
}

// The deepest the Sun goes below the observer's (geodetic) horizon on night n of the span:
// at local solar midnight.
export function maxDepression(lat, night) {
    const [Y, M, Dd] = dateOfDay(night).split("-").map(Number);
    const Oo = geo.llaToEcef(lat, 0, 0), up = geo.localUp(Oo);
    const s = sunEcef(Date.UTC(Y, M - 1, Dd, 24));
    return Math.asin(Math.max(-1, Math.min(1, -(s[0] * up.x + s[1] * up.y + s[2] * up.z)))) / DEG;
}

// The smallest Sun depression that can give a flare of each kind: the lower edge of the
// lowest shell's window, B = 180° - M - 2 asin(cos E cos M) - G with E the dip of the
// Earth's edge seen from the satellite and sin M = tan E / sqrt(3) (see formula.html).
// Over the shells that hold at least 1% of the constellation: the few decaying satellites
// at 240-300 km would put the edge 5° lower for a handful of flares.
export const MIN_DEPRESSION = Object.fromEntries(KINDS.map((kind) => {
    const G = GLINT_LIMIT[kind];
    let best = Infinity;
    for (const s of SHELLS) {
        if (s.count < 0.01 * TOTAL_SATELLITES) continue;
        const c = shellConstants(s.inc, s.alt);
        const E = Math.acos(WA / c.rMax), Mm = Math.asin(Math.tan(E) / Math.sqrt(3));
        best = Math.min(best, (Math.PI - Mm - 2 * Math.asin(Math.cos(E) * Math.cos(Mm))) / DEG - G);
    }
    return [kind, best];
}));

// The window of Sun depressions of a shell at altitude alt (deg): lower edge B as above and
// upper edge 2E, where the satellites in the glint zone enter the Earth's shadow. For the
// formula page's table.
export function windowOf(alt, kind = "visible") {
    const E = Math.acos(6371 / (6371 + alt)), Mm = Math.asin(Math.tan(E) / Math.sqrt(3));
    return { lower: (Math.PI - Mm - 2 * Math.asin(Math.cos(E) * Math.cos(Mm))) / DEG - GLINT_LIMIT[kind], upper: 2 * E / DEG };
}

// The surface density of a shell of inclination inc at geocentric latitude phi, relative to
// its value over the equator: 1 / sqrt(sin^2 i - sin^2 phi) normalized (the time a satellite
// spends per unit of area; infinite at the turning latitude). For the formula page's chart,
// capped at `cap`.
export function relativeDensity(lat, inc, cap = 8) {
    const d2 = Math.sin(inc * DEG) ** 2 - Math.sin(lat * DEG) ** 2;
    if (d2 <= 0) return Math.abs(Math.abs(lat) - (inc > 90 ? 180 - inc : inc)) < 0.26 ? cap : 0;
    return Math.min(cap, Math.sin(inc * DEG) / Math.sqrt(d2));
}

// The precomputed year table (rate/rateTable.json, built by tools/build-rate-table.mjs):
// flares per night at every latitude row and night of the span, both kinds. The file stores
// each row as day-to-day differences, and the "all" rows as differences from the "visible"
// rows, for size; this returns { visible, all }, each a Float64Array of nLat x days flares
// per night (latitude i = latMin + i x latStep), and the header fields. A table for another
// span or shell table than this model's is refused: its nights would be the wrong dates.
export const RATE_TABLE_FORMAT = "shf-rate-table-3";
export function decodeRateTable(table) {
    if (table.format !== RATE_TABLE_FORMAT) throw new Error(`unexpected year table format ${table.format}`);
    if (!table.span || table.span.start !== SPAN.start || table.span.end !== SPAN.end || table.days !== DAYS) {
        throw new Error(`the year table covers ${table.span ? table.span.start + " to " + table.span.end : "an unknown span"}, the model ${SPAN.start} to ${SPAN.end}`);
    }
    if (table.refEpoch !== STARLINK_SHELLS.refEpoch) throw new Error(`the year table was built from a shell table of ${table.refEpoch}, the model has ${STARLINK_SHELLS.refEpoch}`);
    const { nLat, days, scale } = table, out = {};
    for (const kind of table.kinds) {
        const coded = table[kind], base = kind === "visible" ? null : out.visible;
        const vals = new Float64Array(nLat * days);
        for (let i = 0; i < nLat; i++) {
            let run = 0;
            for (let n = 0; n < days; n++) {
                const k = i * days + n;
                run += coded[k];
                vals[k] = run / scale + (base ? base[k] : 0);
            }
        }
        out[kind] = vals;
    }
    return { ...out, latMin: table.latMin, latStep: table.latStep, nLat, days, span: table.span, source: table.source, refEpoch: table.refEpoch };
}

// Hooks for the check scripts (not part of the contract).
export const _debug = {
    shellConstants, glintTable, nightSetup, sunFrame, raanDensity, raanDensityAt, buffers,
    gmstDeg: (d) => astro.gmstRad(d) / DEG,
    // entries per second at one time, per edge type (0 glint, 1 horizon, 2 shadow)
    rateAt({ lat, tMs, kind, shell, date, opts }) {
        const opt = opts ? { ...DEFAULT_OPTS, ...opts } : DEFAULT_OPTS;
        const G = GLINT_LIMIT[kind];
        const setup = nightSetup(lat, [shell], G, opt.ltanJitterDeg), x = setup.sh[0];
        const fr = sunFrame(tMs, setup), fr2 = sunFrame(tMs + opt.velDtSec * 1000, setup);
        if (!fr || !fr2) return null;
        const t0 = date ? Date.UTC(...date.split("-").map((v, i) => i === 1 ? v - 1 : +v), 12) : tMs;
        const anchorRA = x.ltanMean ? astro.gmstRad(new Date(t0)) / DEG : astro.sunEquatorial(new Date(t0)).raDeg;
        const gmst = astro.gmstRad(new Date(tMs));
        const perType = {};
        const B = buffers(opt);
        const r = shellStep(x, glintTable(x.c, G, opt), setup, fr, fr2, tMs, t0, opt.velDtSec, gmst, anchorRA, opt, null, 0, B, perType);
        return { total: r < 0 ? 0 : r, D: fr.D, perType, vertices: B.Q3.n };
    },
};
