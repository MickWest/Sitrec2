// The master switch and its two halves, and the migration for sitches saved
// before the master existed.

jest.mock("../src/Globals", () => ({
    Sit: {},
    guiMenus: {},
    setRenderOne: () => {},
}));

import {Sit} from "../src/Globals";
import {
    applyRefractionMaster,
    ensureRefractionSettings,
} from "../src/atmosphere/refractionSettings";

function reset(props = {}) {
    for (const k of Object.keys(Sit)) delete Sit[k];
    Object.assign(Sit, props);
}

describe("master switch", () => {

    test("a fresh sitch is off, with both halves armed", () => {
        reset();
        ensureRefractionSettings();
        expect(Sit.refraction).toBe(false);
        expect(Sit.refractionSky).toBe(true);
        expect(Sit.refractionTerrain).toBe(true);
        // ...so nothing is actually refracting yet
        expect(Sit.refractionEnabled).toBe(false);
        expect(Sit.terrestrialRefraction).toBe(false);
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
