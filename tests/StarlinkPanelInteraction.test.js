/** @jest-environment jsdom */
jest.mock("../src/ViewUtils", () => ({withDisplayedCamera: (view, callback) => callback(view.camera)}));
import {CNodeStarlinkUI} from "../src/nodes/CNodeStarlinkUI";
import {CNodeViewUI} from "../src/nodes/CNodeViewUI";
import {Globals, setNodeMan} from "../src/Globals";
import {satelliteWidgets, showDataStatus, showFilterStatus, showSatelliteCount} from "../src/SatelliteWidgets";
import {localizeElements} from "../src/NativeText";
import {WidgetPanel} from "../src/WidgetPanel";

let node, observer, nodes, mounted;
beforeEach(() => {
    node = Object.create(CNodeStarlinkUI.prototype);
    node.panel = document.createElement("aside");
    node.panel.innerHTML = `<button data-action="collapse">Collapse</button>`;
    node.launcher = document.createElement("button");
    node.hud = document.createElement("div");
    document.body.append(node.panel, node.launcher, node.hud);
    node.visible = true; node.expanded = true;
    node.layoutPanel = jest.fn(); node.sync = jest.fn(); node.look = {};
    observer = {_LLA: [34.123456789, -119.987654321, 12.3456789], agl: true, gotoLLA: jest.fn()};
    nodes = {fixedCameraPosition: observer, cameraTrackSwitch: {choice: "fixedCamera"},
        NightSkyNode: {satellites: {nameFilter: "", TLEData: null, get renderTLEData() {return this.TLEData;}}}, dateTimeStart: {dateNow: new Date()}};
    setNodeMan({get: id => nodes[id]});
    Globals.deserializing = false; Globals.disposing = false; Globals.sitchDirty = false;
    mounted = [];
});
afterEach(() => {
    for (const widget of mounted) { widget.lifecycle.dispose?.(); widget.body.remove(); }
    node.panel.remove(); node.launcher.remove(); node.hud.remove();
});

// Mount one widget type as the panel does: its template, its text, and its own scope.
function mount(type) {
    const body = document.createElement("div");
    body.innerHTML = satelliteWidgets[type].html;
    localizeElements(body);
    document.body.append(body);
    const scope = node.createScope(body);
    const widget = {body, scope, lifecycle: satelliteWidgets[type].mount({body, scope, context: node, host: {}})};
    mounted.push(widget);
    return widget;
}
const edit = (input, value) => { input.value = value; input.dispatchEvent(new Event("change")); };
const line = () => document.createElement("p");

test("a latitude edit preserves the exact untouched longitude and height", () => {
    const {scope} = mount("observer");
    edit(scope.el("lat"), "35");
    expect(observer.gotoLLA).toHaveBeenCalledWith(35, -119.987654321, 12.3456789, true);
});

test("a longitude edit preserves exact latitude and altitude", () => {
    const {scope} = mount("observer");
    edit(scope.el("lon"), "-120");
    expect(observer.gotoLLA).toHaveBeenCalledWith(34.123456789, -120, 12.3456789, true);
});

test("invalid and track-controlled observer edits leave the position alone", () => {
    const {scope} = mount("observer");
    edit(scope.el("lat"), "95");
    expect(scope.el("locationMessage").textContent).toContain("latitude");
    nodes.cameraTrackSwitch.choice = "track";
    edit(scope.el("lat"), "35");
    expect(observer.gotoLLA).not.toHaveBeenCalled();
});

test("each observer widget has its own elements, and all show the same observer", () => {
    const first = mount("observer"), second = mount("observer");
    edit(first.scope.el("lat"), "95");
    // The message of an invalid edit is in the widget that got the edit, not in the other one.
    expect(first.scope.el("locationMessage").textContent).not.toBe("");
    expect(second.scope.el("locationMessage").textContent).toBe("");
    // One source: each instance shows the position of the same observer after a refresh.
    observer._LLA[0] = 40.5;
    first.scope.el("lat").value = "";
    for (const widget of [first, second]) widget.lifecycle.update();
    expect(first.scope.el("lat").value).toBe("40.5");
    expect(second.scope.el("lat").value).toBe("40.5");
    expect(second.scope.el("lon").value).toBe("-119.98765");
    // A track-controlled observer locks the fields and says why, in each instance.
    nodes.cameraTrackSwitch.choice = "track";
    second.lifecycle.update();
    expect(second.scope.el("lat").disabled).toBe(true);
    expect(second.scope.el("observerNote").textContent).toBe("Track-controlled observer");
    expect(first.scope.el("lat").disabled).toBe(false);
});

test("a composition needs only the widgets that it names", () => {
    // Two copies of one information widget and no other widget: the refresh must not look
    // for the elements of widgets that are not there.
    const home = document.createElement("div");
    document.body.append(home);
    const panel = new WidgetPanel({parent: home, context: node, registry: satelliteWidgets,
        definition: {id: "counts", title: "Counts", widgets: ["satelliteInfo", {type: "satelliteInfo", id: "secondCount"}]}});
    try {
        panel.setVisible(true);
        expect(() => panel.update()).not.toThrow();
        const texts = [...panel.instances.values()].map(instance => instance.body.textContent);
        expect(texts).toEqual(["No orbit data loaded", "No orbit data loaded"]);
    } finally {
        panel.dispose(); home.remove();
    }
});

test("the layout widget shows which layout is active", () => {
    node.look = {width: 1}; node.main = {height: 0.28, width: 0.26};
    const {body, lifecycle} = mount("viewLayout");
    lifecycle.update();
    expect(body.querySelector('[data-action="sky"]').getAttribute("aria-pressed")).toBe("true");
    expect(body.querySelector('[data-action="split"]').getAttribute("aria-pressed")).toBe("false");
    expect(body.querySelector('[data-action="sky"]').textContent).toBe("Sky + overview");
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
    const status = line();
    showFilterStatus(status, node.countSatellites());
    expect(status.textContent).toContain("TLE filter active");
    expect(status.textContent).not.toContain("Clear search");
    expect(status.title).toBe("Use Clear TLE Filter to remove the orbit filter.");
});

test("unloading orbit data clears obsolete filter and epoch messages", () => {
    const filter = line(), data = line(), count = line();
    filter.textContent = "TLE filter active";
    data.classList.add("sl-warning");
    count.title = "Modeled points";
    const status = node.countSatellites();
    showFilterStatus(filter, status); showDataStatus(data, status); showSatelliteCount(count, status);
    expect(filter.textContent).toBe("");
    expect(data.classList.contains("sl-warning")).toBe(false);
    expect(data.textContent).toBe("No orbit data loaded");
    expect(count.title).toBe("");
});

test("simulation status identifies approximate orbits and does not claim the saved TLE filter applies", () => {
    const sats = nodes.NightSkyNode.satellites;
    sats.TLEData = {satData: [], simulated: true};
    sats.tleFilterResults = [false];
    const filter = line(), data = line();
    showFilterStatus(filter, node.countSatellites()); showDataStatus(data, node.countSatellites());
    expect(data.textContent).toContain("simulated Starlink");
    expect(data.title).toContain("Positions and historical shell proportions are simulated");
    expect(data.title).toContain("filter applies only to loaded orbit data");
    expect(data.style.color).not.toBe("");
    expect(filter.textContent).toBe("");
    sats.TLEData = null;
    showDataStatus(data, node.countSatellites());
    expect(data.style.color).toBe("");
});

test("loaded orbit data outside its epochs is marked as extrapolated", () => {
    const sats = nodes.NightSkyNode.satellites;
    sats.TLEData = {satData: [{visible: true, invalidPosition: true}], startDate: new Date("2020-01-01T00:00:00Z"), endDate: new Date("2020-01-02T00:00:00Z")};
    const data = line();
    showDataStatus(data, node.countSatellites());
    expect(data.textContent).toBe("1 loaded · 1 match · Extrapolated");
    expect(data.classList.contains("sl-warning")).toBe(true);
    expect(data.title).toContain("Viewing time is outside these epochs");
});

test("the count of satellites is made one time each second for all widgets", () => {
    nodes.NightSkyNode.satellites.TLEData = {satData: []};
    node.countSatellites = jest.fn(CNodeStarlinkUI.prototype.countSatellites);
    const first = node.satelliteStatus();
    expect(node.satelliteStatus()).toBe(first);
    expect(node.countSatellites).toHaveBeenCalledTimes(1);
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
