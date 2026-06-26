import {hasPausedBackgroundWork, shouldSleepAnimationLoop} from "../src/renderLoopControl";

describe("render loop sleep control", () => {
    test("sleeps immediately when the page is hidden", () => {
        expect(shouldSleepAnimationLoop({
            hidden: true,
            focused: true,
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
            focused: true,
            paused: true,
            renderOne: false,
            nodeList: {},
        })).toBe(true);
    });

    test("stays awake when a paused node still needs background updates", () => {
        expect(shouldSleepAnimationLoop({
            hidden: false,
            focused: true,
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
            focused: true,
            paused: true,
            renderOne: true,
            nodeList: {},
        })).toBe(false);
    });

    test("sleeps when paused and the window is unfocused, even with background work pending", () => {
        expect(shouldSleepAnimationLoop({
            hidden: false,
            focused: false,
            paused: true,
            renderOne: false,
            nodeList: {
                terrain: {data: {update() {}, updateWhilePaused: true}},
            },
        })).toBe(true);
    });

    test("stays awake when playing and the window is unfocused", () => {
        expect(shouldSleepAnimationLoop({
            hidden: false,
            focused: false,
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
