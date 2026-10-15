import {beforeEach, expect, jest, test} from "@jest/globals";
import {PerspectiveCamera, Quaternion, Vector3} from "three";
import {CNodeControllerPTZUI} from "../src/nodes/CNodeControllerPTZUI";
import {NodeMan} from "../src/Globals";

jest.mock("../src/nodes/CNodeController", () => ({CNodeController: class {
    constructor() { this.simpleSerials = []; }
}}));
jest.mock("../src/Globals", () => ({
    Globals: {equatorRadius: 6378137, polarRadius: 6356752.314245},
    Sit: {frames: 900, fps: 30, lat: 0, lon: 0},
    guiMenus: {}, NodeMan: {get: jest.fn()},
}));
jest.mock("../src/par", () => ({par: {paused: true}}));
jest.mock("../src/CViewManager", () => ({}));
jest.mock("../src/LLA-ECEF-ENU", () => ({}));
jest.mock("../src/KeyBoardHandler", () => ({}));
jest.mock("../src/threeExt", () => ({}));
jest.mock("../src/CelestialMath", () => ({}));
jest.mock("../src/atmosphere/refractionSettings", () => ({
    currentTerrestrialLiftContext: () => null,
}));
jest.mock("../src/mouseMoveView", () => ({}));
jest.mock("../src/JetUtils", () => ({}));
jest.mock("../src/i18n", () => ({}));

// A point 1 km above a sphere, near enough to the ellipsoid for the local frame to be sane.
function site(latDeg, lonDeg) {
    const lat = latDeg * Math.PI / 180, lon = lonDeg * Math.PI / 180, r = 6372000;
    return new Vector3(r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat));
}
const P1 = site(33, -106);
const P2 = site(35.5, -104);    // about 330 km away

let camera, objectNode, ptz;
beforeEach(() => {
    NodeMan.get.mockImplementation(() => undefined);
    camera = new PerspectiveCamera(30, 1.5, 1, 10000000);
    camera.position.copy(P1);
    objectNode = {camera};
    ptz = Object.assign(Object.create(CNodeControllerPTZUI.prototype), {
        az: 30, el: 20, roll: 5, fov: 30, nearPlane: 0.1, relative: false, lockForward: true,
        satellite: false, rotation: 0, _lock: null, satQuat: new Quaternion(), _satQuatDirty: true,
        updateSatelliteSliderRanges() {}, updateSatelliteSliderVisibility() {},
        updateAspectLockAvailability() {}, updateAspectReadout() {}, updateLensReadout() {},
    });
});

function applyAt(position) {
    camera.position.copy(position);
    ptz.apply(0, objectNode);
    return camera.quaternion.clone();
}

test("moving the camera keeps its orientation in space and changes Pan and Tilt", () => {
    const q1 = applyAt(P1);
    const q2 = applyAt(P2);
    expect(q2.angleTo(q1)).toBeLessThan(1e-9);
    expect(Math.abs(ptz.az - 30) + Math.abs(ptz.el - 20)).toBeGreaterThan(0.5);
});

test("the angles depend only on where the camera is, and repeated moves do not drift", () => {
    const q1 = applyAt(P1);
    for (let i = 0; i < 200; i++) { applyAt(P2); applyAt(P1); }
    expect(camera.quaternion.angleTo(q1)).toBeLessThan(1e-9);
    expect(ptz.az).toBeCloseTo(30, 6);   // lookAt(position + fwd) at ECEF scale limits this, not drift
    expect(ptz.el).toBeCloseTo(20, 6);
    expect(ptz.roll).toBeCloseTo(5, 6);
});

test("changing the angles sets a new direction to hold", () => {
    applyAt(P1);
    applyAt(P2);
    ptz.az = ptz.az + 10;
    const held = applyAt(P2);
    expect(applyAt(P1).angleTo(held)).toBeLessThan(1e-9);
});

test("Satellite Mode holds the orientation too", () => {
    Object.assign(ptz, {satellite: true, el: -40, az: 15, roll: 70, _satQuatDirty: true});
    const q1 = applyAt(P1);
    const q2 = applyAt(P2);
    expect(q2.angleTo(q1)).toBeLessThan(1e-9);
    expect(ptz.satellite).toBe(true);
});

test("off, or with Relative Heading, the angles stay and the orientation turns with the ground", () => {
    ptz.lockForward = false;
    const q1 = applyAt(P1);
    const q2 = applyAt(P2);
    expect(q2.angleTo(q1)).toBeGreaterThan(0.01);
    expect(ptz.az).toBe(30);
    expect(ptz.el).toBe(20);

    Object.assign(ptz, {lockForward: true, relative: true});
    applyAt(P1);
    applyAt(P2);
    expect(ptz.az).toBe(30);
    expect(ptz.el).toBe(20);
    expect(ptz._lock).toBe(null);
});
