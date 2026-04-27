import {hasPausedBackgroundWork, shouldSleepAnimationLoop} from "../src/renderLoopControl";

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

    test("ignores controllers and paused nodes without an update hook", () => {
        expect(hasPausedBackgroundWork({
            controller: {data: {isController: true, update() {}, updateWhilePaused: true}},
            inert: {data: {updateWhilePaused: true}},
        })).toBe(false);
    });
});