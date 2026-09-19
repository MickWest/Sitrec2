/** @jest-environment jsdom */
import {DragDropHandler} from "../src/DragDropHandler";
import {FileManager, setFileManager} from "../src/Globals";
import {par} from "../src/par";
import {shouldSleepAnimationLoop} from "../src/renderLoopControl";

let previous;
beforeEach(() => {
    jest.useFakeTimers();
    previous = {fileManager: FileManager, wake: globalThis.__sitrecWakeRenderLoop,
        renderOne: par.renderOne, paused: par.paused, queue: DragDropHandler.dropQueue};
    DragDropHandler.dropQueue = [];
    par.paused = true;
    par.renderOne = false;
    setFileManager({parseResult: jest.fn().mockResolvedValue({changesSerializedState: false})});
    // Match the loop's wake contract: schedule a tick, then drain the queue.
    globalThis.__sitrecWakeRenderLoop = jest.fn(() => setTimeout(() => {
        DragDropHandler.checkDropQueue();
        par.renderOne = false;
    }, 0));
});

afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    setFileManager(previous.fileManager);
    globalThis.__sitrecWakeRenderLoop = previous.wake;
    par.renderOne = previous.renderOne;
    par.paused = previous.paused;
    DragDropHandler.dropQueue = previous.queue;
});

test("a file read that finishes after the paused loop sleeps is parsed without interaction", async () => {
    const sleeps = () => shouldSleepAnimationLoop({hidden: false, paused: par.paused,
        renderOne: par.renderOne, nodeList: {}});
    expect(sleeps()).toBe(true);
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    // FileReader completion arrives after the interaction's last frame.
    setTimeout(() => DragDropHandler.queueResult("track.csv", bytes, null), 50);
    jest.advanceTimersByTime(50);
    expect(sleeps()).toBe(false);
    expect(FileManager.parseResult).not.toHaveBeenCalled();
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    expect(FileManager.parseResult).toHaveBeenCalledWith("track.csv", bytes, null, {returnMeta: true});
    expect(DragDropHandler.dropQueue).toEqual([]);
    expect(sleeps()).toBe(true);
});

test("multiple completed files share the pending wake and all reach the parser", async () => {
    const bytes = new ArrayBuffer(0);
    DragDropHandler.queueResult("one.csv", bytes, null);
    DragDropHandler.queueResult("two.csv", bytes, "https://example.com/two.csv");
    expect(globalThis.__sitrecWakeRenderLoop).toHaveBeenCalledTimes(1);
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    expect(FileManager.parseResult.mock.calls.map(args => args[0])).toEqual(["one.csv", "two.csv"]);
    expect(DragDropHandler.dropQueue).toEqual([]);
    expect(par.renderOne).toBe(false);
});
