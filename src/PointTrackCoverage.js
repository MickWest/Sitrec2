// How each frame of a point track gets its position. A track is a sparse map
// from frame number to point: the cursor, the trail and the line of sight use
// the straight line between two points for the frames that have none. The
// timeline, the trail, Go to Next Untracked and Frequency Analysis all need to
// know which frames those are, so the rule lives here, in one place.
//
// The values are also the status values that the timeline draws
// (CNodeFrameSlider.drawTimeline), each in its own color.
export const TRACK_FRAME = Object.freeze({
    none: 0,          // no position: outside the track, or the object was not found
    measured: 1,      // the tracker measured the object
    user: 2,          // a person placed the point
    estimated: 3,     // the tracker made the point without seeing the object
    interpolated: 4,  // no point: the position is on the line between the points on each side
});

// The trail colors of the two kinds of frame that are not measurements. The
// timeline has the same two colors for status 3 and 4.
export const ESTIMATED_COLOR = '#ffb347';
export const INTERPOLATED_COLOR = '#ff4040';

// A measurement of the object: a point from the tracker or from a person.
export const isTrackedStatus = status => status === TRACK_FRAME.measured || status === TRACK_FRAME.user;

export function sortedTrackFrames(positions) {
    return Array.from(positions.keys()).sort((one, other) => one - other);
}

// True when the tracker recorded "object not found" for a frame between two
// points. Such a record stops interpolation across the whole interval, as it
// does in interpolatePosition(): the frames there have no position.
export function lostBetween(positions, before, after) {
    const lost = positions.unmeasuredFrames;
    if (!lost?.size) return false;
    if (lost.size < after - before) {
        for (const frame of lost) if (frame > before && frame < after) return true;
        return false;
    }
    for (let frame = before + 1; frame < after; frame++) if (lost.has(frame)) return true;
    return false;
}

// The status of each frame from 0 to frames - 1.
export function trackFrameStatus(positions, userPoints, frames) {
    const status = new Array(Math.max(0, frames)).fill(TRACK_FRAME.none);
    let previous = null;
    for (const frame of sortedTrackFrames(positions)) {
        if (previous !== null && frame > previous + 1 && !lostBetween(positions, previous, frame)) {
            const end = Math.min(frame, frames);
            for (let between = Math.max(0, previous + 1); between < end; between++) status[between] = TRACK_FRAME.interpolated;
        }
        if (frame >= 0 && frame < frames) {
            status[frame] = userPoints?.has(frame) ? TRACK_FRAME.user
                : positions.get(frame).estimated ? TRACK_FRAME.estimated : TRACK_FRAME.measured;
        }
        previous = frame;
    }
    return status;
}

// The position of a frame whose status is interpolated: on the line between
// the points on each side. `sorted` is sortedTrackFrames(positions). Null when
// the frame is not between two points.
export function positionBetween(positions, sorted, frame) {
    let low = 0, high = sorted.length - 1;
    if (high < 1 || frame <= sorted[0] || frame >= sorted[high]) return null;
    // The last point before the frame.
    while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (sorted[middle] < frame) low = middle; else high = middle - 1;
    }
    const before = sorted[low], after = sorted[low + 1];
    if (after === frame) return null;
    const from = positions.get(before), to = positions.get(after);
    const part = (frame - before) / (after - before);
    return {x: from.x + (to.x - from.x) * part, y: from.y + (to.y - from.y) * part};
}

// How far a straight line is from the track when it replaces as many tracked
// frames as the gap from `first` to `last` has: the replacement that
// interpolation makes in the gap, tried where the answer is known. The trial
// uses the tracked frames right before the gap and right after it. An object
// at a constant velocity gives 0, however fast it moves; a turn or a tracker
// that jumps gives more. Returns the largest distance, in the units of the
// positions, or null when neither side has enough tracked frames in a row.
export function lineTrialError(positions, status, first, last) {
    const length = last - first + 1;
    let worst = null;
    // The two ends of each trial line. The `length` frames between them are the ones replaced.
    for (const [from, to] of [[first - 2 - length, first - 1], [last + 1, last + 2 + length]]) {
        let tracked = from >= 0;
        for (let frame = from; tracked && frame <= to; frame++) tracked = isTrackedStatus(status[frame]);
        if (!tracked) continue;
        const start = positions.get(from), end = positions.get(to);
        for (let frame = from + 1; frame < to; frame++) {
            const part = (frame - from) / (to - from), point = positions.get(frame);
            const error = Math.hypot(start.x + (end.x - start.x) * part - point.x, start.y + (end.y - start.y) * part - point.y);
            worst = Math.max(worst ?? 0, error);
        }
    }
    return worst;
}

// The frame where the next run of untracked frames starts, from `first` to
// `last`. The search starts after `from` and goes round to `first` at the end,
// so repeated calls visit each run in turn. When `from` is inside a run, the
// rest of that run is passed over. Null when every frame is tracked.
export function nextUntrackedFrame(status, from, first, last) {
    const untracked = frame => !isTrackedStatus(status[frame]);
    const startOfRun = frame => untracked(frame) && (frame === first || !untracked(frame - 1));
    for (let frame = Math.max(first, from + 1); frame <= last; frame++) if (startOfRun(frame)) return frame;
    for (let frame = first; frame <= Math.min(last, from); frame++) if (startOfRun(frame)) return frame;
    return null;
}
