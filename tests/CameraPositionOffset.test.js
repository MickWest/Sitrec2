import {PerspectiveCamera, Vector3} from "three";
import {getTrackPositionBasis, offsetCameraPosition} from "../src/CameraPositionOffset";
import {CNodeControllerAzElZoom} from "../src/nodes/CNodeControllerPTZUI";
import {CNodeControllerTrackPosition, CNodeControllerTrackToTrack} from "../src/nodes/CNodeControllerVarious";
import {getLocalUpVector} from "../src/SphericalMath";
import {createCameraPoseSample} from "../src/CameraPoseSample";

jest.mock("../src/Globals", () => ({
    Globals: {equatorRadius: 6378137, polarRadius: 6356752.314245},
    Sit: {frames: 101, fps: 30}, guiMenus: {},
}));
jest.mock("../src/par", () => ({par: {paused: true, trackToTrackStopAt: 0}}));
jest.mock("../src/nodes/CNodeController", () => ({CNodeController: class {}}));
jest.mock("../src/threeExt", () => ({}));
jest.mock("../src/CViewManager", () => ({}));
jest.mock("../src/KeyBoardHandler", () => ({}));
jest.mock("../src/CelestialMath", () => ({}));
jest.mock("../src/mouseMoveView", () => ({}));
jest.mock("../src/JetUtils", () => ({}));
jest.mock("../src/atmosphere/refractionSettings", () => ({currentTerrestrialLiftContext: () => null}));

function road(slope = 0.1) {
    return {frames: 101, altitudeLock: 0, altitudeLockAGL: true,
        p: f => new Vector3(6378137 + f * slope, 0, f)};
}
function cameraNode(track) {
    const camera = new PerspectiveCamera(30, 1.5, 0.1, 100000);
    return {camera, _object: camera, forceAboveSurface: false, syncUIPosition() {},
        getUpVector: getLocalUpVector, getPositionTrack: () => track,
        offsetPosition: (p, t, f) => offsetCameraPosition(p, t, f, 0.3, 1.524, 0.5)};
}
const apply = (Type, inputs, node, f) => Type.prototype.apply.call({in: inputs}, f, node);

test("cabin axes follow a climbing path and offsets do not move its source", () => {
    const track = road(), p = track.p(40), original = p.clone();
    const basis = getTrackPositionBasis(track, 40, p);
    const offset = offsetCameraPosition(p, track, 40, 0.3, 1.524, 0.5).sub(p);
    expect(offset.dot(basis.right)).toBeCloseTo(0.3, 8);
    expect(offset.dot(basis.up)).toBeCloseTo(1.524, 8);
    expect(offset.dot(basis.forward)).toBeCloseTo(0.5, 8);
    expect(p).toEqual(original);
    expect(basis.forward.dot(getLocalUpVector(p))).toBeGreaterThan(0.09);
});

test("stopped endpoints and a single fixed position produce stable finite cabin axes", () => {
    const track = road();
    const moving = track.p;
    track.p = f => moving(Math.min(f, 50));
    for (const f of [100, 75, 100]) {
        expect(getTrackPositionBasis(track, f, track.p(f)).forward.dot(new Vector3(0.1, 0, 1).normalize())).toBeCloseTo(1, 10);
    }
    const fixed = {frames: 1, p: () => moving(0)};
    expect(offsetCameraPosition(fixed.p(0), fixed, 0, 0, 2, 0).x).toBeCloseTo(6378139, 8);
});

test.each([0, 0.1, -0.1])("relative camera follows road slope %s without accumulating offsets or changing location when panning", slope => {
    const track = road(slope), node = cameraNode(track);
    const ptz = {relative: true, az: 0, el: 0, roll: 0, fov: 30};
    const update = () => {
        apply(CNodeControllerTrackPosition, {sourceTrack: track}, node, 40);
        CNodeControllerAzElZoom.prototype.apply.call(ptz, 40, node);
    };
    update();
    const expected = getTrackPositionBasis(track, 40, track.p(40));
    const position = node.camera.position.clone();
    expect(node.camera.getWorldDirection(new Vector3()).dot(expected.forward)).toBeCloseTo(1, 9);
    for (let i = 0; i < 10; i++) update();
    expect(node.camera.position).toEqual(position);
    ptz.az = 90;
    update();
    expect(node.camera.position).toEqual(position);
    expect(node.camera.getWorldDirection(new Vector3()).dot(expected.right)).toBeCloseTo(1, 8);
});

test("To Target and isolated pose sampling use the same offset origin", () => {
    const track = road(), node = cameraNode(track);
    apply(CNodeControllerTrackPosition, {sourceTrack: track}, node, 40);
    const position = node.camera.position.clone();
    const target = {p: () => new Vector3(6379000, 1000, 1000)};
    apply(CNodeControllerTrackToTrack, {sourceTrack: track, targetTrack: target}, node, 40);
    expect(node.camera.position).toEqual(position);
    expect(node.camera.getWorldDirection(new Vector3()).dot(target.p().sub(position).normalize())).toBeCloseTo(1, 10);
    const sample = createCameraPoseSample(node);
    // Minimal fixture uses a data property; real CNodeCamera has a getter for _object.
    sample.camera = sample._object;
    apply(CNodeControllerTrackPosition, {sourceTrack: track}, sample, 60);
    expect(sample.camera.position).toEqual(node.offsetPosition(track.p(60), track, 60));
    expect(node.camera.position).toEqual(position);
});
