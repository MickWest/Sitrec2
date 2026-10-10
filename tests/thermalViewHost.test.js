/** @jest-environment jsdom */
// The Sitrec look-view host: the Mach plausibility warning and the per-frame target range.
import {PerspectiveCamera, Scene, Vector3} from "three";
import {createThermalViewAdapter, thermalMachWarning} from "../src/rendering/ThermalViewAdapter";
import {Globals, NodeMan, Sit} from "../src/Globals";

jest.mock("../src/Globals", () => ({Globals: {equatorRadius: 6371000, polarRadius: 6371000},
    GlobalDateTimeNode: {dateNow: new Date("2014-11-11T16:55:00Z")},
    NodeMan: {get: jest.fn(), iterate: jest.fn()}, Sit: {fps: 30, lat: 0, lon: 0}, markSitchDirty: jest.fn(), setRenderOne: jest.fn()}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: () => 0}));
jest.mock("../src/par", () => ({par: {frame: 0, trackToTrackStopAt: 0}}));
jest.mock("../src/i18n", () => ({t: (key, values = {}) => {
    const en = jest.requireActual("../src/i18n/en.js").default;
    return key.split(".").reduce((value, part) => value?.[part], en)?.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]) ?? key;
}}));

test("implausible scene-derived airliner Mach warns and suggests an override without changing values", () => {
    const recipe = {parameters: {vehicleType: "aircraft", bodyStyle: "transport", engineType: "jet"}};
    const state = {mach: 2.5, sources: {mach: "groundSpeed"}};
    expect(thermalMachWarning(state, recipe)).toMatch(/2.500.*airliner.*Override/);
    expect(state.mach).toBe(2.5);
    expect(thermalMachWarning({...state, mach: .95}, recipe)).toBe("");
    expect(thermalMachWarning({...state, sources: {mach: "override"}}, recipe)).toBe("");
    expect(thermalMachWarning(state, {parameters: {...recipe.parameters, bodyStyle: "jet"}})).toBe("");
});

test("look host passes physical target range each frame without saving it into sensor settings", () => {
    const camera = new PerspectiveCamera(1, 1, 1, 500000);
    camera.position.set(Globals.equatorRadius + 1382, 0, 0);
    const target = new Vector3(Globals.equatorRadius + 1382, 125000, 0);
    camera.lookAt(target); camera.updateMatrixWorld(true);
    NodeMan.get.mockImplementation(id => id === "targetTrackSwitchSmooth" ? {p: () => target} : null);
    NodeMan.iterate.mockImplementation(() => {}); Sit.thermalEnvironment = undefined;
    const view = {camera, cameraNode: {thermalSensor: {turbulenceMode: "manual"}}, renderer: {}, renderMode: "physicalThermal"};
    const adapter = createThermalViewAdapter(view);
    const render = jest.spyOn(adapter.pipeline, "render").mockImplementation(() => {});
    try {
        adapter.render(new Scene(), 1);
        expect(render.mock.calls[0][0].psfRangeM).toBe(125000);
        target.y = 130000; adapter.render(new Scene(), 2);
        expect(render.mock.calls[1][0].psfRangeM).toBe(130000);
        expect(view.cameraNode.thermalSensor.psfRangeM).toBeUndefined();
    } finally {adapter.dispose();}
});
