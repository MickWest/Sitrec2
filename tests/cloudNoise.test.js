import {
    equalize,
    generateDetail,
    generateShapeSlices,
    generateWeather,
    makePermutation,
    makeWorleyPoints,
    perlin3,
    perlinFBM,
    shapeContext,
    worley3,
} from "../src/clouds/CloudNoise";

function hashBytes(bytes) {
    let hash = 2166136261;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return hash;
}

describe("cloud noise", () => {
    test("the same seed gives the same bytes, a different seed different bytes", () => {
        const first = generateShapeSlices(16, 0, 16, 1);
        const second = generateShapeSlices(16, 0, 16, 1);
        const other = generateShapeSlices(16, 0, 16, 2);
        expect(hashBytes(first)).toBe(hashBytes(second));
        expect(hashBytes(first)).not.toBe(hashBytes(other));
        expect(hashBytes(generateDetail(8, 1))).toBe(hashBytes(generateDetail(8, 1)));
        expect(hashBytes(generateWeather(8, 1))).toBe(hashBytes(generateWeather(8, 1)));
    });

    test("slabs assemble into the same texture as one run", () => {
        const context = shapeContext(1);
        const whole = generateShapeSlices(16, 0, 16, 1, context);
        const lower = generateShapeSlices(16, 0, 5, 1, context);
        const upper = generateShapeSlices(16, 5, 16, 1, context);
        const joined = new Uint8Array(whole.length);
        joined.set(lower, 0);
        joined.set(upper, lower.length);
        expect(hashBytes(joined)).toBe(hashBytes(whole));
    });

    test("noise tiles with period one", () => {
        const perm = makePermutation(1);
        for (const [x, y, z] of [[0.1, 0.2, 0.3], [0.9, 0.05, 0.5], [0.33, 0.77, 0.999]]) {
            expect(perlin3(perm, x * 4, y * 4, z * 4, 4)).toBeCloseTo(perlin3(perm, x * 4 + 4, y * 4 - 4, z * 4 + 8, 4), 10);
            expect(perlinFBM(perm, x, y, z, 4, 4)).toBeCloseTo(perlinFBM(perm, x + 1, y + 2, z - 1, 4, 4), 10);
            const points = makeWorleyPoints(8, 1);
            expect(worley3(points, 8, x, y, z)).toBeCloseTo(worley3(points, 8, x + 1, y - 1, z + 3), 10);
        }
    });

    test("noise is continuous across the tile edge", () => {
        const perm = makePermutation(3);
        const points = makeWorleyPoints(4, 3);
        const edge = 1 - 1e-6;
        expect(Math.abs(perlinFBM(perm, edge, 0.4, 0.6, 4, 4) - perlinFBM(perm, 0, 0.4, 0.6, 4, 4))).toBeLessThan(1e-3);
        expect(Math.abs(worley3(points, 4, edge, 0.4, 0.6) - worley3(points, 4, 0, 0.4, 0.6))).toBeLessThan(1e-3);
    });

    test("channels use the byte range", () => {
        const shape = generateShapeSlices(32, 0, 32, 1);
        for (let channel = 0; channel < 4; channel++) {
            let low = 255, high = 0;
            for (let index = channel; index < shape.length; index += 4) {
                low = Math.min(low, shape[index]);
                high = Math.max(high, shape[index]);
            }
            expect(high - low).toBeGreaterThan(120);
        }
    });

    test("weather channels are equalized to a uniform distribution", () => {
        const weather = generateWeather(16, 1);
        for (let channel = 0; channel < 4; channel++) {
            let below = 0, count = 0;
            for (let index = channel; index < weather.length; index += 4) {
                if (weather[index] < 64) below++;
                count++;
            }
            // About a quarter of the values in the lowest quarter of the range.
            expect(below / count).toBeGreaterThan(0.2);
            expect(below / count).toBeLessThan(0.3);
        }
        const flat = equalize(new Float32Array([5, 1, 3, 2, 4]));
        expect(Array.from(flat).map(value => Math.round(value * 10))).toEqual([9, 1, 5, 3, 7]);
    });
});
