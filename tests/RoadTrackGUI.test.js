/** @jest-environment jsdom */
import {CNodeArray} from "../src/nodes/CNodeArray";
import {CNodeManager} from "../src/nodes/CNodeManager";
import {setNodeMan, setSit} from "../src/Globals";
import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";
import {addRoadTrackControls} from "../src/RoadTrackGUI";

// The track ground cache exists only while Google 3D tiles are the visible ground.
const mockGround = {cache: {}};
jest.mock("../src/TrackGround", () => ({trackGroundCache: () => mockGround.cache}));

beforeEach(() => {
    mockGround.cache = {};
    window.matchMedia ??= () => ({matches: false, addListener() {}, removeListener() {}});
    global.ResizeObserver ??= class {observe() {} disconnect() {}};
    setNodeMan(new CNodeManager());
    setSit({lat: 35, lon: -88, frames: 1});
});

test("road settings survive a node save and restore, and controls follow ground locking", () => {
    const folder = new GUI({container: document.body, autoPlace: false});
    const node = new CNodeArray({id: "road", array: []});
    node.altitudeLock = 0; node.altitudeLockAGL = true;
    const controls = addRoadTrackControls(folder, node, node);
    const toggle = folder.controllers.find(c => c.property === "roadTrack");
    const width = folder.controllers.find(c => c.property === "roadWidth");
    expect(width._hidden).toBe(true);
    toggle.setValue(true);
    expect(width._hidden).toBe(false);
    node.roadWidth = 10;
    node.roadSmoothing = 35;
    const saved = JSON.parse(JSON.stringify(node.modSerialize()));
    node.roadTrack = false; node.roadWidth = 8; node.roadSmoothing = 20;
    node.modDeserialize(saved);
    expect([node.roadTrack, node.roadWidth, node.roadSmoothing]).toEqual([true, 10, 35]);
    expect(width._hidden).toBe(false);
    node.altitudeLockAGL = false;
    controls.update();
    expect(toggle._hidden).toBe(true);
    expect(width._hidden).toBe(true);
    folder.destroy();
});

test("Road Track shows only while a track ground cache exists, and follows a change of ground", () => {
    mockGround.cache = null;
    const folder = new GUI({container: document.body, autoPlace: false});
    const node = new CNodeArray({id: "road", array: []});
    node.altitudeLock = 0; node.altitudeLockAGL = true; node.roadTrack = true;
    addRoadTrackControls(folder, node, node);
    const control = property => folder.controllers.find(c => c.property === property);
    expect(["roadTrack", "roadWidth", "roadSmoothing"].map(p => control(p)._hidden)).toEqual([true, true, true]);
    // The node's visibleGroundChanged handler runs this when Google 3D tiles become the ground.
    mockGround.cache = {};
    node.updateRoadTrackControls();
    expect(["roadTrack", "roadWidth", "roadSmoothing"].map(p => control(p)._hidden)).toEqual([false, false, false]);
    mockGround.cache = null;
    node.updateRoadTrackControls();
    expect(control("roadTrack")._hidden).toBe(true);
    expect(node.roadTrack).toBe(true);
    folder.destroy();
});
