/**
 * BOTBench's GPU search option, where there is no WebGPU (as here).
 *
 * The fits must run on the CPU exactly as a CPU run does, and the fixed-wing,
 * balloon, and quadcopter units must be marked not cacheable: stored under the GPU options, a CPU
 * fit would later be served to a GPU run as though it were a GPU result.
 *
 * @jest-environment jsdom
 */
jest.mock("three/addons/lines/LineMaterial.js", () => ({LineMaterial: class {}}), {virtual: true});
jest.mock("three/addons/lines/LineGeometry.js", () => ({LineGeometry: class {}}), {virtual: true});
jest.mock("three/addons/lines/Line2.js", () => ({Line2: class {}}), {virtual: true});

import {setSit} from "../../src/Globals";
import {fitBotBenchRecord, searchBackendOf} from "../../src/analysis/BotBenchFit";

jest.setTimeout(300000);

// A turning sensor watching a slow, climbing object through a light wind.
function record({n = 150, fps = 10} = {}) {
    const S = new Float64Array(n * 3), D = new Float64Array(n * 3), W = new Float64Array(n * 3);
    for (let f = 0; f < n; f++) {
        const t = f / fps;
        const sx = 3000 * Math.sin(0.02 * t), sy = 3000 * (1 - Math.cos(0.02 * t)), sz = 4000;
        const tx = 2500 + 4 * t, ty = 6000 - 2 * t, tz = 800 + 1.5 * t;
        const dx = tx - sx, dy = ty - sy, dz = tz - sz, dl = Math.hypot(dx, dy, dz);
        S.set([sx, sy, sz], f * 3);
        D.set([dx / dl, dy / dl, dz / dl], f * 3);
        W.set([0.3, -0.1, 0], f * 3);
    }
    return {kind: "bot", label: "synthetic", dataset: {n, fps, S, D, W},
        originLat: 41 * Math.PI / 180, originLon: -104.87 * Math.PI / 180, groundZ: 0, meta: {}};
}

describe("GPU search without WebGPU", () => {
    beforeAll(() => setSit({name: "botbench", frames: 100000, fps: 10, simSpeed: 1, lat: 41, lon: -104.87}));
    const solvers = ["aircraft", "horizontalSpeed", "lantern", "quadcopter"];
    let cpu, gpu;

    beforeAll(async () => {
        cpu = await fitBotBenchRecord(record(), {solvers});
        gpu = await fitBotBenchRecord(record(), {solvers, gpuSearch: true});
    });

    test("runs the same CPU fits", () => {
        expect(gpu.aircraft.cost).toBe(cpu.aircraft.cost);
        expect(gpu.aircraft.params).toEqual(cpu.aircraft.params);
        expect(gpu.horizontalSpeed).toEqual(cpu.horizontalSpeed);
        expect(gpu.lantern.params.solved).toEqual(cpu.lantern.params.solved);
        expect(gpu.quad.params.solved).toEqual(cpu.quad.params.solved);
        expect(searchBackendOf(gpu)).toBe("cpu");
        expect(searchBackendOf(cpu)).toBe("cpu");
    });

    test("does not offer the fallback fits for storage; the other units are unaffected", () => {
        expect(gpu.units.aircraft.cacheable).toBe(false);
        // Horizontal Speed Valley is deliberately CPU-only, so the GPU option
        // does not split or invalidate its cache unit.
        expect(gpu.units.horizontalSpeed.cacheable).toBe(true);
        expect(gpu.units.lantern.cacheable).toBe(false);
        expect(gpu.units.quadcopter.cacheable).toBe(false);
        expect(gpu.units.constAir.cacheable).toBe(true);
        expect(gpu.units.kalman.cacheable).toBe(true);
        expect(cpu.units.aircraft.cacheable).toBe(true);
        expect(cpu.units.horizontalSpeed.cacheable).toBe(true);
        expect(cpu.units.lantern.cacheable).toBe(true);
        expect(cpu.units.quadcopter.cacheable).toBe(true);
    });
});

test("searchBackendOf names where the searches ran", () => {
    const aircraft = (backend) => ({runs: [{de: backend ? {backend} : {}}]});
    const lantern = (backend) => ({params: {optimizer: {de: backend ? {backend} : {}}}});
    const quad = (backend) => ({params: {optimizer: {de: backend ? {backend} : {}}}});
    expect(searchBackendOf({aircraft: aircraft("webgpu"), lantern: lantern("webgpu"),
        quad: quad("webgpu")})).toBe("webgpu");
    expect(searchBackendOf({aircraft: aircraft("webgpu"), lantern: lantern(null)})).toBe("mixed");
    expect(searchBackendOf({horizontalSpeed: {backend: "webgpu"}})).toBeNull();
    expect(searchBackendOf({aircraft: aircraft(null)})).toBe("cpu");
    expect(searchBackendOf({})).toBeNull();
});
