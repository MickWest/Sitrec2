import {setGlobalDateTimeNode, setSit, Sit} from "../src/Globals";
import {par} from "../src/par";
import {clampSitFrameRange, lastSitFrame, setSitFpsFromVideo, updateSitFrames} from "../src/UpdateSitFrames";

describe("Sit frame range normalization", () => {
    beforeEach(() => {
        setSit({
            frames: 900,
            fps: 30,
            aFrame: 0,
            bFrame: 899,
            framesFromVideo: true,
        });
        par._frameOverride = undefined;
        par.frame = 0;
        setGlobalDateTimeNode({changedFrames: jest.fn()});
    });

    test("clamps stale saved B frame and current frame to the video length", () => {
        Sit.frames = 2410;
        Sit.aFrame = 0;
        Sit.bFrame = 6299;
        par.frame = 2919;

        clampSitFrameRange();

        expect(Sit.aFrame).toBe(0);
        expect(Sit.bFrame).toBe(2409);
        expect(par.frame).toBe(2409);
    });

    test("moves B to the new end when it was at the old end", () => {
        Sit.videoFrames = 2410;

        updateSitFrames();

        expect(Sit.frames).toBe(2410);
        expect(Sit.bFrame).toBe(2409);
        expect(lastSitFrame()).toBe(2409);
    });

    test("preserves an intentional shorter B range when the video frame count changes", () => {
        Sit.bFrame = 120;
        Sit.videoFrames = 2410;

        updateSitFrames();

        expect(Sit.frames).toBe(2410);
        expect(Sit.bFrame).toBe(120);
    });

    test("defaults a missing B frame to the last valid frame", () => {
        delete Sit.bFrame;
        Sit.frames = 1031;

        clampSitFrameRange();

        expect(Sit.bFrame).toBe(1030);
    });
});

describe("Video fps versus a hand-set fps", () => {
    beforeEach(() => {
        setSit({fps: 30});
    });

    test("a loaded video sets Sit.fps from its header when nothing was set by hand", () => {
        setSitFpsFromVideo(29.97);
        expect(Sit.fps).toBe(29.97);
    });

    // The reported bug: set 24, save, reload - the video finishes loading after the
    // saved Sit values are restored and put its own 30 back.
    test("a restored hand-set fps wins over a video that finishes loading later", () => {
        Sit.fpsOverride = 24;
        Sit.fps = 24;
        setSitFpsFromVideo(30);
        expect(Sit.fps).toBe(24);
    });

    test("a newly imported video drops the override once it loads", () => {
        Sit.fpsOverride = 24;
        const newVideo = {clearsFpsOverride: true};
        setSitFpsFromVideo(30, newVideo);
        expect(Sit.fps).toBe(30);
        expect(Sit.fpsOverride).toBeUndefined();
        expect(newVideo.clearsFpsOverride).toBe(false);
    });

    test("a video that is not a new import keeps the override", () => {
        Sit.fpsOverride = 24;
        setSitFpsFromVideo(30, {});
        expect(Sit.fps).toBe(24);
        expect(Sit.fpsOverride).toBe(24);
    });

    test("an invalid override is ignored", () => {
        Sit.fpsOverride = 0;
        setSitFpsFromVideo(25);
        expect(Sit.fps).toBe(25);
    });
});
