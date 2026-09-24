import {acquirePlaybackControl, par, resetPar, stopControlledPlayback} from "../src/par";

describe("par paused state", () => {
    beforeEach(() => {
        resetPar();
        delete globalThis.__sitrecWakeRenderLoop;
    });

    afterEach(() => {
        delete globalThis.__sitrecWakeRenderLoop;
    });

    test("wakes the render loop when transitioning from paused to playing", () => {
        const wakeRenderLoop = jest.fn();
        globalThis.__sitrecWakeRenderLoop = wakeRenderLoop;

        par.paused = true;
        par.paused = false;

        expect(wakeRenderLoop).toHaveBeenCalledTimes(1);
    });

    test("does not wake the render loop when staying paused", () => {
        const wakeRenderLoop = jest.fn();
        globalThis.__sitrecWakeRenderLoop = wakeRenderLoop;

        par.paused = true;

        expect(wakeRenderLoop).not.toHaveBeenCalled();
    });

    test('exclusive playback control blocks normal seeks, overrides and Play', () => {
        par.frame = 5;
        const control = acquirePlaybackControl(jest.fn());
        par.frame = 100;
        par._frameOverride = 200;
        par.paused = false;
        expect(par.frame).toBe(5);
        expect(par.paused).toBe(true);
        control.setFrame(6);
        expect(par.frame).toBe(6);
        par._frameOverride = undefined;
        control.release();
        par.frame = 7;
        par.paused = false;
        expect(par.frame).toBe(7);
        expect(par.paused).toBe(false);
    });

    test('an old controller cannot move or unlock a later run', () => {
        const old = acquirePlaybackControl(jest.fn());
        expect(acquirePlaybackControl(jest.fn())).toBeNull();
        old.release();
        const current = acquirePlaybackControl(jest.fn());
        current.setFrame(20);
        old.setFrame(3);
        old.release();
        expect(par.frame).toBe(20);
        expect(par.playbackLocked).toBe(true);
        current.release();
    });

    test('stop requests are consumed only while a controller owns playback', () => {
        const stop = jest.fn(() => control.release());
        const control = acquirePlaybackControl(stop);
        expect(stopControlledPlayback()).toBe(true);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(stopControlledPlayback()).toBe(false);
        expect(par.paused).toBe(true);
    });
});
