import {DISPLAY_FRAME_TOLERANCE_MS, frameClockStep, hasPausedBackgroundWork, renderCadence, shouldSleepAnimationLoop} from "../src/renderLoopControl";

// The render loop is gated ONLY on tab visibility (hidden) — never on OS window focus. A visible
// tab does its work (requested renders + finite background work) whether or not its window is the
// foreground OS window; it sleeps only when hidden, or when paused with nothing pending and no
// background work. (See renderLoopControl.ts for why focus gating was removed.)
describe("render loop sleep control", () => {
    test("sleeps immediately when the page is hidden", () => {
        expect(shouldSleepAnimationLoop({
            hidden: true,
            paused: false,
            renderOne: false,
            nodeList: {
                terrain: {data: {update() {}, updateWhilePaused: true}},
            },
        })).toBe(true);
    });

    test("forceRender keeps the loop awake even when hidden, paused, and unfocused", () => {
        // Debug/MCP override: __sitrecForceRender(true) sets this so a backgrounded
        // tab keeps rendering (terrain subdivision / tile loading) for inspection.
        expect(shouldSleepAnimationLoop({
            hidden: true,
            focused: false,
            paused: true,
            renderOne: false,
            nodeList: {},
            forceRender: true,
        })).toBe(false);
    });

    test("sleeps when paused and nothing requested a redraw", () => {
        expect(shouldSleepAnimationLoop({
            hidden: false,
            paused: true,
            renderOne: false,
            nodeList: {},
        })).toBe(true);
    });

    test("stays awake when a paused node still needs background updates", () => {
        expect(shouldSleepAnimationLoop({
            hidden: false,
            paused: true,
            renderOne: false,
            nodeList: {
                terrain: {data: {update() {}, updateWhilePaused: true}},
            },
        })).toBe(false);
    });

    test("stays awake when a one-off render was requested while paused", () => {
        expect(shouldSleepAnimationLoop({
            hidden: false,
            paused: true,
            renderOne: true,
            nodeList: {},
        })).toBe(false);
    });

    // Regression (missing-tiles-when-unfocused): a VISIBLE tab with background work pending — e.g.
    // terrain LOD subdivision still settling — must stay awake regardless of OS window focus.
    // The old `paused && !focused → sleep` gate froze this work on a visible-but-unfocused window,
    // so tiles never finished loading until the user interacted. Focus is no longer even an input.
    test("stays awake on a visible tab with background work pending (focus is irrelevant)", () => {
        expect(shouldSleepAnimationLoop({
            hidden: false,
            paused: true,
            renderOne: false,
            nodeList: {
                terrain: {data: {update() {}, updateWhilePaused: true}},
            },
        })).toBe(false);
    });

    // Regression (changes-don't-paint): an explicitly requested render must always run.
    test("stays awake when a render is requested while paused", () => {
        expect(shouldSleepAnimationLoop({
            hidden: false,
            paused: true,
            renderOne: true,
            nodeList: {},
        })).toBe(false);
    });

    test("stays awake when playing", () => {
        expect(shouldSleepAnimationLoop({
            hidden: false,
            paused: false,
            renderOne: false,
            nodeList: {},
        })).toBe(false);
    });

    test("ignores controllers and paused nodes without an update hook", () => {
        expect(hasPausedBackgroundWork({
            controller: {data: {isController: true, update() {}, updateWhilePaused: true}},
            inert: {data: {updateWhilePaused: true}},
        })).toBe(false);
    });
});

describe("playback render cadence", () => {
    const state = {renderFps: 30, sourceFps: 30000 / 1001, adaptiveFps: 60,
        playing: true, logicTime: 12, renderTime: 0};
    test("never draws before the next source frame at a matching display cap", () => {
        let logicTime = state.logicTime, renderTime = 0, frames = 0;
        const interval = 1000 / state.sourceFps;
        for (let now = 0; now < 10000; now += 4.1) {
            const cadence = renderCadence({...state, logicTime, renderTime});
            if (now - cadence.origin < cadence.interval) continue;
            const elapsed = now - logicTime;
            expect(elapsed).toBeGreaterThanOrEqual(interval);
            const count = Math.floor(elapsed / interval);
            frames += count;
            logicTime += count * interval;
            renderTime = now;
        }
        expect(frames).toBeGreaterThanOrEqual(298);
    });
    test("retains display-rate redraws between source frames and while paused", () => {
        expect(renderCadence({...state, renderFps: 60})).toEqual({interval: 1000 / 60, origin: 0});
        expect(renderCadence({...state, playing: false})).toEqual({interval: 1000 / 30, origin: 0});
    });
    test("shares the slower logic clock when the cap or adaptive rate limits playback", () => {
        expect(renderCadence({...state, sourceFps: 60})).toEqual({interval: 1000 / 30, origin: 12});
        expect(renderCadence({...state, adaptiveFps: 20})).toEqual({interval: 50, origin: 12});
    });
});

describe("display-clock pacing", () => {
    function playback({renderFps, sourceFps, displayFps = 60, seconds = 10, jitter = 0}) {
        let logicTime = 0, renderTime = 0, sourceFrames = 0;
        const draws = [];
        const logicInterval = 1000 / Math.min(renderFps, sourceFps);
        for (let refresh = 1; refresh <= seconds * displayFps; refresh++) {
            const now = refresh * 1000 / displayFps + (refresh % 2 ? jitter : -jitter);
            const cadence = renderCadence({renderFps, sourceFps, adaptiveFps: 60,
                playing: true, logicTime, renderTime});
            const render = frameClockStep(now, cadence.origin, cadence.interval, DISPLAY_FRAME_TOLERANCE_MS);
            if (!render.due) continue;
            const logic = frameClockStep(now, logicTime, logicInterval, DISPLAY_FRAME_TOLERANCE_MS);
            if (logic.due) {
                sourceFrames += logic.elapsed * sourceFps / 1000;
                logicTime = logic.time;
            }
            renderTime = render.time;
            draws.push({refresh, now, logic: logic.due});
        }
        return {draws, sourceFrames, logicTime, renderTime};
    }

    test.each([60, 30])("%i Hz playback keeps its rate despite alternating early/late rAF timestamps", fps => {
        const result = playback({renderFps: fps, sourceFps: fps, jitter: 0.3});
        expect(result.draws).toHaveLength(10 * fps);
        expect(result.sourceFrames).toBeCloseTo(10 * fps, 7);
        expect(result.logicTime).toBeCloseTo(10000, 7);
        expect(result.draws.every((draw, i) => !i
            || draw.refresh - result.draws[i - 1].refresh === 60 / fps)).toBe(true);
    });

    test("Quality draws each refresh while 30 Hz source logic advances every second refresh", () => {
        const result = playback({renderFps: 60, sourceFps: 30, jitter: 0.3});
        expect(result.draws).toHaveLength(600);
        expect(result.sourceFrames).toBeCloseTo(300, 7);
        expect(result.draws.filter(draw => draw.logic).map(draw => draw.refresh))
            .toEqual(Array.from({length: 300}, (_, i) => 2 * (i + 1)));
    });

    test.each([30, 60])("29.97 Hz playback at a %i Hz cap retains the source rate over two minutes", renderFps => {
        const sourceFps = 30000 / 1001;
        const result = playback({renderFps, sourceFps, seconds: 120, jitter: 0.2});
        const expected = Math.floor((120000 - 0.2 + DISPLAY_FRAME_TOLERANCE_MS) * sourceFps / 1000);
        expect(result.sourceFrames).toBeCloseTo(expected, 6);
        expect(result.draws).toHaveLength(renderFps === 60 ? 7200 : expected);
        expect(result.logicTime).toBeCloseTo(expected * 1000 / sourceFps, 6);
    });

    test.each([30, 60])("%i Hz cap does not speed up on a 120 Hz display", fps => {
        const result = playback({renderFps: fps, sourceFps: fps, displayFps: 120, jitter: 0.2});
        expect(result.draws).toHaveLength(10 * fps);
        expect(result.sourceFrames).toBeCloseTo(10 * fps, 7);
    });

    test("an early accepted refresh advances to the deadline and cannot count twice", () => {
        const interval = 1000 / 60;
        const early = frameClockStep(interval - 0.2, 0, interval, DISPLAY_FRAME_TOLERANCE_MS);
        expect(early.due).toBe(true);
        expect(early.time).toBe(interval);
        expect(early.elapsed).toBe(interval);
        expect(frameClockStep(interval + 0.2, early.time, interval, DISPLAY_FRAME_TOLERANCE_MS).due).toBe(false);
        expect(frameClockStep(interval - 0.2, 0, interval).due).toBe(false);
    });

    test("a long stall advances whole missed periods once and retains the original phase", () => {
        const interval = 1000 / 30, origin = 7;
        const late = frameClockStep(254, origin, interval, DISPLAY_FRAME_TOLERANCE_MS);
        expect(late.due).toBe(true);
        expect(late.elapsed).toBe(7 * interval);
        expect(late.time).toBe(origin + 7 * interval);
        const next = frameClockStep(origin + 8 * interval - 0.1, late.time, interval, DISPLAY_FRAME_TOLERANCE_MS);
        expect(next.due).toBe(true);
        expect(next.elapsed).toBeCloseTo(interval, 10);
        expect(next.time).toBeCloseTo(origin + 8 * interval, 10);
    });
});
