/** @jest-environment jsdom */
jest.mock("../src/ViewUtils", () => ({withDisplayedCamera: (view, callback) => callback(view.camera)}));
import {CNodeCameraMenu} from "../src/nodes/CNodeCameraMenu";
import {CNodeViewUI} from "../src/nodes/CNodeViewUI";
import {Globals, setNodeMan} from "../src/Globals";
import {viewingWidgets} from "../src/ViewingWidgets";
import {localizeElements} from "../src/NativeText";

let node, observer, nodes, mounted;
beforeEach(() => {
    node = Object.create(CNodeCameraMenu.prototype);
    node.sync = jest.fn();
    observer = {_LLA: [34.123456789, -119.987654321, 12.3456789], agl: true, gotoLLA: jest.fn()};
    nodes = {fixedCameraPosition: observer, cameraTrackSwitch: {choice: "fixedCamera"},
        NightSkyNode: {satellites: {nameFilter: "", TLEData: null, get renderTLEData() {return this.TLEData;}}}, dateTimeStart: {dateNow: new Date()}};
    setNodeMan({get: id => nodes[id]});
    Globals.deserializing = false; Globals.disposing = false; Globals.sitchDirty = false;
    mounted = [];
});
afterEach(() => {
    for (const widget of mounted) { widget.lifecycle.dispose?.(); widget.body.remove(); }
});

// Mount the same content as the Camera menu: its template, its text, and its own scope.
function mount(type) {
    const body = document.createElement("div");
    body.innerHTML = viewingWidgets[type].html;
    localizeElements(body);
    document.body.append(body);
    const scope = node.createScope(body);
    const widget = {body, scope, lifecycle: viewingWidgets[type].mount({body, scope, context: node, host: {}})};
    mounted.push(widget);
    return widget;
}
const edit = (input, value) => { input.value = value; input.dispatchEvent(new Event("change")); };

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
