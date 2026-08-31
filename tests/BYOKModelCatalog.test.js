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
    // A custom endpoint is configured by its ADDRESS rather than a key, so the catalogue
    // asks about both.
    getEndpoint: jest.fn(() => null),
    isProviderEnabled: jest.fn(() => true),
}));

import {indexedDBManager} from '../src/IndexedDBManager';
import {getEndpoint, getKey, isProviderEnabled} from '../src/BYOKKeyStore';
import {
    KIND_VOICE, catalogPricesFor, filterToCurrentGeneration, getCatalogModels,
    primeModelCatalog, probeEndpointResidency, refreshModelCatalog,
} from '../src/BYOKModelCatalog';

beforeEach(() => {
    indexedDBManager._reset();
    jest.resetAllMocks();
    // resetAllMocks clears implementations, not just calls, so the defaults are restored
    // here rather than at declaration.
    getKey.mockImplementation(async () => null);
    getEndpoint.mockImplementation(() => null);
    isProviderEnabled.mockImplementation(() => true);
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

// The spoken assistant's models come from the same /v1/models call as the typed ones and
// are told apart by `kind`. They must not leak into the AI Model list — a realtime model
// selected for typed chat fails with an error the user cannot act on.
describe('voice models', () => {
    const REALTIME = [
        'gpt-realtime-2.1', 'gpt-realtime-2.1-mini', 'gpt-realtime-2', 'gpt-realtime',
        // Realtime, but not conversational assistants: one only transcribes, one only
        // translates. Neither can drive Sitrec.
        'gpt-realtime-whisper', 'gpt-realtime-translate',
    ];

    beforeEach(() => {
        getKey.mockImplementation(async p => (p === 'openai' ? 'sk-test' : null));
    });

    test('separates the realtime family from the chat models', async () => {
        mockCatalogFetches({openai: [...REALTIME, 'gpt-5.6-sol', 'gpt-4o']});
        await refreshModelCatalog({force: true});

        const chat = getCatalogModels('openai').map(m => m.id);
        const voice = getCatalogModels('openai', KIND_VOICE).map(m => m.id);

        expect(chat).toEqual(expect.arrayContaining(['gpt-5.6-sol', 'gpt-4o']));
        expect(chat.some(id => id.includes('realtime'))).toBe(false);

        expect(voice).toEqual(expect.arrayContaining(
            ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini', 'gpt-realtime-2', 'gpt-realtime']));
        expect(voice).not.toContain('gpt-realtime-whisper');
        expect(voice).not.toContain('gpt-realtime-translate');
    });

    test('a key with no realtime models reports none rather than an empty list', async () => {
        mockCatalogFetches({openai: ['gpt-5.6-sol']});
        await refreshModelCatalog({force: true});
        expect(getCatalogModels('openai', KIND_VOICE)).toBeNull();
    });

    // Regression guard. The voice models were invisible for up to a day after the update
    // that added them: the cached entries had been written by a build that filtered the
    // realtime family out entirely, and the freshness window had no reason to refetch.
    //
    // The module registry is reset because the stored catalogue is read ONCE per session
    // (primeModelCatalog memoises, which is what makes it cheap on the startup path), so
    // the version check only runs on that first read — exactly as it does on a page load.
    test('a cache from an older shape is discarded, keeping only its prices', async () => {
        jest.resetModules();
        const {indexedDBManager: db} = require('../src/IndexedDBManager');
        const {getKey: mockedGetKey} = require('../src/BYOKKeyStore');
        const catalog = require('../src/BYOKModelCatalog');

        mockedGetKey.mockImplementation(async p => (p === 'openai' ? 'sk-test' : null));
        await db.setSetting('sitrecModelCatalog', {
            version: 1,
            fetchedAt: Date.now(),                      // fresh, so only the version saves us
            byProvider: {openai: [{id: 'gpt-4o', label: 'gpt-4o', created: 1}]},
            prices: {'openai/gpt-4o': {prompt: '0.0000025', completion: '0.00001'}},
        });
        // The price fetch FAILS here, so this also covers the carry-over: prices are a
        // plain lookup table whose shape did not change, and a stale-version discard must
        // not throw them away along with the model lists.
        global.fetch = jest.fn(async (url) => {
            if (url.includes('openrouter.ai')) throw new Error('price list unavailable');
            return {
                ok: true, status: 200,
                json: async () => ({data: ['gpt-5.6-sol', 'gpt-realtime-2']
                    .map((id, i) => ({id, created: 1000 + i}))}),
            };
        });

        // Not forced: the stale-version check must trigger the refetch on its own.
        await catalog.refreshModelCatalog();

        expect(catalog.getCatalogModels('openai', catalog.KIND_VOICE).map(m => m.id))
            .toEqual(['gpt-realtime-2']);
        expect(catalog.getCatalogModels('openai').map(m => m.id)).toEqual(['gpt-5.6-sol']);
        expect(catalog.catalogPricesFor('gpt-4o')).toMatchObject({input: 2.5, output: 10});
    });
});

// A server the user named. Unlike every hosted provider it is configured by its ADDRESS,
// and its key is optional — so "no key" must not read as "no provider".
describe('custom endpoint models', () => {
    test('lists models from the endpoint even with no key stored', async () => {
        getKey.mockImplementation(async () => null);                       // no credential
        getEndpoint.mockImplementation(p => (p === 'custom'
            ? {url: 'http://127.0.0.1:11434/v1', format: 'openai'} : null));
        global.fetch = jest.fn(async (url) => ({
            ok: true, status: 200,
            json: async () => (url.includes('11434')
                ? {data: [{id: 'llama3.2:3b'}, {id: 'qwen3-coder:30b'}]}
                : {data: []}),
        }));

        await refreshModelCatalog({force: true});

        expect(getCatalogModels('custom').map(m => m.id))
            .toEqual(expect.arrayContaining(['llama3.2:3b', 'qwen3-coder:30b']));
        expect(fetch.mock.calls.some(([u]) => u === 'http://127.0.0.1:11434/v1/models')).toBe(true);
    });

    test('accepts Ollama\'s native {models:[{name}]} shape too', async () => {
        // A user is as likely to paste the bare host as the /v1 base, and the native list
        // is what answers there.
        getEndpoint.mockImplementation(p => (p === 'custom'
            ? {url: 'http://127.0.0.1:11434/api', format: 'openai'} : null));
        global.fetch = jest.fn(async (url) => ({
            ok: true, status: 200,
            json: async () => (url.includes('11434')
                ? {models: [{name: 'mistral:7b'}]} : {data: []}),
        }));

        await refreshModelCatalog({force: true});
        expect(getCatalogModels('custom').map(m => m.id)).toEqual(['mistral:7b']);
    });

    test('contributes nothing when no address is set', async () => {
        getEndpoint.mockImplementation(() => null);
        global.fetch = jest.fn(async () => ({ok: true, status: 200, json: async () => ({data: []})}));
        await refreshModelCatalog({force: true});
        expect(getCatalogModels('custom')).toBeNull();
    });

    test('contributes nothing while switched off', async () => {
        getEndpoint.mockImplementation(p => (p === 'custom'
            ? {url: 'http://127.0.0.1:11434/v1', format: 'openai'} : null));
        isProviderEnabled.mockImplementation(p => p !== 'custom');
        global.fetch = jest.fn(async () => ({ok: true, status: 200,
            json: async () => ({data: [{id: 'llama3.2:3b'}]})}));

        await refreshModelCatalog({force: true});
        expect(getCatalogModels('custom')).toBeNull();
    });
});

// Is the model already loaded on a user-named server?
//
// This decides whether the user is warned that a reply may take minutes rather than
// seconds. Measured difference on a 27B local model: 199s cold, 3s warm — same prompt,
// same machine — and nothing in the request itself distinguishes the two. The rule that
// matters most here is the NEGATIVE one: a server that cannot answer the question must
// produce no warning at all, because a warning we cannot stand behind is worse than none.
describe('endpoint model residency', () => {
    const ollamaPs = (loaded) => jest.fn(async (url) => {
        if (!url.endsWith('/api/ps')) return {ok: false, status: 404, json: async () => ({})};
        return {ok: true, status: 200, json: async () => ({models: loaded.map(m => ({model: m, name: m}))})};
    });

    beforeEach(() => {
        getEndpoint.mockImplementation(p => (p === 'custom'
            ? {url: 'http://127.0.0.1:11434/v1', format: 'openai'} : null));
    });

    test('reports a loaded model as resident', async () => {
        global.fetch = ollamaPs(['qwen3.8:27b-mlx', 'llama3.2:latest']);
        await expect(probeEndpointResidency('qwen3.8:27b-mlx'))
            .resolves.toEqual({supported: true, resident: true});
        // /api/ps is a sibling of /api/tags, one level ABOVE the OpenAI-compatible /v1 base.
        expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/ps');
    });

    test('reports an unloaded model as not resident — the case that warns', async () => {
        global.fetch = ollamaPs(['some-other-model']);
        await expect(probeEndpointResidency('qwen3.8:27b-mlx'))
            .resolves.toEqual({supported: true, resident: false});
    });

    test('nothing loaded at all is still an answer', async () => {
        global.fetch = ollamaPs([]);
        await expect(probeEndpointResidency('qwen3.8:27b-mlx'))
            .resolves.toEqual({supported: true, resident: false});
    });

    // The negative rule, four ways. Each must yield supported:false so the caller stays
    // silent rather than guessing.
    test('a server without /api/ps is reported as unsupported, never as cold', async () => {
        global.fetch = jest.fn(async () => ({ok: false, status: 404, json: async () => ({})}));
        await expect(probeEndpointResidency('m')).resolves.toEqual({supported: false, resident: false});
    });

    test('a server that answers /api/ps with something else is unsupported', async () => {
        // 200, but not Ollama's shape — do not read a warning into it.
        global.fetch = jest.fn(async () => ({ok: true, status: 200, json: async () => ({hello: 'world'})}));
        await expect(probeEndpointResidency('m')).resolves.toEqual({supported: false, resident: false});
    });

    test('an unreachable server is unsupported, not cold', async () => {
        global.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); });
        await expect(probeEndpointResidency('m')).resolves.toEqual({supported: false, resident: false});
    });

    test('no endpoint or no model asks nothing at all', async () => {
        global.fetch = jest.fn();
        getEndpoint.mockImplementation(() => null);
        await expect(probeEndpointResidency('m')).resolves.toEqual({supported: false, resident: false});

        getEndpoint.mockImplementation(() => ({url: 'http://127.0.0.1:11434/v1', format: 'openai'}));
        await expect(probeEndpointResidency('')).resolves.toEqual({supported: false, resident: false});
        expect(fetch).not.toHaveBeenCalled();
    });

    test('derives /api/ps from a bare host and from an /api base too', async () => {
        for (const [base, expected] of [
            ['http://127.0.0.1:11434', 'http://127.0.0.1:11434/api/ps'],
            ['http://127.0.0.1:11434/api', 'http://127.0.0.1:11434/api/ps'],
            ['https://llm.internal.example/v1', 'https://llm.internal.example/api/ps'],
        ]) {
            global.fetch = ollamaPs(['m']);
            getEndpoint.mockImplementation(() => ({url: base, format: 'openai'}));
            await probeEndpointResidency('m');
            expect(fetch.mock.calls[0][0]).toBe(expected);
        }
    });
});
