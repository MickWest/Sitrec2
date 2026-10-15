import {
    SATELLITE_PHOTOMETRY, STARLINK_PROFILES, fluxToMagnitude, lambertPhaseFunction,
    magnitudeToFlux, satelliteFlux, satelliteMagnitude, starlinkFlareMagnitude,
} from "../tools/shf/satellitePhotometry.js";

const reference = {rangeM: 1e6, phaseAngleRad: Math.PI / 2, glintAngleDeg: 3, starlink: true, profile: "v1.5"};

describe("continuous satellite photometry", () => {
    test.each([
        ["v1.0", 2, 0.34], ["v1.0", 8, 3.22],
        ["visor", 2, -0.97], ["visor", 8, 4.16],
        ["v1.5", 2, -0.35], ["v1.5", 8, 3.27],
        ["mini", 2, -0.72], ["mini", 8, 2.65],
    ])("agrees with independent Figure 3 readings: %s at %s degrees", (profile, angle, expected) => {
        // Reading precision is deliberately lower than digitization precision.
        expect(Math.abs(starlinkFlareMagnitude(angle, profile) - expected)).toBeLessThan(0.06);
    });

    test("removes the flat bright core and retains measured wings beyond five degrees", () => {
        expect(starlinkFlareMagnitude(3, "v1.5")).toBeCloseTo(0.71, 1);
        expect(starlinkFlareMagnitude(3.75, "v1.5")).toBeGreaterThan(starlinkFlareMagnitude(2, "v1.5") + 1);
        expect(starlinkFlareMagnitude(8, "v1.5")).toBeLessThan(4);
        expect(satelliteFlux({...reference, glintAngleDeg: 8})).toBeGreaterThan(0);
    });

    test("distance follows the inverse-square flux law, including extreme flares", () => {
        const flux = satelliteFlux(reference);
        expect(satelliteFlux({...reference, rangeM: 2e6}) / flux).toBeCloseTo(0.25, 12);
        expect(satelliteMagnitude({...reference, rangeM: 2e6}) - satelliteMagnitude(reference))
            .toBeCloseTo(5 * Math.log10(2), 12);
        expect(satelliteMagnitude({...reference, glintAngleDeg: 0})).toBeCloseTo(-5, 2);
        expect(Number.isFinite(satelliteMagnitude({...reference, glintAngleDeg: 0}))).toBe(true);
    });

    test.each([0, 3.75, 5, 20, 60])("is continuous with a continuous slope near %s degrees", (angle) => {
        const h = 1e-4;
        const flux = g => satelliteFlux({...reference, glintAngleDeg: Math.abs(g)});
        const center = flux(angle), left = flux(angle - h), right = flux(angle + h);
        expect(Math.abs(right - left) / center).toBeLessThan(0.001);
        const leftSlope = (center - left) / h, rightSlope = (right - center) / h;
        expect(Math.abs(leftSlope - rightSlope) / center).toBeLessThan(0.001);
    });

    test("unknown design stays an explicit equal-weight flux mixture", () => {
        const names = Object.keys(STARLINK_PROFILES).filter(name => name !== "unknown");
        const expected = names.reduce((sum, name) => sum + magnitudeToFlux(starlinkFlareMagnitude(4, name)), 0) / names.length;
        expect(magnitudeToFlux(starlinkFlareMagnitude(4))).toBeCloseTo(expected, 12);
        expect(starlinkFlareMagnitude(4, "unidentified-new-design")).toBe(starlinkFlareMagnitude(4, "unknown"));
        expect(SATELLITE_PHOTOMETRY.unknownProfile).toMatch(/not a population estimate/);
    });

    test("ordinary Starlinks remain visible outside the horizon lobe with phase-dependent flux", () => {
        expect(lambertPhaseFunction(0)).toBe(1);
        expect(lambertPhaseFunction(Math.PI / 2)).toBeCloseTo(1 / Math.PI, 12);
        expect(lambertPhaseFunction(Math.PI)).toBe(0);
        const ordinary = {...reference, glintAngleDeg: 90};
        expect(satelliteMagnitude(ordinary)).toBeCloseTo(7.501719, 10);
        expect(satelliteFlux({...ordinary, phaseAngleRad: 0}) / satelliteFlux(ordinary)).toBeCloseTo(Math.PI, 12);
    });

    test("generic objects use declared area/albedo assumptions, not Starlink flare geometry", () => {
        const generic = {...reference, starlink: false};
        expect(satelliteMagnitude(generic)).toBeCloseTo(7.933, 2);
        expect(satelliteFlux({...generic, glintAngleDeg: 0})).toBe(satelliteFlux({...generic, glintAngleDeg: 90}));
        expect(satelliteFlux({...generic, diffuseAreaM2: 10}) / satelliteFlux(generic)).toBeCloseTo(10, 12);
        expect(satelliteFlux({...generic, diffuseAlbedo: 0.1}) / satelliteFlux(generic)).toBeCloseTo(0.5, 12);
        expect(satelliteMagnitude({...generic, diffuseMagnitudeAt90Deg: 3})).toBeCloseTo(3, 12);
    });

    test("illumination scales flux once and dark or invalid orbits cannot poison an exposure", () => {
        expect(satelliteFlux({...reference, illumination: 0.2}) / satelliteFlux(reference)).toBeCloseTo(0.2, 12);
        expect(satelliteFlux({...reference, illumination: 0})).toBe(0);
        expect(satelliteMagnitude({...reference, illumination: 0})).toBe(Infinity);
        for (const rangeM of [0, -1, NaN, Infinity]) expect(satelliteFlux({...reference, rangeM})).toBe(0);
        expect(satelliteFlux({...reference, phaseAngleRad: NaN})).toBe(0);
        expect(satelliteFlux({...reference, illumination: NaN})).toBe(0);
        expect(satelliteFlux({...reference, glintAngleDeg: NaN})).toBeGreaterThan(0); // diffuse remains
        expect(fluxToMagnitude(0)).toBe(Infinity);
    });
});
