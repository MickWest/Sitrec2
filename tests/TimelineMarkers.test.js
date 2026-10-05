import {nextStop, normalizeMarkers, prevStop, timelineStops, TimelineMarkers} from "../src/TimelineMarkers";

describe("TimelineMarkers", () => {
    beforeEach(() => TimelineMarkers.clear());

    test("keeps markers sorted, one per frame, with rounded frames", () => {
        TimelineMarkers.add(50, "b10");
        TimelineMarkers.add(18.4, "b8");
        TimelineMarkers.add(2);
        expect(TimelineMarkers.list()).toEqual([
            {frame: 2, label: ""}, {frame: 18, label: "b8"}, {frame: 50, label: "b10"}]);
        expect(TimelineMarkers.frames()).toEqual([2, 18, 50]);
    });

    test("adding at an existing frame relabels it only when a label is given", () => {
        TimelineMarkers.add(7, "first");
        TimelineMarkers.add(7);
        expect(TimelineMarkers.get(7).label).toBe("first");
        TimelineMarkers.add(7, "second");
        expect(TimelineMarkers.list()).toEqual([{frame: 7, label: "second"}]);
    });

    test("rejects frames that are not numbers", () => {
        expect(TimelineMarkers.add("abc")).toBeNull();
        expect(TimelineMarkers.add(NaN)).toBeNull();
        expect(TimelineMarkers.count()).toBe(0);
    });

    test("rename, remove and clear report what changed", () => {
        TimelineMarkers.add(3);
        expect(TimelineMarkers.rename(3, "x")).toBe(true);
        expect(TimelineMarkers.rename(4, "y")).toBe(false);
        expect(TimelineMarkers.remove(4)).toBe(false);
        expect(TimelineMarkers.remove(3)).toBe(true);
        expect(TimelineMarkers.count()).toBe(0);
    });

    test("version changes only on a real change", () => {
        const v0 = TimelineMarkers.version;
        TimelineMarkers.add(1, "a");
        const v1 = TimelineMarkers.version;
        expect(v1).toBeGreaterThan(v0);
        TimelineMarkers.add(1);                // already there, no new label
        TimelineMarkers.rename(1, "a");        // same label
        TimelineMarkers.remove(99);            // nothing there
        expect(TimelineMarkers.version).toBe(v1);
    });

    test("snapshot and restore round-trip, and the copies are independent", () => {
        TimelineMarkers.add(5, "five");
        const snap = TimelineMarkers.snapshot();
        snap[0].label = "changed outside";
        TimelineMarkers.add(9, "nine");
        TimelineMarkers.restore(TimelineMarkers.snapshot().slice(0, 1));
        expect(TimelineMarkers.list()).toEqual([{frame: 5, label: "five"}]);
    });

    test("serializes to undefined when empty and restores a saved list", () => {
        expect(TimelineMarkers.serialize()).toBeUndefined();
        TimelineMarkers.add(12, "b12");
        const saved = JSON.parse(JSON.stringify({timelineMarkers: TimelineMarkers.serialize()}));
        TimelineMarkers.clear();
        TimelineMarkers.deserialize(saved.timelineMarkers);
        expect(TimelineMarkers.list()).toEqual([{frame: 12, label: "b12"}]);
        TimelineMarkers.deserialize(undefined);
        expect(TimelineMarkers.count()).toBe(0);
    });

    test("normalizeMarkers drops bad entries and keeps the last label per frame", () => {
        expect(normalizeMarkers([{frame: 4, label: "a"}, {frame: "x"}, null, {frame: 4.2, label: 7}, {frame: 1}]))
            .toEqual([{frame: 1, label: ""}, {frame: 4, label: "7"}]);
        expect(normalizeMarkers("not a list")).toEqual([]);
    });
});

describe("timeline navigation stops", () => {
    test("merge markers, keyframes and the In/Out frames, inside the sitch", () => {
        const stops = timelineStops([[50, 18, 50], [-3, 700, 30], 0, 662], 662);
        expect(stops).toEqual([0, 18, 30, 50, 662]);
    });

    test("prev and next skip the current frame and stop at the ends", () => {
        const stops = [0, 18, 50, 662];
        expect(prevStop(stops, 50)).toBe(18);
        expect(nextStop(stops, 50)).toBe(662);
        expect(nextStop(stops, 20)).toBe(50);
        expect(prevStop(stops, 0)).toBeUndefined();
        expect(nextStop(stops, 662)).toBeUndefined();
    });
});
