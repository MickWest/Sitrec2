// Camera Motion (Background) localStorage cache key (src/CameraMotionFromVideo.js).
//
// The key was the file name alone, and every unnamed video shared "cameraMotion:video", so a
// different video with the same name, or a re-encode, silently loaded the wrong motion. The key
// now adds the frame count and (MP4 only) the video-track byte size.

jest.mock('../src/Globals', () => ({
    Globals: {}, Sit: {}, guiMenus: {},
    NodeMan: {get: jest.fn(() => null)}, setRenderOne: jest.fn(),
}));
jest.mock('../src/par', () => ({par: {}}));
jest.mock('../src/openCVLoader', () => ({loadOpenCV: jest.fn(), getCV: jest.fn()}));
jest.mock('../src/VideoAnalysisResolution', () => ({
    addVideoAnalysisResolutionMenu: jest.fn(), beginVideoAnalysis: jest.fn(),
}));
jest.mock('../src/nodes/CNodeCameraMotionTrack', () => ({CNodeCameraMotionTrack: class {}}));
jest.mock('../src/nodes/CNodeControllerCameraMotionOrientation', () => ({
    CNodeControllerCameraMotionOrientation: class {},
}));
jest.mock('../src/nodes/CNodeDisplayTrack', () => ({CNodeDisplayTrack: class {}}));
jest.mock('../src/SphericalMath', () => ({altitudeHAE: jest.fn(), getLocalUpVector: jest.fn()}));
jest.mock('../src/threeUtils', () => ({V3: jest.fn()}));

import {
    cameraMotionCacheKey,
    legacyCameraMotionCacheKey,
    readCameraMotionCache,
    writeCameraMotionCache,
} from '../src/CameraMotionFromVideo';

function fakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        getItem: jest.fn(k => (map.has(k) ? map.get(k) : null)),
        setItem: jest.fn((k, v) => { map.set(k, String(v)); }),
        removeItem: jest.fn(k => { map.delete(k); }),
        get length() { return map.size; },
        key: i => [...map.keys()][i] ?? null,
        keys: () => [...map.keys()].sort(),
    };
}

describe('cameraMotionCacheKey', () => {
    test('adds the frame count and byte size to the name', () => {
        expect(cameraMotionCacheKey('clip.mp4', 300, 123456)).toBe('cameraMotion:clip.mp4|frames=300|bytes=123456');
    });

    test('omits the byte size when it is not known', () => {
        expect(cameraMotionCacheKey('clip.mp4', 300, undefined)).toBe('cameraMotion:clip.mp4|frames=300');
        expect(cameraMotionCacheKey('clip.mp4', 300, 0)).toBe('cameraMotion:clip.mp4|frames=300');
    });

    test('is null when the frame count is not known', () => {
        for (const frames of [undefined, null, 0, NaN, 12.5, -3]) {
            expect(cameraMotionCacheKey('clip.mp4', frames, 123456)).toBeNull();
        }
    });

    test('two videos with the same name get different keys', () => {
        const a = cameraMotionCacheKey('video', 300, 1000);
        expect(cameraMotionCacheKey('video', 301, 1000)).not.toBe(a);   // different length
        expect(cameraMotionCacheKey('video', 300, 1001)).not.toBe(a);   // re-encode, same length
        expect(cameraMotionCacheKey('video', 300, undefined)).not.toBe(a);
    });

    test('never equals the legacy name-only key', () => {
        expect(legacyCameraMotionCacheKey('clip.mp4')).toBe('cameraMotion:clip.mp4');
        expect(cameraMotionCacheKey('clip.mp4', 300)).not.toBe(legacyCameraMotionCacheKey('clip.mp4'));
    });
});

describe('writeCameraMotionCache / readCameraMotionCache', () => {
    const video = {name: 'clip.mp4', frames: 300, bytes: 123456};
    const newKey = 'cameraMotion:clip.mp4|frames=300|bytes=123456';

    test('saving removes every older entry for this name and keeps every other entry', () => {
        const storage = fakeStorage({
            'cameraMotion:clip.mp4': '[legacy]',
            'cameraMotion:clip.mp4|frames=299': '[older encode]',
            'cameraMotion:clip.mp4.bak|frames=300': '[another name]',
            'cameraMotion:other.mp4': '[other legacy]',
            'cameraMotion:other.mp4|frames=10': '[other new]',
            'unrelated': 'x',
        });
        expect(writeCameraMotionCache(storage, video, '[motion]')).toBe(true);
        expect(storage.keys()).toEqual([
            'cameraMotion:clip.mp4.bak|frames=300',
            'cameraMotion:clip.mp4|frames=300|bytes=123456',
            'cameraMotion:other.mp4',
            'cameraMotion:other.mp4|frames=10',
            'unrelated',
        ]);
        expect(storage.getItem(newKey)).toBe('[motion]');
        // The legacy entry goes BEFORE the new one is written, so its space is free.
        expect(storage.removeItem.mock.invocationCallOrder[0])
            .toBeLessThan(storage.setItem.mock.invocationCallOrder[0]);
    });

    test('loading never reads the legacy key', () => {
        const storage = fakeStorage({'cameraMotion:clip.mp4': '[legacy]'});
        expect(readCameraMotionCache(storage, video)).toBeNull();
        expect(storage.getItem).not.toHaveBeenCalledWith('cameraMotion:clip.mp4');
    });

    test('loads only the entry for the same name, frame count and size', () => {
        const storage = fakeStorage();
        writeCameraMotionCache(storage, video, '[motion]');
        expect(readCameraMotionCache(storage, video)).toBe('[motion]');
        expect(readCameraMotionCache(storage, {...video, frames: 299})).toBeNull();
        expect(readCameraMotionCache(storage, {...video, bytes: 654321})).toBeNull();
        expect(readCameraMotionCache(storage, {...video, name: 'other.mp4'})).toBeNull();
    });

    test('with no frame count nothing is written, read or removed', () => {
        const storage = fakeStorage({'cameraMotion:clip.mp4': '[legacy]'});
        const noFrames = {name: 'clip.mp4', frames: undefined, bytes: 123456};
        expect(writeCameraMotionCache(storage, noFrames, '[motion]')).toBe(false);
        expect(readCameraMotionCache(storage, noFrames)).toBeNull();
        expect(storage.setItem).not.toHaveBeenCalled();
        expect(storage.removeItem).not.toHaveBeenCalled();
        expect(storage.getItem).not.toHaveBeenCalled();
    });
});
