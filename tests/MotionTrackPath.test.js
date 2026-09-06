import {identity3, MotionTrackPath} from '../src/MotionTrackPath';
import {TrackPositionMap, smoothPointTrack} from '../src/PointTrackSmoothing';
import {interpolatePosition, CVideoData} from '../src/CVideoData';

const shift = x => [1, 0, x, 0, 1, 0, 0, 0, 1];

test('a confirmed gap follows the measured camera slew, including outside the image', () => {
    const path = new MotionTrackPath();
    [-30, -40, 20, 50].forEach((x, i) => path.record(i + 1, shift(x)));
    const gap = path.reconstruct({frame: 0, x: 20, y: 50}, {frame: 4, x: 28, y: 50});
    expect([...gap.values()]).toEqual([{x: -8, y: 50}, {x: -46, y: 50}, {x: -24, y: 50}]);
    // An image-space line would be 22, 24, 26, hiding the actual excursion.
});

test('internal prediction removes camera motion from target velocity', () => {
    const path = new MotionTrackPath();
    path.record(1, shift(-30)); path.record(2, shift(10));
    expect(path.predict([{frame: 0, x: 100, y: 50}, {frame: 1, x: 72, y: 50}], 2))
        .toEqual({x: 84, y: 50});
});

test('rotation and scale are composed in time order and inverted for reconstruction', () => {
    const path = new MotionTrackPath();
    path.record(1, [0, -1, 10, 1, 0, 0, 0, 0, 1]);
    path.record(2, [2, 0, 0, 0, 2, 0, 0, 0, 1]);
    const p = path.transport({x: 3, y: 4}, 0, 2);
    expect(p).toEqual({x: 12, y: 6});
    expect(path.transport(p, 2, 0)).toEqual({x: 3, y: 4});
});

test('missing or failed registration cannot create a confident camera gap', () => {
    const path = new MotionTrackPath();
    path.record(1, shift(10));
    const failed = identity3(); failed.inliers = 0;
    path.record(2, failed);
    path.record(3, shift(10));
    expect(path.reconstruct({frame: 0, x: 0, y: 0}, {frame: 3, x: 30, y: 0})).toBeNull();
    expect(path.transport({x: 0, y: 0}, 2, 3)).toEqual({x: 10, y: 0});
    expect(path.transport({x: 0, y: 0}, 0, 4)).toBeNull();
});

test('a long camera history cannot corrupt a valid recent transform', () => {
    const path = new MotionTrackPath();
    for (let f = 1; f <= 200; f++) path.record(f, [0.5, 0, 10, 0, 0.5, 10, 0, 0, 1]);
    path.record(201, shift(3));
    expect(path.transport({x: 100, y: 50}, 200, 201)).toEqual({x: 103, y: 50});
    path.record(202, null);
    path.record(203, shift(4));
    expect(path.transport({x: 100, y: 50}, 201, 203)).toBeNull();
    expect(path.transport({x: 100, y: 50}, 202, 203)).toEqual({x: 104, y: 50});
});

test('unconfirmed frames stay absent through smoothing, interpolation and stabilization', () => {
    const points = new TrackPositionMap([[0, {x: 10, y: 20}], [1, {x: 5, y: 20}]]);
    points.markUnmeasured(2);
    const output = smoothPointTrack(points, new Set(), 5);
    expect(interpolatePosition(output, 2)).toBeNull();
    expect(interpolatePosition(output, 20)).toBeNull();
    points.set(4, {x: 20, y: 30});
    expect(interpolatePosition(points, 1.5)).toBeNull();
    const video = Object.create(CVideoData.prototype);
    video.setStabilizationData(output, output.get(0));
    expect(interpolatePosition(video.stabilizationData, 2)).toBeNull();
    points.set(2, {x: -3, y: 21, estimated: 'background'});
    expect(interpolatePosition(points, 2)).toEqual({x: -3, y: 21, estimated: 'background'});
    expect(points.unmeasuredFrames.has(2)).toBe(false);
    points.clear();
    expect(points.unmeasuredFrames.size).toBe(0);
});
