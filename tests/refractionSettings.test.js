// The master switch and its two halves, and the migration for sitches saved
// before the master existed.

jest.mock("../src/Globals", () => ({
    Sit: {},
    // No earth radii set, so the refraction helpers use WGS84.
    Globals: {},
    guiMenus: {},
    setRenderOne: () => {},
}));

import {Globals, Sit} from "../src/Globals";
import {
    apparentPositionFrom,
    applyRefractionMaster,
    ensureRefractionSettings,
    installTerrestrialRefractionSceneHook,
    resetTerrestrialRefractionSweep,
} from "../src/atmosphere/refractionSettings";
import {Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, SphereGeometry, Vector3} from "three";

function reset(props = {}) {
    for (const k of Object.keys(Sit)) delete Sit[k];
    Object.assign(Sit, props);
}

describe("master switch", () => {

    test("a fresh sitch is on, with both halves armed", () => {
        reset();
        ensureRefractionSettings();
        expect(Sit.refraction).toBe(true);
        expect(Sit.refractionSky).toBe(true);
        expect(Sit.refractionTerrain).toBe(true);
        // ...so both halves are refracting from the start
        expect(Sit.refractionEnabled).toBe(true);
        expect(Sit.terrestrialRefraction).toBe(true);
    });

    test("one switch turns on both halves — the point of the coupling", () => {
        reset();
        ensureRefractionSettings();
        Sit.refraction = true;
        applyRefractionMaster();
        expect(Sit.refractionEnabled).toBe(true);
        expect(Sit.terrestrialRefraction).toBe(true);
    });

    test("either half can be taken back out on its own", () => {
        reset();
        ensureRefractionSettings();
        Sit.refraction = true;

        Sit.refractionTerrain = false;
        applyRefractionMaster();
        expect(Sit.refractionEnabled).toBe(true);
        expect(Sit.terrestrialRefraction).toBe(false);

        Sit.refractionTerrain = true;
        Sit.refractionSky = false;
        applyRefractionMaster();
        expect(Sit.refractionEnabled).toBe(false);
        expect(Sit.terrestrialRefraction).toBe(true);
    });

    test("the master overrides both halves when off", () => {
        reset();
        ensureRefractionSettings();
        Sit.refraction = false;
        Sit.refractionSky = true;
        Sit.refractionTerrain = true;
        applyRefractionMaster();
        expect(Sit.refractionEnabled).toBe(false);
        expect(Sit.terrestrialRefraction).toBe(false);
    });
});

describe("migration from pre-master sitches", () => {

    test("a saved refracted sky becomes master-on with both halves", () => {
        reset({refractionEnabled: true, refractionPressure: 1017, refractionTemp: 19});
        ensureRefractionSettings();
        expect(Sit.refraction).toBe(true);
        expect(Sit.refractionSky).toBe(true);
        expect(Sit.refractionTerrain).toBe(true);
        // the ground now refracts too, which is the intended change
        expect(Sit.terrestrialRefraction).toBe(true);
        // and the user's chosen air is left alone
        expect(Sit.refractionPressure).toBe(1017);
        expect(Sit.refractionTemp).toBe(19);
    });

    test("a saved sitch with refraction off stays off", () => {
        reset({refractionEnabled: false});
        ensureRefractionSettings();
        expect(Sit.refraction).toBe(false);
        expect(Sit.refractionEnabled).toBe(false);
        expect(Sit.terrestrialRefraction).toBe(false);
    });

    test("an already-migrated sitch is left exactly as saved", () => {
        reset({refraction: true, refractionSky: false, refractionTerrain: true});
        ensureRefractionSettings();
        expect(Sit.refraction).toBe(true);
        expect(Sit.refractionSky).toBe(false);
        expect(Sit.refractionTerrain).toBe(true);
        expect(Sit.refractionEnabled).toBe(false);
        expect(Sit.terrestrialRefraction).toBe(true);
    });

    test("migration runs once — a second call does not re-arm a cleared half", () => {
        reset({refractionEnabled: true});
        ensureRefractionSettings();
        Sit.refractionTerrain = false;
        ensureRefractionSettings();
        expect(Sit.refractionTerrain).toBe(false);
    });

    test("defaults for the derived-k inputs are filled in too", () => {
        reset();
        ensureRefractionSettings();
        expect(Sit.refractionPressure).toBe(1010);
        expect(Sit.refractionTemp).toBe(10);
        expect(Sit.terrestrialLapseRate).toBe(-6.5);
        expect(Sit.terrestrialRefractionOverrideK).toBe(false);
    });
});

// Where a camera that points at a target aims. The target is drawn lofted, so the camera
// must aim at the lofted position or the target is drawn off the centre of the picture.
describe("aiming at a target", () => {

    // On the equator at 3.5 km, looking at a target 161.7 km away: the test sitch.
    const camera = new Vector3(6378137 + 3491, 0, 0);
    const target = new Vector3(6378137 + 3491 - 1956, 161717, 0);

    test("with refraction on, the aim point is straight above the target", () => {
        reset();
        ensureRefractionSettings();
        const aim = apparentPositionFrom(camera, target);
        expect(aim.y).toBeCloseTo(target.y, 6);
        expect(aim.z).toBeCloseTo(target.z, 6);
        const lift = aim.x - target.x;
        // 0.085 degrees at 161.7 km
        expect(lift).toBeGreaterThan(200);
        expect(lift).toBeLessThan(260);
    });

    test("with the terrain half off, the aim point is the target itself", () => {
        reset();
        ensureRefractionSettings();
        Sit.refractionTerrain = false;
        applyRefractionMaster();
        expect(apparentPositionFrom(camera, target).equals(target)).toBe(true);
    });

    test("it does not change the target it is given", () => {
        reset();
        ensureRefractionSettings();
        const before = target.clone();
        apparentPositionFrom(camera, target);
        expect(target.equals(before)).toBe(true);
    });
});

// Before each render the scene hook decides, from the LOFTED position, which objects Three's
// frustum test must not reject. Fisheye and Flat Earth switch that test off for every object
// themselves, and the hook must leave their setting alone.
describe("frustum culling in the scene hook", () => {

    // On the equator at 3.5 km, with an airliner 125 km away and a 0.118 degree field of view.
    const CAMERA = new Vector3(6378137 + 3491, 0, 0);
    const TARGET = new Vector3(6378137 + 3491 - 1200, 125000, 0);

    function build() {
        reset();
        ensureRefractionSettings();
        delete Globals.fisheye;
        delete Globals.flatEarthRendering;
        const scene = new Scene();
        const wing = new Mesh(new SphereGeometry(8), new MeshBasicMaterial());
        wing.position.copy(TARGET);
        const offToTheSide = new Mesh(new SphereGeometry(8), new MeshBasicMaterial());
        offToTheSide.position.copy(TARGET).add(new Vector3(0, 0, 5000));
        scene.add(wing, offToTheSide);
        scene.updateMatrixWorld(true);
        const camera = new PerspectiveCamera(0.118, 16 / 9, 1, 1e7);
        camera.position.copy(CAMERA);
        camera.up.set(1, 0, 0);
        camera.lookAt(apparentPositionFrom(CAMERA, TARGET));
        camera.updateMatrixWorld();
        installTerrestrialRefractionSceneHook(scene);
        const render = () => scene.onBeforeRender(null, scene, camera, null);
        return {wing, offToTheSide, render};
    }

    test("an object in the picture is exempted, and one outside it is not", () => {
        const {wing, offToTheSide, render} = build();
        render();
        expect(wing.frustumCulled).toBe(false);
        expect(offToTheSide.frustumCulled).toBe(true);
    });

    test("with refraction switched off, the exemption is taken away again", () => {
        const {wing, render} = build();
        render();
        Sit.refractionTerrain = false;
        applyRefractionMaster();
        render();
        expect(wing.frustumCulled).toBe(true);
    });

    test("the ray-traced pass holding one view off keeps the lofted objects for the others", () => {
        const {wing, render} = build();
        resetTerrestrialRefractionSweep();
        render();
        expect(wing.frustumCulled).toBe(false);
        // RefractionPass.begin(): the terrain half off for one render, the master still on.
        Sit.terrestrialRefraction = false;
        render();
        expect(wing.frustumCulled).toBe(true);
        Sit.terrestrialRefraction = true;
        // The next view, before the next sweep, still exempts the wing.
        render();
        expect(wing.frustumCulled).toBe(false);
    });

    test("with refraction switched off, the hook lets go of the objects", () => {
        const {wing, render} = build();
        resetTerrestrialRefractionSweep();
        render();
        Sit.refractionTerrain = false;
        applyRefractionMaster();
        render();
        expect(wing.frustumCulled).toBe(true);
        // A later change to the object's own setting is not undone by later renders.
        wing.frustumCulled = false;
        render();
        expect(wing.frustumCulled).toBe(false);
    });

    for (const [name, switchOn, switchOff] of [
        ["Fisheye", () => { Globals.fisheye = {enabled: true}; }, () => { Globals.fisheye.enabled = false; }],
        ["Flat Earth", () => { Globals.flatEarthRendering = true; }, () => { Globals.flatEarthRendering = false; }],
    ]) {
        test(`${name} owns the setting while it is on`, () => {
            const {wing, offToTheSide, render} = build();
            render();
            // The mode comes on and switches culling off for everything, as its sweep does.
            switchOn();
            wing.frustumCulled = false;
            offToTheSide.frustumCulled = false;
            render();
            expect(offToTheSide.frustumCulled).toBe(false);
            // Refraction goes off while the mode is on: still the mode's setting.
            Sit.refractionTerrain = false;
            applyRefractionMaster();
            render();
            expect(wing.frustumCulled).toBe(false);
            expect(offToTheSide.frustumCulled).toBe(false);
            // The mode goes off and puts back what it changed. The hook takes over again.
            Sit.refractionTerrain = true;
            applyRefractionMaster();
            switchOff();
            wing.frustumCulled = true;
            offToTheSide.frustumCulled = true;
            render();
            expect(wing.frustumCulled).toBe(false);
            expect(offToTheSide.frustumCulled).toBe(true);
        });
    }
});
