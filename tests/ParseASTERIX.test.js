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

describe('ParseASTERIX', () => {
    test('isPCAP detects libpcap little-endian magic', () => {
        expect(isPCAP(loadBuf('cat_034_048.pcap'))).toBe(true);
    });

    test('isPCAP rejects raw ASTERIX', () => {
        expect(isPCAP(loadBuf('cat048.raw'))).toBe(false);
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
