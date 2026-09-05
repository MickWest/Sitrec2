import {differentialEvolution, mulberry32, patternSearchPolish} from "../src/DifferentialEvolution";
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

    test.each(["de", "polish"])("%s bounded costs preserve every candidate and the exact result", async (kind) => {
        const measure = async (boundedCost) => {
            const candidates = [], callbacks = [];
            let terms = 0, rejected = 0;
            const objective = (x, incumbent = Infinity) => {
                candidates.push(x.slice());
                let sum = 0;
                for (let i = 0; i < x.length; i++) {
                    sum += (x[i] - i) ** 2;
                    terms++;
                    if (sum > incumbent) { rejected++; return Infinity; }
                }
                return sum;
            };
            const options = {boundedCost, onEvaluation: payload => { callbacks.push(payload); }};
            const result = kind === "de"
                ? await differentialEvolution(objective, [-20, -20, -20], [20, 20, 20],
                    {...options, rng: mulberry32(31), pop: 10, gens: 15})
                : await patternSearchPolish(objective, [4, -3, 7], [1, 1, 1], options);
            return {result, candidates, callbacks, terms, rejected};
        };
        const full = await measure(false), bounded = await measure(true);
        expect(bounded.result).toEqual(full.result);
        expect(bounded.candidates).toEqual(full.candidates);
        expect(bounded.callbacks).toEqual(full.callbacks);
        expect(bounded.rejected).toBeGreaterThan(0);
        expect(bounded.terms).toBeLessThan(full.terms);
    });

    test("bounded DE still accepts exact ties and preserves its random sequence", async () => {
        const run = async boundedCost => differentialEvolution((x, incumbent = Infinity) => {
            expect(incumbent).toBeGreaterThanOrEqual(0);
            return 0;
        }, [-1], [1], {rng: mulberry32(12), pop: 5, gens: 3, boundedCost});
        expect(await run(true)).toEqual(await run(false));
    });

    test("bounds are opt-in and ordinary costs still receive one argument", async () => {
        const objective = jest.fn(bowl);
        await differentialEvolution(objective, [-1], [1], {pop: 5, gens: 1});
        await patternSearchPolish(objective, [1], [1], {maxIter: 2});
        expect(objective.mock.calls.every(args => args.length === 1)).toBe(true);
    });
});
