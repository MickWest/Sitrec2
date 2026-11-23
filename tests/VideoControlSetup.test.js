/** @jest-environment jsdom */

// Real GUI nodes and lil-gui exercise callbacks, shared menus and saved values.
// Rendering and the unrelated forensic tools are outside this setup test.
jest.mock("../src/Globals", () => {
    const nodes = new Map();
    return {
        Globals: {}, Sit: {frames: 10}, Units: {units: "metric"}, guiMenus: {},
        NodeMan: {
            nodes,
            exists: id => nodes.has(id),
            get: (id, required = true) => {
                if (!nodes.has(id) && required) throw new Error(`Missing node ${id}`);
                return nodes.get(id);
            },
            add: (id, node) => {
                if (nodes.has(id)) throw new Error(`Duplicate node ${id}`);
                nodes.set(id, node);
            },
        },
        FileManager: {removeExportButton: jest.fn()},
        CustomManager: {videoExportManager: {exportSourceVideo: jest.fn()}},
        setRenderOne: jest.fn(), markSitchDirty: jest.fn(), setMouseOverGUI: jest.fn(),
    };
});
jest.mock("../src/configUtils", () => ({isLocal: false}));
jest.mock("../src/nodes/CNodeMath", () => ({}));
jest.mock("../src/utils", () => ({roundIfClose: n => n, stripComments: s => s}));
jest.mock("../src/PageStructure", () => ({}));
jest.mock("../src/CViewManager", () => ({ViewMan: {topPx: 0, updateSize: jest.fn()}}));
jest.mock("../src/i18n", () => ({t: (key, options) => options?.defaultValue ?? key}));
jest.mock("../src/nodes/CNodeGridOverlay", () => ({}));
jest.mock("../src/starTrack/StarAdjustOptimize", () => ({addStarOptimizeControls: jest.fn()}));
jest.mock("../src/VideoQPGraph", () => ({addVideoQPGraphMenu: jest.fn()}));
jest.mock("../src/VideoTonalGraph", () => ({addVideoTonalGraphMenu: jest.fn()}));
jest.mock("../src/VideoNoisePattern", () => ({addVideoNoisePatternMenu: jest.fn()}));

let gui, setup, NodeMan, CustomManager, EventManager;
beforeEach(() => {
    jest.resetModules();
    window.matchMedia = () => ({matches: false, addListener() {}, removeListener() {}});
    const GUI = require("../src/js/lil-gui.esm").default;
    require("../src/lil-gui-extras");
    const globals = require("../src/Globals");
    ({NodeMan, CustomManager} = globals);
    ({EventManager} = require("../src/CEventManager"));
    gui = new GUI({container: document.body, autoPlace: false, title: "Video"});
    globals.guiMenus.video = gui;
    // The grid is unchanged by this refactor and requires a canvas view.
    NodeMan.add("videoGridOverlay", {});
    setup = require("../src/nodes/CNodeVideoViewFilters");
});
afterEach(() => gui.destroy(true));

function video(id = "video") {
    const node = {id, inputs: {}, addMoreInputs(inputs) { Object.assign(this.inputs, inputs); }};
    for (const name of ["updateLevelsVisibility", "invalidateLevelsResult", "updateCurvesVisibility",
        "updateHistogramVisibilityFromVideoAdjustments", "restartFullABEchoIfActive", "startFullABEcho",
        "stopFullABEcho", "startFullABBlend", "stopFullABBlend", "startFullABExposure", "stopFullABExposure",
        "invalidateELAResult", "invalidateNoiseResult", "makeProcessedVideo"]) node[name] = jest.fn();
    setup.addFiltersToVideoNode(node);
    return node;
}

// A sitch switch: the menus keep their permanent folders, and the nodes and listeners go.
function rebuildScene() {
    gui.destroy(false);
    NodeMan.nodes.clear();
    NodeMan.add("videoGridOverlay", {});
    EventManager.removeAll();
}

function saveMods(view, inputs) {
    return JSON.parse(JSON.stringify(Object.fromEntries(inputs.map(input => {
        const node = view.inputs[input];
        return [node.id, node.modSerialize()];
    }))));
}

function action(folder, property) {
    const controller = folder.controllers.find(c => c.property === property);
    return controller.object[property]();
}

test("creates the shared inputs with the existing defaults, ranges, types and menu order", () => {
    const view = video();
    const {CNodeConstant} = require("../src/nodes/CNode");
    const {CNodeGUIValue, CNodeGUIFlag, CNodeGUISelect} = require("../src/nodes/CNodeGUIValue");
    const {VIDEO_CONTROL_DEFINITIONS} = require("../src/VideoControlDefinitions");
    expect(Object.keys(view.inputs)).toHaveLength(VIDEO_CONTROL_DEFINITIONS.length);
    expect(NodeMan.nodes.size).toBe(VIDEO_CONTROL_DEFINITIONS.length + 1);  // + the grid overlay
    expect(view.inputs.brightness).toBe(NodeMan.get("videoBrightness"));
    expect(view.inputs.brightness).toBeInstanceOf(CNodeGUIValue);
    expect(view.inputs.brightness.value).toBe(1);
    expect(view.inputs.brightness.guiEntry._min).toBe(0);
    expect(view.inputs.brightness.guiEntry._max).toBe(5);
    expect(view.inputs.brightness.guiEntry._step).toBe(0.01);
    expect(view.inputs.enableVideoEffects).toBeInstanceOf(CNodeGUIFlag);
    expect(view.inputs.levelsInputBlack.constructor).toBe(CNodeConstant);
    for (const [input, value, label] of [["elaExpandMethod", "none", "videoView.expandOutput.label"],
        ["noiseDisplayMode", "heatmap", "videoView.displayMode.label"],
        ["convolutionFilter", "none", "videoView.convolutionFilter.label"]]) {
        expect(view.inputs[input]).toBeInstanceOf(CNodeGUISelect);
        expect(view.inputs[input].guiEntry.getValue()).toBe(value);
        expect(view.inputs[input].guiEntry._name).toBe(label);
    }
    expect(setup.guiVideoEffectsFolder.controllers.map(c => c.object.id ?? c.property)).toEqual([
        "videoBrightness", "videoContrast", "videoLevels", "videoShowHistogram", "videoHistogramOnScreen",
        "videoCurves", "videoShowCurves", "videoShadows", "videoHighlights", "videoDehaze", "videoBlur",
        "videoHue", "videoInvert", "videoSaturate", "videoEnableEffects", "videoSharpenAmount",
        "videoEdgeDetectThreshold", "videoEmbossDepth", "videoConvolutionFilter", "resetFilters", "exportSourceVideo",
    ]);
    expect(setup.guiVideoELAFolder.controllers.at(-1).object).toBe(view.inputs.elaExpandMethod);
    expect(view.inputs.sharpenAmount.guiEntry._hidden).toBe(true);
    expect(view.inputs.elaContrastClipPercent.guiEntry._hidden).toBe(true);
    expect(view.inputs.showCurves.guiEntry._hidden).toBe(true);
});

test("a second view reuses values and menus while processing actions stay with the first view", () => {
    const first = video();
    first.inputs.brightness.setValue(2.35);
    const count = gui.controllersRecursive().length;
    const second = video("video2");
    for (const input of Object.keys(first.inputs)) expect(second.inputs[input]).toBe(first.inputs[input]);
    expect(second.inputs.brightness.value).toBe(2.35);
    expect(gui.controllersRecursive()).toHaveLength(count);
    second.inputs.fullABBlend.guiEntry.setValue(true);
    expect(first.startFullABBlend).toHaveBeenCalledTimes(1);
    expect(second.startFullABBlend).not.toHaveBeenCalled();
    action(setup.guiVideoProcessingFolder, "makeVideo");
    expect(first.makeProcessedVideo).toHaveBeenCalledTimes(1);
    expect(second.makeProcessedVideo).not.toHaveBeenCalled();
    action(setup.guiVideoEffectsFolder, "exportSourceVideo");
    expect(CustomManager.videoExportManager.exportSourceVideo).toHaveBeenCalledTimes(1);
    EventManager.dispatchEvent("abFrameChanged");
    expect(first.restartFullABEchoIfActive).toHaveBeenCalledTimes(1);
    expect(second.restartFullABEchoIfActive).toHaveBeenCalledTimes(1);
});

test("the video header mirrors all three shared adjustment controls", () => {
    const view = video();
    const {mirrorMenuItem} = require("../src/MenuMirror");
    const {viewMenuKey} = require("../src/ViewUIBarMenus");
    const header = gui.addFolder("Header");
    for (const [slot, input, value] of [["brightness", "brightness", 2.5],
        ["contrast", "contrast", 1.5], ["effects", "enableVideoEffects", false]]) {
        const mirror = mirrorMenuItem(viewMenuKey("video", slot), header);
        expect(mirror).not.toBeNull();
        mirror.setValue(value);
        expect(view.inputs[input].value).toBe(value);
    }
    expect(header.controllers).toHaveLength(3);
});

test("fills missing controls in an older graph without replacing existing values", () => {
    const {CNodeGUIValue, CNodeGUISelect} = require("../src/nodes/CNodeGUIValue");
    const {VIDEO_CONTROL_DEFINITIONS} = require("../src/VideoControlDefinitions");
    const brightness = new CNodeGUIValue({id: "videoBrightness", value: 2.375,
        start: 0, end: 5, step: 0.01, desc: "Brightness"}, gui);
    const filter = new CNodeGUISelect({id: "videoConvolutionFilter", value: "emboss",
        options: ["none", "sharpen", "edgeDetect", "emboss"]}, gui);
    const view = video();
    expect(view.inputs.brightness).toBe(brightness);
    expect(brightness.value).toBe(2.375);
    expect(view.inputs.convolutionFilter).toBe(filter);
    expect(filter.value).toBe("emboss");
    expect(filter.guiEntry.getValue()).toBe("emboss");
    expect(view.inputs.embossDepth.guiEntry._hidden).toBe(false);
    expect(view.inputs.shadows.value).toBe(0);
    expect(view.inputs.noiseScale.value).toBe(5);
    expect(Object.keys(view.inputs)).toHaveLength(VIDEO_CONTROL_DEFINITIONS.length);
    action(setup.guiVideoEffectsFolder, "resetFilters");
    expect(brightness.value).toBe(1);
    expect(filter.value).toBe("none");
});

test("selectors update visibility and caches, and reflect values restored outside the menu", () => {
    const view = video();
    view.inputs.convolutionFilter.guiEntry.setValue("sharpen");
    expect(view.inputs.sharpenAmount.guiEntry._hidden).toBe(false);
    expect(view.inputs.edgeDetectThreshold.guiEntry._hidden).toBe(true);
    view.inputs.elaExpandMethod.guiEntry.setValue("autoContrastChannels");
    expect(view.inputs.elaContrastClipPercent.guiEntry._hidden).toBe(false);
    expect(view.invalidateELAResult).toHaveBeenCalledTimes(1);
    view.inputs.noiseDisplayMode.guiEntry.setValue("residual");
    expect(view.invalidateNoiseResult).toHaveBeenCalledTimes(1);
    view.inputs.noiseDisplayMode.value = "heatmap";
    gui.updateListeners();
    expect(view.inputs.noiseDisplayMode.guiEntry.$select.selectedIndex).toBe(0);
    view.inputs.curves.guiEntry.setValue(true);
    expect(view.inputs.showCurves.guiEntry._hidden).toBe(false);
    expect(view.updateCurvesVisibility).toHaveBeenCalled();
});

test("A-B modes remain mutually exclusive and Echo enables a light trail when needed", () => {
    const view = video();
    view.inputs.fullABBlend.guiEntry.setValue(true);
    view.inputs.fullABEcho.guiEntry.setValue(true);
    expect(view.inputs.fullABBlend.value).toBe(false);
    expect(view.inputs.echoMax.value).toBe(true);
    expect(view.startFullABEcho).toHaveBeenCalledTimes(1);
    view.inputs.fullABExposure.guiEntry.setValue(true);
    expect(view.inputs.fullABEcho.value).toBe(false);
    expect(view.startFullABExposure).toHaveBeenCalledTimes(1);
    view.inputs.fullABExposure.guiEntry.setValue(false);
    expect(view.stopFullABExposure).toHaveBeenCalledTimes(1);
});

test.each([false, true])("reset restores adjustments and preserves editor/forensics toggles (editors: %s)", withEditors => {
    const view = video();
    const input = view.inputs;
    for (const key of ["levels", "curves", "elaEnabled", "noiseEnabled"]) input[key].value = true;
    input.brightness.setValue(2);
    input.contrast.setValue(3);
    input.levelsInputBlack.value = 40;
    input.levelsMidpoint.value = 0.6;
    input.levelsInputWhite.value = 230;
    input.levelsOutputBlack.value = 10;
    input.levelsOutputWhite.value = 200;
    input.shadows.setValue(25);
    input.enableVideoEffects.guiEntry.setValue(false);
    input.showHistogram.guiEntry.setValue(false);
    input.histogramOnScreen.guiEntry.setValue(true);
    input.showCurves.guiEntry.setValue(false);
    input.convolutionFilter.guiEntry.setValue("emboss");
    input.elaExpandMethod.guiEntry.setValue("autoContrast");
    input.noiseDisplayMode.guiEntry.setValue("residual");
    input.noiseScale.setValue(12);
    input.fullABBlend.guiEntry.setValue(true);
    if (withEditors) {
        view.levelsView = {resetLevels: jest.fn(() => {
            input.levelsInputBlack.value = 0;
            input.levelsMidpoint.value = 1;
            input.levelsInputWhite.value = 255;
            input.levelsOutputBlack.value = 0;
            input.levelsOutputWhite.value = 255;
        })};
        view.curvesView = {resetCurve: jest.fn()};
    }
    action(setup.guiVideoEffectsFolder, "resetFilters");
    for (const key of ["levels", "curves", "elaEnabled", "noiseEnabled"]) expect(input[key].value).toBe(true);
    expect(input.brightness.value).toBe(1);
    expect(input.contrast.value).toBe(1);
    expect(input.shadows.value).toBe(0);
    expect(input.enableVideoEffects.value).toBe(true);
    expect(input.showHistogram.value).toBe(true);
    expect(input.histogramOnScreen.value).toBe(false);
    expect(input.showCurves.value).toBe(true);
    expect([input.levelsInputBlack.value, input.levelsMidpoint.value, input.levelsInputWhite.value,
        input.levelsOutputBlack.value, input.levelsOutputWhite.value]).toEqual([0, 1, 255, 0, 255]);
    expect(input.convolutionFilter.value).toBe("none");
    expect(input.elaExpandMethod.value).toBe("none");
    expect(input.noiseDisplayMode.value).toBe("heatmap");
    expect(input.noiseScale.value).toBe(5);
    expect(input.fullABBlend.value).toBe(false);
    expect(view.stopFullABBlend).toHaveBeenCalled();
    expect(input.embossDepth.guiEntry._hidden).toBe(true);
    expect(input.elaContrastClipPercent.guiEntry._hidden).toBe(true);
    expect(view.invalidateELAResult).toHaveBeenCalled();
    expect(view.invalidateNoiseResult).toHaveBeenCalled();
    if (withEditors) {
        expect(view.levelsView.resetLevels).toHaveBeenCalledTimes(1);
        expect(view.curvesView.resetCurve).toHaveBeenCalledTimes(1);
    }
});

test("a scene switch rebuilds controls in the permanent folders and binds the new video", () => {
    const oldView = video();
    oldView.inputs.brightness.setValue(4);
    rebuildScene();
    const newView = video();
    expect(newView.inputs.brightness.value).toBe(1);
    expect(newView.inputs.brightness).not.toBe(oldView.inputs.brightness);
    expect(setup.guiVideoEffectsFolder.controllers.filter(c => c.property === "resetFilters")).toHaveLength(1);
    newView.inputs.fullABBlend.guiEntry.setValue(true);
    expect(newView.startFullABBlend).toHaveBeenCalledTimes(1);
    expect(oldView.startFullABBlend).not.toHaveBeenCalled();
});

test("saved GUI values restore by their existing node IDs after rebuilding the scene", () => {
    const first = video();
    first.inputs.brightness.setValue(2.375);
    first.inputs.blur.setValue(1.23);
    first.inputs.curves.guiEntry.setValue(true);
    first.inputs.histogramOnScreen.guiEntry.setValue(true);
    const saved = saveMods(first, ["brightness", "blur", "curves", "histogramOnScreen"]);
    rebuildScene();
    const restored = video();
    for (const [id, mod] of Object.entries(saved)) NodeMan.get(id).modDeserialize(mod);
    expect(restored.inputs.brightness.value).toBe(2.375);
    expect(restored.inputs.blur.value).toBe(1.23);
    expect(restored.inputs.curves.value).toBe(true);
    expect(restored.inputs.histogramOnScreen.value).toBe(true);
    expect(restored.inputs.showCurves.guiEntry._hidden).toBe(false);
    expect(restored.updateCurvesVisibility).toHaveBeenCalled();
});

const SELECTORS = ["convolutionFilter", "elaExpandMethod", "noiseDisplayMode"];

test("the selectors are saved, and a loaded selection updates the controls that use it", () => {
    const first = video();
    first.inputs.convolutionFilter.guiEntry.setValue("sharpen");
    first.inputs.elaExpandMethod.guiEntry.setValue("autoContrast");
    first.inputs.noiseDisplayMode.guiEntry.setValue("residual");
    const saved = saveMods(first, SELECTORS);
    // The save leaves out a mod that holds only {visible: true}, so the value must be in it.
    expect(Object.values(saved).map(mod => mod.value)).toEqual(["sharpen", "autoContrast", "residual"]);
    rebuildScene();
    const restored = video();
    expect(restored.inputs.sharpenAmount.guiEntry._hidden).toBe(true);
    for (const [id, mod] of Object.entries(saved)) NodeMan.get(id).modDeserialize(mod);
    const input = restored.inputs;
    expect(SELECTORS.map(key => input[key].value)).toEqual(["sharpen", "autoContrast", "residual"]);
    expect(SELECTORS.map(key => input[key].guiEntry.$display.textContent))
        .toEqual(["sharpen", "Auto Contrast", "Noise Residual"]);
    expect(input.sharpenAmount.guiEntry._hidden).toBe(false);
    expect(input.embossDepth.guiEntry._hidden).toBe(true);
    expect(input.elaContrastClipPercent.guiEntry._hidden).toBe(false);
    expect(restored.invalidateELAResult).toHaveBeenCalledTimes(1);
    expect(restored.invalidateNoiseResult).toHaveBeenCalledTimes(1);
});

test("a save from before the selectors were saved loads with their defaults", () => {
    const view = video();
    for (const key of SELECTORS) view.inputs[key].modDeserialize({visible: true});
    expect(SELECTORS.map(key => view.inputs[key].value)).toEqual(["none", "none", "heatmap"]);
    expect(view.inputs.sharpenAmount.guiEntry._hidden).toBe(true);
    expect(view.invalidateELAResult).not.toHaveBeenCalled();
});
