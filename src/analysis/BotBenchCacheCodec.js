/**
 * JSON codec for BOTBench's on-disk analysis cache.
 *
 * WHY NOT PLAIN JSON.stringify. The analysis output is not JSON-shaped in two
 * ways that both corrupt silently rather than fail:
 *
 *   - Every candidate track is a Float64Array. JSON.stringify turns one into
 *     {"0":123,"1":456,...} — an object with string keys, three times the size,
 *     which reads back as something no numeric code path can use.
 *   - NaN and Infinity stringify as `null`. Both are REAL VALUES here: a range
 *     violation for an at-infinity hypothesis is literally Infinity, and an
 *     unscored metric is NaN. Reading them back as null turns "beyond any
 *     finite range" into "no value" and a missing score into a zero.
 *
 * So numbers and typed arrays are encoded explicitly, and ANYTHING ELSE the
 * walker does not recognise — a function, a Date, a Map, a class instance —
 * THROWS, naming the path. That is the point: a cache that silently dropped a
 * field would produce a run that differs from a fresh one in a way nothing
 * downstream could detect. Failing the write is recoverable (the file is
 * re-analysed next time); a wrong cache hit is not.
 *
 * Byte order is the host's. Caches are keyed by app version and by content
 * hash and are meant to sit beside the files that made them, not to travel;
 * every platform Sitrec runs on is little-endian in any case.
 */

const TYPED_ARRAYS = {
    Float64Array, Float32Array,
    Int32Array, Int16Array, Int8Array,
    Uint32Array, Uint16Array, Uint8Array, Uint8ClampedArray,
};

function toBase64(u8) {
    let s = "";
    // In chunks: String.fromCharCode.apply blows the argument limit on a track
    // array of any size (a 700-frame candidate is 16,800 bytes).
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(s);
}

function fromBase64(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
}

/** Encode `value` into something JSON.stringify round-trips without loss. */
export function packForCache(value, path = "$") {
    if (value === null) return null;
    if (value === undefined) return {__undef: true};

    const type = typeof value;
    if (type === "boolean" || type === "string") return value;
    if (type === "number") {
        if (Number.isFinite(value)) return value;
        return {__num: Number.isNaN(value) ? "NaN" : (value > 0 ? "Infinity" : "-Infinity")};
    }
    if (type !== "object") {
        throw new Error(`BotBench cache: cannot encode ${type} at ${path}`);
    }

    if (ArrayBuffer.isView(value)) {
        const name = value.constructor?.name;
        if (!TYPED_ARRAYS[name]) {
            throw new Error(`BotBench cache: unsupported view ${name} at ${path}`);
        }
        return {__ta: name, d: toBase64(new Uint8Array(value.buffer,
            value.byteOffset, value.byteLength))};
    }

    if (Array.isArray(value)) {
        const items = value.map((v, i) => packForCache(v, `${path}[${i}]`));
        // ARRAYS HERE CARRY FIELDS. rangeProfile returns the profile rows as an
        // array and hangs bestIndex / familyLoIndex / boundaryLimited / boundarySides
        // off the array OBJECT, and JSON.stringify silently keeps only the
        // indices. That is not a hypothetical: dropping slowProfile.boundaryLimited
        // turned a manifest's "the slow-profile search hit its edge" from true to
        // false on a cached run — a completeness claim inverted, with the tracks
        // themselves identical, which is precisely the sort of difference nobody
        // would ever notice by looking.
        const extra = Object.keys(value).filter((k) => !/^(0|[1-9]\d*)$/.test(k));
        if (!extra.length) return items;
        const props = {};
        for (const key of extra) props[key] = packForCache(value[key], `${path}.${key}`);
        return {__arr: items, p: props};
    }

    // Plain objects only. A class instance would lose its prototype and come
    // back as a bag of fields whose methods are gone — which is exactly the
    // kind of difference this cache must not introduce.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
        throw new Error(`BotBench cache: cannot encode a `
            + `${value.constructor?.name ?? "non-plain object"} at ${path}`);
    }
    const out = {};
    for (const key of Object.keys(value)) {
        // The encoded forms are objects with reserved keys, so a real field of
        // the same name would decode as an encoding. Nothing in the analysis
        // uses these names, and the check makes sure that stays true.
        if (key === "__ta" || key === "__num" || key === "__undef" || key === "__arr") {
            throw new Error(`BotBench cache: reserved key "${key}" at ${path}`);
        }
        out[key] = packForCache(value[key], `${path}.${key}`);
    }
    return out;
}

/** The inverse of packForCache. */
export function unpackFromCache(value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(unpackFromCache);
    if (Array.isArray(value.__arr)) {
        const out = value.__arr.map(unpackFromCache);
        for (const key of Object.keys(value.p ?? {})) out[key] = unpackFromCache(value.p[key]);
        return out;
    }
    if (value.__undef === true) return undefined;
    if (typeof value.__num === "string") {
        return value.__num === "NaN" ? NaN
            : value.__num === "Infinity" ? Infinity : -Infinity;
    }
    if (typeof value.__ta === "string") {
        const Ctor = TYPED_ARRAYS[value.__ta];
        if (!Ctor) throw new Error(`BotBench cache: unknown array type ${value.__ta}`);
        const bytes = fromBase64(value.d);
        // Copy into a fresh buffer rather than viewing the decode buffer: a
        // Float64Array needs 8-byte alignment, which a shared offset cannot
        // promise, and a stale view would keep the whole decode alive.
        return new Ctor(bytes.buffer.slice(bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength));
    }
    const out = {};
    for (const key of Object.keys(value)) out[key] = unpackFromCache(value[key]);
    return out;
}
