// Easing across a CUT.
//
// `ride` and `follow` both ease out of the previous beat's pose into their own, which is
// what makes a continuous move glide. Across a cut there is nothing to ease FROM — the
// previous pose belongs to a different shot, often pointing somewhere else entirely — so
// easing from it swings the camera round hunting its subject at the start of a shot whose
// motion is otherwise calm (measured at 88-117 deg/s on real shots). After a cut the
// command must land on its pose immediately.

import {Vector3} from "three";
import {COMMANDS} from "../src/scriptedVideo/ScriptCommands";

// Flat-space stubs, as in scriptRideCommand.test.js: up is +Z, "car" drives along +X.
const stubs = () => {
    const targetPos = (name, sf) => {
        if (name === "car") return new Vector3(sf * 10, 0, 0);
        if (name === "beacon") return new Vector3(0, 500, 100);
        return null;
    };
    const localUp = () => new Vector3(0, 0, 1);
    const localNorth = () => new Vector3(0, 1, 0);
    const makePose = (position, lookTarget, fov) =>
        ({position: position.clone(), up: new Vector3(0, 0, 1), lookTarget: lookTarget.clone(), fov});
    // a previous pose a long way from anything this shot is about
    const startPose = makePose(new Vector3(-5000, -5000, 900), new Vector3(0, 0, 0), 30);
    return {targetPos, localUp, localNorth, makePose, startPose};
};

// prepare + sample at localT, for a command driven by a single target
const at = (type, e, localT, sf = 0) => {
    const {targetPos, localUp, localNorth, makePose, startPose} = stubs();
    COMMANDS[type].prepare(e, {startPose, sfStart: 0, sfEnd: 60,
        targetPos, makePose, localUp, localNorth});
    return {pose: COMMANDS[type].sample(e, {sp: startPose, sf, localT, targetPos, makePose, localUp}),
        startPose};
};

describe.each([
    ["ride", () => ({type: "ride", target: "car", dur: 6, lookAt: "beacon", height: 1.6, back: 0})],
    ["follow", () => ({type: "follow", target: "car", dur: 6, distance: 18, height: 6})],
])("%s across a cut", (type, mk) => {
    test("mid-move it eases out of the previous pose", () => {
        const {pose, startPose} = at(type, {...mk(), afterCut: false}, 0);
        expect(pose.position.x).toBeCloseTo(startPose.position.x);   // blend 0 == the old pose
    });

    test("after a cut the first frame is already ON the shot's pose", () => {
        const {pose, startPose} = at(type, {...mk(), afterCut: true}, 0);
        expect(pose.position.x).not.toBeCloseTo(startPose.position.x);
        // the same pose the shot settles into, with no swing to get there
        const settled = at(type, {...mk(), afterCut: false}, 1).pose;
        expect(pose.position.x).toBeCloseTo(settled.position.x);
        expect(pose.position.y).toBeCloseTo(settled.position.y);
        expect(pose.position.z).toBeCloseTo(settled.position.z);
    });
});
