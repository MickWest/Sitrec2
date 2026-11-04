// The time zone map file (data/timezones/timezone-borders.bin.gz): loading, decoding, and the
// zones at a point. Shared by Time > Show Time Zones (TimeZoneBorders.js, which draws it) and the
// zone at a position (lookupTimeZone in TimeZoneLookup.js). It imports neither, so neither import
// makes a cycle.
//
// The file holds the zones of timezone-boundary-builder's "1970" set (304 zones in 2026f): zones
// whose clocks have been the same since 1970 are one zone. So a zone of the file has one history
// of UTC offsets since 1970, and the browser's rules (Intl) give its offset on any such date. It
// is fetched the first time it is needed, never at startup, and kept for the session.
// scripts/buildTimeZoneBorders.js makes it and describes its format.

import {SITREC_APP} from "./configUtils";

const MAP_FILE = "data/timezones/timezone-borders.bin.gz";
const UNITS_PER_DEG = 1e4;      // must match scripts/buildTimeZoneBorders.js
const NO_STANDARD = 126;        // quarter hours: a zone with no standard offset (as there)

let mapPromise = null;          // the decoded file, loaded once per session

// The "TZB5" format of scripts/buildTimeZoneBorders.js (read its header), as
// {zones: [{name, standard}] (standard offset in hours, NaN when not known),
//  counts: Uint32Array (points in each arc), lonLat: Float64Array (lon, lat in degrees),
//  leftFace, rightFace: Int32Array (the face on each side of each arc, facing along it; -1 none),
//  faces: [{zones: [zone index...], pole: -1 | 0 | 1, rings: [[half-arc...], ...]}]}.
export function decodeTimeZoneBorders(buffer) {
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const name = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (name !== "TZB5") throw new Error(`not a time zone border file (starts "${name}")`);
    const zoneCount = view.getUint32(4, true);
    const lineCount = view.getUint32(8, true);
    const pointCount = view.getUint32(12, true);
    const faceCount = view.getUint32(16, true);

    let offset = 20;
    const readVarint = () => {
        let value = 0, shift = 0, byte;
        do {
            if (offset >= bytes.byteLength) throw new Error("time zone border file is too short");
            byte = bytes[offset++];
            value += (byte & 0x7f) * 2 ** shift;      // not <<, which overflows past 31 bits
            shift += 7;
        } while (byte & 0x80);
        return value;
    };
    const readSigned = () => {
        const value = readVarint();
        return value % 2 === 0 ? value / 2 : -(value + 1) / 2;    // undo the zigzag
    };

    const zones = [];
    for (let i = 0; i < zoneCount; i++) {
        const length = readVarint();
        if (offset + length > bytes.byteLength) throw new Error("time zone border file is too short");
        const zoneName = String.fromCharCode(...bytes.subarray(offset, offset + length));
        offset += length;
        const quarters = readSigned();
        zones.push({name: zoneName, standard: quarters === NO_STANDARD ? NaN : quarters / 4});
    }
    const counts = new Uint32Array(lineCount);
    const leftFace = new Int32Array(lineCount);
    const rightFace = new Int32Array(lineCount);
    const lonLat = new Float64Array(2 * pointCount);
    let k = 0;
    for (let i = 0; i < lineCount; i++) {
        const count = readVarint();
        counts[i] = count;
        leftFace[i] = readVarint() - 1;
        rightFace[i] = readVarint() - 1;
        if (leftFace[i] >= faceCount || rightFace[i] >= faceCount) throw new Error("time zone border file has a bad arc");
        if (k + 2 * count > lonLat.length) throw new Error("time zone border file has too many points");
        let lon = 0, lat = 0;
        for (let j = 0; j < count; j++) {
            lon += readSigned();        // the first point is absolute (lon starts at 0), then differences
            lat += readSigned();
            lonLat[k++] = lon / UNITS_PER_DEG;
            lonLat[k++] = lat / UNITS_PER_DEG;
        }
    }
    if (k !== lonLat.length) throw new Error("time zone border file has the wrong length");
    const faces = [];
    for (let i = 0; i < faceCount; i++) {
        const faceZones = [];
        for (let n = readVarint(); n > 0; n--) {
            const zone = readVarint();
            if (zone >= zoneCount) throw new Error("time zone border file has a bad face");
            faceZones.push(zone);
        }
        const pole = readSigned();
        const rings = [];
        for (let r = readVarint(); r > 0; r--) {
            const ring = [];
            for (let n = readVarint(); n > 0; n--) {
                const half = readVarint();
                if ((half >> 1) >= lineCount) throw new Error("time zone border file has a bad face");
                ring.push(half);
            }
            rings.push(ring);
        }
        faces.push({zones: faceZones, pole, rings});
    }
    if (offset !== bytes.byteLength) throw new Error("time zone border file has the wrong length");
    return {zones, counts, lonLat, leftFace, rightFace, faces};
}

async function gunzip(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    // A server can send the file already decoded (Content-Encoding: gzip); only a gzip
    // stream starts with 1f 8b.
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return arrayBuffer;
    const stream = new Response(bytes).body.pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).arrayBuffer();
}

// The decoded map (decodeTimeZoneBorders), fetched on first use and kept for the session. A
// failed load is tried again on the next call.
export function loadTimeZoneMap() {
    if (!mapPromise) {
        mapPromise = fetch(SITREC_APP + MAP_FILE)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status} for ${MAP_FILE}`);
                return response.arrayBuffer();
            })
            .then(gunzip)
            .then(decodeTimeZoneBorders)
            .catch(error => {
                mapPromise = null;
                throw error;
            });
    }
    return mapPromise;
}

// ------------------------------------------------------------------------- zones at a point

// The rings of a face as flat [lon, lat, lon, lat...] arrays, longitudes unwrapped along each
// ring, and the holes moved by whole turns into the outer ring's span (as buildTimeZoneFill
// does). An outer ring that goes around a pole is closed through it. An arc is a straight line
// in longitude/latitude, so its stored points are enough.
function faceRings(borders, face, arcStart) {
    const {counts, lonLat} = borders;
    const ringOf = halves => {
        const ring = [];
        for (const half of halves) {
            const arc = half >> 1, count = counts[arc], first = arcStart[arc];
            for (let j = ring.length ? 1 : 0; j < count; j++) {
                const k = 2 * (first + ((half & 1) ? count - 1 - j : j));
                let lon = lonLat[k];
                if (ring.length) {
                    const previous = ring[ring.length - 2];
                    lon = previous + ((((lon - previous) % 360) + 540) % 360) - 180;
                }
                ring.push(lon, lonLat[k + 1]);
            }
        }
        return ring;
    };
    const outer = ringOf(face.rings[0]);
    if (face.pole && outer.length >= 2) {
        const pole = 90 * Math.sign(face.pole);
        outer.push(outer[outer.length - 2], pole, outer[0], pole);
    }
    let minLon = Infinity;
    for (let i = 0; i < outer.length; i += 2) minLon = Math.min(minLon, outer[i]);
    const holes = face.rings.slice(1).map(halves => {
        const hole = ringOf(halves);
        const turns = hole.length ? -360 * Math.floor((hole[0] - minLon) / 360) : 0;
        for (let i = 0; i < hole.length; i += 2) hole[i] += turns;
        return hole;
    });
    return [outer, ...holes];
}

// A function (lat, lon) => [zone name...]: the zones of the face of the map that holds the
// point, more than one where zones overlap on purpose (Xinjiang, the West Bank), [] where none
// does. The face borders are simplified to about 1.1 km, so a point closer than that to a
// border can get the zone on the other side.
export function makeZoneLocator(borders) {
    const arcStart = new Uint32Array(borders.counts.length);
    for (let i = 1; i < borders.counts.length; i++) arcStart[i] = arcStart[i - 1] + borders.counts[i - 1];
    const faces = borders.faces.map(face => {
        const rings = faceRings(borders, face, arcStart);
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        const outer = rings[0];
        for (let i = 0; i < outer.length; i += 2) {
            x0 = Math.min(x0, outer[i]); x1 = Math.max(x1, outer[i]);
            y0 = Math.min(y0, outer[i + 1]); y1 = Math.max(y1, outer[i + 1]);
        }
        return {rings, box: [x0, y0, x1, y1], zones: face.zones.map(z => borders.zones[z].name)};
    });
    const inside = (x, y, rings) => {
        let odd = false;        // even-odd over the outer ring and its holes
        for (const ring of rings) {
            for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
                const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
                if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) odd = !odd;
            }
        }
        return odd;
    };
    return (lat, lon) => {
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return [];
        const found = new Set();
        for (const {rings, box, zones} of faces) {
            if (lat < box[1] || lat > box[3]) continue;
            // The face's longitudes are unwrapped: try the point a whole turn either way too.
            for (let x = lon - 720; x <= box[2]; x += 360) {
                if (x >= box[0] && inside(x, lat, rings)) {
                    for (const zone of zones) found.add(zone);
                    break;
                }
            }
        }
        return [...found];
    };
}

const locators = new WeakMap();

// The zones at a point in a decoded map (makeZoneLocator, made once per map).
export function zonesAtPoint(borders, lat, lon) {
    let locate = locators.get(borders);
    if (!locate) {
        locate = makeZoneLocator(borders);
        locators.set(borders, locate);
    }
    return locate(lat, lon);
}
