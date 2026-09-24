import {CVideoStreamData} from '../src/CVideoStreamData';
import {CVideoWebCodecBase} from '../src/CVideoWebCodecBase';
import {H264Decoder} from '../src/H264Decoder';

jest.mock('../src/CVideoWebCodecBase', () => ({CVideoWebCodecBase: class {
    async waitForFrame(frame) { return !!this.isFrameCached(frame); }
}}));
jest.mock('../src/CVideoMp4Data', () => ({}));
jest.mock('../src/CVideoByteStream', () => ({}));
jest.mock('../src/H264StreamParser', () => ({}));
jest.mock('../src/H264Decoder', () => ({H264Decoder: {
    analyzeH264Stream: jest.fn(), createAVCDecoderConfig: jest.fn(),
    extractNALUnits: jest.fn(() => []), createEncodedVideoChunks: jest.fn(() => []),
}}));
jest.mock('../src/js/mp4-decode/mp4_demuxer', () => ({}));
jest.mock('../src/CStreamingAudio', () => ({}));
jest.mock('../src/Globals', () => ({setRenderOne: jest.fn()}));
jest.mock('../src/CVideoLoadingManager', () => ({VideoLoadingManager: {setStatus: jest.fn()}}));
jest.mock('../src/CLoadingManager', () => ({}));
jest.mock('../src/CEventManager', () => ({EventManager: {dispatchEvent: jest.fn()}}));
jest.mock('../src/UpdateSitFrames', () => ({}));
jest.mock('../src/IndexedDBManager', () => ({}));
jest.mock('../src/quickFetch', () => ({}));

function video() {
    return Object.assign(Object.create(CVideoStreamData.prototype), {
        videoSpeed: 1, disposed: false, streamError: 'Earlier decode failed',
        getGroup: () => ({dataReady: true}), isFrameCached: f => f === 32,
    });
}

test('an earlier stream failure does not hide an exact decoded frame from analysis', async () => {
    const v = video();
    expect(await v.waitForFrame(32)).toBe(true);
    expect(await v.waitForFrame(33)).toBe(false);
    expect(await CVideoWebCodecBase.prototype.waitForFrame.call(v, 32)).toBe(true);
});

test('missing bytes after stream failure and disposed sources fail promptly', async () => {
    const v = video();
    v.getGroup = () => undefined;
    expect(await v.waitForFrame(100)).toBe(false);
    v.disposed = true;
    expect(await v.waitForFrame(32)).toBe(false);
});

test('a late successful initial decode clears only the startup failure', () => {
    const v = video();
    Object.assign(v, {error: true, _loadFailureReported: true, config: {}, bufferedFrames: 30,
        downloadFinished: true, groups: [{frame: 0}], isFrameCached: () => true,
        loadedCallback: jest.fn()});
    v.maybeReady();
    expect(v.loaded).toBe(true);
    expect(v.error).toBe(false);
    expect(v.streamError).toBeNull();
    expect(v.loadedCallback).toHaveBeenCalledTimes(1);
    v.maybeReady();
    expect(v.loadedCallback).toHaveBeenCalledTimes(1);
});

test.each([
    [25, 25], [30000 / 1001, 29.97], [undefined, 30],
    [349525.33, 30], [-30, 30], [Infinity, 30], [NaN, 30],
])('streaming H.264 timing %s uses %s fps for playback and chunk timestamps', async (detected, expected) => {
    H264Decoder.analyzeH264Stream.mockReturnValue({
        hasSPS: true, hasPPS: true, spsData: new Uint8Array([0x67, 0x42, 0xc0, 0x1f]),
        vui: {calculated_fps: detected}, width: 640, height: 480,
    });
    const v = video();
    Object.assign(v, {chunks: [], configureVideo: jest.fn(), publishGroups: jest.fn()});
    await v.appendH264Group(new ArrayBuffer(0));
    expect(v.originalFps).toBe(expected);
    expect(v.detectedFps).toBe(expected);
    expect(H264Decoder.createEncodedVideoChunks).toHaveBeenLastCalledWith(expect.anything(), expected, null, 0);
});
