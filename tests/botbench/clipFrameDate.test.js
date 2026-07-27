/**
 * clipFrameDate.test.js — the extracted clip-time helper must agree with the
 * scene-bound original AT EVERY simSpeed, not just the default.
 *
 * The original lived in AnalyzeTraverse and read globals:
 *
 *     dateStart + globalFrame * 1000 * (Sit.simSpeed ?? 1) / Sit.fps
 *
 * Note it divides by the RAW Sit.fps. The extracted version divides by
 * dataset.fps, which buildAnalysisDataset already defines as Sit.fps / simSpeed
 * — so an extra simSpeed factor squares it. That is invisible at simSpeed 1,
 * which is every other test and every benchmark scenario in the repo, so it
 * needs a case with simSpeed != 1 to be caught at all.
 */

import {clipFrameDate} from "../../src/TraverseHypotheses";

// The pre-extraction formula, verbatim, with the globals as plain arguments.
function originalDateAtFrame(dateStartMs, sitFps, simSpeed, globalFrame) {
    return new Date(dateStartMs + globalFrame * 1000 * (simSpeed ?? 1) / sitFps);
}

describe("clipFrameDate matches the scene-bound original", () => {
    const START = Date.parse("2025-02-01T20:00:00Z");
    const SIT_FPS = 30;

    for (const simSpeed of [1, 2, 10, 0.5]) {
        test(`simSpeed ${simSpeed}`, () => {
            // buildAnalysisDataset: dataset.fps is EFFECTIVE frames per real second.
            const dataset = {fps: SIT_FPS / simSpeed, frame0: 0};
            for (const f of [0, 1, 37, 600]) {
                expect(clipFrameDate(START, dataset, f).valueOf())
                    .toBeCloseTo(originalDateAtFrame(START, SIT_FPS, simSpeed, f).valueOf(), 6);
            }
        });
    }

    test("honours dataset.frame0 like dateAtDatasetFrame did", () => {
        const dataset = {fps: SIT_FPS / 4, frame0: 120};
        expect(clipFrameDate(START, dataset, 5).valueOf())
            .toBeCloseTo(originalDateAtFrame(START, SIT_FPS, 4, 125).valueOf(), 6);
    });

    test("a doubled simSpeed factor would fail this suite", () => {
        // Guards the guard: prove the assertion above is load-bearing.
        const simSpeed = 10, dataset = {fps: SIT_FPS / simSpeed, frame0: 0};
        const doubled = new Date(START + 600 * 1000 * simSpeed / dataset.fps);
        expect(doubled.valueOf())
            .not.toBeCloseTo(originalDateAtFrame(START, SIT_FPS, simSpeed, 600).valueOf(), 6);
    });
});
