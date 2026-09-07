import {muxVideoKlv, mpegCRC, encodePTS} from "../../benchmarks/botbench/lib/muxVideoKlv";
import {scanTransportStreamForMetadata} from "../../src/analysis/TSMetadataScanner";
import {encodeMISBLocalSet} from "../../src/MISBEncoder";
import {TSParser} from "../../src/TSParser";

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
