// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original asks a public IP-geolocation service for an approximate position. Both callers
// (src/index.js at startup, src/nodes/CNodePositionLLA.js on request) already treat null as
// "no location", so that is what this resolves to, with no request made.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:GeoLocation";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

export async function getApproximateLocationFromIP() {
    return null;
}
