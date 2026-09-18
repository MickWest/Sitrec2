// Tests for the pure geometry helpers behind Chart3D's "zoom to tracks" mode:
// Liang–Barsky segment clipping against an axis-aligned bounds box, and point
// containment. These are what keep the LOS rays drawn INSIDE the zoomed volume
// instead of spilling across the page.

import {Chart3D, clipSegmentToBounds, boundsContainPoint, niceTicks} from "../src/Chart3D";
import {cameraTrackProjection} from "../src/CameraTrackView";

const BOX = {minX: 0, maxX: 10, minY: 0, maxY: 10, minZ: 0, maxZ: 10};

const close = (a, b) => expect(a).toBeCloseTo(b, 9);
const closePt = (p, q) => { close(p[0], q[0]); close(p[1], q[1]); close(p[2], q[2]); };

describe("track overlays", () => {
    const project = ([x, y]) => ({x, y});
    const peak = (x, y, value) => ({pos: [x, y, 0], value});
    function labels(series, {showTruth = true, clip = null} = {}) {
        const drawn = [];
        const ctx = {
            save() {}, restore() {}, strokeText() {},
            measureText: text => ({width: text.length * 7}),
            fillText(text, x, y) { drawn.push({text, x, y, color: this.fillStyle}); },
        };
        Chart3D.prototype._drawPeakLabels.call({scene: {series}, showTruth, w: 340, h: 260, labelInsetRight: 44},
            ctx, project, clip);
        return drawn;
    }

    test("labels the three highest separated visible peaks in the path colour", () => {
        const drawn = labels([{color: "cyan", peaks: [peak(30, 50, 10), peak(35, 52, 9),
            peak(100, 80, 8), peak(180, 110, 7), peak(250, 140, 6)]}]);
        expect(drawn.map(d => d.text)).toEqual(["10.0g", "8.0g", "7.0g"]);
        expect(drawn.every(d => d.color === "cyan")).toBe(true);
    });

    test("hidden truth and peaks outside the zoom bounds have no labels", () => {
        const series = [
            {color: "cyan", peaks: [peak(80, 80, 4.3), peak(250, 80, 9)]},
            {role: "truth", color: "pink", peaks: [peak(160, 160, 2.1)]},
        ];
        const clip = {minX: 0, maxX: 200, minY: 0, maxY: 200, minZ: -1, maxZ: 1};
        expect(labels(series, {showTruth: false, clip}).map(d => d.text)).toEqual(["4.3g"]);
        expect(labels(series, {clip}).map(d => d.color)).toEqual(["cyan", "pink"]);
    });

    test("truth visibility removes the path itself without removing other paths", () => {
        const ctx = {beginPath() {}, fill() {}, arc: jest.fn()};
        const series = [
            {type: "points", role: "truth", color: "pink", pts: [[10, 10, 0]]},
            {type: "points", color: "cyan", pts: [[20, 20, 0]]},
        ];
        Chart3D.prototype._drawSeries.call({scene: {series}, showTruth: false}, ctx, project);
        expect(ctx.arc).toHaveBeenCalledTimes(1);
        expect(ctx.arc.mock.calls[0].slice(0, 2)).toEqual([20, 20]);
    });
});

test("camera current markers use the exact frame and omit unavailable truth positions", () => {
    const pose = {position: [0, 0, 0], forward: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0]};
    const points = [[0, 0, 10], [2, 1, 10], [4, 0, 10]];
    const candidate = {cameraPath: true, pts: [points[0], points[2]], color: "cyan",
        frameCount: 3, positionAt: f => points[f]};
    const truth = {cameraPath: true, role: "truth", pts: [[1, 0, 10], [3, 0, 10]], color: "pink",
        frameCount: 3, positionAt: f => f === 1 ? null : [f + 1, 0, 10]};
    const scene = {camera: {poseAt: () => pose}, series: [candidate, truth]};
    const ctx = {save() {}, restore() {}, fillText() {}, beginPath() {}, rect() {}, clip() {},
        setLineDash() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc: jest.fn()};
    const fake = {scene, cameraFrame: 1, showTruth: true, showPeaks: false, w: 340, h: 260};
    Chart3D.prototype._drawCameraView.call(fake, ctx);
    const project = cameraTrackProjection(scene.series, pose, {left: 14, top: 28, width: 274, height: 162});
    const expected = project(points[1]);
    expect(ctx.arc).toHaveBeenCalledTimes(1);
    expect(ctx.arc.mock.calls[0][0]).toBeCloseTo(expected.x, 9);
    expect(ctx.arc.mock.calls[0][1]).toBeCloseTo(expected.y, 9);
});

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

// Sync Scale in the MAGNIFIED (zoomed) views: the group carries the reference
// chart's zoom-window SIZE, and each zoomed chart re-centers that window on
// its own tracks — so magnified candidates compare at one scale. Uses the real
// activeBounds via .call() on a minimal chart shape; the method only reads
// zoomed / scene.zoomBounds / group / bounds.
describe("Sync Scale across zoomed views", () => {
    const {Chart3DGroup, Chart3D} = require("../src/Chart3D");

    // setSyncScale coalesces a redraw through requestAnimationFrame, which
    // node's test environment does not define. The callback never needs to
    // run here — these tests assert state, not painting.
    beforeAll(() => {
        global.requestAnimationFrame = () => 0;
    });
    afterAll(() => {
        delete global.requestAnimationFrame;
    });
    const mk = (bounds, zoomBounds) => ({bounds, scene: {zoomBounds}});
    const BIG = mk(
        {minX: -500, maxX: 500, minY: -500, maxY: 500, minZ: 0, maxZ: 200},
        {minX: 0, maxX: 100, minY: 0, maxY: 80, minZ: 0, maxZ: 40});
    const SMALL = mk(
        {minX: -50, maxX: 50, minY: -50, maxY: 50, minZ: 0, maxZ: 20},
        {minX: 40, maxX: 60, minY: 10, maxY: 30, minZ: 0, maxZ: 10});

    test("setSyncScale stores the shared box and window; off clears both", () => {
        const g = new Chart3DGroup({});
        g.setSyncScale(true, BIG.bounds, {x: 100, y: 80, z: 40});
        expect(g.sharedBounds).toBe(BIG.bounds);
        expect(g.sharedZoomSpan).toEqual({x: 100, y: 80, z: 40});
        g.setSyncScale(false);
        expect(g.sharedBounds).toBeNull();
        expect(g.sharedZoomSpan).toBeNull();
    });

    test("a zoomed chart under sync keeps its own center at the shared size", () => {
        const g = new Chart3DGroup({});
        g.setSyncScale(true, BIG.bounds, {x: 100, y: 80, z: 40});
        const fake = {zoomed: true, scene: SMALL.scene, group: g, bounds: SMALL.bounds};
        const b = Chart3D.prototype.activeBounds.call(fake);
        // SMALL's zoom center is (50, 20, 5); the window is the shared 100x80x40.
        expect(b.minX).toBeCloseTo(0, 9);
        expect(b.maxX).toBeCloseTo(100, 9);
        expect(b.minY).toBeCloseTo(-20, 9);
        expect(b.maxY).toBeCloseTo(60, 9);
        expect(b.minZ).toBeCloseTo(-15, 9);
        expect(b.maxZ).toBeCloseTo(25, 9);
    });

    test("the shared window must be a per-axis maximum, not one chart's spans", () => {
        // Review case: an E/W 200x10x10 candidate outranks a N/S 10x150x10
        // one on max single-axis span — but copying the E/W chart's spans
        // would give the N/S candidate a 10-unit-tall window and clip its
        // 150-unit track. The per-axis max window covers both.
        const spans = [{x: 200, y: 10, z: 10}, {x: 10, y: 150, z: 10}];
        const shared = spans.reduce((a, s) => ({
            x: Math.max(a.x, s.x), y: Math.max(a.y, s.y), z: Math.max(a.z, s.z),
        }));
        expect(shared).toEqual({x: 200, y: 150, z: 10});
        const g = new Chart3DGroup({});
        const ns = mk(null, {minX: 0, maxX: 10, minY: 0, maxY: 150, minZ: 0, maxZ: 10});
        g.setSyncScale(true, null, shared);
        const fake = {zoomed: true, scene: ns.scene, group: g, bounds: ns.bounds};
        const b = Chart3D.prototype.activeBounds.call(fake);
        // The N/S candidate's full 150-unit extent fits the shared window.
        expect(b.maxY - b.minY).toBeCloseTo(150, 9);
        expect(b.minY).toBeLessThanOrEqual(0);
        expect(b.maxY).toBeGreaterThanOrEqual(150);
    });

    test("sync off leaves the zoomed view on its own zoomBounds", () => {
        const g = new Chart3DGroup({});
        g.setSyncScale(false);
        const fake = {zoomed: true, scene: SMALL.scene, group: g, bounds: SMALL.bounds};
        expect(Chart3D.prototype.activeBounds.call(fake)).toBe(SMALL.scene.zoomBounds);
    });

    test("unzoomed sync still follows sharedBounds", () => {
        const g = new Chart3DGroup({});
        g.setSyncScale(true, BIG.bounds, {x: 100, y: 80, z: 40});
        const fake = {zoomed: false, scene: SMALL.scene, group: g, bounds: SMALL.bounds};
        expect(Chart3D.prototype.activeBounds.call(fake)).toBe(BIG.bounds);
    });

    test("sync without a shared window leaves zoomed charts on their own box", () => {
        const g = new Chart3DGroup({});
        g.setSyncScale(true, BIG.bounds, null);
        expect(g.sharedZoomSpan).toBeNull();
        const fake = {zoomed: true, scene: SMALL.scene, group: g, bounds: SMALL.bounds};
        expect(Chart3D.prototype.activeBounds.call(fake)).toBe(SMALL.scene.zoomBounds);
    });
});
