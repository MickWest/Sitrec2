// Shared by water-mask rendering and calculation workers. Clamping also keeps
// water-mask spans and tile counts finite near the poles.
const MAX_MASK_LATITUDE = 85.05;
const DEG2RAD = Math.PI / 180;

/** Latitude, held inside the range Web Mercator is defined on. */
export function clampLatitude(latDeg) {
    return Math.max(-MAX_MASK_LATITUDE, Math.min(MAX_MASK_LATITUDE, latDeg));
}

/** Normalised Web Mercator x (0 at 180W, 1 at 180E). */
export function mercatorX(lonDeg) {
    return (lonDeg + 180) / 360;
}

/** Normalised Web Mercator y, using geodetic latitude in degrees.
 * Geocentric latitude can differ by 21 km on WGS84 and must not be used here. */
export function mercatorY(latDeg) {
    const lat = clampLatitude(latDeg) * DEG2RAD;
    return 0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI);
}
