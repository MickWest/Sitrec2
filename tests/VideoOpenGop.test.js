import {CVideoWebCodecBase} from '../src/CVideoWebCodecBase';

jest.mock('../src/Globals', () => ({Globals: {settings: {}}, Sit: {videoFrames: 21}, setRenderOne: jest.fn()}));
jest.mock('../src/CVideoAndAudio', () => ({CVideoAndAudio: class {}}));
jest.mock('../src/utils', () => ({}));
jest.mock('../src/par', () => ({par: {frame: 0}}));
jest.mock('../src/configUtils', () => ({}));
jest.mock('../src/showError', () => ({}));
jest.mock('../src/CVideoDecodeWorker', () => ({VideoDecodeWorkerManager: class {}}));

// Open-GOP stream in decode order, as timestamps. Each later keyframe is
// followed by three B-frames that display before it and reference the
// previous group. Display frames: group 0 = 0-7, group 1 = 8-15, group 2 = 16-20.
const DECODE_ORDER = [
    [0, 3, 1, 2, 7, 4, 5, 6],
    [11, 8, 9, 10, 15, 12, 13, 14],
    [19, 16, 17, 18, 20],
];

function video() {
    const v = Object.assign(Object.create(CVideoWebCodecBase.prototype), {
        imageCache: [], imageDataCache: [], frameCache: [], chunks: [], groups: [],
        _activeGroupMap: new Map(), groupsPending: 0, requestQueue: [], nextRequest: null,
        flushing: false, isAudioActive: () => false, videoSpeed: 1,
    });
    for (const timestamps of DECODE_ORDER) {
        v.groups.push({frame: v.chunks.length, length: timestamps.length, pending: 0, loaded: false,
            timestamp: timestamps[0]});
        for (const timestamp of timestamps) {
            v.chunks.push({timestamp, type: v.chunks.length === v.groups.at(-1).frame ? 'key' : 'delta',
                byteLength: 1, copyTo: () => {}});
        }
    }
    v.buildTimestampMap();
    return v;
}

// Jest's environment has no ImageBitmap; the purge closes only ImageBitmaps.
global.ImageBitmap ??= class ImageBitmap {};

function fillCache(v) {
    for (let i = 0; i < v.chunks.length; i++) {
        v.imageCache[i] = Object.assign(new ImageBitmap(), {width: 1, close: jest.fn()});
    }
    for (const group of v.groups) group.loaded = true;
}

test('a leading frame belongs to the previous group, whose decode produces it', () => {
    const v = video();
    const [g0, g1, g2] = v.groups;
    expect([g0.leadingFrames, g1.leadingFrames, g2.leadingFrames]).toEqual([0, 3, 3]);
    expect([8, 9, 10].map(f => v.getDecodeGroup(f))).toEqual([g0, g0, g0]);
    expect(v.getDecodeGroup(11)).toBe(g1);
    expect(v.getDecodeGroup(18)).toBe(g1);
    expect(v.getDecodeGroup(19)).toBe(g2);
    expect(v.getGroupDisplayRange(g0)).toEqual([0, 11]);
    expect(v.getGroupDisplayRange(g1)).toEqual([11, 19]);
    expect(v.getGroupDisplayRange(g2)).toEqual([19, 21]);
});

test('purging a group keeps the leading frames its predecessor decoded', () => {
    const v = video();
    fillCache(v);
    const [g0, g1] = v.groups;
    v.purgeGroupsExcept(new Set([g0]));
    // The bug: these frames were cleared with group 1, but group 0 stayed
    // loaded, so no request could decode them again and playback waited forever.
    for (const f of [8, 9, 10]) expect(v.isFrameCached(f)).toBeTruthy();
    expect(v.isFrameCached(11)).toBeFalsy();
    expect(g1.loaded).toBe(false);

    // Purging group 0 releases them, and a request for one reaches group 0.
    v.purgeGroupsExcept(new Set());
    expect(v.isFrameCached(8)).toBeFalsy();
    v.requestGroup = jest.fn();
    v.requestFrame(8);
    expect(v.requestGroup).toHaveBeenCalledWith(g0);
});

test('a frame wait ends at once when its group has failed for good', async () => {
    const v = video();
    Object.assign(v, {config: {}, requestGroup: jest.fn()});
    v.groups[1]._permanentlyFailed = true;
    const started = Date.now();
    expect(await v.waitForFrame(12, 5000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    // A leading frame waits on the group that decodes it.
    v.groups[0].loaded = true;
    v.imageCache[9] = Object.assign(new ImageBitmap(), {width: 1});
    expect(await v.waitForFrame(9, 5000)).toBe(true);
});

test('a decode expects only the frames it can output', () => {
    const v = video();
    v._workerManager = {configured: true, busy: false, decodeGroup: jest.fn(() => true)};
    const expected = [];
    for (const group of v.groups) {
        v._requestGroupViaWorker(group);
        expected.push(group._expectedLength);
        v.flushing = false;
    }
    v._clearAllDecodeTimers();
    // Own frames less leading frames, plus the next group's leading frames
    // and its keyframe, which the decode needs as a reference.
    expect(expected).toEqual([8 + 3 + 1, 5 + 3 + 1, 2]);
});
