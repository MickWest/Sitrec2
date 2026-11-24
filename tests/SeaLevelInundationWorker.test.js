jest.mock("../src/WaterMaskGeo", () => ({loadOceanMaskRegion: jest.fn()}));
jest.mock("../src/water/InundationTerrain", () => ({loadInundationTerrain: jest.fn()}));
jest.mock("../src/water/InundationWorkerClient", () => ({createInundationWorker: jest.fn()}));

import {SeaLevelInundation} from "../src/water/SeaLevelInundation";
import {loadOceanMaskRegion} from "../src/WaterMaskGeo";
import {loadInundationTerrain} from "../src/water/InundationTerrain";
import {createInundationWorker} from "../src/water/InundationWorkerClient";

let worker, jobs, model;
const region = {maskRect: {u0: 0.15, v0: 0.4, du: 0.001}}, map = {options: {zScale: 1}};
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const answer = value => ({wet: new Uint8Array(4096).fill(value), flowRoutes: [{cells: [1, 2]}], elapsedMs: 4});
beforeEach(() => {
    jobs = [];
    worker = {cancel: jest.fn(), dispose: jest.fn(), request: jest.fn((type, payload, transfer, progress) =>
        new Promise((resolve, reject) => jobs.push({type, payload, progress, resolve, reject})))};
    createInundationWorker.mockReturnValue(worker);
    const data = new Uint8Array(4096 * 4).fill(255);
    loadOceanMaskRegion.mockResolvedValue({image: {getContext: () => ({getImageData: () => ({data})})}, dispose() {}});
    loadInundationTerrain.mockResolvedValue({heights: new Float32Array(4096), missing: 0});
    model = new SeaLevelInundation(jest.fn());
});
afterEach(() => model.dispose());

test("worker progress is published, repeated frames share a job, and only the latest level is applied", async () => {
    model.update(region, map, 640, 1);
    await settle();
    expect(jobs).toHaveLength(1);
    expect(model.update(region, map, 640, 1)).toBeNull();
    expect(jobs).toHaveLength(1);
    jobs[0].progress({stage: "Flood fill", done: 1, total: 2, fraction: 0.5});
    expect(model.status).toBe("Flood fill 50%");
    expect(model.progress.fraction).toBe(0.5);
    model.update(region, map, 640, 2);
    jobs[0].resolve(answer(99));
    await settle();
    expect(model.texture.image.data[0]).toBe(0);
    jobs[1].resolve(answer(255));
    await settle();
    expect(model.update(region, map, 640, 2)).toBe(model.texture);
    expect(model.texture.image.data[0]).toBe(255);
    expect(model.progress).toBeNull();
    model.update(region, map, 640, 3);
    expect(jobs[2].payload.terrain).toBeUndefined();
});

test("locking rejects a late result and preserves the completed pixels and routes", async () => {
    model.update(region, map, 640, 1);
    await settle();
    jobs[0].resolve(answer(12));
    await settle();
    const pixels = model.texture.image.data, routes = model.flowRoutes;
    model.update(region, map, 640, 2);
    model.pauseCalculation();
    jobs[1].resolve(answer(255));
    await settle();
    expect(model.texture.image.data).toBe(pixels);
    expect(model.flowRoutes).toBe(routes);
    expect(model.pendingFill).toBeNull();
    expect(worker.cancel).toHaveBeenCalled();
    model.update(region, map, 640, 2);
    expect(jobs).toHaveLength(3);
});

test("same-level refinements retain the completed surface until the replacement is ready", async () => {
    model.update(region, map, 640, 1);
    await settle();
    jobs[0].resolve(answer(12));
    await settle();
    const texture = model.texture;
    model.appliedBarriers = {}; // Force a refinement at the same level and domain.
    expect(model.update(region, map, 640, 1)).toBe(texture);
    expect(model.pendingFill).not.toBeNull();
    expect(texture.image.data[0]).toBe(12);
    jobs[1].resolve(answer(255));
    await settle();
    expect(model.update(region, map, 640, 1)).toBe(texture);
    expect(texture.image.data[0]).toBe(255);
});

test("worker failure hides old water at a new level and does not retry every frame", async () => {
    model.update(region, map, 640, 1);
    await settle();
    jobs[0].resolve(answer(12));
    await settle();
    model.update(region, map, 640, 2);
    jobs[1].reject(new Error("worker stopped"));
    await settle();
    for (let i = 0; i < 3; i++) expect(model.update(region, map, 640, 2)).toBeNull();
    expect(jobs).toHaveLength(2);
    expect(model.status).toMatch(/worker stopped.*Recalculate/);
    expect(model.progress).toBeNull();
});

test("changing region disposes the old worker and ignores its late reply", async () => {
    model.update(region, map, 640, 1);
    await settle();
    model.update({...region}, map, 640, 3);
    await settle();
    const texture = model.texture;
    jobs[0].resolve(answer(99));
    await settle();
    expect(model.texture).toBe(texture);
    expect(model.texture.image.data[0]).toBe(0);
    expect(worker.dispose).toHaveBeenCalled();
});
