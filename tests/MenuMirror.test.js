/**
 * @jest-environment jsdom
 */

// MenuMirror surfaces one lil-gui controller in a second menu. The whole point is that the two
// rows are ONE control: one value, one side effect, one option list. These tests run against
// the real (forked) lil-gui rather than a stub, because most of what can go wrong is a detail
// of that fork — a NumberController silently degrading to a text box because min/max/step were
// not carried across, an OptionController's <select> rebuilt with selectedIndex 0, a twin left
// bound to a controller that has since been destroyed.

// jsdom has no matchMedia; lil-gui's NumberController probes it for a coarse pointer. Stub it
// before the module graph is touched, or every slider in this file fails to construct.
window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));

import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";      // adds Controller.tooltip(), which mirrors carry across
import {
    clearMenuMirrors,
    mirrorMenuItem,
    registerMirrorSource,
    syncMirroredSource,
} from "../src/MenuMirror";

let containers;

// Menus must live in the document: MenuMirror drops requests whose target menu has been
// detached, which is how a closed view stops collecting rows.
function makeGUI(title = "menu") {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    return new GUI({container, autoPlace: false, title});
}

function rowNames(gui) {
    return gui.controllers.map(c => c._name);
}

beforeEach(() => {
    containers = [];
    clearMenuMirrors();
});

afterEach(() => {
    clearMenuMirrors();
    for (const c of containers) c.remove();
});

describe("value and side effect", () => {
    test("a boolean twin shares the source's value and runs its side effect exactly once", () => {
        const state = {flag: false};
        const sideEffect = jest.fn();
        const source = makeGUI().add(state, "flag").name("Labels in Look").onChange(sideEffect);
        registerMirrorSource("k", source);

        const twin = mirrorMenuItem("k", makeGUI(), {name: "Labels"});

        twin.setValue(true);
        expect(state.flag).toBe(true);
        expect(source.getValue()).toBe(true);
        expect(sideEffect).toHaveBeenCalledTimes(1);

        source.setValue(false);
        expect(twin.getValue()).toBe(false);
        expect(sideEffect).toHaveBeenCalledTimes(2);
    });

    test("every twin of a source stays in step with the others", () => {
        const state = {flag: false};
        registerMirrorSource("k", makeGUI().add(state, "flag"));
        const a = mirrorMenuItem("k", makeGUI());
        const b = mirrorMenuItem("k", makeGUI());

        a.setValue(true);
        expect(b.getValue()).toBe(true);
        expect(b.$input.checked).toBe(true);
    });

    test("syncMirroredSource re-aligns displays after a write that bypassed the controller", () => {
        const state = {flag: false};
        registerMirrorSource("k", makeGUI().add(state, "flag"));
        const twin = mirrorMenuItem("k", makeGUI());

        state.flag = true;                       // straight at the object, no controller involved
        expect(twin.$input.checked).toBe(false);
        syncMirroredSource("k");
        expect(twin.$input.checked).toBe(true);
    });
});

describe("controller kinds", () => {
    test("a number twin is a slider with the same range, not a bare text box", () => {
        const state = {trans: 0.15};
        const source = makeGUI().add(state, "trans", 0, 1, 0.01).name("Vid Overlay Trans %");
        registerMirrorSource("k", source);

        const twin = mirrorMenuItem("k", makeGUI(), {name: "Transparency %"});
        expect(twin._min).toBe(0);
        expect(twin._max).toBe(1);
        expect(twin._step).toBe(0.01);
        expect(twin.$slider).toBeDefined();
    });

    test("a number twin follows a range that moves under it", () => {
        // An elastic slider raises its own _max as you drag past the end, and a units change
        // rescales both ends. A twin left on the old range draws the same value in the wrong
        // place on the bar.
        const state = {alt: 1000};
        const source = makeGUI().add(state, "alt", 0, 2000, 1);
        registerMirrorSource("k", source);
        const twin = mirrorMenuItem("k", makeGUI());

        source.max(20000);
        source.setValue(15000);
        expect(twin._max).toBe(20000);
        expect(twin.getValue()).toBe(15000);
    });

    test("a colour twin is a colour controller", () => {
        const state = {keyColor: 0xff00ff};
        registerMirrorSource("k", makeGUI().addColor(state, "keyColor"));
        const twin = mirrorMenuItem("k", makeGUI());
        expect(twin.domElement.classList.contains("color")).toBe(true);
    });

    test("a button twin calls the same function", () => {
        const fn = jest.fn();
        registerMirrorSource("k", makeGUI().add({go: fn}, "go"));
        const twin = mirrorMenuItem("k", makeGUI());
        twin.$button.click();
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test("a dropdown twin copies the option LABELS, not just the values", () => {
        const state = {rotation: 90};
        const source = makeGUI().add(state, "rotation", {"0°": 0, "90° CW": 90, "180°": 180});
        registerMirrorSource("k", source);

        const twin = mirrorMenuItem("k", makeGUI());
        expect(twin._names).toEqual(["0°", "90° CW", "180°"]);
        expect(twin.$select.value).toBe("90° CW");
    });

    test("a refreshed option list reaches the twin without stranding its display", () => {
        // OptionController.options() rebuilds the <select>, which resets selectedIndex to 0
        // without clearing lil-gui's "already displayed" cache — so the row can end up showing
        // an item that is not the bound value.
        const state = {video: 1};
        const source = makeGUI().add(state, "video", {A: 0, B: 1});
        registerMirrorSource("k", source);
        const twin = mirrorMenuItem("k", makeGUI());

        source.options({A: 0, B: 1, C: 2});
        expect(twin._names).toEqual(["A", "B", "C"]);
        expect(twin.$select.value).toBe("B");
        expect(source.$select.value).toBe("B");
    });
});

describe("labels, tooltips and visibility", () => {
    test("the twin's label defaults to the source's and can be overridden", () => {
        const state = {a: false, b: false};
        registerMirrorSource("inherited", makeGUI().add(state, "a").name("Measurements in Look"));
        registerMirrorSource("overridden", makeGUI().add(state, "b").name("Measurements in Look"));

        const menu = makeGUI();
        mirrorMenuItem("inherited", menu);
        mirrorMenuItem("overridden", menu, {name: "Measurements"});
        expect(rowNames(menu)).toEqual(["Measurements in Look", "Measurements"]);
    });

    // A rename normally means the label went stale (units changed, a button flipped from "Show"
    // to "Hide"), so it must reach the twins — but not clobber a deliberate short override.
    test("a source rename reaches inherited twins", () => {
        const state = {a: false};
        const source = makeGUI().add(state, "a").name("Show EXIF");
        registerMirrorSource("k", source);
        const menu = makeGUI();
        mirrorMenuItem("k", menu);

        source.name("Hide EXIF");
        expect(rowNames(menu)).toEqual(["Hide EXIF"]);
    });

    test("a source rename leaves an overridden twin label alone", () => {
        const state = {a: false};
        const source = makeGUI().add(state, "a").name("Original");
        registerMirrorSource("k", source);
        const menu = makeGUI();
        mirrorMenuItem("k", menu, {name: "Short"});

        source.name("Renamed");
        expect(rowNames(menu)).toEqual(["Short"]);
    });

    test("the twin inherits the source tooltip unless told otherwise", () => {
        const state = {a: false, b: false};
        registerMirrorSource("x", makeGUI().add(state, "a").tooltip("the long explanation"));
        registerMirrorSource("y", makeGUI().add(state, "b").tooltip("the long explanation"));

        const menu = makeGUI();
        expect(mirrorMenuItem("x", menu)._tooltip).toBe("the long explanation");
        expect(mirrorMenuItem("y", menu, {tooltip: "short"})._tooltip).toBe("short");
    });

    test("hiding the source hides the twin, and a source born hidden never shows one", () => {
        const state = {a: false, b: false};
        const shown = makeGUI().add(state, "a");
        registerMirrorSource("shown", shown);
        const twin = mirrorMenuItem("shown", makeGUI());
        expect(twin._hidden).toBe(false);
        shown.hide();
        expect(twin._hidden).toBe(true);
        shown.show();
        expect(twin._hidden).toBe(false);

        const hidden = makeGUI().add(state, "b");
        hidden.hide();
        registerMirrorSource("hidden", hidden);
        expect(mirrorMenuItem("hidden", makeGUI())._hidden).toBe(true);
    });
});

describe("order independence and lifecycle", () => {
    test("a request made before the source exists is fulfilled when it appears", () => {
        const menu = makeGUI();
        expect(mirrorMenuItem("k", menu, {name: "Later"})).toBe(null);
        expect(menu.controllers).toHaveLength(0);

        const state = {flag: true};
        registerMirrorSource("k", makeGUI().add(state, "flag"));
        expect(rowNames(menu)).toEqual(["Later"]);
        expect(menu.controllers[0].getValue()).toBe(true);
    });

    test("re-registering a key rebuilds its rows instead of stacking a second copy", () => {
        // The video Rotation dropdown is destroyed and rebuilt on every video load.
        const state = {rotation: 0};
        const sourceMenu = makeGUI();
        const menu = makeGUI();

        const first = sourceMenu.add(state, "rotation", {"0°": 0, "90° CW": 90});
        registerMirrorSource("k", first);
        mirrorMenuItem("k", menu, {name: "Rotation"});
        expect(rowNames(menu)).toEqual(["Rotation"]);

        first.destroy();
        const second = sourceMenu.add(state, "rotation", {"0°": 0, "90° CW": 90, "180°": 180});
        registerMirrorSource("k", second);

        expect(rowNames(menu)).toEqual(["Rotation"]);
        expect(menu.controllers[0]._names).toEqual(["0°", "90° CW", "180°"]);
        menu.controllers[0].setValue(180);
        expect(state.rotation).toBe(180);
    });

    test("a menu detached from the document stops collecting rows", () => {
        const dead = makeGUI();
        mirrorMenuItem("k", dead);
        dead.domElement.remove();

        const state = {flag: false};
        registerMirrorSource("k", makeGUI().add(state, "flag"));
        expect(dead.controllers).toHaveLength(0);
    });
});

// The failure that started this: a header row showed one thing and the Show menu showed another.
// Nothing had gone wrong at mirror time — the value was changed WITHOUT touching a controller
// (a sitch load writing the flag straight onto the node), which is exactly the case explicit
// source->twin propagation cannot see. The source recovered because it was .listen()-ing and
// something polls it; the twin did neither.
describe("changes that bypass every controller", () => {
    test("a twin inherits the source's listen state, and a non-listening source's does not", () => {
        const state = {watched: false, unwatched: false};
        registerMirrorSource("watched", makeGUI().add(state, "watched").listen());
        registerMirrorSource("unwatched", makeGUI().add(state, "unwatched"));

        expect(mirrorMenuItem("watched", makeGUI())._listening).toBe(true);
        expect(mirrorMenuItem("unwatched", makeGUI())._listening).toBeFalsy();
    });

    test("a whole-folder mirror makes BOTH ends poll, whatever the source did", () => {
        // These popups (Building / Track edit) are driven by dragging 3D handles, which write
        // the values directly. Inheriting faithfully would freeze the panel you are editing with.
        const state = {pos: 0, name: "a"};
        const sourceFolder = makeGUI().addFolder("Edit");
        const a = sourceFolder.add(state, "pos", 0, 10, 0.1);       // no .listen()
        const b = sourceFolder.add(state, "name");
        expect(a._listening).toBeFalsy();

        const popup = makeGUI();
        popup.mirrorFolderFrom(sourceFolder);

        expect(a._listening).toBe(true);
        expect(b._listening).toBe(true);
        expect(popup.controllers.every(c => c._listening)).toBe(true);

        state.pos = 7;                       // a 3D handle drag
        popup.updateListeners();
        expect(popup.controllers[0].getValue()).toBe(7);
        expect(popup.controllers[0].$input.value).toBe("7");
    });

    test("polling the twin's own menu repairs a display the mirror could not have seen", () => {
        const state = {flag: false};
        registerMirrorSource("k", makeGUI().add(state, "flag").listen());
        const menu = makeGUI();
        const twin = mirrorMenuItem("k", menu);

        state.flag = true;                 // a sitch load, an API call, a script
        expect(twin.$input.checked).toBe(false);

        menu.updateListeners();            // what GUIRootRegistry drives once a frame
        expect(twin.$input.checked).toBe(true);
    });
});

describe("clearMenuMirrors", () => {
    test("drops ordinary sources and pending requests, keeping permanent ones", () => {
        // menuBar.destroy(false) tears down every non-.perm() controller on a sitch load, so
        // their registrations are stale. Permanent controllers are still there, and a mirror of
        // one (the video Masking toggles) has to survive or it works in the first sitch only.
        const state = {ordinary: false, permanent: false};
        registerMirrorSource("ordinary", makeGUI().add(state, "ordinary"));
        registerMirrorSource("permanent", makeGUI().add(state, "permanent").perm());
        const oldMenu = makeGUI();
        mirrorMenuItem("ordinary", oldMenu);
        mirrorMenuItem("permanent", oldMenu);
        expect(oldMenu.controllers).toHaveLength(2);

        clearMenuMirrors();

        const newMenu = makeGUI();
        expect(mirrorMenuItem("ordinary", newMenu)).toBe(null);   // must re-register
        expect(mirrorMenuItem("permanent", newMenu)).not.toBe(null);
        expect(newMenu.controllers).toHaveLength(1);

        // The permanent source's old twin is forgotten, so changing it only drives the new one.
        newMenu.controllers[0].setValue(true);
        expect(state.permanent).toBe(true);
    });
});
