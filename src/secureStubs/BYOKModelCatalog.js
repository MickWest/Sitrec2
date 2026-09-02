// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original asks each model provider which models the user's key can reach, and reads a
// public price table. Here the catalog is permanently empty: no request is made, no models
// are listed, no prices are known, and the endpoint probe reports that it knows nothing
// (the shape src/nodes/CNodeVIewChat.js destructures).

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:BYOKModelCatalog";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

export const KIND_CHAT = 'chat';
export const KIND_VOICE = 'voice';

// Same value as the original: src/CustomSupport.js prints it in the voice-model dropdown's
// default label.
export const DEFAULT_VOICE_MODEL = 'gpt-realtime-2';

const EMPTY_CATALOG = Object.freeze({version: 0, fetchedAt: 0, byProvider: {}, prices: {}});

export async function primeModelCatalog() {
}

export const AI_KEY_PROVIDERS = [];

export function catalogPricesFor() {
    return null;
}

export async function probeEndpointResidency() {
    return {supported: false, resident: false};
}

export async function refreshModelCatalog() {
    return EMPTY_CATALOG;
}

export function getCatalogModels() {
    return null;
}

export function filterToCurrentGeneration(models) {
    return models;
}

export function hasCatalog() {
    return false;
}
