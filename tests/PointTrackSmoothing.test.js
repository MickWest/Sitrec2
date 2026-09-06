import {smoothPointTrack, TrackPositionMap} from '../src/PointTrackSmoothing';

const line = () => new TrackPositionMap(Array.from({length: 31}, (_, f) => [f, {x: 3 * f + 10, y: 2 * f - 7}]));

test.each([2, 3, 4, 5, 6, 7, 8, 9, 10])('%s-frame smoothing preserves constant velocity without phase lag', n => {
    const raw = line();
    expect(smoothPointTrack(raw, new Set(), n)).toEqual(new Map(raw));
});

test('a single-frame jump and return is reduced without replacing the observations', () => {
    const raw = new TrackPositionMap(Array.from({length: 31}, (_, f) => [f, {x: f, y: f === 15 ? 12 : 0}]));
    const output = smoothPointTrack(raw, new Set(), 3);
    expect(output.get(15)).toEqual({x: 15, y: 4});
    expect(Math.max(...Array.from(output.values(), p => p.y))).toBe(4);
    expect(raw.get(15).y).toBe(12);
    expect(smoothPointTrack(raw, new Set(), 0)).toBe(raw);
});

test('manual anchors remain exact and smoothing never reaches across them', () => {
    const raw = new TrackPositionMap(Array.from({length: 21}, (_, f) => [f, {x: f, y: f < 10 ? 100 : 0}]));
    const output = smoothPointTrack(raw, new Set([10]), 10);
    expect(output.get(10)).toEqual(raw.get(10));
    expect(output.get(11).y).toBe(0);
    expect(output.get(12).y).toBe(0);
});

test('a missing-frame gap is not treated as adjacent samples', () => {
    const raw = new TrackPositionMap([[0, {x: 0, y: 0}], [1, {x: 1, y: 0}],
        [10, {x: 50, y: 50}], [11, {x: 51, y: 50}]]);
    expect(smoothPointTrack(raw, new Set(), 10)).toEqual(new Map(raw));
});
