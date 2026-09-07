jest.mock("../src/Globals", () => ({
    Globals: {disposing: false}, setRenderOne: jest.fn(),
    NodeMan: {
        list: {},
        get(id) { return this.list[id]?.data; },
        exists(id) { return !!this.list[id]; },
    },
    TrackManager: {tracks: [], iterate(fn) { this.tracks.forEach(track => fn(track.trackNode.id, track)); }},
}));

import {NodeMan, TrackManager} from "../src/Globals";
import {addCameraFocusControl, addCameraFollowControl, cameraFocusOptions, objectFocusTrack, syncCameraFocusUI} from "../src/CameraFocusUI";

const add = node => { NodeMan.list[node.id] = {data: node}; return node; };
const gui = {add() {
    return {name() {return this;}, listen() {return this;}, tooltip() {return this;},
        onChange(fn) {this.change = fn; return this;}, updateDisplay: jest.fn()};
}};
let view;
function control(id, target) {
    const node = add({id});
    addCameraFocusControl(node, gui, () => target);
    addCameraFollowControl(node, gui, () => target);
    return node;
}
function choose(node, value, property = "focusCameraHere") {
    node[property] = value;
    node[`${property}Controller`].change(value);
}

const modes = [
    ["focusCameraHere", "focusTrackName", "lockTrackName"],
    ["followCameraHere", "lockTrackName", "focusTrackName"],
];

beforeEach(async () => {
    await Promise.resolve();
    NodeMan.list = {}; TrackManager.tracks = [];
    view = add({id: "mainView", focusTrackName: "default", lockTrackName: "default",
        _baseFocusTracks: {Ground: "default"},
        refreshFocusTrackMenus(options) {this.options = options;}});
});
afterEach(async () => {await Promise.resolve();});

test("catalog contains imported, generated, hidden display and object tracks with distinct names", () => {
    const imported = add({id: "imported"}), generated = add({id: "generated"});
    const satellite = add({id: "satellite"}), objectTrack = add({id: "objectTrack"});
    TrackManager.tracks = [{trackNode: imported, menuText: "Flight"}, {trackNode: generated, menuText: "Flight"}];
    control("satelliteDisplay", satellite).visible = false;
    control("object", objectTrack);
    syncCameraFocusUI();
    expect(view.options).toEqual({Ground: "default", Flight: "imported", "Flight (generated)": "generated",
        satellite: "satellite", objectTrack: "objectTrack"});
});

test("object focus uses the position controller's timed track, not raw source samples", () => {
    const raw = {id: "rawMISB"};
    const timed = {id: "timedTrack", inputs: {source: raw}};
    const object = {id: "object", inputs: {position: {isController: true, inputs: {sourceTrack: timed}}}};
    expect(objectFocusTrack(object)).toBe(timed);
    expect(objectFocusTrack({id: "direct", inputs: {track: timed}})).toBe(timed);
    expect(objectFocusTrack({id: "static"}).id).toBe("static");
});

test.each(modes)("changing %s clears other object/track checkboxes and preserves the independent selection", (property, viewProperty, independent) => {
    const a = add({id: "a"}), b = add({id: "b"});
    const objectA = control("objectA", a), trackA = control("trackA", a);
    const objectB = control("objectB", b), trackB = control("trackB", b);
    view[independent] = "a";
    choose(objectA, true, property);
    expect(view[viewProperty]).toBe("a");
    expect([objectA, trackA, objectB, trackB].map(n => n[property])).toEqual([true, true, false, false]);
    choose(trackB, true, property);
    expect(view[viewProperty]).toBe("b");
    expect(view[independent]).toBe("a");
    expect([objectA, trackA, objectB, trackB].map(n => n[property])).toEqual([false, false, true, true]);
    choose(objectA, false, property); // stale event from another menu cannot clear B
    expect(view[viewProperty]).toBe("b");
    choose(objectB, false, property);
    expect(view[viewProperty]).toBe("default");
    expect(view[independent]).toBe("a");
    expect([objectA, trackA, objectB, trackB].every(n => !n[property])).toBe(true);
});

test.each(modes)("View menu and restored selections update %s object and track controls", (property, viewProperty) => {
    const track = add({id: "track"}), object = control("object", track), display = control("display", track);
    view[viewProperty] = "track";
    syncCameraFocusUI();
    expect(object[property] && display[property]).toBe(true);
    view[viewProperty] = "default";
    syncCameraFocusUI();
    expect(object[property] || display[property]).toBe(false);
});

test.each(modes)("switch-backed objects update %s to match the selected track", (property) => {
    const a = add({id: "a"}), b = add({id: "b"});
    const sw = add({id: "switch", choice: "A", inputs: {A: a, B: b}});
    const object = control("object", sw), trackA = control("trackA", a), trackB = control("trackB", b);
    choose(object, true, property);
    expect([object, trackA, trackB].map(n => n[property])).toEqual([true, true, false]);
    sw.choice = "B";
    syncCameraFocusUI();
    expect([object, trackA, trackB].map(n => n[property])).toEqual([true, false, true]);
});

test("removing a selected track clears Focus and Lock and removes the dropdown entry", () => {
    const track = add({id: "track"});
    const object = control("object", track);
    choose(object, true); choose(object, true, "followCameraHere");
    syncCameraFocusUI();
    delete NodeMan.list.track;
    syncCameraFocusUI();
    expect([view.focusTrackName, view.lockTrackName]).toEqual(["default", "default"]);
    expect(Object.values(view.options)).not.toContain("track");
    expect(object.focusCameraHere).toBe(false);
    expect(object.followCameraHere).toBe(false);
});

test.each(modes)("keeps a restored %s selection while its track is still loading", (property, viewProperty) => {
    view[viewProperty] = "incoming";
    syncCameraFocusUI();
    expect(view[viewProperty]).toBe("incoming");
    const track = add({id: "incoming"});
    const display = control("display", track);
    syncCameraFocusUI();
    expect(display[property]).toBe(true);
    expect(Object.values(view.options)).toContain("incoming");
});

test("does not mutate configured defaults or treat imported names as object properties", () => {
    const track = add({id: "flight"});
    TrackManager.tracks = [{trackNode: track, menuText: "__proto__"}];
    const base = {Ground: "default", select: "flight"};
    const options = cameraFocusOptions(base, []);
    expect(base.select).toBe("flight");
    expect(Object.values(options)).toContain("flight");
    expect(Object.getPrototypeOf(options)).toBe(Object.prototype);
});
