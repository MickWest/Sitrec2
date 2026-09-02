// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original records menu clicks and posts them to the server. Here nothing is recorded and
// nothing is sent; src/index.js calls initUILogging() and ignores the result.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:UILogging";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

export function buildMenuPath() {
    return null;
}

export function flushUILog() {
}

export function initUILogging() {
}
