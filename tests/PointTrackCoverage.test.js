// How each frame of a point track gets its position: the rule that the
// timeline, the trail, Go to Next Untracked and Frequency Analysis share.
import {
    isTrackedStatus, lineTrialError, lostBetween, nextUntrackedFrame, positionBetween, sortedTrackFrames, TRACK_FRAME,
    trackFrameStatus,
} from '../src/PointTrackCoverage';

const {none, measured, user, estimated, interpolated} = TRACK_FRAME;

// A track from `first` to `last` on a line, without the frames in `gaps`.
function track(first, last, gaps = []) {
    const positions = new Map();
    for (let frame = first; frame <= last; frame++) if (!gaps.includes(frame)) positions.set(frame, {x: frame, y: 2 * frame});
    return positions;
}

test('frames between two points are interpolated; frames outside the track have no position', () => {
    const status = trackFrameStatus(track(2, 9, [4, 5, 8]), null, 12);
    expect(status).toEqual([none, none, measured, measured, interpolated, interpolated, measured, measured,
        interpolated, measured, none, none]);
});

test('user points and estimated points keep their own status', () => {
    const positions = track(0, 5, [3]);
    positions.set(1, {x: 1, y: 2, estimated: 'linear'});
    positions.set(4, {x: 4, y: 8, estimated: 'background'});
    // A point that a person placed is an observation, also when it replaced an estimate.
    expect(trackFrameStatus(positions, new Set([2, 4]), 6)).toEqual([measured, estimated, user, interpolated, user, measured]);
    expect([measured, user, estimated, interpolated, none].map(isTrackedStatus)).toEqual([true, true, false, false, false]);
});

test('a frame where the object was not found stops interpolation across its whole interval', () => {
    const positions = track(0, 9, [3, 4, 5, 7]);
    positions.unmeasuredFrames = new Set([4]);
    expect(lostBetween(positions, 2, 6)).toBe(true);
    expect(lostBetween(positions, 6, 8)).toBe(false);
    expect(trackFrameStatus(positions, null, 10)).toEqual([measured, measured, measured, none, none, none, measured,
        interpolated, measured, measured]);
});

test('the status array is cut at the number of frames', () => {
    expect(trackFrameStatus(track(3, 20, [10]), null, 6)).toEqual([none, none, none, measured, measured, measured]);
    expect(trackFrameStatus(new Map([[2, {x: 0, y: 0}], [9, {x: 7, y: 7}]]), null, 5)).toEqual([none, none, measured, interpolated, interpolated]);
    expect(trackFrameStatus(new Map(), null, 3)).toEqual([none, none, none]);
});

test('an interpolated position is on the line between the points on each side', () => {
    const positions = new Map([[10, {x: 100, y: 50}], [14, {x: 108, y: 30}], [15, {x: 0, y: 0}]]);
    const sorted = sortedTrackFrames(positions);
    expect(positionBetween(positions, sorted, 11)).toEqual({x: 102, y: 45});
    expect(positionBetween(positions, sorted, 13)).toEqual({x: 106, y: 35});
    // Not between two points: on a point, or outside the track.
    for (const frame of [10, 14, 15, 9, 16]) expect(positionBetween(positions, sorted, frame)).toBeNull();
    expect(positionBetween(new Map([[3, {x: 1, y: 1}]]), [3], 3)).toBeNull();
});

test('the line trial measures what interpolation would get wrong beside a gap', () => {
    // A straight path at any speed is exactly on the line.
    const straight = track(0, 40, [20, 21, 22]);
    expect(lineTrialError(straight, trackFrameStatus(straight, null, 41), 20, 22)).toBeCloseTo(0, 12);

    // A parabola y = frame², x = 0. A line that replaces 3 frames spans 4 steps;
    // its largest distance from the parabola is at the middle: 2 · 2 = 4.
    const curved = new Map();
    for (let frame = 0; frame <= 40; frame++) if (frame < 20 || frame > 22) curved.set(frame, {x: 0, y: frame * frame});
    const status = trackFrameStatus(curved, null, 41);
    expect(lineTrialError(curved, status, 20, 22)).toBeCloseTo(4, 9);

    // One side is enough. With no side that has enough tracked frames in a row there is no trial.
    for (const frame of [16, 25]) curved.delete(frame);
    expect(lineTrialError(curved, trackFrameStatus(curved, null, 41), 20, 22)).toBeNull();
    // A point that jumped: the line from frame 23 to 27 passes frame 25 at 629, the point is at 700.
    curved.set(25, {x: 0, y: 700});
    expect(lineTrialError(curved, trackFrameStatus(curved, null, 41), 20, 22)).toBeCloseTo(71, 9);
    expect(lineTrialError(straight, trackFrameStatus(straight, null, 41), 1, 38)).toBeNull();
});

test('Go to Next Untracked visits the start of each gap in turn and goes round', () => {
    // The test sitch: a track from 522 to 957 without 927–931 and 948–949.
    const status = trackFrameStatus(track(522, 957, [927, 928, 929, 930, 931, 948, 949]), null, 1798);
    const next = from => nextUntrackedFrame(status, from, 522, 957);
    expect(next(522)).toBe(927);
    expect(next(927)).toBe(948);
    // Inside a gap, the rest of that gap is passed over.
    expect(next(929)).toBe(948);
    expect(next(948)).toBe(927);
    expect(next(957)).toBe(927);
    // With In and Out past the ends of the track, the frames there are untracked too.
    expect(nextUntrackedFrame(status, 950, 500, 1000)).toBe(958);
    expect(nextUntrackedFrame(status, 958, 500, 1000)).toBe(500);
    expect(nextUntrackedFrame(status, 500, 500, 1000)).toBe(927);
});

test('Go to Next Untracked finds nothing on a complete track', () => {
    const status = trackFrameStatus(track(0, 30), null, 31);
    expect(nextUntrackedFrame(status, 12, 0, 30)).toBeNull();
    // The only gap is the one the playhead is at the start of.
    const oneGap = trackFrameStatus(track(0, 30, [7, 8]), null, 31);
    expect(nextUntrackedFrame(oneGap, 7, 0, 30)).toBe(7);
    expect(nextUntrackedFrame(oneGap, 8, 0, 30)).toBe(7);
});
