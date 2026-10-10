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

// Calculated geometric horizon dip (rad, negative) of an observer at altitudeM above a sphere of radiusM.
export const horizonDip = (altitudeM, radiusM = EARTH_RADIUS_M) => -Math.acos(radiusM / (radiusM + altitudeM));

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
export function cloudMinimumElevation(altitudeM, rangeM, radiusM = EARTH_RADIUS_M) {
    const radial = radiusM + altitudeM;
    const tangent = Math.sqrt(altitudeM * (2 * radiusM + altitudeM));
    return rangeM >= tangent ? horizonDip(altitudeM, radiusM) :
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
// A thermal source depends on temperature and band, not on the ray. Cache 0.01 K knots and interpolate them;
// atmospheric temperatures are restricted to 150–350 K. The exact quadrature remains available for verification.
// This changes neither path segments nor extinction. Maximum per-band relative error is checked in the tests.
const PATH_SOURCE_STEP_K = .01, pathSources = new Map();
function pathSourceBands(temperatureK, quantity, band) {
    const key = `${quantity},${band.minUm},${band.maxUm}`;
    let cache = pathSources.get(key);
    if (!cache) {
        if (pathSources.size >= 4) pathSources.delete(pathSources.keys().next().value);
        cache = new Map(); pathSources.set(key, cache);
    }
    const index = Math.floor(temperatureK / PATH_SOURCE_STEP_K), fraction = temperatureK / PATH_SOURCE_STEP_K - index;
    const knot = i => {
        if (!cache.has(i)) cache.set(i, blackbodyBands(i * PATH_SOURCE_STEP_K, {quantity, band}));
        return cache.get(i);
    };
    const a = knot(index), b = knot(index + 1);
    return Float64Array.from(a, (value, i) => value + fraction * (b[i] - value));
}
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
    return edges.sort((first, second) => first - second).filter((x, index, a) => !index || x - a[index - 1] > 1e-8);
}

/** Return band transmission and additive path radiance. The nine channels per
 * band retain three absorption ranks for each of CO2 and water with random
 * inter-species overlap; ranks are held correlated between atmospheric layers.
 * Uniform input radiance inside a band is assumed when collapsing to band arrays.
 * input geometry uses m/rad; segments is a count. quantity selects energy or photon
 * radiance and applies to aerosol incident radiance too; band endpoints are um.
 */
export function evaluatePath(input, atmosphere = createAtmosphere(), {segments = 32, quantity = "energy", band = {minUm: 3, maxUm: 5}, exactSource = false} = {}) {
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
        const B = exactSource ? blackbodyBands(T, {quantity, band}) : pathSourceBands(T, quantity, band);
        const J = optionsResolved.aerosolSingleScatteringAlbedo ? spectrum("aerosolIncidentRadiance", typeof optionsResolved.aerosolIncidentRadiance === "function" ? optionsResolved.aerosolIncidentRadiance(altitudeM) : optionsResolved.aerosolIncidentRadiance) : null;
        for (let bandIndex = 0; bandIndex < N; bandIndex++) {
            const spectralBand = BANDS[bandIndex], lambda = (spectralBand.minM + spectralBand.maxM) / 2;
            const kc = spectralBand.co2PerM * co2Scale, kh = spectralBand.waterPerM * waterScale;
            const kt = spectralBand.tracePerM * density * broadening * optionsResolved.traceGasScale * air.active;
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
                // Once floating-point transmission is zero, every later contribution is exactly zero too.
                if (transmissionChannels[ch] === 0) continue;
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

// a and imaginaryPart are dimensionless complex-index components.
function complexSqrt(a, imaginaryPart) {
    const r = Math.hypot(a, imaginaryPart);
    return [Math.sqrt(Math.max(0, (r + a) / 2)), Math.sign(imaginaryPart) * Math.sqrt(Math.max(0, (r - a) / 2))];
}
/** Unpolarized Fresnel reflectance for opaque water. n+ik is an explicit
 * gray approximation, used for the Omaha surface-path comparison, not a spectral water table. */
export function seaReflectance(cosIncidence, n = 1.35, k = 0.01) {
    number("cosIncidence", cosIncidence, 0, 1); number("water n", n, 1); number("water k", k);
    // Complex permittivity (n + ik)² = a + i·b.
    const a = n * n - k * k, b = 2 * n * k;
    const [qr, qi] = complexSqrt(a - (1 - cosIncidence * cosIncidence), b);
    const c = cosIncidence;
    const rs = ((c - qr) ** 2 + qi * qi) / ((c + qr) ** 2 + qi * qi);
    const rp = ((a * c - qr) ** 2 + (b * c - qi) ** 2) / ((a * c + qr) ** 2 + (b * c + qi) ** 2);
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

/** Azimuth integral of the cosine factor for a surface whose normal is at elevation beta, seen along elevation e:
 * integral over a in [0, 2 pi) of max(0, sin e sin beta + cos e cos beta cos a). Exact. */
export function hemisphereAzimuthWeight(elevationRad, normalElevationRad) {
    const A = Math.sin(elevationRad) * Math.sin(normalElevationRad), B = Math.cos(elevationRad) * Math.cos(normalElevationRad);
    if (A >= B) return 2 * Math.PI * A;
    if (A <= -B) return 0;
    return 2 * (A * Math.acos(-A / B) + Math.sqrt(B * B - A * A));
}

/** Sines of the normal elevations of a reflected-environment table: facing down, -30, vertical, +30 deg, facing up. */
export const ENVIRONMENT_NORMAL_SINES = Object.freeze([-1, -0.5, 0, 0.5, 1]);

/** Reflected environment by surface orientation (calculated): for each normal elevation in ENVIRONMENT_NORMAL_SINES,
 * the cosine-weighted hemispheric photon radiance per band that a diffuse surface at altitudeM receives: clear sky above
 * the horizon (clearSky) and gray ground of groundTemperatureK and groundEmissivity below it, through its slant path.
 * The ground's own reflection is omitted. Elevation is sampled at midpoints; 48 samples agree with 360 within 0.02 K. */
export function reflectedEnvironmentTable({altitudeM, groundTemperatureK, groundEmissivity = 1, band = {minUm: 3, maxUm: 5},
    samples = 48}, atmosphere) {
    const accuracy = {segments: 64, quantity: "photon", band}, sensorAltitudeM = Math.max(1, altitudeM);
    const ground = blackbodyBands(groundTemperatureK, {quantity: "photon", band}).map(value => value * groundEmissivity);
    const sampled = Array.from({length: samples}, (_, i) => {
        const elevationRad = -Math.PI / 2 + (i + 0.5) * Math.PI / samples;
        const sky = clearSky({sensorAltitudeM, elevationRad}, atmosphere, accuracy);
        const radiance = sky.kind === "sky" ? sky.radiance :
            transmitRadiance(evaluatePath({sensorAltitudeM, elevationRad, slantRangeM: sky.distanceM}, atmosphere, accuracy), ground).observed;
        return {elevationRad, radiance: Float64Array.from(radiance)};
    });
    return ENVIRONMENT_NORMAL_SINES.map(sine => {
        const normalElevationRad = Math.asin(sine), result = new Float64Array(N);
        for (const {elevationRad, radiance} of sampled) {
            const weight = Math.cos(elevationRad) * hemisphereAzimuthWeight(elevationRad, normalElevationRad) / samples;
            for (let band = 0; band < N; band++) result[band] += radiance[band] * weight;
        }
        return result;
    });
}

/** Adaptive photon-radiance/elevation table. Calculated numerical policy: 65
 * initial nodes across the diagonal interval, plus the exact axis and separate
 * sea/sky horizon endpoints. Bisect intervals with midpoint relative error above
 * 2e-5 (or, with toleranceK, a midpoint brightness error above it), up to maxSamples
 * nodes (2049 by default) or 20 bisection levels. Final leaf midpoints report
 * interpolation error against the same 96-segment atmosphere, not atmospheric model
 * accuracy. Horizon limits are evaluated 1e-8 rad inside each branch to avoid
 * tangent-ray roundoff. Duplicate horizon coordinates prevent blending sea into clear sky.
 */
export function createSkyElevationLUT(options, atmosphere = createAtmosphere()) {
    const steps = skyElevationLUTSteps(options, atmosphere);
    let result; do {result = steps.next();} while (!result.done);
    return result.value;
}

// The table builder as a generator that yields after each atmospheric integration, so that
// interactive work can run in cooperative slices. coordinateOriginRad translates the elevation
// coordinate (the table stores elevation minus the origin), so that altitude rows share identical
// angular knots and subtracting different horizons cannot create almost-duplicate validation nodes.
function* skyElevationLUTSteps({view, elevationRange, toleranceK, relativeTolerance = 2e-5, maxSamples = 2049, initialSamples = 65, coordinateOriginRad = 0, ...options}, atmosphere = createAtmosphere()) {
    const range = elevationRange ?? skyElevationRange(view), {minRad, maxRad, centerRad} = range;
    const radius = options.earthRadiusM ?? EARTH_RADIUS_M;
    const horizonRad = (options.rayGeometry?.horizonRad ?? horizonDip(options.sensorAltitudeM, radius))-coordinateOriginRad;
    const at = e => backgroundAtElevation(e+coordinateOriginRad, options, atmosphere).photonRadiance;
    const nodes = [];
    for (let i = 0; i < initialSamples; i++) {
        const e = minRad + (maxRad - minRad) * i / (initialSamples - 1);
        if (Math.abs(e - horizonRad) > 1e-12) {nodes.push({e, value: at(e)}); yield;}
    }
    if (Math.abs(centerRad - horizonRad) > 1e-12) {nodes.push({e: centerRad, value: at(centerRad)}); yield;}
    if (horizonRad >= minRad && horizonRad <= maxRad) {
        nodes.push({e: horizonRad, value: at(Math.max(-Math.PI / 2-coordinateOriginRad, horizonRad - 1e-8))}); yield;
        nodes.push({e: horizonRad, value: at(Math.min(Math.PI / 2-coordinateOriginRad, horizonRad + 1e-8))}); yield;
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
    function* interval(a, b, depth) {
        if (b.e === a.e) { refined.push(b); return; }
        const e = (a.e + b.e) / 2, value = at(e); yield;
        const error = Math.abs(value - (a.value + b.value) / 2), relative = error / Math.max(value, 1);
        if ((toleranceK ? error * inverseSlope > toleranceK : relative > relativeTolerance) && sampleCount < maxSamples && depth < 20) {
            sampleCount++;
            const mid = {e, value}; yield* interval(a, mid, depth + 1); yield* interval(mid, b, depth + 1);
        } else {
            maxRelativeError = Math.max(maxRelativeError, relative);
            maxAbsoluteError = Math.max(maxAbsoluteError, error); refined.push(b);
        }
    }
    for (let i = 1; i < unique.length; i++) yield* interval(unique[i - 1], unique[i], 0);
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

/** Sensor radiance of a source seen at each table range. sourceBands: 12 physical photon radiances; output:
 * scaled photon radiance by range. The shader linearly interpolates these samples at
 * sqrt(rangeM/maxRangeM)*(size-1). A thin layer that transmits t of what lies behind it passes
 * pathWeight = 1 - t: the renderer adds t times the radiance already behind it, which carries its own path. */
export function sourceRangeLUT(rangeLUT, sourceBands, pathWeight = 1) {
    spectrum("sourceBands", sourceBands);
    return Float32Array.from({length: rangeLUT.size}, (_, sample) => {
        let radiance = 0;
        for (let bandIndex = 0; bandIndex < N; bandIndex++) {
            const index = sample * N + bandIndex;
            radiance += sourceBands[bandIndex] / PHOTON_SCALE * rangeLUT.transmission[index]
                + pathWeight * rangeLUT.pathRadiance[index];
        }
        return radiance;
    });
}

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
 * earthRadiusM is the sphere the domain is built on; it serves samples within
 * RADIUS_REUSE_M of it, as the range and sky domains do.
 */
export function createCloudRadianceDomain(atmosphere, band, {isothermal = false, toleranceK = .001, earthRadiusM = EARTH_RADIUS_M} = {}) {
    const widths = isothermal ? [100, 1000, .02, 8] : [100, 1000, .02];
    const roots = new Map(), exact = new Map();
    const domain = {evaluations: 0, maxErrorK: 0, toleranceK, cells: 0, earthRadiusM};
    const at = coordinates => {
        const key = coordinates.join(",");
        if (exact.has(key)) return exact.get(key);
        const [sensorAltitudeM, slantRangeM, clearance, temperatureK] = coordinates;
        const elevationRad = Math.min(Math.PI / 2, cloudMinimumElevation(sensorAltitudeM, slantRangeM, earthRadiusM) + clearance);
        const value = opaqueCloudRadiance({sensorAltitudeM, slantRangeM, elevationRad, earthRadiusM}, atmosphere,
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
    domain.sample = ({sensorAltitudeM, slantRangeM, elevationRad, temperatureK, visibilityResolved, earthRadiusM: sampleRadiusM = EARTH_RADIUS_M}) => {
        const clearance = elevationRad - cloudMinimumElevation(sensorAltitudeM, slantRangeM, sampleRadiusM);
        // A lifted endpoint may be visible beyond the geometric tangent. Its
        // straight transfer chord is outside the unobstructed cache domain;
        // cache exact evaluations rather than extrapolating a validated cell.
        // A sample on a sphere outside this domain's radius reuse span is exact too.
        if (visibilityResolved && (clearance < 0 || Math.abs(sampleRadiusM - earthRadiusM) > RADIUS_REUSE_M)) {
            const key = JSON.stringify([sensorAltitudeM, slantRangeM, elevationRad, temperatureK, sampleRadiusM]);
            if (!exact.has(key)) {
                exact.set(key, opaqueCloudRadiance({sensorAltitudeM, slantRangeM, elevationRad, earthRadiusM: sampleRadiusM, visibilityResolved}, atmosphere,
                    {band, temperatureK: isothermal ? temperatureK : undefined}).photonRadiance);
                domain.evaluations++;
            }
            const value = exact.get(key);
            if (exact.size > 32768) exact.clear();
            return value;
        }
        if (clearance < -1e-10) throw new RangeError("Cloud sample is behind the foreground sea");
        // Within the reuse span the domain's sphere stands in for the sample's (see RADIUS_REUSE_M).
        const domainClearance = sampleRadiusM === earthRadiusM ? clearance
            : elevationRad - cloudMinimumElevation(sensorAltitudeM, slantRangeM, earthRadiusM);
        const point = [sensorAltitudeM, slantRangeM, Math.max(0, domainClearance)];
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

// Gauss–Legendre nodes and weights on [-1, 1], cached by count.
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

/** Projected visible Gaussian normals, including a finite grazing limit.
 * Calculated midpoint quadrature on +/-6 sigma; 241 samples per slope axis is
 * the estimated numerical default (481 is the convergence reference).
 * Returned bins retain reflected direction; first-hit R is NOT effective R
 * after hidden reflections. Black-cavity closure preserves isothermal balance.
 */
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
            const radiance = collapse(channels);
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
// Estimated altitude reuse budget, independent of angular interpolation. Shift
// the angular coordinate with the exact horizon, then check both altitude ends
// against received radiance at every row knot and interval midpoint. A factor
// two margin guards the sampled small-height interval. Failed intervals shrink.
// rows are elevation tables of the same table (its azimuth rows, or the table itself);
// moved(h) gives {rayGeometry, horizonRad} at height h; evaluate(rowIndex, elevationRad, at)
// is the received photon radiance of that row, at the table's own altitude when at is
// null, else at {sensorAltitudeM, rayGeometry}. On success sets table.altitudeDomain.
function validateAltitudeSpan(table, rows, moved, evaluate, band) {
    // Estimated initial height margin: 0.05 m, reduced at the water boundary.
    let span = Math.min(.05, table.sensorAltitudeM / 4);
    for (let attempt = 0; span > 0 && attempt < 16; attempt++, span /= 2) {
        let absolute = 0, minimum = Infinity;
        for (const h of [table.sensorAltitudeM - span, table.sensorAltitudeM + span]) {
            const {rayGeometry, horizonRad} = moved(h), shift = horizonRad - table.horizonRad;
            rows.forEach((row, rowIndex) => {
                for (let i = 0; i < row.elevations.length; i++) {
                    const points = [row.elevations[i]];
                    if (i && row.elevations[i] !== row.elevations[i - 1]) points.push((row.elevations[i] + row.elevations[i - 1]) / 2);
                    for (let e of points) {
                        if (e === table.horizonRad) e += i && row.elevations[i - 1] === e ? 1e-8 : -1e-8;
                        if (Math.abs(e + shift) > Math.PI / 2) continue;
                        const base = evaluate(rowIndex, e, null), shifted = evaluate(rowIndex, e + shift, {sensorAltitudeM: h, rayGeometry});
                        absolute = Math.max(absolute, Math.abs(base - shifted));
                        if (base !== 0 || shifted !== 0) minimum = Math.min(minimum, base, shifted);
                    }
                }
            });
        }
        const errorK = absolute === 0 ? 0 : 2 * brightnessErrorBound(absolute, minimum, band, .001);
        if (errorK <= .001) {
            table.altitudeDomain = {minM: table.sensorAltitudeM - span, maxM: table.sensorAltitudeM + span,
                maxErrorK: errorK, toleranceK: .001, status: "calculated"};
            return;
        }
    }
}

function validateSeaAltitudeDomain(table, atmosphere, sea, band) {
    const azimuthOf = rowIndex => table.minAzimuth + rowIndex / (table.rows.length - 1) * (table.maxAzimuth - table.minAzimuth);
    validateAltitudeSpan(table, table.rows, h => {
        const rayGeometry = table.rayGeometry?.atAltitude(h);
        return {rayGeometry, horizonRad: rayGeometry?.horizonRad ?? horizonDip(h)};
    }, (rowIndex, elevationRad, at) => backgroundAtElevation(elevationRad, {sensorAltitudeM: at?.sensorAltitudeM ?? table.sensorAltitudeM,
        band, rayGeometry: at ? at.rayGeometry : table.rayGeometry, seaProvider: g => sea.evaluate({...g, azimuthRad: azimuthOf(rowIndex)})},
    atmosphere).photonRadiance, band);
}

// Calculated half-width in azimuth of a cone of half-angle halfCone about a ray at elevation centerRad;
// pi when the cone contains a pole.
const coneHalfAzimuth = (halfCone, centerRad) => Math.sin(halfCone) >= Math.cos(centerRad) ? Math.PI :
    Math.asin(Math.sin(halfCone) / Math.cos(centerRad));

// Elevation rows -> RGBA float texture, one row per azimuth: elevation, scaled photon radiance, row sample
// count. Shorter rows repeat their last sample.
function packElevationRows(rows) {
    const width = Math.max(...rows.map(row => row.sampleCount)), data = new Float32Array(width * rows.length * 4);
    rows.forEach((row, y) => {
        for (let x = 0; x < width; x++) {
            const i = Math.min(x, row.sampleCount - 1), offset = (y * width + x) * 4;
            data[offset] = row.elevations[i]; data[offset + 1] = row.photonRadiances[i] / PHOTON_SCALE; data[offset + 2] = row.sampleCount;
        }
    });
    return {width, data};
}

export function createSeaSkyTable(view, wind, settings, atmosphere, sea, rayGeometry,
    {paddingRad = 0, maxPaddingRad = Infinity, azimuthPaddingRad = 0, elevationRange, axisAzimuth: workAzimuth, azimuthOrder = 1, initialSamples = 65, toleranceK = .002,
        azimuthSamples = azimuthOrder === 3 ? 5 : 3} = {}) {
    const band = {minUm: settings.bandMinUm, maxUm: settings.bandMaxUm}, requested = elevationRange ?? skyElevationRange(view);
    const axis = skyRayDirection(0, 0, view), axisAzimuth = workAzimuth ?? seaRayAzimuth(axis, view.up, wind);
    const halfCone = Math.max(requested.centerRad - requested.minRad, requested.maxRad - requested.centerRad);
    const halfAzimuth = coneHalfAzimuth(halfCone, requested.centerRad);
    const candidate = seaAngularDomains.get(sea);
    const domainKey = rayGeometry?.domainKey ?? rayGeometry?.key;
    const cached = candidate?.geometryDomainKey === domainKey ? candidate : null;
    const azimuthDelta = cached ? Math.atan2(Math.sin(axisAzimuth - cached.axisAzimuth), Math.cos(axisAzimuth - cached.axisAzimuth)) : 0;
    const elevationShift = cached ? (rayGeometry?.horizonRad ?? horizonDip(settings.sensorAltitudeM)) - cached.horizonRad : 0;
    if ((!rayGeometry || rayGeometry.atAltitude) && cached && cached.sensorAltitudeM !== settings.sensorAltitudeM && !cached.altitudeDomain &&
        Math.abs(cached.sensorAltitudeM - settings.sensorAltitudeM) <= .05) validateSeaAltitudeDomain(cached, atmosphere, sea, band);
    const altitudeSupported = cached && (cached.sensorAltitudeM === settings.sensorAltitudeM || cached.altitudeDomain &&
        settings.sensorAltitudeM >= cached.altitudeDomain.minM && settings.sensorAltitudeM <= cached.altitudeDomain.maxM);
    if (altitudeSupported && (cached.azimuthOrder ?? 1) === azimuthOrder && cached.rows.length >= azimuthSamples &&
        cached.interpolation.maxErrorK <= 2*toleranceK &&
        requested.minRad - elevationShift - paddingRad >= cached.minRad && requested.maxRad - elevationShift + paddingRad <= cached.maxRad &&
        (cached.maxAzimuth - cached.minAzimuth >= 2 * Math.PI ||
        Math.abs(azimuthDelta) + halfAzimuth + azimuthPaddingRad <= (cached.maxAzimuth - cached.minAzimuth) / 2)) return cached;
    // Estimated reuse margin: a quarter of the angular cone, at least 0.002 rad.
    // The entire enlarged domain is checked, so reuse never freezes a pose.
    const padding = Math.min(maxPaddingRad, Math.max(.002, halfCone / 4, paddingRad));
    const range = {...requested, minRad: Math.max(-Math.PI / 2, requested.minRad - padding),
        maxRad: Math.min(Math.PI / 2, requested.maxRad + padding)};
    const azimuthWidth = Math.min(Math.PI, halfAzimuth + Math.max(padding,azimuthPaddingRad));
    const minAzimuth = axisAzimuth - azimuthWidth, maxAzimuth = axisAzimuth + azimuthWidth;
    const cache = new Map();
    const row = azimuth => {
        if (!cache.has(azimuth)) cache.set(azimuth, createSkyElevationLUT({view, elevationRange: range, toleranceK, initialSamples, sensorAltitudeM: settings.sensorAltitudeM,
            temperatureK: settings.seaSkinTemperatureK, band, rayGeometry, seaProvider: g => sea.evaluate({...g, azimuthRad: azimuth})}, atmosphere));
        return cache.get(azimuth);
    };
    let rows, count = azimuthSamples, maxErrorK;
    while (true) {
        rows = Array.from({length: count}, (_, i) => row(minAzimuth + (maxAzimuth - minAzimuth) * i / (count - 1)));
        let absoluteError = 0, minimumRadiance = Infinity;
        for (let i = 0; i < count - 1; i++) {
            for (const fraction of azimuthOrder === 3 ? [.25,.5,.75] : [.5]) {
            const azimuth = minAzimuth + (maxAzimuth - minAzimuth) * (i + fraction) / (count - 1);
            // Elevation midpoint accuracy is independently checked by each row.
            // Probe both sides of the horizon; never average across the jump.
            for (let j = 0; j < rows[i].elevations.length; j++) {
                let e = rows[i].elevations[j];
                if (e === rows[i].horizonRad) e += j && rows[i].elevations[j - 1] === e ? 1e-8 : -1e-8;
                if (e >= rows[i].horizonRad) continue;
                const hit = rayGeometry?.sea(e);
                const actual = sea.evaluate({...hit, sensorAltitudeM: settings.sensorAltitudeM,
                    elevationRad: hit?.elevationRad ?? e, azimuthRad: azimuth}).photonRadiance;
                const interpolated = sampleSeaSkyTable({rows,minAzimuth,maxAzimuth,azimuthOrder},e,azimuth);
                minimumRadiance = Math.min(minimumRadiance, actual, interpolated);
                absoluteError = Math.max(absoluteError, Math.abs(actual - interpolated));
            }
            }
        }
        maxErrorK = brightnessErrorBound(absoluteError, minimumRadiance, band);
        if (maxErrorK <= toleranceK || count >= 65) break;
        count = 2 * count - 1;
    }
    const {width, data} = packElevationRows(rows);
    const elevationErrorK = Math.max(...rows.map(r => r.interpolation.maxErrorK));
    const table = {...rows[Math.floor(rows.length / 2)], rows, width, data, axisAzimuth, minAzimuth, maxAzimuth, azimuthOrder,
        sensorAltitudeM: settings.sensorAltitudeM, geometryDomainKey: domainKey, rayGeometry, quadrature: sea.quadrature,
        azimuthInterpolation: {maxErrorK, toleranceK, toleranceMet: maxErrorK <= toleranceK},
        interpolation: {status: "calculated", elevationErrorK, azimuthErrorK: maxErrorK,
            maxErrorK: elevationErrorK + maxErrorK, toleranceK: 2*toleranceK, toleranceMet: elevationErrorK + maxErrorK <= 2*toleranceK,
            validation: "elevation interval midpoints and azimuth midpoint rows"},
        photonRadianceRange: [Math.min(...rows.map(r => r.photonRadianceRange[0])), Math.max(...rows.map(r => r.photonRadianceRange[1]))]};
    if (table.azimuthInterpolation.toleranceMet && rows.every(r => r.interpolation.toleranceMet)) seaAngularDomains.set(sea, table);
    return table;
}

export function sampleSeaSkyTable(table,elevation,azimuth) {
    const axis=(table.minAzimuth+table.maxAzimuth)/2;
    const delta=Math.atan2(Math.sin(azimuth-axis),Math.cos(azimuth-axis));
    const row=clamp((axis+delta-table.minAzimuth)/(table.maxAzimuth-table.minAzimuth)*(table.rows.length-1),0,table.rows.length-1);
    const lower=Math.min(table.rows.length-2,Math.floor(row)),fraction=row-lower;
    if (table.azimuthOrder === 3) {
        const first=clamp(lower-1,0,table.rows.length-4),x=row-first;
        const weights=[-(x-1)*(x-2)*(x-3)/6,x*(x-2)*(x-3)/2,-x*(x-1)*(x-3)/2,x*(x-1)*(x-2)/6];
        return Math.max(0,weights.reduce((sum,w,i)=>sum+w*sampleSkyElevationLUT(table.rows[first+i],elevation),0));
    }
    return sampleSkyElevationLUT(table.rows[lower],elevation)*(1-fraction)+sampleSkyElevationLUT(table.rows[lower+1],elevation)*fraction;
}

// Pack each cubic azimuth interval's four source rows together. Their union of
// elevation knots preserves the same piecewise-linear field. The GPU searches
// elevation once and reads two RGBA tuples instead of searching four rows.
export function packSeaSkyAzimuth(rows) {
    const elevations=[...new Set(rows.flatMap(row=>Array.from(row.elevations)))].sort((a,b)=>a-b);
    if (elevations.length>2048) return null;
    const width=2*elevations.length,height=rows.length-1,data=new Float32Array(width*height*4);
    for(let row=0;row<height;row++) {
        const first=clamp(row-1,0,rows.length-4);
        elevations.forEach((e,i)=>{
            const offset=(row*width+2*i)*4;
            data[offset]=e;data[offset+2]=elevations.length;
            for(let j=0;j<4;j++) data[offset+4+j]=sampleSkyElevationLUT(rows[first+j],e)/PHOTON_SCALE;
        });
    }
    return {width,textureHeight:height,data,packedAzimuth:true};
}

// The same angular sea calculation, with validated cubic interpolation in
// observer height. Wholly submerged angular domains have no horizon jump;
// mixed sea/sky views retain createSeaSkyTable's separate one-sided limits.
export class SeaSkyBackgroundCache {
    constructor(onReady = () => {}, {createWorker} = {}) {
        this.onReady = onReady; this.createWorker = createWorker; this.serial = 0; this.builds = 0;
    }
    table(view, wind, settings, atmosphere, sea, rayGeometry, workerAtmosphere) {
        const range = skyElevationRange(view), horizon = rayGeometry?.horizonRad ?? horizonDip(settings.sensorAltitudeM);
        const key = JSON.stringify([settings.bandMinUm, settings.bandMaxUm, rayGeometry?.domainKey ?? rayGeometry?.key]);
        if (this.key !== key || this.sea !== sea) {
            this.pending = this.domain = this.previousDomain = this.lastRequest = null;
            this.key = key; this.sea = sea; this.failedKey = null;
        }
        if (this.error) {this.failedKey=key;this.error=null;}
        const axis = seaRayAzimuth(skyRayDirection(0,0,view), view.up, wind);
        const halfCone = Math.max(range.centerRad-range.minRad,range.maxRad-range.centerRad);
        const halfAzimuth = coneHalfAzimuth(halfCone, range.centerRad);
        const h = settings.sensorAltitudeM, now = performance.now(), last = this.lastRequest;
        const dt = last && now-last.time;
        const wrapped = angle => Math.atan2(Math.sin(angle),Math.cos(angle));
        const velocity = dt > 0 ? {h:(h-last.h)/dt,e:(range.centerRad-last.e)/dt,a:wrapped(axis-last.a)/dt} : {h:0,e:0,a:0};
        const contains = d => d && Math.abs(h-d.h) <= d.dh && range.minRad >= d.minRad && range.maxRad <= d.maxRad &&
            Math.abs(wrapped(axis-d.axisAzimuth))+halfAzimuth <= (d.maxAzimuth-d.minAzimuth)/2 && radiusFits(radiusOf({rayGeometry}),d.radius);
        const d = [this.domain,this.previousDomain].find(contains), fits = !!d;
        this.lastRequest = {h,e:range.centerRad,a:axis,time:now,contains};
        const lead = 1.5*(this.buildWallMs ?? 15000);
        const approaching = (offset,half,rate) => offset*rate > 0 && (half-Math.abs(offset))/Math.abs(rate) < 2*lead;
        const nearEdge = fits && (approaching(h-d.h,d.dh,velocity.h) ||
            approaching(range.centerRad-(d.minRad+d.maxRad)/2,(d.maxRad-d.minRad)/2-halfCone,velocity.e) ||
            approaching(wrapped(axis-d.axisAzimuth),(d.maxAzimuth-d.minAzimuth)/2-halfAzimuth,velocity.a));
        if (!this.pending && !this.disposed && this.failedKey!==key && (!rayGeometry || rayGeometry.atAltitude) &&
            range.maxRad < horizon-1e-6 && (!fits || nearEdge)) {
            // Forecast only the validated work domain. Every rendered ray still
            // uses its current height and angles; retain overlap on publication.
            const height = fits ? Math.max(0,h+clamp(velocity.h*lead,-d.dh*.4,d.dh*.4)) : h;
            const elevation = fits ? clamp(velocity.e*lead,-.04,Math.min(.04,(horizon-range.maxRad)/2)) : 0;
            const azimuth = fits ? clamp(velocity.a*lead,-.8,.8) : 0;
            this.start({view,wind,settings:{...settings,sensorAltitudeM:height},
                rayGeometry:rayGeometry?.atAltitude(height),workerAtmosphere,
                elevationRange:{minRad:range.minRad+elevation,maxRad:range.maxRad+elevation,centerRad:range.centerRad+elevation},
                axisAzimuth:axis+azimuth},atmosphere,sea);
        }
        if (fits) {
            const weights=polynomialWeights(SKY_HEIGHTS,(h-d.h)/d.dh);
            const rows=d.elevations.map((elevations,row)=>{
                const photonRadiances=Float64Array.from(elevations,(_,i)=>Math.max(0,
                    weights.reduce((sum,w,j)=>sum+w*d.values[j][row][i],0)));
                return {elevations,photonRadiances,sampleCount:elevations.length,minRad:d.minRad,maxRad:d.maxRad};
            });
            const {width,data}=packElevationRows(rows);
            return {...rows[Math.floor(rows.length/2)],rows,width,data,horizonRad:horizon,
                ...(d.azimuthOrder===3 ? packSeaSkyAzimuth(rows) : {}),
                axisAzimuth:d.axisAzimuth,minAzimuth:d.minAzimuth,maxAzimuth:d.maxAzimuth,azimuthOrder:d.azimuthOrder,
                altitudeDomain:{minM:d.h-d.dh,maxM:d.h+d.dh,maxErrorK:d.altitudeErrorK,toleranceK:.001,status:"validated"},
                azimuthInterpolation:{maxErrorK:d.angularErrorK,toleranceK:.004,toleranceMet:true},
                interpolation:{status:"validated",maxErrorK:d.angularErrorK,toleranceK:.004,toleranceMet:true,
                    validation:"angular knots and midpoints; altitude interior probes; factor-two margin"},
                photonRadianceRange:[Math.min(...rows.flatMap(r=>Array.from(r.photonRadiances))),Math.max(...rows.flatMap(r=>Array.from(r.photonRadiances)))]};
        }
        return createSeaSkyTable(view,wind,settings,atmosphere,sea,rayGeometry);
    }
    *build({view,wind,settings,rayGeometry,elevationRange,axisAzimuth},atmosphere,sea) {
        const h=settings.sensorAltitudeM,band={minUm:settings.bandMinUm,maxUm:settings.bandMaxUm};
        const requestedRange=elevationRange ?? skyElevationRange(view);
        // Start with enough height coverage for a moving camera while the next
        // worker table builds. The existing .001 K check halves this if needed.
        let dh=Math.min(256,h/4);
        for(let attempt=0;attempt<12;attempt++,dh/=2) {
            const heights=SKY_HEIGHTS.map(y=>h+y*dh),geometries=heights.map(z=>rayGeometry?.atAltitude(z));
            // A wide field can fit below the horizon without the usual .04 rad
            // margin fitting there. Bound padding by the horizon at every basis
            // height; retain the same one-sided domain and validation budgets.
            const lowestHorizon=Math.min(...heights.map((z,j)=>geometries[j]?.horizonRad ?? horizonDip(z)));
            const paddingRad=Math.min(.04,(lowestHorizon-requestedRange.maxRad)/2);
            if (!(paddingRad>0)) continue;
            const tables=[];
            const tableAt = (j,azimuthSamples=5) => createSeaSkyTable(view,wind,{...settings,sensorAltitudeM:heights[j]},atmosphere,sea,geometries[j],
                {paddingRad,maxPaddingRad:paddingRad,azimuthPaddingRad:.85,elevationRange,axisAzimuth,azimuthOrder:3,initialSamples:17,toleranceK:.0005,azimuthSamples});
            for(let j=0;j<heights.length;j++) {
                tables.push(tableAt(j));yield;
            }
            // Adaptive angular sampling can choose different row counts at
            // different heights. Refine to a shared grid before interpolation.
            while(tables.some(t=>t.rows.length!==tables[0].rows.length)) {
                const count=Math.max(...tables.map(t=>t.rows.length));
                for(let j=0;j<tables.length;j++) if(tables[j].rows.length<count) {tables[j]=tableAt(j,count);yield;}
            }
            const basis=tables[0];
            this.buildValidation={attempt,dh,rows:tables.map(t=>t.rows.length),
                horizonFits:tables.every(t=>t.maxRad<t.horizonRad),tableErrorK:Math.max(...tables.map(t=>t.interpolation.maxErrorK))};
            if(tables.some(t=>t.rows.length!==basis.rows.length || t.maxRad>=t.horizonRad ||
                t.minAzimuth!==basis.minAzimuth || t.maxAzimuth!==basis.maxAzimuth || !t.interpolation.toleranceMet)) continue;
            const elevations=basis.rows.map((_,row)=>Float64Array.from([...new Set(tables.flatMap(t=>Array.from(t.rows[row].elevations)))].sort((a,b)=>a-b)));
            if(elevations.some(e=>e.length>4097)) continue;
            const values=tables.map(t=>elevations.map((e,row)=>Float64Array.from(e,v=>sampleSkyElevationLUT(t.rows[row],v))));
            let absolute=0,angularAbsolute=0,minimum=Infinity;
            const at=(z,e,azimuthRad,geometry)=>backgroundAtElevation(e,{sensorAltitudeM:z,band,rayGeometry:geometry,
                seaProvider:g=>sea.evaluate({...g,azimuthRad})},atmosphere).photonRadiance;
            for(let row=0;row<=elevations.length-1;row+=.5) {
                const azimuth=basis.minAzimuth+row/(elevations.length-1)*(basis.maxAzimuth-basis.minAzimuth);
                const knots=elevations[Math.floor(row)];
                for(let i=0;i<knots.length;i++) {
                const probes=[knots[i]];
                if(i) probes.push((knots[i-1]+knots[i])/2);
                for(const e of probes) {
                    const corners=heights.map((z,j)=>at(z,e,azimuth,geometries[j]));
                    for(const y of [-.8,-.5,0,.5,.8]) {
                        const z=h+y*dh,actual=at(z,e,azimuth,rayGeometry?.atAltitude(z));
                        const weights=polynomialWeights(SKY_HEIGHTS,y),predicted=weights.reduce((sum,w,j)=>sum+w*corners[j],0);
                        const sampled=weights.reduce((sum,w,j)=>sum+w*sampleSeaSkyTable(tables[j],e,azimuth),0);
                        angularAbsolute=Math.max(angularAbsolute,Math.abs(sampled-predicted));
                        absolute=Math.max(absolute,Math.abs(actual-predicted));minimum=Math.min(minimum,actual,predicted);yield;
                    }
                }
                }
            }
            const altitudeErrorK=2*brightnessErrorBound(absolute,minimum,band,.001);
            const angularErrorK=Math.max(2*brightnessErrorBound(angularAbsolute,minimum,band,.004),
                2*Math.max(...tables.map(t=>t.interpolation.maxErrorK)));
            Object.assign(this.buildValidation,{altitudeErrorK,angularErrorK});
            if(altitudeErrorK<=.001 && angularErrorK<=.004) return {h,dh,elevations,values,altitudeErrorK,angularErrorK,
                minRad:basis.minRad,maxRad:basis.maxRad,axisAzimuth:basis.axisAzimuth,minAzimuth:basis.minAzimuth,maxAzimuth:basis.maxAzimuth,azimuthOrder:basis.azimuthOrder};
        }
        throw new Error(`Sea altitude interpolation did not converge: ${JSON.stringify(this.buildValidation)}`);
    }
    start(options,atmosphere,sea) {
        const radius=radiusOf(options),publish=domain=>{
            this.previousDomain=[this.domain,this.previousDomain].find(d=>this.lastRequest?.contains(d)) ?? this.domain;
            domain.radius=radius;this.domain=domain;this.builds++;this.onReady();
        };
        if(this.createWorker && options.workerAtmosphere && (!options.rayGeometry || options.rayGeometry.workerSpec)) {
            const job={serial:++this.serial,started:performance.now(),publish};this.pending=job;
            const fallback=()=>{
                if(this.disposed || this.pending!==job)return;
                this.worker?.terminate();this.worker=this.workerPromise=this.createWorker=null;this.pending=null;
                this.start(options,atmosphere,sea);
            };
            job.fallback=fallback;
            this.workerPromise??=Promise.resolve().then(()=>this.createWorker()).then(worker=>{
                if(this.disposed){worker?.terminate();return null;}this.worker=worker;
                if(worker)worker.onmessage=({data})=>{
                    const current=this.pending;
                    if(!current || this.disposed || data.serial!==current.serial)return;
                    if(data.error){current.fallback();return;}
                    this.pending=null;this.buildWallMs=performance.now()-current.started;current.publish(data.domain);
                };
                return worker;
            });
            this.workerPromise.then(worker=>{
                if(this.disposed || this.pending!==job)return;
                if(!worker){fallback();return;}worker.onerror=fallback;
                const {rayGeometry,workerAtmosphere,...numeric}=options;
                try{worker.postMessage({kind:"seaSky",serial:job.serial,options:numeric,raySpec:rayGeometry?.workerSpec,atmosphere:workerAtmosphere});}
                catch{fallback();}
            }).catch(fallback);
        } else scheduleThermalBuild(this,this.build(options,atmosphere,sea),publish);
    }
    dispose(){this.disposed=true;this.pending=this.domain=this.previousDomain=this.lastRequest=null;this.worker?.terminate();this.worker=null;}
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

// Estimated shared scheduling policy: a 24 ms burst per 50 ms. Larger bursts
// make progress between busy frames while retaining a similar average CPU budget.
// A single queue prevents independent range and sky jobs from doubling a slice.
// Estimated reuse span in Earth radius. The radius at the observer changes by centimeters per frame as the camera moves,
// so it is not part of a domain key: a range or sky domain built at radius R serves requests within 100 m of R. At
// 200 km that moves the path altitude by at most d²·δR/(2R²(1−k)) ≈ 6 cm and the horizon distance by δR/(2R) ≈ 8e-6
// of itself, far inside the range and sky tolerances.
export const RADIUS_REUSE_M = 100;
const radiusOf = options => options.rayGeometry?.earthRadiusM ?? options.earthRadiusM ?? null;
const radiusFits = (radius, built) => radius == null || built == null || Math.abs(radius - built) <= RADIUS_REUSE_M;

const thermalBuildJobs = [];
let thermalBuildTimer, thermalBuildRunning = false;
function scheduleThermalBuild(owner, steps, publish) {
    const job = {owner, steps, publish, started: performance.now()};
    owner.pending = job; thermalBuildJobs.push(job);
    const advance = () => {
        thermalBuildTimer = null; thermalBuildRunning = true;
        const started = performance.now(), work = new Map();
        do {
            const next = thermalBuildJobs.shift();
            if (!next) break;
            const {owner} = next;
            if (owner.disposed || owner.pending !== next) continue;
            const before = performance.now();
            try {
                let result;
                // Share CPU time, not yield counts: a sky validation step can
                // contain more integrations than one range sample.
                const quantum = Math.min(started+24, before+4);
                do {result = next.steps.next();} while (!result.done && performance.now() < quantum);
                if (result.done) {
                    owner.pending = null; owner.buildWallMs = performance.now()-next.started;
                    next.publish(result.value);
                } else thermalBuildJobs.push(next);
            } catch (error) {
                owner.error = error; owner.errorKey = next.key; owner.errorAtmosphere = next.atmosphere;
                owner.pending = null; owner.onReady?.();
            }
            work.set(owner, (work.get(owner) ?? 0)+performance.now()-before);
        } while (thermalBuildJobs.length && performance.now()-started < 24);
        for (const [owner, ms] of work) {
            owner.workMs = (owner.workMs ?? 0)+ms; owner.maxSliceMs = Math.max(owner.maxSliceMs ?? 0, ms);
        }
        thermalBuildRunning = false;
        if (thermalBuildJobs.length) {
            thermalBuildTimer = setTimeout(advance, Math.max(1, 50-(performance.now()-started)));
            thermalBuildTimer.unref?.();
        }
    };
    if (!thermalBuildTimer && !thermalBuildRunning) {thermalBuildTimer = setTimeout(advance, 0); thermalBuildTimer.unref?.();}
    return job;
}

const SKY_HEIGHTS = [-1, -1/3, 1/3, 1];
const SKY_PADDING_RAD = .024; // estimated angular prefetch margin
const skyHorizon = (options, h) => horizonDip(h, options.earthRadiusM ?? EARTH_RADIUS_M);

/** Validated angular and altitude interpolation in photon radiance. Its altitude rows use the
 * createSkyElevationLUT builder in cooperative slices, with a 17-node seed and a 0.0006 K tolerance.
 */
export class SkyBackgroundCache {
    constructor(onReady = () => {}) {this.onReady = onReady; this.builds = 0; this.fallbacks = 0; this.hits = 0;}
    table(options, atmosphere) {
        const requested = skyElevationRange(options.view);
        const key = JSON.stringify([options.temperatureK, options.band, options.segments,
            options.earthRadiusM, options.rayGeometry?.domainKey ?? options.rayGeometry?.key]);
        const h = options.sensorAltitudeM, now = performance.now();
        const compatible = key === this.key && atmosphere === this.atmosphere;
        const dt = compatible && this.lastRequest && now - this.lastRequest.time;
        const altitudeVelocity = dt > 0 ? (h-this.lastRequest.h)/dt : 0;
        const velocity = dt > 0 ? (requested.centerRad-this.lastRequest.e)/dt : 0;
        this.lastRequest = {h, e: requested.centerRad, time: now};
        if (!compatible) {
            this.pending = null;
            this.domain = this.previousDomain = this.cached = this.sampled = null;
            this.key = key; this.atmosphere = atmosphere; this.error = null;
        }
        const horizon = options.rayGeometry?.horizonRad ?? skyHorizon(options, h);
        const minQ = requested.minRad-horizon, maxQ = requested.maxRad-horizon;
        Object.assign(this.lastRequest, {minQ, maxQ});
        const radius = radiusOf(options);
        const domain = [this.domain, this.previousDomain].find(d => d && Math.abs(h-d.h) <= d.dh &&
            minQ >= d.minQ && maxQ <= d.maxQ && radiusFits(radius, d.radius));
        const nearEdge = domain && (Math.abs(h-domain.h) > domain.dh/10 ||
            Math.min(minQ-domain.minQ, domain.maxQ-maxQ) < SKY_PADDING_RAD-.002);
        if ((!domain || nearEdge) && !this.pending && !this.disposed &&
            (!options.rayGeometry || options.rayGeometry.atAltitude)) {
            const lead = 1.5*(this.buildWallMs ?? 1000); // estimated publication margin, ms
            const offset = domain ? clamp(altitudeVelocity*lead, -domain.dh/4, domain.dh/4) : 0;
            // Estimated forecast caps keep validation from reaching a distant
            // horizon branch merely because a previous busy build took longer.
            const e = domain ? clamp(velocity*lead, -.004, .004) : 0;
            const sensorAltitudeM = Math.max(0, h+offset);
            this.start({...options, sensorAltitudeM,
                rayGeometry: options.rayGeometry ? {...options.rayGeometry.atAltitude(sensorAltitudeM),
                    atAltitude: height => options.rayGeometry.atAltitude(height)} : undefined,
                elevationRange: {...requested, minRad: requested.minRad+e, maxRad: requested.maxRad+e,
                    centerRad: requested.centerRad+e}}, atmosphere);
        }
        if (this.error) throw this.error;
        if (domain) {
            this.hits++;
            if (this.sampled?.domain === domain && this.sampled.sensorAltitudeM === h) return this.sampled;
            const weights = polynomialWeights(SKY_HEIGHTS, domain.dh ? (h-domain.h)/domain.dh : 0);
            const elevations = Float64Array.from(domain.q, q => q+horizon);
            const photonRadiances = Float64Array.from(domain.q, (_, i) =>
                Math.max(0, weights.reduce((sum, w, j) => sum+w*domain.rows[j][i], 0)));
            this.sampled = {domain, sensorAltitudeM: h, options, elevations, photonRadiances,
                sampleCount: elevations.length, horizonRad: horizon, minRad: elevations[0], maxRad: elevations.at(-1),
                centerRad: requested.centerRad, photonRadianceRange: [Math.min(...photonRadiances), Math.max(...photonRadiances)],
                altitudeDomain: {minM: domain.h-domain.dh, maxM: domain.h+domain.dh,
                    maxErrorK: domain.altitudeErrorK, toleranceK: .001, status: "validated"},
                interpolation: {status: "validated", maxErrorK: domain.angularErrorK, toleranceK: .002,
                    toleranceMet: true, validation: "angular midpoints; altitude interior probes; factor-two margin"}};
            return this.sampled;
        }
        const cached = this.cached;
        const shift = cached ? horizon - cached.horizonRad : 0;
        // Preserve the validated small-shift fallback during cooperative warm-up.
        if (cached && h !== cached.sensorAltitudeM && !cached.altitudeDomain &&
            Math.abs(h-cached.sensorAltitudeM) <= .05 && (!options.rayGeometry || options.rayGeometry.atAltitude))
            this.validateAltitude(cached, atmosphere);
        const altitudeFits = cached && radiusFits(radius, cached.radius) && (h === cached.sensorAltitudeM || cached.altitudeDomain &&
            h >= cached.altitudeDomain.minM && h <= cached.altitudeDomain.maxM);
        if (altitudeFits && requested.minRad-shift >= cached.minRad && requested.maxRad-shift <= cached.maxRad) {
            this.hits++; return cached;
        }
        const padding = Math.max(.002, (requested.maxRad-requested.minRad)/8);
        const elevationRange = {...requested, minRad: Math.max(-Math.PI/2, requested.minRad-padding),
            maxRad: Math.min(Math.PI/2, requested.maxRad+padding)};
        const table = createSkyElevationLUT({...options, elevationRange, toleranceK: .002, initialSamples: 17}, atmosphere);
        if (!table.interpolation.toleranceMet) throw new Error("Sky interpolation did not meet its brightness tolerance");
        this.fallbacks++;
        this.cached = {...table, sensorAltitudeM: h, options, radius};
        return this.cached;
    }
    *build(options, atmosphere) {
        const h = options.sensorAltitudeM, band = options.band ?? {minUm: 3, maxUm: 5};
        const horizon = options.rayGeometry?.horizonRad ?? skyHorizon(options, h);
        const requested = options.elevationRange ?? skyElevationRange(options.view);
        // Estimated starting half-width 512 m; the angular padding is a work margin.
        // The cubic altitude coordinate follows the exact horizon, with separate
        // sea/sky endpoints. Validation halves the height span to the .001 K budget.
        let dh = Math.min(512, h*.75);
        for (let attempt = 0; attempt < 16; attempt++, dh /= 2) {
            const heights = SKY_HEIGHTS.map(y => h+y*dh);
            const geometries = heights.map(z => options.rayGeometry?.atAltitude(z));
            const horizons = heights.map((z, i) => geometries[i]?.horizonRad ?? skyHorizon(options, z));
            const minQ = Math.max(requested.minRad-horizon-SKY_PADDING_RAD, -Math.PI/2-Math.min(...horizons));
            const maxQ = Math.min(requested.maxRad-horizon+SKY_PADDING_RAD, Math.PI/2-Math.max(...horizons));
            const tables = [];
            for (let j = 0; j < heights.length; j++) {
                const elevationRange = {minRad: minQ, maxRad: maxQ,
                    centerRad: clamp(requested.centerRad-horizon, minQ, maxQ)};
                // Calculated cubic weight sum is at most 1.632; a factor of two
                // reserves the original .002 K angular budget after blending.
                const table = yield* skyElevationLUTSteps({...options, sensorAltitudeM: heights[j], rayGeometry: geometries[j],
                    elevationRange, coordinateOriginRad: horizons[j], toleranceK: .0006, initialSamples: 17}, atmosphere);
                if (!table.interpolation.toleranceMet) throw new Error("Sky interpolation did not meet its brightness tolerance");
                tables.push(table); yield;
            }
            const coords = [...new Set(tables.flatMap(t => Array.from(t.elevations)))].sort((a,b) => a-b);
            // Duplicate the horizon once, preserving both one-sided limits.
            if (minQ <= 0 && maxQ >= 0) coords.splice(coords.indexOf(0), 0, 0);
            // Calculated upload limit: the shader's 12 binary-search steps
            // resolve at most 4097 knots. Narrow height until the union fits.
            if (coords.length > 4097) continue;
            const side = i => coords[i] === 0 ? (i+1 < coords.length && coords[i+1] === 0 ? -1 : 1) : 0;
            const rows = tables.map((t, j) => Float64Array.from(coords, (q, i) => {
                if (side(i) === -1) return t.photonRadiances[Array.from(t.elevations).indexOf(t.horizonRad)];
                return sampleSkyElevationLUT(t, q);
            }));
            const at = (q, branch, z, geometry, boundary) => backgroundAtElevation(q+boundary+branch*1e-8,
                {...options, sensorAltitudeM: z, rayGeometry: geometry}, atmosphere).photonRadiance;
            let absolute = 0, minimum = Infinity;
            for (let i = 0; i < coords.length; i++) {
                const probes = [[coords[i], side(i)]];
                if (i && coords[i] > coords[i-1]) probes.push([(coords[i]+coords[i-1])/2, 0]);
                for (const [q, branch] of probes) {
                    const values = heights.map((z,j) => at(q, branch, z, geometries[j], horizons[j]));
                    for (const y of [-.8, -.5, 0, .5, .8]) {
                        const z = h+y*dh, geometry = options.rayGeometry?.atAltitude(z);
                        const actual = at(q, branch, z, geometry, geometry?.horizonRad ?? skyHorizon(options, z));
                        const weights = polynomialWeights(SKY_HEIGHTS, y);
                        const predicted = weights.reduce((sum,w,j) => sum+w*values[j], 0);
                        absolute = Math.max(absolute, Math.abs(actual-predicted));
                        if (actual || predicted) minimum = Math.min(minimum, actual, predicted);
                    }
                    yield;
                }
            }
            const altitudeErrorK = absolute === 0 ? 0 : 2*brightnessErrorBound(absolute, minimum, band, .001);
            const positive = rows.flatMap(row => Array.from(row).filter(value => value > 0));
            const angularErrorK = positive.length ? 2*brightnessErrorBound(
                Math.max(...tables.map(t => t.interpolation.maxAbsoluteError)), Math.min(...positive)*.99, band, .002) : 0;
            if (altitudeErrorK <= .001 && angularErrorK <= .002)
                return {h, dh, minQ, maxQ, q: coords, rows, altitudeErrorK, angularErrorK};
        }
        throw new Error("Sky altitude interpolation did not converge");
    }
    start(options, atmosphere) {
        const radius = radiusOf(options);
        scheduleThermalBuild(this, this.build(options, atmosphere), domain => {
            domain.radius = radius;
            const last = this.lastRequest;
            this.previousDomain = [this.domain, this.previousDomain].find(d => d && last &&
                Math.abs(last.h-d.h) <= d.dh && last.minQ >= d.minQ && last.maxQ <= d.maxQ) ?? this.domain;
            this.domain = domain; this.builds++; this.onReady();
        });
    }
    dispose() {this.disposed = true; this.pending = this.domain = this.previousDomain = null;}
    validateAltitude(table, atmosphere) {
        validateAltitudeSpan(table, [table], h => {
            const rayGeometry = table.options.rayGeometry?.atAltitude(h);
            return {rayGeometry, horizonRad: rayGeometry?.horizonRad ?? skyHorizon(table.options, h)};
        }, (_, elevationRad, at) => backgroundAtElevation(elevationRad,
            at ? {...table.options, sensorAltitudeM: at.sensorAltitudeM, rayGeometry: at.rayGeometry} : table.options,
            atmosphere).photonRadiance, table.options.band);
    }
}


// Estimated numerical allocations, additional to the unchanged range sampling:
// |dL| <= 1e-4 * sum(source bands) + B'(300 K) * .001 K.
// This covers every nonnegative source spectrum, including reflected sunlight.
export const RANGE_TRANSMISSION_TOLERANCE = 1e-4;
export const RANGE_PATH_TOLERANCE_K = .001;
const ANGLES = [-1, -.6, -.2, .2, .6, 1]; // calculated equally spaced quintic nodes
const HEIGHTS = [-1, -.6, -.2, .2, .6, 1]; // calculated quintic altitude nodes
const polynomialWeights = (nodes, x) => nodes.map((node, i) =>
    nodes.reduce((w, other, j) => i === j ? w : w*(x-other)/(node-other), 1));
function blend(tables, x, y) {
    const angular = polynomialWeights(ANGLES, 2*x-1);
    const weights = polynomialWeights(HEIGHTS, 2*y-1).flatMap(w => angular.map(a => a*w));
    const result = {...tables[0]};
    for (const field of ["transmission", "pathRadiance"]) {
        const arrays = tables.map(t => t[field]), output = new Float32Array(arrays[0].length);
        for (let i = 0; i < output.length; i++) {
            let value = 0;
            for (let k = 0; k < weights.length; k++) value += weights[k]*arrays[k][i];
            output[i] = Math.max(0, Math.min(field === "transmission" ? 1 : Infinity, value));
        }
        result[field] = output;
    }
    return result;
}

export class RangeTableCache {
    constructor(onReady = () => {}, {createWorker} = {}) {this.onReady = onReady; this.createWorker = createWorker; this.workerSerial = 0;}
    request(options, atmosphere) {
        const key = JSON.stringify([options.surfaceLimited ? ["surface", options.rangeLimitM] : options.maxRangeM, options.size, options.band,
            options.rayGeometry?.domainKey ?? options.rayGeometry?.key, options.segments]);
        if (this.error) {
            if (this.errorKey === key && this.errorAtmosphere === atmosphere) throw this.error;
            this.error = null;
        }
        const h = options.sensorAltitudeM, e = options.elevationRad, now = performance.now();
        const dt = this.lastRequest && now - this.lastRequest.time;
        const velocity = dt > 0 ? (e-this.lastRequest.e)/dt : 0;
        const altitudeVelocity = dt > 0 ? (h-this.lastRequest.h)/dt : 0;
        this.lastRequest = {e, h, time: now};
        const compatible = key === this.key && atmosphere === this.atmosphere, radius = radiusOf(options);
        if (this.pending && (this.pending.key !== key || this.pending.atmosphere !== atmosphere ||
            !radiusFits(radius, this.pending.radius))) {
            this.pending = null; this.error = null;
        }
        const contains = cell => cell && Math.abs(h-cell.h) <= cell.dh && Math.abs(e-cell.e) <= cell.de && radiusFits(radius, cell.radius);
        const domain = compatible ? [this.domain, this.previousDomain].find(contains) : null;
        const fits = !!domain;
        const leadMs = 1.5*(this.buildWallMs ?? 1000); // estimated scheduling margin
        // Prefetch when the camera, at its current rate, would leave the domain within twice the build lead time.
        // A fixed fraction of the half-width rebuilt continuously on a slow sweep (101 builds in 25 s live), and each
        // build takes main-thread slices from the frames.
        const exitMs = (offset, half, rate) => rate ? (half-Math.abs(offset))/Math.abs(rate) : Infinity;
        const angularEdge = fits && (e-domain.e)*velocity > 0 && exitMs(e-domain.e, domain.de, velocity) < 2*leadMs;
        const altitudeEdge = fits && (h-domain.h)*altitudeVelocity > 0 && exitMs(h-domain.h, domain.dh, altitudeVelocity) < 2*leadMs;
        if ((!fits || angularEdge || altitudeEdge) && !this.pending) {
            // Calculated motion prediction changes only the work domain, never a
            // physical ray. Retain overlapping completed domains during publication.
            const offset = fits ? clamp(velocity*leadMs, -domain.de*.4, domain.de*.4) : 0;
            const altitudeOffset = fits ? clamp(altitudeVelocity*leadMs, -domain.dh*.4, domain.dh*.4) : 0;
            // Advance one grid axis at a time. During a rapid bearing change,
            // finish the overlapping angular strip before a height change can
            // require a cold build near the surface.
            this.start({...options, elevationRad: fits ? angularEdge ? clamp(e+offset, domain.e-.8*domain.de, domain.e+.8*domain.de) : domain.e : e,
                sensorAltitudeM: fits ? angularEdge ? domain.h : clamp(h+altitudeOffset, domain.h-.8*domain.dh, domain.h+.8*domain.dh) : h}, atmosphere, key, domain);
        }
        if (this.error) throw this.error;
        if (!fits) return null;
        const table = blend(domain.tables, domain.de ? (e-domain.e+domain.de)/(2*domain.de) : .5, domain.dh ? (h-domain.h+domain.dh)/(2*domain.dh) : 0);
        this.report = {status: "validated", validation: "all range nodes; angular and altitude interior probes; factor-two margin",
            transmissionError: domain.transmissionError, pathErrorK: domain.pathErrorK,
            pending: !!this.pending, builds: this.builds ?? 0};
        table.maxRangeM = options.maxRangeM;
        return table;
    }
    *build(options, atmosphere, reuse = null) {
        let e = options.elevationRad, h = options.sensorAltitudeM;
        // Estimated initial work domain; only validated cells are published.
        // Estimated starting half-widths: .016 rad and 1024 m, clipped to 3/4 of height.
        // Quintic altitude interpolation is validated together with elevation;
        // halving changes the work domain, never a physical value or tolerance.
        let de = reuse?.de ?? options.initialHalfElevationRad ?? .016,
            dh = options.rayGeometry && !options.rayGeometry.atAltitude ? 0 : reuse?.dh ?? Math.min(options.initialHalfAltitudeM ?? 1024, h*.75);
        if (h === 0 && e === 0) de = 0;
        let grid;
        if (reuse?.grid) {
            // Calculated exact reuse: shift by whole interpolation nodes so the
            // overlapping spectral tables keep their original ray coordinates.
            const shift = (delta, step) => step ? clamp(Math.round(delta/step), -1, 1) : 0;
            grid = {...reuse.grid, ei: reuse.grid.ei+shift(e-reuse.e, reuse.grid.stepE), hi: reuse.grid.hi+shift(h-reuse.h, reuse.grid.stepH)};
            e = grid.e0+(grid.ei+(ANGLES.length-1)/2)*grid.stepE;
            h = grid.h0+(grid.hi+2.5)*grid.stepH;
            if (h < dh) {
                // Keep the validated angular span when descent reaches the
                // surface constraint. Halve only the altitude seed here.
                while (dh > h && dh > 0) dh /= 2;
                grid = null; reuse = null;
            }
        }
        const derivative = radianceDerivative(300, options.band).photon / PHOTON_SCALE;
        const at = (x, y, coordinates) => {
            const [elevation, altitude] = coordinates ?? [e+x*de, h+y*dh];
            const rayGeometry = dh && options.rayGeometry ? options.rayGeometry.atAltitude(altitude) : options.rayGeometry;
            const maxRangeM = options.surfaceLimited ? Math.min(options.rangeLimitM,
                rayGeometry ? rayGeometry.sea(elevation)?.distanceM ?? Infinity : thermalSeaDistance(altitude, Math.sin(elevation))) : options.maxRangeM;
            return createRangeLUTSteps({...options, maxRangeM, atmosphere, elevationRad: elevation, sensorAltitudeM: altitude, rayGeometry});
        };
        for (let attempt = 0; attempt < 16; attempt++, de /= 2, dh /= 2) {
            if (!options.surfaceLimited && HEIGHTS.some(y => {
                const altitude = h+y*dh, rayGeometry = options.rayGeometry?.atAltitude?.(altitude) ?? options.rayGeometry;
                return [e-de, e+de].some(elevation => (rayGeometry ? rayGeometry.sea(elevation)?.distanceM ?? Infinity :
                    thermalSeaDistance(altitude, Math.sin(elevation))) < options.maxRangeM-1e-5);
            })) {grid = null; reuse = null; continue;}
            grid ??= {e0: e-de, h0: h-dh, ei: 0, hi: 0, stepE: 2*de/(ANGLES.length-1), stepH: 2*dh/(HEIGHTS.length-1)};
            const tables = [];
            for (let j = 0; j < HEIGHTS.length; j++) for (let i = 0; i < ANGLES.length; i++) {
                const oldI = reuse ? grid.ei+i-reuse.grid.ei : -1, oldJ = reuse ? grid.hi+j-reuse.grid.hi : -1;
                const old = oldI >= 0 && oldI < ANGLES.length && oldJ >= 0 && oldJ < HEIGHTS.length ? reuse.tables[oldJ*ANGLES.length+oldI] : null;
                tables.push(old ?? (j && !dh ? tables[i] : yield* at(ANGLES[i], HEIGHTS[j],
                    [grid.e0+(grid.ei+i)*grid.stepE, grid.h0+(grid.hi+j)*grid.stepH])));
            }
            let transmissionError = 0, pathErrorK = 0;
            const checks = new Map();
            // Validated at every angular/altitude cell midpoint, including the
            // outer cells where polynomial interpolation has its largest weights.
            for (let j = 0; j < HEIGHTS.length-1; j++) for (let k = 0; k < ANGLES.length-1; k++) {
                const x = -1+2*(k+.5)/(ANGLES.length-1), y = -1+2*(j+.5)/(HEIGHTS.length-1), id = `${grid.ei+k},${grid.hi+j}`;
                const exact = reuse?.checks?.get(id) ?? (yield* at(x,y,
                    [grid.e0+(grid.ei+k+.5)*grid.stepE, grid.h0+(grid.hi+j+.5)*grid.stepH]));
                checks.set(id, exact);
                const predicted = blend(tables, (x+1)/2, (y+1)/2);
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
                return {e,h,de,dh,grid,tables,checks,transmissionError,pathErrorK};
            grid = null; reuse = null;
        }
        throw new Error("Foreground transfer interpolation did not converge");
    }
    start(options, atmosphere, key, seed = this.domain) {
        const radius = radiusOf(options);
        const reuse = this.key === key && this.atmosphere === atmosphere && seed &&
            Math.abs(options.elevationRad-seed.e) <= seed.de &&
            Math.abs(options.sensorAltitudeM-seed.h) <= seed.dh && radiusFits(radius, seed.radius) ? seed : null;
        const publish = domain => {
            // A late or narrower prefetch must not evict the domain serving
            // the current pose. Keep that completed domain until its replacement fits.
            this.previousDomain = this.key === key && this.atmosphere === atmosphere ?
                [this.domain, this.previousDomain].find(d => d && this.lastRequest &&
                    Math.abs(this.lastRequest.h-d.h) <= d.dh && Math.abs(this.lastRequest.e-d.e) <= d.de) ?? this.domain : null;
            domain.radius = radius;
            this.domain = domain; this.key = key; this.atmosphere = atmosphere;
            this.builds = (this.builds ?? 0)+1; this.onReady();
        };
        if (this.createWorker && options.workerAtmosphere && (!options.rayGeometry || options.rayGeometry.workerSpec)) {
            const job = {key, atmosphere, radius, serial: ++this.workerSerial, started: performance.now()};
            this.pending = job;
            const fallback = () => {
                if (this.disposed || this.pending !== job) return;
                this.worker?.terminate(); this.worker = null; this.workerPromise = null; this.createWorker = null;
                this.pending = null; this.start(options, atmosphere, key, seed);
            };
            this.workerPromise ??= Promise.resolve().then(() => this.createWorker()).then(worker => {
                if (this.disposed) {worker?.terminate(); return null;}
                this.worker = worker;
                if (worker) worker.onmessage = ({data}) => {
                    const current = this.pending;
                    if (!current || data.serial !== current.serial || this.disposed) return;
                    if (data.error) {current.fallback(); return;}
                    this.pending = null; this.buildWallMs = performance.now() - current.started;
                    current.publish(data.domain);
                };
                return worker;
            });
            job.fallback = fallback; job.publish = publish;
            this.workerPromise.then(worker => {
                if (this.disposed || this.pending !== job) return;
                if (!worker) {fallback(); return;}
                worker.onerror = fallback;
                const {rayGeometry, atmosphere: ignored, workerAtmosphere, ...numeric} = options;
                try {worker.postMessage({serial: job.serial, options: numeric, raySpec: rayGeometry?.workerSpec,
                    atmosphere: workerAtmosphere, reuse});} catch {fallback();}
            }).catch(fallback);
            return;
        }
        const job = scheduleThermalBuild(this, this.build(options, atmosphere, reuse), publish);
        Object.assign(job, {key, atmosphere, radius});
    }
    dispose() {this.disposed = true; this.pending = this.domain = this.previousDomain = null; this.worker?.terminate(); this.worker = null;}
}
