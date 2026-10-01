// dummyTLE.js — synthesise the Starlink constellation. This is the DEFAULT data source
// (instant, offline, no network); real elements are opt-in via the Advanced controls.
// It is NOT real data: it reproduces the measured STRUCTURE of the real constellation
// (starlinkShells.js), so that the flare counts and their pattern in the sky match the real
// set, without naming any real satellite.
//
// How it is built, per shell of the table (inclination, altitude, count):
//   * The shell is laid out in its MEASURED orbital planes. Each plane's right ascension was
//     measured at the table's reference epoch and is moved to the requested date with the
//     shell's J2 nodal precession rate (-4.7°/day at 53°/470 km, -5.6°/day at 43°/490 km,
//     -2.5°/day at 70°/579 km). All planes of a shell precess at the same rate, so the real
//     plane pattern is kept on any date; it rotates as a whole, as the real one does. This
//     matters: the 70° shells are a few planes each, and on a given night such a shell has
//     no "average" layout — its planes either cross the glint zone or they do not. A uniform
//     Walker layout of the same shells was measured to be ±5-10% per latitude; the anchored
//     planes are within 2%.
//   * A Sun-synchronous shell (sso: true, the 97.3° group) keeps each plane at its measured
//     local MEAN solar time of the ascending node (LTAN) on ANY date:
//     RAAN = GMST + 15° x (LTAN - UT), that is RAAN = (mean Sun RA) + 15° x (LTAN - 12 h).
//     The mean Sun, not the true Sun, because the plane precesses at the mean Sun's uniform
//     rate; the true Sun differs by the equation of time (up to 4° of right ascension).
//     These planes made 68% of the visible flares at 55°N around 1 October 2026 (57% over
//     the year); a uniform RAAN gave 0.58 of the real count from this group (50°S to 55°N).
//   * Within a plane the satellites are evenly spaced in argument of latitude, with a random
//     phase per plane and Gaussian jitter equal to the shell's measured within-plane
//     irregularity (gapSd: 1-4° for the regular 53°, 43° and 97° planes, ~10° for the 70°
//     planes filled from mixed launch batches). The phases are tied to the reference epoch
//     and moved to the date with the shell's mean motion, so successive dates are one
//     constellation moving continuously, not a reshuffle.
//   * Altitude = shell altitude + Gaussian spread (altSd, clamped at 2.5 sigma); RAAN jitter
//     ±0.15°; inclination jitter ±0.003°; eccentricity 1e-4; argument of perigee 0;
//     epoch = the given date, so SGP4 propagates from there.
// Measured against the real set over five nights (29 Sep - 3 Oct 2026; visible flares per
// night, 14 latitudes): pooled ratio 1.002, every latitude from 50°S to 60°N within 2%
// (worst 1.016 +/- 0.006 at 10°S and 0.981 +/- 0.016 at 60°N; the rest within 1%). The old
// Walker-style generator was -19% / -37% / -65% at 45/55/65°N.
//
// Emits valid two-line element sets (correct fixed columns + checksums) so satellite.js
// parses them like any other TLE. Deterministic for a given (date, options).

// Versioned imports (see app.js): we are imported as `dummyTLE.js?v=<stamp>`, so carry
// that query into the modules this file loads, for consistent cache-busting.
const VERSION = new URL(import.meta.url).search;
const [{ STARLINK_SHELLS }, { gmstRad }] = await Promise.all([
    import("./starlinkShells.js" + VERSION),
    import("./astro.js" + VERSION),
]);
export { STARLINK_SHELLS };

const MU = 398600.4418;             // km^3/s^2
const RE_GEN = 6371;                // the altitude convention of the shell table (see starlinkShells.js)
const RE_J2 = 6378.137, J2 = 1.08262668e-3;
const wrap360 = (x) => ((x % 360) + 360) % 360;
const f = (v, w) => v.toFixed(4).padStart(w);     // fixed 4-dp, right-justified

// Mod-10 TLE checksum over columns 1–68 ('-' counts as 1, digits as themselves).
function checksum(line) {
    let sum = 0;
    for (let i = 0; i < 68; i++) {
        const c = line[i];
        if (c >= "0" && c <= "9") sum += +c;
        else if (c === "-") sum += 1;
    }
    return String(sum % 10);
}

// Place [startIndex, text] fields into a 68-char line, then append the checksum.
function buildLine(fields) {
    const a = new Array(68).fill(" ");
    for (const [start, str] of fields) {
        for (let i = 0; i < str.length; i++) a[start + i] = str[i];
    }
    const line = a.join("");
    return line + checksum(line);
}

// TLE epoch "YYDDD.DDDDDDDD" (2-digit year, day-of-year with fraction).
function epochStr(date) {
    const year = date.getUTCFullYear();
    const yy = String(year % 100).padStart(2, "0");
    const doy = (date.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1; // Jan 1 = day 1.x
    const dInt = Math.floor(doy);
    const frac = (doy - dInt).toFixed(8).slice(1); // ".DDDDDDDD"
    return yy + String(dInt).padStart(3, "0") + frac;
}

// Tiny deterministic PRNG (mulberry32) so the synthetic set is reproducible —
// the same every run, rather than reshuffling on each Find Flares.
function mulberry32(seed) {
    return function () {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Mean motion (rev/day) for a circular orbit at the given altitude (km).
export function meanMotion(altKm) {
    const a = RE_GEN + altKm;
    const n = Math.sqrt(MU / (a * a * a));          // rad/s
    return n * 86400 / (2 * Math.PI);
}

// J2 secular nodal precession rate (deg/day) of a near-circular orbit.
export function nodalRate(altKm, incDeg, ecc = 1e-4) {
    const p = (RE_GEN + altKm) * (1 - ecc * ecc);
    return -1.5 * meanMotion(altKm) * 360 * J2 * (RE_J2 / p) ** 2 * Math.cos(incDeg * Math.PI / 180);
}

// Scale integer counts to a new total: largest remainder, so the sum is exact.
function scaleCounts(counts, total) {
    const sum = counts.reduce((s, c) => s + c, 0);
    const raw = counts.map((c) => (c * total) / sum);
    const out = raw.map(Math.floor);
    let left = total - out.reduce((s, c) => s + c, 0);
    const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((p, q) => q[0] - p[0]);
    for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]]++;
    return out;
}

// Generate the synthetic constellation as TLE text, epoch = date.
//
// `total` (optional) scales every shell's count by the same factor (largest-remainder
// rounding keeps the sum exact); the default is the table's own total, so the count follows
// the measured constellation. The callers (app.js, stats/statsCore.mjs) do not pass it.
export function generateDummyTLE(date = new Date(), total) {
    return generateFromTable(date, { total });
}

// The generator with its measurement options. opts:
//   total   satellites in all (default: the table's total; every shell scaled alike)
//   shells  a shell table in the starlinkShells.js format (default: STARLINK_SHELLS)
//   mode    "anchored" (default): the measured planes, precessed to the date;
//           "walker": the same number of planes, evenly spaced, equal counts, a seeded offset;
//           "random": every satellite at a random RAAN (no planes; for measurement only).
//           A Sun-synchronous shell keeps its local-time planes in every mode but "random".
//   phase   "even" (default): evenly spaced in each plane with the measured jitter (gapSd);
//           "random": uniform random phases
//   gapSd   overrides every shell's within-plane jitter (deg)
//   seed    the random seed (default 1)
//   inc     keep only the shells within 3° of these inclinations, e.g. "70" or "70,97"
export function generateFromTable(date = new Date(), opts = {}) {
    const table = opts.shells || STARLINK_SHELLS;
    const mode = opts.mode || "anchored";
    const randomPhase = opts.phase === "random";
    const incFilter = opts.inc != null ? String(opts.inc).split(",").map(Number) : null;
    const total = Number(opts.total || table.total);
    const rnd = mulberry32((Number(opts.seed || 1) * 0x9E3779B1) | 0);
    const gauss = () => { const u = Math.max(1e-12, rnd()), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const epoch = epochStr(date);
    const days = (date.getTime() - Date.parse(table.refEpoch)) / 86400000;
    // RAAN of a plane whose ascending node is at local mean solar time `ltan` (hours) at `date`.
    const gmstDeg = gmstRad(date) * 180 / Math.PI;
    const utHours = (date.getTime() % 86400000) / 3600000;
    const raanOfLtan = (ltan) => gmstDeg + 15 * (ltan - utHours);
    const counts = scaleCounts(table.shells.map((s) => s.count), total);

    const lines = [];
    let id = 80000, n = 0;
    const emit = (inc, raan, ma, altKm) => {
        id++; n++;
        const sat = String(id).padStart(5, "0");
        const l1 = buildLine([
            [0, "1"], [2, sat], [7, "U"], [9, "26001A"], [18, epoch],
            [33, " .00000000"], [44, " 00000-0"], [53, " 00000-0"], [62, "0"], [64, " 999"],
        ]);
        const l2 = buildLine([
            [0, "2"], [2, sat], [8, f(inc, 8)], [17, f(wrap360(raan), 8)], [26, "0001000"],
            [34, f(0, 8)], [43, f(wrap360(ma), 8)], [52, meanMotion(altKm).toFixed(8).padStart(11)], [63, "00000"],
        ]);
        lines.push("SYNTH-STARLINK " + n, l1, l2);
    };

    table.shells.forEach((sh, si) => {
        const count = counts[si];
        if (count <= 0) return;
        if (incFilter && !incFilter.some((i) => Math.abs(i - sh.inc) < 3)) return;
        const altOf = () => sh.alt + (sh.altSd || 0) * Math.max(-2.5, Math.min(2.5, gauss()));
        const incOf = () => sh.inc + (rnd() - 0.5) * 0.006;
        // Phase advance from the reference epoch to `date` (deg), so the constellation moves
        // continuously between dates instead of being reshuffled each night.
        const advance = meanMotion(sh.alt) * 360 * days;
        // Even spacing with Gaussian jitter = the shell's measured within-plane gap
        // irregularity (gapSd, deg; 0.5° when not measured), or uniform random phases.
        const jitter = opts.gapSd != null ? Number(opts.gapSd) : (sh.gapSd ?? 0.5);
        const phaseOf = (base, k, j) => base + advance + (randomPhase ? rnd() * 360 : (360 / k) * j + gauss() * jitter);
        // The planes at `date`: [[raanDeg, satellites], ...].
        let planes = null;
        const measured = sh.sso ? sh.ltan : sh.raan;
        if (measured && mode !== "random") {
            if (sh.sso) planes = measured.map(([ltan, k]) => [raanOfLtan(ltan), k]);
            else if (mode === "walker") {
                const P = measured.length, off = rnd() * 360 / P;
                planes = measured.map((_, p) => [off + (360 / P) * p, 1]);
            } else planes = measured.map(([raan, k]) => [raan + nodalRate(sh.alt, sh.inc) * days, k]);
            const pc = scaleCounts(planes.map((p) => p[1]), count);
            planes = planes.map((p, i) => [p[0], pc[i]]).filter((p) => p[1] > 0);
        }
        // A shell without a plane list (or mode "random"): random RAANs.
        if (!planes) { for (let k = 0; k < count; k++) emit(incOf(), rnd() * 360, rnd() * 360 + advance, altOf()); return; }
        for (const [raan, k] of planes) {
            const phase = rnd() * 360;
            for (let j = 0; j < k; j++) emit(incOf(), raan + (rnd() - 0.5) * 0.3, phaseOf(phase, k, j), altOf());
        }
    });
    return lines.join("\n") + "\n";
}
