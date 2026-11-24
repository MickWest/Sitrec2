jest.mock("../src/Globals", () => ({Globals: {equatorRadius: 6378137, polarRadius: 6356752.314245}}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: () => -30}));

import {BufferGeometry, Float32BufferAttribute, Group, InterleavedBuffer, InterleavedBufferAttribute, Mesh, MeshBasicMaterial} from "three";
import {addInundationTriangle, addInundationCoverageTriangle, connectedInundation} from "../src/water/InundationGrid";
import {InundationBuildings, inundationBuildingMeshes} from "../src/water/InundationBuildings";
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
    expect(inundationBuildingMeshes([renderer], [solid], 10)).toEqual([mesh, solid]);
    expect(mesh.matrixWorld.elements.slice(12, 15)).toEqual([10, 20, 30]);
    // Repeated reads must not accumulate a detached tile's group transform.
    inundationBuildingMeshes([renderer], [], 10);
    expect(mesh.matrixWorld.elements.slice(12, 15)).toEqual([10, 20, 30]);
    expect(inundationBuildingMeshes([renderer], [], 1)).toEqual([]);
    solid.visible = false;
    expect(inundationBuildingMeshes([], [solid])).toEqual([]);
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

test("detail loaded in one view replaces the other view's cached parent", () => {
    const mesh = () => new Mesh(new BufferGeometry().setAttribute("position", new Float32BufferAttribute([0,0,0], 3)));
    const coarse = mesh(), fine = mesh(), duplicate = mesh();
    const parentA = {content: {uri: "coast.glb"}}, parentB = {content: {uri: "coast.glb"}};
    const childA = {content: {uri: "wall.glb"}, parent: parentA}, childB = {content: {uri: "wall.glb"}, parent: parentB};
    const first = {group: new Group(), forEachLoadedModel: fn => fn(coarse, parentA)};
    const second = {group: new Group(), forEachLoadedModel: fn => fn(fine, childB)};
    expect(inundationBuildingMeshes([first, second])).toEqual([fine]);
    first.forEachLoadedModel = fn => { fn(coarse, parentA); fn(duplicate, childA); };
    expect(inundationBuildingMeshes([first, second])).toEqual([duplicate]);
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
