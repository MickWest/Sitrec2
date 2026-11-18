// Refine a texture mask with the smooth colour and illumination of its open sky.
// The model is learned from this frame; no particular sky hue, horizon or camera
// orientation is assumed. A monochrome frame still supplies illumination evidence.

function median(a) {
    a.sort((x, y) => x - y);
    return a[a.length >> 1];
}

function basis(x, y) { return [1, x, y, x * x, x * y, y * y]; }
function value(c, b) { return c.reduce((s, v, i) => s + v * b[i], 0); }

// Linear chromaticity and quadratic log illumination, fitted with pivoting.
// A narrow strip of usable sky can
// leave the fit unconstrained; in that case retain the texture mask.
function fit(samples, channel) {
    const n = channel === 2 ? 6 : 3;
    const a = Array.from({length: n}, () => new Float64Array(n + 1));
    for (const s of samples) for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) a[i][j] += s.b[i] * s.b[j];
        a[i][n] += s.b[i] * s.v[channel];
    }
    for (let i = 0; i < n; i++) {
        let pivot = i;
        for (let j = i + 1; j < n; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
        if (Math.abs(a[pivot][i]) < 1e-7 * samples.length) return null;
        [a[i], a[pivot]] = [a[pivot], a[i]];
        const d = a[i][i];
        for (let j = i; j <= n; j++) a[i][j] /= d;
        for (let k = 0; k < n; k++) if (k !== i) {
            const f = a[k][i];
            for (let j = i; j <= n; j++) a[k][j] -= f * a[i][j];
        }
    }
    return a.map(row => row[n]);
}

/** Pixels are at the segmenter's working resolution, not the measurement image. */
export function refineSkyMaskWithColor(rgba, W, H, ground, {luma, texture}, opts = {}) {
    const N = W * H;
    const red = new Float32Array(N), blue = new Float32Array(N), level = new Float32Array(N);
    // Suppress individual coloured stars before learning or classifying regions.
    // The original image is never changed, including its unsaturated colour samples.
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const r = [], g = [], b = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const p = 4 * (Math.max(0, Math.min(H - 1, y + dy)) * W + Math.max(0, Math.min(W - 1, x + dx)));
            r.push(rgba[p]); g.push(rgba[p + 1]); b.push(rgba[p + 2]);
        }
        const R = median(r), G = median(g), B = median(b), sum = R + G + B + 24;
        const i = y * W + x;
        // The pedestal bounds colour noise near black, where chromaticity is undefined.
        red[i] = (R - G) / sum; blue[i] = (B - G) / sum;
        level[i] = Math.log(8 + luma[i]);
    }
    const samples = [];
    for (let y = 2; y < H - 2; y += 4) for (let x = 2; x < W - 2; x += 4) {
        const i = y * W + x;
        if (!ground[i]) samples.push({b: basis(2 * x / W - 1, 2 * y / H - 1), v: [red[i], blue[i], level[i]]});
    }
    if (samples.length < 100) return null;
    let live = samples, model;
    const floors = [0.02, 0.02, 0.15];
    // A bright, smooth roof at a frame corner has disproportionate leverage in
    // least squares. Start with a deterministic least-median sample fit, so that
    // corner cannot bend the sky model before trimming has a chance to reject it.
    let state = 0x51a7, best = Infinity;
    const probe = samples.filter((_, i) => i % Math.max(1, Math.floor(samples.length / 300)) === 0);
    for (let trial = 0; trial < 128; trial++) {
        const subset = [];
        for (let k = 0; k < 6; k++) {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            subset.push(samples[state % samples.length]);
        }
        const candidate = floors.map((_, c) => fit(subset, c));
        if (candidate.some(c => !c)) continue;
        const score = median(probe.map(s => Math.max(...floors.map((scale, c) =>
            Math.abs(s.v[c] - value(candidate[c], s.b)) / scale))));
        if (score < best) { best = score; model = candidate; }
    }
    if (!model) return null;
    // Trim jointly: a smooth coloured wall can pass a texture test but must not
    // drag the fitted sky colour toward itself. Retain broad spatial support.
    for (let pass = 0; pass < 5; pass++) {
        const scales = floors.map((floor, c) => Math.max(floor,
            1.4826 * median(live.map(s => Math.abs(s.v[c] - value(model[c], s.b))))));
        const ranked = samples.map(s => ({s, error: Math.max(...scales.map((scale, c) =>
            Math.abs(s.v[c] - value(model[c], s.b)) / scale))})).sort((a, b) => a.error - b.error);
        // A zoom can make a smooth wall cover more than a quarter of the frame.
        // Never force its samples back into the sky fit to fill a fixed quota.
        const inliers = ranked.filter(r => r.error <= 3);
        if (inliers.length < Math.max(100, samples.length * .35)) return null;
        live = inliers.slice(0, Math.max(100, Math.floor(samples.length * .75))).map(r => r.s);
        model = floors.map((_, c) => fit(live, c));
        if (model.some(c => !c)) return null;
    }
    const limits = floors.map((floor, c) => Math.max(floor * 3,
        4 * 1.4826 * median(live.map(s => Math.abs(s.v[c] - value(model[c], s.b))))));
    // An incoherent fit has no authority to relabel texture regions.
    if (limits[0] > .12 || limits[1] > .12 || limits[2] > .65) return null;
    const span = c => Math.max(...live.map(s => s.b[c])) - Math.min(...live.map(s => s.b[c]));
    if (span(1) < .6 || span(2) < .6) return null;

    const out = new Uint8Array(ground);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, b = basis(2 * x / W - 1, 2 * y / H - 1);
        const dc = Math.max(Math.abs(red[i] - value(model[0], b)) / limits[0],
            Math.abs(blue[i] - value(model[1], b)) / limits[1]);
        const dl = Math.abs(level[i] - value(model[2], b)) / limits[2];
        const chromaticSky = Math.hypot(value(model[0], b), value(model[1], b)) > .08;
        // Colour adds evidence for smooth foreground that texture alone misses.
        // Recover sky from coarse boundary blocks only when both cues agree.
        if (dc > 1 || (dl > 1 && (!chromaticSky || dc > .5))) out[i] = 1;
        else if (dc < .7 && (dl < .7 || chromaticSky) && texture[i] < Math.max(1, opts.splitTolerance * 3)) out[i] = 0;
    }
    return {ground: out, colorLimits: limits, colorSamples: live.length};
}
