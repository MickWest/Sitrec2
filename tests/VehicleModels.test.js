/**
 * Tests for the vehicle-model catalog and nearest-model classifiers
 * (src/VehicleModels.js). Pure data + arithmetic — no three.js / node graph.
 */

import {
    QUADCOPTER_MODELS, FIXED_WING_MODELS,
    quadcopterById, fixedWingById,
    classifyQuadcopter, classifyFixedWing,
} from "../src/VehicleModels";

describe("VehicleModels catalog", () => {
    test("first entry of each catalog is the AUTO envelope", () => {
        expect(QUADCOPTER_MODELS[0].auto).toBe(true);
        expect(FIXED_WING_MODELS[0].auto).toBe(true);
    });

    test("only the AUTO entries are flagged auto", () => {
        expect(QUADCOPTER_MODELS.filter(m => m.auto)).toHaveLength(1);
        expect(FIXED_WING_MODELS.filter(m => m.auto)).toHaveLength(1);
    });

    test("envelopes are internally consistent (min < max, positive rates)", () => {
        for (const m of FIXED_WING_MODELS) {
            expect(m.tasMin).toBeGreaterThan(0);
            expect(m.tasMax).toBeGreaterThan(m.tasMin);
            expect(m.cruise).toBeGreaterThanOrEqual(m.tasMin);
            expect(m.cruise).toBeLessThanOrEqual(m.tasMax);
            expect(m.climbMax).toBeGreaterThan(0);
        }
        for (const m of QUADCOPTER_MODELS) {
            expect(m.maxSpeed).toBeGreaterThan(0);
            expect(m.maxAscent).toBeGreaterThan(0);
            expect(m.maxDescent).toBeGreaterThan(0);
        }
    });

    test("lookup by id, unknown falls back to AUTO", () => {
        expect(quadcopterById("djifpv").name).toBe("DJI FPV");
        expect(fixedWingById("f16").tasMax).toBe(600);
        expect(quadcopterById("nope").auto).toBe(true);
        expect(fixedWingById("nope").auto).toBe(true);
    });
});

describe("classifyFixedWing", () => {
    test("a slow GA speed maps to the Cessna 172", () => {
        expect(classifyFixedWing(64, 2).model.id).toBe("c172");
    });
    test("airliner cruise, gentle climb maps to the 737", () => {
        expect(classifyFixedWing(230, 8).model.id).toBe("b737");
    });
    test("fast cruise with a steep climb only a fighter can do", () => {
        // 235 m/s and 200 m/s climb: both jets share cruise 235; ties resolve to
        // the first in catalog order (F/A-18). Either way it must be a fighter.
        const m = classifyFixedWing(235, 200).model;
        expect(m.gMax).toBeGreaterThanOrEqual(7);
        expect(["fa18", "f35", "f16"]).toContain(m.id);
    });
    test("never returns the AUTO entry", () => {
        expect(classifyFixedWing(195, 0).model.auto).toBeFalsy();
    });
});

describe("classifyQuadcopter", () => {
    test("a slow, low-climb object is a small consumer drone", () => {
        expect(classifyQuadcopter(15, 4).model.id).toBe("mini4");
    });
    test("a fast object needs an FPV drone, not a camera drone", () => {
        expect(classifyQuadcopter(35, 8).model.id).toBe("djifpv");
    });
    test("beyond every drone's envelope, the fastest is chosen", () => {
        const result = classifyQuadcopter(80, 40);
        expect(result.model.id).toBe("racer");
        expect(result.compatible).toBe(false);
    });
    test("prefers the snug (least-capable sufficient) model", () => {
        // 18 m/s exceeds the Mini 4 (16) but fits the Phantom 4 Pro (20),
        // Air 3 / Mavic 3 (21). The snuggest envelope wins: P4P at 20 m/s is a
        // tighter fit than 21, so it is chosen over the faster camera drones.
        expect(classifyQuadcopter(18, 5).model.id).toBe("p4p");
    });
    test("never returns the AUTO entry", () => {
        expect(classifyQuadcopter(10, 2).model.auto).toBeFalsy();
    });

    test("descents are checked against maxDescent, not ascent capability", () => {
        // +5.5 m/s CLIMB fits the P4P (maxAscent 6) — snuggest envelope wins.
        const ascent = classifyQuadcopter(18, 5.5);
        expect(ascent.model.id).toBe("p4p");
        expect(ascent.compatible).toBe(true);
        // -5.5 m/s DESCENT does NOT fit the P4P (maxDescent 4): the classifier
        // must pick a drone that can actually descend that fast. A sign-blind
        // check against max(ascent, descent) wrongly kept the P4P here.
        const descent = classifyQuadcopter(18, -5.5);
        expect(descent.model.maxDescent).toBeGreaterThanOrEqual(5.5);
        expect(descent.model.id).toBe("air3");
        expect(descent.compatible).toBe(true);
    });

    test("altitude beyond every catalog ceiling is not a contained motion", () => {
        expect(classifyQuadcopter(18, 0, 1000).compatible).toBe(true);
        expect(classifyQuadcopter(18, 0, 7000).compatible).toBe(false);
    });

    test("reports whether the nearest named catalog envelope actually contains the motion", () => {
        expect(classifyQuadcopter(50, 20).compatible).toBe(true);
        expect(classifyQuadcopter(58, 20).compatible).toBe(false);
        expect(classifyFixedWing(230, 8).compatible).toBe(true);
        expect(classifyFixedWing(650, 0).compatible).toBe(false);
        expect(classifyFixedWing(230, 8, 12, 25000).compatible).toBe(false); // exceeds every catalog envelope
    });

    test("converts maneuver acceleration to load factor before applying structural-g limits", () => {
        // 3.7 g of maneuver acceleration corresponds to sqrt(1+3.7^2)=3.83 g
        // load factor, just beyond the C172 catalog limit of 3.8 g.
        expect(classifyFixedWing(64, 2, 3.7, 1000).compatible).toBe(false);
    });
});
