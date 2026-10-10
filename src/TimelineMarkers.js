// Timeline markers: user-named frames on the frame slider.
//
// A marker is {frame, label}. They are drawn as flags along the top of the
// frame slider, clicking one jumps to it, the slider's right-click menu adds,
// renames and deletes them, and Shift+, / Shift+. step through them together
// with the In/Out frames and any tool keyframes (CKeyframeRegistry).
//
// They belong to the sitch: CustomManagerSerialize saves them as
// `timelineMarkers` and restores them on load, and a sitch change clears them.
//
// This module has no DOM, scene or Globals imports so it can be unit-tested
// on its own. Frames are integers; one marker per frame.

// Sorted, one entry per frame (the last label given for a frame wins), labels
// as strings. Entries without a finite frame are dropped.
export function normalizeMarkers(list) {
    const byFrame = new Map();
    for (const entry of Array.isArray(list) ? list : []) {
        const frame = Math.round(Number(entry?.frame));
        if (!Number.isFinite(frame)) continue;
        byFrame.set(frame, {frame, label: entry?.label == null ? "" : String(entry.label)});
    }
    return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

// The frames that Shift+, / Shift+. stop at: the union of the given lists and
// single frames, limited to [0, lastFrame], sorted and unique.
export function timelineStops(lists, lastFrame) {
    const set = new Set();
    for (const list of lists) {
        for (const value of (typeof list === "number" ? [list] : (list ?? []))) {
            const frame = Math.round(value);
            if (Number.isFinite(frame) && frame >= 0 && frame <= lastFrame) set.add(frame);
        }
    }
    return [...set].sort((a, b) => a - b);
}

// The last stop before `current`, or undefined if there is none.
export function prevStop(stops, current) {
    let result;
    for (const frame of stops) {
        if (frame < current) result = frame;
        else break;
    }
    return result;
}

// The first stop after `current`, or undefined if there is none.
export function nextStop(stops, current) {
    for (const frame of stops) {
        if (frame > current) return frame;
    }
    return undefined;
}

class CTimelineMarkers {
    constructor() {
        this.markers = [];
        // Bumped on every change; the frame slider compares it to decide
        // whether to redraw.
        this.version = 0;
    }

    changed() {
        this.version++;
    }

    list() {
        return this.markers.map(marker => ({...marker}));
    }

    frames() {
        return this.markers.map(marker => marker.frame);
    }

    count() {
        return this.markers.length;
    }

    get(frame) {
        const marker = this.markers.find(m => m.frame === Math.round(frame));
        return marker ? {...marker} : null;
    }

    // Add a marker, or relabel the one already at that frame when a label is
    // given. Returns the marker, or null for an invalid frame.
    add(frame, label = "") {
        frame = Math.round(Number(frame));
        if (!Number.isFinite(frame)) return null;
        const existing = this.markers.find(m => m.frame === frame);
        if (existing) {
            if (label !== "" && label != null && existing.label !== String(label)) {
                existing.label = String(label);
                this.changed();
            }
            return {...existing};
        }
        const marker = {frame, label: label == null ? "" : String(label)};
        this.markers.push(marker);
        this.markers.sort((a, b) => a.frame - b.frame);
        this.changed();
        return {...marker};
    }

    remove(frame) {
        const index = this.markers.findIndex(m => m.frame === Math.round(frame));
        if (index < 0) return false;
        this.markers.splice(index, 1);
        this.changed();
        return true;
    }

    rename(frame, label) {
        const marker = this.markers.find(m => m.frame === Math.round(frame));
        if (!marker) return false;
        const text = label == null ? "" : String(label);
        if (marker.label === text) return true;
        marker.label = text;
        this.changed();
        return true;
    }

    clear() {
        if (this.markers.length === 0) return;
        this.markers = [];
        this.changed();
    }

    // Add markers that a prediction found, such as satellite rises and sets:
    // entries are {frame, label}. A frame that already has a marker keeps its
    // label and gets the new one after it, separated by "; ", so a label that
    // the user typed is never replaced. A label that the marker already has is
    // not added again, so the same prediction added twice changes nothing.
    // Returns the number of markers added or changed.
    addPredicted(entries) {
        let count = 0;
        for (const entry of entries) {
            const frame = Math.round(Number(entry.frame));
            if (!Number.isFinite(frame)) continue;
            const label = String(entry.label);
            const existing = this.markers.find(m => m.frame === frame);
            if (!existing) {
                this.markers.push({frame, label});
                count++;
            } else if (!existing.label.split("; ").includes(label)) {
                existing.label = existing.label ? existing.label + "; " + label : label;
                count++;
            }
        }
        if (count) {
            this.markers.sort((a, b) => a.frame - b.frame);
            this.changed();
        }
        return count;
    }

    // Undo and sitch chapters (CustomManagerSubSitch, which gives each chapter
    // its own markers) use snapshots: a snapshot is a plain copy that restore()
    // puts back.
    snapshot() {
        return this.list();
    }

    restore(snapshot) {
        this.markers = normalizeMarkers(snapshot);
        this.changed();
    }

    // undefined when there are none, so a saved sitch without markers carries
    // no field at all.
    serialize() {
        return this.markers.length ? this.list() : undefined;
    }

    // Replaces the current markers; a missing field means none.
    deserialize(data) {
        this.restore(data ?? []);
    }
}

export const TimelineMarkers = new CTimelineMarkers();

if (typeof window !== "undefined") {
    window.TimelineMarkers = TimelineMarkers;
}
