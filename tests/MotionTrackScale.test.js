// "Create Track from Motion" scale (src/MotionTrackScale.js).
//
// The old code looked up node ids ("fov", "cameraFOV", "targetDistance") that no sitch
// creates, so it always used 30 deg and 1000 m, and it spread the FOV across the image
// WIDTH although Sitrec FOV values are vertical.

import {
    MOTION_TRACK_DEFAULT_DISTANCE,
    MOTION_TRACK_DEFAULT_FOV,
    motionTrackScale,
} from '../src/MotionTrackScale';

const fovNode = (value) => ({id: 'fovSwitch', getValueFrame: jest.fn(() => value)});
const track = (id, x, y, z) => ({id, p: jest.fn(() => ({x, y, z}))});
const lookCamera = (fov, renderedFOV) => ({id: 'lookCamera', camera: {fov, renderedFOV}});

// origin - camera = (300, 400, 1200), a range of 1300 m.
const camera = track('cameraTrackSwitchSmooth', 1000, 2000, 3000);
const origin = track('LOSTraverseSelect', 1300, 2400, 4200);

const expectedMpp = (fovDeg, distance, height) => 2 * distance * Math.tan(fovDeg * Math.PI / 360) / height;

describe('motionTrackScale', () => {
    test('spreads the vertical FOV at frame 0 across the image HEIGHT', () => {
        const fov = fovNode(10);
        const s = motionTrackScale({fovNode: fov, lookCamera: lookCamera(50), originNode: origin,
            cameraNode: camera, imageHeight: 1080});
        expect(fov.getValueFrame).toHaveBeenCalledWith(0);
        expect(s.fovDegrees).toBe(10);
        expect(s.fovSource).toBe('fovSwitch at frame 0');
        expect(s.distance).toBeCloseTo(1300, 9);
        expect(s.metersPerPixel).toBeCloseTo(expectedMpp(10, 1300, 1080), 12);
        // Not the old width formula (a 1920-px width would give a smaller scale).
        expect(s.metersPerPixel).not.toBeCloseTo(expectedMpp(10, 1300, 1920), 6);
    });

    test('reads a FOV source that yields an object with a vFOV member', () => {
        const s = motionTrackScale({fovNode: fovNode({vFOV: 4.5}), lookCamera: null,
            originNode: origin, cameraNode: camera, imageHeight: 720});
        expect(s.fovDegrees).toBe(4.5);
        expect(s.metersPerPixel).toBeCloseTo(expectedMpp(4.5, 1300, 720), 12);
    });

    test('distance is the camera-to-origin range at frame 0', () => {
        const s = motionTrackScale({fovNode: fovNode(30), lookCamera: null,
            originNode: origin, cameraNode: camera, imageHeight: 1000});
        expect(origin.p).toHaveBeenCalledWith(0);
        expect(camera.p).toHaveBeenCalledWith(0);
        expect(s.distanceSource).toBe('|LOSTraverseSelect - cameraTrackSwitchSmooth| at frame 0');
        expect(s.distance).toBeCloseTo(1300, 9);
    });

    describe('FOV fallbacks', () => {
        test('no FOV node: the look camera FOV, never the widened renderedFOV', () => {
            let s = motionTrackScale({fovNode: null, lookCamera: lookCamera(40), originNode: origin,
                cameraNode: camera, imageHeight: 1080});
            expect(s.fovDegrees).toBe(40);
            expect(s.fovSource).toBe('lookCamera camera');
            s = motionTrackScale({fovNode: null, lookCamera: lookCamera(40, 48), originNode: origin,
                cameraNode: camera, imageHeight: 1080});
            expect(s.fovDegrees).toBe(40);
        });

        test('an unusable FOV node value falls back to the look camera', () => {
            for (const bad of [NaN, 0, -5, 180, Infinity]) {
                const s = motionTrackScale({fovNode: fovNode(bad), lookCamera: lookCamera(40),
                    originNode: origin, cameraNode: camera, imageHeight: 1080});
                expect(s.fovDegrees).toBe(40);
            }
            const throwing = {id: 'fovSwitch', getValueFrame: () => { throw new Error('no value'); }};
            const s = motionTrackScale({fovNode: throwing, lookCamera: lookCamera(40),
                originNode: origin, cameraNode: camera, imageHeight: 1080});
            expect(s.fovDegrees).toBe(40);
        });

        test('no FOV node and no look camera: the default', () => {
            const s = motionTrackScale({fovNode: null, lookCamera: null, originNode: origin,
                cameraNode: camera, imageHeight: 1080});
            expect(s.fovDegrees).toBe(MOTION_TRACK_DEFAULT_FOV);
            expect(s.fovSource).toBe('default');
            expect(s.metersPerPixel).toBeCloseTo(expectedMpp(MOTION_TRACK_DEFAULT_FOV, 1300, 1080), 12);
        });
    });

    describe('distance fallbacks', () => {
        const run = (originNode, cameraNode) => motionTrackScale({fovNode: fovNode(30), lookCamera: null,
            originNode, cameraNode, imageHeight: 1080});

        test('the origin IS the camera track', () => {
            const s = run(camera, camera);
            expect(s.distance).toBe(MOTION_TRACK_DEFAULT_DISTANCE);
            expect(s.distanceSource).toBe('default');
        });

        test('no camera track', () => {
            expect(run(origin, null).distance).toBe(MOTION_TRACK_DEFAULT_DISTANCE);
            expect(run(origin, undefined).distance).toBe(MOTION_TRACK_DEFAULT_DISTANCE);
        });

        test('a range under 1 m', () => {
            const near = track('near', 1000.3, 2000.4, 3000);   // 0.5 m from the camera
            expect(run(near, camera).distance).toBe(MOTION_TRACK_DEFAULT_DISTANCE);
        });

        test('a range that is not finite', () => {
            expect(run(track('bad', NaN, 0, 0), camera).distance).toBe(MOTION_TRACK_DEFAULT_DISTANCE);
            expect(run(track('far', Infinity, 0, 0), camera).distance).toBe(MOTION_TRACK_DEFAULT_DISTANCE);
        });

        test('a track with no position at frame 0', () => {
            const broken = {id: 'broken', p: () => { throw new Error('no position'); }};
            expect(run(broken, camera).distance).toBe(MOTION_TRACK_DEFAULT_DISTANCE);
            expect(run(origin, broken).distance).toBe(MOTION_TRACK_DEFAULT_DISTANCE);
        });

        test('all defaults gives the old 30 deg / 1000 m scale, but across the height', () => {
            const s = motionTrackScale({fovNode: null, lookCamera: null, originNode: origin,
                cameraNode: null, imageHeight: 1080});
            expect(s.metersPerPixel).toBeCloseTo(expectedMpp(30, 1000, 1080), 12);
        });
    });
});
