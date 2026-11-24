jest.mock("../src/WaterMaskGeo", () => ({loadOceanMaskRegion: jest.fn()}));
jest.mock("../src/water/InundationTerrain", () => ({loadInundationTerrain: jest.fn()}));

import {SeaLevelInundation} from "../src/water/SeaLevelInundation";
import {loadOceanMaskRegion} from "../src/WaterMaskGeo";
import {loadInundationTerrain} from "../src/water/InundationTerrain";

const geometry = () => ({maskRect: {u0: 0.15, v0: 0.4, du: 0.001}});
const map = {options: {zScale: 1}};
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function oceanTexture(seeds = true) {
    const data = new Uint8Array(64 * 64 * 4);
    if (seeds) for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) data[(y * 64 + x) * 4] = 255;
    return {image: {getContext: () => ({getImageData: () => ({data})})}, dispose: jest.fn()};
}

beforeEach(() => {
    jest.clearAllMocks();
    loadOceanMaskRegion.mockImplementation(async () => oceanTexture());
    loadInundationTerrain.mockImplementation(async () => ({heights: new Float32Array(64 * 64).fill(2), missing: 0}));
});

test("reuses height data for level edits and restores a dry region when lowering the level", async () => {
    const model = new SeaLevelInundation(jest.fn()), region = geometry();
    expect(model.update(region, map, 640, 1)).toBeNull();
    await settle();
    expect(model.status).toBe("Ready");
    expect(model.texture.image.data[6]).toBe(0);
    const texture = model.texture;
    model.suspend();
    model.update(region, map, 640, 2);
    expect(texture.image.data[6]).toBe(255);
    model.update(region, map, 640, 1);
    expect(texture.image.data[6]).toBe(0);
    expect(loadInundationTerrain).toHaveBeenCalledTimes(1);
    model.dispose();
});

test("discarded asynchronous terrain loads cannot replace a more recent region", async () => {
    let finishOld;
    loadInundationTerrain.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const model = new SeaLevelInundation(jest.fn());
    model.update(geometry(), map, 640, 1);
    await settle();
    model.update(geometry(), map, 640, 3);
    await settle();
    const current = model.texture;
    finishOld({heights: new Float32Array(64 * 64).fill(99), missing: 100});
    await settle();
    expect(model.texture).toBe(current);
    expect(model.status).toBe("Ready");
    expect(current.image.data[6]).toBe(255);
    model.dispose();
});

test("locking cancels an initial terrain load and unlocking can restart the same region", async () => {
    let finishOld;
    loadInundationTerrain.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const model = new SeaLevelInundation(jest.fn()), region = geometry();
    model.update(region, map, 640, 3);
    await settle();
    model.pauseCalculation();
    expect(model.controller.signal.aborted).toBe(true);
    finishOld({heights: new Float32Array(64 * 64).fill(99), missing: 0});
    await settle();
    expect(model.texture).toBeNull();
    model.update(region, map, 640, 3);
    await settle();
    expect(model.texture.image.data[6]).toBe(255);
    expect(loadInundationTerrain).toHaveBeenCalledTimes(2);
    model.dispose();
});

test("locking preserves the result and cancels queued geometry work without preventing resume", async () => {
    jest.useFakeTimers();
    const model = new SeaLevelInundation(jest.fn()), region = geometry();
    try {
        model.update(region, map, 640, 3, [], true);
        await jest.advanceTimersByTimeAsync(250);
        model.update(region, map, 640, 3, [], true);
        const texture = model.texture, routes = model.flowRoutes, barriers = model.buildings.barriers;
        const pixels = texture.image.data.slice();
        model.buildings.inputs = null;
        model.update(region, map, 640, 3, [], true);
        expect(model.buildings.timer).not.toBeNull();
        model.pauseCalculation();
        await jest.advanceTimersByTimeAsync(500);
        expect(model.texture).toBe(texture);
        expect(model.texture.image.data).toEqual(pixels);
        expect(model.flowRoutes).toBe(routes);
        expect(model.buildings.barriers).toBe(barriers);
        expect(model.buildings.timer).toBeNull();
        model.update(region, map, 640, 3, [], true);
        await jest.advanceTimersByTimeAsync(250);
        expect(model.update(region, map, 640, 3, [], true)).toBe(texture);
        expect(model.buildings.ready).toBe(true);
        expect(loadInundationTerrain).toHaveBeenCalledTimes(1);
    } finally {
        model.dispose(); jest.useRealTimers();
    }
});

test("missing ocean coverage stays dry and does not start an elevation download", async () => {
    loadOceanMaskRegion.mockResolvedValue(oceanTexture(false));
    const model = new SeaLevelInundation(jest.fn());
    model.update(geometry(), map, 640, 20);
    await settle();
    expect(model.texture).toBeNull();
    expect(model.status).toMatch(/No ocean/);
    expect(loadInundationTerrain).not.toHaveBeenCalled();
    model.dispose();
});

test("failed ocean data is reported without reverting to unrestricted flooding", async () => {
    loadOceanMaskRegion.mockRejectedValue(new Error("Ocean map could not be loaded."));
    const model = new SeaLevelInundation(jest.fn());
    model.update(geometry(), map, 640, 20);
    await settle();
    expect(model.texture).toBeNull();
    expect(model.status).toMatch(/could not be loaded/);
    model.dispose();
});

test("the 3D option reports absent meshes and can be disabled during a pending recalculation", async () => {
    jest.useFakeTimers();
    const model = new SeaLevelInundation(jest.fn()), region = geometry();
    try {
        model.update(region, map, 640, 1, []);
        await jest.advanceTimersByTimeAsync(250);
        model.update(region, map, 640, 1, []);
        expect(model.status).toMatch(/no 3D geometry loaded/);
        expect(model.texture.image.data[6]).toBe(0);
        const texture = model.texture;
        model.suspend();
        expect(model.buildings).toBeNull();
        expect(model.buildingMeshes).toBeNull();
        expect(model.texture).toBe(texture);
        expect(model.update(region, map, 640, 3, [])).toBeNull();
        expect(model.update(region, map, 640, 3, null)).toBe(model.texture);
        expect(model.status).toBe("Ready");
        expect(model.texture.image.data[6]).toBe(255);
    } finally {
        model.dispose(); jest.useRealTimers();
    }
});

test("empty photogrammetry coverage blocks inland flooding instead of falling back to terrain", async () => {
    jest.useFakeTimers();
    const model = new SeaLevelInundation(jest.fn()), region = geometry();
    const meshes = []; meshes.requireCoverage = true;
    try {
        model.update(region, map, 640, 3, meshes, true);
        await jest.advanceTimersByTimeAsync(250);
        model.update(region, map, 640, 3, meshes, true);
        expect(model.status).toMatch(/missing 3D coverage blocks flow/);
        expect(model.texture.image.data[0]).toBe(255);
        expect(model.texture.image.data[6]).toBe(0);
        expect(model.flowRoutes).toEqual([]);
        model.update(region, map, 640, 3, null, true);
        expect(model.texture.image.data[6]).toBe(255);
        expect(model.flowRoutes.length).toBeGreaterThan(0);
        model.update(region, map, 640, 3, null, false);
        expect(model.flowRoutes).toEqual([]);
        expect(loadInundationTerrain).toHaveBeenCalledTimes(1);
    } finally {
        model.dispose(); jest.useRealTimers();
    }
});
