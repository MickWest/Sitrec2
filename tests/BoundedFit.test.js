import {assessBoundPins} from "../src/BoundedFit";

describe("assessBoundPins", () => {
    test("marks a genuinely load-bearing upper bound", () => {
        // Unconstrained optimum is x=2, outside the tested [0,1] interval.
        const pins = assessBoundPins([1], [0], [1], ["x"],
            ([x]) => (x - 2) ** 2, {absoluteTolerance: 1e-6});
        expect(pins).toHaveLength(1);
        expect(pins[0]).toMatchObject({name: "x", side: "hi", loadBearing: true});
        expect(pins[0].deltaCost).toBeGreaterThan(0);
    });

    test("does not treat an inactive flat parameter as a capability limit", () => {
        const pins = assessBoundPins([1, 0.25], [0, 0], [1, 1], ["inactive", "active"],
            ([, y]) => (y - 0.25) ** 2);
        expect(pins).toHaveLength(1);
        expect(pins[0]).toMatchObject({name: "inactive", side: "hi", loadBearing: false});
        expect(pins[0].deltaCost).toBeCloseTo(0, 12);
    });

    test("records when an inward probe is actually better", () => {
        const pins = assessBoundPins([1], [0], [1], ["x"], ([x]) => x ** 2,
            {absoluteTolerance: 1e-6});
        expect(pins[0]).toMatchObject({loadBearing: false, inwardBetter: true});
        expect(pins[0].deltaCost).toBeLessThan(0);
    });

    test("dedicated exclusions omit circular or otherwise arbitrary bounds", () => {
        const pins = assessBoundPins([1, 1], [0, 0], [1, 1], ["keep", "skip"],
            ([x, y]) => (x - 2) ** 2 + (y - 2) ** 2, {excludeIndices: [1]});
        expect(pins.map((p) => p.name)).toEqual(["keep"]);
    });
});
