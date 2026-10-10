// Scale of the milliradian reticle (CNodeMradReticleUI): screen pixels per milliradian at
// the center of the look view, and which of the display's two reticles applies.

// The display shows one of two reticles, chosen by the field of view. The wide one
// was seen at a 43.6 mrad field and the narrow one at 10.9 mrad (4x); switch at
// their geometric mean.
export const WIDE_MIN_FIELD_MRAD = Math.sqrt(43.6 * 10.9);
export const WIDE_RETICLE = {left: 15, right: 15, up: 10, down: 5, minorStep: 1, majorStep: 5, labels: [5, 10, 15]};
export const NARROW_RETICLE = {left: 3, right: 3, up: 3, down: 3, minorStep: 0, majorStep: 0, labels: [3]};

// Screen pixels per milliradian at the center of a view heightPx tall, for a camera with a
// vertical field of view of fovDeg that the view draws `magnification` times larger
// (see viewMagnification). One milliradian is a tangent of 0.001.
export function pixelsPerMrad(heightPx, fovDeg, magnification = 1) {
    return (heightPx / 2) * magnification / Math.tan(fovDeg * Math.PI / 360) / 1000;
}

// The reticle for a video image imageWidthPx wide on screen. The image's width in
// milliradians is the camera's own field: zooming the video scales the image and
// pxPerMrad together, so it does not change the choice.
export function reticleForImage(imageWidthPx, pxPerMrad) {
    return imageWidthPx / pxPerMrad >= WIDE_MIN_FIELD_MRAD ? WIDE_RETICLE : NARROW_RETICLE;
}
