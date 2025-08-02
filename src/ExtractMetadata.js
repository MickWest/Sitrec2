export function extractAllMetaData(boxes) {
    //dumpAllBoxData(boxes);

    const udta = findBox(boxes, ['moov', 'udta']);
    const meta = findBox(boxes, ['moov', 'meta']) || findBox(boxes, ['moov', 'udta', 'meta']);
    const mvhd = findBox(boxes, ['moov', 'mvhd']);
    const moov = findBox(boxes, ['moov']);

    //const meta = Array.isArray(metaBox) ? metaBox[0] : metaBox;

    console.log("UDTA:", udta);
    console.log("META:", meta);
    console.log("MVHD:", mvhd);

    const appleMeta = moov?.find(b => b.type === 'meta' && b.data && b.data.byteLength > 0);
    const metaMap = appleMeta?.data ? parseMetaData(appleMeta) : new Map();
  //  console.log("Apple-style meta map:", metaMap);

    const gps =
        debugWrap("ISO6709", () => extractFromISO6709Map(metaMap)) ||
        debugWrap("XYZ", () => extractFromXYZ(meta)) ||
        debugWrap("LocationInformation", () => extractFromLocationInformation(udta)) ||
        debugWrap("LOCI", () => extractFromLoci(udta));

    const date =
        debugWrap("QuicktimeCreationDateMap", () => extractFromQuickTimeCreationDateMap(metaMap)) ||
        debugWrap("DateTimeOriginal", () => extractFromDateTimeOriginal(meta)) ||
        debugWrap("QuicktimeCreationDate", () => extractFromQuickTimeCreationDate(meta)) ||
        debugWrap("DateBox", () => extractFromDateBox(udta)) ||
        debugWrap("Day", () => extractFromDay(meta)) ||
        debugWrap("Mvhd", () => extractFromMvhd(mvhd));

    return {
        latitude: gps?.latitude ?? null,
        longitude: gps?.longitude ?? null,
        altitude: gps?.altitude ?? null,
        creationDate: date ?? null,
    };
}

// dump lines of 16 hex bytes and their ASCII representation
// useful for debugging binary data
function hexDump(buffer) {
    while (buffer.length > 0) {
        const line = buffer.slice(0, 16);
        const hex = line.toString('hex').match(/.{1,2}/g).join(' ');
        const ascii = line.toString('ascii').replace(/[^\x20-\x7E]/g, '.');
        console.log(`${hex.padEnd(48)} | ${ascii}`);
        buffer = buffer.slice(16);
    }


}

// a reader class to parse a byte buffer
// has an offset and a method to read bytes
class ByteReader {
    constructor(buffer) {
        this.buffer = buffer;
        this.offset = 0;
    }

    readUInt32BE() {
        if (typeof this.buffer.readUInt32BE === 'function') {
            const value = this.buffer.readUInt32BE(this.offset);
            this.offset += 4;
            return value;
        } else {
            // Fallback for Uint8Array or ArrayBuffer
            const value =
                (this.buffer[this.offset] << 24) |
                (this.buffer[this.offset + 1] << 16) |
                (this.buffer[this.offset + 2] << 8) |
                (this.buffer[this.offset + 3]);
            this.offset += 4;
            return value >>> 0;
        }
    }

    readByte() {
        const value = this.buffer[this.offset];
        this.offset += 1;
        return value;
    }

    readString(length) {
        const bytes = this.buffer.slice(this.offset, this.offset + length);
        const str = new TextDecoder('utf-8').decode(bytes);
        this.offset += length;
        return str;
    }

    readNullTerminatedString() {
        let str = '';
        while (this.offset < this.buffer.length) {
            const byte = this.buffer[this.offset++];
            if (byte === 0) break; // null terminator
            str += String.fromCharCode(byte);
        }
        return str;
    }

    readBytes(length) {
        const bytes = this.buffer.slice(this.offset, this.offset + length);
        this.offset += length;
        return bytes;
    }

    skipBytes(length) {
        if (this.offset + length > this.buffer.length) {
            throw new Error("Attempt to skip beyond buffer length");
        }
        this.offset += length;
    }

    hasMore() {
        return this.offset < this.buffer.length;
    }
}

function parseMetaData(meta) {
    let buffer = meta.data;
    let reader = new ByteReader(buffer);

    const hdlr = reader.readString(4);
    if (hdlr !== 'hdlr') {
        console.warn("Expected 'hdlr' atom, found:", hdlr);
        return new Map();
    }

    const version = reader.readByte();
    const flags = reader.readBytes(3);
    const predefined = reader.readBytes(4); // predefined bytes, usually 0
    const handlerType = reader.readString(4);

    if (handlerType !== 'mdta') {
        console.warn("Expected 'mdta' handler type, found:", handlerType);
        return new Map();
    }

    reader.readBytes(12); // skip reserved bytes (3 const uint32s)

    const humanReadableName = reader.readNullTerminatedString();
    console.log("Human-readable name:", humanReadableName);

    //const keysAtom = reader.readString(40);

   //console.log("Keys Atom:", keysAtom);

    reader.readByte();

    const atomSize = reader.readUInt32BE();
    const atomType = reader.readString(4);

    console.log("Atom Type:", atomType, "Size:", atomSize);

    // parsing keys will give us an array of keys
    // that we can later use as the key for the values in ilst
    if (atomType !== 'keys') {
        console.warn("Expected 'keys' atom, found:", atomType);
        return new Map();
    }

    reader.skipBytes(4); // skip version and flags

    const keyCount = reader.readUInt32BE();
    console.log("Key Count:", keyCount);
    const keys = [];
    for (let i = 0; i < keyCount; i++) {
        const keySize = reader.readUInt32BE();
        const namespace = reader.readString(4); // usually 'mdta'
        const key = reader.readString(keySize - 8); // -8 for the size and namespace bytes
        keys.push(key);
        console.log("Key:", key);
    }

    // see: https://developer.apple.com/documentation/quicktime-file-format/metadata_item_list_atom

    const ilstAtomSize = reader.readUInt32BE();
    const ilstAtomType = reader.readString(4);
    console.log("ILST Atom Type:", ilstAtomType, "Size:", ilstAtomSize);

    const kv = new Map();
    if (ilstAtomType !== 'ilst') {
        console.warn("Expected 'ilst' atom, found:", ilstAtomType);
        return kv;
    }

    const endOffset = reader.offset + ilstAtomSize - 8; // -8 for the size and type bytes
    while (reader.offset < endOffset && reader.hasMore()) {

        // EXAMPLE
        // 0000001D  DataSize 29 bytes (correct, entire atom size, including these 4 bytes)
        // 00000004  index = 4 (the index of the key in the keys array, correct)
        // 00000015  type, not sure what this is, but it seems to be the type of the data
        // 64617461  type of atom, should be 'data'
        // 00000001  ??
        // 00000000  ??
        // 4170706C 65




        const dataSize = reader.readUInt32BE();
        const nextOffset = reader.offset + dataSize - 4;
        const dataIndex = reader.readUInt32BE();
        const dataType = reader.readUInt32BE(4);
        console.log("Data Type:", dataType, "Index", dataIndex, "Size:", dataSize);

        const actualType = reader.readString(4);
        if (actualType !== 'data') {
            console.warn("Expected 'data' atom, found:", actualType);
            reader.skipBytes(dataSize - 12); // skip to the next atom
            continue;
        }

        // not sure about this
        reader.skipBytes(8);

        // THIS IS NOT RIGHT, PROBABLY NEED TO BE SKIPPIN
        // SOME MORE OPTIONAL ATOMS HERE, AND THE ABOVE IS SUS

        kv[keys[dataIndex-1]] = reader.readString(dataSize - 24);



    }

    console.log("Extracted Key-Value Pairs:", kv);


   // debugger;

    return kv;

}




function extractFromISO6709Map(metaMap) {
    const str = metaMap['com.apple.quicktime.location.ISO6709'];
    if (!str) return null;
    const m = str.match(/^([+-][0-9.]+)([+-][0-9.]+)([+-][0-9.]+)?/);
    if (!m) return null;

    return {
        latitude: parseFloat(m[1]),
        longitude: parseFloat(m[2]),
        altitude: m[3] ? parseFloat(m[3]) : null,
    };
}

function extractFromQuickTimeCreationDateMap(metaMap) {
    const raw = metaMap['com.apple.quicktime.creationdate'];
    if (!raw) return null;
    return raw;
}

function extractFromQuickTimeCreationDate(ilst) {
    const box = ilst?.find(b => b.type === 'com.apple.quicktime.creationdate');
    const raw = box?.boxes?.find(b => b.type === 'data')?.data;
    if (!raw) return null;
    return decodeText(raw);
}

// ... existing helper and extractor functions remain unchanged below


function dumpAllBoxData(boxes, path = []) {
    for (const box of boxes) {
        const fullPath = [...path, box.type].join('/');
        if (box.data) {
            const text = decodeText(box.data);
            const float32 = new Float32Array(box.data.buffer, box.data.byteOffset, Math.floor(box.data.byteLength / 4));
            const float64 = new Float64Array(box.data.buffer, box.data.byteOffset, Math.floor(box.data.byteLength / 8));
            console.group(`Box: ${fullPath}`);
            console.log("Raw Bytes:", box.data);
            console.log("As String:", text);
            console.log("As Float32Array:", Array.from(float32));
            console.log("As Float64Array:", Array.from(float64));
            console.groupEnd();
        }
        if (box.boxes) dumpAllBoxData(box.boxes, [...path, box.type]);
    }
}

function debugWrap(label, fn) {
    try {
        const result = fn();
        console.log(`✔ ${label}:`, result);
        return result;
    } catch (e) {
        console.warn(`✖ ${label} failed:`, e);
        return null;
    }
}

function findBox(boxes, path) {
    let current = boxes;
    for (const name of path) {
        const next = current?.find(b => b.type === name);
        if (!next) return null;
        current = next.boxes;
    }
    return current?.__box || current;
}

function decodeText(uint8arr) {
    return new TextDecoder().decode(uint8arr).replace(/\0/g, '').trim();
}

function extractFromLocationInformation(udta) {
    const box = udta?.find(
        b =>
            b.type === 'com.apple.quicktime.location' ||
            b.type === 'LocationInformation'
    );
    if (!box?.data) return null;

    const str = decodeText(box.data);
    const match = str.match(/Lat=([-0-9.]+)\s+Lon=([-0-9.]+)\s+Alt=([-0-9.]+)/);
    if (!match) return null;

    return {
        latitude: parseFloat(match[1]),
        longitude: parseFloat(match[2]),
        altitude: parseFloat(match[3]),
    };
}

function extractFromISO6709(ilst) {
    const box = ilst?.find(
        b => b.type === 'com.apple.quicktime.location.ISO6709'
    );
    const raw = box?.boxes?.find(b => b.type === 'data')?.data;
    if (!raw) return null;

    const str = decodeText(raw);
    const m = str.match(/^([+-][0-9.]+)([+-][0-9.]+)([+-][0-9.]+)?/);
    if (!m) return null;

    return {
        latitude: parseFloat(m[1]),
        longitude: parseFloat(m[2]),
        altitude: m[3] ? parseFloat(m[3]) : null,
    };
}

function extractFromXYZ(ilst) {
    const box = ilst?.find(b => b.type === '©xyz');
    const raw = box?.boxes?.find(b => b.type === 'data')?.data;
    if (!raw) return null;

    const str = decodeText(raw);
    const m = str.match(/^([+-][0-9.]+)([+-][0-9.]+)([+-][0-9.]+)?/);
    if (!m) return null;

    return {
        latitude: parseFloat(m[1]),
        longitude: parseFloat(m[2]),
        altitude: m[3] ? parseFloat(m[3]) : null,
    };
}

function extractFromLoci(udta) {
    const box = udta?.find(b => b.type === 'loci');
    if (!box?.data || box.data.byteLength < 20) return null;

    const dv = new DataView(box.data.buffer, box.data.byteOffset, box.data.byteLength);
    let o = 0;

    const version = dv.getUint8(o); o += 1;
    o += 3; // flags

    const langBits = dv.getUint16(o); o += 2;
    const langCode = String.fromCharCode(
        ((langBits >> 10) & 0x1F) + 0x60,
        ((langBits >> 5) & 0x1F) + 0x60,
        (langBits & 0x1F) + 0x60
    );

    let name = "";
    while (o < box.data.byteLength && box.data[o] !== 0) {
        name += String.fromCharCode(box.data[o]);
        o++;
    }
    o++; // null terminator

    const role = dv.getUint8(o); o += 1;

    const lon_fixed = dv.getInt32(o, false); o += 4;
    const lat_fixed = dv.getInt32(o, false); o += 4;
    const alt_fixed = dv.getInt32(o, false); o += 4;

    const lon = lon_fixed / 65536;
    const lat = lat_fixed / 65536;
    const alt = alt_fixed / 65536;

    let body = "";
    while (o < box.data.byteLength && box.data[o] !== 0) {
        body += String.fromCharCode(box.data[o]);
        o++;
    }
    o++; // null terminator

    let notes = "";
    while (o < box.data.byteLength && box.data[o] !== 0) {
        notes += String.fromCharCode(box.data[o]);
        o++;
    }

    return {
        language: langCode,
        name,
        role,
        latitude: lat,
        longitude: lon,
        altitude: alt,
        body,
        notes,
    };
}

function extractFromDateTimeOriginal(ilst) {
    const box = ilst?.find(b => b.type === 'com.apple.quicktime.datetimeoriginal');
    const raw = box?.boxes?.find(b => b.type === 'data')?.data;
    if (!raw) return null;

    const text = decodeText(raw);
    return text.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
}

function extractFromDateBox(udta) {
    const box = udta?.find(b => b.type === 'date');
    if (!box?.data) return null;
    return decodeText(box.data);
}

function extractFromDay(ilst) {
    const box = ilst?.find(b => b.type === '©day');
    const raw = box?.boxes?.find(b => b.type === 'data')?.data;
    if (!raw) return null;
    return decodeText(raw);
}

function extractFromMvhd(mvhdBox) {
    if (!mvhdBox?.creation_time) return null;
    const epochOffset = Date.UTC(1904, 0, 1) / 1000;
    const unixSec = mvhdBox.creation_time - epochOffset;
    return new Date(unixSec * 1000).toISOString();
}