/**
 * HEICUtils.js - Decode HEIC/HEIF images in the browser.
 *
 * Browsers other than Safari cannot natively decode `image/heic`, so a
 * `new Image()` with a HEIC blob URL silently fails (onerror) everywhere
 * except macOS/iOS Safari. This module decodes HEIC/HEIF to RGBA using
 * `heic-to` (a thin wrapper around the libheif WebAssembly build), then
 * hands back a standard PNG-backed Image / blob URL that the rest of
 * Sitrec's image pipeline already understands.
 *
 * The `heic-to` library is a single ~3MB file with the libheif WASM inlined
 * as base64, and it does its decoding inside an internal Web Worker. We load
 * it with a lazy dynamic import so that weight is only paid the first time a
 * user actually opens a HEIC (mirrors the lazy JPEG2000Utils import).
 *
 * We use the `heic-to/csp` entry point (identical output, but instantiates
 * the WASM without `unsafe-eval`) so this keeps working if a strict
 * Content-Security-Policy is ever added to production.
 *
 * Orientation: libheif applies the HEIF `irot`/`imir` transform boxes while
 * decoding, so the pixels we get back are already in display orientation
 * (upright). The EXIF Orientation tag in the same file is therefore
 * redundant for HEIC and must NOT be applied a second time — see the callers,
 * which strip `rotationDegrees` from the imported metadata for HEIC. That is
 * different from JPEG, where `new Image()` does not auto-rotate and the EXIF
 * rotation IS applied downstream by CVideoImageData.
 */

import {createImageFromArrayBuffer} from "./FileUtils";

let _heicTo = null;

/**
 * Lazily load and cache the heic-to `heicTo` function.
 */
async function getHeicTo() {
    if (_heicTo) return _heicTo;
    const mod = await import("heic-to/csp");
    _heicTo = mod.heicTo;
    return _heicTo;
}

/**
 * Decode a HEIC/HEIF buffer to a lossless PNG Blob (already upright).
 * @param {ArrayBuffer} arrayBuffer - Raw HEIC/HEIF file data
 * @returns {Promise<Blob>} PNG blob
 */
export async function decodeHEICToBlob(arrayBuffer) {
    const heicTo = await getHeicTo();
    const inputBlob = new Blob([arrayBuffer], {type: "image/heic"});
    const pngBlob = await heicTo({blob: inputBlob, type: "image/png"});
    if (!pngBlob) throw new Error("HEIC decode produced no output");
    return pngBlob;
}

/**
 * Decode a HEIC/HEIF buffer and return a persistent blob URL (PNG-backed).
 * The caller owns the URL and should URL.revokeObjectURL() it when done.
 * @param {ArrayBuffer} arrayBuffer - Raw HEIC/HEIF file data
 * @returns {Promise<string>} object URL
 */
export async function decodeHEICToBlobURL(arrayBuffer) {
    const pngBlob = await decodeHEICToBlob(arrayBuffer);
    return URL.createObjectURL(pngBlob);
}

/**
 * Decode a HEIC/HEIF buffer and return a fully-loaded HTMLImageElement.
 * Resolves only once the browser has actually decoded the PNG (onload), so
 * callers get a guaranteed-ready image with real width/height.
 * @param {ArrayBuffer} arrayBuffer - Raw HEIC/HEIF file data
 * @returns {Promise<HTMLImageElement>}
 */
export async function decodeHEICToImage(arrayBuffer) {
    const pngBlob = await decodeHEICToBlob(arrayBuffer);
    const pngBuffer = await pngBlob.arrayBuffer();
    // createImageFromArrayBuffer resolves on img.onload and keeps the object
    // URL alive for the life of the image (same as the JPEG2000 path).
    return createImageFromArrayBuffer(pngBuffer, "image/png");
}
