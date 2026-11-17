import {Color, Group, PerspectiveCamera, Vector3} from "three";
import {PRESETS, normalizeParameters} from "../tools/vehicles/vehicleParameters.js";
import {KITE_LED_PATTERNS, KITE_LED_TAIL_PATTERNS, KITE_SHAPES} from "../tools/vehicles/kiteParameters.js";
import {sampleKiteLED} from "../tools/vehicles/kiteLEDPattern.js";
import {buildVehicle, disposeVehicle} from "../tools/vehicles/vehicle.js";
import {animateVehicleLights} from "../tools/vehicles/vehicleLights.js";
import {poseVehicleSpinners} from "../tools/vehicles/motion.js";
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
    expect(old.ledTailEnabled).toBe(false);
    expect(old.ledTailPattern).toBe("solid");
    const p = normalizeParameters({...defaults, ledSpokes: 200, ledPerSpoke: -1, ledPattern: "bad", ledSpeed: NaN});
    expect(p).toMatchObject({ledSpokes: 24, ledPerSpoke: 2, ledPattern: "spokes", ledSpeed: 0.35});
});

const tailParameters = extra => normalizeParameters({...defaults, ledEnabled: false, ledTailEnabled: true, tailCount: 2, ...extra});

test("LED tails default to solid color without sail lights, and handle designs without tails", () => {
    const p = tailParameters(), model = buildVehicle(p);
    expect(model.lamps).toHaveLength(2 * p.ledTailCount);
    for (const time of [0, 0.73, 100]) for (const [level, color] of states(model, p, time)) {
        expect(level).toBe(1); expect(color).toBe(p.ledTailColor.slice(1));
    }
    expect(states(model, {...p, ledTailEnabled: false}, 0).every(([level]) => level === 0)).toBe(true);
    const empty = buildVehicle({...p, tailCount: 0});
    expect(empty.lamps).toHaveLength(0);
    disposeVehicle(empty.root); disposeVehicle(model.root);
});

test.each(["ribbon", "tube"])("tail LEDs and preview halos follow %s joints at fixed local positions", tailStyle => {
    const p = tailParameters({tailStyle, tailCount: 3, tailTaper: 10, overallScale: 0.5});
    const model = buildVehicle(JSON.parse(JSON.stringify(p)));
    const local = model.lamps.map(lamp => lamp.light.position.toArray());
    const geometries = model.lamps.map(lamp => lamp.lens.geometry);
    const world = () => model.lamps.map(lamp => lamp.light.getWorldPosition(new Vector3()).toArray());
    poseVehicleSpinners(model.waves, 0.73, true); const first = world();
    animateVehicleLights(model, 0.73, true);
    for (const lamp of model.lamps) {
        expect(lamp.light.parent.userData.vehicleWave).toBeDefined();
        expect(lamp.light.parent).toBe(lamp.lens.parent);
        expect(lamp.glow.parent).toBe(lamp.light.parent);
        expect(lamp.light.intensity).toBeCloseTo(p.ledTailIntensity * 0.25);
    }
    poseVehicleSpinners(model.waves, 2.19, true);
    expect(world()).not.toEqual(first);
    expect(model.lamps.map(lamp => lamp.light.position.toArray())).toEqual(local);
    expect(model.lamps.map(lamp => lamp.lens.geometry)).toEqual(geometries);
    expect(new Set(model.lamps.map(lamp => lamp.glow.material.map)).size).toBe(1);
    poseVehicleSpinners(model.waves, 0.73, true); expect(world()).toEqual(first);
    disposeVehicle(model.root);
});

test.each(Object.keys(KITE_LED_TAIL_PATTERNS))("tail %s is deterministic, bounded, and can be held at a phase", ledTailPattern => {
    const p = tailParameters({ledTailPattern}), model = buildVehicle(p);
    const first = states(model, p, 0.73);
    if (ledTailPattern !== "solid") expect(states(model, p, 2.19)).not.toEqual(first);
    expect(states(model, p, 0.73)).toEqual(first);
    for (const time of [-100, 0, 0.73, 100]) for (const [level] of states(model, p, time)) {
        expect(level).toBeGreaterThanOrEqual(0); expect(level).toBeLessThanOrEqual(1);
    }
    expect(states(model, {...p, ledTailSpeed: 0, ledTailPhase: 123}, 1))
        .toEqual(states(model, {...p, ledTailSpeed: 0, ledTailPhase: 123}, 99));
    expect(states(model, {...p, ledTailSpeed: -p.ledTailSpeed}, 0.73)).toEqual(states(model, p, -0.73));
    disposeVehicle(model.root);
});

test("sail and tail patterns have independent switches, colors and intensity", () => {
    const p = tailParameters({ledEnabled: true, ledPattern: "steady", ledPalette: "solid", ledColor1: "#ff0000", ledTailIntensity: 20});
    const model = buildVehicle(p), sail = model.lamps.find(lamp => !lamp.light.userData.kiteLED.site.tail);
    const tail = model.lamps.find(lamp => lamp.light.userData.kiteLED.site.tail);
    expect(model.lamps).toHaveLength(128 + p.tailCount * p.ledTailCount);
    expect(new Set(model.lamps.map(lamp => lamp.light.name)).size).toBe(model.lamps.length);
    animateVehicleLights(model, 0.3, true);
    expect(tail.light.color.getHexString()).toBe(p.ledTailColor.slice(1));
    expect(tail.light.intensity).toBe(20);
    expect(sail.light.color.getHexString()).toBe("ff0000");
    const sample = (lamp, settings) => sampleKiteLED(lamp.light.userData.kiteLED.site, settings, 0.3).level;
    expect(sample(tail, {...p, ledEnabled: false})).toBe(1);
    expect(sample(sail, {...p, ledTailEnabled: false})).toBe(1);
    const staggered = {...p, ledTailPattern: "pulse", ledTailStagger: 180};
    const tail2 = model.lamps.find(lamp => lamp.light.userData.kiteLED.site.tailIndex === 1);
    expect(sample(tail, staggered) + sample(tail2, staggered)).toBeCloseTo(1);
    disposeVehicle(model.root);
});

test("native tail billboards follow posed joints through object and overall scaling in each view", () => {
    const p = tailParameters({overallScale: 0.5}), model = buildVehicle(p);
    const scene = new Group(); scene.position.set(100, 20, -50); scene.rotation.y = 0.8; scene.scale.setScalar(3); scene.add(model.root);
    const lamp = model.lamps[p.ledTailCount - 1], node = new CNode3DLight({id: "tailLED", light: lamp.light, scene});
    node.vehicleLens = lamp.lens;
    const geometry = node._object.geometry, camera = new PerspectiveCamera(40, 1, 0.1, 10000);
    for (const time of [0.73, 2.19, 0.73]) {
        poseVehicleSpinners(model.waves, time, true); node.update(time * Sit.fps);
        for (const x of [0, 200]) {
            camera.position.set(x, 15, 30); node.preRender({camera});
            expect(node._object.getWorldPosition(new Vector3()).distanceTo(lamp.light.getWorldPosition(new Vector3()))).toBeLessThan(1e-9);
            expect(node._object.geometry).toBe(geometry);
        }
        expect(node.light.intensity).toBeCloseTo(p.ledTailIntensity * 0.25);
    }
    node.dispose(); disposeVehicle(model.root);
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
