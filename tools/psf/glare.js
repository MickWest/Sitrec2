// Glare preview: what a scene looks like THROUGH the optic the PSF describes.
//
// The whole content of "glare" is one line of linear systems theory: an incoherent imaging
// system is a convolution, image = scene * PSF. Everything else here is bookkeeping.
//
// This does the convolution exactly, in the Fourier domain, rather than approximating it -
// the preview is the reference the real-time Sitrec pass is checked against, so it must not
// share the real-time pass's shortcuts. The transform is cyclic, so both inputs are zero
// padded to twice the working size; without that, a spike running off the right edge
// reappears on the left.
//
// One deliberate split: the scene is convolved ONCE per (scene, PSF, threshold) and cached,
// because `gain` is the control that gets dragged and rescaling a cached halo is free.

import { FFT2D, fftshift } from "./fft.js";

/** Relative luminance of linear sRGB. Rec. 709 weights - the same ones the Sitrec pass uses
 *  for its bright test, so the two agree about which pixels glare. */
export function luminance(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

export class GlareRenderer {
    /** @param {number} n working size; the scene and the PSF are both handled at n x n. */
    constructor(n) {
        this.n = n;
        this.pad = n * 2;                 // linear (non-cyclic) convolution needs 2n
        this.fft = new FFT2D(this.pad);
        this.psfSpectrum = null;          // [{re, im} x3], the cached transform of the PSF
        this.scene = null;                // Float32Array(n*n*3), linear light
        this.halo = null;                 // Float32Array(n*n*3), the cached convolution
        this.haloKey = null;
    }

    /** Cache the PSF's transform. `scale` resamples the PSF first: 1 draws it at its native
     *  pixel scale, 2 makes the pattern twice as wide (a source seen at half the field of
     *  view, or through half the aperture). */
    setPSF(psfRGB, psfN, scale = 1) {
        // Minifying a PSF with bilinear sampling alone ALIASES badly: the spikes are one or
        // two pixels wide, so point-sampling a 512 PSF down to 256 makes them flicker in and
        // out along their length. Box-reduce by the integer part of the minification first,
        // which averages the pixels that are being thrown away instead of ignoring them.
        if (scale < 1) {
            const f = Math.max(1, Math.floor(1 / scale));
            if (f > 1) {
                const m = Math.floor(psfN / f);
                const small = new Float32Array(m * m * 3);
                for (let y = 0; y < m; y++) {
                    for (let x = 0; x < m; x++) {
                        let r = 0, g = 0, b = 0;
                        for (let j = 0; j < f; j++) {
                            for (let i = 0; i < f; i++) {
                                const o = ((y * f + j) * psfN + (x * f + i)) * 3;
                                r += psfRGB[o]; g += psfRGB[o + 1]; b += psfRGB[o + 2];
                            }
                        }
                        const d = (y * m + x) * 3;
                        small[d] = r; small[d + 1] = g; small[d + 2] = b;
                    }
                }
                psfRGB = small; psfN = m; scale *= f;
            }
        }
        const P = this.pad, c = P / 2, pc = psfN / 2;
        this.psfSpectrum = [];
        for (let ch = 0; ch < 3; ch++) {
            const re = new Float64Array(P * P), im = new Float64Array(P * P);
            // Centre the PSF on the padded grid, then shift it so its core sits at the
            // transform's origin - otherwise the convolution translates the whole image.
            for (let y = 0; y < P; y++) {
                const sy = (y - c) / scale + pc;
                if (sy < 0 || sy > psfN - 1) continue;
                for (let x = 0; x < P; x++) {
                    const sx = (x - c) / scale + pc;
                    if (sx < 0 || sx > psfN - 1) continue;
                    re[y * P + x] = sampleBilinear3(psfRGB, psfN, sx, sy, ch);
                }
            }
            // Preserve unit flux across the resample, so changing `scale` changes the SHAPE
            // of the glare without changing how much light it carries.
            let s = 0; for (let i = 0; i < P * P; i++) s += re[i];
            if (s > 0) { const k = 1 / s; for (let i = 0; i < P * P; i++) re[i] *= k; }
            fftshift(re, P);
            this.fft.transform(re, im, false);
            this.psfSpectrum.push({ re, im });
        }
        this.haloKey = null;
    }

    setScene(sceneRGB) { this.scene = sceneRGB; this.haloKey = null; }

    /** Convolve the over-threshold part of the scene with the PSF. Cached on `threshold`. */
    convolve(threshold) {
        const key = String(threshold);
        if (this.haloKey === key && this.halo) return this.halo;
        const n = this.n, P = this.pad, off = (P - n) >> 1;
        const halo = new Float32Array(n * n * 3);

        for (let ch = 0; ch < 3; ch++) {
            const re = new Float64Array(P * P), im = new Float64Array(P * P);
            for (let y = 0; y < n; y++) {
                for (let x = 0; x < n; x++) {
                    const i = y * n + x;
                    // Bright pass on LUMINANCE, not per channel: a red source must throw a
                    // red glare, and thresholding channels independently would tint it.
                    const L = luminance(this.scene[i * 3], this.scene[i * 3 + 1], this.scene[i * 3 + 2]);
                    if (L <= threshold) continue;
                    const k = (L - threshold) / L;
                    re[(y + off) * P + (x + off)] = this.scene[i * 3 + ch] * k;
                }
            }
            const S = this.psfSpectrum[ch];
            this.fft.transform(re, im, false);
            for (let i = 0, e = P * P; i < e; i++) {
                const ar = re[i], ai = im[i], br = S.re[i], bi = S.im[i];
                re[i] = ar * br - ai * bi;
                im[i] = ar * bi + ai * br;
            }
            this.fft.transform(re, im, true);
            for (let y = 0; y < n; y++)
                for (let x = 0; x < n; x++)
                    halo[(y * n + x) * 3 + ch] = re[(y + off) * P + (x + off)];
        }

        this.halo = halo;
        this.haloKey = key;
        return halo;
    }

    /** scene + gain * halo, in linear light. Free to recompute as `gain` is dragged. */
    compose(gain) {
        const n = this.n, out = new Float32Array(n * n * 3);
        for (let i = 0, e = n * n * 3; i < e; i++) out[i] = this.scene[i] + this.halo[i] * gain;
        return out;
    }
}

function sampleBilinear3(a, n, x, y, ch) {
    const x0 = x | 0, y0 = y | 0;
    const x1 = Math.min(x0 + 1, n - 1), y1 = Math.min(y0 + 1, n - 1);
    const fx = x - x0, fy = y - y0;
    const p = (yy, xx) => a[(yy * n + xx) * 3 + ch];
    return (p(y0, x0) * (1 - fx) + p(y0, x1) * fx) * (1 - fy)
         + (p(y1, x0) * (1 - fx) + p(y1, x1) * fx) * fy;
}

// ── Test scenes ─────────────────────────────────────────────────────────────────

/** A few point sources on a flat background - the case a diffraction PSF actually
 *  describes, and the one the Chandelier is. Brightness is in linear units where the
 *  background is `sky`; the values are deliberately far above it, because a source has to
 *  outshine the scene by orders of magnitude before its spikes clear the noise. */
export function scenePoints(n, opts = {}) {
    const { sky = 0.02, sources = null, tint = [1, 1, 1] } = opts;
    const img = new Float32Array(n * n * 3);
    for (let i = 0; i < n * n; i++) {
        img[i * 3] = sky * tint[0]; img[i * 3 + 1] = sky * tint[1]; img[i * 3 + 2] = sky * tint[2];
    }
    const list = sources || [
        { x: 0.5,  y: 0.5,  flux: 4000, rgb: [1, 1, 1] },
        { x: 0.22, y: 0.28, flux: 260,  rgb: [1, 0.85, 0.6] },
        { x: 0.78, y: 0.72, flux: 90,   rgb: [0.7, 0.85, 1] },
    ];
    for (const s of list) {
        // Splat into the four nearest pixels so a source at a fractional position does not
        // snap to the grid - the spike pattern is symmetric about the source, and a
        // half-pixel snap is visible as a lopsided core.
        const fx = s.x * (n - 1), fy = s.y * (n - 1);
        const x0 = Math.floor(fx), y0 = Math.floor(fy), dx = fx - x0, dy = fy - y0;
        for (const [ox, oy, w] of [[0, 0, (1 - dx) * (1 - dy)], [1, 0, dx * (1 - dy)],
                                   [0, 1, (1 - dx) * dy],       [1, 1, dx * dy]]) {
            const x = x0 + ox, y = y0 + oy;
            if (x < 0 || y < 0 || x >= n || y >= n) continue;
            const i = (y * n + x) * 3;
            img[i]     += s.flux * w * s.rgb[0];
            img[i + 1] += s.flux * w * s.rgb[1];
            img[i + 2] += s.flux * w * s.rgb[2];
        }
    }
    return img;
}

/** Convert an ImageData to a linear-light float scene, undoing the sRGB transfer function
 *  and then boosting the near-white pixels. The boost exists because an 8-bit photo has
 *  already clipped its bright sources to 255: a lamp that was 10,000x the background reads
 *  as 1.0, and convolving THAT produces no visible glare at all. `highlightBoost` is an
 *  honest guess at the clipped headroom, and it is labelled as one in the UI. */
export function sceneFromImageData(src, n, highlightBoost = 300) {
    const img = new Float32Array(n * n * 3);
    const sw = src.width, sh = src.height;
    for (let y = 0; y < n; y++) {
        const sy = Math.min(sh - 1, Math.floor((y / n) * sh));
        for (let x = 0; x < n; x++) {
            const sx = Math.min(sw - 1, Math.floor((x / n) * sw));
            const o = (sy * sw + sx) * 4, d = (y * n + x) * 3;
            for (let ch = 0; ch < 3; ch++) {
                const s = src.data[o + ch] / 255;
                const lin = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
                // Smooth ramp into the boost above ~0.85, so a bright sky does not suddenly
                // become a light source at one particular grey level.
                const t = Math.max(0, (lin - 0.72) / 0.28);
                img[d + ch] = lin * (1 + t * t * highlightBoost);
            }
        }
    }
    return img;
}
