// dummyTLE.js — synthesise a Starlink-like TLE set. This is the DEFAULT data source
// (instant, offline, no network); real elements are opt-in via the Advanced controls.
// It is NOT real data — it just reproduces the *distribution* of the real
// constellation so the sky chart looks plausible: most satellites in the two dominant
// inclined shells (≈53° and ≈43°), plus a few polar (≈97.6°) ones, laid out in
// Walker-style planes across a realistic altitude distribution (~360–580 km, median
// ~490 km). Epoch = the given date so SGP4 propagates sensibly.
//
// Emits valid two-line element sets (correct fixed columns + checksums) so
// satellite.js parses them like any other TLE.

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

const f = (v, w) => v.toFixed(4).padStart(w);     // fixed 4-dp, right-justified
const wrap360 = (x) => ((x % 360) + 360) % 360;

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
function meanMotion(altKm) {
    const a = 6371 + altKm;                     // km
    const n = Math.sqrt(398600.4418 / (a * a * a)); // rad/s
    return n * 86400 / (2 * Math.PI);
}

// Generate a synthetic Starlink-like constellation as TLE text.
//
// Tuned to reproduce the *look* of the real flare pattern. The big realism lever
// is the (inclination, ALTITUDE) joint distribution, measured from a live set:
// the bulk sits near ~480–490 km (not 550), the dominant shell is 43°/490 km,
// and there are real lower groups (~360–470 km, orbit-raising/low shells). Those
// lower satellites are what produce the dense near-horizon flares; a single-altitude
// set could only make a thin high-elevation band.
// Each shell is laid out in Walker-style orbital planes (like the real
// constellation), which produces the clustered limb flares a uniform-random shell
// can't. Because the shells now sit at DIFFERENT altitudes, each flares at its own
// elevation, so the planes no longer collapse into one thin band (the old banding
// was caused by uniform altitude, not by the plane structure).
// Still entirely synthetic — NOT real satellites.
export function generateDummyTLE(date = new Date(), total = 10500) {
    const rnd = mulberry32(0x57A123);
    const epoch = epochStr(date);
    const ecc = "0001000";                 // 0.0001, decimal point implied
    const TOTAL = total;

    // [inclination°, altitude km, fraction] — the real shells (see diag-shells.mjs).
    const groups = [
        { inc: 43.00, alt: 490, frac: 0.31 },  // dominant V2-mini shell
        { inc: 53.17, alt: 480, frac: 0.18 },
        { inc: 53.17, alt: 550, frac: 0.13 },
        { inc: 53.17, alt: 470, frac: 0.09 },
        { inc: 70.00, alt: 580, frac: 0.067 },
        { inc: 97.50, alt: 560, frac: 0.046 },
        { inc: 97.50, alt: 470, frac: 0.037 },
        { inc: 53.17, alt: 370, frac: 0.034 }, // orbit-raising / low
        { inc: 43.00, alt: 360, frac: 0.032 },
        { inc: 97.50, alt: 430, frac: 0.010 },
        { inc: 53.17, alt: 420, frac: 0.020 }, // low tail (raising / decaying)
        { inc: 43.00, alt: 400, frac: 0.020 },
    ];

    // Lay each shell out in WALKER-style orbital planes (evenly-spaced RAAN, evenly
    // phased mean anomaly), like the real constellation. The plane structure is
    // essential: a whole plane sweeping through the deep-night specular point
    // delivers a burst of horizon flares that a uniform-random shell never makes.
    // Because the shells now sit at DIFFERENT altitudes, each flares at its own
    // elevation, so this no longer collapses into a single thin band (the old bug
    // — which was caused by every satellite being at ~550 km, not by the planes).
    // Small jitter on RAAN / mean anomaly / mean motion avoids a perfect grid.
    const lines = [];
    let id = 90000, n = 0;
    for (const g of groups) {
        const count = Math.max(1, Math.round(TOTAL * g.frac));
        const planes = Math.max(8, Math.round(Math.sqrt(count) * 1.4));
        const perPlane = Math.ceil(count / planes);
        const inc8 = f(g.inc, 8);
        let made = 0;
        for (let p = 0; p < planes && made < count; p++) {
            const raanBase = (360 / planes) * p;
            for (let k = 0; k < perPlane && made < count; k++) {
                const raan = wrap360(raanBase + (rnd() - 0.5) * (360 / planes) * 0.25);
                const ma = wrap360((360 / perPlane) * k + (p * 360 / planes / perPlane) + (rnd() - 0.5) * 3);
                const mm = meanMotion(g.alt + (rnd() - 0.5) * 16).toFixed(8).padStart(11);  // ±8 km
                id++; made++; n++;
                const sat = String(id).padStart(5, "0");
                const l1 = buildLine([
                    [0, "1"], [2, sat], [7, "U"], [9, "26001A"], [18, epoch],
                    [33, " .00000000"], [44, " 00000-0"], [53, " 00000-0"], [62, "0"], [64, " 999"],
                ]);
                const l2 = buildLine([
                    [0, "2"], [2, sat], [8, inc8], [17, f(raan, 8)], [26, ecc],
                    [34, f(0, 8)], [43, f(ma, 8)], [52, mm], [63, "00000"],
                ]);
                lines.push("SYNTH-STARLINK " + n, l1, l2);
            }
        }
    }
    return lines.join("\n") + "\n";
}
