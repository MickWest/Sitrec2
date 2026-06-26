import {hasPausedBackgroundWork, shouldSleepAnimationLoop} from "../src/renderLoopControl";

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
