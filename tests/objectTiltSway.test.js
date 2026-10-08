import {Object3D, Vector3} from "three";
import {CNodeControllerObjectTilt} from "../src/nodes/CNodeControllerObjectTilt";
import {LLAToECEF} from "../src/LLA-ECEF-ENU";
import {getLocalEastVector, getLocalUpVector} from "../src/SphericalMath";
import {setSit} from "../src/Globals";

beforeAll(() => setSit({fps: 30, simSpeed: 1}));

function controller(values) {
    // Only the tilt-and-sway step is under test; the banking modes leave the orientation alone here.
    const node = Object.assign(Object.create(CNodeControllerObjectTilt.prototype),
        {tiltAngle: 0, tiltDirection: 0, swayAmplitude: 0, swayPeriod: 2, _swayRotation: null}, values);
    node.applyBanking = () => {};
    return node;
}

// The banking modes leave the model's +Y along local up; start from that orientation.
function objectAt(lat, lon) {
    const object = new Object3D();
    object.position.copy(LLAToECEF(lat, lon, 300));
    object.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), getLocalUpVector(object.position));
    return object;
}

test("a fixed tilt leans the object's up axis toward the tilt direction by the tilt angle", () => {
    const object = objectAt(18.5, -67.1), node = controller({tiltAngle: 30, tiltDirection: 90});
    node.apply(0, {_object: object});
    const axis = new Vector3(0, 1, 0).applyQuaternion(object.quaternion);
    const up = getLocalUpVector(object.position), east = getLocalEastVector(object.position);
    expect(axis.dot(up)).toBeCloseTo(Math.cos(Math.PI / 6), 9);
    expect(axis.dot(east)).toBeCloseTo(Math.sin(Math.PI / 6), 9);
});

test("the lean is replaced each frame, not accumulated, and zero leaves the orientation unchanged", () => {
    const object = objectAt(18.5, -67.1), node = controller({tiltAngle: 10, tiltDirection: 0});
    const base = object.quaternion.clone();
    for (let frame = 0; frame < 5; frame++) node.apply(frame, {_object: object});
    const axis = new Vector3(0, 1, 0).applyQuaternion(object.quaternion);
    expect(axis.angleTo(getLocalUpVector(object.position))).toBeCloseTo(Math.PI / 18, 9);
    node.tiltAngle = 0;
    node.apply(5, {_object: object});
    expect(object.quaternion.angleTo(base)).toBeCloseTo(0, 6);
});

test("the sway swings sinusoidally about the fixed tilt with the given period", () => {
    const node = controller({tiltAngle: 5, swayAmplitude: 8, swayPeriod: 2});
    expect(node.leanAt(0)).toBeCloseTo(5, 12);
    expect(node.leanAt(15)).toBeCloseTo(13, 12);   // a quarter period
    expect(node.leanAt(45)).toBeCloseTo(-3, 12);   // three quarters
    expect(node.leanAt(60)).toBeCloseTo(5, 9);     // one period
    // At simSpeed 5 each frame is five times as much scene time, so a quarter period is 3 frames.
    setSit({fps: 30, simSpeed: 5});
    try {
        expect(node.leanAt(3)).toBeCloseTo(13, 12);
    } finally {setSit({fps: 30, simSpeed: 1});}
});
