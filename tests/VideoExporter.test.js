import {createVideoExportFramePlan} from "../src/VideoExporter";

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
});
