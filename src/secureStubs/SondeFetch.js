// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original fetches weather-balloon soundings, through the server's proxy for one archive
// and directly from a public archive for the other, and imports them as tracks. Here nothing
// is fetched: the station list is empty, no station is ever picked, the balloon import
// resolves to an empty result list (src/CustomManagerSetup.js reads "no soundings returned"
// from that), the dialog logs a warning, and the two raw fetchers reject.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:SondeFetch";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

const NOT_AVAILABLE = "Weather-balloon sounding import is not available in this build";

export async function fetchUWYOSounding() {
    throw new Error(NOT_AVAILABLE);
}

export async function fetchIGRA2Data() {
    throw new Error(NOT_AVAILABLE);
}

export async function pickIGRA2Sounding() {
    return null;
}

export async function loadStationList() {
    return [];
}

export function lookupStationPosition() {
    return null;
}

// Only reached after loadStationList() returns a non-empty list, so never in this build.
export function haversineKm() {
    return 0;
}

export async function pickStation() {
    return null;
}

export async function getNearbyWeatherBalloons() {
    return [];
}

export const getNearbySoundings = getNearbyWeatherBalloons;

export async function importSoundingDialog() {
    console.warn(NOT_AVAILABLE);
    return false;
}

export async function compareSondeTrajectory() {
    throw new Error(NOT_AVAILABLE);
}
