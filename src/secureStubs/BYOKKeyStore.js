// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original stores the user's own provider keys and endpoints in IndexedDB and serves
// them to the code that calls those providers. Here nothing is stored and nothing is ever
// found: every key lookup is null, every provider is unconfigured and disabled, and
// primeKeyCache() resolves to a count of zero, which is what src/SettingsManager.js compares
// against.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:BYOKKeyStore";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

export async function obfuscate() {
    return null;
}

export async function deobfuscate() {
    return null;
}

export function isProviderEnabled() {
    return false;
}

export async function setProviderEnabled() {
}

export function getEndpoint() {
    return null;
}

export async function setEndpoint() {
}

export async function getKeyRaw() {
    return null;
}

export async function getKey() {
    return null;
}

export async function setKey() {
}

export async function deleteKey() {
}

export async function getAllProviders() {
    return [];
}

export async function hasAnyKey() {
    return false;
}

export async function primeKeyCache() {
    return 0;
}

export function getCachedKey() {
    return null;
}

export function hasCachedKey() {
    return false;
}

export function isProviderConfigured() {
    return false;
}
