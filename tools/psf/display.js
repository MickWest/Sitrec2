// Turning a linear-light float image into pixels.
//
// A PSF has a brutal dynamic range - the core is commonly 10^6 times the faint outer
// structure - so the stretch is not a cosmetic control, it IS how you see the thing. Straight
// linear display shows a white dot on black and nothing else. Maskulator exposes one
// "Brightness" number for this; the two curves below are the same idea, said honestly.

/** Stretch curves, keyed by id, each mapping normalised linear v in [0, inf) to [0, 1].
 *  `gain` multiplies BEFORE the curve, so raising it reveals fainter structure and blows out
 *  the core - exactly what Maskulator's Brightness does. */
export const STRETCH = {
    // Plain gamma. Faithful to what a display does, and the right choice when comparing
    // against a real photograph that has been through the same kind of curve.
    gamma: {
        label: "Gamma",
        apply: (v, gain, p) => Math.pow(Math.min(1, v * gain), 1 / Math.max(0.01, p)),
        paramLabel: "Gamma",
        paramRange: [1, 6, 0.05],
        paramDefault: 2.2,
    },
    // Logarithmic. Compresses decades evenly, so the faint outer spikes and the core are
    // legible at once. This is the one to use when judging spike STRUCTURE.
    log: {
        label: "Log",
        apply: (v, gain, p) => Math.log1p(v * gain * p) / Math.log1p(gain * p),
        paramLabel: "Decades",
        paramRange: [10, 1e6, null],       // logarithmic slider; app.js maps it
        paramDefault: 1e4,
    },
    // Filmic-ish soft shoulder. Keeps the core from flat-topping into a featureless disc,
    // which matters when matching footage where the core is NOT clipped.
    asinh: {
        label: "Asinh",
        apply: (v, gain, p) => Math.asinh(v * gain * p) / Math.asinh(gain * p),
        paramLabel: "Softness",
        paramRange: [1, 1e5, null],
        paramDefault: 300,
    },
};

/** Render an n x n (or w x h) linear RGB float array into an ImageData.
 *
 *  `normalise` divides by this before the curve; pass the image peak to make gain 1 mean
 *  "just clipping". Values are sRGB-encoded by the stretch itself, not afterwards - the
 *  curves above stand in for the transfer function on purpose, so that `gamma 2.2` reads
 *  exactly as it does in every other imaging tool. */
export function toImageData(rgb, w, h, opts = {}) {
    const { stretch = "log", gain = 1, param = 1e4, normalise = 1, tint = [1, 1, 1] } = opts;
    const curve = (STRETCH[stretch] || STRETCH.log).apply;
    const inv = 1 / (normalise || 1);
    const out = new ImageData(w, h);
    const d = out.data;
    for (let i = 0, e = w * h; i < e; i++) {
        d[i * 4]     = 255 * curve(Math.max(0, rgb[i * 3]     * inv) * tint[0], gain, param);
        d[i * 4 + 1] = 255 * curve(Math.max(0, rgb[i * 3 + 1] * inv) * tint[1], gain, param);
        d[i * 4 + 2] = 255 * curve(Math.max(0, rgb[i * 3 + 2] * inv) * tint[2], gain, param);
        d[i * 4 + 3] = 255;
    }
    return out;
}

/** Render a single-channel mask (0..1) as greyscale - used for the pupil view. */
export function maskToImageData(mask, n) {
    const out = new ImageData(n, n);
    const d = out.data;
    for (let i = 0; i < n * n; i++) {
        const v = 255 * Math.max(0, Math.min(1, mask[i]));
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
        d[i * 4 + 3] = 255;
    }
    return out;
}
