import {MessageChannel as NodeMessageChannel} from "node:worker_threads";
import {yieldStarAnalysis} from "../src/starTrack/StarAnalysisYield";

const schedulerBefore = globalThis.scheduler;
const channelBefore = globalThis.MessageChannel;
afterEach(() => {
    globalThis.scheduler = schedulerBefore;
    globalThis.MessageChannel = channelBefore;
    jest.useRealTimers();
});

test("uses the browser task scheduler without creating a throttled timer", async () => {
    jest.useFakeTimers();
    globalThis.scheduler = {yield: jest.fn(() => Promise.resolve())};
    await yieldStarAnalysis();
    expect(globalThis.scheduler.yield).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
});

test("message fallback yields beyond microtasks and closes both ports", async () => {
    globalThis.scheduler = undefined;
    let channel;
    globalThis.MessageChannel = class {
        constructor() {
            channel = new NodeMessageChannel();
            jest.spyOn(channel.port1, "close");
            jest.spyOn(channel.port2, "close");
            return channel;
        }
    };
    const order = [];
    const task = yieldStarAnalysis().then(() => order.push("task"));
    await Promise.resolve().then(() => order.push("microtask"));
    expect(order).toEqual(["microtask"]);
    await task;
    expect(order).toEqual(["microtask", "task"]);
    expect(channel.port1.close).toHaveBeenCalledTimes(1);
    expect(channel.port2.close).toHaveBeenCalledTimes(1);
});

test("runtimes with neither API retain the timer fallback", async () => {
    jest.useFakeTimers();
    globalThis.scheduler = undefined;
    globalThis.MessageChannel = undefined;
    let done = false;
    const task = yieldStarAnalysis().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(jest.getTimerCount()).toBe(1);
    jest.runOnlyPendingTimers();
    await task;
    expect(done).toBe(true);
});
