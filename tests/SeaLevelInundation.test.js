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
    if (seeds) data[0] = 255;
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
    expect(model.texture.image.data[1]).toBe(0);
    const texture = model.texture;
    model.suspend();
    model.update(region, map, 640, 2);
    expect(texture.image.data[1]).toBe(255);
    model.update(region, map, 640, 1);
    expect(texture.image.data[1]).toBe(0);
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
    expect(current.image.data[1]).toBe(255);
    model.dispose();
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
