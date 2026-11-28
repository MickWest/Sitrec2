import {Group, Mesh, MeshBasicMaterial, PlaneGeometry, Sphere, Vector3} from "three";
import {TrackGroundCache, TrackLoadRegion} from "../src/TrackGroundCache";
import {Globals, setNodeMan, setSit} from "../src/Globals";
import {CNodeManager} from "../src/nodes/CNodeManager";
import {LLAToECEF, ECEFToLLAVD_radii} from "../src/LLA-ECEF-ENU";
import {EventManager} from "../src/CEventManager";
import {getLocalNorthVector, getLocalUpVector} from "../src/SphericalMath";

jest.mock("3d-tiles-renderer/plugins", () => ({LoadRegionPlugin: class {constructor(options) {Object.assign(this, options);}}}), {virtual: true});
jest.mock("json-stringify-pretty-compact", () => ({__esModule: true, default: JSON.stringify}));

function volume(point, radius = 1) {
    const sphere = new Sphere(point, radius);
    return {getAABB: target => {sphere.getBoundingBox(target);}, intersectsSphere: s => s.intersectsSphere(sphere)};
}
test("the retained region follows the route, including offscreen leaves, without enclosing its interior", () => {
    const region = new TrackLoadRegion();
    region.setPaths([[new Vector3(0, 0, 0), new Vector3(500, 0, 0), new Vector3(500, 500, 0)]]);
    expect(region.intersectsTile(volume(new Vector3(250, 0, 0)))).toBe(true);
    expect(region.intersectsTile(volume(new Vector3(250, 250, 0)))).toBe(false);
    expect(region.calculateError({geometricError: 0})).toBe(Infinity);
    region.setPaths([]);
    expect(region.intersectsTile(volume(new Vector3()))).toBe(false);
});

test("a tile volume is tested once per path change, and only against the spheres near it", () => {
    const region = new TrackLoadRegion();
    const path = Array.from({length: 101}, (_, i) => new Vector3(i * 20, 0, 0));
    region.setPaths([path]);
    const near = volume(new Vector3(1990, 0, 0));
    const sphereTests = jest.spyOn(near, "intersectsSphere");
    const boxTests = jest.spyOn(near, "getAABB");
    expect(region.intersectsTile(near)).toBe(true);
    // Only the last block of spheres overlaps this tile.
    expect(sphereTests.mock.calls.length).toBeGreaterThan(0);
    expect(sphereTests.mock.calls.length).toBeLessThan(10);
    const calls = sphereTests.mock.calls.length;
    for (let i = 0; i < 5; i++) expect(region.intersectsTile(near)).toBe(true);
    expect(sphereTests).toHaveBeenCalledTimes(calls);
    expect(boxTests).toHaveBeenCalledTimes(1);
    // A path change tests the tile again.
    region.setPaths([path.slice(0, 50)]);
    expect(region.intersectsTile(near)).toBe(false);
    expect(boxTests).toHaveBeenCalledTimes(2);
    expect(region.intersectsTile(volume(new Vector3(500, 0, 0)))).toBe(true);
});

test("corridor-only tiles download and parse after the tiles in view, in both shared queues", () => {
    const region = new TrackLoadRegion();
    expect(region.calculateDistance()).toBe(Infinity);
    // Like the library's queues: the highest error sorts last, and the end of the list runs first.
    const byError = (a, b) => a.traversal.error > b.traversal.error ? 1 : -1;
    const downloadQueue = {priorityCallback: byError}, parseQueue = {priorityCallback: byError};
    const renderer = () => ({registerPlugin: jest.fn(), unregisterPlugin: jest.fn(), addEventListener: jest.fn(),
        removeEventListener: jest.fn(), downloadQueue, parseQueue});
    const cache = new TrackGroundCache({});
    cache.attach({renderer: renderer()});
    cache.attach({renderer: renderer()});
    const corridor = {name: "corridor", traversal: {error: Infinity, distanceFromCamera: Infinity}};
    const corridorInView = {name: "corridorInView", traversal: {error: Infinity, distanceFromCamera: 50}};
    const inView = {name: "inView", traversal: {error: 3, distanceFromCamera: 200}};
    const runOrder = queue => [corridor, inView, corridorInView].sort(queue.priorityCallback).reverse().map(t => t.name);
    expect(runOrder(downloadQueue)).toEqual(["corridorInView", "inView", "corridor"]);
    expect(runOrder(parseQueue)).toEqual(["corridorInView", "inView", "corridor"]);
    cache.dispose();
    expect(downloadQueue.priorityCallback).toBe(byError);
    expect(parseQueue.priorityCallback).toBe(byError);
});

test("an offscreen fine mesh supplies ground even at a seam outside its declared tile bounds", () => {
    setSit({lat: 35, lon: -88});
    const point = LLAToECEF(35, -88, 100);
    const up = getLocalUpVector(point), north = getLocalNorthVector(point), east = north.clone().cross(up);
    const makeTile = (height, geometricError) => {
        const scene = new Group();
        scene.matrixAutoUpdate = false;
        scene.matrix.makeBasis(east, north, up).setPosition(point.clone().addScaledVector(up, height));
        scene.add(new Mesh(new PlaneGeometry(20, 20), new MeshBasicMaterial()));
        const boundingVolume = {...volume(point, 30), intersectsRay: () => true};
        return {scene, tile: {geometricError, engineData: {boundingVolume}}};
    };
    const coarse = makeTile(2, 10), fine = makeTile(5, 0);
    fine.tile.engineData.boundingVolume.intersectsRay = () => false;
    const cache = new TrackGroundCache({});
    cache.region.setPaths([[point]]);
    cache.renderers = [{renderer: {forEachLoadedModel: fn => {fn(coarse.scene, coarse.tile); fn(fine.scene, fine.tile);}}}];
    cache.collectTiles();
    expect(cache.sample(point).clone().sub(point).dot(up)).toBeCloseTo(5, 6);
    cache.renderers = [];
    cache.dispose();
});

test("camera visibility does not resample a track; corridor arrivals do, and deleting a lock releases it", () => {
    const manager = new CNodeManager(); setNodeMan(manager);
    setSit({lat: 35, lon: -88});
    let elevation = 100;
    const ground = p => {const lla = ECEFToLLAVD_radii(p); return LLAToECEF(lla.x, lla.y, elevation);};
    manager.add("TerrainModel", {group: {visible: false}, getPointBelow: ground});
    const lock = {id: "road", altitudeLock: 0, altitudeLockAGL: true, array: [0, 1, 2].map(i => ({position: LLAToECEF(35, -88 + i * .00002, 100)})), recalculateCascade: jest.fn()};
    manager.add(lock.id, lock);
    const cache = new TrackGroundCache({});
    const listeners = {};
    const renderer = {registerPlugin: jest.fn(), unregisterPlugin: jest.fn(), addEventListener: (type, fn) => {listeners[type] = fn;}, removeEventListener: jest.fn(), forEachLoadedModel: jest.fn()};
    const pv = {renderer}; cache.attach(pv);
    const raf = [];
    const oldRAF = global.requestAnimationFrame;
    global.requestAnimationFrame = fn => raf.push(fn);
    Globals.pendingActions = 0;
    cache.sample = jest.fn(p => p.clone().multiplyScalar(1 + 2 / p.length()));
    try {
        cache.pointBelow(lock.array[0].position, lock);
        cache.update(); cache.lastLoad = -10000;
        for (let i = 0; i < 10; i++) cache.update();
        raf.splice(0).forEach(fn => fn());
        expect(lock.recalculateCascade).toHaveBeenCalledTimes(1);
        const calls = cache.sample.mock.calls.length;
        for (let i = 0; i < 20; i++) cache.update();
        expect(cache.sample).toHaveBeenCalledTimes(calls);
        lock.roadTrack = true;
        cache.update();
        raf.splice(0).forEach(fn => fn());
        expect(cache.records.get(lock).profile).not.toBeNull();
        lock.roadSmoothing = 35;
        cache.update();
        raf.splice(0).forEach(fn => fn());
        expect(cache.sample).toHaveBeenCalledTimes(calls);
        lock.roadTrack = false;
        cache.update();
        raf.splice(0).forEach(fn => fn());
        expect(cache.records.get(lock).profile).toBeNull();
        expect(cache.sample).toHaveBeenCalledTimes(calls);
        expect(listeners["tile-visibility-change"]).toBeUndefined();
        EventManager.dispatchEvent("elevationChanged");
        expect(cache.hasPendingWork()).toBe(false);
        elevation = 110;
        EventManager.dispatchEvent("elevationChanged");
        expect(cache.hasPendingWork()).toBe(true);
        expect(ECEFToLLAVD_radii(cache.records.get(lock).route[0]).z).toBeCloseTo(110, 5);
        cache.lastLoad = -10000;
        for (let i = 0; i < 10; i++) cache.update();
        raf.splice(0).forEach(fn => fn());
        listeners["load-model"]({tile: {engineData: {boundingVolume: volume(LLAToECEF(36, -88, 100))}}});
        expect([...cache.records.get(lock).samples.values()].every(e => !e.pending)).toBe(true);
        listeners["load-model"]({tile: {engineData: {boundingVolume: volume(lock.array[0].position)}}});
        expect([...cache.records.get(lock).samples.values()].every(e => e.pending)).toBe(true);
        lock.altitudeLock = -1;
        cache.update();
        expect(cache.records.size).toBe(0);
        expect(cache.region.spheres).toHaveLength(0);
        expect(Globals.pendingActions).toBe(0);
    } finally { cache.dispose(); global.requestAnimationFrame = oldRAF; }
});

test("columns that no consumer, caller or route uses are released, and only pending columns are sampled", () => {
    const manager = new CNodeManager(); setNodeMan(manager);
    setSit({lat: 35, lon: -88});
    const ground = p => {const lla = ECEFToLLAVD_radii(p); return LLAToECEF(lla.x, lla.y, 100);};
    manager.add("TerrainModel", {group: {visible: false}, getPointBelow: ground});
    const path = east => [0, 1, 2].map(i => ({position: LLAToECEF(35, -88 + i * .00002 + east / 91000, 100)}));
    const lock = {id: "road", altitudeLock: 0, altitudeLockAGL: true, array: path(0), recalculateCascade: jest.fn()};
    const smoother = {id: "smoother"};
    manager.add(lock.id, lock); manager.add(smoother.id, smoother);
    const cache = new TrackGroundCache({});
    const raf = [];
    const oldRAF = global.requestAnimationFrame;
    global.requestAnimationFrame = fn => raf.push(fn);
    Globals.pendingActions = 0;
    cache.sample = jest.fn(p => p.clone().multiplyScalar(1 + 2 / p.length()));
    const settle = () => { for (let i = 0; i < 10; i++) { cache.lastLoad = -10000; cache.update(); raf.splice(0).forEach(fn => fn()); } };
    // One pass of a smoothed track: 50 frames, 5.5 m beside the route, with a
    // new column for each frame.
    const frame = (shift, f) => LLAToECEF(35.00005 + shift * 1e-6, -88 + 0.000025 + f * 2e-7, 100);
    const pass = shift => {
        cache.beginPass(lock, smoother);
        for (let f = 0; f < 50; f++) cache.pointBelow(frame(shift, f), lock, smoother);
    };
    try {
        const callerColumn = LLAToECEF(35.0001, -88, 100);
        cache.pointBelow(callerColumn, lock);
        pass(0);
        settle();
        const record = cache.records.get(lock);
        const routeColumns = record.routeKeys.size;
        for (let shift = 1; shift <= 5; shift++) pass(shift);
        cache.lastLoad = performance.now();
        cache.update();
        // The latest pass, the route and the other caller's column.
        expect(record.samples.size).toBe(50 + routeColumns + 1);
        expect(record.pending.size).toBe(50);
        const sampled = cache.sample.mock.calls.length;
        settle();
        expect(cache.sample).toHaveBeenCalledTimes(sampled + 50);
        expect(cache.hasPendingWork()).toBe(false);
        // A caller without a consumer keeps its column through a path edit made
        // without it, and loses it at the next path edit after it has moved on.
        lock.array = path(1);
        settle();
        expect(record.samples.size).toBe(50 + record.routeKeys.size + 1);
        cache.pointBelow(LLAToECEF(35.0002, -88, 100), lock);
        lock.array = path(2);
        settle();
        expect(record.samples.size).toBe(50 + record.routeKeys.size + 1);
        cache.pointBelow(callerColumn, lock);
        expect(record.pending.size).toBe(1);
        // Road Track reads every route column, so pruning must keep them.
        lock.roadTrack = true;
        pass(6);
        settle();
        expect(record.profile.pointBelow(frame(6, 0))).not.toBeNull();
        // While Road Track answers, a pass still keeps its columns' tile heights.
        const sampledWithRoad = cache.sample.mock.calls.length;
        pass(6);
        settle();
        lock.roadTrack = false;
        pass(6);
        settle();
        expect(record.profile).toBeNull();
        expect(cache.sample).toHaveBeenCalledTimes(sampledWithRoad);
        expect(Globals.pendingActions).toBe(0);
        // A smoothed track's frames move a little while Road Track answers. Its last
        // pass without Road Track keeps its columns, so turning Road Track off
        // resamples nothing.
        lock.roadTrack = true;
        pass(6);
        settle();
        pass(7);
        settle();
        const sampledBeforeOff = cache.sample.mock.calls.length;
        lock.roadTrack = false;
        pass(6);
        settle();
        expect(record.profile).toBeNull();
        expect(cache.sample).toHaveBeenCalledTimes(sampledBeforeOff);
    } finally { cache.dispose(); global.requestAnimationFrame = oldRAF; }
});
