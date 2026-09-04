import {getDateTimeFilename, screenshotFilename} from '../src/utils';

afterEach(() => jest.restoreAllMocks());

test('version and screenshot names retain sortable prefixes and all 128 random bits', () => {
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-09-04T12:34:56.000Z');
    const random = jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(bytes => {
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes.byteLength).toBe(16);
        bytes.set(Array.from({length: 16}, (_, i) => i));
        return bytes;
    });
    const token = '20260904_123456_000102030405060708090a0b0c0d0e0f';
    expect(getDateTimeFilename()).toBe(token);
    expect(screenshotFilename()).toBe(`screenshot_${token}.jpg`);
    expect(random).toHaveBeenCalledTimes(2);
});

test('unavailable secure randomness fails without a weaker token fallback', () => {
    jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => { throw new Error('Randomness unavailable'); });
    expect(() => getDateTimeFilename()).toThrow('Randomness unavailable');
});
