import {losFitCostFrames, LOS_FIT_SAMPLE_INTERVAL_SEC} from "../src/LOSFitSampling";
import {fitPhysicsModel} from "../src/LOSFitting";
import {fitAircraft} from "../src/TraverseAnalysis";
import {PhysicsModel} from "../src/PhysicsModel";

describe("LOS optimizer observation cadence", () => {
    test.each([20, 40, 60, 120, 180, 240, 300])("keeps all %i observations at 1 Hz", count => {
        const {frames, sampling} = losFitCostFrames({count, fps: 1}, new Set(),
            {sampleIntervalSec: LOS_FIT_SAMPLE_INTERVAL_SEC});
        expect(frames).toEqual(Array.from({length: count}, (_, f) => f));
        expect(sampling).toMatchObject({activeCount: count, objectiveCount: count, maxGapSec: 1});
    });

    test("preserves the 10 Hz aircraft/physics sampling and both endpoints", () => {
        const ds = {count: 1201, fps: 10};
        const timed = losFitCostFrames(ds, new Set(), {sampleIntervalSec: 0.5});
        const legacy = losFitCostFrames(ds, new Set(), {sampleStride: 5});
        expect(timed.frames).toEqual(legacy.frames);
        expect(timed.sampling.objectiveCount).toBe(241);
        expect(timed.frames.at(-1)).toBe(1200);
    });

    test.each([2, 10, 30])("uses the same half-second cadence at %i Hz", fps => {
        const {frames} = losFitCostFrames({count: 10 * fps + 1, fps}, new Set(), {sampleIntervalSec: 0.5});
        expect(frames.map(f => f / fps)).toEqual(Array.from({length: 21}, (_, i) => i / 2));
    });

    test("uses actual timestamps, supports exclusions and retains a short final interval", () => {
        const times = Float64Array.from([0, 0.1, 0.5, 0.6, 1, 1.1, 1.2], t => 1750000000 + t);
        const result = losFitCostFrames({count: times.length, times}, new Set([0, 4]), {sampleIntervalSec: 0.5});
        expect(result.frames).toEqual([1, 3, 5, 6]);
        expect(result.sampling.activeCount).toBe(5);
        expect(result.sampling.maxGapSec).toBeCloseTo(0.5);
    });

    test("explicit legacy strides take precedence and count active observations", () => {
        expect(losFitCostFrames({count: 10, fps: 1}, new Set([0, 2]),
            {sampleStride: 5, sampleIntervalSec: 0.5}).frames).toEqual([1, 7, 9]);
        expect(losFitCostFrames({count: 0, fps: 1}).frames).toEqual([]);
        expect(losFitCostFrames({count: 1, fps: 1}, new Set([0])).frames).toEqual([]);
    });

    test("physics optimization sees the observations hidden by the old stride", async () => {
        class FixedPosition extends PhysicsModel {
            getName() { return "Fixed position"; }
            getParameterDefs() { return [{name: "x", min: -200, max: 200, default: 0, scale: 20}]; }
            getInitialState([x]) { return [x, 1000, 0, 0, 0, 0]; }
        }
        const count = 6;
        const dataset = {count, sensorPos: new Float64Array(count * 3),
            times: Float64Array.from({length: count}, (_, f) => f), losDir: new Float64Array(count * 3)};
        for (let f = 0; f < count; f++) {
            const x = f === 0 || f === 5 ? 0 : 100;
            dataset.losDir[f * 3] = x / Math.hypot(x, 1000);
            dataset.losDir[f * 3 + 1] = 1000 / Math.hypot(x, 1000);
        }
        const opts = {optimizer: "nm", maxIter: 200};
        const oldFit = await fitPhysicsModel(dataset, new Set(), new FixedPosition(), {...opts, sampleStride: 5});
        const newFit = await fitPhysicsModel(dataset, new Set(), new FixedPosition(), {...opts, sampleIntervalSec: 0.5});
        expect(oldFit.params.sampling.frameIndices).toEqual([0, 5]);
        expect(newFit.params.sampling.frameIndices).toEqual([0, 1, 2, 3, 4, 5]);
        expect(newFit.params.solved.x).toBeCloseTo(100, 1);
        expect(newFit.params.errDeg).toBeLessThan(oldFit.params.errDeg);
    });

    test("aircraft defaults retain sparse observations while preserving explicit legacy override", async () => {
        const n = 20, S = new Float64Array(n * 3), D = new Float64Array(n * 3);
        for (let f = 0; f < n; f++) {
            S[f * 3] = 50 * f; S[f * 3 + 1] = 0.5 * f * f;
            const x = 5000 - S[f * 3], y = 4000 + 100 * f - S[f * 3 + 1];
            const length = Math.hypot(x, y, 500);
            D[f * 3] = x / length; D[f * 3 + 1] = y / length; D[f * 3 + 2] = 500 / length;
        }
        const ds = {n, fps: 1, S, D, W: new Float64Array(n * 3)};
        const options = {runs: 1, pop: 12, gens: 10, escalate: false};
        const fit = await fitAircraft(ds, options);
        const old = await fitAircraft(ds, {...options, costStride: 5});
        expect(fit.sampling.objectiveCount).toBe(n);
        expect(old.sampling.objectiveCount).toBe(5);
        expect(fit.track.length).toBe(n * 3);
        expect(old.track.length).toBe(n * 3);
    }, 30000);
});
