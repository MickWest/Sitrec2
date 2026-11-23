import {migrateCameraEditorLayers} from "../src/SitchMigrations";
import {CNodeFOVSwitch} from "../src/nodes/CNodeFOVSwitch";
import {NodeMan} from "../src/Globals";
import {MISB} from "../src/MISBFields";

jest.mock("../src/Globals", () => ({NodeMan: {get: jest.fn()}}));
jest.mock("../src/nodes/CNodeSwitch", () => ({CNodeSwitch: class {
    getValue(f) { return this.inputs[this.choice].getValue(f); }
}}));

function curve(points, frame) {
    if (frame <= points[0]) return points[1];
    for (let i = 2; i < points.length; i += 2) {
        if (frame <= points[i]) return points[i-1] + (points[i+1] - points[i-1]) *
            (frame - points[i-2]) / (points[i] - points[i-2]);
    }
    return points[points.length-1];
}

test("old FOV saves retain every interpolated frame, endpoints and source-independent visibility", () => {
    const points = [2, 49, 33, 10.289735991, 77, 10.289735991, 99, 33.76, 248.02, 3.218];
    const scene = {fovSwitch: {kind: "Switch", inputs: {userFOV: "fovUI", "FOV Editor": "fovEditor"}},
        mods: {fovSwitch: {choice: "FOV Editor"}, fovUI: {value: 33.707863884},
            fovEditor: {points: [...points], visible: false, maxY: 55}}};
    migrateCameraEditorLayers(scene);
    const {mods} = scene;
    expect(scene.fovSwitch.kind).toBe("FOVSwitch");
    expect(scene.fovSwitch.inputs).toEqual({userFOV: "fovUI"});
    expect(mods.fovSwitch.choice).toBe("userFOV");
    expect(mods.fovEditor.useEditor).toBe(true);
    expect(mods.fovEditor.visible).toBe(false);
    for (let f = 0; f < 312; f += .5) {
        expect(mods.fovUI.value + curve(mods.fovEditor.points, f)).toBeCloseTo(curve(points, f), 12);
    }
    const migrated = JSON.stringify(scene);
    migrateCameraEditorLayers(scene);
    expect(JSON.stringify(scene)).toBe(migrated);
});

test("chapter FOV states convert their own keys, or inherit the original main curve", () => {
    const main = {fovSwitch: {choice: "FOV Editor"}, fovUI: {value: 30}, fovEditor: {points: [0, 20, 100, 10]}};
    const own = {fovSwitch: {choice: "FOV Editor"}, fovUI: {value: 15}, fovEditor: {points: [0, 5]}};
    const inherited = {fovSwitch: {choice: "FOV Editor"}};
    const unused = {fovSwitch: {choice: "recorded"}};
    const scene = {mods: main, subSitchesData: {subSitches: [own, inherited, unused].map(mods => ({state: {mods}}))}};
    migrateCameraEditorLayers(scene);
    expect(own.fovEditor.points).toEqual([0, -10]);
    expect(own.fovUI.value).toBe(15);
    expect(inherited.fovEditor.points).toEqual([0, -10, 100, -20]);
    expect(inherited.fovUI.value).toBe(30);
    expect(inherited.fovEditor.useEditor).toBe(true);
    expect(unused.fovEditor.useEditor).toBe(false);
    expect(unused.fovSwitch.choice).toBe("recorded");
});

test("unused old curves stay off and a default untouched editor starts at zero", () => {
    const scene = {mods: {fovSwitch: {choice: "recorded"}, fovEditor: {points: [99, 99], visible: true}}};
    migrateCameraEditorLayers(scene);
    expect(scene.mods.fovSwitch.choice).toBe("recorded");
    expect(scene.mods.fovEditor).toEqual({points: [0, 0], visible: true, useEditor: false});
});

test("FOV offsets compose with a changing source, bypass cleanly and accept recorded rows", () => {
    const editor = {useEditor: true, getValue: f => f / 10 - 5};
    NodeMan.get.mockReturnValue(editor);
    const source = Object.assign(Object.create(CNodeFOVSwitch.prototype), {
        choice: "recorded", inputs: {recorded: {getValue: f => 20 + f / 2}},
    });
    expect(source.getValue(0)).toBe(15);
    expect(source.getValueFrame(100)).toBe(75);
    expect(source.choice).toBe("recorded");
    editor.useEditor = false;
    expect(source.getValue(0)).toBe(20);
    editor.useEditor = true;
    const row = []; row[MISB.SensorVerticalFieldofView] = 25;
    source.inputs.recorded.getValue = () => ({misbRow: row});
    expect(source.getValue(0)).toBe(20);
    expect(row[MISB.SensorVerticalFieldofView]).toBe(25);
    source.inputs.recorded.getValue = () => ({vFOV: 1});
    expect(source.getValue(0)).toBeGreaterThan(0);
});
