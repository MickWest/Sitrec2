import {
    compareGraySamplesForDuplicate,
    createFadeExportPlan,
    createVideoExportFramePlan,
    findFadeOverlayView,
} from "../src/VideoExporter";

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

describe("createFadeExportPlan", () => {
    const twoFades = () => createFadeExportPlan({
        fps: 10,
        startWithVideo: false,
        initialDelay: 1,
        fadeTime: 2,
        holdTime: 1,
        fades: 2,
        holdFrame: true,
        startFrame: 100,
        endFrame: 103,
        frame: 42,
    });

    test("length is delay + fades x (fade + hold)", () => {
        const plan = twoFades();

        expect(plan.totalSeconds).toBe(7);
        expect(plan.totalFrames).toBe(70);
        expect(plan.fps).toBe(10);
    });

    test("holds the start view, fades out and back for two fades", () => {
        const plan = twoFades();

        expect(plan.alphaAt(0)).toBe(0);            // t=0s, initial delay
        expect(plan.alphaAt(9)).toBe(0);            // t=0.9s, still in the delay
        expect(plan.alphaAt(20)).toBeCloseTo(0.5);  // t=2.0s, halfway through fade 1
        expect(plan.alphaAt(30)).toBe(1);           // t=3.0s, fade 1 done, holding on video
        expect(plan.alphaAt(50)).toBeCloseTo(0.5);  // t=5.0s, halfway back
        expect(plan.alphaAt(60)).toBe(0);           // t=6.0s, back on look, final hold
        expect(plan.alphaAt(69)).toBe(0);
    });

    test("starting on video runs the same schedule inverted", () => {
        const plan = createFadeExportPlan({
            fps: 10, startWithVideo: true, initialDelay: 1, fadeTime: 2, holdTime: 1, fades: 2,
        });

        expect(plan.alphaAt(0)).toBe(1);
        expect(plan.alphaAt(20)).toBeCloseTo(0.5);
        expect(plan.alphaAt(30)).toBe(0);
        expect(plan.alphaAt(69)).toBe(1);
    });

    test("an odd fade count ends on the other view", () => {
        const plan = createFadeExportPlan({
            fps: 10, startWithVideo: false, initialDelay: 0, fadeTime: 1, holdTime: 1, fades: 1,
        });

        expect(plan.totalFrames).toBe(20);
        expect(plan.alphaAt(0)).toBe(0);
        expect(plan.alphaAt(19)).toBe(1);
        expect(plan.alphaEnd).toBe(1);
    });

    test("holdFrame freezes on the current frame, otherwise A-B wraps", () => {
        const held = twoFades();
        expect(held.frameAt(0)).toBe(42);
        expect(held.frameAt(69)).toBe(42);

        const playing = createFadeExportPlan({
            fps: 10, initialDelay: 0, fadeTime: 1, holdTime: 0, fades: 1,
            holdFrame: false, startFrame: 100, endFrame: 103,
        });
        expect(playing.frameAt(0)).toBe(100);
        expect(playing.frameAt(3)).toBe(103);
        expect(playing.frameAt(4)).toBe(100);
    });

    test("carries the plan fields the single-view export loop reads", () => {
        const plan = twoFades();

        expect(plan.playbackSpeed).toBe(1);
        expect(plan.pingPong).toBe(false);
        expect(plan.loops).toBe(1);
        expect(plan.skippedDuplicateFrames).toBe(0);
        expect(plan.totalSourceFrames).toBe(plan.totalFrames);
        expect(plan.nameSuffix).toBe("fade");
    });
});

describe("findFadeOverlayView", () => {
    const makeViewMan = (views) => ({
        iterate(callback) {
            for (const [id, view] of Object.entries(views)) callback(id, view);
        },
    });

    test("finds the overlay child carrying a transparency", () => {
        const lookView = {};
        const mirrorVideo = {overlayView: lookView, transparency: 0.15};
        const label = {overlayView: lookView};
        const ViewMan = makeViewMan({lookView, label, mirrorVideo});

        expect(findFadeOverlayView(ViewMan, lookView)).toBe(mirrorVideo);
    });

    test("returns null when the view has no video overlay", () => {
        const lookView = {};
        const otherView = {};
        const ViewMan = makeViewMan({
            lookView,
            otherView,
            elsewhere: {overlayView: otherView, transparency: 0.15},
        });

        expect(findFadeOverlayView(ViewMan, lookView)).toBe(null);
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
