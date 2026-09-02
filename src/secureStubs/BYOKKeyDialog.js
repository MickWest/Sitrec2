// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original is the dialog where a user enters their own provider keys. Here the dialog
// never opens. The Settings button that calls it (src/CustomSupport.js) is still shown; it
// logs a warning and does nothing else.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:BYOKKeyDialog";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

export async function showKeyDialog() {
    console.warn("The API key dialog is not available in this build");
}
