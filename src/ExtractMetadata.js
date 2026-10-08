// Reads the capture time and location that phones and cameras write into the header of an
// MP4 or QuickTime (MOV) file, from the box tree MP4Box has parsed.
//
// Where each kind of file keeps them (every layout below was checked against real files):
//
//   iPhone .MOV         moov/meta 'mdta' keys: com.apple.quicktime.creationdate (local time with
//                       its UTC offset, start of recording) and com.apple.quicktime.location.ISO6709
//                       (latitude, longitude and altitude in metres above sea level).
//   iPhone .mp4 export  moov/udta 'date' (the same date text) and a 3GPP 'loci' box.
//                       Its mvhd time is when the file was EXPORTED, not when it was filmed.
//   Android (Pixel,     moov/udta '©xyz' (ISO 6709 text, no altitude) and moov/meta 'mdta' keys
//   Samsung, ...)       named com.android.*. Samsung adds com.samsung.android.utc_offset.
//                       The only time is the mvhd creation time, and that is the END of the
//                       recording — see startFromMvhd().
//   ffmpeg              .mp4: udta 'loci'. .mov: udta '©xyz'. With -movflags use_metadata_tags,
//                       udta/meta 'mdta' keys. mvhd creation time is 0 when no time was carried
//                       over.
//
// Returns {latitude, longitude, altitude, creationDate, locationSource, creationDateSource}.
// altitude is metres above sea level, or null when the file has none. creationDate is an
// ISO 8601 string for the START of the recording, with the local UTC offset when the file gives
// one. Anything not found is null.

const MP4_EPOCH_MS = Date.UTC(1904, 0, 1);

export function extractAllMetaData(boxes) {
    const result = {
        latitude: null, longitude: null, altitude: null, creationDate: null,
        locationSource: null, creationDateSource: null,
    };

    // The metadata is optional, so a box we cannot read must never stop the video loading.
    try {
        const moov = boxes?.find(box => box.type === "moov");
        const moovChildren = moov?.boxes ?? [];
        const udta = moovChildren.find(box => box.type === "udta")?.boxes ?? [];
        const mvhd = moovChildren.find(box => box.type === "mvhd");

        const items = new Map();
        for (const meta of [...moovChildren, ...udta].filter(box => box.type === "meta")) {
            readMetaItems(boxPayload(meta), items);
        }
        const udtaBox = type => udta.find(box => box.type === type);

        const location =
            locationFromISO6709(items.get("com.apple.quicktime.location.ISO6709"), "QuickTime location key") ??
            locationFromISO6709(userDataText(udtaBox("©xyz")), "udta ©xyz") ??
            locationFromISO6709(items.get("©xyz"), "ilst ©xyz") ??
            locationFromLoci(boxPayload(udtaBox("loci")));

        if (location) {
            result.latitude = location.latitude;
            result.longitude = location.longitude;
            result.altitude = location.altitude;
            result.locationSource = location.source;
        }

        const date =
            dateFromText(items.get("com.apple.quicktime.creationdate"), "QuickTime creationdate key") ??
            dateFromText(textOf(boxPayload(udtaBox("date"))), "udta date") ??
            dateFromText(userDataText(udtaBox("©day")), "udta ©day") ??
            dateFromText(items.get("©day"), "ilst ©day") ??
            startFromMvhd(mvhd, items);

        if (date) {
            result.creationDate = date.creationDate;
            result.creationDateSource = date.source;
        }
    } catch (e) {
        console.warn("Video metadata could not be read:", e);
    }

    console.log("Video metadata:", result);
    return result;
}

// MP4Box keeps the raw payload of a box it does not fully handle in box.data. For a box it
// treats as a FullBox (it does so for 'meta') it reads the 4-byte version/flags header first and
// keeps only what follows. Put those 4 bytes back, so every payload starts where the file's does.
function boxPayload(box) {
    if (!box?.data) return null;
    if (box.version === undefined) return box.data;
    const bytes = new Uint8Array(box.data.byteLength + 4);
    bytes[0] = box.version;
    bytes[1] = (box.flags >> 16) & 0xff;
    bytes[2] = (box.flags >> 8) & 0xff;
    bytes[3] = box.flags & 0xff;
    bytes.set(box.data, 4);
    return bytes;
}

function fourCC(bytes, offset) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function textOf(bytes, start = 0, end = bytes?.byteLength) {
    if (!bytes) return null;
    return new TextDecoder().decode(bytes.subarray(start, end)).replace(/\0/g, "").trim();
}

// The boxes inside bytes[start, end). Each is {type, start, end} with start/end bounding its payload.
function childBoxes(bytes, start = 0, end = bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const children = [];
    let offset = start;
    while (offset + 8 <= end) {
        const size = view.getUint32(offset);
        if (size < 8 || offset + size > end) break;
        children.push({type: fourCC(bytes, offset + 4), start: offset + 8, end: offset + size});
        offset += size;
    }
    return children;
}

// Adds the items of a 'meta' box to items: by key name for QuickTime 'mdta' metadata, and by
// four-character code (such as '©day') for iTunes-style 'mdir' metadata. The first value found
// for a name is kept.
function readMetaItems(bytes, items) {
    if (!bytes || bytes.byteLength < 8) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // QuickTime writes 'meta' as a plain box. ISO files write it with a version/flags header.
    const start = fourCC(bytes, 4) === "hdlr" ? 0 : 4;

    let handler = null;
    let keys = [];
    for (const box of childBoxes(bytes, start)) {
        if (box.type === "hdlr") {
            // version/flags, pre_defined, then the handler type
            handler = fourCC(bytes, box.start + 8);
        } else if (box.type === "keys") {
            keys = [];
            const count = view.getUint32(box.start + 4);
            let offset = box.start + 8;
            for (let i = 0; i < count; i++) {
                const size = view.getUint32(offset);
                keys.push(textOf(bytes, offset + 8, offset + size));   // after size and namespace
                offset += size;
            }
        } else if (box.type === "ilst") {
            for (const item of childBoxes(bytes, box.start, box.end)) {
                // An 'mdta' item's type field is the 1-based index of its key.
                const name = handler === "mdta" ? keys[view.getUint32(item.start - 4) - 1] : item.type;
                const data = childBoxes(bytes, item.start, item.end).find(box => box.type === "data");
                if (name && data && !items.has(name)) {
                    // The data box starts with a type indicator (1 = UTF-8 text) and a locale.
                    // Only text values are read. Other items are recorded by name, with null.
                    const isText = (view.getUint32(data.start) & 0xffffff) === 1;
                    items.set(name, isText ? textOf(bytes, data.start + 8, data.end) : null);
                }
            }
        }
    }
}

// QuickTime user-data text, as in udta '©xyz': a 16-bit length and a 16-bit language code
// before the text.
function userDataText(box) {
    const bytes = boxPayload(box);
    if (!bytes || bytes.byteLength < 4) return null;
    const length = (bytes[0] << 8) | bytes[1];
    return textOf(bytes, 4, 4 + length);
}

// ISO 6709 in decimal degrees: "+38.1234-121.1234+077.123/" (Apple) or "+53.5765-2.8823/"
// (Android, which writes no altitude).
function locationFromISO6709(text, source) {
    const match = text?.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/);
    if (!match) return null;
    return {
        latitude: parseFloat(match[1]),
        longitude: parseFloat(match[2]),
        altitude: match[3] !== undefined ? parseFloat(match[3]) : null,
        source,
    };
}

// 3GPP TS 26.244 'loci': version/flags, language, a null-terminated place name, a role byte,
// then longitude, latitude and altitude (metres, sea level = 0) as 16.16 fixed point.
function locationFromLoci(bytes) {
    if (!bytes || bytes.byteLength < 20) return null;
    let offset = 6;
    while (offset < bytes.byteLength && bytes[offset] !== 0) offset++;
    offset += 2;    // the terminator and the role
    if (offset + 12 > bytes.byteLength) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
        longitude: view.getInt32(offset) / 65536,
        latitude: view.getInt32(offset + 4) / 65536,
        altitude: view.getInt32(offset + 8) / 65536,
        source: "udta loci",
    };
}

// "2025-10-20T21:35:53-0700" -> "2025-10-20T21:35:53-07:00". The ECMAScript date format needs
// the colon in the offset; without it, parsing is up to the browser.
function dateFromText(text, source) {
    if (!text || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return null;
    const creationDate = text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    if (Number.isNaN(Date.parse(creationDate))) return null;
    return {creationDate, source};
}

// The mvhd creation time is seconds since 1904, in UTC. A writer with no time (ffmpeg) leaves 0.
//
// Android's MPEG4Writer, which the camera apps record through, stamps mvhd with the wall-clock
// time at the moment it writes the moov box, and it writes that box in stop(). So for an Android
// recording the time is the END of the recording, and the start is that minus the duration.
// The writer adds com.android.* keys to the file, which is how we tell. The result is a few
// seconds late, never early: mvhd holds whole seconds, and the moov box is written after the last
// frame. Against a filmed clock (Pixel 7 Pro) it was 1.3 to 2.3 s late; against the start time in
// Pixel and Samsung file names (which are themselves up to ~1.4 s late), 0.1 to 3 s.
function startFromMvhd(mvhd, items) {
    if (!mvhd?.creation_time) return null;
    let ms = MP4_EPOCH_MS + mvhd.creation_time * 1000;
    let source = "mvhd creation time";

    if ([...items.keys()].some(key => key.startsWith("com.android."))) {
        ms -= mvhd.duration / mvhd.timescale * 1000;
        source = "Android mvhd creation time (end of recording) minus the duration";
    }

    // Samsung records the phone's time zone, which lets us show the local time.
    const offset = items.get("com.samsung.android.utc_offset")?.match(/^([+-])(\d{2}):?(\d{2})$/);
    if (!offset) {
        return {creationDate: new Date(ms).toISOString(), source};
    }
    const offsetMinutes = (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]));
    const local = new Date(ms + offsetMinutes * 60000).toISOString().slice(0, -1);
    return {creationDate: `${local}${offset[1]}${offset[2]}:${offset[3]}`, source};
}
