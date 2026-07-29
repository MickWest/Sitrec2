import {Vector3} from 'three';
import {airframeHeadingFromVelocity} from '../src/AirframeHeading';
import {getLocalNorthVector, getLocalUpVector} from '../src/SphericalMath';
import {RLLAToECEF_radii} from '../src/LLA-ECEF-ENU';
import {setSit} from '../src/Globals';
import {radians} from '../src/utils';

// Somewhere over southern California, at altitude. getLocalNorthVector needs
// Sit.lat/lon, so establish a minimal Sit before building the local basis.
const LAT = 34, LON = -118;
setSit({frames: 100, fps: 30, simSpeed: 1, lat: LAT, lon: LON});

const POSITION = RLLAToECEF_radii(radians(LAT), radians(LON), 10000);

const UP = getLocalUpVector(POSITION);
const NORTH = getLocalNorthVector(POSITION);
// north x up is east, matching getCompassHeading's own basis
const EAST = NORTH.clone().cross(UP);

// build an ECEF velocity from local north/east/up components, in m/frame
function velocity(north, east, up) {
    return new Vector3()
        .addScaledVector(NORTH, north)
        .addScaledVector(EAST, east)
        .addScaledVector(UP, up);
}

describe('airframeHeadingFromVelocity', () => {

    describe('returns a heading when the track is actually travelling', () => {
        test('due north reads 000', () => {
            expect(airframeHeadingFromVelocity(POSITION, velocity(5, 0, 0))).toBeCloseTo(0, 3);
        });

        test('due east reads 090', () => {
            expect(airframeHeadingFromVelocity(POSITION, velocity(0, 5, 0))).toBeCloseTo(90, 3);
        });

        test('due west reads 270', () => {
            expect(airframeHeadingFromVelocity(POSITION, velocity(0, -5, 0))).toBeCloseTo(270, 3);
        });

        test('climbing while travelling north still reads 000', () => {
            // vertical motion must not affect a horizontal quantity
            expect(airframeHeadingFromVelocity(POSITION, velocity(5, 0, 20))).toBeCloseTo(0, 3);
        });
    });

    describe('crosswind turns the airframe into the wind', () => {
        test('tracking north with an easterly wind component points west of north', () => {
            // air velocity = ground - wind = 5N - 2E, so atan2(-2, 5) = -21.8
            const heading = airframeHeadingFromVelocity(POSITION, velocity(5, 0, 0), velocity(0, 2, 0));
            expect(heading).toBeCloseTo(360 - 21.801, 2);
        });

        test('a purely vertical wind does not change the heading', () => {
            const heading = airframeHeadingFromVelocity(POSITION, velocity(5, 0, 0), velocity(0, 0, 9));
            expect(heading).toBeCloseTo(0, 3);
        });
    });

    describe('returns null rather than fabricating a heading', () => {
        // The Custom sitch's default camera is fixed, and localWind is ~1.2
        // m/frame. Correcting a zero ground track for wind yields the wind
        // direction, which used to be displayed as a confident "285".
        test('stationary camera in a wind has no heading', () => {
            const wind = velocity(0.3, -1.16, 0);
            expect(airframeHeadingFromVelocity(POSITION, velocity(0, 0, 0), wind)).toBeNull();
        });

        test('stationary camera with no wind has no heading', () => {
            expect(airframeHeadingFromVelocity(POSITION, velocity(0, 0, 0))).toBeNull();
        });

        // getCompassHeading projects onto the horizontal plane, so a vertical
        // vector projects to zero and atan2(0,0) would hand back 0 = "000".
        test('purely vertical motion has no heading', () => {
            expect(airframeHeadingFromVelocity(POSITION, velocity(0, 0, 25))).toBeNull();
        });

        test('purely vertical motion in a wind has no heading', () => {
            const wind = velocity(1.2, 0.5, 0);
            expect(airframeHeadingFromVelocity(POSITION, velocity(0, 0, 25), wind)).toBeNull();
        });

        test('wind exactly cancelling the ground track has no heading', () => {
            const ground = velocity(4, -3, 0);
            expect(airframeHeadingFromVelocity(POSITION, ground, ground.clone())).toBeNull();
        });

        test('horizontal motion below the threshold has no heading', () => {
            // 0.02 m/frame is under MIN_HORIZONTAL_SPEED_SQ (0.0316 m/frame)
            expect(airframeHeadingFromVelocity(POSITION, velocity(0.02, 0, 0))).toBeNull();
        });
    });

    test('does not mutate the vectors it is given', () => {
        const ground = velocity(5, 0, 0);
        const wind = velocity(0, 2, 0);
        const groundCopy = ground.clone();
        const windCopy = wind.clone();
        airframeHeadingFromVelocity(POSITION, ground, wind);
        expect(ground.distanceTo(groundCopy)).toBeCloseTo(0, 9);
        expect(wind.distanceTo(windCopy)).toBeCloseTo(0, 9);
    });
});
