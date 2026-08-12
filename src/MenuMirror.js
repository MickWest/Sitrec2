// Mirror individual lil-gui controllers into other menus.
//
// Surfaces an existing control (e.g. the Show menu's "Labels in Look" checkbox) inside
// another menu (e.g. the look view's header menu) WITHOUT duplicating its logic. The twin and
// the source bind to the SAME object[property], so there is ONE piece of state and ONE side
// effect: changing either writes the same value, runs the source's own onChange, and then
// refreshes every display. Nothing downstream can tell which row the user clicked.
//
// Order-independent. A source registers by key when it is created; a consumer asks for a
// mirror by key into a target menu. Whichever runs second wires them up, so it does not matter
// whether the Show menu or the view header is built first:
//
//   registerMirrorSource("view:lookView:labels", controller)    // producer side
//   mirrorMenuItem("view:lookView:labels", headerGui, {...})    // consumer side
//
// Kept in sync source -> twin: value, label, tooltip, visibility, option list, and (for
// sliders) min/max — the last because an elastic slider grows its own max as you drag it.
// Twins are ordinary lil-gui controllers in the target menu; no other code special-cases them.
//
// A twin also inherits the source's `.listen()`, which is what makes a mirror survive changes
// that never touch a controller at all — a sitch load writing the flag straight onto the node,
// the API, a script. That only works if the twin's menu is a POLLED root: see
// src/GUIRootRegistry.js, and note that a menu which forgets to register gets a twin that is
// correct when built and then drifts, which is the failure this is here to prevent.
//
// Register AFTER the source's `.name().tooltip().onChange()` chain: registration captures the
// onChange in place at that moment, and a later `.onChange()` on the source would replace the
// wrapper that keeps the twins in step. `.shareAs()` chains, so this is natural:
//
//   guiShowHide.add(Globals, "showLabelsLook").name("Labels in Look").listen()
//       .shareAs(viewMenuKey("lookView", "labels"))
//
// Lifecycle. Requests are REMEMBERED rather than consumed, so a source destroyed and
// re-created under the same key (the video Rotation dropdown does this on every video load)
// rebuilds its twins instead of stacking a second copy of every row. clearMenuMirrors() drops
// what a sitch teardown invalidates and keeps only `.perm()` sources, which are exactly the
// ones that survive menuBar.destroy(false).

import GUI, {Controller} from "./js/lil-gui.esm";

const sources = new Map();      // key -> source controller
const requests = new Map();     // key -> [{gui, opts}, ...]  (kept for rebuilds, see above)
const twins = new Map();        // key -> [twin controller, ...]

// Register a controller as the mirror source for `key`, replacing any previous source (whose
// twins are torn down first). Fulfils every outstanding mirror request. Returns the controller,
// so it can wrap a call chain in place.
export function registerMirrorSource(key, controller) {
    if (!key || !controller) return controller ?? null;
    if (sources.get(key) === controller) return controller;
    destroyTwins(key);
    sources.set(key, controller);
    patchSource(key, controller);
    for (const {gui, opts} of liveRequests(key)) createMirror(key, gui, opts);
    return controller;
}

// Add a mirror of source `key` into `targetGui`. If the source is not registered yet the
// request is remembered and fulfilled when registerMirrorSource(key, ...) runs. Returns the
// twin, or null if it was deferred. opts: {name, tooltip} override the mirrored label/tooltip;
// opts.onMirror(twin) fires whenever a twin for this request is created (including rebuilds).
export function mirrorMenuItem(key, targetGui, opts = {}) {
    if (!key || !targetGui) return null;
    if (!requests.has(key)) requests.set(key, []);
    requests.get(key).push({gui: targetGui, opts});
    return sources.has(key) ? createMirror(key, targetGui, opts) : null;
}

// Forget everything a sitch teardown invalidates: all pending requests, and every source whose
// controller is about to be destroyed. `.perm()` controllers survive menuBar.destroy(false), so
// their registration survives too — otherwise a permanent control (the video Masking toggles)
// would mirror correctly into the first sitch's views and silently into none after that. Their
// twins are still dropped: those lived in the view menus that are going away.
export function clearMenuMirrors() {
    for (const [key, source] of [...sources]) {
        twins.delete(key);
        if (!source.permanent) sources.delete(key);
    }
    requests.clear();
}

// Re-align a registered source and all its twins to the current bound value. Call this after
// changing object[property] WITHOUT going through the controller (e.g. a direct settings
// assignment + bare updateDisplay()), which otherwise updates only the source's own widget.
export function syncMirroredSource(key) {
    if (sources.has(key)) syncMirrors(key);
}

// --- twin creation -------------------------------------------------------------------------

function createMirror(key, targetGui, opts) {
    const source = sources.get(key);
    const twin = buildTwin(source, targetGui, opts);
    if (!twin) return null;

    // The twin has already written the shared value by the time this runs; all that is left is
    // the source's real side effect (recalculate, setRenderOne, saveGlobalSettings, ...) and
    // bringing every other display into line.
    twin.onChange(() => {
        const sideEffect = sources.get(key)?._menuMirrorSideEffect;
        if (sideEffect) sideEffect.call(sources.get(key), twin.getValue());
        syncMirrors(key);
    });

    if (!twins.has(key)) twins.set(key, []);
    twins.get(key).push(twin);

    syncMirrors(key);            // initial display alignment
    opts.onMirror?.(twin);
    return twin;
}

// Build a faithful twin of `source` in `targetGui` — same binding, same kind, same look — and
// wire the twin -> source direction. The key-registry layer above adds the source -> twin
// direction; `mirrorTo()` (below) uses this on its own for one-off, unkeyed clones.
function buildTwin(source, targetGui, opts = {}) {
    const twin = addTwin(source, targetGui);
    if (!twin) return null;

    twin.name(opts.name ?? source._name ?? source.property);
    // A caller-supplied label is deliberate shorthand for its context ("Labels" inside the Look
    // header, not "Labels in Look"), so a later source rename must not overwrite it.
    twin._menuMirrorFixedName = opts.name !== undefined;
    const tip = opts.tooltip ?? source._tooltip;
    if (tip && typeof twin.tooltip === "function") twin.tooltip(tip);
    if (source._labelColor && typeof twin.setLabelColor === "function") twin.setLabelColor(source._labelColor);
    twin.show(!source._hidden);

    // Unit metadata is COPIED rather than re-applied through setUnitType(): the name already
    // carries the unit suffix and the bound value is already in display units, so converting
    // again would double-suffix and double-scale.
    if (source._unitType !== undefined) {
        twin._unitType = source._unitType;
        twin._originalName = source._originalName;
        twin._originalMinSI = source._originalMinSI;
        twin._originalMaxSI = source._originalMaxSI;
        twin._originalStepSI = source._originalStepSI;
    }

    // onFinishChange is where text fields do their parsing (a track start time, a coordinate),
    // so a twin without it accepts the typing and silently drops it.
    if (typeof source._onFinishChange === "function" && typeof twin.onFinishChange === "function") {
        twin.onFinishChange(function (value) { source._onFinishChange.call(source, value); });
    }

    // Inherit the source's listening state. This is what lets a twin recover from a change that
    // bypassed every controller — but only in a polled root (GUIRootRegistry).
    //
    // opts.listen forces it on for BOTH ends instead. Whole-folder popups need that: a mirrored
    // Building or Track edit menu is driven by dragging 3D handles, which write the values
    // directly, and most of those controls were never built with .listen(). Inheriting faithfully
    // there would freeze the popup the moment you touched the thing it is editing.
    if (opts.listen) {
        source.listen();
        twin.listen();
    } else if (source._listening) {
        twin.listen();
    }

    return twin;
}

// Build a twin of the same KIND as the source, bound to the same object[property].
//
// The kind is read back from the CSS class lil-gui stamps on the controller's root element
// ('boolean', 'color', 'function', 'number', 'option', 'string'). That beats
// `constructor.name`, which a minified production build renames — a mismatch there would
// silently downgrade a slider to a text box only in the shipped build.
function addTwin(source, gui) {
    const {object, property} = source;
    switch (controllerKind(source)) {
        case "option":
            return gui.add(object, property, optionsObject(source));

        case "color":
            return gui.addColor(object, property, source._rgbScale);

        case "number": {
            // NumberController requires an explicit step (it asserts otherwise), so every live
            // number controller has one to copy.
            const twin = gui.add(object, property, source._min, source._max, source._step, source._doSnap);
            twin._maxMax = source._maxMax;
            if (source._decimals !== undefined) twin.decimals(source._decimals);
            if (source._elastic) {
                twin.elastic(source._elasticMin, source._elasticMax, source._elasticInteger, source._elasticShrink);
            }
            if (!source.$slider) twin.noSlider();
            return twin;
        }

        default:
            return gui.add(object, property);
    }
}

const KINDS = ["option", "color", "number", "boolean", "string", "function"];

function controllerKind(controller) {
    const classes = controller?.domElement?.classList;
    return (classes && KINDS.find(k => classes.contains(k))) ?? null;
}

function isDropdown(controller) {
    return controller && controller._names !== undefined && controller._values !== undefined;
}

function optionsObject(controller) {
    const o = {};
    (controller._names || []).forEach((n, i) => { o[n] = controller._values[i]; });
    return o;
}

// --- source -> twin propagation ------------------------------------------------------------

// Wrap the source ONCE so that everything which changes it also reaches its twins. Value goes
// through onChange; the three ways a control changes SHAPE rather than value (rename, hide/show,
// new option list) are patched individually. Each of those mutates in place and returns `this`,
// so the source reference stays stable.
function patchSource(key, source) {
    if (source._menuMirrorPatched) return;
    source._menuMirrorPatched = true;

    const sideEffect = typeof source._onChange === "function" ? source._onChange : null;
    source._menuMirrorSideEffect = sideEffect;
    source.onChange(function (value) {
        if (sideEffect) sideEffect.call(this, value);
        syncMirrors(key);
    });

    const originalName = source.name.bind(source);
    source.name = (name) => {
        const result = originalName(name);
        for (const twin of twinsOf(key)) if (!twin._menuMirrorFixedName) twin.name(name);
        // A rename is how a units change announces itself (CNodeGUIValue.updateDesc), and that
        // rescales min/max as well as the label — so re-sync the range on the way through.
        syncMirrors(key);
        return result;
    };

    const originalShow = source.show.bind(source);
    source.show = (visible = true) => {
        const result = originalShow(visible);
        for (const twin of twinsOf(key)) twin.show(visible);
        return result;
    };

    if (isDropdown(source)) {
        const originalOptions = source.options.bind(source);
        source.options = (newOptions) => {
            const result = originalOptions(newOptions);
            const o = optionsObject(source);
            for (const twin of twinsOf(key)) twin.options(o);
            syncMirrors(key);       // the <select> rebuild resets selectedIndex; put it back
            return result;
        };
    }
}

// Refresh the source's display and all its twins from the shared bound value.
function syncMirrors(key) {
    const source = sources.get(key);
    if (!source) return;
    forceUpdateDisplay(source);
    for (const twin of twinsOf(key)) {
        syncRange(source, twin);
        forceUpdateDisplay(twin);
    }
}

// Force a controller's widget to re-sync to the bound value. lil-gui's updateDisplay() skips
// when value === _lastDisplayedValue, but OptionController.options() rebuilds the <select>
// (resetting selectedIndex to 0) WITHOUT clearing that cache — so after an option-list refresh
// the display can be stuck on the wrong item. Clearing the cache first defeats that guard.
function forceUpdateDisplay(controller) {
    if (!controller) return;
    controller._lastDisplayedValue = undefined;
    if (typeof controller.updateDisplay === "function") controller.updateDisplay();
}

// An elastic slider raises its own _max as the user drags past the end, and CNodeGUIValue
// rescales _min/_max on a units change. Either leaves a twin drawing the fill bar against a
// stale range, so the two sliders disagree about where the same value sits.
function syncRange(source, twin) {
    if (typeof twin._onUpdateMinMax !== "function") return;
    if (twin._min === source._min && twin._max === source._max) return;
    twin._min = source._min;
    twin._max = source._max;
    twin._maxMax = source._maxMax;
    twin._onUpdateMinMax();
}

// --- request / twin bookkeeping --------------------------------------------------------------

function twinsOf(key) {
    return twins.get(key) ?? [];
}

// Drop requests whose target menu has been detached from the document (view closed, popped out
// and back, sitch torn down). Mirroring into one would build rows nobody can see and keep the
// dead menu alive.
function liveRequests(key) {
    const all = requests.get(key);
    if (!all) return [];
    const live = all.filter(r => isLiveGui(r.gui));
    if (live.length !== all.length) requests.set(key, live);
    return live;
}

function isLiveGui(gui) {
    return !!gui && (!gui.domElement || gui.domElement.isConnected !== false);
}

function destroyTwins(key) {
    for (const twin of twinsOf(key)) {
        if (isLiveGui(twin.parent)) twin.destroy();
    }
    twins.delete(key);
}

// --- lil-gui extensions ------------------------------------------------------------------
//
// The point of putting these on the prototypes is that "show this same control over there" is
// then a chainable one-liner wherever a control is built, rather than a call to a helper that
// has to wrap the whole expression. Installed on import; lil-gui-extras.js imports this module
// so they exist app-wide.
//
//   control.shareAs("view:lookView:labels")        // publish (chainable, returns the control)
//   headerMenu.addMirror("view:lookView:labels")   // subscribe, whenever — before or after
//   control.mirrorTo(someMenu)                     // one-off clone, no key
//   popup.mirrorFolderFrom(sourceFolder)           // whole folder, recursively

Controller.prototype.shareAs = function (key) {
    registerMirrorSource(key, this);
    return this;
};

// Add a mirror of the control published under `key`. Returns the twin, or null if the source
// has not been published yet — in which case it appears here as soon as it is.
GUI.prototype.addMirror = function (key, opts = {}) {
    return mirrorMenuItem(key, this, opts);
};

// One-off faithful clone into `targetGui`, with no key and no registry entry: same binding,
// kind, label, tooltip, range, units and finish-handler. Use `shareAs`/`addMirror` instead when
// the two ends are built independently — that pair is order-independent and self-repairing;
// this is for cloning a menu you already have in your hand.
Controller.prototype.mirrorTo = function (targetGui, opts = {}) {
    const twin = buildTwin(this, targetGui, opts);
    if (!twin) return null;
    // Unkeyed, so wire the source -> twin direction here: run the source's own side effect and
    // refresh both displays whichever end was touched.
    const sideEffect = typeof this._onChange === "function" ? this._onChange : null;
    twin.onChange((value) => {
        if (sideEffect) sideEffect.call(this, value);
        forceUpdateDisplay(this);
        syncRange(this, twin);
    });
    this.onChange((value) => {
        if (sideEffect) sideEffect.call(this, value);
        syncRange(this, twin);
        forceUpdateDisplay(twin);
    });
    return twin;
};

// Recursively clone `sourceFolder`'s contents into this GUI, preserving DOM order so the copy
// reads like the original. Folders are recreated as folders; every control becomes a mirrorTo
// twin, so one implementation of "faithful clone" serves both the whole-folder popups and the
// single-item header rows.
GUI.prototype.mirrorFolderFrom = function (sourceFolder, opts = {}) {
    // A whole-folder mirror is a live editing panel for something being manipulated elsewhere
    // (3D handles, code), so both ends poll by default — see the opts.listen note in buildTwin.
    opts = {listen: true, ...opts};
    for (const child of childrenInDOMOrder(sourceFolder)) {
        if (child.controllers !== undefined) {
            const folder = this.addFolder(child._title);
            folder.mirrorFolderFrom(child, opts);
            folder.open();
            folder.show(!child._hidden);
        } else {
            child.mirrorTo(this, opts);
        }
    }
    return this;
};

// lil-gui keeps controllers and folders in two arrays, but paints them in DOM order — so DOM
// order is the only faithful reading of "what this menu looks like".
function childrenInDOMOrder(gui) {
    const byElement = new Map();
    for (const c of gui.controllers) byElement.set(c.domElement, c);
    for (const f of gui.folders) byElement.set(f.domElement, f);
    const ordered = [];
    for (const el of gui.$children.children) {
        const child = byElement.get(el);
        if (child) ordered.push(child);
    }
    // Anything the DOM walk missed (a controller whose element was re-parented) still gets
    // mirrored, just at the end, rather than silently vanishing from the copy.
    for (const child of byElement.values()) if (!ordered.includes(child)) ordered.push(child);
    return ordered;
}
