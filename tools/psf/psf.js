// Polychromatic point spread function from a pupil mask - the "FFTW" half of the job.
//
// THE PHYSICS, in one paragraph. In the Fraunhofer (far field) regime the image-plane
// amplitude of a point source is the Fourier transform of the pupil function, so the point
// spread function is |FFT(P)|^2 where P is the complex pupil: the transmission mask times a
// phase term carrying the wavefront error. Defocus is the only aberration modelled here,
// as W20 * rho^2 - a quadratic phase - because it is the one Maskulator exposes and the one
// that visibly changes the pattern. Everything the Chandelier shows falls out of that.
//
// WHY THE FFT NORMALLY RUNS ONCE, NOT ONCE PER WAVELENGTH. In dimensionless pupil
// coordinates the transform does not depend on wavelength at all; wavelength only sets the
// SCALE at which the result lands on the detector, with the pattern radius proportional to
// lambda. So an in-focus polychromatic PSF is one transform resampled at 32 different
// scales - about 30x cheaper than 32 transforms, and exact. Defocus breaks this, because
// the phase term is 2*pi*W20*rho^2/lambda and so the pupil itself becomes wavelength
// dependent; that path really does transform once per sample, and says so in its progress.

import { FFT2D, fftshift } from "./fft.js";
import { rasterStop, DEFAULT_STOP } from "./aperture.js";
import { buildSpectralSamples } from "./cie.js";

export const DEFAULT_SPEC = {
    n: 512,                 // grid size; the PSF comes out at this resolution
    fill: 0.62,             // pupil diameter as a fraction of the grid (the zero padding)
    supersample: 3,
    combine: "sumPSF",      // sumPSF (two separate stops, incoherent) | intersect (one pupil)
    stops: [
        { ...DEFAULT_STOP, weight: 1 },
        { ...DEFAULT_STOP, enabled: false, shape: "square", obstruction: 0, rotationDeg: 0,
          vanes: { ...DEFAULT_STOP.vanes, count: 0 }, weight: 1 },
    ],
    spectrum: { nm0: 350, nm1: 780, steps: 32, kind: "flat", kelvin: 5500 },
    optics: { apertureM: 0.40, focalM: 3.0 },
    defocusUm: 0,
};

/** The sampling trade-off the grid and fill imply, in units a reader can act on.
 *
 *  Stated because it is the one thing an FFT PSF gets silently wrong: at a large fill the
 *  Airy core lands on barely one pixel and the whole pattern looks like pure spikes with no
 *  core, which is an artefact, not optics. */
export function describeSampling(spec) {
    const n = spec.n;
    const pupilPx = spec.fill * n;
    const lambdaRefNm = spec.spectrum.nm1;
    const D = spec.optics.apertureM, f = spec.optics.focalM;

    // dx is the pupil-plane sample pitch; the transform's angular pitch is lambda/(n*dx).
    const dx = D / pupilPx;
    const anglePerPixelRad = (lambdaRefNm * 1e-9) / (n * dx);
    const airyRadiusPx = 1.22 / pupilPx * n;   // 1.22*lambda/D expressed in output pixels
    return {
        pupilPx,
        anglePerPixelRad,
        anglePerPixelArcsec: anglePerPixelRad * 206264.806,
        fieldHalfWidthRad: anglePerPixelRad * (n / 2),
        fieldHalfWidthArcsec: anglePerPixelRad * (n / 2) * 206264.806,
        airyRadiusPx,
        airyRadiiAcrossField: (n / 2) / airyRadiusPx,
        imagePixelPitchUm: anglePerPixelRad * f * 1e6,
        fNumber: f / D,
        // Rayleigh quarter-wave depth of focus, the scale on which `defocusUm` matters.
        criticalFocusUm: 2 * 550e-9 * (f / D) * (f / D) * 1e6,
        undersampledCore: airyRadiusPx < 1.5,
    };
}

/** Bilinear sample of an n x n array, zero outside. */
function sampleBilinear(a, n, x, y) {
    if (x < 0 || y < 0 || x > n - 1 || y > n - 1) return 0;
    const x0 = x | 0, y0 = y | 0;
    const x1 = Math.min(x0 + 1, n - 1), y1 = Math.min(y0 + 1, n - 1);
    const fx = x - x0, fy = y - y0;
    const a00 = a[y0 * n + x0], a10 = a[y0 * n + x1];
    const a01 = a[y1 * n + x0], a11 = a[y1 * n + x1];
    return (a00 * (1 - fx) + a10 * fx) * (1 - fy) + (a01 * (1 - fx) + a11 * fx) * fy;
}

/** |FFT(mask * exp(i*phase))|^2, quadrant-shifted so the core sits at the centre.
 *  `phaseScale` multiplies rho^2 to give the phase in radians; 0 leaves the pupil real. */
function intensityFromPupil(fft2d, mask, n, fill, phaseScale) {
    const re = new Float64Array(n * n);
    const im = new Float64Array(n * n);
    const centre = n / 2;
    const radiusPx = (fill * n) / 2;

    if (phaseScale === 0) {
        re.set(mask);
    } else {
        const inv2 = 1 / (radiusPx * radiusPx);
        for (let y = 0; y < n; y++) {
            const dy = y - centre;
            for (let x = 0; x < n; x++) {
                const m = mask[y * n + x];
                if (m === 0) continue;
                const dx = x - centre;
                const phase = phaseScale * (dx * dx + dy * dy) * inv2;
                re[y * n + x] = m * Math.cos(phase);
                im[y * n + x] = m * Math.sin(phase);
            }
        }
    }

    fft2d.transform(re, im, false);

    const I = new Float64Array(n * n);
    for (let i = 0, e = n * n; i < e; i++) I[i] = re[i] * re[i] + im[i] * im[i];
    fftshift(I, n);
    return I;
}

/** One pupil's polychromatic PSF, accumulated into `out` (n*n*3 linear RGB).
 *  Takes an already-rasterised mask so the intersect path can hand it a merged one. */
function accumulatePupil(out, mask, spec, samples, fft2d, weight, onProgress, progressBase, progressSpan) {
    const n = spec.n;
    const steps = samples.nm.length;
    const lambdaRefNm = spec.spectrum.nm1;
    const centre = n / 2;

    // Defocus as a wavefront error at the pupil edge. A longitudinal focus shift dz in a
    // beam of focal ratio F puts W20 = dz / (8 F^2) of optical path error at the rim; the
    // phase that costs is 2*pi*W20/lambda, and it is what makes defocus wavelength dependent.
    const F = spec.optics.focalM / spec.optics.apertureM;
    const W20m = (spec.defocusUm * 1e-6) / (8 * F * F);
    const inFocus = spec.defocusUm === 0;

    let cachedI = inFocus ? intensityFromPupil(fft2d, mask, n, spec.fill, 0) : null;

    // A per-stop flux normaliser, so two stops combine on equal terms rather than by how
    // much area each happens to transmit.
    let stopTotal = 0;
    const stopBuf = new Float64Array(n * n * 3);

    for (let i = 0; i < steps; i++) {
        const lambdaNm = samples.nm[i];
        const I = inFocus
            ? cachedI
            : intensityFromPupil(fft2d, mask, n, spec.fill, (2 * Math.PI * W20m) / (lambdaNm * 1e-9));

        // The output grid is pitched for the LONGEST wavelength, so every other wavelength
        // is read from further out in the transform - which is exactly the statement that a
        // shorter wavelength diffracts less and its pattern is more compact.
        const k = lambdaRefNm / lambdaNm;
        const flux = k * k;                       // resampling shrinks area by 1/k^2
        const cr = samples.rgb[i * 3] * flux;
        const cg = samples.rgb[i * 3 + 1] * flux;
        const cb = samples.rgb[i * 3 + 2] * flux;

        for (let y = 0; y < n; y++) {
            const sy = (y - centre) * k + centre;
            for (let x = 0; x < n; x++) {
                const v = sampleBilinear(I, n, (x - centre) * k + centre, sy);
                if (v === 0) continue;
                const o = (y * n + x) * 3;
                stopBuf[o] += v * cr;
                stopBuf[o + 1] += v * cg;
                stopBuf[o + 2] += v * cb;
                stopTotal += v * (cr + cg + cb);
            }
        }

        if (onProgress && (i % 4 === 3 || i === steps - 1)) {
            onProgress(progressBase + (progressSpan * (i + 1)) / steps);
        }
    }

    const norm = stopTotal > 0 ? (weight * 3) / stopTotal : 0;
    for (let i = 0, e = n * n * 3; i < e; i++) out[i] += stopBuf[i] * norm;
}

/** Compute the polychromatic PSF.
 *
 *  Returns linear-light RGB normalised so the MEAN channel sums to 1 over the whole array -
 *  i.e. the PSF is an energy-preserving convolution kernel. That is what makes it directly
 *  usable as a glare kernel: splatting it, scaled by a source's brightness, neither creates
 *  nor destroys light. */
export function computePSF(spec, onProgress = null) {
    const t0 = (typeof performance !== "undefined" ? performance : Date).now();
    const n = spec.n;
    const fft2d = new FFT2D(n);
    const samples = buildSpectralSamples(
        spec.spectrum.nm0, spec.spectrum.nm1, spec.spectrum.steps,
        spec.spectrum.kind, spec.spectrum.kelvin);

    const rgb = new Float64Array(n * n * 3);
    const masks = [];

    const active = spec.stops.filter((s) => s.enabled !== false);
    if (active.length === 0) {
        return { n, rgb: new Float32Array(n * n * 3), masks: [], peak: 0,
                 sampling: describeSampling(spec), ms: 0, empty: true };
    }

    if (spec.combine === "intersect" && active.length > 1) {
        // Both stops treated as ONE pupil: the beam has to get through both, so the
        // transmissions multiply. Physically right only when the stops sit in the same
        // plane - see the note in the UI.
        const merged = rasterStop(active[0], n, spec.fill, spec.supersample);
        for (let s = 1; s < active.length; s++) {
            const m = rasterStop(active[s], n, spec.fill, spec.supersample);
            for (let i = 0; i < merged.length; i++) merged[i] *= m[i];
        }
        masks.push(merged);
        accumulatePupil(rgb, merged, spec, samples, fft2d, 1, onProgress, 0, 1);
    } else {
        const span = 1 / active.length;
        for (let s = 0; s < active.length; s++) {
            const mask = rasterStop(active[s], n, spec.fill, spec.supersample);
            masks.push(mask);
            accumulatePupil(rgb, mask, spec, samples, fft2d,
                            active[s].weight ?? 1, onProgress, s * span, span);
        }
    }

    // Final flux normalisation. Each stop was already normalised to its own weight, so a
    // two-stop model would otherwise total 2 and a one-stop model 1 - and the whole point of
    // this array is to be an ENERGY-PRESERVING convolution kernel, whatever it is made of.
    let total = 0;
    for (let i = 0, e = n * n; i < e; i++) total += (rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 3;
    const k = total > 0 ? 1 / total : 0;

    let peak = 0;
    const out = new Float32Array(n * n * 3);
    for (let i = 0, e = n * n; i < e; i++) {
        const r = rgb[i * 3] * k, g = rgb[i * 3 + 1] * k, b = rgb[i * 3 + 2] * k;
        out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = b;
        const m = (r + g + b) / 3;
        if (m > peak) peak = m;
    }

    const now = (typeof performance !== "undefined" ? performance : Date).now();
    return { n, rgb: out, masks, peak, sampling: describeSampling(spec), ms: now - t0 };
}
