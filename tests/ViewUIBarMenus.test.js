/**
 * @jest-environment jsdom
 */

// The per-view header menus are a REGISTRY plus registrations scattered across the files that
// create the controls. That split is what makes the feature order-independent, and it is also
// the only thing that can rot: a slot listed here with nothing registering it produces a row
// that never appears, and a registration with no registry entry produces a control the user can
// never reach. Neither throws, neither is visible in review — so they are tested.
//
// The second half exercises populateViewUIBarMenu against the real lil-gui, covering the parts
// that are easy to get subtly wrong: grouping, and folders that must not survive empty.

// jsdom has no matchMedia; lil-gui's NumberController probes it for a coarse pointer.
window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));

import fs from "fs";
import path from "path";
import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";
import {clearMenuMirrors} from "../src/MenuMirror";
import {
    populateViewUIBarIcons,
    populateViewUIBarMenu,
    VIEW_UIBAR_FOLDERS,
    VIEW_UIBAR_ICONS,
    VIEW_UIBAR_MENUS,
    sharedMenuKey,
    viewMenuKey,
} from "../src/ViewUIBarMenus";
import {CUIBar} from "../src/CUIBar";
import en from "../src/i18n/en";

const SRC_DIR = path.resolve(__dirname, "..", "src");

const allItems = Object.entries(VIEW_UIBAR_MENUS)
    .flatMap(([viewId, items]) => items.map(item => ({viewId, ...item})));

// --- registry shape ---------------------------------------------------------------------

describe("the registry itself", () => {
    test.each(allItems.map(i => [`${i.viewId}:${i.slot}`, i]))("%s is well formed", (label, item) => {
        expect(typeof item.slot).toBe("string");
        expect(item.slot).toMatch(/^[a-zA-Z]\w*$/);
        expect(typeof item.name).toBe("string");
        expect(item.name.length).toBeGreaterThan(0);
        if (item.folder !== undefined) {
            expect(Object.keys(VIEW_UIBAR_FOLDERS)).toContain(item.folder);
        }
    });

    test("no view lists the same slot twice", () => {
        for (const [viewId, items] of Object.entries(VIEW_UIBAR_MENUS)) {
            const slots = items.map(i => i.slot);
            expect(new Set(slots).size).toBe(slots.length);
        }
    });

    // A slot means the same thing in every view (that is why "features" can be Features under
    // both Main and Look), so two views must not disagree about its label — the i18n key is
    // shared and one of them would silently win.
    test("a slot has one label across every view", () => {
        const byName = new Map();
        for (const item of allItems) {
            if (byName.has(item.slot)) expect(byName.get(item.slot)).toBe(item.name);
            else byName.set(item.slot, item.name);
        }
    });

    test("every label and folder title has a matching en.js string", () => {
        for (const item of allItems) {
            expect(en.viewMenus[item.slot]).toBe(item.name);
        }
        for (const [id, title] of Object.entries(VIEW_UIBAR_FOLDERS)) {
            expect(en.viewMenus.folders[id]).toBe(title);
        }
    });

    test("no orphaned viewMenus strings in en.js", () => {
        const usedSlots = new Set(allItems.map(i => i.slot));
        const orphans = Object.keys(en.viewMenus).filter(k => k !== "folders" && !usedSlots.has(k));
        expect(orphans).toEqual([]);
        const folderOrphans = Object.keys(en.viewMenus.folders)
            .filter(k => !Object.keys(VIEW_UIBAR_FOLDERS).includes(k));
        expect(folderOrphans).toEqual([]);
    });
});

// --- registry vs. the registrations in src/ ----------------------------------------------

// Collect every `.shareAs(viewMenuKey(<view>, "<slot>"))` and `.shareAs(sharedMenuKey("<slot>"))`
// publication in src/, other than the helpers' own definitions. The view id is often an
// expression (this.id, this.overlayView.id) because the control is per-view, so it is only
// checked when it is a literal — and a SHARED key has no view at all, by definition.
function collectRegistrations() {
    const calls = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith(".js")) continue;
            if (full === path.join(SRC_DIR, "ViewUIBarMenus.js")) continue;
            const text = fs.readFileSync(full, "utf8");
            const re = /\.shareAs\(\s*(?:viewMenuKey\(\s*("?[\w.?]+"?)\s*,\s*"(\w+)"|sharedMenuKey\(\s*"(\w+)")/g;
            let m;
            while ((m = re.exec(text)) !== null) {
                const file = path.relative(SRC_DIR, full);
                if (m[3] !== undefined) { calls.push({file, view: null, slot: m[3], shared: true}); continue; }
                const literalView = m[1].startsWith('"') ? m[1].slice(1, -1) : null;
                calls.push({file, view: literalView, slot: m[2], shared: false});
            }
        }
    };
    walk(SRC_DIR);
    return calls;
}

describe("registry vs. registrations", () => {
    const registrations = collectRegistrations();

    test("the scan sees exactly the registry's set of slots", () => {
        // Guards the guard: a refactor that renamed the helper, or a regex that stopped
        // matching, would otherwise turn every check below into a vacuous pass. Comparing SLOTS
        // rather than call counts is the real invariant — one call site can serve several views
        // when the view id is an expression (`this.id`, `this.overlayView.id`).
        const scanned = new Set(registrations.map(r => r.slot));
        // Menu rows, plus the ACTION slots that only an icon's double click reaches — those are
        // published the same way and would otherwise look like orphans.
        const listed = new Set([
            ...allItems.map(i => i.slot),
            ...Object.values(VIEW_UIBAR_ICONS).flat().map(i => i.double).filter(Boolean),
        ]);
        expect([...scanned].sort()).toEqual([...listed].sort());
    });

    test.each(allItems.map(i => [`${i.viewId}:${i.slot}`, i]))(
        "%s has something registering it", (label, item) => {
            // Either an exact literal match, or a dynamic view id (this.id / overlayView.id)
            // registering that slot — which is how the per-view controls do it.
            // A shared slot has one registration serving every view; a per-view slot matches by
            // literal view id, or by a dynamic one (this.id / overlayView.id).
            const hit = registrations.some(r => r.slot === item.slot
                && (item.shared
                    ? r.shared
                    : !r.shared && (r.view === null || r.view === item.viewId)));
            expect(hit).toBe(true);
        });

    test.each(registrations.map(r => [`${r.file} ${r.shared ? "<shared>" : r.view ?? "<dynamic>"}:${r.slot}`, r]))(
        "%s is listed in the registry", (label, reg) => {
            const asDoubleAction = Object.values(VIEW_UIBAR_ICONS).flat()
                .some(i => i.double === reg.slot);
            const listed = (reg.shared || reg.view === null)
                ? allItems.some(i => i.slot === reg.slot)
                : (VIEW_UIBAR_MENUS[reg.view] ?? []).some(i => i.slot === reg.slot);
            expect(listed || asDoubleAction).toBe(true);
        });
});

// --- populateViewUIBarMenu ----------------------------------------------------------------

describe("populateViewUIBarMenu", () => {
    let containers;

    // The minimum a view needs to look like one here: an id and a CUIBar-shaped title menu.
    function fakeView(id) {
        const container = document.createElement("div");
        document.body.appendChild(container);
        containers.push(container);
        return {id, uiBar: {titleMenu: new GUI({container, autoPlace: false, title: id})}};
    }

    function source(state, property, ...args) {
        const container = document.createElement("div");
        document.body.appendChild(container);
        containers.push(container);
        return new GUI({container, autoPlace: false}).add(state, property, ...args);
    }

    // Publish a control as a view's slot, the way the real call sites do.
    const source_shared = (viewId, slot, controller) => controller.shareAs(viewMenuKey(viewId, slot));

    // Read the rows the way the user sees them — lil-gui lays out in DOM order, which is NOT
    // the order of gui.controllers once a deferred mirror has been inserted into place.
    const rowNames = (gui) => [...gui.$children.children]
        .filter(el => el.classList.contains("controller"))
        .map(el => el.querySelector(".name")?.textContent)
        .filter(Boolean);

    beforeEach(() => { containers = []; clearMenuMirrors(); });
    afterEach(() => { clearMenuMirrors(); for (const c of containers) c.remove(); });

    test("does nothing to a view with no registry entry", () => {
        const view = fakeView("someGraphView");
        expect(populateViewUIBarMenu(view)).toBe(0);
        expect(view.uiBar.titleMenu.controllers).toHaveLength(0);
        expect(view.uiBar.titleMenu.folders).toHaveLength(0);
    });

    test("mirrors registered controls into the header under their short names", () => {
        const state = {labels: false, features: false};
        source_shared("lookView", "labels", source(state, "labels").name("Labels in Look"));
        source_shared("lookView", "features", source(state, "features").name("Pins in Look"));

        const view = fakeView("lookView");
        populateViewUIBarMenu(view);

        expect(rowNames(view.uiBar.titleMenu)).toEqual(["Labels", "Pins"]);
        view.uiBar.titleMenu.controllers[0].setValue(true);
        expect(state.labels).toBe(true);
    });

    test("controls registered AFTER the view drop into the header when they appear", () => {
        const view = fakeView("lookView");
        populateViewUIBarMenu(view);
        expect(view.uiBar.titleMenu.controllers).toHaveLength(0);

        const state = {allTracks: false};
        source_shared("lookView", "allTracks", source(state, "allTracks"));
        expect(rowNames(view.uiBar.titleMenu)).toEqual(["All Tracks"]);
    });

    test("rows land in registry order however late their controls turn up", () => {
        // Otherwise the menu is ordered by whatever the sitch happened to build first, which
        // varies between sitches and matches no list anyone wrote down.
        const view = fakeView("lookView");
        populateViewUIBarMenu(view);

        const state = {a: false, b: false, c: false};
        source_shared("lookView", "allTracks", source(state, "a"));      // registry #4
        source_shared("lookView", "labels", source(state, "b"));         // registry #2
        source_shared("lookView", "measurements", source(state, "c"));   // registry #1

        expect(rowNames(view.uiBar.titleMenu)).toEqual(["Measurements", "Labels", "All Tracks"]);
    });

    test("grouped items go into their folder, and empty folders stay hidden", () => {
        const state = {stars: false, trans: 0.15};
        source_shared("lookView", "starNames", source(state, "stars"));
        source_shared("lookView", "overlayTransparency", source(state, "trans", 0, 1, 0.01));

        const look = fakeView("lookView");
        populateViewUIBarMenu(look);
        const menu = look.uiBar.titleMenu;

        const byTitle = Object.fromEntries(menu.folders.map(f => [f._title, f]));
        expect(rowNames(byTitle["Night Sky"])).toEqual(["Star Names"]);
        expect(rowNames(byTitle["Video Overlay"])).toEqual(["Transparency %"]);
        expect(byTitle["Night Sky"]._hidden).toBe(false);
        expect(byTitle["Video Overlay"]._hidden).toBe(false);

        // Nothing registered for the main view, so its Night Sky group must not show up empty.
        const main = fakeView("mainView");
        populateViewUIBarMenu(main);
        expect(main.uiBar.titleMenu.controllers).toHaveLength(0);
        for (const f of main.uiBar.titleMenu.folders) expect(f._hidden).toBe(true);
    });

    test("the same slot in two views mirrors two different controllers", () => {
        const state = {main: false, look: false};
        source_shared("mainView", "labels", source(state, "main"));
        source_shared("lookView", "labels", source(state, "look"));

        const main = fakeView("mainView");
        const look = fakeView("lookView");
        populateViewUIBarMenu(main);
        populateViewUIBarMenu(look);

        main.uiBar.titleMenu.controllers[0].setValue(true);
        expect(state.main).toBe(true);
        expect(state.look).toBe(false);
    });
});

// --- header icons -------------------------------------------------------------------------
//
// The icons are the same registry pattern one level up: a slot published elsewhere, surfaced as
// a button instead of a row. What is worth testing is the join between the two halves — an icon
// with no menu row has no label and no tooltip to borrow, and a click on either has to come out
// the same way whichever of them the user hit.

const allIcons = Object.entries(VIEW_UIBAR_ICONS)
    .flatMap(([viewId, items]) => items.map(item => ({viewId, ...item})));

// An icon is identified by its slot, or — for a group button, which has no single control — by
// its `action`. One helper, so a test never has to care which kind it is looking at.
const iconId = (item) => item.slot ?? item.action;

describe("the icon registry", () => {
    test.each(allIcons.map(i => [`${i.viewId}:${iconId(i)}`, i]))("%s is well formed", (label, item) => {
        expect(iconId(item)).toMatch(/^[a-zA-Z]\w*$/);
        expect(item.icon).toMatch(/^<(svg|span)[\s\S]*<\/(svg|span)>$/);
        // Exactly one of the two shapes: one control, or a group of them.
        expect(item.slot === undefined).toBe(item.targets !== undefined);
        // A button whose control's own label does not describe what pressing it does has to say
        // so itself: a SNAP ("Video Zoom %" is not what 100% does) and a GROUP (which has no one
        // control to borrow from). An ordinary toggle must NOT restate its control's wording.
        if (item.value !== undefined || item.targets !== undefined) {
            expect(typeof item.tip).toBe("string");
        } else {
            expect(item.tip).toBeUndefined();
        }
    });

    test("every icon tooltip has a matching en.js string", () => {
        for (const item of allIcons.filter(i => i.tip !== undefined)) {
            expect(en.viewIcons[iconId(item)]).toBe(item.tip);
        }
        const used = new Set(allIcons.filter(i => i.tip !== undefined).map(iconId));
        expect(Object.keys(en.viewIcons).filter(k => !used.has(k))).toEqual([]);
    });

    // A group button clears controls by name. A target that names nothing is a line of the
    // button's job silently not being done, which is invisible until someone notices the
    // compass is still there.
    test("every target of a group button is a real menu row somewhere", () => {
        const everySlot = new Set(allItems.map(i => i.slot));
        for (const item of allIcons.filter(i => i.targets)) {
            for (const target of item.targets) expect(everySlot).toContain(target);
        }
    });

    test("a group button has something to do in every view it appears on", () => {
        for (const item of allIcons.filter(i => i.targets)) {
            const rows = (VIEW_UIBAR_MENUS[item.viewId] ?? []).map(r => r.slot);
            expect(item.targets.filter(t => rows.includes(t)).length).toBeGreaterThan(0);
        }
    });

    test("no view lists the same icon twice", () => {
        for (const items of Object.values(VIEW_UIBAR_ICONS)) {
            const slots = items.map(i => i.slot);
            expect(new Set(slots).size).toBe(slots.length);
        }
    });

    // Main and Look are read as a pair, side by side. A button in both has to be in the same
    // PLACE in both, or the bar has to be re-read every time the eye moves between them.
    test("Main and Look agree on the order of the icons they share", () => {
        const main = VIEW_UIBAR_ICONS.mainView.map(iconId);
        const look = VIEW_UIBAR_ICONS.lookView.map(iconId);
        const common = main.filter(slot => look.includes(slot));
        expect(look.filter(slot => main.includes(slot))).toEqual(common);
        // …and they come first, so the shared run is a prefix of both rather than something to
        // hunt for among the view-specific ones.
        expect(main.slice(0, common.length)).toEqual(common);
        expect(look.slice(0, common.length)).toEqual(common);
    });

    // An icon borrows its label and its tooltip from the control the menu row mirrors, and the
    // row is where a user who does not recognise a glyph finds out what it was. A slot with an
    // icon and no row is therefore an unlabelled button with no way to identify it.
    test("every icon slot is also a menu row in the same view", () => {
        for (const item of allIcons.filter(i => i.slot)) {
            const rows = (VIEW_UIBAR_MENUS[item.viewId] ?? []).map(i => i.slot);
            expect(rows).toContain(item.slot);
        }
    });
});

describe("populateViewUIBarIcons", () => {
    let hosts;

    // A real CUIBar on a real (detached-but-attached) div: the icons are DOM, and the whole
    // point of the mechanism is what the DOM ends up showing.
    function fakeBar(id) {
        const host = document.createElement("div");
        document.body.appendChild(host);
        hosts.push(host);
        const bar = new CUIBar(host, {title: id});
        return {id, uiBar: bar};
    }

    function source(state, property, ...args) {
        const container = document.createElement("div");
        document.body.appendChild(container);
        hosts.push(container);
        return new GUI({container, autoPlace: false}).add(state, property, ...args);
    }

    const iconOf = (view, slot) =>
        view.uiBar.bar.querySelector(`button[data-uibar-action="icon-${slot}"]`);

    beforeEach(() => { hosts = []; clearMenuMirrors(); });
    afterEach(() => { clearMenuMirrors(); for (const h of hosts) h.remove(); });

    test("does nothing to a view with no icons", () => {
        const view = fakeBar("someGraphView");
        expect(populateViewUIBarIcons(view)).toBe(0);
        expect(view.uiBar.bar.querySelector("button.view-uibar-icon")).toBe(null);
    });

    test("an icon stays hidden until its control is published, then appears", () => {
        const view = fakeBar("mainView");
        populateViewUIBarIcons(view);
        expect(iconOf(view, "los").style.display).toBe("none");

        const state = {los: true};
        source(state, "los").name("Lines of Sight").tooltip("Show lines of sight")
            .shareAs(viewMenuKey("mainView", "los"));

        expect(iconOf(view, "los").style.display).toBe("flex");
        expect(iconOf(view, "los").getAttribute("aria-pressed")).toBe("true");
        // The explanation is BORROWED from the control; the NAME is the menu row's short label,
        // which is not always what the control calls itself (the compass overlay's own switch
        // is named "compassMain").
        expect(iconOf(view, "los").title).toBe("Lines of Sight — Show lines of sight");
    });

    test("the icons sit on the LEFT, beside the view menu, not with the window chrome", () => {
        const view = fakeBar("mainView");
        view.uiBar.addPinIcon(() => {});
        populateViewUIBarIcons(view);
        for (const item of VIEW_UIBAR_ICONS.mainView) {
            expect(view.uiBar.left.contains(iconOf(view, iconId(item)))).toBe(true);
        }
        expect(view.uiBar.right.contains(view.uiBar._pin)).toBe(true);
    });

    test("icon, header row and flag are one control, whichever the user clicks", () => {
        const state = {labels: false};
        source(state, "labels").name("Labels in Main").shareAs(viewMenuKey("mainView", "labels"));

        const view = fakeBar("mainView");
        populateViewUIBarMenu(view);
        populateViewUIBarIcons(view);
        const icon = iconOf(view, "labels");
        const row = view.uiBar.titleMenu.controllers.find(c => c._name === "Labels");

        icon.click();
        expect(state.labels).toBe(true);
        expect(row.getValue()).toBe(true);
        expect(icon.getAttribute("aria-pressed")).toBe("true");

        row.setValue(false);
        expect(state.labels).toBe(false);
        expect(icon.getAttribute("aria-pressed")).toBe("false");
    });

    test("a flag written with no controller involved reaches the icon when the bar is polled", () => {
        // The case a build-time read of the flag would get wrong: a sitch load, the API or a
        // script assigning the global. The twin inherits the source's .listen(), and the bar
        // polls it while it is up.
        const state = {labels: false};
        source(state, "labels").name("Labels in Main").listen()
            .shareAs(viewMenuKey("mainView", "labels"));

        const view = fakeBar("mainView");
        populateViewUIBarIcons(view);
        const icon = iconOf(view, "labels");
        expect(icon.getAttribute("aria-pressed")).toBe("false");

        state.labels = true;
        view.uiBar.setShown(true);          // repaints on the way in...
        expect(icon.getAttribute("aria-pressed")).toBe("true");

        state.labels = false;
        view.uiBar._toggleGui.updateListeners();   // ...and once a frame after that
        expect(icon.getAttribute("aria-pressed")).toBe("false");
    });

    test("hiding the control takes its icon away with it", () => {
        const state = {los: true};
        const control = source(state, "los").name("Lines of Sight")
            .shareAs(viewMenuKey("mainView", "los"));

        const view = fakeBar("mainView");
        populateViewUIBarIcons(view);
        expect(iconOf(view, "los").style.display).toBe("flex");

        control.show(false);
        expect(iconOf(view, "los").style.display).toBe("none");
        control.show(true);
        expect(iconOf(view, "los").style.display).toBe("flex");
    });

    test("a SNAP icon goes to its value and back to where it found the control", () => {
        // The video "100%" button. Pressing it twice has to leave the video exactly as it was,
        // which means remembering the zoom rather than assuming a default to come back to.
        const state = {zoom: 250};
        source(state, "zoom", 5, 2000, 1).name("Video Zoom %")
            .shareAs(viewMenuKey("video", "zoom"));

        const view = fakeBar("video");
        populateViewUIBarIcons(view);
        const icon = iconOf(view, "zoom");
        expect(icon.getAttribute("aria-pressed")).toBe("false");
        // Its own wording, because "Video Zoom %" does not describe what pressing it does.
        expect(icon.title).toMatch(/^Video zoom 100%/);

        icon.click();
        expect(state.zoom).toBe(100);
        expect(icon.getAttribute("aria-pressed")).toBe("true");

        icon.click();
        expect(state.zoom).toBe(250);
        expect(icon.getAttribute("aria-pressed")).toBe("false");

        // A zoom set some other way in between is what the NEXT press remembers.
        state.zoom = 400;
        view.uiBar._toggleGui.updateListeners();
        icon.click();
        expect(state.zoom).toBe(100);
        icon.click();
        expect(state.zoom).toBe(400);
    });

    test("a SNAP icon already at its value with nothing remembered does nothing", () => {
        const state = {zoom: 100};
        source(state, "zoom", 5, 2000, 1).shareAs(viewMenuKey("video", "zoom"));
        const view = fakeBar("video");
        populateViewUIBarIcons(view);

        iconOf(view, "zoom").click();
        expect(state.zoom).toBe(100);
    });

    test("an icon is named after its menu row, not after what the control calls itself", () => {
        const state = {on: true};
        source(state, "on").name("compassLook").tooltip("Show/Hide the view: compassLook")
            .shareAs(viewMenuKey("lookView", "compass"));

        const view = fakeBar("lookView");
        populateViewUIBarIcons(view);
        expect(iconOf(view, "compass").title).toBe("Compass — Show/Hide the view: compassLook");
        expect(iconOf(view, "compass").getAttribute("aria-label")).toBe("Compass");
    });

    test("a control that means something in two views gets an icon in both", () => {
        const state = {main: false, look: false};
        source(state, "main").shareAs(viewMenuKey("mainView", "labels"));
        source(state, "look").shareAs(viewMenuKey("lookView", "labels"));

        const main = fakeBar("mainView");
        const look = fakeBar("lookView");
        populateViewUIBarIcons(main);
        populateViewUIBarIcons(look);

        iconOf(look, "labels").click();
        expect(state.look).toBe(true);
        expect(state.main).toBe(false);
        expect(iconOf(main, "labels").getAttribute("aria-pressed")).toBe("false");

        // …and the ones that are only drawn in the main view stay there.
        expect(iconOf(look, "los")).toBe(null);
        expect(iconOf(main, "los")).not.toBe(null);
    });

    test("one SHARED control stands behind the button on both bars", () => {
        // "Extend Tracks to Ground" is one flag per track, not a per-view display option, so
        // both 3D views show the same switch rather than two that mysteriously move together.
        const state = {extended: false};
        source(state, "extended").name("Extend Tracks to Ground")
            .shareAs(sharedMenuKey("extendToGround"));

        const main = fakeBar("mainView");
        const look = fakeBar("lookView");
        populateViewUIBarIcons(main);
        populateViewUIBarIcons(look);

        // This icon has a double action too, so its single press waits — see the next test.
        jest.useFakeTimers();
        iconOf(main, "extendToGround").click();
        jest.advanceTimersByTime(300);
        jest.useRealTimers();

        expect(state.extended).toBe(true);
        expect(iconOf(look, "extendToGround").getAttribute("aria-pressed")).toBe("true");
    });

    test("a double click runs the blunter action, and the single press it began does not", () => {
        jest.useFakeTimers();
        const state = {extended: false};
        source(state, "extended").shareAs(sharedMenuKey("extendToGround"));

        // A mirrored ACTION is an ordinary lil-gui function controller — a real, labelled
        // control somewhere in the menus, not a gesture that exists only on this button.
        const cleared = {clearAll: jest.fn()};
        const container = document.createElement("div");
        document.body.appendChild(container);
        hosts.push(container);
        new GUI({container, autoPlace: false}).add(cleared, "clearAll")
            .shareAs(sharedMenuKey("clearExtendToGround"));

        const view = fakeBar("mainView");
        populateViewUIBarIcons(view);
        const icon = iconOf(view, "extendToGround");

        // A single press has to WAIT to find out whether it was half of a double.
        icon.click();
        expect(state.extended).toBe(false);
        jest.advanceTimersByTime(300);
        expect(state.extended).toBe(true);

        icon.click();
        icon.click();
        icon.dispatchEvent(new MouseEvent("dblclick", {bubbles: true}));
        expect(cleared.clearAll).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(300);
        expect(state.extended).toBe(true);      // the swallowed press did not fire late
        jest.useRealTimers();
    });

    test("Declutter clears, restores, and re-arms when the user turns something back on", () => {
        // The whole contract in one go, because the interesting part is the SEQUENCE: what it
        // restores depends on what was on the moment it was last pressed, and a manual change
        // in between has to re-arm it rather than being quietly undone by the next press.
        const state = {labels: true, features: true, measurements: false, tracks: true};
        source(state, "labels").shareAs(viewMenuKey("mainView", "labels"));
        source(state, "features").shareAs(viewMenuKey("mainView", "features"));
        source(state, "measurements").shareAs(viewMenuKey("mainView", "measurements"));
        source(state, "tracks").shareAs(sharedMenuKey("showTracks"));

        const view = fakeBar("mainView");
        populateViewUIBarIcons(view);
        const declutter = iconOf(view, "declutter");
        const armed = () => declutter.getAttribute("aria-pressed") === "false";
        const on = () => Object.keys(state).filter(k => state[k]);

        expect(armed()).toBe(true);
        expect(on()).toEqual(["labels", "features", "tracks"]);

        declutter.click();
        expect(on()).toEqual([]);
        expect(armed()).toBe(false);            // lit: this view is decluttered

        declutter.click();
        expect(on()).toEqual(["labels", "features", "tracks"]);
        expect(armed()).toBe(true);

        // Clear, then turn one thing back on BY HAND. That re-arms it…
        declutter.click();
        iconOf(view, "measurements").click();
        expect(on()).toEqual(["measurements"]);
        expect(armed()).toBe(true);

        // …so the next press clears again, and the one after brings back what it just cleared —
        // the hand-picked control, not the set from two presses ago.
        declutter.click();
        expect(on()).toEqual([]);
        declutter.click();
        expect(on()).toEqual(["measurements"]);
    });

    test("Declutter ignores targets this view does not have", () => {
        // Only "labels" is registered, so that is the whole of this view's clutter — and the
        // button must not sit there lit as if the view were already tidy.
        const state = {labels: true};
        source(state, "labels").shareAs(viewMenuKey("mainView", "labels"));

        const view = fakeBar("mainView");
        populateViewUIBarIcons(view);
        const declutter = iconOf(view, "declutter");

        expect(declutter.style.display).toBe("flex");
        expect(declutter.getAttribute("aria-pressed")).toBe("false");
        declutter.click();
        expect(state.labels).toBe(false);
        expect(declutter.getAttribute("aria-pressed")).toBe("true");
    });

    test("Declutter hides itself in a view with nothing to declutter", () => {
        const view = fakeBar("mainView");
        populateViewUIBarIcons(view);
        expect(iconOf(view, "declutter").style.display).toBe("none");
    });

    test("the same slot in two views drives two different controls", () => {
        // starNames is per-view by construction — one sky overlay per 3D view — so the main
        // view's icon must not reach the look view's flag.
        const state = {main: false, look: false};
        source(state, "main").shareAs(viewMenuKey("mainView", "starNames"));
        source(state, "look").shareAs(viewMenuKey("lookView", "starNames"));

        const view = fakeBar("mainView");
        populateViewUIBarIcons(view);
        iconOf(view, "starNames").click();

        expect(state.main).toBe(true);
        expect(state.look).toBe(false);
    });
});
