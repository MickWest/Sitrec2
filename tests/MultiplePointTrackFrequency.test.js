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
    addPointTrackFrequencyMenu, setPointTrackFrequencyRadius, showNewPointTrackFrequencyGraph, getPointTrackFrequencyAperture,
} from '../src/PointTrackFrequencyGraph';

const SINGLE = 'pointTrackFrequencyGraph_all';
let views;
beforeEach(() => {
    views = new Map();
    pointTracks.splice(0, pointTracks.length, ...[1, 2, 3].map(n => ({trackId: `track${n}`, editable: n === 1})));
    resetPointTrackFrequencyGraph();
    NodeMan.get.mockImplementation(id => views.get(id));
    NodeMan.disposeRemove.mockImplementation(id => views.delete(id));
    // A window: its own track (trackId), or the single graph (trackId null) with the tracks setTracks gives it.
    createPointTrackFrequencyGraphView.mockImplementation((id, options, trackId) => {
        const view = {id, trackId, visible: true, options: {...options}, left: .2, trackIds: trackId ? [trackId] : [], radii: {},
            show(v) { this.visible = v; }, refreshAnalysis: jest.fn(), updateSpectrum: jest.fn(),
            setTracks(ids) { this.trackIds = [...ids]; },
            setTrackRadius: jest.fn(function(trackId, radius) { this.radii[trackId] = radius; }),
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
const separateMode = () => { const controls = frequencyControls(); controls.singleGraph.singleGraph = false; return controls; };
const single = () => views.get(SINGLE);

test('frequency settings apply to all tracks regardless of edit selection, with per-track radius overrides', async () => {
    const controls = separateMode();
    for (const track of pointTracks) await showPointTrackFrequencyGraph(true, null, track.trackId);
    expect(views.size).toBe(3);
    controls.radius.radius = 3;
    setPointTrackFrequencyRadius('track2', 6);
    const overridden = getPointTrackFrequencyView('track2');
    overridden.setTrackRadius.mockClear();
    pointTracks[0].editable = false;
    pointTracks[1].editable = true;
    controls.radius.radius = 8;
    expect([...views.values()].map(v => v.trackId)).toEqual(['track1', 'track2', 'track3']);
    expect([...views.values()].map(v => v.radii[v.trackId])).toEqual([8, 6, 8]);
    // The overridden track keeps its radius (a window measures again only on a change).
    expect(overridden.setTrackRadius.mock.calls.every(([id, radius]) => id === 'track2' && radius === 6)).toBe(true);
    controls.minPeakHz.minPeakHz = 2;
    controls.percent.percent = false;
    controls.showBackground.showBackground = false;
    controls.perMinute.perMinute = true;
    for (const view of views.values()) expect(view.options).toMatchObject({minPeakHz: 2, percent: false, showBackground: false, perMinute: true});
    setPointTrackFrequencyRadius('track2', 0);
    expect(overridden.radii.track2).toBe(8);
    expect([...views.values()].every(v => v.visible)).toBe(true);
    await showPointTrackFrequencyGraph(false);
    expect([...views.values()].map(v => v.visible)).toEqual([true, false, true]);
});

test('save/load preserves all windows, including a hidden graph and its aperture and position', async () => {
    separateMode();
    for (const track of pointTracks) await showPointTrackFrequencyGraph(true, null, track.trackId);
    setPointTrackFrequencyRadius('track2', 7);
    frequencyControls().minPeakHz.minPeakHz = 2;
    getPointTrackFrequencyView('track2').left = .6;
    await showPointTrackFrequencyGraph(false, null, 'track2');
    const saved = serializePointTrackFrequencyGraph();
    expect(saved.settings.minPeakHz).toBe(2);
    expect(saved.singleGraph).toBe(false);
    expect(saved.single).toBeUndefined();
    expect(saved.tracks.track2.frequencyOptions).toBeUndefined();
    views.clear(); resetPointTrackFrequencyGraph();
    await deserializePointTrackFrequencyGraph(saved);
    expect([...views.values()].map(v => v.visible)).toEqual([true, false, true]);
    expect(getPointTrackFrequencyView('track2')).toMatchObject({left: .6, radii: {track2: 7}});
    removePointTrackFrequencyGraph('track2');
    pointTracks.splice(1, 1);
    expect(views.size).toBe(2);
    expect(serializePointTrackFrequencyGraph().tracks.track2).toBeUndefined();
});

test('an old single frequency graph restores on the single graph, at its saved place', async () => {
    await deserializePointTrackFrequencyGraph({visible: true, left: .4, frequencyOptions: {radius: 5}});
    expect(views.size).toBe(1);
    expect(single()).toMatchObject({trackId: null, left: .4, visible: true, trackIds: ['track1'], radii: {track1: 5}});
    expect(getPointTrackFrequencyView('track1')).toBe(single());
});

test('hiding during lazy loading does not reopen the window', async () => {
    separateMode();
    const opening = showPointTrackFrequencyGraph(true, null, 'track3');
    await showPointTrackFrequencyGraph(false, null, 'track3');
    await opening;
    expect(views.size).toBe(0);
});

test('the main checkbox controls all graphs and new tracks inherit the common settings', async () => {
    const controls = separateMode();
    controls.radius.radius = 9;
    controls.show.show = true;
    await Promise.resolve(); await Promise.resolve();
    expect([...views.values()].map(v => v.visible)).toEqual([true, true, true]);
    pointTracks.push({trackId: 'track4', frequencyRadius: 0});
    await showNewPointTrackFrequencyGraph('track4');
    expect(getPointTrackFrequencyView('track4').radii.track4).toBe(9);
    controls.show.show = false;
    expect([...views.values()].every(v => !v.visible)).toBe(true);
});

test('legacy per-track apertures migrate to overrides and the selected graph supplies common settings', async () => {
    pointTracks[0].editable = false; pointTracks[1].editable = true;
    await deserializePointTrackFrequencyGraph({version: 2, singleGraph: false, tracks: {
        track1: {visible: true, frequencyOptions: {radius: 12, minPeakHz: 0}},
        track2: {visible: true, frequencyOptions: {radius: 4, minPeakHz: 1.5}},
        track3: {visible: true, frequencyOptions: {radius: 4, minPeakHz: 0.5}},
    }});
    expect([...views.values()].map(v => v.radii[v.trackId])).toEqual([12, 4, 4]);
    expect(pointTracks[0].frequencyRadius).toBe(12);
    expect([...views.values()].map(v => v.options.minPeakHz)).toEqual([1.5, 1.5, 1.5]);
    const controls = frequencyControls();
    controls.radius.radius = 5;
    expect([...views.values()].map(v => v.radii[v.trackId])).toEqual([12, 5, 5]);
});

test('Single Graph is on by default: the tracks share one window, and the Track List adds and removes lines', async () => {
    const controls = frequencyControls();
    expect(controls.singleGraph.singleGraph).toBe(true);
    await showPointTrackFrequencyGraph(true, null, 'track2');
    expect([...views.keys()]).toEqual([SINGLE]);
    expect(single()).toMatchObject({trackId: null, visible: true, trackIds: ['track2']});
    expect(getPointTrackFrequencyView('track2')).toBe(single());
    expect(getPointTrackFrequencyView('track1')).toBeNull();
    expect(getPointTrackFrequencyAperture('track1')).toBeNull();
    await showPointTrackFrequencyGraph(true, null, 'track1');
    expect(single().trackIds).toEqual(['track2', 'track1']);
    expect(getPointTrackFrequencyAperture('track1')).toMatchObject({radius: 4});
    // The main checkbox: all lines on, then all off, which hides the window.
    controls.show.show = true;
    expect(single().trackIds).toEqual(['track2', 'track1', 'track3']);
    expect(controls.show.show).toBe(true);
    await showPointTrackFrequencyGraph(false, null, 'track1');
    expect(single().trackIds).toEqual(['track2', 'track3']);
    expect(single().visible).toBe(true);
    controls.show.show = false;
    expect(single()).toMatchObject({visible: false, trackIds: []});
    expect(controls.show.show).toBe(false);
    // A window that was off comes back with only the asked track.
    single().setTracks(['track3']);
    await showPointTrackFrequencyGraph(true, null, 'track1');
    expect(single()).toMatchObject({visible: true, trackIds: ['track1']});
    expect(views.size).toBe(1);
});

test('on the single graph the common radius and a track override reach the right lines', async () => {
    const controls = frequencyControls();
    controls.show.show = true;
    await Promise.resolve(); await Promise.resolve();
    controls.radius.radius = 7;
    expect(single().radii).toEqual({track1: 7, track2: 7, track3: 7});
    setPointTrackFrequencyRadius('track2', 3);
    expect(single().radii).toEqual({track1: 7, track2: 3, track3: 7});
    expect(getPointTrackFrequencyAperture('track2')).toMatchObject({radius: 3});
    controls.radius.radius = 9;
    expect(single().radii).toEqual({track1: 9, track2: 3, track3: 9});
    pointTracks.push({trackId: 'track4', frequencyRadius: 0});
    await showNewPointTrackFrequencyGraph('track4');
    expect(single().trackIds).toEqual(['track1', 'track2', 'track3', 'track4']);
    expect(single().radii.track4).toBe(9);
    removePointTrackFrequencyGraph('track4');
    expect(single().trackIds).toEqual(['track1', 'track2', 'track3']);
    controls.minPeakHz.minPeakHz = 2;
    expect(single().options.minPeakHz).toBe(2);
    expect(single().updateSpectrum).toHaveBeenCalled();
});

test('a single-graph save keeps the window, the lines that are on, and the mode', async () => {
    const controls = frequencyControls();
    await showPointTrackFrequencyGraph(true, null, 'track1');
    await showPointTrackFrequencyGraph(true, null, 'track3');
    single().left = .7;
    setPointTrackFrequencyRadius('track3', 6);
    const saved = serializePointTrackFrequencyGraph();
    expect(saved).toMatchObject({version: 4, singleGraph: true, single: {visible: true, left: .7},
        tracks: {track1: {visible: true}, track2: {visible: false}, track3: {visible: true}}});
    views.clear(); resetPointTrackFrequencyGraph();
    await deserializePointTrackFrequencyGraph(saved);
    expect([...views.keys()]).toEqual([SINGLE]);
    expect(single()).toMatchObject({visible: true, left: .7, trackIds: ['track1', 'track3'], radii: {track1: 4, track3: 6}});
    expect(controls.singleGraph.singleGraph).toBe(true);
    // A hidden single window keeps its place.
    controls.show.show = false;
    const hidden = serializePointTrackFrequencyGraph();
    expect(hidden.single).toMatchObject({visible: false, left: .7});
    views.clear(); resetPointTrackFrequencyGraph();
    await deserializePointTrackFrequencyGraph(hidden);
    expect(single()).toMatchObject({visible: false, left: .7, trackIds: []});
});

test('a save with a window for each track loads on the single graph, at the first window\'s place', async () => {
    await deserializePointTrackFrequencyGraph({version: 3, tracks: {
        track1: {visible: false}, track2: {visible: true, left: .3}, track3: {visible: true, left: .5},
    }, settings: {radius: 5}});
    expect([...views.keys()]).toEqual([SINGLE]);
    expect(single()).toMatchObject({visible: true, left: .3, trackIds: ['track2', 'track3']});
});

test('turning Single Graph off and on moves the shown tracks between the windows', async () => {
    const controls = frequencyControls();
    controls.show.show = true;
    await Promise.resolve(); await Promise.resolve();
    await showPointTrackFrequencyGraph(false, null, 'track2');
    controls.singleGraph.singleGraph = false;
    await Promise.resolve(); await Promise.resolve();
    expect(single().visible).toBe(false);
    expect([...views.values()].filter(v => v.visible).map(v => v.trackId)).toEqual(['track1', 'track3']);
    expect(getPointTrackFrequencyView('track2')).toBeUndefined();
    expect(serializePointTrackFrequencyGraph().singleGraph).toBe(false);
    await showPointTrackFrequencyGraph(true, null, 'track2');
    controls.singleGraph.singleGraph = true;
    await Promise.resolve(); await Promise.resolve();
    expect([...views.values()].filter(v => v.visible)).toEqual([single()]);
    expect(single().trackIds).toEqual(['track1', 'track2', 'track3']);
});

test('a change of Single Graph while the graph code loads shows the track in the new mode', async () => {
    const controls = frequencyControls();
    const opening = showPointTrackFrequencyGraph(true, null, 'track2');
    controls.singleGraph.singleGraph = false;
    await opening;
    expect(single()).toBeUndefined();
    expect(getPointTrackFrequencyView('track2')).toMatchObject({trackId: 'track2', visible: true});
    expect(controls.show.show).toBe(true);
    // Nothing is left pending, so the main checkbox goes off with the window.
    await showPointTrackFrequencyGraph(false, null, 'track2');
    expect(controls.show.show).toBe(false);
});
