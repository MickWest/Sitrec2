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
jest.mock("../src/videoNoisePattern/CNodeVideoNoisePatternView", () => ({createVideoNoisePatternView: jest.fn()}));

import {Globals, NodeMan} from "../src/Globals";
import {ViewMan} from "../src/CViewManager";
import {createVideoNoisePatternView} from "../src/videoNoisePattern/CNodeVideoNoisePatternView";
import {
    clampNoisePatternOptions, deserializeVideoNoisePattern, resetVideoNoisePattern, serializeVideoNoisePattern, showVideoNoisePattern,
} from "../src/VideoNoisePattern";

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
    resetVideoNoisePattern();
    NodeMan.get.mockImplementation(() => graph);
    createVideoNoisePatternView.mockReset().mockImplementation(makeGraph);
});

test("a legacy saved graph restores visibly on top of the fullscreen video", async () => {
    const video = restoreFullscreen();
    await deserializeVideoNoisePattern(saved);
    ViewMan.computeEffectiveVisibility();
    expect(ViewMan.fullscreenView).toBe(video);
    expect(graph._effectivelyVisible).toBe(true);
    expect(graph).toMatchObject(saved);
    expect(serializeVideoNoisePattern()).toEqual({...saved, fullscreenSuppressed: false});
});

test("an already-created graph is re-shown after fullscreen restoration", async () => {
    // Models the old ordering, or a graph opened while a sitch was loading.
    makeGraph("videoNoisePattern");
    restoreFullscreen();
    ViewMan.computeEffectiveVisibility();
    expect(graph._effectivelyVisible).toBe(false);
    await deserializeVideoNoisePattern(saved);
    ViewMan.computeEffectiveVisibility();
    expect(graph._effectivelyVisible).toBe(true);
    expect(createVideoNoisePatternView).not.toHaveBeenCalled();
});

test("a graph deliberately covered by fullscreen stays covered after a round trip", async () => {
    makeGraph("videoNoisePattern");
    restoreFullscreen();
    const state = serializeVideoNoisePattern();
    expect(state.fullscreenSuppressed).toBe(true);
    delete ViewMan.list.videoNoisePattern;
    graph = null;
    restoreFullscreen();
    await deserializeVideoNoisePattern(state);
    ViewMan.computeEffectiveVisibility();
    expect(graph.visible).toBe(true);
    expect(graph._effectivelyVisible).toBe(false);
    ViewMan.setFullscreenView(null);
    ViewMan.computeEffectiveVisibility();
    expect(graph._effectivelyVisible).toBe(true);
});

test("graphs without fullscreen and explicitly hidden graphs keep their visibility", async () => {
    await deserializeVideoNoisePattern(saved);
    ViewMan.computeEffectiveVisibility();
    expect(graph._effectivelyVisible).toBe(true);
    await showVideoNoisePattern(false);
    expect(serializeVideoNoisePattern()).toBeUndefined();
    graph = null;
    await deserializeVideoNoisePattern({visible: false});
    expect(graph).toBeNull();
});

test("a superseded sitch cannot create its graph after the lazy import", async () => {
    const restoring = deserializeVideoNoisePattern(saved);
    Globals.loadGeneration++;
    await restoring;
    expect(createVideoNoisePatternView).not.toHaveBeenCalled();
    expect(graph).toBeNull();
});

test("saved settings are limited to the values the menu offers", () => {
    expect(clampNoisePatternOptions({longestLag: 5000, detail: 3, vertical: 2, held: "x", frames: "ab", searchOn: "gpu"}))
        .toEqual({longestLag: 2000, detail: 8, vertical: 0, held: "leave", frames: "ab", searchOn: "gpu", offsetSearch: false});
    expect(clampNoisePatternOptions(undefined)).toEqual({longestLag: 256, detail: 8, vertical: 0, held: "leave", frames: "all", searchOn: "fastest", offsetSearch: false});
    expect(clampNoisePatternOptions({longestLag: 10, detail: 4, vertical: 3, held: "picture"}))
        .toMatchObject({longestLag: 32, detail: 4, vertical: 3, held: "picture"});
});

test("the saved record carries the settings and the selected pair, and the window shows", async () => {
    const state = {...saved, noisePatternOptions: {longestLag: 512, detail: 4, vertical: 3, held: "picture", frames: "ab", searchOn: "cpu"},
        noisePatternSelection: {lag: 32, source: 1261, target: 1293, blink: true, aligned: false, overlay: true}};
    createVideoNoisePatternView.mockImplementation((id) => {
        graph = {id, in: {}, visible: false, shown: 0, state: null,
            modDeserialize(s) { this.state = s; },
            modSerialize() { return {visible: this.visible, rootTestRemove: true, noisePatternOptions: this.state.noisePatternOptions,
                noisePatternSelection: this.state.noisePatternSelection}; },
            show(v) { this.visible = v; this.shown++; }};
        ViewMan.list[id] = graph;
        return graph;
    });
    await deserializeVideoNoisePattern(state);
    expect(graph.shown).toBe(1);
    const out = serializeVideoNoisePattern();
    expect(out.noisePatternOptions).toEqual(state.noisePatternOptions);
    expect(out.noisePatternSelection).toEqual(state.noisePatternSelection);
    expect(out.rootTestRemove).toBeUndefined();
});
