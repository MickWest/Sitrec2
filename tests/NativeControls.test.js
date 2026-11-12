/** @jest-environment jsdom */
window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));
import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";
import {createNativeControlGroup, mirrorControl, setNativeControlGroupActive} from "../src/NativeControls";
import {ControlAdapter} from "../src/ControlAdapter";
import {guiRootCount, updateGUIRootListeners} from "../src/GUIRootRegistry";
import {setUnits} from "../src/Globals";

let host, source, native;
beforeEach(() => {
    jest.useFakeTimers();
    host = document.createElement("div"); document.body.append(host);
    source = new GUI({container: host, autoPlace: false});
    native = createNativeControlGroup(host);
});
afterEach(() => {
    native.destroy(); source.destroy(); host.remove();
    jest.clearAllTimers(); jest.useRealTimers();
});

test("native controls contain no old GUI and dispatch source/folder callbacks once", () => {
    const state = {enabled: false}, onChange = jest.fn(), onFinish = jest.fn();
    const folderChange = jest.fn(), folderFinish = jest.fn(), presentationChange = jest.fn();
    source.onChange(folderChange).onFinishChange(folderFinish);
    native.onChange = presentationChange;
    const control = source.add(state, "enabled").onChange(onChange).onFinishChange(onFinish);
    const first = mirrorControl(control, native), second = mirrorControl(control, native);
    expect(native.domElement.querySelector(".lil-gui")).toBeNull();
    first.$input.click();
    expect(state.enabled).toBe(true);
    expect(control.$input.checked).toBe(true);
    expect(second.$input.checked).toBe(true);
    for (const callback of [onChange, onFinish, folderChange, folderFinish, presentationChange]) expect(callback).toHaveBeenCalledTimes(1);
    control.onChange(jest.fn());
    second.$input.click();
    expect(control._onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
});

test("function actions preserve their receiver and source action callback semantics", () => {
    const state = {count: 0, action() { this.count++; }};
    const changed = jest.fn(), finished = jest.fn();
    const controller = source.add(state, "action").onChange(changed).onFinishChange(finished);
    const row = mirrorControl(controller, native);
    row.$input.click();
    expect(state.count).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(finished).not.toHaveBeenCalled();
    controller.disable();
    row.$input.dispatchEvent(new MouseEvent("click", {bubbles: true}));
    expect(state.count).toBe(1);
});

test("polling follows live names, help, availability, options and bypassed values", () => {
    const state = {choice: 2}, control = source.add(state, "choice", {One: 1, Two: 2});
    const row = mirrorControl(control, native);
    expect(row.$input.value).toBe("1");
    control.name("Mode").tooltip("Choose a mode").options({Two: 2, Three: 3}).disable();
    jest.advanceTimersByTime(250);
    expect(row.$name.textContent).toBe("Mode");
    expect(row.domElement.title).toBe("Choose a mode");
    expect(row.$input.disabled).toBe(true);
    expect(row.$input.value).toBe("0");
    control.enable(); native.updateListeners();
    row.$input.value = "1"; row.$input.dispatchEvent(new Event("change", {bubbles: true}));
    expect(state.choice).toBe(3);
    state.choice = 2; updateGUIRootListeners();
    expect(row.$input.value).toBe("0");
    control.domElement.inert = true; native.updateListeners();
    expect(row.$input.disabled).toBe(true);
    control.hide(); native.updateListeners(); expect(row.domElement.hidden).toBe(true);
});

test("typed numbers retain precision and units without a second conversion", () => {
    const units = {small: {abbrev: "m", toM: 1}}; setUnits(units);
    const state = {value: 1, unitType: "small"};
    const control = source.add(state, "value", 0, 100, 1).name("Altitude (m)");
    const row = mirrorControl(control, native, {name: "Altitude", unitLabel: true}).noSlider();
    row.$input.focus(); row.$input.value = "12.345";
    row.$input.dispatchEvent(new Event("input", {bubbles: true}));
    expect(state.value).toBe(12.345);
    expect(row.$slider).toBeNull();
    expect(row.$name.textContent).toBe("Altitude (m)");
    units.small = {abbrev: "ft", toM: 0.3048}; state.value = 40.5; control.max(328);
    row.$input.blur(); native.updateListeners();
    expect(row.$name.textContent).toBe("Altitude (ft)");
    expect(row.$input.value).toBe("40.5");
    row.$input.focus(); row.$input.value = "";
    row.$input.dispatchEvent(new Event("input", {bubbles: true}));
    expect(row.$input.value).toBe("");
    expect(state.value).toBe(40.5);
});

test("numeric keyboard wrapping and finish handlers use the original controller", () => {
    const state = {angle: 360}, changed = jest.fn(), finished = jest.fn();
    const control = source.add(state, "angle", 0, 360, 1, false).wrap().wrapPeriod(360)
        .onChange(changed).onFinishChange(finished);
    const row = mirrorControl(control, native);
    row.$input.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowUp", bubbles: true, cancelable: true}));
    row.$input.dispatchEvent(new KeyboardEvent("keyup", {key: "ArrowUp", bubbles: true}));
    expect(state.angle).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1); expect(finished).toHaveBeenCalledTimes(1);
    row.$input.dispatchEvent(new Event("blur"));
    expect(finished).toHaveBeenCalledTimes(1);
});

test("number display formatting preserves state and Enter finishes an edit only once", () => {
    const state = {value: 12.3456789}, finished = jest.fn();
    const control = source.add(state, "value", -100, 100, 1, false).decimals(3).onFinishChange(finished);
    const row = mirrorControl(control, native);
    expect(row.$input.value).toBe("12.346");
    expect(state.value).toBe(12.3456789);
    row.$input.focus(); row.$input.value = "-3.123456";
    row.$input.dispatchEvent(new Event("input", {bubbles: true}));
    native.updateListeners(); expect(row.$input.value).toBe("-3.123456");
    row.$input.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
    expect(finished).toHaveBeenCalledTimes(1);
    expect(state.value).toBe(-3.123456);
    expect(row.$input.value).toBe("-3.123");
    row.$input.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowUp", shiftKey: true, bubbles: true, cancelable: true}));
    expect(state.value).toBeCloseTo(-3.113456);
});

test("contextual display precision leaves the shared numeric value unchanged", () => {
    const state = {altitude: 19.6850393701};
    const row = mirrorControl(source.add(state, "altitude"), native, {displayDecimals: 3});
    expect(row.$input.value).toBe("19.685");
    expect(state.altitude).toBe(19.6850393701);
    row.$input.focus(); row.$input.value = "12.3456789";
    row.$input.dispatchEvent(new Event("input", {bubbles: true}));
    row.$input.blur();
    expect(row.$input.value).toBe("12.346");
    expect(state.altitude).toBe(12.3456789);
});

test("adapter uses source drag geometry, wrapping, elastic ranges and entry expansion", () => {
    const state = {angle: 0, height: 10};
    const control = source.add(state, "angle", 0, 360, 1, false).wrap().wrapPeriod(360).allowInputExpandMax();
    const adapter = new ControlAdapter(control);
    const track = {getBoundingClientRect: () => ({left: 0, right: 100, width: 100})};
    adapter.beginDrag(50, track); expect(state.angle).toBe(180);
    adapter.drag(110, track); expect(state.angle).toBeCloseTo(36);
    adapter.setNumber(400); expect(state.angle).toBe(400); expect(control._max).toBe(400);
    const height = source.add(state, "height", 0, 100, 1).elastic(1, 1000);
    const altitude = new ControlAdapter(height);
    altitude.setNumber(250.5);
    expect(state.height).toBe(250.5); expect(height._max).toBe(400);
});

test("native range gestures use source changes and finish once, then remove document handlers", () => {
    const state = {angle: 0}, changed = jest.fn(), finished = jest.fn();
    const control = source.add(state, "angle", 0, 360, 1, false).wrap().wrapPeriod(360)
        .onChange(changed).onFinishChange(finished);
    const row = mirrorControl(control, native);
    row.$slider.getBoundingClientRect = () => ({left: 0, right: 100, width: 100});
    row.$slider.dispatchEvent(new MouseEvent("pointerdown", {clientX: 50, bubbles: true, cancelable: true}));
    document.dispatchEvent(new MouseEvent("pointermove", {clientX: 110, bubbles: true, cancelable: true}));
    document.dispatchEvent(new MouseEvent("pointerup", {clientX: 110, bubbles: true}));
    expect(state.angle).toBeCloseTo(36);
    expect(changed).toHaveBeenCalledTimes(2); expect(finished).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new MouseEvent("pointermove", {clientX: 80, bubbles: true}));
    expect(changed).toHaveBeenCalledTimes(2);
    expect(row.dragCleanup).toBeNull();
});

test("Main/Look pairs keep independent labels, values and disabled states", () => {
    const state = {main: false, look: true};
    const m = source.add(state, "main").name("Flare region in Main"), l = source.add(state, "look").name("Flare region in Look");
    const main = mirrorControl(m, native).asViewCheckbox("mainView", "Flare region");
    const look = mirrorControl(l, native).asViewCheckbox("lookView", "Flare region");
    expect(main.pair).toBe(look.pair);
    expect([...main.pair.querySelectorAll(".native-control-letter")].map(el => el.textContent)).toEqual(["M", "L"]);
    main.$input.click(); expect(state).toEqual({main: true, look: true});
    look.$input.click(); expect(state).toEqual({main: true, look: false});
    l.disable(); native.updateListeners();
    expect(main.$input.disabled).toBe(false); expect(look.$input.disabled).toBe(true);
    expect(main.$input.getAttribute("aria-label")).toBe("Flare region in Main");
});

test("active groups stop polling when hidden or destroyed and keep native keyboard behavior after Tab", () => {
    const count = guiRootCount();
    const state = {text: "old"}; const row = mirrorControl(source.add(state, "text"), native);
    const beforeEdit = jest.fn();
    const second = createNativeControlGroup(host, {beforeEdit});
    const checkbox = mirrorControl(source.add({enabled: false}, "enabled"), second);
    // Tab shows keyboard use. The click case is in NativeKeyRouting.test.js.
    document.body.dispatchEvent(new KeyboardEvent("keydown", {key: "Tab", bubbles: true}));
    const sceneKey = jest.fn(); document.addEventListener("keydown", sceneKey);
    const event = new KeyboardEvent("keydown", {key: " ", bubbles: true, cancelable: true});
    checkbox.$input.dispatchEvent(event);
    expect(beforeEdit).toHaveBeenCalledTimes(1); expect(event.defaultPrevented).toBe(false); expect(sceneKey).not.toHaveBeenCalled();
    second.destroy(); document.removeEventListener("keydown", sceneKey);
    setNativeControlGroupActive(native, false); expect(guiRootCount()).toBe(count - 1);
    state.text = "new"; jest.advanceTimersByTime(500); expect(row.$input.value).toBe("old");
    setNativeControlGroupActive(native, true); expect(row.$input.value).toBe("new");
    native.destroy(); expect(guiRootCount()).toBe(count - 1);
    expect(jest.getTimerCount()).toBe(0);
});
