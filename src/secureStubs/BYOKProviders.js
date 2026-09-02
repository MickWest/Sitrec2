// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original is the table of providers a user can supply their own key for, with the
// sign-up address of each. Here the table is empty: no provider is offered, looked up, or
// grouped, and there are no limit definitions. src/BYOKUsage.js reads getProvider() and
// returns early on null.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:BYOKProviders";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

export const PROVIDER_CATEGORIES = {};

export const BYOK_PROVIDERS = [];

export const LIMIT_DEFS = {};

export function getProvider() {
    return null;
}

export function visibleProviders() {
    return [];
}

export function providersByCategory() {
    return {};
}
