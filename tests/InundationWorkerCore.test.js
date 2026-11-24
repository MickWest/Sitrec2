jest.mock("../src/water/InundationProjection", () => ({projectInundationMesh: jest.fn(async change => change.fixtureProjected)}));

import {InundationWorkerCore} from "../src/water/InundationWorkerCore";
import {projectInundationMesh} from "../src/water/InundationProjection";
import {connectedInundation} from "../src/water/InundationGrid";
import {inundationFlowRoutes} from "../src/water/InundationFlow";

const checkpoint = async () => {};
const progress = () => {};
const size = 7;

function ground(key = "ground", height = 1) {
    return {
        key, retained: true,
        fixtureProjected: [{vertices: new Float32Array([-1, -1, height, 7, -1, height, 7, 7, height, -1, 7, height]),
            minHeight: height, maxHeight: height}],
        input: {index: new Uint32Array([0, 1, 2, 0, 2, 3]), position: {count: 4},
            start: 0, count: 6, error: 2, coverageSource: true},
    };
}

function wall(key = "wall") {
    return {
        key, retained: false,
        fixtureProjected: [{vertices: new Float32Array([2.5, -1, 0, 2.5, 7, 0, 2.5, 7, 10, 2.5, -1, 10]),
            minHeight: 0, maxHeight: 10}],
        input: {index: new Uint32Array([0, 1, 2, 0, 2, 3]), position: {count: 4},
            start: 0, count: 6, error: 0, coverageSource: false},
    };
}

function request(changes = [], options = {}) {
    return {domain: 1, context: {size}, changes, active: changes.map(change => change.key), level: 5,
        requireCoverage: true, fineError: 5, geometryId: 1, ...options};
}

beforeEach(() => { jest.clearAllMocks(); });

test("decoding identical tile data again keeps its projection and raster cache, while an edit replaces them", async () => {
    const core = new InundationWorkerCore();
    await core.geometry(request([ground()]), checkpoint, progress);
    const original = core.records.get("ground");
    const duplicate = await core.geometry(request([ground()], {geometryId: 2}), checkpoint, progress);
    expect(core.records.get("ground")).toBe(original);
    expect(duplicate.cacheStats.coverageTriangles).toBe(0);
    expect(duplicate.cacheStats.barrierPartsReused).toBe(1);
    const edited = await core.geometry(request([ground("ground", 2)], {geometryId: 3}), checkpoint, progress);
    expect(core.records.get("ground")).not.toBe(original);
    expect(edited.barriers.surfaceHeights[24]).toBe(2);
});

test("evicted tile calculations remain available without retransmitting or rerasterizing their triangles", async () => {
    const core = new InundationWorkerCore();
    const first = await core.geometry(request([ground()]), checkpoint, progress);
    expect(first.barriers.coverage.every(Boolean)).toBe(true);
    expect(first.cacheStats.coverageTriangles).toBe(2);
    const stored = core.records.get("ground");
    const next = await core.geometry(request([], {geometryId: 2}), checkpoint, progress);
    expect(core.records.get("ground")).toBe(stored);
    expect(next.barriers).toEqual(first.barriers);
    expect(next.cacheStats.coverageTriangles).toBe(0);
    expect(next.cacheStats.barrierPartsReused).toBe(1);
    expect(projectInundationMesh).toHaveBeenCalledTimes(1);
});

test("new tiles preserve earlier retained results and a source/domain change drops them", async () => {
    const core = new InundationWorkerCore();
    await core.geometry(request([ground("first")]), checkpoint, progress);
    const firstRecord = core.records.get("first");
    const second = await core.geometry(request([ground("second", 2)], {geometryId: 2}), checkpoint, progress);
    expect(core.records.get("first")).toBe(firstRecord);
    expect(second.recordCount).toBe(2);
    expect(second.cacheStats.coverageTriangles).toBe(2);
    expect(second.cacheStats.coveragePartsReused).toBe(1);
    const changed = await core.geometry(request([], {domain: 2, geometryId: 3}), checkpoint, progress);
    expect(changed.recordCount).toBe(0);
    expect(changed.barriers.coverage.some(Boolean)).toBe(false);
    expect(changed.barriers.surfaceHeights.every(value => value === Infinity)).toBe(true);
});

test("removing a synthetic object removes its barriers while retaining photogrammetry; retransmitting restores it", async () => {
    const core = new InundationWorkerCore(), barrier = wall();
    const first = await core.geometry(request([ground(), barrier]), checkpoint, progress);
    expect(first.barriers.east.some(Boolean)).toBe(true);
    const removed = await core.geometry(request([], {geometryId: 2}), checkpoint, progress);
    expect(core.records.has("wall")).toBe(false);
    expect(core.records.has("ground")).toBe(true);
    expect(removed.barriers.east.some(Boolean)).toBe(false);
    const restored = await core.geometry(request([barrier], {geometryId: 3}), checkpoint, progress);
    expect(restored.barriers.east).toEqual(first.barriers.east);
});

test("cancellation after projecting an edit cannot replace acknowledged tile geometry", async () => {
    const core = new InundationWorkerCore();
    await core.geometry(request([ground()]), checkpoint, progress);
    const oldRecord = core.records.get("ground"), oldBarriers = core.barriers;
    let calls = 0;
    const cancelAfterProjection = async () => { if (++calls === 1) throw new Error("cancelled"); };
    await expect(core.geometry(request([ground("ground", 20)], {geometryId: 2}), cancelAfterProjection, progress))
        .rejects.toThrow("cancelled");
    expect(core.records.get("ground")).toBe(oldRecord);
    expect(core.barriers).toBe(oldBarriers);
    expect(core.geometryId).toBe(1);
    const resumed = await core.geometry(request([], {geometryId: 3}), checkpoint, progress);
    expect(resumed.barriers.surfaceHeights).toEqual(oldBarriers.surfaceHeights);
});

test("cancellation after rasterization leaves the acknowledged state usable on resume", async () => {
    const core = new InundationWorkerCore();
    await core.geometry(request([ground()]), checkpoint, progress);
    const oldRecord = core.records.get("ground"), oldBarriers = core.barriers;
    const build = core.raster.build.bind(core.raster);
    let rasterFinished = false;
    jest.spyOn(core.raster, "build").mockImplementation(async (...args) => {
        const result = await build(...args);
        rasterFinished = true;
        return result;
    });
    await expect(core.geometry(request([ground("ground", 20)], {geometryId: 2}), async () => {
        if (rasterFinished) throw new Error("cancelled");
    }, progress)).rejects.toThrow("cancelled");
    expect(core.records.get("ground")).toBe(oldRecord);
    expect(core.barriers).toBe(oldBarriers);
    const resumed = await core.geometry(request([], {geometryId: 3}), checkpoint, progress);
    expect(resumed.barriers.surfaceHeights).toEqual(oldBarriers.surfaceHeights);
});

test("level edits reuse projection and coverage but recalculate overtopped walls", async () => {
    const core = new InundationWorkerCore();
    const low = await core.geometry(request([ground(), wall()]), checkpoint, progress);
    const high = await core.geometry(request([], {active: ["wall"], level: 11, geometryId: 2}), checkpoint, progress);
    expect(high.barriers.surfaceHeights).toEqual(low.barriers.surfaceHeights);
    expect(low.barriers.east.some(Boolean)).toBe(true);
    expect(high.barriers.east.some(Boolean)).toBe(false);
    expect(high.cacheStats.coverageTriangles).toBe(0);
    expect(projectInundationMesh).toHaveBeenCalledTimes(2);
    const lower = await core.geometry(request([], {active: ["wall"], geometryId: 3}), checkpoint, progress);
    expect(lower.barriers.east).toEqual(low.barriers.east);
});

test("worker flood masks and routes match the shared calculation and terrain remains reusable", async () => {
    const core = new InundationWorkerCore();
    await core.geometry(request([ground(), wall()]), checkpoint, progress);
    const heights = new Float32Array(size * size).fill(1), ocean = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) ocean[y * size] = 1;
    const terrain = {id: 10, heights, ocean, seeds: ocean.slice(), size, cellMeters: 100};
    const onProgress = jest.fn();
    const actual = await core.fill({terrain, terrainId: 10, useBuildings: true, geometryId: 1, level: 5, showFlow: true},
        checkpoint, onProgress);
    const trace = {};
    const expected = connectedInundation(heights, ocean, size, size, 5, undefined, core.barriers, trace, terrain.seeds);
    expect(actual.wet).toEqual(expected);
    expect(actual.flowRoutes).toEqual(inundationFlowRoutes(trace, heights, ocean, size, terrain.cellMeters, core.barriers.surfaceHeights));
    expect(actual.wet[3 * size + 2]).toBe(255);
    expect(actual.wet[3 * size + 3]).toBe(0);
    expect(onProgress.mock.calls.map(call => call[0])).toEqual(["Flood fill", "Flow arrows", "Complete"]);
    const again = await core.fill({terrainId: 10, useBuildings: true, geometryId: 1, level: 5, showFlow: false}, checkpoint, progress);
    expect(again.wet).toEqual(expected);
    expect(again.flowRoutes).toEqual([]);
});

test("stale terrain or geometry cannot be combined into a flood result", async () => {
    const core = new InundationWorkerCore();
    await expect(core.fill({terrainId: 1, useBuildings: false}, checkpoint, progress)).rejects.toThrow("terrain cache");
    await core.geometry(request([ground()]), checkpoint, progress);
    const terrain = {id: 1, size, heights: new Float32Array(49), ocean: new Uint8Array(49), seeds: new Uint8Array(49), cellMeters: 10};
    await expect(core.fill({terrain, terrainId: 1, useBuildings: true, geometryId: 2, level: 5}, checkpoint, progress))
        .rejects.toThrow("geometry changed");
    await expect(core.fill({terrainId: 1, useBuildings: true, geometryId: 1, level: 6}, checkpoint, progress))
        .rejects.toThrow("geometry changed");
    await expect(core.fill({terrainId: 2, useBuildings: false, level: 5}, checkpoint, progress)).rejects.toThrow("terrain cache");
});
