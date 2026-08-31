// BYOKUsage.js
// Running usage and cost totals for the BYOK (Bring Your Own Key) path.
//
// When the user supplies their own API key, the provider bills them directly and Sitrec
// never sees the invoice — so the app is the only place that can tell them what a
// session cost. Totals accumulate locally and are broken down per model, because prices
// across the offered range differ by 5x and "I left Opus selected all afternoon" is the
// exact mistake this is here to surface.
//
// Cost is an ESTIMATE computed from published list prices. It cannot see promotional
// rates, negotiated discounts, or a price change made after this table was written, so
// it is a running order-of-magnitude figure, not a reconciliation of a bill.
//
// NOTE ON THE STORAGE KEY: this deliberately does NOT start with "byok_". That prefix is
// the key namespace BYOKKeyStore.getAllProviders() scans, so a "byok_usage" entry would
// be reported as a stored provider key and make hasAnyKey() true with no key present.

import {indexedDBManager} from './IndexedDBManager';
import {catalogPricesFor} from './BYOKModelCatalog';

const USAGE_KEY = 'aiUsageTotals';

// USD per million tokens, from the providers' published list prices.
//
// `promo` is a temporary rate with an end date. Hardcoding either rate on its own is
// wrong half the time — quoting the standard rate during a promotion overstates cost
// (Sonnet 5 by 50%), and quoting the promotional rate after it lapses understates it —
// so the rate in effect is chosen by date, and cost is banked at the time of use
// (see recordUsage) rather than re-derived later at whatever rate is current then.
const MODEL_PRICES = {
    'claude-opus-5': {input: 5, output: 25},
    'claude-sonnet-5': {
        input: 3, output: 15,
        promo: {input: 2, output: 10, untilUTC: Date.UTC(2026, 8, 1)},  // through 2026-08-31
    },
    'claude-haiku-4-5': {input: 1, output: 5},
    // OpenRouter model slugs. OpenRouter's response-provided usage.cost is preferred;
    // these are fallbacks for an upstream response that omits the exact charged cost.
    'openai/gpt-5-mini': {input: 0.25, output: 2},
    'openai/gpt-5-nano': {input: 0.05, output: 0.40},
    // The same two models called directly on the user's OpenAI key. Bare slugs, because
    // that is the name OpenAI's own API takes and the name banked in the usage record —
    // OpenAI returns no cost field, so these rates are the only figure available.
    'gpt-5-mini': {input: 0.25, output: 2},
    'gpt-5-nano': {input: 0.05, output: 0.40},
    // The voice model. Audio tokens are billed at a completely different rate from text
    // — 8x on input, 2.7x on output — and a voice session is overwhelmingly audio, so
    // folding them into the text counters would understate the bill by most of an order
    // of magnitude. They therefore get their own rates and their own counters (see
    // emptyUsage). `cachedInput` is an ABSOLUTE rate rather than a multiple of the input
    // rate: OpenAI charges the same $0.40/1M for a cached text token and a cached audio
    // token, which is 0.1x the text rate but 0.0125x the audio rate, so no single
    // multiplier can express it.
    'gpt-realtime-2': {
        input: 4, output: 24,
        audio: {input: 32, output: 64},
        cachedInput: 0.40,
    },
};

// The per-million rates in effect at a given moment (defaults to now).
//
// The table above wins where it has an entry: it carries the promotional-rate logic and is
// the provider's own published price. Everything else falls through to the live catalogue
// (OpenRouter's public price list, see BYOKModelCatalog) — without which every model
// outside the four hardcoded rows would report tokens and no cost at all, which is most of
// them now that the dropdown lists whatever the key exposes.
export function pricesFor(model, atMs = undefined) {
    const entry = MODEL_PRICES[model];
    if (!entry) {
        const listed = catalogPricesFor(model);
        if (!listed) return null;
        // No audio rates: the catalogue quotes text pricing, and the only audio model
        // Sitrec uses is the pinned voice one, which the table above covers.
        return {input: listed.input, output: listed.output, cachedInput: listed.cachedInput};
    }
    const at = atMs === undefined ? Date.now() : atMs;
    // A promotion only ever restates the TEXT rates, so the audio and cached-input rates
    // are carried through from the standard entry rather than being dropped — returning
    // an object without them would silently price a promoted voice model's audio at zero.
    if (entry.promo && at < entry.promo.untilUTC) {
        return {input: entry.promo.input, output: entry.promo.output,
            audio: entry.audio, cachedInput: entry.cachedInput};
    }
    return {input: entry.input, output: entry.output,
        audio: entry.audio, cachedInput: entry.cachedInput};
}

// Cached input bills at ~0.1x the input rate; a 5-minute cache write at ~1.25x.
// Both paths are used heavily here — CDirectLLMClient sets two cache breakpoints —
// so folding them in at the input rate would overstate cost substantially.
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

function cacheMultipliersFor(model) {
    // A catalogue-priced model states its own cache-write rate, so express it as the
    // multiple of the input rate that estimateCostUSD expects rather than guessing.
    if (!MODEL_PRICES[model]) {
        const listed = catalogPricesFor(model);
        if (listed && listed.cacheWriteRate !== undefined && listed.input > 0) {
            return {read: CACHE_READ_MULTIPLIER, write: listed.cacheWriteRate / listed.input};
        }
    }
    // OpenRouter can route OpenAI cached reads at model-dependent discounts. Exact cost
    // normally comes back from OpenRouter; use the conservative 0.5x fallback when it does
    // not. OpenAI cache writes carry no premium.
    if (model.startsWith('openai/')) return {read: 0.5, write: 1};
    // Called directly, there is no routing in between: OpenAI publishes cached input at
    // exactly 0.1x the input rate for the GPT-5 family, and charges nothing to write.
    if (model.startsWith('gpt-')) return {read: 0.1, write: 1};
    return {read: CACHE_READ_MULTIPLIER, write: CACHE_WRITE_MULTIPLIER};
}

// costUSD is part of the accumulated record, not just a display-time derivation: it is
// banked at the rate in effect when the tokens were actually spent, so a later price
// change (or a promotion lapsing) cannot retroactively rewrite what past turns cost.
// ─── Provider-level accounting (tile and data providers) ─────────────────────────────
//
// The AI accounting above is token-based and priced per model. Tile and data providers
// expose no per-request cost, so all we can observe is a request count. The maintainer's
// rule is "usage is spend where possible": we therefore turn counts into money using a
// rate the USER supplies, rather than shipping a guessed list price. Tile pricing varies
// by plan, region and free-tier allowance, so a hardcoded figure would be confidently
// wrong; with no rate set we show counts and no dollar figure.
//
// Neither key starts with "byok_" — that prefix is enumerated by BYOKKeyStore as stored
// credentials (see the note at the top of this file).
const PROVIDER_USAGE_KEY = 'sitrecProviderUsage';   // {providerId: {requests}}
const PROVIDER_CONFIG_KEY = 'sitrecProviderConfig'; // {providerId: {unitPricePer1000, limits}}

async function readStore(key) {
    try {
        const stored = await indexedDBManager.getSetting(key);
        return (stored && typeof stored === 'object') ? stored : {};
    } catch (e) {
        return {};
    }
}

async function writeStore(key, value) {
    try {
        await indexedDBManager.setSetting(key, value);
    } catch (e) {
        // Accounting is reporting, not behaviour — never let it break the thing being counted.
        console.warn(`Failed to persist ${key}:`, e);
    }
}

export async function getProviderUsage() {
    return readStore(PROVIDER_USAGE_KEY);
}

// Local date, not UTC: the user's "today" is the one they can reason about, and this
// counter exists for their benefit, not to reconcile with a provider's billing day.
function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// `amount` is whatever that provider is metered in — sessions for Google 3D, bytes for
// Cesium, requests for everything else. The running total is lifetime; dailyCount resets
// on the first record of a new day, which is what the daily caps are checked against.
export async function recordProviderUsage(providerId, amount = 1) {
    if (!providerId || !amount) return;
    const all = await getProviderUsage();
    const entry = all[providerId] || {total: 0, day: todayKey(), dailyCount: 0};
    const today = todayKey();
    if (entry.day !== today) {
        entry.day = today;
        entry.dailyCount = 0;
    }
    entry.total = (entry.total || 0) + amount;
    entry.dailyCount = (entry.dailyCount || 0) + amount;
    all[providerId] = entry;
    await writeStore(PROVIDER_USAGE_KEY, all);
    await refreshBlockedState(providerId);
}

// How much of today's allowance is already spent (0 when the stored day is stale).
export async function getDailyUsage(providerId) {
    const all = await getProviderUsage();
    const entry = all[providerId];
    if (!entry || entry.day !== todayKey()) return 0;
    return entry.dailyCount || 0;
}

// True when the user set a daily cap for this provider and today's usage has reached it.
// A null/absent limit means unlimited, which is the default whenever the user is spending
// their own money — Sitrec's tiered caps exist to protect its SHARED key, not the user's.
export async function isOverDailyLimit(providerId, limitName, scale = 1) {
    const limit = await getLimit(providerId, limitName);
    if (limit === null) return false;
    const used = await getDailyUsage(providerId);
    return used >= limit * scale;
}

// ─── Synchronous over-limit state ─────────────────────────────────────────────────────
// Enforcement has to happen on the fetch path, which is synchronous, and the limit lives
// in IndexedDB. So the async check above maintains this Set, and callers read it without
// awaiting. It is refreshed after every recorded unit and on demand (dialog close, load).
const blockedProviders = new Set();

export function isProviderBlocked(providerId) {
    return blockedProviders.has(providerId);
}

// Re-evaluate one provider's daily cap. Called after each recorded unit, so the block
// takes effect on the request AFTER the one that crosses the line — the caps are a budget
// guard, not a hard transactional limit, and overshooting by one session is acceptable
// where blocking a request mid-render is not.
export async function refreshBlockedState(providerId) {
    const {getProvider, LIMIT_DEFS} = await import('./BYOKProviders');
    const provider = getProvider(providerId);
    if (!provider || !provider.limits || provider.limits.length === 0) return;
    let blocked = false;
    for (const limitName of provider.limits) {
        const scale = LIMIT_DEFS[limitName]?.scale ?? 1;
        if (await isOverDailyLimit(providerId, limitName, scale)) {
            blocked = true;
            break;
        }
    }
    if (blocked) blockedProviders.add(providerId);
    else blockedProviders.delete(providerId);
}

export async function resetProviderUsage(providerId = null) {
    if (providerId === null) {
        await writeStore(PROVIDER_USAGE_KEY, {});
        return;
    }
    const all = await getProviderUsage();
    delete all[providerId];
    await writeStore(PROVIDER_USAGE_KEY, all);
}

export async function getProviderConfig() {
    return readStore(PROVIDER_CONFIG_KEY);
}

// Merge a patch into one provider's config: {unitPricePer1000, limits:{name:value|null}}.
export async function setProviderConfig(providerId, patch) {
    if (!providerId) return;
    const all = await getProviderConfig();
    const current = all[providerId] || {};
    const next = {...current, ...patch};
    if (patch && patch.limits) {
        next.limits = {...(current.limits || {}), ...patch.limits};
    }
    all[providerId] = next;
    await writeStore(PROVIDER_CONFIG_KEY, all);
}

// null means "unlimited" — the default whenever the user is spending their own money.
export async function getLimit(providerId, limitName) {
    const all = await getProviderConfig();
    const value = all[providerId]?.limits?.[limitName];
    return (typeof value === 'number' && isFinite(value) && value > 0) ? value : null;
}

// Estimated spend for a request-counting provider, or null when no rate is configured.
// `per` is how many metered units the user's rate covers — 1000 sessions, or one GB for a
// byte-metered provider. It comes from the provider registry, because a single hardcoded
// "per 1000" produced a nonsensical "per 1000 bytes" for Cesium.
//
// Reads usage.total: recordProviderUsage stores {total, day, dailyCount}. An earlier
// version read usage.requests, a field that store never writes, so every estimate came
// out as zero however the rate was set.
export function estimateProviderSpendUSD(usage, config, per = 1000) {
    const rate = config?.unitPricePer1000;
    if (typeof rate !== 'number' || !isFinite(rate) || rate <= 0) return null;
    if (!per || per <= 0) return null;
    return ((usage?.total || 0) / per) * rate;
}

// audioInputTokens / audioOutputTokens are counted separately from the text fields
// because they are priced separately (see MODEL_PRICES). addUsage iterates these keys, so
// a record stored before the audio fields existed simply reads them as 0 — no migration.
export function emptyUsage() {
    return {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        audioInputTokens: 0, audioOutputTokens: 0,
        requests: 0, costUSD: 0,
    };
}

export function addUsage(target, delta) {
    if (!delta) return target;
    for (const field of Object.keys(emptyUsage())) {
        target[field] = (target[field] || 0) + (delta[field] || 0);
    }
    return target;
}

// Estimated USD for one usage record on a given model. Returns null for a model with no
// price entry, so callers can show token counts without inventing a dollar figure.
export function estimateCostUSD(model, usage, atMs = undefined) {
    const price = pricesFor(model, atMs);
    if (!price || !usage) return null;
    const cache = cacheMultipliersFor(model);
    const perToken = 1e-6;
    // An explicit cachedInput rate wins over the multiplier: see the note in MODEL_PRICES
    // on why the realtime models' flat cached rate is not expressible as a multiple.
    const cachedReadRate = (price.cachedInput !== undefined)
        ? price.cachedInput
        : price.input * cache.read;
    // A model with no audio rates prices audio tokens at its text rates rather than at
    // zero. That case should not arise — only audio models report audio tokens — but a
    // missing rate must never make a real cost vanish from the running total.
    const audio = price.audio || {input: price.input, output: price.output};
    return (
        (usage.inputTokens || 0) * price.input * perToken +
        (usage.outputTokens || 0) * price.output * perToken +
        (usage.audioInputTokens || 0) * audio.input * perToken +
        (usage.audioOutputTokens || 0) * audio.output * perToken +
        (usage.cacheReadTokens || 0) * cachedReadRate * perToken +
        (usage.cacheWriteTokens || 0) * price.input * cache.write * perToken
    );
}

export async function getUsageByModel() {
    try {
        const stored = await indexedDBManager.getSetting(USAGE_KEY);
        return (stored && typeof stored === 'object') ? stored : {};
    } catch (e) {
        return {};
    }
}

export async function recordUsage(model, usage) {
    if (!model || !usage) return;
    const byModel = await getUsageByModel();
    // Bank the cost now, at today's rate, so the running total stays accurate across a
    // price change instead of being re-derived at whatever rate is current at display time.
    const exactCost = Number(usage.costUSD);
    const priced = {
        ...usage,
        costUSD: Number.isFinite(exactCost) && exactCost > 0
            ? exactCost
            : (estimateCostUSD(model, usage) || 0),
    };
    byModel[model] = addUsage(byModel[model] || emptyUsage(), priced);
    try {
        await indexedDBManager.setSetting(USAGE_KEY, byModel);
    } catch (e) {
        // Usage tracking is reporting, not behaviour — never let it break a chat turn.
        console.warn('Failed to record BYOK usage:', e);
    }
}

export async function resetUsage() {
    try {
        await indexedDBManager.deleteSetting(USAGE_KEY);
    } catch (e) {
        console.warn('Failed to reset BYOK usage:', e);
    }
}

export function formatTokens(n) {
    if (!n) return '0';
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'K';
    return (n / 1e6).toFixed(2) + 'M';
}

export function formatCostUSD(cost) {
    if (cost === null || cost === undefined) return null;
    if (cost > 0 && cost < 0.01) return '<$0.01';
    return '$' + cost.toFixed(2);
}

// One-line summary of a single turn, for the chat debug log.
export function formatTurnUsage(model, usage) {
    const exactCost = Number(usage?.costUSD);
    const cost = formatCostUSD(Number.isFinite(exactCost) && exactCost > 0
        ? exactCost
        : estimateCostUSD(model, usage));
    const parts = [
        `${formatTokens(usage.inputTokens)} in`,
        `${formatTokens(usage.outputTokens)} out`,
    ];
    // Named as audio rather than merged into the text counts: they cost several times as
    // much, so a user comparing "why was that turn expensive" needs to see the split.
    if (usage.audioInputTokens || usage.audioOutputTokens) {
        parts.push(`${formatTokens(usage.audioInputTokens)} audio in`);
        parts.push(`${formatTokens(usage.audioOutputTokens)} audio out`);
    }
    if (usage.cacheReadTokens) parts.push(`${formatTokens(usage.cacheReadTokens)} cached`);
    return `Usage (${model}): ${parts.join(', ')}${cost ? ` — approx ${cost}` : ''}`;
}

// Multi-line breakdown across all models, plus a grand total. Used by the Settings
// readout so the user can see which model actually spent the money.
// `match` selects which recorded models to report on: an array of id prefixes, or a
// predicate. The predicate form exists because the dropdown now lists whatever the key
// exposes, and a prefix can no longer identify a provider — an OpenAI key reaches o3 and
// chat-latest as well as gpt-*, and an OpenRouter key reaches 300-odd models across every
// vendor. Null reports everything.
export async function formatUsageReport(match = null) {
    const byModel = await getUsageByModel();
    const accept = typeof match === 'function'
        ? match
        : (Array.isArray(match) ? (model => match.some(prefix => model.startsWith(prefix))) : null);
    const models = Object.keys(byModel)
        .filter(model => !accept || accept(model))
        .sort();
    if (models.length === 0) return {lines: ['No usage recorded yet.'], totalCost: 0, totalRequests: 0};

    const lines = [];
    let totalCost = 0;
    let totalRequests = 0;
    let anyUnpriced = false;
    for (const model of models) {
        const usage = byModel[model];
        // Prefer the banked cost (priced when the tokens were spent). Fall back to
        // re-deriving for any record written before costUSD was tracked.
        const cost = (typeof usage.costUSD === 'number' && usage.costUSD > 0)
            ? usage.costUSD
            : estimateCostUSD(model, usage);
        if (cost === null) anyUnpriced = true; else totalCost += cost;
        totalRequests += usage.requests || 0;
        lines.push(
            `${model}: ${usage.requests || 0} requests, ` +
            `${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out` +
            ((usage.audioInputTokens || usage.audioOutputTokens)
                ? `, audio ${formatTokens(usage.audioInputTokens)} in / ${formatTokens(usage.audioOutputTokens)} out`
                : '') +
            (usage.cacheReadTokens ? ` (${formatTokens(usage.cacheReadTokens)} from cache)` : '') +
            (cost === null ? '' : ` — approx ${formatCostUSD(cost)}`)
        );
    }
    if (anyUnpriced) lines.push('(Some models have no price on file; those are excluded from the total.)');
    return {lines, totalCost, totalRequests};
}
