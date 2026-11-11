/**
 * Tests for the Reverse Balloon Launch Finder math (src/BalloonLaunchFinder.js):
 * one flight followed back to the ground, and the launch sites of a balloon at
 * a known position and on a line of sight.
 *
 * Uses the real ECEF/ENU math. The ground and the wind are simple functions.
 * In Sitrec the ground query is raycastGroundElevationFast (src/raycastGround.js).
 * Here it is hitOn, a slow and simple search over a ground function.
 */

import {Vector3} from "three";
import {setSit} from "../src/Globals";
import {ECEFToLLAVD_radii, LLAToECEF} from "../src/LLA-ECEF-ENU";
import {getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "../src/SphericalMath";
import {FLAT_GEOID, integrateBalloonPositions} from "../src/BalloonPhysics";
import {
    balloonLaunchSitesOfObject, balloonLaunchSitesOnSight, buoyancySteps, reverseBalloonFlight,
} from "../src/BalloonLaunchFinder";

const LAT = 61.2, LON = -149.8;
const RADIANS = Math.PI / 180;
const flatGround = () => 0;
const toEast = speed => () => ({u: speed, v: 0});

// A ground query for a ground function: the first point of a ray that is not
// above that ground, or null. It goes along the ray in steps of half a metre,
// which is smaller than every feature of the test grounds, then halves the last step.
const HIT_STEP = 0.5;
const hitOn = groundHAE => (origin, direction, maxDistance) => {
    const clearance = distance => {
        const lla = ECEFToLLAVD_radii(origin.clone().addScaledVector(direction, distance));
        return lla.z - groundHAE(lla.x, lla.y);
    };
    if (clearance(0) <= 0) return origin.clone();
    for (let far = HIT_STEP; far < maxDistance + HIT_STEP; far += HIT_STEP) {
        if (clearance(far) > 0) continue;
        let near = far - HIT_STEP;
        for (let pass = 0; pass < 20; pass++) {
            const middle = (near + far) / 2;
            if (clearance(middle) > 0) near = middle;
            else far = middle;
        }
        return origin.clone().addScaledVector(direction, far);
    }
    return null;
};
// Metres to the east of LON, for a ground that changes from west to east.
const metresPerDegree = LLAToECEF(LAT, LON + 0.001, 0).distanceTo(LLAToECEF(LAT, LON, 0)) * 1000;
const eastOf = lon => (lon - LON) * metresPerDegree;

// The offset of a point from another in metres, {east, north, up}, on the axes at `from`.
const offsetOf = (from, point) => {
    const offset = point.clone().sub(from);
    return {east: offset.dot(getLocalEastVector(from)), north: offset.dot(getLocalNorthVector(from)), up: offset.dot(getLocalUpVector(from))};
};

// getLocalNorthVector asserts Sit.lat/Sit.lon are defined. The describe blocks
// below make their fixtures with it, so this must run before them, not in a beforeEach.
setSit({name: "test", frames: 300, fps: 30, lat: LAT, lon: LON});

describe("buoyancySteps", () => {
    test("go from the highest buoyancy to the lowest, at equal steps of the flight time", () => {
        const rates = buoyancySteps(1, 5, 4);
        expect(rates.map(rate => 1 / rate)).toEqual([0.2, 0.4, 0.6000000000000001, 0.8, 1].map(value => expect.closeTo(value, 12)));
        expect(rates[0]).toBeCloseTo(5, 12);
        expect(rates[4]).toBeCloseTo(1, 12);
    });
});

describe("reverseBalloonFlight", () => {
    const balloon = LLAToECEF(LAT, LON, 1000);
    const flight = (params = {}) => reverseBalloonFlight({position: balloon, height: 1000, buoyancy: 5,
        maxSeconds: 3600, windAt: toEast(10), groundHit: hitOn(flatGround), ...params});

    test("in a steady wind over flat ground, the launch site is upwind by the wind speed times the flight time", () => {
        const site = flight();
        // 1000 m at 5 m/s is 200 seconds, and 200 seconds of a 10 m/s wind is 2000 m
        expect(site.seconds).toBeCloseTo(200, 0);
        const {east, north, up} = offsetOf(balloon, site.position);
        expect(east).toBeGreaterThan(-2003); expect(east).toBeLessThan(-1997);
        expect(Math.abs(north)).toBeLessThan(1);
        expect(up).toBeGreaterThan(-1001); expect(up).toBeLessThan(-999);
        expect(site.groundHAE).toBeCloseTo(0, 2);
        expect(site.path).toBeNull();
    });

    test("a balloon that rises more slowly comes from farther away", () => {
        expect(flight({buoyancy: 2}).seconds).toBeCloseTo(500, 0);
        expect(offsetOf(balloon, flight({buoyancy: 2}).position).east).toBeCloseTo(-5000, -1);
    });

    test("the wind of each height moves the balloon for the time that it is at that height", () => {
        // the wind grows with the height: 10 m/s at 1000 m. The drift is the mean wind, 5 m/s, for 200 seconds
        const site = flight({windAt: (lat, lon, altitude) => ({u: altitude / 100, v: 0})});
        expect(offsetOf(balloon, site.position).east).toBeCloseTo(-1000, -1);
    });

    test("a wind turned to the right puts the launch site to the left of the upwind direction", () => {
        const {east, north} = offsetOf(balloon, flight({windTurn: 20 * RADIANS}).position);
        // the wind now blows toward 110 degrees, so the launch site is toward 290 degrees
        expect(east).toBeCloseTo(-2000 * Math.cos(20 * RADIANS), -1);
        expect(north).toBeCloseTo(2000 * Math.sin(20 * RADIANS), -1);
    });

    test("with no wind, the launch site is below the balloon", () => {
        const site = flight({windAt: () => ({u: 0, v: 0})});
        const {east, north} = offsetOf(balloon, site.position);
        expect(Math.hypot(east, north)).toBeLessThan(0.01);
        expect(site.seconds).toBeCloseTo(200, 1);
    });

    test("ground that rises upwind makes the flight shorter", () => {
        // The path goes down 1 m for each 2 m, and the ground rises 1 m for each 10 m to the west.
        const site = flight({groundHit: hitOn((lat, lon) => -eastOf(lon) * 0.1)});
        expect(offsetOf(balloon, site.position).east).toBeCloseTo(-1000 / 0.6, -1);
        expect(site.seconds).toBeCloseTo(1000 / 0.6 / 10, 0);
        expect(site.groundHAE).toBeCloseTo(166.7, 0);
    });

    test("a ridge on the way is the launch site: the first contact, not the ground beyond", () => {
        // A wall 50 m thick and 800 m high, 500 m to the west of the balloon. The path is 750 m up there.
        const site = flight({groundHit: hitOn((lat, lon) => (eastOf(lon) <= -500 && eastOf(lon) >= -550 ? 800 : 0))});
        expect(offsetOf(balloon, site.position).east).toBeCloseTo(-500, -1);
        expect(site.seconds).toBeCloseTo(50, 0);
    });

    test("no launch site for a flight longer than the limit, for a balloon in the ground, or for no buoyancy", () => {
        expect(flight({maxSeconds: 190})).toBeNull();
        expect(flight({maxSeconds: 210})).not.toBeNull();
        expect(flight({height: 0})).toBeNull();
        expect(flight({buoyancy: 0})).toBeNull();
    });

    test("gives the points of the flight when they are asked for", () => {
        const site = flight({withPath: true});
        expect(site.path[0].distanceTo(balloon)).toBe(0);
        expect(site.path[site.path.length - 1].distanceTo(site.position)).toBe(0);
        expect(site.path.length).toBeGreaterThan(30);
        // each point is lower than the one before it
        const heights = site.path.map(point => ECEFToLLAVD_radii(point).z);
        for (let index = 1; index < heights.length; index++) expect(heights[index]).toBeLessThan(heights[index - 1]);
    });

    test("the balloon track from the launch site, with the same wind and buoyancy, comes to the balloon", () => {
        // a wind that changes in speed and direction with the height
        const wind = (lat, lon, altitude) => ({u: 2 + altitude / 100, v: altitude / 250});
        const site = flight({buoyancy: 4, windAt: wind});
        const dt = 0.1, frames = Math.round(site.seconds / dt) + 1;
        const track = integrateBalloonPositions({startLat: site.lat, startLon: site.lon, startAltMSL: site.groundHAE,
            ascentRate: 4, frames, dt, geoidOffset: FLAT_GEOID}, wind);
        // 250 seconds of flight, and a drift of 1.9 km
        expect(site.seconds).toBeCloseTo(250, 0);
        expect(site.position.distanceTo(balloon)).toBeGreaterThan(1800);
        expect(track[frames - 1].position.distanceTo(balloon)).toBeLessThan(5);
    });
});

describe("balloonLaunchSitesOfObject", () => {
    const balloon = LLAToECEF(LAT, LON, 1000);
    const sites = (params = {}) => balloonLaunchSitesOfObject({position: balloon, buoyancyMin: 1, buoyancyMax: 5,
        windError: 10 * RADIANS, maxSeconds: 7200, windAt: toEast(10), groundHAE: flatGround, groundHit: hitOn(flatGround), ...params});

    test("gives one outline: the launch sites from the highest buoyancy to the lowest, and a loop around them", () => {
        const {samples, outlines} = sites();
        expect(samples).toEqual([]);
        expect(outlines).toHaveLength(1);
        const [outline] = outlines;
        expect(outline.height).toBeCloseTo(1000, 6);
        expect(outline.windSpeed).toBeCloseTo(10, 12);
        expect(outline.windToward).toBeCloseTo(Math.PI / 2, 12);
        expect(outline.buoyancies).toHaveLength(5);
        // 200 seconds at 5 m/s to 1000 seconds at 1 m/s, at equal steps of time
        expect(outline.spine.map(site => Math.round(site.seconds / 10) * 10)).toEqual([200, 400, 600, 800, 1000]);
        expect(outline.spine.map(site => Math.round(-offsetOf(balloon, site.position).east / 100) * 100)).toEqual([2000, 4000, 6000, 8000, 10000]);
        // the middle one is the center, and it has its path
        expect(outline.center).toBe(outline.spine[2]);
        expect(outline.center.path.length).toBeGreaterThan(30);
        expect(outline.spine[0].path).toBeNull();
    });

    test("the loop goes along the two sides, where the wind is turned by the error", () => {
        const {loop} = sites().outlines[0];
        expect(loop).toHaveLength(12);
        expect(loop[0]).toBeInstanceOf(Vector3);
        const across = loop.map(point => offsetOf(balloon, point)).map(({east, north}) => north / Math.hypot(east, north));
        // five points on one side, one at the middle of the far end, five on the other side, one at the middle of the near end
        for (const index of [0, 1, 2, 3, 4]) expect(across[index]).toBeCloseTo(-Math.sin(10 * RADIANS), 2);
        expect(across[5]).toBeCloseTo(0, 2);
        for (const index of [6, 7, 8, 9, 10]) expect(across[index]).toBeCloseTo(Math.sin(10 * RADIANS), 2);
        expect(across[11]).toBeCloseTo(0, 2);
    });

    test("the time limit removes the slow flights, and the loop with them", () => {
        const [outline] = sites({maxSeconds: 700}).outlines;
        expect(outline.spine.map(site => site !== null)).toEqual([true, true, true, false, false]);
        expect(outline.center).not.toBeNull();
        expect(outline.loop).toBeNull();
    });
});

describe("balloonLaunchSitesOnSight", () => {
    // A camera on the ground that looks east and 30° up. An object of 2 mrad is 500 m away for each metre of its size.
    const origin = LLAToECEF(LAT, LON, 2);
    const direction = getLocalEastVector(origin).multiplyScalar(Math.cos(30 * RADIANS))
        .addScaledVector(getLocalUpVector(origin), Math.sin(30 * RADIANS));
    const sites = (params = {}) => balloonLaunchSitesOnSight({
        origin, direction, angularSize: 0.002, sizeMin: 1, sizeMax: 3, steps: 4,
        buoyancyMin: 2, buoyancyMax: 5, windError: 10 * RADIANS, maxSeconds: 7200,
        windAt: toEast(10), groundHAE: flatGround, groundHit: hitOn(flatGround), ...params,
    });

    test("puts a balloon on the line of sight for each size, at the distance that its size gives", () => {
        const {samples} = sites();
        expect(samples.map(sample => sample.size)).toEqual([1, 1.5, 2, 2.5, 3]);
        for (const sample of samples) {
            expect(sample.range).toBeCloseTo(sample.size * 500, 0);
            const toBalloon = sample.balloon.clone().sub(origin);
            expect(toBalloon.length()).toBeCloseTo(sample.range, 6);
            expect(toBalloon.normalize().dot(direction)).toBeCloseTo(1, 12);
            // 30° up: the height is half of the distance, and a little more for the curve of the Earth
            expect(sample.height).toBeGreaterThan(2 + sample.range / 2);
            expect(sample.height).toBeLessThan(2 + sample.range / 2 + 0.2);
        }
    });

    test("the center is the launch site for the middle buoyancy, and the corners are the limits", () => {
        for (const sample of sites().samples) {
            // the middle buoyancy of 2 and 5 m/s, by flight time, is 1 / 0.35
            expect(sample.center.seconds).toBeCloseTo(sample.height * 0.35, 0);
            const [fastLeft, fastRight, slowLeft, slowRight] = sample.corners;
            expect(fastLeft.seconds).toBeCloseTo(sample.height / 5, 0);
            expect(slowLeft.seconds).toBeCloseTo(sample.height / 2, 0);
            const across = site => offsetOf(sample.balloon, site.position).north;
            expect(across(fastLeft)).toBeLessThan(0);
            expect(across(fastRight)).toBeGreaterThan(0);
            // the two sides are the same to 1% (north turns a little along the path at this latitude)
            expect(across(slowLeft) / -across(slowRight)).toBeGreaterThan(0.99);
            expect(across(slowLeft) / -across(slowRight)).toBeLessThan(1.01);
            expect(Math.abs(across(slowLeft))).toBeGreaterThan(Math.abs(across(fastLeft)));
        }
    });

    test("gives an outline for each round size, or for the sizes that are asked for", () => {
        const {outlines} = sites();
        expect(outlines.map(outline => outline.size)).toEqual([1, 1.5, 2, 2.5, 3]);
        for (const outline of outlines) {
            expect(outline.loop).toHaveLength(12);
            expect(outline.spine).toHaveLength(5);
        }
        expect(sites({labelSizes: [2]}).outlines).toHaveLength(1);
    });

    test("a balloon in a calm comes from the ground below it", () => {
        const {samples} = sites({windAt: toEast(0)});
        for (const sample of samples) {
            expect(sample.windToward).toBeNull();
            const {east, north} = offsetOf(sample.balloon, sample.center.position);
            expect(Math.hypot(east, north)).toBeLessThan(0.01);
        }
    });
});
