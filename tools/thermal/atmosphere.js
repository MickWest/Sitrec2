import {H, C, PHOTON_SCALE, apparentTemperature, inBandRadiance, radianceDerivative} from "./radiometry.js";

/**
 * Dependency-free, reduced MWIR radiative-transfer model.
 * All distances are m, temperatures K, pressures Pa, angles rad. Radiance is
 * integrated over each band, W m^-2 sr^-1 by default. Photon mode uses
 * photons s^-1 m^-2 sr^-1. Neither convention is per micrometer or irradiance.
 *
 * Status: phenomenological bands with one local broadband calibration anchor,
 * NOT a MODTRAN/HITRAN spectral fit.
 * Exact positive layer transfer; approximate molecular spectroscopy, continua,
 * aerosol treatment and plume spectra. Do not infer detection from transmission.
 */

const P0 = 101325, T0 = 296, R_AIR = 287.05287, G = 9.80665;
const KB = 1.380649e-23;
const NA = 6.02214076e23, MW = 0.01801528;
export const EARTH_RADIUS_M = 6371000;

// Calculated first intersection with the same unrefracted sphere used for
// atmospheric transfer. Infinity means no foreground sea on this ray.
export function thermalSeaDistance(sensorAltitudeM, sineElevation, radiusM = EARTH_RADIUS_M) {
    const radial = radiusM + sensorAltitudeM;
    const heightTerm = sensorAltitudeM * (2 * radiusM + sensorAltitudeM);
    const discriminant = radial * radial * sineElevation * sineElevation - heightTerm;
    if (sineElevation >= 0 || discriminant < 0) return Infinity;
    return heightTerm / (-radial * sineElevation + Math.sqrt(discriminant));
}

// Calculated lower elevation of a visible endpoint at range r. Beyond the
// tangent range the horizon, rather than the far sphere intersection, limits it.
export function cloudMinimumElevation(altitudeM, rangeM) {
    const radial = EARTH_RADIUS_M + altitudeM;
    const tangent = Math.sqrt(altitudeM * (2 * EARTH_RADIUS_M + altitudeM));
    return rangeM >= tangent ? -Math.acos(EARTH_RADIUS_M / radial) :
        Math.asin(clamp(-(tangent * tangent + rangeM * rangeM) / (2 * radial * Math.max(rangeM, Number.MIN_VALUE)), -1, 1));
}

// Nominal k coefficients at 296 K, 101325 Pa, CO2 mole fraction 420e-6,
// H2O mass density 0.010 kg m^-3. Raw table values are in km^-1 and converted to m^-1.
// Shapes are modeling assumptions, not extracted spectral measurements. The
// water multiplier 3 approximately anchors the 5000 m surface-path transmission
// in a surface-path broadband comparison (transmission 0.166084).
// This broadband anchor cannot validate the spectral allocation or altitude scaling.
// The trace-gas term represents unresolved CH4/CO/N2O features provisionally.
const DEFINITIONS = [
    [3.00, 3.30, "water-short", 0.00001, 0.80, 0.008],
    [3.30, 3.60, "methane-window", 0.00002, 0.15, 0.080],
    [3.60, 4.00, "window", 0.00003, 0.008, 0.002],
    [4.00, 4.10, "blue-outer", 0.0003, 0.005, 0.001],
    [4.10, 4.20, "blue-wing", 0.008, 0.008, 0.001],
    [4.20, 4.28, "co2-blue-shoulder", 0.8, 0.015, 0.001],
    [4.28, 4.38, "co2-center", 30, 0.020, 0.001],
    [4.38, 4.45, "co2-red-shoulder", 4, 0.025, 0.001],
    [4.45, 4.55, "red-inner", 0.04, 0.040, 0.001],
    [4.55, 4.70, "red-wing", 0.003, 0.100, 0.080],
    [4.70, 4.85, "water-red", 0.0003, 0.350, 0.010],
    [4.85, 5.00, "water-long", 0.0001, 0.900, 0.001],
];
export const BANDS = Object.freeze(DEFINITIONS.map(([lo, hi, id, co2, h2o, trace]) =>
    Object.freeze({id, minM: lo * 1e-6, maxM: hi * 1e-6,
        co2PerM: co2 / 1000, waterPerM: 3 * h2o / 1000, tracePerM: trace / 1000})));
const N = BANDS.length;
const KW = [0.55, 0.30, 0.15];
const KC = [0.25, 1, 8], KH = [0.10, 1, 20];
export const CHANNEL_WEIGHTS = Object.freeze(KW.flatMap(co2Weight => KW.map(waterWeight => co2Weight * waterWeight)));
const NC = CHANNEL_WEIGHTS.length;
const zeros = n => new Float64Array(n);
const sum = a => a.reduce((s, x) => s + x, 0);
const clamp = (value, lower, upper) => Math.max(lower, Math.min(upper, value));
// name is an error label; scalar value and limits share the caller's physical unit.
function number(name, x, min = 0, max = Infinity) {
    if (!Number.isFinite(x) || x < min || x > max) throw new RangeError(`${name} is invalid: ${x}`);
    return x;
}
// name is a label; a holds nonnegative band quantities, n is a band/channel count.
function spectrum(name, a, n = N) {
    if (!a || a.length !== n) throw new RangeError(`${name} requires ${n} nonnegative values`);
    for (const x of a) number(name, x);
    return a;
}

// Internal Planck integration: four-point Gauss quadrature in wavelength.
// Exposed only as a band boundary source needed by the atmosphere helpers/tests.
const GX = [-0.8611363115940526, -0.3399810435848563, 0.3399810435848563, 0.8611363115940526];
const GW = [0.3478548451374538, 0.6521451548625461, 0.6521451548625461, 0.3478548451374538];
// temperatureK is K; band endpoints um; quantity selects W m^-2 sr^-1 or photons s^-1 m^-2 sr^-1.
export function blackbodyBands(temperatureK, {quantity = "energy", band = {minUm: 3, maxUm: 5}} = {}) {
    if (quantity !== "energy" && quantity !== "photon") throw new RangeError("Unknown radiance quantity");
    number("temperatureK", temperatureK, 0, 10000);
    return Float64Array.from(BANDS, spectralBand => {
        if (!temperatureK) return 0;
        const lowerM = Math.max(band.minUm * 1e-6, spectralBand.minM);
        const upperM = Math.min(band.maxUm * 1e-6, spectralBand.maxM);
        if (upperM <= lowerM) return 0;
        const mid = (lowerM + upperM) / 2, half = (upperM - lowerM) / 2;
        let value = 0;
        for (let index = 0; index < 4; index++) {
            const wavelengthM = mid + half * GX[index];
            value += (quantity === "photon" ? wavelengthM / (H * C) : 1) * GW[index] * 2 * H * C * C / (wavelengthM ** 5 * Math.expm1(H * C / (wavelengthM * KB * temperatureK)));
        }
        return value * half;
    });
}

// Bolton liquid-water saturation expression. Below freezing this is relative to
// supercooled liquid water, deliberately; explicit vapor density avoids that convention.
// T is K; return saturation vapor pressure in Pa.
function saturationPa(T) {
    const tc = T - 273.15;
    return 611.2 * Math.exp(17.67 * tc / (tc + 243.5));
}
// p is Pa, temperatures K, dz m; return hydrostatic pressure in Pa.
function pressureStep(p, t1, t2, dz) {
    if (!dz) return p;
    const lapse = (t2 - t1) / dz;
    return Math.abs(lapse) < 1e-10 ? p * Math.exp(-G * dz / (R_AIR * t1))
        : p * (t2 / t1) ** (-G / (R_AIR * lapse));
}
const STANDARD_T = [[0, 288.15], [11000, 216.65], [20000, 216.65],
    [32000, 228.65], [47000, 270.65], [51000, 270.65], [71000, 214.65], [80000, 196.65]];

/**
 * Create once and reuse per frame. Options:
 * temperatureProfile: [{altitudeM, temperatureK}, ...], first level at 0 m;
 *   linear T, hydrostatic dry-air pressure. Default: standard-atmosphere layers.
 * surfaceTemperatureK: sea-level air temperature, default 288.15 K (U.S. Standard
 *   Atmosphere 1976). Shift standard layers by its difference from 288.15 K;
 *   retain a 150 K lower bound. Explicit profiles take precedence.
 * profile(z): optional alternative returning {temperatureK, pressurePa,
 *   waterVaporDensityKgM3} OR {temperatureK, pressurePa, relativeHumidity}.
 *   profile has priority over temperatureProfile and default vapor profile.
 * relativeHumidity: constant fraction at each height, OR use the default
 *   surfaceWaterVaporDensityKgM3 * exp(-z/waterScaleHeightM), capped at saturation.
 * aerosolExtinction4umPerM(z): overrides visibility-derived aerosol profile.
 * aerosolSingleScatteringAlbedo > 0 requires aerosolIncidentRadiance(z), a band
 *   array giving the phase-function-weighted incident radiance. No scattering solver.
 * densityScale: multiplies ALL extinction terms; 0 is a true vacuum.
 */
export function createAtmosphere(options = {}) {
    // Profile, humidity, aerosol and abundance defaults are estimated boundary conditions.
    const optionsResolved = {...{
        surfacePressurePa: P0, surfaceTemperatureK: 288.15, surfaceWaterVaporDensityKgM3: 0.010,
        waterScaleHeightM: 2000, co2MoleFraction: 420e-6,
        visibilityM: 23000, aerosolRatio4um: 0.15, aerosolScaleHeightM: 1000,
        aerosolSpectralPower: 1, aerosolSingleScatteringAlbedo: 0,
        densityScale: 1, co2Scale: 1, waterLineScale: 1, traceGasScale: 1,
        continuumScale: 1, topAltitudeM: 80000,
    }, ...options};
    for (const key of ["surfacePressurePa", "surfaceWaterVaporDensityKgM3", "co2MoleFraction",
        "aerosolRatio4um", "densityScale", "co2Scale", "waterLineScale", "traceGasScale", "continuumScale"]) number(key, optionsResolved[key]);
    for (const key of ["waterScaleHeightM", "aerosolScaleHeightM", "topAltitudeM"]) number(key, optionsResolved[key], 1);
    if (optionsResolved.visibilityM !== Infinity) number("visibilityM", optionsResolved.visibilityM, 1);
    number("aerosolSpectralPower", optionsResolved.aerosolSpectralPower, -4, 4);
    number("aerosolSingleScatteringAlbedo", optionsResolved.aerosolSingleScatteringAlbedo, 0, 1);
    if (optionsResolved.relativeHumidity !== undefined) number("relativeHumidity", optionsResolved.relativeHumidity, 0, 1);
    if (optionsResolved.aerosolSingleScatteringAlbedo > 0 && !optionsResolved.aerosolIncidentRadiance)
        throw new Error("Scattering aerosols require aerosolIncidentRadiance; extinction is not thermal absorption.");
    number("surfaceTemperatureK", optionsResolved.surfaceTemperatureK, 150, 350);
    const levels = (optionsResolved.temperatureProfile ?? STANDARD_T.map(([altitudeM, temperatureK]) =>
        ({altitudeM, temperatureK: Math.max(150, temperatureK + optionsResolved.surfaceTemperatureK - 288.15)})))
        .map(row => ({...row}));
    if (levels.length < 2 || levels[0].altitudeM !== 0) throw new Error("temperatureProfile must start at 0 m and have at least two levels");
    for (let index = 0; index < levels.length; index++) {
        const row = levels[index];
        number("profile altitudeM", row.altitudeM);
        number("profile temperatureK", row.temperatureK, 150, 350);
        if (index && row.altitudeM <= levels[index - 1].altitudeM) throw new Error("Profile heights must increase");
        row.pressurePa = index ? pressureStep(levels[index - 1].pressurePa, levels[index - 1].temperatureK,
            row.temperatureK, row.altitudeM - levels[index - 1].altitudeM) : optionsResolved.surfacePressurePa;
    }
    function sample(altitudeM) {
        const z = Math.max(0, altitudeM);
        let state;
        if (optionsResolved.profile) state = optionsResolved.profile(z);
        else {
            let index = 0;
            while (index < levels.length - 2 && z > levels[index + 1].altitudeM) index++;
            const lowerLevel = levels[index], upperLevel = levels[index + 1];
            const t = z >= upperLevel.altitudeM ? upperLevel.temperatureK : lowerLevel.temperatureK +
                (upperLevel.temperatureK - lowerLevel.temperatureK) * (z - lowerLevel.altitudeM) / (upperLevel.altitudeM - lowerLevel.altitudeM);
            const p = z >= upperLevel.altitudeM ? pressureStep(upperLevel.pressurePa, t, t, z - upperLevel.altitudeM)
                : pressureStep(lowerLevel.pressurePa, lowerLevel.temperatureK, t, z - lowerLevel.altitudeM);
            const maxWater = saturationPa(t) * MW / (8.31446261815324 * t);
            const water = optionsResolved.relativeHumidity === undefined ?
                Math.min(maxWater, optionsResolved.surfaceWaterVaporDensityKgM3 * Math.exp(-z / optionsResolved.waterScaleHeightM)) : maxWater * optionsResolved.relativeHumidity;
            state = {temperatureK: t, pressurePa: p, waterVaporDensityKgM3: water};
        }
        const temperatureK = number("profile temperatureK", state.temperatureK, 150, 350);
        const pressurePa = number("profile pressurePa", state.pressurePa);
        const waterVaporDensityKgM3 = state.waterVaporDensityKgM3 !== undefined ?
            number("profile waterVaporDensityKgM3", state.waterVaporDensityKgM3) :
            number("profile relativeHumidity", state.relativeHumidity, 0, 1) * saturationPa(temperatureK) * MW / (8.31446261815324 * temperatureK);
        const vaporPressurePa = waterVaporDensityKgM3 * 8.31446261815324 * temperatureK / MW;
        if (vaporPressurePa > pressurePa + 1e-6) throw new RangeError("Water partial pressure exceeds total pressure");
        const aerosolPerM = optionsResolved.aerosolExtinction4umPerM ? optionsResolved.aerosolExtinction4umPerM(z) :
            Math.log(50) / optionsResolved.visibilityM * optionsResolved.aerosolRatio4um * Math.exp(-z / optionsResolved.aerosolScaleHeightM);
        number("aerosol extinction", aerosolPerM);
        const active = z >= optionsResolved.topAltitudeM ? 0 : optionsResolved.densityScale;
        return {temperatureK, pressurePa, waterVaporDensityKgM3, vaporPressurePa, aerosolPerM: aerosolPerM * active, active};
    }
    return Object.freeze({options: Object.freeze(optionsResolved), sample,
        layerAltitudesM: Object.freeze([...(optionsResolved.layerAltitudesM ?? levels.map(level => level.altitudeM))])});
}

/** Resolve spherical straight-ray geometry. earthRadiusM=Infinity is a deliberately
 * flat laboratory comparison, not a way to see through the Earth. effective-radius
 * refraction, if desired, is supplied as earthRadiusM by the caller. No ray bending.
 * With target altitude + elevation only, select the nearest positive intersection.
 */
export function solvePath({sensorAltitudeM, targetAltitudeM, slantRangeM, elevationRad,
    earthRadiusM = EARTH_RADIUS_M}) {
    number("sensorAltitudeM", sensorAltitudeM);
    if (targetAltitudeM !== undefined) number("targetAltitudeM", targetAltitudeM);
    if (elevationRad !== undefined) number("elevationRad", elevationRad, -Math.PI / 2, Math.PI / 2);
    if (earthRadiusM !== Infinity) number("earthRadiusM", earthRadiusM, 1);
    const flat = earthRadiusM === Infinity;
    const r = earthRadiusM + sensorAltitudeM;
    let s = elevationRad === undefined ? undefined : Math.sin(elevationRad);
    let lengthM = slantRangeM;
    if (lengthM === undefined) {
        if (s === undefined || targetAltitudeM === undefined) throw new Error("Supply range and target altitude or elevation, or target altitude and elevation");
        if (flat) lengthM = (targetAltitudeM - sensorAltitudeM) / s;
        else {
            const d = (targetAltitudeM - sensorAltitudeM) * (2 * earthRadiusM + targetAltitudeM + sensorAltitudeM);
            const disc = r * r * s * s + d;
            if (disc < 0) throw new RangeError("Ray does not intersect the requested altitude");
            const roots = [-r * s - Math.sqrt(disc), -r * s + Math.sqrt(disc)].filter(x => x > 1e-7);
            lengthM = roots.length ? Math.min(...roots) : (d === 0 ? 0 : NaN);
        }
    }
    number("slantRangeM", lengthM);
    if (!lengthM) {
        if (targetAltitudeM !== undefined && Math.abs(targetAltitudeM - sensorAltitudeM) > 1e-6)
            throw new RangeError("A zero path must have coincident endpoint altitudes");
        s = s ?? 0;
        targetAltitudeM = sensorAltitudeM;
    } else if (targetAltitudeM !== undefined) {
        const implied = flat ? (targetAltitudeM - sensorAltitudeM) / lengthM :
            ((targetAltitudeM - sensorAltitudeM) * (2 * earthRadiusM + targetAltitudeM + sensorAltitudeM) - lengthM * lengthM) / (2 * r * lengthM);
        if (Math.abs(implied) > 1 + 1e-10) throw new RangeError("Endpoint heights and range are geometrically inconsistent");
        if (s !== undefined && Math.abs(s - implied) * lengthM > 0.1) throw new RangeError("Range, elevation and target altitude disagree by more than 0.1 m");
        s = clamp(implied, -1, 1);
    } else if (s === undefined) throw new Error("Supply target altitude or elevation");
    function altitudeAt(distanceM) {
        if (flat) return sensorAltitudeM + distanceM * s;
        // Rationalize the radius difference to retain precision for short rays.
        const q = 2 * r * s * distanceM + distanceM * distanceM;
        return sensorAltitudeM + q / (Math.sqrt(r * r + q) + r);
    }
    targetAltitudeM = altitudeAt(lengthM);
    const closestM = flat ? (s < 0 ? lengthM : 0) : clamp(-r * s, 0, lengthM);
    const minimumAltitudeM = altitudeAt(closestM);
    return {sensorAltitudeM, targetAltitudeM, slantRangeM: lengthM,
        elevationRad: Math.asin(s), earthRadiusM, minimumAltitudeM,
        occluded: minimumAltitudeM < -1e-5, altitudeAt};
}

// path distances/altitudes m; segments is a count; output is observer distance in m.
function layerEdges(path, atmosphere, segments) {
    // Cosine spacing resolves both endpoint boundary layers; also split at every
    // specified temperature layer and at atmospheric entry/exit and the tangent.
    const length = path.slantRangeM;
    const edges = Array.from({length: segments + 1}, (_, index) => length * (1 - Math.cos(Math.PI * index / segments)) / 2);
    const s = Math.sin(path.elevationRad), R = path.earthRadiusM;
    const heights = [...atmosphere.layerAltitudesM, atmosphere.options.topAltitudeM];
    if (R !== Infinity) {
        const r = R + path.sensorAltitudeM, tangent = -r * s;
        if (tangent > 0 && tangent < length) edges.push(tangent);
        for (const h of heights) {
            const disc = r * r * s * s + (h - path.sensorAltitudeM) * (2 * R + h + path.sensorAltitudeM);
            if (disc < 0) continue;
            for (const x of [tangent - Math.sqrt(disc), tangent + Math.sqrt(disc)])
                if (x > 0 && x < length) edges.push(x);
        }
    } else if (s !== 0) {
        for (const h of heights) {
            const x = (h - path.sensorAltitudeM) / s;
            if (x > 0 && x < length) edges.push(x);
        }
    }
    return edges.sort((a, bandIndex) => a - bandIndex).filter((x, index, a) => !index || x - a[index - 1] > 1e-8);
}

/** Return band transmission and additive path radiance. The nine channels per
 * band retain three absorption ranks for each of CO2 and water with random
 * inter-species overlap; ranks are held correlated between atmospheric layers.
 * Uniform input radiance inside a band is assumed when collapsing to band arrays.
 * input geometry uses m/rad; segments is a count. quantity selects energy or photon
 * radiance and applies to aerosol incident radiance too; band endpoints are um.
 */
export function evaluatePath(input, atmosphere = createAtmosphere(), {segments = 32, quantity = "energy", band = {minUm: 3, maxUm: 5}} = {}) {
    if (!["energy", "photon"].includes(quantity)) throw new RangeError("Unknown radiance quantity");
    number("segments", segments, 1, 4096);
    if (!Number.isInteger(segments)) throw new RangeError("segments must be an integer");
    const geometry = solvePath(input);
    if (geometry.occluded && !input.visibilityResolved) throw new RangeError("Path crosses the Earth; render the foreground surface instead");
    const transmissionChannels = new Float64Array(N * NC).fill(1);
    const pathRadianceChannels = zeros(N * NC);
    const opticalDepthComponents = {co2: zeros(N), waterLines: zeros(N), trace: zeros(N), continuum: zeros(N), aerosol: zeros(N)};
    const edges = layerEdges(geometry, atmosphere, segments);
    const optionsResolved = atmosphere.options;
    for (let segment = 1; segment < edges.length; segment++) {
        const ds = edges[segment] - edges[segment - 1];
        const altitudeM = geometry.altitudeAt((edges[segment] + edges[segment - 1]) / 2);
        const air = atmosphere.sample(altitudeM);
        if (!air.active) continue;
        const T = air.temperatureK, p = air.pressurePa / P0, e = air.vaporPressurePa / P0;
        const density = p * T0 / T;
        // Approximate pressure-broadening correction; no line-by-line temperature
        // intensities. The exponent is an explicit phenomenological assumption.
        const broadening = Math.sqrt(p) * (T0 / T) ** 0.7;
        const co2Scale = density * broadening * optionsResolved.co2MoleFraction / 420e-6 * optionsResolved.co2Scale * air.active;
        const waterScale = air.waterVaporDensityKgM3 / 0.010 * broadening * optionsResolved.waterLineScale * air.active;
        const molecules = air.waterVaporDensityKgM3 / MW * NA;
        const waterContinuum = molecules * (3e-28 * (T0 / T) ** 4 * e + 3e-30 * Math.max(0, p - e));
        const B = blackbodyBands(T, {quantity, band});
        const J = optionsResolved.aerosolSingleScatteringAlbedo ? spectrum("aerosolIncidentRadiance", typeof optionsResolved.aerosolIncidentRadiance === "function" ? optionsResolved.aerosolIncidentRadiance(altitudeM) : optionsResolved.aerosolIncidentRadiance) : null;
        for (let bandIndex = 0; bandIndex < N; bandIndex++) {
            const band = BANDS[bandIndex], lambda = (band.minM + band.maxM) / 2;
            const kc = band.co2PerM * co2Scale, kh = band.waterPerM * waterScale;
            const kt = band.tracePerM * density * broadening * optionsResolved.traceGasScale * air.active;
            const nitrogenContinuum = 4.5e-5 * Math.exp(-(((1 / (lambda * 100) - 2330) / 85) ** 2)) * (0.781 * p * 273.15 / T) ** 2;
            const kcont = (waterContinuum + nitrogenContinuum) * optionsResolved.continuumScale * air.active;
            const ka = air.aerosolPerM * (lambda / 4e-6) ** -optionsResolved.aerosolSpectralPower;
            opticalDepthComponents.co2[bandIndex] += kc * ds;
            opticalDepthComponents.waterLines[bandIndex] += kh * ds;
            opticalDepthComponents.trace[bandIndex] += kt * ds;
            opticalDepthComponents.continuum[bandIndex] += kcont * ds;
            opticalDepthComponents.aerosol[bandIndex] += ka * ds;
            for (let ci = 0; ci < 3; ci++) for (let wi = 0; wi < 3; wi++) {
                const ch = bandIndex * NC + ci * 3 + wi;
                const absorption = kc * KC[ci] + kh * KH[wi] + kt + kcont + ka * (1 - optionsResolved.aerosolSingleScatteringAlbedo);
                const scatter = ka * optionsResolved.aerosolSingleScatteringAlbedo;
                const extinction = absorption + scatter;
                if (!extinction) continue;
                const removed = -Math.expm1(-extinction * ds);
                const source = (absorption * B[bandIndex] + (J ? scatter * J[bandIndex] : 0)) / extinction;
                pathRadianceChannels[ch] += transmissionChannels[ch] * removed * source;
                transmissionChannels[ch] *= 1 - removed;
            }
        }
    }
    const transmission = collapse(transmissionChannels), pathRadiance = collapse(pathRadianceChannels);
    return {geometry, quantity, band: {...band}, transmission, pathRadiance, transmissionChannels, pathRadianceChannels,
        flatTransmission: sum(transmission.map((x, index) => x * (BANDS[index].maxM - BANDS[index].minM))) / 2e-6,
        pathRadianceWm2Sr: quantity === "energy" ? sum(pathRadiance) : undefined,
        pathRadiancePhotons: quantity === "photon" ? sum(pathRadiance) : undefined, opticalDepthComponents, layerCount: Math.max(0, edges.length - 1)};
}
function collapse(channels) {
    return Float64Array.from(BANDS, (_, bandIndex) => CHANNEL_WEIGHTS.reduce((s, w, index) => s + w * channels[bandIndex * NC + index], 0));
}

/** Smooth source in each band. For a resolved structured spectrum, the caller
 * should supply its own fitted spectral transfer table; these bands cannot recover
 * unresolved plume/atmosphere line correlation. path is evaluatePath output;
 * sourceBands uses the same physical radiance unit selected by path.quantity. */
export function transmitRadiance(path, sourceBands) {
    spectrum("sourceBands", sourceBands);
    const direct = sourceBands.map((x, index) => x * path.transmission[index]);
    const sourceRadiance = sum(sourceBands), directRadiance = sum(direct);
    const observedRadiance = directRadiance + sum(path.pathRadiance);
    const suffix = path.quantity === "photon" ? "Photons" : "Wm2Sr";
    return {direct: Float64Array.from(direct), observed: Float64Array.from(direct, (value, index) => value + path.pathRadiance[index]),
        quantity: path.quantity ?? "energy", sourceRadiance, directRadiance, observedRadiance,
        [`sourceRadiance${suffix}`]: sourceRadiance, [`directRadiance${suffix}`]: directRadiance,
        [`observedRadiance${suffix}`]: observedRadiance,
        effectiveTransmission: sourceRadiance ? directRadiance / sourceRadiance : null};
}

// Unit-integral illustrative emission distributions, NOT measured engine spectra.
export const PLUME_COMPONENTS = Object.freeze({
    co2Center: Object.freeze([0, 0, 0, 0, 0, 0.15, 0.65, 0.20, 0, 0, 0, 0]),
    blueWing: Object.freeze([0, 0, 0, 0.25, 0.75, 0, 0, 0, 0, 0, 0, 0]),
    redWing: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0.30, 0.70, 0, 0]),
    water: Object.freeze([0.50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.20, 0.30]),
});
/** Supply fractions explicitly; broader/hotter plume spectra should be supplied
 * by the signature model (preferably HITEMP or measured). No assumed temperature
 * uniquely determines these fractions. Output is conditional atmospheric survival. */
export function plumeSurvival(path, fractions) {
    const bands = zeros(N), components = {};
    let total = 0;
    for (const [name, template] of Object.entries(PLUME_COMPONENTS)) {
        const fraction = number(`plume fraction ${name}`, fractions[name] ?? 0, 0, 1);
        total += fraction;
        components[name] = sum(template.map((x, index) => x * path.transmission[index]));
        for (let index = 0; index < N; index++) bands[index] += fraction * template[index];
    }
    if (Math.abs(total - 1) > 1e-8) throw new RangeError("Plume fractions must sum to one");
    return {effectiveTransmission: sum(bands.map((x, index) => x * path.transmission[index])), components,
        sourceBandFractions: bands, transmittedBandFractions: Float64Array.from(bands, (x, index) => x * path.transmission[index])};
}

/** Thermal clear sky, excluding sunlight and external clouds. Below the geometric
 * horizon return a surface intersection, not a fictitious sky temperature. */
export function clearSky({sensorAltitudeM, elevationRad, earthRadiusM = EARTH_RADIUS_M}, atmosphere = createAtmosphere(), accuracy) {
    number("sensorAltitudeM", sensorAltitudeM);
    number("elevationRad", elevationRad, -Math.PI / 2, Math.PI / 2);
    if (!Number.isFinite(earthRadiusM)) throw new RangeError("Sky geometry requires a finite Earth radius");
    number("earthRadiusM", earthRadiusM, 1);
    const r = earthRadiusM + sensorAltitudeM, s = Math.sin(elevationRad);
    const distanceM = thermalSeaDistance(sensorAltitudeM, s, earthRadiusM);
    if (Number.isFinite(distanceM)) return {kind: "surface", distanceM};
    const top = Math.max(atmosphere.options.topAltitudeM, sensorAltitudeM + 1);
    const length = -r * s + Math.sqrt(r * r * s * s + (top - sensorAltitudeM) * (2 * earthRadiusM + top + sensorAltitudeM));
    const path = evaluatePath({sensorAltitudeM, elevationRad, slantRangeM: length, earthRadiusM}, atmosphere, accuracy ?? {segments: 64});
    return {kind: "sky", radiance: path.pathRadiance, radianceChannels: path.pathRadianceChannels,
        radianceWm2Sr: path.pathRadianceWm2Sr, path};
}

/** Cloud top or side: an isothermal absorbing slab with a specified temperature
 * and normal absorption optical depth. The normal/view cosine distinguishes a
 * top from a side. Optically thick cloud is robust; thin scattering cloud is not.
 * Atmosphere in front of the cloud is supplied as a precomputed path. Source and
 * behindRadiance use path.quantity and path.band (legacy default: energy, 3–5 um).
 */
export function cloudBackground(path, {temperatureK, normalOpticalDepth = 20, viewCosine = 1,
    behindRadiance = zeros(N)}) {
    number("normalOpticalDepth", normalOpticalDepth);
    number("viewCosine", viewCosine, 0, 1);
    spectrum("behindRadiance", behindRadiance);
    const cloudTransmission = normalOpticalDepth === 0 ? 1 : Math.exp(-normalOpticalDepth / Math.max(1e-12, viewCosine));
    const B = blackbodyBands(temperatureK, {quantity: path.quantity ?? "energy", band: path.band});
    const source = B.map((x, index) => (1 - cloudTransmission) * x + cloudTransmission * behindRadiance[index]);
    return {...transmitRadiance(path, source), cloudTransmission};
}

// a and imaginaryPart are dimensionless complex-index components.
function complexSqrt(a, imaginaryPart) {
    const r = Math.hypot(a, imaginaryPart);
    return [Math.sqrt(Math.max(0, (r + a) / 2)), Math.sign(imaginaryPart) * Math.sqrt(Math.max(0, (r - a) / 2))];
}
/** Unpolarized Fresnel reflectance for opaque water. n+ik is an explicit
 * gray approximation, used for the Omaha surface-path comparison, not a spectral water table. */
export function seaReflectance(cosIncidence, n = 1.35, k = 0.01) {
    number("cosIncidence", cosIncidence, 0, 1); number("water n", n, 1); number("water k", k);
    const a = n * n - k * k, bandIndex = 2 * n * k;
    const [qr, qi] = complexSqrt(a - (1 - cosIncidence * cosIncidence), bandIndex);
    const c = cosIncidence;
    const rs = ((c - qr) ** 2 + qi * qi) / ((c + qr) ** 2 + qi * qi);
    const rp = ((a * c - qr) ** 2 + (bandIndex * c - qi) ** 2) / ((a * c + qr) ** 2 + (bandIndex * c + qi) ** 2);
    return (rs + rp) / 2;
}

/** Sea emission plus reflected sky, then foreground atmosphere. Facets, when
 * supplied, require projected-area weights, local incidence cosine and reflected
 * elevationRad. They are a caller-provided roughness distribution, not a wave model.
 * Correlated channel radiance is retained through sky reflection and foreground.
 */
export function seaBackground({sensorAltitudeM, elevationRad, temperatureK = 290,
    earthRadiusM = EARTH_RADIUS_M, slantRangeM, visibilityResolved, facets, refractiveIndex = 1.35, extinctionIndex = 0.01},
    atmosphere = createAtmosphere(), accuracy) {
    const hit = visibilityResolved ? {kind: "surface", distanceM: slantRangeM} : clearSky({sensorAltitudeM, elevationRad, earthRadiusM}, atmosphere, accuracy);
    if (hit.kind !== "surface") throw new RangeError("Ray does not hit the sea");
    const path = evaluatePath({sensorAltitudeM, targetAltitudeM: 0, slantRangeM: hit.distanceM, earthRadiusM, visibilityResolved}, atmosphere, accuracy);
    const cos = clamp(-((earthRadiusM + sensorAltitudeM) * Math.sin(elevationRad) + hit.distanceM) / earthRadiusM, 0, 1);
    facets = facets ?? [{weight: 1, cosIncidence: cos, reflectedElevationRad: Math.asin(cos)}];
    const weights = sum(facets.map(facet => number("facet weight", facet.weight)));
    if (!weights) throw new RangeError("Facet weights must have a positive sum");
    const B = blackbodyBands(temperatureK, {quantity: path.quantity, band: accuracy?.band}), sourceChannels = zeros(N * NC);
    let meanReflectance = 0;
    for (const facet of facets) {
        number("reflectedElevationRad", facet.reflectedElevationRad, 0, Math.PI / 2);
        const reflection = seaReflectance(facet.cosIncidence, refractiveIndex, extinctionIndex);
        const sky = clearSky({sensorAltitudeM: 0, elevationRad: facet.reflectedElevationRad, earthRadiusM}, atmosphere, accuracy);
        const weight = facet.weight / weights;
        meanReflectance += weight * reflection;
        for (let index = 0; index < N * NC; index++) sourceChannels[index] += weight * ((1 - reflection) * B[Math.floor(index / NC)] + reflection * sky.radianceChannels[index]);
    }
    const observedChannels = sourceChannels.map((x, index) => x * path.transmissionChannels[index] + path.pathRadianceChannels[index]);
    const radiance = collapse(observedChannels);
    return {kind: "sea", radiance, radianceWm2Sr: sum(radiance), radianceChannels: observedChannels,
        sourceRadiance: collapse(sourceChannels), meanReflectance, path};
}

/** Camera-space local up, with camera forward -Z and image up +Y. The default
 * is calculated from the optical-axis elevation, with no image roll. skyUp is
 * an array or an object with x/y/z; its length is normalized, never inferred.
 * A projection inverse can be supplied as 16 column-major elements (Three.js).
 */
export function skyViewGeometry(settings, skyUp = null, camera = null) {
    const e = settings.pathElevationDeg * Math.PI / 180;
    const up = skyUp === null ? [0, Math.cos(e), -Math.sin(e)] :
        Array.isArray(skyUp) || ArrayBuffer.isView(skyUp) ? Array.from(skyUp) : [skyUp.x, skyUp.y, skyUp.z];
    if (up.length !== 3 || up.some(v => !Number.isFinite(v)) || Math.hypot(...up) === 0)
        throw new RangeError("skyUp must be a finite nonzero camera-space vector");
    const length = Math.hypot(...up);
    return {up: up.map(v => v / length), orthographic: !!camera?.isOrthographicCamera,
        inverseProjection: camera?.projectionMatrixInverse ? Array.from(camera.projectionMatrixInverse.elements) : null,
        tanHalfY: Math.tan(settings.verticalFovDeg * Math.PI / 360),
        aspect: settings.detectorWidth / settings.detectorHeight};
}

/** Normalized camera ray at NDC x,y in [-1,1]; positive y is image up. */
export function skyRayDirection(x, y, view) {
    if (view.orthographic) return [0, 0, -1];
    const m = view.inverseProjection;
    const ray = m ? [m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13],
        m[2] * x + m[6] * y + m[14]] : [x * view.tanHalfY * view.aspect, y * view.tanHalfY, -1];
    const length = Math.hypot(...ray);
    return ray.map(value => value / length);
}

/** Calculated ray elevation [rad] = asin(normalized direction dot local up). */
export function skyRayElevation(x, y, view) {
    return Math.asin(clamp(skyRayDirection(x, y, view).reduce((total, v, i) => total + v * view.up[i], 0), -1, 1));
}

/** Enclosing elevation interval [rad], optical diagonal plus a numerical margin
 * of max(0.01 degree, 5% of the half diagonal). Covers rolled and wide fields,
 * including a zenith inside the frame, without assuming corners are extrema.
 */
export function skyElevationRange(view) {
    const axis = skyRayDirection(0, 0, view), center = skyRayElevation(0, 0, view);
    let halfDiagonal = 0;
    for (const y of [-1, 1]) for (const x of [-1, 1]) {
        const ray = skyRayDirection(x, y, view);
        halfDiagonal = Math.max(halfDiagonal, Math.acos(clamp(sum(ray.map((v, i) => v * axis[i])), -1, 1)));
    }
    const marginRad = Math.max(0.01 * Math.PI / 180, halfDiagonal * 0.05);
    return {minRad: Math.max(-Math.PI / 2, center - halfDiagonal - marginRad),
        maxRad: Math.min(Math.PI / 2, center + halfDiagonal + marginRad), centerRad: center, marginRad};
}

/** Photon background [photons/(s m² sr)] from this atmosphere, never brightness
 * temperature interpolation. The geometric horizon is depressed below 0 degrees
 * for an elevated observer; negative elevations can still be unobstructed sky.
 */
export function backgroundAtElevation(elevationRad, {sensorAltitudeM, temperatureK = 288.15,
    earthRadiusM = EARTH_RADIUS_M, band = {minUm: 3, maxUm: 5}, segments = 96, seaProvider, rayGeometry}, atmosphere) {
    const geometry = rayGeometry?.ray(elevationRad, atmosphere.options.topAltitudeM) ?? {sensorAltitudeM, elevationRad, earthRadiusM};
    const accuracy = {segments, quantity: "photon", band};
    const sky = rayGeometry ? (geometry.kind === "surface" ? geometry :
        {kind: "sky", radiance: evaluatePath(geometry, atmosphere, accuracy).pathRadiance}) : clearSky(geometry, atmosphere, accuracy);
    const result = sky.kind === "surface" ? (seaProvider ? seaProvider(geometry) : seaBackground({...geometry, temperatureK}, atmosphere, accuracy)) : sky;
    return {kind: result.kind, photonRadiance: sum(result.radiance)};
}

/** Adaptive photon-radiance/elevation table. Calculated numerical policy: 65
 * initial nodes across the diagonal interval, plus the exact axis and separate
 * sea/sky horizon endpoints. Bisect intervals with midpoint relative error above
 * 2e-5, up to 2049 nodes or depth 12. Final leaf midpoints report interpolation
 * error against the same 96-segment atmosphere, not atmospheric model accuracy.
 * Horizon limits are evaluated 1e-8 rad inside each branch to avoid tangent-ray
 * roundoff. Duplicate horizon coordinates prevent blending sea into clear sky.
 */
export function createSkyElevationLUT({view, elevationRange, toleranceK, relativeTolerance = 2e-5, maxSamples = 2049, initialSamples = 65, ...options}, atmosphere = createAtmosphere()) {
    const range = elevationRange ?? skyElevationRange(view), {minRad, maxRad, centerRad} = range;
    const radius = options.earthRadiusM ?? EARTH_RADIUS_M;
    const horizonRad = options.rayGeometry?.horizonRad ?? -Math.acos(radius / (radius + options.sensorAltitudeM));
    const at = e => backgroundAtElevation(e, options, atmosphere).photonRadiance;
    const nodes = [];
    for (let i = 0; i < initialSamples; i++) {
        const e = minRad + (maxRad - minRad) * i / (initialSamples - 1);
        if (Math.abs(e - horizonRad) > 1e-12) nodes.push({e, value: at(e)});
    }
    if (Math.abs(centerRad - horizonRad) > 1e-12) nodes.push({e: centerRad, value: at(centerRad)});
    if (horizonRad >= minRad && horizonRad <= maxRad) {
        nodes.push({e: horizonRad, value: at(Math.max(-Math.PI / 2, horizonRad - 1e-8))});
        nodes.push({e: horizonRad, value: at(Math.min(Math.PI / 2, horizonRad + 1e-8))});
    }
    nodes.sort((a, b) => a.e - b.e);
    const unique = nodes.filter((node, i) => i === 0 || node.e !== nodes[i - 1].e || node.e === horizonRad);
    const positive = unique.map(n => n.value).filter(value => value > 0);
    // Vacuum sky is identically zero on its separate horizon branch. It has no
    // interpolation error and must not supply a zero Planck slope for the sea.
    const inverseSlope = toleranceK && positive.length ? brightnessErrorBound(1, Math.min(...positive) * .99,
        options.band ?? {minUm: 3, maxUm: 5}, toleranceK) : 0;
    let sampleCount = unique.length, maxRelativeError = 0, maxAbsoluteError = 0;
    const refined = [unique[0]];
    function interval(a, b, depth) {
        if (b.e === a.e) { refined.push(b); return; }
        const e = (a.e + b.e) / 2, value = at(e);
        const error = Math.abs(value - (a.value + b.value) / 2), relative = error / Math.max(value, 1);
        if ((toleranceK ? error * inverseSlope > toleranceK : relative > relativeTolerance) && sampleCount < maxSamples && depth < 20) {
            sampleCount++;
            const mid = {e, value}; interval(a, mid, depth + 1); interval(mid, b, depth + 1);
        } else {
            maxRelativeError = Math.max(maxRelativeError, relative);
            maxAbsoluteError = Math.max(maxAbsoluteError, error); refined.push(b);
        }
    }
    for (let i = 1; i < unique.length; i++) interval(unique[i - 1], unique[i], 0);
    const elevations = Float64Array.from(refined, node => node.e);
    const photonRadiances = Float64Array.from(refined, node => node.value);
    return {elevations, photonRadiances, sampleCount: refined.length, horizonRad, ...range,
        photonRadianceRange: [Math.min(...photonRadiances), Math.max(...photonRadiances)],
        interpolation: {status: "calculated", maxRelativeError, maxAbsoluteError, relativeTolerance,
            ...(toleranceK ? {maxErrorK: maxAbsoluteError * inverseSlope, toleranceK} : {}),
            toleranceMet: toleranceK ? maxAbsoluteError * inverseSlope <= toleranceK : maxRelativeError <= relativeTolerance,
            validation: "interval midpoints; photons/(s m² sr)"}};
}

/** Linear radiance interpolation with an upper-bound search at the horizon. */
export function sampleSkyElevationLUT(table, elevationRad) {
    const e = clamp(elevationRad, table.minRad, table.maxRad), {elevations, photonRadiances} = table;
    let low = 0, high = elevations.length - 1;
    while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (elevations[mid] <= e) low = mid; else high = mid;
    }
    const span = elevations[high] - elevations[low];
    const t = span > 0 ? (e - elevations[low]) / span : 1;
    return photonRadiances[low] + t * (photonRadiances[high] - photonRadiances[low]);
}

/** path is evaluatePath output; radiance units follow path.quantity.
 * Two rows of an R32F table: transmission then band-integrated path radiance.
 * A shader forms sum_b(source_b * transmission_b + pathRadiance_b).
 * Recompute per distinct range/altitude, or interpolate a range/elevation table.
 */
export function shaderTable(path) {
    return Float32Array.from([...path.transmission, ...path.pathRadiance]);
}

/** Photon transfer on the same 12 bands. Temperatures K, band endpoints um.
 * Returned radiances are photons s^-1 m^-2 sr^-1, integrated per band.
 * Scattering incident radiances, if supplied, must use the same photon units.
 */
export function evaluatePhotonPath(geometry, atmosphere, options = {}) {
    return evaluatePath(geometry, atmosphere, {...options, quantity: "photon"});
}

/** Range table for a narrow field with a fixed launch elevation (rad) and altitude (m).
 * With rayGeometry, each range resolves the physical endpoint of that displayed
 * direction; the range coordinate remains the physical chord length in m.
 * Range samples are quadratic in index to resolve the steep near-camera changes.
 * Texture rows contain 12 transmissions (unitless) and 12 photon path radiances
 * scaled by 1e20. No midpoint-wavelength conversion of energy radiance is used.
 */
export function* createRangeLUTSteps({maxRangeM, size = 128, sensorAltitudeM = 1500,
    elevationRad = 0, band = {minUm: 3, maxUm: 5}, atmosphere = createAtmosphere(), segments = 96, rayGeometry}) {
    number("maxRangeM", maxRangeM);
    if (!Number.isInteger(size) || size < 2) throw new RangeError("Range table needs at least two samples");
    if (!(band.minUm >= 3 && band.maxUm <= 5 && band.maxUm > band.minUm))
        throw new RangeError("Atmospheric band must lie within 3–5 um");
    const transmission = new Float32Array(size * N), pathRadiance = new Float32Array(size * N);
    for (let sample = 0; sample < size; sample++) {
        const slantRangeM = maxRangeM * (sample / (size - 1)) ** 2;
        const path = evaluatePhotonPath(rayGeometry?.rangePath(elevationRad, slantRangeM) ??
            {sensorAltitudeM, elevationRad, slantRangeM}, atmosphere, {band, segments});
        for (let bandIndex = 0; bandIndex < N; bandIndex++) {
            transmission[sample * N + bandIndex] = path.transmission[bandIndex];
            pathRadiance[sample * N + bandIndex] = path.pathRadiance[bandIndex] / PHOTON_SCALE;
        }
        yield;
    }
    return {size, maxRangeM, transmission, pathRadiance};
}

export function createRangeLUT(options) {
    const steps = createRangeLUTSteps(options);
    let result; do {result = steps.next();} while (!result.done);
    return result.value;
}

/** sourceBands: 12 physical photon radiances; output: scaled photon radiance by range.
 * The shader linearly interpolates these samples at sqrt(rangeM/maxRangeM)*(size-1).
 */
export function sourceRangeLUT(rangeLUT, sourceBands) {
    spectrum("sourceBands", sourceBands);
    return Float32Array.from({length: rangeLUT.size}, (_, sample) => {
        let radiance = 0;
        for (let bandIndex = 0; bandIndex < N; bandIndex++) {
            const index = sample * N + bandIndex;
            radiance += sourceBands[bandIndex] / PHOTON_SCALE * rangeLUT.transmission[index]
                + rangeLUT.pathRadiance[index];
        }
        return radiance;
    });
}

/** A local segment emits E and transmits tau. These operations also permit an
 * emission-only volume (tau=1). Radiance units must agree at every boundary. */
export const applyTransfer = (segment, behind) => segment.E + segment.tau * behind;
export const composeTransfer = (near, far) => ({E: near.E + near.tau * far.E, tau: near.tau * far.tau});
export const observerTransfer = (cloud, foreground) => ({
    E: (1 - cloud.tau) * foreground.E + foreground.tau * cloud.E, tau: cloud.tau,
});

export function cloudOpacity(mask, opticalDepth = Math.log(100), semantics = "normalizedColumn") {
    if (!Number.isFinite(mask) || mask < 0 || mask > 1 || !(opticalDepth >= 0)) throw new RangeError("Invalid cloud column");
    if (semantics === "calibratedOpacity") return mask;
    if (semantics === "coverage") return mask * -Math.expm1(-opticalDepth);
    if (semantics !== "normalizedColumn") throw new RangeError("Unknown cloud mask semantics");
    return -Math.expm1(-mask * opticalDepth);
}

export function sortCloudSheets(sheets) {
    return [...sheets].sort((a, b) => (a.apparentCenter ?? a.center)[2] - (b.apparentCenter ?? b.center)[2] || String(a.id).localeCompare(String(b.id)));
}

/** Physical center altitude samples the SAME thermodynamic atmosphere as the
 * foreground. Estimated local equilibrium; phase remains unknown. No RGB term.
 */
export function cloudTemperature(atmosphere, altitudeM) {
    return atmosphere.sample(altitudeM).temperatureK;
}

export function opaqueCloudRadiance(geometry, atmosphere, {temperatureK, band = {minUm: 3, maxUm: 5}, segments = 96} = {}) {
    const path = evaluatePhotonPath(geometry, atmosphere, {band, segments});
    temperatureK ??= cloudTemperature(atmosphere, path.geometry.targetAltitudeM);
    const B = blackbodyBands(temperatureK, {quantity: "photon", band});
    return {temperatureK, path, photonRadiance: B.reduce((total, v, i) => total + v * path.transmission[i] + path.pathRadiance[i], 0)};
}

/** Calculated conservative brightness-error bound. Planck's temperature slope
 * increases with temperature. The secant immediately BELOW the minimum received
 * temperature therefore underestimates the slope everywhere being compared.
 * One inverse per table avoids one expensive inversion per interpolation probe.
 */
const brightnessSlopes = new Map();
export function brightnessErrorBound(absoluteError, minimumRadiance, band, intervalK = .005, cell = "unspecified cell") {
    if (!Number.isFinite(minimumRadiance) || minimumRadiance < 0)
        throw new RangeError(`Invalid minimum radiance in ${cell}: ${minimumRadiance}; expected a finite value >= 0 photons/(s m² sr)`);
    if (absoluteError === 0) return 0;
    // Calculated lower radiance bracket, sixteen logarithmic bins per octave.
    // Reusing its lower Planck slope makes the bound more conservative, and
    // avoids an inverse-Planck solve for every moving sheet on every frame.
    const lowerRadiance = 2 ** (Math.floor(Math.log2(minimumRadiance) * 16) / 16);
    const key = typeof band?.response === "function" ? null : JSON.stringify([band, lowerRadiance, intervalK]);
    if (key && brightnessSlopes.has(key)) return absoluteError / brightnessSlopes.get(key);
    const T = apparentTemperature(lowerRadiance, {quantity: "photon", band});
    const lo = Math.max(0, T - 2 * intervalK), hi = Math.max(0, T - intervalK);
    if (hi === lo) return Infinity;
    const slope = (inBandRadiance(hi, band).photon - inBandRadiance(lo, band).photon) / (hi - lo);
    if (key) {
        brightnessSlopes.set(key, slope);
        if (brightnessSlopes.size > 512) brightnessSlopes.delete(brightnessSlopes.keys().next().value);
    }
    return absoluteError / slope;
}

/** Reusable local photon-radiance function. Estimated numerical policy: cells
 * start at 100 m observer height, 1000 m range, 0.02 rad elevation clearance,
 * and 8 K override temperature. These are search domains, never rounded poses.
 * All tensor half-step probes must pass a 0.001 K received-radiance gate, with
 * a factor-two margin. Failed cells split along their largest measured curvature.
 * The elevation coordinate is clearance above the first-hit visibility limit:
 * every atmospheric integration is a physical, unobstructed path.
 */
export function createCloudRadianceDomain(atmosphere, band, {isothermal = false, toleranceK = .001} = {}) {
    const widths = isothermal ? [100, 1000, .02, 8] : [100, 1000, .02];
    const roots = new Map(), exact = new Map();
    const domain = {evaluations: 0, maxErrorK: 0, toleranceK, cells: 0};
    const at = coordinates => {
        const key = coordinates.join(",");
        if (exact.has(key)) return exact.get(key);
        const [sensorAltitudeM, slantRangeM, clearance, temperatureK] = coordinates;
        const elevationRad = Math.min(Math.PI / 2, cloudMinimumElevation(sensorAltitudeM, slantRangeM) + clearance);
        const value = opaqueCloudRadiance({sensorAltitudeM, slantRangeM, elevationRad}, atmosphere,
            {band, temperatureK: isothermal ? temperatureK : undefined}).photonRadiance;
        domain.evaluations++; exact.set(key, value);
        return value;
    };
    const interpolate = (cell, point) => {
        let value = 0;
        for (let bits = 0; bits < cell.values.length; bits++) {
            let weight = 1;
            for (let d = 0; d < widths.length; d++) {
                const t = (point[d] - cell.lo[d]) / (cell.hi[d] - cell.lo[d]);
                weight *= bits & (1 << d) ? t : 1 - t;
            }
            value += weight * cell.values[bits];
        }
        return value;
    };
    function build(lo, hi, depth = 0) {
        const cell = {lo, hi}; domain.cells++;
        cell.values = Array.from({length: 1 << widths.length}, (_, bits) =>
            at(lo.map((v, d) => bits & (1 << d) ? hi[d] : v)));
        let error = 0, minimum = Math.min(...cell.values);
        const center = lo.map((v, d) => (v + hi[d]) / 2), centerValue = at(center);
        const curvature = lo.map((_, d) => {
            const a = [...center], b = [...center]; a[d] = lo[d]; b[d] = hi[d];
            return Math.abs(at(a) + at(b) - 2 * centerValue);
        });
        // Tensor probes include edges, faces and the center, not only one axis.
        for (let index = 0; index < 3 ** widths.length; index++) {
            let code = index;
            const point = lo.map((v, d) => {const t = code % 3 / 2; code = Math.floor(code / 3); return v + t * (hi[d] - v);});
            const actual = at(point), estimate = interpolate(cell, point);
            minimum = Math.min(minimum, actual, estimate); error = Math.max(error, Math.abs(actual - estimate));
        }
        cell.errorK = 2 * brightnessErrorBound(error, minimum, band, toleranceK,
            `cloud radiance domain cell lo=[${lo}] hi=[${hi}]`);
        if (cell.errorK > toleranceK && depth < 24) {
            const axis = curvature.indexOf(Math.max(...curvature));
            cell.axis = axis; cell.mid = center[axis]; cell.depth = depth;
            // Children are built only when requested, keeping moving domains sparse.
        } else if (cell.errorK > toleranceK) throw new Error("Cloud radiance domain did not converge");
        else domain.maxErrorK = Math.max(domain.maxErrorK, cell.errorK);
        return cell;
    }
    domain.sample = ({sensorAltitudeM, slantRangeM, elevationRad, temperatureK, visibilityResolved, earthRadiusM = EARTH_RADIUS_M}) => {
        const clearance = elevationRad - cloudMinimumElevation(sensorAltitudeM, slantRangeM);
        // A lifted endpoint may be visible beyond the geometric tangent. Its
        // straight transfer chord is outside the unobstructed cache domain;
        // cache exact evaluations rather than extrapolating a validated cell.
        if (visibilityResolved && (clearance < 0 || earthRadiusM !== EARTH_RADIUS_M)) {
            const key = JSON.stringify([sensorAltitudeM, slantRangeM, elevationRad, temperatureK, earthRadiusM]);
            if (!exact.has(key)) {
                exact.set(key, opaqueCloudRadiance({sensorAltitudeM, slantRangeM, elevationRad, earthRadiusM, visibilityResolved}, atmosphere,
                    {band, temperatureK: isothermal ? temperatureK : undefined}).photonRadiance);
                domain.evaluations++;
            }
            const value = exact.get(key);
            if (exact.size > 32768) exact.clear();
            return value;
        }
        if (clearance < -1e-10) throw new RangeError("Cloud sample is behind the foreground sea");
        const point = [sensorAltitudeM, slantRangeM, Math.max(0, clearance)];
        if (isothermal) point.push(temperatureK);
        const lo = point.map((v, d) => Math.floor(v / widths[d]) * widths[d]);
        const key = lo.join(",");
        if (!roots.has(key)) roots.set(key, build(lo, lo.map((v, d) => v + widths[d])));
        let cell = roots.get(key);
        while (cell.axis !== undefined) {
            const side = point[cell.axis] < cell.mid ? "lower" : "upper";
            if (!cell[side]) {
                const a = [...cell.lo], b = [...cell.hi];
                (side === "lower" ? b : a)[cell.axis] = cell.mid;
                cell[side] = build(a, b, cell.depth + 1);
            }
            cell = cell[side];
        }
        // Estimated bounded working sets. Eviction affects work, never accuracy.
        if (roots.size > 256) roots.delete(roots.keys().next().value);
        if (exact.size > 32768) exact.clear();
        return interpolate(cell, point);
    };
    return domain;
}

/** Physical sheet sample; no atmospheric work is done behind opaque geometry.
 * firstHitM optionally supplies the nearest scene surface along the same ray.
 */
export function cloudSampleGeometry(sheet, u, v, {sensorAltitudeM, up, firstHitM, rayGeometry}) {
    const point = [sheet.center[0] + (u - .5) * sheet.size[0], sheet.center[1] + (v - .5) * sheet.size[1], sheet.center[2]];
    const slantRangeM = Math.hypot(...point), sine = sum(point.map((x, i) => x * up[i])) / slantRangeM;
    const elevationRad = Math.asin(clamp(sine, -1, 1));
    const apparent = point.map((x, i) => x + (sheet.apparentCenter?.[i] ?? sheet.center[i]) - sheet.center[i]);
    const apparentRangeM = Math.hypot(...apparent);
    const apparentElevationRad = Math.asin(clamp(sum(apparent.map((x, i) => x * up[i])) / apparentRangeM, -1, 1));
    const sea = rayGeometry ? rayGeometry.sea(apparentElevationRad)?.apparentDistanceM ?? Infinity : thermalSeaDistance(sensorAltitudeM, sine);
    const visible = (rayGeometry ? apparentRangeM : slantRangeM) <= sea + 1e-5 && (!firstHitM || slantRangeM <= firstHitM(point) + 1e-5);
    return {sensorAltitudeM, slantRangeM, elevationRad, visible, point, apparent,
        ...(rayGeometry ? {earthRadiusM: rayGeometry.earthRadiusM, visibilityResolved: true} : {})};
}

/** Bilinear sheet texture, validated only on its physically visible support.
 * Invisible texture nodes are a linear continuation from two visible points,
 * not an atmospheric path through the Earth. The shader clips those fragments.
 * This extension lets interpolation reach a curved horizon without dark padding.
 * Default temperature is local air equilibrium; isothermal is an explicit policy.
 * Estimated total gate 0.005 K: 0.001 K domain plus 0.004 K sheet interpolation.
 */
export function cloudRadianceTable(sheet, atmosphere, {sensorAltitudeM, up, band = {minUm: 3, maxUm: 5},
    toleranceK = .005, maxSize = 65, domain, firstHitM, rayGeometry} = {}) {
    const options = {sensorAltitudeM, up, firstHitM, rayGeometry}, values = new Map(), geometry = new Map();
    let evaluations = 0, maxErrorK = 0;
    const isothermal = sheet.temperaturePolicy === "isothermal";
    const physical = (u, v) => {
        const key = `${u},${v}`;
        if (!geometry.has(key)) geometry.set(key, cloudSampleGeometry(sheet, u, v, options));
        return geometry.get(key);
    };
    const received = (u, v) => {
        const key = `${u},${v}`;
        if (values.has(key)) return values.get(key);
        const g = physical(u, v);
        if (!g.visible) throw new Error("Cannot integrate an invisible cloud sample");
        const input = {...g, temperatureK: isothermal ? sheet.temperatureK : undefined};
        const L = domain ? domain.sample(input) : opaqueCloudRadiance(g, atmosphere, {band, temperatureK: input.temperatureK}).photonRadiance;
        values.set(key, L); evaluations++; return L;
    };
    // The sea-hidden region is convex in the billboard plane. A visible corner
    // exists whenever any part of this rectangular sheet is above the sea.
    const anchors = [[0, 0], [1, 0], [0, 1], [1, 1], [.5, .5]].filter(([u, v]) => physical(u, v).visible);
    // Foreground objects can hide corners while leaving interior support exposed.
    if (firstHitM) for (let y = 0; y <= 8; y++) for (let x = 0; x <= 8; x++) {
        if (physical(x / 8, y / 8).visible) anchors.push([x / 8, y / 8]);
    }
    if (!anchors.length) return {empty: true, evaluations: 0};
    const boundaryProbes = [];
    const sample = (u, v) => {
        if (physical(u, v).visible) return received(u, v);
        // A horizon anchor can be visible only at the segment's endpoint. It
        // cannot define a slope: both continuation probes would coincide.
        // Prefer the nearest anchor with a resolved interval of visible support,
        // using the same projected first-hit geometry as the cloud fragments.
        const nearest = [...anchors].sort((a, b) => Math.hypot(a[0] - u, a[1] - v) - Math.hypot(b[0] - u, b[1] - v));
        for (const anchor of nearest) {
            let lo = 0, hi = 1;
            for (let i = 0; i < 32; i++) {
                const t = (lo + hi) / 2;
                if (physical(u + t * (anchor[0] - u), v + t * (anchor[1] - v)).visible) hi = t; else lo = t;
            }
            if (hi === 1) continue;
            const t1 = hi + (1 - hi) / 4, t2 = hi + (1 - hi) / 2;
            const a = [u + t1 * (anchor[0] - u), v + t1 * (anchor[1] - v)];
            const b = [u + t2 * (anchor[0] - u), v + t2 * (anchor[1] - v)];
            if (!physical(...a).visible || !physical(...b).visible) continue;
            boundaryProbes.push([u + hi * (anchor[0] - u), v + hi * (anchor[1] - v)]);
            const A = received(...a), B = received(...b);
            return A - t1 * (B - A) / (t2 - t1);
        }
        throw new Error(`Cloud sheet ${sheet.id ?? "(unnamed)"} has no resolved visible continuation at u=${u}, v=${v}`);
    };
    let size = 2, grid;
    while (true) {
        boundaryProbes.length = 0;
        grid = Float64Array.from({length: size * size}, (_, i) => sample((i % size) / (size - 1), Math.floor(i / size) / (size - 1)));
        let maxAbsoluteError = 0, minimumRadiance = Infinity;
        let minimumCell = `cloud sheet ${sheet.id ?? "(unnamed)"}, ${size}x${size} grid (no visible probes)`;
        const check = (u, v) => {
            if (!physical(u, v).visible) return;
            const x = Math.min(size - 2, Math.floor(u * (size - 1))), y = Math.min(size - 2, Math.floor(v * (size - 1)));
            const a = u * (size - 1) - x, b = v * (size - 1) - y;
            const interpolated = (grid[y * size + x] * (1 - a) + grid[y * size + x + 1] * a) * (1 - b) +
                (grid[(y + 1) * size + x] * (1 - a) + grid[(y + 1) * size + x + 1] * a) * b;
            const actual = received(u, v);
            const minimum = Math.min(actual, interpolated);
            if (!Number.isFinite(minimum) || minimum < minimumRadiance)
                minimumCell = `cloud sheet ${sheet.id ?? "(unnamed)"}, cell (${x}, ${y}) in ${size}x${size} grid, u=${u}, v=${v}, actual=${actual}, interpolated=${interpolated}`;
            minimumRadiance = Math.min(minimumRadiance, actual, interpolated);
            maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(actual - interpolated));
        };
        for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++)
            for (const [u, v] of [[.5, .5], [.5, 0], [0, .5], [1, .5], [.5, 1]]) check((x + u) / (size - 1), (y + v) / (size - 1));
        boundaryProbes.forEach(([u, v]) => check(u, v));
        maxErrorK = brightnessErrorBound(maxAbsoluteError, minimumRadiance, band, toleranceK, minimumCell) + (domain?.toleranceK ?? 0);
        if (maxErrorK <= toleranceK || size >= maxSize) break;
        size = Math.min(maxSize, 2 * size - 1);
    }
    return {size, data: Float32Array.from(grid, v => v / PHOTON_SCALE), evaluations,
        temperaturePolicy: isothermal ? "isothermal" : "airAtAltitude",
        maxErrorK, toleranceK, toleranceMet: maxErrorK <= toleranceK};
}

// Isothermal profile's analytic center chord; volume renderers must clip chords
// against opaque depth and jointly integrate overlapping unequal-temperature media.
export const sphereOpticalDepth = (centerDepth, impactFraction) => centerDepth * Math.max(0, 1 - impactFraction ** 2) ** 2;

export const SEA_SOURCES = Object.freeze({
    slopes: "Cox–Munk slope statistics (published measurement); legacy Gaussian component convention",
    visibility: "Published study; independent Smith visibility with black-cavity closure (estimated)",
    spectrum: "Linear random-wave moments: Hs=4 sqrt(sum variance), C=sum variance k k^T; all modes unresolved",
    water: "Estimated gray comparison index 1.35+0.01i; spectral water data not substituted for this approximation",
});

/** SI wind conversion; estimated neutral log law, z0=0.0002 m. The Gaussian
 * component coefficients are the named legacy Cox–Munk convention, not an
 * inferred wavelength spectrum. Keep wind and independently supplied swell apart.
 */
export function windSlopeCovariance(speedMps, heightM = 10) {
    if (!(speedMps >= 0) || !(heightM > .0002)) throw new RangeError("Invalid sea wind");
    const wind12Mps = speedMps * Math.log(12.5 / .0002) / Math.log(heightM / .0002);
    return {xx: .00316 * wind12Mps, xy: 0, yy: .003 + .00192 * wind12Mps, wind12Mps};
}

/** Shared spectral contract. Each independent mode has varianceM2=a²/2 and
 * kx,ky in rad/m in the wind frame. A residual covariance represents wavelengths
 * not supplied explicitly. Never add a total empirical covariance twice at LOD.
 */
export function waveSpectrumMoments(components = [], residual = {xx: 0, xy: 0, yy: 0}) {
    const covariance = {xx: residual.xx, xy: residual.xy, yy: residual.yy};
    let varianceM2 = 0;
    for (const {varianceM2: variance, kx, ky} of components) {
        if (!(variance >= 0) || ![variance, kx, ky].every(Number.isFinite)) throw new RangeError("Invalid wave spectrum");
        varianceM2 += variance;
        covariance.xx += variance * kx * kx; covariance.xy += variance * kx * ky; covariance.yy += variance * ky * ky;
    }
    if (![covariance.xx, covariance.xy, covariance.yy].every(Number.isFinite) || covariance.xx < 0 || covariance.yy < 0 ||
        covariance.xx * covariance.yy < covariance.xy ** 2 - 1e-15) throw new RangeError("Inconsistent slope covariance");
    return {varianceM2, significantHeightM: 4 * Math.sqrt(varianceM2), covariance};
}

export function seaSpectrum(settings) {
    const wind = windSlopeCovariance(settings.seaWindMps, 10);
    // Estimated optional monochromatic swell sensitivity, not observed sea state.
    // Deep water: k=omega²/g; conventional gravity 9.80665 m/s².
    const k = (2 * Math.PI / settings.seaSwellPeriodS) ** 2 / 9.80665;
    const angle = settings.seaSwellDirectionRad - settings.seaWindDirectionRad;
    const components = settings.seaSwellHeightM > 0 ? [{varianceM2: (settings.seaSwellHeightM / 4) ** 2,
        kx: k * Math.cos(angle), ky: k * Math.sin(angle)}] : [];
    return {...waveSpectrumMoments(components, wind), components, residual: wind, status: "estimated",
        source: SEA_SOURCES.spectrum, development: "empiricalWindSlopes", resolution: "ensembleMean",
        windHeightM: 10, wind12Mps: wind.wind12Mps};
}

// Gaussian CDF approximation (published handbook formula); calculated
// absolute error <1.5e-7 in erf. Avoids a nonportable Math.erf dependency.
function erf(x) {
    const t = 1 / (1 + .3275911 * Math.abs(x));
    return Math.sign(x) * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-x * x));
}
export function smithEscape(direction, covariance) {
    const [x, y, z] = direction;
    if (z <= 0) return 0;
    const sigma = Math.sqrt(Math.max(0, covariance.xx * x * x + 2 * covariance.xy * x * y + covariance.yy * y * y));
    if (!sigma) return 1;
    const a = z / sigma;
    const projected = z * (1 + erf(a / Math.SQRT2)) / 2 + sigma * Math.exp(-a * a / 2) / Math.sqrt(2 * Math.PI);
    return clamp(z / projected, 0, 1);
}

/** Projected visible Gaussian normals, including a finite grazing limit.
 * Calculated midpoint quadrature on +/-6 sigma; 241 samples per slope axis is
 * the estimated numerical default (481 is the convergence reference).
 * Returned bins retain reflected direction; first-hit R is NOT effective R
 * after hidden reflections. Black-cavity closure preserves isothermal balance.
 */
const quadratures = new Map();
function gaussLegendre(count) {
    if (quadratures.has(count)) return quadratures.get(count);
    const nodes = [];
    for (let i = 0; i < count; i++) {
        let x = Math.cos(Math.PI * (i + .75) / (count + .5)), derivative;
        for (let iteration = 0; iteration < 20; iteration++) {
            let a = 1, b = x;
            for (let n = 2; n <= count; n++) {const c = ((2 * n - 1) * x * b - (n - 1) * a) / n; a = b; b = c;}
            derivative = count * (x * b - a) / (x * x - 1);
            const delta = b / derivative; x -= delta;
            if (Math.abs(delta) < 1e-14) break;
        }
        nodes.push([x, 2 / ((1 - x * x) * derivative * derivative)]);
    }
    quadratures.set(count, nodes); return nodes;
}

export function roughSeaFacets(cosView, covariance, azimuthRad = 0, {count = 241, bins = 129, hiding = true, quadrature = "midpoint"} = {}) {
    const c = clamp(cosView, 0, 1), st = Math.sqrt(1 - c * c), vx = st * Math.cos(azimuthRad), vy = st * Math.sin(azimuthRad);
    const ca = Math.cos(azimuthRad), sa = Math.sin(azimuthRad), gaussian = quadrature === "gauss";
    // Rotate into the viewing plane so the visible-half-space boundary is one
    // quadrature endpoint. The positive-part kink then costs no extra samples.
    const xx = gaussian ? covariance.xx * ca * ca + 2 * covariance.xy * ca * sa + covariance.yy * sa * sa : covariance.xx;
    const xy = gaussian ? (covariance.yy - covariance.xx) * ca * sa + covariance.xy * (ca * ca - sa * sa) : covariance.xy;
    const yy = gaussian ? covariance.xx * sa * sa - 2 * covariance.xy * ca * sa + covariance.yy * ca * ca : covariance.yy;
    const sxScale = Math.sqrt(xx), syCross = sxScale ? xy / sxScale : 0;
    const syScale = Math.sqrt(Math.max(0, yy - syCross * syCross));
    const xmax = gaussian && st * sxScale > 0 ? Math.min(6, c / (st * sxScale)) : 6;
    const nodes = gaussian ? gaussLegendre(count) : Array.from({length: count}, (_, i) => [-1 + 2 * (i + .5) / count, 1]);
    const reflectedWeights = new Float64Array(bins);
    let weight = 0, reflected = 0, escaped = 0, elevation = 0;
    for (const [nx, wx] of nodes) {
        const x = (xmax + 6) * nx / 2 + (xmax - 6) / 2, u = x * sxScale;
        for (const [ny, wy] of nodes) {
            const y = ny * 6, v = x * syCross + y * syScale;
            const sx = gaussian ? ca * u - sa * v : u, sy = gaussian ? sa * u + ca * v : v;
            const projected = c - sx * vx - sy * vy;
            if (projected <= 0) continue;
            const norm = Math.hypot(1, sx, sy), mu = clamp(projected / norm, 0, 1);
            const w = wx * wy * Math.exp(-(x * x + y * y) / 2) * projected, R = seaReflectance(mu);
            const direction = [-2 * mu * sx / norm - vx, -2 * mu * sy / norm - vy, 2 * mu / norm - c];
            const e = Math.asin(clamp(direction[2], -1, 1));
            const escape = hiding ? smithEscape(direction, covariance) : Number(e >= 0);
            const q = clamp(e / (Math.PI / 2) * (bins - 1), 0, bins - 1), lo = Math.min(bins - 2, Math.floor(q)), f = q - lo;
            reflectedWeights[lo] += w * R * escape * (1 - f); reflectedWeights[lo + 1] += w * R * escape * f;
            weight += w; reflected += w * R; escaped += w * R * escape; elevation += w * e;
        }
    }
    // Exact smooth, tangent limit has zero projected area in slope coordinates.
    if (!weight) { reflectedWeights[0] = 1; return {reflectedWeights, firstReflectance: 1, effectiveReflectance: 1, meanReflectedElevationRad: 0}; }
    return {reflectedWeights: reflectedWeights.map(w => w / weight), firstReflectance: reflected / weight,
        effectiveReflectance: escaped / weight, meanReflectedElevationRad: elevation / weight};
}

/** Cached directional clear-sky sea, preserving all correlated absorption
 * channels through incoming and outgoing paths. No solar disk or cloud reflection
 * is assumed. Geometry remains the spherical mean surface; no crest occlusion.
 */
// Estimated numerical production policy: 96-point Gaussian quadrature per slope
// axis, 513 incident-sky elevations. Doubling checks quadrature independently of
// angular-table interpolation over the declared wind/angle/temperature domain.
export function createStatisticalSea(settings, atmosphere, {segments = 96, count = 96, bins = 513, quadrature = "gauss"} = {}) {
    const spectrum = seaSpectrum(settings), band = {minUm: settings.bandMinUm, maxUm: settings.bandMaxUm};
    const accuracy = {segments, quantity: "photon", band}, nc = CHANNEL_WEIGHTS.length;
    const B = blackbodyBands(settings.seaSkinTemperatureK, accuracy), skies = [];
    // Local incident radiance is launched at the WATER, not at the camera.
    for (let i = 0; i < bins; i++) skies.push(clearSky({sensorAltitudeM: 0, elevationRad: i / (bins - 1) * Math.PI / 2}, atmosphere, accuracy).radianceChannels);
    const paths = new Map(), kernels = new Map();
    return {spectrum, status: "estimated", environment: "clearSkyThermalOnlyDiagnostic",
        quadrature: {count, bins, segments, status: "estimated", toleranceK: .005,
            errorK: null,
            validation: "resolution doubling; separate from angular interpolation"},
        hiding: "independentSmithBlackCavity", water: SEA_SOURCES.water,
        evaluate({sensorAltitudeM, elevationRad, azimuthRad = 0, earthRadiusM = EARTH_RADIUS_M, slantRangeM, visibilityResolved}) {
            const key = `${sensorAltitudeM},${elevationRad},${earthRadiusM},${visibilityResolved ? slantRangeM : ""}`;
            let path = paths.get(key);
            if (!path) {
                const hit = visibilityResolved ? {kind: "surface", distanceM: slantRangeM} : clearSky({sensorAltitudeM, elevationRad, earthRadiusM}, atmosphere, accuracy);
                if (hit.kind !== "surface") throw new RangeError("Statistical sea ray misses surface");
                path = evaluatePath({sensorAltitudeM, targetAltitudeM: 0, slantRangeM: hit.distanceM, earthRadiusM, visibilityResolved}, atmosphere, accuracy);
                paths.set(key, path);
            }
            const cosine = clamp(-((earthRadiusM + sensorAltitudeM) * Math.sin(elevationRad) + path.geometry.slantRangeM) / earthRadiusM, 0, 1);
            const kernelKey = `${cosine},${azimuthRad}`;
            let facets = kernels.get(kernelKey);
            if (!facets) {facets = roughSeaFacets(cosine, spectrum.covariance, azimuthRad, {count, bins, quadrature}); kernels.set(kernelKey, facets);}
            // Estimated bounded working sets; moving cameras cannot accumulate an
            // unbounded history of atmospheric paths or angular kernels.
            if (paths.size > 4096) paths.delete(paths.keys().next().value);
            if (kernels.size > 4096) kernels.delete(kernels.keys().next().value);
            const sourceChannels = new Float64Array(BANDS.length * nc);
            for (let ch = 0; ch < sourceChannels.length; ch++) {
                let source = (1 - facets.effectiveReflectance) * B[Math.floor(ch / nc)];
                for (let i = 0; i < bins; i++) source += facets.reflectedWeights[i] * skies[i][ch];
                sourceChannels[ch] = source;
            }
            const channels = sourceChannels.map((v, i) => v * path.transmissionChannels[i] + path.pathRadianceChannels[i]);
            const radiance = Float64Array.from(BANDS, (_, b) => CHANNEL_WEIGHTS.reduce((s, w, i) => s + w * channels[b * nc + i], 0));
            return {kind: "sea", radiance, photonRadiance: sum(radiance), path, firstReflectance: facets.firstReflectance,
                effectiveReflectance: facets.effectiveReflectance, spectrum, hiding: this.hiding};
        }};
}

export function seaRayAzimuth(ray, up, wind) {
    // Clockwise from wind toward azimuth: north cross up points east.
    const cross = [wind[1] * up[2] - wind[2] * up[1], wind[2] * up[0] - wind[0] * up[2], wind[0] * up[1] - wind[1] * up[0]];
    return Math.atan2(sum(ray.map((v, i) => -v * cross[i])), sum(ray.map((v, i) => -v * wind[i])));
}

/** A two-dimensional radiance table retains view azimuth, not only elevation.
 * Its angular cone includes coverage subviews and roll. Independent elevation
 * knots preserve the discontinuous horizon in every row. Estimated azimuth gate:
 * 0.005 K at each elevation knot; refine to at most 65 rows, report exhaustion.
 */
const seaAngularDomains = new WeakMap();
const thermalHorizon = h => -Math.acos(EARTH_RADIUS_M / (EARTH_RADIUS_M + h));

// Estimated altitude reuse budget, independent of angular interpolation. Shift
// the angular coordinate with the exact horizon, then check both altitude ends
// against received radiance at every row knot and interval midpoint. A factor
// two margin guards the sampled small-height interval. Failed intervals shrink.
function validateSeaAltitudeDomain(table, atmosphere, sea, band) {
    // Estimated initial height margin: 0.05 m, reduced at the water boundary.
    let span = Math.min(.05, table.sensorAltitudeM / 4), errorK = Infinity;
    if (!span) return;
    for (let attempt = 0; attempt < 16; attempt++, span /= 2) {
        let absolute = 0, minimum = Infinity;
        for (const h of [table.sensorAltitudeM - span, table.sensorAltitudeM + span]) {
            const movedGeometry = table.rayGeometry?.atAltitude(h);
            const shift = (movedGeometry?.horizonRad ?? thermalHorizon(h)) - table.horizonRad;
            for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex++) {
                const row = table.rows[rowIndex], azimuthRad = table.minAzimuth + rowIndex / (table.rows.length - 1) * (table.maxAzimuth - table.minAzimuth);
                for (let i = 0; i < row.elevations.length; i++) {
                    const points = [row.elevations[i]];
                    if (i && row.elevations[i] !== row.elevations[i - 1]) points.push((row.elevations[i] + row.elevations[i - 1]) / 2);
                    for (let e of points) {
                        if (e === table.horizonRad) e += i && row.elevations[i - 1] === e ? 1e-8 : -1e-8;
                        if (Math.abs(e + shift) > Math.PI / 2) continue;
                        const evaluate = (sensorAltitudeM, elevationRad, rayGeometry) => backgroundAtElevation(elevationRad, {sensorAltitudeM, band, rayGeometry,
                            seaProvider: g => sea.evaluate({...g, azimuthRad})}, atmosphere).photonRadiance;
                        const base = evaluate(table.sensorAltitudeM, e, table.rayGeometry), moved = evaluate(h, e + shift, movedGeometry);
                        absolute = Math.max(absolute, Math.abs(base - moved));
                        if (base !== 0 || moved !== 0) minimum = Math.min(minimum, base, moved);
                    }
                }
            }
        }
        errorK = 2 * brightnessErrorBound(absolute, minimum, band, .001);
        if (errorK <= .001) {
            table.altitudeDomain = {minM: table.sensorAltitudeM - span, maxM: table.sensorAltitudeM + span,
                maxErrorK: errorK, toleranceK: .001, status: "calculated"};
            return;
        }
    }
}

export function createSeaSkyTable(view, wind, settings, atmosphere, sea, rayGeometry) {
    const band = {minUm: settings.bandMinUm, maxUm: settings.bandMaxUm}, requested = skyElevationRange(view);
    const axis = skyRayDirection(0, 0, view), axisAzimuth = seaRayAzimuth(axis, view.up, wind);
    const halfCone = Math.max(requested.centerRad - requested.minRad, requested.maxRad - requested.centerRad);
    const halfAzimuth = Math.sin(halfCone) >= Math.cos(requested.centerRad) ? Math.PI :
        Math.asin(Math.sin(halfCone) / Math.cos(requested.centerRad));
    const candidate = seaAngularDomains.get(sea);
    const domainKey = rayGeometry?.domainKey ?? rayGeometry?.key;
    const cached = candidate?.geometryDomainKey === domainKey ? candidate : null;
    const azimuthDelta = cached ? Math.atan2(Math.sin(axisAzimuth - cached.axisAzimuth), Math.cos(axisAzimuth - cached.axisAzimuth)) : 0;
    const elevationShift = cached ? (rayGeometry?.horizonRad ?? thermalHorizon(settings.sensorAltitudeM)) - cached.horizonRad : 0;
    if ((!rayGeometry || rayGeometry.atAltitude) && cached && cached.sensorAltitudeM !== settings.sensorAltitudeM && !cached.altitudeDomain &&
        Math.abs(cached.sensorAltitudeM - settings.sensorAltitudeM) <= .05) validateSeaAltitudeDomain(cached, atmosphere, sea, band);
    const altitudeSupported = cached && (cached.sensorAltitudeM === settings.sensorAltitudeM || cached.altitudeDomain &&
        settings.sensorAltitudeM >= cached.altitudeDomain.minM && settings.sensorAltitudeM <= cached.altitudeDomain.maxM);
    if (altitudeSupported &&
        requested.minRad - elevationShift >= cached.minRad && requested.maxRad - elevationShift <= cached.maxRad &&
        (cached.maxAzimuth - cached.minAzimuth >= 2 * Math.PI ||
        Math.abs(azimuthDelta) + halfAzimuth <= (cached.maxAzimuth - cached.minAzimuth) / 2)) return cached;
    // Estimated reuse margin: a quarter of the angular cone, at least 0.002 rad.
    // The entire enlarged domain is checked, so reuse never freezes a pose.
    const padding = Math.max(.002, halfCone / 4);
    const range = {...requested, minRad: Math.max(-Math.PI / 2, requested.minRad - padding),
        maxRad: Math.min(Math.PI / 2, requested.maxRad + padding)};
    const azimuthWidth = Math.min(Math.PI, halfAzimuth + padding);
    const minAzimuth = axisAzimuth - azimuthWidth, maxAzimuth = axisAzimuth + azimuthWidth;
    const cache = new Map();
    const row = azimuth => {
        if (!cache.has(azimuth)) cache.set(azimuth, createSkyElevationLUT({view, elevationRange: range, toleranceK: .002, sensorAltitudeM: settings.sensorAltitudeM,
            temperatureK: settings.seaSkinTemperatureK, band, rayGeometry, seaProvider: g => sea.evaluate({...g, azimuthRad: azimuth})}, atmosphere));
        return cache.get(azimuth);
    };
    let rows, count = 3, maxErrorK;
    while (true) {
        rows = Array.from({length: count}, (_, i) => row(minAzimuth + (maxAzimuth - minAzimuth) * i / (count - 1)));
        let absoluteError = 0, minimumRadiance = Infinity;
        for (let i = 0; i < count - 1; i++) {
            const azimuth = minAzimuth + (maxAzimuth - minAzimuth) * (i + .5) / (count - 1);
            // Elevation midpoint accuracy is independently checked by each row.
            // Probe both sides of the horizon; never average across the jump.
            for (let j = 0; j < rows[i].elevations.length; j++) {
                let e = rows[i].elevations[j];
                if (e === rows[i].horizonRad) e += j && rows[i].elevations[j - 1] === e ? 1e-8 : -1e-8;
                if (e >= rows[i].horizonRad) continue;
                const hit = rayGeometry?.sea(e);
                const actual = sea.evaluate({...hit, sensorAltitudeM: settings.sensorAltitudeM,
                    elevationRad: hit?.elevationRad ?? e, azimuthRad: azimuth}).photonRadiance;
                const interpolated = (sampleSkyElevationLUT(rows[i], e) + sampleSkyElevationLUT(rows[i + 1], e)) / 2;
                minimumRadiance = Math.min(minimumRadiance, actual, interpolated);
                absoluteError = Math.max(absoluteError, Math.abs(actual - interpolated));
            }
        }
        maxErrorK = brightnessErrorBound(absoluteError, minimumRadiance, band);
        if (maxErrorK <= .002 || count >= 65) break;
        count = 2 * count - 1;
    }
    const width = Math.max(...rows.map(r => r.sampleCount)), data = new Float32Array(width * rows.length * 4);
    rows.forEach((r, y) => {
        for (let x = 0; x < width; x++) {
            const i = Math.min(x, r.sampleCount - 1), offset = (y * width + x) * 4;
            data[offset] = r.elevations[i]; data[offset + 1] = r.photonRadiances[i] / PHOTON_SCALE; data[offset + 2] = r.sampleCount;
        }
    });
    const elevationErrorK = Math.max(...rows.map(r => r.interpolation.maxErrorK));
    const table = {...rows[Math.floor(rows.length / 2)], rows, width, data, axisAzimuth, minAzimuth, maxAzimuth,
        sensorAltitudeM: settings.sensorAltitudeM, geometryDomainKey: domainKey, rayGeometry, quadrature: sea.quadrature,
        azimuthInterpolation: {maxErrorK, toleranceK: .002, toleranceMet: maxErrorK <= .002},
        interpolation: {status: "calculated", elevationErrorK, azimuthErrorK: maxErrorK,
            maxErrorK: elevationErrorK + maxErrorK, toleranceK: .004, toleranceMet: elevationErrorK + maxErrorK <= .004,
            validation: "elevation interval midpoints and azimuth midpoint rows"},
        photonRadianceRange: [Math.min(...rows.map(r => r.photonRadianceRange[0])), Math.max(...rows.map(r => r.photonRadianceRange[1]))]};
    if (table.azimuthInterpolation.toleranceMet && rows.every(r => r.interpolation.toleranceMet)) seaAngularDomains.set(sea, table);
    return table;
}

// Calculated inverse projection of the mean spherical surface. Distances are m,
// elevations rad. The host supplies its actual vertex lift, including density
// and saturation; no effective-radius or constant-angle substitute is used.
export function createThermalRayGeometry({sensorAltitudeM, earthRadiusM, lift, key}) {
    const h = sensorAltitudeM, R = earthRadiusM;
    const project = ([d, z]) => [d, z + lift(d, z)];
    const unproject = ([d, apparentZ]) => {
        let z = apparentZ;
        // Calculated fixed-point inversion; verify the residual before use.
        for (let i = 0; i < 64; i++) {
            const next = apparentZ - lift(d, z);
            if (Math.abs(next - z) < 1e-8) return [d, next];
            z = next;
        }
        throw new Error("Thermal inverse projection did not converge");
    };
    const surface = d => [d, -h - d * d / (R + Math.sqrt(Math.max(0, R * R - d * d)))];
    const elevation = p => Math.atan2(p[1], p[0]);
    const apparentElevation = d => elevation(project(surface(d)));
    // Calculated maximum of the projected surface, not the lifted geometric
    // tangent: refraction also changes which surface point forms the limb.
    let lo = 0, hi = R;
    for (let i = 0; i < 96; i++) {
        const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
        if (apparentElevation(a) < apparentElevation(b)) lo = a; else hi = b;
    }
    const horizonDistanceM = (lo + hi) / 2;
    const horizonRad = h === 0 ? 0 : apparentElevation(horizonDistanceM);
    const path = physical => ({sensorAltitudeM: h, earthRadiusM: R,
        slantRangeM: Math.hypot(...physical), elevationRad: elevation(physical),
        // Apparent first-hit testing owns visibility. Transfer still follows
        // the straight chord and samples the atmosphere at physical altitude.
        visibilityResolved: true});
    const sea = e => {
        if (e > horizonRad) return null;
        let a = 0, b = horizonDistanceM;
        for (let i = 0; i < 64; i++) {
            const mid = (a + b) / 2;
            if (apparentElevation(mid) < e) a = mid; else b = mid;
        }
        const physical = surface((a + b) / 2), apparent = project(physical);
        return {...path(physical), kind: "surface", distanceM: Math.hypot(...physical),
            apparentDistanceM: Math.hypot(...apparent), physical, apparent};
    };
    const atDistance = (e, distance) => unproject([distance * Math.cos(e), distance * Math.sin(e)]);
    const solveDistance = (e, residual, upper) => {
        let a = 0, b = upper;
        while (residual(atDistance(e, b)) < 0) b *= 2;
        for (let i = 0; i < 64; i++) {
            const mid = (a + b) / 2;
            if (residual(atDistance(e, mid)) < 0) a = mid; else b = mid;
        }
        return atDistance(e, (a + b) / 2);
    };
    return {key, horizonRad, horizonDistanceM, sensorAltitudeM: h, earthRadiusM: R, sea,
        ray(e, topAltitudeM) {
            const hit = sea(e);
            if (hit) return hit;
            const top = Math.max(topAltitudeM, h + 1);
            const physical = solveDistance(e, ([d, z]) => Math.hypot(d, R + h + z) - R - top, R);
            return {...path(physical), physical, kind: "sky"};
        },
        rangePath(e, rangeM) {
            return path(rangeM === 0 ? [0, 0] : solveDistance(e, p => Math.hypot(...p) - rangeM, rangeM));
        },
    };
}

// Calculated adaptive depth interpolation. The square-root angular coordinate
// removes the tangent singularity. Validate quarter points to 0.01 m + 2e-6 of
// range; these are estimated numerical budgets, not surface-model accuracy.
export function createThermalDepthTable(geometry, minElevationRad) {
    const horizon = geometry.horizonRad, maxQ = Math.sqrt(Math.max(0, horizon - minElevationRad));
    const at = q => geometry.sea(horizon - q * q).apparentDistanceM;
    const nodes = [{q: 0, distance: at(0)}];
    let maxErrorM = 0;
    function interval(a, b, depth) {
        let error = 0;
        for (const t of [.25, .5, .75]) error = Math.max(error,
            Math.abs(at(a.q + t * (b.q - a.q)) - (a.distance + t * (b.distance - a.distance))));
        if (error > .01 + 2e-6 * Math.min(a.distance, b.distance)) {
            if (depth >= 24 || nodes.length >= 4095) throw new Error("Thermal sea depth table did not converge");
            const mid = {q: (a.q + b.q) / 2, distance: at((a.q + b.q) / 2)};
            interval(a, mid, depth + 1); interval(mid, b, depth + 1);
        } else {maxErrorM = Math.max(maxErrorM, error); nodes.push(b);}
    }
    interval(nodes[0], {q: maxQ, distance: at(maxQ)}, 0);
    return {data: Float32Array.from(nodes.flatMap(n => [n.q, n.distance, 0, 0])),
        sampleCount: nodes.length, horizonRad: horizon, maxErrorM};
}

/** Calculated angular cache: the entire padded interval is checked in photon
 * radiance. A moving pose samples that interval, rather than freezing its center.
 * Estimated padding .002 rad or 1/4 field keeps the validation domain local.
 */
export class SkyBackgroundCache {
    table(options, atmosphere) {
        const requested = skyElevationRange(options.view);
        const key = JSON.stringify([options.temperatureK, options.band,
            options.rayGeometry?.domainKey ?? options.rayGeometry?.key]);
        const cached = key === this.key && atmosphere === this.atmosphere ? this.cached : null;
        const h = options.sensorAltitudeM;
        const shift = cached ? (options.rayGeometry?.horizonRad ?? thermalHorizon(h)) - cached.horizonRad : 0;
        if (cached && h !== cached.sensorAltitudeM && !cached.altitudeDomain &&
            Math.abs(h - cached.sensorAltitudeM) <= .05 && (!options.rayGeometry || options.rayGeometry.atAltitude))
            this.validateAltitude(cached, atmosphere);
        const altitudeFits = cached && (h === cached.sensorAltitudeM || cached.altitudeDomain &&
            h >= cached.altitudeDomain.minM && h <= cached.altitudeDomain.maxM);
        if (altitudeFits && requested.minRad - shift >= cached.minRad && requested.maxRad - shift <= cached.maxRad)
            return cached;
        const padding = Math.max(.002, (requested.maxRad - requested.minRad) / 8);
        const elevationRange = {...requested, minRad: Math.max(-Math.PI / 2, requested.minRad - padding),
            maxRad: Math.min(Math.PI / 2, requested.maxRad + padding)};
        // Estimated allocation: .002 K angular + .001 K altitude, with remaining
        // .002 K reserved for sampled-validation and Float32 upload roundoff.
        // Estimated coarse seed; adaptive validation retains the same radiance tolerance.
        const table = createSkyElevationLUT({...options, elevationRange, toleranceK: .002, initialSamples: 17}, atmosphere);
        if (!table.interpolation.toleranceMet) throw new Error("Sky interpolation did not meet its brightness tolerance");
        this.cached = {...table, sensorAltitudeM: h, options};
        this.key = key; this.atmosphere = atmosphere;
        return this.cached;
    }
    validateAltitude(table, atmosphere) {
        let span = Math.min(.05, table.sensorAltitudeM / 4);
        for (let attempt = 0; span > 0 && attempt < 16; attempt++, span /= 2) {
            let absolute = 0, minimum = Infinity;
            for (const h of [table.sensorAltitudeM - span, table.sensorAltitudeM + span]) {
                const rayGeometry = table.options.rayGeometry?.atAltitude(h);
                const shift = (rayGeometry?.horizonRad ?? thermalHorizon(h)) - table.horizonRad;
                for (let i = 0; i < table.sampleCount; i++) {
                    const points = [table.elevations[i]];
                    if (i && table.elevations[i] > table.elevations[i - 1]) points.push((table.elevations[i] + table.elevations[i - 1]) / 2);
                    for (let e of points) {
                        if (e === table.horizonRad) e += i && table.elevations[i - 1] === e ? 1e-8 : -1e-8;
                        if (Math.abs(e + shift) > Math.PI / 2) continue;
                        const a = backgroundAtElevation(e, table.options, atmosphere).photonRadiance;
                        const b = backgroundAtElevation(e + shift, {...table.options, sensorAltitudeM: h, rayGeometry}, atmosphere).photonRadiance;
                        absolute = Math.max(absolute, Math.abs(a - b));
                        if (a || b) minimum = Math.min(minimum, a, b);
                    }
                }
            }
            const errorK = absolute === 0 ? 0 : 2 * brightnessErrorBound(absolute, minimum, table.options.band, .001);
            if (errorK <= .001) {
                table.altitudeDomain = {minM: table.sensorAltitudeM - span, maxM: table.sensorAltitudeM + span,
                    maxErrorK: errorK, toleranceK: .001, status: "calculated"};
                return;
            }
        }
    }
}


// Estimated numerical allocations, additional to the unchanged range sampling:
// |dL| <= 1e-4 * sum(source bands) + B'(300 K) * .001 K.
// This covers every nonnegative source spectrum, including reflected sunlight.
export const RANGE_TRANSMISSION_TOLERANCE = 1e-4;
export const RANGE_PATH_TOLERANCE_K = .001;
const ANGLES = [-1, -.6, -.2, .2, .6, 1]; // calculated equally spaced quintic nodes
function blend(tables, x, y) {
    const e = 2*x-1;
    const angular = ANGLES.map((node, i) => ANGLES.reduce((w, other, j) => i === j ? w : w*(e-other)/(node-other), 1));
    const weights = [...angular.map(w => w*(1-y)), ...angular.map(w => w*y)];
    const result = {...tables[0]};
    for (const field of ["transmission", "pathRadiance"])
        result[field] = Float32Array.from(tables[0][field], (_, i) => Math.max(0, Math.min(field === "transmission" ? 1 : Infinity,
            weights.reduce((value, w, k) => value + w * tables[k][field][i], 0))));
    return result;
}

export class RangeTableCache {
    constructor(onReady = () => {}) {this.onReady = onReady;}
    request(options, atmosphere) {
        const key = JSON.stringify([options.surfaceLimited ? ["surface", options.rangeLimitM] : options.maxRangeM, options.size, options.band,
            options.rayGeometry?.domainKey ?? options.rayGeometry?.key]);
        const h = options.sensorAltitudeM, e = options.elevationRad, now = performance.now();
        const velocity = this.lastRequest && now > this.lastRequest.time ? (e-this.lastRequest.e)/(now-this.lastRequest.time) : 0;
        this.lastRequest = {e, time: now};
        const compatible = key === this.key && atmosphere === this.atmosphere;
        const contains = cell => cell && Math.abs(h-cell.h) <= cell.dh && Math.abs(e-cell.e) <= cell.de;
        const domain = compatible ? [this.domain, this.previousDomain].find(contains) : null;
        const fits = !!domain;
        const nearEdge = fits && (Math.abs(h-domain.h) > domain.dh/2 || Math.abs(e-domain.e) > domain.de/10);
        if ((!fits || nearEdge) && !this.pending) {
            // Calculated motion prediction changes only the work domain, never a
            // physical ray. Retain overlapping completed domains during publication.
            const offset = fits ? clamp(velocity*(this.buildWallMs ?? 1000), -domain.de, domain.de) : 0;
            this.start({...options, elevationRad: e+offset}, atmosphere, key);
        }
        if (this.error) throw this.error;
        if (!fits) return null;
        const table = blend(domain.tables, (e-domain.e+domain.de)/(2*domain.de), domain.dh ? (h-domain.h+domain.dh)/(2*domain.dh) : 0);
        this.report = {status: "calculated", validation: "all range nodes; angular and altitude quarter points; factor-two margin",
            transmissionError: domain.transmissionError, pathErrorK: domain.pathErrorK,
            pending: !!this.pending, builds: this.builds ?? 0};
        table.maxRangeM = options.maxRangeM;
        return table;
    }
    *build(options, atmosphere) {
        const e = options.elevationRad, h = options.sensorAltitudeM;
        // Estimated initial work domain; only validated cells are published.
        let de = this.domain?.de ?? .016, dh = options.rayGeometry && !options.rayGeometry.atAltitude ? 0 : Math.min(.05, h/4);
        const derivative = radianceDerivative(300, options.band).photon / PHOTON_SCALE;
        const at = (x, y) => {
            const altitude = h+y*dh, elevation = e+x*de;
            const rayGeometry = dh && options.rayGeometry ? options.rayGeometry.atAltitude(altitude) : options.rayGeometry;
            const maxRangeM = options.surfaceLimited ? Math.min(options.rangeLimitM,
                rayGeometry ? rayGeometry.sea(elevation)?.distanceM ?? Infinity : thermalSeaDistance(altitude, Math.sin(elevation))) : options.maxRangeM;
            return createRangeLUTSteps({...options, maxRangeM, atmosphere, elevationRad: elevation, sensorAltitudeM: altitude, rayGeometry});
        };
        for (let attempt = 0; attempt < 16; attempt++, de /= 2, dh /= 2) {
            const tables = [];
            for (const y of [-1,1]) for (let i = 0; i < ANGLES.length; i++) tables.push(y === 1 && !dh ? tables[i] : yield* at(ANGLES[i],y));
            let transmissionError = 0, pathErrorK = 0;
            for (const [x,y] of [[-.5,0],[0,0],[.5,0],[0,-.5],[0,.5],[-.5,-.5],[.5,.5]]) {
                const exact = yield* at(x,y), predicted = blend(tables, (x+1)/2, (y+1)/2);
                for (let sample = 0; sample < exact.size; sample++) {
                    let pathError = 0;
                    for (let b = 0; b < 12; b++) {
                        const i = sample*12+b;
                        transmissionError = Math.max(transmissionError, 2*Math.abs(exact.transmission[i]-predicted.transmission[i]));
                        pathError += Math.abs(exact.pathRadiance[i]-predicted.pathRadiance[i]);
                    }
                    pathErrorK = Math.max(pathErrorK, 2*pathError/derivative);
                }
            }
            if (transmissionError <= RANGE_TRANSMISSION_TOLERANCE && pathErrorK <= RANGE_PATH_TOLERANCE_K)
                return {e,h,de,dh,tables,transmissionError,pathErrorK};
        }
        throw new Error("Foreground transfer interpolation did not converge");
    }
    start(options, atmosphere, key) {
        const job = {steps: this.build(options, atmosphere), started: performance.now()};
        this.pending = job;
        const advance = () => {
            if (this.disposed || this.pending !== job) return;
            const started = performance.now(), deadline = started+4; // estimated cooperative CPU slice, ms
            try {
                let result;
                do {result = job.steps.next();} while (!result.done && performance.now() < deadline);
                if (result.done) {
                    this.previousDomain = this.key === key && this.atmosphere === atmosphere ? this.domain : null;
                    this.domain = result.value; this.key = key; this.atmosphere = atmosphere;
                    this.buildWallMs = performance.now()-job.started;
                    this.builds = (this.builds ?? 0)+1; this.pending = null; this.onReady();
                } else this.timer = setTimeout(advance, 0);
            } catch (error) {this.error = error; this.pending = null; this.onReady();}
            finally {
                const ms = performance.now()-started; this.workMs = (this.workMs ?? 0)+ms; this.maxSliceMs = Math.max(this.maxSliceMs ?? 0, ms);
            }
        };
        this.timer = setTimeout(advance, 0);
    }
    dispose() {this.disposed = true; clearTimeout(this.timer); this.pending = this.domain = this.previousDomain = null;}
}
