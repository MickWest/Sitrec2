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

import {NodeMan, Sit} from "../src/Globals";
import {saveAs} from "file-saver";
import {
    addPointTrackFrequencyMenu, clampPeakFloor, FREQUENCY_DEFAULTS, MAX_PEAK_FLOOR_HZ, resetPointTrackFrequencyGraph,
} from "../src/PointTrackFrequencyGraph";
import {CNodePointTrackFrequencyGraphView} from "../src/pointFrequency/CNodePointTrackFrequencyGraphView";

function menuCalls() {
    const calls = [], controller = {};
    for (const method of ['name', 'tooltip', 'listen', 'perm', 'noSlider']) controller[method] = () => controller;
    const folder = {
        add(object, key, min, max, step) { calls.push({object, key, min, max, step}); return controller; },
        addFolder() { return folder; },
        close() { return folder; },
        perm() { return folder; },
        tooltip() { return folder; },
    };
    addPointTrackFrequencyMenu(folder);
    return calls;
}
const menu = () => menuCalls().find(call => call.key === 'minPeakHz');

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

test('the widening frames follow In/Out until they are set', () => {
    const calls = menuCalls();
    expect(calls.map(call => call.key)).toEqual(expect.arrayContaining(['in1', 'in2', 'out1', 'out2', 'pingPong', 'renderWidening']));
    const proxy = calls.find(call => call.key === 'in1').object;
    try {
        Sit.aFrame = 522; Sit.bFrame = 905;
        // In 2/Out 2 are the In/Out region; In 1/Out 1 are its middle quarter.
        expect([proxy.in1, proxy.in2, proxy.out1, proxy.out2]).toEqual([666, 522, 761, 905]);
        Sit.aFrame = 100; Sit.bFrame = 110;
        // A short region still gives at least 16 frames, inside In/Out when it can.
        expect([proxy.in1, proxy.in2, proxy.out1, proxy.out2]).toEqual([100, 100, 110, 110]);

        proxy.in1 = 618.4; proxy.out1 = '685';
        Sit.aFrame = 522; Sit.bFrame = 905;
        expect([proxy.in1, proxy.in2, proxy.out1, proxy.out2]).toEqual([618, 522, 685, 905]);
        proxy.in2 = -5;
        expect(proxy.in2).toBe(0);
        // The reverse part is an option, and it is off until it is set.
        expect(proxy.pingPong).toBe(false);
        proxy.pingPong = 1;
        expect(proxy.pingPong).toBe(true);

        resetPointTrackFrequencyGraph();
        expect([proxy.in1, proxy.in2, proxy.out1, proxy.out2]).toEqual([666, 522, 761, 905]);
        expect(proxy.pingPong).toBe(false);
    } finally {
        delete Sit.aFrame; delete Sit.bFrame;
    }
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

test('the vertical scale covers only the frequencies that the peak search considers', () => {
    // DN·px, so the scale is the amplitude itself. The fixture background is constant.
    const view = analyzedView({minPeakHz: 1.5, percent: false});
    const scaled = () => { view.updateSpectrum(); view.autoScale(); return view.maxY; };
    // The labeled 10 Hz flicker fills the plot. The drift below the floor is still
    // in the spectrum, and taller than the plot.
    expect(scaled()).toBeCloseTo(view.spectrum.peak.amplitude * 1.1, 9);
    expect(view.spectrum.peak.amplitude).toBeCloseTo(2, 1);
    expect(Math.max(...view.spectrum.amplitude)).toBeGreaterThan(5 * view.maxY);

    // With no floor the drift is searched, so it sets the scale as it did before.
    view.options.minPeakHz = 0;
    expect(scaled()).toBeCloseTo(view.spectrum.peak.amplitude * 1.1, 9);
    expect(view.maxY).toBeGreaterThan(10);

    // Nothing to search: the whole spectrum sets the scale, so the curve stays in view.
    view.options.minPeakHz = 30;
    expect(scaled()).toBeCloseTo(Math.max(...view.spectrum.amplitude) * 1.1, 9);
    expect(view.spectrum.peak).toBeNull();
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
    const floor = columns.indexOf('peak_floor_hz');
    expect(floor).toBeGreaterThan(-1);
    expect(values.length).toBe(columns.length);
    expect(Number(values[floor])).toBe(2);
});
