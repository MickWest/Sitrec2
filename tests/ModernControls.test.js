/** @jest-environment jsdom */
window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));
import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";
import {createControlGroup, setControlGroupActive} from "../src/ModernControls";
import {guiRootCount, updateGUIRootListeners} from "../src/GUIRootRegistry";
import {CUIBar} from "../src/CUIBar";
import {clearMenuMirrors} from "../src/MenuMirror";
import {setUnits} from "../src/Globals";
import {CNodeGUIValue} from "../src/nodes/CNodeGUIValue";

let host, source, group, bar;
beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    source = new GUI({container: host, autoPlace: false});
});
afterEach(() => { group?.destroy(); bar?.dispose(); group = null; bar = null; source.destroy(); host.remove(); clearMenuMirrors(); });

test("embedded groups poll shared state and unregister on disposal", () => {
    const count = guiRootCount();
    const state = {flag: false};
    group = createControlGroup(host);
    const twin = source.add(state, "flag").mirrorTo(group, {listen: true});
    state.flag = true;
    updateGUIRootListeners();
    expect(twin.$input.checked).toBe(true);
    expect(guiRootCount()).toBe(count + 1);
    setControlGroupActive(group, false);
    expect(guiRootCount()).toBe(count);
    setControlGroupActive(group, true);
    expect(guiRootCount()).toBe(count + 1);
    group.destroy(); group = null;
    expect(guiRootCount()).toBe(count);
});

test("native form keys keep focus and default behavior without reaching scene shortcuts", () => {
    const beforeEdit = jest.fn();
    group = createControlGroup(host, {beforeEdit});
    const twin = source.add({flag: false}, "flag").mirrorTo(group);
    const sceneKey = jest.fn();
    document.addEventListener("keydown", sceneKey);
    twin.$input.focus();
    const event = new KeyboardEvent("keydown", {key: " ", bubbles: true, cancelable: true});
    twin.$input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(twin.$input);
    expect(beforeEdit).toHaveBeenCalledTimes(1);
    expect(sceneKey).not.toHaveBeenCalled();
    document.removeEventListener("keydown", sceneKey);
});

test("view-header icons inherit disabled state and live explanations", () => {
    const state = {on: false};
    const c = source.add(state, "on").name("Old name").tooltip("Old help").shareAs("modern-test");
    bar = new CUIBar(host, {title: "Test"});
    const button = bar.addControlIcon("modern-test", {html: "T"});
    c.disable();
    expect(button.disabled).toBe(true);
    button.click();
    expect(state.on).toBe(false);
    c.enable().name("New name").tooltip("New help");
    expect(button.title).toContain("New help");
    expect(button.getAttribute("aria-label")).toBe("New name");
    button.click();
    expect(state.on).toBe(true);
});

test("a contextual altitude label follows the source's small units without converting twice", () => {
    const units = {small: {abbrev: "m", toM: 1}};
    setUnits(units);
    const node = Object.assign(Object.create(CNodeGUIValue.prototype), {
        value: 10, unitType: "small", desc: "Camera Alt", maxMax: 100,
    });
    let altitude = 10;
    node.guiEntry = source.add(node, "value", 0, 100, 1)
        .onChange(() => { altitude = node.getValueFrame(0); });
    node.updateDesc();
    group = createControlGroup(host);
    const twin = node.guiEntry.mirrorTo(group, {name: "Altitude", unitLabel: true, listen: true}).noSlider();
    expect(twin._name).toBe("Altitude (m)");
    units.small = {abbrev: "ft", toM: 0.3048};
    node.changeUnits("imperial", {small: 1 / 0.3048});
    expect(twin._name).toBe("Altitude (ft)");
    expect(twin.getValue()).toBeCloseTo(10 / 0.3048);
    expect(twin._max).toBeCloseTo(100 / 0.3048);
    expect(altitude).toBe(10);
    twin.setValue(100);
    expect(altitude).toBeCloseTo(30.48);
    units.small = {abbrev: "m", toM: 1};
    node.changeUnits("metric", {small: 0.3048});
    expect(twin._name).toBe("Altitude (m)");
    expect(twin.getValue()).toBeCloseTo(30.48);
});
