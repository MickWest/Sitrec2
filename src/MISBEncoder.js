// Binary ST 0601 local sets. Values are in the same units as MISBFields:
// degrees, metres, and integer microseconds since the Unix epoch.
const KEY = Uint8Array.from([6,14,43,52,2,11,1,1,14,1,3,1,1,0,0,0]);
const TEXT_FIELDS = new Set([3, 4, 10, 11, 12]);
const FIELDS = {
    5: [2, 0, 360], 6: [2, -20, 20], 7: [2, -50, 50],
    13: [4, -90, 90], 14: [4, -180, 180], 15: [2, -900, 19000],
    16: [2, 0, 180], 17: [2, 0, 180], 18: [4, 0, 360],
    19: [4, -180, 180], 20: [4, 0, 360], 21: [4, 0, 5000000],
    23: [4, -90, 90], 24: [4, -180, 180], 25: [2, -900, 19000],
    // Target Location: where the tracked object is, as distinct from tag
    // 23/24/25's boresight-on-ground frame centre. Latitude and longitude get
    // the same 4-byte resolution as the sensor position (~5 mm); elevation is
    // 2 bytes over -900..19000 m, so it quantizes to 0.30 m — tag 21's slant
    // range carries the radial component at 1.2 mm when that matters.
    40: [4, -90, 90], 41: [4, -180, 180], 42: [2, -900, 19000],
};

export function berLength(n) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid BER length");
    if (n < 128) return [n];
    const bytes = [];
    for (; n; n = Math.floor(n / 256)) bytes.unshift(n % 256);
    return [0x80 | bytes.length, ...bytes];
}

export function encodeMISBLocalSet(values) {
    if (!Number.isSafeInteger(values[2]) || values[2] < 0) throw new Error("MISB timestamp must be integer microseconds");
    const payload = [];
    // Timestamp first, checksum last. Emit only fields whose meaning is known.
    for (const [tag, value] of Object.entries({...values, 65: 13}).sort((a, b) => Number(a[0]) - Number(b[0]))) {
        const key = Number(tag);
        let bytes;
        if (key === 2) {
            bytes = new Uint8Array(8);
            new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
        } else if (key === 65) {
            bytes = [value];
        } else if (TEXT_FIELDS.has(key)) {
            if (typeof value !== "string") throw new Error(`MISB tag ${key} must be text`);
            bytes = new TextEncoder().encode(value);
            if (!bytes.length || bytes.length > 127) throw new Error(`MISB tag ${key} text must be 1..127 bytes`);
        } else {
            const field = FIELDS[key];
            if (!field) throw new Error(`Unsupported MISB export tag ${key}`);
            const [size, min, max] = field;
            if (!Number.isFinite(value) || value < min || value > max) throw new Error(`MISB tag ${key} out of range: ${value}`);
            const signed = min === -max;
            const limit = 2 ** (8 * size - (signed ? 1 : 0)) - 1;
            const raw = Math.round(signed ? value / max * limit : (value - min) / (max - min) * limit);
            bytes = new Uint8Array(size);
            const view = new DataView(bytes.buffer);
            view[`${signed ? "setInt" : "setUint"}${size * 8}`](0, raw);
        }
        payload.push(key, ...berLength(bytes.length), ...bytes);
    }
    const packet = Uint8Array.from([...KEY, ...berLength(payload.length + 4), ...payload, 1, 2, 0, 0]);
    let sum = 0;
    for (let i = 0; i < packet.length - 2; i++) sum += packet[i] << (i % 2 === 0 ? 8 : 0);
    new DataView(packet.buffer).setUint16(packet.length - 2, sum & 0xffff);
    return packet;
}
