// EXIF Orientation must be applied exactly once. It used to be applied twice for
// JPEG — the browser rotated on decode and Sitrec rotated again — which turned
// every portrait phone photo 90 degrees the wrong way and swapped its reported
// width and height. The measured case: a Galaxy S26 Ultra frame, EXIF
// Orientation 6, stored 4000x3000, decoded by the browser as 3000x4000, then
// re-rotated by Sitrec back to 4000x3000.

import {decoderAppliedOrientation, residualExifRotation} from "../src/imageOrientation";

// EXIF Orientation 6 = rotate 90 CW; stored landscape, displayed portrait.
const ORI6 = {orientation: 6, rotationDegrees: 90, exifImageWidth: 4000, exifImageHeight: 3000};
const ORI8 = {orientation: 8, rotationDegrees: 270, exifImageWidth: 4000, exifImageHeight: 3000};
const ORI3 = {orientation: 3, rotationDegrees: 180, exifImageWidth: 4000, exifImageHeight: 3000};
const ORI1 = {orientation: 1, rotationDegrees: 0, exifImageWidth: 4000, exifImageHeight: 3000};

const decoded = (w, h) => ({width: w, height: h});

describe("has the decoder already applied EXIF orientation?", () => {

    test("the real Funkturm case: decoded portrait, so the decoder turned it", () => {
        // stored 4000x3000, came back 3000x4000 -> browser did the rotation
        expect(decoderAppliedOrientation(decoded(3000, 4000), ORI6)).toBe(true);
        expect(residualExifRotation(decoded(3000, 4000), ORI6)).toBe(0);
    });

    test("a decoder that did NOT rotate leaves the stored dimensions", () => {
        expect(decoderAppliedOrientation(decoded(4000, 3000), ORI6)).toBe(false);
        expect(residualExifRotation(decoded(4000, 3000), ORI6)).toBe(90);
    });

    test("270 behaves like 90 — the axes swap either way", () => {
        expect(residualExifRotation(decoded(3000, 4000), ORI8)).toBe(0);
        expect(residualExifRotation(decoded(4000, 3000), ORI8)).toBe(270);
    });

    test("an upright image needs nothing applied whatever the decoder did", () => {
        expect(decoderAppliedOrientation(decoded(4000, 3000), ORI1)).toBe(true);
        expect(residualExifRotation(decoded(4000, 3000), ORI1)).toBe(0);
    });

    test("no rotationDegrees at all means no rotation to apply", () => {
        expect(residualExifRotation(decoded(4000, 3000), {})).toBe(0);
        expect(residualExifRotation(decoded(4000, 3000), undefined)).toBe(0);
    });

    // 180 does not swap the axes, so the pixels cannot say. Trusting the decoder
    // is the safe default: every decoder Sitrec uses honours orientation, and
    // being wrong the other way is the double-rotation this exists to prevent.
    test("180 cannot be measured, so the decoder is trusted", () => {
        expect(decoderAppliedOrientation(decoded(4000, 3000), ORI3)).toBe(true);
        expect(residualExifRotation(decoded(4000, 3000), ORI3)).toBe(0);
    });

    test("a square image cannot be measured either", () => {
        const sq = {rotationDegrees: 90, exifImageWidth: 3000, exifImageHeight: 3000};
        expect(decoderAppliedOrientation(decoded(3000, 3000), sq)).toBe(true);
    });

    test("missing or nonsense EXIF dimensions fall back to trusting the decoder", () => {
        expect(decoderAppliedOrientation(decoded(3000, 4000), {rotationDegrees: 90})).toBe(true);
        expect(decoderAppliedOrientation(decoded(3000, 4000),
            {rotationDegrees: 90, exifImageWidth: 0, exifImageHeight: 0})).toBe(true);
        expect(decoderAppliedOrientation(null, ORI6)).toBe(true);
    });

    test("negative and over-360 angles normalise rather than misfire", () => {
        expect(decoderAppliedOrientation(decoded(4000, 3000),
            {rotationDegrees: -270, exifImageWidth: 4000, exifImageHeight: 3000})).toBe(false);
        expect(decoderAppliedOrientation(decoded(4000, 3000),
            {rotationDegrees: 360, exifImageWidth: 4000, exifImageHeight: 3000})).toBe(true);
    });

    // The bug in one assertion: applying the EXIF angle to already-rotated pixels
    // gives back the STORED dimensions, which is how it was spotted.
    test("double-applying would restore the stored size — the original symptom", () => {
        const browserDecoded = decoded(3000, 4000);
        const wrong = residualExifRotation(browserDecoded, ORI6) === 90;
        expect(wrong).toBe(false);
    });
});
