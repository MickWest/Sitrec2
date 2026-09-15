import {airDataFromTAS, KNOT_MPS, pitotImpactPressureRatio, standardAtmosphere} from "../src/AirData";

test('standard atmosphere uses geometric height and the isothermal layer', () => {
    expect(standardAtmosphere(0)).toEqual({pressurePa: 101325, temperatureK: 288.15});
    // Standard-atmosphere table at 11 and 20 km geopotential height.
    const geometric = h => 6356766 * h / (6356766 - h);
    expect(standardAtmosphere(geometric(11000)).pressurePa).toBeCloseTo(22632.04, 1);
    expect(standardAtmosphere(geometric(20000)).pressurePa).toBeCloseTo(5474.877, 1);
    expect(standardAtmosphere(geometric(20000)).temperatureK).toBeCloseTo(216.65, 8);
    expect(standardAtmosphere(25000)).toBeNull();
    expect(standardAtmosphere(null)).toBeNull();
});

test('CAS equals TAS at standard sea level, including the supersonic branch', () => {
    for (const knots of [0, 1, 253, 600, 900, 1300]) {
        expect(airDataFromTAS(knots * KNOT_MPS, 101325, 288.15).casKnots).toBeCloseTo(knots, 8);
    }
});

test('25,000 ft air data includes compressibility instead of reporting EAS', () => {
    const data = airDataFromTAS(369 * KNOT_MPS, 37600.89, 238.62);
    expect(data.mach).toBeCloseTo(0.613, 2);
    expect(data.casKnots).toBeCloseTo(254.0668723, 5);
    const eas = 369 * Math.sqrt((37600.89 / 238.62) / (101325 / 288.15));
    expect(data.casKnots - eas).toBeGreaterThan(5);
});

test('Mach 2 pitot includes normal-shock total pressure loss and is continuous at Mach 1', () => {
    expect(pitotImpactPressureRatio(2)).toBeCloseTo(4.64044, 5);
    expect(pitotImpactPressureRatio(1 - 1e-8)).toBeCloseTo(pitotImpactPressureRatio(1 + 1e-8), 6);
});

test('temperature changes Mach and CAS; missing inputs do not invent zero airspeed', () => {
    const cold = airDataFromTAS(180, 38000, 230), warm = airDataFromTAS(180, 38000, 250);
    expect(cold.mach).toBeGreaterThan(warm.mach);
    expect(cold.casKnots).toBeGreaterThan(warm.casKnots);
    expect(airDataFromTAS(null, 38000, 240)).toEqual({mach: null, casKnots: null});
    expect(airDataFromTAS(180, null, 240).casKnots).toBeNull();
    expect(airDataFromTAS(180, 38000, null).mach).toBeNull();
});
