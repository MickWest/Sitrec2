// The model catalogue: what the user's own keys actually reach.
//
// The point of this module is that nothing here is a hardcoded list, so the tests are
// about the two things that CAN silently go wrong: the OpenAI filter quietly dropping a
// model that should be offered, and the id normalisation failing to find a price.

jest.mock('../src/IndexedDBManager', () => {
    const store = new Map();
    return {
        indexedDBManager: {
            async getSetting(key) { return store.has(key) ? store.get(key) : null; },
            async setSetting(key, value) { store.set(key, value); },
            async deleteSetting(key) { store.delete(key); },
            async getAllSettings() { return Object.fromEntries(store); },
            _reset() { store.clear(); },
            _internal: store,
        },
    };
});

jest.mock('../src/BYOKKeyStore', () => ({
    getKey: jest.fn(async () => null),
}));

import {indexedDBManager} from '../src/IndexedDBManager';
import {getKey} from '../src/BYOKKeyStore';
import {
    catalogPricesFor, filterToCurrentGeneration, getCatalogModels, primeModelCatalog,
    refreshModelCatalog,
} from '../src/BYOKModelCatalog';

beforeEach(() => {
    indexedDBManager._reset();
    jest.resetAllMocks();
});

// The exact id list an OpenAI key returned on 2026-08-31, trimmed to one of each family.
// A model that should be OFFERED disappearing is the failure this module exists to prevent,
// so the assertions run in both directions.
const OPENAI_SAMPLE = [
    'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini',
    'gpt-5-codex', 'gpt-5-chat-latest', 'chat-latest', 'gpt-4o', 'gpt-4.1', 'o3', 'o4-mini',
    // ...and the families that cannot drive a typed, tool-using assistant:
    'text-embedding-3-small', 'whisper-1', 'tts-1-hd', 'gpt-4o-transcribe',
    'gpt-image-2', 'omni-moderation-latest', 'sora-2', 'gpt-audio-mini',
    'gpt-realtime-2', 'gpt-3.5-turbo-instruct', 'davinci-002', 'babbage-002',
    'gpt-4o-search-preview', 'gpt-5-search-api', 'o4-mini-deep-research',
];

function mockCatalogFetches({openai = [], anthropic = [], prices = []} = {}) {
    global.fetch = jest.fn(async (url) => {
        const json = url.includes('api.openai.com')
            ? {data: openai.map((id, i) => ({id, created: 1000 + i}))}
            : url.includes('api.anthropic.com')
                ? {data: anthropic}
                : {data: prices};
        return {ok: true, status: 200, json: async () => json};
    });
}

describe('OpenAI model filtering', () => {
    test('offers every chat model and no non-chat one', async () => {
        getKey.mockImplementation(async p => (p === 'openai' ? 'sk-test' : null));
        mockCatalogFetches({openai: OPENAI_SAMPLE});

        await refreshModelCatalog({force: true});
        const ids = getCatalogModels('openai').map(m => m.id);

        // Offered — including the newest families, which is the whole point.
        for (const keep of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5',
            'gpt-5.4-mini', 'gpt-5-codex', 'gpt-5-chat-latest', 'chat-latest',
            'gpt-4o', 'gpt-4.1', 'o3', 'o4-mini']) {
            expect(ids).toContain(keep);
        }
        // Not offered: wrong modality, wrong API, or a fixed tool set of their own.
        for (const drop of ['text-embedding-3-small', 'whisper-1', 'tts-1-hd',
            'gpt-4o-transcribe', 'gpt-image-2', 'omni-moderation-latest', 'sora-2',
            'gpt-audio-mini', 'gpt-realtime-2', 'gpt-3.5-turbo-instruct', 'davinci-002',
            'babbage-002', 'gpt-4o-search-preview', 'gpt-5-search-api',
            'o4-mini-deep-research']) {
            expect(ids).not.toContain(drop);
        }
    });

    test('a provider with no key contributes nothing', async () => {
        getKey.mockImplementation(async () => null);
        mockCatalogFetches({});
        await refreshModelCatalog({force: true});
        expect(getCatalogModels('openai')).toBeNull();
        expect(getCatalogModels('anthropic')).toBeNull();
    });

    test('lists newest first, so a new release is not buried', async () => {
        getKey.mockImplementation(async p => (p === 'openai' ? 'sk-test' : null));
        // created ascending in the fixture, so the last id is the newest.
        mockCatalogFetches({openai: ['old-chat-model', 'mid-chat-model', 'new-chat-model']});
        await refreshModelCatalog({force: true});
        expect(getCatalogModels('openai').map(m => m.id))
            .toEqual(['new-chat-model', 'mid-chat-model', 'old-chat-model']);
    });

    test('a failing provider keeps the models it already had', async () => {
        getKey.mockImplementation(async p => (p === 'openai' ? 'sk-test' : null));
        mockCatalogFetches({openai: ['gpt-5.6-sol']});
        await refreshModelCatalog({force: true});

        // A rate limit or a network blip must not empty the dropdown mid-session.
        global.fetch = jest.fn(async () => { throw new Error('network down'); });
        await refreshModelCatalog({force: true});
        expect(getCatalogModels('openai').map(m => m.id)).toEqual(['gpt-5.6-sol']);
    });
});

describe('catalogue pricing', () => {
    // Real shapes and prices from openrouter.ai/api/v1/models, 2026-08-31.
    const PRICES = [
        {id: 'openai/gpt-5.6-sol', pricing: {prompt: '0.000002', completion: '0.00001',
            input_cache_read: '0.0000002', input_cache_write: '0.0000025'}},
        {id: 'anthropic/claude-fable-5', pricing: {prompt: '0.00001', completion: '0.00005',
            input_cache_read: '0.000001', input_cache_write: '0.0000125'}},
        {id: 'anthropic/claude-haiku-4.5', pricing: {prompt: '0.000001', completion: '0.000005'}},
        {id: 'anthropic/claude-opus-4.8', pricing: {prompt: '0.000005', completion: '0.000025'}},
    ];

    beforeEach(async () => {
        getKey.mockImplementation(async () => null);
        mockCatalogFetches({prices: PRICES});
        await refreshModelCatalog({force: true});
    });

    test('converts per-token strings to the per-million units BYOKUsage uses', () => {
        const p = catalogPricesFor('gpt-5.6-sol');
        // toBeCloseTo, not toEqual: 0.0000002 * 1e6 is 0.19999999999999998 in binary
        // floating point. estimateCostUSD multiplies by 1e-6 again, so the error is far
        // below a cent and pinning the exact bits would only make the test brittle.
        expect(p.input).toBeCloseTo(2, 10);
        expect(p.output).toBeCloseTo(10, 10);
        expect(p.cachedInput).toBeCloseTo(0.2, 10);
        expect(p.cacheWriteRate).toBeCloseTo(2.5, 10);
    });

    // The id forms differ between the provider APIs and OpenRouter's catalogue: Anthropic
    // ships "claude-opus-4-8" and dated snapshots, OpenRouter says "claude-opus-4.8".
    test('normalises version separators and snapshot dates to find a price', () => {
        expect(catalogPricesFor('claude-fable-5')).toMatchObject({input: 10, output: 50});
        expect(catalogPricesFor('claude-opus-4-8')).toMatchObject({input: 5, output: 25});
        expect(catalogPricesFor('claude-haiku-4-5-20251001')).toMatchObject({input: 1, output: 5});
    });

    test('an OpenRouter slug is looked up as itself', () => {
        expect(catalogPricesFor('openai/gpt-5.6-sol')).toMatchObject({input: 2, output: 10});
    });

    test('an unknown model reports no price rather than a made-up one', () => {
        // formatUsageReport shows tokens and says the total excludes it; a zero here would
        // silently understate spend instead.
        expect(catalogPricesFor('gpt-9-imaginary')).toBeNull();
        expect(catalogPricesFor('')).toBeNull();
    });

    test('the catalogue survives a reload', async () => {
        const {byProvider, prices} = await indexedDBManager.getSetting('sitrecModelCatalog');
        expect(prices['openai/gpt-5.6-sol']).toBeDefined();
        expect(byProvider).toBeDefined();
        await expect(primeModelCatalog()).resolves.toBeDefined();
    });
});

// Trimming the list to each vendor's newest generation. The generation is derived from the
// ids rather than listed anywhere, so what these tests protect is that derivation — a new
// family must be current the day it appears, with no constant to edit.
describe('current-generation filter', () => {
    const m = id => ({model: id});
    const ids = list => filterToCurrentGeneration(list.map(m)).map(x => x.model);

    test('keeps the newest Claude generation and drops the rest', () => {
        expect(ids([
            'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5',
            'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-opus-4-5-20251101',
            'claude-haiku-4-5-20251001',
        ])).toEqual(['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5']);
    });

    test('keeps the newest GPT family and drops the rest', () => {
        expect(ids([
            'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
            'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4-mini-2026-03-17', 'gpt-5-mini',
            'gpt-4o', 'gpt-4.1', 'gpt-3.5-turbo',
            // No version at all: superseded in practice, and correctly counted as old.
            'o3', 'o4-mini', 'chat-latest',
        ])).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
    });

    test('compares vendors separately, so each keeps its own newest', () => {
        // Cross-vendor comparison would be meaningless: one vendor being on 5 while
        // another is on 3 says nothing about either.
        expect(ids([
            'anthropic/claude-opus-5', 'anthropic/claude-opus-4.8',
            'openai/gpt-5.6-sol', 'openai/gpt-4o',
            'google/gemini-3-pro', 'google/gemini-2.5-pro',
        ])).toEqual(['anthropic/claude-opus-5', 'openai/gpt-5.6-sol', 'google/gemini-3-pro']);
    });

    test('a newly released family is current with no code change', () => {
        // The whole point: today's list plus one unknown future model, and the new one
        // wins on its version number alone.
        expect(ids(['gpt-5.6-sol', 'gpt-5.7-nova', 'gpt-5.5']))
            .toEqual(['gpt-5.7-nova']);
        expect(ids(['claude-opus-5', 'claude-quill-6']))
            .toEqual(['claude-quill-6']);
    });

    test('keeps the currently selected model even when it is old', () => {
        // Hiding it would let updateChatModelSelector() treat the saved setting as invalid
        // and switch the user to a different model — a display option must not do that.
        const kept = filterToCurrentGeneration(
            ['gpt-5.6-sol', 'gpt-4o', 'gpt-4.1'].map(m), 'gpt-4o');
        expect(kept.map(x => x.model)).toEqual(['gpt-5.6-sol', 'gpt-4o']);
    });

    test('returns everything rather than nothing when no id declares a version', () => {
        // An unfamiliar naming scheme must degrade to an over-long list, never an empty one.
        const odd = ['chat-latest', 'some-model', 'another'];
        expect(ids(odd)).toEqual(odd);
        expect(filterToCurrentGeneration([])).toEqual([]);
    });
});
