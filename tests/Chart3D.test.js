// Tests for the pure geometry helpers behind Chart3D's "zoom to tracks" mode:
// Liang–Barsky segment clipping against an axis-aligned bounds box, and point
// containment. These are what keep the LOS rays drawn INSIDE the zoomed volume
// instead of spilling across the page.

import {clipSegmentToBounds, boundsContainPoint, niceTicks} from "../src/Chart3D";

const BOX = {minX: 0, maxX: 10, minY: 0, maxY: 10, minZ: 0, maxZ: 10};

const close = (a, b) => expect(a).toBeCloseTo(b, 9);
const closePt = (p, q) => { close(p[0], q[0]); close(p[1], q[1]); close(p[2], q[2]); };

describe("niceTicks", () => {
    test("an un-snapped terrain floor still gets nice ticks above it", () => {
        // The altitude axis starts exactly at ground level (e.g. 0.7343 NM) —
        // the floor itself is not rounded, but every tick is a nice value at
        // or above it, never below the ground plane.
        const ticks = niceTicks(0.7343, 2.1, 5);
        expect(ticks.length).toBeGreaterThan(2);
        expect(Math.min(...ticks)).toBeGreaterThanOrEqual(0.7343);
        for (const t of ticks) {
            // every tick is an integer multiple of the chosen nice step
            const step = ticks[1] - ticks[0];
            expect(Math.abs(t / step - Math.round(t / step))).toBeLessThan(1e-9);
        }
        expect(ticks[0]).toBeCloseTo(0.8, 10);
    });
});

describe("boundsContainPoint", () => {
    test("inside, on-face, and outside points", () => {
        expect(boundsContainPoint(BOX, [5, 5, 5])).toBe(true);
        expect(boundsContainPoint(BOX, [0, 10, 5])).toBe(true);     // faces are inclusive
        expect(boundsContainPoint(BOX, [10.001, 5, 5])).toBe(false);
        expect(boundsContainPoint(BOX, [5, -0.001, 5])).toBe(false);
        expect(boundsContainPoint(BOX, [5, 5, 10.001])).toBe(false);
    });
});

describe("clipSegmentToBounds", () => {
    test("segment fully inside is returned unchanged with no clip flags", () => {
        const r = clipSegmentToBounds([1, 2, 3], [8, 7, 6], BOX);
        expect(r).not.toBeNull();
        closePt(r.a, [1, 2, 3]);
        closePt(r.c, [8, 7, 6]);
        expect(r.entryClipped).toBe(false);
        expect(r.exitClipped).toBe(false);
    });

    test("segment fully outside (offset on a constant axis) is rejected", () => {
        // runs parallel to X at y = 20 — the y slab test has d[1] === 0
        expect(clipSegmentToBounds([-5, 20, 5], [15, 20, 5], BOX)).toBeNull();
    });

    test("segment crossing the whole box is clipped to both faces", () => {
        const r = clipSegmentToBounds([-5, 5, 5], [15, 5, 5], BOX);
        closePt(r.a, [0, 5, 5]);
        closePt(r.c, [10, 5, 5]);
        expect(r.entryClipped).toBe(true);
        expect(r.exitClipped).toBe(true);
    });

    test("segment leaving the box keeps its inside end and clips the exit", () => {
        // this is the LOS-ray case: origin inside the zoom volume, tip far outside
        const r = clipSegmentToBounds([5, 5, 5], [5, 5, 45], BOX);
        closePt(r.a, [5, 5, 5]);
        closePt(r.c, [5, 5, 10]);
        expect(r.entryClipped).toBe(false);
        expect(r.exitClipped).toBe(true);
    });

    test("segment entering the box clips the entry and keeps its inside end", () => {
        const r = clipSegmentToBounds([-10, 5, 5], [5, 5, 5], BOX);
        closePt(r.a, [0, 5, 5]);
        closePt(r.c, [5, 5, 5]);
        expect(r.entryClipped).toBe(true);
        expect(r.exitClipped).toBe(false);
    });

    test("diagonal segment is clipped at the correct parametric points", () => {
        // from (-2,-2,-2) toward (14,14,14): enters at t=2/16, exits at t=12/16
        const r = clipSegmentToBounds([-2, -2, -2], [14, 14, 14], BOX);
        closePt(r.a, [0, 0, 0]);
        closePt(r.c, [10, 10, 10]);
        expect(r.entryClipped).toBe(true);
        expect(r.exitClipped).toBe(true);
    });

    test("diagonal near-miss outside a corner is rejected", () => {
        // passes beside the box: x enters only after y has already exited
        expect(clipSegmentToBounds([-10, 12, 5], [5, 27, 5], BOX)).toBeNull();
    });

    test("degenerate direction inside its slab still clips the moving axes", () => {
        // constant y (inside 0..10), x crosses the box
        const r = clipSegmentToBounds([-5, 3, 2], [15, 3, 2], BOX);
        closePt(r.a, [0, 3, 2]);
        closePt(r.c, [10, 3, 2]);
    });

    test("polyline continuation flags: exit then re-entry restarts the subpath", () => {
        // pts: inside → outside → inside; the drawer uses exitClipped/entryClipped
        // to decide whether the second drawn segment continues the first.
        const seg1 = clipSegmentToBounds([5, 5, 5], [5, 5, 15], BOX);   // leaves through +Z
        const seg2 = clipSegmentToBounds([5, 5, 15], [5, 5, 8], BOX);   // comes back in
        expect(seg1.exitClipped).toBe(true);
        expect(seg2.entryClipped).toBe(true);
        // and two fully-inside consecutive segments read as one continuous path
        const seg3 = clipSegmentToBounds([1, 1, 1], [2, 2, 2], BOX);
        const seg4 = clipSegmentToBounds([2, 2, 2], [3, 3, 3], BOX);
        expect(seg3.exitClipped).toBe(false);
        expect(seg4.entryClipped).toBe(false);
    });
});
