// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original is the table of live data feeds (aircraft, ships, weather, and others) with
// each provider's address and parser. Here the table is empty, so src/CustomManagerSetup.js
// builds no feed menu items at all and the feed layer is never loaded.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:LiveFeedRegistry";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

export const LIVE_FEEDS = [];

export function getLiveFeed() {
    return null;
}
