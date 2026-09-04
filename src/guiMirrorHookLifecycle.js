/**
 * Replace an object's property and remember its exact prior state for cleanup.
 * This also handles properties that did not originally exist.
 */
export function replacePropertyWithCleanup(target, property, replacement, cleanupActions) {
    const hadOwnProperty = Object.prototype.hasOwnProperty.call(target, property);
    const originalValue = target[property];

    cleanupActions.push(() => {
        if (hadOwnProperty) {
            target[property] = originalValue;
        } else {
            delete target[property];
        }
    });

    target[property] = replacement;
    return originalValue;
}

/**
 * Wrap a controller's destroy method for one mirror lifecycle.
 */
export function hookMirrorControllerDestroy(controller, onDestroy, cleanupActions) {
    if (controller._mirrorHooked || typeof controller.destroy !== "function") return false;

    replacePropertyWithCleanup(controller, "_mirrorHooked", true, cleanupActions);
    const originalDestroy = controller.destroy;
    replacePropertyWithCleanup(controller, "destroy", (...args) => {
        const result = originalDestroy.apply(controller, args);
        onDestroy();
        return result;
    }, cleanupActions);
    return true;
}

export function runMirrorHookCleanup(cleanupActions) {
    for (let i = cleanupActions.length - 1; i >= 0; i--) {
        cleanupActions[i]();
    }
    cleanupActions.length = 0;
}
