import {setSit} from "../../src/Globals";
import {generateVideoScenarios} from "../../benchmarks/botbench/lib/videoScenarios";
import {generateScenario} from "../../benchmarks/botbench/lib/generateScenario";

beforeAll(() => setSit({lat: 37.244358, lon: -120.738187, fps: 10, frames: 10000, simSpeed: 1}));

test("starter video set preserves the generated track while resampling at 30p", () => {
    const clips = generateVideoScenarios({durationSeconds: 2});
    expect(clips.map(c => c.name)).toEqual(["01-party-neutral-orbit", "02-party-rising-orbit", "03-party-neutral-straight"]);
    const first = clips[0];
    const source = generateScenario(first.sourceSpec, {scenarioSeed: first.scenarioSeed});
    expect(first.frames).toBe(60);
    expect(first.sensorENU).toHaveLength(60);
    expect(first.targetENU).toHaveLength(60);
    expect(first.targetENU[30]).toEqual(Array.from(source.target.positionENU.slice(30, 33)));
    const p0 = first.targetENU[0], p1 = first.targetENU[3];
    first.targetENU[1].forEach((v, k) => expect(v).toBeCloseTo(p0[k] + (p1[k] - p0[k]) / 3, 10));
    expect(first).toMatchObject({diameterM: 1, targetPixels: 6, wobblePercent: 0.1, width: 640, height: 480, fps: 30});
});

test("video options reject invalid or unbounded batches", () => {
    for (const options of [{count: 0}, {count: 4}, {durationSeconds: -1}, {durationSeconds: 100}, {wobblePercent: NaN},
        {wobbleDegrees: NaN}, {wobbleDegrees: -0.5}, {wobbleDegrees: 6}, {wobbleDegrees: 0.5, wobblePercent: 0.1}]) {
        expect(() => generateVideoScenarios(options)).toThrow();
    }
});

test("selecting one scenario and slowing recentering preserves its identity and drift seed", () => {
    const original = generateVideoScenarios({durationSeconds: 2, wobbleDegrees: 0.5})[1];
    const clips = generateVideoScenarios({durationSeconds: 2, wobbleDegrees: 0.5,
        scenarioName: "02-party-rising-orbit", recenterSpeedScale: 0.25});
    expect(clips).toHaveLength(1);
    expect(clips[0]).toEqual({...original, recenterSpeedScale: 0.25});
    for (const recenterSpeedScale of [0, -1, NaN, Infinity, 11]) {
        expect(() => generateVideoScenarios({recenterSpeedScale})).toThrow();
    }
    expect(() => generateVideoScenarios({scenarioName: "unknown"})).toThrow();
});

test("degree-based tracking wobble retains the same scene and unambiguous units", () => {
    const original = generateVideoScenarios({count: 1, durationSeconds: 2})[0];
    const degrees = generateVideoScenarios({count: 1, durationSeconds: 2, wobbleDegrees: 0.5})[0];
    expect(degrees.wobbleDegrees).toBe(0.5);
    expect(degrees.wobblePercent).toBeUndefined();
    expect(degrees.sensorENU).toEqual(original.sensorENU);
    expect(degrees.targetENU).toEqual(original.targetENU);
    expect(degrees.targetPixels).toBe(6);
    expect(generateVideoScenarios({count: 1, durationSeconds: 2, wobbleDegrees: 0})[0].wobbleDegrees).toBe(0);
});

test("absolute drift and recenter speeds preserve the scene and reject conflicting scales", () => {
    const options = {durationSeconds: 2, scenarioName: "02-party-rising-orbit", wobbleDegrees: 0.5};
    const original = generateVideoScenarios(options)[0];
    const clip = generateVideoScenarios({...options, driftSpeed: 0.1, recenterSpeed: 0.3})[0];
    expect(clip).toEqual({...original, driftSpeed: 0.1, recenterSpeed: 0.3});
    expect(generateVideoScenarios({...options, driftSpeed: 0})[0].driftSpeed).toBe(0);
    for (const rates of [{driftSpeed: NaN}, {driftSpeed: -1}, {driftSpeed: 4},
        {recenterSpeed: 0}, {recenterSpeed: Infinity}, {recenterSpeed: 11},
        {recenterSpeed: 0.3, recenterSpeedScale: 0.25}]) {
        expect(() => generateVideoScenarios({...options, ...rates})).toThrow();
    }
});
