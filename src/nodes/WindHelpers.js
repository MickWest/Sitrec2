// Pure wind-math helpers — extracted from CNodeDisplayWindField so they
// can be unit-tested without pulling in three.js and the full node graph.
//
// Conventions:
//   u = east component (m/s), v = north component (m/s)
//   "from" direction in degrees = the heading the wind is coming FROM
//   (met convention — opposite of the direction the air is flowing TO)

import {knotsFromMetersPerSecond, metersPerSecondFromKnots} from "../utils";

// Pressure-level ↔ altitude mapping (approximate standard atmosphere)
// Sorted low-to-high altitude. "surface" is a special 10m-above-ground product.
export const WIND_LEVEL_TABLE = [
    {level: "surface", ft: 33},
    {level: "1000",    ft: 360},
    {level: "925",     ft: 2500},
    {level: "850",     ft: 4800},
    {level: "700",     ft: 9900},
    {level: "500",     ft: 18300},
    {level: "300",     ft: 30000},
    {level: "250",     ft: 33800},
    {level: "200",     ft: 38600},
];

// Return the two bracketing levels and interpolation factor for an altitude (ft).
export function bracketingLevels(ft) {
    const T = WIND_LEVEL_TABLE;
    if (ft <= T[0].ft) return {lo: T[0], hi: T[0], t: 0};
    if (ft >= T[T.length - 1].ft) return {lo: T[T.length - 1], hi: T[T.length - 1], t: 0};
    for (let i = 0; i < T.length - 1; i++) {
        if (ft >= T[i].ft && ft <= T[i + 1].ft) {
            const range = T[i + 1].ft - T[i].ft;
            const t = range > 0 ? (ft - T[i].ft) / range : 0;
            return {lo: T[i], hi: T[i + 1], t};
        }
    }
    return {lo: T[0], hi: T[0], t: 0};
}

// Accepts:
//   "surface"            → 33 (the 10m product)
//   "500", "850", …      → pressure-level altitude from WIND_LEVEL_TABLE
//   "500ft", "3650ft", … → parsed numeric ft (used by blended JSON labels)
//   anything else        → 0
export function levelToAltFeet(level) {
    if (level === "surface") return 33;
    const entry = WIND_LEVEL_TABLE.find(e => e.level === level);
    if (entry) return entry.ft;
    if (typeof level === "string") {
        const m = level.match(/^(-?\d+(?:\.\d+)?)\s*ft$/i);
        if (m) return parseFloat(m[1]);
    }
    return 0;
}

// Bilinear sample of a GFS-style grid JSON at (lat,lon). Returns {u,v} in m/s.
export function sampleJSONGrid(json, lat, lon) {
    lon = ((lon % 360) + 360) % 360;
    lat = Math.max(-90, Math.min(90, lat));

    const fi = (lon - json.lon0) / json.dlon;
    const fj = (lat - json.lat0) / json.dlat;

    let i0 = Math.floor(fi);
    let j0 = Math.floor(fj);
    const si = fi - i0;
    const sj = fj - j0;

    i0 = ((i0 % json.nx) + json.nx) % json.nx;
    const i1 = (i0 + 1) % json.nx;
    j0 = Math.max(0, Math.min(j0, json.ny - 2));
    const j1 = j0 + 1;

    const w00 = (1 - si) * (1 - sj);
    const w10 = si * (1 - sj);
    const w01 = (1 - si) * sj;
    const w11 = si * sj;

    const a = j0 * json.nx + i0;
    const b = j0 * json.nx + i1;
    const c = j1 * json.nx + i0;
    const d = j1 * json.nx + i1;
    return {
        u: w00 * json.u[a] + w10 * json.u[b] + w01 * json.u[c] + w11 * json.u[d],
        v: w00 * json.v[a] + w10 * json.v[b] + w01 * json.v[c] + w11 * json.v[d],
    };
}

// (from-direction, speed-m/s) → (u,v) in m/s.
export function fromDirSpeedToUV(fromDeg, speedMS) {
    // Wind is going TO (from + 180°). u east-component, v north-component.
    const toRad = (fromDeg + 180) * Math.PI / 180;
    return {
        u: speedMS * Math.sin(toRad),
        v: speedMS * Math.cos(toRad),
    };
}

// (from-direction, speed-knots) → (u,v) in m/s.
export function fromDirSpeedKnotsToUV(fromDeg, knots) {
    return fromDirSpeedToUV(fromDeg, metersPerSecondFromKnots(knots));
}

// (u,v) in m/s → {from in deg, knots}.
export function fromUVToDirKnots(u, v) {
    const speedMS = Math.sqrt(u * u + v * v);
    const toDeg = Math.atan2(u, v) * 180 / Math.PI; // heading wind is going TO
    let from = (toDeg + 180) % 360;
    if (from < 0) from += 360;
    return {from, knots: knotsFromMetersPerSecond(speedMS)};
}

// Approximate great-circle distance on a unit sphere, in degrees (cheap).
export function greatCircleDistanceDeg(lat1, lon1, lat2, lon2) {
    const D = Math.PI / 180;
    const sLat = Math.sin((lat2 - lat1) * D / 2);
    const sLon = Math.sin((lon2 - lon1) * D / 2);
    const a = sLat * sLat + Math.cos(lat1 * D) * Math.cos(lat2 * D) * sLon * sLon;
    return 2 * Math.asin(Math.min(1, Math.sqrt(a))) * 180 / Math.PI;
}

// 16-point compass direction string from a degree value (0 = N, CW).
export function compassFromDeg(deg) {
    const points = ["N","NNE","NE","ENE","E","ESE","SE","SSE",
                    "S","SSW","SW","WSW","W","WNW","NW","NNW"];
    const idx = Math.floor(((deg % 360 + 360) % 360 + 11.25) / 22.5) % 16;
    return points[idx];
}

// Compute the wind-blow-TO unit vector (ECEF) at lat/lon for a given
// FROM-bearing in radians. If `out` has a `.set(x,y,z)` method (e.g. a
// Three.js Vector3), the result is written into it and `out` is returned;
// otherwise a plain {x,y,z} object is returned.
//
// Avoids the 12+ Vector3 allocations per call that getLocalNorthVector /
// getLocalEastVector incur — sphere approximation, sub-degree error vs
// ellipsoid, irrelevant for arrow direction visualization.
export function windDirFromBearing(latDeg, lonDeg, bearingFromRad, out) {
    const D = Math.PI / 180;
    const lat = latDeg * D;
    const lon = lonDeg * D;
    const sLat = Math.sin(lat), cLat = Math.cos(lat);
    const sLon = Math.sin(lon), cLon = Math.cos(lon);
    // ENU local basis at (lat, lon):
    //   north = (-sLat*cLon, -sLat*sLon, cLat)
    //   east  = (-sLon, cLon, 0)
    // arrow TO = (bearingFromRad+180°): cos = -cos(from), sin = -sin(from)
    const cFrom = Math.cos(bearingFromRad);
    const sFrom = Math.sin(bearingFromRad);
    const cTo = -cFrom, sTo = -sFrom;
    const nX = -sLat * cLon, nY = -sLat * sLon, nZ = cLat;
    const eX = -sLon,        eY =  cLon,        eZ = 0;
    const x = cTo * nX + sTo * eX;
    const y = cTo * nY + sTo * eY;
    const z = cTo * nZ + sTo * eZ;
    if (out && typeof out.set === "function") {
        out.set(x, y, z);
        return out;
    }
    return {x, y, z};
}
