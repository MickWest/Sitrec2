// Capture the frames a gesture touches. A tracking run or bulk clear starts with
// all existing frames, then compares the result once, when the command finishes.
function frameState(track, frame) {
    const point = track.trackedPositions.get(frame);
    return {point: point ? {...point} : null, manual: track.manualKeyframes.has(frame),
        missing: !!track.trackedPositions.unmeasuredFrames?.has(frame)};
}

function framesOf(track) {
    return new Set([...track.trackedPositions.keys(), ...track.manualKeyframes,
        ...(track.trackedPositions.unmeasuredFrames ?? [])]);
}

function restoreFrame(track, frame, state) {
    const positions = track.trackedPositions;
    positions.delete(frame);
    positions.unmeasuredFrames?.delete(frame);
    if (state?.point) positions.set(frame, {...state.point});
    if (state?.missing) positions.markUnmeasured(frame);
    if (state?.manual) track.manualKeyframes.add(frame);
    else track.manualKeyframes.delete(frame);
}

export class PointTrackEdit {
    constructor(track, bulk = false) {
        this.before = new Map();
        this.cursor = [track.trackX, track.trackY];
        this.bulk = bulk;
        if (bulk) for (const frame of framesOf(track)) this.touch(track, frame);
    }

    touch(track, frame) {
        if (!this.before.has(frame)) this.before.set(frame, frameState(track, frame));
    }

    action(track, description, resolveTrack) {
        const frames = this.bulk ? framesOf(track) : new Set();
        for (const frame of this.before.keys()) frames.add(frame);
        const changes = [];
        for (const frame of frames) {
            const before = this.before.get(frame) ?? {point: null, manual: false, missing: false};
            const after = frameState(track, frame);
            if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({frame, before, after});
        }
        const beforeCursor = this.cursor, afterCursor = [track.trackX, track.trackY];
        const moved = beforeCursor.some((v, i) => v !== afterCursor[i]);
        if (!changes.length && !moved) return null;
        const restore = (side, cursor) => {
            const live = resolveTrack();
            if (!live) return;
            for (const change of changes) restoreFrame(live, change.frame, change[side]);
            [live.trackX, live.trackY] = cursor;
            live.resetMotionHistory();
            live.refreshSmoothedOutput();
            live.updateSliderStatus();
        };
        return {description, undo: () => restore("before", beforeCursor), redo: () => restore("after", afterCursor)};
    }
}
