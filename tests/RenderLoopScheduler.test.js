import {RenderLoopScheduler} from "../src/RenderLoopScheduler";

function harness(hidden = false) {
    let nextId = 0;
    const frames = new Map(), timers = new Map();
    const run = jest.fn(), now = jest.fn(() => 1234);
    const requestFrame = jest.fn(callback => { const id = ++nextId; frames.set(id, callback); return id; });
    const cancelFrame = jest.fn(id => frames.delete(id));
    const setTimer = jest.fn((callback, delay) => { const id = ++nextId; timers.set(id, {callback, delay}); return id; });
    const clearTimer = jest.fn(id => timers.delete(id));
    const scheduler = new RenderLoopScheduler({run, hidden, requestFrame, cancelFrame, setTimer, clearTimer, now});
    return {scheduler, run, frames, timers, requestFrame, cancelFrame, setTimer, clearTimer, now};
}

test("visible work uses one display callback and its timestamp, regardless of timer delay", () => {
    const h = harness();
    h.scheduler.schedule(33);
    h.scheduler.schedule();
    expect(h.requestFrame).toHaveBeenCalledTimes(1);
    expect(h.setTimer).not.toHaveBeenCalled();
    const callback = [...h.frames.values()][0];
    callback(42.125);
    expect(h.run).toHaveBeenCalledWith(42.125, true);
    expect(h.scheduler.pending).toBeNull();
    expect(h.now).not.toHaveBeenCalled();
});

test("hidden timers use wall time and retain the requested delay", () => {
    const h = harness(true);
    h.scheduler.schedule(12.5);
    expect(h.requestFrame).not.toHaveBeenCalled();
    const timer = [...h.timers.values()][0];
    expect(timer.delay).toBe(12.5);
    timer.callback();
    expect(h.run).toHaveBeenCalledWith(1234, false);
    expect(h.scheduler.pending).toBeNull();
});

test("cancel uses the matching API and an already queued callback cannot revive the loop", () => {
    for (const hidden of [false, true]) {
        const h = harness(hidden);
        h.scheduler.schedule();
        const pending = h.scheduler.pending;
        const stale = hidden ? h.timers.get(pending.id).callback : h.frames.get(pending.id);
        h.scheduler.cancel();
        h.scheduler.schedule();
        const replacement = h.scheduler.pending;
        stale(99);
        expect(h.run).not.toHaveBeenCalled();
        expect(h.scheduler.pending).toBe(replacement);
        expect(hidden ? h.clearTimer : h.cancelFrame).toHaveBeenCalledWith(pending.id);
        expect(hidden ? h.cancelFrame : h.clearTimer).not.toHaveBeenCalled();
    }
});

test("visibility transitions transfer pending MCP work between rAF and timers", () => {
    const h = harness();
    h.scheduler.schedule();
    const frame = h.scheduler.pending;
    const staleFrame = h.frames.get(frame.id);
    h.scheduler.setHidden(true);
    expect(h.cancelFrame).toHaveBeenCalledWith(frame.id);
    expect(h.scheduler.pending.kind).toBe("timer");
    const timer = h.scheduler.pending;
    const staleTimer = h.timers.get(timer.id).callback;
    h.scheduler.setHidden(false);
    expect(h.clearTimer).toHaveBeenCalledWith(timer.id);
    expect(h.scheduler.pending.kind).toBe("frame");
    staleFrame(20);
    staleTimer();
    expect(h.run).not.toHaveBeenCalled();
    h.frames.get(h.scheduler.pending.id)(50);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.run).toHaveBeenCalledWith(50, true);
});

test("a normal hidden tab sleeps; foreground wake schedules only one new callback", () => {
    const h = harness();
    h.scheduler.schedule();
    h.scheduler.setHidden(true, false);
    expect(h.scheduler.pending).toBeNull();
    expect(h.setTimer).not.toHaveBeenCalled();
    h.scheduler.runPending();
    h.scheduler.setHidden(false);
    expect(h.scheduler.pending).toBeNull();
    h.scheduler.schedule();
    h.scheduler.schedule();
    expect(h.requestFrame).toHaveBeenCalledTimes(2);
    expect(h.run).not.toHaveBeenCalled();
});

test("worker heartbeat drains one scheduled timer without waking an idle paused loop", () => {
    const h = harness(true);
    h.scheduler.runPending();
    expect(h.run).not.toHaveBeenCalled();
    h.scheduler.schedule(1000);
    const timer = h.scheduler.pending;
    const staleTimer = h.timers.get(timer.id).callback;
    h.scheduler.runPending();
    expect(h.clearTimer).toHaveBeenCalledWith(timer.id);
    expect(h.run).toHaveBeenCalledWith(1234, false);
    staleTimer();
    h.scheduler.runPending();
    expect(h.run).toHaveBeenCalledTimes(1);
});

test("a running callback can schedule its successor and repeated visibility state is a no-op", () => {
    const h = harness();
    h.run.mockImplementation(() => h.scheduler.schedule());
    h.scheduler.schedule();
    const first = h.scheduler.pending;
    h.scheduler.setHidden(false);
    expect(h.scheduler.pending).toBe(first);
    h.frames.get(first.id)(16.7);
    expect(h.scheduler.pending).not.toBe(first);
    expect(h.requestFrame).toHaveBeenCalledTimes(2);
});
