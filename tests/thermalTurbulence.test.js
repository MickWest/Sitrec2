// Turbulence along a spherical path: the Hufnagel–Valley profile, Fried r0 and the isoplanatic angle.
import * as A from "../tools/thermal/atmosphere.js";
import {integrateTurbulence, hufnagelValley, scaleR0} from "../tools/thermal/turbulence.js";

const close = (actual, expected, tolerance) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);

test("HV spherical integration reproduces the 125 km reference r0 and wavelength scaling", () => {
    // Estimated reconstructed IB6830 frame-11000 endpoints, in m. Published HV21
    // transferred to this geometry gives calculated r0=.5723 m at 4 um.
    const geometry = {sensorAltitudeM: 1382, targetAltitudeM: 7479.8611315789485, slantRangeM: 124979.14348796658};
    const result = integrateTurbulence(geometry);
    close(result.r0M, 0.5723, 0.0001);
    close(result.planeR0M, 0.4275, 0.0001);
    close(result.sphericalIntegral / 2.4285e-12, 1, 0.0001);
    expect(result.isoplanaticAngleRad).toBeGreaterThan(2e-6);
    expect(result.isoplanaticAngleRad).toBeLessThan(4e-6);
    expect(result.sampleCount).toBe(20001);
    const blue = integrateTurbulence(geometry, {wavelengthM: 3e-6});
    close(blue.r0M / result.r0M, (3 / 4) ** (6 / 5), 1e-12);
    close(blue.r0ReferenceM, result.r0M, 1e-12);
    close(scaleR0(result.r0M, 5e-6) / result.r0M, (5 / 4) ** (6 / 5), 1e-12);
    expect(hufnagelValley(2000, {windSpeedMS: 40})).toBeGreaterThan(hufnagelValley(2000));
    close(hufnagelValley(2000, {multiplier: 0.1}) / hufnagelValley(2000), 0.1, 1e-15);
    console.log(`HV21 finite-source reference: r0=${result.r0M.toFixed(6)} m at 4 um; theta0=${(result.isoplanaticAngleRad * 1e6).toFixed(6)} urad`);
});

test("uniform Cn² has the analytic finite-distance 3/8 weighting and isoplanatic angle", () => {
    const cn2 = 4e-17, length = 100000, wavelengthM = 4e-6;
    const result = integrateTurbulence({sensorAltitudeM: 2000, targetAltitudeM: 2000, slantRangeM: length}, {cn2: () => cn2});
    close(result.sphericalIntegral / (cn2 * length), 3 / 8, 1e-8);
    const expected = (2.91 * (2 * Math.PI / wavelengthM) ** 2 * cn2 * (3 / 8) * length ** (8 / 3)) ** (-3 / 5);
    close(result.isoplanaticAngleRad / expected, 1, 1e-8);
    expect(integrateTurbulence({sensorAltitudeM: 1000, targetAltitudeM: 1000, slantRangeM: 0}).r0M).toBe(Infinity);
    expect(() => integrateTurbulence({sensorAltitudeM: 1000, targetAltitudeM: 1000, slantRangeM: 1e6})).toThrow(/surface/);
});

test("accepted sea-level endpoints never pass negative roundoff heights to turbulence", () => {
    let negative = 0;
    for (const sensorAltitudeM of [10, 100, 1382]) for (let i = 1; i < 20; i++) {
        const slantRangeM = Math.sqrt(2 * A.EARTH_RADIUS_M * sensorAltitudeM) * i / 21;
        const geometry = {sensorAltitudeM, targetAltitudeM: 0, slantRangeM};
        if (A.solvePath(geometry).altitudeAt(slantRangeM) < 0) negative++;
        expect(Number.isFinite(integrateTurbulence(geometry, {segments: 100}).r0M)).toBe(true);
        integrateTurbulence(geometry, {segments: 10, cn2: h => { expect(h).toBeGreaterThanOrEqual(0); return 1e-15; }});
    }
    expect(negative).toBeGreaterThan(0);
    expect(() => integrateTurbulence({sensorAltitudeM: 10, elevationRad: -.1, slantRangeM: 10000})).toThrow(/surface/);
});
