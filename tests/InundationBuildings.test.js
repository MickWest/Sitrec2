jest.mock("../src/Globals", () => ({Globals: {equatorRadius: 6378137, polarRadius: 6356752.314245}}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: () => -30}));

import {BufferGeometry, EventDispatcher, Float32BufferAttribute, Group, InterleavedBuffer, InterleavedBufferAttribute, Mesh, MeshBasicMaterial} from "three";
import {addInundationTriangle, addInundationCoverageTriangle, connectedInundation} from "../src/water/InundationGrid";
import {InundationBuildings, InundationMeshCollector, inundationBuildingMeshes, inundationCoverageAtLevel} from "../src/water/InundationBuildings";
import {LLAToECEF} from "../src/LLA-ECEF-ENU";
import {mercatorX, mercatorY} from "../src/WaterMaskGeo";

function barriersAt(vertices, triangles, level, size = 7) {
    const barriers = {east: new Uint8Array(size * size), south: new Uint8Array(size * size)};
    for (const [a, b, c] of triangles) addInundationTriangle(vertices, a, b, c, level, barriers, size, size);
    return barriers;
}
function fill(barriers, level = 5, size = 7) {
    const heights = new Float32Array(size * size).fill(1), ocean = new Uint8Array(size * size);
    ocean[0] = 1;
    return connectedInundation(heights, ocean, size, size, level, undefined, barriers);
}

test("coarse ground well below a high tide is usable, while uncertain coastal heights require detail", () => {
    const coverage = new Uint8Array([1, 1, 1, 0]);
    const heights = new Float32Array([2, 6, 3, 0]), errors = new Float32Array([8, 8, 2, 0]);
    expect([...inundationCoverageAtLevel(coverage, heights, errors, 12.192, 5)]).toEqual([1, 0, 1, 0]);
    expect([...inundationCoverageAtLevel(coverage, heights, errors, 2.31648, 5)]).toEqual([0, 0, 1, 0]);
});

test("fine children replace coarse heights and barriers without removing uncovered parent cells", () => {
    const size = 7, coverage = new Uint8Array(49), heights = new Float32Array(49).fill(Infinity);
    const errors = new Float32Array(49).fill(Infinity);
    const coarse = new Float32Array([-1,-1,1, 7,-1,1, 7,7,1, -1,7,1]);
    const fine = new Float32Array([-1,-1,2, 4,-1,2, 4,7,2, -1,7,2]);
    for (const [vertices, error] of [[fine, 4], [coarse, 8]]) {
        for (const [a,b,c] of [[0,1,2], [0,2,3]]) addInundationCoverageTriangle(vertices,a,b,c,coverage,size,size,heights,errors,error);
    }
    expect(heights[3 * size + 2]).toBe(2);
    expect(heights[3 * size + 6]).toBe(1);
    expect(coverage.every(Boolean)).toBe(true);
    const wall = new Float32Array([2.5,-1,0, 2.5,7,0, 2.5,7,10, 2.5,-1,10]);
    const barriers = {east: new Uint8Array(49), south: new Uint8Array(49), surfaceErrors: errors};
    for (const [a,b,c] of [[0,1,2], [0,2,3]]) addInundationTriangle(wall,a,b,c,5,barriers,size,size,8);
    expect(barriers.east.some(Boolean)).toBe(false);
    for (const [a,b,c] of [[0,1,2], [0,2,3]]) addInundationTriangle(wall,a,b,c,5,barriers,size,size,2);
    expect(barriers.east.some(Boolean)).toBe(true);
});

test("a thin wall blocks flow between cells and can be overtopped", () => {
    const wall = new Float32Array([2.5,-1,0, 2.5,7,0, 2.5,7,10, 2.5,-1,10]);
    const triangles = [[0,1,2], [0,2,3]];
    const blocked = fill(barriersAt(wall, triangles, 5));
    for (let y = 0; y < 7; y++) {
        expect(blocked[y * 7 + 2]).toBe(255);
        expect(blocked[y * 7 + 3]).toBe(0);
    }
    expect(fill(barriersAt(wall, triangles, 11), 11).every(Boolean)).toBe(true);
});

test("a raised deck does not block flow beneath it", () => {
    const deck = new Float32Array([2,-1,10, 3,-1,10, 3,7,10, 2,7,10]);
    expect(fill(barriersAt(deck, [[0,1,2], [0,2,3]], 5)).every(Boolean)).toBe(true);
});

test("closed building walls leave the interior dry while water flows around them", () => {
    const vertices = [], triangles = [];
    const corners = [[1.5,1.5], [4.5,1.5], [4.5,4.5], [1.5,4.5]];
    for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4], n = vertices.length / 3;
        vertices.push(...a,0, ...b,0, ...b,10, ...a,10);
        triangles.push([n,n+1,n+2], [n,n+2,n+3]);
    }
    const wet = fill(barriersAt(new Float32Array(vertices), triangles, 5));
    expect(wet[3 * 7 + 3]).toBe(0);
    expect(wet[3 * 7 + 6]).toBe(255);
});

test("off-screen cached detail remains in the calculation while coarse ancestors and editing handles do not", () => {
    const group = new Group();
    const mesh = new Mesh(new BufferGeometry().setAttribute("position", new Float32BufferAttribute([0,0,0], 3)));
    const coarse = mesh.clone(), parent = {geometricError: 100}, tile = {geometricError: 2, parent};
    const renderer = {group, forEachLoadedModel: fn => { fn(coarse, parent); fn(mesh, tile); }};
    group.position.set(10, 20, 30);
    mesh.visible = false;
    const solid = mesh.clone();
    solid.visible = true;
    expect([...inundationBuildingMeshes([renderer], [solid], 10)]).toEqual([mesh, solid]);
    expect(mesh.matrixWorld.elements.slice(12, 15)).toEqual([10, 20, 30]);
    // Repeated reads must not accumulate a detached tile's group transform.
    inundationBuildingMeshes([renderer], [], 10);
    expect(mesh.matrixWorld.elements.slice(12, 15)).toEqual([10, 20, 30]);
    expect([...inundationBuildingMeshes([renderer], [], 1)]).toEqual([]);
    solid.visible = false;
    expect([...inundationBuildingMeshes([], [solid])]).toEqual([]);
});

test("missing off-screen photogrammetry cannot open a route around a seawall", () => {
    const size = 7, heights = new Float32Array(49), ocean = new Uint8Array(49);
    for (let y = 0; y < size; y++) ocean[y * size] = 1;
    const wall = new Float32Array([2.5,1,0, 2.5,7,0, 2.5,7,10, 2.5,1,10]);
    const barriers = barriersAt(wall, [[0,1,2], [0,2,3]], 5);
    // The missing first row lets a terrain-only fallback go around the wall.
    expect(connectedInundation(heights, ocean, size, size, 5, undefined, barriers)[24]).toBe(255);
    barriers.coverage = new Uint8Array(49);
    const ground = new Float32Array([-1,1,0, 7,1,0, 7,7,0, -1,7,0]);
    for (const [a,b,c] of [[0,1,2], [0,2,3]]) addInundationCoverageTriangle(ground, a,b,c, barriers.coverage, size,size);
    expect(connectedInundation(heights, ocean, size, size, 5, undefined, barriers)[24]).toBe(0);
    // Once the missing ground is genuinely loaded and open, flow is allowed.
    barriers.coverage.fill(1);
    expect(connectedInundation(heights, ocean, size, size, 5, undefined, barriers)[24]).toBe(255);
});

test("partial child loads retain usable parent coverage and deduplicate the views", () => {
    const mesh = () => new Mesh(new BufferGeometry().setAttribute("position", new Float32BufferAttribute([0,0,0], 3)));
    const coarse = mesh(), fine = mesh(), duplicate = mesh();
    const parentA = {content: {uri: "coast.glb"}}, parentB = {content: {uri: "coast.glb"}};
    const childA = {content: {uri: "wall.glb"}, parent: parentA}, childB = {content: {uri: "wall.glb"}, parent: parentB};
    const first = {group: new Group(), forEachLoadedModel: fn => fn(coarse, parentA)};
    const second = {group: new Group(), forEachLoadedModel: fn => fn(fine, childB)};
    expect([...inundationBuildingMeshes([first, second])]).toEqual([coarse, fine]);
    first.forEachLoadedModel = fn => { fn(coarse, parentA); fn(duplicate, childA); };
    expect([...inundationBuildingMeshes([first, second])]).toEqual([coarse, duplicate]);
});

test("tile selection is cached until models change, with listeners removed on disposal", () => {
    const renderer = new EventDispatcher();
    renderer.group = new Group();
    renderer.forEachLoadedModel = jest.fn();
    const collector = new InundationMeshCollector();
    collector.collect([renderer], [], 5);
    collector.collect([renderer], [], 5);
    renderer.dispatchEvent({type: "tile-visibility-change"});
    collector.collect([renderer], [], 5);
    expect(renderer.forEachLoadedModel).toHaveBeenCalledTimes(1);
    renderer.dispatchEvent({type: "load-model"});
    collector.collect([renderer], [], 5);
    expect(renderer.forEachLoadedModel).toHaveBeenCalledTimes(2);
    renderer.dispatchEvent({type: "dispose-model"});
    collector.collect([renderer], [], 5);
    expect(renderer.forEachLoadedModel).toHaveBeenCalledTimes(3);
    collector.dispose();
    expect(renderer.hasEventListener("load-model", collector.invalidate)).toBe(false);
    expect(renderer.hasEventListener("dispose-model", collector.invalidate)).toBe(false);
});

test("mesh samples correct a high DEM and reject ocean seeds above the water without closing raised decks", () => {
    const size = 7, heights = new Float32Array(49).fill(10), ocean = new Uint8Array(49);
    const barriers = {east: new Uint8Array(49), south: new Uint8Array(49), coverage: new Uint8Array(49),
        surfaceHeights: new Float32Array(49).fill(Infinity)};
    const ground = new Float32Array([-1,-1,1, 7,-1,1, 7,7,1, -1,7,1]);
    for (const [a,b,c] of [[0,1,2], [0,2,3]]) addInundationCoverageTriangle(ground, a,b,c, barriers.coverage, size,size, barriers.surfaceHeights);
    ocean[0] = 1;
    expect(connectedInundation(heights, ocean, size,size, 2, undefined, barriers).every(Boolean)).toBe(true);
    // A coast polygon overlapping known elevated land must not start a flood.
    barriers.surfaceHeights.fill(5);
    expect(connectedInundation(heights, ocean, size,size, 2, undefined, barriers).some(Boolean)).toBe(false);
    // A high deck prevents a seed on its top, but water can enter underneath
    // from an adjacent ocean cell when ground is low and there is no wall.
    heights.fill(0); barriers.surfaceHeights[0] = 0;
    ocean[1] = 1;
    expect(connectedInundation(heights, ocean, size,size, 2, undefined, barriers).every(Boolean)).toBe(true);
});

test("projects transformed geometry to the same datum and rebuilds after mesh edits", async () => {
    jest.useFakeTimers();
    const rect = {u0: mercatorX(-118) - 0.00001, v0: mercatorY(34) - 0.00001, du: 0.00002};
    const origin = LLAToECEF(34, -118, -30);
    const positions = [];
    for (const [lat, h] of [[33.995, 0], [34.005, 0], [34.005, 10], [33.995, 10]]) {
        LLAToECEF(lat, -118, h - 30).sub(origin).toArray(positions, positions.length);
    }
    const attribute = new InterleavedBufferAttribute(new InterleavedBuffer(new Float32Array(positions), 3), 3, 0);
    const geometry = new BufferGeometry().setAttribute("position", attribute);
    geometry.setIndex([0,1,2,0,2,3]);
    const mesh = new Mesh(geometry, new MeshBasicMaterial());
    mesh.position.copy(origin); mesh.updateMatrixWorld(true);
    const onReady = jest.fn(), model = new InundationBuildings(onReady);
    try {
        model.update([mesh], rect, 7, 5);
        await jest.advanceTimersByTimeAsync(200);
        expect(model.ready).toBe(true);
        expect(model.barriers.east.some(Boolean)).toBe(true);
        const first = model.barriers;
        model.update([mesh], rect, 7, 5);
        expect(model.ready).toBe(true);
        expect(model.barriers).toBe(first);
        // Move the wall well above the water, retaining the same geometry.
        const up = LLAToECEF(34, -118, 1).sub(LLAToECEF(34, -118, 0)).normalize();
        mesh.position.addScaledVector(up, 20); mesh.updateMatrixWorld(true);
        model.update([mesh], rect, 7, 5);
        expect(model.ready).toBe(false);
        await jest.advanceTimersByTimeAsync(200);
        expect(model.barriers.east.some(Boolean)).toBe(false);
        expect(onReady).toHaveBeenCalledTimes(2);
        // Geometry edits can update an interleaved buffer's version rather
        // than a version on the position attribute itself.
        for (let i = 0; i < attribute.count; i++) {
            attribute.setXYZ(i, attribute.getX(i) - up.x * 20, attribute.getY(i) - up.y * 20, attribute.getZ(i) - up.z * 20);
        }
        attribute.needsUpdate = true;
        model.update([mesh], rect, 7, 5);
        expect(model.ready).toBe(false);
        await jest.advanceTimersByTimeAsync(200);
        expect(model.barriers.east.some(Boolean)).toBe(true);
    } finally {
        model.dispose(); geometry.dispose(); mesh.material.dispose(); jest.useRealTimers();
    }
});

test("a synthetic deck does not replace photogrammetry ground or certify missing ground coverage", async () => {
    jest.useFakeTimers();
    const rect = {u0: mercatorX(-118) - 0.00001, v0: mercatorY(34) - 0.00001, du: 0.00002};
    const origin = LLAToECEF(34, -118, -30);
    const surface = h => {
        const vertices = [];
        for (const [lat, lon] of [[33.995,-118.005], [34.005,-118.005], [34.005,-117.995], [33.995,-117.995]]) {
            LLAToECEF(lat, lon, h - 30).sub(origin).toArray(vertices, vertices.length);
        }
        const geometry = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(vertices, 3));
        geometry.setIndex([0,1,2,0,2,3]);
        const mesh = new Mesh(geometry, new MeshBasicMaterial());
        mesh.position.copy(origin); mesh.updateMatrixWorld(true);
        return mesh;
    };
    const ground = surface(1), deck = surface(10), meshes = [ground, deck];
    meshes.errors = new Map([[ground, 2]]);
    const model = new InundationBuildings();
    try {
        model.update(meshes, rect, 7, 2, true, 5);
        await jest.advanceTimersByTimeAsync(250);
        expect(model.ready).toBe(true);
        expect(model.surfaceHeights[24]).toBeCloseTo(1, 1);
        expect(model.surfaceErrors[24]).toBe(2);
        expect(model.barriers.coverage[24]).toBe(1);
        model.update([deck], rect, 7, 2, true, 5);
        await jest.advanceTimersByTimeAsync(250);
        expect(model.barriers.coverage.some(Boolean)).toBe(false);
    } finally {
        model.dispose();
        for (const mesh of meshes) { mesh.geometry.dispose(); mesh.material.dispose(); }
        jest.useRealTimers();
    }
});

test("display-cache eviction retains calculation geometry, while a source change releases it", async () => {
    jest.useFakeTimers();
    const mesh = new Mesh(new BufferGeometry().setAttribute("position", new Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0], 3)));
    const model = new InundationBuildings(), rect = {}, sourceKey = {};
    const projected = [{vertices: new Float32Array([-1,-1,1, 10,-1,1, -1,10,1]), minHeight: 1, maxHeight: 1}];
    jest.spyOn(model, "project").mockResolvedValue(projected);
    const meshes = [mesh];
    Object.assign(meshes, {sourceKey, errors: new Map([[mesh,2]]), meshKeys: new Map([[mesh,"tile/0"]])});
    try {
        model.update(meshes,rect,7,2,true,5);
        await jest.advanceTimersByTimeAsync(250);
        expect(model.barriers.coverage[24]).toBe(1);
        expect(model.records.get("tile/0").input).not.toHaveProperty("mesh");
        const evicted = []; evicted.sourceKey = sourceKey;
        model.update(evicted,rect,7,3,true,5);
        await jest.advanceTimersByTimeAsync(250);
        expect(model.barriers.coverage[24]).toBe(1);
        expect(model.surfaceHeights[24]).toBe(1);
        expect(model.project).toHaveBeenCalledTimes(1);
        evicted.sourceKey = {};
        model.update(evicted,rect,7,3,true,5);
        await jest.advanceTimersByTimeAsync(250);
        expect(model.records.size).toBe(0);
        expect(model.barriers.coverage.some(Boolean)).toBe(false);
    } finally {
        model.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); jest.useRealTimers();
    }
});

test("incoming tiles do not starve a scheduled or running geometry batch", async () => {
    jest.useFakeTimers();
    const mesh = () => new Mesh(new BufferGeometry().setAttribute("position", new Float32BufferAttribute([0,0,0,1,0,0,0,1,0], 3)));
    const a = mesh(), b = mesh(), model = new InundationBuildings(), rect = {};
    const projected = [{vertices: new Float32Array([0,0,1,1,0,1,0,1,1]), minHeight: 1, maxHeight: 1}];
    let finish;
    jest.spyOn(model, "project").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(projected);
    try {
        model.update([a],rect,7,2);
        const generation = model.generation;
        await jest.advanceTimersByTimeAsync(100);
        model.update([a,b],rect,7,2);
        expect(model.generation).toBe(generation);
        await jest.advanceTimersByTimeAsync(150);
        expect(model.running).toBe(true);
        model.update([a,b],rect,7,2);
        expect(model.generation).toBe(generation);
        finish(projected);
        await jest.advanceTimersByTimeAsync(0);
        expect(model.ready).toBe(true);
        model.update([a,b],rect,7,2);
        await jest.advanceTimersByTimeAsync(250);
        expect(model.ready).toBe(true);
        expect(model.meshCount).toBe(2);
    } finally {
        model.dispose();
        for (const object of [a,b]) { object.geometry.dispose(); object.material.dispose(); }
        jest.useRealTimers();
    }
});
