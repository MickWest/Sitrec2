// Which lil-gui roots the main loop polls for `.listen()` controllers.
//
// The fork removed lil-gui's per-controller requestAnimationFrame: `.listen()` now only sets a
// flag, and something has to walk the tree once a frame and call updateDisplay on anything whose
// bound value moved. CGuiMenuBar.updateListeners does that — but it only knew about the docked
// menu-bar slots, so `.listen()` was silently a NO-OP in any other root: a detached menu, a
// mirrored popup, a per-view header menu. Anything that changed such a control's value without
// going through the controller (a sitch load, the API, a script, a twin in another menu) left
// the widget showing the old value with no way back.
//
// So every root that is not a menu-bar slot registers here, and the same frame walk covers it.
// Registration is by ROOT: `updateListeners()` recurses, so nested folders come along.
//
// Register only while a root is actually on screen — a hidden header menu costs a full
// controllersRecursive() walk per frame for nothing, and it catches up the frame it is shown
// (lil-gui compares against `_listenPrevValue`, which is still stale from before it was hidden).

const roots = new Set();

export function registerGUIRoot(gui) {
    if (gui) roots.add(gui);
    return gui;
}

export function unregisterGUIRoot(gui) {
    roots.delete(gui);
}

// Called once per frame from CGuiMenuBar.updateListeners, alongside the docked slots.
export function updateGUIRootListeners() {
    for (const gui of roots) {
        // A root whose DOM has been torn down without unregistering must not take the whole
        // frame's listener pass down with it.
        if (typeof gui.updateListeners !== "function") { roots.delete(gui); continue; }
        gui.updateListeners();
    }
}

// Test/diagnostic hook: how many extra roots are currently being polled.
export function guiRootCount() {
    return roots.size;
}
