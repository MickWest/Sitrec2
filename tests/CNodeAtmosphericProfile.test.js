// Test the atmospheric profile interpolation logic standalone
// (without the full node system — just the interpolation functions)

import {CNodeAtmosphericProfile} from '../src/nodes/CNodeAtmosphericProfile';

// Mock a minimal CNode environment
jest.mock('../src/Globals', () => ({
    NodeMan: { add: jest.fn(), exists: () => false },
    Sit: { frames: 900, fps: 30 },
}));

// Create a profile with known data by directly setting levels
function makeProfile(levels) {
    // Minimal mock to bypass CNode constructor
    var p = Object.create(CNodeAtmosphericProfile.prototype);
    p.levels = levels.sort((a, b) => a.alt - b.alt);
    return p;
}

describe('CNodeAtmosphericProfile.getAtAltitude', () => {
    var profile = makeProfile([
        { alt: 0,     temp: 15,   pressure: 1013, rh: 80, windDir: 180, windSpeed: 5 },
        { alt: 5000,  temp: -18,  pressure: 540,  rh: 50, windDir: 270, windSpeed: 20 },
        { alt: 10000, temp: -50,  pressure: 265,  rh: 20, windDir: 300, windSpeed: 30 },
        { alt: 20000, temp: -60,  pressure: 55,   rh: 5,  windDir: 250, windSpeed: 15 },
        { alt: 30000, temp: -45,  pressure: 12,   rh: 2,  windDir: 200, windSpeed: 8 },
    ]);

    test('returns exact level data', () => {
        var d = profile.getAtAltitude(5000);
        expect(d.temp).toBeCloseTo(-18, 1);
        expect(d.pressure).toBeCloseTo(540, 0);
        expect(d.windSpeed).toBeCloseTo(20, 1);
    });

    test('interpolates between levels', () => {
        var d = profile.getAtAltitude(2500);
        // Midpoint between 0m (15°C) and 5000m (-18°C)
        expect(d.temp).toBeCloseTo(-1.5, 0);
        expect(d.pressure).toBeCloseTo(776.5, 0);
    });

    test('clamps below lowest level', () => {
        var d = profile.getAtAltitude(-100);
        expect(d.temp).toBeCloseTo(15, 1);
        expect(d.alt).toBe(0);
    });

    test('clamps above highest level', () => {
        var d = profile.getAtAltitude(35000);
        expect(d.temp).toBeCloseTo(-45, 1);
        expect(d.alt).toBe(30000);
    });

    test('returns null for empty profile', () => {
        var empty = makeProfile([]);
        expect(empty.getAtAltitude(5000)).toBeNull();
    });

    test('computeTopWindAlt returns highest level with valid wind (sonde drops wind before top)', () => {
        // pressure/temp continue above the last GPS-wind level (18000 m)
        var p = makeProfile([
            { alt: 0,     temp: 15,  pressure: 1013, rh: 80, windDir: 180, windSpeed: 5 },
            { alt: 12000, temp: -55, pressure: 190,  rh: 20, windDir: 270, windSpeed: 40 },
            { alt: 18000, temp: -60, pressure: 75,   rh: 5,  windDir: 250, windSpeed: 25 },
            { alt: 26000, temp: -50, pressure: 22,   rh: 2,  windDir: null, windSpeed: null },
            { alt: 31000, temp: -45, pressure: 10,   rh: 1,  windDir: null, windSpeed: null },
        ]);
        expect(p.computeTopWindAlt()).toBe(18000);
    });

    test('computeTopWindAlt is null when no level has wind', () => {
        var p = makeProfile([
            { alt: 0,    temp: 15, pressure: 1013, rh: 80, windDir: null, windSpeed: null },
            { alt: 5000, temp: -18, pressure: 540, rh: 50, windDir: null, windSpeed: null },
        ]);
        expect(p.computeTopWindAlt()).toBeNull();
    });

    test('interpolates wind direction across 360/0 boundary', () => {
        var p = makeProfile([
            { alt: 0,    temp: 0, pressure: 1000, rh: 0, windDir: 350, windSpeed: 10 },
            { alt: 1000, temp: 0, pressure: 900,  rh: 0, windDir: 10,  windSpeed: 10 },
        ]);
        var d = p.getAtAltitude(500);
        // Midpoint between 350° and 10° should be 0° (not 180°)
        expect(d.windDir).toBeCloseTo(0, 0);
    });
});

describe('CNodeAtmosphericProfile.getAtPressure', () => {
    var profile = makeProfile([
        { alt: 0,     temp: 15,  pressure: 1013, rh: 80, windDir: 180, windSpeed: 5 },
        { alt: 5000,  temp: -18, pressure: 540,  rh: 50, windDir: 270, windSpeed: 20 },
        { alt: 10000, temp: -50, pressure: 265,  rh: 20, windDir: 300, windSpeed: 30 },
    ]);

    test('returns interpolated data at 700 hPa', () => {
        var d = profile.getAtPressure(700);
        expect(d).not.toBeNull();
        expect(d.pressure).toBeCloseTo(700, 0);
        // 700 is between 1013 (0m) and 540 (5000m)
        expect(d.alt).toBeGreaterThan(0);
        expect(d.alt).toBeLessThan(5000);
    });

    test('returns null for pressure outside range', () => {
        var d = profile.getAtPressure(50);
        // 50 hPa is below 265 hPa (lowest in our data)
        expect(d).toBeNull();
    });
});

describe('CNodeAtmosphericProfile profile arrays', () => {
    var profile = makeProfile([
        { alt: 0,    temp: 15,  pressure: 1013, rh: null, windDir: 180, windSpeed: 5 },
        { alt: 5000, temp: -18, pressure: 540,  rh: null, windDir: 270, windSpeed: 20 },
        { alt: 10000, temp: null, pressure: 265, rh: null, windDir: null, windSpeed: null },
    ]);

    test('getTemperatureProfile excludes null temps', () => {
        var tp = profile.getTemperatureProfile();
        expect(tp.length).toBe(2);
        expect(tp[0]).toEqual({ alt: 0, temp: 15 });
    });

    test('getPressureProfile includes all with pressure', () => {
        var pp = profile.getPressureProfile();
        expect(pp.length).toBe(3);
    });

    test('getWindProfile excludes null wind', () => {
        var wp = profile.getWindProfile();
        expect(wp.length).toBe(2);
    });

    test('getAltitudeRange', () => {
        var r = profile.getAltitudeRange();
        expect(r.min).toBe(0);
        expect(r.max).toBe(10000);
    });
});
