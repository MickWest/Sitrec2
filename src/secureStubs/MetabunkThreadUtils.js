// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original recognizes a forum-thread address dropped onto the page and fetches the
// thread to find the video it links to. Here no address is recognized, so the resolver in
// src/DragDropHandler.js is never reached; if called anyway it resolves to null.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:MetabunkThreadUtils";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

export function isMetabunkThreadURL() {
    return false;
}

export function extractMetabunkThreadTitle() {
    return null;
}

export function extractMetabunkLinkedURLs() {
    return [];
}

export async function resolveMetabunkThreadVideoURL() {
    return null;
}
