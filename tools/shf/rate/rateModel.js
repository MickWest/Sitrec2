// rateModel.js — the approximate Starlink horizon-flare rate formula.
//
// A closed-form model derived from the flare geometry and fitted (one constant, K) to a
// year of flare-stats.mjs simulation with the synthetic constellation. The formula, its
// derivation and its accuracy are in ../stats/README.md ("Approximate formula").
// Pure functions, no DOM: the rate page and tools/test-rate.mjs both use it.
//
// Units: angles in degrees, time in hours of local mean solar time, rates in flares per hour.

const R_EARTH = 6371;
const DEG = Math.PI / 180;

// The shells of the synthetic constellation: the `groups` in ../dummyTLE.js, with the
// same satellite counts (round(total × fraction)). tools/test-rate.mjs checks this list
// against generateDummyTLE, so the two cannot drift apart.
export const SYNTHETIC_TOTAL = 10500;
export const SHELLS = [
    { inc: 43.00, alt: 490, frac: 0.31 },
    { inc: 53.17, alt: 480, frac: 0.18 },
    { inc: 53.17, alt: 550, frac: 0.13 },
    { inc: 53.17, alt: 470, frac: 0.09 },
    { inc: 70.00, alt: 580, frac: 0.067 },
    { inc: 97.50, alt: 560, frac: 0.046 },
    { inc: 97.50, alt: 470, frac: 0.037 },
    { inc: 53.17, alt: 370, frac: 0.034 },
    { inc: 43.00, alt: 360, frac: 0.032 },
    { inc: 97.50, alt: 430, frac: 0.010 },
    { inc: 53.17, alt: 420, frac: 0.020 },
    { inc: 43.00, alt: 400, frac: 0.020 },
].map((s) => ({ ...s, count: Math.max(1, Math.round(SYNTHETIC_TOTAL * s.frac)) }));

// G = glint limit in degrees, K = fitted constant for a rate in flares per HOUR.
// The fit was made per 2-minute sample (K = 0.01049 visible, 0.01173 all); per hour
// that is 30 times larger. These values reproduce the fitted yearly means.
export const KINDS = {
    visible: { glint: 4.44, k: 0.3147 },
    all: { glint: 5, k: 0.3519 },
};

const sind = (a) => Math.sin(a * DEG);
const cosd = (a) => Math.cos(a * DEG);
const asind = (x) => Math.asin(Math.max(-1, Math.min(1, x))) / DEG;
const clampLat = (y) => Math.max(-90, Math.min(90, y));

// Everything about a shell that does not change with time or place.
function shellConstants(shell, glint) {
    const e = Math.acos(R_EARTH / (R_EARTH + shell.alt)) / DEG;     // E: dip of the Earth's edge
    const m = asind(Math.tan(e * DEG) / Math.sqrt(3));             // M
    const upper = 2 * e;                                           // U: satellite enters shadow
    const lower = 180 - m - 2 * asind(cosd(e) * cosd(m)) - glint;  // B: lower edge of the window
    const dist = 86 - asind(cosd(e) * cosd(4));                    // C: distance to the flaring satellites
    return { ...shell, lower, upper, dist, sinInc: sind(shell.inc) };
}

const CONSTANTS = Object.fromEntries(Object.entries(KINDS).map(([kind, { glint }]) =>
    [kind, SHELLS.map((s) => shellConstants(s, glint))]));

// The smallest Sun depression that can give a flare (the lowest shell's window).
export const MIN_DEPRESSION = Object.fromEntries(Object.entries(CONSTANTS).map(([kind, shells]) =>
    [kind, Math.min(...shells.map((s) => s.lower))]));

// Fraction of a shell south of latitude y. The band edges are limited to ±90° so that
// the formula stays finite at the poles; below about 69° latitude this changes nothing.
function fractionSouth(y, sinInc) {
    const s = sind(clampLat(y)) / sinInc;
    return 0.5 + asind(s) / 180;
}

// Q: the shell's satellite density per steradian in a ±3° band about latitude z.
function shellDensity(z, sinInc) {
    const hi = clampLat(z + 3), lo = clampLat(z - 3);
    const area = 2 * Math.PI * (sind(hi) - sind(lo));
    if (area <= 0) return 0;
    return (fractionSouth(hi, sinInc) - fractionSouth(lo, sinInc)) / area;
}

// Solar declination (S) on day of year N (1 January = 0).
export function declination(dayOfYear) {
    return -23.44 * cosd(360 * (dayOfYear + 10) / 365.25);
}

// Sun depression below the horizon (D, positive when the Sun is down) and Sun azimuth (A,
// from north, clockwise) at latitude lat, declination dec, local solar time t (hours).
export function sunPosition(lat, dec, t) {
    const h = 15 * (t - 12);
    const depression = -asind(sind(lat) * sind(dec) + cosd(lat) * cosd(dec) * cosd(h));
    const azimuth = Math.atan2(-sind(h) * cosd(dec), cosd(lat) * sind(dec) - sind(lat) * cosd(dec) * cosd(h)) / DEG;
    return { depression, azimuth };
}

// The relative density of a shell of inclination inc at latitude lat: Q, divided by its
// value at the equator (for the explanation page's chart).
export function relativeDensity(lat, inc) {
    const sinInc = sind(inc);
    return shellDensity(lat, sinInc) / shellDensity(0, sinInc);
}

// Flares per hour at latitude lat, declination dec, local solar time t. An optional
// filter(shell) limits the sum to some shells (the explanation page splits by inclination).
export function rateAt(lat, dec, t, kind = "visible", filter = null) {
    const shells = CONSTANTS[kind];
    const { depression, azimuth } = sunPosition(lat, dec, t);
    if (depression <= MIN_DEPRESSION[kind]) return 0;     // daytime or twilight: no shell can flare
    const sinL = sind(lat), cosL = cosd(lat), cosA = cosd(azimuth);
    let sum = 0;
    for (const s of shells) {
        if (filter && !filter(s)) continue;
        const x = (depression - s.lower) / (s.upper - s.lower);
        if (x <= 0 || x >= 1) continue;
        const w = Math.sqrt(Math.sin(Math.PI * x));
        const z = asind(sinL * cosd(s.dist) + cosL * sind(s.dist) * cosA);
        sum += shellDensity(z, s.sinInc) * w * s.count;
    }
    return KINDS[kind].k * sum;
}

// One night (local solar noon on day N to the next noon), sampled every stepMin minutes.
// Returns the rate at each sample and the night's total (the rate added up over time).
export function nightProfile(lat, dayOfYear, kind = "visible", stepMin = 2, filter = null) {
    const dec = declination(dayOfYear);
    const dt = stepMin / 60;
    const steps = Math.round(24 / dt);
    const times = new Array(steps + 1);
    const rates = new Array(steps + 1);
    let total = 0;
    for (let i = 0; i <= steps; i++) {
        const t = 12 + i * dt;
        times[i] = t;
        rates[i] = rateAt(lat, dec, t, kind, filter);
        // Trapezoid rule; the two noon ends are always zero.
        total += (i === 0 || i === steps ? 0.5 : 1) * rates[i] * dt;
    }
    return { times, rates, total };
}

// Flares per night for every day of a 365-day year.
export function yearTotals(lat, kind = "visible", stepMin = 5, filter = null) {
    const out = new Array(365);
    for (let n = 0; n < 365; n++) out[n] = nightProfile(lat, n, kind, stepMin, filter).total;
    return out;
}

// The deepest the Sun goes below the horizon on day N (at local solar midnight).
export function maxDepression(lat, dayOfYear) {
    return sunPosition(lat, declination(dayOfYear), 24).depression;
}
