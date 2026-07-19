/**
 * The soft priors in each physics model are implemented TWICE: once in
 * `extraCost` (inside the optimizer's inner loop) and once, itemised, in
 * `extraCostTerms` (display only). That duplication is deliberate — summing an
 * itemised object would reorder floating-point additions and could nudge the
 * search onto a different path, and reporting must never perturb a fit.
 *
 * The cost of that choice is that the two can silently drift apart, at which
 * point the UI would confidently report a breakdown that does not describe the
 * priors actually applied. These tests are what makes the duplication safe:
 * they assert the itemisation sums to the real cost across the parameter space,
 * including the branches (wind prior set vs not, negative shear, below-surface
 * profile, above-top-speed) that only fire for some parameter values.
 */

import {SkyLanternModel} from "../src/SkyLanternModel";
import {QuadcopterModel} from "../src/QuadcopterModel";
import {FixedWingModel} from "../src/FixedWingModel";

// Minimal dataset: the models only read sensorPos/losDir at frame 0 for the
// start position, plus T for the profile sampling.
const dataset = {
    sensorPos: new Float64Array([0, 0, 500]),
    losDir: new Float64Array([0.6, 0.5, 0.62]),
    times: new Float64Array([0, 1]),
    count: 2,
};
const T = 60;

function sumTerms(model, params) {
    const terms = model.extraCostTerms(params, dataset, T);
    return Object.values(terms).reduce((a, b) => a + b, 0);
}

function agrees(model, params) {
    const direct = model.extraCost(params, dataset, T);
    const itemised = sumTerms(model, params);
    // Loose relative tolerance: the two sum in different orders by design.
    expect(itemised).toBeCloseTo(direct, 6);
    return {direct, itemised};
}

describe("prior itemisation matches the cost actually applied", () => {
    describe("SkyLanternModel", () => {
        // [initialRange, windE, windN, shearPerM, vRise, vSink, tBurn, tauCool]
        const base = [3000, 5, -3, 0.001, 1.5, 1.0, 60, 60];

        test("calm-wind branch (no wind prior)", () => {
            const m = new SkyLanternModel();
            const {direct} = agrees(m, base);
            expect(direct).toBeGreaterThan(0);
            expect(Object.keys(m.extraCostTerms(base, dataset, T)))
                .toContain("calm-wind preference");
        });

        test("measured-wind branch (prior set) replaces the calm term", () => {
            const m = new SkyLanternModel();
            m.windPriorE = 5; m.windPriorN = -3;
            agrees(m, base);
            const keys = Object.keys(m.extraCostTerms(base, dataset, T));
            expect(keys).toContain("wind toward measured");
            expect(keys).not.toContain("calm-wind preference");
        });

        test("negative shear adds a term only when shear is negative", () => {
            const m = new SkyLanternModel();
            const neg = [...base]; neg[3] = -0.002;
            agrees(m, neg);
            expect(Object.keys(m.extraCostTerms(neg, dataset, T))).toContain("negative shear");
            expect(Object.keys(m.extraCostTerms(base, dataset, T))).not.toContain("negative shear");
        });

        test("a profile driven below the surface adds its own term", () => {
            const m = new SkyLanternModel();
            // Start low and sink for long enough that the closed-form altitude
            // profile actually goes under. tBurn negative = already past the
            // flame phase, so vz is the terminal sink from t=0.
            const lowStart = {
                ...dataset,
                sensorPos: new Float64Array([0, 0, 100]),
                losDir: new Float64Array([0.79, 0.5, 0.35]),
            };
            const longT = 300;   // 4 m/s of sink for 300 s clears any start altitude here
            const down = [300, 0, 0, 0.001, 0, 4, -1200, 60];
            const direct = m.extraCost(down, lowStart, longT);
            const terms = m.extraCostTerms(down, lowStart, longT);
            expect(Object.values(terms).reduce((a, b) => a + b, 0)).toBeCloseTo(direct, 6);
            expect(Object.keys(terms)).toContain("below-surface profile");
        });

        test("a strong wind costs far more than a light one (prior has a gradient)", () => {
            const m = new SkyLanternModel();
            const light = [...base]; light[1] = 1; light[2] = 0;
            const strong = [...base]; strong[1] = 20; strong[2] = 0;
            expect(m.extraCost(strong, dataset, T)).toBeGreaterThan(
                m.extraCost(light, dataset, T) + 1);
        });
    });

    describe("QuadcopterModel", () => {
        // [.., .., speed, accel, .., turnAccel, .., windE, windN]
        const base = [2000, 0, 5, 0, 0, 1, 0, 2, 1];

        test("calm-wind fallback branch", () => {
            agrees(new QuadcopterModel(), base);
        });

        test("measured-wind branch", () => {
            const m = new QuadcopterModel();
            m.windPriorE = 2; m.windPriorN = 1;
            agrees(m, base);
        });

        test("exceeding rotor top speed adds a term", () => {
            const m = new QuadcopterModel();
            const fast = [...base]; fast[2] = 200;
            agrees(m, fast);
            expect(Object.keys(m.extraCostTerms(fast, dataset, T)))
                .toContain("above rotor top speed");
        });
    });

    describe("FixedWingModel", () => {
        // [.., .., tas, turnRate, turnAccel, climb, windE, windN]
        const base = [8000, 0, 120, 0.5, 0.001, 2, 0, 0];

        test("turn/climb/cruise priors itemise correctly", () => {
            const m = new FixedWingModel();
            agrees(m, base);
            const keys = Object.keys(m.extraCostTerms(base, dataset, T));
            // These push AGAINST maneuvering — the anomaly-side counterpart of
            // the balloon's calm-wind prior, and equally in need of disclosure.
            expect(keys).toEqual(expect.arrayContaining(
                ["turn at start", "turn at end", "climb/descent", "off cruise speed"]));
        });

        test("with a wind prior set", () => {
            const m = new FixedWingModel();
            m.windPriorE = 3; m.windPriorN = -1;
            agrees(m, base);
            expect(Object.keys(m.extraCostTerms(base, dataset, T)))
                .toContain("wind toward measured");
        });
    });

    test("the base class degrades to a single total rather than throwing", () => {
        const {PhysicsModel} = require("../src/PhysicsModel");
        const m = new PhysicsModel();
        expect(m.extraCostTerms([], dataset, T)).toEqual({});
        m.extraCost = () => 2.5;
        expect(m.extraCostTerms([], dataset, T)).toEqual({"model priors": 2.5});
    });
});
