import {Vector3} from 'three';
import {CNodeCameraMotionTrack} from '../src/nodes/CNodeCameraMotionTrack';

jest.mock('../src/nodes/CNodeTrack', () => ({CNodeTrack: class {}}));
jest.mock('../src/Globals', () => ({Sit: {frames: 4}}));
jest.mock('../src/threeUtils', () => ({V3: () => new (require('three').Vector3)()}));
jest.mock('../src/SphericalMath', () => ({
    getLocalUpVector: () => new (require('three').Vector3)(0, 1, 0),
    getLocalNorthVector: () => new (require('three').Vector3)(0, 0, -1),
    altitudeHAE: p => p.y,
    setAltitudeHAE: (p, altitude) => { p.y = altitude; return p; },
}));

test('camera position, roll and altitude include the motion arriving at the current frame', () => {
    const track = Object.create(CNodeCameraMotionTrack.prototype);
    Object.assign(track, {frames: 4, in: {origin: {p: () => new Vector3(0, 100, 0)}},
        motion: [{dx: 0, dy: 0, scale: 1, theta: 0},
            {dx: 10, dy: 0, scale: 0.9, theta: 0.1},
            {dx: 20, dy: 0, scale: 0.8, theta: 0.2},
            {dx: 30, dy: 0, scale: 0.7, theta: 0.3}],
        metersPerPixel: 1, signE: -1, signN: -1, swapEN: false, climbGain: 1});
    track.recalculate();
    expect(track.array.map(p => p.position.x)).toEqual([0, 10, 30, 60]);
    [0, 0.1, 0.3, 0.6].forEach((roll, f) => expect(track.array[f].imageRot).toBeCloseTo(roll, 12));
    [100, 100 / 0.9, 100 / (0.9 * 0.8), 100 / (0.9 * 0.8 * 0.7)]
        .forEach((altitude, f) => expect(track.array[f].position.y).toBeCloseTo(altitude, 10));
});
