import {BufferGeometry, Float32BufferAttribute, Mesh, Scene} from "three";
import {GPUMemoryMonitor} from "../src/GPUMemoryMonitor";

jest.mock("../src/i18n", () => ({t: key => key}));

function monitorFixture() {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const scene = new Scene();
    scene.add(new Mesh(geometry), new Mesh(geometry));
    const monitor = new GPUMemoryMonitor({getContext: () => null, info: {memory: {}, render: {}}}, scene);
    monitor.guiFolder = {domElement: {checkVisibility: () => true}};
    monitor.displayControls.enabled = true;
    const scan = jest.spyOn(scene, "traverse");
    const terrainScan = jest.spyOn(monitor, "collectTerrainCacheCounts");
    return {monitor, scene, geometry, scan, terrainScan};
}

afterEach(() => jest.restoreAllMocks());

test("closed Debug does no scene or terrain scans; opening immediately refreshes", () => {
    const {monitor, scan, terrainScan} = monitorFixture();
    monitor.guiFolder.domElement.checkVisibility = () => false;
    monitor.updateGUI();
    expect(scan).not.toHaveBeenCalled();
    expect(terrainScan).not.toHaveBeenCalled();
    monitor.guiFolder.domElement.checkVisibility = () => true;
    monitor.updateGUI(true);
    expect(scan).toHaveBeenCalled();
    expect(terrainScan).toHaveBeenCalledTimes(1);
    expect(monitor.metrics.geometries).toBe(36); // shared geometry counted once
    expect(monitor.metrics.triangles.total).toBe(1);
});

test("scene and terrain scans stay at diagnostic cadence while frames render", () => {
    let now = 10000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const {monitor, scan, terrainScan} = monitorFixture();
    monitor.updateGUI();
    const firstScans = scan.mock.calls.length;
    for (let i = 0; i < 59; i++) {now += 16; monitor.updateGUI();}
    expect(scan).toHaveBeenCalledTimes(firstScans);
    expect(terrainScan).toHaveBeenCalledTimes(1);
    now += 100;
    monitor.updateGUI();
    expect(scan).toHaveBeenCalledTimes(2 * firstScans);
    expect(terrainScan).toHaveBeenCalledTimes(2);
    monitor.displayControls.enabled = false;
    monitor.updateGUI(true);
    expect(scan).toHaveBeenCalledTimes(2 * firstScans);
});

test("explicit diagnostics still work with closed GUI and renderer replacement", () => {
    const {monitor, scene} = monitorFixture();
    monitor.guiFolder._closed = true;
    expect(monitor.getStats(true).geometriesBytes).toBe(36);
    scene.clear();
    expect(monitor.getStats(true).geometriesBytes).toBe(0);
    monitor.setScene(new Scene());
    expect(monitor.lastUpdate).toBe(-Infinity);
});
