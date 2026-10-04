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
export function filterKernelMTF(kernel, angularStepRad, mtf, radius = (kernel.width - 1) / 2, linear = false, cache = null) {
    const size = 2 * radius + 1, n = nextPow2(2 * Math.max(size, kernel.width, kernel.height));
    const reused = cache?.source === kernel && cache.n === n;
    const re = reused ? cache.re.slice() : new Float64Array(n * n);
    const im = reused ? cache.im.slice() : new Float64Array(n * n);
    if (!reused) {
        const cx = Math.floor(kernel.width / 2), cy = Math.floor(kernel.height / 2);
        for (let y = 0; y < kernel.height; y++) for (let x = 0; x < kernel.width; x++)
            re[((y - cy + n) % n) * n + (x - cx + n) % n] = kernel.data[y * kernel.width + x];
        fft2(re, im, n);
        if (cache?.reuseTransform) Object.assign(cache, {source: kernel, n, re: re.slice(), im: im.slice()});
    }
    // Calculated reflection symmetry: the transfer uses absolute axis frequencies.
    // Evaluate each quadrant sample once; fixed Gaussian transfer is shared across
    // wavelength and turbulence samples, without combining the finite crops.
    const side = n / 2 + 1;
    let transfer = cache?.transfer;
    if (!transfer || transfer.length !== side * side) {
        transfer = new Float64Array(side * side);
        for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
            const fx = x / (n * angularStepRad), fy = y / (n * angularStepRad);
            transfer[y * side + x] = mtf(Math.hypot(fx, fy), fx, fy);
        }
        if (cache?.reuseTransfer) cache.transfer = transfer;
    }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const value = transfer[Math.min(y, n - y) * side + Math.min(x, n - x)], i = y * n + x;
        re[i] *= value; im[i] *= value;
    }
    fft2(re, im, n, true);
    const data = new Float64Array(size * size);
    for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++)
        data[(y + radius) * size + x + radius] = linear ? re[((y + n) % n) * n + (x + n) % n] :
            Math.max(0, re[((y + n) % n) * n + (x + n) % n]);
    // Calculated signed, unnormalized response for linear spectral mixing. Clamp
    // and normalize only AFTER mixing, as in the full polychromatic reference.
    if (linear) return {width: size, height: size, data};
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
    for (let i = 0; i < image.length; i++) if (!Number.isFinite(image[i])) throw new RangeError("Image contains a non-finite value");
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
// Calculated exact ordering: complement negative Float32 words and flip the
// sign bit of nonnegative words. Unsigned keys then have the same order as the
// numeric typed-array sort, including -0 before +0. Two 16-bit histogram passes
// select both ranks in O(samples + 65536), without rounding fractional counts.
// Scratch is private to these synchronous calls, fully cleared before reuse,
// and never returned. Calculated reuse error is zero; no frame data is cached.
const percentileHigh = new Float64Array(65536);
const percentileLow = new Float64Array(65536);
const percentileUpper = new Float64Array(65536);
const percentileWord = new Uint32Array(1);
const percentileValue = new Float32Array(percentileWord.buffer);

function histogramRank(histogram, rank) {
    let bin = 0;
    while (rank >= histogram[bin]) rank -= histogram[bin++];
    return {bin, rank};
}

function percentileCounts(counts, lowRank, highRank) {
    const words = new Uint32Array(counts.buffer, counts.byteOffset, counts.length);
    percentileHigh.fill(0);
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        percentileHigh[(word & 0x80000000 ? ~word : word ^ 0x80000000) >>> 16]++;
    }
    const low = histogramRank(percentileHigh, lowRank);
    const high = histogramRank(percentileHigh, highRank);
    percentileLow.fill(0);
    percentileUpper.fill(0);
    for (let i = 0; i < words.length; i++) {
        const word = words[i], key = word & 0x80000000 ? ~word : word ^ 0x80000000;
        const bin = key >>> 16;
        if (bin === low.bin) percentileLow[key & 65535]++;
        else if (bin === high.bin) percentileUpper[key & 65535]++;
    }
    const lowKey = (low.bin << 16) | histogramRank(percentileLow, low.rank).bin;
    const highKey = (high.bin << 16) | histogramRank(high.bin === low.bin ? percentileLow : percentileUpper, high.rank).bin;
    percentileWord[0] = lowKey & 0x80000000 ? lowKey ^ 0x80000000 : ~lowKey;
    const lowCount = percentileValue[0];
    percentileWord[0] = highKey & 0x80000000 ? highKey ^ 0x80000000 : ~highKey;
    return [lowCount, percentileValue[0]];
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
    const [low, upper] = percentileCounts(counts, Math.floor(lowPercentile * (counts.length - 1)),
        Math.floor(highPercentile * (counts.length - 1)));
    const high = Math.max(upper, low + minimumSpan);
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
    if (countLevels) {
        for (let i = 0; i < drive.length; i++) histogram[Math.round(clamp(drive[i], 0, bins - 1))]++;
    } else {
        for (let i = 0; i < drive.length; i++) histogram[Math.floor(clamp(drive[i]) * (bins - 1))]++;
    }
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

/** The statistics rectangle of gainStatistics, inclusive native pixel bounds {left, right, bottom, top}, or null
 * when the statistics use the whole image. The GPU gain statistics scatter exactly these pixels.
 */
export function gainStatisticsBounds(width, height, settings, presentation = null) {
    if (settings.gainRegion !== "displayed") return null;
    presentation = detectorPresentation(settings, presentation);
    if (settings.digitalZoom === 1 && presentation.scale.every(value => value === 1) && presentation.offset.every(value => value === 0) && detectorWindowScale(settings).every(value => value === 1)) return null;
    const bounds = (size, axis) => {
        const half = Math.max(size * (presentation?.scale[axis] ?? 1) / settings.digitalZoom / 2, 0.5);
        const center = size * (0.5 + (presentation?.offset[axis] ?? 0) / settings.digitalZoom);
        const windowHalf = size * detectorWindowScale(settings)[axis] / 2;
        const first = Math.max(0, Math.ceil(size / 2 - windowHalf - .5));
        const last = Math.min(size - 1, Math.floor(size / 2 + windowHalf - .5));
        return [clamp(Math.ceil(center - half - 0.5), first, last), clamp(Math.floor(center + half - 0.5), first, last)];
    };
    const [left, right] = bounds(width, 0), [bottom, top] = bounds(height, 1);
    return {left, right, bottom, top};
}

/** Native samples whose centers are in the continuous centered zoom rectangle.
 * A subpixel crop retains the nearest central sample(s). Estimated statistics
 * policy; independent of enlargement interpolation and unknown camera firmware.
 */
export function gainStatistics(counts, width, height, settings, presentation = null) {
    const region = gainStatisticsBounds(width, height, settings, presentation);
    if (!region) return counts;
    validateImage(counts, width, height);
    const {left, right, bottom, top} = region;
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
        // Calculated zero-aliasing criterion for two finite-support convolutions:
        // N >= field + (core width - 1) + (scatter width - 1), independently per axis.
        requiredWidth: width + 2 * (coreRadius + nearRadius),
        requiredHeight: height + 2 * (coreRadius + nearRadius),
        accuracy: "full linear convolution; zero circular wrap within retained support",
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

// Estimated numerical budgets, not physical parameters. The kernel L1 bound
// limits absolute image error to tolerance * maximum absolute scene contrast.
// It also bounds absolute MTF error at every spatial frequency by the same value.
export const OPTICS_L1_TOLERANCE = 1e-4;

export const opticalFields = ["supersample", "opticsEnabled", "focalLengthM", "apertureM", "pixelPitchM",
    "bandMinUm", "bandMaxUm", "opticsRadiusPx", "defocusM", "turbulenceR0M", "jitterRmsUrad",
    "diffusionSigmaPx", "systemBlurHorizontalRmsUrad", "systemBlurVerticalRmsUrad",
    "scatterFraction", "scatterSlope", "scatterShoulderRad", "scatterCutoffRad"];

/** Calculated wavelength responses. Linear Gaussian filtering commutes with
 * spectral addition; signed samples retain that identity before the final clamp.
 * Range, altitude, elevation and source temperature affect only photon weights.
 */
export function opticalBasis(settings, width, height, spectrum, scatterBasis = null, work = null) {
    const split = scatterPlan(settings, width, height);
    const sensor = {focalM: settings.focalLengthM, apertureM: settings.apertureM, pitchM: settings.pixelPitchM};
    const sigma = gaussianBlurRmsRad(settings);
    const bands = spectrum.bins.map(({wavelengthM}, index) => {
        let kernel = work?.diffraction[index] ?? (settings.opticsEnabled ? diffractionKernel(sensor, {radiusPx: settings.opticsRadiusPx,
            defocusM: settings.defocusM, pupilGrid: 1024}, wavelengthM, settings.supersample) : deltaKernel());
        if (work) work.diffraction[index] = kernel;
        if (settings.turbulenceR0M > 0) kernel = filterKernelMTF(kernel, split.angularStep,
            frequency => turbulenceMTF(frequency, wavelengthM, settings.turbulenceR0M),
            Math.ceil(settings.opticsRadiusPx * settings.supersample), false,
            work ? (work.turbulence[index] ??= {reuseTransform: true}) : null);
        if (sigma.horizontal > 0 || sigma.vertical > 0) kernel = filterKernelMTF(kernel, split.angularStep,
            (frequency, fx, fy) => Math.exp(-2 * Math.PI ** 2 *
                ((sigma.horizontal * fx) ** 2 + (sigma.vertical * fy) ** 2)), opticalCoreRadius(settings), true, work?.gaussian);
        return kernel;
    });
    return {bands, split, ...(scatterBasis ?? splitScatter(settings, split))};
}

export function mixOpticalBasis(basis, spectrum) {
    const data = new Float64Array(basis.bands[0].data.length);
    basis.bands.forEach((band, i) => {
        const weight = spectrum.bins[i].weight;
        for (let pixel = 0; pixel < data.length; pixel++) data[pixel] += band.data[pixel] * weight;
    });
    for (let pixel = 0; pixel < data.length; pixel++) data[pixel] = Math.max(0, data[pixel]);
    const core = normalized(data, basis.bands[0].width);
    return {core, spectrum, split: basis.split, scatter: basis.scatter, farScatter: basis.farScatter,
        farMass: basis.farMass, farCore: basis.farScatter ? coarsenKernel(core, basis.split.factor) : null};
}

/** Calculated discrete L1 error of the actual finite kernels, including the
 * coarse branch. Positive unit-mass convolutions and conservative deposition
 * cannot amplify L1 error. No rounded range or assumed camera speed is used.
 */
export function opticalKernelError(a, b) {
    if (!a || !b || a.split.factor !== b.split.factor || a.split.fftWidth !== b.split.fftWidth ||
        a.split.fftHeight !== b.split.fftHeight || a.split.requiredWidth !== b.split.requiredWidth ||
        a.split.requiredHeight !== b.split.requiredHeight) return Infinity;
    const difference = (first, second) => {
        if (first === second) return 0;
        if (!first || !second || first.width !== second.width || first.height !== second.height) return Infinity;
        let error = 0;
        for (let i = 0; i < first.data.length; i++) error += Math.abs(first.data[i] - second.data[i]);
        return error;
    };
    return difference(a.core, b.core) + difference(a.scatter, b.scatter) + difference(a.farScatter, b.farScatter);
}

export class OpticalKernelCache {
    candidate(settings, width, height, atmosphere) {
        const key = JSON.stringify([width, height, ...opticalFields.map(name => settings[name])]);
        const spectrumKey = JSON.stringify([settings.psfRangeM, settings.sensorAltitudeM, settings.pathElevationDeg,
            settings.psfTemperatureK, settings.bandMinUm, settings.bandMaxUm,
            atmosphere ? null : [settings.atmosphereEnabled, settings.visibilityM,
                settings.surfaceTemperatureK, settings.waterVaporDensityKgM3]]);
        this.basisRebuilt = false;
        if (key === this.key && spectrumKey === this.spectrumKey && atmosphere === this.atmosphere) return this.kernels;
        const spectrum = psfSpectrum(settings, atmosphere);
        this.basisRebuilt = key !== this.key;
        if (this.basisRebuilt) this.basis = opticalBasis(settings, width, height, spectrum);
        this.key = key; this.spectrumKey = spectrumKey; this.atmosphere = atmosphere;
        this.kernels = mixOpticalBasis(this.basis, spectrum);
        return this.kernels;
    }
}


export function timingDistribution(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
    return {medianMs: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99),
        maxMs: sorted.at(-1), meanMs: values.reduce((a, b) => a + b, 0) / values.length};
}

// Calculated cubic response interpolation in turbulence strength q=r0^(-5/3), m^(-5/3).
// Each interval is checked against independent finite kernels at its quarter,
// midpoint and three-quarter points. The factor-two validation margin and
// one-quarter allocation of the L1 budget are estimated numerical policies.
export function opticalStructureKey(settings, width, height) {
    return JSON.stringify([width, height, ...opticalFields.filter(name => name !== "turbulenceR0M").map(name => settings[name]),
        scatterPlan(settings, width, height)]);
}
export const turbulenceStrength = r0 => r0 > 0 ? r0 ** (-5 / 3) : 0;
export function interpolateOpticalBasis(a, b, fraction) {
    if (!fraction) return a;
    if (fraction === 1) return b;
    return {...a, bands: a.bands.map((band, i) => ({...band,
        data: Float64Array.from(band.data, (v, p) => v + fraction * (b.bands[i].data[p] - v))}))};
}
export function buildOpticalDomain(settings, width, height, spectrum, onAnchor = null) {
    const q = turbulenceStrength(settings.turbulenceR0M), samples = new Map();
    // Diffraction depends on wavelength and pupil, not turbulence strength.
    // All validation samples share these finite responses.
    const work = {diffraction: [], turbulence: [], gaussian: {reuseTransfer: true}};
    let scatter;
    const at = strength => {
        if (!samples.has(strength)) {
            const value = opticalBasis({...settings, turbulenceR0M: strength ? strength ** (-3 / 5) : 0}, width, height, spectrum, scatter, work);
            scatter = {scatter: value.scatter, farScatter: value.farScatter, farMass: value.farMass};
            samples.set(strength, value);
        }
        return samples.get(strength);
    };
    const key = opticalStructureKey(settings, width, height);
    if (onAnchor) {
        const basis = at(q);
        onAnchor({key, anchor: q, intervals: [{low: q, high: q, a: basis, b: basis, errorL1: 0}], builds: 1});
    }
    // Estimated work-domain width in q; validation, never this width, decides reuse.
    const span = Math.max(.4, q / 5), low = Math.max(q / 16, q - span), high = q + span;
    if (!q) return {key: opticalStructureKey(settings, width, height), intervals: [{low: 0, high: 0, a: at(0), b: at(0), errorL1: 0}], builds: 1};
    const intervals = [];
    const validate = (low, high, depth = 0) => {
        const bases = [0, 1/3, 2/3, 1].map(t => at(low+t*(high-low)));
        const a = bases[0], b = bases[3];
        const coefficients = a.bands.map((band, i) => {
            const c = Array.from({length: 4}, () => new Float64Array(band.data.length));
            for (let p = 0; p < band.data.length; p++) {
                const [v0,v1,v2,v3] = bases.map(basis => basis.bands[i].data[p]);
                c[0][p] = v0;
                c[1][p] = (-11*v0+18*v1-9*v2+2*v3)/2;
                c[2][p] = (18*v0-45*v1+36*v2-9*v3)/2;
                c[3][p] = (-9*v0+27*v1-27*v2+9*v3)/2;
            }
            return c;
        });
        let maximum = 0;
        for (const t of [.25, .5, .75]) {
            const exact = at(low+t*(high-low));
            for (let i = 0; i < a.bands.length; i++) {
                let difference = 0, mass = 0;
                const c = coefficients[i];
                for (let p = 0; p < c[0].length; p++) {
                    const predicted = c[0][p]+t*(c[1][p]+t*(c[2][p]+t*c[3][p]));
                    difference += Math.abs(predicted-exact.bands[i].data[p]); mass += predicted;
                }
                // Clamping is nonexpansive; normalization adds at most 2/mass.
                maximum = Math.max(maximum, 4*difference/mass);
            }
        }
        if (maximum > OPTICS_L1_TOLERANCE/4) {
            if (depth >= 12) throw new Error("Optical interpolation did not converge");
            const mid = (low+high)/2; validate(low,mid,depth+1); validate(mid,high,depth+1);
        } else intervals.push({low, high, a, b, coefficients, errorL1: maximum});
    };
    validate(low, high);
    return {key: opticalStructureKey(settings, width, height), anchor: q, intervals, builds: samples.size};
}
export function sampleOpticalDomain(domain, settings, spectrum) {
    const q = turbulenceStrength(settings.turbulenceR0M);
    const interval = domain.intervals.find(cell => q >= cell.low && q <= cell.high);
    if (!interval) return null;
    const fraction = interval.high === interval.low ? 0 : (q - interval.low) / (interval.high - interval.low);
    // Mix wavelength and strength weights together to avoid allocating a second basis.
    const length = interval.a.bands[0].data.length;
    const data = domain.scratch?.length === length ? domain.scratch : (domain.scratch = new Float64Array(length));
    data.fill(0);
    for (let i = 0; i < spectrum.bins.length; i++) {
        const w = spectrum.bins[i].weight, c = interval.coefficients?.[i];
        if (c) for (let p=0; p<data.length; p++) data[p] += w*(c[0][p]+fraction*(c[1][p]+fraction*(c[2][p]+fraction*c[3][p])));
        else for (let p=0; p<data.length; p++) data[p] += w*interval.a.bands[i].data[p];
    }
    for (let p = 0; p < data.length; p++) data[p] = Math.max(0, data[p]);
    const total = sum(data), basis = interval.a;
    if (!(total > 0)) throw new Error("Kernel must have positive integral");
    const output = domain.output?.length === length ? domain.output : (domain.output = new Float32Array(length));
    for (let p = 0; p < length; p++) output[p] = data[p]/total;
    const core = {width: basis.bands[0].width, height: basis.bands[0].height, data: output, rawSum: total};
    return {core, spectrum, split: basis.split, scatter: basis.scatter, farScatter: basis.farScatter,
        farMass: basis.farMass, farCore: basis.farScatter ? coarsenKernel(core, basis.split.factor) : null,
        interpolationErrorL1: interval.errorL1};
}

// Completed optical domains kept by OpticsScheduler, so a return to an earlier lens step (or other optical structure)
// reuses its domain instead of showing the previous lens while the worker rebuilds it. The cache is bounded by the
// bytes the domains keep, because a domain grows with the number of turbulence intervals it needs. Measured in Node 22
// on one thread of a desktop CPU, for the stepped MX-15 class preset (2560 × 2048 fine grid, 257 × 257 kernels, seven
// bands):
//   one turbulence interval (r0 0.57 m at all four lens steps; r0 0.05–0.1 m at 27 and 135 mm): 21–23 MiB, built in
//   7.6–7.7 s, the first full kernel after 1.4–1.6 s;
//   two intervals (r0 0.05–0.1 m at 675 and 1012 mm): 40–41 MiB, built in 14–16 s;
//   no turbulence: 3.6–5.5 MiB, 0.6–0.8 s.
// Estimated budget: 128 MiB. It keeps all four steps in both measured cases (89 MiB with one interval each, 124 MiB
// with two at the long steps); stronger turbulence evicts the least recently used domain. The domain in current use is
// always kept, even when it alone is larger than the budget.
export const OPTICS_DOMAIN_CACHE_BYTES = 128 * 2 ** 20;

// The bytes a completed domain keeps: its basis kernels and interpolation coefficients, the arrays the optics worker
// transfers to the main thread (opticsWorker.js).
export function opticalDomainBytes(domain) {
    const buffers = new Set();
    for (const cell of domain?.intervals ?? []) {
        for (const basis of [cell.a, cell.b])
            for (const kernel of [...basis.bands, basis.scatter, basis.farScatter]) if (kernel) buffers.add(kernel.data.buffer);
        for (const band of cell.coefficients ?? []) for (const coefficient of band) buffers.add(coefficient.buffer);
    }
    let bytes = 0;
    for (const buffer of buffers) bytes += buffer.byteLength;
    return bytes;
}
const domainBytes = new WeakMap();

export class OpticsScheduler {
    constructor({createWorker, onReady = () => {}, domainBudgetBytes = OPTICS_DOMAIN_CACHE_BYTES} = {}) {
        this.createWorker = createWorker ?? createDefaultOpticsWorker;
        this.fallback = new OpticalKernelCache();
        this.onReady = onReady;
        this.serial = 0;
        // Completed domains by structure key, least recently used first. this.domain is the one in current use.
        this.domains = new Map();
        this.domainBudgetBytes = domainBudgetBytes;
    }
    // The bytes the cached domains keep.
    get retainedBytes() {
        let total = 0;
        for (const domain of this.domains.values()) total += domainBytes.get(domain);
        return total;
    }
    // Make a completed domain the most recently used, then evict the least recently used others until the cache fits
    // its budget.
    _remember(domain) {
        if (!domainBytes.has(domain)) domainBytes.set(domain, opticalDomainBytes(domain));
        this.domains.delete(domain.key); this.domains.set(domain.key, domain);
        let total = this.retainedBytes;
        for (const [key, cached] of this.domains) {
            if (total <= this.domainBudgetBytes || cached === domain) break;
            this.domains.delete(key); total -= domainBytes.get(cached);
        }
    }
    // The completed domain for this structure key, made current and most recently used. A cached domain still serves
    // only turbulence strengths inside its validated intervals; outside them the request builds a new domain.
    _completed(key) {
        const domain = this.domain?.key === key ? this.domain : this.domains.get(key) ?? null;
        if (domain) {this.domain = domain; this._remember(domain);}
        return domain;
    }
    request(settings, width, height, atmosphere) {
        const key = opticalStructureKey(settings, width, height);
        const synchronous = () => this.synchronousRequest(settings, width, height, atmosphere, key);
        if (this.workerUnavailable) return synchronous();
        const spectrum = psfSpectrum(settings, atmosphere);
        const q = turbulenceStrength(settings.turbulenceR0M);
        const completed = this._completed(key);
        const anchor = this.anchorDomain?.key === key ? this.anchorDomain : null;
        const domain = completed?.intervals.some(cell => q >= cell.low && q <= cell.high) ? completed : anchor ?? completed;
        const kernels = domain ? sampleOpticalDomain(domain, settings, spectrum) : null;
        const low = domain?.intervals[0].low, high = domain?.intervals.at(-1).high;
        // Estimated prefetch fraction measured from the build anchor, including asymmetric domains.
        const needsBuild = !kernels || q !== 0 && (q < domain.anchor - (domain.anchor-low)/4 || q > domain.anchor + (high-domain.anchor)/4);
        if (needsBuild) {
            this.latest = {settings: {...settings}, width, height, spectrum, key};
            if (!this.pending) this.start(this.latest);
        }
        if (this.workerUnavailable) return synchronous();
        return {kernels, key, pending: !!this.pending, buildMs: this.buildMs,
            firstKernelMs: this.firstKernelMs, builds: domain?.builds ?? 0};
    }
    /** Without a worker, build the worker's interpolation domain in this thread, once per optical structure
     * and turbulence interval, and sample it each frame. The results match the worker path, and a moving
     * camera, whose turbulence changes every frame, no longer rebuilds the whole optical basis every frame.
     */
    synchronousRequest(settings, width, height, atmosphere, key) {
        const spectrum = psfSpectrum(settings, atmosphere);
        const q = turbulenceStrength(settings.turbulenceR0M);
        const covered = this._completed(key)?.intervals.some(cell => q >= cell.low && q <= cell.high);
        if (!covered) {
            const start = performance.now();
            this.domain = buildOpticalDomain(settings, width, height, spectrum);
            this.buildMs = performance.now() - start;
            this._remember(this.domain);
        }
        // Unchanged inputs return the same kernel object, so the pipeline does not upload it again.
        const sampleKey = JSON.stringify([q, spectrum.bins.map(bin => bin.weight)]);
        if (this.sampled?.domain === this.domain && this.sampled.sampleKey === sampleKey) return this.sampled.result;
        const kernels = sampleOpticalDomain(this.domain, settings, spectrum);
        const result = kernels
            ? {kernels, key, pending: false, fallback: true, buildMs: this.buildMs, builds: this.domain.builds ?? 0}
            : {kernels: this.fallback.candidate(settings, width, height, atmosphere), key, pending: false, fallback: true};
        this.sampled = {domain: this.domain, sampleKey, result};
        return result;
    }
    start(request) {
        const id = ++this.serial;
        this.pending = {...request, id};
        const unavailable = () => {
            if (this.disposed) return;
            this.worker?.terminate(); this.worker = null;
            this.workerUnavailable = true; this.pending = null; this.onReady();
        };
        if (!this.workerPromise) {
            let created;
            try {created = this.createWorker();} catch {unavailable(); return;}
            if (!created) {unavailable(); return;}
            this.workerPromise = Promise.resolve(created).then(worker => {
                if (this.disposed) {worker?.terminate(); return null;}
                if (!worker) {unavailable(); return null;}
                this.worker = worker;
                worker.onmessage = event => {
                    if (this.disposed || event.data.id !== this.pending?.id) return;
                    if (event.data.error) {unavailable(); return;}
                    this.buildMs = event.data.buildMs;
                    if (event.data.complete === false) {
                        // An early point response must not evict the still-valid
                        // interval during a prefetch for a moving camera.
                        this.anchorDomain = event.data.domain;
                        this.firstKernelMs ??= event.data.buildMs;
                    } else {
                        this.domain = event.data.domain; this.anchorDomain = null;
                        this._remember(this.domain);
                        this.pending = null;
                    }
                    this.onReady();
                };
                worker.onerror = event => {event.preventDefault?.(); unavailable();};
                worker.onmessageerror = unavailable;
                return worker;
            }).catch(() => {unavailable(); return null;});
        }
        this.workerPromise.then(worker => !this.disposed && worker?.postMessage({id, settings: request.settings,
            width: request.width, height: request.height, spectrum: request.spectrum}))
            .catch(unavailable);
    }
    dispose() {
        this.disposed = true; this.serial++; this.pending = this.latest = this.domain = this.anchorDomain = this.sampled = null;
        this.domains.clear(); this.worker?.terminate();
    }
}

/** Module-relative resolution works without a document or a navigable page URL.
 * Evaluated bundles, unavailable workers and constructor restrictions use the
 * same finite CPU calculation instead. Bundled hosts may supply an asset factory.
 */
export function createDefaultOpticsWorker() {
    if (typeof Worker === "undefined") return null;
    try {
        return new Worker(new URL("./opticsWorker.js", import.meta.url), {type: "module"});
    } catch {return null;}
}

/** Coarse startup response: residual Gaussian blur and scatter only. The omitted
 * diffraction and turbulence are explicit. Calculated universal L1 bound = 2
 * between positive unit-mass responses, so |image error| <= 2 * max |contrast|.
 * This is a transient preview, not the validated interpolation tolerance.
 */
export function coarseOpticalKernels(settings, width, height, atmosphere) {
    return {...opticalKernels({...settings, opticsEnabled: false, turbulenceR0M: 0}, width, height, atmosphere),
        quality: "coarse", interpolationErrorL1: 2};
}
