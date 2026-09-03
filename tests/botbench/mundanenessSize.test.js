/**
 * mundanenessSize.test.js — the implied-size interval, and the difference
 * between "small" and "unmeasured".
 *
 * A published angular bound is `max(theta, IFOV) + IFOV`. When the target is
 * smaller than a pixel that collapses to exactly `2 * IFOV`, the interval's
 * lower end goes to zero, and the statement degrades from "the object is
 * between lo and hi" to "the object is under hi". Both are useful; only one is
 * a measurement of size, and the display must not present the second as the
 * first.
 *
 * The numbers below are the real ones from
 * `botset_balloons_straight/batch_20s/0.0deg`: a 3 deg field over 640 px, a
 * published bound of 0.009375 deg on every scenario, and a 0.35 m party balloon
 * at 6.4-80.7 km slant.
 */

import {impliedDiameter, mundanenessCost} from "../../src/TraverseMundaneness";

const FOV = 3;          // degrees, full frame width
const PIXELS = 640;
const IFOV = FOV / PIXELS;               // 0.0046875 deg
const SUB_PIXEL_BOUND = 2 * IFOV;        // 0.009375 deg — the floor
const TRUTH_RANGE_M = 13993;             // the r12.875 km scenario, slant

/** A candidate with just enough metrics for the cost function to judge it. */
function candidate({rangeM, speedKt = 5, gMax = 0.01}) {
    return {
        metricsFull: {
            range: {mean: rangeM},
            // mundanenessCost divides by KNOTS_TO_MS, so feed it m/s.
            airSpeed: {mean: speedKt * 0.514444},
            gLoad: {max: gMax},
        },
    };
}

const DATASET = {
    angularDiameterMaxDeg: SUB_PIXEL_BOUND,
    fovFullDeg: FOV,
    pixelsAcross: PIXELS,
};

describe("implied size interval", () => {

    test("a sub-pixel target gives a one-sided bound, not an interval", () => {
        const d = impliedDiameter(TRUTH_RANGE_M, SUB_PIXEL_BOUND, FOV, PIXELS);
        expect(d.lo).toBe(0);
        expect(d.oneSided).toBe(true);
        // The upper end is real and worth reporting: 2 px at 14 km.
        expect(d.hi).toBeCloseTo(TRUTH_RANGE_M * SUB_PIXEL_BOUND / (180 / Math.PI), 6);
    });

    test("a resolved target keeps both ends", () => {
        // Ten pixels across — what FRAME_FRACTION_TARGET aims for.
        const d = impliedDiameter(TRUTH_RANGE_M, 10 * IFOV, FOV, PIXELS);
        expect(d.lo).toBeGreaterThan(0);
        expect(d.oneSided).toBe(false);
        expect(d.lo).toBeLessThan(d.hi);
    });

    test("with no sensor geometry declared the bound stays one-sided", () => {
        // Reachable by importing a BOT CSV without its sidecar: the angular
        // column rides on the CSV, the sensor block only on scenario.json.
        // The published quantity is an UPPER bound, so with no IFOV to say how
        // much of it is resolution, zero is the only defensible lower end.
        // Subtracting nothing and calling the result exact would invent a lower
        // bound the file never asserted.
        const d = impliedDiameter(TRUTH_RANGE_M, 0.01, null, null);
        expect(d.lo).toBe(0);
        expect(d.oneSided).toBe(true);
        expect(d.hi).toBeCloseTo(TRUTH_RANGE_M * 0.01 / (180 / Math.PI), 6);
    });

    test("a sidecar-less import cannot manufacture a size cost", () => {
        // The teeth of the case above. Pinned at hi = 2.44 m the implied size
        // sits ABOVE the bird and multirotor ceilings and BELOW the airliner
        // floor, so a point interval charges every class something. The honest
        // interval [0, 2.44] overlaps four classes and charges nothing.
        const noSensor = {angularDiameterMaxDeg: 0.01, fovFullDeg: null, pixelsAcross: null};
        const cost = mundanenessCost(noSensor, candidate({rangeM: TRUTH_RANGE_M}));
        expect(cost.sizeCost).toBe(0);
        expect(cost.impliedM.oneSided).toBe(true);
    });

    test("no angular measurement at all returns null", () => {
        expect(impliedDiameter(TRUTH_RANGE_M, 0, FOV, PIXELS)).toBeNull();
        expect(impliedDiameter(0, SUB_PIXEL_BOUND, FOV, PIXELS)).toBeNull();
    });
});

describe("what the one-sided bound still costs", () => {

    // This is the guard that matters. The sub-pixel bound is NOT no evidence:
    // it refutes any candidate close enough that even one pixel would be
    // smaller than the smallest real object. Zeroing the size term on
    // `oneSided` would silently discard that, so the two cases are pinned.

    test("it costs nothing at the true range — every class overlaps [0, hi]", () => {
        const cost = mundanenessCost(DATASET, candidate({rangeM: TRUTH_RANGE_M}));
        expect(cost.sizeCost).toBe(0);
        expect(cost.impliedM.oneSided).toBe(true);
    });

    test("it refutes a candidate collapsed inside the break-even range", () => {
        // Break-even is D_min / theta_max = 0.10 / 1.6362e-4 = 611 m for the
        // smallest class there is. Inside that, one pixel is smaller than a
        // bird and no class can fit.
        const cost = mundanenessCost(DATASET, candidate({rangeM: 500}));
        expect(cost.sizeCost).toBeGreaterThan(0);
        // 0.10 m against an implied upper bound of 500 * 1.6362e-4 = 0.0818 m.
        expect(cost.sizeCost).toBeCloseTo(Math.log10(0.10 / (500 * SUB_PIXEL_BOUND / (180 / Math.PI))), 6);
    });

    test("the break-even range is where the cost turns on", () => {
        const justInside = mundanenessCost(DATASET, candidate({rangeM: 600}));
        const justOutside = mundanenessCost(DATASET, candidate({rangeM: 620}));
        expect(justInside.sizeCost).toBeGreaterThan(0);
        expect(justOutside.sizeCost).toBe(0);
    });
});

describe("the balloon cell scores as measured", () => {

    // Regression pin on the published result: over the 20 straight-balloon
    // scenarios no winning candidate paid any size cost. If a future change to
    // the class table or the bound makes one of these non-zero, that is a real
    // change to a published number and should fail here first.

    test.each([6356, 13993, 32650, 80653])(
        "a drifting balloon at %i m is entirely ordinary", (rangeM) => {
            const cost = mundanenessCost(DATASET, candidate({rangeM, speedKt: 20, gMax: 0.05}));
            expect(cost.total).toBe(0);
            expect(cost.key).toBe("balloon");
        });
});
