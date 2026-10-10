// The statistical sea: slopes, Fresnel reflection, hiding, the horizon ramp, its scene boundary, an independent
// reference integral, and the quadrature doubling sweep.
import path from "node:path";
import {pathToFileURL} from "node:url";
import {execFileSync} from "node:child_process";
import {Mesh, PerspectiveCamera, Vector3} from "three";
import {createAtmosphere, clearSky, evaluatePhotonPath, blackbodyBands, skyViewGeometry, sampleSkyElevationLUT} from "../tools/thermal/atmosphere.js";
import {apparentTemperature} from "../tools/thermal/radiometry.js";
import {windSlopeCovariance, waveSpectrumMoments, roughSeaFacets, smithEscape, createStatisticalSea, createSeaSkyTable, seaSpectrum, seaRayAzimuth} from "../tools/thermal/atmosphere.js";
import {defaultSettings, normalizeSettings} from "../tools/thermal/thermalSchema.js";
import {EARTH_RADIUS_M, CHANNEL_WEIGHTS, seaReflectance} from "../tools/thermal/atmosphere.js";
import {ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";
import {createThermalSceneAdapter} from "../src/rendering/ThermalSceneAdapters";

jest.mock("../src/Globals", () => ({Globals: {equatorRadius: 6371000, polarRadius: 6371000}, Sit: {lat: 0, lon: 0}, NodeMan: {}}));
jest.setTimeout(120000);
const band = {minUm: 3, maxUm: 5}, sum = a => a.reduce((s, x) => s + x, 0);
const kelvin = L => apparentTemperature(L, {quantity: "photon", band});
const close = (a, b, tolerance = 1e-12) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tolerance);

test("grazing first-encounter Fresnel averages reproduce both wind directions", () => {
    const C = windSlopeCovariance(9.8, 4.1), cosine = Math.cos(89.99 * Math.PI / 180);
    close(C.wind12Mps, 10.900350, 1e-6);
    for (const [azimuth, expected] of [[0, .326189], [Math.PI / 2, .380718]]) {
        const coarse = roughSeaFacets(cosine, C, azimuth, {count: 241});
        const fine = roughSeaFacets(cosine, C, azimuth, {count: 481});
        close(fine.firstReflectance, expected, 1e-6); close(coarse.firstReflectance, fine.firstReflectance, .0001);
        close(roughSeaFacets(cosine, C, azimuth, {count: 32, quadrature: "gauss"}).firstReflectance, fine.firstReflectance, .0001);
        expect(fine.firstReflectance).toBeGreaterThanOrEqual(.326); expect(fine.firstReflectance).toBeLessThanOrEqual(.381);
        expect(fine.effectiveReflectance).toBeLessThan(fine.firstReflectance);
    }
    expect(smithEscape([1, 0, .01], C)).toBeLessThan(1); close(smithEscape([1, 0, -.01], C), 0);
});

test("spectral moments conserve height variance, covariance and wind/swell independence", () => {
    close(seaRayAzimuth([-1, 0, 0], [0, 0, 1], [0, 1, 0]), Math.PI / 2);
    close(seaRayAzimuth([0, -1, 0], [0, 0, 1], [0, 1, 0]), 0);
    const spectrum = waveSpectrumMoments([{varianceM2: (1.85 / 4) ** 2, kx: .1, ky: .05}, {varianceM2: (.95 / 4) ** 2, kx: -.02, ky: .03}]);
    close(spectrum.significantHeightM, Math.hypot(1.85, .95));
    expect(spectrum.covariance.xy).not.toBe(0);
    expect(() => waveSpectrumMoments([], {xx: 1, xy: 2, yy: 1})).toThrow();
    const s = defaultSettings(), a = seaSpectrum(s), b = seaSpectrum({...s, seaSwellHeightM: 1.85});
    expect(a.residual).toEqual(b.residual); expect(b.covariance.xx).toBeGreaterThan(a.covariance.xx);
});

test("statistical hiding preserves an isothermal enclosure instead of darkening it", () => {
    // Estimated enclosure fixture: optically thick isothermal air supplies B(T)
    // on every incident direction; a zero outgoing path exposes the sea source.
    const temperatureK = 290, settings = normalizeSettings({seaSkinTemperatureK: temperatureK});
    const atmosphere = createAtmosphere({densityScale: 1e6, temperatureProfile: [
        {altitudeM: 0, temperatureK}, {altitudeM: 100000, temperatureK}]});
    const sea = createStatisticalSea(settings, atmosphere);
    const expected = sum(blackbodyBands(temperatureK, {quantity: "photon", band}));
    for (const elevationRad of [-Math.PI / 2, -.001]) for (const azimuthRad of [0, Math.PI / 2]) {
        const value = sea.evaluate({sensorAltitudeM: 0, elevationRad, azimuthRad});
        close(value.photonRadiance / expected, 1, 1e-6);
    }
});

test("rough sea produces a physical horizon ramp without a fitted contrast control", () => {
    const settings = normalizeSettings({seaMode: "statistical", seaSkinTemperatureK: 290.34, surfaceTemperatureK: 290.24, sensorAltitudeM: 21});
    const atmosphere = createAtmosphere({surfaceTemperatureK: settings.surfaceTemperatureK});
    const sea = createStatisticalSea(settings, atmosphere);
    const refined = createStatisticalSea(settings, atmosphere, {count: 64, bins: 257});
    const near = sea.evaluate({sensorAltitudeM: 21, elevationRad: -.05}), far = sea.evaluate({sensorAltitudeM: 21, elevationRad: -.00257});
    const sky = clearSky({sensorAltitudeM: 21, elevationRad: -.00256}, atmosphere, {quantity: "photon", band, segments: 96});
    expect(kelvin(sum(near.radiance))).toBeLessThan(kelvin(sum(far.radiance)));
    expect(kelvin(sum(far.radiance))).toBeLessThan(kelvin(sum(sky.radiance)));
    for (const elevationRad of [-.05, -.00257]) for (const azimuthRad of [0, Math.PI / 2]) {
        const ray = {sensorAltitudeM: 21, elevationRad, azimuthRad};
        close(kelvin(sea.evaluate(ray).photonRadiance), kelvin(refined.evaluate(ray).photonRadiance), .005);
    }
    const view = skyViewGeometry({...settings, verticalFovDeg: .02, pathElevationDeg: -.15, detectorWidth: 4, detectorHeight: 4});
    const started = performance.now(), table = createSeaSkyTable(view, [1, 0, 0], settings, atmosphere, sea);
    expect(table.azimuthInterpolation.toleranceMet).toBe(true);
    const moved = skyViewGeometry({...settings, verticalFovDeg: .02, pathElevationDeg: -.14999, detectorWidth: 4, detectorHeight: 4});
    expect(createSeaSkyTable(moved, [1, 0, 0], settings, atmosphere, sea)).toBe(table);
    expect(table.interpolation.maxErrorK).toBeLessThan(.005);
    expect(table.quadrature.errorK).toBeNull(); // Numerical sweep is separate from a per-frame estimate.
    for (const row of table.rows) {
        const horizon = row.elevations.filter(e => e === row.horizonRad); expect(horizon).toHaveLength(2);
        expect(sampleSkyElevationLUT(row, row.horizonRad - 1e-7)).not.toBe(sampleSkyElevationLUT(row, row.horizonRad + 1e-7));
    }
    console.log(`Sea CPU table: ${(performance.now() - started).toFixed(1)} ms, ${table.rows.length} azimuth rows, ${table.width} elevation slots, ${table.data.byteLength} bytes; max azimuth error ${table.azimuthInterpolation.maxErrorK} K`);
});

test("ocean roots use the directional sea boundary, and registered land stays a thermal surface", () => {
    const camera = new PerspectiveCamera(1, 1, 1, 200000); camera.position.set(6372000, 0, 0); camera.updateMatrixWorld();
    const land = new Mesh(), sea = new Mesh();
    const adapter = createThermalSceneAdapter([], [land, sea], camera, {enabled: false});
    const settings = normalizeSettings({seaMode: "statistical"});
    expect(adapter.attributes(sea, settings)).toEqual({sea: true});
    expect(adapter.attributes(land, settings)).toEqual({temperatureK: settings.groundTemperatureK, emissivity: settings.groundEmissivity, terrainColor:true});
    expect(adapter.seaWind(settings).every(Number.isFinite)).toBe(true);
    const pipeline = new ThermalPipeline({}); pipeline.resources = {surfaces: new Map()};
    pipeline.skyView = {up: [0, 1, 0]}; pipeline.background = {scaledPhotonRadiance: 1};
    const pass = pipeline._surface({sea: true}, sea.material, settings);
    expect(pass.fragmentShader).toContain("vec3 ray=normalize(vViewPosition)");
    expect(pass.fragmentShader).not.toContain("vUv"); expect(pass.depthWrite).toBe(true);
    pass.dispose(); land.geometry.dispose(); land.material.dispose(); sea.geometry.dispose(); sea.material.dispose();
});

// Independent midpoint slope integration: project in the wind frame, integrate
// the one-dimensional Gaussian positive part for reflection escape, and only
// then normalize received photon radiance. No production facet/hiding helpers.
function independentSeaReference(settings, atmosphere, ray) {
    const wind = settings.seaWindMps * Math.log(12.5 / .0002) / Math.log(10 / .0002);
    const sxScale = Math.sqrt(.00316 * wind), syScale = Math.sqrt(.003 + .00192 * wind);
    const r = EARTH_RADIUS_M + ray.sensorAltitudeM, b = r * Math.sin(ray.elevationRad);
    const range = -b - Math.sqrt(b * b - ray.sensorAltitudeM * (2 * EARTH_RADIUS_M + ray.sensorAltitudeM));
    const path = evaluatePhotonPath({sensorAltitudeM: ray.sensorAltitudeM, targetAltitudeM: 0, slantRangeM: range}, atmosphere, {band, segments: 96});
    const c = -(b + range) / EARTH_RADIUS_M, st = Math.sqrt(1 - c * c);
    const view = [st * Math.cos(ray.azimuthRad), st * Math.sin(ray.azimuthRad), c];
    const B = blackbodyBands(settings.seaSkinTemperatureK, {quantity: 'photon', band});
    const emission = sum(B.map((value, b) => value * path.transmission[b]));
    const nc = CHANNEL_WEIGHTS.length, skies = [];
    for (let i = 0; i <= 1024; i++) {
        const sky = clearSky({sensorAltitudeM: 0, elevationRad: i / 1024 * Math.PI / 2}, atmosphere, {quantity: 'photon', band, segments: 96});
        skies.push(sum(sky.radianceChannels.map((L, ch) => L * path.transmissionChannels[ch] * CHANNEL_WEIGHTS[ch % nc])));
    }
    const escape = direction => {
        if (direction[2] <= 0) return 0;
        const sigma = Math.hypot(direction[0] * sxScale, direction[1] * syScale), a = direction[2] / sigma;
        if (a >= 8) return 1;
        const step = (a + 8) / 128; let positivePart = 0;
        for (let k = 0; k <= 128; k++) {
            const x = -8 + k * step;
            positivePart += (k === 0 || k === 128 ? 1 : k % 2 ? 4 : 2) * (a - x) * Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
        }
        return a / (positivePart * step / 3);
    };
    let total = 0, weight = 0;
    const count = 481;
    for (let ix = 0; ix < count; ix++) for (let iy = 0; iy < count; iy++) {
        const x = -6 + 12 * (ix + .5) / count, y = -6 + 12 * (iy + .5) / count;
        const sx = x * sxScale, sy = y * syScale, projected = view[2] - sx * view[0] - sy * view[1];
        if (projected <= 0) continue;
        const normal = new Vector3(-sx, -sy, 1).normalize(), mu = normal.dot(new Vector3(...view));
        const reflected = normal.multiplyScalar(2 * mu).sub(new Vector3(...view)).toArray();
        const R = seaReflectance(mu) * escape(reflected), w = projected * Math.exp(-(x * x + y * y) / 2);
        const index = Math.max(0, Math.asin(Math.max(-1, Math.min(1, reflected[2]))) / (Math.PI / 2) * 1024);
        const lo = Math.min(1023, Math.floor(index)), fraction = index - lo;
        const incident = skies[lo] * (1 - fraction) + skies[lo + 1] * fraction;
        total += w * ((1 - R) * emission + R * incident); weight += w;
    }
    return total / weight + sum(path.pathRadiance);
}

test('production visible normals and reflection escape match an independent nonisothermal integral', () => {
    const atmosphere = createAtmosphere(), settings = normalizeSettings({seaWindMps: 2, seaSkinTemperatureK: 293});
    const sea = createStatisticalSea(settings, atmosphere);
    expect(sea.environment).toBe('clearSkyThermalOnlyDiagnostic');
    for (const [elevationRad, azimuthRad, frozenK] of [[-.05, 0, 287.51498], [-.00257, 0, 287.36262], [-.08730412994347143, Math.PI / 2, 288.23889]]) {
        const ray = {sensorAltitudeM: 21, elevationRad, azimuthRad};
        const actual = kelvin(sea.evaluate(ray).photonRadiance);
        // Calculated fixed non-isothermal cases, rounded to 0.00001 K.
        close(actual, frozenK, .002);
        if (elevationRad === -.05) close(actual, kelvin(independentSeaReference(settings, atmosphere, ray)), .002);
    }
    const ray = {sensorAltitudeM: 21, elevationRad: -.08730412994347143, azimuthRad: Math.PI / 2};
    const doubled = createStatisticalSea(settings, atmosphere, {count: 192, bins: 1025});
    close(kelvin(sea.evaluate(ray).photonRadiance), kelvin(doubled.evaluate(ray).photonRadiance), .005);
});

// Run the numerical domain sweep in the same native module runtime as the tool.
// Estimated fixtures: U10 2–10 m/s, skin 288–297 K, 21/7620 m altitude,
// nadir through 89.99 degree incidence, and both wind axes plus the diagonal.
// The reported difference is quadrature uncertainty, not interpolation or
// uncertainty in the assumed atmosphere, water index or reflection closure.
const thermalModule = name => pathToFileURL(path.resolve(__dirname, "../tools/thermal", name)).href;
test('statistical sea resolution doubling across its declared numerical domain', () => {
    const report = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
        import {createAtmosphere, createStatisticalSea, createSeaSkyTable, skyViewGeometry, sampleSkyElevationLUT, EARTH_RADIUS_M} from '${thermalModule("atmosphere.js")}';
        import {normalizeSettings} from '${thermalModule("thermalSchema.js")}';
        import {apparentTemperature} from '${thermalModule("radiometry.js")}';
        const atmosphere = createAtmosphere();
        let maximumK = 0, worst, cases = 0;
        for (const seaWindMps of [2, 3, 5, 7, 10]) for (const seaSkinTemperatureK of [288, 293, 297]) {
            const settings = normalizeSettings({seaWindMps, seaSkinTemperatureK});
            const production = createStatisticalSea(settings, atmosphere);
            const doubled = createStatisticalSea(settings, atmosphere, {count: 192, bins: 1025});
            for (const sensorAltitudeM of [21, 7620]) for (const incidenceDeg of [0, 54, 64, 75, 85, 89.99]) for (const azimuthRad of [0, Math.PI / 4, Math.PI / 2]) {
                const elevationRad = -Math.acos(EARTH_RADIUS_M / (EARTH_RADIUS_M + sensorAltitudeM) * Math.sin(incidenceDeg * Math.PI / 180));
                const ray = {sensorAltitudeM, elevationRad, azimuthRad};
                const values = [production, doubled].map(sea => apparentTemperature(sea.evaluate(ray).photonRadiance, {quantity: 'photon'}));
                const errorK = Math.abs(values[0] - values[1]); cases++;
                if (errorK > maximumK) {maximumK = errorK; worst = {seaWindMps, seaSkinTemperatureK, sensorAltitudeM, incidenceDeg, azimuthRad, values};}
            }
        }
        const settings = normalizeSettings({sensorAltitudeM: 21, verticalFovDeg: .02, pathElevationDeg: -.15});
        const sea = createStatisticalSea(settings, atmosphere), view = skyViewGeometry(settings);
        const table = createSeaSkyTable(view, [1, 0, 0], settings, atmosphere, sea);
        const altitudeM = 21.01, moved = createSeaSkyTable(view, [1, 0, 0], {...settings, sensorAltitudeM: altitudeM}, atmosphere, sea);
        const elevationRad = -.0027, shift = -Math.acos(EARTH_RADIUS_M / (EARTH_RADIUS_M + altitudeM)) - table.horizonRad;
        const row = table.rows[(table.rows.length - 1) / 2];
        const actual = sea.evaluate({sensorAltitudeM: altitudeM, elevationRad, azimuthRad: table.axisAzimuth}).photonRadiance;
        const estimate = sampleSkyElevationLUT(row, elevationRad - shift);
        const altitudeReuseErrorK = Math.abs(apparentTemperature(actual, {quantity: 'photon'}) - apparentTemperature(estimate, {quantity: 'photon'}));
        const vacuum = createAtmosphere({densityScale: 0}), vacuumSea = createStatisticalSea(settings, vacuum);
        const vacuumTable = createSeaSkyTable(view, [1, 0, 0], settings, vacuum, vacuumSea);
        console.log(JSON.stringify({cases, maximumK, worst, altitudeDomainReused: table === moved, altitudeReuseErrorK,
            vacuumToleranceMet: vacuumTable.interpolation.toleranceMet,
            vacuumReused: createSeaSkyTable(view, [1, 0, 0], settings, vacuum, vacuumSea) === vacuumTable}));
    `], {encoding: 'utf8', timeout: 240000, maxBuffer: 1024 * 1024}));
    console.log('Calculated sea quadrature doubling:', report);
    expect(report.cases).toBe(540);
    expect(report.maximumK).toBeLessThan(.005);
    expect(report.altitudeDomainReused).toBe(true);
    expect(report.altitudeReuseErrorK).toBeLessThan(.005);
    expect(report.vacuumToleranceMet).toBe(true);
    expect(report.vacuumReused).toBe(true);
}, 250000);
