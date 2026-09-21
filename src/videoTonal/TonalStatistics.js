// Statistics of recorded code values, not temperature or sensor dynamic range.
export const TONAL_FIELDS = ['min', 'p05', 'p25', 'median', 'p75', 'p95', 'max', 'mean',
    'target', 'local', 'contrast', 'relativeContrast'];

export function histogramStatistics(histogram) {
    let count = 0, sum = 0;
    for (let i = 0; i < histogram.length; i++) {
        count += histogram[i];
        sum += i * histogram[i];
    }
    const result = {count, mean: count ? sum / count : NaN};
    const keys = ['min', 'p05', 'p25', 'median', 'p75', 'p95', 'max'];
    const fractions = [0, .05, .25, .5, .75, .95, 1];
    let total = 0, q = 0;
    for (let i = 0; i < histogram.length && count; i++) {
        total += histogram[i];
        while (q < keys.length && total >= Math.max(1, Math.ceil(fractions[q] * count))) {
            result[keys[q++]] = i;
        }
    }
    for (; q < keys.length; q++) result[keys[q]] = NaN;
    return result;
}

// Native source coordinates -> the rotated video coordinates in which the mask was painted.
export function rotatedUV(u, v, rotation) {
    if (rotation === 90) return [1 - v, u];
    if (rotation === 180) return [1 - u, 1 - v];
    if (rotation === 270) return [v, 1 - u];
    return [u, v];
}

export function exclusionMask(width, height, mask, rotation = 0) {
    if (!mask) return null;
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const [u, v] = rotatedUV((x + .5) / width, (y + .5) / height, rotation);
        const mx = Math.min(mask.width - 1, Math.floor(u * mask.width));
        const my = Math.min(mask.height - 1, Math.floor(v * mask.height));
        out[y * width + x] = mask.alpha[my * mask.width + mx] > 128 ? 1 : 0;
    }
    return out;
}

// target uses normalized, rotated-video coordinates and radii, independent of decode resolution.
export function measureTonalFrame(pixels, width, height, excluded, target, rotation = 0) {
    const histogram = new Uint32Array(256);
    for (let i = 0; i < pixels.length; i++) if (!excluded?.[i]) histogram[pixels[i]]++;
    const values = {target: NaN, local: NaN, contrast: NaN, relativeContrast: NaN,
        targetCount: 0, localCount: 0};
    if (target) {
        const [u, v] = rotatedUV(target.u, target.v, (360 - rotation) % 360);
        const swap = rotation === 90 || rotation === 270;
        const rx = (swap ? target.ry : target.rx) * width;
        const ry = (swap ? target.rx : target.ry) * height;
        const cx = u * width, cy = v * height;
        if (rx > 0 && ry > 0) {
            const localHistogram = new Uint32Array(256);
            let targetSum = 0;
            for (let y = Math.max(0, Math.floor(cy - 4 * ry)); y < Math.min(height, Math.ceil(cy + 4 * ry)); y++) {
                for (let x = Math.max(0, Math.floor(cx - 4 * rx)); x < Math.min(width, Math.ceil(cx + 4 * rx)); x++) {
                    const i = y * width + x;
                    if (excluded?.[i]) continue;
                    const distance = ((x + .5 - cx) / rx) ** 2 + ((y + .5 - cy) / ry) ** 2;
                    if (distance < 4) histogram[pixels[i]]--; // exclude target + guard from global background
                    if (distance <= 1) { targetSum += pixels[i]; values.targetCount++; }
                    if (distance >= 4 && distance <= 16) localHistogram[pixels[i]]++;
                }
            }
            const local = histogramStatistics(localHistogram);
            values.target = values.targetCount ? targetSum / values.targetCount : NaN;
            values.local = local.median;
            values.localCount = local.count;
            values.contrast = values.target - values.local;
            const spread = local.p75 - local.p25;
            // A sub-code spread cannot support a stable relative-contrast estimate.
            values.relativeContrast = spread >= 1 ? values.contrast / spread : NaN;
        }
    }
    return {histogram, ...histogramStatistics(histogram), ...values};
}
