import {airIndex, anchorsToCurve, atmosphere, buildRayTable, curveSampler, groundY,
    normalizeSettings, PROFILE_PRESETS, traceRay} from "../src/refraction/RefractionPhysics";

const radius = 6371000;

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
