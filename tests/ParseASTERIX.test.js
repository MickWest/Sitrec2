/**
 * @jest-environment jsdom
 */
import fs from 'fs';
import path from 'path';
import {parseASTERIXBuffer, isPCAP, looksLikeASTERIX} from '../src/utils/ParseASTERIX';
import {MISB} from '../src/MISBFields';

const TEST_DIR = path.join(__dirname, '..', 'test-data', 'TEST-Radar');

function loadBuf(name) {
    // fs.readFileSync returns a Node Buffer whose `.buffer` is a shared pool —
    // we need the slice corresponding to this file's bytes specifically.
    const b = fs.readFileSync(path.join(TEST_DIR, name));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function makeASTERIXRecord(cat, body) {
    const record = Buffer.alloc(3 + body.length);
    record[0] = cat;
    record.writeUInt16BE(record.length, 1);
    body.copy(record, 3);
    return record;
}

function makeCAT062Record(trackNumber, lat = 41.5, lon = 15.5) {
    const body = Buffer.alloc(17);
    let off = 0;
    body[off++] = 0x99; // FRN 1,4,5 + FX
    body[off++] = 0x08; // FRN 12 (I062/040 track number)
    body[off++] = 10; // SAC
    body[off++] = 20; // SIC
    body.writeUIntBE(123456, off, 3); // I062/070 time of track information
    off += 3;
    body.writeInt32BE(Math.round(lat / (180 / 33554432)), off);
    off += 4;
    body.writeInt32BE(Math.round(lon / (180 / 33554432)), off);
    off += 4;
    body.writeUInt16BE(trackNumber, off);
    return makeASTERIXRecord(62, body);
}

function makeEthernetIPv4UDPPacket(payload) {
    const packet = Buffer.alloc(14 + 20 + 8 + payload.length);
    let off = 0;
    packet.fill(0xff, off, off + 6); off += 6; // dst
    packet.fill(0x11, off, off + 6); off += 6; // src
    packet.writeUInt16BE(0x0800, off); off += 2;
    packet[off++] = 0x45; // IPv4, IHL=5
    packet[off++] = 0;
    packet.writeUInt16BE(20 + 8 + payload.length, off); off += 2;
    packet.writeUInt16BE(0, off); off += 2;
    packet.writeUInt16BE(0, off); off += 2;
    packet[off++] = 64;
    packet[off++] = 17; // UDP
    packet.writeUInt16BE(0, off); off += 2;
    packet.writeUInt32BE(0x0A000001, off); off += 4;
    packet.writeUInt32BE(0xE0000001, off); off += 4;
    packet.writeUInt16BE(30000, off); off += 2;
    packet.writeUInt16BE(30001, off); off += 2;
    packet.writeUInt16BE(8 + payload.length, off); off += 2;
    packet.writeUInt16BE(0, off); off += 2;
    payload.copy(packet, off);
    return packet;
}

function makeClassicPCAP(payload) {
    const packet = makeEthernetIPv4UDPPacket(payload);
    const pcap = Buffer.alloc(24 + 16 + packet.length);
    let off = 0;
    pcap.writeUInt32LE(0xA1B2C3D4, off); off += 4;
    pcap.writeUInt16LE(2, off); off += 2;
    pcap.writeUInt16LE(4, off); off += 2;
    pcap.writeInt32LE(0, off); off += 4;
    pcap.writeUInt32LE(0, off); off += 4;
    pcap.writeUInt32LE(65535, off); off += 4;
    pcap.writeUInt32LE(1, off); off += 4;
    pcap.writeUInt32LE(1700000000, off); off += 4;
    pcap.writeUInt32LE(123000, off); off += 4;
    pcap.writeUInt32LE(packet.length, off); off += 4;
    pcap.writeUInt32LE(packet.length, off); off += 4;
    packet.copy(pcap, off);
    return pcap.buffer.slice(pcap.byteOffset, pcap.byteOffset + pcap.byteLength);
}

function makePcapng(payload) {
    const packet = makeEthernetIPv4UDPPacket(payload);
    const align4 = (n) => (n + 3) & ~3;
    const block = (type, body) => {
        const len = 12 + align4(body.length);
        const b = Buffer.alloc(len);
        b.writeUInt32LE(type, 0);
        b.writeUInt32LE(len, 4);
        body.copy(b, 8);
        b.writeUInt32LE(len, len - 4);
        return b;
    };
    const shbBody = Buffer.alloc(16);
    shbBody.writeUInt32LE(0x1A2B3C4D, 0);
    shbBody.writeUInt16LE(1, 4);
    shbBody.writeUInt16LE(0, 6);
    shbBody.writeBigInt64LE(-1n, 8);
    const idbBody = Buffer.alloc(8);
    idbBody.writeUInt16LE(1, 0); // Ethernet
    idbBody.writeUInt32LE(65535, 4);
    const epbBody = Buffer.alloc(20 + packet.length);
    epbBody.writeUInt32LE(0, 0);
    epbBody.writeUInt32LE(0, 4);
    epbBody.writeUInt32LE(1700000000123000 % 0x100000000, 8);
    epbBody.writeUInt32LE(packet.length, 12);
    epbBody.writeUInt32LE(packet.length, 16);
    packet.copy(epbBody, 20);
    const pcapng = Buffer.concat([block(0x0A0D0D0A, shbBody), block(1, idbBody), block(6, epbBody)]);
    return pcapng.buffer.slice(pcapng.byteOffset, pcapng.byteOffset + pcapng.byteLength);
}

describe('ParseASTERIX', () => {
    test('isPCAP detects libpcap little-endian magic', () => {
        expect(isPCAP(loadBuf('cat_034_048.pcap'))).toBe(true);
    });

    test('isPCAP rejects raw ASTERIX', () => {
        expect(isPCAP(loadBuf('cat048.raw'))).toBe(false);
    });

    test('pcapng parses ASTERIX UDP payloads', () => {
        const rows = parseASTERIXBuffer(makePcapng(Buffer.from(loadBuf('cat048.raw'))));
        expect(rows).not.toBeNull();
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows[0][MISB.TrackID]).toBeTruthy();
    });

    test('looksLikeASTERIX accepts a single CAT-048 record', () => {
        expect(looksLikeASTERIX(loadBuf('cat048.raw'))).toBe(true);
    });

    test('cat_034_048.pcap: parses to 42 unique aircraft tracks', () => {
        const rows = parseASTERIXBuffer(loadBuf('cat_034_048.pcap'));
        expect(rows).not.toBeNull();
        const uniqueIDs = new Set(rows.map(r => r[MISB.TrackID]));
        expect(uniqueIDs.size).toBe(42);
    });

    test('cat_034_048.pcap: DLH65A matches README (Mode-S, FL330, ~434 kt)', () => {
        const rows = parseASTERIXBuffer(loadBuf('cat_034_048.pcap'));
        const dlh = rows.filter(r => r[MISB.PlatformTailNumber] === 'DLH65A');
        expect(dlh.length).toBeGreaterThanOrEqual(1);

        const first = dlh[0];
        // FL330 = 33000 ft = 10058.4 m
        expect(first[MISB.SensorTrueAltitude]).toBeCloseTo(10058.4, 1);
        // Mode-S address 0x3C660C
        expect(first[MISB.TrackID]).toBe('S3C660C');

        // Rows are [phantom_start, plot, plot+4, phantom_end] in time order;
        // pick the inner pair (the actual plot and its velocity sibling).
        const sorted = [...dlh].sort((x, y) => x[MISB.UnixTimeStamp] - y[MISB.UnixTimeStamp]);
        if (sorted.length >= 3) {
            const a = sorted[1], b = sorted[2];
            const dt = (b[MISB.UnixTimeStamp] - a[MISB.UnixTimeStamp]) / 1000;
            const R = 6371000;
            const dLat = (b[MISB.SensorLatitude] - a[MISB.SensorLatitude]) * Math.PI / 180;
            const dLon = (b[MISB.SensorLongitude] - a[MISB.SensorLongitude]) * Math.PI / 180;
            const lat = a[MISB.SensorLatitude] * Math.PI / 180;
            const dist = R * Math.sqrt(dLat * dLat + (dLon * Math.cos(lat)) ** 2);
            const speedKt = (dist / dt) / 0.514444;
            expect(speedKt).toBeGreaterThan(420);
            expect(speedKt).toBeLessThan(450);
        }
    });

    test('cat_034_048.pcap: every row has valid (lat, lon, time, alt)', () => {
        const rows = parseASTERIXBuffer(loadBuf('cat_034_048.pcap'));
        for (const r of rows) {
            const t = r[MISB.UnixTimeStamp];
            const lat = r[MISB.SensorLatitude];
            const lon = r[MISB.SensorLongitude];
            const alt = r[MISB.SensorTrueAltitude];
            expect(typeof t).toBe('number');
            expect(Number.isFinite(t)).toBe(true);
            expect(Number.isFinite(lat)).toBe(true);
            expect(Number.isFinite(lon)).toBe(true);
            expect(Number.isFinite(alt)).toBe(true);
        }
    });

    test('cat_034_048.pcap: per-track timestamps are strictly increasing', () => {
        const rows = parseASTERIXBuffer(loadBuf('cat_034_048.pcap'));
        const byTrack = new Map();
        for (const r of rows) {
            const k = r[MISB.TrackID];
            if (!byTrack.has(k)) byTrack.set(k, []);
            byTrack.get(k).push(r[MISB.UnixTimeStamp]);
        }
        for (const [k, times] of byTrack) {
            for (let i = 1; i < times.length; i++) {
                expect(times[i]).toBeGreaterThan(times[i - 1]);
            }
        }
    });

    test('cat_062_065.pcap: CAT-062 system track at southern Italy', () => {
        const rows = parseASTERIXBuffer(loadBuf('cat_062_065.pcap'));
        expect(rows).not.toBeNull();
        expect(rows.length).toBeGreaterThan(0);
        const r = rows[0];
        // WGS-84 ~ Foggia/Bari area
        expect(r[MISB.SensorLatitude]).toBeGreaterThan(40);
        expect(r[MISB.SensorLatitude]).toBeLessThan(43);
        expect(r[MISB.SensorLongitude]).toBeGreaterThan(14);
        expect(r[MISB.SensorLongitude]).toBeLessThan(17);
    });

    test('CAT-062 same-source tracks without callsigns stay separate by track number', () => {
        const payload = Buffer.concat([
            makeCAT062Record(101, 41.5, 15.5),
            makeCAT062Record(202, 41.6, 15.6),
        ]);
        const rows = parseASTERIXBuffer(makeClassicPCAP(payload));
        const uniqueIDs = new Set(rows.map(r => r[MISB.TrackID]));
        expect(uniqueIDs).toEqual(new Set(['T10_20_101', 'T10_20_202']));
    });

    test('cat048.raw: standalone raw stream parses to 1+ row', () => {
        const rows = parseASTERIXBuffer(loadBuf('cat048.raw'));
        expect(rows).not.toBeNull();
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows[0][MISB.TrackID]).toBeTruthy();
    });

    test('rejects an unrelated buffer', () => {
        const buf = Buffer.from('not a pcap, not asterix').buffer.slice(0);
        expect(isPCAP(buf)).toBe(false);
        expect(looksLikeASTERIX(buf)).toBe(false);
        expect(parseASTERIXBuffer(buf)).toBeNull();
    });
});
