// Compact worker cache. Coordinates quantize one bounded region to uint16.
export const ROAD_CLASSES = [
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "residential",
    "service",
    "pedestrian",
    "footway",
    "cycleway",
    "unclassified",
    "unknown",
];
export function stableHash(s) {
    let h = 2166136261;
    for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return h >>> 0;
}
export function buildingStyle(rings, seed, extent) {
    let longest = 0,
        angle = 0;
    for (const ring of rings)
        for (let i = 1; i < ring.length; i++) {
            const a = ring[i - 1],
                b = ring[i];
            // Tile clipping boundaries do not describe a building's orientation.
            if ((a.x === b.x && (a.x <= 0 || a.x >= extent)) || (a.y === b.y && (a.y <= 0 || a.y >= extent))) continue;
            const dx = b.x - a.x,
                dy = a.y - b.y,
                len = dx * dx + dy * dy;
            if (len > longest) {
                longest = len;
                angle = Math.atan2(dy, dx);
            }
        }
    const quarter = Math.PI / 2;
    angle = ((angle % quarter) + quarter) % quarter;
    const heading = Math.round((angle / quarter) * 32) % 32;
    return heading * 8 + (seed % 8);
}
export function encodeCompact(meta, features) {
    const json = new TextEncoder().encode(JSON.stringify({ ...meta, featureCount: features.length }));
    let length = 8 + json.length;
    for (const f of features) {
        length += 8;
        for (const p of f.paths) length += 2 + 4 * p.length;
    }
    const data = new Uint8Array(length),
        v = new DataView(data.buffer);
    let at = 0;
    const u8 = (n) => {
            v.setUint8(at, n);
            at++;
        },
        u16 = (n) => {
            v.setUint16(at, n, true);
            at += 2;
        },
        u32 = (n) => {
            v.setUint32(at, n, true);
            at += 4;
        };
    u32(0x32564c43);
    u32(json.length);
    data.set(json, at);
    at += json.length;
    for (const f of features) {
        if (f.paths.length > 65535) throw new Error("Too many paths");
        u8(f.kind);
        u8(f.style);
        u16(f.paths.length);
        u32(f.seed);
        for (const p of f.paths) {
            if (p.length > 65535) throw new Error("Too many points");
            u16(p.length);
            for (const xy of p) {
                u16(xy[0]);
                u16(xy[1]);
            }
        }
    }
    return data;
}
export function decodeCompact(data) {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let at = 0;
    const u8 = () => v.getUint8(at++),
        u16 = () => {
            const n = v.getUint16(at, true);
            at += 2;
            return n;
        },
        u32 = () => {
            const n = v.getUint32(at, true);
            at += 4;
            return n;
        };
    if (u32() !== 0x32564c43) throw new Error("Unknown city-lights data format");
    const length = u32();
    const meta = JSON.parse(new TextDecoder().decode(data.subarray(at, at + length)));
    at += length;
    const start = at;
    return {
        meta,
        *features() {
            at = start;
            for (let i = 0; i < meta.featureCount; i++) {
                const kind = u8(),
                    style = u8(),
                    n = u16(),
                    seed = u32(),
                    paths = [];
                for (let j = 0; j < n; j++) {
                    const count = u16(),
                        p = [];
                    for (let k = 0; k < count; k++) p.push([u16() / 65535, u16() / 65535]);
                    paths.push(p);
                }
                yield { kind, style, seed, paths };
            }
            if (at !== data.byteLength) throw new Error("City-lights data length mismatch");
        },
        forEachFeature(fn) {
            for (const f of this.features()) fn(f);
        },
    };
}
