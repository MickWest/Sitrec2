import {par, resetPar} from "../src/par";

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
});