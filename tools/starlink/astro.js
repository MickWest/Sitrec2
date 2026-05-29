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
// Provided for standalone use (twilight window); the engine prefers
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
// Used to find the productive twilight window. Uses a spherical approximation
// (sub-solar great-circle angle) — sufficient for window selection.
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
