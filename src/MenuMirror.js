// Mirror individual lil-gui controllers into other menus.
//
// Surfaces a single existing control (e.g. the Settings "AI Model" dropdown) inside another
// menu (e.g. a per-view header menu) WITHOUT duplicating its logic. The mirror and the source
// bind to the SAME object[property], so changing either updates the shared value; .listen()
// keeps both displays in sync. For dropdowns the option list is copied, and any later
// source.options()/.name()/.tooltip() change propagates to every mirror.
//
// Order-independent: a source registers by key when it's created; a consumer requests a mirror
// by key into a target menu. Whichever runs second wires them up — so it doesn't matter whether
// the Settings menu or the view header is built first.
//
//   registerMirrorSource("chatModel", controller)        // producer side (Settings)
//   mirrorMenuItem("chatModel", someGui, {name: "..."})  // consumer side (view header)
//
// Reusable for the many "show this Settings control in a view header" mirrors to come.

const sources = new Map();            // key -> source controller
const consumers = new Map();          // key -> [{gui, opts}, ...] requested before source existed
const mirrorsBySource = new WeakMap(); // source controller -> [twin controller, ...]

// Register a controller as a mirror source under `key`. Fulfils any pending mirror requests.
export function registerMirrorSource(key, controller) {
    if (!key || !controller) return;
    sources.set(key, controller);
    patchSourcePropagation(controller);
    const waiting = consumers.get(key);
    if (waiting) {
        for (const {gui, opts} of waiting) createMirror(controller, gui, opts);
        consumers.delete(key);
    }
}

// Add a mirror of source `key` into `targetGui`. If the source isn't registered yet the request
// is queued and created when registerMirrorSource(key, ...) runs. Returns the twin (or null if
// deferred). opts: {name, tooltip} override the mirrored label/tooltip.
export function mirrorMenuItem(key, targetGui, opts = {}) {
    if (!key || !targetGui) return null;
    const source = sources.get(key);
    if (source) return createMirror(source, targetGui, opts);
    if (!consumers.has(key)) consumers.set(key, []);
    consumers.get(key).push({gui: targetGui, opts});
    return null;
}

// Forget all sources + pending requests. Call on sitch teardown so controllers/menus from the
// previous sitch (now disposed) don't leak or get mirrored into.
export function clearMenuMirrors() {
    sources.clear();
    consumers.clear();
}

// Re-align a registered source and all its mirrors to the current bound value. Call this after
// changing object[property] WITHOUT going through the controller (e.g. a direct settings
// assignment + bare updateDisplay()), which otherwise updates only the source's own <select>
// and leaves the mirrors stale.
export function syncMirroredSource(key) {
    const source = sources.get(key);
    if (source) syncMirrors(source);
}

function isDropdown(controller) {
    return controller && controller._names !== undefined && controller._values !== undefined;
}

function optionsObject(controller) {
    const o = {};
    (controller._names || []).forEach((n, i) => { o[n] = controller._values[i]; });
    return o;
}

function createMirror(source, targetGui, opts) {
    let twin;
    if (isDropdown(source)) {
        twin = targetGui.add(source.object, source.property, optionsObject(source));
    } else {
        twin = targetGui.add(source.object, source.property);
    }
    twin.name(opts.name ?? source._name ?? source.property);
    const tip = opts.tooltip ?? source._tooltip;
    if (tip && typeof twin.tooltip === "function") twin.tooltip(tip);

    // Capture the source's real side effect (e.g. saveGlobalSettings) and ensure BOTH the
    // source and every mirror run it + refresh all displays when changed. We sync displays
    // explicitly (not via .listen(), whose RAF loop isn't active for a per-view header menu).
    const sideEffect = wrapSourceOnChange(source);
    twin.onChange(() => { if (sideEffect) sideEffect(); syncMirrors(source); });

    let twins = mirrorsBySource.get(source);
    if (!twins) { twins = []; mirrorsBySource.set(source, twins); }
    twins.push(twin);

    syncMirrors(source);   // initial display alignment
    return twin;
}

// Force a controller's <select> to re-sync to the bound value. lil-gui's updateDisplay() skips
// when value === _lastDisplayedValue, but OptionController.options() rebuilds the <select>
// (resetting selectedIndex to 0) WITHOUT clearing that cache — so after an option-list refresh
// the display can be stuck on the wrong item. Clearing the cache first defeats that guard.
function forceUpdateDisplay(controller) {
    if (!controller) return;
    controller._lastDisplayedValue = undefined;
    if (typeof controller.updateDisplay === "function") controller.updateDisplay();
}

// Refresh the source's display and all its mirrors from the shared bound value.
function syncMirrors(source) {
    forceUpdateDisplay(source);
    for (const t of (mirrorsBySource.get(source) || [])) forceUpdateDisplay(t);
}

// Wrap the source's onChange ONCE so changing the source (its own UI) also refreshes the
// mirrors. Returns the source's original side-effect callback (for the mirrors to reuse).
function wrapSourceOnChange(source) {
    if (source._menuMirrorOnChangeWrapped) return source._menuMirrorSideEffect ?? null;
    source._menuMirrorOnChangeWrapped = true;
    const original = typeof source._onChange === "function" ? source._onChange : null;
    source._menuMirrorSideEffect = original;
    source.onChange(() => { if (original) original(); syncMirrors(source); });
    return original;
}

// Patch a source dropdown so that updating its option list (the async model fetch calls
// controller.options(...)) also updates every mirror's list. The fork's OptionController.options
// mutates in place and returns `this`, so the source reference stays stable.
function patchSourcePropagation(source) {
    if (!isDropdown(source) || source._menuMirrorPatched) return;
    source._menuMirrorPatched = true;
    const origOptions = source.options.bind(source);
    source.options = (newOptions) => {
        const result = origOptions(newOptions);
        // Copy the refreshed option list to every mirror, then force ALL displays (source
        // included) back to the shared value — repairing the stale-selectedIndex left by the
        // <select> rebuild.
        const o = optionsObject(source);
        for (const t of (mirrorsBySource.get(source) || [])) t.options(o);
        syncMirrors(source);
        return result;
    };
}
