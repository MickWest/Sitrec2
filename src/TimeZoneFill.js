// Time > Show Time Zones: the colored areas under the border lines. This module is the geometry
// only (no WebGL), so it can be tested on its own; TimeZoneBorders.js makes the mesh from it.
//
// Each face of the map (see scripts/buildTimeZoneBorders.js) is filled with a color for its UTC
// offset at the sitch time, with daylight saving time (zoneMapAt). The colors repeat every 6
// hours, as on an ordinary time zone map: UTC orange, +1 yellow, +2 green, +3 blue, +4 purple,
// +5 red, +6 orange again. Neighbouring whole hours always differ, and +13 has the color of
// -11, which has the same clock time a day earlier. A zone between two whole hours (India,
// UTC+5:30) has diagonal stripes of the two colors, as wide as the fraction: Nepal (UTC+5:45) is
// 3/4 the color of +6. A face that two zones cover (Xinjiang, UTC+8 and UTC+6) has stripes of
// both colors, half and half.
//
// The faces are triangulated in the longitude/latitude plane: a grid of extra points inside
// each face (steinerPoints), Earcut (three.js ShapeUtils), Delaunay edge flips (delaunayFlips),
// then splits until no edge is longer than FILL_MAX_EDGE_DEG (refineTriangles), so that the flat
// triangles follow the curve of the Earth closely enough for a color. On the 2026f "1970" data
// this is about 190,000 triangles, made once per session. The rings use the same points as
// the border lines (densifySegment), so a fill ends exactly on its line.

import {ShapeUtils, Vector2} from "three";
import {utcOffsetHoursInZone} from "./TimeZoneLookup";

// sRGB colors for standard offsets of 0, 1, 2, 3, 4 and 5 hours (mod 6): orange, yellow, green,
// blue, purple, red, as on an ordinary time zone map, but with the hues pushed apart. At 15%
// they must differ over land and sea: the first choice (0xff8c00 orange, 0xffd700 yellow) made
// UTC-6 and UTC-5 both brownish (color difference 7.9 over land, against 16.1 for these; the
// smallest difference between neighbours is now 11.4).
export const ZONE_PALETTE = [0xff5500, 0xffee00, 0x22cc33, 0x0088ff, 0xb040ff, 0xff2277];

// Border segments longer than this many degrees are split, because a straight ECEF line between
// two far points cuts under the curve of the Earth (the Western Australia border is a meridian
// for 1,500 km). The fill rings use the same points.
export const MAX_SEGMENT_DEG = 0.5;

// Fill triangles are split until each edge is at most this long, in degrees of latitude (a
// longitude difference counts times the cosine of the latitude). The middle of a 3-degree chord
// is 2.2 km under the surface, which the colors can take: the fill has no depth test, and its
// edges are on the border lines. On the 2026f "1970" data, 3 degrees is about 190,000 triangles
// (on the smaller "now" set, 1 degree was 450,000 and 3 degrees 127,000; 5 degrees saves little
// time but leaves a gap below the horizon of a low camera).
export const FILL_MAX_EDGE_DEG = 3;

// The palette index of a whole number of hours.
export const paletteIndex = hours => ((Math.round(hours) % 6) + 6) % 6;

// The fill of a face from the standard offsets (hours) of the zones that cover it:
// {a, b, fraction}: palette indices, and the part of each stripe period that has color b.
export function faceStyle(offsets) {
    const sorted = [...offsets].filter(Number.isFinite).sort((p, q) => p - q);
    if (sorted.length === 0) return null;
    if (sorted.length === 1) {
        const whole = Math.floor(sorted[0] + 1e-9);
        const fraction = sorted[0] - whole;
        return {a: paletteIndex(whole), b: paletteIndex(whole + 1), fraction: fraction < 1e-6 ? 0 : fraction};
    }
    // Two or more zones: stripes of the first two, half and half. Two colors that are the same
    // (UTC+5:30 and +5:45 both start at +5) use the next color for the second.
    const first = paletteIndex(Math.floor(sorted[0] + 1e-9));
    let second = paletteIndex(Math.floor(sorted[sorted.length - 1] + 1e-9));
    if (second === first) second = (first + 1) % 6;
    return {a: first, b: second, fraction: 0.5};
}

// Call push(lon, lat) for each point after the first of the segment from (lon0, lat0) to
// (lon1, lat1), splitting it into pieces of at most MAX_SEGMENT_DEG. lon1 is taken the short way
// from lon0 (across the 180-degree meridian when that is shorter), so the points can be past 180.
export function densifySegment(lon0, lat0, lon1In, lat1, push) {
    let lon1 = lon1In;
    if (lon1 - lon0 > 180) lon1 -= 360;
    else if (lon1 - lon0 < -180) lon1 += 360;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(lon1 - lon0), Math.abs(lat1 - lat0)) / MAX_SEGMENT_DEG));
    for (let s = 1; s <= steps; s++) {
        const f = s / steps;
        push(lon0 + (lon1 - lon0) * f, lat0 + (lat1 - lat0) * f);
    }
}

// The points of one ring of a face, as [lon, lat] pairs: its half-arcs end to end, densified,
// with longitudes unwrapped (continuous across the 180-degree meridian). The last point is not
// a copy of the first.
function ringPoints(borders, halves, arcStart) {
    const {counts, lonLat} = borders;
    const points = [];
    for (const half of halves) {
        const arc = half >> 1, count = counts[arc], first = arcStart[arc];
        const at = j => {
            const k = 2 * (first + ((half & 1) ? count - 1 - j : j));
            return [lonLat[k], lonLat[k + 1]];
        };
        let [lon, lat] = at(0);
        if (points.length === 0) points.push([lon, lat]);
        else {
            // The arc starts where the last one ended; continue from the unwrapped end.
            [lon, lat] = points[points.length - 1];
        }
        for (let j = 1; j < count; j++) {
            const [nextLon, nextLat] = at(j);
            const unwrapped = lon + (((nextLon - lon) % 360) + 540) % 360 - 180;
            densifySegment(lon, lat, unwrapped, nextLat, (x, y) => points.push([x, y]));
            lon = unwrapped;
            lat = nextLat;
        }
    }
    // Drop repeated points (two quantized points can be equal), and the closing copy.
    const ring = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
    while (ring.length > 1 && ring[ring.length - 1][0] === ring[0][0] && ring[ring.length - 1][1] === ring[0][1]) ring.pop();
    return ring;
}

// Make a triangulation (index triples into xs, ys, changed in place) Delaunay, except across
// the ring edges, which stay: Lawson's method. An inner edge, shared by triangles a-b-c and
// b-a-d, is flipped to c-d when d is inside the circle through a, b and c. This repeats until no
// edge needs it, and gives the constrained Delaunay triangulation, whose triangles are as near
// to equilateral as the points allow. Earcut's own triangles are long and thin.
function delaunayFlips(xs, ys, triangles, ringEdges) {
    const orient = (a, b, c) => (xs[b] - xs[a]) * (ys[c] - ys[a]) - (ys[b] - ys[a]) * (xs[c] - xs[a]);
    // True when d is inside the circle through a, b, c (counterclockwise).
    const inCircle = (a, b, c, d) => {
        const adx = xs[a] - xs[d], ady = ys[a] - ys[d];
        const bdx = xs[b] - xs[d], bdy = ys[b] - ys[d];
        const cdx = xs[c] - xs[d], cdy = ys[c] - ys[d];
        const det = (adx * adx + ady * ady) * (bdx * cdy - cdx * bdy)
            - (bdx * bdx + bdy * bdy) * (adx * cdy - cdx * ady)
            + (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady);
        return det > 1e-12;
    };
    const edgeKey = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
    for (let t = 0; t < triangles.length; t += 3) {
        if (orient(triangles[t], triangles[t + 1], triangles[t + 2]) < 0) {
            [triangles[t + 1], triangles[t + 2]] = [triangles[t + 2], triangles[t + 1]];
        }
    }
    const trianglesOf = new Map();      // edge -> the (one or two) triangles on it
    const link = (a, b, t) => {
        const key = edgeKey(a, b), list = trianglesOf.get(key);
        if (list) list.push(t);
        else trianglesOf.set(key, [t]);
    };
    const relink = (a, b, from, to) => {
        const list = trianglesOf.get(edgeKey(a, b));
        list[list.indexOf(from)] = to;
    };
    for (let t = 0; t < triangles.length; t += 3) {
        link(triangles[t], triangles[t + 1], t);
        link(triangles[t + 1], triangles[t + 2], t);
        link(triangles[t + 2], triangles[t], t);
    }
    const queue = [...trianglesOf.keys()];
    let flips = 0;
    while (queue.length && flips < 20 * triangles.length) {
        const key = queue.pop(), list = trianglesOf.get(key);
        if (!list || list.length !== 2 || ringEdges.has(key)) continue;
        const [t1, t2] = list;
        // Turn t1 to a-b-c with a-b on this edge, and find d, the far vertex of t2.
        let r = 0;
        while (edgeKey(triangles[t1 + r], triangles[t1 + (r + 1) % 3]) !== key) r++;
        const a = triangles[t1 + r], b = triangles[t1 + (r + 1) % 3], c = triangles[t1 + (r + 2) % 3];
        const d = triangles[t2] !== a && triangles[t2] !== b ? triangles[t2]
            : triangles[t2 + 1] !== a && triangles[t2 + 1] !== b ? triangles[t2 + 1] : triangles[t2 + 2];
        if (!inCircle(a, b, c, d) || orient(a, d, c) <= 0 || orient(d, b, c) <= 0) continue;
        triangles[t1] = a; triangles[t1 + 1] = d; triangles[t1 + 2] = c;
        triangles[t2] = d; triangles[t2 + 1] = b; triangles[t2 + 2] = c;
        trianglesOf.delete(key);
        trianglesOf.set(edgeKey(c, d), [t1, t2]);
        relink(a, d, t2, t1);
        relink(b, c, t1, t2);
        queue.push(edgeKey(a, d), edgeKey(d, b), edgeKey(b, c), edgeKey(c, a));
        flips++;
    }
}

// Split triangles (index triples into xs, ys) until no edge is longer than FILL_MAX_EDGE_DEG,
// each time at the middle of its LONGEST edge, which keeps the thin fans that Earcut makes from
// multiplying. An edge is always split at the same new vertex (one per edge), and in the end
// every edge over the limit is split in both triangles that share it, so the mesh has no
// T-junctions (they would show as cracks, as the parts bend with the Earth differently).
function refineTriangles(xs, ys, triangles) {
    const length = (a, b) => {
        const cosLat = Math.cos((ys[a] + ys[b]) * Math.PI / 360);
        return Math.max(Math.abs(xs[a] - xs[b]) * cosLat, Math.abs(ys[a] - ys[b]));
    };
    const middles = new Map();
    const middle = (a, b) => {
        const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
        let m = middles.get(key);
        if (m === undefined) {
            m = xs.length;
            xs.push((xs[a] + xs[b]) / 2);
            ys.push((ys[a] + ys[b]) / 2);
            middles.set(key, m);
        }
        return m;
    };
    const out = [];
    const stack = Array.from(triangles);
    while (stack.length) {
        const c = stack.pop(), b = stack.pop(), a = stack.pop();
        const ab = length(a, b), bc = length(b, c), ca = length(c, a);
        const longest = Math.max(ab, bc, ca);
        if (longest <= FILL_MAX_EDGE_DEG) {
            out.push(a, b, c);
        } else if (longest === ab) {
            const m = middle(a, b);
            stack.push(a, m, c, m, b, c);
        } else if (longest === bc) {
            const m = middle(b, c);
            stack.push(a, b, m, a, m, c);
        } else {
            const m = middle(c, a);
            stack.push(a, b, m, m, b, c);
        }
    }
    return out;
}

// The parts of the horizontal line at latitude y that are inside the rings (even-odd, so holes
// are outside), as sorted [start, end] longitude pairs.
function insideAlong(rings, y) {
    const crossings = [];
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [x0, y0] = ring[j], [x1, y1] = ring[i];
            if ((y0 > y) !== (y1 > y)) crossings.push(x0 + (x1 - x0) * (y - y0) / (y1 - y0));
        }
    }
    crossings.sort((p, q) => p - q);
    const spans = [];
    for (let i = 0; i + 1 < crossings.length; i += 2) spans.push([crossings[i], crossings[i + 1]]);
    return spans;
}

// The parts that are in both lists of spans.
function intersectSpans(first, second) {
    const out = [];
    let i = 0, j = 0;
    while (i < first.length && j < second.length) {
        const start = Math.max(first[i][0], second[j][0]), end = Math.min(first[i][1], second[j][1]);
        if (start < end) out.push([start, end]);
        if (first[i][1] < second[j][1]) i++;
        else j++;
    }
    return out;
}

// Extra vertices (Steiner points) on a grid inside a face, FILL_MAX_EDGE_DEG apart (in
// longitude, that divided by the cosine of the latitude), and at least STEINER_MARGIN of that
// from its rings. Earcut then joins the ring points to these, and not across the whole face: a
// long band face triangulated alone is a fan of thin triangles, some 100 degrees long, which
// the refinement would cut into millions of pieces.
//
// Each point moves by up to STEINER_JITTER of the spacing, the same way every time. Points of
// an exact grid are in lines, and Earcut drops a vertex that is in line with its neighbours
// (it joins each Steiner point to the ring by a spike of zero area), so most of them were lost.
const STEINER_MARGIN = 0.3;
const STEINER_JITTER = 0.1;
const jitter = (row, column, salt) => {
    const x = Math.sin(row * 127.1 + column * 311.7 + salt * 74.7) * 43758.5453;
    return (x - Math.floor(x) - 0.5) * STEINER_JITTER;
};
function steinerPoints(rings) {
    const spacing = FILL_MAX_EDGE_DEG, margin = spacing * STEINER_MARGIN;
    let minLat = Infinity, maxLat = -Infinity;
    for (const [, lat] of rings[0]) {
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
    }
    const points = [];
    for (let row = Math.ceil(minLat / spacing); row * spacing <= maxLat; row++) {
        const lat = row * spacing;
        if (Math.abs(lat) > 89) continue;
        const cosLat = Math.cos(lat * Math.PI / 180);
        // Inside at this latitude and at the margin above and below, and the margin from the
        // ends of each part.
        const spans = intersectSpans(intersectSpans(insideAlong(rings, lat), insideAlong(rings, lat - margin)),
            insideAlong(rings, lat + margin));
        const step = spacing / Math.max(cosLat, 0.05), inset = margin / Math.max(cosLat, 0.05);
        for (const [start, end] of spans) {
            for (let k = Math.ceil((start + inset) / step); k * step <= end - inset; k++) {
                points.push([(k + jitter(row, k, 1)) * step, lat + jitter(row, k, 2) * spacing]);
            }
        }
    }
    return points;
}

// The fill of every face, as {lonLat: Float64Array (lon, lat per vertex, lon unwrapped),
// index: Uint32Array (triangles), faceStart: Uint32Array (the first vertex of each face, then
// the vertex count)}. The colors depend on the date: see fillStyles. borders: from
// decodeTimeZoneBorders. stats, when given, gets counts for tests.
export function buildTimeZoneFill(borders, stats = {}) {
    stats.ringPoints = 0;
    stats.steinerPoints = 0;
    stats.earcutTriangles = 0;
    const {counts, faces} = borders;
    const arcStart = new Uint32Array(counts.length);
    for (let i = 1; i < counts.length; i++) arcStart[i] = arcStart[i - 1] + counts[i - 1];

    const lonLat = [], index = [];
    const faceStart = new Uint32Array(faces.length + 1);
    faces.forEach((face, faceNumber) => {
        faceStart[faceNumber] = lonLat.length / 2;
        const outer = ringPoints(borders, face.rings[0], arcStart);
        if (face.pole) {
            // The ring goes once around the globe; close it through the pole it goes around.
            const pole = 90 * Math.sign(face.pole);
            outer.push([outer[outer.length - 1][0], pole], [outer[0][0], pole]);
        }
        if (outer.length < 3) return;
        let minLon = Infinity;
        for (const [lon] of outer) minLon = Math.min(minLon, lon);
        // A hole is unwrapped on its own; move it by whole turns into the outer ring's span.
        const holes = face.rings.slice(1).map(halves => {
            const hole = ringPoints(borders, halves, arcStart);
            const turns = hole.length ? -360 * Math.floor((hole[0][0] - minLon) / 360) : 0;
            return hole.map(([lon, lat]) => [lon + turns, lat]);
        }).filter(hole => hole.length >= 3);

        // Earcut takes a Steiner point as a hole of one point.
        const steiner = steinerPoints([outer, ...holes]).map(point => [point]);
        const toVectors = ring => ring.map(([lon, lat]) => new Vector2(lon, lat));
        const triangles = ShapeUtils.triangulateShape(toVectors(outer), [...holes, ...steiner].map(toVectors));
        const xs = [], ys = [];
        for (const ring of [outer, ...holes, ...steiner]) {
            for (const [lon, lat] of ring) {
                xs.push(lon);
                ys.push(lat);
            }
        }
        stats.ringPoints += xs.length - steiner.length;
        stats.steinerPoints += steiner.length;
        stats.earcutTriangles += triangles.length;
        // The ring edges are the borders; they are never flipped.
        const ringEdges = new Set();
        let first = 0;
        for (const ring of [outer, ...holes]) {
            for (let i = 0; i < ring.length; i++) {
                const a = first + i, b = first + (i + 1) % ring.length;
                ringEdges.add(a < b ? a * 4294967296 + b : b * 4294967296 + a);
            }
            first += ring.length;
        }
        const flat = triangles.flat();
        delaunayFlips(xs, ys, flat, ringEdges);
        const refined = refineTriangles(xs, ys, flat);
        const base = lonLat.length / 2;
        for (let i = 0; i < xs.length; i++) lonLat.push(xs[i], ys[i]);
        for (const v of refined) index.push(base + v);
    });
    faceStart[faces.length] = lonLat.length / 2;
    return {lonLat: Float64Array.from(lonLat), index: Uint32Array.from(index), faceStart};
}

// ------------------------------------------------------------------ the map at an instant

// The UTC offsets of the zones of the map, and from them, at one instant:
//   key:         the offsets as text, to tell when anything changed
//   faceOffsets: for each face, the offsets (hours, sorted, no repeats) of the zones that cover it
//   border:      for each arc, 1 when the faces on its two sides have different offsets: the
//                arcs that are drawn as lines
//   left, right: for each arc, the offset of the face on each side, facing along the arc (NaN
//                where a face has more than one, or there is no face)
// A zone the browser does not know gets its standard offset from the file. offsetOf(zone, date)
// is utcOffsetHoursInZone; tests give their own.
export function zoneMapAt(borders, date, offsetOf = utcOffsetHoursInZone) {
    const {zones, faces, leftFace, rightFace} = borders;
    const zoneOffsets = zones.map(({name, standard}) => {
        const hours = offsetOf(name, date);
        return hours === null || !Number.isFinite(hours) ? standard : Math.round(hours * 60) / 60;
    });
    const faceOffsets = faces.map(face => [...new Set(face.zones.map(zone => zoneOffsets[zone]))]
        .filter(Number.isFinite).sort((p, q) => p - q));
    const single = face => (face >= 0 && faceOffsets[face].length === 1 ? faceOffsets[face][0] : NaN);
    const same = (p, q) => p.length === q.length && p.every((value, i) => value === q[i]);
    const arcCount = leftFace.length;
    const border = new Uint8Array(arcCount), left = new Float64Array(arcCount), right = new Float64Array(arcCount);
    for (let i = 0; i < arcCount; i++) {
        const l = leftFace[i], r = rightFace[i];
        border[i] = l >= 0 && r >= 0 && !same(faceOffsets[l], faceOffsets[r]) ? 1 : 0;
        left[i] = single(l);
        right[i] = single(r);
    }
    return {key: zoneOffsets.join(","), faceOffsets, border, left, right};
}

// The color of each fill vertex for faceOffsets (from zoneMapAt), as (a, b, fraction) per
// vertex (see faceStyle); a = -1 for a face with no known offset, which is not drawn.
export function fillStyles(fill, faceOffsets, target = new Float32Array(fill.lonLat.length / 2 * 3)) {
    const {faceStart} = fill;
    for (let face = 0; face + 1 < faceStart.length; face++) {
        const style = faceStyle(faceOffsets[face]) ?? {a: -1, b: -1, fraction: 0};
        for (let v = faceStart[face]; v < faceStart[face + 1]; v++) {
            target[3 * v] = style.a;
            target[3 * v + 1] = style.b;
            target[3 * v + 2] = style.fraction;
        }
    }
    return target;
}
