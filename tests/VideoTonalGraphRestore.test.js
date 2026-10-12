jest.mock("../src/Globals", () => ({
    Globals: {loadGeneration: 1}, NodeMan: {get: jest.fn()}, setRenderOne: jest.fn(),
}));
jest.mock("../src/i18n", () => ({t: key => key}));
jest.mock("../src/configUtils", () => ({isConsole: true}));
jest.mock("../src/PageStructure", () => ({setupPageStructure: jest.fn()}));
jest.mock("../src/CManager", () => ({CManager: class {
    constructor() { this.list = {}; }
    iterate(fn) { for (const [id, view] of Object.entries(this.list)) fn(id, view); }
}}));
jest.mock("../src/videoTonal/CNodeVideoTonalGraphView", () => ({createVideoTonalGraphView: jest.fn()}));
jest.mock("../src/pointFrequency/CNodePointTrackFrequencyGraphView", () => ({createPointTrackFrequencyGraphView: jest.fn()}));

import {Globals, NodeMan} from "../src/Globals";
import {ViewMan} from "../src/CViewManager";
import {createVideoTonalGraphView} from "../src/videoTonal/CNodeVideoTonalGraphView";
import {
    deserializeVideoTonalGraph, resetVideoTonalGraph, serializeVideoTonalGraph, showVideoTonalGraph,
} from "../src/VideoTonalGraph";
import {createPointTrackFrequencyGraphView} from "../src/pointFrequency/CNodePointTrackFrequencyGraphView";
import {addPointTrackFrequencyMenu, deserializePointTrackFrequencyGraph, resetPointTrackFrequencyGraph,
    serializePointTrackFrequencyGraph, showPointTrackFrequencyGraph} from "../src/PointTrackFrequencyGraph";

describe.each([
    {id: 'videoTonalGraph', createVideoTonalGraphView, deserializeVideoTonalGraph, resetVideoTonalGraph, serializeVideoTonalGraph, showVideoTonalGraph},
    {id: 'pointTrackFrequencyGraph', createVideoTonalGraphView: createPointTrackFrequencyGraphView,
        deserializeVideoTonalGraph: deserializePointTrackFrequencyGraph, resetVideoTonalGraph: resetPointTrackFrequencyGraph,
        serializeVideoTonalGraph: serializePointTrackFrequencyGraph, showVideoTonalGraph: showPointTrackFrequencyGraph},
])('$id restoration', ({id, createVideoTonalGraphView, deserializeVideoTonalGraph, resetVideoTonalGraph, serializeVideoTonalGraph, showVideoTonalGraph}) => {

const saved = {visible: true, left: 0.55, top: 0.20, width: 0.45, height: 0.53, headerPinned: true};
let graph;

function makeGraph(id) {
    graph = {id, in: {}, visible: true, ...saved,
        modDeserialize(state) {
            for (const key of Object.keys(saved)) if (state[key] !== undefined) this[key] = state[key];
        },
        modSerialize() { return Object.fromEntries(Object.keys(saved).map(key => [key, this[key]])); },
        show(visible) { this.visible = visible; if (visible) ViewMan.unsuppressView(this); },
    };
    ViewMan.list[id] = graph;
    return graph;
}

function restoreFullscreen() {
    const video = {id: "video", in: {}, visible: true, doubled: true, doubleClickFullScreen: true,
        undouble() { this.doubled = false; ViewMan.setFullscreenView(null); },
    };
    ViewMan.list.video = video;
    ViewMan.restoreFullscreenFromMods();
    return video;
}

beforeEach(() => {
    graph = null;
    Globals.loadGeneration = 1;
    ViewMan.list = {};
    ViewMan.setFullscreenView(null);
    resetVideoTonalGraph();
    NodeMan.get.mockImplementation(() => graph);
    createVideoTonalGraphView.mockReset().mockImplementation(makeGraph);
});

test("a legacy saved graph restores visibly on top of the fullscreen video", async () => {
    const video = restoreFullscreen();
    await deserializeVideoTonalGraph(saved);
    ViewMan.computeEffectiveVisibility();
    expect(ViewMan.fullscreenView).toBe(video);
    expect(graph._effectivelyVisible).toBe(true);
    expect(graph).toMatchObject(saved);
    expect(serializeVideoTonalGraph()).toEqual({...saved, fullscreenSuppressed: false});
});

test("an already-created graph is re-shown after fullscreen restoration", async () => {
    // Models the old ordering, or a graph opened while a sitch was loading.
    makeGraph(id);
    restoreFullscreen();
    ViewMan.computeEffectiveVisibility();
    expect(graph._effectivelyVisible).toBe(false);
    await deserializeVideoTonalGraph(saved);
    ViewMan.computeEffectiveVisibility();
    expect(graph._effectivelyVisible).toBe(true);
    expect(createVideoTonalGraphView).not.toHaveBeenCalled();
});

test("a graph deliberately covered by fullscreen stays covered after a round trip", async () => {
    makeGraph(id);
    restoreFullscreen();
    const state = serializeVideoTonalGraph();
    expect(state.fullscreenSuppressed).toBe(true);
    delete ViewMan.list[id];
    graph = null;
    restoreFullscreen();
    await deserializeVideoTonalGraph(state);
    ViewMan.computeEffectiveVisibility();
    expect(graph.visible).toBe(true);
    expect(graph._effectivelyVisible).toBe(false);
    ViewMan.setFullscreenView(null);
    ViewMan.computeEffectiveVisibility();
    expect(graph._effectivelyVisible).toBe(true);
});

test("graphs without fullscreen and explicitly hidden graphs keep their visibility", async () => {
    await deserializeVideoTonalGraph(saved);
    ViewMan.computeEffectiveVisibility();
    expect(graph._effectivelyVisible).toBe(true);
    await showVideoTonalGraph(false);
    expect(serializeVideoTonalGraph()).toBeUndefined();
    graph = null;
    await deserializeVideoTonalGraph({visible: false});
    expect(graph).toBeNull();
});

test("a superseded sitch cannot create its graph after the lazy import", async () => {
    const restoring = deserializeVideoTonalGraph(saved);
    Globals.loadGeneration++;
    await restoring;
    expect(createVideoTonalGraphView).not.toHaveBeenCalled();
    expect(graph).toBeNull();
});
});

test('frequency menu controls retain boolean types when a GUI sends numeric checkbox values', () => {
    NodeMan.get.mockReturnValue(null);
    resetPointTrackFrequencyGraph();
    const calls = [];
    const controller = {};
    for (const method of ['name', 'tooltip', 'listen', 'perm']) controller[method] = () => controller;
    const folder = {
        add(object, key) { calls.push({object, key}); return controller; },
        addFolder() { return folder; },
        close() { return folder; },
        perm() { return folder; },
    };
    addPointTrackFrequencyMenu(folder);
    const proxy = calls.find(call => call.key === 'percent').object;
    proxy.percent = 0;
    expect(proxy.percent).toBe(false);
    proxy.percent = 1;
    expect(proxy.percent).toBe(true);
    proxy.radius = 1000;
    expect(proxy.radius).toBe(100);
});
