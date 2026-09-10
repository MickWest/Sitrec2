import MP4Box from '../src/js/mp4box.all';
import {MP4Source} from '../src/js/mp4-decode/mp4_demuxer';
import {CVideoStreamData} from '../src/CVideoStreamData';
import {indexedDBManager} from '../src/IndexedDBManager';

jest.mock('../src/CVideoWebCodecBase', () => ({CVideoWebCodecBase: class {
    constructor(v, loadedCallback, errorCallback) {
        Object.assign(this, {chunks: [], groups: [], videoSpeed: 1, loadedCallback, errorCallback});
    }
    buildTimestampMap() { this.framePTSus = this.chunks.map(chunk => chunk.timestamp); }
    isFrameCached() { return true; }
    initializeAudioHandler() {
        this.audioHandler = {initializeAudio: demuxer => demuxer.getAudioConfig()};
    }
}}));
jest.mock('../src/CVideoMp4Data', () => ({getRotationAngleFromVideoMatrix: () => 0}));
jest.mock('../src/ExtractMetadata', () => ({extractAllMetaData: () => null}));
jest.mock('../src/Globals', () => ({setRenderOne: jest.fn()}));
jest.mock('../src/CVideoLoadingManager', () => ({VideoLoadingManager: {setStatus: jest.fn()}}));
jest.mock('../src/CLoadingManager', () => ({LoadingManager: {
    registerLoading: jest.fn(), updateProgress: jest.fn(), completeLoading: jest.fn(),
}}));
jest.mock('../src/CEventManager', () => ({EventManager: {dispatchEvent: jest.fn()}}));
jest.mock('../src/UpdateSitFrames', () => ({}));
jest.mock('../src/IndexedDBManager', () => ({indexedDBManager: {
    getCachedData: jest.fn(), cacheData: jest.fn().mockResolvedValue(),
}}));
jest.mock('../src/quickFetch', () => ({}));

// Real fragmented container/sample tables; only browser decoding is stubbed.
function fragmentedVideo(sampleSize = 5) {
    const file = MP4Box.createFile();
    const id = file.addTrack({type: 'avc1', timescale: 1000, width: 16, height: 16,
        avcDecoderConfigRecord: new Uint8Array([
            1, 66, 0, 30, 255, 225, 0, 4, 0x67, 0x42, 0, 0x1e, 1, 0, 2, 0x68, 0xce,
        ]).buffer});
    file.moov.mvex.add('mehd').set('fragment_duration', 320);
    const ends = [file.getBuffer().byteLength];
    for (let i = 0; i < 8; i++) {
        const data = new Uint8Array(sampleSize);
        new DataView(data.buffer).setUint32(0, sampleSize - 4);
        data[4] = 0x65;
        file.addSample(id, data, {duration: 40, dts: i * 40, cts: i * 40, is_sync: true});
        ends.push(file.getBuffer().byteLength);
    }
    return {buffer: file.getBuffer(), ends};
}

const originalFetch = global.fetch;
const originalChunk = global.EncodedVideoChunk;
beforeEach(() => {
    jest.clearAllMocks();
    indexedDBManager.getCachedData.mockResolvedValue(undefined);
    global.EncodedVideoChunk = class { constructor(chunk) { Object.assign(this, chunk); } };
    jest.spyOn(CVideoStreamData.prototype, 'configureVideo').mockImplementation(async function(config) {
        this.config = config;
    });
});
afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    global.EncodedVideoChunk = originalChunk;
});

test.each([0, 2, 8])('fragmented download finalizes all samples when onReady sees %i frames', async firstFrames => {
    const {buffer, ends} = fragmentedVideo();
    let video;
    const partialStates = [];
    global.fetch = jest.fn().mockResolvedValue(new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(buffer.slice(0, ends[firstFrames])));
        },
        pull(controller) {
            // Response streams may prefetch, so observe the parser from the
            // onChunk boundary below, not from the transport's pull callback.
            controller.enqueue(new Uint8Array(buffer.slice(ends[firstFrames])));
            controller.close();
        },
    }), {headers: {'content-length': String(buffer.byteLength)}}));
    const receive = CVideoStreamData.prototype.receiveBytes;
    jest.spyOn(CVideoStreamData.prototype, 'receiveBytes').mockImplementation(async function(...args) {
        await receive.apply(this, args);
        partialStates.push({frames: this.frames, headerFrames: this.mp4.totalFrames,
            completeTimeline: this.completeFramePTSus, loaded: this.loaded});
    });
    const loaded = jest.fn(), failed = jest.fn();
    video = new CVideoStreamData({file: 'https://example.com/video.mp4', id: 'video', streamFrames: 8}, loaded, failed);
    await video.downloadComplete;

    expect(partialStates[0]).toEqual({frames: 8, headerFrames: firstFrames,
        completeTimeline: undefined, loaded: undefined});
    expect(failed).not.toHaveBeenCalled();
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(video.downloadFinished).toBe(true);
    expect(video.frames).toBe(8);
    expect(video.chunks).toHaveLength(8);
    expect(video.bufferedFrames).toBe(8);
    expect(video.originalFps).toBe(25);
    expect(video.mp4.durationInSeconds).toBeCloseTo(0.32);
    expect(video.mp4.info.videoTracks[0].nb_samples).toBe(8);
    expect(video.framePTSus).toEqual(Array.from({length: 8}, (_, i) => i * 40000));
    expect(indexedDBManager.cacheData).toHaveBeenCalledTimes(1);
});

test('cached fragmented files also refresh metadata across one-megabyte reads', async () => {
    const {buffer} = fragmentedVideo(350000);
    indexedDBManager.getCachedData.mockResolvedValue(buffer);
    global.fetch = jest.fn();
    const failed = jest.fn();
    const video = new CVideoStreamData({file: 'video.mp4', id: 'video', streamFrames: 8}, jest.fn(), failed);
    await video.downloadComplete;
    expect(global.fetch).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(video.loaded).toBe(true);
    expect(video.frames).toBe(8);
    expect(video.chunks).toHaveLength(8);
    expect(video.originalFps).toBe(25);
});

test('a missing final sample still fails validation and is never cached', async () => {
    const {buffer} = fragmentedVideo();
    indexedDBManager.getCachedData.mockResolvedValue(buffer.slice(0, -1));
    const failed = jest.fn(), loaded = jest.fn();
    const video = new CVideoStreamData({file: 'video.mp4', id: 'video', streamFrames: 8}, loaded, failed);
    await video.downloadComplete;
    expect(video.streamError).toBe('Video ended before all frames could be read');
    expect(video.downloadFinished).toBe(false);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(loaded).not.toHaveBeenCalled();
    expect(indexedDBManager.cacheData).not.toHaveBeenCalled();
});

test('ordinary MP4 timing retains the declared movie duration', () => {
    const source = new MP4Source();
    source.updateTiming({isFragmented: false, tracks: [{type: 'video', nb_samples: 60,
        movie_duration: 2000, movie_timescale: 1000, samples_duration: 180000, timescale: 90000}]});
    expect(source.totalFrames).toBe(60);
    expect(source.durationInSeconds).toBe(2);
    expect(source.fps).toBe(30);
});
