// A camera that points at a target aims at where terrestrial refraction DRAWS the target,
// and carries the rotation back to the geometric direction, so that the line of sight used
// for calculations is still the straight line to the target.

import {beforeEach, expect, jest, test} from "@jest/globals";
import {PerspectiveCamera, Vector3} from "three";
import {CNodeControllerLookAtTrack, CNodeControllerTrackToTrack} from "../src/nodes/CNodeControllerVarious";
import {getLocalUpVector} from "../src/SphericalMath";
import {liftWorldPoint, terrestrialLiftContext} from "../src/atmosphere/terrestrialRefraction";

let mockRefraction = true;

jest.mock("../src/nodes/CNodeController", () => ({CNodeController: class {
    constructor() { this.simpleSerials = []; }
}}));
jest.mock("../src/Globals", () => ({
    Globals: {equatorRadius: 6378137, polarRadius: 6356752.314245},
    Sit: {frames: 900, fps: 30, lat: 0, lon: 0},
    guiMenus: {}, NodeMan: {get: jest.fn()},
}));
jest.mock("../src/par", () => ({par: {paused: true, trackToTrackStopAt: 0}}));
jest.mock("../src/LLA-ECEF-ENU", () => ({}));
jest.mock("../src/KeyBoardHandler", () => ({}));
jest.mock("../src/threeExt", () => ({}));
jest.mock("../src/CelestialMath", () => ({}));
jest.mock("../src/mouseMoveView", () => ({}));
jest.mock("../src/JetUtils", () => ({}));
jest.mock("../src/i18n", () => ({}));
// The real lift, with a switch in place of the Sit settings.
jest.mock("../src/atmosphere/refractionSettings", () => ({
    currentTerrestrialLiftContext: (observer) => {
        const {terrestrialLiftContext} = jest.requireActual("../src/atmosphere/terrestrialRefraction");
        return terrestrialLiftContext(observer, {enabled: mockRefraction, k: 0.176});
    },
}));

// On the equator at 3.5 km, looking at a target 161.7 km away: the test sitch.
const CAMERA = new Vector3(6378137 + 3491, 0, 0);
const TARGET = new Vector3(6378137 + 3491 - 1956, 161717, 0);

const forward = camera => new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
const degreesBetween = (a, b) => a.angleTo(b) * 180 / Math.PI;

let camera, objectNode, toTarget;
beforeEach(() => {
    mockRefraction = true;
    camera = new PerspectiveCamera(0.224, 1.1, 1, 10000000);
    // The camera has a position from the frame before, and takes its up direction from it.
    camera.position.copy(CAMERA);
    objectNode = {camera, getUpVector: getLocalUpVector, syncUIPosition() {}};
    toTarget = Object.assign(Object.create(CNodeControllerTrackToTrack.prototype), {
        in: {
            sourceTrack: {p: () => CAMERA.clone()},
            targetTrack: {p: () => TARGET.clone()},
        },
    });
});

test("To Target aims at the drawn position, which is above the geometric one", () => {
    toTarget.apply(0, objectNode);
    const drawn = liftWorldPoint(terrestrialLiftContext(CAMERA, {enabled: true, k: 0.176}), TARGET);
    const toDrawn = drawn.clone().sub(CAMERA).normalize();
    const toGeometric = TARGET.clone().sub(CAMERA).normalize();

    expect(degreesBetween(forward(camera), toDrawn)).toBeLessThan(1e-6);
    // 0.085 degrees: three quarters of the half-height of this 0.224 degree field of view.
    const offGeometric = degreesBetween(forward(camera), toGeometric);
    expect(offGeometric).toBeGreaterThan(0.080);
    expect(offGeometric).toBeLessThan(0.090);
    // and it is the upward side
    expect(forward(camera).x).toBeGreaterThan(toGeometric.x);
});

test("the camera carries the rotation back to the straight line to the target", () => {
    toTarget.apply(0, objectNode);
    const toGeometric = TARGET.clone().sub(CAMERA).normalize();
    const lineOfSight = forward(camera).applyQuaternion(camera.userData.geometricAim);
    expect(degreesBetween(lineOfSight, toGeometric)).toBeLessThan(1e-6);
    // At the target's range, that is a miss of less than a centimetre, not 240 m.
    const range = TARGET.distanceTo(CAMERA);
    expect(lineOfSight.multiplyScalar(range).add(CAMERA).distanceTo(TARGET)).toBeLessThan(0.01);
});

test("with refraction off it is a plain lookAt, and no rotation is carried", () => {
    mockRefraction = false;
    toTarget.apply(0, objectNode);
    const toGeometric = TARGET.clone().sub(CAMERA).normalize();
    expect(degreesBetween(forward(camera), toGeometric)).toBeLessThan(1e-6);
    expect(camera.userData.geometricAim).toBeNull();
});

test("a rotation from an earlier pass does not stay when refraction is switched off", () => {
    toTarget.apply(0, objectNode);
    expect(camera.userData.geometricAim).not.toBeNull();
    mockRefraction = false;
    toTarget.apply(0, objectNode);
    expect(camera.userData.geometricAim).toBeNull();
});

test("Look At Track aims the same way", () => {
    const lookAt = Object.assign(Object.create(CNodeControllerLookAtTrack.prototype), {
        in: {targetTrack: {p: () => TARGET.clone()}},
    });
    camera.position.copy(CAMERA);
    lookAt.apply(0, objectNode);
    const toGeometric = TARGET.clone().sub(CAMERA).normalize();
    expect(degreesBetween(forward(camera), toGeometric)).toBeGreaterThan(0.080);
    const lineOfSight = forward(camera).applyQuaternion(camera.userData.geometricAim);
    expect(degreesBetween(lineOfSight, toGeometric)).toBeLessThan(1e-6);
});
