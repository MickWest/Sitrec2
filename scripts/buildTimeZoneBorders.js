// Build-time extraction of the time zone MAP from timezone-boundary-builder into a compact
// file that Sitrec loads on demand (data/timezones/timezone-borders.bin.gz), for
// Time > Show Time Zones: the borders it draws as lines, and the zones it fills with color.
//
// Source: timezone-boundary-builder by Evan Siroky, the "1970" set WITH OCEANS
// (timezones-with-oceans-1970.geojson.zip, which holds combined-with-oceans-1970.json). It
// covers the whole globe: at sea the zones are the 15-degree nautical bands (Etc/GMT+8 ...).
// Data © OpenStreetMap contributors, under the Open Database License (ODbL). The output is a
// database derived from it, so it is under the ODbL too (see data/timezones/README.md).
//
// The file keeps each zone of the "1970" set apart (304 zones in 2026f). That set merges only
// the zones whose clocks have been the same since 1970, so each zone has ONE history of UTC
// offsets since then, and a browser can give its offset on any date since 1970 (Intl), with or
// without daylight saving time. Do NOT use the "now" set: it merges the zones that keep the same
// clock from its release on, so it is wrong for past dates (with 2026f it showed British
// Columbia as UTC-7 in January 2025, grouped with Phoenix; the true offset was UTC-8). Sitrec
// draws a border only where the offsets on its two sides differ at the sitch time, and colors
// each zone by that offset: in July a line runs around Arizona (UTC-7) inside UTC-6 Mountain
// time; in January it does not. Some zones overlap on purpose (Xinjiang has both UTC+8 and
// UTC+6; the West Bank has two; some border rivers have both banks' zones), so a face of the map
// can have more than one zone. The file also keeps each zone's standard offset (the smaller of
// its mid-January and mid-July offsets in this Node's IANA data) for a browser that does not know
// the zone name. Sitrec also uses the file for Set Time Zone from Camera Location.
//
// Download and unzip the release file by hand, then pass the path:
//
//     node --max-old-space-size=12288 scripts/buildTimeZoneBorders.js path/to/combined-with-oceans-1970.json [toleranceDeg]
//
// The script reads the file only; it does not download anything.
//
// METHOD (zoneTopology, then traceFaces)
//  1. Vertices less than SNAP_DEG apart are one vertex, and longitude -180 is +180: zones
//     that cross the 180-degree meridian are split there. An edge (two consecutive points of a
//     ring) that only one side has is split where another such edge has a vertex on it (a
//     T-junction), so the two sides of a border then share their edges.
//  2. Each edge knows the zones on its left and its right, from the direction of the rings. An
//     edge with the same zones on both sides is dropped. The others are joined into ARCS: an arc
//     ends at a junction, a point where the number of edges is not 2 or the sides change. A
//     closed arc smaller than MIN_LOOP_AREA_DEG2 (a sliver where two shapes cross) is dropped
//     (buildBorders).
//  3. Each arc is simplified with the Douglas-Peucker method (tolerance in degrees, with
//     longitude scaled by the cosine of the latitude), on longitudes unwrapped across the
//     180-degree meridian. Its end points are kept, so arcs still meet at the junctions.
//  4. The arcs divide the longitude/latitude plane into FACES (see traceFaces). Each face gets
//     the zones that cover it (from its arcs, and a point test inside it), and each arc the
//     faces on its two sides.
//
// OUTPUT FORMAT "TZB5" (gzip; decoded by src/TimeZoneBorders.js):
//   "TZB5"   4 bytes, format name
//   uint32   number of zones Z, arcs A, points P and faces F (little-endian, 4 numbers)
//   then, for each zone: the length of its name, the name (ASCII), and its standard UTC offset
//   in quarter hours (126 when not known).
//   then, for each arc: its point count; the face on its left and on its right, facing along the
//   arc, as the face index + 1 (0: no face, beyond a pole). Then its points as longitude,
//   latitude pairs in units of 1e-4 degree (about 11 m). The first point is absolute; every other
//   point is the difference from the point before it.
//   then, for each face: its number of zones, and each zone index; its pole (-1 when its outer
//   ring goes around the South Pole and is closed through it, +1 the North Pole, else 0); its
//   number of rings, the outer one first, then the holes; for each ring its number of
//   half-arcs, then each half-arc as 2 * arc (the arc forward) or 2 * arc + 1 (backward).
//   Every number after the header is a varint (7 bits per byte, low bits first, high bit set on
//   all bytes but the last); signed numbers are zigzag-coded first (0, -1, 1, -2 ... -> 0, 1, 2,
//   3 ...), so a small difference takes one or two bytes.
//
// SIZE (release 2026f, gzipped). The "now" set, borders only: tolerance 0.001 deg -> 488 KB,
// 0.002 -> 336 KB, 0.005 -> 190 KB, 0.01 -> 119 KB, 0.02 -> 73 KB. The default, 0.01 deg (about
// 1.1 km), is far below what shows at the scale of a country. The 1970 set with its faces, at
// 0.01 deg: 251 KB (1,941 arcs, 67,817 points, 1,039 faces).

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const DEFAULT_TOLERANCE_DEG = 0.01;     // about 1.1 km (see SIZE above)
const UNITS_PER_DEG = 1e4;              // stored resolution, about 11 m
const NO_ZONE_SIDE = 126;               // quarter hours: a zone with no standard offset known
const SNAP_DEG = 1e-5;                  // about 1 m: nearer vertices are one vertex (larger snaps join
                                        // distinct vertices where a border has close points, 1e-4 left 126 loose ends)

// Each ring of a Polygon or MultiPolygon, with isHole: false for the outer ring of a polygon.
function* polygonRings(geometry) {
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates]
        : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
    for (const polygon of polygons) {
        for (let i = 0; i < polygon.length; i++) yield {ring: polygon[i], isHole: i > 0};
    }
}

// Twice the signed area of a ring in the lon/lat plane: positive when it runs counterclockwise.
// The rings are split at the 180-degree meridian, so none wraps around.
function signedArea2(ring) {
    let sum = 0;
    for (let i = 1; i < ring.length; i++) sum += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
    return sum;
}

function utcOffsetHours(tzid, isoDate) {
    const text = new Intl.DateTimeFormat("en-US", {timeZone: tzid, timeZoneName: "longOffset"})
        .formatToParts(new Date(isoDate)).find(part => part.type === "timeZoneName").value;
    const match = /^GMT(?:([+-])(\d{1,2}):(\d{2}))?$/.exec(text);
    if (!match) throw new Error(`unexpected offset "${text}" for ${tzid}`);
    return match[1] ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) + Number(match[3]) / 60) : 0;
}

// Standard UTC offset in hours: the smaller of the mid-January and mid-July offsets.
function standardOffsetHours(tzid, year = 2026) {
    return Math.min(utcOffsetHours(tzid, `${year}-01-15T12:00:00Z`), utcOffsetHours(tzid, `${year}-07-15T12:00:00Z`));
}

const defaultZoneKey = feature => feature.properties.tzid;
const wrapDelta = d => d - 360 * Math.round(d / 360);      // a longitude difference, in -180..180

// A set of zone groups as text: the names, sorted, joined by "|"; "" is no group (no zone there).
const addToGroupSet = (set, group) => {
    if (set === "") return group;
    const names = set.split("|");
    return names.includes(group) ? set : [...names, group].sort().join("|");
};
const groupSetHas = (set, group) => set !== "" && set.split("|").includes(group);

// The topology of the zones: every edge where the zone group changes, joined into ARCS
// {points: [[lon, lat], ...], from, to, left, right}. from and to are the vertex ids at the ends;
// left and right are the group sets on each side, facing along the arc ("" where no zone is: at
// the poles, and in a sliver where two source shapes do not meet). zoneKey(feature) names the
// group a zone belongs to (its standard offset). An edge with the same group on both sides is
// not a border, and is dropped.
//
// The source shapes do not always share their vertices, so the edges of two neighbours would not
// match. Two repairs make them match (2026f had 324 line ends away from the poles without them):
//  - SNAP: a vertex within snapDeg (Chebyshev) of an earlier vertex is that vertex: two shapes
//    often put the same corner a metre apart. (On the coast of Iceland, -22.499983, 63.417278 and
//    -22.5, 63.417281 are about 1 m apart; the two repairs together close that gap.)
//  - T-JUNCTIONS: an edge that only one side has is split at every vertex of another such edge
//    that lies on it. The Troll sector of Antarctica has one edge along 68 S from 0 to 25 E,
//    where the ocean bands have vertices at 7.5 and 22.5 E. The two sides of the 180-degree
//    meridian are the same case: Fiji's side has a point at 70 S, the other side one at 75 S.
// A real sliver (the OSM borders of the two sides differ, as for 5 km on the Togo / Benin border)
// stays: its edges have "" on one side.
function zoneTopology(geojson, zoneKey = defaultZoneKey, snapDeg = SNAP_DEG) {
    // ---- vertices, snapped. -180 is the same meridian as +180.
    const xs = [], ys = [];
    const snapGrid = new Map();     // cell -> vertex id, or an array of them
    const snapCell = (ix, iy) => (ix + 1e7) * 2e7 + (iy + 1e7);
    const vertexId = (lonIn, lat) => {
        const lon = lonIn === -180 ? 180 : lonIn;
        const ix = Math.floor(lon / snapDeg), iy = Math.floor(lat / snapDeg);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const entry = snapGrid.get(snapCell(ix + dx, iy + dy));
                if (entry === undefined) continue;
                for (const id of (typeof entry === "number" ? [entry] : entry)) {
                    if (Math.abs(xs[id] - lon) <= snapDeg && Math.abs(ys[id] - lat) <= snapDeg) return id;
                }
            }
        }
        const id = xs.length;
        xs.push(lon);
        ys.push(lat);
        const key = snapCell(ix, iy), entry = snapGrid.get(key);
        if (entry === undefined) snapGrid.set(key, id);
        else if (typeof entry === "number") snapGrid.set(key, [entry, id]);
        else entry.push(id);
        return id;
    };

    // ---- rings as vertex ids. A zone is on the LEFT of its own ring's edges when the outer ring
    // runs counterclockwise or a hole runs clockwise; the sign of the ring's area says which.
    const rings = [];
    geojson.features.forEach(feature => {
        const group = zoneKey(feature);
        for (const {ring, isHole} of polygonRings(feature.geometry)) {
            const area = signedArea2(ring);
            if (area === 0) continue;
            const ids = [];
            for (const [lon, lat] of ring) {
                const id = vertexId(lon, lat);
                if (id !== ids[ids.length - 1]) ids.push(id);
            }
            if (ids[ids.length - 1] !== ids[0]) ids.push(ids[0]);
            if (ids.length < 4) continue;       // snapped to fewer than three points
            rings.push({ids, group, groupOnLeft: isHole ? area < 0 : area > 0});
        }
    });

    // ---- T-junctions. An edge is keyed by its vertex ids, lower first.
    const ID_SPAN = 2 ** 23;
    if (xs.length >= ID_SPAN) throw new Error(`too many vertices (${xs.length})`);
    const edgeKey = (a, b) => (a < b ? a * ID_SPAN + b : b * ID_SPAN + a);
    const sideCounts = new Map();   // edge -> [zones on the left of low -> high, on the right]
    for (const {ids, groupOnLeft} of rings) {
        for (let i = 1; i < ids.length; i++) {
            const a = ids[i - 1], b = ids[i], key = edgeKey(a, b);
            let counts = sideCounts.get(key);
            if (!counts) sideCounts.set(key, counts = [0, 0]);
            counts[(a < b) === groupOnLeft ? 0 : 1]++;
        }
    }
    const unmatched = [];
    for (const [key, [onLeft, onRight]] of sideCounts) if (onLeft === 0 || onRight === 0) unmatched.push(key);

    // The vertices of the unmatched edges, in cells of 0.01 degree around the globe.
    const CELL = 0.01, CELLS_AROUND = Math.round(360 / CELL);
    const lonCell = lon => ((Math.floor((lon + 180) / CELL) % CELLS_AROUND) + CELLS_AROUND) % CELLS_AROUND;
    const latCell = lat => Math.floor((lat + 90) / CELL);
    const candidates = new Map();
    for (const key of unmatched) {
        for (const v of [Math.floor(key / ID_SPAN), key % ID_SPAN]) {
            const cell = lonCell(xs[v]) * 1e5 + latCell(ys[v]);
            const list = candidates.get(cell);
            if (!list) candidates.set(cell, [v]);
            else if (!list.includes(v)) list.push(v);
        }
    }
    const splits = new Map();       // edge -> vertex ids on it, in order from low to high
    for (const key of unmatched) {
        const a = Math.floor(key / ID_SPAN), b = key % ID_SPAN;
        const ax = xs[a], ay = ys[a];
        const dx = wrapDelta(xs[b] - ax), dy = ys[b] - ay, lengthSq = dx * dx + dy * dy;
        if (lengthSq === 0) continue;
        const found = [];
        const x0 = lonCell(ax + Math.min(0, dx) - snapDeg), cellsWide = Math.floor((Math.abs(dx) + 2 * snapDeg) / CELL) + 2;
        const y0 = latCell(ay + Math.min(0, dy) - snapDeg), y1 = latCell(ay + Math.max(0, dy) + snapDeg);
        for (let i = 0; i < cellsWide; i++) {
            const cx = (x0 + i) % CELLS_AROUND;
            for (let cy = y0; cy <= y1; cy++) {
                const list = candidates.get(cx * 1e5 + cy);
                if (!list) continue;
                for (const v of list) {
                    if (v === a || v === b) continue;
                    const px = wrapDelta(xs[v] - ax), py = ys[v] - ay;
                    const t = (px * dx + py * dy) / lengthSq;
                    if (t <= 1e-9 || t >= 1 - 1e-9) continue;
                    if (Math.hypot(px - t * dx, py - t * dy) > snapDeg) continue;
                    if (!found.some(([, other]) => other === v)) found.push([t, v]);
                }
            }
        }
        if (found.length) splits.set(key, found.sort((p, q) => p[0] - q[0]).map(([, v]) => v));
    }

    // ---- the group sets on each side of every edge (low -> high), after the splits.
    const owners = new Map();       // edge -> [left set, right set]
    for (const {ids, group, groupOnLeft} of rings) {
        for (let i = 1; i < ids.length; i++) {
            const a = ids[i - 1], b = ids[i];
            const inner = splits.get(edgeKey(a, b));
            const path = !inner ? [a, b] : [a, ...(a < b ? inner : [...inner].reverse()), b];
            for (let j = 1; j < path.length; j++) {
                const p = path[j - 1], q = path[j], key = edgeKey(p, q);
                let sides = owners.get(key);
                if (!sides) owners.set(key, sides = ["", ""]);
                const side = (p < q) === groupOnLeft ? 0 : 1;
                sides[side] = addToGroupSet(sides[side], group);
            }
        }
    }

    // ---- borders: the edges with different group sets on their two sides, joined into arcs.
    // An arc ends at a junction: a point where the number of border edges is not 2, or where the
    // sides change.
    const edges = [];               // [a, b, left set, right set] (sides of a -> b, a < b)
    const edgesAtPoint = new Map();
    for (const [key, [left, right]] of owners) {
        if (left === right) continue;
        const a = Math.floor(key / ID_SPAN), b = key % ID_SPAN, index = edges.length;
        edges.push([a, b, left, right]);
        for (const p of [a, b]) {
            const list = edgesAtPoint.get(p);
            if (list) list.push(index);
            else edgesAtPoint.set(p, [index]);
        }
    }
    // The sides of edge e walked away from point p: the left set, a tab, the right set.
    // (Joined by a tab: zone names such as "America/Chicago" have slashes.)
    const sidesFrom = (e, p) => (edges[e][0] === p ? `${edges[e][2]}\t${edges[e][3]}` : `${edges[e][3]}\t${edges[e][2]}`);
    const otherEnd = (e, p) => (edges[e][0] === p ? edges[e][1] : edges[e][0]);
    const isJunction = (p) => {
        const list = edgesAtPoint.get(p);
        return list.length !== 2 || sidesFrom(list[0], otherEnd(list[0], p)) !== sidesFrom(list[1], p);
    };

    const used = new Uint8Array(edges.length);
    const arcs = [];
    const walk = (start, firstEdge) => {
        const chain = [start];
        let p = start, e = firstEdge;
        const [left, right] = sidesFrom(firstEdge, start).split("\t");
        for (;;) {
            used[e] = 1;
            p = otherEnd(e, p);
            chain.push(p);
            if (p === start || isJunction(p)) break;
            const next = edgesAtPoint.get(p).find(candidate => !used[candidate]);
            if (next === undefined) break;
            e = next;
        }
        arcs.push({points: chain.map(id => [xs[id], ys[id]]), from: start, to: p, left, right});
    };
    // Arcs that start at a junction, then closed loops with no junction (an enclave).
    for (const [p, list] of edgesAtPoint) {
        if (!isJunction(p)) continue;
        for (const e of list) if (!used[e]) walk(p, e);
    }
    for (let e = 0; e < edges.length; e++) {
        if (!used[e]) walk(edges[e][0], e);
    }
    return {arcs, stats: {vertices: xs.length, unmatchedEdges: unmatched.length, splitEdges: splits.size}};
}

// The single group of a set, or undefined when it has none or more than one.
const onlyGroup = set => (set !== "" && !set.includes("|") ? set : undefined);

// True for an arc along a pole (latitude +-90 everywhere). It has no length on the globe; it
// only closes the zones that reach the pole, in the longitude/latitude plane.
const isPoleArc = arc => arc.points.every(([, lat]) => Math.abs(lat) === 90);

// The borders of an ordinary time zone map: the arcs with a zone group on both sides, as chains
// {points, left, right} (left and right are the single group on each side, or undefined where
// zones overlap).
function borderChains(geojson, zoneKey = defaultZoneKey) {
    return zoneTopology(geojson, zoneKey).arcs
        .filter(arc => arc.left !== "" && arc.right !== "")
        .map(({points, left, right}) => ({points, left: onlyGroup(left), right: onlyGroup(right)}));
}

// Distance of point p from the line through a and b, in degrees of latitude, with
// longitude scaled by the cosine of the mean latitude of a and b.
function offsetFromLine(p, a, b) {
    const scale = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
    const ax = a[0] * scale, ay = a[1], bx = b[0] * scale, by = b[1];
    const px = p[0] * scale, py = p[1];
    const dx = bx - ax, dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Make each longitude within 180 degrees of the one before it, so a chain that crosses the
// 180-degree meridian is continuous (179.9 then -179.9 becomes 179.9 then 180.1).
function unwrapLongitudes(chain) {
    const out = [chain[0].slice()];
    for (let i = 1; i < chain.length; i++) {
        let lon = chain[i][0];
        const previous = out[i - 1][0];
        while (lon - previous > 180) lon -= 360;
        while (lon - previous < -180) lon += 360;
        out.push([lon, chain[i][1]]);
    }
    return out;
}

const wrapLongitude = lon => ((((lon + 180) % 360) + 360) % 360) - 180;

// Douglas-Peucker, keeping both end points, on unwrapped longitudes; the result is wrapped
// back into -180..180 (src/TimeZoneBorders.js takes the short way across the meridian). A
// closed chain (first point = last point) is split at its farthest point first, so it does
// not collapse.
function simplifyChain(rawChain, toleranceDeg) {
    const chain = unwrapLongitudes(rawChain);
    const n = chain.length;
    if (n <= 2) return chain.map(([lon, lat]) => [wrapLongitude(lon), lat]);
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    if (chain[0][0] === chain[n - 1][0] && chain[0][1] === chain[n - 1][1]) {
        let far = 1, farDistance = -1;
        for (let i = 1; i < n - 1; i++) {
            const d = Math.hypot(chain[i][0] - chain[0][0], chain[i][1] - chain[0][1]);
            if (d > farDistance) { farDistance = d; far = i; }
        }
        keep[far] = 1;
        stack.length = 0;
        stack.push([0, far], [far, n - 1]);
    }
    while (stack.length) {
        const [first, last] = stack.pop();
        let index = -1, maxOffset = toleranceDeg;
        for (let i = first + 1; i < last; i++) {
            const offset = offsetFromLine(chain[i], chain[first], chain[last]);
            if (offset > maxOffset) { maxOffset = offset; index = i; }
        }
        if (index !== -1) {
            keep[index] = 1;
            stack.push([first, index], [index, last]);
        }
    }
    return chain.filter((_, i) => keep[i]).map(([lon, lat]) => [wrapLongitude(lon), lat]);
}

// The faces of the map: the areas that the arcs enclose. Returns
//   faces: [{groups, rings: [outer, ...holes]}], each ring a list of half-arcs (2 * arc for the
//          arc forward, 2 * arc + 1 for it backward). A face is on the LEFT of its half-arcs, so an
//          outer ring runs counterclockwise in the longitude/latitude plane and a hole clockwise.
//          The face beyond each pole in that plane has no zone, and is left out.
//   sides: for each arc, the group sets of the faces on its left and right.
//
// The usual planar method: around each vertex the half-arcs that leave it are sorted by angle;
// a face boundary arrives at a vertex and leaves by the next half-arc CLOCKWISE from the one it
// arrived on. Each arc gives one half-arc each way, so every boundary closes.
//
// The groups of a face are all the groups that the rings put on its side of its boundary arcs,
// plus the groups of zonesAt(lon, lat) at a point well inside it (see innerPoint), when given.
// An arc can miss a group: the edge of Asia/Urumqi (UTC+6) inside China says nothing about the
// UTC+8 of China, which covers both its sides. Xinjiang also meets the border of China, where
// both zones are on its side, so the arcs alone give it both; but the holes of Asia/Jerusalem in
// the West Bank (Hebron, Nablus...) lie wholly inside the zone of the West Bank and touch none
// of its edges, so the arcs alone gave them no zone and they were left out (2026f, 20 faces,
// about 950 km2). One point test per face is exact: a zone with no edge on or inside a face
// covers all of it or none of it.
function traceFaces(arcs, zonesAt = null) {
    const halfCount = 2 * arcs.length;
    const pointsOf = h => (h & 1 ? [...arcs[h >> 1].points].reverse() : arcs[h >> 1].points);
    const origin = h => (h & 1 ? arcs[h >> 1].to : arcs[h >> 1].from);
    const sideOf = h => (h & 1 ? arcs[h >> 1].right : arcs[h >> 1].left);
    const angleOf = (h) => {
        const p = arcs[h >> 1].points, last = p.length - 1;
        const [a, b] = h & 1 ? [p[last], p[last - 1]] : [p[0], p[1]];
        return Math.atan2(b[1] - a[1], wrapDelta(b[0] - a[0]));
    };
    const leaving = new Map();          // vertex -> the half-arcs that leave it, by angle
    for (let h = 0; h < halfCount; h++) {
        const list = leaving.get(origin(h));
        if (list) list.push(h);
        else leaving.set(origin(h), [h]);
    }
    const place = new Int32Array(halfCount);
    for (const list of leaving.values()) {
        list.sort((p, q) => angleOf(p) - angleOf(q));
        list.forEach((h, i) => { place[h] = i; });
    }
    const next = (h) => {
        const back = h ^ 1, list = leaving.get(origin(back));
        return list[(place[back] - 1 + list.length) % list.length];
    };

    // Each boundary: its half-arcs, its points (longitudes unwrapped), twice its area, whether it
    // winds around the globe, and the groups its arcs put on its side.
    const boundaryOf = new Int32Array(halfCount).fill(-1);
    const boundaries = [];
    for (let start = 0; start < halfCount; start++) {
        if (boundaryOf[start] >= 0) continue;
        const halves = [];
        let h = start, groups = "";
        do {
            boundaryOf[h] = boundaries.length;
            halves.push(h);
            for (const group of sideOf(h) === "" ? [] : sideOf(h).split("|")) groups = addToGroupSet(groups, group);
            h = next(h);
        } while (h !== start);
        const points = [];
        for (const half of halves) {
            const list = pointsOf(half);
            for (let i = points.length ? 1 : 0; i < list.length; i++) {
                const previous = points[points.length - 1];
                points.push([previous ? previous[0] + wrapDelta(list[i][0] - previous[0]) : list[i][0], list[i][1]]);
            }
        }
        // A boundary that winds once around the globe goes around a polar cap: the UTC+12 of
        // Pacific/Auckland covers all of Antarctica south of 86 S (and, through the Ross Sea and
        // the ocean band 172.5 E to 180, reaches up to the North Pole). In the plane it is closed
        // through the pole that it goes around (pole -1 south, +1 north); the client adds the same
        // two corners. The face is on the left, so a boundary that runs WEST around the globe holds
        // the South Pole. A boundary of pole arcs only is the empty face beyond a pole.
        const winding = points[points.length - 1][0] - points[0][0];
        const winds = Math.abs(winding) > 180;
        const poleOnly = halves.every(half => isPoleArc(arcs[half >> 1]));
        let pole = 0;
        if (winds && !poleOnly) {
            pole = winding < 0 ? -1 : 1;
            points.push([points[points.length - 1][0], 90 * pole], [points[0][0], 90 * pole]);
        }
        let area2 = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            area2 += points[j][0] * points[i][1] - points[i][0] * points[j][1];
            x0 = Math.min(x0, points[i][0]);
            x1 = Math.max(x1, points[i][0]);
            y0 = Math.min(y0, points[i][1]);
            y1 = Math.max(y1, points[i][1]);
        }
        boundaries.push({index: boundaries.length, halves, points, box: [x0, y0, x1, y1], area2,
            winds: winds && !pole, pole, groups, face: null});
    }

    const inBoundary = (x, y, {points, box}) => {
        if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) return false;
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const [xi, yi] = points[i], [xj, yj] = points[j];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    };
    const faces = [];
    const outers = boundaries.filter(b => !b.winds && b.area2 > 0);
    for (const outer of outers) {
        outer.face = {groups: outer.groups, rings: [outer.halves], pole: outer.pole, ringPoints: [outer.points]};
        faces.push(outer.face);
    }
    // A hole goes to the smallest outer ring that holds it, other than the rings on the far side
    // of its own arcs (an island's own coast): a point on the hole is then inside, never on, it.
    const orphanHoles = []; let windingWithZones = 0;
    for (const hole of boundaries) {
        if (hole.winds) {
            if (hole.groups !== "") windingWithZones++;
            continue;
        }
        if (hole.area2 > 0) continue;
        const own = new Set(hole.halves.map(h => boundaryOf[h ^ 1]));
        const [[x0, y0], [x1, y1]] = hole.points;
        const px = (x0 + x1) / 2, py = (y0 + y1) / 2;
        let best = null;
        let bestShift = 0;
        for (const outer of outers) {
            if ((best && outer.area2 >= best.area2) || own.has(outer.index)) continue;
            const shift = [0, 360, -360].find(s => inBoundary(px + s, py, outer));
            if (shift !== undefined) {
                best = outer;
                bestShift = shift;
            }
        }
        if (!best) { orphanHoles.push(`${hole.groups} at ${hole.points[0].map(v => v.toFixed(3))}`); continue; }
        hole.face = best.face;
        best.face.rings.push(hole.halves);
        // The hole's points moved into the outer ring's span of longitude, for innerPoint.
        best.face.ringPoints.push(bestShift ? hole.points.map(([x, y]) => [x - bestShift, y]) : hole.points);
        for (const group of hole.groups === "" ? [] : hole.groups.split("|")) best.face.groups = addToGroupSet(best.face.groups, group);
    }
    let pointTests = 0;
    const zonesAdded = [];
    if (zonesAt) {
        for (const face of faces) {
            const inner = innerPoint(face.ringPoints);
            if (!inner) continue;       // a sliver too thin for a safe test
            pointTests++;
            for (const group of zonesAt(wrapLongitude(inner[0]), inner[1])) {
                if (groupSetHas(face.groups, group)) continue;
                face.groups = addToGroupSet(face.groups, group);
                zonesAdded.push(`${group} at ${wrapLongitude(inner[0]).toFixed(3)},${inner[1].toFixed(3)}`);
            }
        }
    }
    for (const face of faces) delete face.ringPoints;
    const kept = faces.filter(face => face.groups !== "");
    const faceIndex = new Map(kept.map((face, i) => [face, i]));
    const faceOfHalf = (h) => {
        const face = boundaries[boundaryOf[h]].face;
        return face && faceIndex.has(face) ? faceIndex.get(face) : -1;
    };
    return {
        faces: kept,
        // For each arc, the index of the face on its left and on its right (-1: none).
        arcFaces: arcs.map((_, i) => ({leftFace: faceOfHalf(2 * i), rightFace: faceOfHalf(2 * i + 1)})),
        stats: {boundaries: boundaries.length, faces: faces.length, orphanHoles, windingWithZones, pointTests, zonesAdded},
    };
}

// A point well inside the area that rings enclose (even-odd: the outer ring, then its holes;
// points [lon, lat] with longitudes unwrapped), for a point-in-polygon test that the ~1 m
// snapping of zoneTopology cannot upset. Scan lines across the outer ring's box give the
// intervals inside; the middles of the widest are tried, and the one farthest from every ring
// edge wins. null when even that is closer than MIN_CLEARANCE_DEG to an edge.
const INNER_SCAN_LINES = 24;
const INNER_CANDIDATES = 8;
const MIN_CLEARANCE_DEG = 1e-4;         // about 11 m, ten times the snap
function innerPoint(rings) {
    let y0 = Infinity, y1 = -Infinity;
    for (const [, y] of rings[0]) {
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
    }
    const candidates = [];
    for (let k = 0; k < INNER_SCAN_LINES; k++) {
        const y = y0 + (y1 - y0) * (k + 0.5) / INNER_SCAN_LINES;
        const xs = [];
        for (const ring of rings) {
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const [xi, yi] = ring[i], [xj, yj] = ring[j];
                if ((yi > y) !== (yj > y)) xs.push(xi + (xj - xi) * (y - yi) / (yj - yi));
            }
        }
        xs.sort((a, b) => a - b);
        for (let i = 0; i + 1 < xs.length; i += 2) {
            if (xs[i + 1] > xs[i]) candidates.push({x: (xs[i] + xs[i + 1]) / 2, y, width: xs[i + 1] - xs[i]});
        }
    }
    candidates.sort((a, b) => b.width - a.width);
    let best = null, bestClearance = MIN_CLEARANCE_DEG;
    for (const {x, y} of candidates.slice(0, INNER_CANDIDATES)) {
        let clearance = Infinity;
        for (const ring of rings) {
            for (let i = 0, j = ring.length - 1; i < ring.length && clearance > bestClearance; j = i++) {
                clearance = Math.min(clearance, offsetFromLine([x, y], ring[j], ring[i]));
            }
        }
        if (clearance > bestClearance) {
            best = [x, y];
            bestClearance = clearance;
        }
    }
    return best;
}

// The zones (zoneKey) whose shapes hold a point, from the source GeoJSON: inside an outer ring
// and in none of its holes. Longitudes in -180..180 (the source rings are split at 180).
function makeZonesAt(geojson, zoneKey = defaultZoneKey) {
    const polygons = [];
    for (const feature of geojson.features) {
        const geometry = feature.geometry;
        const list = geometry.type === "Polygon" ? [geometry.coordinates]
            : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
        for (const rings of list) {
            let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
            for (const [x, y] of rings[0]) {
                x0 = Math.min(x0, x); x1 = Math.max(x1, x);
                y0 = Math.min(y0, y); y1 = Math.max(y1, y);
            }
            polygons.push({group: zoneKey(feature), rings, box: [x0, y0, x1, y1]});
        }
    }
    const inRing = (x, y, ring) => {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    };
    return (x, y) => {
        const groups = new Set();
        for (const {group, rings, box} of polygons) {
            if (x < box[0] || x > box[2] || y < box[1] || y > box[3] || groups.has(group)) continue;
            if (inRing(x, y, rings[0]) && !rings.slice(1).some(hole => inRing(x, y, hole))) groups.add(group);
        }
        return [...groups];
    };
}

// The standard offset (hours) of a zone group: its tzid's, or the group name itself when that is
// a number (the tests name groups by offset).
const standardOfGroup = (group) => {
    const hours = Number(group);
    if (Number.isFinite(hours)) return hours;
    try {
        return standardOffsetHours(group);
    } catch {
        return NaN;
    }
};

// The map -> the binary format above (not yet gzipped).
// zones: [{name, standard}] (standard in hours, the fallback where a browser does not know the
// name). arcs: [{points: [[lon, lat], ...], leftFace, rightFace}]. faces: [{zones: [zone index],
// pole, rings}].
function encodeBorders({zones, arcs, faces}) {
    const pointCount = arcs.reduce((sum, arc) => sum + arc.points.length, 0);
    const bytes = [];
    const pushVarint = (value) => {
        let v = value >>> 0;
        while (v >= 0x80) {
            bytes.push((v & 0x7f) | 0x80);
            v >>>= 7;
        }
        bytes.push(v);
    };
    const pushSigned = value => pushVarint((value << 1) ^ (value >> 31));   // zigzag
    for (const {name, standard} of zones) {
        pushVarint(name.length);
        for (let i = 0; i < name.length; i++) bytes.push(name.charCodeAt(i) & 0x7f);
        pushSigned(Number.isFinite(standard) ? Math.round(standard * 4) : NO_ZONE_SIDE);
    }
    for (const arc of arcs) {
        pushVarint(arc.points.length);
        pushVarint(arc.leftFace + 1);
        pushVarint(arc.rightFace + 1);
        let lastLon = 0, lastLat = 0;
        arc.points.forEach(([lon, lat], i) => {
            const qLon = Math.round(lon * UNITS_PER_DEG), qLat = Math.round(lat * UNITS_PER_DEG);
            pushSigned(i === 0 ? qLon : qLon - lastLon);
            pushSigned(i === 0 ? qLat : qLat - lastLat);
            lastLon = qLon;
            lastLat = qLat;
        });
    }
    for (const face of faces) {
        pushVarint(face.zones.length);
        for (const zone of face.zones) pushVarint(zone);
        pushSigned(face.pole || 0);
        pushVarint(face.rings.length);
        for (const ring of face.rings) {
            pushVarint(ring.length);
            for (const half of ring) pushVarint(half);
        }
    }
    const header = Buffer.alloc(20);
    header.write("TZB5", 0, "ascii");
    header.writeUInt32LE(zones.length, 4);
    header.writeUInt32LE(arcs.length, 8);
    header.writeUInt32LE(pointCount, 12);
    header.writeUInt32LE(faces.length, 16);
    return Buffer.concat([header, Buffer.from(bytes)]);
}

// The whole map: {zones, arcs, faces, stats}. zoneKey: see zoneTopology. Left out, each zone of
// the source is its own group (its tzid), so the client can find its offset on any date.
function buildBorders(geojson, toleranceDeg = DEFAULT_TOLERANCE_DEG, zoneKey = defaultZoneKey, snapDeg = SNAP_DEG) {
    const topology = zoneTopology(geojson, zoneKey, snapDeg);
    // A closed loop smaller than MIN_LOOP_AREA_DEG2 is a sliver of a few metres where two source
    // shapes cross, not a place: it is dropped, and its area joins the face around it. Such a
    // loop can cross the border it sits on. In 2026f a 3 m2 loop on the Germany / Czechia border
    // near As left its vertex on the Czech side and came back on the German side, so the face walk
    // went through it, and Germany, Czechia and Slovakia became one face (with Berlin and Prague,
    // and no line between them).
    const arcs = topology.arcs.filter(arc => !isTinyLoop(arc));
    // The faces are traced BEFORE simplification. The two arcs of a thin sliver can simplify to
    // the same straight line, which leaves their end vertex at the same angle; the faces could
    // then join wrongly (in 2026f, all of India got the UTC+6 of a sliver on its border).
    const {faces, arcFaces, stats} = traceFaces(arcs, makeZonesAt(geojson, zoneKey));
    const names = [...new Set(faces.flatMap(face => face.groups.split("|")))].sort();
    const zones = names.map(name => ({name, standard: standardOfGroup(name)}));
    const zoneIndex = new Map(names.map((name, i) => [name, i]));
    // An arc with the same face on both sides is not a border of anything: the faces are wrong
    // around it. The shipped file must have none (tests/TimeZoneBorders.test.js checks it).
    const sameFaceArcs = arcFaces.filter(({leftFace, rightFace}) => leftFace >= 0 && leftFace === rightFace).length;
    return {
        zones,
        arcs: arcs.map((arc, i) => ({...arc, ...arcFaces[i], points: simplifyChain(arc.points, toleranceDeg)})),
        faces: faces.map(face => ({...face, zones: face.groups.split("|").map(name => zoneIndex.get(name))})),
        stats: {...topology.stats, ...stats, zones: zones.length,
            tinyLoopsDropped: topology.arcs.length - arcs.length, sameFaceArcs},
    };
}

// A closed arc (it ends where it starts) that encloses less than MIN_LOOP_AREA_DEG2 and is less
// than a degree across. The longitudes are unwrapped first: a border that goes once around the
// globe along a parallel is also a closed arc, and in wrapped longitudes its area looks like 0.
const MIN_LOOP_AREA_DEG2 = 1e-7;        // about 800 m2 at 50 degrees of latitude
function isTinyLoop(arc) {
    if (arc.from !== arc.to) return false;
    const p = arc.points;
    let x = p[0][0], area2 = 0, x0 = x, x1 = x, y0 = p[0][1], y1 = p[0][1];
    for (let i = 1; i < p.length; i++) {
        const next = x + wrapDelta(p[i][0] - p[i - 1][0]);
        area2 += x * p[i][1] - next * p[i - 1][1];
        x = next;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, p[i][1]); y1 = Math.max(y1, p[i][1]);
    }
    return x1 - x0 < 1 && y1 - y0 < 1 && Math.abs(area2) / 2 < MIN_LOOP_AREA_DEG2;
}

module.exports = {zoneTopology, borderChains, simplifyChain, traceFaces, innerPoint, makeZonesAt, encodeBorders,
    buildBorders, standardOffsetHours, isPoleArc, UNITS_PER_DEG};

if (require.main === module) {
    const input = process.argv[2];
    const toleranceDeg = process.argv[3] !== undefined ? Number(process.argv[3]) : DEFAULT_TOLERANCE_DEG;
    if (!input || !(toleranceDeg > 0)) {
        console.error("usage: node --max-old-space-size=12288 scripts/buildTimeZoneBorders.js path/to/combined-with-oceans-1970.json [toleranceDeg]");
        process.exit(1);
    }
    const geojson = JSON.parse(fs.readFileSync(input, "utf8"));
    const map = buildBorders(geojson, toleranceDeg);
    const raw = encodeBorders(map);
    const gz = zlib.gzipSync(raw, {level: 9});
    const output = path.join(__dirname, "..", "data", "timezones", "timezone-borders.bin.gz");
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, gz);
    const points = map.arcs.reduce((sum, arc) => sum + arc.points.length, 0);
    // This Node's tzdata can be older than the source (Node 22: 2024b has no America/Coyhaique).
    const unknown = map.zones.filter(zone => Number.isNaN(zone.standard)).map(zone => zone.name);
    const offsets = new Set(map.zones.map(zone => zone.standard).filter(hours => !Number.isNaN(hours)));
    if (unknown.length) console.log(`no standard offset in this Node's tzdata for: ${unknown.join(", ")}`);
    console.log(`${geojson.features.length} zones, ${offsets.size} standard offsets (Node tzdata `
        + `${process.versions.tz}) -> ${map.arcs.length} arcs, ${points} points, ${map.faces.length} faces, `
        + `tolerance ${toleranceDeg} deg; ${raw.length} bytes, ${gz.length} gzipped -> ${output}`);
    const {zonesAdded, ...stats} = map.stats;
    console.log({...stats, zonesAdded: zonesAdded.length});
    for (const line of zonesAdded) console.log(`  zone from a point test: ${line}`);
}
