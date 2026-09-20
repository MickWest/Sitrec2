import {fitBalloon, BalloonDriftModel} from "../src/BalloonFit";
import {SuppliedWindModel} from "../src/SuppliedWindModel";
import {integrateRK4} from "../src/PhysicsModel";
import {datasetWithConstantWind, datasetWithWindCorrection} from "../src/TraverseWind";
import {buildHypotheses} from "../src/TraverseHypotheses";
import {completenessBadges, plausibilityRating} from "../src/TraverseRanking";
import {fitConstAltitude, traverseMinSpeed} from "../src/TraverseAnalysis";

jest.setTimeout(120000);

function scene({climb = 1.5, acceleration = 0, lifecycle = false, fps = 1} = {}) {
    const T = 60, n = T * fps + 1;
    const S = new Float64Array(n * 3), D = new Float64Array(n * 3), track = new Float64Array(n * 3);
    const times = Float64Array.from({length: n}, (_, i) => i / fps);
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        const x = 500 + 3 * t + 0.5 * acceleration * t * t, y = 300 + 2 * t;
        const u = Math.max(0, t - 25);
        const h = lifecycle ? 700 + 2 * Math.min(t, 25) - u + 45 * (1 - Math.exp(-u / 15)) : 700 + climb * t;
        const z = h - (x * x + y * y) / (2 * 6371000);
        track.set([x, y, z], f * 3);
        S.set([2200 * Math.cos(t * 0.045), 2200 * Math.sin(t * 0.045), 1800], f * 3);
        const ray = [x - S[f * 3], y - S[f * 3 + 1], z - S[f * 3 + 2]];
        D.set(ray.map(v => v / Math.hypot(...ray)), f * 3);
    }
    const dataset = datasetWithConstantWind({n, fps, S, D}, 12, -5);
    return {dataset, track, T, physics: {sensorPos: S, losDir: D, times, count: n}};
}
const options = {optimizer: "nm", maxIter: 1600, sampleStride: 2};

test.each([1.5, 0, -1.5])("steady balloon supports signed vertical speed %p without inactive lifecycle parameters", async climb => {
    const {dataset, physics, track} = scene({climb});
    const fit = await fitBalloon(physics, dataset, {...options, seedTrack: track});
    expect(fit.params.modelSelection.selectedStage).toBe("steady");
    expect(fit.params.solved.verticalSpeed).toBeCloseTo(climb, 2);
    expect(fit.params.errDeg).toBeLessThan(0.002);
    expect(fit.params.solved.tBurn).toBeUndefined();
    expect(fit.params.modelSelection.freeParameterCount).toBe(4);
});

test("minimum-speed wind regularization is independent of sample rate", () => {
    const opts = {fitWind: true, levelW: 0, accelReg: 0};
    const slow = traverseMinSpeed(scene({fps: 1}).dataset, opts);
    const fast = traverseMinSpeed(scene({fps: 10}).dataset, opts);
    expect(Math.abs(slow.wind.windE - fast.wind.windE)).toBeLessThan(0.05);
    expect(Math.abs(slow.wind.windN - fast.wind.windN)).toBeLessThan(0.05);
});

test("materially changing wind selects an extension without also freeing altitude shear", async () => {
    const {dataset, physics, track} = scene({acceleration: 0.1});
    const fit = await fitBalloon(physics, dataset, {...options, seedTrack: track});
    expect(["linear", "quadratic"]).toContain(fit.params.modelSelection.selectedStage);
    expect(fit.params.solved.shearPerM).toBeUndefined();
    expect(fit.params.errDeg).toBeLessThan(0.01);
    const baseline = fit.params.modelSelection.alternatives[0];
    expect(baseline.errDeg - fit.params.errDeg).toBeGreaterThan(0.002);
});

test("a vertical transition can select the lifecycle while keeping wind constant", async () => {
    const {dataset, physics, track} = scene({lifecycle: true});
    const fit = await fitBalloon(physics, dataset, {...options, seedTrack: track});
    expect(fit.params.modelSelection.selectedStage).toBe("lifecycle");
    expect(fit.params.solved.windDriftE).toBe(0);
    expect(fit.params.solved.shearPerM).toBe(0);
    expect(fit.params.errDeg).toBeLessThan(0.01);
});

test("correction mode integrates total wind and charges only the correction prior", () => {
    const {dataset, physics, T} = scene();
    const model = new SuppliedWindModel(new BalloonDriftModel("steady", T), dataset, {correctionSigmaMS: 5});
    const values = {initialRange: 2300, windE: -9, windN: 7, verticalSpeed: 0};
    const p = model.getParameterDefs().map(d => values[d.name]);
    const initial = model.getInitialState(p, physics);
    const end = integrateRK4(model, initial, p, [0, T]).pop();
    expect(end[0] - initial[0]).toBeCloseTo(3 * T, 6);
    expect(end[1] - initial[1]).toBeCloseTo(2 * T, 6);
    const altitude = s => s[2] + (s[0] ** 2 + s[1] ** 2) / (2 * 6371000);
    expect(altitude(end)).toBeCloseTo(altitude(initial), 5);
    const terms = model.extraCostTerms(p, physics, T);
    expect(terms["shared wind prior"]).toBeUndefined();
    expect(terms["supplied wind correction"]).toBeCloseTo((81 + 49) / 25);
    const corrected = datasetWithWindCorrection(dataset, -9, 7);
    expect(corrected.W[0]).toBe(3);
    expect(corrected.W[1]).toBe(2);
    expect(() => new SuppliedWindModel(new BalloonDriftModel(), dataset, {correctionSigmaMS: 0})).toThrow();
});

test("geometric wind is undetermined and cannot improve its score by inflating airspeed", () => {
    const {dataset} = scene();
    const opts = {fitWind: true, rangeMin: 1000, rangeMax: 5000, samples: 4};
    const a = fitConstAltitude(dataset, opts);
    const b = fitConstAltitude(datasetWithConstantWind(dataset, -35, 25), opts);
    expect(a).toEqual(b);
    expect(a.wind).toEqual({unconstrained: true});
    const h = buildHypotheses({dataset, ca: a, include: new Set(["constAlt"]), windModes: {constAlt: "fitted"}})[0];
    expect(h.name).toContain("wind undetermined");
    expect(h.windSamples).toBeNull();
    expect(h.params.motionFrame).toBe("ground");
});

test("a fitted wind at the search edge reaches the completeness judge", () => {
    const {dataset} = scene();
    const ca = fitConstAltitude(dataset, {rangeMin: 1000, rangeMax: 5000, samples: 4});
    ca.wind = {windE: -40, windN: 40};
    const h = buildHypotheses({dataset, ca, include: new Set(["constAlt"]), windModes: {constAlt: "fitted"}})[0];
    const rating = plausibilityRating(h);
    expect(rating.boundaryLimited).toBe(true);
    expect(completenessBadges(rating).map(b => b.label)).toContain("Wind search edge");
});
