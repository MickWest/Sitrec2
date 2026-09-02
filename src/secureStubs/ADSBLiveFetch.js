// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original polls the server's live-traffic proxy for the aircraft currently around a
// point. Here the feed reports itself unavailable and every poll rejects, which the layer
// (src/traffic/CNodeADSBLiveTraffic.js) shows as its error status. No request is made.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:ADSBLiveFetch";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

// Same bounds as the original.
export const ADSB_LIVE_MIN_RADIUS_NM = 1;
export const ADSB_LIVE_MAX_RADIUS_NM = 250;

export function adsbLiveURL() {
    return null;
}

export function isADSBLiveAvailable() {
    return false;
}

export function normalizeAircraft() {
    return null;
}

export function normalizeResponse() {
    return {aircraft: [], nowSec: null, reportedTotal: 0};
}

export async function fetchLiveTraffic() {
    throw new Error("Live ADS-B traffic is not available in this build");
}
