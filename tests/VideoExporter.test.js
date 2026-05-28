import {compareGraySamplesForDuplicate, createVideoExportFramePlan} from "../src/VideoExporter";

describe("createVideoExportFramePlan", () => {
    test("builds a repeated A-B pingpong sequence", () => {
        const plan = createVideoExportFramePlan({
            startFrame: 10,
            endFrame: 13,
            sourceFps: 30,
            pingPong: true,
            loops: 2,
        });

        expect(plan.sourceFrames).toEqual([10, 11, 12, 13, 12, 11, 10, 11, 12, 13, 12, 11]);
        expect(plan.totalFrames).toBe(12);
        expect(plan.frameAt(0)).toBe(10);
        expect(plan.frameAt(5)).toBe(11);
    });

    test("applies playback speed and output fps cap", () => {
        const plan = createVideoExportFramePlan({
            startFrame: 0,
            endFrame: 9,
            sourceFps: 30,
            playbackSpeed: 3,
        });

        expect(plan.fps).toBe(60);
        expect(plan.frameStep).toBe(1.5);
        expect(plan.totalFrames).toBe(7);
        expect(plan.frameAt(1)).toBe(2);
    });

    test("filters duplicate source frames without changing fps", () => {
        const plan = createVideoExportFramePlan({
            startFrame: 0,
            endFrame: 5,
            sourceFps: 30,
            duplicateFrameSet: new Set([2, 4]),
        });

        expect(plan.sourceFrames).toEqual([0, 1, 3, 5]);
        expect(plan.fps).toBe(30);
        expect(plan.totalFrames).toBe(4);
        expect(plan.skippedDuplicateFrames).toBe(2);
    });
});

describe("compareGraySamplesForDuplicate", () => {
    test("detects identical grayscale samples", () => {
        const a = new Uint8Array([10, 20, 30, 40]);
        const b = new Uint8Array([10, 20, 30, 40]);

        expect(compareGraySamplesForDuplicate(a, b).isDuplicate).toBe(true);
    });

    test("rejects visibly different grayscale samples", () => {
        const a = new Uint8Array([10, 20, 30, 40]);
        const b = new Uint8Array([80, 90, 100, 110]);

        expect(compareGraySamplesForDuplicate(a, b).isDuplicate).toBe(false);
    });
});
