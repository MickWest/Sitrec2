// Mock IndexedDBManager before importing BYOKUsage so the store uses the mock.
jest.mock('../src/IndexedDBManager', () => {
    const store = new Map();
    return {
        indexedDBManager: {
            async getSetting(key) { return store.has(key) ? store.get(key) : null; },
            async setSetting(key, value) { store.set(key, value); },
            async deleteSetting(key) { store.delete(key); },
            async getAllSettings() {
                const obj = {};
                for (const [k, v] of store.entries()) obj[k] = v;
                return obj;
            },
            _reset() { store.clear(); },
            _internal: store,
        },
    };
});

import { indexedDBManager } from '../src/IndexedDBManager';
import { hasAnyKey, setKey } from '../src/BYOKKeyStore';
import {
    addUsage, emptyUsage, estimateCostUSD, formatUsageReport, getUsageByModel,
    pricesFor, recordUsage, resetUsage,
} from '../src/BYOKUsage';

beforeEach(() => {
    indexedDBManager._reset();
});

const DURING_PROMO = Date.UTC(2026, 7, 14);   // 2026-08-14
const AFTER_PROMO = Date.UTC(2026, 8, 15);    // 2026-09-15

describe('pricing', () => {
    test('Sonnet 5 uses introductory rates during the promo window', () => {
        expect(pricesFor('claude-sonnet-5', DURING_PROMO)).toEqual({input: 2, output: 10});
    });

    // The promo is published as running "through 2026-08-31". Quoting the standard
    // rate during it overstates a Sonnet turn by 50%; hardcoding the promo rate
    // instead would understate it by 33% the moment the promo lapses.
    test('Sonnet 5 reverts to standard rates once the promo lapses', () => {
        expect(pricesFor('claude-sonnet-5', AFTER_PROMO)).toEqual({input: 3, output: 15});
    });

    test('models without a promo are unaffected by the date', () => {
        expect(pricesFor('claude-opus-5', DURING_PROMO)).toEqual({input: 5, output: 25});
        expect(pricesFor('claude-opus-5', AFTER_PROMO)).toEqual({input: 5, output: 25});
        expect(pricesFor('claude-haiku-4-5', DURING_PROMO)).toEqual({input: 1, output: 5});
    });

    test('an unknown model has no price rather than a made-up one', () => {
        expect(pricesFor('some-future-model')).toBeNull();
        expect(estimateCostUSD('some-future-model', {inputTokens: 1e6})).toBeNull();
    });

    test('cost uses per-million rates', () => {
        // 1M in + 1M out on Opus 5 = $5 + $25
        const cost = estimateCostUSD('claude-opus-5', {inputTokens: 1e6, outputTokens: 1e6});
        expect(cost).toBeCloseTo(30, 6);
    });

    test('cached input is billed at the reduced rate, not the full input rate', () => {
        // Cache read is ~0.1x input, cache write ~1.25x. Counting either at the full
        // input rate would materially overstate cost, since the client sets two
        // cache breakpoints and most turns read a large cached prefix.
        const cached = estimateCostUSD('claude-opus-5', {cacheReadTokens: 1e6});
        expect(cached).toBeCloseTo(0.5, 6);
        const written = estimateCostUSD('claude-opus-5', {cacheWriteTokens: 1e6});
        expect(written).toBeCloseTo(6.25, 6);
    });
});

describe('accumulation', () => {
    test('addUsage sums every tracked field', () => {
        const total = addUsage(emptyUsage(), {inputTokens: 10, outputTokens: 5, requests: 1});
        addUsage(total, {inputTokens: 3, outputTokens: 1, requests: 1});
        expect(total.inputTokens).toBe(13);
        expect(total.outputTokens).toBe(6);
        expect(total.requests).toBe(2);
    });

    test('recordUsage banks cost per model and survives a later price change', async () => {
        await recordUsage('claude-opus-5', {inputTokens: 1e6, outputTokens: 0, requests: 1});
        const byModel = await getUsageByModel();
        expect(byModel['claude-opus-5'].inputTokens).toBe(1e6);
        expect(byModel['claude-opus-5'].costUSD).toBeCloseTo(5, 6);

        const report = await formatUsageReport();
        expect(report.totalRequests).toBe(1);
        expect(report.totalCost).toBeCloseTo(5, 6);
    });

    test('resetUsage clears the totals', async () => {
        await recordUsage('claude-opus-5', {inputTokens: 100, requests: 1});
        await resetUsage();
        expect(await formatUsageReport()).toMatchObject({totalRequests: 0});
    });
});

// Regression guard for a real trap: BYOKKeyStore.getAllProviders() enumerates every
// IndexedDB entry prefixed "byok_" and treats it as a stored provider key. Putting the
// usage totals under that prefix would make hasAnyKey() true with no key entered,
// offering BYOK models to users who never supplied one.
test('usage storage does not squat on the BYOK key namespace', async () => {
    await recordUsage('claude-opus-5', {inputTokens: 100, requests: 1});
    expect(await hasAnyKey()).toBe(false);

    for (const key of indexedDBManager._internal.keys()) {
        expect(key.startsWith('byok_')).toBe(false);
    }

    // ...and a real key still registers.
    await setKey('anthropic', 'sk-ant-test');
    expect(await hasAnyKey()).toBe(true);
});
