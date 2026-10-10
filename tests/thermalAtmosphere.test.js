import assert from "node:assert/strict";
import * as M from "../tools/thermal/atmosphere.js";
import {inBandRadiance, PHOTON_SCALE} from "../tools/thermal/radiometry.js";

const {createAtmosphere, solvePath, evaluatePath, blackbodyBands,
    transmitRadiance, clearSky, seaBackground, seaReflectance, BANDS} = M;
const sum = a => a.reduce((a, b) => a + b, 0);
const rad = d => d * Math.PI / 180;
function close(a, b, tolerance = 1e-10) { assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b} +/- ${tolerance}`); }
function compare(a, b, tolerance = 1e-10) { assert.equal(a.length, b.length); a.forEach((v, i) => close(v, b[i], tolerance)); }
const atm = createAtmosphere();
const FLAT = {sensorAltitudeM: 0, targetAltitudeM: 0, earthRadiusM: Infinity};
const isothermal = (temperatureK = 290, extra = {}) => createAtmosphere({
    profile: () => ({temperatureK, pressurePa: 101325, waterVaporDensityKgM3: 0.01}), ...extra});
const aerosolOnly = (extra = {}) => isothermal(290, {co2Scale: 0, waterLineScale: 0,
    traceGasScale: 0, continuumScale: 0, aerosolExtinction4umPerM: () => 0.001,
    aerosolSpectralPower: 0, ...extra});

test('band coverage and channel weights', () => {
    close(BANDS[0].minM, 3e-6); close(BANDS.at(-1).maxM, 5e-6);
    BANDS.slice(1).forEach((band, index) => close(band.minM, BANDS[index].maxM));
    close(sum(M.CHANNEL_WEIGHTS), 1);
});
test('Planck band integral agrees with independent adaptive quadrature in SI units', () => {
    // Independently evaluated with scipy.integrate.quad over wavelength, using
    // the exact SI h, c, k constants; not a number fitted to this implementation.
    close(sum(blackbodyBands(300)), 1.8659562081616936, 1e-9);
});
test('zero range preserves source exactly and emits nothing', () => {
    const p = evaluatePath({...FLAT, slantRangeM: 0}, atm);
    compare(p.transmission, Array(12).fill(1)); compare(p.pathRadiance, Array(12).fill(0));
    compare(transmitRadiance(p, blackbodyBands(700)).observed, blackbodyBands(700));
});
test('vacuum includes removing aerosol extinction', () => {
    const p = evaluatePath({...FLAT, slantRangeM: 200000}, createAtmosphere({densityScale: 0}));
    compare(p.transmission, Array(12).fill(1)); compare(p.pathRadiance, Array(12).fill(0));
});
test('homogeneous Beer law and absolute radiance', () => {
    const p = evaluatePath({...FLAT, slantRangeM: 2000}, aerosolOnly());
    compare(p.transmission, Array(12).fill(Math.exp(-2)));
    compare(p.pathRadiance, blackbodyBands(290).map(x => x * (1 - Math.exp(-2))));
});
test('opaque very long isothermal path approaches air blackbody', () => {
    const p = evaluatePath({...FLAT, slantRangeM: 1e7}, isothermal());
    assert.ok(Math.max(...p.transmission) < 1e-10);
    compare(p.pathRadiance, blackbodyBands(290));
});
test('isothermal thermal equilibrium for mixed bands at multiple ranges', () => {
    for (const range of [1, 1000, 15000, 100000]) {
        const p = evaluatePath({...FLAT, slantRangeM: range}, isothermal());
        compare(transmitRadiance(p, blackbodyBands(290)).observed, blackbodyBands(290));
    }
});
test('two temperatures are integrated in observer-to-target order', () => {
    const a = aerosolOnly({profile: z => ({temperatureK: z < 500 ? 300 : 280,
        pressurePa: 101325, waterVaporDensityKgM3: 0.01})});
    const p = evaluatePath({sensorAltitudeM: 0, targetAltitudeM: 1000, slantRangeM: 1000}, a, {segments: 2});
    const near = blackbodyBands(300), far = blackbodyBands(280), t = Math.exp(-0.5);
    compare(p.pathRadiance, near.map((x, i) => x * (1 - t) + t * (1 - t) * far[i]));
});
test('reciprocity of transmission but direction-dependent path radiance', () => {
    const p = evaluatePath({sensorAltitudeM: 1000, targetAltitudeM: 9000, slantRangeM: 90000}, atm);
    const q = evaluatePath({sensorAltitudeM: 9000, targetAltitudeM: 1000, slantRangeM: 90000}, atm);
    compare(p.transmission, q.transmission);
    assert.ok(Math.abs(p.pathRadianceWm2Sr - q.pathRadianceWm2Sr) > 0.01);
});
test('transmission decreases with range on a fixed homogeneous path', () => {
    let previous = Array(12).fill(1);
    for (const range of [1, 100, 1000, 5000, 15000, 20000, 50000, 200000]) {
        const p = evaluatePath({...FLAT, slantRangeM: range}, isothermal());
        p.transmission.forEach((t, i) => assert.ok(t <= previous[i] + 1e-14)); previous = p.transmission;
    }
});
test('water, carbon dioxide and haze separately reduce transmission', () => {
    for (const key of ['waterLineScale', 'co2Scale', 'aerosolRatio4um', 'continuumScale']) {
        const p = evaluatePath({...FLAT, slantRangeM: 10000}, createAtmosphere({[key]: 0}));
        const q = evaluatePath({...FLAT, slantRangeM: 10000}, createAtmosphere({[key]: 2}));
        p.transmission.forEach((t, i) => assert.ok(q.transmission[i] <= t + 1e-14));
        assert.ok(q.flatTransmission < p.flatTransmission);
    }
});
test('humidity increases continuum and line absorption', () => {
    const p = evaluatePath({...FLAT, slantRangeM: 10000}, createAtmosphere({relativeHumidity: 0}));
    const q = evaluatePath({...FLAT, slantRangeM: 10000}, createAtmosphere({relativeHumidity: 0.9}));
    assert.ok(q.flatTransmission < p.flatTransmission);
    assert.ok(q.opticalDepthComponents.continuum[2] > p.opticalDepthComponents.continuum[2]);
});
test('elevated equal-height path transmits more in standard atmosphere', () => {
    let previous = Array(12).fill(0);
    for (const altitude of [100, 2000, 7600, 12000]) {
        const p = evaluatePath({sensorAltitudeM: altitude, targetAltitudeM: altitude, slantRangeM: 50000}, atm);
        p.transmission.forEach((t, i) => assert.ok(t >= previous[i] - 1e-14)); previous = p.transmission;
    }
});
test('CO2 center is suppressed and its wings transmit along a high-altitude path', () => {
    const p = evaluatePath({sensorAltitudeM: 7620, targetAltitudeM: 7620, slantRangeM: 60000}, atm);
    assert.ok(p.transmission[6] < 1e-6);
    assert.ok(p.transmission[4] > p.transmission[6] * 100);
    assert.ok(p.transmission[9] > p.transmission[6] * 100);
});
test('a scattering-only aerosol does not emit thermal radiation', () => {
    const p = evaluatePath({...FLAT, slantRangeM: 2000}, aerosolOnly({aerosolSingleScatteringAlbedo: 1,
        aerosolIncidentRadiance: Array(12).fill(0)}));
    compare(p.pathRadiance, Array(12).fill(0));
    compare(p.transmission, Array(12).fill(Math.exp(-2)));
});
test('scattering in isotropic thermal equilibrium conserves radiance', () => {
    const p = evaluatePath({...FLAT, slantRangeM: 2000}, aerosolOnly({aerosolSingleScatteringAlbedo: 0.9,
        aerosolIncidentRadiance: blackbodyBands(290)}));
    compare(transmitRadiance(p, blackbodyBands(290)).observed, blackbodyBands(290));
});
test('spherical geometry, elevation inversion and Earth obstruction', () => {
    const p = solvePath({sensorAltitudeM: 6492.24, elevationRad: rad(-50), slantRangeM: 7408});
    const q = solvePath({sensorAltitudeM: 6492.24, elevationRad: rad(-50), targetAltitudeM: p.targetAltitudeM});
    close(q.slantRangeM, 7408, 1e-5);
    assert.ok(solvePath({sensorAltitudeM: 20, targetAltitudeM: 20, slantRangeM: 100000}).occluded);
    assert.throws(() => evaluatePath({sensorAltitudeM: 20, targetAltitudeM: 20, slantRangeM: 100000}));
    assert.ok(!solvePath({sensorAltitudeM: 20, elevationRad: 0, slantRangeM: 100000}).occluded);
});
test('clear sky handles horizon and altitude without a secant singularity', () => {
    const horizon = clearSky({sensorAltitudeM: 20, elevationRad: 0}, atm);
    const zenith = clearSky({sensorAltitudeM: 20, elevationRad: Math.PI / 2}, atm);
    const high = clearSky({sensorAltitudeM: 7620, elevationRad: Math.PI / 2}, atm);
    assert.ok(horizon.radianceWm2Sr > zenith.radianceWm2Sr);
    assert.ok(zenith.radianceWm2Sr > high.radianceWm2Sr);
    assert.equal(clearSky({sensorAltitudeM: 20, elevationRad: rad(-1)}, atm).kind, 'surface');
});
test('sea Fresnel normal and grazing limits', () => {
    close(seaReflectance(1), ((1.35 - 1) ** 2 + 0.01 ** 2) / ((1.35 + 1) ** 2 + 0.01 ** 2));
    close(seaReflectance(0), 1);
    assert.ok(seaReflectance(Math.cos(rad(85))) > seaReflectance(Math.cos(rad(60))));
});
test('sea source and foreground remain finite and positive', () => {
    const sea = seaBackground({sensorAltitudeM: 20, elevationRad: rad(-0.2)}, atm);
    assert.ok(sea.radianceWm2Sr > 0);
    assert.ok(sea.radianceWm2Sr < sum(blackbodyBands(310)));
    assert.ok(sea.path.geometry.slantRangeM > 0);
});
test('profile hydrostatic pressure and array interpolation', () => {
    const a = createAtmosphere({temperatureProfile: [{altitudeM: 0, temperatureK: 300}, {altitudeM: 10000, temperatureK: 300}]});
    close(a.sample(5000).temperatureK, 300);
    close(a.sample(5000).pressurePa, 101325 * Math.exp(-9.80665 * 5000 / (287.05287 * 300)), 1e-7);
    close(atm.sample(11000).temperatureK, 216.65);
    close(atm.sample(11000).pressurePa, 22632.04, 0.1);
});
test('reject invalid inputs instead of returning plausible numbers', () => {
    for (const input of [{...FLAT, slantRangeM: -1}, {...FLAT, slantRangeM: NaN},
        {sensorAltitudeM: 0, targetAltitudeM: 2000, slantRangeM: 1000},
        {sensorAltitudeM: 0, targetAltitudeM: 10, slantRangeM: 0}]) assert.throws(() => evaluatePath(input));
    assert.throws(() => createAtmosphere({relativeHumidity: -0.1}));
    assert.throws(() => createAtmosphere({aerosolSingleScatteringAlbedo: 0.9}));
});


// Independent saved Omaha surface-path calculation, photon-weighted 290 K source,
// 3.6–4.9 um. The 5 km row anchors water amplitude; other ranges test extrapolation.
// The input is the 5 m state of a surface-anchored temperature/humidity column.
const omahaFixtures = [
    [1000, 0.48791285788146904], [5000, 0.16608400118260286],
    [10000, 0.059008662914097204], [17000, 0.016256494441430198],
    [30000, 0.0017803861226010163], [100000, 2.999344330366171e-8],
];
test.each(omahaFixtures)("Omaha broadband comparison at %i m", (rangeM, expected) => {
    const temperatureK = 290.25;
    const vaporPressurePa = 611.2 * Math.exp(17.67 * 15.6 / (15.6 + 243.5));
    const pressurePa = 101200 * Math.exp(-9.80665 * 5 / (287.05 * temperatureK * (1 + 0.378 * vaporPressurePa / 101200)));
    const atmosphere = createAtmosphere({profile: () => ({temperatureK, pressurePa,
        waterVaporDensityKgM3: vaporPressurePa * 0.01801528 / (8.31446261815324 * temperatureK)}),
        aerosolExtinction4umPerM: () => 0.6 * 3.912 / 16600, aerosolSpectralPower: 0, co2MoleFraction: 411e-6});
    const path = evaluatePath({...FLAT, sensorAltitudeM:5, targetAltitudeM:5, slantRangeM:rangeM}, atmosphere);
    const weights = BANDS.map(band => {
        const minUm = Math.max(3.6, band.minM * 1e6), maxUm = Math.min(4.9, band.maxM * 1e6);
        return maxUm > minUm ? inBandRadiance(290,{minUm,maxUm}).photon : 0;
    });
    const measured = sum(weights.map((weight,index) => weight * path.transmission[index])) / sum(weights);
    expect(Math.abs(measured / expected - 1)).toBeLessThan(0.083);
});
test("photon atmosphere preserves isothermal equilibrium without an energy midpoint conversion", () => {
    for (const band of [{minUm:3,maxUm:5},{minUm:3.7,maxUm:4.8}]) {
        const source = M.blackbodyBands(290,{quantity:"photon",band});
        const path = M.evaluatePhotonPath({...FLAT,slantRangeM:10000},isothermal(),{band});
        for (let index=0;index<12;index++) expect(Math.abs(source[index]*path.transmission[index]+path.pathRadiance[index]-source[index]))
            .toBeLessThanOrEqual(Math.max(1,source[index]*1e-12));
        expect(Math.abs(sum(source)/inBandRadiance(290,band).photon-1)).toBeLessThan(1e-9);
    }
});
test("vacuum range LUT preserves source radiance and absorbing paths emit", () => {
    const table = M.createRangeLUT({maxRangeM:1000,size:8,sensorAltitudeM:100,atmosphere:createAtmosphere({densityScale:0})});
    const source = M.blackbodyBands(600,{quantity:"photon"});
    const received = M.sourceRangeLUT(table,source);
    for (const value of received) expect(Math.abs(value/(sum(source)/PHOTON_SCALE)-1)).toBeLessThan(1e-7);
    const absorbing = M.createRangeLUT({maxRangeM:1000,size:8,sensorAltitudeM:0,atmosphere:isothermal()});
    expect(absorbing.pathRadiance.some(value => value > 0)).toBe(true);
});

test("photon transmission reports photon totals without NaN energy metadata", () => {
    const path=M.evaluatePhotonPath({...FLAT,slantRangeM:1000},isothermal());
    const result=transmitRadiance(path,M.blackbodyBands(290,{quantity:"photon"}));
    expect(result.quantity).toBe("photon");
    expect(Number.isFinite(result.observedRadiancePhotons)).toBe(true);
    expect(result.observedRadianceWm2Sr).toBeUndefined();
    expect(result.observedRadiance).toBe(result.observedRadiancePhotons);
});
test("cached path sources preserve exact band quadrature through long atmospheric paths", () => {
    const atmosphere = createAtmosphere();
    for (const quantity of ["energy", "photon"]) for (const elevationRad of [0, .04, .3]) {
        const geometry = {sensorAltitudeM: 1382, slantRangeM: 200000, elevationRad};
        const cached = evaluatePath(geometry, atmosphere, {segments: 96, quantity});
        const exact = evaluatePath(geometry, atmosphere, {segments: 96, quantity, exactSource: true});
        expect(cached.transmission).toEqual(exact.transmission);
        for (let i = 0; i < cached.pathRadiance.length; i++)
            expect(Math.abs(cached.pathRadiance[i] / exact.pathRadiance[i] - 1)).toBeLessThan(1e-7);
    }
});
