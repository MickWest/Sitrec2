// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original fetches one aircraft's recent positions from a public flight-tracking
// aggregator, from a dialog or from a click on a live marker. Here nothing is fetched: the
// dialog logs a warning and both import functions resolve to false, the value the callers
// (src/CustomManagerSetup.js, src/nodes/CNodeView3DMouse.js) already treat as "nothing was
// imported".

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:ADSBTraceFetch";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

export function adsbLolTraceURL() {
    return null;
}

export function normalizeIcaoHex() {
    return "";
}

export function isValidIcaoHex() {
    return false;
}

export async function importADSBTraceDialog() {
    console.warn("ADS-B track import is not available in this build");
    return false;
}

export async function importADSBTraceByHex() {
    return false;
}
