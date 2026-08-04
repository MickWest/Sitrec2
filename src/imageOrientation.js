// Did the image decoder already apply the EXIF orientation?
//
// This used to be answered by assumption, and the assumption went stale. Browsers
// have honoured EXIF Orientation when decoding an <img> or createImageBitmap
// since Chrome 81 / Safari 13.1 — `image-orientation: from-image` is the INITIAL
// value of that CSS property, so it applies to a detached `new Image()` too — and
// libheif applies the HEIF irot/imir boxes while decoding. Sitrec nonetheless
// rotated by the EXIF angle a second time, so every portrait phone JPEG came out
// 90 degrees from how it was shot, with its width and height swapped.
//
// The fix is to stop guessing. EXIF records the STORED pixel dimensions, so the
// decoded image is evidence: come back with those dimensions swapped and the
// decoder has already turned the picture.
//
// Deliberately dependency-free so it can be unit-tested without the app graph.

// True when the decoded pixels are already in display orientation, i.e. the EXIF
// rotation must NOT be applied again.
//
// decoded: anything with numeric .width/.height (HTMLImageElement, ImageBitmap,
//          canvas) — the image as the decoder handed it back
// meta:    the `image` block from EXIFUtils — rotationDegrees plus the stored
//          exifImageWidth/exifImageHeight
export function decoderAppliedOrientation(decoded, meta) {
    const deg = ((meta?.rotationDegrees ?? 0) % 360 + 360) % 360;
    if (deg === 0) return true;                 // nothing to apply either way

    const ew = meta?.exifImageWidth, eh = meta?.exifImageHeight;
    const dw = decoded?.width, dh = decoded?.height;
    const usable = [ew, eh, dw, dh].every(n => Number.isFinite(n) && n > 0);

    if (usable && ew !== eh && (deg === 90 || deg === 270)) {
        // Decisive: a quarter turn swaps the axes, so the decoded size tells us
        // outright which side of the rotation we are on.
        if (dw === eh && dh === ew) return true;    // already turned
        if (dw === ew && dh === eh) return false;   // still as stored
    }

    // 180, or a square image, or dimensions we cannot trust: the axes do not
    // swap, so there is nothing to measure. Every decoder Sitrec uses honours
    // orientation, so trust it rather than risk turning the picture twice —
    // which is the failure this function exists to prevent.
    return true;
}

// The rotation Sitrec should apply itself, in degrees: the EXIF angle when the
// decoder left the pixels as stored, otherwise nothing.
export function residualExifRotation(decoded, meta) {
    if (meta?.rotationDegrees === undefined) return 0;
    return decoderAppliedOrientation(decoded, meta) ? 0 : meta.rotationDegrees;
}
