// Point Track settings chosen in the menu BEFORE Enable, when no tracker exists
// yet, must reach the tracker that Enable creates. A loaded save must not be
// overridden by them, and a tracker made with no menu changes must have exactly
// the ObjectTracker constructor's values.
//
// Each test loads a fresh copy of CObjectTracking (jest.resetModules), because
// the pending settings and the tracker are module state.

jest.mock('../src/Globals', () => ({
    Globals: {}, Sit: {frames: 20, aFrame: 0, bFrame: 19},
    NodeMan: {get: jest.fn(() => null)}, setRenderOne: jest.fn(),
    unregisterFrameBlocker: jest.fn(), guiMenus: {},
}));
jest.mock('../src/openCVLoader', () => ({getCV: () => ({}), loadOpenCV: jest.fn()}));
jest.mock('../src/jsfeatLoader', () => ({getJsfeat: jest.fn(() => null), loadJsfeat: jest.fn()}));
jest.mock('../src/CVideoData', () => ({interpolatePosition: (map, f) => map.get(f)}));
jest.mock('../src/CEventManager', () => ({}));
jest.mock('../src/KeyBoardHandler', () => ({KeyMan: {isKeyHeld: jest.fn(), clearAll: jest.fn()}}));
jest.mock('../src/VideoExporter', () => ({}));
jest.mock('../src/utils', () => ({}));
jest.mock('../src/showError', () => ({showError: jest.fn(), showConfirm: jest.fn()}));
jest.mock('../src/AttributionOverlay', () => ({}));
jest.mock('../src/configUtils', () => ({isLocal: false}));
jest.mock('../src/i18n', () => ({t: v => v}));
jest.mock('../src/PointTrackFrequencyGraph', () => ({
    addPointTrackFrequencyMenu: jest.fn(),
    clampFrequencyRadiusOverride: value => Number(value) > 0 ? Math.max(2, Number(value)) : 0,
    showNewPointTrackFrequencyGraph: jest.fn(),
    getPointTrackFrequencyAperture: jest.fn(() => null),
    removePointTrackFrequencyGraph: jest.fn(),
}));

// The settings that are held before Enable. Each is also the menu property that sets it.
const SETTINGS = ['trackRadius', 'searchRadius', 'featureSize', 'useMask',
    'brightnessThreshold', 'trackingColor', 'colorDistance'];

// A lil-gui stand-in: records each controller by its property name.
function fakeFolder(controls) {
    const folder = {
        add: (object, property) => controller(controls, object, property),
        addColor: (object, property) => controller(controls, object, property),
        addFolder: () => fakeFolder(controls),
        close: () => folder, perm: () => folder, tooltip: () => folder,
    };
    return folder;
}

function controller(controls, object, property) {
    const c = {object, property};
    for (const m of ['name', 'tooltip', 'listen', 'perm', 'disable']) c[m] = () => c;
    c.onChange = fn => { c.changed = fn; return c; };
    c.onFinishChange = () => c;
    controls[property] = c;
    return c;
}

function load() {
    jest.resetModules();
    const Globals = require('../src/Globals');
    const tracking = require('../src/CObjectTracking');
    const {showError} = require('../src/showError');
    const videoView = {
        videoData: {originalVideoWidth: 1000, originalVideoHeight: 500, videoWidth: 1000, videoHeight: 500,
            setStabilizationEnabled: () => {}},
        div: {appendChild: () => {}},
        renderCanvas: () => {},
    };
    Globals.NodeMan.get.mockImplementation(id => id === 'video' ? videoView : null);
    const controls = {};
    Globals.guiMenus.view = {};
    Globals.guiMenus.video = {addFolder: () => fakeFolder(controls)};
    tracking.addObjectTrackingMenu();
    const value = key => controls[key].object[key];
    const set = (key, v) => { controls[key].object[key] = v; };
    const enable = () => controls.enableTracking.object.enableTracking();
    return {tracking, controls, videoView, value, set, enable, showError};
}

// What lil-gui does when the user picks a color: it edits the Color the getter
// returns, in place, then calls onChange. It never calls the setter.
function pickColor(controls, hex) {
    const c = controls.trackingColor;
    c.object.trackingColor.setHex(hex);
    c.changed?.(c.object.trackingColor);
}

beforeEach(() => {
    // Enable creates the overlay canvas.
    global.document = {createElement: () => ({style: {}, getContext: () => ({clearRect: () => {}})})};
});
afterEach(() => { delete global.document; });

test('before Enable the menu shows the constructor values, Feature Size 4 included', () => {
    const {tracking, videoView, value} = load();
    expect(tracking.getObjectTracker()).toBeNull();
    const fresh = new tracking.ObjectTracker(videoView);
    for (const key of SETTINGS) {
        if (key === 'trackingColor') expect(value(key).getHex()).toBe(fresh.trackingColor.getHex());
        else expect(value(key)).toBe(fresh[key]);
    }
    expect(value('featureSize')).toBe(4);
    expect(fresh.featureSize).toBe(4);
});

test('a tracker created with no menu changes has exactly the constructor values', () => {
    const {tracking, videoView, enable} = load();
    enable();
    const tracker = tracking.getObjectTracker();
    const fresh = new tracking.ObjectTracker(videoView);
    for (const key of [...SETTINGS, 'trackingMethod', 'motionPolarity', 'motionGap',
        'motionSamples', 'motionSlack', 'motionThreshold', 'smoothingFrames']) {
        if (key === 'trackingColor') expect(tracker.trackingColor.getHex()).toBe(fresh.trackingColor.getHex());
        else expect(tracker[key]).toBe(fresh[key]);
    }
});

test('settings chosen before Enable reach the tracker, and the color is never shared', () => {
    const {tracking, controls, value, set, enable} = load();
    set('trackRadius', 12);
    set('searchRadius', 90);
    set('featureSize', 7.5);
    set('useMask', false);
    set('brightnessThreshold', 200);
    set('colorDistance', 33);
    pickColor(controls, 0x00ff00);
    // The menu keeps showing what was chosen, instead of reverting.
    expect(value('trackRadius')).toBe(12);
    expect(value('trackingColor').getHex()).toBe(0x00ff00);
    const pendingColor = value('trackingColor');

    enable();
    const tracker = tracking.getObjectTracker();
    expect(tracker.enabled).toBe(true);
    expect(tracker).toMatchObject({trackRadius: 12, searchRadius: 90, featureSize: 7.5,
        useMask: false, brightnessThreshold: 200, colorDistance: 33});
    expect(tracker.trackingColor.getHex()).toBe(0x00ff00);
    expect(tracker.trackingColor).not.toBe(pendingColor);

    // With a tracker, a change goes to the tracker and is kept for the next one.
    set('trackRadius', 20);
    pickColor(controls, 0x0000ff);
    expect(tracker.trackRadius).toBe(20);
    expect(tracker.trackingColor.getHex()).toBe(0x0000ff);
    // A setter call (an API, not lil-gui) with a hex string also lands in both.
    set('trackingColor', '#ffff00');
    expect(tracker.trackingColor.getHex()).toBe(0xffff00);

    // A sitch reset discards the tracker; the next Enable starts from the menu again.
    tracking.resetObjectTracking();
    expect(value('trackRadius')).toBe(20);
    expect(value('trackingColor').getHex()).toBe(0xffff00);
    enable();
    const second = tracking.getObjectTracker();
    expect(second).not.toBe(tracker);
    expect(second.trackRadius).toBe(20);
    expect(second.trackingColor.getHex()).toBe(0xffff00);
    expect(second.trackingColor).not.toBe(tracker.trackingColor);
    expect(second.trackingColor).not.toBe(pendingColor);
});

test('a loaded save is never overridden by settings chosen before it', async () => {
    const {tracking, controls, set} = load();
    set('trackRadius', 12);
    set('featureSize', 9);
    set('colorDistance', 33);
    pickColor(controls, 0x00ff00);
    await tracking.deserializeAutoTracking({enabled: false, trackRadius: 40, featureSize: 2,
        colorDistance: 100, trackingColor: '#123456'});
    const tracker = tracking.getObjectTracker();
    expect(tracker).toMatchObject({trackRadius: 40, featureSize: 2, colorDistance: 100});
    expect(tracker.trackingColor.getHex()).toBe(0x123456);
});

test('a save without a setting loads the default, not the pending value; Feature Size default is 4', async () => {
    const {tracking, controls, set} = load();
    set('featureSize', 9);
    set('trackRadius', 12);
    pickColor(controls, 0x00ff00);
    await tracking.deserializeAutoTracking({enabled: false});
    const tracker = tracking.getObjectTracker();
    expect(tracker.featureSize).toBe(4);
    expect(tracker.trackRadius).toBe(30);
    expect(tracker.trackingColor.getHex()).toBe(0xff0000);
});

test('Stabilize with no tracker reports through showError', () => {
    const {controls, showError} = load();
    controls.stabilizeVideo.object.stabilizeVideo();
    expect(showError).toHaveBeenCalledWith(
        "Please enable tracking first and track an object before stabilizing.");
});


test('three tracks keep independent points, settings, visibility and edit selection across save/load', async () => {
    const {tracking, enable, set, value} = load();
    enable();
    const first = tracking.getObjectTracker();
    first.trackedPositions.set(2, {x: 100, y: 200});
    first.manualKeyframes.add(2);
    set('trackRadius', 7);
    const second = tracking.addPointTrack();
    second.trackName = 'Second object';
    second.frequencyRadius = 9;
    second.trackedPositions.set(3, {x: 300, y: 210});
    second.trackedPositions.unmeasuredFrames = new Set([4]);
    set('trackRadius', 12);
    const third = tracking.addPointTrack();
    third.trackName = 'Empty seed';
    third.trackX = 50; third.trackY = 60;
    second.disable();
    tracking.selectPointTrack(first.trackId);
    expect(value('trackRadius')).toBe(7);
    expect([first.editable, second.editable, third.editable]).toEqual([true, false, false]);
    expect(second.trackRadius).toBe(12);
    expect(first.enabled).toBe(true);
    expect(third.trackedPositions.size).toBe(0);
    const saved = tracking.serializeAutoTracking();
    await tracking.deserializeAutoTracking(saved);
    const tracks = tracking.getPointTracks();
    expect(tracks).toHaveLength(3);
    expect(tracking.getObjectTracker().trackId).toBe(first.trackId);
    expect(tracks.map(t => t.enabled)).toEqual([true, false, true]);
    expect(tracks[0].trackedPositions.get(2)).toEqual({x: 100, y: 200});
    expect(tracks[0].manualKeyframes.has(2)).toBe(true);
    expect(tracks[1].frequencyRadius).toBe(9);
    expect(tracks[0].frequencyRadius).toBe(0);
    expect(tracks[1].trackedPositions.get(3)).toEqual({x: 300, y: 210});
    expect(tracks[1].trackedPositions.unmeasuredFrames.has(4)).toBe(true);
    expect(tracks[2]).toMatchObject({trackName: 'Empty seed', trackX: 50, trackY: 60});
    tracking.selectPointTrack(second.trackId);
    expect(tracking.getObjectTracker()).toBe(tracks[1]);
    tracks[1].clearTrack();
    expect(tracks[0].trackedPositions.size).toBe(1);
    // Clear Track keeps a seed at the playhead, but removes the old measurement.
    expect(tracks[1].trackedPositions.has(3)).toBe(false);
});

test('deletion releases a track and never reuses its graph identity', () => {
    const {tracking, enable} = load();
    enable();
    const first = tracking.getObjectTracker();
    const second = tracking.addPointTrack();
    const third = tracking.addPointTrack();
    expect(tracking.removePointTrack(second.trackId)).toBe(true);
    expect(tracking.getObjectTracker()).toBe(third);
    expect(tracking.getPointTracks()).toEqual([first, third]);
    const fourth = tracking.addPointTrack();
    expect(new Set([first, second, third, fourth].map(t => t.trackId)).size).toBe(4);
    expect(require('../src/PointTrackFrequencyGraph').removePointTrackFrequencyGraph).toHaveBeenCalledWith(second.trackId);
    tracking.removePointTrack(fourth.trackId);
    expect(tracking.getObjectTracker()).toBe(third);
});

test('selection and deletion cannot redirect an in-progress tracking run', () => {
    const {tracking, enable} = load();
    enable();
    const first = tracking.getObjectTracker(), second = tracking.addPointTrack();
    const {par} = require('../src/par');
    par.playbackLocked = true;
    try {
        expect(tracking.selectPointTrack(first.trackId)).toBeNull();
        expect(tracking.addPointTrack()).toBeNull();
        expect(tracking.removePointTrack(second.trackId)).toBe(false);
        expect(tracking.getObjectTracker()).toBe(second);
    } finally { par.playbackLocked = false; }
});

test('restoring tracks preserves another analysis render hook without drawing tracks twice', async () => {
    const {tracking, videoView, enable} = load();
    enable();
    const saved = tracking.serializeAutoTracking();
    const original = videoView.renderCanvas;
    const otherOverlay = jest.fn();
    videoView.renderCanvas = function(frame) { original.call(this, frame); otherOverlay(); };
    await tracking.deserializeAutoTracking(saved);
    const draw = tracking.getObjectTracker().renderOverlay = jest.fn();
    videoView.renderCanvas(0);
    expect(otherOverlay).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledTimes(1);
});
