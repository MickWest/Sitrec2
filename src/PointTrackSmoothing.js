// Keep raw observations separate from derived output, and cheaply detect edits
// when a cached smoothed track is used by many display/LOS consumers.
export class TrackPositionMap extends Map {
    set(frame, position) {
        this.revision = (this.revision || 0) + 1;
        this.unmeasuredFrames?.delete(frame);
        return super.set(frame, position);
    }
    delete(frame) {
        if (!this.has(frame)) return false;
        this.revision = (this.revision || 0) + 1;
        return super.delete(frame);
    }
    clear() {
        this.revision = (this.revision || 0) + 1;
        this.unmeasuredFrames?.clear();
        super.clear();
    }
    markUnmeasured(frame) {
        super.delete(frame);
        if (!this.unmeasuredFrames) this.unmeasuredFrames = new Set();
        this.unmeasuredFrames.add(frame);
        this.revision = (this.revision || 0) + 1;
    }
}

export function normalizeTrackSmoothing(frames) {
    const n = Math.round(Number(frames));
    return Number.isFinite(n) && n >= 2 ? Math.min(10, n) : 0;
}

export function smoothPointTrack(positions, userPoints, frames) {
    const n = normalizeTrackSmoothing(frames);
    if (!n) return positions;
    const output = new Map();
    output.unmeasuredFrames = positions.unmeasuredFrames;
    const radius = Math.ceil((n - 1) / 2);
    for (const [frame, point] of positions) {
        if (userPoints.has(frame)) { output.set(frame, {...point}); continue; }
        let x = point.x, y = point.y, weight = 1;
        // Always take pairs at equal time offsets: no phase lag on a constant
        // velocity track, including at the ends. Stop at gaps and user anchors.
        for (let d = 1; d <= radius; d++) {
            const left = positions.get(frame - d), right = positions.get(frame + d);
            if (!left || !right) break;
            // Even windows share the outer sample between both ends, keeping
            // the filter centered on the requested frame rather than halfway
            // between frames.
            const w = n % 2 === 0 && d === radius ? 0.5 : 1;
            x += w * (left.x + right.x);
            y += w * (left.y + right.y);
            weight += 2 * w;
            if (userPoints.has(frame - d) || userPoints.has(frame + d)) break;
        }
        output.set(frame, {...point, x: x / weight, y: y / weight});
    }
    return output;
}
