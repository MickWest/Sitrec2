import {Vector3} from "three";
import {TrackGroundCache} from "../src/TrackGroundCache";
import {Globals, setNodeMan, setSit} from "../src/Globals";
import {CNodeManager} from "../src/nodes/CNodeManager";
import {ECEFToLLAVD_radii, LLAToECEF} from "../src/LLA-ECEF-ENU";
import {restoreRoadGeometry, smoothRoadGeometry} from "../src/RoadGeometry";

jest.mock("3d-tiles-renderer/plugins", () => ({LoadRegionPlugin: class {constructor(options) {Object.assign(this, options);}}}), {virtual: true});
jest.mock("json-stringify-pretty-compact", () => ({__esModule: true, default: JSON.stringify}));
// Count the mesh work without real tile geometry.
jest.mock("../src/RoadGeometry", () => ({
    restoreRoadGeometry: jest.fn(),
    originalRoadGeometry: mesh => mesh.geometry,
    hasRoadGeometry: () => true,
    smoothRoadGeometry: jest.fn(() => true),
}));

// A corridor tile with two meshes. Its volume touches the whole route while
// corridor.inside is true.
function makeTile(name, geometricError, parent = null) {
    const meshes = [0, 1].map(i => ({name: `${name}${i}`, isMesh: true, geometry: {}}));
    const center = LLAToECEF(35, -88, 100);
    const corridor = {inside: true};
    const boundingVolume = {
        getAABB: target => { target.min.copy(center).subScalar(1000); target.max.copy(center).addScalar(1000); },
        intersectsSphere: () => corridor.inside,
        intersectsRay: () => true,
    };
    return {
        meshes, corridor,
        scene: {traverse: fn => meshes.forEach(fn), updateWorldMatrix: () => {}},
        tile: {name, geometricError, parent, engineData: {boundingVolume}},
    };
}

// A ground-locked track along the test road, moved north by `north` degrees.
function makeLock(id, roadTrack, north = 0) {
    return {id, altitudeLock: 0, altitudeLockAGL: true, roadTrack, recalculateCascade: jest.fn(),
        array: Array.from({length: 10}, (_, i) => ({position: LLAToECEF(35 + north, -88 + i * .00002, 100)}))};
}

// A path edit gives the track a new array, as a recalculation does.
function movePath(lock, north) {
    lock.array = makeLock(lock.id, lock.roadTrack, north).array;
}

function makeRenderer(tiles) {
    const listeners = {};
    return {
        tiles, listeners,
        registerPlugin: jest.fn(), unregisterPlugin: jest.fn(), removeEventListener: jest.fn(),
        addEventListener: (type, fn) => { listeners[type] = fn; },
        forEachLoadedModel: fn => tiles.forEach(({scene, tile}) => fn(scene, tile)),
    };
}

let manager, cache, raf, oldRAF, height;
beforeEach(() => {
    manager = new CNodeManager(); setNodeMan(manager);
    setSit({lat: 35, lon: -88});
    const ground = p => { const lla = ECEFToLLAVD_radii(p); return LLAToECEF(lla.x, lla.y, 100); };
    manager.add("TerrainModel", {group: {visible: false}, getPointBelow: ground});
    cache = new TrackGroundCache({});
    height = 2;
    cache.sample = jest.fn(p => p.clone().multiplyScalar(1 + height / p.length()));
    raf = [];
    oldRAF = global.requestAnimationFrame;
    global.requestAnimationFrame = fn => raf.push(fn);
    Globals.pendingActions = 0;
    smoothRoadGeometry.mockClear();
    smoothRoadGeometry.mockImplementation(() => true);
    restoreRoadGeometry.mockClear();
});
afterEach(() => { cache.dispose(); global.requestAnimationFrame = oldRAF; });

function settle() {
    for (let i = 0; i < 10; i++) {
        cache.lastLoad = -Infinity;
        cache.update();
        raf.splice(0).forEach(fn => fn());
    }
}

const smoothedNames = () => smoothRoadGeometry.mock.calls.map(([mesh]) => mesh.name).sort();

test("Road Track smooths the finest tiles of each view once, and again only when the road surface changes", () => {
    // View A has a coarse tile and its loaded child. View B has only the coarse tile.
    const parentA = makeTile("parentA", 10), childA = makeTile("childA", 1, parentA.tile);
    const parentB = makeTile("parentB", 10);
    const viewA = makeRenderer([parentA, childA]), viewB = makeRenderer([parentB]);
    cache.attach({renderer: viewA});
    cache.attach({renderer: viewB});
    const lock = {id: "road", altitudeLock: 0, altitudeLockAGL: true, roadTrack: true, recalculateCascade: jest.fn(),
        array: Array.from({length: 10}, (_, i) => ({position: LLAToECEF(35, -88 + i * .00002, 100)}))};
    manager.add(lock.id, lock);
    cache.pointBelow(lock.array[0].position, lock);
    settle();
    const record = cache.records.get(lock);
    expect(record.profile).not.toBeNull();
    expect(smoothedNames()).toEqual(["childA0", "childA1", "parentB0", "parentB1"]);
    expect(cache.modified.size).toBe(4);

    // A surface edit or an unrelated tile load with the same heights: nothing is restored or smoothed again.
    smoothRoadGeometry.mockClear();
    cache.invalidate();
    settle();
    expect(smoothRoadGeometry).not.toHaveBeenCalled();
    expect(restoreRoadGeometry).not.toHaveBeenCalled();
    expect(cache.hasPendingWork()).toBe(false);

    // A newly loaded corridor tile: only its own meshes are smoothed.
    const childB = makeTile("childB", 1, parentB.tile);
    viewB.tiles.push(childB);
    viewB.listeners["load-model"]({scene: childB.scene, tile: childB.tile});
    settle();
    expect(smoothedNames()).toEqual(["childB0", "childB1"]);
    expect(restoreRoadGeometry).not.toHaveBeenCalled();

    // Road Width does not move the centerline, but changes the surface. A mesh
    // that the road no longer touches leaves the modified set. The shown meshes
    // are not restored first; only the hidden parent in view B, which childB
    // replaces, is restored.
    smoothRoadGeometry.mockClear();
    smoothRoadGeometry.mockImplementation(mesh => mesh.name !== "childA0");
    lock.roadWidth = 12;
    settle();
    expect(smoothedNames()).toEqual(["childA0", "childA1", "childB0", "childB1"]);
    expect(restoreRoadGeometry.mock.calls.map(([mesh]) => mesh.name).sort()).toEqual(["parentB0", "parentB1"]);
    expect(cache.modified.has(childA.meshes[0])).toBe(false);
    expect(cache.modified.has(childA.meshes[1])).toBe(true);
    expect(cache.modified.has(parentB.meshes[0])).toBe(false);

    // New centerline heights smooth all the finest meshes again, without restoring them first.
    restoreRoadGeometry.mockClear();
    smoothRoadGeometry.mockClear();
    smoothRoadGeometry.mockImplementation(() => true);
    height = 3;
    cache.invalidate();
    settle();
    expect(smoothedNames()).toEqual(["childA0", "childA1", "childB0", "childB1"]);
    expect(restoreRoadGeometry).not.toHaveBeenCalled();

    // When a child unloads, its parent is the finest tile again and is smoothed for the current road.
    smoothRoadGeometry.mockClear();
    viewB.tiles.splice(viewB.tiles.indexOf(childB), 1);
    viewB.listeners["dispose-model"]({scene: childB.scene, tile: childB.tile});
    settle();
    expect(smoothedNames()).toEqual(["parentB0", "parentB1"]);

    // Turning Road Track off restores every smoothed mesh.
    restoreRoadGeometry.mockClear();
    lock.roadTrack = false;
    settle();
    expect(restoreRoadGeometry.mock.calls.map(([mesh]) => mesh.name).sort())
        .toEqual(["childA0", "childA1", "parentB0", "parentB1"]);
    expect(cache.modified.size).toBe(0);
    expect(cache.hasPendingWork()).toBe(false);
    expect(Globals.pendingActions).toBe(0);
});

const restoredNames = () => restoreRoadGeometry.mock.calls.map(([mesh]) => mesh.name).sort();

test("Edits of a ground-locked track that is not a road keep the road smoothing", () => {
    const leaf = makeTile("leaf", 1);
    cache.attach({renderer: makeRenderer([leaf])});
    const road = makeLock("road", true), car = makeLock("car", false);
    manager.add(road.id, road);
    manager.add(car.id, car);
    cache.pointBelow(road.array[0].position, road);
    cache.pointBelow(car.array[0].position, car);
    settle();
    expect(smoothedNames()).toEqual(["leaf0", "leaf1"]);

    // Move only the ordinary track by about 1 m: the road is not restored or smoothed again.
    smoothRoadGeometry.mockClear();
    movePath(car, 0.00001);
    settle();
    expect(cache.records.get(car).path[0].distanceTo(car.array[0].position)).toBe(0);
    expect(restoreRoadGeometry).not.toHaveBeenCalled();
    expect(smoothRoadGeometry).not.toHaveBeenCalled();

    // Turn its ground lock off, and on again.
    car.altitudeLock = -1;
    settle();
    expect(cache.records.has(car)).toBe(false);
    car.altitudeLock = 0;
    cache.pointBelow(car.array[0].position, car);
    settle();
    expect(cache.records.has(car)).toBe(true);
    expect(restoreRoadGeometry).not.toHaveBeenCalled();
    expect(smoothRoadGeometry).not.toHaveBeenCalled();
    expect(cache.modified.size).toBe(2);
    expect(cache.hasPendingWork()).toBe(false);
});

test("A road path edit smooths the road again in place, and restores the tiles that left the corridor", () => {
    const near = makeTile("near", 1), far = makeTile("far", 1);
    cache.attach({renderer: makeRenderer([near, far])});
    const road = makeLock("road", true);
    manager.add(road.id, road);
    cache.pointBelow(road.array[0].position, road);
    settle();
    expect(smoothedNames()).toEqual(["far0", "far1", "near0", "near1"]);

    // The edit removes the old profile. Until the new one is ready, the meshes
    // keep the old smoothing, and updateRoads() waits for it.
    smoothRoadGeometry.mockClear();
    far.corridor.inside = false;
    movePath(road, 0.00001);
    cache.lastLoad = -Infinity;
    cache.update();
    expect(cache.records.get(road).profile).toBeNull();
    expect(cache.updateRoads(true)).toBe(false);
    expect(restoreRoadGeometry).not.toHaveBeenCalled();
    expect(cache.modified.size).toBe(4);

    // The new profile smooths the corridor's meshes again without a restore, and
    // only the tile that left the corridor goes back to its raw geometry.
    settle();
    expect(smoothedNames()).toEqual(["near0", "near1"]);
    expect(restoredNames()).toEqual(["far0", "far1"]);
    expect([...cache.modified].map(mesh => mesh.name).sort()).toEqual(["near0", "near1"]);
    expect(cache.hasPendingWork()).toBe(false);
});

test("A parent that is shown while its corridor children load is smoothed too", () => {
    // The library shows the parent until all the children it uses are loaded.
    const parent = makeTile("parent", 10), first = makeTile("first", 1, parent.tile);
    parent.tile.traversal = {allChildrenLoaded: false};
    const view = makeRenderer([parent, first]);
    cache.attach({renderer: view});
    const road = makeLock("road", true);
    manager.add(road.id, road);
    cache.pointBelow(road.array[0].position, road);
    settle();
    expect(smoothedNames()).toEqual(["first0", "first1", "parent0", "parent1"]);

    // The second child loads, so the children replace the parent. The parent is
    // hidden now: it is neither smoothed again nor restored.
    smoothRoadGeometry.mockClear();
    const second = makeTile("second", 1, parent.tile);
    view.tiles.push(second);
    parent.tile.traversal.allChildrenLoaded = true;
    view.listeners["load-model"]({scene: second.scene, tile: second.tile});
    settle();
    expect(smoothedNames()).toEqual(["second0", "second1"]);
    expect(restoreRoadGeometry).not.toHaveBeenCalled();
    expect(cache.roadTiles.map(({tile}) => tile.name).sort()).toEqual(["first", "second"]);
});
