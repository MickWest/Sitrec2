import {applyVideoOffscreenEvents} from "../../benchmarks/botbench/lib/videoOffscreenEvents";
import {generateVideoScenarios} from "../../benchmarks/botbench/lib/videoScenarios";
import {setSit} from "../../src/Globals";

test("offscreen set includes one and two smooth losses for each starter geometry", () => {
    setSit({lat: 37.244358, lon: -120.738187, fps: 10, frames: 10000, simSpeed: 1});
    const plans = generateVideoScenarios({set: "offscreen", durationSeconds: 30, wobbleDegrees: .5});
    expect(plans).toHaveLength(6);
    expect(generateVideoScenarios({set: "offscreen", count: 1})[0].frames).toBe(900);
    expect(() => generateVideoScenarios({set: "offscreen", durationSeconds: 20})).toThrow("reacquisition");
    expect(plans.map(p => p.offscreenEvents.length)).toEqual([1, 2, 1, 2, 1, 2]);
    const original = Array.from({length: 900}, () => ({pan: 0, tilt: .1}));
    for (const plan of plans) {
        const wobble = applyVideoOffscreenEvents(original, plan.offscreenEvents, 30, 3.1);
        expect(original.every(p => p.pan === 0)).toBe(true);
        expect(wobble[0]).toEqual(original[0]); expect(wobble[899]).toEqual(original[899]);
        const runs = []; let start;
        for (let f = 0; f <= 900; f++) {
            if (f < 900 && Math.abs(wobble[f].pan) > 3.1 / 2) start ??= f;
            else if (start !== undefined) {runs.push((f-start)/30); start = undefined;}
        }
        expect(runs).toHaveLength(plan.offscreenEvents.length);
        for (const seconds of runs) {expect(seconds).toBeGreaterThanOrEqual(1); expect(seconds).toBeLessThanOrEqual(5);}
        expect(Math.max(...wobble.slice(1).map((p,i) => Math.abs(p.pan-wobble[i].pan)))).toBeLessThan(.05);
    }
    expect(applyVideoOffscreenEvents(original, undefined, 30, 3.1)).toEqual(original);
});
