/**
 * MWIR radiometry reference. No imports, I/O, atmosphere, optics, or electronics.
 * Wavelength arguments are micrometers (um); temperatures are kelvins (K).
 * A radiance pair is {energy: W m^-2 sr^-1, photon: photons s^-1 m^-2 sr^-1}.
 * Spectral functions return those units per um. Irradiance pairs omit sr^-1.
 * response(lambdaUm) is a NONNEGATIVE DIMENSIONLESS weight, never A/W.
 * For photon detectors use quantum efficiency as the weight and the photon result.
 * Integrals are NOT divided by bandwidth or by the response integral.
 */
export const H = 6.62607015e-34; // J s, exact SI
export const C = 299792458; // m s^-1, exact SI
export const K = 1.380649e-23; // J K^-1, exact SI
export const SIGMA = 2 * Math.PI ** 5 * K ** 4 / (15 * H ** 3 * C ** 2);
export const SOLAR_RADIUS_M = 6.957e8; // IAU nominal
export const AU_M = 149597870700; // exact conventional astronomical unit
export const SOLAR_TEMPERATURE_K = 5772; // IAU nominal effective temperature
export const PHOTON_SCALE = 1e20; // photons s^-1 m^-2 sr^-1 per stored linear unit

function nonnegative(x, name) {
    if (!Number.isFinite(x) || x < 0) throw new RangeError(`${name} must be finite and >= 0`);
    return x;
}
function positive(x, name) {
    nonnegative(x, name);
    if (x === 0) throw new RangeError(`${name} must be > 0`);
    return x;
}
function fraction(x, name) {
    nonnegative(x, name);
    if (x > 1) throw new RangeError(`${name} must be <= 1`);
    return x;
}
function pair(radiancePair, name) {
    nonnegative(radiancePair.energy, `${name}.energy`);
    nonnegative(radiancePair.photon, `${name}.photon`);
    return radiancePair;
}
const zero = () => ({energy: 0, photon: 0});
const scale = (radiancePair, s) => ({energy: radiancePair.energy * s, photon: radiancePair.photon * s});

/** Blackbody spectral energy radiance in W m^-2 sr^-1 um^-1. */
export function planckEnergy(wavelengthUm, temperatureK) {
    positive(wavelengthUm, "wavelengthUm");
    nonnegative(temperatureK, "temperatureK");
    if (temperatureK === 0) return 0;
    const wavelengthM = wavelengthUm * 1e-6;
    const x = H * C / (wavelengthM * K * temperatureK);
    // Avoid overflow on the cold Wien tail; expm1 preserves the hot/longwave limit.
    const occupation = x > 50 ? Math.exp(-x) / (1 - Math.exp(-x)) : 1 / Math.expm1(x);
    return (2 * H * C * C / wavelengthM ** 5) * occupation * 1e-6;
}

/** Blackbody spectral photon radiance in photons s^-1 m^-2 sr^-1 um^-1. */
export function planckPhoton(wavelengthUm, temperatureK) {
    return planckEnergy(wavelengthUm, temperatureK) * (wavelengthUm * 1e-6) / (H * C);
}

/** Calculated dL/dT from Planck's law, per K, in the same band/response as L.
 * The analytic derivative avoids finite-difference cancellation for small offsets.
 */
export function radianceDerivative(temperatureK, band = {}) {
    positive(temperatureK, "temperatureK");
    return integrateSpectrum(wavelengthUm => {
        const x = H * C / (wavelengthUm * 1e-6 * K * temperatureK);
        return planckEnergy(wavelengthUm, temperatureK) * x / (temperatureK * -Math.expm1(-x));
    }, band);
}

/** Piecewise-linear nonnegative response. Samples are [wavelengthUm, weight].
 * Zero outside supplied support. Knots are exposed for integration splitting.
 * The curve is copied, so later changes to the input do not change the response.
 */
export function tabulatedResponse(samples) {
    if (!Array.isArray(samples) || samples.length < 2) throw new RangeError("Need at least two samples");
    const points = samples.map(([wavelengthUm, w]) => [positive(wavelengthUm, "wavelengthUm"), nonnegative(w, "weight")]);
    for (let index = 1; index < points.length; index++) {
        if (points[index][0] <= points[index - 1][0]) throw new RangeError("Wavelengths must increase strictly");
    }
    const response = wavelengthUm => {
        if (wavelengthUm < points[0][0] || wavelengthUm > points.at(-1)[0]) return 0;
        let lo = 0, hi = points.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (points[mid][0] <= wavelengthUm) lo = mid; else hi = mid;
        }
        const t = (wavelengthUm - points[lo][0]) / (points[hi][0] - points[lo][0]);
        return points[lo][1] * (1 - t) + points[hi][1] * t;
    };
    response.breakpointsUm = points.map(radiancePair => radiancePair[0]);
    return response;
}

// Positive abscissas and weights of 8-point Gauss-Legendre quadrature.
const GX = [0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363];
const GW = [0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];

/** Integrate an energy spectrum, deriving photon counts from photon energy hc/lambda.
 * Radiance spectra return radiance pairs; irradiance spectra return irradiance pairs.
 * Both spectral input conventions are per um; integration removes only that unit.
 * band: {minUm=3, maxUm=5, response=1, breakpointsUm=[], relativeTolerance=1e-10}.
 * response may be a constant or a function. Supply ALL sharp features as breakpoints;
 * a numerical integrator cannot discover arbitrarily narrow unsampled features.
 */
export function integrateSpectrum(spectralEnergy, band = {}) {
    const {minUm = 3, maxUm = 5, response = 1, breakpointsUm = [], relativeTolerance = 1e-10} = band;
    positive(minUm, "minUm"); positive(maxUm, "maxUm");
    if (maxUm <= minUm) throw new RangeError("maxUm must exceed minUm");
    positive(relativeTolerance, "relativeTolerance");
    if (typeof spectralEnergy !== "function") throw new TypeError("spectralEnergy must be a function");
    const weight = typeof response === "function" ? response : () => nonnegative(response, "response");
    const knots = [...breakpointsUm, ...(response.breakpointsUm ?? [])];
    knots.forEach(x => positive(x, "breakpointUm"));
    const edges = [...new Set([minUm, ...knots.filter(x => x > minUm && x < maxUm), maxUm])].sort((a, b) => a - b);
    function gauss(a, b) {
        const mid = (a + b) / 2, half = (b - a) / 2;
        let energy = 0, photon = 0;
        for (let sample = 0; sample < GX.length; sample++) {
            for (const sign of [-1, 1]) {
                const wavelengthUm = mid + sign * half * GX[sample];
                const value = nonnegative(spectralEnergy(wavelengthUm), "spectralEnergy") * nonnegative(weight(wavelengthUm), "response");
                energy += GW[sample] * value;
                photon += GW[sample] * value * (wavelengthUm * 1e-6) / (H * C);
            }
        }
        return {energy: energy * half, photon: photon * half};
    }
    function refine(a, b, coarse, depth) {
        const mid = (a + b) / 2;
        const left = gauss(a, mid), right = gauss(mid, b);
        const fine = {energy: left.energy + right.energy, photon: left.photon + right.photon};
        // Calculated absolute quadrature floor: 1e-280 in each returned unit.
        // Subnormal Wien-tail samples cannot meet a relative precision criterion;
        // this is far below one photon per second over any modeled aperture.
        if (["energy", "photon"].every(q => Math.abs(fine[q] - coarse[q]) <=
            Math.max(1e-280, relativeTolerance * fine[q]))) return fine;
        if (depth === 0) throw new Error("Radiance quadrature did not converge; provide spectral breakpoints");
        const l = refine(a, mid, left, depth - 1), r = refine(mid, b, right, depth - 1);
        return {energy: l.energy + r.energy, photon: l.photon + r.photon};
    }
    const result = zero();
    for (let index = 1; index < edges.length; index++) {
        // At least 16 starting intervals, also split at supplied response knots.
        const count = Math.max(1, Math.ceil(16 * (edges[index] - edges[index - 1]) / (maxUm - minUm)));
        for (let sample = 0; sample < count; sample++) {
            const a = edges[index - 1] + (edges[index] - edges[index - 1]) * sample / count;
            const b = edges[index - 1] + (edges[index] - edges[index - 1]) * (sample + 1) / count;
            const value = refine(a, b, gauss(a, b), 18);
            result.energy += value.energy; result.photon += value.photon;
        }
    }
    return pair(result, "integral");
}

/** Blackbody band radiance pair; default flat 3.0–5.0 um band. */
export function inBandRadiance(temperatureK, band = {}) {
    nonnegative(temperatureK, "temperatureK");
    return integrateSpectrum(wavelengthUm => planckEnergy(wavelengthUm, temperatureK), band);
}

/** Idealized solar blackbody TOA irradiance, normal to rays, before any atmosphere.
 * Uniform solar disk: E = pi (R/d)^2 B. This is projected solid angle, not disk area
 * times 4*pi. The solar continuum is an approximation, not a measured spectrum.
 */
export function solarIrradiance({temperatureK = SOLAR_TEMPERATURE_K, radiusM = SOLAR_RADIUS_M,
    distanceM = AU_M} = {}, band = {}) {
    positive(radiusM, "radiusM"); positive(distanceM, "distanceM");
    if (distanceM <= radiusM) throw new RangeError("Observer must be outside solar surface");
    return scale(inBandRadiance(temperatureK, band), Math.PI * (radiusM / distanceM) ** 2);
}

/** Lambertian (direction-independent) reflected radiance = rho E cos(theta)/pi.
 * Negative incidence cosine means unilluminated. Caller handles any shadowing.
 */
export function diffuseSolarRadiance(irradiance, reflectance, cosIncidence = 1) {
    pair(irradiance, "irradiance"); fraction(reflectance, "reflectance");
    if (!Number.isFinite(cosIncidence) || Math.abs(cosIncidence) > 1) throw new RangeError("cosIncidence must be in [-1,1]");
    return scale(irradiance, reflectance * Math.max(0, cosIncidence) / Math.PI);
}

/** Opaque diffuse gray surface, constant emissivity over this band.
 * environment is cosine-weighted hemispheric incident radiance: E_environment/pi.
 * It excludes direct sun if solar is supplied. All pairs MUST use the same band/response.
 * Specular surfaces and transmitting media require a different reflection model.
 */
export function grayBodyRadiance({temperatureK, emissivity, environment = zero(), solar = zero(),
    cosIncidence = 1}, band = {}) {
    fraction(emissivity, "emissivity"); pair(environment, "environment");
    const emitted = scale(inBandRadiance(temperatureK, band), emissivity);
    const reflectedEnvironment = scale(environment, 1 - emissivity);
    const reflectedSolar = diffuseSolarRadiance(solar, 1 - emissivity, cosIncidence);
    return {emitted, reflectedEnvironment, reflectedSolar, total: {
        energy: emitted.energy + reflectedEnvironment.energy + reflectedSolar.energy,
        photon: emitted.photon + reflectedEnvironment.photon + reflectedSolar.photon,
    }};
}

/** Brightness/apparent blackbody temperature, K. Input units selected by quantity.
 * The same band and response used to form radiance must be used to invert it.
 * Throws for zero-throughput responses or out-of-bracket radiance; never clamps.
 */
export function apparentTemperature(radiance, {quantity = "photon", band = {}, minK = 0,
    maxK = 10000, toleranceK = 1e-7} = {}) {
    nonnegative(radiance, "radiance"); nonnegative(minK, "minK"); positive(maxK, "maxK");
    positive(toleranceK, "toleranceK");
    if (!["energy", "photon"].includes(quantity)) throw new RangeError("Unknown radiance quantity");
    if (maxK <= minK) throw new RangeError("maxK must exceed minK");
    let lo = minK, hi = maxK;
    const lowValue = inBandRadiance(lo, band)[quantity], highValue = inBandRadiance(hi, band)[quantity];
    if (highValue <= lowValue) throw new RangeError("Response has no invertible throughput in this bracket");
    if (radiance < lowValue || radiance > highValue) throw new RangeError("Radiance is outside temperature bracket");
    if (radiance === lowValue) return lo;
    if (radiance === highValue) return hi;
    for (let n = 0; n < 200 && hi - lo > toleranceK; n++) {
        const mid = (lo + hi) / 2;
        if (mid === lo || mid === hi) break;
        if (inBandRadiance(mid, band)[quantity] < radiance) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

/** Small-angle pixel solid angle in sr, IFOV angles in rad. */
export function pixelSolidAngle(ifovXRad, ifovYRad = ifovXRad) {
    return positive(ifovXRad, "ifovXRad") * positive(ifovYRad, "ifovYRad");
}

/** Pixel-averaged radiance and angular integral from geometric footprint overlap.
 * projectedAreaM2 is source area normal to the viewing ray, rangeM is slant range.
 * overlapFraction is the fraction of the SOURCE's apparent area in this pixel.
 * Default 1 is only valid when the entire source fits in this pixel.
 * For resolved sources supply one overlap per pixel; overlaps sum to 1.
 * Reject overfilled pixels instead of clamping and silently losing source energy.
 * angularIntegral units: W m^-2 or photons s^-1 m^-2 (per collecting area).
 */
export function pixelSignal({sourceRadiance, backgroundRadiance = 0, projectedAreaM2,
    rangeM, pixelSolidAngleSr, overlapFraction = 1}) {
    nonnegative(sourceRadiance, "sourceRadiance"); nonnegative(backgroundRadiance, "backgroundRadiance");
    nonnegative(projectedAreaM2, "projectedAreaM2"); positive(rangeM, "rangeM");
    positive(pixelSolidAngleSr, "pixelSolidAngleSr"); nonnegative(overlapFraction, "overlapFraction");
    if (overlapFraction > 1 + 1e-12) throw new RangeError("overlapFraction must be <= 1");
    const sourceSolidAngleSr = projectedAreaM2 / rangeM ** 2;
    const overlapSr = sourceSolidAngleSr * Math.min(1, overlapFraction);
    let fillFraction = overlapSr / pixelSolidAngleSr;
    if (fillFraction > 1 + 1e-12) throw new RangeError("Source overlap exceeds pixel solid angle; distribute across pixels");
    fillFraction = Math.min(1, fillFraction); // floating-point tolerance only
    const radiance = backgroundRadiance + (sourceRadiance - backgroundRadiance) * fillFraction;
    return {sourceSolidAngleSr, fillFraction, radiance,
        angularIntegral: radiance * pixelSolidAngleSr,
        sourceAngularIntegral: sourceRadiance * overlapSr,
        excessAngularIntegral: (sourceRadiance - backgroundRadiance) * overlapSr};
}

/** Float32 log2(L/unitScale) LUT sampled uniformly in log2(T), inclusive endpoints.
 * Default photon table: 2048 texels, 180–3000 K, 8192 bytes, unitScale=1e20.
 * For energy, default unitScale=4 W m^-2 sr^-1. Rebuild for each band/response.
 */
export function createRadianceLUT({size = 2048, minK = 180, maxK = 3000, quantity = "photon",
    unitScale = quantity === "photon" ? PHOTON_SCALE : 4, band = {}} = {}) {
    if (!Number.isInteger(size) || size < 2) throw new RangeError("size must be an integer >= 2");
    positive(minK, "minK"); positive(maxK, "maxK"); positive(unitScale, "unitScale");
    if (maxK <= minK) throw new RangeError("maxK must exceed minK");
    if (!["energy", "photon"].includes(quantity)) throw new RangeError("Unknown radiance quantity");
    const logMinK = Math.log2(minK), logRangeK = Math.log2(maxK / minK);
    const values = new Float32Array(size);
    for (let index = 0; index < size; index++) {
        const temperatureK = minK * 2 ** (logRangeK * index / (size - 1));
        const value = inBandRadiance(temperatureK, band)[quantity];
        positive(value, "LUT radiance");
        values[index] = Math.log2(value / unitScale);
    }
    return {values, size, minK, maxK, quantity, unitScale, logMinK, logRangeK};
}

/** CPU equivalent of log-value interpolation; returns physical linear radiance.
 * Rejects temperatures outside the table. Shader callers must use the same policy.
 */
export function sampleRadianceLUT(lut, temperatureK) {
    positive(temperatureK, "temperatureK");
    if (temperatureK < lut.minK || temperatureK > lut.maxK) throw new RangeError("Temperature outside LUT");
    const position = Math.max(0, Math.min(lut.size - 1,
        (Math.log2(temperatureK) - lut.logMinK) / lut.logRangeK * (lut.size - 1)));
    const index = Math.min(lut.size - 2, Math.floor(position)), t = position - index;
    return lut.unitScale * 2 ** (lut.values[index] * (1 - t) + lut.values[index + 1] * t);
}
