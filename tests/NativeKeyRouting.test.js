/** @jest-environment jsdom */
// After a click on a control that is not a text field, a key press is a scene shortcut:
// the control loses focus and the key goes on to the document handler, as in the menus.
// A panel keeps a key for text entry, and for a control that Tab moved the focus to.
window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));
import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";
import {createNativeControlGroup, mirrorControl} from "../src/NativeControls";
import {applyModernControls} from "../src/ModernControls";
import {WidgetPanel} from "../src/WidgetPanel";
import {hideLeftSidebar, hideRightSidebar} from "../src/PageStructure";

let host, source, native, beforeEdit, sceneKey, panel;

const press = (element, key = " ", code = "Space") => {
    const event = new KeyboardEvent("keydown", {key, code, bubbles: true, cancelable: true});
    element.dispatchEvent(event);
    return event;
};
// The two ways that a control gets the focus.
const clickFocus = element => {
    element.dispatchEvent(new MouseEvent("pointerdown", {bubbles: true}));
    element.focus();
    element.dispatchEvent(new MouseEvent("pointerup", {bubbles: true}));
    sceneKey.mockClear(); beforeEdit.mockClear();
};
const tabFocus = element => {
    press(document.body, "Tab", "Tab");
    element.focus();
    sceneKey.mockClear(); beforeEdit.mockClear();
};

beforeEach(() => {
    jest.useFakeTimers();
    host = document.createElement("div"); document.body.append(host);
    source = new GUI({container: host, autoPlace: false});
    beforeEdit = jest.fn();
    native = createNativeControlGroup(host, {beforeEdit});
    sceneKey = jest.fn();
    document.addEventListener("keydown", sceneKey);
    panel = null;
});
afterEach(() => {
    document.removeEventListener("keydown", sceneKey);
    panel?.dispose(); hideLeftSidebar(); hideRightSidebar();
    native.destroy(); source.destroy(); host.remove();
    jest.clearAllTimers(); jest.useRealTimers();
});

test("after a click, a key on a native checkbox, button or slider goes to the scene", () => {
    const state = {flag: false, level: 5, run: jest.fn()};
    const checkbox = mirrorControl(source.add(state, "flag"), native);
    const button = mirrorControl(source.add(state, "run"), native);
    const slider = mirrorControl(source.add(state, "level", 0, 10, 1), native);

    clickFocus(checkbox.$input);
    const space = press(checkbox.$input);
    expect(sceneKey).toHaveBeenCalledTimes(1);
    expect(space.defaultPrevented).toBe(true);          // Space does not operate the checkbox again
    expect(document.activeElement).not.toBe(checkbox.$input);
    expect(beforeEdit).not.toHaveBeenCalled();          // a scene shortcut is not an edit
    expect(state.flag).toBe(false);

    clickFocus(button.$input);
    press(button.$input, "Enter", "Enter");
    expect(sceneKey).toHaveBeenCalledTimes(1);
    expect(state.run).not.toHaveBeenCalled();

    clickFocus(slider.$slider);
    press(slider.$slider, "ArrowRight", "ArrowRight");
    expect(sceneKey).toHaveBeenCalledTimes(1);
    expect(state.level).toBe(5);
});

test("after a click, a text field and a number field keep their keys", () => {
    const state = {name: "abc", level: 5};
    const text = mirrorControl(source.add(state, "name"), native);
    const number = mirrorControl(source.add(state, "level", 0, 10, 1), native);

    clickFocus(text.$input);
    expect(press(text.$input, "a", "KeyA").defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(text.$input);

    clickFocus(number.$input);
    press(number.$input, "ArrowUp", "ArrowUp");
    expect(state.level).toBe(6);
    expect(sceneKey).not.toHaveBeenCalled();
});

test("after Tab, a native control keeps its keys", () => {
    const state = {flag: false, level: 5};
    const checkbox = mirrorControl(source.add(state, "flag"), native);
    const slider = mirrorControl(source.add(state, "level", 0, 10, 1), native);

    tabFocus(checkbox.$input);
    const space = press(checkbox.$input);
    expect(space.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(checkbox.$input);
    expect(beforeEdit).toHaveBeenCalledTimes(1);

    tabFocus(slider.$slider);
    press(slider.$slider, "ArrowRight", "ArrowRight");
    expect(state.level).toBe(6);
    expect(sceneKey).not.toHaveBeenCalled();
});

test("a widget title follows the same rule", () => {
    panel = new WidgetPanel({parent: host, context: {},
        definition: {id: "test", title: "Test controls", widgets: ["time"]},
        registry: {time: {title: "Time", html: "<input>"}},
    });
    panel.setVisible(true);
    const title = panel.instances.get("time").host.titleElement;

    clickFocus(title);
    expect(press(title, "Enter", "Enter").defaultPrevented).toBe(true);
    expect(sceneKey).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(title);

    tabFocus(title);
    expect(press(title, "Enter", "Enter").defaultPrevented).toBe(false);
    expect(sceneKey).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(title);
});

test("a menu form with the native style follows the same rule", () => {
    applyModernControls(source);
    const checkbox = source.add({flag: false}, "flag");

    clickFocus(checkbox.$input);
    expect(press(checkbox.$input).defaultPrevented).toBe(true);
    expect(sceneKey).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(checkbox.$input);

    tabFocus(checkbox.$input);
    expect(press(checkbox.$input).defaultPrevented).toBe(false);
    expect(sceneKey).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(checkbox.$input);
});
