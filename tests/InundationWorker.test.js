jest.mock("../src/water/InundationProjection", () => ({projectInundationMesh: jest.fn(async change => change.fixtureProjected)}));

import {createInundationWorkerHandler} from "../src/water/InundationWorker";
import {InundationWorkerCore} from "../src/water/InundationWorkerCore";
import {projectInundationMesh} from "../src/water/InundationProjection";

function tile(height) {
    return {key: "tile", retained: true,
        fixtureProjected: [{vertices: new Float32Array([-1,-1,height, 7,-1,height, 7,7,height, -1,7,height]),
            minHeight: height, maxHeight: height}],
        input: {index: new Uint32Array([0,1,2,0,2,3]), position: {count: 4},
            start: 0, count: 6, error: 2, coverageSource: true}};
}

function payload(geometryId, height, domain = 1) {
    return {domain, context: {size: 7}, changes: height === undefined ? [] : [tile(height)], active: [],
        level: 5, requireCoverage: true, fineError: 5, geometryId};
}

function harness() {
    const core = new InundationWorkerCore(), messages = [];
    const handler = createInundationWorkerHandler(core, (message, transfer = []) => {
        // Exercise real buffer transfer: the worker's retained raster arrays
        // must remain attached for subsequent calculations and rollback.
        messages.push(structuredClone(message, {transfer}));
    });
    const send = data => handler({data});
    const result = id => messages.find(message => message.id === id && (message.result || message.error));
    return {core, messages, send, result};
}

beforeEach(() => { jest.clearAllMocks(); });

test("a canceled completed reply rolls back a retained tile edit even after that tile leaves the view", async () => {
    const {core, send, result} = harness();
    await send({id: 1, type: "geometry", payload: payload(1, 1)});
    await send({type: "accept", id: 1});
    const oldRecord = core.records.get("tile"), oldBarriers = core.barriers;
    const oldCoverage = core.raster.coverageState, oldEdges = core.raster.edges;
    await send({id: 2, type: "geometry", payload: payload(2, 20)});
    expect(result(2).result.barriers.surfaceHeights[24]).toBe(20);
    expect(core.barriers.surfaceHeights.byteLength).toBe(49 * 4);
    await send({type: "cancel", id: 2});
    expect(core.records.get("tile")).toBe(oldRecord);
    expect(core.barriers).toBe(oldBarriers);
    expect(core.raster.coverageState).toBe(oldCoverage);
    expect(core.raster.edges).toBe(oldEdges);
    expect(core.geometryId).toBe(1);
    // The tile is no longer loaded, so the next request cannot retransmit it.
    await send({id: 3, type: "geometry", payload: payload(3)});
    expect(result(3).result.barriers.surfaceHeights[24]).toBe(1);
    expect(projectInundationMesh).toHaveBeenCalledTimes(2);
});

test("an unaccepted reply is rolled back before the next job, including a different domain", async () => {
    const {core, send, result} = harness();
    await send({id: 1, type: "geometry", payload: payload(1, 1)});
    await send({type: "accept", id: 1});
    await send({id: 2, type: "geometry", payload: payload(2, 20, 2)});
    expect(core.domain).toBe(2);
    await send({id: 3, type: "geometry", payload: payload(3)});
    expect(core.domain).toBe(1);
    expect(result(3).result.barriers.surfaceHeights[24]).toBe(1);
    // An acknowledgement arriving after supersession must not accept job 2.
    await send({type: "accept", id: 2});
    await send({type: "cancel", id: 3});
    expect(core.geometryId).toBe(1);
});

test("an accepted result remains cached when a later job is canceled", async () => {
    const {core, send, result} = harness();
    await send({id: 1, type: "geometry", payload: payload(1, 1)});
    await send({type: "accept", id: 1});
    await send({id: 2, type: "geometry", payload: payload(2, 3)});
    await send({type: "accept", id: 2});
    const accepted = core.records.get("tile");
    await send({id: 3, type: "geometry", payload: payload(3, 20)});
    await send({type: "cancel", id: 3});
    expect(core.records.get("tile")).toBe(accepted);
    await send({id: 4, type: "geometry", payload: payload(4)});
    expect(result(4).result.barriers.surfaceHeights[24]).toBe(3);
});

test("cancellation during projection waits for the old job before restoring cache state", async () => {
    const {core, send, result} = harness();
    await send({id: 1, type: "geometry", payload: payload(1, 1)});
    await send({type: "accept", id: 1});
    const oldRecord = core.records.get("tile");
    let finishProjection, started;
    const projectionStarted = new Promise(resolve => { started = resolve; });
    projectInundationMesh.mockImplementationOnce(change => {
        started();
        return new Promise(resolve => { finishProjection = () => resolve(change.fixtureProjected); });
    });
    const running = send({id: 2, type: "geometry", payload: payload(2, 20)});
    await projectionStarted;
    const canceled = send({type: "cancel", id: 2});
    const resumed = send({id: 3, type: "geometry", payload: payload(3)});
    finishProjection();
    await Promise.all([running, canceled, resumed]);
    expect(result(2)).toBeUndefined();
    expect(core.records.get("tile")).toBe(oldRecord);
    expect(result(3).result.barriers.surfaceHeights[24]).toBe(1);
});

test("clearing geometry is ordered after cancellation and preserves terrain/geoid for terrain-only fill", async () => {
    const {core, send, result} = harness();
    const terrain = {id: 10, size: 7, heights: new Float32Array(49).fill(1), ocean: new Uint8Array(49),
        seeds: new Uint8Array(49), cellMeters: 10};
    terrain.ocean[0] = terrain.seeds[0] = 1;
    core.terrain = terrain;
    core.geoid = new Int16Array([10]);
    const geoid = core.geoid;
    await send({id: 1, type: "geometry", payload: payload(1, 1)});
    await send({type: "accept", id: 1});
    let finishProjection, started;
    const projectionStarted = new Promise(resolve => { started = resolve; });
    projectInundationMesh.mockImplementationOnce(change => {
        started();
        return new Promise(resolve => { finishProjection = () => resolve(change.fixtureProjected); });
    });
    const running = send({id: 2, type: "geometry", payload: payload(2, 20)});
    await projectionStarted;
    const clear = send({type: "clearGeometry"});
    const fill = send({id: 3, type: "fill", payload: {terrainId: 10, useBuildings: false, level: 5}});
    finishProjection();
    await Promise.all([running, clear, fill]);
    expect(core.records.size).toBe(0);
    expect(core.barriers).toBeNull();
    expect(core.domain).toBeUndefined();
    expect(core.geometryId).toBeUndefined();
    expect(core.raster.coverageState).toBeNull();
    expect(core.raster.edges.size).toBe(0);
    expect(core.terrain).toBe(terrain);
    expect(core.geoid).toBe(geoid);
    expect(result(2)).toBeUndefined();
    expect(result(3).result.wet.every(Boolean)).toBe(true);
});

test("a geometry error restores the acknowledged domain and cached grids", async () => {
    const {core, send, result} = harness();
    await send({id: 1, type: "geometry", payload: payload(1, 1)});
    await send({type: "accept", id: 1});
    const oldRecord = core.records.get("tile"), oldCoverage = core.raster.coverageState;
    projectInundationMesh.mockRejectedValueOnce(new Error("invalid mesh"));
    await send({id: 2, type: "geometry", payload: payload(2, 20, 2)});
    expect(result(2).error).toBe("invalid mesh");
    expect(core.domain).toBe(1);
    expect(core.records.get("tile")).toBe(oldRecord);
    expect(core.raster.coverageState).toBe(oldCoverage);
});
