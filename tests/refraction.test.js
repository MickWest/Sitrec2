import {Matrix4, Vector3} from 'three';
import {
    refractionDeltaDeg,
    applyRefractionECI,
    applyRefractionFromObserver,
    ellipsoidRadiusUnder,
    rayMinHeight,
    zenithECEFFromLatLon,
    zenithECEFFromPosition,
    zenithEQJFromLatLon,
    REFRACTION_DEFAULTS,
    REFRACTION_SCALE_HEIGHT_M,
    REFRACTION_VERTEX_GLSL,
    refractionUniforms,
} from '../src/atmosphere/refraction';
import {getECEFToEQJMatrix, getEQJToECEFMatrix} from '../src/CelestialMath';

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

// Saemundsson is a sea-level formula. These lock in the observer-height
// correction that scales it down to the air a sightline actually crosses.
describe('rayMinHeight (lowest point on the sightline)', () => {
    const R = 6371000;

    test('looking up, the observer is its own lowest point', () => {
        for (const alt of [0, 1, 15, 45, 90]) {
            expect(rayMinHeight(alt, 10000, R)).toBeCloseTo(10000, 6);
        }
    });

    test('looking down, it is the tangent height (R+h)·cos(a) − R', () => {
        for (const [alt, h] of [[-1, 10000], [-5, 493000], [-10.2, 492806], [-21, 492806]]) {
            const want = (R + h) * Math.cos(alt * Math.PI / 180) - R;
            expect(rayMinHeight(alt, h, R)).toBeCloseTo(want, 3);
        }
    });

    test('continuous through zero', () => {
        const h = 100000;
        expect(rayMinHeight(-1e-9, h, R)).toBeCloseTo(rayMinHeight(0, h, R), 6);
    });

    test('goes negative when the ray runs into the ground', () => {
        // A ground observer looking below the horizontal, and a 10 km observer
        // looking down steeply enough to hit the surface (dip is ~3.2°).
        expect(rayMinHeight(-1, 0, R)).toBeLessThan(0);
        expect(rayMinHeight(-5, 10000, R)).toBeLessThan(0);
    });

    test('the reported case: nothing in that field of view touches the air', () => {
        // Camera at 492.8 km; the main view spanned −2.58° to −10.20°.
        for (const alt of [-2.58, -4.1, -6.39, -10.2]) {
            expect(rayMinHeight(alt, 492806, R)).toBeGreaterThan(300000);
        }
    });
});

describe('refractionDeltaDeg observer-height scaling', () => {
    test('height 0 is bit-identical to omitting it', () => {
        for (const alt of [-4.9, -3.54, -1, 0, 0.5, 5, 30, 89]) {
            expect(refractionDeltaDeg(alt, {observerHeight: 0}))
                .toBe(refractionDeltaDeg(alt));
        }
    });

    test('a negative height (below sea level) is also unchanged', () => {
        expect(refractionDeltaDeg(0, {observerHeight: -430}))
            .toBe(refractionDeltaDeg(0));
    });

    test('a ground observer looking down is unchanged — the ray hits dirt', () => {
        // zMin < 0 there, so the taper region keeps its existing behaviour.
        for (const alt of [-1, -3.54, -4, -4.9]) {
            expect(refractionDeltaDeg(alt, {observerHeight: 0.0001}))
                .toBeCloseTo(refractionDeltaDeg(alt), 12);
        }
    });

    test('an aircraft at 10 km sees ~26% of sea-level refraction', () => {
        // US Standard Atmosphere puts 10 km at 264/1013 = 0.261 of surface
        // pressure; the 7.5 km scale height reproduces that to ~1%.
        const ratio = refractionDeltaDeg(0, {observerHeight: 10000})
            / refractionDeltaDeg(0);
        expect(ratio).toBeGreaterThan(0.24);
        expect(ratio).toBeLessThan(0.28);
    });

    test('refraction never grows as the observer climbs', () => {
        let prev = Infinity;
        for (const h of [0, 1000, 5000, 10000, 20000, 50000, 100000, 493000]) {
            const d = refractionDeltaDeg(0, {observerHeight: h});
            expect(d).toBeLessThanOrEqual(prev);
            prev = d;
        }
    });

    // The bug this fixes: at 493 km the horizon is 21.8° down, so the −5°
    // floor fell inside a 7.62° field of view. The top of the frame got 0.65°
    // of bend and everything below 35% of the way down got none — a visible
    // seam across the sky. With the height correction the whole frame is
    // effectively unrefracted, which is right: none of it passes through air.
    describe('camera at 492.8 km (the reported sitch)', () => {
        const opts = {observerHeight: 492806, earthRadius: 6371000};

        test('the old model tore the frame into a bent band and a flat one', () => {
            expect(refractionDeltaDeg(-2.58)).toBeGreaterThan(0.6);   // top
            expect(refractionDeltaDeg(-6.39)).toBe(0);                // middle
        });

        test('no part of the frame is bent by more than a milliarcsecond now', () => {
            for (let alt = -2.58; alt >= -10.2; alt -= 0.1) {
                expect(refractionDeltaDeg(alt, opts)).toBeLessThan(1 / 3600000);
            }
        });

        test('and the seam at the −5° floor is gone', () => {
            const above = refractionDeltaDeg(-4.99, opts);
            const below = refractionDeltaDeg(-5.01, opts);
            expect(Math.abs(above - below)).toBeLessThan(1e-9);
        });
    });
});

describe('ellipsoidRadiusUnder', () => {
    const A = 6378137.0, B = A * (1 - 1 / 298.257223563);
    const D2R = Math.PI / 180;

    test('a point on the ellipsoid has exactly zero radial height', () => {
        // Built from geocentric latitude so the point is on the surface along
        // the same ray the radius is evaluated along.
        for (const latDeg of [0, 30, 45, 60, 89.9, -45]) {
            const la = latDeg * D2R;
            const dir = new Vector3(Math.cos(la), 0, Math.sin(la));
            const r = (A * B) / Math.hypot(A * Math.sin(la), B * Math.cos(la));
            const p = dir.multiplyScalar(r);
            expect(p.length() - ellipsoidRadiusUnder(p)).toBeCloseTo(0, 6);
        }
    });

    test('equator gives a, pole gives b', () => {
        expect(ellipsoidRadiusUnder(new Vector3(1, 0, 0))).toBeCloseTo(A, 6);
        expect(ellipsoidRadiusUnder(new Vector3(0, 0, 1))).toBeCloseTo(B, 6);
    });

    test('a spherical earth model gives that radius everywhere', () => {
        for (const latDeg of [0, 37, 72]) {
            const la = latDeg * D2R;
            const p = new Vector3(Math.cos(la), 0, Math.sin(la)).multiplyScalar(7e6);
            expect(ellipsoidRadiusUnder(p, A, A)).toBeCloseTo(A, 6);
        }
    });

    test('is stable at the origin', () => {
        expect(Number.isFinite(ellipsoidRadiusUnder(new Vector3(0, 0, 0)))).toBe(true);
    });
});

describe('the vertex shader carries the same model as the CPU', () => {
    test('every shared uniform is declared in the GLSL', () => {
        for (const name of Object.keys(refractionUniforms)) {
            expect(REFRACTION_VERTEX_GLSL).toContain(name);
        }
    });

    test('the scale height is the exported constant, not a stale literal', () => {
        expect(REFRACTION_VERTEX_GLSL).toContain(REFRACTION_SCALE_HEIGHT_M.toFixed(1));
    });

    // GLSL has no implicit int→float, so a bare "7500" would fail to compile
    // the moment anyone edits the constant to a whole number they typed plainly.
    test('it is emitted as a float literal whatever value it is set to', () => {
        expect(REFRACTION_VERTEX_GLSL).toMatch(/exp\(-zMin \/ \d+\.\d+\)/);
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
        applyRefractionECI(v, zenith, {enabled: true});
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
        const out = applyRefractionFromObserver(sat.clone(), obs, {enabled: true});
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
        const out = applyRefractionFromObserver(sat.clone(), obs, {enabled: true});
        // angular shift = asin(crossMag / dist)
        const dir = sat.clone().sub(obs).normalize();
        const dirOut = out.clone().sub(obs).normalize();
        const cosA = dir.dot(dirOut);
        const angleDeg = Math.acos(Math.min(1, cosA)) * 180 / Math.PI;
        expect(angleDeg).toBeGreaterThan(0.2);
        expect(angleDeg).toBeLessThan(0.8);
    });

    // The observer's ECEF already says how high it is, so callers don't have
    // to thread a height through. CSatellite relies on this.
    test('derives the observer height from the observer position', () => {
        const angle = (o, s, out) => {
            const a = s.clone().sub(o).normalize();
            const b = out.clone().sub(o).normalize();
            return Math.acos(Math.min(1, a.dot(b))) * 180 / Math.PI;
        };
        // Same 1000 km horizontal offset, observer at the surface vs 400 km up.
        const ground = new Vector3(6378137, 0, 0);
        const orbit = new Vector3(6378137 + 400000, 0, 0);
        const satG = new Vector3(ground.x, 1000000, 0);
        const satO = new Vector3(orbit.x, 1000000, 0);

        const bentG = angle(ground, satG, applyRefractionFromObserver(satG, ground));
        const bentO = angle(orbit, satO, applyRefractionFromObserver(satO, orbit));

        expect(bentG).toBeGreaterThan(0.2);      // unchanged ground behaviour
        expect(bentO).toBeLessThan(bentG / 100); // 400 km up: essentially none
    });

    test('an explicit observerHeight overrides the derived one', () => {
        const obs = new Vector3(6378137 + 400000, 0, 0);
        const sat = new Vector3(obs.x, 1000000, 0);
        const derived = applyRefractionFromObserver(sat, obs);
        const forced = applyRefractionFromObserver(sat, obs, {observerHeight: 0});
        expect(forced.distanceTo(sat)).toBeGreaterThan(derived.distanceTo(sat));
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

describe('zenithECEFFromPosition (geodetic zenith from an ECEF point)', () => {
    const A = 6378137.0, F = 1 / 298.257223563, E2 = F * (2 - F);
    const D2R = Math.PI / 180, R2D = 180 / Math.PI;

    // Build an ECEF position from geodetic lat/lon/height, so the expected
    // zenith is known exactly rather than assumed.
    const fromGeodetic = (latDeg, lonDeg, h) => {
        const la = latDeg * D2R, lo = lonDeg * D2R;
        const N = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2);
        return new Vector3(
            (N + h) * Math.cos(la) * Math.cos(lo),
            (N + h) * Math.cos(la) * Math.sin(lo),
            (N * (1 - E2) + h) * Math.sin(la),
        );
    };

    test.each([
        [0, 0, 0], [55.6405, 12.6533, 39.6], [45, -118, 0],
        [-33.9, 151.2, 1200], [89.9, 10, 0], [60, 20, 400000],
    ])('recovers the exact geodetic normal at lat %p lon %p h %p', (lat, lon, h) => {
        const got = zenithECEFFromPosition(fromGeodetic(lat, lon, h));
        const want = zenithECEFFromLatLon(lat * D2R, lon * D2R);
        // Bowring is good to well under a milliarcsecond.
        expect(Math.acos(Math.min(1, got.dot(want))) * R2D * 3600).toBeLessThan(0.001);
    });

    test('differs from the geocentric radial by the expected amount', () => {
        // The bug this replaced: using observerECEF.normalize() as the zenith.
        // Peak separation is ~11.55' near 45°, zero at pole and equator.
        const sep = (latDeg) => {
            const p = fromGeodetic(latDeg, 0, 0);
            const geodetic = zenithECEFFromPosition(p);
            const geocentric = p.clone().normalize();
            return Math.acos(Math.min(1, geodetic.dot(geocentric))) * R2D * 60;
        };
        // Coincident at equator and pole. Bounded rather than toBeCloseTo(0):
        // acos is ill-conditioned at dot≈1, so the floor here is arithmetic
        // noise (~3 milliarcsec), not geometry.
        expect(sep(0)).toBeLessThan(0.001);
        expect(sep(90)).toBeLessThan(0.001);
        expect(sep(45)).toBeGreaterThan(11.4);
        expect(sep(45)).toBeLessThan(11.6);
        expect(sep(55.6405)).toBeGreaterThan(10.6);   // Copenhagen
        expect(sep(55.6405)).toBeLessThan(10.9);
    });

    // Sitrec's earth model is selectable (Sit.useEllipsoid, false by default for
    // legacy sitches). With a sphere the observer ECEF sits on a sphere and the
    // local vertical IS the radial, so a hard-coded WGS84 inversion would tilt
    // the refraction axis by the same ~11.5' this change exists to remove.
    test('collapses to the radial when given a spherical earth model', () => {
        const R = A;
        for (const latDeg of [0, 30, 45, 55.6405, 80]) {
            const la = latDeg * D2R;
            const p = new Vector3(R * Math.cos(la), 0, R * Math.sin(la));
            const got = zenithECEFFromPosition(p, new Vector3(), R, R);
            const radial = p.clone().normalize();
            expect(got.dot(radial)).toBeCloseTo(1, 12);
        }
    });

    test('ellipsoid and sphere models genuinely disagree, by the known amount', () => {
        const la = 45 * D2R;
        const N = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2);
        const p = new Vector3(N * Math.cos(la), 0, N * (1 - E2) * Math.sin(la));
        const ell = zenithECEFFromPosition(p, new Vector3());               // WGS84 default
        const sph = zenithECEFFromPosition(p, new Vector3(), A, A);         // sphere
        const sep = Math.acos(Math.min(1, ell.dot(sph))) * R2D * 60;
        expect(sep).toBeGreaterThan(11.4);
        expect(sep).toBeLessThan(11.6);
    });

    test('is stable on the spin axis', () => {
        expect(zenithECEFFromPosition(new Vector3(0, 0, 6356752)).z).toBeCloseTo(1, 9);
        expect(zenithECEFFromPosition(new Vector3(0, 0, -6356752)).z).toBeCloseTo(-1, 9);
    });
});

describe('satellite refraction bends about the geodetic vertical', () => {
    const A = 6378137.0, F = 1 / 298.257223563, E2 = F * (2 - F);
    const D2R = Math.PI / 180;
    const fromGeodetic = (latDeg, lonDeg, h) => {
        const la = latDeg * D2R, lo = lonDeg * D2R;
        const N = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2);
        return new Vector3(
            (N + h) * Math.cos(la) * Math.cos(lo),
            (N + h) * Math.cos(la) * Math.sin(lo),
            (N * (1 - E2) + h) * Math.sin(la),
        );
    };

    test('a satellite low over a mid-latitude observer lifts along local up', () => {
        const obs = fromGeodetic(45, 0, 0);
        const up = zenithECEFFromPosition(obs);
        // North-pointing horizontal direction in the local geodetic frame.
        const north = new Vector3(0, 0, 1).sub(up.clone().multiplyScalar(up.z)).normalize();
        // Satellite ~1° above the geodetic horizon, 1000 km away.
        const dir = north.clone().multiplyScalar(Math.cos(1 * D2R))
            .add(up.clone().multiplyScalar(Math.sin(1 * D2R))).normalize();
        const sat = obs.clone().add(dir.clone().multiplyScalar(1e6));

        const out = applyRefractionFromObserver(sat, obs, {enabled: true});
        const outDir = out.clone().sub(obs).normalize();

        const altBefore = Math.asin(dir.dot(up)) / D2R;
        const altAfter = Math.asin(outDir.dot(up)) / D2R;
        const lift = (altAfter - altBefore) * 60;

        // Saemundsson at 1° is ~21.8'; bending about the geocentric radial
        // instead would be off by ~1'.
        expect(lift).toBeGreaterThan(20.5);
        expect(lift).toBeLessThan(23.0);

        // The lift must be purely vertical in the geodetic frame — refraction
        // never changes azimuth.
        const east = new Vector3().crossVectors(up, north).normalize();
        expect(Math.abs(outDir.dot(east) - dir.dot(east))).toBeLessThan(1e-9);
    });
});

describe('zenithEQJFromLatLon', () => {
    const identity = new Matrix4();
    const rotZ = (deg) => new Matrix4().makeRotationZ(deg * Math.PI / 180);

    test('lat=0, lon=0, identity frame → +X', () => {
        const z = zenithEQJFromLatLon(0, 0, identity);
        expect(z.x).toBeCloseTo(1, 6);
        expect(z.y).toBeCloseTo(0, 6);
        expect(z.z).toBeCloseTo(0, 6);
    });

    test('lat=90 → +Z regardless of longitude or frame rotation', () => {
        const z = zenithEQJFromLatLon(Math.PI / 2, 1.234, rotZ(200));
        expect(z.z).toBeCloseTo(1, 6);
    });

    test('the supplied matrix rotates the equator point', () => {
        const z = zenithEQJFromLatLon(0, 0, rotZ(90));
        expect(z.x).toBeCloseTo(0, 6);
        expect(z.y).toBeCloseTo(1, 6);
    });

    test('unit length', () => {
        const z = zenithEQJFromLatLon(0.7, -2.1, rotZ(137));
        expect(z.length()).toBeCloseTo(1, 6);
    });

    // The load-bearing property: refraction must bend about the observer's
    // real zenith, so the matrix handed in has to be the exact inverse of the
    // one the celestial sphere is drawn with. Round-tripping proves it, and
    // guards against anyone "simplifying" this back to a bare sidereal spin.
    test('round-trips through the celestial sphere matrix back to the ECEF zenith', () => {
        const date = new Date('2026-08-01T20:06:45.000Z');
        const lat = 55.640518563099654 * Math.PI / 180;
        const lon = 12.653300416260622 * Math.PI / 180;

        const eqj = zenithEQJFromLatLon(lat, lon, getECEFToEQJMatrix(date));
        const backToECEF = eqj.clone().applyMatrix4(getEQJToECEFMatrix(date));
        const direct = zenithECEFFromLatLon(lat, lon);

        expect(backToECEF.x).toBeCloseTo(direct.x, 12);
        expect(backToECEF.y).toBeCloseTo(direct.y, 12);
        expect(backToECEF.z).toBeCloseTo(direct.z, 12);
    });
});
