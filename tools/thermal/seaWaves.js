// Linear random sea from a measured directional wave spectrum, in deep water.
//
// A spectrum follows the directional wave-buoy convention. Per frequency band it gives the elevation density
// E [m²/Hz], the band width [Hz], the mean direction the waves come FROM [degrees clockwise from true north]
// and r1, the first normalized directional moment [1]. The sea is a sum of plane-wave components with
// random phases from a seed, so a replay or a seek returns the same water. Linear theory only: no
// second-order crest sharpening, breaking, foam or spray. Positions are meters east and north of a fixed
// point on the sea; time is seconds on the scene clock, so a moving camera sees encounter frequencies
// without any special case.

export const GRAVITY_MPS2 = 9.80665; // conventional gravity, as in atmosphere.js

/** Calculated significant wave height [m]: 4 sqrt(sum E df), the spectral convention. */
export function significantWaveHeight({densityM2PerHz, bandwidthHz}) {
    let variance = 0;
    for (let i = 0; i < densityM2PerHz.length; i++) variance += densityM2PerHz[i] * bandwidthHz[i];
    return 4 * Math.sqrt(variance);
}

// Deterministic 32-bit generator, uniform on [0, 1): a numerical choice, not a physical model.
function uniformGenerator(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Inverse cumulative distribution of the published cos^(2s)(theta/2) spreading, s = r1 / (1 - r1),
// on a 3601-point grid over [-pi, pi] (numerical choice). Returns offsets from the mean direction [rad].
function spreadingSampler(r1) {
    const s = r1 / (1 - r1), n = 3601;
    const theta = new Float64Array(n), cdf = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        theta[i] = -Math.PI + 2 * Math.PI * i / (n - 1);
        cdf[i] = (i ? cdf[i - 1] : 0) + Math.cos(theta[i] / 2) ** (2 * s);
    }
    for (let i = 0; i < n; i++) cdf[i] /= cdf[n - 1];
    return u => {
        let lo = 0, hi = n - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid; else hi = mid; }
        const span = cdf[hi] - cdf[lo];
        return theta[lo] + (span > 0 ? (u - cdf[lo]) / span : 0) * (theta[hi] - theta[lo]);
    };
}

/** Plane-wave components for a Gaussian sea with the given spectrum (estimated: linear, deep water).
 * Each band splits into `subFrequencies` random frequencies, each with `directions` random directions
 * from the band's spreading, so every component carries the same share of the band's variance:
 * amplitude = sqrt(2 E df / (subFrequencies * directions)). An f^-4 tail (estimated) continues the
 * spectrum from the last band to `tailHz` in `tailStepHz` bands, with the mean energy, direction and r1 of
 * the last three bands. r1 is limited to 0.05-0.985 (numerical choice). Deep-water dispersion
 * omega² = g k; the depth is not used. Returned arrays: amplitudeM, kEast and kNorth [rad/m] (toward the
 * travel direction), omegaRadS, phaseRad, frequencyHz.
 */
export function waveComponents(spectrum, {seed = 1, subFrequencies = 4, directions = 24, tailHz = 0.6,
    tailStepHz = 0.02} = {}) {
    const f = [...spectrum.frequencyHz], df = [...spectrum.bandwidthHz], E = [...spectrum.densityM2PerHz];
    const from = [...spectrum.meanFromDeg], r1 = Array.from(spectrum.r1, r => Math.min(0.985, Math.max(0.05, r)));
    const last = f.length - 1, mean3 = values => (values[last] + values[last - 1] + values[last - 2]) / 3;
    if (tailHz > f[last] + df[last] / 2) {
        const tailEnergy = mean3(E), tailR1 = mean3(r1), fLast = f[last];
        // Mean of the last three directions, as a circular mean.
        const tailFrom = Math.atan2(mean3(from.map(d => Math.sin(d * Math.PI / 180))),
            mean3(from.map(d => Math.cos(d * Math.PI / 180)))) * 180 / Math.PI;
        for (let ft = fLast + df[last]; ft < tailHz; ft += tailStepHz) {
            f.push(ft); df.push(tailStepHz); E.push(tailEnergy * (ft / fLast) ** -4); from.push(tailFrom); r1.push(tailR1);
        }
    }
    const random = uniformGenerator(seed), list = [];
    for (let i = 0; i < f.length; i++) {
        if (!(E[i] > 0)) continue;
        const sample = spreadingSampler(r1[i]), amplitude = Math.sqrt(2 * E[i] * df[i] / (subFrequencies * directions));
        for (let j = 0; j < subFrequencies; j++) {
            const frequency = f[i] + (random() - 0.5) * df[i];
            for (let d = 0; d < directions; d++) {
                const toward = (from[i] + 180) * Math.PI / 180 + sample(random());
                list.push([amplitude, frequency, toward]);
            }
        }
    }
    const count = list.length, out = {count, amplitudeM: new Float64Array(count), kEast: new Float64Array(count),
        kNorth: new Float64Array(count), omegaRadS: new Float64Array(count), phaseRad: new Float64Array(count),
        frequencyHz: new Float64Array(count)};
    list.forEach(([amplitude, frequency, toward], j) => {
        const omega = 2 * Math.PI * frequency, k = omega * omega / GRAVITY_MPS2;
        out.amplitudeM[j] = amplitude; out.frequencyHz[j] = frequency; out.omegaRadS[j] = omega;
        out.kEast[j] = k * Math.sin(toward); out.kNorth[j] = k * Math.cos(toward);
    });
    for (let j = 0; j < count; j++) out.phaseRad[j] = 2 * Math.PI * random();
    return out;
}

/** Water elevation above mean sea level [m] at a point and time. */
export function seaElevation(c, eastM, northM, timeS) {
    let eta = 0;
    for (let j = 0; j < c.count; j++)
        eta += c.amplitudeM[j] * Math.cos(c.kEast[j] * eastM + c.kNorth[j] * northM - c.omegaRadS[j] * timeS + c.phaseRad[j]);
    return eta;
}

/** Water slope [1] at a point and time: {east, north} = gradient of the elevation. */
export function seaSlope(c, eastM, northM, timeS) {
    let east = 0, north = 0;
    for (let j = 0; j < c.count; j++) {
        const s = -c.amplitudeM[j] * Math.sin(c.kEast[j] * eastM + c.kNorth[j] * northM - c.omegaRadS[j] * timeS + c.phaseRad[j]);
        east += s * c.kEast[j]; north += s * c.kNorth[j];
    }
    return {east, north};
}

/** Elevation [m] at `count` evenly spaced points along a horizontal line: from (eastM, northM) toward
 * azimuthRad (clockwise from north), offset lateralM to the right, at distances startM + n stepM. Each
 * component advances by a rotation, which is exact to rounding; it is recomputed every 1024 points.
 */
export function seaAlongLine(c, {eastM, northM, azimuthRad, lateralM = 0, startM, stepM, count, timeS}, out = new Float64Array(count)) {
    out.fill(0, 0, count);
    const ue = Math.sin(azimuthRad), un = Math.cos(azimuthRad);
    const e0 = eastM + startM * ue + lateralM * un, n0 = northM + startM * un - lateralM * ue;
    for (let j = 0; j < c.count; j++) {
        const a = c.amplitudeM[j], phase0 = c.kEast[j] * e0 + c.kNorth[j] * n0 - c.omegaRadS[j] * timeS + c.phaseRad[j];
        const step = stepM * (c.kEast[j] * ue + c.kNorth[j] * un), cs = Math.cos(step), sn = Math.sin(step);
        let x = 0, y = 0;
        for (let n = 0; n < count; n++) {
            if ((n & 1023) === 0) { x = Math.cos(phase0 + n * step); y = Math.sin(phase0 + n * step); }
            out[n] += a * x;
            const nx = x * cs - y * sn; y = x * sn + y * cs; x = nx;
        }
    }
    return out;
}

/** Crest envelope along one azimuth, the CPU reference for first-hit tests: M[n] = the highest apparent elevation
 * of the water at ranges up to r_n = startM + n stepM, where water at height eta and range r appears at
 * smoothElevationRad(r) + eta / r. smoothElevationRad gives the apparent elevation of the mean sea surface, so the
 * caller's refraction model applies unchanged; the eta / r term is the small-angle height step at that range.
 * M is non-decreasing, so a ray at elevation e first meets the water at the smallest r_n with M[n] >= e.
 */
export function seaCrestEnvelope(c, line, smoothElevationRad, out = new Float64Array(line.count)) {
    const eta = seaAlongLine(c, line, out);
    let highest = -Infinity;
    for (let n = 0; n < line.count; n++) {
        const r = line.startM + n * line.stepM;
        highest = Math.max(highest, smoothElevationRad(r) + eta[n] / r);
        out[n] = highest;
    }
    return out;
}

/** First range [m] at which a ray of apparent elevation elevationRad meets the water, from a crest envelope;
 * Infinity when the ray passes above every crest in the sampled ranges. */
export function seaFirstHitRange(envelope, {startM, stepM, count}, elevationRad) {
    if (!(envelope[count - 1] >= elevationRad)) return Infinity;
    let lo = -1, hi = count - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (envelope[mid] >= elevationRad) hi = mid; else lo = mid; }
    return startM + hi * stepM;
}

/** The horizon-forming crest along one line of sight: the highest apparent elevation of the water,
 * with the small-angle curved-Earth relation e = (eta - h) / r - r / (2 Reff). Reff is the effective
 * Earth radius R / (1 - k) for refraction coefficient k (estimated: a constant k replaces a ray trace).
 * Returns {elevationRad, rangeM}. A point at range r and elevation e is hidden by the water when a crest
 * nearer than r reaches e; use `seaAlongLine` for that test, not this maximum alone.
 */
export function seaSilhouette(c, line, {eyeHeightM, effectiveRadiusM}, scratch) {
    const eta = seaAlongLine(c, line, scratch);
    let best = -Infinity, bestRange = NaN;
    for (let n = 0; n < line.count; n++) {
        const r = line.startM + n * line.stepM, e = (eta[n] - eyeHeightM) / r - r / (2 * effectiveRadiusM);
        if (e > best) { best = e; bestRange = r; }
    }
    return {elevationRad: best, rangeM: bestRange};
}
