// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original sends the current video frame to the server's vision endpoint and masks the
// ground from the outline that comes back. Here no frame leaves the page: the result is the
// {error} shape the caller (src/CMotionAnalysisUI.js) shows to the user.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:SkyMaskAI";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

export async function maskGroundWithAI() {
    return {error: "not available in this build"};
}
