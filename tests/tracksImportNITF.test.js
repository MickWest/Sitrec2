/**
 * @jest-environment jsdom
 */
// A truncated NITF (e.g. a partial download) used to throw a RangeError out of
// parseNITF, past every hideProgress(), leaving the full-screen input blocker up
// until the page was reloaded. The blocker must always come down, the user gets an
// error message, and the parse fails with a clear error instead of a RangeError.

import {NITFParser} from '../src/NITFParser';
import {hideProgress, initProgress} from '../src/CProgressIndicator';
import {showError} from '../src/showError';

jest.mock('../src/FileUtils', () => ({createImageFromArrayBuffer: jest.fn()}));
jest.mock('../src/JPEG2000Utils', () => ({
    decodeJPEG2000ToBlobURL: jest.fn(),
    decodeJ2KTiledToCanvas: jest.fn()
}));
jest.mock('../src/CProgressIndicator', () => ({
    initProgress: jest.fn(), updateProgress: jest.fn(), hideProgress: jest.fn()
}));
jest.mock('../src/showError', () => ({showError: jest.fn()}));

// A minimal single-image NITF 2.1 (8-bit mono, uncompressed), optionally with a
// band lookup table, as an ArrayBuffer of the given length (default: complete).
function buildNITF({nrows = 64, ncols = 64, lutEntries = 0, truncateTo} = {}) {
    const dataLength = nrows * ncols;
    const sub = [];
    const str = (s, len) => sub.push(s.padEnd(len, ' ').substring(0, len));
    const int = (v, len) => sub.push(String(v).padStart(len, '0'));
    str('IM', 2); str('', 10); str('20200615120000', 14); str('', 17); str('Truncated Test', 80);
    str('U', 1); str('', 166); str('0', 1); str('', 42);
    int(nrows, 8); int(ncols, 8); str('INT', 3); str('MONO', 8); str('VIS', 8); int(8, 2);
    str('R', 1); str(' ', 1); int(0, 1); str('NC', 2);
    int(1, 1); str('M', 2); str('', 6); str('N', 1); str('', 3);         // one band
    if (lutEntries > 0) {
        int(1, 1); int(lutEntries, 5); str('', lutEntries);              // NLUTS, NELUT, LUT
    } else {
        int(0, 1);
    }
    str('0', 1); str('B', 1); int(1, 4); int(1, 4); int(ncols, 4); int(nrows, 4); int(8, 2);
    str('', 20); int(0, 5); int(0, 5);
    const subheader = sub.join('');

    const hdr = [];
    const hStr = (s, len) => hdr.push(s.padEnd(len, ' ').substring(0, len));
    const hInt = (v, len) => hdr.push(String(v).padStart(len, '0'));
    hStr('NITF', 4); hStr('02.10', 5); hInt(3, 2); hStr('BF01', 4); hStr('TEST', 10);
    hStr('20200615120000', 14); hStr('Truncated NITF', 80); hStr('U', 1); hStr('', 166);
    hInt(0, 5); hInt(0, 5); hStr('0', 1); hStr('', 3); hStr('', 24); hStr('', 18);
    const headerLength = hdr.join('').length + 12 + 6 + 3 + 16 + 3 + 3 + 3 + 3 + 3 + 5 + 5;
    hInt(headerLength + subheader.length + dataLength, 12); hInt(headerLength, 6);
    hInt(1, 3); hInt(subheader.length, 6); hInt(dataLength, 10);
    hInt(0, 3); hInt(0, 3); hInt(0, 3); hInt(0, 3); hInt(0, 3); hInt(0, 5); hInt(0, 5);
    const text = hdr.join('') + subheader;

    const bytes = new Uint8Array(text.length + dataLength);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes.buffer.slice(0, truncateTo ?? bytes.length);
}

const fullLength = buildNITF().byteLength;

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    initProgress.mockClear();
    hideProgress.mockClear();
    showError.mockClear();
});

afterEach(() => jest.restoreAllMocks());

test('the complete synthetic file parses', () => {
    const nitf = NITFParser.parseNITF(buildNITF());
    expect(nitf.images).toHaveLength(1);
    expect(nitf.images[0].rawData.length).toBe(64 * 64);
});

test('image data cut short fails with a clear error, not a RangeError', () => {
    const truncated = buildNITF({truncateTo: fullLength - 1000});
    expect(() => NITFParser.parseNITF(truncated)).toThrow(/truncated/);
});

test('a lookup table cut short fails with a clear error, not a RangeError', () => {
    const withLut = buildNITF({lutEntries: 4096});
    const lutStart = withLut.byteLength - 64 * 64 - 4096;
    expect(() => NITFParser.parseNITF(withLut.slice(0, lutStart + 100))).toThrow(/truncated/);
});

test('a TRE that runs past the end of the file is skipped', () => {
    const bytes = new Uint8Array(Array.from('ABCDEF00004wxyzGHIJKL00100abc', c => c.charCodeAt(0)));
    // declared length is longer than the bytes present, as in a truncated file
    const tres = NITFParser.parseTREs(bytes, 0, 1000);
    expect(Object.keys(tres)).toEqual(['ABCDEF']);
    expect(tres.ABCDEF.text).toBe('wxyz');
});

test('a truncated file takes the input blocker down and tells the user', async () => {
    const truncated = buildNITF({truncateTo: fullLength - 1000});
    const results = await NITFParser.parseNITFFile('uploads/partial.ntf', 'partial', truncated);
    expect(results).toEqual([]);
    expect(initProgress).toHaveBeenCalled();
    expect(hideProgress).toHaveBeenCalled();
    expect(hideProgress.mock.invocationCallOrder.at(-1))
        .toBeGreaterThan(initProgress.mock.invocationCallOrder.at(-1));
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls[0][0]).toMatch(/partial\.ntf.*truncated/s);
});
