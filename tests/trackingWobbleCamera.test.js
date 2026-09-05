import {beforeEach, expect, jest, test} from "@jest/globals";
import {PerspectiveCamera, Vector3} from "three";
import {CNodeControllerTrackingWobble} from "../src/nodes/CNodeControllerTrackingWobble";
import {CNodeControllerAzElZoom, CNodeControllerPTZUI} from "../src/nodes/CNodeControllerPTZUI";
import {CNodeControllerTrackToTrack} from "../src/nodes/CNodeControllerVarious";
import {getLocalUpVector} from "../src/SphericalMath";
import {NodeMan} from "../src/Globals";

jest.mock("../src/nodes/CNodeController", () => ({CNodeController: class {
    constructor() { this.simpleSerials = []; }
}}));
jest.mock("../src/Globals", () => ({
    Globals: {equatorRadius: 6378137, polarRadius: 6356752.314245},
    Sit: {frames: 900, fps: 30, lat: 0, lon: 0},
    guiMenus: {}, NodeMan: {get: jest.fn()},
}));
jest.mock("../src/par", () => ({par: {paused: true, trackToTrackStopAt: 0}}));
jest.mock("../src/CViewManager", () => ({}));
jest.mock("../src/LLA-ECEF-ENU", () => ({}));
jest.mock("../src/KeyBoardHandler", () => ({}));
jest.mock("../src/threeExt", () => ({}));
jest.mock("../src/CelestialMath", () => ({}));
jest.mock("../src/atmosphere/refractionSettings", () => ({}));
jest.mock("../src/mouseMoveView", () => ({}));
jest.mock("../src/JetUtils", () => ({}));
jest.mock("../src/i18n", () => ({}));

let camera, objectNode, ptz, track, wobble;
beforeEach(() => {
    camera = new PerspectiveCamera(30, 1.5, 1, 10000000);
    camera.position.set(6379000, 0, 0);
    objectNode = {camera, getUpVector: getLocalUpVector, syncUIPosition() {}};
    ptz = Object.assign(Object.create(CNodeControllerPTZUI.prototype), {
        roll: 12, az: 0, el: 0, fov: 30, relative: false,
        updateSatelliteSliderRanges() {}, updateSatelliteSliderVisibility() {},
    });
    track = Object.assign(Object.create(CNodeControllerTrackToTrack.prototype), {
        in: {
            sourceTrack: {p: () => new Vector3(6379000, 0, 0)},
            targetTrack: {p: () => new Vector3(6382000, 2000, 5000)},
            roll: ptz,
        },
    });
    wobble = new CNodeControllerTrackingWobble({wobbleEnabled: true, gui: false});
    NodeMan.get.mockImplementation(id => id === "trackingWobbleController" ? wobble : undefined);
});

function update(frame) {
    track.apply(frame, objectNode);
    wobble.apply(frame, objectNode);
    ptz.syncFromCamera(camera);
    return camera.quaternion.clone();
}

function expectSamePose(actual, expected, precision = 11) {
    actual.toArray().forEach((v, i) => expect(v).toBeCloseTo(expected.toArray()[i], precision));
}

test("paused To Target updates never feed tracking wobble into the Roll setting", () => {
    const pose = update(580);
    for (let i = 0; i < 500; i++) update(580);
    expect(ptz.roll).toBeCloseTo(12, 10);
    expectSamePose(camera.quaternion, pose);
});

test("scrubbing changes the wobble and returning to a frame reproduces its pose", () => {
    const pose = update(580);
    const other = update(710);
    expect(other.angleTo(pose)).toBeGreaterThan(0.0001);
    expectSamePose(update(580), pose);
    expect(ptz.roll).toBeCloseTo(12, 10);
});

test("roll corrections applied before wobble are still reflected in PTZ", () => {
    track.apply(580, objectNode);
    camera.rotateZ(0.2);
    wobble.apply(580, objectNode);
    const pose = camera.quaternion.clone();
    ptz.syncFromCamera(camera);
    expect(ptz.roll).toBeCloseTo(12 + 0.2 * 180 / Math.PI, 10);
    expectSamePose(camera.quaternion, pose);
});

test("switching to Manual preserves the displayed pose without applying wobble twice", () => {
    const pose = update(580);
    ptz.syncFromCamera(camera);
    expectSamePose(camera.quaternion, pose);
    CNodeControllerAzElZoom.prototype.apply.call(ptz, 580, objectNode);
    wobble.apply(580, objectNode);
    // PTZ aims at position + a unit direction; ECEF addition loses ~1e-10.
    expectSamePose(camera.quaternion, pose, 9);
});

test("LOS and clean pose probes do not replace the live camera's unperturbed pose", () => {
    const pose = update(580);
    const probe = {camera: camera.clone()};
    probe.camera.rotateZ(0.3);
    wobble.apply(710, probe);
    wobble.apply(580, {...probe, _poseProbe: true});
    ptz.syncFromCamera(camera);
    expect(ptz.roll).toBeCloseTo(12, 10);
    expectSamePose(camera.quaternion, pose);
    wobble.apply(580, objectNode);
    expectSamePose(camera.quaternion, pose);
});

test("disabling wobble removes its offset and later interactive movement can be synced", () => {
    update(580);
    track.apply(580, objectNode);
    const clean = camera.quaternion.clone();
    wobble.apply(580, objectNode);
    wobble.wobbleEnabled = false;
    wobble.apply(580, objectNode);
    expectSamePose(camera.quaternion, clean);
    wobble.wobbleEnabled = true;
    wobble.apply(580, objectNode);
    camera.rotateZ(0.3);
    expect(wobble.getUnperturbedQuaternion(camera)).toBeUndefined();
    ptz.syncFromCamera(camera);
    expect(Math.abs(ptz.roll - 12)).toBeGreaterThan(10);
});
