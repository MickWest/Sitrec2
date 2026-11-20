/** @jest-environment jsdom */
import {CNodeArray} from "../src/nodes/CNodeArray";
import {CNodeManager} from "../src/nodes/CNodeManager";
import {setNodeMan, setSit} from "../src/Globals";
import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";
import {addRoadTrackControls} from "../src/RoadTrackGUI";

beforeEach(() => {
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
