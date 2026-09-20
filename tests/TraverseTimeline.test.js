import {TraverseTimeline} from "../src/TraverseTimeline";

describe("traverse gallery timeline", () => {
    let now, queued, nextId, changed, timeline;
    const advance = time => {
        now = time;
        const callbacks = [...queued.values()];
        queued.clear();
        callbacks.forEach(callback => callback(time));
    };
    beforeEach(() => {
        now = 0; nextId = 0; queued = new Map(); changed = jest.fn();
        jest.spyOn(performance, "now").mockImplementation(() => now);
        global.requestAnimationFrame = callback => { queued.set(++nextId, callback); return nextId; };
        global.cancelAnimationFrame = id => queued.delete(id);
        timeline = new TraverseTimeline({frameCount: 1200, fps: 10, onChange: changed});
    });
    afterEach(() => {
        timeline.dispose();
        jest.restoreAllMocks();
        delete global.requestAnimationFrame;
        delete global.cancelAnimationFrame;
    });

    test("uses real elapsed time at dataset fps even when renders are delayed", () => {
        timeline.toggle();
        advance(25);
        expect(timeline.frame).toBe(0);
        advance(1000);
        expect(timeline.frame).toBe(10);
        advance(4250);
        expect(timeline.frame).toBe(42);
    });

    test("pause and resume do not count paused time", () => {
        timeline.toggle(); advance(1000); timeline.toggle();
        expect(queued.size).toBe(0);
        advance(11000);
        expect(timeline.frame).toBe(10);
        timeline.toggle(); advance(12000);
        expect(timeline.frame).toBe(20);
    });

    test("scrubbing during playback resets the clock to the chosen frame", () => {
        timeline.toggle(); advance(1000);
        timeline.seek(600); advance(1500);
        expect(timeline.frame).toBe(605);
        expect(timeline.playing).toBe(true);
    });

    test("stops on the final frame and can restart from the beginning", () => {
        timeline.seek(1198); timeline.toggle(); advance(1000);
        expect(timeline.frame).toBe(1199);
        expect(timeline.playing).toBe(false);
        expect(queued.size).toBe(0);
        timeline.toggle();
        expect(timeline.frame).toBe(0);
        advance(1100);
        expect(timeline.frame).toBe(1);
    });

    test("closing the gallery cancels playback and prevents late callbacks", () => {
        timeline.toggle();
        const pending = [...queued.values()][0];
        timeline.dispose();
        expect(queued.size).toBe(0);
        changed.mockClear();
        pending(1000); timeline.seek(500); timeline.toggle();
        expect(changed).not.toHaveBeenCalled();
        expect(queued.size).toBe(0);
    });

    test("one-frame results do not start an animation loop", () => {
        timeline.dispose();
        timeline = new TraverseTimeline({frameCount: 1, fps: 30, onChange: changed});
        timeline.toggle();
        expect(timeline.playing).toBe(false);
        expect(queued.size).toBe(0);
    });
});
