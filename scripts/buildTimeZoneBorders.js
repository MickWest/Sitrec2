// Build-time extraction of time zone BORDERS from timezone-boundary-builder into a compact
// file that Sitrec loads on demand (data/timezones/timezone-borders.bin.gz), for
// Time > Show Time Zones.
//
// Source: timezone-boundary-builder by Evan Siroky, the "now" set WITH OCEANS
// (timezones-with-oceans-now.geojson.zip, which holds combined-with-oceans-now.json). It
// covers the whole globe: at sea the zones are the 15-degree nautical bands, merged into the
// land zones that keep the same time. Data © OpenStreetMap contributors, under the Open
// Database License (ODbL). The output is a database derived from it, so it is under the
// ODbL too (see data/timezones/README.md).
//
// The lines are those of an ordinary time zone map: a border is kept only where the
// STANDARD UTC offset (the offset without daylight saving time) changes. Arizona and New
// Mexico are both UTC-7 standard, so there is no line between them. The standard offset of
// a zone is the smaller of its offsets in mid-January and mid-July (daylight saving time
// adds to the offset), read from this Node's IANA data (Intl). Each zone in the "now" set
// is named after the largest city of the group it stands for, so a group whose rules
// changed recently can still give the right offset through that city's name.
//
// Download and unzip the release file by hand, then pass the path:
//
//     node --max-old-space-size=8192 scripts/buildTimeZoneBorders.js path/to/combined-with-oceans-now.json [toleranceDeg]
//
// The script reads the file only; it does not download anything.
//
// METHOD
//  1. Each edge (two consecutive points of a ring) is keyed by its end points, rounded to
//     1e-7 degree, with longitude -180 matched to +180: zones that cross the 180-degree
//     meridian are split there, and the date line is a border between two such halves. An
//     edge is a border when the zones that own it have two or more standard offsets. An
//     edge of one zone only (the poles) and an edge between zones with the same standard
//     offset are dropped.
//  2. Border edges are joined into chains. A chain ends at a junction: a point where the
//     number of border edges is not 2, or where the offsets on the two sides change.
//  3. Each chain is simplified with the Douglas-Peucker method (tolerance in degrees, with
//     longitude scaled by the cosine of the latitude), on longitudes unwrapped across the
//     180-degree meridian. Its end points are kept, so chains still meet at the junctions.
//
// OUTPUT FORMAT "TZB3" (gzip; decoded by src/TimeZoneBorders.js):
//   "TZB3"   4 bytes, format name
//   uint32   number of polylines N (little-endian)
//   uint32   number of points P (little-endian)
//   then, for each polyline: its point count; the standard UTC offset on its left and on its
//   right, facing along the line, in quarter hours, or 127 where that side has no single
//   offset (zones overlap in disputed areas); the labels use them to know the zone between two
//   crossings. Then its points as longitude, latitude pairs
//   in units of 1e-4 degree (about 11 m). The first point is absolute; every other point is
//   the difference from the point before it. Every number after the header is a varint
//   (7 bits per byte, low bits first, high bit set on all bytes but the last), and the
//   coordinates are zigzag-coded first (0, -1, 1, -2 ... -> 0, 1, 2, 3 ...), so a small
//   difference takes one or two bytes.
//
// SIZE (release 2026f, gzipped): tolerance 0.001 deg -> 488 KB, 0.002 -> 336 KB,
// 0.005 -> 190 KB, 0.01 -> 119 KB, 0.02 -> 73 KB. With 32-bit numbers at 1e-5 degree,
// 0.01 was 181 KB. The default, 0.01 deg (about 1.1 km), is far below what shows at the
// scale of a country.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const DEFAULT_TOLERANCE_DEG = 0.01;     // about 1.1 km (see SIZE above)
const UNITS_PER_DEG = 1e4;              // stored resolution, about 11 m
const UNKNOWN_SIDE = 127;               // quarter hours; no real offset is near it (max 14 h = 56)
const KEY_SCALE = 1e7;                  // edge-matching resolution

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

// The border edges of a GeoJSON FeatureCollection, as chains {points: [[lon, lat], ...], left,
// right}: left and right are the groups on each side, facing along the chain.
// zoneKey(feature) names the group a zone belongs to; a border separates two groups.
function borderChains(geojson, zoneKey = feature => String(standardOffsetHours(feature.properties.tzid))) {
    const pointIds = new Map();          // rounded "lon,lat" -> point id
    const points = [];                   // id -> [lon, lat]
    const pointId = ([lon, lat]) => {
        const keyLon = lon === -180 ? 180 : lon;    // the two sides of the 180-degree meridian
        const key = `${Math.round(keyLon * KEY_SCALE)},${Math.round(lat * KEY_SCALE)}`;
        let id = pointIds.get(key);
        if (id === undefined) {
            id = points.length;
            points.push([lon, lat]);
            pointIds.set(key, id);
        }
        return id;
    };

    // The two sides of the 180-degree meridian need not put their points at the same
    // latitudes (in 2026f, Fiji's side has a point at 70 S, the Etc/GMT+12 side one at 75 S),
    // so an edge that lies ON the meridian would never match the other side's edge. Every such
    // edge is therefore split at every meridian point of either side; the pieces then match.
    const onMeridian = lon => Math.abs(lon) === 180;
    const meridianLatitudes = new Set();
    for (const feature of geojson.features) {
        for (const {ring} of polygonRings(feature.geometry)) {
            for (const [lon, lat] of ring) if (onMeridian(lon)) meridianLatitudes.add(lat);
        }
    }
    const meridianSorted = [...meridianLatitudes].sort((x, y) => x - y);
    const meridianPointsBetween = (latA, latB) => {
        const low = Math.min(latA, latB), high = Math.max(latA, latB);
        const between = meridianSorted.filter(lat => lat > low && lat < high);
        return latA < latB ? between : between.reverse();
    };

    // edge "a,b" (a < b) -> the zone groups that own it, and which side of the direction a -> b
    // each is on. A zone is on the LEFT of its own ring's edges when the outer ring runs
    // counterclockwise or a hole runs clockwise; the sign of the ring's area says which.
    const edgeOwners = new Map();
    const addEdge = (previous, current, zone, zoneOnLeft) => {
        if (current === previous) return;
        const key = previous < current ? `${previous},${current}` : `${current},${previous}`;
        let owners = edgeOwners.get(key);
        if (!owners) {
            owners = {all: new Set(), left: new Set(), right: new Set()};
            edgeOwners.set(key, owners);
        }
        owners.all.add(zone);
        owners[(previous < current) === zoneOnLeft ? "left" : "right"].add(zone);
    };
    geojson.features.forEach(feature => {
        const zone = zoneKey(feature);
        for (const {ring, isHole} of polygonRings(feature.geometry)) {
            const area = signedArea2(ring);
            const zoneOnLeft = isHole ? area < 0 : area > 0;
            let previous = pointId(ring[0]);
            for (let i = 1; i < ring.length; i++) {
                const [lonA, latA] = ring[i - 1], [lonB, latB] = ring[i];
                if (onMeridian(lonA) && onMeridian(lonB)) {
                    for (const lat of meridianPointsBetween(latA, latB)) {
                        const middle = pointId([180, lat]);
                        addEdge(previous, middle, zone, zoneOnLeft);
                        previous = middle;
                    }
                }
                const current = pointId(ring[i]);
                addEdge(previous, current, zone, zoneOnLeft);
                previous = current;
            }
        }
    });

    // Keep the borders: edges owned by two or more groups. Group the edges at each point.
    const edges = [];                    // [a, b, ownersKey, left group, right group] (sides of a -> b)
    const edgesAtPoint = new Map();      // point id -> edge indices
    const only = set => (set.size === 1 ? [...set][0] : undefined);
    for (const [key, owners] of edgeOwners) {
        if (owners.all.size < 2) continue;
        const [a, b] = key.split(",").map(Number);
        const index = edges.length;
        edges.push([a, b, [...owners.all].sort().join("|"), only(owners.left), only(owners.right)]);
        for (const p of [a, b]) {
            let list = edgesAtPoint.get(p);
            if (!list) {
                list = [];
                edgesAtPoint.set(p, list);
            }
            list.push(index);
        }
    }

    const isJunction = (p) => {
        const list = edgesAtPoint.get(p);
        return list.length !== 2 || edges[list[0]][2] !== edges[list[1]][2];
    };

    const used = new Uint8Array(edges.length);
    const chains = [];
    const walk = (start, firstEdge) => {
        const chain = [start];
        let p = start, e = firstEdge;
        // The sides of the chain in its own direction: those of its first edge, swapped when
        // the walk runs b -> a. The owners do not change along a chain (see isJunction).
        const [firstA, , , firstLeft, firstRight] = edges[firstEdge];
        const left = start === firstA ? firstLeft : firstRight;
        const right = start === firstA ? firstRight : firstLeft;
        for (;;) {
            used[e] = 1;
            const [a, b] = edges[e];
            p = a === p ? b : a;
            chain.push(p);
            if (p === start || isJunction(p)) break;
            const next = edgesAtPoint.get(p).find(candidate => !used[candidate]);
            if (next === undefined) break;
            e = next;
        }
        chains.push({points: chain.map(id => points[id]), left, right});
    };

    // Chains that start at a junction, then closed loops with no junction (an enclave).
    for (const [p, list] of edgesAtPoint) {
        if (!isJunction(p)) continue;
        for (const e of list) if (!used[e]) walk(p, e);
    }
    for (let e = 0; e < edges.length; e++) {
        if (!used[e]) walk(edges[e][0], e);
    }
    return chains;
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

// Polylines -> the binary format above (not yet gzipped).
// polylines: [{points: [[lon, lat], ...], left, right}], left and right in hours of UTC offset.
function encodeBorders(polylines) {
    const pointCount = polylines.reduce((sum, line) => sum + line.points.length, 0);
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
    for (const line of polylines) {
        pushVarint(line.points.length);
        // Quarter hours; UNKNOWN_SIDE where zones overlap (disputed areas), so a side has no
        // single offset.
        const quarters = hours => (Number.isFinite(Number(hours)) ? Math.round(Number(hours) * 4) : UNKNOWN_SIDE);
        pushSigned(quarters(line.left));
        pushSigned(quarters(line.right));
        let lastLon = 0, lastLat = 0;
        line.points.forEach(([lon, lat], i) => {
            const qLon = Math.round(lon * UNITS_PER_DEG), qLat = Math.round(lat * UNITS_PER_DEG);
            pushSigned(i === 0 ? qLon : qLon - lastLon);
            pushSigned(i === 0 ? qLat : qLat - lastLat);
            lastLon = qLon;
            lastLat = qLat;
        });
    }
    const header = Buffer.alloc(12);
    header.write("TZB3", 0, "ascii");
    header.writeUInt32LE(polylines.length, 4);
    header.writeUInt32LE(pointCount, 8);
    return Buffer.concat([header, Buffer.from(bytes)]);
}

// zoneKey: see borderChains. Left out, the zones are grouped by standard UTC offset.
function buildBorders(geojson, toleranceDeg = DEFAULT_TOLERANCE_DEG, zoneKey = undefined) {
    return borderChains(geojson, zoneKey)
        .map(chain => ({...chain, points: simplifyChain(chain.points, toleranceDeg)}))
        .filter(line => line.points.length >= 2);
}

module.exports = {borderChains, simplifyChain, encodeBorders, buildBorders, standardOffsetHours, UNITS_PER_DEG, UNKNOWN_SIDE};

if (require.main === module) {
    const input = process.argv[2];
    const toleranceDeg = process.argv[3] !== undefined ? Number(process.argv[3]) : DEFAULT_TOLERANCE_DEG;
    if (!input || !(toleranceDeg > 0)) {
        console.error("usage: node --max-old-space-size=8192 scripts/buildTimeZoneBorders.js path/to/combined-with-oceans-now.json [toleranceDeg]");
        process.exit(1);
    }
    const geojson = JSON.parse(fs.readFileSync(input, "utf8"));
    const polylines = buildBorders(geojson, toleranceDeg);
    const raw = encodeBorders(polylines);
    const gz = zlib.gzipSync(raw, {level: 9});
    const output = path.join(__dirname, "..", "data", "timezones", "timezone-borders.bin.gz");
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, gz);
    const points = polylines.reduce((sum, line) => sum + line.points.length, 0);
    const offsets = new Set(geojson.features.map(feature => standardOffsetHours(feature.properties.tzid)));
    console.log(`${geojson.features.length} zones, ${offsets.size} standard offsets (Node tzdata `
        + `${process.versions.tz}) -> ${polylines.length} border lines, ${points} points, `
        + `tolerance ${toleranceDeg} deg; ${raw.length} bytes, ${gz.length} gzipped -> ${output}`);
}
