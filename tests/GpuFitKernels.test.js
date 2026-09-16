/**
 * GPU fit search: what can be checked without a GPU.
 *
 * 1. Each WGSL cost kernel has a JavaScript-double mirror over the same f32
 *    tables. The mirror must reproduce the CPU objective the fit minimises, which
 *    pins the table layout and the sensor-relative reformulation. (The WGSL
 *    itself is checked on a real GPU by private probes.)
 * 2. Where WebGPU does not exist (here), `gpu: true` must fall back to the CPU
 *    search and return exactly what the CPU search returns.
 */

import {aircraftCostErrDeg, cumulativeWind, fitAircraft, EARTH_RADIUS_M, KNOTS_TO_MS, METERS_PER_NM}
    from "../src/TraverseAnalysis";
import {fitPhysicsModel} from "../src/LOSFitting";
import {SkyLanternModel} from "../src/SkyLanternModel";
import {QuadcopterModel} from "../src/QuadcopterModel";
import {integrateRK4} from "../src/PhysicsModel";
import {aircraftKernelCostF64, buildAircraftKernel, AIRCRAFT_KERNEL_DIM} from "../src/gpu/AircraftCostKernel";
import {buildLanternKernel, lanternKernelCostF64} from "../src/gpu/LanternCostKernel";
import {buildQuadcopterKernel, quadcopterKernelCostF64} from "../src/gpu/QuadcopterCostKernel";
import {composeDifferentialEvolutionWGSL, resolveGpuBudget} from "../src/gpu/GpuDifferentialEvolution";
import {getComputeDevice, webgpuAvailable} from "../src/gpu/WebGPUCompute";
import {mulberry32} from "../src/DifferentialEvolution";

jest.setTimeout(120000);

// A turning sensor 20-30 km from the ENU origin watching a straight, climbing
// target through a light wind. Far enough out that absolute-coordinate f32
// arithmetic would visibly fail.
function traverseScene({n = 400, fps = 10} = {}) {
    const S = new Float64Array(n * 3), D = new Float64Array(n * 3), W = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        const sx = 20000 + 8000 * Math.sin(0.01 * t), sy = 25000 + 8000 * (1 - Math.cos(0.01 * t)), sz = 6000;
        const tx = 32000 + 60 * t, ty = 30000 - 20 * t, tz = 3000 + 2 * t;
        const dx = tx - sx, dy = ty - sy, dz = tz - sz, dl = Math.hypot(dx, dy, dz);
        S.set([sx, sy, sz], f * 3);
        D.set([dx / dl, dy / dl, dz / dl], f * 3);
        W.set([1.5 / fps, -0.5 / fps, 0], f * 3);
    }
    return {n, fps, S, D, W};
}

describe("aircraft kernel mirror matches the fitAircraft objective", () => {
    const dataset = traverseScene();
    const costFrames = [];
    for (let f = 0; f < dataset.n; f += 5) costFrames.push(f);
    if (costFrames[costFrames.length - 1] !== dataset.n - 1) costFrames.push(dataset.n - 1);
    const cumW = cumulativeWind(dataset);
    const T = (dataset.n - 1) / dataset.fps;
    const settings = {errSigma: 0.02, turnSigma: 0.5, climbSigma: 8,
        tasTarget: 380 * KNOTS_TO_MS, tasSigma: 150 * KNOTS_TO_MS};
    const cpuObjective = (p, groundPrior) => {
        const scoreError = (e, q) => {
            const wEnd = q[3] + q[4] * T;
            let c = e / settings.errSigma + (q[3] / settings.turnSigma) ** 2 + (wEnd / settings.turnSigma) ** 2
                + (q[5] / settings.climbSigma) ** 2 + ((q[2] - settings.tasTarget) / settings.tasSigma) ** 2;
            if (groundPrior) {
                const x0 = dataset.S[0] + q[0] * dataset.D[0];
                const y0 = dataset.S[1] + q[0] * dataset.D[1];
                const z0 = dataset.S[2] + q[0] * dataset.D[2];
                const h0 = z0 + (x0 * x0 + y0 * y0) / (2 * EARTH_RADIUS_M);
                c += ((h0 - groundPrior.startZ) / groundPrior.sigma) ** 2;
                c += ((h0 + q[5] * T - groundPrior.endZ) / groundPrior.sigma) ** 2;
            }
            return c;
        };
        const e = aircraftCostErrDeg(dataset, p, costFrames, cumW, Infinity, settings.errSigma, scoreError);
        return e > 1e8 ? e : scoreError(e, p);
    };
    const lo = [1 * METERS_PER_NM, 0, 25 * KNOTS_TO_MS, -4, -0.3, -40];
    const hi = [45 * METERS_PER_NM, 360, 700 * KNOTS_TO_MS, 4, 0.3, 40];

    test.each([null, {startZ: 3000, endZ: 3500, sigma: 40}])("ground prior %j", (groundPrior) => {
        const kernel = buildAircraftKernel({dataset, costFrames, cumW, T, ...settings, groundPrior,
            earthRadius: EARTH_RADIUS_M});
        expect(kernel.dim).toBe(AIRCRAFT_KERNEL_DIM);
        const rng = mulberry32(42);
        for (let i = 0; i < 200; i++) {
            const p = lo.map((l, d) => l + rng() * (hi[d] - l));
            const cpu = cpuObjective(p, groundPrior);
            const mirror = aircraftKernelCostF64(kernel, p);
            // f32 table rounding: well under 0.001 deg of residual per cost unit scale
            expect(Math.abs(mirror - cpu)).toBeLessThan(0.02 + 1e-5 * Math.abs(cpu));
        }
    });
});

describe("lantern kernel mirror matches the fitPhysicsModel objective", () => {
    const scene = traverseScene({n: 600, fps: 10});
    const times = new Float64Array(scene.n);
    for (let f = 0; f < scene.n; f++) times[f] = f / scene.fps;
    const dataset = {sensorPos: scene.S, losDir: scene.D, times, count: scene.n};
    const costFrames = [];
    for (let f = 0; f < scene.n; f += 5) costFrames.push(f);
    if (costFrames[costFrames.length - 1] !== scene.n - 1) costFrames.push(scene.n - 1);
    const costTimes = costFrames.map((f) => times[f]);
    const T = times[scene.n - 1];
    const errSigma = 0.02;

    const cpuObjective = (model, p) => {
        const states = integrateRK4(model, model.getInitialState(p, dataset), p, costTimes, {checkDivergence: true});
        let err = 0;
        costFrames.forEach((fi, k) => {
            const s = states[k], b = fi * 3;
            let rx = s[0] - scene.S[b], ry = s[1] - scene.S[b + 1], rz = s[2] - scene.S[b + 2];
            const rl = Math.hypot(rx, ry, rz);
            rx /= rl; ry /= rl; rz /= rl;
            err += Math.acos(Math.max(-1, Math.min(1, rx * scene.D[b] + ry * scene.D[b + 1] + rz * scene.D[b + 2])));
        });
        return (err / costFrames.length * 180 / Math.PI) / errSigma + model.extraCost(p, dataset, T);
    };

    test.each([
        {label: "light-wind prior", clipDuration: 59.9, windPrior: null},
        {label: "measured-wind prior", clipDuration: 59.9, windPrior: [4, -2]},
        {label: "constant wind (no clip duration)", clipDuration: null, windPrior: null},
    ])("$label", ({clipDuration, windPrior}) => {
        const model = new SkyLanternModel();
        model.clipDuration = clipDuration;
        if (windPrior) [model.windPriorE, model.windPriorN] = windPrior;
        const kernel = buildLanternKernel({model, dataset, costFrames, costTimes, T, errSigma, maxDt: model.maxDt});
        expect(kernel).not.toBeNull();
        const defs = model.getParameterDefs();
        const rng = mulberry32(7);
        for (let i = 0; i < 60; i++) {
            // Start ranges that keep the object in front of the sensor; the rest free.
            const p = defs.map((d) => d.min + rng() * (d.max - d.min));
            const cpu = cpuObjective(model, p);
            const mirror = lanternKernelCostF64(kernel, p);
            expect(Math.abs(mirror - cpu)).toBeLessThan(0.02 + 1e-5 * Math.abs(cpu));
        }
    });

    test("not covered: a ground prior, or a model without a kernel", () => {
        const model = new SkyLanternModel();
        expect(buildLanternKernel({model, dataset, costFrames, costTimes, T, errSigma, maxDt: 0.25,
            groundPrior: {startZ: 0}})).toBeNull();
        expect(buildLanternKernel({model: {maxDt: 0.25}, dataset, costFrames, costTimes, T, errSigma, maxDt: 0.25}))
            .toBeNull();
    });
});

describe("quadcopter kernel mirror matches the fitPhysicsModel objective", () => {
    const scene = traverseScene({n: 600, fps: 10});
    const times = Float64Array.from({length: scene.n}, (_, f) => f / scene.fps);
    const dataset = {sensorPos: scene.S, losDir: scene.D, times, count: scene.n};
    const costFrames = [];
    for (let f = 0; f < scene.n; f += 5) costFrames.push(f);
    if (costFrames[costFrames.length - 1] !== scene.n - 1) costFrames.push(scene.n - 1);
    const costTimes = costFrames.map((f) => times[f]);
    const T = times[scene.n - 1];
    const errSigma = 0.02;
    const cpuObjective = (model, p) => {
        const states = integrateRK4(model, model.getInitialState(p, dataset), p, costTimes,
            {maxDt: 0.5, checkDivergence: true});
        let err = 0;
        costFrames.forEach((fi, index) => {
            const state = states[index], b = fi * 3;
            const r = [state[0] - scene.S[b], state[1] - scene.S[b + 1], state[2] - scene.S[b + 2]];
            const cross = [r[1] * scene.D[b + 2] - r[2] * scene.D[b + 1],
                r[2] * scene.D[b] - r[0] * scene.D[b + 2],
                r[0] * scene.D[b + 1] - r[1] * scene.D[b]];
            err += Math.atan2(Math.hypot(...cross),
                r[0] * scene.D[b] + r[1] * scene.D[b + 1] + r[2] * scene.D[b + 2]);
        });
        return (err / costFrames.length * 180 / Math.PI) / errSigma + model.extraCost(p, dataset, T);
    };

    test.each([null, [4, -2]])("wind prior %j", (windPrior) => {
        const model = new QuadcopterModel();
        if (windPrior) [model.windPriorE, model.windPriorN] = windPrior;
        const kernel = buildQuadcopterKernel({
            model, dataset, costFrames, costTimes, T, errSigma, maxDt: 0.5,
        });
        expect(kernel).not.toBeNull();
        const defs = model.getParameterDefs();
        const rng = mulberry32(17);
        for (let i = 0; i < 60; i++) {
            const p = defs.map((definition) => definition.min + rng() * (definition.max - definition.min));
            const cpu = cpuObjective(model, p);
            const mirror = quadcopterKernelCostF64(kernel, p);
            expect(Math.abs(mirror - cpu)).toBeLessThan(0.02 + 1e-5 * Math.abs(cpu));
        }
    });

    test("does not cover a ground prior or another model", () => {
        const model = new QuadcopterModel();
        const args = {model, dataset, costFrames, costTimes, T, errSigma, maxDt: 0.5};
        expect(buildQuadcopterKernel({...args, groundPrior: {startZ: 0}})).toBeNull();
        expect(buildQuadcopterKernel({...args, model: {maxDt: 0.5}})).toBeNull();
    });
});

describe("without WebGPU, gpu: true is the CPU search", () => {
    test("no device here", async () => {
        expect(webgpuAvailable()).toBe(false);
        await expect(getComputeDevice()).resolves.toBeNull();
    });

    test("fitAircraft", async () => {
        const dataset = traverseScene({n: 120, fps: 10});
        const opts = {runs: 1, pop: 12, gens: 15};
        const cpu = await fitAircraft(dataset, opts);
        const gpu = await fitAircraft(dataset, {...opts, gpu: true});
        expect(gpu).toEqual(cpu);
        expect(gpu.runs[0].de.backend).toBeUndefined();
    });

    test("fitPhysicsModel (Sky Lantern)", async () => {
        const scene = traverseScene({n: 200, fps: 10});
        const times = Float64Array.from({length: scene.n}, (_, f) => f / scene.fps);
        const dataset = {sensorPos: scene.S, losDir: scene.D, times, count: scene.n};
        const opts = {optimizer: "de", dePop: 12, deGens: 10, maxIter: 150, sampleStride: 5};
        const make = () => { const m = new SkyLanternModel(); m.clipDuration = 19.9; return m; };
        const cpu = await fitPhysicsModel(dataset, new Set(), make(), opts);
        const gpu = await fitPhysicsModel(dataset, new Set(), make(), {...opts, gpu: true});
        expect(gpu).toEqual(cpu);
        expect(gpu.params.optimizer.de.backend).toBeUndefined();
    });

    test("fitPhysicsModel (Quadcopter)", async () => {
        const scene = traverseScene({n: 120, fps: 10});
        const times = Float64Array.from({length: scene.n}, (_, f) => f / scene.fps);
        const dataset = {sensorPos: scene.S, losDir: scene.D, times, count: scene.n};
        const opts = {optimizer: "de", dePop: 12, deGens: 8, maxIter: 100,
            sampleStride: 5, fitMaxDt: 0.5};
        const cpu = await fitPhysicsModel(dataset, new Set(), new QuadcopterModel(), opts);
        const gpu = await fitPhysicsModel(dataset, new Set(), new QuadcopterModel(), {...opts, gpu: true});
        expect(gpu).toEqual(cpu);
        expect(gpu.params.optimizer.de.backend).toBeUndefined();
    });
});

describe("GPU search plumbing", () => {
    test("budget resolution", () => {
        const defaults = {instances: 4, pop: 1024, gens: 200};
        expect(resolveGpuBudget(true, defaults)).toEqual(defaults);
        expect(resolveGpuBudget({pop: 2.7, gens: -3}, defaults)).toEqual({instances: 4, pop: 4, gens: 0});
        expect(resolveGpuBudget({instances: 16}, defaults)).toEqual({instances: 16, pop: 1024, gens: 200});
    });

    test("the composed module defines the dimension and one cost", () => {
        const dataset = traverseScene({n: 50});
        const cumW = cumulativeWind(dataset);
        const kernel = buildAircraftKernel({dataset, costFrames: [0, 10, 20, 49], cumW, T: 4.9, errSigma: 0.02,
            turnSigma: 0.5, climbSigma: 8, tasTarget: 195, tasSigma: 77, earthRadius: EARTH_RADIUS_M});
        const wgsl = composeDifferentialEvolutionWGSL(kernel);
        expect(wgsl).toContain("const DIM: u32 = 6u;");
        expect(wgsl.match(/\bfn cost\(/g)).toHaveLength(1);
        expect(kernel.params[0]).toBe(3);
        expect(kernel.table.length).toBe(33);
    });
});
