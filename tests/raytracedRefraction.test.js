import {airIndex, anchorsToCurve, applyProfilePreset, atmosphere, buildRayTable, curveSampler, groundY,
    normalizeSettings, PROFILE_PRESETS, traceRay} from "../src/refraction/RefractionPhysics";
import {terrestrialBendAngle, terrestrialKFromAtmosphere} from "../src/atmosphere/terrestrialRefraction";

const radius = 6371000;

test.each(Object.keys(PROFILE_PRESETS))("%s preset replaces the previous temperature model and round-trips", name => {
    const s = normalizeSettings({temperature: 55, lapseRate: 85, humidity: 73, humidityProfile: true, wavelength: 633});
    const rh = s.humidityCurve.slice();
    applyProfilePreset(s, name);
    const medium = atmosphere(s), points = PROFILE_PRESETS[name];
    for (const [height, temp] of points) expect(medium.temperature(height)).toBeCloseTo(temp, 6);
    expect(medium.temperature(points.at(-1)[0] + 100)).toBeCloseTo(points.at(-1)[1] + s.lapseRate / 10, 6);
    expect(s.humidityCurve).toEqual(rh);
    expect([s.humidity, s.humidityProfile, s.wavelength]).toEqual([73, true, 633]);
    expect(normalizeSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
});

test("fan diagnostics distinguish ground termination from folds", () => {
    const settings = normalizeSettings({bend: false, maxDistance: 10000, distanceSamples: 64});
    const upward = buildRayTable({settings, height: 10, radius, minAngle: 0, maxAngle: .01, rows: 16}).diagnostics;
    expect(upward.groundHits).toBe(0);
    expect(upward.reachedSamples).toBe(upward.totalSamples);
    expect(upward.foldedPairs).toBe(0);
    expect(upward.kAtObserver).toBeCloseTo(0);
    const crossing = buildRayTable({settings, height: 2, radius, minAngle: -.01, maxAngle: .01, rows: 16}).diagnostics;
    expect(crossing.groundHits).toBeGreaterThan(0);
    expect(crossing.reachedSamples).toBeLessThan(crossing.totalSamples);
    expect(crossing.foldedPairs).toBe(0);
});

test("the ducting preset detects actual reversals in the surviving ray fan", () => {
    const settings = applyProfilePreset(normalizeSettings({maxDistance: 30000, distanceSamples: 128}), "Ducting inversion");
    const d = buildRayTable({settings, height: 2, radius, minAngle: -.001, maxAngle: .003, rows: 128}).diagnostics;
    expect(d.foldedPairs).toBeGreaterThan(0);
    expect(d.testedPairs).toBeGreaterThan(d.foldedPairs);
    expect(d.kAt1m).toBeGreaterThan(0);
});

describe("ray-traced refraction agrees with the analytic terrestrial model", () => {
    // Ciddor's refractive-index gradient and the surveying approximation are
    // independent derivations. Compare where constant-k refraction applies;
    // its nonnegative clamp deliberately excludes upward-bending mirages.
    test.each([-6.5, -9.8, -13.7, 0, 20, 50])("local k at lapse %p K/km", lapseRate => {
        const medium = atmosphere(normalizeSettings({temperature: 15, pressure: 1013.25, humidity: 50, lapseRate}));
        const tracedK = -radius * medium.gradient(1);
        const analyticK = terrestrialKFromAtmosphere(1013.25, 15, lapseRate);
        expect(Math.abs(tracedK - analyticK)).toBeLessThan(0.02 * Math.max(analyticK, 0.1));
    });

    test("finite-distance bending agrees with the analytic model over 5–50 km", () => {
        const medium = atmosphere(normalizeSettings({temperature: 15, pressure: 1013.25, humidity: 50, lapseRate: -6.5}));
        const distances = Float64Array.of(0, 5000, 20000, 50000);
        const height = 10;
        const ray = traceRay({height, angle: 0, distances, radius, medium});
        const k = terrestrialKFromAtmosphere(1013.25, 15, -6.5);
        for (let i = 1; i < distances.length; i++) {
            const distance = distances[i];
            // The launch is horizontal; its endpoint is depressed below that
            // tangent. A target there consequently appears elevated by this angle.
            const traced = -Math.atan2(ray[i * 3] - height, distance);
            const analytic = terrestrialBendAngle(distance, k, radius, 0);
            expect(Math.abs(traced / analytic - 1)).toBeLessThan(0.02);
            expect(ray[i * 3 + 2]).toBe(1); // the ray remains above the surface
            if (distance === 20000) {
                expect(traced * 180 * 60 / Math.PI).toBeGreaterThan(0.85);
                expect(traced * 180 * 60 / Math.PI).toBeLessThan(0.95);
            }
        }
    });
});

test("Ciddor matches the original simulator's standard reference and dispersion", () => {
    expect(airIndex(633, 20, 1013.25, 50)).toBeCloseTo(1.000271373, 9);
    expect(airIndex(550, 15, 0, 0)).toBe(1);
    expect(airIndex(450, 15, 1013.25, 50)).toBeGreaterThan(airIndex(650, 15, 1013.25, 50));
    expect(airIndex(550, 15, 1013.25, 0)).toBeGreaterThan(airIndex(550, 15, 1013.25, 100));
});

test("the worker samples the same anchor/handle convention as Sitrec's curve editor", () => {
    const curve = [0, 10, 2, 12, 6, 20, 4, 18, 12, 10, 10, 12];
    const sample = curveSampler(curve, -0.0065);
    expect(sample(0)).toBe(10);
    expect(sample(3)).toBeCloseTo(15, 7);
    expect(sample(6)).toBeCloseTo(20, 7);
    expect(sample(12)).toBeCloseTo(10, 7);
    expect(sample(1012)).toBeCloseTo(3.5, 7);
    expect(sample(-10)).toBe(10);
});

test("vacuum rays are straight and a zero-distance table column has no offset", () => {
    const settings = normalizeSettings({bend: false, maxDistance: 10000, distanceSamples: 64});
    const result = buildRayTable({settings, height: 100, radius, minAngle: 0, maxAngle: 0.01, rows: 4});
    for (let row = 0; row < result.rows; row++) for (let col = 0; col < result.width; col++) {
        const k = (row * result.width + col) * 4;
        expect(result.data[k]).toBeCloseTo(0, 10);
        expect(result.data[k + 2]).toBe(settings.maxDistance);
    }
});

test("constant logarithmic gradient agrees with the exact flat-atmosphere ray", () => {
    // y'' = g(1+y'^2), y(0)=100, y'(0)=0 => y=100-log(cos(g*x))/g.
    const g = -3e-8, distances = Float64Array.of(0, 1000, 5000, 20000);
    const ray = traceRay({height: 100, angle: 0, distances, radius: Infinity, medium: {gradient: () => g}, step: 100});
    for (let i = 0; i < distances.length; i++) {
        expect(ray[3 * i]).toBeCloseTo(100 - Math.log(Math.cos(g * distances[i])) / g, 6);
    }
});

test("ground intersections terminate a ray, with no non-finite LUT entries", () => {
    const settings = normalizeSettings({maxDistance: 10000, distanceSamples: 64});
    const table = buildRayTable({settings, height: 2, radius, minAngle: -0.01, maxAngle: 0.01, rows: 16});
    expect(Array.from(table.data).every(Number.isFinite)).toBe(true);
    expect(table.data[(table.width - 1) * 4 + 2]).toBeLessThan(1000);
    expect(table.data[(table.rows * table.width - 1) * 4 + 2]).toBe(settings.maxDistance);
    expect(groundY(10000, radius)).toBeCloseTo(-7.848066, 5);
});

test("standard atmosphere bends downward; a warm surface produces upward bending", () => {
    const standard = atmosphere(normalizeSettings());
    const mirage = atmosphere(normalizeSettings({useStandard: false,
        temperatureCurve: anchorsToCurve(PROFILE_PRESETS["Inferior mirage"])}));
    expect(standard.gradient(1)).toBeLessThan(0);
    expect(mirage.gradient(0.2)).toBeGreaterThan(0);
});

test("ray integration converges through a thin inversion", () => {
    const s = normalizeSettings({useStandard: false, temperatureCurve: anchorsToCurve(PROFILE_PRESETS["Superior mirage"])});
    const medium = atmosphere(s), distances = Float64Array.of(0, 1000, 5000, 10000);
    const args = {height: 8, angle: 0.0001, distances, radius, medium};
    const coarse = traceRay({...args, step: 40}), fine = traceRay({...args, step: 10});
    for (let i = 0; i < distances.length; i++) expect(Math.abs(coarse[i * 3] - fine[i * 3])).toBeLessThan(0.01);
});

test("laser reverse direction, aperture and divergence are traced independently", () => {
    const s = normalizeSettings({bend: false, flat: true, maxDistance: 1000, distanceSamples: 64,
        lasersEnabled: true, lasers: [{height: 20, distance: 1000, reverse: true, divergence: 2, diameter: 10}]});
    const r = buildRayTable({settings: s, height: 20, radius, minAngle: 0, maxAngle: 0.01, rows: 2});
    const l = r.lasers[0], end = (l.distances.length - 1) * 3;
    expect(l.center[end]).toBeCloseTo(20, 9);
    expect(l.upper[end] - l.lower[end]).toBeCloseTo(2.01, 5);
});

test("settings survive JSON round-trip, reject malformed profiles and bound work", () => {
    const s = normalizeSettings({maxDistance: Infinity, distanceSamples: 1e8, step: -10,
        temperatureCurve: [0, NaN, 0, 0], humidityPoints: [[0, 1000], [0, 0]]});
    expect(s.maxDistance).toBe(50000);
    expect(s.distanceSamples).toBe(2048);
    expect(s.step).toBe(2);
    expect(s.temperatureCurve.every(Number.isFinite)).toBe(true);
    expect(normalizeSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
});
