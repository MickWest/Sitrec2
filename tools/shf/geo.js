// geo.js — WGS84 geodesy, ECEF/ENU geometry and great-circle helpers.
//
// Conventions shared by the whole Starlink-flare app:
//   * ALL distances are in KILOMETRES.
//   * Angles in the public API are in DEGREES (internal trig uses radians).
//   * Vectors are plain {x, y, z} objects in the ECEF frame
//     (Earth-Centered, Earth-Fixed; X→(0°N,0°E), Z→north pole).
//
// The flare geometry mirrors Sitrec's CSatellite/CNodeDisplayNightSky exactly:
//   - getLocalUpVector  -> localUp        (geodetic ellipsoid normal)
//   - getLocalNorthVector/EastVector -> localEnu
//   - rayIntersectsEllipsoid -> rayHitsEllipsoid (identical quadratic)
//   - Three.js Vector3.reflect -> vreflect
//
// Pure ES module, no dependencies, runs unchanged in the browser and in Node.

export const WGS84 = {
    a: 6378.137,            // equatorial radius (km), exact
    b: 6356.752314245,      // polar radius (km) = a*(1 - 1/298.257223563)
};

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// ---- tiny vector helpers (operate on {x,y,z}) -----------------------------
export const vadd   = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vsub   = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vscale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vdot   = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const vlen   = (a) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const vcross = (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
});
export function vnorm(a) {
    const L = vlen(a) || 1;
    return { x: a.x / L, y: a.y / L, z: a.z / L };
}
// Reflect direction d about unit normal n — matches Three.js Vector3.reflect:
//   r = d - 2*(d·n)*n
export function vreflect(d, n) {
    const k = 2 * vdot(d, n);
    return { x: d.x - k * n.x, y: d.y - k * n.y, z: d.z - k * n.z };
}

// ---- geodetic conversions -------------------------------------------------

// Radius of curvature in the prime vertical at geodetic latitude (radians).
function primeVertical(latRad) {
    const a = WGS84.a, b = WGS84.b;
    const e2 = (a * a - b * b) / (a * a);
    const s = Math.sin(latRad);
    return a / Math.sqrt(1 - e2 * s * s);
}

// LLA (degrees, km) -> ECEF {x,y,z} (km). Matches Sitrec RLLAToECEF_radii.
export function llaToEcef(latDeg, lonDeg, altKm = 0) {
    const lat = latDeg * DEG, lon = lonDeg * DEG;
    const a = WGS84.a, b = WGS84.b;
    const N = primeVertical(lat);
    const ratio = (b * b) / (a * a);
    const cosLat = Math.cos(lat);
    return {
        x: (N + altKm) * cosLat * Math.cos(lon),
        y: (N + altKm) * cosLat * Math.sin(lon),
        z: (ratio * N + altKm) * Math.sin(lat),
    };
}

// ECEF {x,y,z} (km) -> {lat, lon, altKm} (degrees, km). Iterative Bowring.
export function ecefToLla(p) {
    const a = WGS84.a, b = WGS84.b;
    const a2 = a * a, b2 = b * b;
    const e2 = (a2 - b2) / a2;
    const ep2 = (a2 - b2) / b2;
    const X = p.x, Y = p.y, Z = p.z;
    const pr = Math.sqrt(X * X + Y * Y);
    const theta = Math.atan2(Z * a, pr * b);
    const st = Math.sin(theta), ct = Math.cos(theta);
    let lat = Math.atan2(Z + ep2 * b * st * st * st, pr - e2 * a * ct * ct * ct);
    for (let i = 0; i < 5; i++) {
        const sinLat = Math.sin(lat);
        const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
        const newLat = Math.atan2(Z + e2 * N * sinLat, pr);
        if (Math.abs(newLat - lat) < 1e-14) { lat = newLat; break; }
        lat = newLat;
    }
    const lon = Math.atan2(Y, X);
    const N = primeVertical(lat);
    const cosLat = Math.cos(lat);
    const altKm = Math.abs(cosLat) > 1e-10
        ? pr / cosLat - N
        : Math.abs(Z) / Math.abs(Math.sin(lat)) - N * (1 - e2);
    return { lat: lat * RAD, lon: lon * RAD, altKm };
}

// ---- local frame (ENU) ----------------------------------------------------

// Geodetic ellipsoid normal at an ECEF point — Sitrec getLocalUpVector.
// Outward normal to x²/a² + y²/a² + z²/b² = 1 is proportional to (X/a², Y/a², Z/b²).
export function localUp(p) {
    const a2 = WGS84.a * WGS84.a, b2 = WGS84.b * WGS84.b;
    return vnorm({ x: p.x / a2, y: p.y / a2, z: p.z / b2 });
}

// Geocentric (spherical) nadir-up: straight from Earth's centre.
export function geocentricUp(p) {
    return vnorm(p);
}

// East/North/Up basis at an ECEF point. Replicates Sitrec's getLocalNorthVector
// (project the to-north-pole vector perpendicular to up) and getLocalEastVector
// (east = up × south, south = -north).
export function localEnu(p) {
    const up = localUp(p);
    const northPole = { x: 0, y: 0, z: WGS84.b };
    const toNorth = vnorm(vsub(northPole, p));
    const d = vdot(toNorth, up);
    const north = vnorm(vsub(toNorth, vscale(up, d)));
    const south = vscale(north, -1);
    const east = vcross(up, south);
    return { east, north, up };
}

// Azimuth (°, 0=N, 90=E, clockwise), elevation (°), range (km) of a target ECEF
// point as seen from an observer ECEF point.
export function azElFromObserver(observerEcef, targetEcef) {
    const los = vsub(targetEcef, observerEcef);
    const rangeKm = vlen(los);
    const dir = vscale(los, 1 / (rangeKm || 1));
    const { east, north, up } = localEnu(observerEcef);
    const e = vdot(dir, east);
    const n = vdot(dir, north);
    const u = vdot(dir, up);
    let az = Math.atan2(e, n) * RAD;
    if (az < 0) az += 360;
    const el = Math.asin(Math.max(-1, Math.min(1, u))) * RAD;
    return { azDeg: az, elDeg: el, rangeKm };
}

// Ray/ellipsoid intersection — identical maths to Sitrec rayIntersectsEllipsoid.
// Returns true if the ray (origin + t*direction, t>0) meets the WGS84 ellipsoid.
// Used both for the horizon test (observer→sat) and the Earth-shadow test (sat→sun).
export function rayHitsEllipsoid(origin, direction) {
    const a = WGS84.a, b = WGS84.b;
    const a2 = a * a, b2 = b * b;
    const { x: ox, y: oy, z: oz } = origin;
    const { x: dx, y: dy, z: dz } = direction;
    const A = (dx * dx + dy * dy) / a2 + (dz * dz) / b2;
    const B = 2 * ((ox * dx + oy * dy) / a2 + (oz * dz) / b2);
    const C = (ox * ox + oy * oy) / a2 + (oz * oz) / b2 - 1;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return false;
    const sq = Math.sqrt(disc);
    const t1 = (-B - sq) / (2 * A);
    const t2 = (-B + sq) / (2 * A);
    return t1 > 0 || t2 > 0;
}

// ---- compass --------------------------------------------------------------
const COMPASS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                   "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export function compass16(azDeg) {
    const i = Math.round(((azDeg % 360) + 360) % 360 / 22.5) % 16;
    return COMPASS16[i];
}

// ---- great-circle (spherical) ---------------------------------------------

// Interpolate fraction f∈[0,1] along the great circle from A to B (lat/lon °).
// Spherical slerp of the unit vectors — independent of altitude.
export function greatCircleInterpolate(latA, lonA, latB, lonB, f) {
    const φ1 = latA * DEG, λ1 = lonA * DEG;
    const φ2 = latB * DEG, λ2 = lonB * DEG;
    const A = { x: Math.cos(φ1) * Math.cos(λ1), y: Math.cos(φ1) * Math.sin(λ1), z: Math.sin(φ1) };
    const B = { x: Math.cos(φ2) * Math.cos(λ2), y: Math.cos(φ2) * Math.sin(λ2), z: Math.sin(φ2) };
    let dot = Math.max(-1, Math.min(1, vdot(A, B)));
    const Ω = Math.acos(dot);
    let P;
    if (Ω < 1e-9) {
        P = A; // coincident endpoints
    } else {
        const s1 = Math.sin((1 - f) * Ω) / Math.sin(Ω);
        const s2 = Math.sin(f * Ω) / Math.sin(Ω);
        P = { x: A.x * s1 + B.x * s2, y: A.y * s1 + B.y * s2, z: A.z * s1 + B.z * s2 };
    }
    const lat = Math.atan2(P.z, Math.sqrt(P.x * P.x + P.y * P.y)) * RAD;
    const lon = Math.atan2(P.y, P.x) * RAD;
    return { lat, lon };
}

// Great-circle distance (km) on the WGS84 mean radius — haversine.
export function greatCircleDistanceKm(latA, lonA, latB, lonB) {
    const R = (2 * WGS84.a + WGS84.b) / 3; // mean radius
    const dφ = (latB - latA) * DEG;
    const dλ = (lonB - lonA) * DEG;
    const s = Math.sin(dφ / 2) ** 2 +
        Math.cos(latA * DEG) * Math.cos(latB * DEG) * Math.sin(dλ / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Initial great-circle bearing (°, 0=N) from A to B.
export function bearingDeg(latA, lonA, latB, lonB) {
    const φ1 = latA * DEG, φ2 = latB * DEG;
    const dλ = (lonB - lonA) * DEG;
    const y = Math.sin(dλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
    let brg = Math.atan2(y, x) * RAD;
    return (brg + 360) % 360;
}
