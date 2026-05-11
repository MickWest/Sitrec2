import {Vector3} from 'three';
import {
    refractionDeltaDeg,
    applyRefractionECI,
    applyRefractionFromObserver,
    zenithECEFFromLatLon,
    zenithECIFromLatLonGMST,
    REFRACTION_DEFAULTS,
} from '../src/atmosphere/refraction';

// Stellarium-style Saemundsson reference values at standard atmosphere
// (P = 1010 hPa, T = 10 °C). Values were generated from the same formula
// the implementation uses; the purpose is to lock the implementation against
// regressions and document expected magnitudes.
describe('refractionDeltaDeg (Saemundsson + Stellarium horizon taper)', () => {
    const tol = 1e-3; // degrees

    test('zenith → 0 correction', () => {
        expect(refractionDeltaDeg(90)).toBeCloseTo(0, 3);
    });

    test('30° altitude → ~0.0292° (≈1.75 arcmin)', () => {
        expect(refractionDeltaDeg(30)).toBeCloseTo(0.0292, 3);
    });

    test('10° altitude → ~0.0902°', () => {
        expect(refractionDeltaDeg(10)).toBeCloseTo(0.0902, 3);
    });

    test('5° altitude → ~0.165°', () => {
        expect(refractionDeltaDeg(5)).toBeCloseTo(0.165, 2);
    });

    test('horizon → ~0.479° (about half a Sun/Moon diameter)', () => {
        expect(refractionDeltaDeg(0)).toBeCloseTo(0.479, 2);
    });

    test('above horizon stays larger than below', () => {
        expect(refractionDeltaDeg(0)).toBeGreaterThan(refractionDeltaDeg(1));
    });

    test('at -3.54° still > 0 (formula edge)', () => {
        expect(refractionDeltaDeg(-3.54)).toBeGreaterThan(0);
    });

    test('linear taper through -4° is between 0 and the -3.54° value', () => {
        const at354 = refractionDeltaDeg(-3.54);
        const at4 = refractionDeltaDeg(-4);
        expect(at4).toBeLessThan(at354);
        expect(at4).toBeGreaterThan(0);
    });

    test('below -5° clamps to zero', () => {
        expect(refractionDeltaDeg(-5)).toBeCloseTo(0, 6);
        expect(refractionDeltaDeg(-10)).toBe(0);
        expect(refractionDeltaDeg(-90)).toBe(0);
    });

    test('negative pressure is clamped to zero', () => {
        expect(refractionDeltaDeg(0, {pressureHPa: -100})).toBe(0);
    });

    test('temperature below absolute zero is clamped', () => {
        expect(Number.isFinite(refractionDeltaDeg(0, {tempC: -300}))).toBe(true);
        expect(Number.isFinite(refractionDeltaDeg(0, {tempC: -1000}))).toBe(true);
    });

    test('pressure scales correction linearly', () => {
        const pNorm = refractionDeltaDeg(0, {pressureHPa: 1010, tempC: 10});
        const pHalf = refractionDeltaDeg(0, {pressureHPa: 505, tempC: 10});
        expect(pHalf).toBeCloseTo(pNorm * 0.5, 4);
    });

    test('warmer air refracts less', () => {
        const cold = refractionDeltaDeg(0, {pressureHPa: 1010, tempC: -20});
        const warm = refractionDeltaDeg(0, {pressureHPa: 1010, tempC: 30});
        expect(warm).toBeLessThan(cold);
    });

    test('uses Stellarium defaults when no opts passed', () => {
        expect(REFRACTION_DEFAULTS.pressureHPa).toBe(1010);
        expect(REFRACTION_DEFAULTS.tempC).toBe(10);
    });
});

describe('applyRefractionECI (direction bending)', () => {
    const zenith = new Vector3(0, 0, 1);

    test('disabled → input returned unchanged', () => {
        const v = new Vector3(1, 0, 0);
        const out = applyRefractionECI(v, zenith, {enabled: false});
        expect(out.x).toBeCloseTo(1, 6);
        expect(out.z).toBeCloseTo(0, 6);
    });

    test('zenith direction is unchanged (axis is degenerate)', () => {
        const v = new Vector3(0, 0, 100);
        applyRefractionECI(v, zenith);
        expect(v.length()).toBeCloseTo(100, 6);
        expect(v.z).toBeCloseTo(100, 6);
    });

    test('horizon direction is lifted toward zenith', () => {
        const v = new Vector3(100, 0, 0); // horizon, 100m sphere
        const before = v.clone();
        applyRefractionECI(v, zenith);
        // Length preserved
        expect(v.length()).toBeCloseTo(100, 4);
        // Lifted toward zenith — z should increase
        expect(v.z).toBeGreaterThan(before.z);
        // Lift magnitude near the horizon ≈ 0.479° → z ≈ 100 * sin(0.479°) ≈ 0.836
        expect(v.z).toBeGreaterThan(0.5);
        expect(v.z).toBeLessThan(1.2);
    });

    test('high altitude object barely moves', () => {
        const v = new Vector3(Math.cos(60 * Math.PI / 180), 0, Math.sin(60 * Math.PI / 180))
            .multiplyScalar(100);
        const before = v.clone();
        applyRefractionECI(v, zenith);
        expect(v.length()).toBeCloseTo(100, 4);
        expect(v.distanceTo(before)).toBeLessThan(0.1);
    });

    test('length is preserved at all altitudes', () => {
        for (const altDeg of [-2, 0, 1, 5, 30, 60, 89]) {
            const a = altDeg * Math.PI / 180;
            const r = 1234.5;
            const v = new Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(r);
            applyRefractionECI(v, zenith);
            expect(v.length()).toBeCloseTo(r, 3);
        }
    });
});

describe('applyRefractionFromObserver (satellites)', () => {
    // Observer at 6371 km radius from Earth centre on +X axis (lat=0, lon=0).
    // Local zenith is +X. A satellite directly overhead is at +X (further out).
    const obs = new Vector3(6371000, 0, 0);

    test('disabled → unchanged', () => {
        const sat = new Vector3(7371000, 100000, 0);
        const out = applyRefractionFromObserver(sat, obs, {enabled: false});
        expect(out.x).toBeCloseTo(sat.x, 6);
        expect(out.y).toBeCloseTo(sat.y, 6);
    });

    test('overhead satellite (zenith) → no shift', () => {
        const sat = new Vector3(7371000, 0, 0);
        const out = applyRefractionFromObserver(sat, obs);
        expect(out.distanceTo(sat)).toBeLessThan(1);
    });

    test('horizon satellite → lifted toward zenith', () => {
        // Place satellite 1000 km away in observer-tangent direction
        // (alt ~ 0° from observer's local horizon).
        const sat = new Vector3(6371000, 1000000, 0);
        const before = sat.clone();
        const out = applyRefractionFromObserver(sat.clone(), obs);
        // Apparent direction lifts toward zenith (+X). y-component should
        // shrink slightly, x-component grows.
        expect(out.x).toBeGreaterThan(before.x);
        expect(out.y).toBeLessThan(before.y);
        // Distance from observer is preserved.
        const dBefore = before.distanceTo(obs);
        const dAfter = out.distanceTo(obs);
        expect(dAfter).toBeCloseTo(dBefore, 0);
    });

    test('shift magnitude at horizon is order ~0.5° at 1000 km', () => {
        const sat = new Vector3(6371000, 1000000, 0);
        const out = applyRefractionFromObserver(sat.clone(), obs);
        // angular shift = asin(crossMag / dist)
        const dir = sat.clone().sub(obs).normalize();
        const dirOut = out.clone().sub(obs).normalize();
        const cosA = dir.dot(dirOut);
        const angleDeg = Math.acos(Math.min(1, cosA)) * 180 / Math.PI;
        expect(angleDeg).toBeGreaterThan(0.2);
        expect(angleDeg).toBeLessThan(0.8);
    });

    test('writes to provided target without mutating inputs', () => {
        const sat = new Vector3(6371000, 1000000, 0);
        const obsCopy = obs.clone();
        const target = new Vector3();
        applyRefractionFromObserver(sat, obsCopy, undefined, target);
        // Inputs untouched.
        expect(sat.y).toBe(1000000);
        expect(obsCopy.x).toBe(obs.x);
        // Target populated.
        expect(target.length()).toBeGreaterThan(0);
    });
});

describe('zenithECEFFromLatLon', () => {
    test('lat=0, lon=0 → +X', () => {
        const z = zenithECEFFromLatLon(0, 0);
        expect(z.x).toBeCloseTo(1, 6);
        expect(z.y).toBeCloseTo(0, 6);
        expect(z.z).toBeCloseTo(0, 6);
    });
    test('lat=π/2 → +Z', () => {
        const z = zenithECEFFromLatLon(Math.PI / 2, 0.5);
        expect(z.z).toBeCloseTo(1, 6);
    });
    test('unit length', () => {
        const z = zenithECEFFromLatLon(0.7, -2.1);
        expect(z.length()).toBeCloseTo(1, 6);
    });
});

describe('zenithECIFromLatLonGMST', () => {
    test('lat=0, lon=0, GMST=0 → +X (vernal equinox)', () => {
        const z = zenithECIFromLatLonGMST(0, 0, 0);
        expect(z.x).toBeCloseTo(1, 6);
        expect(z.y).toBeCloseTo(0, 6);
        expect(z.z).toBeCloseTo(0, 6);
    });

    test('lat=90 → +Z regardless of longitude or GMST', () => {
        const z = zenithECIFromLatLonGMST(Math.PI / 2, 1.234, 200);
        expect(z.z).toBeCloseTo(1, 6);
    });

    test('GMST rotates equator point by +GMST around Z', () => {
        const z = zenithECIFromLatLonGMST(0, 0, 90);
        expect(z.x).toBeCloseTo(0, 6);
        expect(z.y).toBeCloseTo(1, 6);
    });

    test('unit length', () => {
        const z = zenithECIFromLatLonGMST(0.7, -2.1, 137);
        expect(z.length()).toBeCloseTo(1, 6);
    });
});
