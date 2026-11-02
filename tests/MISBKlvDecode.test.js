import {parseKLVFile} from "../src/MISBUtils";
import {MISB} from "../src/MISBFields";

// Real bytes through the real decoder. These faults were all on error paths, which
// is why they can only be seen with the true library: a fault was shown as data.
const KEY = [0x06, 0x0E, 0x2B, 0x34, 0x02, 0x0B, 0x01, 0x01, 0x0E, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00];
const ber = n => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]);
const item = (tag, bytes) => [tag, ...ber(bytes.length), ...bytes];
const timestamp = micros => item(2, Array.from({length: 8}, (_, i) => Number((BigInt(micros) >> BigInt(8 * (7 - i))) & 255n)));
const heading = item(5, [0x40, 0x00]);
const version = item(65, [7]);

function packet(items, {badChecksum = false} = {}) {
    const body = [...items.flat(), 1, 2];
    const head = [...KEY, ...ber(body.length + 2)];
    let checksum = 0;
    [...head, ...body].forEach((byte, i) => { checksum += byte << (i % 2 === 0 ? 8 : 0); });
    checksum = (checksum & 0xFFFF) ^ (badChecksum ? 0x5555 : 0);
    return [...head, ...body, checksum >> 8, checksum & 255];
}

const parse = (bytes, pesEntries = null) => parseKLVFile(new Uint8Array(bytes).buffer, pesEntries, null, {silent: true});
const record = (micros = 1500000000000000, extra = []) => packet([timestamp(micros), ...extra, heading, version]);
// A record of at least this many bytes: a text tag takes up the rest.
function recordOfSize(size) {
    const build = length => packet([timestamp(1500000000000000), item(3, new Array(length).fill(0x41)), heading, version]);
    let length = Math.max(1, size - 50);
    while (build(length).length < size) length++;
    return build(length);
}
const auCell = (bytes, sequence = 0) => [0, sequence, 0xDF, bytes.length >> 8, bytes.length & 255, ...bytes];

beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("KLV packets", () => {
    test("decodes a clean stream, and counts it as clean", () => {
        const rows = parse([...record(), ...record()]);
        expect(rows).toHaveLength(2);
        expect(rows[0][MISB.PlatformHeadingAngle]).toBeCloseTo(90, 2);
        expect(rows[0][MISB.UASDatalinkLSVersionNumber]).toBe(7);
        expect(rows.otherKLVPackets).toEqual([]);
        expect(rows.klvDecodeStats).toEqual({
            packets: 2, rejected: 0, badChecksums: 0, badLengths: 0, pesWithoutPacket: null, tagFaults: [],
        });
    });

    test.each([200, 300, 511, 512, 700, 768, 1000, 5000])("keeps a %i-byte record in an AU cell, with no false key", size => {
        const cell = auCell(recordOfSize(size));
        const rows = parse([...cell, ...cell, ...cell]);
        expect(rows).toHaveLength(3);
        expect(rows.otherKLVPackets).toEqual([]);
    });

    test("keeps every record when the AU cell sequence counts up", () => {
        const bytes = [];
        for (let i = 0; i < 300; i++) bytes.push(...auCell(recordOfSize(600), i & 255));
        expect(parse(bytes)).toHaveLength(300);
    });

    test("a packet too short to decode costs only that packet", () => {
        const short = [...KEY, 4, 5, 2, 0x40, 0];
        const rows = parse([...record(), ...short, ...record()]);
        expect(rows).toHaveLength(2);
        expect(rows.klvDecodeStats).toMatchObject({packets: 3, rejected: 1});
    });

    test("a bad length costs only that packet, and the scan finds the next one", () => {
        const good = record();
        const bad = [...good];
        bad[16] = 0x83; // now a long form that claims far more than the data has
        const bytes = [];
        for (let i = 0; i < 5; i++) bytes.push(...good);
        bytes.push(...bad);
        for (let i = 0; i < 5; i++) bytes.push(...good);
        const rows = parse(bytes);
        expect(rows).toHaveLength(10);
        expect(rows.klvDecodeStats.badLengths).toBeGreaterThan(0);
    });

    test.each([
        ["four bytes of 0xff", [0x84, 0xFF, 0xFF, 0xFF, 0xFF]],
        ["a length with the top bit set", [0x84, 0xFF, 0xFF, 0xFF, 0x00]],
        ["more length bytes than the data has", [0xFF, 0x01]],
    ])("the scan ends on %s", (name, length) => {
        const rows = parse([...KEY, ...length, ...record()]);
        expect(rows).toHaveLength(1);
    });

    test("a lost TS packet costs one record, not the record after it too", () => {
        const good = record();
        const damaged = [...good.slice(0, 30), ...good.slice(45)]; // 15 bytes gone, length unchanged
        const bytes = [...good, ...damaged, ...good, ...good];
        const rows = parse(bytes);
        expect(rows).toHaveLength(3);
        expect(rows.klvDecodeStats.rejected).toBe(1);
        rows.forEach(row => expect(row[MISB.PlatformHeadingAngle]).toBeCloseTo(90, 2));
    });

    test("does not cut a good packet that holds key bytes", () => {
        const withKey = packet([timestamp(1500000000000000), item(3, [...KEY]), heading, version]);
        const rows = parse([...withKey, ...record()]);
        expect(rows).toHaveLength(2);
        expect(rows.klvDecodeStats).toMatchObject({rejected: 0, badChecksums: 0});
    });

    test("a record with another checksum method keeps a nested key that is not ST 0601", () => {
        const nestedKey = [...KEY];
        nestedKey[11] = 0x02;
        const withKey = packet([timestamp(1500000000000000), item(48, nestedKey), heading, version], {badChecksum: true});
        const rows = parse([...withKey, ...withKey, ...withKey]);
        expect(rows).toHaveLength(3);
        expect(rows.klvDecodeStats).toMatchObject({rejected: 0, badChecksums: 3});
        rows.forEach(row => expect(row[MISB.UASDatalinkLSVersionNumber]).toBe(7));
    });

    test("counts a packet that has no checksum tag", () => {
        const body = [...timestamp(1500000000000000), ...heading, ...version, ...item(5, [0x40, 0])];
        const rows = parse([...KEY, ...ber(body.length), ...body, ...record()]);
        expect(rows).toHaveLength(2);
        expect(rows.klvDecodeStats.badChecksums).toBe(1);
    });

    test("counts a bad checksum, and keeps the record", () => {
        const rows = parse([...packet([timestamp(1500000000000000), heading], {badChecksum: true}), ...record()]);
        expect(rows).toHaveLength(2);
        expect(rows.klvDecodeStats.badChecksums).toBe(1);
    });

    test("names a key that is not ST 0601, and does not decode it", () => {
        const other = [...KEY];
        other[11] = 0x03;
        other[12] = 0x06;
        const rows = parse([...other, 2, 1, 2, ...record()]);
        expect(rows).toHaveLength(1);
        expect(rows.otherKLVPackets).toEqual([{key: "060e2b34020b01010e01030306000000", standard: "ST 0903 VMTI", count: 1, bytes: 19}]);
    });

    test("reports no KLV in data that has none", () => {
        expect(parse([1, 2, 3, 4])).toBeUndefined();
    });
});

describe("one tag", () => {
    const decoded = (tag, bytes) => parse(record(1500000000000000, [item(tag, bytes)]))[0];

    test.each([
        ["VMTILocalSet", 74, item(4, [5])],
        ["RVTLocalSet", 73, item(3, [0x41, 0x42])],
    ])("%s decodes, and the tags after it stay", (name, tag, bytes) => {
        const row = decoded(tag, bytes);
        expect(Array.isArray(row[tag])).toBe(true);
        expect(row[tag].length).toBeGreaterThan(0);
        expect(row[MISB.PlatformHeadingAngle]).toBeCloseTo(90, 2);
        expect(row[MISB.UASDatalinkLSVersionNumber]).toBe(7);
    });

    test("reads the text inside a nested local set", () => {
        const row = decoded(74, item(3, [0x56, 0x4D, 0x54, 0x49]));
        expect(row[74]).toEqual([expect.objectContaining({name: "VMTI System Name", value: "VMTI"})]);
    });

    test("tags 67, 68 and 76 decode, and the tags after them stay", () => {
        expect(decoded(67, [0x20, 0, 0, 0])[67]).toBeCloseTo(22.5, 5);
        expect(decoded(68, [0x20, 0, 0, 0])[68]).toBeCloseTo(45, 5);
        const row = decoded(76, [0x40, 0]);
        expect(row[76]).toBeCloseTo(4075.08, 1);
        expect(row[MISB.PlatformHeadingAngle]).toBeCloseTo(90, 2);
    });

    test("tag 96 is IMAPB, and its top bit marks a special value", () => {
        expect(decoded(96, [0, 4, 0])[96]).toBe(256);
        expect(decoded(96, [0x80, 0, 0])[96]).toBeNull();
    });

    test("tag 22 reads every byte, and is reported when it is not 2 bytes", () => {
        const four = parse(record(1500000000000000, [item(22, [0, 0, 1, 0xC9])]));
        expect(four[0][22]).toBeCloseTo(69.73, 1);
        expect(four.klvDecodeStats.tagFaults).toEqual([{tag: 22, kind: "wrong length, value read", count: 1}]);
        const two = parse(record(1500000000000000, [item(22, [0x01, 0xC9])]));
        expect(two[0][22]).toBeCloseTo(69.73, 1);
        expect(two.klvDecodeStats.tagFaults).toEqual([]);
    });

    test("tag 39 keeps its value, and tags 45, 46 and 58 are unsigned", () => {
        expect(decoded(39, [0xF6])[39]).toBe(-10);
        expect(decoded(45, [0xFF, 0xFF])[45]).toBeCloseTo(4095, 5);
        expect(decoded(46, [0x80, 0x00])[46]).toBeCloseTo(2047.5, 1);
        expect(decoded(58, [0xC0, 0x00])[58]).toBeCloseTo(7500, 0);
    });

    test("a zero-length item is legal: it has no value, and is not a fault", () => {
        const rows = parse(packet([timestamp(1500000000000000), item(13, []), version]));
        expect(rows[0][13]).toBeNull();
        expect(rows[0][MISB.UASDatalinkLSVersionNumber]).toBe(7);
        expect(rows.klvDecodeStats.tagFaults).toEqual([]);
    });

    test.each(Object.entries({
        2: 8, 5: 2, 13: 4, 15: 2, 23: 4, 26: 2, 33: 2, 34: 1, 40: 4, 45: 2, 57: 4, 58: 2, 65: 1, 67: 4, 72: 8, 76: 2, 82: 4, 93: 4,
    }))("tag %s must be %i bytes long", (tag, size) => {
        const wrong = new Array(size + 1).fill(1);
        const rows = parse(packet([tag === "2" ? [] : timestamp(1500000000000000), item(Number(tag), wrong)]));
        expect(rows[0][Number(tag)]).toBeNull();
        expect(rows.klvDecodeStats.tagFaults).toEqual([{tag: Number(tag), kind: "wrong length", count: 1}]);
    });

    test.each([
        ["too short", 5, [0x40]],
        ["too long", 5, [0x40, 0, 0, 0]],
    ])("a value that is %s is null, is reported, and costs only that tag", (name, tag, bytes) => {
        const rows = parse(packet([timestamp(1500000000000000), item(tag, bytes), version]));
        expect(rows[0][tag]).toBeNull();
        expect(rows[0][MISB.UASDatalinkLSVersionNumber]).toBe(7);
        expect(rows.klvDecodeStats.tagFaults).toEqual([{tag, kind: "wrong length", count: 1}]);
    });

    test("a tag that throws costs only that tag, and is counted", () => {
        // In an ST 0102 set, tag 22 (the version) is 2 bytes, so 1 byte cannot be read.
        const rows = parse(record(1500000000000000, [item(48, [22, 1, 9])]));
        expect(rows[0][48]).toBeNull();
        expect(rows[0][MISB.PlatformHeadingAngle]).toBeCloseTo(90, 2);
        expect(rows[0][MISB.UASDatalinkLSVersionNumber]).toBe(7);
        expect(rows.klvDecodeStats.tagFaults).toEqual([{tag: 48, kind: "decode error", count: 1}]);
    });

    test("a zero-length item is not a fault on a tag with no entry in the size table", () => {
        const rows = parse(record(1500000000000000, [item(47, [])]));
        expect(rows[0][MISB.PlatformHeadingAngle]).toBeCloseTo(90, 2);
        expect(rows.klvDecodeStats.tagFaults).toEqual([]);
    });

    test("reads the bytes of a tag that misb.js does not decode, into the raw list", () => {
        const rows = parse(record(1500000000000000, [item(106, [0x42, 0x4C, 0x55, 0x45])]));
        expect(rows.undecodedKLVTags).toEqual([expect.objectContaining({tag: 106, count: 1, values: ["424c5545"]})]);
    });

    test("a sentinel is unknown data, not a fault", () => {
        const rows = parse(record(1500000000000000, [item(82, [0x80, 0, 0, 0])]));
        expect(rows[0][82]).toBeNull();
        expect(rows.klvDecodeStats.tagFaults).toEqual([]);
    });
});

describe("pairing records with PES PTS", () => {
    test("pairs one record with each PES", () => {
        const one = record();
        const rows = parse([...one, ...one], [{offset: 0, ptsUs: 1000}, {offset: one.length, ptsUs: 2000}]);
        expect(rows.pesPTSus).toEqual([0, 1000]);
        expect(rows.klvDecodeStats.pesWithoutPacket).toBe(0);
    });

    test("equal counts do not override the offsets", () => {
        const one = record();
        const other = [...KEY];
        other[11] = 0x03;
        other[12] = 0x06;
        const secondPES = one.length * 2;
        const rows = parse([...one, ...one, ...other, 2, 1, 2], [{offset: 0, ptsUs: 1000}, {offset: secondPES, ptsUs: 2000}]);
        expect(rows).toHaveLength(2);
        expect(rows.pesPTSus).toEqual([0, 0]);
    });

    test("counts a PES that holds no part of a packet", () => {
        const one = record();
        const bytes = [...one, 1, 2, 3, 4, ...one];
        const pes = [{offset: 0, ptsUs: 1000}, {offset: one.length, ptsUs: 2000}, {offset: one.length + 4, ptsUs: 3000}];
        const rows = parse(bytes, pes);
        expect(rows.pesPTSus).toEqual([0, 2000]);
        expect(rows.klvDecodeStats.pesWithoutPacket).toBe(1);
    });

    test("does not count a PES that holds a packet of another standard", () => {
        const one = record();
        const other = [...KEY];
        other[11] = 0x03;
        other[12] = 0x06;
        const vmti = [...other, 2, 1, 2];
        const pes = [{offset: 0, ptsUs: 1000}, {offset: one.length, ptsUs: 2000}, {offset: one.length + vmti.length, ptsUs: 3000}];
        const rows = parse([...one, ...vmti, ...one], pes);
        expect(rows).toHaveLength(2);
        expect(rows.klvDecodeStats.pesWithoutPacket).toBe(0);
    });

    test("does not count a PES that holds only the rest of a long record", () => {
        const long = recordOfSize(600);
        const rows = parse([...long, ...record()], [{offset: 0, ptsUs: 1000}, {offset: 300, ptsUs: 2000}, {offset: long.length, ptsUs: 3000}]);
        expect(rows).toHaveLength(2);
        expect(rows.klvDecodeStats.pesWithoutPacket).toBe(0);
    });

    test("does not count a packet twice that is already counted as not decoded", () => {
        const one = record();
        const short = [...KEY, 4, 5, 2, 0x40, 0];
        const pes = [{offset: 0, ptsUs: 1000}, {offset: one.length, ptsUs: 2000}, {offset: one.length + short.length, ptsUs: 3000}];
        const rows = parse([...one, ...short, ...one], pes);
        expect(rows.klvDecodeStats).toMatchObject({rejected: 1, pesWithoutPacket: 0});
    });

    test("does not count a PES that is cut off inside its packet", () => {
        const one = record();
        const rows = parse([...one, ...one.slice(0, 30)], [{offset: 0, ptsUs: 1000}, {offset: one.length, ptsUs: 2000}]);
        expect(rows.klvDecodeStats).toMatchObject({badLengths: 1, pesWithoutPacket: 0});
    });

    test("pairs by byte offset when a PES holds more than one record", () => {
        const one = record();
        const rows = parse([...one, ...one, ...one], [{offset: 0, ptsUs: 1000}, {offset: one.length * 2, ptsUs: 2000}]);
        expect(rows.pesPTSus).toEqual([0, 0, 1000]);
    });

    test("cell headers and packets that are not ST 0601 do not move the pairing", () => {
        const one = auCell(record());
        const other = [...KEY];
        other[11] = 0x03;
        other[12] = 0x06;
        const bytes = [...other, 2, 1, 2, ...one, ...one, ...one];
        const rows = parse(bytes, [{offset: 0, ptsUs: 1000}, {offset: 19 + one.length * 2, ptsUs: 5000}]);
        expect(rows).toHaveLength(3);
        expect(rows.pesPTSus).toEqual([0, 0, 4000]);
    });

    test("a lost packet does not shift the records after it", () => {
        const one = record();
        const short = [...KEY, 4, 5, 2, 0x40, 0];
        const pesEntries = [
            {offset: 0, ptsUs: 1000},
            {offset: one.length, ptsUs: 2000},
            {offset: one.length + short.length, ptsUs: 3000},
            {offset: one.length * 2 + short.length, ptsUs: 4000},
        ];
        const rows = parse([...one, ...short, ...one, ...one], pesEntries);
        expect(rows).toHaveLength(3);
        expect(rows.pesPTSus).toEqual([0, 2000, 3000]);
    });
});
