jest.mock('../src/js/map33/material/TerrainDayNightMaterial', () => ({}));
jest.mock('../src/TileUsageTracker', () => ({TileUsageTracker: {trackTile: jest.fn()}}));
jest.mock('../src/ServiceAvailability', () => ({ServiceAvailability: {
    isAvailableByUrl: () => true,
    recordSuccessByUrl: jest.fn(),
    recordFailureByUrl: jest.fn(),
}}));

import {loadTextureWithRetries} from '../src/js/map33/material/QuadTextureMaterial';
import {badTextureUrls} from '../src/QuadTreeTileCache';

const blockedHash = 'b02c44252dac5a5e820ecef1e9bf9200e9407c042df668a466a1aa81a9ecca7a';
const originalFetch = global.fetch;
const originalImage = global.Image;
const originalCrypto = Object.getOwnPropertyDescriptor(global, 'crypto');
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
    badTextureUrls.clear();
    global.fetch = jest.fn(async () => ({ok: true, blob: async () => ({size: 50})}));
    global.Image = class { set src(value) { queueMicrotask(() => this.onload()); } };
    URL.createObjectURL = jest.fn(() => 'blob:test-tile');
    URL.revokeObjectURL = jest.fn();
    Object.defineProperty(global, 'crypto', {configurable: true, value: {
        subtle: {digest: jest.fn(async () => new Uint8Array(32).buffer)},
    }});
});

afterEach(() => {
    global.fetch = originalFetch;
    global.Image = originalImage;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    if (originalCrypto) Object.defineProperty(global, 'crypto', originalCrypto);
    else delete global.crypto;
    jest.restoreAllMocks();
});

test.each([
    ['https://tile.openstreetmap.org/7/22/51.png', true],
    ['https://c.tile.openstreetmap.org/7/22/51.png', true],
    ['https://api.mapbox.com/styles/v1/example/tiles/7/22/51', true],
    ['https://tile.openstreetmap.org.example.net/7/22/51.png', false],
    ['https://example.net/?url=https://tile.openstreetmap.org/7/22/51.png', false],
    ['http://tile.openstreetmap.org/7/22/51.png', false],
    ['/sitrec/local-tile.png', false],
])('identifies approved tile hosts without changing cache behavior: %s', async (url, identified) => {
    const controller = new AbortController();
    await loadTextureWithRetries(url, 0, 100, 0, 0, controller.signal);
    expect(fetch).toHaveBeenCalledWith(url, {
        signal: controller.signal,
        ...(identified ? {referrerPolicy: 'strict-origin'} : {}),
    });
});

test('rejects a known HTTP 200 OSM block image without retrying or decoding it', async () => {
    const url = 'https://tile.openstreetmap.org/7/22/51.png';
    fetch.mockResolvedValue({ok: true, blob: async () => ({size: 6987, arrayBuffer: async () => new ArrayBuffer(6987)})});
    crypto.subtle.digest.mockResolvedValue(Uint8Array.from(blockedHash.match(/../g), x => parseInt(x, 16)).buffer);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(loadTextureWithRetries([url, url + '?fallback'], 2)).rejects.toThrow('BlockedTile');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await expect(loadTextureWithRetries(url)).rejects.toThrow('KnownBadUrl');
    expect(fetch).toHaveBeenCalledTimes(1);
});

test('accepts a different image with the same byte count as the block notice', async () => {
    fetch.mockResolvedValue({ok: true, blob: async () => ({size: 6987, arrayBuffer: async () => new ArrayBuffer(6987)})});
    await expect(loadTextureWithRetries('https://tile.openstreetmap.org/7/22/51.png')).resolves.toHaveProperty('isTexture', true);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
});

test('never fetches an already cancelled tile', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(loadTextureWithRetries('https://tile.openstreetmap.org/7/22/51.png', 0, 100, 0, 0, controller.signal)).rejects.toThrow('Aborted');
    expect(fetch).not.toHaveBeenCalled();
});
