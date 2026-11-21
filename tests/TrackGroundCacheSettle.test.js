import {CatmullRomCurve3} from "three";
import {TrackGroundCache} from "../src/TrackGroundCache";
import {Globals, setNodeMan, setSit} from "../src/Globals";
import {CNodeManager} from "../src/nodes/CNodeManager";
import {ECEFToLLAVD_radii, LLAToECEF} from "../src/LLA-ECEF-ENU";
import {raisePoint} from "../src/SphericalMath";

jest.mock("3d-tiles-renderer/plugins", () => ({LoadRegionPlugin: class {constructor(options) {Object.assign(this, options);}}}), {virtual: true});
jest.mock("json-stringify-pretty-compact", () => ({__esModule: true, default: JSON.stringify}));

// The elevation map is flat. The tiles are not, so the chord lengths of the
// spline change when the control points move from one to the other.
const tileHeight = (lat, lon) => 102 + 6 * Math.sin((lon + 88) * 3000) + 4 * Math.cos((lat - 35) * 2500);
const atHeight = (point, height) => {
    const lla = ECEFToLLAVD_radii(point);
    return LLAToECEF(lla.x, lla.y, height(lla.x, lla.y));
};

let manager, cache, raf, oldRAF;
beforeEach(() => {
    manager = new CNodeManager(); setNodeMan(manager);
    setSit({lat: 35, lon: -88});
    manager.add("TerrainModel", {group: {visible: false}, getPointBelow: p => atHeight(p, () => 100)});
    cache = new TrackGroundCache({});
    cache.sample = jest.fn(p => atHeight(p, tileHeight));
    raf = [];
    oldRAF = global.requestAnimationFrame;
    global.requestAnimationFrame = fn => raf.push(fn);
    Globals.pendingActions = 0;
});
afterEach(() => { cache.dispose(); global.requestAnimationFrame = oldRAF; });

// A ground-locked spline track, as CNodeSplineEdit builds it: the control
// points and then every frame are put at the lock height above the ground.
function splineTrack(curveType) {
    const controls = [[0, 0], [0.0008, 0.001], [0.0005, 0.0022], [0.0014, 0.003], [0.001, 0.0042], [0.002, 0.005]]
        .map(([lat, lon]) => LLAToECEF(35 + lat, -88 + lon, 0));
    const lock = {id: "spline", altitudeLock: 2, altitudeLockAGL: true, recalcs: 0};
    lock.syncControlPointsToAltitudeLock = () => {
        lock.controls = controls.map(p => raisePoint(cache.pointBelow(p, lock), lock.altitudeLock));
    };
    lock.recalculate = () => {
        const curve = new CatmullRomCurve3(lock.controls, false, curveType);
        lock.array = Array.from({length: 600}, (_, f) => ({
            position: raisePoint(cache.pointBelow(curve.getPoint(f / 599), lock), lock.altitudeLock),
        }));
    };
    lock.recalculateCascade = () => { lock.recalcs++; lock.recalculate(); };
    manager.add(lock.id, lock);
    lock.syncControlPointsToAltitudeLock();
    lock.recalculate();
    return lock;
}

function run(updates) {
    for (let i = 0; i < updates; i++) {
        cache.lastLoad = -Infinity;
        cache.update();
        raf.splice(0).forEach(fn => fn());
    }
}

test.each(["chordal", "centripetal"])("a ground-locked %s spline settles on the tiles and stops recalculating", curveType => {
    const lock = splineTrack(curveType);
    run(30);
    const recalcs = lock.recalcs;
    expect(recalcs).toBeGreaterThan(0);
    expect(recalcs).toBeLessThanOrEqual(4);
    run(30);
    expect(lock.recalcs).toBe(recalcs);
    expect(cache.hasPendingWork()).toBe(false);
    expect(Globals.pendingActions).toBe(0);
    for (const f of [0, 150, 300, 450, 599]) {
        const lla = ECEFToLLAVD_radii(lock.array[f].position);
        expect(lla.z - tileHeight(lla.x, lla.y)).toBeCloseTo(2, 2);
    }
});

test("only a frame count change or a sideways move of more than 25 cm rebuilds the route", () => {
    const lock = splineTrack("chordal");
    run(30);
    const record = cache.records.get(lock);
    const route = record.route;
    const move = (east, up = 0) => {
        lock.array = lock.array.map(({position}) => {
            const lla = ECEFToLLAVD_radii(position);
            return {position: LLAToECEF(lla.x, lla.y + east / 91000, lla.z + up)};
        });
        cache.update();
    };
    move(0.1, 3);
    expect(record.route).toBe(route);
    expect(cache.hasPendingWork()).toBe(false);
    move(0.5);
    expect(record.route).not.toBe(route);
    // The sampled columns stay, so the old tile heights hold while they are resampled.
    expect([...record.samples.values()].some(e => e.pending && e.value.distanceTo(e.point) > 0.5)).toBe(true);
    const rebuilt = record.route;
    lock.array = lock.array.slice(1);
    cache.update();
    expect(record.route).not.toBe(rebuilt);
});
