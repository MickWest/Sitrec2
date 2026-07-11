/**
 * Tests for the single-authority dataset/window helpers in
 * src/TraverseAnalysisData.js (TRAV-TIME-001 territory): the physical
 * effective fps (Sit.fps / simSpeed), per-SOURCE-frame historical wind
 * sampling, the shared A-B window (abFrameRange), and window expansion.
 */

import {Vector3} from "three";
import {setSit, Sit} from "../src/Globals";
import {abFrameRange, buildAnalysisDataset, expandWindowedTrack} from "../src/TraverseAnalysisData";

// Minimal LOS node near lat/lon 0: sensor on the ellipsoid surface looking east.
function makeLOSNode(frames = 100) {
    return {
        frames,
        v(f) {
            return {
                position: new Vector3(6378137, f * 10, 0),
                heading: new Vector3(0, 1, 0),
            };
        },
    };
}

describe("buildAnalysisDataset", () => {
    test("effective fps is Sit.fps / simSpeed (physical time)", () => {
        setSit({frames: 100, fps: 30, simSpeed: 1});
        expect(buildAnalysisDataset(makeLOSNode()).dataset.fps).toBe(30);
        setSit({frames: 100, fps: 30, simSpeed: 5});
        expect(buildAnalysisDataset(makeLOSNode()).dataset.fps).toBe(6);
    });

    test("A-B window options select the exact source frames", () => {
        setSit({frames: 100, fps: 30, simSpeed: 1});
        const {dataset} = buildAnalysisDataset(makeLOSNode(), null, 37040,
            {frame0: 10, frame1: 19});
        expect(dataset.n).toBe(10);
        expect(dataset.frame0).toBe(10);
        expect(dataset.frame1).toBe(19);
    });

    test("wind is sampled per SOURCE frame through the pure windVectorAt", () => {
        setSit({frames: 100, fps: 30, simSpeed: 1});
        // Fake wind whose per-frame ECEF vector encodes the frame number in x
        // (locally "up" at lat/lon 0, i.e. ENU z after conversion).
        const windNode = {
            windVectorAt: (f) => new Vector3(f, 0, 0),
        };
        const {dataset} = buildAnalysisDataset(makeLOSNode(), windNode, 37040,
            {frame0: 10, frame1: 19});
        // Row 0 must be source frame 10, row 9 source frame 19 — a playhead
        // sampler would repeat one value across the window.
        expect(dataset.W[0 * 3 + 2]).toBeCloseTo(10, 6);
        expect(dataset.W[9 * 3 + 2]).toBeCloseTo(19, 6);
    });
});

describe("abFrameRange", () => {
    test("no In/Out set falls back to the full clip", () => {
        setSit({frames: 100, fps: 30});
        expect(abFrameRange(100)).toEqual({frame0: 0, frame1: 99, count: 100});
    });

    test("a valid In/Out window is honored and clamped", () => {
        setSit({frames: 100, fps: 30, aFrame: 20, bFrame: 29});
        expect(abFrameRange(100)).toEqual({frame0: 20, frame1: 29, count: 10});
        setSit({frames: 100, fps: 30, aFrame: -5, bFrame: 1e9});
        expect(abFrameRange(100)).toEqual({frame0: 0, frame1: 99, count: 100});
    });

    test("reversed markers swap; degenerate windows fall back to the clip", () => {
        setSit({frames: 100, fps: 30, aFrame: 29, bFrame: 20});
        expect(abFrameRange(100)).toEqual({frame0: 20, frame1: 29, count: 10});
        // A 1-frame window is below the default minCount of 8: full clip.
        setSit({frames: 100, fps: 30, aFrame: 50, bFrame: 50});
        expect(abFrameRange(100)).toEqual({frame0: 0, frame1: 99, count: 100});
        // Callers that handle short windows themselves pass minCount 1.
        expect(abFrameRange(100, 1)).toEqual({frame0: 50, frame1: 50, count: 1});
    });
});

describe("expandWindowedTrack", () => {
    test("holds endpoint positions outside the analyzed window (cloned)", () => {
        const win = [
            {position: new Vector3(1, 0, 0)},
            {position: new Vector3(2, 0, 0)},
            {position: new Vector3(3, 0, 0)},
        ];
        const full = expandWindowedTrack(win, 7, 2);
        expect(full).toHaveLength(7);
        // Held frames replicate the endpoints without sharing the Vector3.
        expect(full[0].position.x).toBe(1);
        expect(full[1].position.x).toBe(1);
        expect(full[0].position).not.toBe(win[0].position);
        // The analyzed interval is the window's own objects, pointwise.
        expect(full[2]).toBe(win[0]);
        expect(full[4]).toBe(win[2]);
        expect(full[5].position.x).toBe(3);
        expect(full[6].position.x).toBe(3);
        expect(full[6].position).not.toBe(win[2].position);
    });

    test("a full-clip window is returned unchanged", () => {
        const win = [{position: new Vector3(1, 0, 0)}, {position: new Vector3(2, 0, 0)}];
        expect(expandWindowedTrack(win, 2, 0)).toBe(win);
    });
});
