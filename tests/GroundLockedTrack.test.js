import {CNodeManager} from "../src/nodes/CNodeManager";
import {CNodeArray} from "../src/nodes/CNodeArray";
import {CNodeSwitch} from "../src/nodes/CNodeSwitch";
import {CNodeSmoothedPositionTrack} from "../src/nodes/CNodeSmoothedPositionTrack";
import {CNodeSplineEditor} from "../src/nodes/CNodeSplineEdit";
import {SplineEditor} from "../src/SplineEditor";
import {CNodeMISBDataTrack} from "../src/nodes/CNodeMISBData";
import {CNodeTrackFromMISB} from "../src/nodes/CNodeTrackFromMISB";
import {Globals, setGlobalDateTimeNode, setNodeMan, setSit} from "../src/Globals";
import {LLAToECEF, ECEFToLLAVD_radii} from "../src/LLA-ECEF-ENU";
import {getTrackAltitudeLock} from "../src/AltitudeLock";
import {EventManager} from "../src/CEventManager";
import {MISB, MISBFields} from "../src/MISBFields";

jest.mock("json-stringify-pretty-compact", () => ({__esModule: true, default: JSON.stringify}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: () => 0}));
jest.mock("../src/SplineEditor", () => ({SplineEditor: jest.fn()}));

let manager, terrain, tiles, surfaceHeight;
const start = 1_000_000;
const roadHeight = lon => 140 + 8 * Math.sin((lon + 88) * 20000);
function atHeight(point, height) {
    const lla = ECEFToLLAVD_radii(point);
    return LLAToECEF(lla.x, lla.y, height(lla.y));
}

beforeEach(() => {
    manager = new CNodeManager();
    setNodeMan(manager);
    setSit({frames: 101, fps: 10, simSpeed: 1, lat: 35, lon: -88});
    const clock = new CNodeArray({id: "clock", array: [start]});
    clock.getStartTimeValue = () => start;
    setGlobalDateTimeNode(clock);
    EventManager.removeAll();
    Globals.pendingActions = 0;
    surfaceHeight = roadHeight;
    terrain = {group: {visible: false}, getPointBelow: p => atHeight(p, () => 145)};
    terrain.getPointBelowWithTileInfo = (p, agl) => ({point: atHeight(p, () => 145 + agl), elevation: 145, tileZ: 10, tileX: 0, tileY: 0});
    terrain.elevationTileHasHigherZoom = () => false;
    tiles = {groundBelow: jest.fn(p => atHeight(p, surfaceHeight))};
    manager.add("TerrainModel", terrain);
    manager.add("buildings3DTiles", tiles);
});

function source() {
    const node = new CNodeArray({id: "raw", array: Array.from({length: 101}, (_, f) => ({
        position: LLAToECEF(35 + Math.sin(f / 8) * 0.00001, -88 + f * 0.00001, 145),
    }))});
    node.altitudeLock = 0;
    node.altitudeLockAGL = true;
    return node;
}

test("a new spline displays its saved height above ground before the first reload", () => {
    terrain.group.visible = true;
    manager.add("mainView", {});
    manager.add("mainCamera", {camera: {}});
    const pointAt = f => LLAToECEF(35, -88 + f * 0.00001, 145);
    // Stand in for the interactive handles. The spline node and its display track are real.
    SplineEditor.mockImplementationOnce(() => ({
        frameNumbers: [0, 100], positions: [pointAt(0), pointAt(100)],
        getPointFrame: pointAt, updateSnapping() {}, updatePointEditorGraphics() {},
    }));
    const raw = new CNodeSplineEditor({id: "spline", type: "linear", view: "mainView",
        camera: "mainCamera", frames: -1, skipGUI: true});
    const display = new CNodeSmoothedPositionTrack({id: "track", source: raw, method: "moving", window: 0});
    for (const height of [0, 20]) {
        raw.setAltitudeLock(height);
        display.recalculate();
        expect(ECEFToLLAVD_radii(display.p(50)).z).toBeCloseTo(145 + height, 5);
        expect(raw.modSerialize()).toMatchObject({altitudeLock: height, altitudeLockAGL: true});
    }
});

test.each(["none", "moving", "savgol", "sliding", "spline", "catmull"])(
    "%s smoothing locks the final path to the visible surface, including another camera smoother", method => {
        const raw = source();
        const track = new CNodeSmoothedPositionTrack({id: "track", source: raw, method, window: 20, tension: 0.5, intervals: 10});
        const selector = new CNodeSwitch({id: "selector", inputs: {road: track}, default: "road"});
        const camera = new CNodeSmoothedPositionTrack({id: "camera", source: selector, method: "moving", window: 10});
        expect(getTrackAltitudeLock(camera)).toBe(raw);
        for (const node of [track, camera]) {
            for (const f of [0, 20, 50, 80, 100]) {
                const lla = ECEFToLLAVD_radii(node.p(f));
                expect(lla.z).toBeCloseTo(roadHeight(lla.y), 5);
                expect(node.array[f].position.distanceTo(node.p(f))).toBeLessThan(1e-6);
            }
        }
        raw.altitudeLock = 1.524;
        track.recalculate();
        camera.recalculate();
        const lla = ECEFToLLAVD_radii(camera.p(40));
        expect(lla.z - roadHeight(lla.y)).toBeCloseTo(1.524, 5);
    });

test("falls back before tiles arrive, restores the basemap, and leaves absolute locks independent of tiles", () => {
    const raw = source();
    const track = new CNodeSmoothedPositionTrack({id: "track", source: raw, method: "moving", window: 20});
    tiles.groundBelow.mockReturnValue(null);
    expect(ECEFToLLAVD_radii(track.p(50)).z).toBeCloseTo(145, 5);
    tiles.groundBelow.mockImplementation(p => atHeight(p, surfaceHeight));
    track.recalculate();
    expect(ECEFToLLAVD_radii(track.p(50)).z).not.toBeCloseTo(145, 2);
    terrain.group.visible = true;
    track.recalculate();
    expect(ECEFToLLAVD_radii(track.p(50)).z).toBeCloseTo(145, 5);
    raw.altitudeLockAGL = false;
    raw.altitudeLock = 200;
    terrain.group.visible = false;
    tiles.groundBelow.mockClear();
    track.recalculate();
    expect(ECEFToLLAVD_radii(track.p(50)).z).toBeCloseTo(200, 5);
    expect(tiles.groundBelow).not.toHaveBeenCalled();
    raw.altitudeLock = -1;
    expect(getTrackAltitudeLock(track)).toBeNull();
});

test("ground locking preserves the smoothed horizontal motion", () => {
    const raw = source();
    raw.altitudeLock = -1;
    const track = new CNodeSmoothedPositionTrack({id: "track", source: raw, method: "savgol", window: 20});
    const before = Array.from({length: 101}, (_, f) => ECEFToLLAVD_radii(track.p(f)));
    raw.altitudeLock = 0;
    track.recalculate();
    for (let f = 0; f < 101; f++) {
        const after = ECEFToLLAVD_radii(track.p(f));
        expect(after.x).toBeCloseTo(before[f].x, 9);
        expect(after.y).toBeCloseTo(before[f].y, 9);
    }
});

test("a ground-relative source uses the selected height reference in both raw and smoothed frames", () => {
    terrain.group.visible = true;
    const rows = [0, 100].map(f => {
        const row = new Array(MISBFields).fill(null);
        row[MISB.UnixTimeStamp] = start + f * 100;
        row[MISB.SensorLatitude] = 35;
        row[MISB.SensorLongitude] = -88 + f * 0.00001;
        row[MISB.AltitudeAGL] = 10;
        return row;
    });
    const data = new CNodeMISBDataTrack({id: "relative", misb: rows});
    const raw = new CNodeTrackFromMISB({id: "raw", misb: data});
    const smooth = new CNodeSmoothedPositionTrack({id: "smooth", source: raw, method: "moving", window: 0});
    expect(data.useAGL).toBe(true);

    // The terrain here is at 145 m HAE. Turning the lock off restores the original 10 m AGL.
    for (const [lock, agl, expectedHAE] of [[100, false, 100], [0, false, 0], [20, true, 165], [-1, false, 155]]) {
        data.altitudeLock = lock;
        data.altitudeLockAGL = agl;
        raw.recalculate();
        smooth.recalculate();
        expect(raw.v(50).lla[2]).toBeCloseTo(expectedHAE, 5);
        expect(ECEFToLLAVD_radii(smooth.p(50)).z).toBeCloseTo(expectedHAE, 5);
    }
});

test("3D surface changes refresh an imported locked track and coalesce with elevation changes", () => {
    const rows = [0, 100].map(f => {
        const row = new Array(MISBFields).fill(null);
        row[MISB.UnixTimeStamp] = start + f * 100;
        row[MISB.SensorLatitude] = 35;
        row[MISB.SensorLongitude] = -88 + f * 0.00001;
        row[MISB.SensorTrueAltitude] = 145;
        return row;
    });
    const data = new CNodeMISBDataTrack({id: "data", misb: rows});
    data.altitudeLock = 0;
    data.altitudeLockAGL = true;
    // Let the ordinary interpolation path run; this fixture has no elevation cache.
    const track = new CNodeTrackFromMISB({id: "track", misb: data});
    track._resolveTerrainNode = () => null;
    const smooth = new CNodeSmoothedPositionTrack({id: "smooth", source: track, method: "moving", window: 20});
    data.recalculateCascade = jest.fn(() => { data.recalculate(); track.recalculate(); smooth.recalculate(); });
    let callback;
    const previousRAF = global.requestAnimationFrame;
    global.requestAnimationFrame = fn => { callback = fn; };
    try {
        const pending = Globals.pendingActions;
        surfaceHeight = lon => roadHeight(lon) + 3;
        EventManager.dispatchEvent("visibleGroundChanged");
        EventManager.dispatchEvent("elevationChanged");
        expect(Globals.pendingActions).toBe(pending + 1);
        callback();
        expect(Globals.pendingActions).toBe(pending);
        expect(data.recalculateCascade).toHaveBeenCalledTimes(1);
        const lla = ECEFToLLAVD_radii(smooth.p(40));
        expect(lla.z).toBeCloseTo(surfaceHeight(lla.y), 5);
        data.altitudeLock = -1;
        EventManager.dispatchEvent("visibleGroundChanged");
        expect(Globals.pendingActions).toBe(pending);
    } finally {
        global.requestAnimationFrame = previousRAF;
    }
});
