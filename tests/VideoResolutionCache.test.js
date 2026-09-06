import {CVideoWebCodecBase} from '../src/CVideoWebCodecBase';

jest.mock('../src/Globals', () => ({Globals: {settings: {videoMaxSize: '720P'}}, setRenderOne: jest.fn()}));
jest.mock('../src/CVideoAndAudio', () => ({CVideoAndAudio: class {}}));
jest.mock('../src/utils', () => ({}));
jest.mock('../src/par', () => ({par: {frame: 0}}));
jest.mock('../src/configUtils', () => ({}));
jest.mock('../src/showError', () => ({}));
jest.mock('../src/CVideoDecodeWorker', () => ({VideoDecodeWorkerManager: class {}}));

function video() {
    return Object.assign(Object.create(CVideoWebCodecBase.prototype), {
        imageCache: [], imageDataCache: [], frameCache: [], stabilizedImageCache: ['old'],
        groups: [{loaded: true, pending: 2, decodeOrder: []}], _activeGroupMap: new Map(),
        originalVideoWidth: 1920, originalVideoHeight: 1080, effectiveRotation: 0,
        frameCacheGeneration: 1, stabilizationEnabled: true,
        stabilizationData: new Map([[0, {x: 900, y: 500}]]),
    });
}

test('a resolution change closes decoded frames, cancels the worker, and retains original-coordinate stabilization', () => {
    const v = video();
    const bitmap = {close: jest.fn()};
    const worker = {dispose: jest.fn()};
    v.imageCache[0] = bitmap;
    v._workerManager = worker;
    v._workerConfig = {codec: 'test-codec'};
    v._workerHardwareAcceleration = 'prefer-software';
    v.configureWorker = jest.fn();
    v.decoder = {state: 'configured', reset: jest.fn(), configure: jest.fn()};
    v.config = {codec: 'test-codec'};
    v.onVideoResolutionChanged();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(worker.dispose).toHaveBeenCalledTimes(1);
    expect(v.configureWorker).toHaveBeenCalledWith(v._workerConfig, 'prefer-software');
    expect(v.decoder.reset).toHaveBeenCalledTimes(1);
    expect(v.decoder.configure).toHaveBeenCalledWith(v.config);
    expect(v.imageCache).toEqual([]);
    expect(v.stabilizedImageCache).toEqual([]);
    expect(v.groups[0].loaded).toBe(false);
    expect(v.groups[0].pending).toBe(0);
    expect([v.videoWidth, v.videoHeight]).toEqual([1280, 720]);
    expect(v.stabilizationEnabled).toBe(true);
    expect(v.stabilizationData.get(0)).toEqual({x: 900, y: 500});
});

test('an asynchronous bitmap from before a flush cannot refill the new cache', async () => {
    const v = video();
    let resolveBitmap;
    const originalCreate = global.createImageBitmap;
    global.createImageBitmap = () => new Promise(resolve => { resolveBitmap = resolve; });
    try {
        const bitmap = {width: 1280, height: 720, close: jest.fn()};
        v.processDecodedFrame(0, {close: jest.fn()}, v.groups[0]);
        v.flushEntireCache();
        resolveBitmap(bitmap);
        // Drain the image conversion promise chain.
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(bitmap.close).toHaveBeenCalledTimes(1);
        expect(v.imageCache).toEqual([]);
    } finally {
        global.createImageBitmap = originalCreate;
    }
});
