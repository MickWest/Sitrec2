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

test("an offscreen fine tile is sampled before its first render instead of caching its coarse parent", () => {
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
