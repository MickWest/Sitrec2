// BYOKKeyStore.js
// Local-only storage for user-provided LLM API keys (Bring Your Own Key).
//
// Keys live in IndexedDB under the "byok_<provider>" naming convention. They
// are deliberately kept OUT of Globals.settings so they never flow through
// sanitizeSettings(), saveSettingsToCookie(), or saveSettingsToServer() —
// i.e. they never touch the server or cookies.
//
// The server-side sanitizer in settings.php is a whitelist and already strips
// unknown fields, so even a bug that accidentally put a BYOK key into
// Globals.settings would be scrubbed before it could be persisted remotely.
// Using a separate key namespace here is defense-in-depth.

import { indexedDBManager } from './IndexedDBManager';

const KEY_PREFIX = 'byok_';

// ─── Obfuscation at rest ──────────────────────────────────────────────────────────────
//
// READ THIS BEFORE TRUSTING IT: this is obfuscation, NOT encryption in any meaningful
// security sense. The passphrase below is a constant compiled into the public JavaScript
// bundle, so anyone who wants the plaintext can read the passphrase out of the bundle and
// decrypt in seconds. It raises the effort from "read it straight out of the DevTools
// storage pane" to "know what you are doing", and nothing more.
//
// It is worth doing anyway, for the accident cases rather than the attacker cases:
//   - a screenshot or screen-share of the DevTools Application tab
//   - a browser-profile backup, sync blob, or forensic dump read casually
//   - a support request where someone pastes their IndexedDB contents
// In each of those a plaintext "sk-ant-..." is instantly recognisable and instantly
// abusable; an opaque blob is not.
//
// It does NOT protect against anything running on the page (a browser extension, or an
// XSS flaw), because that code can simply call getKey() and be handed the plaintext. The
// user-facing doc (docs/APIKeys.md) states this in the same terms — keep the two in step.
//
// AES-GCM via WebCrypto is used rather than a hand-rolled XOR purely because it is no more
// code, is constant-time, and produces a self-checking envelope: a corrupted or truncated
// value fails to decrypt loudly instead of yielding silent garbage that would then be sent
// to a provider as a "key".
const OBFUSCATION_PASSPHRASE = 'sitrec-byok-at-rest-obfuscation-v1-not-a-secret';
const OBFUSCATION_SALT = 'sitrec-byok-salt-v1';
const ENVELOPE_PREFIX = 'sitrec-obf-v1:';

let derivedKeyPromise = null;

function subtle() {
    return (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle)
        ? globalThis.crypto.subtle
        : null;
}

function toBase64(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

function fromBase64(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

async function getDerivedKey() {
    if (derivedKeyPromise) return derivedKeyPromise;
    const s = subtle();
    if (!s) return null;
    derivedKeyPromise = (async () => {
        const enc = new TextEncoder();
        const base = await s.importKey('raw', enc.encode(OBFUSCATION_PASSPHRASE), 'PBKDF2', false, ['deriveKey']);
        return s.deriveKey(
            // Iteration count is deliberately modest: the passphrase is public, so a high
            // count buys no security, and this runs on every key read at startup.
            {name: 'PBKDF2', salt: enc.encode(OBFUSCATION_SALT), iterations: 10000, hash: 'SHA-256'},
            base,
            {name: 'AES-GCM', length: 256},
            false,
            ['encrypt', 'decrypt']
        );
    })();
    return derivedKeyPromise;
}

// Values may be strings (an API key) or objects (Space-Track username+password), so the
// value is JSON-encoded before wrapping and parsed back on the way out.
export async function obfuscate(value) {
    const s = subtle();
    const key = await getDerivedKey();
    if (!s || !key) return value;              // no WebCrypto: store as-is rather than fail
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(value));
    const ct = new Uint8Array(await s.encrypt({name: 'AES-GCM', iv}, key, data));
    return ENVELOPE_PREFIX + toBase64(iv) + ':' + toBase64(ct);
}

export async function deobfuscate(stored) {
    // Anything not in the envelope format is a value written before obfuscation existed
    // (or written on a browser without WebCrypto). Pass it through unchanged so an
    // existing key keeps working; it is re-wrapped next time it is saved.
    if (typeof stored !== 'string' || !stored.startsWith(ENVELOPE_PREFIX)) return stored;
    const s = subtle();
    const key = await getDerivedKey();
    if (!s || !key) return null;
    try {
        const [ivB64, ctB64] = stored.slice(ENVELOPE_PREFIX.length).split(':');
        const plain = await s.decrypt(
            {name: 'AES-GCM', iv: fromBase64(ivB64)}, key, fromBase64(ctB64)
        );
        return JSON.parse(new TextDecoder().decode(plain));
    } catch (e) {
        // Corrupted or written with a different passphrase. Returning null is the safe
        // outcome: the user is told no key is set and can re-enter one, rather than a
        // mangled string being sent to a provider.
        console.warn('BYOK: stored credential could not be read; treating as unset.');
        return null;
    }
}

function storageKey(provider) {
    return KEY_PREFIX + provider;
}

// ─── Enable flag ───────────────────────────────────────────────────────────────────────
//
// A stored key can be KEPT but not USED — "run this session on Sitrec's quota, without
// making me paste my key again tomorrow". The gate lives here, in the one module every
// consumer already goes through, rather than in each consumer: getKey() and
// getCachedKey() simply report no key for a disabled provider, so the terrain code, the
// live feeds, the voice session and the model dropdown all honour it with no changes and
// no way to forget one.
//
// Only the DISABLED ids are stored, so absence means enabled and a provider added later
// is on by default. The storage key deliberately does not start with "byok_": that prefix
// is what getAllProviders() enumerates as stored credentials, and an entry there would be
// reported as a key that does not exist.
const DISABLED_KEY = 'sitrecByokDisabled';

let disabledSet = new Set();
let disabledPromise = null;

function loadDisabled() {
    if (!disabledPromise) {
        disabledPromise = (async () => {
            try {
                const stored = await indexedDBManager.getSetting(DISABLED_KEY);
                disabledSet = new Set(Array.isArray(stored) ? stored : []);
            } catch (e) {
                disabledSet = new Set();     // unreadable store means "nothing disabled"
            }
            return disabledSet;
        })();
    }
    return disabledPromise;
}

// Synchronous, for the same reason getCachedKey is: it is read on construction paths.
// Accurate once primeKeyCache() has run, which SettingsManager does at startup.
export function isProviderEnabled(provider) {
    return !disabledSet.has(provider);
}

export async function setProviderEnabled(provider, enabled) {
    if (!provider) return;
    await loadDisabled();
    if (enabled) disabledSet.delete(provider);
    else disabledSet.add(provider);
    try {
        await indexedDBManager.setSetting(DISABLED_KEY, [...disabledSet]);
    } catch (e) {
        console.warn('BYOK: could not persist the enable flag for ' + provider, e);
    }
}

// ─── Custom endpoints ──────────────────────────────────────────────────────────────────
//
// Where a provider lives, for the ones that are not at a fixed address: a self-hosted or
// on-premises server, or a local model runner. Stored next to the credential rather than in
// BYOKUsage's provider config for two reasons — an internal hostname deserves the same
// local-only treatment as the key it goes with, and BYOKUsage imports BYOKModelCatalog for
// prices, so a catalogue that had to read the endpoint from there would close an import
// cycle.
//
// Shape: {url, format}. `format` names the wire protocol the server speaks, not the vendor.
const ENDPOINTS_KEY = 'sitrecByokEndpoints';   // NOT "byok_" — that prefix means "a credential"

let endpoints = {};
let endpointsPromise = null;

function loadEndpoints() {
    if (!endpointsPromise) {
        endpointsPromise = (async () => {
            try {
                const stored = await indexedDBManager.getSetting(ENDPOINTS_KEY);
                endpoints = (stored && typeof stored === 'object') ? stored : {};
            } catch (e) {
                endpoints = {};
            }
            return endpoints;
        })();
    }
    return endpointsPromise;
}

// Synchronous, like getCachedKey and for the same reason: the transport needs the address
// on a path that cannot await. Accurate once primeKeyCache() has run.
export function getEndpoint(provider) {
    const e = endpoints[provider];
    return (e && typeof e.url === 'string' && e.url) ? e : null;
}

export async function setEndpoint(provider, endpoint) {
    if (!provider) return;
    await loadEndpoints();
    if (endpoint && endpoint.url) endpoints[provider] = {...endpoint};
    else delete endpoints[provider];
    try {
        await indexedDBManager.setSetting(ENDPOINTS_KEY, endpoints);
    } catch (e) {
        console.warn('BYOK: could not persist the endpoint for ' + provider, e);
    }
}

// Reads the stored credential IGNORING the enable flag. The key dialog is the only
// legitimate caller — it has to show "Set" for a key that is deliberately switched off.
// Everything that actually USES a credential must call getKey().
export async function getKeyRaw(provider) {
    if (!provider) return null;
    try {
        const stored = await indexedDBManager.getSetting(storageKey(provider));
        if (stored === null || stored === undefined) return null;
        return await deobfuscate(stored);
    } catch (e) {
        return null;
    }
}

export async function getKey(provider) {
    if (!provider) return null;
    await loadDisabled();
    if (disabledSet.has(provider)) return null;
    return getKeyRaw(provider);
}

export async function setKey(provider, key) {
    if (!provider) throw new Error('provider required');
    await indexedDBManager.setSetting(storageKey(provider), await obfuscate(key));
}

export async function deleteKey(provider) {
    if (!provider) return;
    await indexedDBManager.deleteSetting(storageKey(provider));
}

// Returns an array of provider names that currently have a non-empty stored key AND are
// enabled — i.e. the ones a caller would actually get a key for. Globals.hasByokKeys is
// derived from this, so switching every key off correctly takes the "(your key)" entries
// back out of the AI Model list.
export async function getAllProviders() {
    try {
        await loadDisabled();
        await loadEndpoints();
        const all = await indexedDBManager.getAllSettings();
        const withKeys = Object.keys(all)
            .filter(k => k.startsWith(KEY_PREFIX) && all[k])
            .map(k => k.slice(KEY_PREFIX.length));
        // A custom endpoint is configured by its ADDRESS, and usually has no key at all —
        // so a key-only sweep would report "no BYOK configured" for a working local model
        // and take its entries back out of the AI Model list.
        for (const id of Object.keys(endpoints)) {
            if (endpoints[id]?.url && !withKeys.includes(id)) withKeys.push(id);
        }
        return withKeys.filter(id => !disabledSet.has(id));
    } catch (e) {
        return [];
    }
}

export async function hasAnyKey() {
    const providers = await getAllProviders();
    return providers.length > 0;
}

// ─── Synchronous cache ────────────────────────────────────────────────────────────────
// Terrain and tile code needs a key at construction time, on a synchronous path, and
// IndexedDB is async. So the keys are primed once at startup and re-primed whenever the
// key dialog changes something.
//
// This cache lives here as a module-level Map rather than on Globals ON PURPOSE. Globals
// is serialisation-adjacent — Globals.settings is sanitised and POSTed to the server, and
// Globals is exactly the sort of object that gets dumped wholesale in a debug path. Keys
// stay in a module nobody has a reason to enumerate.
const keyCache = new Map();

export async function primeKeyCache() {
    keyCache.clear();
    // Re-read rather than trusting the in-memory set: this also runs as the key dialog's
    // resync, and re-reading is the cheap way to be right after any change.
    disabledPromise = null;
    endpointsPromise = null;
    await loadDisabled();
    await loadEndpoints();
    try {
        const all = await indexedDBManager.getAllSettings();
        for (const k of Object.keys(all)) {
            if (k.startsWith(KEY_PREFIX) && all[k]) {
                // Stored values are obfuscated; the cache holds the usable plaintext, since
                // its whole purpose is to answer synchronously on the tile-fetch path.
                const value = await deobfuscate(all[k]);
                if (value) keyCache.set(k.slice(KEY_PREFIX.length), value);
            }
        }
    } catch (e) {
        // An unreadable store means "no user keys", which falls back to Sitrec's own.
    }
    return keyCache.size;
}

// Synchronous read. Returns null when the user has supplied nothing for this provider, so
// callers can fall back to Sitrec's shared credential.
export function getCachedKey(provider) {
    if (!provider) return null;
    if (disabledSet.has(provider)) return null;
    return keyCache.get(provider) ?? null;
}

export function hasCachedKey(provider) {
    return getCachedKey(provider) !== null;
}

// "Is this provider usable?" — the question the AI Model dropdown actually wants answered.
//
// For everything hosted that means a key. For a custom endpoint it means an ADDRESS: a
// model runner on your own machine normally has no credential, so gating on a key would
// make the commonest case unreachable. The enable tick still applies to both.
export function isProviderConfigured(provider) {
    if (!provider) return false;
    if (!isProviderEnabled(provider)) return false;
    if (hasCachedKey(provider)) return true;
    return provider === 'custom' && !!getEndpoint(provider);
}
