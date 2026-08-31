// BYOKModelCatalog.js
// What models can this user's own keys actually reach?
//
// The AI Model dropdown used to offer a hardcoded shortlist — three Claude models and two
// GPTs. That was wrong twice over: it hid models the user is paying for and already has
// access to (Fable, Sol), and it went stale the moment a provider shipped anything new,
// which is often. The list now comes from the provider's own /v1/models, so "any model
// this key enables" means exactly that, and a model released tomorrow appears with no
// Sitrec change at all.
//
// All three catalogue endpoints allow direct browser access (measured 2026-08-31):
//   api.anthropic.com/v1/models   ACAO *  (with the anthropic-dangerous-direct-browser-access header)
//   api.openai.com/v1/models      ACAO *
//   openrouter.ai/api/v1/models   ACAO *
//
// This module is deliberately unaware of the "byok-*" provider tokens used by the chat
// model setting: it deals only in key-provider ids ('anthropic' | 'openai' | 'openrouter').
// CDirectLLMClient maps them onto its own tokens. That keeps the import graph one-way —
// CDirectLLMClient and BYOKUsage both read this module, and it reads only BYOKKeyStore —
// where importing CDirectLLMClient here would close a cycle through BYOKUsage.

import {indexedDBManager} from './IndexedDBManager';
import {getEndpoint, getKey, isProviderEnabled} from './BYOKKeyStore';

const CATALOG_KEY = 'sitrecModelCatalog';   // NOT "byok_" — that prefix means "a credential"

// Bump whenever the SHAPE of a stored entry changes, so an existing cache is refetched
// instead of being read with the wrong assumptions. Without this the voice models were
// invisible for up to a day after the update that added them: the cached entries were
// written by a build that filtered the realtime family out entirely, and the freshness
// window below had no reason to think anything had changed.
//   1 — {id, label, created}
//   2 — adds `kind` ('chat' | 'voice')
const CATALOG_VERSION = 2;
// A day is short enough to pick up a new release promptly and long enough that the usual
// session costs nothing. Any key change refreshes immediately regardless (see the dialog's
// resync), so this only governs the passive case.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1000';
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

// Model families on an OpenAI key that cannot drive a typed, tool-using assistant. This is
// a DENYLIST on purpose. An allowlist is what produced the problem this module exists to
// fix: anything unrecognised gets excluded, so every new release is invisible until
// somebody edits a constant. Here, an unrecognised model is offered — and if it turns out
// not to work, the provider's own error says so, naming the model.
//
// 'realtime' is excluded because it is a different API entirely (WebRTC, see
// src/voice/), not because it is unsuitable; it is collected separately below and offered
// in the Voice Model dropdown instead.
const OPENAI_NON_CHAT = [
    'embedding', 'whisper', 'tts', 'transcribe', 'image', 'moderation', 'sora',
    'audio', 'realtime', '-instruct', 'davinci', 'babbage',
    // Chat-shaped, but the web-search and deep-research variants take their own fixed
    // tool set and reject a caller-supplied one, so the assistant cannot run on them.
    'search-preview', 'search-api', 'deep-research',
];

function isOpenAIChatModel(id) {
    const lower = String(id).toLowerCase();
    return !OPENAI_NON_CHAT.some(bad => lower.includes(bad));
}

// The spoken assistant's models: the realtime family, which serves /v1/realtime over
// WebRTC and cannot be called through chat completions at all.
//
// Two of them are realtime models that are not conversational assistants — the whisper one
// only transcribes and the translate one only translates — so neither can drive Sitrec.
function isOpenAIVoiceModel(id) {
    const lower = String(id).toLowerCase();
    if (!lower.includes('realtime')) return false;
    return !['whisper', 'translate', 'transcribe'].some(bad => lower.includes(bad));
}

// Chat and voice models come from one /v1/models call and are told apart by this tag.
// Entries cached before the tag existed have none, and default to 'chat' — which is what
// they were, since the voice family was filtered out entirely back then.
export const KIND_CHAT = 'chat';
export const KIND_VOICE = 'voice';

// What the spoken assistant uses unless the user picks otherwise.
//
// It lives here rather than in src/voice/CVoiceSession.js because that module is lazily
// imported — nothing pulls it in until the microphone is first pressed — and the Voice
// Model dropdown has to name the default at startup. Importing it from there would drag
// the whole WebRTC chunk into the main bundle and undo that split.
//
// gpt-realtime-2 specifically, and not simply the newest realtime model, because it is the
// one with a verified price in BYOKUsage's table: a user who never opens the dropdown gets
// a working cost estimate. Anything else they choose deliberately may report tokens
// without a dollar figure, which the usage report states plainly.
export const DEFAULT_VOICE_MODEL = 'gpt-realtime-2';

// The model-list address for a user-named server. Deliberately a small local copy of the
// rule in CDirectLLMClient.resolveEndpoint rather than an import: this module is read by
// BYOKUsage for prices, so importing CDirectLLMClient here would close a cycle.
function resolveEndpointURLs(rawURL, format) {
    const url = String(rawURL || '').trim().replace(/\/+$/, '');
    if (!url) return null;
    const chatPath = format === 'anthropic' ? '/messages' : '/chat/completions';
    const base = url.endsWith(chatPath) ? url.slice(0, -chatPath.length) : url;
    return {modelsURL: `${base}/models`, base};
}

// ─── In-memory state ──────────────────────────────────────────────────────────────────
// Read synchronously by getCatalogModels() and catalogPricesFor(), both of which sit on
// paths (dropdown rebuild, per-turn usage pricing) that cannot await.
let catalog = {version: CATALOG_VERSION, fetchedAt: 0, byProvider: {}, prices: {}};
let primed = null;

export async function primeModelCatalog() {
    if (!primed) {
        primed = (async () => {
            try {
                const stored = await indexedDBManager.getSetting(CATALOG_KEY);
                if (stored && typeof stored === 'object' && stored.byProvider) {
                    // A catalogue from an older shape keeps its PRICES — those are just a
                    // lookup table and did not change — but its model lists are discarded
                    // and refetched, since what was filtered out of them has changed.
                    catalog = stored.version === CATALOG_VERSION
                        ? stored
                        : {version: CATALOG_VERSION, fetchedAt: 0, byProvider: {},
                           prices: stored.prices || {}};
                }
            } catch (e) {
                // An unreadable catalogue just means "fall back to the built-in list".
            }
            return catalog;
        })();
    }
    return primed;
}

async function persist() {
    try {
        await indexedDBManager.setSetting(CATALOG_KEY, catalog);
    } catch (e) {
        console.warn('BYOK: could not persist the model catalogue:', e);
    }
}

// ─── Fetching ─────────────────────────────────────────────────────────────────────────

async function fetchAnthropicModels(apiKey) {
    const res = await fetch(ANTHROPIC_MODELS_URL, {
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            // Same header the chat call needs; Anthropic rejects a browser origin without it.
            'anthropic-dangerous-direct-browser-access': 'true',
        },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    // Every model Anthropic lists is a chat model that takes tools, so nothing is filtered.
    return (data.data || []).map(m => ({
        id: m.id,
        label: m.display_name || m.id,
        created: Date.parse(m.created_at) || 0,
    }));
}

async function fetchOpenAIModels(apiKey) {
    const res = await fetch(OPENAI_MODELS_URL, {headers: {Authorization: `Bearer ${apiKey}`}});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    return (data.data || [])
        .filter(m => isOpenAIChatModel(m.id) || isOpenAIVoiceModel(m.id))
        // OpenAI publishes no display name, so the id is the label. It is also what the
        // user will see quoted back in any error, which makes it the more useful string.
        .map(m => ({
            id: m.id, label: m.id, created: (m.created || 0) * 1000,
            kind: isOpenAIVoiceModel(m.id) ? KIND_VOICE : KIND_CHAT,
        }));
}

async function fetchOpenRouterModels(apiKey) {
    const res = await fetch(OPENROUTER_MODELS_URL, {
        headers: apiKey ? {Authorization: `Bearer ${apiKey}`} : {},
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    return (data.data || [])
        // OpenRouter states tool support per model, so here the filter is a fact rather
        // than a guess: a model that cannot take a tool definition cannot drive Sitrec.
        .filter(m => (m.supported_parameters || []).includes('tools'))
        .map(m => ({id: m.id, label: m.name || m.id, created: (m.created || 0) * 1000}));
}

// A server the user named. Both wire formats answer GET <base>/models in OpenAI's shape —
// Ollama, LM Studio, llama.cpp, vLLM and LiteLLM all do — so one fetcher covers both.
//
// Nothing is filtered. The chat/voice denylists exist to keep OpenAI's hundred-odd
// special-purpose models out of the list; a server someone stood up themselves serves what
// they chose to put on it, and second-guessing that would be the stale-table mistake again.
async function fetchCustomModels(apiKey) {
    const endpoint = getEndpoint('custom');
    if (!endpoint?.url) return [];
    const resolved = resolveEndpointURLs(endpoint.url, endpoint.format);
    if (!resolved) return [];
    const headers = {};
    if (apiKey) {
        // Send BOTH shapes. The endpoint's format tells us which chat protocol it speaks,
        // but its model list is OpenAI-shaped either way and gateways differ over which
        // header guards it; an unexpected one is ignored.
        headers['Authorization'] = `Bearer ${apiKey}`;
        headers['x-api-key'] = apiKey;
    }
    const res = await fetch(resolved.modelsURL, {headers});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    // Ollama's native /api/tags uses {models:[{name}]}; accept it too, since a user may
    // well paste the address without the /v1.
    const list = Array.isArray(data.data) ? data.data
        : (Array.isArray(data.models) ? data.models : []);
    return list
        .map(m => ({
            id: m.id ?? m.name,
            label: m.id ?? m.name,
            created: (m.created || 0) * 1000,
            kind: KIND_CHAT,
        }))
        .filter(m => typeof m.id === 'string' && m.id.length > 0);
}

const FETCHERS = {
    anthropic: fetchAnthropicModels,
    openai: fetchOpenAIModels,
    openrouter: fetchOpenRouterModels,
    custom: fetchCustomModels,
};

export const AI_KEY_PROVIDERS = Object.keys(FETCHERS);

// ─── Prices for models nobody hardcoded ───────────────────────────────────────────────
//
// Neither Anthropic's nor OpenAI's /v1/models returns a price, so a dynamic list would
// otherwise mean "no cost estimate for anything but the four models in BYOKUsage's table".
// OpenRouter publishes a per-token price for the same upstream models on a PUBLIC,
// unauthenticated endpoint, so it doubles as a price catalogue.
//
// Two honest caveats, both already handled by the display code: it is OpenRouter's price
// for that model, normally list price but not guaranteed to be what the provider charges
// you directly; and coverage is not complete (the -codex and -chat-latest variants are
// absent). A model with no price on file reports tokens and no dollar figure rather than a
// made-up one, and formatUsageReport says so.
//
// The id forms differ and have to be reconciled: Anthropic ships "claude-opus-4-8" and
// dated snapshots like "claude-haiku-4-5-20251001"; OpenRouter calls both
// "anthropic/claude-opus-4.8" and "anthropic/claude-haiku-4.5". Normalising maps all ten
// Anthropic models and eleven of thirteen sampled OpenAI ones.
function normalizeModelId(id) {
    return String(id)
        .replace(/-\d{8}$/, '')                    // claude-haiku-4-5-20251001
        .replace(/-\d{4}-\d{2}-\d{2}$/, '')        // gpt-5.4-2026-03-05
        .replace(/-(\d+)-(\d+)$/, '-$1.$2');       // claude-opus-4-8 -> claude-opus-4.8
}

// Candidate OpenRouter ids for a bare provider model id, most specific first.
function catalogKeysFor(model) {
    if (model.includes('/')) return [model];       // already an OpenRouter slug
    const bare = normalizeModelId(model);
    const vendor = model.startsWith('claude') ? 'anthropic' : 'openai';
    return [`${vendor}/${model}`, `${vendor}/${bare}`];
}

// USD per MILLION tokens, matching the units of BYOKUsage's MODEL_PRICES. OpenRouter
// quotes per single token as decimal strings.
export function catalogPricesFor(model) {
    if (!model) return null;
    for (const key of catalogKeysFor(model)) {
        const p = catalog.prices?.[key];
        if (!p) continue;
        const perMillion = v => {
            const n = Number(v);
            return Number.isFinite(n) ? n * 1e6 : undefined;
        };
        const input = perMillion(p.prompt);
        const output = perMillion(p.completion);
        if (input === undefined || output === undefined) continue;
        return {
            input,
            output,
            cachedInput: perMillion(p.input_cache_read),
            cacheWriteRate: perMillion(p.input_cache_write),
        };
    }
    return null;
}

// Is this model already loaded on a user-named server, and so able to answer quickly?
//
// A local model that is not resident pays twice before it says a word: loading ~20 GB of
// weights, then processing the WHOLE prompt. Sitrec sends about 18,000 tokens (the system
// prompt plus ~105 tool definitions), and a 27B model prefills at roughly 100 tokens a
// second, so a cold "Hello" takes about three minutes and a warm one takes three seconds.
// Measured on an M-series Mac, 2026-08-31. The difference is entirely invisible from the
// client — same request, same 200 response — which is why it is worth asking first.
//
// Ollama's /api/ps reports what is loaded. It is a native endpoint, not part of the
// OpenAI-compatible surface, so a server that has never heard of it 404s or refuses; that
// is reported as `supported: false` and the caller must then say NOTHING rather than
// invent a warning it cannot stand behind.
export async function probeEndpointResidency(model) {
    const endpoint = getEndpoint('custom');
    if (!endpoint?.url || !model) return {supported: false, resident: false};
    const resolved = resolveEndpointURLs(endpoint.url, endpoint.format);
    if (!resolved) return {supported: false, resident: false};
    // /api/ps is a sibling of /api/tags, one level above the OpenAI-compatible /v1 base.
    const psURL = resolved.base.replace(/\/(v1|api)$/, '') + '/api/ps';
    try {
        const res = await fetch(psURL);
        if (!res.ok) return {supported: false, resident: false};
        const data = await res.json();
        if (!Array.isArray(data?.models)) return {supported: false, resident: false};
        const loaded = data.models.some(m => m.model === model || m.name === model);
        return {supported: true, resident: loaded};
    } catch (e) {
        // Not reachable, or not an Ollama-shaped server. Either way we know nothing.
        return {supported: false, resident: false};
    }
}

// ─── Refresh ──────────────────────────────────────────────────────────────────────────

// Fetches the catalogue for every AI provider whose key is set AND enabled. A provider
// that fails keeps whatever it had: a rate limit or an expired key must not empty the
// dropdown the user is looking at.
export async function refreshModelCatalog({force = false} = {}) {
    await primeModelCatalog();
    if (!force && Date.now() - (catalog.fetchedAt || 0) < MAX_AGE_MS
        && Object.keys(catalog.byProvider).length > 0) {
        return catalog;
    }

    const next = {...catalog.byProvider};
    let anySucceeded = false;
    await Promise.all(AI_KEY_PROVIDERS.map(async keyProvider => {
        // getKey() honours the per-provider enable flag, so a key switched off in the
        // dialog stops contributing models — the same rule the rest of the app follows.
        const apiKey = await getKey(keyProvider);
        // A custom endpoint is configured by its ADDRESS; its key is optional, so absence
        // of one is not absence of a provider.
        const configured = keyProvider === 'custom'
            ? (isProviderEnabled('custom') && !!getEndpoint('custom'))
            : !!apiKey;
        if (!configured) { delete next[keyProvider]; return; }
        try {
            const models = await FETCHERS[keyProvider](apiKey);
            if (models.length > 0) { next[keyProvider] = models; anySucceeded = true; }
        } catch (e) {
            console.warn(`BYOK: could not list ${keyProvider} models:`, e?.message || e);
        }
    }));

    // The price table is public, so it is worth having even for a user with only an
    // Anthropic key — it is what puts a dollar figure on Claude models the built-in table
    // has never heard of. No key is sent.
    let prices = catalog.prices;
    try {
        const res = await fetch(OPENROUTER_MODELS_URL);
        if (res.ok) {
            const data = await res.json();
            prices = {};
            for (const m of data.data || []) if (m.pricing) prices[m.id] = m.pricing;
        }
    } catch (e) {
        // Keep the previous table; an unpriced model degrades to "tokens, no dollars".
    }

    catalog = {
        version: CATALOG_VERSION,
        // Only stamp a successful sweep, so a failed one is retried rather than cached.
        fetchedAt: anySucceeded ? Date.now() : (catalog.fetchedAt || 0),
        byProvider: next,
        prices,
    };
    await persist();
    return catalog;
}

// Newest first, so a just-released model is the first thing in the list rather than buried
// among a decade of dated snapshots.
export function getCatalogModels(keyProvider, kind = KIND_CHAT) {
    const models = catalog.byProvider?.[keyProvider];
    if (!Array.isArray(models) || models.length === 0) return null;
    const wanted = models.filter(m => (m.kind ?? KIND_CHAT) === kind);
    if (wanted.length === 0) return null;
    return wanted.sort((a, b) => (b.created || 0) - (a.created || 0));
}

// ─── Current generation ───────────────────────────────────────────────────────────────
//
// Listing everything the key reaches is right, but it is a long list: an OpenAI key
// currently offers seventy models going back to gpt-3.5-turbo, and picking from it means
// scrolling past a decade of superseded releases to reach the one you want. So by default
// only the newest generation of each vendor is offered, and "Enable old AI models" in
// Settings brings the rest back.
//
// The generation is DERIVED from the ids rather than listed anywhere: whatever the highest
// version number a vendor currently ships is, that is the current generation. A new family
// is therefore current the day it appears, with no constant to update — the same reason
// the model list itself is fetched rather than hardcoded.

// The version a model id declares, or null when it declares none.
//
// Two shapes cover every id seen, and they need different rules:
//   the version FOLLOWS the family     gpt-5.6-sol, gpt-5-mini, gpt-4o    -> 5.6, 5, 4
//   the version TRAILS the whole id    claude-opus-5, claude-haiku-4.5    -> 5, 4.5
// An id with neither (o3, o4-mini, chat-latest, mistralai/mistral-nemo) has no declared
// generation and counts as old — which is the right answer for all of them today.
function generationOf(id) {
    const bare = normalizeModelId(String(id).split('/').pop());
    const leading = /^[a-z]+-(\d+(?:\.\d+)?)/.exec(bare);
    if (leading) return Number(leading[1]);
    const trailing = /-(\d+(?:\.\d+)?)$/.exec(bare);
    return trailing ? Number(trailing[1]) : null;
}

// Vendors are compared separately: an OpenRouter key spans many of them, and Anthropic
// being on 5 while somebody else is on 3 says nothing about either.
function vendorOf(id) {
    const slash = String(id).indexOf('/');
    return slash > 0 ? id.slice(0, slash) : '';
}

// `alwaysKeep` is the model the user currently has selected. Hiding it would let
// updateChatModelSelector() treat the saved setting as invalid and silently switch them to
// something else — turning a display preference into a change of which model answers.
export function filterToCurrentGeneration(models, alwaysKeep = null) {
    if (!Array.isArray(models) || models.length === 0) return models;

    const newest = new Map();
    for (const m of models) {
        const gen = generationOf(m.model ?? m.id);
        if (gen === null) continue;
        const vendor = vendorOf(m.model ?? m.id);
        if (!(newest.get(vendor) >= gen)) newest.set(vendor, gen);
    }

    const kept = models.filter(m => {
        const id = m.model ?? m.id;
        if (alwaysKeep && id === alwaysKeep) return true;
        const gen = generationOf(id);
        return gen !== null && gen === newest.get(vendorOf(id));
    });

    // Never hand back nothing. If an unfamiliar naming scheme defeats the rule entirely,
    // an over-long list is a far better failure than an empty one.
    return kept.length > 0 ? kept : models;
}

export function hasCatalog() {
    return Object.keys(catalog.byProvider || {}).length > 0;
}
