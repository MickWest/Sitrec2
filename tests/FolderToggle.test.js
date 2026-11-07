/**
 * @jest-environment jsdom
 */

// A folder's title-bar checkbox (src/FolderToggle.js) is a VIEW of one boolean controller in
// that folder. These tests check that the checkbox and the controller are one control — every
// way of changing the value reaches both — and that promoting the controller does not break
// the mirroring that is built on it: a keyed twin in another menu (MenuMirror.shareAs) and a
// whole-folder copy (GUI.mirrorFolderFrom).

window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));
// jsdom has no layout observers; the checkbox placement needs only to not throw here.
global.ResizeObserver = global.ResizeObserver || class { observe() {} disconnect() {} };

import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";      // installs asFolderToggle, shareAs, mirrorFolderFrom
import {clearMenuMirrors, mirrorMenuItem} from "../src/MenuMirror";

let containers;

function makeGUI(title = "menu") {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    return new GUI({container, autoPlace: false, title});
}

function boxOf(folder) {
    return folder.domElement.querySelector(":scope > input.lil-folder-toggle");
}

function isOff(folder) {
    return folder.domElement.classList.contains("lil-folder-off");
}

function makeToggledFolder(state, sideEffect = () => {}) {
    const folder = makeGUI().addFolder("Camera View Frustum");
    const toggle = folder.add(state, "visible").name("Visible").listen().onChange(sideEffect);
    folder.add(state, "distance", 0, 10, 1);
    return {folder, toggle};
}

test("paired folder title toggles keep settings live while either view is enabled", () => {
    const folder = makeGUI().addFolder("Horizon Compass");
    const state = {main: false, look: true, opacity: 1};
    const pair = folder.addCheckboxPair(state, "main", "look", "Horizon Compass");
    const opacity = folder.add(state, "opacity", 0, 1);
    pair.main.asFolderToggle({paired: true});
    expect(pair.domElement.parentNode).toBe(folder.domElement);
    expect(pair.domElement.querySelectorAll("input")).toHaveLength(2);
    expect(isOff(folder)).toBe(false);
    pair.look.setValue(false);
    expect(isOff(folder)).toBe(true);
    expect(opacity.domElement.hasAttribute("inert")).toBe(true);
    expect(pair.domElement.closest("[inert]")).toBeNull();
    pair.main.$input.click();
    expect(state).toMatchObject({main: true, look: false});
    expect(isOff(folder)).toBe(false);
    expect(opacity.domElement.hasAttribute("inert")).toBe(false);
});

test("a whole-folder mirror retains the paired title and its independent callbacks", () => {
    const folder = makeGUI().addFolder("Vectors"), target = makeGUI("Copy");
    const state = {main: true, look: false, selected: true};
    const changed = jest.fn();
    const pair = folder.addCheckboxPair(state, "main", "look", "Vectors");
    pair.main.onChange(changed).asFolderToggle({paired: true});
    pair.look.onChange(changed);
    folder.add(state, "selected");
    target.mirrorFolderFrom(folder);
    const title = target.domElement.querySelector(":scope > .lil-folder-toggle-pair");
    expect(title.querySelectorAll("input")).toHaveLength(2);
    const look = target.controllers.find(c => c.property === "look");
    look.$input.click();
    expect(state).toMatchObject({main: true, look: true});
    expect(changed).toHaveBeenCalledTimes(1);
    target.destroy();
    expect(pair.domElement.parentNode).toBe(folder.domElement);
});

test("destroying one side of a paired title restores the surviving ordinary control", () => {
    const folder = makeGUI().addFolder("Compass");
    const pair = folder.addCheckboxPair({main: false, look: false}, "main", "look", "Compass");
    const row = folder.add({value: 1}, "value");
    pair.main.asFolderToggle({paired: true});
    pair.look.destroy();
    expect(folder.domElement.querySelector(".lil-folder-toggle-pair")).toBeNull();
    expect(pair.main.domElement.parentNode).toBe(folder.$children);
    expect(row.domElement.hasAttribute("inert")).toBe(false);
    folder.destroy();
});

beforeEach(() => {
    containers = [];
    clearMenuMirrors();
});

afterEach(() => {
    clearMenuMirrors();
    for (const c of containers) c.remove();
});

describe("promotion", () => {
    test("adds a title checkbox and hides the row without hide()", () => {
        const state = {visible: true, distance: 5};
        const {folder, toggle} = makeToggledFolder(state);
        toggle.asFolderToggle();

        const box = boxOf(folder);
        expect(box).not.toBeNull();
        expect(box.checked).toBe(true);
        expect(folder._folderToggle).toBe(toggle);
        expect(toggle.domElement.classList.contains("lil-folder-toggle-source")).toBe(true);
        // hide() is what MenuMirror propagates to twins, so it must not be used
        expect(toggle._hidden).toBeFalsy();
        // the title text is left alone: the menu bar keys folders by it
        expect(folder.$title.textContent).toBe("Camera View Frustum");
        expect(isOff(folder)).toBe(false);
    });

    test("starts greyed out when the value is false", () => {
        const {folder, toggle} = makeToggledFolder({visible: false, distance: 5});
        toggle.asFolderToggle();
        expect(boxOf(folder).checked).toBe(false);
        expect(isOff(folder)).toBe(true);
    });
});

describe("one control", () => {
    test("clicking the checkbox sets the value and runs the side effect once", () => {
        const state = {visible: true, distance: 5};
        const sideEffect = jest.fn();
        const {folder, toggle} = makeToggledFolder(state, sideEffect);
        toggle.asFolderToggle();

        boxOf(folder).click();
        expect(state.visible).toBe(false);
        expect(sideEffect).toHaveBeenCalledTimes(1);
        expect(sideEffect).toHaveBeenLastCalledWith(false);
        expect(isOff(folder)).toBe(true);

        boxOf(folder).click();
        expect(state.visible).toBe(true);
        expect(isOff(folder)).toBe(false);
    });

    test("setValue on the controller reaches the checkbox", () => {
        const state = {visible: true, distance: 5};
        const {folder, toggle} = makeToggledFolder(state);
        toggle.asFolderToggle();

        toggle.setValue(false);
        expect(boxOf(folder).checked).toBe(false);
        expect(isOff(folder)).toBe(true);
    });

    test("a direct write reaches the checkbox through the listen poll", () => {
        const state = {visible: true, distance: 5};
        const {folder, toggle} = makeToggledFolder(state);
        toggle.asFolderToggle();

        state.visible = false;
        folder.root.updateListeners();
        expect(boxOf(folder).checked).toBe(false);
        expect(isOff(folder)).toBe(true);
    });

    test("switching back on leaves each control's own disabled state alone", () => {
        const state = {visible: true, distance: 5};
        const {folder, toggle} = makeToggledFolder(state);
        const distance = folder.controllers[1];
        distance.disable();
        toggle.asFolderToggle();

        toggle.setValue(false);
        toggle.setValue(true);
        expect(distance._disabled).toBe(true);
    });
});

describe("mirroring", () => {
    test("a keyed twin in another menu stays a visible row and stays in step both ways", () => {
        const state = {visible: true, distance: 5};
        const sideEffect = jest.fn();
        const {folder, toggle} = makeToggledFolder(state, sideEffect);
        toggle.shareAs("view:mainView:frustum").asFolderToggle();

        const twin = mirrorMenuItem("view:mainView:frustum", makeGUI("header"));
        expect(twin._hidden).toBeFalsy();
        expect(twin.domElement.classList.contains("lil-folder-toggle-source")).toBe(false);

        twin.setValue(false);
        expect(boxOf(folder).checked).toBe(false);
        expect(isOff(folder)).toBe(true);
        expect(sideEffect).toHaveBeenCalledTimes(1);

        boxOf(folder).click();
        expect(twin.getValue()).toBe(true);
        expect(twin.$input.checked).toBe(true);
        expect(sideEffect).toHaveBeenCalledTimes(2);
    });

    test("promoting after shareAs works the same as before it", () => {
        const state = {visible: true, distance: 5};
        const {folder, toggle} = makeToggledFolder(state);
        toggle.asFolderToggle().shareAs("k");
        const twin = mirrorMenuItem("k", makeGUI("header"));

        twin.setValue(false);
        expect(boxOf(folder).checked).toBe(false);
    });

    test("a whole-folder copy gets its own title checkbox on the same value", () => {
        const state = {visible: true, distance: 5};
        const {folder, toggle} = makeToggledFolder(state);
        toggle.asFolderToggle();

        const popup = makeGUI("popup");
        popup.mirrorFolderFrom(folder);
        const copyBox = boxOf(popup);
        expect(copyBox).not.toBeNull();
        expect(popup._folderToggle.domElement.classList.contains("lil-folder-toggle-source")).toBe(true);

        copyBox.click();
        expect(state.visible).toBe(false);
        expect(boxOf(folder).checked).toBe(false);
        expect(isOff(folder)).toBe(true);
        expect(isOff(popup)).toBe(true);
    });

    test("a copied sub-folder is promoted too", () => {
        const state = {visible: false, distance: 5};
        const outer = makeGUI("objects");
        const inner = outer.addFolder("traverseObject");
        inner.add(state, "visible").name("Visible").asFolderToggle();

        const popup = makeGUI("popup");
        popup.mirrorFolderFrom(outer);
        const copiedInner = popup.folders[0];
        expect(boxOf(copiedInner)).not.toBeNull();
        expect(isOff(copiedInner)).toBe(true);
    });
});

describe("lifecycle", () => {
    test("destroying the controller removes the checkbox and the greying", () => {
        const {folder, toggle} = makeToggledFolder({visible: false, distance: 5});
        toggle.asFolderToggle();
        toggle.destroy();
        expect(boxOf(folder)).toBeNull();
        expect(isOff(folder)).toBe(false);
        expect(folder._folderToggle).toBeNull();
    });

    test("hiding the controller hides the checkbox", () => {
        const {folder, toggle} = makeToggledFolder({visible: true, distance: 5});
        toggle.asFolderToggle();
        toggle.hide();
        expect(boxOf(folder).style.display).toBe("none");
        toggle.show();
        expect(boxOf(folder).style.display).toBe("");
    });
});

describe("phase 0 fixes", () => {
    function rowOf(controller) {
        return controller.domElement;
    }
    function isBlocked(el) {
        return el.hasAttribute("inert") && el.classList.contains("lil-folder-faded");
    }

    test("promotion turns listen on", () => {
        const state = {visible: true};
        const folder = makeGUI().addFolder("F");
        const toggle = folder.add(state, "visible").asFolderToggle();
        expect(toggle._listening).toBe(true);
        state.visible = false;
        folder.root.updateListeners();
        expect(boxOf(folder).checked).toBe(false);
    });

    test("off marks each row inert and faded; on restores them", () => {
        const state = {visible: true, distance: 5};
        const {folder, toggle} = makeToggledFolder(state);
        toggle.asFolderToggle();
        const distance = folder.controllers[1];

        toggle.setValue(false);
        expect(isBlocked(rowOf(distance))).toBe(true);
        toggle.setValue(true);
        expect(rowOf(distance).hasAttribute("inert")).toBe(false);
        expect(rowOf(distance).classList.contains("lil-folder-faded")).toBe(false);
    });

    test("an exempt row stays live while the folder is off", () => {
        const state = {visible: false, name: "a", distance: 5};
        const folder = makeGUI().addFolder("F");
        const name = folder.add(state, "name").keepLiveWhenFolderOff();
        const distance = folder.add(state, "distance", 0, 10, 1);
        folder.add(state, "visible").asFolderToggle();
        expect(isBlocked(rowOf(distance))).toBe(true);
        expect(rowOf(name).hasAttribute("inert")).toBe(false);
    });

    test("exempting after promotion re-marks the folder", () => {
        const state = {visible: false, name: "a"};
        const folder = makeGUI().addFolder("F");
        const name = folder.add(state, "name");
        folder.add(state, "visible").asFolderToggle();
        expect(isBlocked(rowOf(name))).toBe(true);
        name.keepLiveWhenFolderOff();
        expect(rowOf(name).hasAttribute("inert")).toBe(false);
    });

    test("an exempt row in a nested sub-folder stays live; its siblings are blocked", () => {
        const state = {visible: false, keep: 1, other: 2};
        const folder = makeGUI().addFolder("F");
        const sub = folder.addFolder("Sub");
        const keep = sub.add(state, "keep", 0, 10, 1).keepLiveWhenFolderOff();
        const other = sub.add(state, "other", 0, 10, 1);
        folder.add(state, "visible").asFolderToggle();
        expect(rowOf(keep).hasAttribute("inert")).toBe(false);
        expect(sub.domElement.hasAttribute("inert")).toBe(false);
        expect(isBlocked(rowOf(other))).toBe(true);
    });

    test("a nested folder's title checkbox is blocked while the parent is off", () => {
        const state = {visible: false, childOn: true};
        const folder = makeGUI().addFolder("F");
        const sub = folder.addFolder("Sub");
        sub.add(state, "childOn").asFolderToggle();
        folder.add(state, "visible").asFolderToggle();
        // the whole sub-folder element, checkbox included, is inert
        expect(sub.domElement.hasAttribute("inert")).toBe(true);
    });

    test("nested and parent marks are counted, so switching one on keeps the other's marks", () => {
        // x is exempt, so the parent walks INTO the sub-folder and marks y itself; the
        // sub-folder's own toggle marks y as well. y must stay blocked until both are on.
        const state = {visible: false, childOn: false, x: 1, y: 2};
        const folder = makeGUI().addFolder("F");
        const sub = folder.addFolder("Sub");
        const x = sub.add(state, "x", 0, 10, 1).keepLiveWhenFolderOff();
        const y = sub.add(state, "y", 0, 10, 1);
        const childToggle = sub.add(state, "childOn").asFolderToggle();
        const parentToggle = folder.add(state, "visible").asFolderToggle();
        expect(Number(rowOf(y).dataset.folderOffCount)).toBe(2);
        expect(isBlocked(rowOf(y))).toBe(true);
        parentToggle.setValue(true);
        expect(isBlocked(rowOf(y))).toBe(true);        // the child folder is still off
        childToggle.setValue(true);
        expect(rowOf(y).hasAttribute("inert")).toBe(false);
        expect(rowOf(x).hasAttribute("inert")).toBe(false);
    });

    test("rows added while off are marked", async () => {
        const state = {visible: false, later: 1};
        const folder = makeGUI().addFolder("F");
        folder.add(state, "visible").asFolderToggle();
        const later = folder.add(state, "later", 0, 10, 1);
        await Promise.resolve();       // MutationObserver callbacks run as a microtask
        expect(isBlocked(rowOf(later))).toBe(true);
    });

    test("a title click runs the finish callback", () => {
        const state = {visible: true};
        const finish = jest.fn();
        const folder = makeGUI().addFolder("F");
        folder.add(state, "visible").onFinishChange(finish).asFolderToggle();
        boxOf(folder).click();
        expect(finish).toHaveBeenCalledWith(false);
    });

    test("a .perm() toggle keeps its checkbox through destroy(false)", () => {
        const state = {visible: false, x: 1};
        const folder = makeGUI().addFolder("F").perm();
        const toggle = folder.add(state, "visible").perm().asFolderToggle();
        folder.add(state, "x", 0, 10, 1);
        folder.root.destroy(false);
        expect(boxOf(folder)).not.toBeNull();
        expect(folder._folderToggle).toBe(toggle);
        toggle.setValue(true);
        expect(boxOf(folder).checked).toBe(true);
    });

    test("removing a promotion keeps a later MenuMirror patch working", () => {
        const state = {visible: true, other: false};
        const folder = makeGUI().addFolder("F");
        const toggle = folder.add(state, "visible").asFolderToggle().shareAs("k2");
        const twin = mirrorMenuItem("k2", makeGUI("header"));
        // replacing the folder's toggle removes this promotion
        folder.add(state, "other").asFolderToggle();
        toggle.hide();
        expect(twin._hidden).toBe(true);           // MenuMirror's show()/hide() patch survived
        toggle.show();
        expect(twin._hidden).toBe(false);
    });

    test("whole-folder copies carry the exemption", () => {
        const state = {visible: false, name: "a", x: 1};
        const folder = makeGUI().addFolder("F");
        folder.add(state, "name").keepLiveWhenFolderOff();
        folder.add(state, "x", 0, 10, 1);
        folder.add(state, "visible").asFolderToggle();
        const popup = makeGUI("popup");
        popup.mirrorFolderFrom(folder);
        const [nameTwin, xTwin] = popup.controllers;
        expect(nameTwin.domElement.hasAttribute("inert")).toBe(false);
        expect(isBlocked(xTwin.domElement)).toBe(true);
    });
});

// A partial switch (asFolderToggle({fadeOnlyMarked: true})), as a track's "Show Track Line":
// off blocks only the rows marked fadeWhenFolderOff, and every other row stays live.
describe("partial switch", () => {
    const isBlocked = el => el.hasAttribute("inert") && el.classList.contains("lil-folder-faded");

    function makeTrackFolder(state) {
        const folder = makeGUI().addFolder("S1 LS7 AF00371");
        const name = folder.add(state, "name");
        const toggle = folder.add(state, "visible").asFolderToggle({fadeOnlyMarked: true});
        const width = folder.add(state, "width", 0, 10, 1).fadeWhenFolderOff();
        const sub = folder.addFolder("Filter Bad Data");
        const filter = sub.add(state, "filter");
        const look = sub.add(state, "look").fadeWhenFolderOff();
        return {folder, toggle, name, width, sub, filter, look};
    }

    test("off blocks only the marked rows, also in a sub-folder; on restores them", () => {
        const state = {visible: true, name: "a", width: 1, filter: false, look: false};
        const {toggle, name, width, sub, filter, look} = makeTrackFolder(state);

        toggle.setValue(false);
        expect(isBlocked(width.domElement)).toBe(true);
        expect(isBlocked(look.domElement)).toBe(true);
        expect(name.domElement.hasAttribute("inert")).toBe(false);
        expect(filter.domElement.hasAttribute("inert")).toBe(false);
        expect(sub.domElement.hasAttribute("inert")).toBe(false);

        toggle.setValue(true);
        expect(width.domElement.hasAttribute("inert")).toBe(false);
        expect(look.domElement.classList.contains("lil-folder-faded")).toBe(false);
    });

    test("a row marked after the folder is off is blocked too", () => {
        const state = {visible: false, name: "a", width: 1, filter: false, look: false, step: 1};
        const {folder} = makeTrackFolder(state);
        const step = folder.add(state, "step", 1, 10, 1);
        expect(step.domElement.hasAttribute("inert")).toBe(false);
        step.fadeWhenFolderOff();
        expect(isBlocked(step.domElement)).toBe(true);
    });

    test("a whole-folder copy is a partial switch with the same marks", () => {
        const state = {visible: false, name: "a", width: 1, filter: false, look: false};
        const {folder} = makeTrackFolder(state);
        const popup = makeGUI("popup");
        popup.mirrorFolderFrom(folder);
        const nameTwin = popup.controllers.find(c => c.property === "name");
        const widthTwin = popup.controllers.find(c => c.property === "width");
        expect(boxOf(popup)).not.toBeNull();
        expect(nameTwin.domElement.hasAttribute("inert")).toBe(false);
        expect(isBlocked(widthTwin.domElement)).toBe(true);
    });
});

// A list checkbox (asListCheckbox) only changes the look: label on the left, box at the right end,
// in the column of the title checkboxes. It must stay an ordinary boolean row, so a click on the
// box, drag-to-set (which looks for `.controller.boolean`) and an off title checkbox all work.
describe("list checkbox", () => {
    const isBlocked = el => el.hasAttribute("inert") && el.classList.contains("lil-folder-faded");

    test("adds the class and its CSS, and keeps a working boolean row", () => {
        const state = {on: false};
        const folder = makeGUI().addFolder("Show Wind at");
        const row = folder.add(state, "on").name("Camera").asListCheckbox();
        expect(row.domElement.classList.contains("lil-list-checkbox")).toBe(true);
        expect(row.domElement.classList.contains("boolean")).toBe(true);
        expect(document.getElementById("lil-folder-toggle-style").textContent)
            .toContain(".lil-list-checkbox > .widget");
        const box = row.domElement.querySelector('input[type="checkbox"]');
        box.checked = true;
        box.dispatchEvent(new Event("change", {bubbles: true}));
        expect(state.on).toBe(true);
    });

    test("is greyed and blocked when its folder's title checkbox is off", () => {
        const state = {master: true, camera: true};
        const folder = makeGUI().addFolder("Show Wind at");
        folder.add(state, "master").asFolderToggle();
        const row = folder.add(state, "camera").name("Camera").asListCheckbox();
        expect(isBlocked(row.domElement)).toBe(false);
        boxOf(folder).checked = false;
        boxOf(folder).dispatchEvent(new Event("change"));
        expect(isBlocked(row.domElement)).toBe(true);
    });
});
