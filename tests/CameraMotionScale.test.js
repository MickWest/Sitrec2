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
jest.mock('../src/threeUtils', () => ({V3: (...args) => new (jest.requireActual('three').Vector3)(...args)}));

import {PerspectiveCamera, Vector3} from 'three';
import {NodeMan} from '../src/Globals';
import {altitudeHAE, getLocalUpVector} from '../src/SphericalMath';
import {
    geometricMetersPerPixel, encodeCameraMotionData, decodeCameraMotionData, smoothMotion,
} from '../src/CameraMotionFromVideo';

let camera, video;
beforeEach(() => {
    // 1000 m above a plane, looking down 30 degrees: the centre slant range is
    // 2000 m. A 90-degree image spans 4000 m transversely, or 4 m per pixel.
    camera = new PerspectiveCamera(90, 1, 1, 10000);
    camera.position.set(0, 1000, 0);
    camera.lookAt(0, 0, -1000 * Math.sqrt(3));
    video = {videoData: {videoWidth: 1000, videoHeight: 1000}};
    const nodes = {video, lookCamera: {camera}, fixedCameraPosition: {p: () => camera.position}};
    NodeMan.get.mockImplementation(id => nodes[id] ?? null);
    altitudeHAE.mockReturnValue(1000);
    getLocalUpVector.mockImplementation(() => new Vector3(0, 1, 0));
});

test('physical camera-motion scale is independent of viewport padding', () => {
    expect(geometricMetersPerPixel({backgroundAlt: 0}, 1000)).toBeCloseTo(4, 12);
    camera.renderedFOV = 120;
    expect(geometricMetersPerPixel({backgroundAlt: 0}, 1000)).toBeCloseTo(4, 12);
});

test('rebuilding at a different playback resolution retains the measured pixel scale', () => {
    video.videoData.videoHeight = 500;
    // A ten-pixel displacement measured at 1000 px stays 40 m after playback
    // returns to a 500 px decode. It must not silently double to 80 m.
    expect(10 * geometricMetersPerPixel({backgroundAlt: 0}, 1000)).toBeCloseTo(40, 12);
    // Measuring that same displacement at half resolution gives five pixels.
    expect(5 * geometricMetersPerPixel({backgroundAlt: 0}, 500)).toBeCloseTo(40, 12);
});

test('background elevation affects range instead of being treated as camera height', () => {
    expect(geometricMetersPerPixel({backgroundAlt: 500}, 1000)).toBeCloseTo(2, 12);
    expect(geometricMetersPerPixel({backgroundAlt: 1000}, 1000)).toBeNull();
});

const measuredMotion = () => Object.assign([
    {dx: 0, dy: 0, theta: 0, scale: 1, confidence: 1},
    {dx: 10, dy: -2, theta: 0.01, scale: 1.02, confidence: 0.9},
    {dx: 20, dy: -4, theta: 0.02, scale: 1.01, confidence: 0.8},
], {imageWidth: 1000, imageHeight: 1000});

test('cached motion retains the dimensions needed to recover physical displacement', () => {
    const restored = decodeCameraMotionData(encodeCameraMotionData(measuredMotion()));
    video.videoData.videoHeight = 500;
    expect(restored.imageWidth).toBe(1000);
    expect(restored.imageHeight).toBe(1000);
    expect(restored[1].dx * geometricMetersPerPixel({}, restored.imageHeight)).toBeCloseTo(40, 12);
});

test('changing the smoothing window retains the original measurement dimensions', () => {
    const smoothed = smoothMotion(measuredMotion(), 3);
    expect(smoothed[1].dx).toBe(10);
    const restored = decodeCameraMotionData(encodeCameraMotionData(smoothed));
    expect(restored.imageWidth).toBe(1000);
    expect(restored.imageHeight).toBe(1000);
});

test('old caches without a measurement scale require a new analysis', () => {
    expect(decodeCameraMotionData('[[0,0,0,1,1],[10,-2,0.01,1.02,0.9]]')).toBeNull();
    expect(encodeCameraMotionData([{dx: 10, dy: 0}])).toBeNull();
});
