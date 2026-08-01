// The `ride` scripted-video command: DSL/JS arg parsing through the scheduling
// kernel, and the prepare/sample camera geometry (ride ON a moving target,
// looking at a second target or ahead along the motion).

import {Vector3} from "three";
import {COMMANDS} from "../src/scriptedVideo/ScriptCommands";
import {runScriptJS} from "../src/scriptedVideo/ScriptJSRunner";

const run = (lines) => runScriptJS(Array.isArray(lines) ? lines.join("\n") : lines);

describe("ride — parsing", () => {
    test("full sugar form fills every field", async () => {
        const r = await run(["ride car 4 sphere3 0.55 2"]);
        expect(r.errors).toEqual([]);
        const e = r.events[0];
        expect(e.type).toBe("ride");
        expect(e.target).toBe("car");
        expect(e.dur).toBe(4);
        expect(e.lookAt).toBe("sphere3");
        expect(e.height).toBe(0.55);
        expect(e.back).toBe(2);
        expect(r.cameraBeats).toHaveLength(1);
    });

    test("defaults: no lookAt (ahead), height 1.6, back 0", async () => {
        const r = await run(["ride car 5"]);
        expect(r.errors).toEqual([]);
        const e = r.events[0];
        expect(e.lookAt).toBeNull();
        expect(e.height).toBe(1.6);
        expect(e.back).toBe(0);
    });

    test('empty-string lookAt placeholder ("" = look ahead) lets height be set positionally', async () => {
        const r = await run(['ride car 2.5 "" 0.55']);
        expect(r.errors).toEqual([]);
        const e = r.events[0];
        expect(e.lookAt).toBe("");
        expect(e.height).toBe(0.55);
    });

    test("assume-last target is reused", async () => {
        const r = await run(["zoom car 5", "ride 3"]);
        expect(r.errors).toEqual([]);
        expect(r.events[1].type).toBe("ride");
        expect(r.events[1].target).toBe("car");
    });
});

// Flat-space stubs: up is +Z everywhere, "car" drives along +X at 10 m/frame at
// z=0, "beacon" hangs at (0, 500, 100). makePose mirrors the real one's shape.
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
    const startPose = makePose(new Vector3(-50, 0, 0), new Vector3(0, 0, 0), 30);
    return {targetPos, localUp, localNorth, makePose, startPose};
};

const rideEvent = (over = {}) => ({type: "ride", target: "car", dur: 6, lookAt: null, height: 1.6, back: 0, ...over});

describe("ride — prepare/sample geometry", () => {
    test("end pose sits ON the target, height up, looking at the lookAt target", () => {
        const {targetPos, localUp, localNorth, makePose, startPose} = stubs();
        const e = rideEvent({lookAt: "beacon", height: 0.55});
        const end = COMMANDS.ride.prepare(e, {startPose, sfStart: 0, sfEnd: 60, targetPos, makePose, localUp, localNorth});
        expect(e.invalid).toBeUndefined();
        expect(end.position.x).toBeCloseTo(600);      // car at frame 60
        expect(end.position.z).toBeCloseTo(0.55);     // height above it
        expect(end.lookTarget.x).toBeCloseTo(0);      // framing the beacon...
        expect(end.lookTarget.y).toBeCloseTo(500);
        expect(end.lookTarget.z).toBeCloseTo(100);
    });

    test("no lookAt: looks ahead along the motion", () => {
        const {targetPos, localUp, localNorth, makePose, startPose} = stubs();
        const e = rideEvent();
        const end = COMMANDS.ride.prepare(e, {startPose, sfStart: 0, sfEnd: 60, targetPos, makePose, localUp, localNorth});
        // heading is +X, so the aim point is far ahead of the camera on +X
        expect(end.lookTarget.x).toBeGreaterThan(end.position.x + 100);
        expect(Math.abs(end.lookTarget.y)).toBeLessThan(1e-6);
    });

    test("back offset trails the heading", () => {
        const {targetPos, localUp, localNorth, makePose, startPose} = stubs();
        const e = rideEvent({back: 5});
        const end = COMMANDS.ride.prepare(e, {startPose, sfStart: 0, sfEnd: 60, targetPos, makePose, localUp, localNorth});
        expect(end.position.x).toBeCloseTo(595);      // 5 m behind the +X heading
    });

    test("a SUPPLIED but unresolvable lookAt marks the beat invalid (typo surfacing)", () => {
        const {targetPos, localUp, localNorth, makePose, startPose} = stubs();
        const e = rideEvent({lookAt: "nope"});
        const end = COMMANDS.ride.prepare(e, {startPose, sfStart: 0, sfEnd: 60, targetPos, makePose, localUp, localNorth});
        expect(e.invalid).toBe(true);
        expect(e.invalidReason).toMatch(/nope/);   // the warning blames the lookAt, not the ride target
        expect(end).toBe(startPose);
    });

    test('empty-string lookAt is "look ahead", not invalid', () => {
        const {targetPos, localUp, localNorth, makePose, startPose} = stubs();
        const e = rideEvent({lookAt: ""});
        COMMANDS.ride.prepare(e, {startPose, sfStart: 0, sfEnd: 60, targetPos, makePose, localUp, localNorth});
        expect(e.invalid).toBeUndefined();
    });

    test("sample eases out of the previous pose, then rides the target", () => {
        const {targetPos, localUp, localNorth, makePose, startPose} = stubs();
        const e = rideEvent({lookAt: "beacon", height: 1.6});
        COMMANDS.ride.prepare(e, {startPose, sfStart: 0, sfEnd: 60, targetPos, makePose, localUp, localNorth});
        // at localT 0 the pose is the previous beat's (blend 0)
        const p0 = COMMANDS.ride.sample(e, {sp: startPose, sf: 0, localT: 0, targetPos, makePose, localUp});
        expect(p0.position.x).toBeCloseTo(startPose.position.x);
        // past the 25% blend-in it is exactly the settled ride pose
        const p = COMMANDS.ride.sample(e, {sp: startPose, sf: 30, localT: 0.5, targetPos, makePose, localUp});
        expect(p.position.x).toBeCloseTo(300);
        expect(p.position.z).toBeCloseTo(1.6);
        expect(p.lookTarget.y).toBeCloseTo(500);
    });
});
