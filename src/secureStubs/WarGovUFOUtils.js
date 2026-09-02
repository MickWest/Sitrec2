// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original recognizes a public UAP-imagery page address, fetches that site's catalog and
// resolves the record to a video. Here no address and no record code is recognized: the
// resolver in src/DragDropHandler.js is never reached, and src/CSitchBrowser.js, which
// offers an import tile when the search text holds a record code, never sees one.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:WarGovUFOUtils";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

export function getAaroDvidsIdForPrCode() {
    return null;
}

export function isWarGovUFOPageURL() {
    return false;
}

export function getWarGovUFORecordKey() {
    return null;
}

export function getWarGovUFOPrCode() {
    return null;
}

export function extractWarGovPRCode() {
    return null;
}

export function normalizeWarGovRecordText() {
    return "";
}

export function parseWarGovCSV() {
    return [];
}

export function findWarGovUFORecord() {
    return null;
}

export async function loadWarGovUFOCatalog() {
    return [];
}

export function resetWarGovUFOCatalogCacheForTests() {
}

export async function getWarGovUFODvidsId() {
    return null;
}

export async function getWarGovUFODvidsIdForPrCode() {
    return null;
}

export async function resolveWarGovUFOVideoURL() {
    return null;
}
