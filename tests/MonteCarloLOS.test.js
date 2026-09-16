import fixture from "./fixtures/monteCarloWheel.json";
import {fitMonteCarloReference, MONTE_CARLO_PRESETS, prepareMonteCarloLOS,
    monteCarloTrial, evaluateMonteCarloTrial} from "../src/MonteCarloLOS";
import {fitMonteCarloGPU} from "../src/gpu/MonteCarloLOS";

const dataset = fixture.dataset;

describe("blind Monte Carlo matches the supplied CLI's controlled random trials", () => {
    test.each(fixture.cases)("polynomial order $options.order", ({options, positions, score}) => {
        const result = fitMonteCarloReference(dataset, new Set(), options);
        expect(Math.abs(result.params.bestScore - score)).toBeLessThan(1e-9);
        expect(Math.max(...result.positions.map((v, i) => Math.abs(v - positions[i])))).toBeLessThan(1e-5);
        expect(result.positions).toBeInstanceOf(Float64Array);
    });

    test("range cap, blind sampling and the one-metre scene extent floor", () => {
        const stationary = {...dataset, sensorPos: Array.from({length: dataset.count * 3}, () => 0)};
        const p = prepareMonteCarloLOS(stationary);
        expect(p.maxDistance).toBe(10);
        const capped = prepareMonteCarloLOS({...stationary, maxRange: Array(dataset.count).fill(2)});
        expect(capped.table[7]).toBe(2);
        expect(() => prepareMonteCarloLOS(dataset, new Set(), {rangeEstimates: [1]})).toThrow(/range estimates/);
    });

    test("trial prefixes are stable as the budget changes", () => {
        const small = prepareMonteCarloLOS(dataset, new Set(), {numTrials: 50});
        const large = prepareMonteCarloLOS(dataset, new Set(), {preset: "mc_1M"});
        expect(monteCarloTrial(small, 23)).toEqual(monteCarloTrial(large, 23));
        expect(Object.keys(MONTE_CARLO_PRESETS)).toEqual(["mc_50k", "mc_100k", "mc_250k", "mc_500k", "mc_1M"]);
        expect(MONTE_CARLO_PRESETS.mc_500k).toEqual({order: 1, numTrials: 500000, losUncertaintyDeg: 0.1});
        expect(MONTE_CARLO_PRESETS.mc_1M).toEqual({order: 1, numTrials: 1000000, losUncertaintyDeg: 0.1});
    });

    test("excluded observations do not affect score, but still have output positions", () => {
        const excluded = new Set([0, 4]);
        const modified = {...dataset, losDir: dataset.losDir.slice()};
        modified.losDir.fill(NaN, 0, 3); modified.losDir.fill(NaN, 12, 15);
        const opts = {numTrials: 40};
        const a = fitMonteCarloReference(dataset, excluded, opts);
        const b = fitMonteCarloReference(modified, excluded, opts);
        expect(a.positions).toEqual(b.positions);
        expect(a.params.bestScore).toBe(b.params.bestScore);
        expect(b.activeCount).toBe(dataset.count - 2);
        expect(b.residuals[0]).toBeNaN();
        expect(b.positions.every(Number.isFinite)).toBe(true);
    });

    test("large world and epoch offsets preserve the interpolated trajectory", () => {
        const opts = {order: 2, numTrials: 100};
        const shifted = {...dataset, sensorPos: dataset.sensorPos.map(v => v + 6000000),
            times: dataset.times.map(t => t + 1700000000)};
        const p = prepareMonteCarloLOS(dataset, new Set(), opts), q = prepareMonteCarloLOS(shifted, new Set(), opts);
        const a = monteCarloTrial(p, 9), b = monteCarloTrial(q, 9);
        expect(Math.max(...evaluateMonteCarloTrial(a, 0.5).map((v, i) =>
            Math.abs(v - evaluateMonteCarloTrial(b, 0.5)[i])))).toBeLessThan(0.01);
    });

    test("BOTBench shape is accepted without a scene or node graph", () => {
        const d = {S: dataset.sensorPos, D: dataset.losDir, n: dataset.count, fps: 1.2};
        const p = prepareMonteCarloLOS(d);
        expect(p.active).toHaveLength(dataset.count);
        expect(p.times[dataset.count - 1]).toBe(30);
    });

    test("reject malformed settings and times; too few observations give no fit", () => {
        expect(() => prepareMonteCarloLOS(dataset, new Set(), {preset: "mc_typo"})).toThrow(/preset/);
        expect(() => prepareMonteCarloLOS(dataset, new Set(), {order: 6})).toThrow(/order/);
        expect(() => prepareMonteCarloLOS(dataset, new Set(), {numTrials: NaN})).toThrow(/numTrials/);
        expect(() => prepareMonteCarloLOS({...dataset, times: Array(dataset.count).fill(0)})).toThrow(/increase/);
        expect(prepareMonteCarloLOS(dataset, new Set(Array.from({length: dataset.count - 1}, (_, i) => i)))).toBeNull();
    });

    test("GPU unavailability is explicit and cancellation happens before setup", async () => {
        await expect(fitMonteCarloGPU(dataset)).rejects.toThrow(/WebGPU is unavailable/);
        await expect(fitMonteCarloGPU(dataset, new Set(), {shouldCancel: () => true})).rejects.toThrow("cancelled");
    });
});
