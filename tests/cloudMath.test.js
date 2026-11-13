import {
    dualLobePhase,
    enuBasis,
    gaussianRadius,
    heightAlongRay,
    heightAlongRayDirect,
    henyeyGreenstein,
    horizonDip,
    llaToECEF,
    localFrameAt,
    positiveModulo,
    rayShellSegments,
    rayShellSegmentsBrute,
    shellConstant,
    stableQuadraticRoots,
    sunBrightness,
    windDisplacement,
    windVelocityEN,
    WGS84_A,
    WGS84_B,
} from "../src/clouds/CloudMath";

const R = 6371000;

describe("cloud shell intersection", () => {
    test("stable roots match the textbook roots where both are accurate", () => {
        for (const [b, c] of [[3, 2], [-3, 2], [0.5, -6], [-1e6, -2e9]]) {
            const roots = stableQuadraticRoots(b, c);
            const d = Math.sqrt(b * b - c);
            expect(roots[0]).toBeCloseTo(-b - d, 6);
            expect(roots[1]).toBeCloseTo(-b + d, 6);
        }
        expect(stableQuadraticRoots(1, 5)).toBeNull();
    });

    test("stable roots keep the small root that the textbook form loses", () => {
        // A camera 1 m below a shell, ray straight up: the root is 1 m, not cancelled noise.
        const h0 = 1000, H = 1001;
        const roots = stableQuadraticRoots((R + h0) * 1, shellConstant(h0, R, H));
        expect(roots[1]).toBeCloseTo(1, 6);
    });

    test("shell segments agree with a brute-force march", () => {
        const cameraAltitudes = [0, 1000, 11000, 400000];
        const layers = [[0, 400], [1500, 3000], [6000, 6500], [9000, 12000]];
        // Elevation angles including grazing rays near each horizon.
        const elevations = [90, 45, 10, 2, 0.5, 0, -0.2, -1, -3, -10, -45, -90];
        for (const h0 of cameraAltitudes) {
            for (const [H0, H1] of layers) {
                const cBase = shellConstant(h0, R, H0), cTop = shellConstant(h0, R, H1);
                for (const elevation of elevations) {
                    const mu = Math.sin(elevation * Math.PI / 180);
                    const b = (R + h0) * mu;
                    const tMax = 3000000;
                    const fast = rayShellSegments(b, cBase, cTop, tMax);
                    // A camera exactly on a boundary gives the brute force a zero-length start.
                    const brute = rayShellSegmentsBrute(R, h0, mu, H0, H1, tMax, 300000)
                        .filter(([start, end]) => end - start > 2 * tMax / 300000);
                    expect(fast.length).toBe(brute.length);
                    const tolerance = tMax / 300000 + 1;
                    for (let index = 0; index < fast.length; index++) {
                        expect(Math.abs(fast[index][0] - brute[index][0])).toBeLessThan(tolerance);
                        expect(Math.abs(fast[index][1] - brute[index][1])).toBeLessThan(tolerance);
                    }
                }
            }
        }
    });

    test("rationalized height is within a millimeter of the direct formula", () => {
        for (const h0 of [0, 1000, 11000, 400000]) {
            for (const mu of [-1, -0.3, -0.01, 0, 0.01, 0.5, 1]) {
                for (const t of [0, 1, 100, 5000, 80000, 400000]) {
                    const r0 = R + h0;
                    const direct = heightAlongRayDirect(R, h0, mu, t);
                    const rational = heightAlongRay(R, h0 * (2 * R + h0), r0 * mu, t);
                    expect(Math.abs(direct - rational)).toBeLessThan(1e-3);
                }
            }
        }
    });

    test("the rationalized height survives float32 where the direct one does not", () => {
        const f = Math.fround;
        const h0 = 1500, mu = 0.002, t = 3000;
        const r0 = R + h0;
        const exact = heightAlongRayDirect(R, h0, mu, t);
        const numerator = f(f(f(h0 * (2 * R + h0)) + f(2 * f(r0 * mu) * t)) + f(t * t));
        const rational = f(numerator / f(f(Math.sqrt(f(f(R * R) + numerator))) + R));
        const direct = f(f(Math.sqrt(f(f(f(r0 * r0) + f(2 * r0 * mu * t)) + f(t * t)))) - R);
        expect(Math.abs(rational - exact)).toBeLessThan(0.01);
        expect(Math.abs(direct - exact)).toBeGreaterThan(Math.abs(rational - exact));
    });
});

describe("cloud frames and units", () => {
    test("local frame matches the ellipsoid height and geodetic up", () => {
        for (const [lat, lon, alt] of [[0, 0, 0], [34, -118.3, 1500], [-60, 45, 11000], [89, 10, 400000]]) {
            const p = llaToECEF(lat, lon, alt);
            const frame = localFrameAt(p[0], p[1], p[2]);
            const enu = enuBasis(lat, lon);
            // Geocentric-radial height differs from the normal height only at second order.
            expect(Math.abs(frame.h0 - alt)).toBeLessThan(alt > 100000 ? 50 : 2);
            for (let axis = 0; axis < 3; axis++) expect(frame.up[axis]).toBeCloseTo(enu.up[axis], 4);
            expect(Math.abs(frame.R - gaussianRadius(Math.sin(lat * Math.PI / 180)))).toBeLessThan(1);
        }
        expect(gaussianRadius(0, WGS84_A, WGS84_A)).toBe(WGS84_A);
        expect(gaussianRadius(1)).toBeGreaterThan(gaussianRadius(0));
        expect(WGS84_B).toBeLessThan(WGS84_A);
    });

    test("ENU basis is orthonormal and right handed", () => {
        const {east, north, up} = enuBasis(34, -118);
        const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
        expect(dot(east, north)).toBeCloseTo(0, 12);
        expect(dot(east, up)).toBeCloseTo(0, 12);
        expect(dot(north, up)).toBeCloseTo(0, 12);
        const cross = [east[1] * north[2] - east[2] * north[1], east[2] * north[0] - east[0] * north[2], east[0] * north[1] - east[1] * north[0]];
        for (let axis = 0; axis < 3; axis++) expect(cross[axis]).toBeCloseTo(up[axis], 12);
    });

    test("wind is named by where it comes from", () => {
        const west = windVelocityEN(270, 10);
        expect(west.east).toBeCloseTo(10, 9);
        expect(west.north).toBeCloseTo(0, 9);
        const north = windVelocityEN(0, 10);
        expect(north.north).toBeCloseTo(-10, 9);
        const moved = windDisplacement(west, 900, 30);
        expect(moved.east).toBeCloseTo(300, 9);
        expect(windDisplacement(west, 0, 30).east).toBe(0);
    });

    test("positive modulo", () => {
        expect(positiveModulo(5, 4)).toBe(1);
        expect(positiveModulo(-1, 4)).toBe(3);
        expect(positiveModulo(-6378137.25, 1000)).toBeCloseTo(862.75, 6);
    });
});

describe("cloud lighting helpers", () => {
    test("sun brightness matches the scene's sunlight curve", () => {
        expect(sunBrightness(45)).toBe(1);
        expect(sunBrightness(0)).toBeCloseTo(0.25, 9);
        expect(sunBrightness(-1)).toBe(0);
        expect(sunBrightness(5)).toBeGreaterThan(0.25);
        expect(sunBrightness(5)).toBeLessThan(1);
    });

    test("horizon dip grows with height", () => {
        expect(horizonDip(0, R)).toBe(0);
        expect(horizonDip(10000, R) * 180 / Math.PI).toBeCloseTo(3.2, 1);
    });

    test("phase functions integrate to one", () => {
        for (const phase of [cosTheta => henyeyGreenstein(cosTheta, 0.8), cosTheta => dualLobePhase(cosTheta)]) {
            let integral = 0;
            const steps = 200000;
            for (let index = 0; index < steps; index++) {
                const cosTheta = -1 + 2 * (index + 0.5) / steps;
                integral += phase(cosTheta) * 2 * Math.PI * (2 / steps);
            }
            expect(integral).toBeCloseTo(1, 3);
        }
        expect(dualLobePhase(1)).toBeGreaterThan(dualLobePhase(-1));
    });
});
