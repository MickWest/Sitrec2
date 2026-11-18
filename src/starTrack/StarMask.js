// Masks travel as data so the detector, workers and catalog verifier share the
// same convention: one byte per pixel, nonzero means excluded.

/** Sample a video mask's alpha in measurement coordinates; never mutate it. */
export function detectionMaskFromAlpha(image, W, H) {
    if (!image) return null;
    const out = new Uint8Array(W * H);
    let count = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const mx = Math.min(image.width - 1, Math.floor((x + .5) * image.width / W));
        const my = Math.min(image.height - 1, Math.floor((y + .5) * image.height / H));
        if (image.data[4 * (my * image.width + mx) + 3] > 128) { out[y * W + x] = 1; count++; }
    }
    return count ? out : null;
}

/** A visibility mask can have a smaller grid than its image-coordinate bounds. */
export function starIsMasked(mask, x, y) {
    if (!mask) return false;
    const [x0, y0, x1, y1] = mask.bounds;
    if (x < x0 || y < y0 || x >= x1 || y >= y1) return true;
    const mx = Math.floor((x - x0) * mask.width / (x1 - x0));
    const my = Math.floor((y - y0) * mask.height / (y1 - y0));
    return !!mask.data[my * mask.width + mx];
}

/** Actual unmasked area in a search rectangle, in image pixels squared. */
export function visibleStarArea(mask, bounds) {
    if (!mask) return Math.max(0, bounds[2] - bounds[0]) * Math.max(0, bounds[3] - bounds[1]);
    const [x0, y0, x1, y1] = mask.bounds;
    const dx = (x1 - x0) / mask.width, dy = (y1 - y0) / mask.height;
    let area = 0;
    for (let y = 0; y < mask.height; y++) {
        const h = Math.max(0, Math.min(y0 + (y + 1) * dy, bounds[3]) - Math.max(y0 + y * dy, bounds[1]));
        if (!h) continue;
        for (let x = 0; x < mask.width; x++) if (!mask.data[y * mask.width + x]) {
            const w = Math.max(0, Math.min(x0 + (x + 1) * dx, bounds[2]) - Math.max(x0 + x * dx, bounds[0]));
            area += w * h;
        }
    }
    return area;
}
