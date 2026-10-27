// The Frequency Analysis peak search floor: the menu setting, the saved-state
// sanitizer, the spectrum the view computes, and the exported settings row.
jest.mock("../src/Globals", () => ({
    Globals: {loadGeneration: 1}, NodeMan: {get: jest.fn()}, setRenderOne: jest.fn(), Sit: {frames: 300},
}));
jest.mock("../src/i18n", () => ({t: key => key}));
jest.mock("../src/CViewManager", () => ({ViewMan: {fullscreenSuppressed: new Set()}}));
jest.mock("../src/nodes/CNodeCustomGraphView", () => ({CNodeCustomGraphView: class {
    constructor(v) { this.id = v.id; }
    modSerialize() { return {}; }
    modDeserialize() {}
}}));
jest.mock("../src/nodes/CNodeTabbedCanvasView", () => ({CNodeTabbedCanvasView: class {}}));
jest.mock("../src/CVideoLoadingManager", () => ({VideoLoadingManager: {isLoading: () => false}}));
jest.mock("../src/CObjectTracking", () => ({getObjectTracker: jest.fn()}));
jest.mock("../src/TraverseAnalysisData", () => ({abFrameRange: jest.fn()}));
jest.mock("../src/videoQP/VideoQPAnalysis", () => ({displayIndexForFrame: jest.fn(), sourceVideoOf: jest.fn()}));
jest.mock("../src/videoTonal/VideoTonalAnalysis", () => ({startTonalAnalysis: jest.fn()}));
jest.mock("file-saver", () => ({saveAs: jest.fn()}));

import {NodeMan} from "../src/Globals";
import {saveAs} from "file-saver";
import {
    addPointTrackFrequencyMenu, clampPeakFloor, FREQUENCY_DEFAULTS, MAX_PEAK_FLOOR_HZ, resetPointTrackFrequencyGraph,
} from "../src/PointTrackFrequencyGraph";
import {CNodePointTrackFrequencyGraphView} from "../src/pointFrequency/CNodePointTrackFrequencyGraphView";

function menu() {
    const calls = [], controller = {};
    for (const method of ['name', 'tooltip', 'listen', 'perm']) controller[method] = () => controller;
    const folder = {
        add(object, key, min, max, step) { calls.push({object, key, min, max, step}); return controller; },
        addFolder() { return folder; },
        close() { return folder; },
        perm() { return folder; },
    };
    addPointTrackFrequencyMenu(folder);
    return calls.find(call => call.key === 'minPeakHz');
}

// 10 s at 30 fps: a 10 Hz flicker on slow curved drift.
const indices = Array.from({length: 300}, (_, i) => i);
const flux = indices.map(i => 100 + 240 * (i / 300 - .5) ** 2 + 2 * Math.sin(2 * Math.PI * 10 * i / 30));

function analyzedView(options = {}) {
    const view = new CNodePointTrackFrequencyGraphView({id: 'pointTrackFrequencyGraph', options: {...FREQUENCY_DEFAULTS, ...options}});
    view.job = {cancel() {}, result: {complete: true, flux, area: indices.map(() => 50), background: indices.map(() => 20),
        clippedFraction: indices.map(() => 0), mode: 'luma', bits: 8, masked: false}};
    view._inputs = {plan: {indices, targets: Object.fromEntries(indices.map(i => [i, {u: .5, v: .5}]))},
        sampling: {fps: 30, irregular: false, times: indices.map(i => i / 30), minFps: 30, maxFps: 30},
        range: {frame0: 0, frame1: 299}, smoothing: 0, video: {videoWidth: 40, videoHeight: 40}};
    return view;
}

beforeEach(() => {
    NodeMan.get.mockReset().mockReturnValue(null);
    resetPointTrackFrequencyGraph();
});

test('the floor defaults to 0.5 Hz and is clamped to 0–30 Hz', () => {
    expect(FREQUENCY_DEFAULTS.minPeakHz).toBe(0.5);
    expect(MAX_PEAK_FLOOR_HZ).toBe(30);
    expect(clampPeakFloor(2.5)).toBe(2.5);
    expect(clampPeakFloor('4')).toBe(4);
    expect(clampPeakFloor(0)).toBe(0);
    expect(clampPeakFloor(-2)).toBe(0);
    expect(clampPeakFloor(1000)).toBe(30);
    expect(clampPeakFloor(Infinity)).toBe(30);
    for (const bad of [NaN, undefined, null, '', 'fast']) expect(clampPeakFloor(bad)).toBe(0.5);
});

test('the menu control keeps the floor a number and re-labels without a new decode', () => {
    const control = menu();
    expect([control.min, control.max]).toEqual([0, 30]);
    const proxy = control.object;
    expect(proxy.minPeakHz).toBe(0.5);
    proxy.minPeakHz = 0;
    expect(proxy.minPeakHz).toBe(0);
    proxy.minPeakHz = 45;
    expect(proxy.minPeakHz).toBe(30);
    proxy.minPeakHz = NaN;
    expect(proxy.minPeakHz).toBe(0.5);

    const view = {options: {...FREQUENCY_DEFAULTS}, updateSpectrum: jest.fn(), refreshAnalysis: jest.fn()};
    NodeMan.get.mockReturnValue(view);
    proxy.minPeakHz = '3';
    expect(view.options.minPeakHz).toBe(3);
    expect(view.updateSpectrum).toHaveBeenCalledTimes(1);
    expect(view.refreshAnalysis).not.toHaveBeenCalled();

    NodeMan.get.mockReturnValue(null);
    resetPointTrackFrequencyGraph();
    expect(proxy.minPeakHz).toBe(0.5);
});

test('saved states are sanitized; saves without a floor get the default', () => {
    const view = analyzedView();
    view.modDeserialize({frequencyOptions: {radius: 6, percent: false}});
    expect(view.options.minPeakHz).toBe(0.5);
    view.modDeserialize({frequencyOptions: {minPeakHz: '2.5'}});
    expect(view.options.minPeakHz).toBe(2.5);
    view.modDeserialize({frequencyOptions: {minPeakHz: 99}});
    expect(view.options.minPeakHz).toBe(30);
    view.modDeserialize({frequencyOptions: {minPeakHz: 0}});
    expect(view.options.minPeakHz).toBe(0);
    view.modDeserialize({frequencyOptions: {minPeakHz: null}});
    expect(view.options.minPeakHz).toBe(0.5);
    view.modDeserialize({});
    expect(view.options.minPeakHz).toBe(0.5);
    expect(view.modSerialize().frequencyOptions.minPeakHz).toBe(0.5);
});

test('the view searches above its floor and exports the floor with the settings', async () => {
    const view = analyzedView();
    view.updateSpectrum();
    expect(Math.abs(view.spectrum.peak.frequency - 10)).toBeLessThan(view.spectrum.binSpacing);
    expect(view.spectrum.peakFloor).toBe(0.5);
    expect(view.backgroundSpectrum.peakFloor).toBe(0.5);

    view.options.minPeakHz = 0;
    view.updateSpectrum();
    expect(view.spectrum.peak.frequency).toBeLessThan(.5);

    view.options.minPeakHz = 2;
    view.updateSpectrum();
    await view.exportCSV();
    const rows = (await saveAs.mock.calls.at(-1)[0].text()).split('\n');
    const header = rows.findIndex(row => row.startsWith('scene_in,'));
    const columns = rows[header].split(','), values = rows[header + 1].split(',');
    expect(columns.at(-1)).toBe('peak_floor_hz');
    expect(values.length).toBe(columns.length);
    expect(Number(values.at(-1))).toBe(2);
});
