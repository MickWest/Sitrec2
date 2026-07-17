// Pure math helpers for the track CSV exporters (CNodeTrack).
// Deliberately dependency-free (no Three.js, no Globals) so Jest can unit-test
// the truth-column math without pulling in the node graph.

// The truth_* CSV columns follow the client CSV convention that
// CTrackFileMISB imports: altitude in FEET (MSL), heading in degrees true,
// speed in knots (horizontal ground speed).
export const METERS_PER_FOOT = 0.3048;
export const KNOTS_PER_METER_PER_SECOND = 1.94384449;

// Local ENU basis vectors at a geodetic lat/lon (degrees), expressed in ECEF
// axes as plain {x,y,z} objects. Standard WGS84 tangent basis:
//   east  = (-sinLon,          cosLon,         0)
//   north = (-sinLat*cosLon, -sinLat*sinLon, cosLat)
export function enuBasisAt(latDeg, lonDeg) {
    const lat = latDeg * Math.PI / 180;
    const lon = lonDeg * Math.PI / 180;
    const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
    const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
    return {
        east:  {x: -sinLon,          y: cosLon,           z: 0},
        north: {x: -sinLat * cosLon, y: -sinLat * sinLon, z: cosLat},
        up:    {x: cosLat * cosLon,  y: cosLat * sinLon,  z: sinLat},
    };
}

// East/north/up components (meters) of the ECEF displacement a→b, using the
// ENU basis at the given lat/lon (degrees). a and b are {x,y,z} in meters.
export function ecefDisplacementToENU(a, b, latDeg, lonDeg) {
    const d = {x: b.x - a.x, y: b.y - a.y, z: b.z - a.z};
    const {east, north, up} = enuBasisAt(latDeg, lonDeg);
    const dot = (v, w) => v.x * w.x + v.y * w.y + v.z * w.z;
    return {east: dot(d, east), north: dot(d, north), up: dot(d, up)};
}

// Heading (degrees true, 0..360) and ground speed (knots) from a horizontal
// ENU displacement over dtSeconds. Returns null when dt is degenerate or the
// horizontal motion is too slow for a meaningful heading (< 0.05 m/s).
export function headingSpeedFromENU(eastM, northM, dtSeconds) {
    if (!(dtSeconds > 0)) return null;
    const speedMS = Math.hypot(eastM, northM) / dtSeconds;
    const speedKnots = speedMS * KNOTS_PER_METER_PER_SECOND;
    if (speedMS < 0.05) {
        // effectively hovering — report the (near zero) speed, no heading
        return {headingDeg: null, speedKnots};
    }
    let headingDeg = Math.atan2(eastM, northM) * 180 / Math.PI;
    if (headingDeg < 0) headingDeg += 360;
    return {headingDeg, speedKnots};
}
