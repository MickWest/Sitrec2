/** @jest-environment jsdom */
jest.mock("../src/ViewUtils", () => ({withDisplayedCamera: (view, callback) => callback(view.camera)}));
import {CNodeStarlinkUI} from "../src/nodes/CNodeStarlinkUI";
import {CNodeViewUI} from "../src/nodes/CNodeViewUI";
import {Globals, setNodeMan} from "../src/Globals";

let node, observer, nodes;
beforeEach(() => {
    node = Object.create(CNodeStarlinkUI.prototype);
    node.panel = document.createElement("aside");
    node.panel.innerHTML = `<button data-action="collapse">Collapse</button>
        <input data-id="lat" type="number" min="-90" max="90" step="any">
        <input data-id="lon" type="number" min="-180" max="180" step="any">
        <p data-id="locationMessage"></p><p data-id="filterStatus"></p><p data-id="dataStatus"></p>`;
    node.launcher = document.createElement("button");
    node.hud = document.createElement("div");
    node.hud.innerHTML = '<strong data-id="count"></strong>';
    document.body.append(node.panel, node.launcher, node.hud);
    node.visible = true; node.expanded = true; node.controlGroups = new Map();
    node.layoutPanel = jest.fn(); node.sync = jest.fn(); node.look = {};
    observer = {_LLA: [34.123456789, -119.987654321, 12.3456789], agl: true, gotoLLA: jest.fn()};
    nodes = {fixedCameraPosition: observer, cameraTrackSwitch: {choice: "fixedCamera"},
        NightSkyNode: {satellites: {nameFilter: "", TLEData: null, get renderTLEData() {return this.TLEData;}}}, dateTimeStart: {dateNow: new Date()}};
    setNodeMan({get: id => nodes[id]});
    ["lat", "lon"].forEach((id, i) => {node.el(id).value = observer._LLA[i].toFixed(5);});
    Globals.deserializing = false; Globals.disposing = false; Globals.sitchDirty = false;
});
afterEach(() => { node.panel.remove(); node.launcher.remove(); node.hud.remove(); });

test("a latitude edit preserves the exact untouched longitude and height", () => {
    node.el("lat").value = "35";
    node.setLocation("lat");
    expect(observer.gotoLLA).toHaveBeenCalledWith(35, -119.987654321, 12.3456789, true);
});

test("a longitude edit preserves exact latitude and altitude", () => {
    node.el("lon").value = "-120";
    node.setLocation("lon");
    expect(observer.gotoLLA).toHaveBeenCalledWith(34.123456789, -120, 12.3456789, true);
});

test("invalid and track-controlled observer edits leave the position alone", () => {
    node.el("lat").value = "95";
    node.setLocation("lat");
    expect(node.el("locationMessage").textContent).toContain("latitude");
    node.el("lat").value = "35";
    nodes.cameraTrackSwitch.choice = "track";
    node.setLocation("lat");
    expect(observer.gotoLLA).not.toHaveBeenCalled();
});

test("collapse and expand preserve keyboard access without stealing unrelated focus", () => {
    const collapse = node.panel.querySelector("button");
    collapse.focus();
    node.setExpanded(false);
    expect(document.activeElement).toBe(node.launcher);
    node.setExpanded(true);
    expect(document.activeElement).toBe(collapse);
    const outside = document.createElement("input"); document.body.append(outside); outside.focus();
    node.setExpanded(false);
    expect(document.activeElement).toBe(outside);
    outside.remove();
});

test("an active TLE filter is explained without a name search", () => {
    nodes.NightSkyNode.satellites.TLEData = {satData: []};
    nodes.NightSkyNode.satellites.tleFilterResults = [];
    node.syncSatellites();
    expect(node.el("filterStatus").textContent).toContain("TLE filter active");
    expect(node.el("filterStatus").textContent).not.toContain("Clear search");
});

test("unloading orbit data clears obsolete filter and epoch messages", () => {
    node.el("filterStatus").textContent = "TLE filter active";
    node.el("dataStatus").classList.add("sl-warning");
    node.hudEl("count").title = "Modeled points";
    node.syncSatellites();
    expect(node.el("filterStatus").textContent).toBe("");
    expect(node.el("dataStatus").classList.contains("sl-warning")).toBe(false);
    expect(node.hudEl("count").title).toBe("");
});

test("simulation status identifies approximate orbits and does not claim the saved TLE filter applies", () => {
    const sats = nodes.NightSkyNode.satellites;
    sats.TLEData = {satData: [], simulated: true};
    sats.tleFilterResults = [false];
    node.syncSatellites();
    expect(node.el("dataStatus").textContent).toContain("simulated Starlink");
    expect(node.el("dataStatus").title).toContain("Positions and historical shell proportions are simulated");
    expect(node.el("dataStatus").title).toContain("filter applies only to loaded orbit data");
    expect(node.el("filterStatus").textContent).toBe("");
    sats.TLEData = null;
    node.syncSatellites();
    expect(node.el("dataStatus").style.color).toBe("");
});

test("satellite stats follow the sky layout even with the sidebar hidden", () => {
    node.sync = CNodeStarlinkUI.prototype.sync;
    node.visible = false;
    node.look = {width: 1}; node.main = {height: 0.28};
    const stats = {setOverlayView: jest.fn()};
    nodes.labelMainViewPVS = stats;
    node.sync();
    expect(stats.setOverlayView).toHaveBeenLastCalledWith(node.look);
    node.look.width = 0.5; node.main.height = 1;
    node.sync();
    expect(stats.setOverlayView).toHaveBeenLastCalledWith(node.main);
});

test("moving an overlay retains its canvas and contents and resizes only on a host change", () => {
    const main = {div: document.createElement("div"), visible: true};
    const look = {div: document.createElement("div"), visible: true};
    const overlay = Object.assign(Object.create(CNodeViewUI.prototype), {
        overlayView: main, div: main.div, canvas: document.createElement("canvas"),
        textElements: {stats: {text: "TLEs"}}, updateWH: jest.fn(),
    });
    main.div.append(overlay.canvas);
    overlay.setOverlayView(look);
    expect(main.div.children).toHaveLength(0);
    expect(overlay.canvas.parentElement).toBe(look.div);
    expect(overlay.textElements.stats.text).toBe("TLEs");
    overlay.setOverlayView(look);
    expect(overlay.updateWH).toHaveBeenCalledTimes(1);
    overlay.setOverlayView(main);
    expect(overlay.canvas.parentElement).toBe(main.div);
});
