// The readers that need a camera's LINE OF SIGHT, not its picture: the KML/MISB camera
// pose and the copy of the camera's angles into the PTZ controller.
//
// With refraction on, a camera pointed at a target is aimed at where the target is DRAWN
// and carries the rotation back to the geometric direction (camera.userData.geometricAim).
// These readers turn the camera's orientation by it, so they give the straight line to the
// target. With refraction off there is no rotation and they read the camera as it is.

import {afterAll, beforeAll, beforeEach, expect, jest, test} from "@jest/globals";
import {PerspectiveCamera, Vector3} from "three";

let mockRefraction = true;

jest.mock("../src/nodes/CNodeController", () => ({CNodeController: class {
    constructor() { this.simpleSerials = []; }
}}));
jest.mock("../src/raycastGround", () => ({raycastGroundElevationFast: () => null}));
jest.mock("../src/EGM96Geoid", () => ({meanSeaLevelOffset: () => 0, ensureGeoidLoaded: async () => {}}));
// The real lift, with a switch in place of the Sit settings.
jest.mock("../src/atmosphere/refractionSettings", () => ({
    currentTerrestrialLiftContext: (observer) => {
        const {terrestrialLiftContext} = jest.requireActual("../src/atmosphere/terrestrialRefraction");
        return terrestrialLiftContext(observer, {enabled: mockRefraction, k: 0.176});
    },
}));

const {setNodeMan, setSit} = require("../src/Globals");
const {lookAtDrawnPosition, turnToGeometricAim} = require("../src/atmosphere/refractionAim");
const {extractRoll, getCameraKMLPose} = require("../src/ExportCameraKML");
const {CNodeControllerAzElZoom, CNodeControllerPTZUI} = require("../src/nodes/CNodeControllerPTZUI");
const {getAzElFromPositionAndForward, getLocalUpVector} = require("../src/SphericalMath");

// On the equator at 3.5 km, looking at a target 161.7 km away (as toTargetRefractionAim).
const CAMERA = new Vector3(6378137 + 3491, 0, 0);
const TARGET = new Vector3(6378137 + 3491 - 1956, 161717, 0);
const toTarget = TARGET.clone().sub(CAMERA).normalize();
const degreesBetween = (a, b) => a.angleTo(b) * 180 / Math.PI;

let camera;
beforeAll(() => {
    setSit({lat: 0, lon: 0, frames: 900, fps: 30});
    setNodeMan({get: () => undefined, exists: () => false});
});
afterAll(() => setNodeMan(undefined));
beforeEach(() => {
    mockRefraction = true;
    camera = new PerspectiveCamera(0.224, 1.1, 1, 10000000);
    camera.position.copy(CAMERA);
    camera.up.copy(getLocalUpVector(CAMERA));
});

// Aim the camera as To Target does, with a little roll, as a roll setting adds.
function aimAtTarget() {
    lookAtDrawnPosition(camera, TARGET);
    camera.rotateZ(0.1);
    camera.updateMatrixWorld(true);
}

test("turnToGeometricAim turns directions and quaternions, and leaves an unturned camera alone", () => {
    aimAtTarget();
    const forward = camera.getWorldDirection(new Vector3());
    expect(degreesBetween(forward, toTarget)).toBeGreaterThan(0.08);
    turnToGeometricAim(camera, forward);
    expect(degreesBetween(forward, toTarget)).toBeLessThan(1e-6);

    const quaternion = camera.quaternion.clone();
    turnToGeometricAim(camera, quaternion);
    expect(degreesBetween(new Vector3(0, 0, -1).applyQuaternion(quaternion), toTarget)).toBeLessThan(1e-6);

    camera.userData.geometricAim = null;
    const unchanged = camera.getWorldDirection(new Vector3());
    const before = unchanged.clone();
    const quaternionBefore = camera.quaternion.clone();
    turnToGeometricAim(camera, unchanged, quaternionBefore);
    expect(unchanged.equals(before)).toBe(true);
    expect(quaternionBefore.equals(camera.quaternion)).toBe(true);
});

test("the KML and MISB camera pose is the line of sight, and keeps the roll", () => {
    aimAtTarget();
    const apparentForward = camera.getWorldDirection(new Vector3());
    const apparentUp = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const pose = getCameraKMLPose({camera});
    expect(degreesBetween(pose.forward, toTarget)).toBeLessThan(1e-6);
    const [heading, elevation] = getAzElFromPositionAndForward(CAMERA, toTarget);
    expect(pose.heading).toBeCloseTo(heading, 6);
    expect(pose.tilt).toBeCloseTo(elevation + 90, 6);
    // Turning about the horizontal axis keeps the roll.
    expect(pose.roll).toBeCloseTo(extractRoll(CAMERA, apparentForward, apparentUp), 6);
    expect(Math.abs(pose.roll)).toBeGreaterThan(5);
});

test("with refraction off the KML pose is the camera as it is", () => {
    mockRefraction = false;
    aimAtTarget();
    expect(camera.userData.geometricAim).toBeNull();
    const pose = getCameraKMLPose({camera});
    expect(pose.forward.equals(camera.getWorldDirection(new Vector3()))).toBe(true);
    expect(degreesBetween(pose.forward, toTarget)).toBeLessThan(1e-6);
});

// A PTZ controller as the custom sitch has it, without its GUI.
function ptzController() {
    return Object.assign(Object.create(CNodeControllerPTZUI.prototype), {
        roll: 0, az: 0, el: 0, fov: 0.224, relative: false, satellite: false,
        outputs: [{isCamera: true, camera}],
        updateSatelliteSliderRanges() {}, updateSatelliteSliderVisibility() {}, refresh() {},
    });
}

test("the angles copied into the PTZ controller are the line of sight", () => {
    aimAtTarget();
    const ptz = ptzController();
    ptz.syncFromCamera(camera);
    const [az, el] = getAzElFromPositionAndForward(CAMERA, toTarget);
    expect(ptz.az).toBeCloseTo(az > 180 ? az - 360 : az, 6);
    expect(ptz.el).toBeCloseTo(el, 6);

    // The PTZ controller carries no rotation, so the camera it aims looks at the target.
    const objectNode = {camera, getUpVector: getLocalUpVector, syncUIPosition() {}};
    CNodeControllerAzElZoom.prototype.apply.call(ptz, 0, objectNode);
    expect(degreesBetween(camera.getWorldDirection(new Vector3()), toTarget)).toBeLessThan(1e-6);
});

test("leaving PTZ satellite mode copies the line of sight too", () => {
    aimAtTarget();
    const ptz = ptzController();
    ptz.syncModeTransition();
    const [az, el] = getAzElFromPositionAndForward(CAMERA, toTarget);
    expect(ptz.az).toBeCloseTo(az > 180 ? az - 360 : az, 6);
    expect(ptz.el).toBeCloseTo(el, 6);
});

test("with refraction off the PTZ copy is the camera's own aim", () => {
    mockRefraction = false;
    aimAtTarget();
    const ptz = ptzController();
    ptz.syncFromCamera(camera);
    const [az, el] = getAzElFromPositionAndForward(CAMERA, camera.getWorldDirection(new Vector3()));
    expect(ptz.az).toBeCloseTo(az > 180 ? az - 360 : az, 9);
    expect(ptz.el).toBeCloseTo(el, 9);
});

test("a quaternion and the directions from it turn alike", () => {
    aimAtTarget();
    const quaternion = camera.quaternion.clone();
    const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    turnToGeometricAim(camera, quaternion, up);
    expect(up.distanceTo(new Vector3(0, 1, 0).applyQuaternion(quaternion))).toBeLessThan(1e-12);
});
