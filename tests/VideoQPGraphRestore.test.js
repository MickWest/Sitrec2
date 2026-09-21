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
jest.mock("../src/videoQP/CNodeVideoQPGraphView", () => ({createVideoQPGraphView: jest.fn()}));

import {Globals, NodeMan} from "../src/Globals";
import {ViewMan} from "../src/CViewManager";
import {createVideoQPGraphView} from "../src/videoQP/CNodeVideoQPGraphView";
import {
    deserializeVideoQPGraph, resetVideoQPGraph, serializeVideoQPGraph, showVideoQPGraph,
} from "../src/VideoQPGraph";

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
    resetVideoQPGraph();
    NodeMan.get.mockImplementation(() => graph);
    createVideoQPGraphView.mockReset().mockImplementation(makeGraph);
});

test("a legacy saved graph restores visibly on top of the fullscreen video", async () => {
    const video = restoreFullscreen();
    await deserializeVideoQPGraph(saved);
    ViewMan.computeEffectiveVisibility();
    expect(ViewMan.fullscreenView).toBe(video);
    expect(graph._effectivelyVisible).toBe(true);
    expect(graph).toMatchObject(saved);
    expect(serializeVideoQPGraph()).toEqual({...saved, fullscreenSuppressed: false});
});

test("an already-created graph is re-shown after fullscreen restoration", async () => {
    // Models the old ordering, or a graph opened while a sitch was loading.
    makeGraph("videoQPGraph");
    restoreFullscreen();
    ViewMan.computeEffectiveVisibility();
    expect(graph._effectivelyVisible).toBe(false);
    await deserializeVideoQPGraph(saved);
    ViewMan.computeEffectiveVisibility();
    expect(graph._effectivelyVisible).toBe(true);
    expect(createVideoQPGraphView).not.toHaveBeenCalled();
});

test("a graph deliberately covered by fullscreen stays covered after a round trip", async () => {
    makeGraph("videoQPGraph");
    restoreFullscreen();
    const state = serializeVideoQPGraph();
    expect(state.fullscreenSuppressed).toBe(true);
    delete ViewMan.list.videoQPGraph;
    graph = null;
    restoreFullscreen();
    await deserializeVideoQPGraph(state);
    ViewMan.computeEffectiveVisibility();
    expect(graph.visible).toBe(true);
    expect(graph._effectivelyVisible).toBe(false);
    ViewMan.setFullscreenView(null);
    ViewMan.computeEffectiveVisibility();
    expect(graph._effectivelyVisible).toBe(true);
});

test("graphs without fullscreen and explicitly hidden graphs keep their visibility", async () => {
    await deserializeVideoQPGraph(saved);
    ViewMan.computeEffectiveVisibility();
    expect(graph._effectivelyVisible).toBe(true);
    await showVideoQPGraph(false);
    expect(serializeVideoQPGraph()).toBeUndefined();
    graph = null;
    await deserializeVideoQPGraph({visible: false});
    expect(graph).toBeNull();
});

test("a superseded sitch cannot create its graph after the lazy import", async () => {
    const restoring = deserializeVideoQPGraph(saved);
    Globals.loadGeneration++;
    await restoring;
    expect(createVideoQPGraphView).not.toHaveBeenCalled();
    expect(graph).toBeNull();
});
