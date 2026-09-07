// Wavelength -> linear sRGB, and the source spectra that weight the polychromatic sum.
//
// The rainbow in a diffraction spike is not decoration: the pattern's radius scales with
// wavelength, so a spike is literally a spectrum smeared along its own length. Getting the
// colour right therefore needs a real colour-matching function, not a hue ramp.
//
// The CIE 1931 2-degree observer is used through the multi-lobe piecewise-Gaussian fit of
// Wyman, Sloan & Shirley (JCGT 2013). It is accurate to about 1% of peak across 360-830 nm,
// which is far inside the error of everything else in this model, and it is a closed form -
// no 471-row table to ship and interpolate.

/** Piecewise Gaussian: sigma1 below the mean, sigma2 above. The building block of the fit. */
function pieceGauss(x, mu, s1, s2) {
    const t = (x - mu) * (x < mu ? 1 / s1 : 1 / s2);
    return Math.exp(-0.5 * t * t);
}

/** CIE 1931 2-degree colour matching functions at wavelength `nm`. */
export function cieXYZ(nm) {
    const x = 1.056 * pieceGauss(nm, 599.8, 37.9, 31.0)
            + 0.362 * pieceGauss(nm, 442.0, 16.0, 26.7)
            - 0.065 * pieceGauss(nm, 501.1, 20.4, 26.2);
    const y = 0.821 * pieceGauss(nm, 568.8, 46.9, 40.5)
            + 0.286 * pieceGauss(nm, 530.9, 16.3, 31.1);
    const z = 1.217 * pieceGauss(nm, 437.0, 11.8, 36.0)
            + 0.681 * pieceGauss(nm, 459.0, 26.0, 13.8);
    return [x, y, z];
}

/** CIE XYZ (D65 white point) to LINEAR sRGB. Not gamma encoded - the PSF is summed in
 *  linear light and only gamma-encoded at the very end, in the display step. */
export function xyzToLinearRGB([X, Y, Z]) {
    return [
         3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
        -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z,
         0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
    ];
}

/** Linear sRGB for a single wavelength. Negative components (spectral colours outside the
 *  sRGB gamut, which most of them are) are clamped at zero: the alternative is a channel
 *  that subtracts light from its neighbours in the sum, which shows up as black fringes. */
export function wavelengthToRGB(nm) {
    const rgb = xyzToLinearRGB(cieXYZ(nm));
    return [Math.max(0, rgb[0]), Math.max(0, rgb[1]), Math.max(0, rgb[2])];
}

/** Planck spectral radiance, arbitrary scale - only the SHAPE across the band matters here. */
export function planck(nm, kelvin) {
    const l = nm * 1e-9;
    const c1 = 3.7418e-16, c2 = 1.4388e-2;           // 2hc^2 and hc/k, SI
    return c1 / (Math.pow(l, 5) * (Math.exp(c2 / (l * kelvin)) - 1));
}

/** Relative spectral weight of the SOURCE at `nm`.
 *
 *  `flat` matches Maskulator, which weights every sampled wavelength equally. It is not a
 *  physical source, but it is the reference this tool is trying to reproduce, so it stays
 *  the default. `blackbody` is what an incandescent lamp, an engine or a flare actually
 *  emits, and it is the honest choice when matching real footage. */
export function spectrumWeight(nm, spectrum, kelvin) {
    switch (spectrum) {
        case "blackbody": return planck(nm, kelvin);
        case "flat":
        default:          return 1;
    }
}

/** The `steps` sample wavelengths spanning [nm0, nm1], each with its linear-sRGB colour and
 *  source weight already multiplied together.
 *
 *  Returns { nm, rgb } where rgb[i] is the 3-vector this wavelength contributes per unit of
 *  diffracted intensity, normalised so that the FULL band integrates to neutral white. That
 *  normalisation is what makes an undiffracted white source render white rather than the
 *  green cast you get from summing raw colour matching functions. */
export function buildSpectralSamples(nm0, nm1, steps, spectrum = "flat", kelvin = 5500) {
    const nm = new Float64Array(steps);
    const rgb = new Float64Array(steps * 3);
    const sum = [0, 0, 0];

    for (let i = 0; i < steps; i++) {
        // Sample at bin CENTRES. Sampling at the endpoints double-counts the band edges and,
        // with a small `steps`, visibly biases the tint of the outer spike toward deep red.
        const l = steps === 1 ? 0.5 * (nm0 + nm1) : nm0 + ((i + 0.5) * (nm1 - nm0)) / steps;
        const w = spectrumWeight(l, spectrum, kelvin);
        const c = wavelengthToRGB(l);
        nm[i] = l;
        for (let k = 0; k < 3; k++) { rgb[i * 3 + k] = c[k] * w; sum[k] += c[k] * w; }
    }

    // White balance: scale each channel so the summed band is neutral. Anchored on the
    // brightest channel so the result only ever darkens channels, never invents energy.
    const peak = Math.max(sum[0], sum[1], sum[2], 1e-12);
    const gain = [peak / Math.max(sum[0], 1e-12), peak / Math.max(sum[1], 1e-12), peak / Math.max(sum[2], 1e-12)];
    for (let i = 0; i < steps; i++) for (let k = 0; k < 3; k++) rgb[i * 3 + k] *= gain[k];

    return { nm, rgb };
}
