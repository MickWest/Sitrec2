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

export async function getKey(provider) {
    if (!provider) return null;
    try {
        const stored = await indexedDBManager.getSetting(storageKey(provider));
        if (stored === null || stored === undefined) return null;
        return await deobfuscate(stored);
    } catch (e) {
        return null;
    }
}

export async function setKey(provider, key) {
    if (!provider) throw new Error('provider required');
    await indexedDBManager.setSetting(storageKey(provider), await obfuscate(key));
}

export async function deleteKey(provider) {
    if (!provider) return;
    await indexedDBManager.deleteSetting(storageKey(provider));
}

// Returns an array of provider names that currently have a non-empty stored key.
export async function getAllProviders() {
    try {
        const all = await indexedDBManager.getAllSettings();
        return Object.keys(all)
            .filter(k => k.startsWith(KEY_PREFIX) && all[k])
            .map(k => k.slice(KEY_PREFIX.length));
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
    return keyCache.get(provider) ?? null;
}

export function hasCachedKey(provider) {
    return getCachedKey(provider) !== null;
}
