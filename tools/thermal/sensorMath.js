import {PHOTON_SCALE, inBandRadiance, radianceDerivative} from "./radiometry.js";
import {BANDS, createAtmosphere, evaluatePath} from "./atmosphere.js";
import {turbulenceMTF} from "./turbulence.js";
import {SENSOR_PRESETS} from "./sensorPresets.js";

// Images are row-major Float32Array; dimensions and kernel coordinates are pixels.
// Kernels are dimensionless, unit-sum weights. Convolution preserves input units.
// Scalar clamp/sum retain the input unit; nextPow2 takes a sample count.
export const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
export const sum = values => values.reduce((total, value) => total + value, 0);
export const nextPow2 = n => 2 ** Math.ceil(Math.log2(Math.max(2, n)));
export const deltaKernel = () => ({width: 1, height: 1, data: new Float32Array([1])});
/** data contains dimensionless weights; width/height are kernel samples. */
export function normalized(data, width, height = width) {
    const total = sum(data);
    if (!(total > 0)) throw new Error("Kernel must have positive integral");
    return {width, height, data: Float32Array.from(data, v => v / total), rawSum: total};
}

// Radix-2 row/column FFT, adapted from tools/psf/fft.js .
// re/im carry the same input unit; inverse is a boolean. Inverse restores amplitude.
function fft1(re, im, inverse) {
    const n = re.length;
    for (let index = 1, sample = 0; index < n; index++) {
        let bit = n >> 1;
        for (; sample & bit; bit >>= 1) sample ^= bit;
        sample ^= bit;
        if (index < sample) { [re[index], re[sample]] = [re[sample], re[index]]; [im[index], im[sample]] = [im[sample], im[index]]; }
    }
    for (let len = 2; len <= n; len *= 2) {
        const angle = (inverse ? 2 : -2) * Math.PI / len;
        const wr0 = Math.cos(angle), wi0 = Math.sin(angle);
        for (let base = 0; base < n; base += len) {
            let wr = 1, wi = 0;
            for (let sample = 0; sample < len / 2; sample++) {
                const a = base + sample, b = a + len / 2;
                const tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
                re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
                const t = wr * wr0 - wi * wi0; wi = wr * wi0 + wi * wr0; wr = t;
            }
        }
    }
    if (inverse) for (let index = 0; index < n; index++) { re[index] /= n; im[index] /= n; }
}
// re/im are square complex arrays in input units; n is samples per side.
function fft2(re, im, n, inverse = false) {
    for (let y = 0; y < n; y++) fft1(re.subarray(y*n, (y+1)*n), im.subarray(y*n, (y+1)*n), inverse);
    const cr = new Float64Array(n), ci = new Float64Array(n);
    for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) { cr[y] = re[y*n+x]; ci[y] = im[y*n+x]; }
        fft1(cr, ci, inverse);
        for (let y = 0; y < n; y++) { re[y*n+x] = cr[y]; im[y*n+x] = ci[y]; }
    }
}
/** Linear convolution; zero exterior is physical crop loss. 'wrap' is only a periodic test/scene.
 * image is scalar input in any linear unit, width/height pixels, kernel unit-sum.
 * Small kernels use direct convolution, larger ones zero-padded FFTs. Never renormalize edges.
 */
export function convolve(image, width, height, kernel, boundary = "zero") {
    const {width: kernelWidth, height: kernelHeight, data: weights} = kernel;
    if (image.length !== width*height) throw new Error("Image shape mismatch");
    const centerX = Math.floor(kernelWidth/2), centerY = Math.floor(kernelHeight/2), output = new Float32Array(width*height);
    if (kernelWidth*kernelHeight <= 81 || boundary === "wrap") {
        for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
            let value = 0;
            for (let sample = 0; sample < kernelHeight; sample++) for (let index = 0; index < kernelWidth; index++) {
                let sourceX = column+centerX-index, sourceY = row+centerY-sample;
                if (boundary === "wrap") { sourceX = (sourceX%width+width)%width; sourceY = (sourceY%height+height)%height; }
                if (sourceX >= 0 && sourceX < width && sourceY >= 0 && sourceY < height) value += image[sourceY*width+sourceX]*weights[sample*kernelWidth+index];
            }
            output[row*width+column] = value;
        }
        return output;
    }
    const n = nextPow2(Math.max(width+kernelWidth-1, height+kernelHeight-1));
    const ar = new Float64Array(n*n), ai = new Float64Array(n*n);
    const kr = new Float64Array(n*n), ki = new Float64Array(n*n);
    for (let row = 0; row < height; row++) ar.set(image.subarray(row*width,(row+1)*width), row*n);
    for (let row = 0; row < kernelHeight; row++) kr.set(weights.subarray(row*kernelWidth,(row+1)*kernelWidth), row*n);
    fft2(ar, ai, n); fft2(kr, ki, n);
    for (let index = 0; index < ar.length; index++) {
        const t = ar[index]*kr[index]-ai[index]*ki[index]; ai[index] = ar[index]*ki[index]+ai[index]*kr[index]; ar[index] = t;
    }
    fft2(ar, ai, n, true);
    for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) output[row*width+column] = ar[(row+centerY)*n+column+centerX];
    return output;
}

/** Bessel J1 by a power series and a Hankel asymptotic expansion; x is dimensionless.
 * Calculated coefficients: c[k] = (-1)^k/(k! (k+1)!) for (x/2) sum c[k](x*x/4)^k;
 * a[0] = 1, a[k] = a[k-1]*(4-(2*k-1)^2)/(8*k) for the asymptotic expansion.
 * Calculated switch |x| = 11: the 24-term power series has an alternating tail
 * below 2e-13. Its absolute term sum is below 6950, so coefficient, argument and
 * Horner rounding are bounded by 72*u*6950 < 5.6e-11 (u = 2^-53).
 * Keeping a[0..17] gives a large-argument remainder bounded by
 * sqrt(2/(pi*x))*(|a[18]|/x^18 + |a[19]|/x^19) < 3.6e-11 at x = 11,
 * decreasing thereafter. These bounds leave room for trigonometric roundoff
 * in the tested absolute error budget of 1e-10 over |x| <= 2000.
 * Horner evaluation avoids per-call coefficient generation and allocation.
 */
export function j1(x) {
    if (x === 0) return x;
    const ax = Math.abs(x);
    if (ax < 11) {
        const y = x * x / 4;
        let p = -6.234475195398757e-47;
        p = 3.4414303078601135e-44 + y * p;
        p = -1.7413637357772174e-41 + y * p;
        p = 8.045100459290744e-39 + y * p;
        p = -3.3789421929021126e-36 + y * p;
        p = 1.2839980333028028e-33 + y * p;
        p = -4.391273273895586e-31 + y * p;
        p = 1.3437296218120491e-28 + y * p;
        p = -3.654944571328774e-26 + y * p;
        p = 8.771866971189057e-24 + y * p;
        p = -1.842092063949702e-21 + y * p;
        p = 3.352607556388458e-19 + y * p;
        p = -5.230067787965994e-17 + y * p;
        p = 6.903689480115112e-15 + y * p;
        p = -7.594058428126623e-13 + y * p;
        p = 6.834652585313961e-11 + y * p;
        p = -4.920949861426052e-09 + y * p;
        p = 2.755731922398589e-07 + y * p;
        p = -1.1574074074074073e-05 + y * p;
        p = 0.00034722222222222224 + y * p;
        p = -0.006944444444444444 + y * p;
        p = 0.08333333333333333 + y * p;
        p = -0.5 + y * p;
        p = 1.0 + y * p;
        return (x / 2) * p;
    }
    const inverse = 1 / ax, y = inverse * inverse;
    let p = -6656367.718817688;
    p = 127641.2726461746 + y * p;
    p = -3302.2722944808525 + y * p;
    p = 121.59789187653587 + y * p;
    p = -6.883914268109947 + y * p;
    p = 0.6765925884246826 + y * p;
    p = -0.144195556640625 + y * p;
    p = 0.1171875 + y * p;
    p = 1.0 + y * p;
    let q = 53104110.10968523;
    q = -890297.8767070678 + y * q;
    q = 19718.37591223663 + y * q;
    q = -603.8440767050702 + y * q;
    q = 27.248827311268542 + y * q;
    q = -1.993531733751297 + y * q;
    q = 0.2775764465332031 + y * q;
    q = -0.1025390625 + y * q;
    q = 0.375 + y * q;
    const phase = ax - 3 * Math.PI / 4;
    const value = Math.sqrt(2 / (Math.PI * ax)) *
        (Math.cos(phase) * p - inverse * Math.sin(phase) * q);
    return x < 0 ? -value : value;
}
/** Monochromatic diffraction kernel. Circular/annular analytic path retains clean faint wings.
 * Aberrations use |FFT(pupil exp(i 2 pi OPD/lambda))|^2 as in tools/psf/psf.js.
 * sensor pitchM/focalM/apertureM and wavelengthM are m; s is fine samples/pixel.
 * radiusPx is detector pixels; obstruction and pupilFill are dimensionless.
 * defocusM = longitudinal detector displacement [m]; astig/coma/spherical = OPD coefficients [m].
 */
export function diffractionKernel(sensor, optics, wavelengthM, s = 3) {
    const radius = Math.ceil((optics.radiusPx ?? 32)*s), size = 2*radius+1;
    const eps = optics.obstruction ?? 0, F = sensor.focalM/sensor.apertureM;
    if (eps < 0 || eps >= 1) throw new Error("Obstruction must be in [0,1)");
    const dp = sensor.pitchM/s, data = new Float64Array(size*size);
    const useFFT = (optics.defocusM || optics.astigM || optics.comaM || optics.sphericalM);
    if (!useFFT) {
        const scale = Math.PI/(wavelengthM*F);
        const density = Math.PI*(1-eps*eps)/(4*(wavelengthM*F)**2);
        for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
            const u = Math.hypot(x,y)*dp*scale;
            const amp = u < 1e-8 ? 1 : 2*(j1(u)-eps*j1(eps*u))/(u*(1-eps*eps));
            data[(y+radius)*size+x+radius] = amp*amp*density*dp*dp;
        }
        return {...normalized(data, size), method: "annular Airy", retainedFractionEstimate: sum(data)};
    }
    // Calculated matched focal-plane grid: lambda*F*fill = dp. No intensity
    // interpolation is needed at the default fill; <= 0.5 at optical Nyquist.
    const n = optics.pupilGrid ?? 512, fill = optics.pupilFill ?? dp / (wavelengthM * F);
    if (!(fill > 0 && fill <= 1)) throw new RangeError("Pupil sampling requires a finer optical grid");
    if (n !== nextPow2(n)) throw new Error("pupilGrid must be a power of two");
    const re = new Float64Array(n*n), im = new Float64Array(n*n), pr = fill*n/2;
    // Supersampled complex pupil: same edge convention as tools/psf/aperture.js.
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
            const xx = (x-n/2+(sx-0.5)/2)/pr, yy = (y-n/2+(sy-0.5)/2)/pr;
            const r2 = xx*xx+yy*yy;
            if (r2 > 1 || r2 < eps*eps) continue;
            const opd = (optics.defocusM ?? 0)/(8*F*F)*r2 + (optics.astigM ?? 0)*(xx*xx-yy*yy) +
                (optics.comaM ?? 0)*xx*(3*r2-2) + (optics.sphericalM ?? 0)*(6*r2*r2-6*r2+1);
            const phase = 2*Math.PI*opd/wavelengthM;
            re[y*n+x] += Math.cos(phase)/4; im[y*n+x] += Math.sin(phase)/4;
        }
    }
    fft2(re, im, n);
    const intensity = new Float64Array(n*n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const index = ((y+n/2)%n)*n+(x+n/2)%n;
        intensity[y*n+x] = re[index]*re[index]+im[index]*im[index];
    }
    const total = sum(intensity), scale = dp/(wavelengthM*F*fill);
    if (radius*scale >= n/2-1) throw new Error("Pupil FFT field too small; increase pupilGrid or pupilFill");
    for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
        data[(y+radius)*size+x+radius] = bilinear(intensity,n,n,x*scale+n/2,y*scale+n/2)*scale*scale/total;
    }
    return {...normalized(data,size), method: "complex pupil FFT", retainedFractionEstimate: sum(data)};
}
// a has arbitrary scalar units, w/h integer pixels, x/y fractional pixel coordinates.
export function bilinear(a,w,h,x,y) {
    if (x < 0 || y < 0 || x > w-1 || y > h-1) return 0;
    const ix = Math.floor(x), iy = Math.floor(y), jx = Math.min(ix+1,w-1), jy = Math.min(iy+1,h-1);
    const fx = x-ix, fy = y-iy;
    return (1-fy)*((1-fx)*a[iy*w+ix]+fx*a[iy*w+jx])+fy*((1-fx)*a[jy*w+ix]+fx*a[jy*w+jx]);
}
// sigmaPx and radiusPx are pixels; horizontal selects a 1D kernel. Output weights sum to 1.
export function gaussianKernel(sigmaPx, radiusPx = Math.ceil(4*sigmaPx), horizontal = false) {
    if (!(sigmaPx > 0)) return deltaKernel();
    const size = 2*radiusPx+1, height = horizontal ? 1 : size;
    const data = new Float64Array(size*height);
    for (let y = 0; y < height; y++) for (let x = 0; x < size; x++) {
        data[y*size+x] = Math.exp(-((x-radiusPx)**2+(horizontal?0:(y-radiusPx)**2))/(2*sigmaPx*sigmaPx));
    }
    return normalized(data,size,height);
}

/** Apply a continuous angular MTF to a sampled PSF; frequency is cycles/radian.
 * Calculated numerical policy: pad to at least twice the kernel width, transform,
 * multiply, inverse, retain the requested support and normalize its finite tail.
 * Padding prevents the opposite core edge from wrapping directly into the crop.
 * Tiny negative FFT/ringing residuals are clipped; retainedFraction reports loss.
 */
export function filterKernelMTF(kernel, angularStepRad, mtf, radius = (kernel.width - 1) / 2) {
    const size = 2 * radius + 1, n = nextPow2(2 * Math.max(size, kernel.width, kernel.height));
    const re = new Float64Array(n * n), im = new Float64Array(n * n);
    const cx = Math.floor(kernel.width / 2), cy = Math.floor(kernel.height / 2);
    for (let y = 0; y < kernel.height; y++) for (let x = 0; x < kernel.width; x++)
        re[((y - cy + n) % n) * n + (x - cx + n) % n] = kernel.data[y * kernel.width + x];
    fft2(re, im, n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const fx = Math.min(x, n - x) / (n * angularStepRad);
        const fy = Math.min(y, n - y) / (n * angularStepRad);
        const transfer = mtf(Math.hypot(fx, fy), fx, fy), i = y * n + x;
        re[i] *= transfer; im[i] *= transfer;
    }
    fft2(re, im, n, true);
    const data = new Float64Array(size * size);
    for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++)
        data[(y + radius) * size + x + radius] = Math.max(0, re[((y + n) % n) * n + (x + n) % n]);
    return {...normalized(data, size), retainedFraction: sum(data), method: "padded MTF"};
}

// Calculated support policy: the chosen core radius for diffraction/turbulence;
// at least four combined Gaussian sigmas for residual system blur, jitter and
// charge diffusion. Units fine pixels.
export function opticalCoreRadius(settings) {
    const angularPixel = settings.pixelPitchM / settings.focalLengthM;
    const sigmaPx = Math.max(...Object.values(gaussianBlurRmsRad(settings))) / angularPixel;
    return Math.ceil(Math.max(settings.opticsEnabled || settings.turbulenceR0M > 0 ? settings.opticsRadiusPx : 0,
        4 * sigmaPx) * settings.supersample);
}
/** Combined RMS in rad per detector axis, from independent residual, exposure
 * jitter and diffusion variances. Turbulence retains its separate spectral MTF.
 * Legacy scalar inputs apply equally to x and y, only when that axis is absent.
 */
export function gaussianBlurRmsRad(settings) {
    const jitter = (settings.jitterRmsUrad ?? 0) * 1e-6;
    const diffusion = (settings.diffusionSigmaPx ?? 0) * settings.pixelPitchM / settings.focalLengthM;
    return Object.fromEntries([["horizontal", "systemBlurHorizontalRmsUrad"], ["vertical", "systemBlurVerticalRmsUrad"]]
        .map(([axis, key]) => [axis, Math.hypot((settings[key] ?? settings.systemBlurRmsUrad ?? 0) * 1e-6, jitter, diffusion)]));
}
/** Scatter redistributes a fraction tis of transmitted flux. Angular shoulder/cutoff are rad.
 * S(r) = [1+(theta/theta0)^2]^(-slope/2), zero beyond thetaMax.
 * A finite cutoff is REQUIRED: slope <= 2 is not integrable on the infinite plane.
 * sensor pitchM/focalM are m, s is samples/pixel, all fractions and slope unitless.
 * The default skirt shape and ghost geometry are estimates.
 * ghostFraction moves flux to a shifted Gaussian surrogate; no optical ray trace is claimed.
 */
export function scatterKernel(sensor, scatter, s) {
    const tis = scatter.tis ?? 0, ghost = scatter.ghostFraction ?? 0;
    if (tis < 0 || ghost < 0 || tis+ghost > 1) throw new Error("Invalid scatter/ghost fractions");
    if (!tis && !ghost) return deltaKernel();
    const ang = sensor.pitchM/(sensor.focalM*s);
    const cutoff = scatter.cutoffRad ?? 0.001, shoulder = scatter.shoulderRad ?? 0.00004;
    const slope = scatter.slope ?? 2.5;
    const gx = (scatter.ghostOffsetRadX ?? 0)/ang, gy = (scatter.ghostOffsetRadY ?? 0)/ang;
    const gs = (scatter.ghostSigmaRad ?? shoulder)/ang;
    const r = Math.ceil(Math.max(cutoff/ang, ghost ? Math.max(Math.abs(gx),Math.abs(gy))+4*gs : 0));
    const n = 2*r+1, a = new Float64Array(n*n), b = new Float64Array(n*n);
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
        const index = (y+r)*n+x+r, theta = Math.hypot(x,y)*ang;
        a[index] = theta <= cutoff ? (1+(theta/shoulder)**2)**(-slope/2) : 0;
        b[index] = Math.exp(-((x-gx)**2+(y-gy)**2)/(2*gs*gs));
    }
    const sa = sum(a), sb = sum(b);
    for (let index = 0; index < a.length; index++) a[index] = tis*a[index]/sa+ghost*b[index]/sb;
    a[r*n+r] += 1-tis-ghost;
    return normalized(a,n);
}
/** s is fine samples/pixel, fillFactor an area fraction. Unit-sum pixel footprint. Absolute sensitive area is handled in electronsPerRadiance(). */
export function footprintKernel(s, fillFactor = 1) {
    if (!Number.isInteger(s) || s < 1) throw new Error("Use integer oversample");
    if (!(fillFactor > 0 && fillFactor <= 1)) throw new Error("Invalid fill factor");
    const side = Math.sqrt(fillFactor)*s, a = new Float64Array(s*s), c = (s-1)/2;
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        const overlap = v => Math.max(0, Math.min(v-c+0.5,side/2)-Math.max(v-c-0.5,-side/2));
        a[y*s+x] = overlap(x)*overlap(y);
    }
    return normalized(a,s);
}
// a is fine-grid radiance in any linear unit; w/h fine pixels, s samples/native pixel.
// Output is native-grid radiance in the same unit; fillFactor is an active area fraction.
export function sampleDetector(a, w, h, s, fillFactor = 1) {
    if (w%s || h%s) throw new Error("Fine image must be divisible by oversample");
    const out = new Float32Array(w*h/(s*s)), k = footprintKernel(s,fillFactor).data, ow = w/s;
    for (let y = 0; y < h/s; y++) for (let x = 0; x < ow; x++) {
        let v = 0;
        for (let sample = 0; sample < s; sample++) for (let index = 0; index < s; index++) v += a[(y*s+sample)*w+x*s+index]*k[sample*s+index];
        out[y*ow+x] = v;
    }
    return out;
}
// fraction is dimensionless neighbor coupling; returned weights are unit-sum.
export function crosstalkKernel(fraction = 0) {
    if (fraction < 0 || fraction > 1) throw new Error("Invalid crosstalk fraction");
    return {width:3,height:3,data:new Float32Array([0,fraction/4,0,fraction/4,1-fraction,fraction/4,0,fraction/4,0])};
}

export const ADC_MAX = 16383;
export const DISPLAY_MAX = 255;

/** Validate a scalar Float32 image. width/height, when given, are pixel counts. */
export function validateImage(image, width = image?.length, height = 1) {
    if (!(image instanceof Float32Array) || image.length !== width * height || !image.length)
        throw new RangeError("Expected a nonempty Float32Array with matching image dimensions");
    for (const value of image) if (!Number.isFinite(value)) throw new RangeError("Image contains a non-finite value");
}

/** settings use the thermal schema's SI units. Return electrons/pixel/exposure per
 * stored radiance unit (1e20 photons s^-1 m^-2 sr^-1). QE is electrons/photon.
 */
export function electronRatePerRadiance(settings) {
    if (settings.apertureM > 2 * settings.focalLengthM) throw new RangeError("Pupil aperture exceeds numerical aperture one");
    const pupilSolidAngle = Math.PI / 4 * (settings.apertureM / settings.focalLengthM) ** 2;
    return PHOTON_SCALE * settings.pixelPitchM ** 2 * settings.fillFactor * pupilSolidAngle *
        settings.opticalTransmission * settings.quantumEfficiency;
}

/** Calculated exposure in seconds. Reference charge includes mean dark current,
 * before its subtraction. The reference is an unshaded blackbody at the detector
 * input, not a surface viewed through the atmosphere. No frame-rate clamp is
 * inferred from unknown hardware; a host can compare this time with its cadence.
 */
export function integrationTime(settings) {
    if (settings.exposureMode !== "wellFill") return settings.integrationTimeS;
    const reference = inBandRadiance(settings.wellFillReferenceK,
        {minUm: settings.bandMinUm, maxUm: settings.bandMaxUm}).photon / PHOTON_SCALE;
    const rate = reference * electronRatePerRadiance(settings);
    if (!(rate > 0)) throw new RangeError("Reference well-fill exposure requires nonzero photon throughput");
    return settings.wellFillFraction * settings.wellElectrons / (rate + settings.darkElectronsPerS);
}
export function electronsPerRadiance(settings) {
    return electronRatePerRadiance(settings) * integrationTime(settings);
}

/** Equivalent kelvins at 300 K. Pixel centers use native detector coordinates;
 * radius is divided by the geometric detector half-width, including on a rectangle.
 * Estimated residual optical shading, from published studies.
 */
export function shadingTemperature(x, y, width, height, amplitudeK = 0.3, radialWidth = 0.9) {
    const radiusSquared = ((x + 0.5 - width / 2) ** 2 + (y + 0.5 - height / 2) ** 2) / (width / 2) ** 2;
    return amplitudeK * -Math.expm1(-radiusSquared / (2 * radialWidth ** 2)) /
        -Math.expm1(-1 / (2 * radialWidth ** 2));
}
/** Fixed reference responsivity, scaled photon radiance / K. */
export function shadingResponsivity(settings) {
    return radianceDerivative(300, {minUm: settings.bandMinUm, maxUm: settings.bandMaxUm}).photon / PHOTON_SCALE;
}
/** Detector-input signal offset, before exposure, in scaled photon radiance. */
export function shadingMap(settings, width = settings.detectorWidth, height = settings.detectorHeight) {
    const responsivity = shadingResponsivity(settings);
    return Float32Array.from({length: width * height}, (_, pixel) => responsivity *
        shadingTemperature(pixel % width, Math.floor(pixel / width), width, height, settings.shadingK ?? 0, settings.shadingWidth ?? 0.9));
}
/** Fixed pixel offset in ADC counts (before rounding/clipping). Independent stream
 * from temporal shot/read noise; frame is deliberately absent. Estimated RMS prior
 * from a published detector study: .0001–.0004 of ADC range, default .0002.
 */
export function fixedPatternMap(settings, length = settings.detectorWidth * settings.detectorHeight) {
    return Float32Array.from({length}, (_, pixel) => (settings.fixedPatternFraction ?? 0) * ADC_MAX *
        normal(randomSequence(pixelSeed(pixel, 0, settings.noiseSeed ^ 0x68bc21eb))));
}

/** radiance is scaled photon radiance; factor is electrons per scaled unit; dark is
 * electrons/pixel/exposure. Output is the nonnegative expected charge, electrons.
 */
export function exposureToElectrons(radiance, factor, dark = 0) {
    validateImage(radiance);
    if (!(Number.isFinite(factor) && factor >= 0 && Number.isFinite(dark) && dark >= 0))
        throw new RangeError("Exposure factor and dark charge must be finite and nonnegative");
    return Float32Array.from(radiance, value => Math.max(0, value * factor) + dark);
}

/** Unsigned integer seed -> a deterministic uniform variate in (0,1).
 * Integer arithmetic is identical to the GLSL implementation. A 23-bit midpoint
 * avoids log(0) and is exactly representable by a highp shader float.
 */
export function randomSequence(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x9e3779b9) >>> 0;
        let bits = state;
        bits = Math.imul(bits ^ (bits >>> 16), 0x21f0aaad) >>> 0;
        bits = Math.imul(bits ^ (bits >>> 15), 0x735a2d97) >>> 0;
        bits = (bits ^ (bits >>> 15)) >>> 0;
        return ((bits >>> 9) + 0.5) / 8388608;
    };
}
/** pixel/frame/seed are unitless integers; independent stream for each detector pixel. */
export function pixelSeed(pixel, frame, seed) {
    return ((seed >>> 0) ^ Math.imul((pixel + 1) >>> 0, 0x85ebca6b) ^ Math.imul(frame >>> 0, 0xc2b2ae35)) >>> 0;
}
/** random() is uniform (0,1); returns a dimensionless standard normal sample. */
export function normal(random) {
    return Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());
}
/** mean is electrons. Exact product sampler below 64; rounded normal above.
 * The bounded loop mirrors GLSL; 512 draws is beyond the 23-bit RNG's possible
 * practical Poisson tail at these means. High-count output is nonnegative.
 */
export function poisson(mean, random) {
    if (mean <= 0) return 0;
    if (mean >= 64) return Math.max(0, Math.floor(mean + Math.sqrt(mean) * normal(random) + 0.5));
    const limit = Math.exp(-mean);
    let product = 1;
    for (let draw = 0; draw < 512; draw++) {
        product *= random();
        if (product <= limit) return draw;
    }
    return 511;
}
/** Charge image in electrons, frame/seed unitless. Does not clip the well. */
export function shotNoise(electrons, frame = 0, seed = 12345) {
    validateImage(electrons);
    return Float32Array.from(electrons, (mean, pixel) => poisson(mean, randomSequence(pixelSeed(pixel, frame, seed))));
}
/** Charge and well in electrons. Negative charge drains; no charge spill model. */
export function wellLimit(electrons, wellElectrons) {
    validateImage(electrons);
    if (!(Number.isFinite(wellElectrons) && wellElectrons > 0)) throw new RangeError("Well capacity must be positive");
    return Float32Array.from(electrons, value => clamp(value, 0, wellElectrons));
}
/** Electrons and sigma in electrons. Independent stream from the shot-noise stream. */
export function readNoise(electrons, sigma, frame = 0, seed = 12345) {
    validateImage(electrons);
    if (!(Number.isFinite(sigma) && sigma >= 0)) throw new RangeError("Read noise must be nonnegative");
    return Float32Array.from(electrons, (value, pixel) => value + sigma * normal(randomSequence(pixelSeed(pixel, frame, seed ^ 0xa511e9b3))));
}
/** Electrons/full scale plus an electronic offset [counts] -> rounded, clamped
 * 14-bit codes stored as Float32. Raw output retains the offset. */
export function quantizeADC(electrons, fullScaleElectrons, offsetCounts = 0) {
    if (!(Number.isFinite(fullScaleElectrons) && fullScaleElectrons > 0)) throw new RangeError("ADC full scale must be positive");
    return Float32Array.from(electrons, value => Math.floor(clamp(value / fullScaleElectrons * ADC_MAX + offsetCounts, 0, ADC_MAX) + 0.5));
}
/** Scaled photon radiance -> native 14-bit counts. Photon and dark shot noise precede
 * well clipping; mean dark subtraction and read noise follow it. frame is an integer.
 */
export function detectorCounts(radiance, settings, frame = 0) {
    const dark = settings.darkElectronsPerS * integrationTime(settings);
    // Scalar/short calibration arrays retain their supplied shape; a full native
    // raster is required when applying spatial shading.
    let signal = radiance;
    if (settings.shadingK) {
        validateImage(radiance, settings.detectorWidth, settings.detectorHeight);
        const offsets = shadingMap(settings);
        signal = Float32Array.from(radiance, (value, pixel) => value + offsets[pixel]);
    }
    let charge = exposureToElectrons(signal, electronsPerRadiance(settings), dark);
    if (settings.noiseEnabled && settings.shotNoiseEnabled) charge = shotNoise(charge, frame, settings.noiseSeed);
    charge = wellLimit(charge, settings.wellElectrons);
    charge = Float32Array.from(charge, value => value - dark);
    if (settings.noiseEnabled) charge = readNoise(charge, settings.readNoiseElectrons, frame, settings.noiseSeed);
    if (settings.fixedPatternFraction) {
        const offsets = fixedPatternMap(settings, charge.length);
        charge = Float32Array.from(charge, (value, pixel) => value + offsets[pixel] * settings.wellElectrons / ADC_MAX);
    }
    return quantizeADC(charge, settings.wellElectrons, settings.adcOffsetCounts ?? 0);
}

/** ADC count image, dimensionless gain, count-valued level -> clipped display drive [0,1]. */
export function manualGainLevel(counts, gain = 1, level = ADC_MAX / 2) {
    return Float32Array.from(counts, value => clamp((value - level) * gain / ADC_MAX + 0.5));
}
/** Count image -> low/high count endpoints. Percentiles in [0,1], times in seconds.
 * previous is null or {low,high}; a zero delta preserves an existing window exactly.
 */
export function automaticWindow(counts, {lowPercentile = 0.01, highPercentile = 0.99,
    minimumSpan = 32, timeConstantS = 0, deltaTimeS = 0, dynamics = "endpoints"} = {}, previous = null) {
    validateImage(counts);
    if (!(lowPercentile >= 0 && highPercentile <= 1 && highPercentile > lowPercentile &&
        minimumSpan > 0 && Number.isFinite(minimumSpan) && timeConstantS >= 0 && Number.isFinite(timeConstantS) &&
        deltaTimeS >= 0 && Number.isFinite(deltaTimeS))) throw new RangeError("Invalid automatic window controls");
    const sorted = counts.slice().sort();
    const low = sorted[Math.floor(lowPercentile * (sorted.length - 1))];
    const high = Math.max(sorted[Math.floor(highPercentile * (sorted.length - 1))], low + minimumSpan);
    const alpha = previous ? (deltaTimeS === 0 ? 0 : timeConstantS === 0 ? 1 : -Math.expm1(-deltaTimeS / timeConstantS)) : 1;
    if (previous && dynamics === "gainOffset") {
        // Calculated affine map: drive = gain * counts + offset. Video recovery
        // constrains these displayed coefficients, not the count endpoints.
        const oldGain = 1 / (previous.high - previous.low), targetGain = 1 / (high - low);
        const gain = oldGain + alpha * (targetGain - oldGain);
        const offset = -previous.low * oldGain + alpha * (-low * targetGain + previous.low * oldGain);
        return {low: -offset / gain, high: (1 - offset) / gain};
    }
    return {low: previous ? previous.low + alpha * (low - previous.low) : low,
        high: previous ? previous.high + alpha * (high - previous.high) : high};
}
/** Counts and count-valued endpoints -> clipped, normalized display drive. */
export function windowImage(counts, {low, high}) {
    if (!(high > low)) throw new RangeError("Display window must have a positive span");
    return Float32Array.from(counts, value => clamp((value - low) / (high - low)));
}
/** Normalized drive -> a normalized lookup; countLevels selects raw ADC-count
 * indexing with one-count bins instead. Cap histogram population without
 * redistributing it; subtract the first occupied CDF value. A constant field
 * retains its original drive instead of becoming white.
 */
export function plateauLUT(drive, plateauFactor = 4, bins = 256, countLevels = false) {
    validateImage(drive);
    if (!(plateauFactor > 0 && Number.isFinite(plateauFactor) && Number.isInteger(bins) && bins >= 2)) throw new RangeError("Invalid plateau controls");
    const histogram = new Float64Array(bins), lut = new Float32Array(bins);
    for (const value of drive) histogram[countLevels ? Math.round(clamp(value, 0, bins - 1)) : Math.floor(clamp(value) * (bins - 1))]++;
    const cap = plateauFactor * drive.length / bins;
    let total = 0, first = 0, found = false;
    for (let bin = 0; bin < bins; bin++) {
        total += Math.min(histogram[bin], cap);
        lut[bin] = total;
        if (!found && histogram[bin] > 0) { first = total; found = true; }
    }
    for (let bin = 0; bin < bins; bin++) lut[bin] = total > first ? clamp((lut[bin] - first) / (total - first)) : bin / (bins - 1);
    return {values: lut, constant: total <= first};
}
/** Normalized drive and cap factor -> normalized equalized drive. */
export function plateauEqualization(drive, factor = 4, bins = 256) {
    const lut = plateauLUT(drive, factor, bins);
    if (lut.constant) return drive.slice();
    return Float32Array.from(drive, value => lut.values[Math.floor(clamp(value) * (bins - 1))]);
}
/** Normalized image, dimensions pixels, sigma pixels. Reflect neither light nor
 * detail across opposite edges: clamp the nearest edge sample for the local filter.
 */
export function localMean(image, width, height, sigmaPx) {
    validateImage(image, width, height);
    if (sigmaPx === 0) return image.slice();
    if (!(Number.isFinite(sigmaPx) && sigmaPx > 0)) throw new RangeError("Local radius must be nonnegative");
    const kernel = gaussianKernel(sigmaPx, Math.ceil(4 * sigmaPx), true);
    const radius = (kernel.width - 1) / 2;
    let input = image;
    for (const axis of [0, 1]) {
        const output = new Float32Array(image.length);
        for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
            let value = 0;
            for (let offset = -radius; offset <= radius; offset++) {
                const sourceX = clamp(column + (axis === 0 ? offset : 0), 0, width - 1);
                const sourceY = clamp(row + (axis === 1 ? offset : 0), 0, height - 1);
                value += input[sourceY * width + sourceX] * kernel.data[offset + radius];
            }
            output[row * width + column] = value;
        }
        input = output;
    }
    return input;
}
/** Drive image -> signed drive. Amount unitless, sigma detector pixels. Do not clip
 * the signed high-pass term until response/output: it causes the opposite-sign ring.
 */
export function localEnhancement(drive, width, height, amount = 0, sigmaPx = 3) {
    if (amount === 0 || sigmaPx === 0) return drive.slice();
    const mean = localMean(drive, width, height, sigmaPx);
    return Float32Array.from(drive, (value, pixel) => value + amount * (value - mean[pixel]));
}
/** Signed drive -> normalized white-hot response. Gamma is dimensionless and >0. */
export function responseCurve(drive, gamma = 1) {
    if (!(Number.isFinite(gamma) && gamma > 0)) throw new RangeError("Gamma must be positive");
    return Float32Array.from(drive, value => clamp(value) ** (1 / gamma));
}
/** Normalized values -> rounded 8-bit codes in Float32Array. */
export function quantize8Bit(normalizedDrive) {
    return Float32Array.from(normalizedDrive, value => Math.floor(clamp(value) * DISPLAY_MAX + 0.5));
}
/** 8-bit codes -> 8-bit codes. Applied after response and quantization so inversion
 * is exact even at half-code ties and with a nonlinear response curve.
 */
export function polarity(codes, mode = "whiteHot", affine = {gain: 1, offset: 0}) {
    if (!["whiteHot", "blackHot"].includes(mode)) throw new RangeError("Unknown polarity");
    return Float32Array.from(codes, value => mode === "blackHot" ? DISPLAY_MAX - value :
        Math.floor(clamp(affine.gain * value + affine.offset, 0, DISPLAY_MAX) + 0.5));
}
/** Fixed, uniformly spaced LUT in warm-increasing normalized response. No image
 * statistics enter here. Float32 nodes are shared with the GPU texture.
 */
export function displayCurveLUT(settings) {
    if (!settings.displayCurve || settings.displayCurve === "linear") return null;
    const lut = SENSOR_PRESETS[settings.sensorPreset ?? "MX15"]?.displayCurveLUT;
    if (settings.displayCurve !== "measured" || !lut) throw new RangeError("No measured display curve for this sensor");
    return Float32Array.from(lut);
}
/** Signed drive -> fixed tone response in [0,1]; gamma is an optional input
 * remapping. Keep gamma=1 to reproduce the measured law after the count window.
 */
export function displayCurve(drive, settings) {
    const response = responseCurve(drive, settings.responseGamma), lut = displayCurveLUT(settings);
    if (!lut) return response;
    return Float32Array.from(response, value => {
        const coordinate = value * (lut.length - 1), index = Math.floor(coordinate);
        const next = Math.min(index + 1, lut.length - 1), fraction = coordinate - index;
        return lut[index] * (1 - fraction) + lut[next] * fraction;
    });
}
/** Signed drive -> 8-bit display codes, Float32Array. */
export function displayCodes(drive, settings) {
    return polarity(quantize8Bit(displayCurve(drive, settings)), settings.polarity, settings.polarityAffine ??
        {gain: settings.polarityAffineGain ?? 1, offset: settings.polarityAffineOffset ?? 0});
}
/** Count image and settings -> count window and optional dimensionless plateau LUT.
 * previous window is explicit caller-owned state; deltaTimeS is seconds.
 */
export function processingParameters(counts, settings, previous = null, deltaTimeS = 0,
    width = settings.detectorWidth, height = settings.detectorHeight, presentation = null) {
    const statistics = ["automatic", "plateau"].includes(settings.gainMode)
        ? gainStatistics(counts, width, height, settings, presentation) : counts;
    let window;
    if (settings.gainMode === "manual") {
        const halfSpan = ADC_MAX / (2 * settings.fixedGain);
        window = {low: settings.fixedLevel - halfSpan + (settings.adcOffsetCounts ?? 0),
            high: settings.fixedLevel + halfSpan + (settings.adcOffsetCounts ?? 0)};
    } else if (settings.gainMode === "fixedRadiometric") {
        const factor = electronsPerRadiance(settings) * ADC_MAX / settings.wellElectrons;
        if (factor === 0) throw new RangeError("Fixed radiometric mode requires nonzero throughput");
        window = {low: settings.radiometricLow * factor + (settings.adcOffsetCounts ?? 0),
            high: settings.radiometricHigh * factor + (settings.adcOffsetCounts ?? 0)};
    } else {
        window = automaticWindow(statistics, {lowPercentile: settings.lowPercentile, highPercentile: settings.highPercentile,
            minimumSpan: settings.minimumWindowCounts, timeConstantS: settings.agcTimeConstantS, deltaTimeS, dynamics: settings.agcDynamics}, previous);
    }
    const lut = settings.gainMode === "plateau" ? plateauLUT(statistics, settings.plateauFactor, ADC_MAX + 1, true) : null;
    return {window, lut, statisticsCount: statistics.length};
}

/** Native samples whose centers are in the continuous centered zoom rectangle.
 * A subpixel crop retains the nearest central sample(s). Estimated statistics
 * policy; independent of enlargement interpolation and unknown camera firmware.
 */
export function gainStatistics(counts, width, height, settings, presentation = null) {
    if (settings.gainRegion !== "displayed") return counts;
    presentation = detectorPresentation(settings, presentation);
    if (settings.digitalZoom === 1 && presentation.scale.every(value => value === 1) && presentation.offset.every(value => value === 0) && detectorWindowScale(settings).every(value => value === 1)) return counts;
    validateImage(counts, width, height);
    const bounds = (size, axis) => {
        const half = Math.max(size * (presentation?.scale[axis] ?? 1) / settings.digitalZoom / 2, 0.5);
        const center = size * (0.5 + (presentation?.offset[axis] ?? 0) / settings.digitalZoom);
        const windowHalf = size * detectorWindowScale(settings)[axis] / 2;
        const first = Math.max(0, Math.ceil(size / 2 - windowHalf - .5));
        const last = Math.min(size - 1, Math.floor(size / 2 + windowHalf - .5));
        return [clamp(Math.ceil(center - half - 0.5), first, last), clamp(Math.floor(center + half - 0.5), first, last)];
    };
    const [left, right] = bounds(width, 0), [bottom, top] = bounds(height, 1);
    const result = new Float32Array((right - left + 1) * (top - bottom + 1));
    for (let y = bottom; y <= top; y++)
        result.set(counts.subarray(y * width + left, y * width + right + 1), (y - bottom) * (right - left + 1));
    return result;
}
/** Count image -> {codes [0,255], drive signed, window count endpoints}. */
export function processCounts(counts, width, height, settings, previous = null, deltaTimeS = 0) {
    const parameters = processingParameters(counts, settings, previous, deltaTimeS, width, height);
    let drive = windowImage(counts, parameters.window);
    if (parameters.lut && !parameters.lut.constant) drive = Float32Array.from(counts,
        value => parameters.lut.values[Math.round(clamp(value, 0, ADC_MAX))]);
    drive = localEnhancement(drive, width, height, settings.localAmount, settings.localRadiusPx);
    return {codes: displayCodes(drive, settings), drive, ...parameters};
}

// Calculated allocation limits: fine FFT <=4096 per side (2048 when it fits),
// coarse FFT <=1024. These are numerical resource policies, not camera properties.
export const FINE_FFT_LIMIT = 4096;
export const FAR_FFT_LIMIT = 1024;

/** Calculated incoherent optical cutoff: 1/(lambda_min * focalLength/aperture).
 * Nyquist requires pitch/factor <= lambda_min * focalLength/aperture / 2.
 * The discrete factors and FFT limits are numerical resource policies. Manual
 * requests retain their factor; scatterPlan still rejects impossible allocations.
 */
export function opticalSampling(settings) {
    const requiredFactor = 2 * settings.pixelPitchM * settings.apertureM /
        (settings.bandMinUm * 1e-6 * settings.focalLengthM);
    const fits = factor => {
        try { scatterPlan({...settings, supersample: factor}); return true; }
        catch (error) { if (!(error instanceof RangeError)) throw error; return false; }
    };
    const allowed = [2, 4, 8].filter(fits);
    const mode = settings.opticalSamplingMode ?? "nyquist";
    // If even 2x cannot fit, retain the minimum grid so normalization still
    // supports editing large detectors; rendering reports the allocation error.
    const factor = mode === "manual" ? settings.supersample :
        allowed.find(value => value >= requiredFactor) ?? allowed.at(-1) ?? 2;
    const allocationFits = fits(factor);
    return Object.freeze({mode, factor, requiredFactor,
        nyquistMet: allocationFits && factor >= requiredFactor, allocationFits});
}

/** Plan bounded scatter support before allocating kernels. All lengths below are
 * fine samples except angularStep/nearCutoffRad in radians. The smooth transition
 * spans half the near radius to its edge, avoiding a coarse-grid step artifact.
 */
export function scatterPlan(settings, width = settings.detectorWidth * settings.supersample,
    height = settings.detectorHeight * settings.supersample) {
    const angularStep = settings.pixelPitchM / (settings.focalLengthM * settings.supersample);
    const coreRadius = opticalCoreRadius(settings);
    const fullRadius = settings.scatterFraction ? Math.ceil(settings.scatterCutoffRad / angularStep) : 0;
    const side = Math.max(width, height);
    const limit = side + 2 * coreRadius + 64 <= 2048 ? 2048 : FINE_FFT_LIMIT;
    const available = Math.floor((limit - side) / 2) - coreRadius;
    if (available < 0 || (fullRadius && available < 8))
        throw new RangeError("Thermal fine optics exceeds 4096 texels per side; reduce detector size, optical sampling or core support");
    let factor = 1;
    while (Math.ceil((side + 2 * (fullRadius + coreRadius)) / factor) + 8 > FAR_FFT_LIMIT) factor *= 2;
    const nearRadius = Math.min(fullRadius, available, Math.max(32, Math.ceil(0.001 / angularStep), 16 * factor));
    return {factor: nearRadius >= fullRadius ? 1 : factor, angularStep, nearRadius,
        nearCutoffRad: nearRadius * angularStep, fullRadius,
        fftWidth: nextPow2(width + 2 * (coreRadius + nearRadius)),
        fftHeight: nextPow2(height + 2 * (coreRadius + nearRadius))};
}

/** Unit-sum fine kernel -> coarse kernel by conservative linear deposition.
 * Kernel coordinates have zero at an integer sample on both grids.
 */
export function coarsenKernel(kernel, factor) {
    const radius = Math.ceil(Math.max(kernel.width, kernel.height) / (2 * factor));
    const width = 2 * radius + 1, data = new Float64Array(width * width);
    for (let y = 0; y < kernel.height; y++) for (let x = 0; x < kernel.width; x++) {
        const px = (x - Math.floor(kernel.width / 2)) / factor + radius;
        const py = (y - Math.floor(kernel.height / 2)) / factor + radius;
        const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
        for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
            const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
            if (weight) data[(iy + dy) * width + ix + dx] += kernel.data[y * kernel.width + x] * weight;
        }
    }
    return {width, height: width, data: Float32Array.from(data)};
}

/** Normalized near+far scatter. Near includes the unscattered delta. Both parts
 * share one normalization, so the split cannot discard or duplicate flux. The far
 * kernel integrates 4x4 samples/cell; its smooth weight complements the fine part.
 * Numerical approximation only: compare with an unsplit sampled kernel for a fit.
 */
export function splitScatter(settings, plan) {
    const sensor = {pitchM: settings.pixelPitchM, focalM: settings.focalLengthM};
    const scatter = {tis: settings.scatterFraction, slope: settings.scatterSlope,
        shoulderRad: settings.scatterShoulderRad, cutoffRad: settings.scatterCutoffRad};
    if (plan.nearRadius >= plan.fullRadius) return {
        scatter: scatterKernel(sensor, scatter, settings.supersample), farScatter: null, farMass: 0};
    const {angularStep, nearRadius, factor} = plan;
    const shape = radius => radius <= settings.scatterCutoffRad / angularStep
        ? (1 + (radius * angularStep / settings.scatterShoulderRad) ** 2) ** (-settings.scatterSlope / 2) : 0;
    const nearWeight = radius => {
        const t = clamp((radius - nearRadius / 2) / (nearRadius / 2));
        return 1 - t * t * (3 - 2 * t);
    };
    const width = 2 * nearRadius + 1, near = new Float64Array(width * width);
    for (let y = -nearRadius; y <= nearRadius; y++) for (let x = -nearRadius; x <= nearRadius; x++) {
        const radius = Math.hypot(x, y);
        near[(y + nearRadius) * width + x + nearRadius] = shape(radius) * nearWeight(radius);
    }
    const farRadius = Math.ceil(plan.fullRadius / factor + 0.5);
    const farWidth = 2 * farRadius + 1, far = new Float64Array(farWidth * farWidth);
    for (let y = -farRadius; y <= farRadius; y++) for (let x = -farRadius; x <= farRadius; x++) {
        let weight = 0;
        for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
            const radius = Math.hypot(x + (sx + 0.5) / 4 - 0.5, y + (sy + 0.5) / 4 - 0.5) * factor;
            weight += shape(radius) * (1 - nearWeight(radius));
        }
        far[(y + farRadius) * farWidth + x + farRadius] = weight * factor ** 2 / 16;
    }
    const total = sum(near) + sum(far), scale = settings.scatterFraction / total;
    const farMass = sum(far) * scale;
    for (let i = 0; i < near.length; i++) near[i] *= scale;
    for (let i = 0; i < far.length; i++) far[i] *= scale;
    near[nearRadius * width + nearRadius] += 1 - settings.scatterFraction;
    return {scatter: {width, height: width, data: Float32Array.from(near)},
        farScatter: {width: farWidth, height: farWidth, data: Float32Array.from(far)}, farMass};
}

/** Area-average with zero exterior; dimensions need not divide the factor. */
export function reduceImage(input, width, height, factor) {
    const outWidth = Math.ceil(width / factor), outHeight = Math.ceil(height / factor);
    const image = new Float32Array(outWidth * outHeight);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
        image[Math.floor(y / factor) * outWidth + Math.floor(x / factor)] += input[y * width + x] / factor ** 2;
    return {image, width: outWidth, height: outHeight};
}

/** Far contribution on the original fine grid. A one-cell border retains values
 * needed by interpolation at field edges; zero exterior contrast is not clamped.
 */
export function applyFarScatter(contrast, width, height, kernels) {
    if (!kernels.farScatter) return new Float32Array(width * height);
    const factor = kernels.split.factor, coarse = reduceImage(contrast, width, height, factor);
    const cw = coarse.width + 2, ch = coarse.height + 2, padded = new Float32Array(cw * ch);
    for (let y = 0; y < coarse.height; y++) padded.set(coarse.image.subarray(y * coarse.width, (y + 1) * coarse.width), (y + 1) * cw + 1);
    const filtered = convolve(padded, cw, ch, combineKernels(kernels.farCore, kernels.farScatter));
    return Float32Array.from(contrast, (_, pixel) => bilinear(filtered, cw, ch,
        (pixel % width + 0.5) / factor + 0.5, (Math.floor(pixel / width) + 0.5) / factor + 0.5));
}

/** Calculated source-photon weights. Seven PSF bins intersect every atmospheric
 * band before integrating Planck radiance, avoiding loss of narrow absorption bins.
 * A common source temperature/range is an estimated scene approximation. Path emission
 * is excluded: it is not light from the point source. Range zero preserves legacy bins.
 */
export function psfSpectrum(settings, atmosphere = null) {
    const rangeM = settings.psfRangeM ?? 0;
    if (!(Number.isFinite(rangeM) && rangeM >= 0)) throw new RangeError("PSF range must be nonnegative");
    const band = {minUm: settings.bandMinUm, maxUm: settings.bandMaxUm};
    const path = rangeM > 0 ? evaluatePath({sensorAltitudeM: settings.sensorAltitudeM,
        elevationRad: settings.pathElevationDeg * Math.PI / 180, slantRangeM: rangeM},
    atmosphere ?? createAtmosphere({visibilityM: settings.visibilityM,
        densityScale: settings.atmosphereEnabled ? 1 : 0, surfaceTemperatureK: settings.surfaceTemperatureK,
        surfaceWaterVaporDensityKgM3: settings.waterVaporDensityKgM3}), {segments: 96, quantity: "photon", band}) : null;
    const bins = Array.from({length: 7}, (_, index) => {
        const minUm = band.minUm + index * (band.maxUm - band.minUm) / 7;
        const maxUm = band.minUm + (index + 1) * (band.maxUm - band.minUm) / 7;
        const photons = path ? BANDS.reduce((total, subband, channel) => {
            const lo = Math.max(minUm, subband.minM * 1e6), hi = Math.min(maxUm, subband.maxM * 1e6);
            return total + (hi > lo ? inBandRadiance(settings.psfTemperatureK, {minUm: lo, maxUm: hi}).photon * path.transmission[channel] : 0);
        }, 0) : inBandRadiance(settings.psfTemperatureK, {minUm, maxUm}).photon;
        return {minUm, maxUm, wavelengthM: (minUm + maxUm) * 0.5e-6, photons};
    });
    const photons = sum(bins.map(bin => bin.photons));
    if (!(photons > 0)) throw new RangeError("PSF source has no received photons at this range");
    for (const bin of bins) bin.weight = bin.photons / photons;
    return {rangeM, bins, meanWavelengthM: sum(bins.map(bin => bin.wavelengthM * bin.weight)),
        status: "calculated", source: "Planck photon spectrum × selected path transmission, normalized over seven PSF bins"};
}

/** Native detector window for standalone presentation. A supplied host mapping
 * already maps the physical optical field, so it is not cropped a second time.
 */
export function detectorWindowScale(settings) {
    return [(settings.detectorWindow?.width ?? settings.detectorWidth) / settings.detectorWidth,
        (settings.detectorWindow?.height ?? settings.detectorHeight) / settings.detectorHeight];
}
export function detectorPresentation(settings, presentation = null) {
    return presentation ?? {scale: detectorWindowScale(settings), offset: [0, 0]};
}

/** CPU reference for nearest, half-pixel linear and sample-centered linear output.
 * Buffers are bottom row first; sample alignment is anchored at the top left.
 * Coordinates and sizes are pixels. At 2×, the centered impulse is 0.5/1/0.5.
 */
export function enlargeImage(input, width, height, outputWidth, outputHeight, settings, presentation = null) {
    validateImage(input, width, height);
    const mapping = detectorPresentation(settings, presentation), zoom = settings.digitalZoom ?? 1;
    const windowScale = detectorWindowScale(settings);
    const first = windowScale.map((scale, axis) => Math.ceil([width, height][axis] * (.5 - .5 * scale) - .5));
    const last = windowScale.map((scale, axis) => Math.floor([width, height][axis] * (.5 + .5 * scale) - .5));
    const footprint = [width, height].map((size, axis) => size * mapping.scale[axis] / (zoom * [outputWidth, outputHeight][axis]));
    const taps = (uv, axis) => {
        const size = [width, height][axis], span = footprint[axis];
        let position = uv * size - .5;
        if (span > 1) {
            // Calculated area overlap in native pixel coordinates. Minification
            // has no enlargement phase shift; every covered native cell contributes.
            const lo = position - span / 2, hi = position + span / 2, result = [];
            for (let i = Math.floor(lo + .5); i < Math.ceil(hi + .5); i++)
                if (i >= first[axis] && i <= last[axis]) result.push([i, Math.max(0, Math.min(hi, i + .5) - Math.max(lo, i - .5)) / span]);
            return result;
        }
        if (settings.sampling === "sampleCentered") position += (axis === 0 ? 1 : -1) * (.5 - .5 * span);
        if (settings.sampling === "nearest") return [[clamp(Math.floor(position + .5), first[axis], last[axis]), 1]];
        const lo = Math.floor(position), f = position - lo;
        return [[clamp(lo, first[axis], last[axis]), 1 - f], [clamp(lo + 1, first[axis], last[axis]), f]];
    };
    return Float32Array.from({length: outputWidth * outputHeight}, (_, index) => {
        const uv = [index % outputWidth, Math.floor(index / outputWidth)].map((v, axis) =>
            (((v + 0.5) / [outputWidth, outputHeight][axis] - 0.5) * mapping.scale[axis] + mapping.offset[axis]) / zoom + 0.5);
        if (uv.some((value, axis) => footprint[axis] <= 1 &&
            (value < .5 - .5 * windowScale[axis] || value >= .5 + .5 * windowScale[axis]))) return 0;
        let value = 0;
        for (const [y, wy] of taps(uv[1], 1)) for (const [x, wx] of taps(uv[0], 0)) value += input[y * width + x] * wx * wy;
        return value;
    });
}

// Reset on changes to upstream signal formation; presentation edits do not alter
// detector history. The selected gain mode is a discontinuous processing change.
export function temporalHistoryKey(settings) {
    const keys = ["sensorPreset", "focalStep", "pupilPolicy", "focalLengthM", "apertureM", "pixelPitchM",
        "detectorWidth", "detectorHeight", "supersample", "fillFactor", "bandMinUm", "bandMaxUm",
        "psfTemperatureK", "opticsEnabled", "opticsRadiusPx", "defocusM", "scatterFraction",
        "scatterSlope", "scatterShoulderRad", "scatterCutoffRad", "jitterRmsUrad", "diffusionSigmaPx",
        "systemBlurHorizontalRmsUrad", "systemBlurVerticalRmsUrad", "systemBlurRmsUrad", "adcOffsetCounts",
        "exposureMode", "integrationTimeS", "wellFillFraction", "wellFillReferenceK", "wellElectrons",
        "quantumEfficiency", "opticalTransmission", "darkElectronsPerS", "noiseEnabled", "shotNoiseEnabled",
        "readNoiseElectrons", "noiseSeed", "shadingK", "shadingWidth", "fixedPatternFraction",
        "temporalFilterAlpha", "gainMode"];
    return JSON.stringify(keys.map(key => settings[key]));
}

/** Calculated AR(1) recursion in counts. Alpha is memory per delivered frame;
 * skipped forward frames use alpha^delta (current sample held through the gap).
 * Repeats/backward seeks reset so paused edits respond without stale ghosting.
 * previous is the returned caller-owned state; raw counts are never mutated.
 */
export function temporalFilter(counts, settings, frame = 0, previous = null) {
    validateImage(counts);
    const alpha = settings.temporalFilterAlpha ?? 0, key = temporalHistoryKey(settings);
    if (!(Number.isFinite(alpha) && alpha >= 0 && alpha < 1)) throw new RangeError("Temporal alpha must be in [0,1)");
    if (!Number.isInteger(frame) || frame < 0) throw new RangeError("Temporal frame must be a nonnegative integer");
    const reset = !previous || previous.key !== key || previous.image.length !== counts.length || frame <= previous.frame;
    const memory = reset ? 0 : alpha ** (frame - previous.frame);
    const image = Float32Array.from(counts, (value, index) => memory ? (1 - memory) * value + memory * previous.image[index] : value);
    return {image, frame, key, memory, reset};
}

/** settings SI, oversample unitless. Normalized diffraction and scatter kernels.
 * Seven bands are weighted by photons from the stated PSF temperature. This uses a
 * spatially common spectrum, an explicit approximation for a mixed-temperature scene.
 */
export function opticalKernels(settings, width = settings.detectorWidth * settings.supersample,
    height = settings.detectorHeight * settings.supersample, atmosphere = null) {
    const spectrum = psfSpectrum(settings, atmosphere);
    const split = scatterPlan(settings, width, height);
    const sensor = {focalM: settings.focalLengthM, apertureM: settings.apertureM, pitchM: settings.pixelPitchM};
    const oversample = settings.supersample;
    let core = deltaKernel();
    if (settings.opticsEnabled || settings.turbulenceR0M > 0) {
        const samples = [];
        for (const {photons, wavelengthM} of spectrum.bins) {
            let kernel = settings.opticsEnabled ? diffractionKernel(sensor, {radiusPx: settings.opticsRadiusPx,
                defocusM: settings.defocusM, pupilGrid: 1024}, wavelengthM, oversample) : deltaKernel();
            if (settings.turbulenceR0M > 0) kernel = filterKernelMTF(kernel, split.angularStep,
                frequency => turbulenceMTF(frequency, wavelengthM, settings.turbulenceR0M),
                Math.ceil(settings.opticsRadiusPx * oversample));
            samples.push({photons, kernel});
        }
        const photons = samples.reduce((total, sample) => total + sample.photons, 0);
        const data = new Float64Array(samples[0].kernel.data.length);
        for (const sample of samples) for (let pixel = 0; pixel < data.length; pixel++)
            data[pixel] += sample.kernel.data[pixel] * sample.photons / photons;
        core = normalized(data, samples[0].kernel.width);
    }
    // Published Gaussian transfer exp(-2*pi²*sigma²*f²); estimated RMS inputs.
    // Diffusion is after the optical PSF and before pixel-area sampling. These
    // spatially invariant convolutions commute with scatter, so the same blurred
    // core can feed both scatter branches without another full-frame pass.
    const sigma = gaussianBlurRmsRad(settings);
    if (sigma.horizontal > 0 || sigma.vertical > 0) core = filterKernelMTF(core, split.angularStep,
        (frequency, fx, fy) => Math.exp(-2 * Math.PI ** 2 *
            ((sigma.horizontal * fx) ** 2 + (sigma.vertical * fy) ** 2)), opticalCoreRadius(settings));
    const scatter = splitScatter(settings, split);
    return {core, ...scatter, split, spectrum, farCore: scatter.farScatter ? coarsenKernel(core, split.factor) : null};
}

/** Two unit-sum kernels -> their full linear convolution. Dimensions are samples;
 * kernel weights are dimensionless. Intermediate support is retained before cropping.
 */
export function combineKernels(first, second) {
    const width = first.width + second.width - 1, height = first.height + second.height - 1;
    const padded = new Float32Array(width * height);
    const offsetX = Math.floor(second.width / 2), offsetY = Math.floor(second.height / 2);
    for (let row = 0; row < first.height; row++)
        padded.set(first.data.subarray(row * first.width, (row + 1) * first.width), (row + offsetY) * width + offsetX);
    return {width, height, data: convolve(padded, width, height, second)};
}

/** Fine radiance image, dimensions in samples, dimensionless optical kernels and
 * background is a scalar or per-pixel image in the same radiance unit. Only object
 * contrast is convolved; the continued sky is restored after the final crop.
 */
export function applyOptics(input, width, height, kernels, background = 0) {
    if (typeof background !== "number") validateImage(background, width, height);
    const backgroundAt = pixel => typeof background === "number" ? background : background[pixel];
    const contrast = Float32Array.from(input, (value, pixel) => value - backgroundAt(pixel));
    const filtered = convolve(contrast, width, height, combineKernels(kernels.core, kernels.scatter));
    const far = applyFarScatter(contrast, width, height, kernels);
    return Float32Array.from(filtered, (value, pixel) => Math.max(0, value + far[pixel] + backgroundAt(pixel)));
}

/** Fine scaled photon image -> detector result; width/height fine pixels. Disabling
 * optics, exposure, processing and output gives a bit-exact Float32 identity path.
 * The normal pipeline always enables physical exposure, ADC and display processing.
 */
export function runSensorChain(input, width, height, settings, {frame = 0, effectsOff = false,
    previousWindow = null, previousTemporal = null, deltaTimeS = 0, backgroundRadiance, atmosphere = null} = {}) {
    validateImage(input, width, height);
    if (effectsOff) return {image: input.slice()};
    if (backgroundRadiance === undefined) throw new TypeError("Supply backgroundRadiance (scalar or fine-grid sky image) for optical boundaries");
    const kernels = opticalKernels(settings, width, height, atmosphere);
    const optics = applyOptics(input, width, height, kernels, backgroundRadiance);
    const sampled = sampleDetector(optics, width, height, settings.supersample, settings.fillFactor);
    const counts = detectorCounts(sampled, settings, frame);
    const temporal = temporalFilter(counts, settings, frame, previousTemporal);
    const processed = processCounts(temporal.image, width / settings.supersample, height / settings.supersample,
        settings, previousTemporal && temporal.reset ? null : previousWindow, previousTemporal && temporal.reset ? 0 : deltaTimeS);
    return {image: processed.codes, counts, temporal, filteredCounts: temporal.image, sampled, optics, integrationTimeS: integrationTime(settings), ...processed};
}
