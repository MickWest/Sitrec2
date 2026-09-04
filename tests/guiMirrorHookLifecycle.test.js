import {
    hookMirrorControllerDestroy,
    replacePropertyWithCleanup,
    runMirrorHookCleanup,
} from "../src/guiMirrorHookLifecycle";

describe("GUI mirror hook lifecycle", () => {
    test("controller destroy hooks are fully restored and can be installed again", () => {
        const originalDestroy = jest.fn(function (suffix) {
            return `${this.id}:${suffix}`;
        });
        const controller = {id: "source", destroy: originalDestroy};
        const firstCleanup = [];
        const firstUpdate = jest.fn();

        expect(hookMirrorControllerDestroy(controller, firstUpdate, firstCleanup)).toBe(true);
        expect(controller._mirrorHooked).toBe(true);
        expect(controller.destroy("first")).toBe("source:first");
        expect(firstUpdate).toHaveBeenCalledTimes(1);

        runMirrorHookCleanup(firstCleanup);
        expect(controller.destroy).toBe(originalDestroy);
        expect(Object.prototype.hasOwnProperty.call(controller, "_mirrorHooked")).toBe(false);

        const secondCleanup = [];
        const secondUpdate = jest.fn();
        expect(hookMirrorControllerDestroy(controller, secondUpdate, secondCleanup)).toBe(true);
        expect(controller.destroy("second")).toBe("source:second");
        expect(firstUpdate).toHaveBeenCalledTimes(1);
        expect(secondUpdate).toHaveBeenCalledTimes(1);
    });

    test("cleanup restores an existing property and removes a newly added one", () => {
        const target = {existing: "before"};
        const cleanupActions = [];

        replacePropertyWithCleanup(target, "existing", "after", cleanupActions);
        replacePropertyWithCleanup(target, "temporary", true, cleanupActions);
        runMirrorHookCleanup(cleanupActions);

        expect(target.existing).toBe("before");
        expect(Object.prototype.hasOwnProperty.call(target, "temporary")).toBe(false);
    });

    test("an active hook is not wrapped twice", () => {
        const controller = {destroy: jest.fn()};
        const cleanupActions = [];
        expect(hookMirrorControllerDestroy(controller, jest.fn(), cleanupActions)).toBe(true);
        const wrappedDestroy = controller.destroy;

        expect(hookMirrorControllerDestroy(controller, jest.fn(), cleanupActions)).toBe(false);
        expect(controller.destroy).toBe(wrappedDestroy);
    });
});
