import {differentialEvolution, patternSearchPolish} from "../src/DifferentialEvolution";
import {nelderMead} from "../src/NelderMead";

describe("optimizer cooperation", () => {
    const bowl = ([x, y = 0]) => x * x + y * y;

    test("differential evolution can cancel inside the initial population", async () => {
        let callbacks = 0;
        const result = await differentialEvolution(bowl, [-10, -10], [10, 10], {
            pop: 10, gens: 20,
            onEvaluation: () => ++callbacks < 7,
        });
        expect(result.cancelled).toBe(true);
        expect(result.stopReason).toBe("cancelled");
        expect(result.evaluations).toBe(7);
        expect(callbacks).toBe(7);
        expect(result.generations).toBe(0);
    });

    test("Nelder-Mead can cancel during local refinement", async () => {
        let callbacks = 0;
        const result = await nelderMead(bowl, [4, -3], {
            maxIter: 100,
            onEvaluation: () => ++callbacks < 6,
        });
        expect(result.cancelled).toBe(true);
        expect(result.stopReason).toBe("cancelled");
        expect(result.evaluations).toBe(6);
    });

    test("pattern-search polish can cancel between candidates", async () => {
        let callbacks = 0;
        const result = await patternSearchPolish(bowl, [4, -3], [1, 1], {
            maxIter: 100,
            onEvaluation: () => ++callbacks < 5,
        });
        expect(result.cancelled).toBe(true);
        expect(result.stopReason).toBe("cancelled");
        expect(result.evaluations).toBe(5);
    });

    test("all optimizers normalize non-finite objectives to Infinity", async () => {
        const de = await differentialEvolution(() => NaN, [-1], [1], {pop: 5, gens: 2});
        const nm = await nelderMead(() => NaN, [0], {maxIter: 2});
        const ps = await patternSearchPolish(() => NaN, [0], [1], {maxIter: 2});
        expect(de.cost).toBe(Infinity);
        expect(nm.cost).toBe(Infinity);
        expect(ps.cost).toBe(Infinity);
    });
});
