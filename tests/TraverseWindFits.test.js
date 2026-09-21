import {
    aircraftCostErrDeg, cumulativeWind, datasetForFittedWind, EARTH_RADIUS_M,
    fitAircraft, fitConstAltitude, fitPlausibleBestRange, rangeProfile,
    simulateAircraft, sweepConstAirSpeed, trackMetrics, traverseMinSpeed, traversePlausible,
} from "../src/TraverseAnalysis";
import {windPriorCost, datasetWithConstantWind} from "../src/TraverseWind";
import {SuppliedWindModel} from "../src/SuppliedWindModel";
import {SkyLanternModel} from "../src/SkyLanternModel";
import {QuadcopterModel} from "../src/QuadcopterModel";
import {integrateRK4} from "../src/PhysicsModel";
import {buildAircraftKernel, aircraftKernelCostF64} from "../src/gpu/AircraftCostKernel";
import {buildHypotheses} from "../src/TraverseHypotheses";
import {runTraverseBattery} from "../src/TraverseBattery";

function scene(n = 120, fps = 2) {
    const S = new Float64Array(n * 3), D = new Float64Array(n * 3), track = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        S.set([2200 * Math.cos(t * 0.06), 2200 * Math.sin(t * 0.06), 1700], f * 3);
        track.set([500 + 8 * t, 400 - 3 * t, 500], f * 3);
        const d = [0, 1, 2].map(a => track[f * 3 + a] - S[f * 3 + a]);
        D.set(d.map(v => v / Math.hypot(...d)), f * 3);
    }
    return {dataset: datasetWithConstantWind({n, fps, S, D}, 8, -3), track};
}

jest.setTimeout(120000);

test("minimum-speed wind and range are solved jointly, independent of supplied wind", () => {
    const {dataset} = scene();
    const fit = traverseMinSpeed(dataset, {fitWind: true});
    const changed = datasetWithConstantWind(dataset, -25, 20);
    expect(traverseMinSpeed(changed, {fitWind: true})).toEqual(fit);
    expect(fit.wind.windE).toBeCloseTo(8, 0);
    expect(fit.wind.windN).toBeCloseTo(-3, 0);
    expect(trackMetrics(datasetForFittedWind(dataset, fit), fit.track).airSpeed.mean).toBeLessThan(0.5);
    expect(traverseMinSpeed(changed).track).not.toEqual(traverseMinSpeed(dataset).track);
});

test("speed QP respects wind bounds and does not consume the supplied field", () => {
    const {dataset} = scene();
    const options = {fitWind: true, K: 12, vTarget: 25, vSigma: 3, iters: 5, rangeFloor: true};
    const fit = traversePlausible(dataset, 2500, options);
    expect(traversePlausible(datasetWithConstantWind(dataset, 30, 30), 2500, options)).toEqual(fit);
    expect(Math.abs(fit.wind.windE)).toBeLessThanOrEqual(40.000001);
    expect(Math.abs(fit.wind.windN)).toBeLessThanOrEqual(40.000001);
    expect(Array.from(fit.track).every(Number.isFinite)).toBe(true);
});

test("wind survives sweep, range, altitude and minimum-acceleration fits", async () => {
    const {dataset} = scene(60);
    const sweep = await sweepConstAirSpeed(dataset, {fitWind: true, ranges: [1800, 2500, 3500], speeds: [5, 25]});
    expect(sweep.fitWind).toBe(true);
    expect(sweep.results.every(r => Number.isFinite(r.wind.windE))).toBe(true);
    for (const row of sweep.results) {
        expect(row.windCost).toBeCloseTo(windPriorCost(row.wind.windE, row.wind.windN), 10);
        expect(row.score).toBeGreaterThanOrEqual(row.windCost);
    }
    const profile = await rangeProfile(dataset, {fitWind: true, ranges: [1800, 2500, 3500], vTarget: 5, K: 12});
    expect(profile.every(r => Number.isFinite(r.wind.windN))).toBe(true);
    for (const row of profile) {
        expect(row.windCost).toBeCloseTo(windPriorCost(row.wind.windE, row.wind.windN), 10);
        expect(row.score).toBeGreaterThanOrEqual(row.windCost);
    }
    const ca = fitConstAltitude(dataset, {fitWind: true, rangeMin: 1500, rangeMax: 3500, samples: 4});
    const plausible = fitPlausibleBestRange(dataset, {fitWind: true, rangeMin: 1500, rangeMax: 3500, coarse: 4,
        searchK: 8, finalK: 12, searchIters: 2, finalIters: 3, vTarget: 20});
    for (const fit of [ca, plausible]) {
        expect(fit.wind.unconstrained || Number.isFinite(fit.wind.windE)).toBe(true);
        expect(Number.isFinite(fit.score)).toBe(true);
    }
    const hs = buildHypotheses({dataset, sweep, slowProfile: profile, ca, plausible,
        slowOpts: {fitWind: true}, include: new Set(["constAir", "constAlt", "plausible", "saddle"]),
        windModes: {constAir: "fitted", constAlt: "fitted", plausible: "fitted", saddle: "fitted"}});
    expect(hs).toHaveLength(4);
    for (const h of hs) {
        const metricDataset = h.params.unconstrained ? datasetWithConstantWind(dataset, 0, 0)
            : datasetWithConstantWind(dataset, h.params.windE, h.params.windN);
        expect(h.metricsFull.airSpeed.mean).toBeCloseTo(trackMetrics(metricDataset, h.track).airSpeed.mean, 8);
    }
});

test("poor high-speed grid cells cannot enlarge the CAS equivalent-fit family", async () => {
    const {dataset} = scene(60);
    const options = {fitWind: true, ranges: [200, 800, 2500, 6000], speedTarget: 160};
    const speeds = [5, 25, 50, 100, 160];
    const base = await sweepConstAirSpeed(dataset, {...options, speeds});
    const extended = await sweepConstAirSpeed(dataset, {...options, speeds: [...speeds, 300, 600, 1000, 2000, 4000]});
    expect(extended.best).toEqual(base.best);
    expect(extended.familyBand.count).toEqual(base.familyBand.count);
    expect(extended.best.score - extended.bestRaw.score).toBeLessThanOrEqual(Math.max(0.05, extended.bestRaw.score * 0.15) + 1e-10);
});

test("CAS workspace reuse across cases and wind modes preserves results and earlier outputs", async () => {
    const workspace = {};
    const cases = [
        {dataset: scene(60, 2).dataset, fitWind: true},
        {dataset: scene(45, 3).dataset, fitWind: false},
        {dataset: datasetWithConstantWind(scene(60, 2).dataset, -20, 15), fitWind: true},
        {dataset: scene(60, 4).dataset, fitWind: false},
        {dataset: scene(60, 2).dataset, fitWind: true},
    ];
    const retained = [];
    for (const {dataset, fitWind} of cases) {
        const options = {fitWind, ranges: [200, 2500, 6000], speeds: [5, 25, 190], speedTarget: 160};
        const expected = await sweepConstAirSpeed(dataset, options);
        const actual = await sweepConstAirSpeed(dataset, {...options, workspace});
        expect(actual).toEqual(expected);
        retained.push({actual, expected});
    }
    // Later jobs must not mutate results already delivered to cache/reporting.
    for (const {actual, expected} of retained) expect(actual).toEqual(expected);
});

test.each([SkyLanternModel, QuadcopterModel])("supplied %p wind is fixed and integrates every input interval", Model => {
    const {dataset} = scene(25, 10);
    for (let f = 0; f < dataset.n; f++) dataset.W.set([f % 2 ? -2 : 3, 0.25, 0], f * 3);
    const model = new SuppliedWindModel(new Model(), dataset);
    const defs = model.getParameterDefs();
    expect(defs.some(d => /wind|shear/i.test(d.name))).toBe(false);
    const params = defs.map(d => ["speed", "accel", "turnRate", "turnAccel", "climb"].includes(d.name) ? 0 : d.default);
    const ds = {sensorPos: dataset.S, losDir: dataset.D};
    const initial = model.getInitialState(params, ds);
    const times = [0, 1.2, 2.4];
    const states = integrateRK4(model, initial, params, times, {maxDt: 0.7});
    for (let i = 0; i < times.length; i++) {
        const frame = Math.round(times[i] * dataset.fps);
        for (const axis of [0, 1]) {
            let drift = 0;
            for (let f = 0; f < frame; f++) drift += dataset.W[f * 3 + axis];
            expect(states[i][axis] - initial[axis]).toBeCloseTo(drift, 8);
        }
    }
});

test("free aircraft simulation and search ignore supplied wind; GPU mirror covers eight coordinates", async () => {
    const {dataset} = scene(45, 3);
    const changed = datasetWithConstantWind(dataset, -30, 25);
    const p = [2200, 40, 35, 0.2, 0.01, 0.5, 8, -3];
    expect(simulateAircraft(dataset, p)).toEqual(simulateAircraft(changed, p));
    const options = {fitWind: true, runs: 1, pop: 10, gens: 10, rangeMin: 1500, rangeMax: 3500};
    const fit = await fitAircraft(dataset, options);
    expect(await fitAircraft(changed, options)).toEqual(fit);
    expect(await fitAircraft(dataset, {...options, boundedCost: false})).toEqual(fit);
    expect(Number.isFinite(fit.params.windE)).toBe(true);
    const costFrames = [0, 5, 10, 20, 44], cumW = cumulativeWind(dataset), T = 44 / 3;
    const settings = {errSigma: 0.02, turnSigma: 0.5, climbSigma: 8, tasTarget: 35, tasSigma: 50};
    const kernel = buildAircraftKernel({dataset, costFrames, cumW, T, ...settings, earthRadius: EARTH_RADIUS_M, freeWind: true});
    expect(kernel.dim).toBe(8);
    const err = aircraftCostErrDeg(dataset, p, costFrames, cumW);
    const objective = err / settings.errSigma + (p[3] / settings.turnSigma) ** 2
        + ((p[3] + p[4] * T) / settings.turnSigma) ** 2 + (p[5] / settings.climbSigma) ** 2 + windPriorCost(p[6], p[7]);
    expect(Math.abs(aircraftKernelCostF64(kernel, p) - objective)).toBeLessThan(0.01);
});

test("cached physical fits retain both wind treatments through judging", async () => {
    const {dataset: original, track} = scene();
    const dataset = datasetWithConstantWind(original, 30, 10);
    const air = {track, errDeg: 0.01, pinned: [], params: {startDist: 2000, tas: 25, climb: 0, heading: 0}};
    const physics = {positions: track, params: {errDeg: 0.01, solved: {initialRange: 2000, speed: 0, windE: 8, windN: -3}}};
    const supplied = {positions: track, params: {errDeg: 0.01, solved: {initialRange: 2000, speed: 0}}};
    const fits = {aircraft: air, aircraftFreeWind: {...air, params: {...air.params, windE: 8, windN: -3}},
        lantern: physics, lanternSuppliedWind: supplied, quadcopter: physics, quadcopterSuppliedWind: supplied};
    const result = await runTraverseBattery({dataset, ranges: [1000, 4000], anchorDist: 2000, speedTarget: 25,
        fitRangeMin: 1000, fitRangeMax: 4000, caRangeMin: 1000, caRangeMax: 4000, plausRangeMin: 1000, plausRangeMax: 4000,
        buildHypotheses: args => buildHypotheses({...args, include: new Set(["aircraft", "lantern", "quadcopter"])}),
        units: {plan: Object.keys(fits), cached: Object.fromEntries(Object.entries(fits).map(([key, result]) => [key, {result}]))}});
    expect(result.hypotheses).toHaveLength(6);
    for (const key of ["aircraft", "lantern", "quadcopter"]) {
        const pair = result.hypotheses.filter(h => h.key === key);
        expect(new Set(pair.map(h => h.windMode))).toEqual(new Set(["supplied", "fitted"]));
        expect(pair.find(h => h.windMode === "supplied").windEvidenceRole).toBe("externally-conditioned");
        expect(pair.find(h => h.windMode === "fitted").windEvidenceRole).toBe("free");
        expect(pair.every(h => h.platformMirror)).toBe(true);
        const supplied = pair.find(h => h.windMode === "supplied");
        const fitted = pair.find(h => h.windMode === "fitted");
        expect(supplied.windSamples[0]).toEqual({u: 30, v: 10});
        expect(fitted.windSamples[0]).toMatchObject({u: 8, v: -3});
        expect(supplied.metricsFull.airSpeed.mean).toBeGreaterThan(fitted.metricsFull.airSpeed.mean + 20);
    }
    expect(result.units).toEqual({});
});
