jest.mock("../src/Globals", () => ({Globals: {equatorRadius: 6378137, polarRadius: 6356752.314245}}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: () => -30,
    ensureGeoidLoaded: async () => new Int16Array(721 * 1440).fill(-3000)}));

import {BufferGeometry, InstancedMesh, InterleavedBuffer, InterleavedBufferAttribute, Matrix4} from "three";
import {InundationBuildings} from "../src/water/InundationBuildings";
import {InundationWorkerCore} from "../src/water/InundationWorkerCore";
import {LLAToECEF} from "../src/LLA-ECEF-ENU";
import {mercatorX, mercatorY} from "../src/WaterMaskMath";

test("packed worker geometry matches scene projection, caches tide changes and retains evicted instances", async () => {
    jest.useFakeTimers();
    const origin = LLAToECEF(34, -118, -30), values = [];
    for (const [lat, altitude] of [[33.995, 0], [34.005, 0], [34.005, 10], [33.995, 10]]) {
        const point = LLAToECEF(lat, -118, altitude - 30).sub(origin);
        values.push(point.x, point.y, point.z, 123);
    }
    const geometry = new BufferGeometry().setAttribute("position",
        new InterleavedBufferAttribute(new InterleavedBuffer(new Float64Array(values), 4), 3, 0));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new InstancedMesh(geometry, undefined, 2);
    mesh.position.copy(origin);
    mesh.setMatrixAt(0, new Matrix4());
    mesh.setMatrixAt(1, new Matrix4().makeTranslation(100, 0, 0));
    mesh.updateMatrixWorld(true);
    const core = new InundationWorkerCore(), payloads = [];
    const worker = {cancel() {}, clearGeometry() {}, request: async (type, payload, transfer) => {
        // Use the actual transfer operation; only temporary packed buffers move.
        const message = structuredClone(payload, {transfer});
        payloads.push(message);
        return structuredClone(await core.geometry(message, async () => {}, () => {}));
    }};
    const model = new InundationBuildings(null, {worker}), serial = new InundationBuildings(null, {worker: null});
    const rect = {u0: mercatorX(-118) - 0.00001, v0: mercatorY(34) - 0.00001, du: 0.00002};
    const meshes = [mesh];
    Object.assign(meshes, {sourceKey: {}, errors: new Map([[mesh, 2]]), meshKeys: new Map([[mesh, "tile/0"]])});
    try {
        for (const calculation of [model, serial]) calculation.update(meshes, rect, 7, 5, true, 5);
        await jest.advanceTimersByTimeAsync(250);
        expect(model.ready).toBe(true);
        expect(model.barriers).toEqual(serial.barriers);
        expect(geometry.attributes.position.data.array.byteLength).toBe(values.length * 8);
        expect(geometry.index.array.byteLength).toBeGreaterThan(0);
        model.update(meshes, rect, 7, 11, true, 5);
        await jest.advanceTimersByTimeAsync(250);
        expect(payloads[1].changes).toHaveLength(0);
        expect(model.barriers.east.some(Boolean)).toBe(false);
        const barriers = model.barriers, evicted = [];
        evicted.sourceKey = meshes.sourceKey;
        model.update(evicted, rect, 7, 11, true, 5);
        await jest.advanceTimersByTimeAsync(250);
        expect(model.barriers).toBe(barriers);
        expect(payloads).toHaveLength(2);
        expect(core.records.has("tile/0")).toBe(true);
    } finally {
        model.dispose(); serial.dispose(); geometry.dispose(); jest.useRealTimers();
    }
});
