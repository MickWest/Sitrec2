/** @jest-environment jsdom */
jest.mock("../src/nodes/CNodeViewText", () => ({CNodeViewText: class { show() {} }}));
jest.mock("../src/Globals", () => ({NodeMan: {get: jest.fn()}, setRenderOne: jest.fn(), Sit: {}}));
jest.mock("../src/par", () => ({par: {frame: 0}}));
jest.mock("../src/i18n", () => ({t: key => key}));
jest.mock("../src/configUtils", () => ({isLocal: false}));
jest.mock("../src/CVideoLoadingManager", () => ({}));
jest.mock("../src/TimelineMenu", () => ({goToTimelineFrame: jest.fn()}));
jest.mock("../src/showError", () => ({}));
jest.mock("../src/VideoNoisePattern", () => ({setVideoNoisePatternTeardown: jest.fn()}));
jest.mock("../src/videoNoisePattern/NoisePatternJob", () => ({terminateNoisePatternWorkers: jest.fn()}));
jest.mock("../src/videoNoisePattern/NoisePatternCharts", () => ({}));
jest.mock("../src/videoQP/VideoQPAnalysis", () => ({}));

import {NodeMan} from "../src/Globals";
import {CNodeVideoNoisePatternView} from "../src/videoNoisePattern/CNodeVideoNoisePatternView";

const node = value => ({value, setValue(v) { this.value = v; }});
let view, contrast, effects;
beforeEach(() => {
    contrast = node(1.5);
    effects = node(false);
    NodeMan.get.mockImplementation(id => ({videoContrast: contrast, videoEnableEffects: effects})[id]);
    view = Object.assign(Object.create(CNodeVideoNoisePatternView.prototype), {
        ui: {}, refreshDisplay: jest.fn(),
    });
});

test("closing the window puts back the contrast and effects that Max contrast changed", () => {
    view.toggleMaxContrast();
    expect([contrast.value, effects.value, view.ui.maxContrast]).toEqual([5, true, true]);
    view.show(false);
    expect([contrast.value, effects.value, view.ui.maxContrast]).toEqual([1.5, false, false]);
});

test("closing the window without Max contrast leaves the adjustments alone", () => {
    effects.value = true;
    view.show(false);
    expect([contrast.value, effects.value]).toEqual([1.5, true]);
});
