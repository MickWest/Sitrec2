/** @jest-environment jsdom */
import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";
import {clearMenuMirrors} from "../src/MenuMirror";

window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));
global.ResizeObserver = global.ResizeObserver || class { observe() {} disconnect() {} };

let gui;
beforeEach(() => { gui = new GUI({autoPlace: false}); document.body.appendChild(gui.domElement); });
afterEach(() => { gui.destroy(); clearMenuMirrors(); });

test("one row contains independently named Main and Look controls with letters inside the boxes", () => {
    const state = {main: false, look: false};
    const pair = gui.addCheckboxPair(state, "main", "look", "Grid");
    expect(pair.domElement.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(pair.main.$widget.textContent).toBe("M");
    expect(pair.look.$widget.textContent).toBe("L");
    expect(pair.main._name).toBe("Grid in Main");
    expect(pair.look._name).toBe("Grid in Look");
    pair.look.$input.click();
    expect(state).toEqual({main: false, look: true});
    pair.main.$input.click();
    expect(state).toEqual({main: true, look: true});
});

test.each(["main", "look"])("moving the %s control moves the whole row and keeps M/L after its label", side => {
    const before = gui.add({before: false}, "before");
    const pair = gui.addCheckboxPair({main: false, look: true}, "main", "look", "Grid");
    const after = gui.add({after: false}, "after");
    const caption = pair.domElement.querySelector(".lil-checkbox-pair-name");
    const control = pair[side];
    control.moveToFirst();
    expect([...gui.$children.children]).toEqual([pair.domElement, before.domElement, after.domElement]);
    control.moveToEnd();
    expect([...gui.$children.children]).toEqual([before.domElement, after.domElement, pair.domElement]);
    control.moveAfter("before");
    expect([...gui.$children.children]).toEqual([before.domElement, pair.domElement, after.domElement]);
    expect([...pair.domElement.children]).toEqual([caption, pair.main.domElement, pair.look.domElement]);
    after.moveAfter("Grid");
    expect([...gui.$children.children]).toEqual([before.domElement, pair.domElement, after.domElement]);

    const copy = new GUI({autoPlace: false});
    document.body.appendChild(copy.domElement);
    try {
        copy.mirrorFolderFrom(gui);
        const mirrored = copy.controllers.find(c => c.property === "main")._checkboxPair;
        expect([...mirrored.domElement.children].map(el => el.textContent))
            .toEqual(["Grid", "Grid in MainM", "Grid in LookL"]);
        mirrored.look.$input.click();
        expect(pair.look.getValue()).toBe(false);
        expect(pair.main.getValue()).toBe(false);
    } finally {
        copy.destroy();
    }
});

test("mirrors, callbacks and direct saved-state assignments stay synchronized", () => {
    const state = {main: false, look: false};
    const pair = gui.addCheckboxPair(state, "main", "look", "Grid");
    const changed = jest.fn();
    pair.look.onChange(changed).shareAs("test:look");
    const twin = gui.addFolder("Look").addMirror("test:look", {name: "Grid"});
    twin.setValue(true);
    expect(pair.look.$input.checked).toBe(true);
    expect(pair.main.$input.checked).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    state.look = false;
    pair.look.updateDisplay();
    expect(pair.look.$input.checked).toBe(false);
    expect(pair.look._listening).toBe(true);
});

test("drag paint can set one column over several rows without changing the other", () => {
    const state = {aMain: false, aLook: false, bMain: false, bLook: false};
    const a = gui.addCheckboxPair(state, "aMain", "aLook", "A");
    const b = gui.addCheckboxPair(state, "bMain", "bLook", "B");
    document.elementFromPoint = () => b.look.domElement;
    a.look.domElement.dispatchEvent(new MouseEvent("pointerdown", {bubbles: true, button: 0, buttons: 1}));
    b.look.domElement.dispatchEvent(new MouseEvent("pointermove", {bubbles: true, buttons: 1}));
    b.look.domElement.dispatchEvent(new MouseEvent("pointerup", {bubbles: true, buttons: 0}));
    // Consume the post-drag click cancellation before the next test.
    b.look.$input.click();
    expect(state).toEqual({aMain: false, aLook: true, bMain: false, bLook: true});
});

test("Space toggles the focused checkbox without invoking a menu or scene shortcut", () => {
    const state = {main: false, look: false};
    const pair = gui.addCheckboxPair(state, "main", "look", "Grid");
    const parentKey = jest.fn();
    gui.domElement.addEventListener("keydown", parentKey);
    pair.look.$input.dispatchEvent(new KeyboardEvent("keydown", {key: " ", code: "Space", bubbles: true}));
    expect(state).toEqual({main: false, look: true});
    expect(parentKey).not.toHaveBeenCalled();
    pair.look.disable();
    pair.look.$input.click();
    expect(state.look).toBe(true);
});

test("hide and destruction leave no empty row and restore a surviving checkbox", () => {
    const pair = gui.addCheckboxPair({main: false, look: false}, "main", "look", "Grid");
    pair.main.hide();
    expect(pair.domElement.style.display).not.toBe("none");
    pair.look.hide();
    expect(pair.domElement.style.display).toBe("none");
    pair.look.show();
    pair.main.destroy();
    expect(pair.domElement.isConnected).toBe(false);
    expect(pair.look.domElement.parentNode).toBe(gui.$children);
    pair.look.destroy();
    expect(pair.domElement.isConnected).toBe(false);
    expect(gui.controllers).toHaveLength(0);
});

test.each(["mainView", "lookView"])("view controllers created separately can arrive %s first", first => {
    const models = {mainView: {visible: false}, lookView: {visible: true}};
    const second = first === "mainView" ? "lookView" : "mainView";
    const a = gui.add(models[first], "visible").name(first).asViewCheckbox(first, "Names");
    expect(a._checkboxPair).toBeUndefined();
    const b = gui.add(models[second], "visible").name(second).asViewCheckbox(second, "Names");
    const pair = a._checkboxPair;
    expect(pair).toBe(b._checkboxPair);
    expect(pair.domElement.classList.contains("controller")).toBe(true);
    expect(pair.main.object).toBe(models.mainView);
    expect(pair.look.object).toBe(models.lookView);
    pair.main.$input.click();
    expect(models.mainView.visible).toBe(true);
    expect(models.lookView.visible).toBe(true);
});

test("a destroyed view's replacement reuses its surviving partner without duplicate handlers", () => {
    const main = gui.add({visible: false}, "visible").asViewCheckbox("mainView", "Names");
    const look = gui.add({visible: false}, "visible").asViewCheckbox("lookView", "Names");
    look.destroy();
    expect(main._checkboxPair).toBeUndefined();
    const changed = jest.fn();
    const replacement = gui.add({visible: false}, "visible").onChange(changed)
        .asViewCheckbox("lookView", "Names");
    expect(gui.domElement.querySelectorAll(".lil-checkbox-pair")).toHaveLength(1);
    replacement.$input.click();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(main.getValue()).toBe(false);
});

test("whole-folder mirrors keep paired rows in order, while per-view mirrors remain single controls", () => {
    const source = gui.addFolder("Source"), target = gui.addFolder("Copy"), header = gui.addFolder("Main");
    source.add({before: false}, "before");
    const pair = source.addCheckboxPair({main: false, look: true}, "main", "look", "Names");
    pair.main.shareAs("test:main");
    source.add({after: false}, "after");
    target.mirrorFolderFrom(source);
    const twin = header.addMirror("test:main");
    expect([...target.$children.children].map(el => el.querySelector(".name")?.textContent))
        .toEqual(["before", "Names", "after"]);
    expect(target.domElement.querySelectorAll(".lil-checkbox-pair")).toHaveLength(1);
    expect(header.domElement.querySelectorAll(".lil-checkbox-pair")).toHaveLength(0);
    twin.$input.click();
    expect(pair.main.getValue()).toBe(true);
    expect(pair.look.getValue()).toBe(true);
    const targetLook = target.controllers.find(c => c.property === "look");
    targetLook.$input.click();
    expect(pair.look.getValue()).toBe(false);
});

test("other views and controls in different folders never join an unrelated pair", () => {
    const main = gui.add({visible: false}, "visible").asViewCheckbox("mainView", "Names");
    const video = gui.add({visible: false}, "visible").asViewCheckbox("video", "Names");
    const look = gui.addFolder("Other").add({visible: false}, "visible").asViewCheckbox("lookView", "Names");
    expect(main._checkboxPair).toBeUndefined();
    expect(video._checkboxPair).toBeUndefined();
    expect(look._checkboxPair).toBeUndefined();
});
