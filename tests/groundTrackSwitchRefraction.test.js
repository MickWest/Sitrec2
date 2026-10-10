// The camera's "Switch to Ground Track" with terrestrial refraction on.
//
// From the switch frame on, the camera stays aimed at the ground point its line of sight
// met at that frame. To Target aims the camera at where refraction DRAWS the target and
// carries the rotation back to the geometric direction (camera.userData.geometricAim), so:
//   - the locked ground point is found along the geometric line of sight, which for a
//     target on the ground is the target itself;
//   - after the switch the line of sight (forward turned by geometricAim, as
//     CNodeLOSFromCamera does) still passes through the locked point;
//   - the picture does not jump at the switch: the camera aims at where the locked
//     point is drawn.

import {beforeEach, expect, jest, test} from "@jest/globals";
import {PerspectiveCamera, Raycaster, Vector3} from "three";

const R = 6378137;
let mockRefraction = true;

jest.mock("../src/Globals", () => ({
    Globals: {equatorRadius: 6378137, polarRadius: 6378137},
    Sit: {frames: 900, fps: 30, lat: 0, lon: 0},
    guiMenus: {}, NodeMan: {get: () => undefined, exists: () => false},
    GlobalDateTimeNode: {}, setRenderOne: () => {}, UndoManager: null,
    gui: {}, guiPhysics: {},
}));
jest.mock("../src/par", () => ({par: {paused: true, trackToTrackStopAt: 0}}));
// The base class's controller pass: apply each controller in turn.
jest.mock("../src/nodes/CNode3D", () => ({CNode3D: class {
    applyControllers(f) { for (const controller of this.controllers) controller.apply(f, this); }
}}));
jest.mock("../src/nodes/CNodeController", () => ({CNodeController: class {
    constructor() { this.simpleSerials = []; }
}}));
jest.mock("../src/CameraPSF", () => ({}));
jest.mock("../src/CViewManager", () => ({ViewMan: {}}));
jest.mock("../src/ViewUIBarMenus", () => ({}));
jest.mock("../src/FreeLookGuard", () => ({}));
jest.mock("../src/EGM96Geoid", () => ({}));
jest.mock("../src/i18n", () => ({t: key => key}));
jest.mock("../src/CelestialMath", () => ({}));
jest.mock("../src/KeyBoardHandler", () => ({}));
jest.mock("../src/threeExt", () => ({}));
jest.mock("../src/mouseMoveView", () => ({}));
jest.mock("../src/JetUtils", () => ({}));
jest.mock("../src/MISBUtils", () => ({MISB: {}}));
jest.mock("../src/FOVUtils", () => ({}));
// The real lift, with a switch in place of the Sit settings.
jest.mock("../src/atmosphere/refractionSettings", () => {
    const {liftWorldPoint, terrestrialLiftContext} = jest.requireActual("../src/atmosphere/terrestrialRefraction");
    const context = observer => terrestrialLiftContext(observer,
        {enabled: mockRefraction, k: 0.176, equatorRadius: 6378137, polarRadius: 6378137});
    return {
        currentTerrestrialLiftContext: context,
        apparentPositionFrom: (observer, point, target) => liftWorldPoint(context(observer), point, target),
        currentRefractionOpts: () => ({enabled: false}),
    };
});
// The ground is a sphere of radius R; the nearer intersection, if the ray meets it.
jest.mock("../src/raycastGround", () => ({
    raycastLocalGround: raycaster => {
        const {origin, direction} = raycaster.ray;
        const b = origin.dot(direction);
        const c = origin.lengthSq() - 6378137 * 6378137;
        const disc = b * b - c;
        if (disc < 0) return null;
        const distance = -b - Math.sqrt(disc);
        if (distance < 0) return null;
        return {point: origin.clone().addScaledVector(direction, distance), isTerrain: false};
    },
}));

const {CNodeCamera} = require("../src/nodes/CNodeCamera");
const {CNodeControllerTrackToTrack} = require("../src/nodes/CNodeControllerVarious");
const {getLocalUpVector} = require("../src/SphericalMath");
const {liftWorldPoint, terrestrialLiftContext} = require("../src/atmosphere/terrestrialRefraction");

// A camera 3 km up on the equator, and a target on the ground 40 km away.
const CAMERA = new Vector3(R + 3000, 0, 0);
const TARGET_ANGLE = 40000 / R;
const TARGET = new Vector3(R * Math.cos(TARGET_ANGLE), R * Math.sin(TARGET_ANGLE), 0);
const SWITCH_FRAME = 100;

const forward = camera => new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
const degreesBetween = (a, b) => a.angleTo(b) * 180 / Math.PI;
// The line of sight as CNodeLOSFromCamera computes it.
const lineOfSight = camera => {
    const fwd = forward(camera);
    if (camera.userData.geometricAim) fwd.applyQuaternion(camera.userData.geometricAim);
    return fwd;
};
const drawnFrom = (observer, point) =>
    liftWorldPoint(terrestrialLiftContext(observer, {enabled: true, k: 0.176, equatorRadius: R, polarRadius: R}), point);

let node;
beforeEach(() => {
    mockRefraction = true;
    const camera = new PerspectiveCamera(5, 1.5, 1, 10000000);
    camera.position.copy(CAMERA);
    const toTarget = Object.assign(Object.create(CNodeControllerTrackToTrack.prototype), {
        in: {sourceTrack: {p: () => CAMERA.clone()}, targetTrack: {p: () => TARGET.clone()}},
    });
    // The parts of a CNodeCamera that the ground-track switch uses.
    node = Object.assign(Object.create(CNodeCamera.prototype), {
        _object: camera,
        in: {},
        switchToGroundTrackFrame: SWITCH_FRAME,
        _groundTrackSwitchComputing: false,
        _groundTrackSwitchRaycaster: new Raycaster(),
        _groundTrackSwitchWarned: false,
        _groundTrackSwitchCachedFrame: null,
        _groundTrackSwitchCachedTarget: null,
        getUpVector: getLocalUpVector,
        syncUIPosition() {},
        controllers: [toTarget],
        _freeLook: false,
    });
});

// The camera's update for frame f: the controllers, then the switch.
function update(f) {
    node.applyControllers(f);
    node.applyGroundTrackSwitch(f);
}

test("the setup: To Target aims above the geometric direction to the target", () => {
    node.applyControllers(SWITCH_FRAME);
    const toTarget = TARGET.clone().sub(CAMERA).normalize();
    expect(degreesBetween(forward(node.camera), toTarget)).toBeGreaterThan(0.02);
    expect(degreesBetween(lineOfSight(node.camera), toTarget)).toBeLessThan(1e-6);
});

test("the locked ground point is where the geometric line of sight meets the ground", () => {
    const locked = node.getGroundTrackSwitchTarget(SWITCH_FRAME);
    expect(locked).not.toBeNull();
    // The target is on the ground, so the line of sight meets the ground at the target.
    expect(locked.distanceTo(TARGET)).toBeLessThan(0.5);
});

test("after the switch the line of sight passes through the locked point", () => {
    for (const f of [SWITCH_FRAME, SWITCH_FRAME + 50]) {
        update(f);
        const locked = node.getGroundTrackSwitchTarget(SWITCH_FRAME);
        const toLocked = locked.clone().sub(node.camera.position).normalize();
        expect([f, degreesBetween(lineOfSight(node.camera), toLocked) < 1e-6]).toEqual([f, true]);
    }
});

test("the picture does not jump at the switch: the camera aims at where the locked point is drawn", () => {
    node.applyControllers(SWITCH_FRAME);
    const beforeSwitch = forward(node.camera);
    update(SWITCH_FRAME);
    expect(degreesBetween(forward(node.camera), beforeSwitch)).toBeLessThan(1e-4);
    const locked = node.getGroundTrackSwitchTarget(SWITCH_FRAME);
    const toDrawn = drawnFrom(node.camera.position, locked).sub(node.camera.position).normalize();
    expect(degreesBetween(forward(node.camera), toDrawn)).toBeLessThan(1e-6);
});

test("with refraction off the switch is a plain lookAt and carries no rotation", () => {
    mockRefraction = false;
    update(SWITCH_FRAME);
    const locked = node.getGroundTrackSwitchTarget(SWITCH_FRAME);
    expect(locked.distanceTo(TARGET)).toBeLessThan(0.5);
    const toLocked = locked.clone().sub(node.camera.position).normalize();
    expect(degreesBetween(forward(node.camera), toLocked)).toBeLessThan(1e-6);
    expect(node.camera.userData.geometricAim).toBeNull();
});

test("a controller pass that does not aim at a drawn point leaves no rotation behind", () => {
    node.applyControllers(SWITCH_FRAME);
    expect(node.camera.userData.geometricAim).not.toBeNull();
    // A heading set by hand (as Manual PTZ does): a plain lookAt.
    node.controllers = [{apply: (f, objectNode) => objectNode.camera.lookAt(TARGET)}];
    node.applyControllers(SWITCH_FRAME);
    expect(node.camera.userData.geometricAim).toBeNull();
});

test("in Free Look, where no controller sets the pose, the camera carries no rotation", () => {
    node.applyControllers(SWITCH_FRAME);
    expect(node.camera.userData.geometricAim).not.toBeNull();
    node._freeLook = true;
    node.inputs = {};       // the field-of-view controllers Free Look still applies
    node.applyControllers(SWITCH_FRAME);
    expect(node.camera.userData.geometricAim).toBeNull();
});
