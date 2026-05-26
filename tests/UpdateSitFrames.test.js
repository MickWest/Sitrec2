import {setGlobalDateTimeNode, setSit, Sit} from "../src/Globals";
import {par} from "../src/par";
import {clampSitFrameRange, lastSitFrame, updateSitFrames} from "../src/UpdateSitFrames";

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
