import { sanitizeAvcDescription } from '../src/H264Utils';

// Parse a hex string ("01 64 00 28 …") into a Uint8Array.
const hex = (s) => new Uint8Array(s.trim().split(/\s+/).map((b) => parseInt(b, 16)));
const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join(' ');

// Exact avcC bytes pulled from a real broken export (lb.mp4, Firefox / Windows Media Foundation
// "Microsoft H.264 Encoder V1.5.3"). Each parameter set has a DUPLICATED leading NAL-header byte
// (SPS "67 67 …", PPS "68 68 …") and the reserved bits are zeroed (byte[4]=0x03, byte[5]=0x01).
const BROKEN = hex(`
    01 64 00 28 03 01 00 1c
    67 67 64 00 28 ac 2c ac 07 80 22 7e 58 40 00 00 03 00 40 00 00 03 03 83 68 22 11 4e
    01 00 05
    68 68 ce 3c 30
`);

// The same record, repaired: duplicate bytes stripped, lengths fixed, reserved bits restored.
const FIXED = hex(`
    01 64 00 28 ff e1 00 1b
    67 64 00 28 ac 2c ac 07 80 22 7e 58 40 00 00 03 00 40 00 00 03 03 83 68 22 11 4e
    01 00 04
    68 ce 3c 30
`);

describe('sanitizeAvcDescription', () => {

    test('repairs the duplicated SPS/PPS NAL header bytes from a real broken export', () => {
        const { bytes, repaired, warning } = sanitizeAvcDescription(BROKEN);
        expect(repaired).toBe(true);
        expect(warning).toBeNull();
        expect(toHex(bytes)).toBe(toHex(FIXED));
    });

    test('leaves an already-valid description unchanged (no false positives)', () => {
        const { bytes, repaired } = sanitizeAvcDescription(FIXED);
        expect(repaired).toBe(false);
        expect(bytes).toBe(FIXED); // returns the original instance, untouched
    });

    test('leaves a valid Baseline-profile description unchanged', () => {
        // Baseline (profile_idc 0x42), short SPS/PPS, compliant reserved bits (ff e1).
        const baseline = hex(`
            01 42 c0 1e ff e1 00 0d 67 42 c0 1e d9 00 50 05 bb 01 6c 80 00 01 00 04 68 ce 3c 80
        `);
        const { bytes, repaired } = sanitizeAvcDescription(baseline);
        expect(repaired).toBe(false);
        expect(bytes).toBe(baseline);
    });

    // The reserved-bits gate closes the one theoretical false positive: a VALID PPS whose first
    // RBSP byte legitimately equals 0x68 (pps_id=2, sps_id=1). With compliant reserved bits the
    // record must be left untouched even though it superficially looks like the dup-header bug.
    test('does NOT strip a valid PPS whose first RBSP byte is 0x68 (compliant reserved bits)', () => {
        const tricky = hex(`
            01 64 00 28 ff e1 00 1b
            67 64 00 28 ac 2c ac 07 80 22 7e 58 40 00 00 03 00 40 00 00 03 03 83 68 22 11 4e
            01 00 05
            68 68 ce 3c 30
        `);
        const { bytes, repaired, warning } = sanitizeAvcDescription(tricky);
        expect(repaired).toBe(false);
        expect(warning).toBeNull();
        expect(bytes).toBe(tricky);
    });

    // Reserved-bits-only corruption (NALs fine) is the other half of the observed bug; normalize it.
    test('restores reserved bits even when the NALs are not duplicated', () => {
        const reservedOnly = hex(`
            01 64 00 28 03 01 00 1b
            67 64 00 28 ac 2c ac 07 80 22 7e 58 40 00 00 03 00 40 00 00 03 03 83 68 22 11 4e
            01 00 04
            68 ce 3c 30
        `);
        const { bytes, repaired } = sanitizeAvcDescription(reservedOnly);
        expect(repaired).toBe(true);
        expect(toHex(bytes)).toBe(toHex(FIXED)); // same valid record, reserved bits now ff/e1
    });

    test('flags but does not alter an Annex-B-form description (configurationVersion != 1)', () => {
        const annexb = hex('00 00 00 01 67 64 00 28 ac 2c 00 00 00 01 68 ce 3c 30');
        const { bytes, repaired, warning } = sanitizeAvcDescription(annexb);
        expect(repaired).toBe(false);
        expect(bytes).toBe(annexb);
        expect(warning).toMatch(/configurationVersion/);
    });

    test('accepts an ArrayBuffer input', () => {
        const buf = BROKEN.buffer.slice(BROKEN.byteOffset, BROKEN.byteOffset + BROKEN.byteLength);
        const { bytes, repaired } = sanitizeAvcDescription(buf);
        expect(repaired).toBe(true);
        expect(toHex(bytes)).toBe(toHex(FIXED));
    });

    test('accepts a byte-offset typed-array view without reading neighboring bytes', () => {
        const padded = new Uint8Array(BROKEN.length + 8);
        padded.fill(0xaa);
        padded.set(BROKEN, 4);
        const view = padded.subarray(4, 4 + BROKEN.length);
        const { bytes, repaired } = sanitizeAvcDescription(view);
        expect(repaired).toBe(true);
        expect(toHex(bytes)).toBe(toHex(FIXED));
    });

    test('does not throw or corrupt on truncated/garbage input', () => {
        const garbage = hex('01 64 00 28 03 01 00 ff 67');
        const { bytes, repaired } = sanitizeAvcDescription(garbage);
        expect(repaired).toBe(false);
        expect(bytes).toBe(garbage);
    });

    test('handles null/empty description without throwing', () => {
        expect(sanitizeAvcDescription(null).repaired).toBe(false);
        expect(sanitizeAvcDescription(new Uint8Array(0)).repaired).toBe(false);
    });
});
