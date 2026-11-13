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
    refractedRadius,
    straightLineDensityFactor,
    rayShellSegmentsBrute,
    shellConstant,
    stableQuadraticRoots,
    sunBrightness,
    cloudNightLight,
    moonLightFactor,
    skyBrightnessForSunAngle,
    windDisplacement,
    windDisplacementAt,
    windDisplacementTable,
    windVelocityEN,
    WGS84_A,
    WGS84_B,
} from "../src/clouds/CloudMath";
import {Vector3} from "three";
import {
    liftCameraRelative,
    straightLineDensityFactor as sceneDensityFactor,
    TERRESTRIAL_REFRACTION_DEFAULTS,
} from "../src/atmosphere/terrestrialRefraction";

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

describe("cloud layers under terrestrial refraction", () => {
    test("the density factor is the scene's own", () => {
        for (const [hObs, hTarget] of [[0, 0], [2, 1500], [1000, 9000], [11000, 300], [0, 20000]]) {
            expect(straightLineDensityFactor(hObs, hTarget)).toBeCloseTo(sceneDensityFactor(hObs, hTarget), 12);
        }
    });

    test("no refraction leaves the sphere unchanged", () => {
        expect(refractedRadius(R, 0, 10, 1500)).toBe(R);
        expect(refractedRadius(R, -1, 10, 1500)).toBe(R);
    });

    test("a layer on the larger sphere sits where the scene's lift puts it", () => {
        // A real point at height H, range d is lifted by the scene (liftCameraRelative,
        // the CPU twin of the vertex chunk). On the layer's refracted sphere the lifted
        // point must be back at height H: within 2% of the lift out to 100 km, and 7%
        // at 250 km (the lift there is about 600 m; the scene's long-line sag is not modelled).
        const k = 0.13;
        for (const h0 of [2, 1000]) {
            for (const H of [0, 1500, 9000]) {
                for (const [d, share] of [[20000, 0.02], [100000, 0.02], [250000, 0.07]]) {
                    const context = {k, zenith: new Vector3(0, 0, 1), observer: new Vector3(), obsAlt: h0, R,
                        maxBendRad: TERRESTRIAL_REFRACTION_DEFAULTS.maxBendRad, scaleHeightM: 8500,
                        maxLiftM: TERRESTRIAL_REFRACTION_DEFAULTS.maxLiftM};
                    const angle = d / (R + H);
                    const point = new Vector3((R + H) * Math.sin(angle), 0, (R + H) * Math.cos(angle) - (R + h0));
                    const apparent = liftCameraRelative(context, point, new Vector3());
                    const lift = apparent.z - point.z;
                    expect(lift).toBeGreaterThan(0);
                    const radius = refractedRadius(R, k, h0, H);
                    const heightOnLayerSphere = Math.hypot(point.x, radius + h0 + apparent.z) - radius;
                    expect(Math.abs(heightOnLayerSphere - H)).toBeLessThan(share * lift + 1);
                }
            }
        }
    });
});

describe("cloud wind over time", () => {
    const knots = 1852 / 3600;

    test("a constant wind integrates to velocity x time, at whole and fractional frames", () => {
        const velocity = windVelocityEN(270, 60 * knots);
        const table = windDisplacementTable((frame, out) => Object.assign(out, velocity), 900, 30);
        for (const frame of [0, 1, 431.5, 899, 900, 1200, -10]) {
            const expected = windDisplacement(velocity, frame, 30);
            const got = windDisplacementAt(table, frame);
            expect(got.east).toBeCloseTo(expected.east, 9);
            expect(got.north).toBeCloseTo(expected.north, 9);
        }
        // The Phase 1 check: 60 kn from 270 for 899 frames at 30 fps (29.97 s) is 924.97 m east.
        expect(windDisplacementAt(table, 899).east).toBeCloseTo(924.97, 2);
    });

    test("a wind that changes at a frame bends the drift instead of moving the whole pattern", () => {
        const fps = 30;
        const before = {east: 10, north: 0}, after = {east: 0, north: 20};
        const table = windDisplacementTable((frame, out) => Object.assign(out, frame < 300 ? before : after), 900, fps);
        // Before the change: unchanged by what comes later.
        expect(windDisplacementAt(table, 300).east).toBeCloseTo(100, 9);
        expect(windDisplacementAt(table, 300).north).toBeCloseTo(0, 9);
        // After it: the old drift stays, the new one adds to it.
        const later = windDisplacementAt(table, 600);
        expect(later.east).toBeCloseTo(100, 9);
        expect(later.north).toBeCloseTo(200, 9);
        // Continuous across the change (velocity x current time would jump by 200 m).
        const step = windDisplacementAt(table, 301);
        expect(Math.hypot(step.east - 100, step.north)).toBeLessThan(1);
    });

    test("the table is reused when its size is unchanged", () => {
        const first = windDisplacementTable((frame, out) => Object.assign(out, {east: 1, north: 0}), 10, 30);
        const again = windDisplacementTable((frame, out) => Object.assign(out, {east: 2, north: 0}), 10, 30, first);
        expect(again).toBe(first);
        expect(windDisplacementAt(again, 10).east).toBeCloseTo(20 / 30, 12);
    });
});

describe("cloud night light", () => {
    test("sky brightness follows the scene's twilight curve", () => {
        expect(skyBrightnessForSunAngle(10)).toBe(1);
        expect(skyBrightnessForSunAngle(-20)).toBe(0);
        expect(skyBrightnessForSunAngle(-9)).toBeCloseTo(0.5, 9);
    });

    test("by day nothing changes; at night the airlight follows the moon", () => {
        const day = cloudNightLight(30, 0);
        expect(day.nightFactor).toBe(0);
        expect(day.airlightScale).toBeCloseTo(1, 12);
        const moonless = cloudNightLight(-30, 0);
        expect(moonless.nightFactor).toBe(1);
        expect(moonless.airlightScale).toBeCloseTo(0.12, 9);
        expect(moonless.ambientScale).toBeCloseTo(0.12, 9);
        expect(day.ambientScale).toBe(1);
        const fullMoon = cloudNightLight(-30, 1);
        expect(fullMoon.airlightScale).toBeCloseTo(1, 9);
        expect(fullMoon.ambientScale).toBeGreaterThan(moonless.ambientScale);
        expect(cloudNightLight(-8, 0).nightFactor).toBeGreaterThan(0);
        expect(cloudNightLight(-8, 0).nightFactor).toBeLessThan(1);
    });

    test("moon light: full and high is one, below the horizon is zero, a quarter moon is dimmer", () => {
        expect(moonLightFactor(-12.7, 45)).toBeCloseTo(1, 9);
        expect(moonLightFactor(-12.7, -5)).toBe(0);
        const quarter = moonLightFactor(-10.0, 45);
        expect(quarter).toBeGreaterThan(0.2);
        expect(quarter).toBeLessThan(0.4);
        expect(moonLightFactor(-12.7, 45, 0)).toBe(0);
    });
});
