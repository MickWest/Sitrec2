import {GRAVITY_MPS2, seaAlongLine, seaCrestEnvelope, seaElevation, seaFirstHitRange, seaSilhouette, seaSlope, significantWaveHeight,
    waveComponents} from "../tools/thermal/seaWaves.js";

// Test fixtures, not observations: three bands, a broad swell from the south-southwest and a narrow wind sea.
const spectrum = {frequencyHz: [0.08, 0.13, 0.2], bandwidthHz: [0.01, 0.01, 0.01], densityM2PerHz: [2, 8, 3],
    meanFromDeg: [200, 315, 315], r1: [0.5, 0.95, 0.9]};
const variance = c => c.amplitudeM.reduce((sum, a) => sum + a * a / 2, 0);

test("component variance equals the spectrum's; the tail adds only its own bands", () => {
    const c = waveComponents(spectrum, {seed: 3, tailHz: 0});
    expect(c.count).toBe(3 * 4 * 24);
    expect(4 * Math.sqrt(variance(c))).toBeCloseTo(significantWaveHeight(spectrum), 12);
    const tailed = waveComponents(spectrum, {seed: 3, tailHz: 0.3, tailStepHz: 0.02});
    // Tail bands 0.21, 0.23, ..., 0.29 Hz at the mean of the last three densities, falling as f^-4.
    let tail = 0;
    for (let f = 0.21; f < 0.3; f += 0.02) tail += (13 / 3) * (f / 0.2) ** -4 * 0.02;
    expect(variance(tailed)).toBeCloseTo(variance(c) + tail, 12);
});

test("deep-water dispersion, and waves FROM the west travel east", () => {
    const narrow = {frequencyHz: [0.1], bandwidthHz: [1e-9], densityM2PerHz: [1], meanFromDeg: [270], r1: [0.985]};
    const c = waveComponents(narrow, {seed: 1, tailHz: 0, subFrequencies: 1, directions: 1});
    const k = Math.hypot(c.kEast[0], c.kNorth[0]);
    expect(c.omegaRadS[0] ** 2).toBeCloseTo(GRAVITY_MPS2 * k, 10);
    expect(c.kEast[0] / k).toBeGreaterThan(Math.cos(40 * Math.PI / 180));
    // The pattern moves with the phase velocity omega / k along k.
    const speed = c.omegaRadS[0] / k, dt = 3.7;
    const moved = seaElevation(c, 120 + speed * dt * c.kEast[0] / k, -40 + speed * dt * c.kNorth[0] / k, 10 + dt);
    expect(moved).toBeCloseTo(seaElevation(c, 120, -40, 10), 12);
});

test("a seed fixes the sea; another seed gives another sea", () => {
    const a = waveComponents(spectrum, {seed: 7}), b = waveComponents(spectrum, {seed: 7}), other = waveComponents(spectrum, {seed: 8});
    expect(b.phaseRad).toEqual(a.phaseRad);
    expect(seaElevation(b, 5000, 2000, 33.3)).toBe(seaElevation(a, 5000, 2000, 33.3));
    expect(other.phaseRad).not.toEqual(a.phaseRad);
});

test("line evaluation equals the direct sum, with a lateral offset", () => {
    const c = waveComponents(spectrum, {seed: 5});
    const line = {eastM: 300, northM: -800, azimuthRad: 4.92, lateralM: 35, startM: 6000, stepM: 2, count: 3000, timeS: 12.5};
    const eta = seaAlongLine(c, line);
    const ue = Math.sin(line.azimuthRad), un = Math.cos(line.azimuthRad);
    for (const n of [0, 1, 1023, 1024, 1500, 2999]) {
        const r = line.startM + n * line.stepM;
        expect(eta[n]).toBeCloseTo(seaElevation(c, line.eastM + r * ue + line.lateralM * un,
            line.northM + r * un - line.lateralM * ue, line.timeS), 9);
    }
});

test("slope is the gradient of the elevation", () => {
    const c = waveComponents(spectrum, {seed: 2}), h = 1e-3;
    const slope = seaSlope(c, 70, 90, 4);
    expect(slope.east).toBeCloseTo((seaElevation(c, 70 + h, 90, 4) - seaElevation(c, 70 - h, 90, 4)) / (2 * h), 6);
    expect(slope.north).toBeCloseTo((seaElevation(c, 70, 90 + h, 4) - seaElevation(c, 70, 90 - h, 4)) / (2 * h), 6);
});

test("sampled elevations recover the significant wave height", () => {
    const c = waveComponents(spectrum, {seed: 11, tailHz: 0});
    let sum = 0, sum2 = 0, n = 4000, state = 1;
    const next = () => (state = (state * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < n; i++) {
        const eta = seaElevation(c, 2e5 * next(), 2e5 * next(), 1000 * next());
        sum += eta; sum2 += eta * eta;
    }
    const sampledHs = 4 * Math.sqrt(sum2 / n - (sum / n) ** 2);
    expect(Math.abs(sampledHs / significantWaveHeight(spectrum) - 1)).toBeLessThan(0.05);
});

test("the crest envelope gives first hits: a crest hides what is behind it, not what is in front", () => {
    const c = waveComponents(spectrum, {seed: 9});
    const effectiveRadiusM = 6371000 / (1 - 0.115), eyeHeightM = 21;
    const smooth = r => -eyeHeightM / r - r / (2 * effectiveRadiusM);
    const line = {eastM: 0, northM: 0, azimuthRad: 4.92, startM: 3000, stepM: 2, count: 13501, timeS: 40};
    const envelope = seaCrestEnvelope(c, line, smooth), eta = seaAlongLine(c, line);
    for (let n = 1; n < line.count; n++) expect(envelope[n]).toBeGreaterThanOrEqual(envelope[n - 1]);
    // The horizon-forming crest: the envelope's maximum, where it is first reached.
    const top = envelope[line.count - 1], crestRange = seaFirstHitRange(envelope, line, top);
    const crest = (crestRange - line.startM) / line.stepM;
    expect(smooth(crestRange) + eta[crest] / crestRange).toBeCloseTo(top, 15);
    expect(seaSilhouette(c, line, {eyeHeightM, effectiveRadiusM}).elevationRad).toBeCloseTo(top, 15);
    // Just above the crest line nothing is hit; just below it, the crest is hit, at or before its range.
    expect(seaFirstHitRange(envelope, line, top + 1e-9)).toBe(Infinity);
    expect(seaFirstHitRange(envelope, line, top - 1e-9)).toBeLessThanOrEqual(crestRange);
    // A point 1 m beyond the crest and 1 micro-radian below the crest line is hidden. A point in front of the
    // crest and above all nearer water is not hidden by the farther crest, even below the crest line.
    const behind = crestRange + 1, inFront = crestRange - 200, low = top - 1e-6;
    expect(seaFirstHitRange(envelope, line, low)).toBeLessThan(behind);
    const clear = envelope[(inFront - line.startM) / line.stepM] + 1e-9;
    expect(clear).toBeLessThan(top);
    expect(seaFirstHitRange(envelope, line, clear)).toBeGreaterThan(inFront);
});

test("a flat sea gives the smooth horizon dip at the tangent range", () => {
    const flat = waveComponents({...spectrum, densityM2PerHz: [0, 0, 0]}, {tailHz: 0});
    expect(flat.count).toBe(0);
    const effectiveRadiusM = 6371000 / (1 - 0.115), eyeHeightM = 21;
    const silhouette = seaSilhouette(flat, {eastM: 0, northM: 0, azimuthRad: 0, startM: 6000, stepM: 2, count: 12001, timeS: 0},
        {eyeHeightM, effectiveRadiusM});
    expect(silhouette.elevationRad).toBeCloseTo(-Math.sqrt(2 * eyeHeightM / effectiveRadiusM), 10);
    expect(Math.abs(silhouette.rangeM - Math.sqrt(2 * eyeHeightM * effectiveRadiusM))).toBeLessThanOrEqual(1);
});
