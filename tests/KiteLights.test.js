import {Color, Group} from "three";
import {PRESETS, normalizeParameters} from "../tools/vehicles/vehicleParameters.js";
import {KITE_LED_PATTERNS, KITE_SHAPES} from "../tools/vehicles/kiteParameters.js";
import {sampleKiteLED} from "../tools/vehicles/kiteLEDPattern.js";
import {buildVehicle, disposeVehicle} from "../tools/vehicles/vehicle.js";
import {animateVehicleLights} from "../tools/vehicles/vehicleLights.js";
import {captureVehicleLightOverrides, vehicleLightState} from "../src/procedural/VehicleLightState.js";
import {CNode3DLight} from "../src/nodes/CNode3DLight.js";
import {Sit, NodeMan} from "../src/Globals";

jest.mock("../src/nodes/CNode3D", () => ({CNode3D: class {constructor(v) {this.id = v.id;} update() {} dispose() {}}}));
jest.mock("../src/nodes/CNodeGUIValue", () => ({CNodeGUIValue: class {}}));
jest.mock("../src/nodes/CNodeGUIColor", () => ({CNodeGUIColor: class {}}));
jest.mock("../src/Globals", () => ({Sit: {fps: 30, simSpeed: 1}, NodeMan: {disposeRemove: jest.fn(), get: jest.fn()}}));
jest.mock("../src/par", () => ({par: {time: 0}}));
jest.mock("../src/atmosphere/terrestrialRefraction", () => ({installTerrestrialRefractionOnShaderMaterial: jest.fn()}));

const defaults = PRESETS.find(item => item.id === "kite-delta-led").parameters;
const states = (model, p, seconds) => model.lamps.map(lamp => {
    const state = sampleKiteLED(lamp.light.userData.kiteLED.site, p, seconds);
    return [state.level, state.color.getHexString()];
});

test("old kites keep LEDs off and invalid layout values are bounded", () => {
    const old = normalizeParameters({vehicleType: "kite"});
    expect(old.ledEnabled).toBe(false);
    const p = normalizeParameters({...defaults, ledSpokes: 200, ledPerSpoke: -1, ledPattern: "bad", ledSpeed: NaN});
    expect(p).toMatchObject({ledSpokes: 24, ledPerSpoke: 2, ledPattern: "spokes", ledSpeed: 0.35});
});

test.each(Object.keys(KITE_SHAPES))("the fixed array conforms to %s and survives a recipe round trip", kiteShape => {
    const p = normalizeParameters({...defaults, kiteShape});
    const model = buildVehicle(JSON.parse(JSON.stringify(p)));
    expect(model.lamps).toHaveLength(p.ledSpokes * (p.ledPerSpoke + p.ledRings));
    expect(new Set(model.lamps.map(lamp => lamp.light.name)).size).toBe(model.lamps.length);
    expect(model.lamps.every(lamp => lamp.light.position.toArray().every(Number.isFinite))).toBe(true);
    expect(new Set(model.lamps.map(lamp => lamp.light.position.toArray().join(","))).size).toBe(model.lamps.length);
    disposeVehicle(model.root);
});

test.each(Object.keys(KITE_LED_PATTERNS))("%s changes only colors/intensities and repeats after backwards seeking", ledPattern => {
    const p = {...defaults, ledPattern}, model = buildVehicle(p);
    const positions = model.lamps.map(lamp => lamp.light.position.toArray());
    const first = states(model, p, 0.73), later = states(model, p, 2.19);
    if (ledPattern !== "steady") expect(later).not.toEqual(first);
    expect(states(model, p, 0.73)).toEqual(first);
    for (const time of [-100, 0, 0.73, 2.19, 100]) {
        animateVehicleLights(model, time, true);
        expect(model.lamps.map(lamp => lamp.light.position.toArray())).toEqual(positions);
        expect(model.lamps.every(lamp => !lamp.light.visible)).toBe(true); // no shader-light explosion in the studio
        for (const [level] of states(model, p, time)) {expect(level).toBeGreaterThanOrEqual(0); expect(level).toBeLessThanOrEqual(1);}
    }
    expect(states(model, {...p, ledEnabled: false}, 1).every(([level]) => level === 0)).toBe(true);
    expect(states(model, {...p, ledSpeed: 0}, 1)).toEqual(states(model, {...p, ledSpeed: 0}, 99));
    disposeVehicle(model.root);
});

test("a rotating bar advances across fixed strips and speed reverses its direction", () => {
    const p = {...defaults, ledPattern: "bar", ledSpeed: 1, ledWidth: 10}, model = buildVehicle(p);
    const level = (strip, time, parameters = p) => sampleKiteLED(model.lamps[strip * p.ledPerSpoke].light.userData.kiteLED.site, parameters, time).level;
    expect(level(0, 0)).toBeCloseTo(1); expect(level(4, 0)).toBe(0);
    expect(level(4, 0.25)).toBeCloseTo(1); expect(level(0, 0.25)).toBe(0);
    expect(level(1, 1 / 16)).toBeCloseTo(1);
    expect(level(15, 1 / 16, {...p, ledSpeed: -1})).toBeCloseTo(1);
    disposeVehicle(model.root);
});

test("native aircraft light nodes drive LEDs without geometry churn or saved animation overrides", () => {
    const p = {...defaults, ledPattern: "bar", ledSpeed: 1, overallScale: 0.5}, model = buildVehicle(p);
    const lamp = model.lamps[0], node = new CNode3DLight({id: "testLED", light: lamp.light, scene: new Group()});
    node.vehicleLens = lamp.lens;
    const geometry = node._object.geometry, baseline = {[node.light.name]: vehicleLightState(node)};
    node.update(0); expect(node.light.intensity).toBeCloseTo(p.ledIntensity * 0.25);
    node.update(7.5); expect(node.light.intensity).toBe(0); expect(node._object.visible).toBe(false);
    node.update(0); expect(node._object.visible).toBe(true);
    expect(node._object.geometry).toBe(geometry);
    expect(captureVehicleLightOverrides([node], baseline)).toEqual({});
    Sit.simSpeed = 2; node.update(3.75); expect(node.light.intensity).toBe(0); Sit.simSpeed = 1;
    node.suppressBillboard = true; node.update(0); expect(node._object.visible).toBe(false);
    node.lightVisible = false; node.update(0); expect(lamp.lens.material.emissiveIntensity).toBe(0);
    node.dispose(); expect(NodeMan.disposeRemove).toHaveBeenCalled(); disposeVehicle(model.root);
});
