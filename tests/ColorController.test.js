/** @jest-environment jsdom */
import GUI from "../src/js/lil-gui.esm";
import {Color} from "three";

let gui;
beforeEach(() => { gui = new GUI({autoPlace: false}); });
afterEach(() => { gui.destroy(); });

test("scripted HUD and track colors keep their shared Three color and save in sRGB", () => {
    const original = new Color("white");
    const state = {color: original};
    const changed = jest.fn();
    const control = gui.addColor(state, "color").onChange(changed);
    control.setValue("#222222");
    expect(state.color).toBe(original);
    expect(original.getHexString()).toBe("222222");
    expect(control.save()).toBe("#222222");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(() => control.setValue("oops#999999")).toThrow();
    expect(control.save()).toBe("#222222");
    control.reset();
    expect(original.getHexString()).toBe("ffffff");
});

test.each([
    ["#ffffff", "#123456"],
    [0xffffff, 0x123456],
    [[0, 0, 0], [18, 52, 86]],
    [{r: 0, g: 0, b: 0}, {r: 18, g: 52, b: 86}],
])("scripted color edits retain the property's format", (initial, expected) => {
    const state = {color: initial};
    gui.addColor(state, "color", 255).setValue("#123456");
    expect(state.color).toEqual(expected);
    if (typeof initial === "object") expect(state.color).toBe(initial);
});
