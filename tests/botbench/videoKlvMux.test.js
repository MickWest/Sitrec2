import {muxVideoKlv, mpegCRC, encodePTS} from "../../benchmarks/botbench/lib/muxVideoKlv";
import {scanTransportStreamForMetadata} from "../../src/analysis/TSMetadataScanner";
import {encodeMISBLocalSet} from "../../src/MISBEncoder";
import {TSParser} from "../../src/TSParser";
import {parseKLVFile} from "../../src/MISBUtils";

const packet = (pid, payload) => {
    const b = Buffer.alloc(188, 255);
    b.set([0x47, 0x40 | pid >> 8, pid & 255, 0x10]); b.set(payload, 4);
    return b;
};
const psi = (pid, data) => {
    const s = Buffer.from([...data, 0, 0, 0, 0]);
    s.writeUInt32BE(mpegCRC(s.subarray(0, -4)), s.length - 4);
    return packet(pid, [0, ...s]);
};
function fixture(start = 0, audio = false) {
    return Buffer.concat([
        psi(0, [0,0xb0,13,0,1,0xc1,0,0,0,1,0xf0,0]),
        psi(0x1000, [2,0xb0,audio ? 23 : 18,0,1,0xc1,0,0,0xe1,0,0xf0,0,0x1b,0xe1,0,0xf0,0,
            ...(audio ? [0x0f,0xe1,1,0xf0,0] : [])]),
        ...(audio ? [packet(0x101, [0,0,1,0xc0,0,0,0x80,0x80,5,...encodePTS(start),1,2,3])] : []),
        ...[0, 3000, 6000].map(t => packet(0x100, [0,0,1,0xe0,0,0,0x80,0x80,5,
            ...encodePTS(start+t), 0,0,0,1,9,0xf0])),
    ]);
}

test("native TS scanner reads one synchronous KLV PES at each video PTS", async () => {
    const records = [0, 1, 2].map(f => ({klv: encodeMISBLocalSet({2: 1000000 + Math.round(f * 1e6 / 30), 13: 37, 14: -120})}));
    const ts = muxVideoKlv(fixture(), records);
    const scan = await scanTransportStreamForMetadata(ts);
    expect(scan.videoStreams).toHaveLength(1);
    expect(scan.metadataStreams).toHaveLength(1);
    const meta = scan.metadataStreams[0];
    expect(meta.stream_type).toBe("0x15");
    const firstMetadata = ts.subarray(3 * 188, 4 * 188);
    const pesOffset = 4 + (firstMetadata[3] & 0x20 ? 1 + firstMetadata[4] : 0);
    expect(firstMetadata[pesOffset + 6] & 4).toBe(4); // PES data alignment
    const bytes = new Uint8Array(meta.data);
    expect(meta.pesEntries.map(p => p.ptsUs)).toEqual(scan.videoStreams[0].pesEntries.map(p => p.ptsUs));
    expect(meta.pesEntries).toHaveLength(3);
    for (let f = 0; f < 3; f++) {
        const start = meta.pesEntries[f].offset;
        expect(Array.from(bytes.slice(start, start + 3))).toEqual([0, f, 0xdf]);
        expect(Array.from(bytes.slice(start + 5, start + 5 + records[f].klv.length))).toEqual(Array.from(records[f].klv));
    }
    const pmt = ts.subarray(188 + 5, 188 + 188);
    const length = (pmt.readUInt16BE(1) & 4095) + 3;
    expect(mpegCRC(pmt.subarray(0, length))).toBe(0);
});

test("sparse metadata keeps its independent PTS, audio, and repeated program tables", async () => {
    const start = 120 * 90000;
    const records = [0,1,2].map(() => ({klv: encodeMISBLocalSet({2: 1000000, 13: 37, 14: -120})}));
    const samples = [1500,4500].map(ptsOffset90k => ({ptsOffset90k, klv: Uint8Array.from({length: 260}, (_, i) => i % 251)}));
    const input = fixture(start, true);
    const ts = muxVideoKlv(input, records, 30, {klvPID: 0x102, metadataSamples: samples,
        allowAudio: true, sequenceCounter: false, tablePacketPeriod: 2});
    const scan = await scanTransportStreamForMetadata(ts);
    const meta = scan.metadataStreams[0];
    expect(meta.pesEntries.map(p => p.ptsUs)).toEqual(samples.map(s => (start+s.ptsOffset90k)*1000/90));
    for (const {offset} of meta.pesEntries) {
        const bytes = new Uint8Array(meta.data);
        expect(Array.from(bytes.slice(offset, offset+3))).toEqual([0,0,0xdf]);
        expect(Array.from(bytes.slice(offset+5, offset+265))).toEqual(Array.from(samples[0].klv));
    }
    const pidPackets = (buffer, pid) => Array.from({length: buffer.length/188}, (_, i) => buffer.subarray(i*188,(i+1)*188))
        .filter(p => (((p[1]&31)<<8)|p[2]) === pid);
    expect(pidPackets(ts, 0x101)).toEqual(pidPackets(input, 0x101));
    expect(pidPackets(ts, 0x100)).toEqual(pidPackets(input, 0x100));
    const tables = pidPackets(ts, 0x1000);
    expect(tables.length).toBeGreaterThan(1);
    expect(tables.map(p => p[3]&15)).toEqual(tables.map((_,i) => i&15));
    for (const p of tables) {
        const s = p.subarray(5), size = (s.readUInt16BE(1)&4095)+3;
        expect(mpegCRC(s.subarray(0,size))).toBe(0);
    }
    expect(() => muxVideoKlv(input, records, 30, {allowAudio: true})).toThrow("Metadata PID already in use");
    expect(() => muxVideoKlv(fixture(), records, 30, {metadataSamples: [{ptsOffset90k: 9000, klv: []}]})).toThrow("Invalid metadata schedule");
});

test("multi-packet metadata preserves data and continuity counters", async () => {
    const records = [0,1,2].map(() => ({klv: Uint8Array.from({length: 400}, (_, i) => i % 251)}));
    const ts = muxVideoKlv(fixture(), records);
    const scan = await scanTransportStreamForMetadata(ts);
    const meta = scan.metadataStreams[0];
    for (const {offset} of meta.pesEntries) expect(Array.from(new Uint8Array(meta.data).slice(offset + 5, offset + 405))).toEqual(Array.from(records[0].klv));
    const counters = [];
    for (let i = 0; i < ts.length; i += 188) if (((ts[i + 1] & 31) << 8 | ts[i + 2]) === 0x101) counters.push(ts[i + 3] & 15);
    expect(counters).toEqual([0,1,2,3,4,5,6,7,8]);
});

test("missing metadata and unsupported input fail instead of producing a partial stream", () => {
    expect(() => muxVideoKlv(fixture(), [])).toThrow();
    expect(() => muxVideoKlv(Buffer.alloc(189), [])).toThrow();
});

test("camera and sparse truth metadata use distinct synchronous streams without disturbing audio", async () => {
    const records = [0, 1, 2].map(f => ({klv: encodeMISBLocalSet({2: 1000000 + f * 33333, 13: 37, 14: -120})}));
    const truth = records.map((r, i) => i === 1 ? null : r);
    const input = fixture(90000, true);
    const ts = muxVideoKlv(input, records, 30, {klvPID: 0x1e0, allowAudio: true,
        additionalStreams: [{pid: 0x1e1, records: truth}]});
    const scan = await scanTransportStreamForMetadata(ts);
    expect(scan.metadataStreams).toHaveLength(2);
    expect(scan.metadataStreams[0].pesEntries.map(p => p.ptsUs)).toEqual([1000000, 1000000 + 100000 / 3, 1000000 + 200000 / 3]);
    expect(scan.metadataStreams[1].pesEntries).toHaveLength(2);
    const stream = scan.metadataStreams[1];
    expect(new Uint8Array(stream.data)[0]).toBe(1); // independent metadata service
    expect(stream.pesEntries.map(p => p.ptsUs)).toEqual([1000000, 1000000 + 200000 / 3]);
    expect(() => muxVideoKlv(input, records, 30, {klvPID: 0x1e0, allowAudio: true,
        additionalStreams: [{pid: 0x1e0, records: truth}]})).toThrow("Invalid metadata streams");
});

test("normal file import retains the final complete TS packet, including metadata at EOF", async () => {
    const records = [0, 1, 2].map(f => ({klv: encodeMISBLocalSet({2: 1000000 + Math.round(f * 1e6 / 30)})}));
    const ts = muxVideoKlv(fixture(), records);
    const scan = await scanTransportStreamForMetadata(ts);
    const streams = await TSParser.extractTSStreamsAsync(ts);
    const klv = streams.find(s => s.type === "klv");
    expect(klv.pesEntries).toHaveLength(3);
    expect(new Uint8Array(klv.data)).toEqual(new Uint8Array(scan.metadataStreams[0].data));
    const video = streams.find(s => s.type === "h264");
    expect(video.pesEntries).toHaveLength(3);
    expect(video.data.byteLength).toBe(3 * 170); // three full payloads after PES headers
    const videoLast = await TSParser.extractTSStreamsAsync(fixture());
    expect(new Uint8Array(videoLast[0].data)).toEqual(new Uint8Array(video.data));
});

describe("the real path from TS bytes to records", () => {
    const records = [0, 1, 2].map(f => ({klv: encodeMISBLocalSet({2: 1000000 + Math.round(f * 1e6 / 30), 13: 37, 14: -120})}));
    const klvStream = streams => streams.find(stream => stream.type === "klv");
    const toBuffer = ts => ts.buffer.slice(ts.byteOffset, ts.byteOffset + ts.byteLength);

    test("AU cell headers do not become records or false packets", async () => {
        const stream = klvStream(await TSParser.extractTSStreamsAsync(toBuffer(muxVideoKlv(fixture(), records))));
        const rows = parseKLVFile(stream.data, stream.pesEntries, null, {silent: true});
        expect(rows).toHaveLength(3);
        expect(rows.otherKLVPackets).toEqual([]);
        expect(rows.klvDecodeStats).toMatchObject({packets: 3, rejected: 0, badLengths: 0, badChecksums: 0});
        expect(rows.pesPTSus).toHaveLength(3);
    });

    test("saves what the report needs from the TS layer", async () => {
        const ts = muxVideoKlv(fixture(), records);
        const stream = klvStream(await TSParser.extractTSStreamsAsync(toBuffer(ts)));
        expect(stream.tsIds.pesStreamIds).toEqual([0xFC]);
        expect(stream.tsIds.continuityErrors).toBe(0);
        expect(stream.tsIds.pmtName).toBeNull();
        expect(stream.tsIds.otherStreams).toEqual([
            expect.objectContaining({pid: 0x100, codec: "h264", streamType: "0x1b", name: null, packets: 3}),
        ]);
    });

    test("reads the name of a stream from a user-private PMT descriptor, and a private stream's type", () => {
        const descriptor = text => [0xFF, text.length, ...Buffer.from(text)];
        const klvName = descriptor("KLV_SYNC");
        const privateName = descriptor("ARSX");
        const esInfo = [
            0x15, 0xE1, 2, 0xF0, klvName.length, ...klvName,
            0xF1, 0xE1, 3, 0xF0, privateName.length, ...privateName,
        ];
        const sectionLength = 9 + esInfo.length + 4;
        const pmt = psi(0x1000, [2, 0xB0, sectionLength, 0, 1, 0xC1, 0, 0, 0xE1, 0, 0xF0, 0, ...esInfo]);
        const pat = psi(0, [0, 0xB0, 13, 0, 1, 0xC1, 0, 0, 0, 1, 0xF0, 0]);
        const info = TSParser.probeTransportStreamBuffer(toBuffer(Buffer.concat([pat, pmt])));
        const types = Object.fromEntries(info.streams.map(stream => [parseInt(stream.id, 16), stream.codec_name]));
        expect(types[0x103]).toBe("private_data");
    });

    test("a jump that the encoder flags in a packet with no payload is not a loss", async () => {
        const ts = Buffer.from(muxVideoKlv(fixture(), records));
        const stream = klvStream(await TSParser.extractTSStreamsAsync(toBuffer(ts)));
        const klvAt = [];
        for (let at = 0; at + 188 <= ts.length; at += 188) {
            if (((ts[at + 1] & 31) << 8 | ts[at + 2]) === stream.pid) klvAt.push(at);
        }
        expect(klvAt.length).toBeGreaterThan(1);
        const pid = stream.pid;
        const flagged = Buffer.alloc(188, 255);
        flagged.set([0x47, pid >> 8, pid & 255, 0x20, 183, 0x80]);
        const jump = (ts[klvAt[1] + 3] + 7) & 0x0F;
        ts[klvAt[1] + 3] = (ts[klvAt[1] + 3] & 0xF0) | jump;
        for (let i = 2; i < klvAt.length; i++) ts[klvAt[i] + 3] = (ts[klvAt[i] + 3] & 0xF0) | ((ts[klvAt[i] + 3] + 7) & 0x0F);
        const withFlag = Buffer.concat([ts.subarray(0, klvAt[1]), flagged, ts.subarray(klvAt[1])]);
        expect(klvStream(await TSParser.extractTSStreamsAsync(toBuffer(withFlag))).tsIds.continuityErrors).toBe(0);
        expect(klvStream(await TSParser.extractTSStreamsAsync(toBuffer(ts))).tsIds.continuityErrors).toBe(1);
    });

    test("counts a lost TS packet on a KLV PID", async () => {
        const ts = Buffer.from(muxVideoKlv(fixture(), records));
        const stream = klvStream(await TSParser.extractTSStreamsAsync(toBuffer(ts)));
        const klvAt = [];
        for (let at = 0; at + 188 <= ts.length; at += 188) {
            if ((((ts[at + 1] & 31) << 8) | ts[at + 2]) === stream.pid) klvAt.push(at);
        }
        expect(klvAt.length).toBeGreaterThan(1);
        ts[klvAt[1] + 3] = (ts[klvAt[1] + 3] & 0xF0) | ((ts[klvAt[1] + 3] + 5) & 0x0F);
        const damaged = klvStream(await TSParser.extractTSStreamsAsync(toBuffer(ts)));
        expect(damaged.tsIds.continuityErrors).toBeGreaterThan(0);
    });
});
