import {Vector3} from "three";

jest.mock("../src/Globals", () => ({
    Globals: {}, Sit: {frames: 3, fps: 1}, Units: undefined, guiMenus: {},
    setRenderOne: jest.fn(), GlobalDateTimeNode: {},
    NodeMan: {get: jest.fn(), exists: jest.fn(), iterate: jest.fn(), disposeRemove: jest.fn()},
    TrackManager: {get: jest.fn(), iterate: jest.fn(), trackForObject: jest.fn()},
}));
jest.mock("../src/par", () => ({par: {frame: 0}}));
jest.mock("../src/i18n", () => ({t: key => ({"graphControls.xAxis": "X", "graphControls.y1Axis": "Y1 (left)", "graphControls.y2Axis": "Y2 (right)", "graphControls.y3Axis": "Y3 (right)"}[key] ?? key)}));
jest.mock("../src/Theme", () => ({defaultViewDark: () => true}));
jest.mock("../src/ViewUIBarMenus", () => ({viewMenuKey: (id, key) => id + key}));
jest.mock("../src/nodes/CNodeCustomGraphView", () => ({CNodeCustomGraphView: jest.fn().mockImplementation(config => ({...config, setSeries: jest.fn(), show: jest.fn(), tabMenu: {open: jest.fn(), addMirror: jest.fn()}, uiBar: {onMenuStateChange: jest.fn()}}))}));
jest.mock("../src/nodes/CNodeDisplayLOS", () => ({CNodeDisplayLOS: class {}}));
jest.mock("../src/nodes/CNode3DObject", () => ({shortObjectName: name => name}));
jest.mock("../src/trackUtils", () => ({trackHeading: () => 42, trackGForce: () => 0}));
jest.mock("../src/SphericalMath", () => ({getLocalUpVector: () => new (require("three").Vector3)(0, 1, 0), getLocalNorthVector: () => new (require("three").Vector3)(0, 0, -1), getLocalEastVector: () => new (require("three").Vector3)(1, 0, 0), altitudeHAE: p => p.y}));
jest.mock("../src/CelestialMath", () => ({getCelestialDirection: jest.fn()}));
jest.mock("../src/CHorizonExtractor", () => ({getHorizonExtractor: jest.fn()}));
jest.mock("../src/CObjectTracking", () => ({getObjectTracker: jest.fn()}));
jest.mock("../src/CMotionAnalysisUI", () => ({getMotionAnalyzerForTesting: jest.fn()}));

import {CCustomGraph, CCustomGraphManager} from "../src/CCustomGraphManager";
import {GraphDataManager} from "../src/CGraphDataManager";
import {NodeMan, TrackManager, guiMenus, Globals} from "../src/Globals";
import {getObjectTracker} from "../src/CObjectTracking";
import {getMotionAnalyzerForTesting} from "../src/CMotionAnalysisUI";
import {EventManager} from "../src/CEventManager";

function fakeFolder() {
    const folder = {
        controllers: [], addFolder: () => fakeFolder(), onOpenClose() {}, title() {}, open: jest.fn(),
        add(object, property, options) {
            const controller = {
                object, property, options,
                name(value) {this.label = value; return this;}, tooltip() {return this;},
                onChange(fn) {this.change = fn; return this;}, listen() {return this;},
                disable() {this.disabled = true; return this;}, shareAs() {},
                destroy() {folder.controllers = folder.controllers.filter(c => c !== this);},
                select(value) {object[property] = value; this.change(value);},
            };
            folder.controllers.push(controller);
            return controller;
        },
    };
    return folder;
}
function register(key, entity, measurement, extra = {}) {
    GraphDataManager.register(key, {entity, entityLabel: entity, measurement,
        measurementId: key.split(".").pop(), label: entity + " " + measurement, getValue: () => 1, ...extra});
}
function graphWithSelections(config = {}) {
    const graph = new CCustomGraph("test", {setSeries: jest.fn(), dark: true});
    graph.folder = fakeFolder();
    Object.assign(graph, config);
    graph.rebuildDropdowns();
    return graph;
}

beforeEach(() => {
    GraphDataManager.disposeAll();
    EventManager.removeAll();
    jest.clearAllMocks();
    NodeMan.get.mockReturnValue(undefined);
    NodeMan.exists.mockReturnValue(false);
    NodeMan.iterate.mockImplementation(() => {});
    TrackManager.get.mockReturnValue(undefined);
    TrackManager.trackForObject.mockReturnValue(undefined);
    TrackManager.iterate.mockImplementation(() => {});
    Globals.cameraMotionData = undefined;
    guiMenus.showhidegraphs = fakeFolder();
    getObjectTracker.mockReturnValue(null);
    getMotionAnalyzerForTesting.mockReturnValue(null);
});

test("entities give short per-entity measurement options, with units and timeline X", () => {
    register("track.a.speed", "track.a", "Ground speed", {units: "knots"});
    register("track.a.altitude", "track.a", "Altitude HAE", {units: "ft"});
    register("track.b.speed", "track.b", "Ground speed", {units: "knots"});
    expect(GraphDataManager.measurements("track.a")).toEqual({None: "None", "Ground speed (knots)": "track.a.speed", "Altitude HAE (ft)": "track.a.altitude"});
    expect(GraphDataManager.entities(false, true).Timeline).toBe("timeline");
    expect(GraphDataManager.measurements("timeline")).toEqual({Frame: "frames", "Frame A→B": "framesAB"});
    expect(GraphDataManager.seriesLabel("track.a.speed")).toBe("track.a Ground speed (knots)");
});

test("switching an entity preserves a common measurement and only changes that axis", () => {
    register("track.a.altitude", "track.a", "Altitude HAE");
    register("track.b.speed", "track.b", "Ground speed");
    register("track.b.altitude", "track.b", "Altitude HAE");
    const graph = graphWithSelections({_storedY1: "track.a.altitude", _storedY2: "track.gone.speed"});
    graph.folder.controllers.find(c => c.object === graph._entities && c.property === "y1").select("track.b");
    expect(graph._storedY1).toBe("track.b.altitude");
    expect(graph._storedY2).toBe("track.gone.speed");
    expect(graph.serialize().y2Series).toBe("track.gone.speed");
});

test("unavailable saved sources stay explicit and survive changes to a different axis", () => {
    const graph = graphWithSelections({_storedY1: "analyzeMotion.x", _storedY2: "track.a.speed"});
    const y1 = graph.folder.controllers.find(c => c.object === graph._gs && c.property === "y1");
    expect(y1.options["x (unavailable)"]).toBe("analyzeMotion.x");
    graph._xCtrl.select("framesAB");
    expect(graph._storedY1).toBe("analyzeMotion.x");
    expect(graph._storedY2).toBe("track.a.speed");
    register("analyzeMotion.x", "analyzeMotion", "X (raw)");
    graph.rebuildDropdowns();
    expect(graph._y1Ctrl.options["X (raw)"]).toBe("analyzeMotion.x");
    expect(graph._gs.y1).toBe("analyzeMotion.x");
});

test("None disables its measurement; axis clearing retains the entity for saved restores", () => {
    register("track.a.speed", "track.a", "Ground speed");
    const graph = graphWithSelections({_storedY1: "track.a.speed"});
    expect(graph._y2Ctrl.disabled).toBe(true);
    graph._y1Ctrl.select("None");
    expect(graph.serialize()).toMatchObject({y1Entity: "track.a", y1Series: "None"});
    graph.rebuildDropdowns();
    expect(graph._entities.y1).toBe("track.a");
});

test("analysis entities become applicable from live data, with version change on availability", () => {
    const manager = new CCustomGraphManager();
    manager.registerStaticSeries();
    GraphDataManager.refreshAvailability();
    expect(Object.values(GraphDataManager.entities())).not.toContain("analyzeMotion");
    expect(Object.values(GraphDataManager.entities())).not.toContain("pointTrack");
    const version = GraphDataManager.version;
    getMotionAnalyzerForTesting.mockReturnValue({resultCache: new Map([[1, {}]])});
    getObjectTracker.mockReturnValue({trackedPositions: new Map([[1, {}]])});
    GraphDataManager.refreshAvailability();
    expect(GraphDataManager.version).toBeGreaterThan(version);
    expect(Object.values(GraphDataManager.entities())).toEqual(expect.arrayContaining(["analyzeMotion", "pointTrack"]));
});

test("object and look camera measurements use their per-frame controller tracks", () => {
    const manager = new CCustomGraphManager();
    const track = {frames: 3, p: f => new Vector3(f * 3, 100 + f * 4, 0)};
    const cameraTrack = {p: f => new Vector3(f * 3, 90, 0)};
    const object = {id: "object1", displayName: "Object 1", exportTrackNode() {}, inputs: {position: {isController: true, inputs: {sourceTrack: track}}}};
    const camera = {inputs: {position: {isController: true, inputs: {sourceTrack: cameraTrack}}}};
    NodeMan.get.mockImplementation(id => id === "object1" ? object : id === "lookCamera" ? camera : undefined);
    NodeMan.exists.mockImplementation(id => id === "lookCamera" || id === "object1");
    NodeMan.iterate.mockImplementation(fn => fn("object1", object));
    manager.reregisterObjects();
    expect(GraphDataManager.valueAt("object.object1.speed", 1)).toBe(3);
    expect(GraphDataManager.valueAt("object.object1.speed3D", 1)).toBe(5);
    expect(GraphDataManager.valueAt("object.object1.verticalSpeed", 1)).toBe(4);
    expect(GraphDataManager.valueAt("object.object1.altitude", 2)).toBe(108);
    expect(GraphDataManager.valueAt("object.object1.slantRange", 2)).toBe(18);
    expect(GraphDataManager.valueAt("object.object1.altitude", 0)).toBe(100);
});

test("shortcut creates a titled speed/altitude graph and deduplicates imported object tracks", () => {
    const manager = new CCustomGraphManager();
    const trackOb = {trackID: "track1", displayName: "Aircraft", trackNode: {p: () => new Vector3(1, 2, 3)}};
    TrackManager.get.mockImplementation(id => id === "track1" ? trackOb : undefined);
    TrackManager.trackForObject.mockImplementation(id => id === "object1" ? trackOb : undefined);
    TrackManager.iterate.mockImplementation(fn => fn("track1", trackOb));
    const graph = manager.addGraphForEntity("object1");
    expect(graph.serialize()).toMatchObject({title: "Aircraft — Speed & altitude", y1Series: "track.track1.speed", y2Series: "track.track1.altitude", y3Series: "None"});
    expect(graph.folder.open).toHaveBeenCalled();
    expect(graph.view.tabMenu.open).toHaveBeenCalled();
    expect(graph.view.uiBar.onMenuStateChange).toHaveBeenCalled();
    expect(Object.values(GraphDataManager.entities()).filter(x => x.includes("track1"))).toHaveLength(1);
});

test("setup event invokes the entity shortcut and dispose removes the listener", () => {
    const manager = new CCustomGraphManager();
    manager.addGraphForEntity = jest.fn();
    manager.setup();
    EventManager.dispatchEvent("addCustomGraphForEntity", {entityId: "track1", title: "Aircraft"});
    expect(manager.addGraphForEntity).toHaveBeenCalledWith("track1", {title: "Aircraft"});
    manager.disposeAll();
    EventManager.dispatchEvent("addCustomGraphForEntity", {entityId: "track1"});
    expect(manager.addGraphForEntity).toHaveBeenCalledTimes(1);
});

test("editing an interior Y or X sample refreshes the graph", () => {
    const y = [0, 1, 2, 3, 4];
    const x = [0, 1, 2, 3, 4];
    const {Sit} = require("../src/Globals");
    const originalFrames = Sit.frames;
    Sit.frames = 5;
    register("track.a.speed", "track.a", "Ground speed", {getValue: f => y[f]});
    register("track.a.altitude", "track.a", "Altitude HAE", {getValue: f => x[f]});
    const graph = graphWithSelections({_storedY1: "track.a.speed", _storedX: "track.a.altitude"});
    graph.updateGraph();
    expect(graph.view.setSeries).toHaveBeenCalledTimes(1);
    graph.updateGraph();
    expect(graph.view.setSeries).toHaveBeenCalledTimes(1);
    y[1] = 20;
    graph.updateGraph();
    expect(graph.view.setSeries).toHaveBeenCalledTimes(2);
    x[3] = 50;
    graph.updateGraph();
    expect(graph.view.setSeries).toHaveBeenCalledTimes(3);
    expect(graph.view.equalAspect).toBe(false);
    Sit.frames = originalFrames;
});

test("saved graph selections restore unchanged before their source is created", () => {
    const manager = new CCustomGraphManager();
    manager.deserialize([{id: "customGraph4", xSeries: "framesAB", y1Series: "track.delayed.speed", y2Series: "track.delayed.altitude"}]);
    expect(manager.serialize()[0]).toMatchObject({id: "customGraph4", xSeries: "framesAB", y1Series: "track.delayed.speed", y2Series: "track.delayed.altitude"});
    const delayed = {trackID: "delayed", displayName: "Imported later", trackNode: {p: () => new Vector3(0, 300, 0)}};
    TrackManager.get.mockImplementation(id => id === "delayed" ? delayed : undefined);
    TrackManager.iterate.mockImplementation(fn => fn("delayed", delayed));
    manager.refreshSources(true);
    manager.list.customGraph4.maybeRebuild();
    expect(manager.list.customGraph4._entities.y1).toBe("track.delayed");
    expect(manager.list.customGraph4._y1Ctrl.options["Ground speed (m/s)"]).toBe("track.delayed.speed");
    expect(manager.serialize()[0].y2Series).toBe("track.delayed.altitude");
});

test("standalone track graph round-trip restores source registration including dotted node IDs", () => {
    const id = "manual.position.v1";
    const source = {id, frames: 3, p: f => new Vector3(f * 3, 200 + f * 4, 0)};
    NodeMan.get.mockImplementation(key => key === id ? source : undefined);
    NodeMan.exists.mockImplementation(key => key === id);
    NodeMan.iterate.mockImplementation(fn => fn(id, source));
    const original = new CCustomGraphManager();
    const graph = original.addGraphForEntity(id, {title: "Manual position"});
    expect(graph.serialize().y1Series).toBe("node.manual.position.v1.speed");
    const saved = original.serialize();
    original.disposeAll();
    GraphDataManager.disposeAll();
    const restored = new CCustomGraphManager();
    restored.deserialize(saved);
    expect(restored._extraTrackIds.has(id)).toBe(true);
    expect(GraphDataManager.valueAt("node.manual.position.v1.speed", 1)).toBe(3);
    expect(GraphDataManager.valueAt("node.manual.position.v1.altitude", 2)).toBe(208);
    expect(restored.serialize()[0]).toMatchObject({y1Series: "node.manual.position.v1.speed", y2Series: "node.manual.position.v1.altitude"});
});

test("standalone entity round-trip keeps measurements available when every series is None", () => {
    const id = "manual.position.v1";
    const source = {id, frames: 3, p: f => new Vector3(f * 3, 200 + f * 4, 0)};
    NodeMan.get.mockImplementation(key => key === id ? source : undefined);
    NodeMan.exists.mockImplementation(key => key === id);
    NodeMan.iterate.mockImplementation(fn => fn(id, source));
    const original = new CCustomGraphManager();
    const graph = original.addGraphForEntity(id);
    graph._y1Ctrl.select("None");
    graph._y2Ctrl.select("None");
    const saved = original.serialize();
    expect(saved[0]).toMatchObject({y1Entity: "node." + id, y2Entity: "node." + id,
        y1Series: "None", y2Series: "None", y3Series: "None"});
    original.disposeAll();
    GraphDataManager.disposeAll();
    const restored = new CCustomGraphManager();
    restored.deserialize(saved);
    const restoredGraph = restored.list[saved[0].id];
    expect(restored._extraTrackIds.has(id)).toBe(true);
    expect(restoredGraph._y1Ctrl.options["Ground speed (m/s)"]).toBe("node." + id + ".speed");
    expect(restoredGraph._y2Ctrl.options["Altitude HAE (m)"]).toBe("node." + id + ".altitude");
    restoredGraph._y1Ctrl.select("node." + id + ".speed");
    expect(GraphDataManager.valueAt(restoredGraph._storedY1, 1)).toBe(3);
    expect(restoredGraph._storedY2).toBe("None");
});

test("standalone track shortcut reuses the object entity that follows that track", () => {
    const source = {id: "cameraTrackSwitchSmooth", frames: 3, p: f => new Vector3(f * 3, 200, 0)};
    const object = {id: "cameraObject", displayName: "Camera", exportTrackNode() {}, inputs: {position: {isController: true, inputs: {sourceTrack: source}}}};
    NodeMan.get.mockImplementation(id => id === object.id ? object : id === source.id ? source : undefined);
    NodeMan.exists.mockReturnValue(true);
    NodeMan.iterate.mockImplementation(fn => {fn(source.id, source); fn(object.id, object);});
    const manager = new CCustomGraphManager();
    const graph = manager.addGraphForEntity(source.id);
    expect(graph.serialize()).toMatchObject({title: "Camera — Speed & altitude", y1Series: "object.cameraObject.speed", y2Series: "object.cameraObject.altitude"});
    expect(GraphDataManager.has("node.cameraTrackSwitchSmooth.speed")).toBe(false);
    expect(manager._extraTrackIds.size).toBe(0);
});


test("position measurements carry a display-unit minimum Y span and preserve explicit bounds", () => {
    const manager = new CCustomGraphManager();
    const source = {frames: 3, p: f => new Vector3(f * 3, 200, 0)};
    manager._registerPositionSeries("node.test", "Test", () => source);
    for (const metric of ["speed", "altitude", "speed3D", "verticalSpeed"]) {
        expect(GraphDataManager.get("node.test." + metric).minimumRange).toBe(10);
    }
    const graph = graphWithSelections({_storedY1: "node.test.speed", _storedY2: "node.test.altitude"});
    graph.updateGraph(true);
    expect(graph.view.setSeries.mock.calls.at(-1)[0].map(series => series.minimumRange)).toEqual([10, 10]);
    Object.assign(GraphDataManager.get("node.test.speed"), {min: -1, max: 1});
    graph.updateGraph(true);
    expect(graph.view.setSeries.mock.calls.at(-1)[0][0]).toMatchObject({fixedMin: -1, fixedMax: 1, minimumRange: undefined});
});
