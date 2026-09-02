// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original recognizes a public video-library page address dropped onto the page and
// fetches the page to find its MP4. Here no address is recognized, so the resolver in
// src/DragDropHandler.js is never reached; if called anyway it resolves to null.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:DVIDSUtils";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

export function isDvidsVideoPageURL() {
    return false;
}

export function getDvidsVideoId() {
    return null;
}

export function deriveDvidsMp4URLFromPlaylist() {
    return null;
}

export function extractDvidsVideoURLFromHTML() {
    return null;
}

export async function resolveDvidsVideoURL() {
    return null;
}
