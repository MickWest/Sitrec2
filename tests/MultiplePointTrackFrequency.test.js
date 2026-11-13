jest.mock('../src/Globals', () => ({
    Globals: {loadGeneration: 1}, NodeMan: {get: jest.fn(), disposeRemove: jest.fn()}, setRenderOne: jest.fn(), Sit: {},
}));
jest.mock('../src/CViewManager', () => ({ViewMan: {fullscreenSuppressed: new Set()}}));
jest.mock('../src/i18n', () => ({t: key => key}));
jest.mock('../src/pointFrequency/CNodePointTrackFrequencyGraphView', () => ({createPointTrackFrequencyGraphView: jest.fn()}));

import {NodeMan} from '../src/Globals';
import {pointTracks} from '../src/PointTrackRegistry';
import {createPointTrackFrequencyGraphView} from '../src/pointFrequency/CNodePointTrackFrequencyGraphView';
import {
    showPointTrackFrequencyGraph, serializePointTrackFrequencyGraph, deserializePointTrackFrequencyGraph,
    resetPointTrackFrequencyGraph, removePointTrackFrequencyGraph, getPointTrackFrequencyView,
    addPointTrackFrequencyMenu,
} from '../src/PointTrackFrequencyGraph';

let views;
beforeEach(() => {
    views = new Map();
    pointTracks.splice(0, pointTracks.length, ...[1, 2, 3].map(n => ({trackId: `track${n}`, editable: n === 1})));
    resetPointTrackFrequencyGraph();
    NodeMan.get.mockImplementation(id => views.get(id));
    NodeMan.disposeRemove.mockImplementation(id => views.delete(id));
    createPointTrackFrequencyGraphView.mockImplementation((id, options, trackId) => {
        const view = {id, trackId, visible: true, options: {...options}, left: .2,
            show(v) { this.visible = v; }, refreshAnalysis: jest.fn(), updateSpectrum: jest.fn(),
            modSerialize() { return {visible: this.visible, left: this.left, frequencyOptions: {...this.options}}; },
            modDeserialize(state) { this.left = state.left; this.options = {...state.frequencyOptions}; },
        };
        views.set(id, view);
        return view;
    });
});
afterEach(() => { pointTracks.length = 0; resetPointTrackFrequencyGraph(); });

function frequencyControls() {
    const calls = {};
    const controller = {};
    for (const name of ['name', 'tooltip', 'listen', 'perm', 'noSlider']) controller[name] = () => controller;
    const folder = {add(object, key) { calls[key] = object; return controller; }};
    for (const name of ['addFolder', 'close', 'perm', 'tooltip']) folder[name] = () => folder;
    addPointTrackFrequencyMenu(folder);
    return calls;
}

test('three graphs stay attached to their tracks when editing changes, and settings stay independent', async () => {
    for (const track of pointTracks) await showPointTrackFrequencyGraph(true, null, track.trackId);
    expect(views.size).toBe(3);
    const controls = frequencyControls();
    controls.radius.radius = 3;
    pointTracks[0].editable = false;
    pointTracks[1].editable = true;
    controls.radius.radius = 8;
    expect([...views.values()].map(v => v.trackId)).toEqual(['track1', 'track2', 'track3']);
    expect([...views.values()].map(v => v.options.radius)).toEqual([3, 8, 4]);
    expect([...views.values()].every(v => v.visible)).toBe(true);
    await showPointTrackFrequencyGraph(false);
    expect([...views.values()].map(v => v.visible)).toEqual([true, false, true]);
});

test('save/load preserves all windows, including a hidden graph and its aperture and position', async () => {
    for (const track of pointTracks) await showPointTrackFrequencyGraph(true, null, track.trackId);
    getPointTrackFrequencyView('track2').options.radius = 7;
    getPointTrackFrequencyView('track2').left = .6;
    await showPointTrackFrequencyGraph(false, null, 'track2');
    const saved = serializePointTrackFrequencyGraph();
    views.clear(); resetPointTrackFrequencyGraph();
    await deserializePointTrackFrequencyGraph(saved);
    expect([...views.values()].map(v => v.visible)).toEqual([true, false, true]);
    expect(getPointTrackFrequencyView('track2')).toMatchObject({left: .6, options: {radius: 7}});
    removePointTrackFrequencyGraph('track2');
    pointTracks.splice(1, 1);
    expect(views.size).toBe(2);
    expect(serializePointTrackFrequencyGraph().tracks.track2).toBeUndefined();
});

test('an old single frequency graph restores on the first track', async () => {
    await deserializePointTrackFrequencyGraph({visible: true, left: .4, frequencyOptions: {radius: 5}});
    expect(views.size).toBe(1);
    expect(getPointTrackFrequencyView('track1')).toMatchObject({trackId: 'track1', left: .4, options: {radius: 5}});
});

test('hiding during lazy loading does not reopen the window', async () => {
    const opening = showPointTrackFrequencyGraph(true, null, 'track3');
    await showPointTrackFrequencyGraph(false, null, 'track3');
    await opening;
    expect(views.size).toBe(0);
});
