/**
 * Tests for the Kite Anchor Finder math (src/KiteAnchorFinder.js): the size in
 * the picture as an angle, the anchor of one kite, and the band of anchors for
 * a kite on a line of sight.
 *
 * Uses the real ECEF/ENU math. The ground and the wind are simple functions.
 * In Sitrec the ground query is raycastGroundElevationFast (src/raycastGround.js).
 * Here it is hitOn, a slow and simple search over a ground function.
 */

import {Vector3} from "three";
import {setSit} from "../src/Globals";
import {ECEFToLLAVD_radii, LLAToECEF} from "../src/LLA-ECEF-ENU";
import {getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "../src/SphericalMath";
import {kiteAnchorBand, niceSizes, pixelsToAngle, solveKiteAnchor} from "../src/KiteAnchorFinder";

const LAT = 61.2, LON = -149.8;
const RADIANS = Math.PI / 180;
const EAST = Math.PI / 2;      // the bearing that a west wind blows toward
const flatGround = () => 0;
const fromWest = speed => () => ({u: speed, v: 0});

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
    for (let far = HIT_STEP; far <= maxDistance; far += HIT_STEP) {
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

// The offset of a point from the kite in metres, {east, north, up}, on the axes at the kite.
// (The axes at LAT, LON are not the same 1 km away: north turns with the longitude.)
const offsetOf = (kite, point) => {
    const offset = point.clone().sub(kite);
    return {east: offset.dot(getLocalEastVector(kite)), north: offset.dot(getLocalNorthVector(kite)), up: offset.dot(getLocalUpVector(kite))};
};
const offsetFrom = (kite, anchor) => offsetOf(kite, anchor.position);

// getLocalNorthVector asserts Sit.lat/Sit.lon are defined. The describe blocks
// below make their fixtures with it, so this must run before them, not in a beforeEach.
setSit({name: "test", frames: 300, fps: 30, lat: LAT, lon: LON});

describe("pixelsToAngle", () => {
    test("in the middle of the picture, the angle is that of the pixels at the focal length", () => {
        expect(pixelsToAngle(10, 1000)).toBeCloseTo(2 * Math.atan(5 / 1000), 12);
    });

    test("away from the middle, the same pixels are a smaller angle", () => {
        const middle = pixelsToAngle(10, 1000);
        const side = pixelsToAngle(10, 1000, 600, 0);
        // along the direction away from the middle, the angle goes with cos² of the angle off the axis
        expect(side / middle).toBeCloseTo(Math.cos(Math.atan(0.6)) ** 2, 3);
        expect(pixelsToAngle(10, 1000, 0, 600) / middle).toBeCloseTo(Math.cos(Math.atan(0.6)), 3);
    });
});

describe("niceSizes", () => {
    test("gives round sizes with the two limits", () => {
        expect(niceSizes(1, 5)).toEqual([1, 2, 3, 4, 5]);
        expect(niceSizes(0.5, 3)).toEqual([0.5, 1, 1.5, 2, 2.5, 3]);
        expect(niceSizes(1.3, 14)).toEqual([1.3, 5, 10, 14]);
    });

    test("one size gives one label", () => {
        expect(niceSizes(2, 2)).toEqual([2]);
    });
});

describe("solveKiteAnchor", () => {
    const kite = LLAToECEF(LAT, LON, 50);
    const solve = (params = {}) => solveKiteAnchor({kite, windToward: EAST, flightAngle: 45 * RADIANS,
        maxLineLength: 300, groundHit: hitOn(flatGround), ...params});

    test("over flat ground, the anchor is upwind by the height divided by the tangent of the flight angle", () => {
        const anchor = solve();
        const {east, north, up} = offsetFrom(kite, anchor);
        expect(east).toBeCloseTo(-50, 1);
        expect(north).toBeCloseTo(0, 1);
        expect(up).toBeCloseTo(-50, 1);
        expect(anchor.distance).toBeCloseTo(50, 1);
        expect(anchor.lineLength).toBeCloseTo(50 * Math.SQRT2, 1);
        expect(anchor.groundHAE).toBeCloseTo(0, 3);
    });

    test("asks the ground query for one ray: from the kite, upwind and down at the flight angle, to the line limit", () => {
        const asked = [];
        solve({flightAngle: 30 * RADIANS, maxLineLength: 120, groundHit: (...query) => { asked.push(query); return null; }});
        expect(asked).toHaveLength(1);
        const [origin, direction, maxDistance] = asked[0];
        expect(origin.distanceTo(kite)).toBe(0);
        expect(maxDistance).toBe(120);
        expect(direction.length()).toBeCloseTo(1, 12);
        // the wind blows toward the east, so upwind is west
        expect(direction.dot(getLocalEastVector(kite))).toBeCloseTo(-Math.cos(30 * RADIANS), 12);
        expect(direction.dot(getLocalNorthVector(kite))).toBeCloseTo(0, 12);
        expect(direction.dot(getLocalUpVector(kite))).toBeCloseTo(-Math.sin(30 * RADIANS), 12);
    });

    test("a narrow ridge between the kite and the far ground holds the anchor: the first contact, not the ground beyond", () => {
        // A wall 3 m thick and 40 m high, 20 m to the west of the kite. The line is 30 m up there.
        const groundHAE = (lat, lon) => (eastOf(lon) <= -20 && eastOf(lon) >= -23 ? 40 : 0);
        const anchor = solve({groundHit: hitOn(groundHAE)});
        expect(anchor.distance).toBeCloseTo(20, 0);
        expect(anchor.lineLength).toBeCloseTo(20 * Math.SQRT2, 0);
    });

    test("no anchor when the ground query answers past the line limit", () => {
        // the flat ground is 70.7 m along the line; this query does not respect its limit
        expect(solve({maxLineLength: 60, groundHit: (origin, direction) => hitOn(flatGround)(origin, direction, 300)})).toBeNull();
    });

    test("a lower flight angle puts the anchor farther away", () => {
        expect(solve({flightAngle: 30 * RADIANS}).distance).toBeCloseTo(50 / Math.tan(30 * RADIANS), 1);
        expect(solve({flightAngle: 60 * RADIANS}).distance).toBeCloseTo(50 / Math.tan(60 * RADIANS), 1);
    });

    test("the anchor is on the side that the wind comes from", () => {
        // a wind toward the north-east: the anchor is to the south-west
        const {east, north} = offsetFrom(kite, solve({windToward: 45 * RADIANS}));
        expect(east).toBeCloseTo(-50 * Math.SQRT1_2, 1);
        expect(north).toBeCloseTo(-50 * Math.SQRT1_2, 1);
    });

    test("ground that rises upwind brings the anchor nearer", () => {
        // the ground rises 1 m for each 4 m to the west of the kite
        const groundHAE = (lat, lon) => -eastOf(lon) * 0.25;
        const anchor = solve({groundHit: hitOn(groundHAE)});
        // the line goes down 1 m in each metre, and the ground comes up 0.25 m: they meet at 50 / 1.25
        expect(anchor.distance).toBeCloseTo(40, 1);
        expect(anchor.groundHAE).toBeCloseTo(10, 1);
        expect(anchor.lineLength).toBeCloseTo(40 * Math.SQRT2, 1);
    });

    test("a kite in the ground has no anchor", () => {
        expect(solve({groundHit: hitOn(() => 60)})).toBeNull();
    });

    test("no anchor when the line would be longer than the limit", () => {
        expect(solve({maxLineLength: 70})).toBeNull();
        expect(solve({maxLineLength: 72})).not.toBeNull();
    });
});

describe("kiteAnchorBand", () => {
    // A camera on the ground that looks east and 5° up. An object of 2 mrad is 500 m away for each metre of its size.
    const origin = LLAToECEF(LAT, LON, 2);
    const direction = getLocalEastVector(origin).multiplyScalar(Math.cos(5 * RADIANS))
        .addScaledVector(getLocalUpVector(origin), Math.sin(5 * RADIANS));
    const band = (params = {}) => kiteAnchorBand({
        origin, direction, angularSize: 0.002, sizeMin: 1, sizeMax: 3,
        flightAngleMin: 30 * RADIANS, flightAngleMax: 60 * RADIANS, windError: 20 * RADIANS,
        maxLineLength: 1000, windAt: fromWest(5), groundHAE: flatGround, groundHit: hitOn(flatGround), steps: 8, ...params,
    });

    test("puts a kite on the line of sight for each size, at the distance that its size gives", () => {
        const {samples} = band();
        expect(samples).toHaveLength(9);
        expect(samples.map(sample => sample.size)).toEqual([1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3]);
        for (const sample of samples) {
            expect(sample.range).toBeCloseTo(sample.size * 500, 0);
            // the kite is on the line of sight
            const toKite = sample.kite.clone().sub(origin);
            expect(toKite.length()).toBeCloseTo(sample.range, 6);
            expect(toKite.normalize().dot(direction)).toBeCloseTo(1, 12);
            expect(sample.windToward).toBeCloseTo(EAST, 12);
            expect(sample.windSpeed).toBeCloseTo(5, 12);
        }
        // 5° up: a kite 500 m away is about 46 m above the ground, with the curve of the Earth
        expect(samples[0].height).toBeGreaterThan(2 + 500 * Math.sin(5 * RADIANS));
        expect(samples[0].height).toBeLessThan(2 + 500 * Math.sin(5 * RADIANS) + 0.1);
    });

    test("the center anchor is upwind of each kite, at the middle flight angle", () => {
        for (const sample of band().samples) {
            expect(sample.center.distance).toBeCloseTo(sample.height / Math.tan(45 * RADIANS), 1);
            const {east, north} = offsetFrom(sample.kite, sample.center);
            expect(east).toBeCloseTo(-sample.center.distance, 1);
            expect(Math.abs(north)).toBeLessThan(0.05);
        }
    });

    test("the corners are the two flight angles with the wind turned to each side", () => {
        const sample = band().samples[4];
        const [lowLeft, lowRight, highLeft, highRight] = sample.corners;
        expect(lowLeft.distance).toBeCloseTo(sample.height / Math.tan(30 * RADIANS), 1);
        expect(highLeft.distance).toBeCloseTo(sample.height / Math.tan(60 * RADIANS), 1);
        // a wind error to one side moves the anchor across the wind by distance × sin(error)
        const across = anchor => offsetFrom(sample.kite, anchor).north;
        expect(across(lowLeft)).toBeCloseTo(-lowLeft.distance * Math.sin(20 * RADIANS), 1);
        expect(across(lowRight)).toBeCloseTo(lowRight.distance * Math.sin(20 * RADIANS), 1);
        expect(across(highLeft)).toBeCloseTo(-across(highRight), 1);
    });

    test("gives an outline around the anchors of each round size", () => {
        const {outlines} = band();
        expect(outlines.map(outline => outline.size)).toEqual([1, 1.5, 2, 2.5, 3]);
        for (const outline of outlines) {
            expect(outline.loop).toHaveLength(14);
            expect(outline.loop[0]).toBeInstanceOf(Vector3);
            // every point of the outline is on the ground, and upwind of the kite
            for (const point of outline.loop) {
                const {east, up} = offsetOf(outline.kite, point);
                expect(east).toBeLessThan(0);
                expect(up).toBeCloseTo(-outline.height, 0);
            }
        }
        expect(band({labelSizes: [2]}).outlines).toHaveLength(1);
    });

    test("a calm gives no anchors", () => {
        const {samples, outlines} = band({windAt: fromWest(0.2)});
        for (const sample of samples) {
            expect(sample.windToward).toBeNull();
            expect(sample.center).toBeNull();
            expect(sample.corners).toEqual([null, null, null, null]);
        }
        expect(outlines.every(outline => outline.loop === null && outline.center === null)).toBe(true);
    });

    test("the line limit removes the kites that are too high", () => {
        // at 45° the line is height × √2, so a 150 m line holds a kite to 106 m, which is a size of about 2.4 m
        const {samples, outlines} = band({maxLineLength: 150});
        expect(samples.filter(sample => sample.center).map(sample => sample.size)).toEqual([1, 1.25, 1.5, 1.75, 2, 2.25]);
        // at 30° the line is height × 2, so the outline of the 2 m kite (89 m up) is not complete
        const twoMetres = outlines.find(outline => outline.size === 2);
        expect(twoMetres.center).not.toBeNull();
        expect(twoMetres.loop).toBeNull();
    });

    test("the wind at each kite is asked for at the position and height of that kite", () => {
        const asked = [];
        const {samples} = band({steps: 1, labelSizes: [], windAt: (lat, lon, hae) => { asked.push({lat, lon, hae}); return {u: 5, v: 0}; }});
        expect(asked).toHaveLength(2);
        asked.forEach((point, index) => {
            expect(point.lat).toBeCloseTo(samples[index].lat, 12);
            expect(point.lon).toBeCloseTo(samples[index].lon, 12);
            expect(point.hae).toBeCloseTo(samples[index].hae, 9);
        });
    });
});
