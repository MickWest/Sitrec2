import {muxVideoKlv, mpegCRC} from "../../benchmarks/botbench/lib/muxVideoKlv";
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
function fixture() {
    return Buffer.concat([
        psi(0, [0,0xb0,13,0,1,0xc1,0,0,0,1,0xf0,0]),
        psi(0x1000, [2,0xb0,18,0,1,0xc1,0,0,0xe1,0,0xf0,0,0x1b,0xe1,0,0xf0,0]),
        ...[0, 3000, 6000].map(t => packet(0x100, [0,0,1,0xe0,0,0,0x80,0x80,5,
            0x21,0,1 | (t >> 14), (t >> 7) & 255, ((t & 127) << 1) | 1, 0,0,0,1,9,0xf0])),
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
