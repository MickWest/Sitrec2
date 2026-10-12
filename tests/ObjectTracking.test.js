import {ObjectTracker, pointTrackingShift} from '../src/CObjectTracking';
import {NodeMan, Sit} from '../src/Globals';
import {par, resetPar, stopControlledPlayback} from '../src/par';
import {KeyMan} from '../src/KeyBoardHandler';
import {loadOpenCV} from '../src/openCVLoader';
import {getJsfeat} from '../src/jsfeatLoader';

jest.mock('../src/Globals', () => ({
    Globals: {}, Sit: {frames: 20, aFrame: 0, bFrame: 19},
    NodeMan: {get: jest.fn(() => null)}, setRenderOne: jest.fn(),
    unregisterFrameBlocker: jest.fn(),
}));
jest.mock('../src/openCVLoader', () => ({getCV: () => ({}), loadOpenCV: jest.fn()}));
jest.mock('../src/jsfeatLoader', () => ({getJsfeat: jest.fn(() => null), loadJsfeat: jest.fn()}));
jest.mock('../src/CVideoData', () => ({interpolatePosition: (map, f) => map.get(f)}));
jest.mock('../src/CEventManager', () => ({}));
jest.mock('../src/KeyBoardHandler', () => ({KeyMan: {isKeyHeld: jest.fn(), clearAll: jest.fn()}}));
jest.mock('../src/VideoExporter', () => ({}));
jest.mock('../src/utils', () => ({}));
jest.mock('../src/showError', () => ({showError: jest.fn()}));
jest.mock('../src/AttributionOverlay', () => ({}));
jest.mock('../src/configUtils', () => ({isLocal: true}));
jest.mock('../src/i18n', () => ({t: v => v}));
jest.mock('../src/PointTrackFrequencyGraph', () => ({
    addPointTrackFrequencyMenu: jest.fn(),
    getPointTrackFrequencyAperture: jest.fn(() => null),
}));

function makeTracker() {
    const image = {width: 1000, height: 400};
    const videoData = {
        originalVideoWidth: 2000, originalVideoHeight: 1000,
        videoWidth: 1000, videoHeight: 400,
        getImage: () => image, waitForFrame: async () => true,
    };
    const t = new ObjectTracker({videoData});
    Object.assign(t, {enabled: true, tracking: true, trackingMethod: 'motion',
        trackX: 800, trackY: 300});
    return {t, image, videoData};
}

beforeEach(() => {resetPar(); par.paused = true; Sit.bFrame = 19; NodeMan.get.mockReset();});

function pixelTracker(background, pixels) {
    const {t} = makeTracker();
    const image = {width: 200, height: 200};
    t.readROI = (_, x0, y0, w, h) => {
        const rgba = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const color = pixels.get(`${x + x0},${y + y0}`) ?? background;
            rgba.set([...color, 255], (y * w + x) * 4);
        }
        return rgba;
    };
    t.updateSliderStatus = jest.fn();
    t.trackRadius = 30;
    t.searchRadius = 44;
    return {t, image};
}

test.each([
    ['trackBrightCentroid', [50, 50, 50], [210, 210, 210]],
    ['trackDarkCentroid', [220, 220, 220], [40, 40, 40]],
    ['trackColorCentroid', [50, 50, 50], [255, 0, 0]],
])('%s follows one object when a neighbour is inside both circles', (method, background, color) => {
    const pixels = new Map();
    for (const cx of [96, 122]) for (let y = 99; y <= 101; y++) {
        for (let x = cx - 1; x <= cx + 1; x++) pixels.set(`${x},${y}`, color);
    }
    const {t, image} = pixelTracker(background, pixels);
    t[method](1, image, {x: 100, y: 100});
    expect(t.trackedPositions.get(1).x).toBeCloseTo(96, 6);
    expect(t.trackedPositions.get(1).y).toBeCloseTo(100, 6);
});

test('centroid retains weighted diagonal pixels and clips at the image edge', () => {
    const {t, image} = pixelTracker([0, 0, 0], new Map([
        ['0,0', [150, 150, 150]], ['1,1', [200, 200, 200]],
        ['2,2', [250, 250, 250]], ['8,2', [255, 255, 255]],
    ]));
    const point = t.calculateWeightedCentroid(image, 1, 1, 30, (r, g, b) => t._brightWeight(r, g, b));
    expect(point.x).toBeCloseTo((72 + 2 * 122) / (22 + 72 + 122), 6);
    expect(point.y).toBeCloseTo(point.x, 6);
});

test('a dimming centroid target retains identity beside a brighter neighbour', () => {
    const pixels = new Map();
    for (const [cx, cy, value] of [[100, 100, 207], [114, 116, 255]]) {
        for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
            pixels.set(`${x},${y}`, [value, value, value]);
        }
    }
    const {t, image} = pixelTracker([30, 30, 30], pixels);
    t.featureSize = 1;
    t.trackBrightCentroid(1, image, {x: 104, y: 100});
    expect(t.trackedPositions.get(1)).toEqual({x: 100, y: 100});
});

test('masked pixels cannot seed a centroid on a neighbouring object', () => {
    const {t, image} = pixelTracker([0, 0, 0], new Map([
        ['100,100', [255, 255, 255]], ['106,100', [180, 180, 180]],
    ]));
    NodeMan.get.mockReturnValue({maskImageData: {}, maskCanvas: {width: 100, height: 100},
        isPointMasked: (x, y) => x === 50 && y === 50});
    t.trackBrightCentroid(1, image, {x: 100, y: 100});
    expect(t.trackedPositions.get(1)).toEqual({x: 106, y: 100});
});

test('a centroid with no matching pixels records a missing measurement', () => {
    const {t, image} = pixelTracker([60, 60, 60], new Map());
    t.trackX = 100; t.trackY = 100;
    t.trackBrightCentroid(1, image, {x: 100, y: 100});
    expect(t.trackedPositions.has(1)).toBe(false);
    expect(t.trackedPositions.unmeasuredFrames.has(1)).toBe(true);
    expect([t.trackX, t.trackY]).toEqual([100, 100]);
});

test('optical flow too small for corner detection records a missing measurement, not a held point', () => {
    getJsfeat.mockReturnValue({U8_t: 0, C1_t: 0, imgproc: {grayscale: () => {}},
        matrix_t: class { constructor(w, h) { this.data = new Uint8Array(w * h); } }});
    const context = {drawImage: () => {}, getImageData: (x, y, w, h) => ({data: new Uint8ClampedArray(w * h * 4)})};
    global.document = {createElement: () => ({getContext: () => context})};
    try {
        const {t, image} = makeTracker();
        t.updateSliderStatus = jest.fn();
        t.trackRadius = 5;
        t.trackOpticalFlow(1, image, {x: 500, y: 200});
        expect(t.trackedPositions.has(1)).toBe(false);
        expect(t.trackedPositions.unmeasuredFrames.has(1)).toBe(true);
    } finally {
        delete global.document;
        getJsfeat.mockReturnValue(null);
    }
});

test('tracking circles show the source-pixel radii at the current video zoom', () => {
    const {t} = makeTracker();
    t.trackingMethod = 'centerOnBright';
    t.trackRadius = 30; t.searchRadius = 44;
    // A 640px viewport displays a 160px crop of the original 1280px video.
    Object.assign(t.videoView, {dWidth: 640, originalVideoWidth: 1280,
        videoToCanvasCoordsOriginal: (x, y) => [4 * x - 500, 4 * y - 800]});
    const ctx = {setLineDash: jest.fn(), beginPath: jest.fn(), arc: jest.fn(),
        stroke: jest.fn(), moveTo: jest.fn(), lineTo: jest.fn()};
    expect(t.drawTrackingCircles(ctx, 100, 200)).toBe(120);
    expect(ctx.arc.mock.calls.map(args => args.slice(0, 3))).toEqual([
        [100, 200, 176], [100, 200, 120],
    ]);
});

function startTestRun() {
    const result = makeTracker();
    result.t.tracking = false;
    result.t.trackingMethod = 'highPeak';
    result.t.trackFrame = jest.fn(frame => result.t.trackedPositions.set(frame, {x: 800, y: 300}));
    return result;
}

test.each([true, false])('completion leaves the last tracked frame paused (initial paused=%s)', async paused => {
    const {t} = startTestRun();
    par.paused = paused;
    Sit.bFrame = 3;
    t.startTracking();
    expect(par.playbackLocked).toBe(true);
    expect(par.paused).toBe(true);
    await t.trackingPromise;
    expect(t.trackFrame.mock.calls.map(([frame]) => frame)).toEqual([0, 1, 2, 3]);
    expect(par.frame).toBe(3);
    expect(par.paused).toBe(true);
    expect(par.playbackLocked).toBe(false);
    expect(t.tracking).toBe(false);
});

test.each(['button', 'space'])('%s stops at the last tracked frame while the next decode is pending', async stop => {
    const {t, videoData} = startTestRun();
    let releaseDecode, waiting;
    const pending = new Promise(resolve => {waiting = resolve;});
    videoData.waitForFrame = frame => frame < 2 ? Promise.resolve(true) : new Promise(resolve => {
        releaseDecode = resolve;
        waiting();
    });
    par.paused = false;
    t.startTracking();
    await pending;
    expect(par.frame).toBe(2);
    par.frame = 18;
    par.paused = false;
    expect(par.frame).toBe(2);
    expect(par.paused).toBe(true);
    if (stop === 'space') expect(stopControlledPlayback()).toBe(true);
    else t.stopTracking();
    expect(par.frame).toBe(1);
    expect(par.paused).toBe(true);
    expect(par.playbackLocked).toBe(false);
    // The next Space is ordinary playback; the old decode cannot stop it.
    expect(stopControlledPlayback()).toBe(false);
    par.paused = false;
    par.frame = 4;
    releaseDecode(true);
    await t.trackingPromise;
    expect(t.trackedPositions.has(2)).toBe(false);
    expect(par.frame).toBe(4);
    expect(par.paused).toBe(false);
    expect(t.tracking).toBe(false);
});

test('stopping during library loading cannot start tracking later', async () => {
    const {t} = startTestRun();
    t.trackingMethod = 'motion';
    let loaded;
    loadOpenCV.mockImplementationOnce(() => new Promise(resolve => {loaded = resolve;}));
    t.startTracking();
    expect(par.playbackLocked).toBe(true);
    stopControlledPlayback();
    par.paused = false;
    loaded();
    await t.trackingPromise;
    expect(t.trackFrame).not.toHaveBeenCalled();
    expect(t.tracking).toBe(false);
    expect(par.playbackLocked).toBe(false);
    expect(par.paused).toBe(false);
});

test('completion returns to the last result when final frames cannot be decoded', async () => {
    const {t, videoData} = startTestRun();
    Sit.bFrame = 4;
    videoData.waitForFrame = async frame => frame < 3;
    t.startTracking();
    await t.trackingPromise;
    expect(par.frame).toBe(2);
    expect(par.paused).toBe(true);
    expect(par.playbackLocked).toBe(false);
});

test('a failed tracking run releases playback at its last result', async () => {
    const {t, videoData} = startTestRun();
    videoData.waitForFrame = async frame => {
        if (frame === 2) throw new Error('decode failed');
        return true;
    };
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
        t.startTracking();
        await t.trackingPromise;
        expect(par.playbackLocked).toBe(false);
        expect(par.frame).toBe(1);
        expect(par.paused).toBe(true);
        expect(t.analysisResolutionSession).toBeNull();
    } finally { log.mockRestore(); }
});

test('a stopped server tracking request cannot resume after its response arrives', async () => {
    const {t} = startTestRun();
    t.trackingMethod = 'sam2';
    t.videoView.videoData.videoDroppedData = new ArrayBuffer(1);
    const originalFetch = globalThis.fetch;
    let respond;
    globalThis.fetch = jest.fn(() => new Promise(resolve => {respond = resolve;}));
    try {
        t.startTracking();
        expect(par.playbackLocked).toBe(true);
        stopControlledPlayback();
        par.paused = false;
        respond({ok: true});
        await t.trackingPromise;
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(t.tracking).toBe(false);
        expect(par.playbackLocked).toBe(false);
        expect(par.paused).toBe(false);
        expect(t.trackedPositions.size).toBe(0);
    } finally { globalThis.fetch = originalFetch; }
});

test.each([false, true])('a user point resets the search even with force=%s', force => {
    const {t} = makeTracker();
    t.motionAnchors = [{frame: 2, x: 10, y: 10}, {frame: 3, x: 30, y: 20}];
    t.motionMisses = 22;
    t.motionCandidate = {frame: 3, x: 30, y: 20};
    t.trackedPositions.set(4, {x: 1000, y: 600});
    t.manualKeyframes.add(4);
    t.trackFrame(4, force);
    expect(t.trackedPositions.get(4)).toEqual({x: 1000, y: 600});
    expect(t.motionAnchors).toEqual([{frame: 4, x: 500, y: 240}]);
    expect(t.motionLastFrame).toBe(4);
    expect(t.motionMisses).toBe(0);
    expect(t.motionCandidate).toBeNull();
});

test.each(['template', 'highPeak', 'centerOnBright'])('%s preserves forced user points', method => {
    const {t} = makeTracker();
    t.trackingMethod = method;
    t.manualKeyframes.add(4);
    t.trackedPositions.set(4, {x: 1000, y: 600});
    t.runAlgorithm = jest.fn();
    t.trackFrame(4, true);
    expect(t.runAlgorithm).not.toHaveBeenCalled();
    expect([t.trackX, t.trackY]).toEqual([1000, 600]);
});

test('initialization does not replace a user point with a stale cursor', () => {
    const {t} = makeTracker();
    t.manualKeyframes.add(0);
    t.trackedPositions.set(0, {x: 900, y: 500});
    t.initializeTracker();
    expect(t.trackedPositions.get(0)).toEqual({x: 900, y: 500});
    expect([t.trackX, t.trackY]).toEqual([900, 500]);
});

test('waiting for background frames never magnifies a reduced-resolution cursor', () => {
    const {t, image} = makeTracker();
    for (let f = 0; f < 4; f++) {
        t.runAlgorithm(f, image, {x: t.trackX, y: t.trackY}, () => {
            t.trackedPositions.set(f, {x: t.trackX, y: t.trackY});
        });
        expect(t.trackedPositions.get(f)).toEqual({x: 800, y: 300});
    }
});

test('a user point on a held frame survives the full-speed loop and re-anchors', async () => {
    const {t, videoData} = makeTracker();
    par.frame = 1; Sit.bFrame = 1;
    videoData.isHeldFrame = () => true;
    t.trackedPositions.set(0, {x: 800, y: 300});
    t.trackedPositions.set(1, {x: 900, y: 500});
    t.manualKeyframes.add(1);
    await t.runFastTrackingLoop();
    expect(t.trackedPositions.get(1)).toEqual({x: 900, y: 500});
    expect(t.motionAnchors).toEqual([{frame: 1, x: 450, y: 200}]);
});

test('stopping while decoding prevents one final unwanted tracking write', async () => {
    const {t, videoData} = makeTracker();
    Sit.bFrame = 0;
    videoData.waitForFrame = async () => {t.tracking = false;};
    t.trackFrame = jest.fn();
    await t.runFastTrackingLoop();
    expect(t.trackFrame).not.toHaveBeenCalled();
});

test('a decode timeout never measures the playback fallback frame', async () => {
    const {t, videoData} = makeTracker();
    Sit.bFrame = 0;
    videoData.waitForFrame = async () => false;
    t.trackFrame = jest.fn();
    await t.runFastTrackingLoop();
    expect(t.trackFrame).not.toHaveBeenCalled();
});

test('an old decode wait cannot write into or stop a restarted run', async () => {
    const {t, videoData} = makeTracker();
    Sit.bFrame = 0;
    t.trackingRunId = 1;
    videoData.waitForFrame = async () => {t.trackingRunId = 2; return true;};
    t.trackFrame = jest.fn();
    t.onTrackingComplete = jest.fn();
    await t.runFastTrackingLoop();
    expect(t.trackFrame).not.toHaveBeenCalled();
    expect(t.onTrackingComplete).not.toHaveBeenCalled();
    expect(t.tracking).toBe(true);
});

test('a tracking exception releases the analysis session', async () => {
    const {t} = makeTracker();
    Sit.bFrame = 0;
    const end = jest.fn();
    t.analysisResolutionSession = {end};
    t.trackFrame = () => {throw new Error('bad frame');};
    await expect(t.runFastTrackingLoop()).rejects.toThrow('bad frame');
    expect(end).toHaveBeenCalledTimes(1);
    expect(t.tracking).toBe(false);
});

test('releasing the tracking key during library loading does not write points', async () => {
    const {t} = makeTracker();
    let loaded;
    loadOpenCV.mockImplementationOnce(() => new Promise(resolve => { loaded = resolve; }));
    KeyMan.isKeyHeld.mockReturnValue(false);
    t.tracking = false;
    t.holdLoopActive = true;
    const running = t.runHoldLoop('forward');
    loaded();
    await running;
    expect(t.trackedPositions.size).toBe(0);
    expect(t.holdLoopActive).toBe(false);
    expect(t.analysisResolutionSession).toBeNull();
});

test('render-time tracking waits for the exact frame too', () => {
    const {t, videoData} = makeTracker();
    videoData.isFrameLoaded = () => false;
    t.trackedPositions.set(0, {x: 800, y: 300});
    t.runAlgorithm = jest.fn();
    t.trackFrame(1);
    expect(t.runAlgorithm).not.toHaveBeenCalled();
});

test('redrawing a measured frame preserves motion history, skipping a saved span resets it', () => {
    const {t} = makeTracker();
    t.trackedPositions.set(4, {x: 800, y: 300});
    t.motionLastFrame = 4;
    t.motionAnchors = [{frame: 3, x: 380, y: 120}, {frame: 4, x: 400, y: 120}];
    t.trackFrame(4);
    expect(t.motionLastFrame).toBe(4);
    expect(t.motionAnchors.length).toBe(2);
    t.trackedPositions.set(5, {x: 820, y: 300});
    t.trackFrame(5);
    expect(t.motionLastFrame).toBeNull();
});

test('Analyse Object suggests distinct alternative sizes, excluding the winner', async () => {
    const {t} = makeTracker();
    t.motionTracker = {measure: (_, f, x, y, opts) => ({score: 30 / Math.sqrt(opts.featureScale)})};
    const result = await t.analyseObject();
    expect(result.featureScale).toBe(1);
    expect(result.alternatives).toEqual(['size 2 at 21']);
});

test('Analyse Object stays near the selected target despite a large Track Radius', async () => {
    const {t} = makeTracker();
    t.trackRadius = 100;
    t.motionTracker = {measure: (_, f, x, y, opts) => ({score:
        opts.polarity === 'dark' ? 16 / opts.featureScale : (opts.gate > 8 ? 20 : 8) / opts.featureScale})};
    const result = await t.analyseObject();
    expect(result.polarity).toBe('dark');
    expect(result.featureScale).toBe(1);
});

test('Analyse Object cannot calibrate on the playback fallback image', async () => {
    const {t, videoData} = makeTracker();
    videoData.isFrameLoaded = () => false;
    t.motionTracker = {measure: jest.fn()};
    const result = await t.analyseObject();
    expect(result.error).toMatch('not decoded');
    expect(t.motionTracker.measure).not.toHaveBeenCalled();
});

test('calibration retries closer background samples when a fast pan removes overlap', async () => {
    const {t, videoData} = makeTracker();
    videoData.waitForFrame = jest.fn(async () => true);
    t.motionTracker = {measure: (_, f, x, y, opts) => opts.gap > 1 ? null :
        {score: opts.polarity === 'dark' ? 20 / opts.featureScale : 3}};
    const result = await t.analyseObject();
    expect(result).toMatchObject({gap: 1, polarity: 'dark', featureScale: 1});
    expect(t.motionGap).toBe(1);
    expect(videoData.waitForFrame).toHaveBeenCalledWith(1, 4000);
    expect(videoData.waitForFrame).toHaveBeenCalledWith(2, 4000);
});

test('smoothed output responds to edits while raw positions and user points stay exact', () => {
    const {t} = makeTracker();
    t.trackedPositions = new Map([[0, {x: 0, y: 0}], [1, {x: 1, y: 12}], [2, {x: 2, y: 0}]]);
    t.smoothingFrames = 3;
    expect(t.getInterpolatedPosition(1).y).toBe(4);
    expect(t.getRawInterpolatedPosition(1).y).toBe(12);
    t.trackedPositions.set(1, {x: 1, y: 6});
    expect(t.getInterpolatedPosition(1).y).toBe(2);
    t.manualKeyframes.add(1);
    expect(t.getInterpolatedPosition(1).y).toBe(6);
    t.smoothingFrames = 0;
    expect(t.getOutputPositions()).toBe(t.trackedPositions);
});

test('a smoothed display cursor cannot overwrite the raw seed when tracking restarts', () => {
    const {t} = makeTracker();
    t.trackedPositions.set(0, {x: 900, y: 500});
    t.trackX = 890; t.trackY = 490;
    t.initializeTracker();
    expect(t.trackedPositions.get(0)).toEqual({x: 900, y: 500});
});

test('stabilized exports scale source points into the actual decoded frame', () => {
    const vd = {originalVideoWidth: 1920, originalVideoHeight: 1080, videoWidth: 1280, videoHeight: 720};
    const ref = {x: 960, y: 540}, point = {x: 1050, y: 600};
    expect(pointTrackingShift(vd, point, ref)).toEqual({x: -60, y: -40});
    vd.stabilizeCenters = true;
    expect(pointTrackingShift(vd, point, ref)).toEqual({x: -60, y: -40});
    expect(pointTrackingShift(vd, point, ref, 1920, 1080)).toEqual({x: -90, y: -60});
});

test('a missing measurement is not manufactured by the coordinate wrapper', () => {
    const {t, image} = makeTracker();
    t.runAlgorithm(3, image, {x: 800, y: 300}, () => t.trackedPositions.markUnmeasured(3));
    expect(t.trackedPositions.has(3)).toBe(false);
    expect(t.trackedPositions.unmeasuredFrames.has(3)).toBe(true);
    expect([t.trackX, t.trackY]).toEqual([800, 300]);
});

test('redrawing a missing frame does not rerun tracking or reset its loss state', () => {
    const {t} = makeTracker();
    t.motionLastFrame = 4;
    t.motionOffscreen = true;
    t.trackedPositions.markUnmeasured(4);
    t.runAlgorithm = jest.fn();
    t.trackFrame(4);
    expect(t.runAlgorithm).not.toHaveBeenCalled();
    expect(t.motionOffscreen).toBe(true);
});

test('timeline distinguishes estimates from detections and user observations', () => {
    const {t} = makeTracker();
    t.trackedPositions.set(1, {x: 10, y: 20});
    t.trackedPositions.set(2, {x: 11, y: 20, estimated: 'background'});
    t.trackedPositions.markUnmeasured(3);
    t.trackedPositions.set(4, {x: 12, y: 20, estimated: 'linear'});
    t.manualKeyframes.add(4);
    expect(t.getCacheStatusArray().slice(1, 5)).toEqual([1, 3, 0, 2]);
});

test('an off-screen return must be confirmed before camera estimates fill the gap', async () => {
    const {t} = makeTracker();
    // Initialise the same module-local CV handle used by Start/Analyse Object.
    t.motionTracker = {measure: () => ({score: 30})};
    await t.analyseObject();
    let returned = false;
    t.motionTracker = {
        reset: jest.fn(), recordCameraMotion: jest.fn(),
        measure: jest.fn(() => ({x: 20, y: 200, score: 30, second: 2})),
        cameraPath: {
            predict: () => ({x: returned ? 20 : -500, y: 200}),
            reconstruct: () => new Map(Array.from({length: 14}, (_, i) => [10 + i, {x: -20, y: 200}])),
        },
    };
    Object.assign(t, {motionLastFrame: 9, motionOffscreen: true, motionMisses: 30,
        motionAnchors: [{frame: 8, x: 15, y: 200}, {frame: 9, x: 10, y: 200}]});
    t.trackedPositions.set(9, {x: 20, y: 500});
    t.trackFrame(14);
    expect(t.motionTracker.measure).not.toHaveBeenCalled();
    expect(t.trackedPositions.has(14)).toBe(false);
    returned = true;
    t.trackFrame(19);
    expect(t.trackedPositions.has(19)).toBe(false);
    t.trackedPositions.set(17, {x: 7, y: 8}); t.manualKeyframes.add(17);
    t.trackFrame(24);
    expect(t.trackedPositions.get(14)).toEqual({x: -40, y: 500, estimated: 'background'});
    expect(t.trackedPositions.get(17)).toEqual({x: 7, y: 8});
    expect(t.trackedPositions.get(24)).toEqual({x: 40, y: 500});
    expect(t.motionOffscreen).toBe(false);
});

test('a distant off-screen prediction cannot prevent a periodic whole-image search', async () => {
    const {t} = makeTracker();
    t.motionTracker = {measure: () => ({score: 30})};
    await t.analyseObject();
    t.motionTracker = {
        reset: jest.fn(), recordCameraMotion: jest.fn(), measure: jest.fn(() => null),
        cameraPath: {predict: () => ({x: -100000, y: 200}), transport: p => p},
    };
    Object.assign(t, {motionLastFrame: 38, motionOffscreen: true, motionMisses: 30,
        motionAnchors: [{frame: 8, x: 15, y: 200}, {frame: 9, x: 10, y: 200}]});
    t.trackFrame(39);
    expect(t.motionTracker.measure).toHaveBeenCalledWith(expect.anything(), 39, 500, 200,
        expect.objectContaining({gate: Math.hypot(1000, 400), requireAppearance: true, maxCandidates: 12}));
    expect(t.trackedPositions.has(39)).toBe(false);
    expect(t.trackedPositions.unmeasuredFrames.has(39)).toBe(true);
});

test('a bad prediction from the image interior does not claim an observed screen exit', async () => {
    const {t} = makeTracker();
    t.motionTracker = {measure: () => ({score: 30})};
    await t.analyseObject();
    t.motionTracker = {
        reset: jest.fn(), recordCameraMotion: jest.fn(), measure: () => null,
        cameraPath: {predict: () => ({x: -1000, y: 200})},
    };
    Object.assign(t, {motionLastFrame: 9, motionAnchors: [{frame: 9, x: 500, y: 200}]});
    t.trackFrame(10);
    expect(t.motionOffscreen).toBe(false);
    expect(t.trackedPositions.has(10)).toBe(false);
});

test('an inaccurate background prediction cannot reject continued observed target motion', async () => {
    const {t} = makeTracker();
    t.motionTracker = {measure: () => ({score: 30})};
    await t.analyseObject();
    t.motionTracker = {
        reset: jest.fn(), recordCameraMotion: jest.fn(),
        measure: () => ({x: 501, y: 200, score: 30, second: 2}),
        cameraPath: {predict: () => ({x: 480, y: 200})},
    };
    Object.assign(t, {motionLastFrame: 9, motionAnchors: [{frame: 9, x: 500, y: 200}]});
    t.trackFrame(10);
    expect(t.trackedPositions.get(10)).toEqual({x: 1002, y: 500});
    expect(t.motionMisses).toBe(0);
});

test('a brief tower occlusion cannot import background-registration spikes into the track', async () => {
    const {t} = makeTracker();
    t.motionTracker = {measure: () => ({score: 30})};
    await t.analyseObject();
    t.motionTracker = {
        reset: jest.fn(), recordCameraMotion: jest.fn(),
        measure: () => ({x: 503, y: 200, score: 30, second: 2}),
        cameraPath: {predict: () => ({x: 480, y: 200}),
            reconstruct: jest.fn(() => new Map([[10, {x: 470, y: 200}], [11, {x: 520, y: 200}]]))},
    };
    Object.assign(t, {motionLastFrame: 11, motionMisses: 2,
        motionAnchors: [{frame: 8, x: 499, y: 200}, {frame: 9, x: 500, y: 200}]});
    t.trackedPositions.markUnmeasured(10); t.trackedPositions.markUnmeasured(11);
    t.trackFrame(12);
    expect(t.motionTracker.cameraPath.reconstruct).not.toHaveBeenCalled();
    expect(t.trackedPositions.get(10)).toEqual({x: 1002, y: 500, estimated: 'linear'});
    expect(t.trackedPositions.get(11)).toEqual({x: 1004, y: 500, estimated: 'linear'});
});

test('a weak camera-centered search also checks the continuing image trajectory', async () => {
    const {t} = makeTracker();
    t.motionTracker = {measure: () => ({score: 30})};
    await t.analyseObject();
    const measure = jest.fn((video, frame, x) => x < 550
        ? {x: 501, y: 200, score: 30, second: 2}
        : {x: 610, y: 200, score: 8, second: 7});
    t.motionTracker = {reset: jest.fn(), recordCameraMotion: jest.fn(), measure,
        cameraPath: {predict: () => ({x: 600, y: 200})}};
    Object.assign(t, {motionLastFrame: 9, motionAnchors: [{frame: 9, x: 500, y: 200}]});
    t.trackFrame(10);
    expect(measure.mock.calls.map(args => args[2])).toEqual([600, 500]);
    expect(t.trackedPositions.get(10)).toEqual({x: 1002, y: 500});
});

test("the peak prediction uses measured points only, so it cannot run away", () => {
    const {t} = makeTracker();
    t.trackedPositions.clear();
    for (let f = 0; f <= 10; f++) t.trackedPositions.set(f, {x: 100 + 2 * f, y: 50});
    // An estimated point far ahead must not steer the prediction.
    t.trackedPositions.set(11, {x: 900, y: 50, estimated: 'linear'});
    const p = t.predictPosition(12);
    expect(p.x).toBeCloseTo(124, 5);          // 120 + 2 px/frame x 2 frames, from measured points
    expect(p.y).toBeCloseTo(50, 5);
});

test("after a gap the peak search restarts where the object was last seen", () => {
    const {t} = makeTracker();
    t.trackedPositions.clear();
    for (let f = 0; f <= 10; f++) t.trackedPositions.set(f, {x: 100 + 5 * f, y: 50});
    expect(t.predictPosition(15).x).toBeCloseTo(175, 5);     // short coast keeps the velocity
    expect(t.predictPosition(40)).toEqual({x: 150, y: 50});    // long loss: last seen, no velocity
    // Beyond the look-back window the search still continues from the last sighting.
    expect(t.predictPosition(300)).toEqual({x: 150, y: 50});
});

test("one wrong measurement next to the latest does not set the search direction", () => {
    const {t} = makeTracker();
    t.trackedPositions.clear();
    for (let f = 0; f <= 9; f++) t.trackedPositions.set(f, {x: 100, y: 50});
    t.trackedPositions.set(10, {x: 100, y: 84});   // one bad frame, 34 px off
    // Velocity is taken over about five frames, so the prediction moves 34/5 per frame, not 34.
    expect(t.predictPosition(11).y).toBeCloseTo(84 + 34 / 5, 5);
});
