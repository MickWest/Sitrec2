// astro.js — self-contained solar position + sidereal time.
//
// We avoid heavy dependencies (Sitrec uses astronomy-engine; here we only need
// the Sun direction to ~arcminute accuracy, far better than the ~5° flare cone).
//
// The Sun is returned as a UNIT DIRECTION in the ECI (geocentric equatorial,
// mean-equinox-of-date) frame. The flare engine rotates it into ECEF with the
// SAME GMST it uses for satellites (satellite.eciToEcf), so the relative
// geometry between Sun and satellite is always consistent.
//
// Pure ES module, no dependencies.

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// Julian Date from a JS Date (UTC).
export function julianDate(date) {
    return date.getTime() / 86400000 + 2440587.5;
}

// Days since J2000.0 (TT≈UTC at the arcminute level we need).
function daysSinceJ2000(date) {
    return julianDate(date) - 2451545.0;
}

// Low-precision solar coordinates (Astronomical Almanac, "Approximate Solar
// Coordinates"). Returns Sun's geocentric equatorial UNIT vector in ECI.
//   accuracy: ecliptic longitude ~0.01°, declination ~0.01°.
export function sunEciDirection(date) {
    const n = daysSinceJ2000(date);
    // Mean longitude and mean anomaly of the Sun (degrees).
    let L = (280.460 + 0.9856474 * n) % 360;
    let g = (357.528 + 0.9856003 * n) % 360;
    if (L < 0) L += 360;
    if (g < 0) g += 360;
    const gRad = g * DEG;
    // Ecliptic longitude (degrees); ecliptic latitude ≈ 0.
    const lambda = (L + 1.915 * Math.sin(gRad) + 0.020 * Math.sin(2 * gRad)) * DEG;
    // Obliquity of the ecliptic (degrees -> radians).
    const eps = (23.439 - 0.0000004 * n) * DEG;
    // Geocentric equatorial unit vector toward the Sun.
    return {
        x: Math.cos(lambda),
        y: Math.cos(eps) * Math.sin(lambda),
        z: Math.sin(eps) * Math.sin(lambda),
    };
}

// Greenwich Mean Sidereal Time (radians), IAU 1982 — matches satellite.js gstime.
// Provided for standalone night-side computation; the engine prefers
// satellite.gstime so Sun and satellites share one rotation.
export function gmstRad(date) {
    const jd = julianDate(date);
    const T = (jd - 2451545.0) / 36525.0;
    let g = 67310.54841 +
        (876600.0 * 3600 + 8640184.812866) * T +
        0.093104 * T * T -
        6.2e-6 * T * T * T; // seconds of time
    g = ((g % 86400) + 86400) % 86400;       // seconds
    let rad = (g / 240) * DEG;               // 240 s = 1° ; ->degrees ->radians
    rad %= 2 * Math.PI;
    if (rad < 0) rad += 2 * Math.PI;
    return rad;
}

// Sub-solar point (lat, lon °) — where the Sun is at the zenith.
export function subsolarPoint(date) {
    const d = sunEciDirection(date);
    const dec = Math.asin(d.z) * RAD;                 // = declination
    const raRad = Math.atan2(d.y, d.x);               // right ascension
    let lon = (raRad - gmstRad(date)) * RAD;          // ECEF longitude
    lon = ((lon + 180) % 360 + 360) % 360 - 180;      // wrap to [-180,180]
    return { lat: dec, lon };
}

// Sun elevation (°) above the geometric horizon at a geodetic location/time.
// Used to find the productive band (when flares are possible). Uses a spherical
// approximation (sub-solar great-circle angle) — sufficient for band selection.
export function sunElevationDeg(latDeg, lonDeg, date) {
    const sp = subsolarPoint(date);
    const φ1 = latDeg * DEG, φ2 = sp.lat * DEG;
    const dλ = (sp.lon - lonDeg) * DEG;
    const cosZ = Math.sin(φ1) * Math.sin(φ2) + Math.cos(φ1) * Math.cos(φ2) * Math.cos(dλ);
    return Math.asin(Math.max(-1, Math.min(1, cosZ))) * RAD;
}

// Equatorial (RA/Dec, J2000-ish, degrees) -> horizontal (alt, az) for an observer.
// az is measured from North, clockwise (N=0°, E=90°). Standard hour-angle transform;
// ignores refraction and precession (<0.4° over a couple of decades) — fine for a
// "where to look" sky chart. Used to place bright stars on the horizon view.
export function equatorialToAltAz(raDeg, decDeg, latDeg, lonDeg, date) {
    const ra = raDeg * DEG, dec = decDeg * DEG, lat = latDeg * DEG;
    const lst = gmstRad(date) + lonDeg * DEG;     // local sidereal time (east-positive lon)
    const H = lst - ra;                            // hour angle
    const clamp = (x) => (x < -1 ? -1 : x > 1 ? 1 : x);
    const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(H);
    const alt = Math.asin(clamp(sinAlt));
    let az = Math.acos(clamp((Math.sin(dec) - Math.sin(alt) * Math.sin(lat)) /
        (Math.cos(alt) * Math.cos(lat))));
    if (Math.sin(H) > 0) az = 2 * Math.PI - az;    // object is west of the meridian
    return { altDeg: alt * RAD, azDeg: ((az * RAD) % 360 + 360) % 360 };
}

// ---------------------------------------------------------------------------
// Low-precision planet & Moon positions (Paul Schlyter's method). Accuracy is
// ~1–2 arcmin for the Moon and a fraction of a degree for the bright planets
// over a few decades — ample for a "where to look" sky chart. Returns geocentric
// equatorial RA/Dec in degrees; feed into equatorialToAltAz like a star.
// ---------------------------------------------------------------------------
const sind = (x) => Math.sin(x * DEG);
const cosd = (x) => Math.cos(x * DEG);
const atan2d = (y, x) => Math.atan2(y, x) * RAD;
const rev = (x) => ((x % 360) + 360) % 360;

// Schlyter day number: days since 2000 Jan 0.0 UT (JD 2451543.5).
function dayNumber(date) { return julianDate(date) - 2451543.5; }

// Eccentric anomaly (deg) from mean anomaly M (deg) and eccentricity e.
function eccAnomaly(M, e) {
    M = rev(M);
    let E = M + RAD * e * sind(M) * (1 + e * cosd(M));
    for (let k = 0; k < 8; k++) {
        const dE = (E - RAD * e * sind(E) - M) / (1 - e * cosd(E));
        E -= dE;
        if (Math.abs(dE) < 1e-6) break;
    }
    return E;
}

const obliquity = (d) => 23.4393 - 3.563e-7 * d;

// Sun's geocentric ecliptic rectangular coords (AU) + mean anomaly/perihelion.
function sunRect(d) {
    const w = 282.9404 + 4.70935e-5 * d;
    const e = 0.016709 - 1.151e-9 * d;
    const M = 356.0470 + 0.9856002585 * d;
    const E = eccAnomaly(M, e);
    const xv = cosd(E) - e, yv = Math.sqrt(1 - e * e) * sind(E);
    const lon = rev(atan2d(yv, xv) + w);
    const r = Math.hypot(xv, yv);
    return { xs: r * cosd(lon), ys: r * sind(lon), M, w };
}

// Convert ecliptic rectangular (xg,yg,zg) to equatorial RA/Dec (deg).
function eclRectToRaDec(xg, yg, zg, d) {
    const o = obliquity(d);
    const xe = xg;
    const ye = yg * cosd(o) - zg * sind(o);
    const ze = yg * sind(o) + zg * cosd(o);
    return { raDeg: rev(atan2d(ye, xe)), decDeg: atan2d(ze, Math.hypot(xe, ye)) };
}

// Orbital elements (Schlyter): each [value@epoch, per-day rate]. deg / AU.
const PLANET_ELEMENTS = {
    Venus:   { N: [76.6799, 2.46590e-5], i: [3.3946, 2.75e-8],  w: [54.8910, 1.38374e-5], a: [0.723330, 0], e: [0.006773, -1.302e-9], M: [48.0052, 1.6021302244] },
    Mars:    { N: [49.5574, 2.11081e-5], i: [1.8497, -1.78e-8], w: [286.5016, 2.92961e-5], a: [1.523688, 0], e: [0.093405, 2.516e-9], M: [18.6021, 0.5240207766] },
    Jupiter: { N: [100.4542, 2.76854e-5], i: [1.3030, -1.557e-7], w: [273.8777, 1.64505e-5], a: [5.20256, 0], e: [0.048498, 4.469e-9], M: [19.8950, 0.0830853001] },
    Saturn:  { N: [113.6634, 2.38980e-5], i: [2.4886, -1.081e-7], w: [339.3939, 2.97661e-5], a: [9.55475, 0], e: [0.055546, -9.499e-9], M: [316.9670, 0.0334442282] },
};
const el = (pair, d) => pair[0] + pair[1] * d;

// Geocentric equatorial RA/Dec (deg) of a bright planet.
export function planetEquatorial(name, date) {
    const els = PLANET_ELEMENTS[name];
    if (!els) return null;
    const d = dayNumber(date);
    const N = el(els.N, d), i = el(els.i, d), w = el(els.w, d);
    const a = el(els.a, d), e = el(els.e, d), M = el(els.M, d);
    const E = eccAnomaly(M, e);
    const xv = a * (cosd(E) - e), yv = a * Math.sqrt(1 - e * e) * sind(E);
    const v = atan2d(yv, xv), r = Math.hypot(xv, yv), vw = v + w;
    // heliocentric ecliptic
    const xh = r * (cosd(N) * cosd(vw) - sind(N) * sind(vw) * cosd(i));
    const yh = r * (sind(N) * cosd(vw) + cosd(N) * sind(vw) * cosd(i));
    const zh = r * (sind(vw) * sind(i));
    // geocentric ecliptic = heliocentric planet + geocentric Sun
    const s = sunRect(d);
    return eclRectToRaDec(xh + s.xs, yh + s.ys, zh, d);
}

// Geocentric equatorial RA/Dec (deg) of the Moon, with the main perturbations.
export function moonEquatorial(date) {
    const d = dayNumber(date);
    const N = 125.1228 - 0.0529538083 * d;
    const i = 5.1454;
    const w = 318.0634 + 0.1643573223 * d;
    const a = 60.2666, e = 0.054900;
    const M = 115.3654 + 13.0649929509 * d;
    const E = eccAnomaly(M, e);
    const xv = a * (cosd(E) - e), yv = a * Math.sqrt(1 - e * e) * sind(E);
    const v = atan2d(yv, xv), r = Math.hypot(xv, yv), vw = v + w;
    const xh = r * (cosd(N) * cosd(vw) - sind(N) * sind(vw) * cosd(i));
    const yh = r * (sind(N) * cosd(vw) + cosd(N) * sind(vw) * cosd(i));
    const zh = r * (sind(vw) * sind(i));
    let lon = atan2d(yh, xh), lat = atan2d(zh, Math.hypot(xh, yh));
    // perturbations
    const s = sunRect(d);
    const Ms = s.M, Ls = rev(s.M + s.w);
    const Mm = M, Lm = rev(N + w + M);
    const D = rev(Lm - Ls), F = rev(Lm - N);
    lon += -1.274 * sind(Mm - 2 * D) + 0.658 * sind(2 * D) - 0.186 * sind(Ms)
        - 0.059 * sind(2 * Mm - 2 * D) - 0.057 * sind(Mm - 2 * D + Ms) + 0.053 * sind(Mm + 2 * D)
        + 0.046 * sind(2 * D - Ms) + 0.041 * sind(Mm - Ms) - 0.035 * sind(D)
        - 0.031 * sind(Mm + Ms) - 0.015 * sind(2 * F - 2 * D) + 0.011 * sind(Mm - 4 * D);
    lat += -0.173 * sind(F - 2 * D) - 0.055 * sind(Mm - F - 2 * D) - 0.046 * sind(Mm + F - 2 * D)
        + 0.033 * sind(F + 2 * D) + 0.017 * sind(2 * Mm + F);
    const xg = r * cosd(lon) * cosd(lat), yg = r * sind(lon) * cosd(lat), zg = r * sind(lat);
    return eclRectToRaDec(xg, yg, zg, d);
}
