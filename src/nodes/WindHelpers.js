// Pure wind-math helpers — extracted from CNodeDisplayWindField so they
// can be unit-tested without pulling in three.js and the full node graph.
//
// Conventions:
//   u = east component (m/s), v = north component (m/s)
//   "from" direction in degrees = the heading the wind is coming FROM
//   (met convention — opposite of the direction the air is flowing TO)

import {knotsFromMetersPerSecond, metersPerSecondFromKnots} from "../utils";

// Normalize the mixed timestamp representations accepted by Sitrec's MISB
// importers to milliseconds since Unix epoch. Native ST 0601 values are
// microseconds; converted CSV sources may contain seconds, milliseconds,
// Date objects, or ISO strings.
export function normalizeWindTimestampMs(raw) {
    if (raw instanceof Date) return raw.valueOf();
    if (typeof raw === "number" && Number.isFinite(raw)) {
        if (raw > 31568461000000) return raw / 1000; // microseconds -> ms
        if (raw < 31568461000) return raw * 1000;    // seconds -> ms
        return raw;
    }
    const parsed = typeof raw === "string" ? Date.parse(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : NaN;
}

// Pressure-level ↔ altitude mapping (approximate standard atmosphere)
// Sorted low-to-high altitude. "surface" is a special 10m-above-ground product.
// Levels through 200 hPa are fetched routinely; the stratospheric levels
// (150 hPa and up) are fetched LAZILY — only when an altitude above 38,600 ft
// is actually sampled/displayed — since high-altitude wind is rarely needed
// (a balloon can climb to ~100k ft). ft values match fetch_wind.py's
// LEVEL_ALT_FT (standard-atmosphere geopotential heights); the GFS proxy +
// fetch_wind.py already serve every level up to 10 hPa.
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
    {level: "150",     ft: 44600},
    {level: "100",     ft: 53200},
    {level: "70",      ft: 60700},
    {level: "50",      ft: 67500},
    {level: "30",      ft: 78100},
    {level: "20",      ft: 86900},
    {level: "10",      ft: 101000},
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

// The 6-hour GFS cycle a date falls in: {dateStr: "YYYYMMDD", hour: 0|6|12|18}.
export function gfsCycleFor(date) {
    const d = date instanceof Date && Number.isFinite(date.valueOf()) ? date : new Date();
    return {
        dateStr: d.toISOString().slice(0, 10).replace(/-/g, ""),
        hour: Math.floor(d.getUTCHours() / 6) * 6,
    };
}

// The two grid times around a time, and the weight of the later one (decision
// D5, 2026-11-02: interpolate between the cycles, not take the one at or before
// the time). cadenceH: hours between the grids, a divisor of 24 (6 for GFS; an
// installation's grid source can set its own). Returns {c0, c1, w}: c0 and c1
// are {dateStr: "YYYYMMDD", hour, ms}, and the wind at ms is (1 - w) × c0 + w × c1.
// Before 2026-11-03 a point used the cycle at or before its time alone, so the
// wind jumped at each cycle and was up to 6 h old.
export function gridTimesAround(ms, cadenceH = 6) {
    const stepMs = cadenceH * 3600000;
    const t = Number.isFinite(ms) ? ms : Date.now();
    const t0 = Math.floor(t / stepMs) * stepMs;
    const at = (when) => {
        const d = new Date(when);
        return {dateStr: d.toISOString().slice(0, 10).replace(/-/g, ""), hour: d.getUTCHours(), ms: when};
    };
    return {c0: at(t0), c1: at(t0 + stepMs), w: (t - t0) / stepMs};
}

// A cadence in hours from a setting: a whole divisor of 24, else the default.
export function gridCadenceFromSetting(value, fallbackH = 6) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 && 24 % n === 0 ? n : fallbackH;
}

// Height (m) above the ground of the GFS "surface" wind, the 10 m product.
export const GFS_SURFACE_AGL_M = 10;

// The two GFS levels to blend for a height, with the ground under the point.
//
// The column at a place is the 10 m product at the ground + 10 m, then each
// pressure level above that, at its height there: `heights` ({level: m}, the
// level's geopotential height at the point, from the grid's hgt field) where it
// is given, else its standard-atmosphere height (WIND_LEVEL_TABLE). Until
// 2026-11-03 every level was at its standard height, which is off by up to a few
// hundred metres in a strong high or low.
// A pressure level under the ground carries a value the model extrapolated, not
// a wind, so it is left out; between the 10 m wind and the first level above
// the ground the wind is interpolated. Before 2026-11-03 the 10 m product sat at
// 33 ft MSL everywhere, so over high ground a low target was given a blend of
// two levels under the ground.
//
// altM and groundM are metres MSL. groundM null (no terrain) is sea level, and
// then no point is "below-ground". Returns {lo, hi, t, status}: lo and hi are
// {level, altM}; status is "ok", "held-below" (between the ground and the
// 10 m wind), "held-above" (above the highest level) or "below-ground".
export function gridColumnBracket(altM, groundM = null, heights = null) {
    const column = gridColumn(groundM, heights);
    const bottom = column[0];
    const top = column[column.length - 1];
    if (Number.isFinite(groundM) && altM < groundM) {
        return {lo: bottom, hi: bottom, t: 0, status: "below-ground"};
    }
    if (altM <= bottom.altM) {
        return altM < bottom.altM
            ? {lo: bottom, hi: bottom, t: 0, status: "held-below", limitM: bottom.altM}
            : {lo: bottom, hi: bottom, t: 0, status: "ok"};
    }
    if (altM >= top.altM) {
        return altM > top.altM
            ? {lo: top, hi: top, t: 0, status: "held-above", limitM: top.altM}
            : {lo: top, hi: top, t: 0, status: "ok"};
    }
    for (let i = 0; i < column.length - 1; i++) {
        const lo = column[i], hi = column[i + 1];
        if (altM >= lo.altM && altM <= hi.altM) {
            return {lo, hi, t: (altM - lo.altM) / (hi.altM - lo.altM), status: "ok"};
        }
    }
    return {lo: bottom, hi: bottom, t: 0, status: "ok"};
}

// The GFS levels at a place, lowest first: [{level, altM}]. See gridColumnBracket.
// A level that is not above the level below it (heights from two sources that
// disagree) is left out, so the column always rises.
export function gridColumn(groundM = null, heights = null) {
    const ground = Number.isFinite(groundM) ? groundM : 0;
    const surfaceM = ground + GFS_SURFACE_AGL_M;
    const column = [{level: "surface", altM: surfaceM}];
    for (const entry of WIND_LEVEL_TABLE) {
        if (entry.level === "surface") continue;
        const given = heights?.[entry.level];
        const levelM = Number.isFinite(given) ? given : entry.ft * 0.3048;
        if (levelM > column[column.length - 1].altM) column.push({level: entry.level, altM: levelM});
    }
    return column;
}

// Wind at a height from a column of levels [{altM, u, v}], lowest first:
// interpolated by components between the two levels around altM, and the end
// level's wind held below the lowest and above the highest. Returns
// {u, v, status} ("ok", "held-below", "held-above"), or null for no levels.
// A held value also has limitM: the height (m MSL) of the level it is from.
export function columnWindAt(levels, altM) {
    if (!levels || levels.length === 0) return null;
    const bottom = levels[0];
    const top = levels[levels.length - 1];
    if (altM < bottom.altM) return {u: bottom.u, v: bottom.v, status: "held-below", limitM: bottom.altM};
    if (altM > top.altM) return {u: top.u, v: top.v, status: "held-above", limitM: top.altM};
    for (let i = 0; i < levels.length - 1; i++) {
        const lo = levels[i], hi = levels[i + 1];
        if (altM >= lo.altM && altM <= hi.altM) {
            const t = hi.altM > lo.altM ? (altM - lo.altM) / (hi.altM - lo.altM) : 0;
            return {u: (1 - t) * lo.u + t * hi.u, v: (1 - t) * lo.v + t * hi.v, status: "ok"};
        }
    }
    return {u: top.u, v: top.v, status: "ok"};
}

// ── How the Wind panel shows a speed and a height ────────────────────
//
// Speeds: in the speed unit of Units (kt, mph or km/h), or in knots when "Wind in
// Knots" is on (decision D4, 2026-11-02). The "Feet only" units have feet per hour
// as their speed, which is no unit for a wind, so they show knots too.
// Returns {abbrev, fromKnots}: a speed in knots times fromKnots is the speed in
// the unit. `units` is the CUnits object (Globals.Units), or null.
export const METERS_PER_SECOND_PER_KNOT = 1852 / 3600;
export function windSpeedUnit(units, inKnots = false) {
    const speed = !inKnots && units && units.units !== "feet" ? units.speed : null;
    if (!speed || !(speed.toM > 0) || !speed.abbrev) return {abbrev: "kt", fromKnots: 1};
    return {abbrev: speed.abbrev, fromKnots: METERS_PER_SECOND_PER_KNOT / speed.toM};
}

// "12 kt" for a speed in knots, in a unit from windSpeedUnit.
export function windSpeedText(knots, unit) {
    return Number.isFinite(knots) ? `${Math.round(knots * unit.fromKnots)} ${unit.abbrev}` : "–";
}

// "2025-09-19 12Z" for a time on the hour, else "2025-09-19 12:34Z"; null for
// no time. The data time on the Status line and in the readouts.
export function dataTimeText(ms) {
    const date = new Date(ms);
    if (ms == null || !Number.isFinite(date.valueOf())) return null;
    const iso = date.toISOString();
    const hhmm = iso.slice(11, 16);
    return `${iso.slice(0, 10)} ${hhmm.endsWith(":00") ? hhmm.slice(0, 2) : hhmm}Z`;
}

// Heights: in the height unit of Units (its "small" unit): feet for Nautical,
// Imperial/US and Feet only, metres for Metric (Mick, 2026-11-03). Wind in Knots
// changes the speeds only. Returns {abbrev, toM}: a height in metres divided by
// toM is the height in the unit. `units` is the CUnits object, or null (feet).
export const FEET_UNIT = Object.freeze({abbrev: "ft", toM: 0.3048});
export function windHeightUnit(units) {
    const small = units?.small;
    return small && small.toM > 0 && small.abbrev ? {abbrev: small.abbrev, toM: small.toM} : FEET_UNIT;
}

// "1,200 ft" (or "366 m") for a height in metres, in a unit from windHeightUnit.
// Heights on the Wind panel are numbers: until 2026-11-03 every height under
// 300 ft was shown as "Surface", and every height was in feet.
export function heightText(altM, unit = FEET_UNIT) {
    return `${Math.round(altM / unit.toM).toLocaleString()} ${unit.abbrev}`;
}

// Where to put the Show Wind at readout boxes, so that they do not cover each
// other or the menus (they did both until 2026-11-03).
//
// items: [{anchor: {x, y}, w, h}] in screen pixels, most important first (the
// cursor, then the camera and target). blocked: [{left, top, right, bottom}],
// the menus. Each box goes to the first of the four corners around its anchor
// that is clear and on the screen; when none is, to the corner that covers the
// least (a menu counts four times another box, and a box pushed back onto the
// screen covers its own anchor), and then down past a box that it still covers.
// Returns [{left, top}], in the order of items.
export function placeReadoutBoxes(items, blocked, screenW, screenH, margin = 18) {
    const overlap = (r, rects) => {
        let area = 0;
        for (const b of rects) {
            const w = Math.min(r.right, b.right) - Math.max(r.left, b.left);
            const h = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
            if (w > 0 && h > 0) area += w * h;
        }
        return area;
    };
    const box = (left, top, w, h) => {
        const l = Math.max(0, Math.min(left, screenW - w));
        const t = Math.max(0, Math.min(top, screenH - h));
        return {left: l, top: t, right: l + w, bottom: t + h};
    };
    const placed = [];
    for (const {anchor, w, h} of items) {
        const {x, y} = anchor;
        const corners = [[x + margin, y + margin], [x + margin, y - margin - h],
            [x - margin - w, y + margin], [x - margin - w, y - margin - h]];
        let best = null, bestCost = Infinity;
        for (const [left, top] of corners) {
            const r = box(left, top, w, h);
            const pushed = Math.abs(r.left - left) + Math.abs(r.top - top);
            const cost = 4 * overlap(r, blocked) + overlap(r, placed) + pushed * h;
            if (cost < bestCost) {
                best = r;
                bestCost = cost;
                if (cost === 0) break;
            }
        }
        for (let i = 0; i < placed.length; i++) {
            const hit = placed.find(b => overlap(best, [b]) > 0);
            if (!hit || hit.bottom + 2 + h > screenH) break;
            best = box(best.left, hit.bottom + 2, w, h);
        }
        placed.push(best);
    }
    return placed.map(r => ({left: r.left, top: r.top}));
}

// Summary of a wind series (one {from, knots} per frame; null entries are
// skipped): speed min, median and max, and the direction of the vector mean.
// Null for an empty series. The traverse analysis reports the wind it used
// with this, not one value.
export function windSeriesSummary(series) {
    const speeds = [];
    let e = 0, n = 0;
    for (const w of series) {
        if (!w || !Number.isFinite(w.from) || !Number.isFinite(w.knots)) continue;
        speeds.push(w.knots);
        const to = (w.from + 180) * Math.PI / 180;
        e += w.knots * Math.sin(to);
        n += w.knots * Math.cos(to);
    }
    if (speeds.length === 0) return null;
    speeds.sort((a, b) => a - b);
    const meanFrom = ((Math.atan2(e, n) * 180 / Math.PI + 180) % 360 + 360) % 360;
    return {
        count: speeds.length,
        minKnots: speeds[0],
        medianKnots: speeds[Math.floor(speeds.length / 2)],
        maxKnots: speeds[speeds.length - 1],
        meanFrom,
    };
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

// Bilinear sample of one field (a flat array in the grid's layout, such as
// json.hgt) of a GFS-style grid JSON at (lat, lon).
export function sampleJSONScalar(json, values, lat, lon) {
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
    return (1 - si) * (1 - sj) * values[j0 * json.nx + i0] + si * (1 - sj) * values[j0 * json.nx + i1]
        + (1 - si) * sj * values[j1 * json.nx + i0] + si * sj * values[j1 * json.nx + i1];
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

// MISB ST 0601 tag 36 (WindSpeed) is METRES PER SECOND. Sitrec's wind nodes and
// GUI work in knots, so every read of that tag converts through here, in one
// place. Sonde-derived profiles do NOT come through here: CTrackFileSonde
// stores m/s in the tag and CNodeAtmosphericProfile keeps m/s all the way to
// fromDirSpeedToUV, which takes m/s. Only the track-as-wind-source path needs
// this conversion.
export function knotsFromMISBWindSpeed(metersPerSecond) {
    return knotsFromMetersPerSecond(metersPerSecond);
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
