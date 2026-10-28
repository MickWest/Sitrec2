jest.mock('../src/showError', () => ({showErrorOnce: jest.fn()}));
jest.mock('../src/TileUsageTracker', () => ({
    identifyServiceFromUrl: url => (/arcgisonline\.com/.test(url) ? 'esri' : 'other'),
}));

import {ServiceAvailability} from '../src/ServiceAvailability';
import {showErrorOnce} from '../src/showError';

const tile = n => `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/10/406/${n}`;
const originalFetch = global.fetch;

function record(pattern) {
    // "S" = a tile loaded, "F" = a 5xx or network failure
    [...pattern].forEach((outcome, i) => {
        if (outcome === 'S') ServiceAvailability.recordSuccessByUrl(tile(i));
        else ServiceAvailability.recordFailureByUrl(tile(i));
    });
}

beforeEach(() => {
    ServiceAvailability.reset();
    ServiceAvailability.callbacks = {};
    showErrorOnce.mockClear();
});

afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
});

test('a service that fails from the start is unavailable after 10 failures', () => {
    const fallback = jest.fn();
    ServiceAvailability.onUnavailable('esri', fallback);

    record('F'.repeat(9));
    expect(ServiceAvailability.isAvailable('esri')).toBe(true);

    ServiceAvailability.recordFailureByUrl(tile(99));
    expect(ServiceAvailability.isAvailable('esri')).toBe(false);
    expect(showErrorOnce).toHaveBeenCalledTimes(1);
    expect(showErrorOnce.mock.calls[0][1]).toContain('10 of its last 10 requests failed');
    expect(fallback).toHaveBeenCalledWith('esri', tile(99));
});

test('the first few failures alone do not trip it', () => {
    record('FFFFF' + 'S'.repeat(5) + 'FFFFF');
    expect(ServiceAvailability.isAvailable('esri')).toBe(true);
});

test('offUnavailable removes a callback', () => {
    const fallback = jest.fn();
    ServiceAvailability.onUnavailable('esri', fallback);
    ServiceAvailability.offUnavailable('esri', fallback);
    record('F'.repeat(10));
    expect(ServiceAvailability.isAvailable('esri')).toBe(false);
    expect(fallback).not.toHaveBeenCalled();
});

// The 2026-10-27 ESRI fault: some tiles hung for 15 s and gave a CloudFront 502,
// the rest loaded. Five hung requests finish together, after the fast successes,
// and their retries fail at once on the cached error: ten failures in a row.
test('a burst of failures from a service that mostly works does not trip it', () => {
    record('S'.repeat(13) + 'F'.repeat(10));
    expect(ServiceAvailability.isAvailable('esri')).toBe(true);
    expect(showErrorOnce).not.toHaveBeenCalled();
});

test('a service that mostly fails is unavailable at 80% of the window', () => {
    record('SSSS' + 'F'.repeat(15));
    expect(ServiceAvailability.isAvailable('esri')).toBe(true); // 15 of 19

    ServiceAvailability.recordFailureByUrl(tile(99));
    expect(ServiceAvailability.isAvailable('esri')).toBe(false); // 16 of 20
});

test('a success after an outage makes the service available with a clear window', () => {
    record('F'.repeat(10));
    expect(ServiceAvailability.isAvailable('esri')).toBe(false);

    ServiceAvailability.recordSuccessByUrl(tile(50));
    expect(ServiceAvailability.isAvailable('esri')).toBe(true);

    record('F'.repeat(9));
    expect(ServiceAvailability.isAvailable('esri')).toBe(true); // 9 of 10
    ServiceAvailability.recordFailureByUrl(tile(99));
    expect(ServiceAvailability.isAvailable('esri')).toBe(false); // 10 of 11
});

describe('probe', () => {
    beforeEach(() => record('F'.repeat(10)));

    test.each([200, 404])('an answer with status %i means the service is up', async status => {
        global.fetch = jest.fn(async () => ({status, ok: status < 300}));
        await expect(ServiceAvailability.probe(tile(1))).resolves.toBe(true);
        expect(ServiceAvailability.isAvailable('esri')).toBe(true);
        expect(fetch).toHaveBeenCalledWith(tile(1), expect.objectContaining({cache: 'no-store'}));
    });

    // A real tile request would fail the same way, so the map must not come back.
    test.each([401, 403, 429, 502, 503])('an answer with status %i means it is still down', async status => {
        global.fetch = jest.fn(async () => ({status, ok: false}));
        await expect(ServiceAvailability.probe(tile(1))).resolves.toBe(false);
        expect(ServiceAvailability.isAvailable('esri')).toBe(false);
    });

    test('a network failure or a CORS-blocked error page means it is still down', async () => {
        global.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); });
        await expect(ServiceAvailability.probe(tile(1))).resolves.toBe(false);
        expect(ServiceAvailability.isAvailable('esri')).toBe(false);
    });

    test('a Mapbox probe sends the origin, as a Mapbox tile request does', async () => {
        const url = 'https://api.mapbox.com/styles/v1/example/tiles/7/22/51';
        global.fetch = jest.fn(async () => ({status: 200, ok: true}));
        await ServiceAvailability.probe(url);
        expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({referrerPolicy: 'strict-origin'}));
    });
});

describe('watchRecovery', () => {
    test('probes once per interval until the server answers, then calls back once', async () => {
        jest.useFakeTimers();
        global.fetch = jest.fn()
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValue({status: 200, ok: true});
        const onAnswer = jest.fn();
        ServiceAvailability.watchRecovery(tile(1), onAnswer, 1000);

        await jest.advanceTimersByTimeAsync(999);
        expect(fetch).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(onAnswer).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1000);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(onAnswer).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(5000);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    test('reset() does not stop a watch; its stop function does', async () => {
        jest.useFakeTimers();
        global.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); });
        const stop = ServiceAvailability.watchRecovery(tile(1), jest.fn(), 1000);

        ServiceAvailability.reset();
        await jest.advanceTimersByTimeAsync(2000);
        expect(fetch).toHaveBeenCalledTimes(2);

        stop();
        await jest.advanceTimersByTimeAsync(5000);
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});
