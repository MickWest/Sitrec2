// extractAllMetaData on the header layouts that phones and ffmpeg write. Each file is built
// byte by byte, then parsed by the bundled MP4Box exactly as a dropped video is.
import MP4Box from "../src/js/mp4box.all";
import {extractAllMetaData} from "../src/ExtractMetadata";

const latin1 = text => Uint8Array.from(text, ch => ch.charCodeAt(0));
const utf8 = text => new TextEncoder().encode(text);
const u16 = n => Uint8Array.of(n >> 8, n & 0xff);
const u32 = n => Uint8Array.of(n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
const fixed16 = x => u32(Math.round(x * 65536) >>> 0);

function concat(...parts) {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

// type is a four-character code, or 4 raw bytes (an 'mdta' ilst item's key index)
function box(type, ...parts) {
    const payload = concat(...parts);
    return concat(u32(8 + payload.byteLength), typeof type === "string" ? latin1(type) : type, payload);
}

// mvhd version 0: times in seconds since 1904
const MP4_EPOCH_S = Date.UTC(1904, 0, 1) / 1000;
function mvhd(utcISO, durationSeconds, timescale = 1000) {
    const created = utcISO ? Date.parse(utcISO) / 1000 - MP4_EPOCH_S : 0;
    return box("mvhd", u32(0), u32(created), u32(created), u32(timescale),
        u32(Math.round(durationSeconds * timescale)), u32(0x00010000), u16(0x0100),
        new Uint8Array(10), new Uint8Array(36), new Uint8Array(24), u32(2));
}

// A QuickTime/ISO 'meta' box of 'mdta' keys. entries are [key, dataType, valueBytes].
// hdlrName is the trailing name bytes: Android writes 1, Apple writes 2.
function mdtaMeta(entries, {iso = false, hdlrName = 1} = {}) {
    const hdlr = box("hdlr", u32(0), u32(0), latin1("mdta"), new Uint8Array(12), new Uint8Array(hdlrName));
    const keys = box("keys", u32(0), u32(entries.length),
        ...entries.map(([key]) => concat(u32(8 + utf8(key).byteLength), latin1("mdta"), utf8(key))));
    const ilst = box("ilst", ...entries.map(([, type, value], i) =>
        box(u32(i + 1), box("data", u32(type), u32(0), value))));
    return box("meta", iso ? u32(0) : new Uint8Array(0), hdlr, keys, ilst);
}
const text = (key, value) => [key, 1, utf8(value)];

// QuickTime user-data text: length, language ("eng" = 0x15c7), text
const userText = (type, value) => box(type, u16(utf8(value).byteLength), u16(0x15c7), utf8(value));

function loci(lat, lon, alt) {
    return box("loci", u32(0), u16(0x15c7), Uint8Array.of(0), Uint8Array.of(0),
        fixed16(lon), fixed16(lat), fixed16(alt), latin1("earth\0"), Uint8Array.of(0));
}

function parse(...moovChildren) {
    const file = concat(box("ftyp", latin1("isom"), u32(0x200), latin1("isomiso2mp41")),
        box("moov", ...moovChildren));
    const buffer = file.buffer.slice(0);
    buffer.fileStart = 0;
    const mp4 = MP4Box.createFile();
    mp4.appendBuffer(buffer);
    mp4.flush();
    return extractAllMetaData(mp4.boxes);
}

beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("extractAllMetaData", () => {
    test("Android (Pixel): udta ©xyz, and mvhd is the END of the recording", () => {
        // The Pixel 7 Pro writes no com.android.version, only these; capture.fps is a float.
        const meta = parse(
            mvhd("2026-01-02T03:05:00Z", 54.5),
            box("udta", userText("©xyz", "+12.3456-7.8912/")),
            mdtaMeta([
                ["com.android.capture.fps", 23, Uint8Array.of(0x41, 0xf0, 0, 0)],
                text("com.android.model", "Pixel 7 Pro"),
            ]),
        );
        expect(meta.latitude).toBeCloseTo(12.3456, 6);
        expect(meta.longitude).toBeCloseTo(-7.8912, 6);
        expect(meta.altitude).toBeNull();
        expect(meta.creationDate).toBe("2026-01-02T03:04:05.500Z");
    });

    test("Android detected from a non-text key alone", () => {
        const meta = parse(
            mvhd("2026-01-02T03:05:00Z", 10),
            mdtaMeta([["com.android.capture.fps", 23, Uint8Array.of(0x41, 0xf0, 0, 0)]]),
        );
        expect(meta.creationDate).toBe("2026-01-02T03:04:50.000Z");
    });

    test("Samsung: the start is given in the phone's own UTC offset", () => {
        const meta = parse(
            mvhd("2025-11-04T09:21:31Z", 111.5),
            box("udta", userText("©xyz", "+36.1234+128.1234/")),
            mdtaMeta([
                text("com.android.version", "15"),
                ["com.android.capture.fps", 23, Uint8Array.of(0x42, 0x70, 0, 0)],
                text("com.samsung.android.utc_offset", "+0900"),
            ]),
        );
        expect(meta.creationDate).toBe("2025-11-04T18:19:39.500+09:00");
        expect(Date.parse(meta.creationDate)).toBe(Date.parse("2025-11-04T09:19:39.500Z"));
        expect(meta.longitude).toBeCloseTo(128.1234, 6);
    });

    test("iPhone .MOV: QuickTime keys with altitude and local creation date", () => {
        const meta = parse(
            // mvhd is the start in UTC too, but the creationdate key carries the time zone
            mvhd("2025-10-21T04:35:53Z", 30),
            mdtaMeta([
                text("com.apple.quicktime.location.accuracy.horizontal", "3.750171"),
                text("com.apple.quicktime.location.ISO6709", "+12.3456-123.4567+077.392/"),
                text("com.apple.quicktime.make", "Apple"),
                text("com.apple.quicktime.creationdate", "2025-10-20T21:35:53-0700"),
            ], {hdlrName: 2}),
        );
        expect(meta.latitude).toBeCloseTo(12.3456, 6);
        expect(meta.longitude).toBeCloseTo(-123.4567, 6);
        expect(meta.altitude).toBeCloseTo(77.392, 6);
        expect(meta.creationDate).toBe("2025-10-20T21:35:53-07:00");
    });

    test("iPhone .mp4 export: udta loci and date; mvhd is the export time", () => {
        const meta = parse(
            mvhd("2025-10-21T04:54:30Z", 30),
            box("udta", loci(12.3456, -123.4567, 77.39), box("date", utf8("2025-10-20T21:35:53-0700"))),
        );
        expect(meta.latitude).toBeCloseTo(12.3456, 4);
        expect(meta.longitude).toBeCloseTo(-123.4567, 4);
        expect(meta.altitude).toBeCloseTo(77.39, 4);
        expect(meta.creationDate).toBe("2025-10-20T21:35:53-07:00");
    });

    test("ffmpeg .mp4: loci, iTunes-style udta/meta, and mvhd 0 means no time", () => {
        const itunes = box("meta", u32(0),
            box("hdlr", u32(0), u32(0), latin1("mdirappl"), new Uint8Array(9)),
            box("ilst", box("©too", box("data", u32(1), u32(0), utf8("Lavf61.7.100")))));
        const meta = parse(mvhd(null, 1), box("udta", itunes, loci(12.3456, -7.8912, 0)));
        expect(meta.latitude).toBeCloseTo(12.3456, 4);
        expect(meta.altitude).toBe(0);
        expect(meta.creationDate).toBeNull();
    });

    test("ffmpeg use_metadata_tags: ISO 'meta' of 'mdta' keys inside udta", () => {
        const meta = parse(
            mvhd(null, 1),
            box("udta", mdtaMeta([
                text("com.apple.quicktime.location.ISO6709", "+12.3456-007.8912+100.000/"),
                text("com.apple.quicktime.creationdate", "2024-01-02T03:04:05-0700"),
            ], {iso: true})),
        );
        expect(meta.longitude).toBeCloseTo(-7.8912, 6);
        expect(meta.altitude).toBe(100);
        expect(meta.creationDate).toBe("2024-01-02T03:04:05-07:00");
    });

    test("other files: mvhd is taken as the start, in UTC", () => {
        const meta = parse(mvhd("2024-01-02T03:04:05Z", 20));
        expect(meta.creationDate).toBe("2024-01-02T03:04:05.000Z");
        expect(meta.latitude).toBeNull();
    });
});
