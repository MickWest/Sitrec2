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
    populateViewUIBarMenu,
    VIEW_UIBAR_FOLDERS,
    VIEW_UIBAR_MENUS,
    viewMenuKey,
} from "../src/ViewUIBarMenus";
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

// Collect every `.shareAs(viewMenuKey(<view>, "<slot>"))` publication in src/, other than the
// helper's own definition. The view id is often an expression (this.id, this.overlayView.id)
// because the control is per-view, so it is only checked when it is a literal.
function collectRegistrations() {
    const calls = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith(".js")) continue;
            if (full === path.join(SRC_DIR, "ViewUIBarMenus.js")) continue;
            const text = fs.readFileSync(full, "utf8");
            const re = /\.shareAs\(\s*viewMenuKey\(\s*("?[\w.?]+"?)\s*,\s*"(\w+)"/g;
            let m;
            while ((m = re.exec(text)) !== null) {
                const raw = m[1];
                const literalView = raw.startsWith('"') ? raw.slice(1, -1) : null;
                calls.push({file: path.relative(SRC_DIR, full), view: literalView, slot: m[2]});
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
        const listed = new Set(allItems.map(i => i.slot));
        expect([...scanned].sort()).toEqual([...listed].sort());
    });

    test.each(allItems.map(i => [`${i.viewId}:${i.slot}`, i]))(
        "%s has something registering it", (label, item) => {
            // Either an exact literal match, or a dynamic view id (this.id / overlayView.id)
            // registering that slot — which is how the per-view controls do it.
            const hit = registrations.some(r => r.slot === item.slot
                && (r.view === null || r.view === item.viewId));
            expect(hit).toBe(true);
        });

    test.each(registrations.map(r => [`${r.file} ${r.view ?? "<dynamic>"}:${r.slot}`, r]))(
        "%s is listed in the registry", (label, reg) => {
            const listed = reg.view === null
                ? allItems.some(i => i.slot === reg.slot)
                : (VIEW_UIBAR_MENUS[reg.view] ?? []).some(i => i.slot === reg.slot);
            expect(listed).toBe(true);
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
        source_shared("lookView", "features", source(state, "features").name("Features in Look"));

        const view = fakeView("lookView");
        populateViewUIBarMenu(view);

        expect(rowNames(view.uiBar.titleMenu)).toEqual(["Labels", "Features"]);
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
