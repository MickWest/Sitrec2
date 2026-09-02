// Secure-build stub. The original module is compiled out of the secure build; see docs/dev/Secure-Build.md
//
// The original dynamically imports the OCR library, whose worker, core and language files
// are fetched from a public CDN by default, so the text-extraction feature is a network
// dependency even though nothing in src/ names the host. The one caller
// (src/CTextExtraction.js, startExtraction) awaits loadTesseract() inside try/catch and shows
// errors.failedToLoadTesseract on rejection, so rejecting is the intended "feature absent"
// path; getTesseract() is only reached after a successful load and returns null here.

// Also registered on the global object, so the marker survives minification (scripts/secureStubs.js).
export const SECURE_STUB_MARKER = "__SITREC_SECURE_STUB__:tesseractLoader";
globalThis.__SITREC_SECURE_STUBS__ = (globalThis.__SITREC_SECURE_STUBS__ || []).concat(SECURE_STUB_MARKER);

export function loadTesseract() {
    return Promise.reject(new Error("Text extraction is not available in the secure build"));
}

export function getTesseract() {
    return null;
}
