import {
    ECEF2ENU,
    ECEFToLLA,
    ECEFToLLA_Sphere,
    ENU2ECEF,
    getN,
    haversineDistanceKM,
    LLAToECEF_Sphere,
    RLLAToECEF,
    RLLAToECEFV_Sphere,
    wgs84
} from '../src/LLA-ECEF-ENU.js';
import {Vector3} from 'three';

describe('wgs84 constants', () => {
    test('RADIUS is correct', () => {
        expect(wgs84.RADIUS).toBe(6378137);
    });

    test('FLATTENING_DENOM is correct', () => {
        expect(wgs84.FLATTENING_DENOM).toBe(298.257223563);
    });

    test('derived constants are calculated correctly', () => {
        expect(wgs84.FLATTENING).toBeCloseTo(1 / 298.257223563, 15);
        expect(wgs84.POLAR_RADIUS).toBeCloseTo(6356752.314245, 0);
        expect(wgs84.CIRC).toBeCloseTo(2 * Math.PI * wgs84.RADIUS, 0);
    });
});

describe('haversineDistanceKM', () => {
    test('distance from point to itself is 0', () => {
        expect(haversineDistanceKM(45, -122, 45, -122)).toBe(0);
    });

    test('calculates distance between NYC and LA', () => {
        const dist = haversineDistanceKM(40.7128, -74.0060, 34.0522, -118.2437);
        expect(dist).toBeCloseTo(3940, -2);
    });

    test('calculates distance between London and Paris', () => {
        const dist = haversineDistanceKM(51.5074, -0.1278, 48.8566, 2.3522);
        expect(dist).toBeCloseTo(344, -1);
    });

    test('calculates distance across equator', () => {
        const dist = haversineDistanceKM(10, 0, -10, 0);
        expect(dist).toBeCloseTo(2224, -1);
    });

    test('calculates distance across antimeridian', () => {
        const dist = haversineDistanceKM(0, 179, 0, -179);
        // 2° at the equator ≈ 222.6 km using WGS84 equatorial radius
        expect(dist).toBeCloseTo(222.6, 0);
    });

    test('handles negative coordinates', () => {
        const dist = haversineDistanceKM(-33.8688, 151.2093, -37.8136, 144.9631);
        expect(dist).toBeCloseTo(714, -1);
    });
});

describe('RLLAToECEF', () => {
    test('converts equator/prime meridian point', () => {
        const ecef = RLLAToECEF(0, 0, 0);
        expect(ecef.x).toBeCloseTo(wgs84.RADIUS, 0);
        expect(ecef.y).toBeCloseTo(0, 0);
        expect(ecef.z).toBeCloseTo(0, 0);
    });

    test('converts north pole', () => {
        const ecef = RLLAToECEF(Math.PI / 2, 0, 0);
        expect(ecef.x).toBeCloseTo(0, 0);
        expect(ecef.y).toBeCloseTo(0, 0);
        expect(ecef.z).toBeCloseTo(wgs84.POLAR_RADIUS, 0);
    });

    test('converts south pole', () => {
        const ecef = RLLAToECEF(-Math.PI / 2, 0, 0);
        expect(ecef.x).toBeCloseTo(0, 0);
        expect(ecef.y).toBeCloseTo(0, 0);
        expect(ecef.z).toBeCloseTo(-wgs84.POLAR_RADIUS, 0);
    });

    test('converts 90 degrees east on equator', () => {
        const ecef = RLLAToECEF(0, Math.PI / 2, 0);
        expect(ecef.x).toBeCloseTo(0, 0);
        expect(ecef.y).toBeCloseTo(wgs84.RADIUS, 0);
        expect(ecef.z).toBeCloseTo(0, 0);
    });

    test('handles altitude', () => {
        const alt = 1000;
        const ecef = RLLAToECEF(0, 0, alt);
        expect(ecef.x).toBeCloseTo(wgs84.RADIUS + alt, 0);
    });

    test('returns Vector3', () => {
        const ecef = RLLAToECEF(0, 0, 0);
        expect(ecef).toBeInstanceOf(Vector3);
    });
});

describe('ECEFToLLA', () => {
    test('converts equator/prime meridian point', () => {
        const [lat, lon, alt] = ECEFToLLA(wgs84.RADIUS, 0, 0);
        expect(lat).toBeCloseTo(0, 5);
        expect(lon).toBeCloseTo(0, 5);
        expect(alt).toBeCloseTo(0, 0);
    });

    test('converts point at high latitude', () => {
        const lat = 85 * Math.PI / 180;
        const lon = 0;
        const ecef = RLLAToECEF(lat, lon, 0);
        const [latBack, lonBack, altBack] = ECEFToLLA(ecef.x, ecef.y, ecef.z);
        expect(latBack * 180 / Math.PI).toBeCloseTo(85, 3);
    });

    test('converts point at 90 degrees east', () => {
        const [lat, lon, alt] = ECEFToLLA(0, wgs84.RADIUS, 0);
        expect(lat).toBeCloseTo(0, 5);
        expect(lon).toBeCloseTo(Math.PI / 2, 5);
        expect(alt).toBeCloseTo(0, 0);
    });

    test('handles negative longitude (western hemisphere)', () => {
        const [lat, lon, alt] = ECEFToLLA(0, -wgs84.RADIUS, 0);
        expect(lon).toBeCloseTo(-Math.PI / 2, 5);
    });
});

describe('LLA-ECEF round-trip (WGS84)', () => {
    const testPoints = [
        { lat: 0, lon: 0, alt: 0 },
        { lat: 45, lon: -122, alt: 100 },
        { lat: -33.8688, lon: 151.2093, alt: 50 },
        { lat: 51.5074, lon: -0.1278, alt: 11 },
        { lat: 89, lon: 45, alt: 0 },
        { lat: -89, lon: -135, alt: 1000 },
    ];

    testPoints.forEach(({ lat, lon, alt }) => {
        test(`round-trip for lat=${lat}, lon=${lon}, alt=${alt}`, () => {
            const latRad = lat * Math.PI / 180;
            const lonRad = lon * Math.PI / 180;
            const ecef = RLLAToECEF(latRad, lonRad, alt);
            const [latBack, lonBack, altBack] = ECEFToLLA(ecef.x, ecef.y, ecef.z);
            expect(latBack * 180 / Math.PI).toBeCloseTo(lat, 4);
            expect(lonBack * 180 / Math.PI).toBeCloseTo(lon, 4);
            expect(altBack).toBeCloseTo(alt, 0);
        });
    });
});

describe('Sphere functions', () => {
    describe('LLAToECEF_Sphere', () => {
        test('converts equator/prime meridian point', () => {
            const [x, y, z] = LLAToECEF_Sphere(0, 0, 0);
            expect(x).toBeCloseTo(wgs84.RADIUS, 0);
            expect(y).toBeCloseTo(0, 0);
            expect(z).toBeCloseTo(0, 0);
        });

        test('converts north pole', () => {
            const [x, y, z] = LLAToECEF_Sphere(Math.PI / 2, 0, 0);
            expect(x).toBeCloseTo(0, 0);
            expect(y).toBeCloseTo(0, 0);
            expect(z).toBeCloseTo(wgs84.RADIUS, 0);
        });
    });

    describe('RLLAToECEFV_Sphere', () => {
        test('returns Vector3', () => {
            const result = RLLAToECEFV_Sphere(0, 0, 0);
            expect(result).toBeInstanceOf(Vector3);
        });

        test('handles custom radius', () => {
            const customRadius = 1000;
            const result = RLLAToECEFV_Sphere(0, 0, 0, customRadius);
            expect(result.x).toBeCloseTo(customRadius, 0);
        });
    });

    describe('ECEFToLLA_Sphere', () => {
        test('converts equator/prime meridian point', () => {
            const [lat, lon, alt] = ECEFToLLA_Sphere(wgs84.RADIUS, 0, 0);
            expect(lat).toBeCloseTo(0, 5);
            expect(lon).toBeCloseTo(0, 5);
            expect(alt).toBeCloseTo(0, 0);
        });

        test('converts north pole', () => {
            const [lat, lon, alt] = ECEFToLLA_Sphere(0, 0, wgs84.RADIUS);
            expect(lat).toBeCloseTo(Math.PI / 2, 5);
            expect(alt).toBeCloseTo(0, 0);
        });
    });

    describe('Sphere LLA-ECEF round-trip', () => {
        const testPoints = [
            { lat: 0, lon: 0, alt: 0 },
            { lat: 45, lon: -90, alt: 1000 },
            { lat: -45, lon: 90, alt: 500 },
        ];

        testPoints.forEach(({ lat, lon, alt }) => {
            test(`round-trip for lat=${lat}, lon=${lon}, alt=${alt}`, () => {
                const latRad = lat * Math.PI / 180;
                const lonRad = lon * Math.PI / 180;
                const [x, y, z] = LLAToECEF_Sphere(latRad, lonRad, alt);
                const [latBack, lonBack, altBack] = ECEFToLLA_Sphere(x, y, z);
                expect(latBack * 180 / Math.PI).toBeCloseTo(lat, 4);
                expect(lonBack * 180 / Math.PI).toBeCloseTo(lon, 4);
                expect(altBack).toBeCloseTo(alt, 0);
            });
        });
    });
});

describe('ECEF2ENU and ENU2ECEF', () => {
    const lat = 45 * Math.PI / 180;
    const lon = -122 * Math.PI / 180;
    const radius = wgs84.RADIUS;

    test('origin point converts to ENU (0,0,0)', () => {
        const originECEF = RLLAToECEFV_Sphere(lat, lon, 0, radius);
        const enu = ECEF2ENU(originECEF, lat, lon, radius);
        expect(enu.x).toBeCloseTo(0, 3);
        expect(enu.y).toBeCloseTo(0, 3);
        expect(enu.z).toBeCloseTo(0, 3);
    });

    test('point above origin has positive U (z)', () => {
        const originECEF = RLLAToECEFV_Sphere(lat, lon, 1000, radius);
        const enu = ECEF2ENU(originECEF, lat, lon, radius);
        expect(enu.z).toBeCloseTo(1000, 0);
    });

    test('ECEF2ENU and ENU2ECEF are inverses', () => {
        const testECEF = RLLAToECEFV_Sphere(lat + 0.01, lon + 0.01, 500, radius);
        const enu = ECEF2ENU(testECEF, lat, lon, radius);
        const backECEF = ENU2ECEF(enu, lat, lon, radius);
        expect(backECEF.x).toBeCloseTo(testECEF.x, 0);
        expect(backECEF.y).toBeCloseTo(testECEF.y, 0);
        expect(backECEF.z).toBeCloseTo(testECEF.z, 0);
    });

    test('justRotate option works', () => {
        const direction = new Vector3(1, 0, 0);
        const rotated = ECEF2ENU(direction, lat, lon, radius, true);
        expect(rotated.length()).toBeCloseTo(1, 5);
    });
});

describe('getN (radius of curvature)', () => {
    test('returns radius at equator', () => {
        const N = getN(0);
        expect(N).toBeCloseTo(wgs84.RADIUS, 0);
    });

    test('returns larger value at poles due to flattening', () => {
        const Nequator = getN(0);
        const Npole = getN(Math.PI / 2);
        expect(Npole).toBeGreaterThan(Nequator);
    });

    test('is symmetric for positive and negative latitudes', () => {
        const N45 = getN(Math.PI / 4);
        const Nminus45 = getN(-Math.PI / 4);
        expect(N45).toBeCloseTo(Nminus45, 5);
    });
});
