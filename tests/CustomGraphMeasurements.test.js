import {Vector3} from "three";
import {graphPosition, graphVelocity, graphGroundSpeed, graphVerticalSpeed, graphSlantRange, graphHeading, graphAcceleration} from "../src/CustomGraphMeasurements";

const context = {frames: 3, fps: 2, simSpeed: 1};
const points = [new Vector3(0, 100, 0), new Vector3(3, 104, 0), new Vector3(6, 108, 0)];
const source = {frames: 3, p: f => points[f]?.clone()};
const up = () => new Vector3(0, 1, 0);
const altitude = p => p.y;

test("ground speed removes vertical motion, while 3D and vertical speed retain it", () => {
    expect(graphGroundSpeed(source, 1, context, up)).toBe(6);
    expect(graphVelocity(source, 1, context).velocity.length()).toBe(10);
    expect(graphVerticalSpeed(source, 1, context, altitude)).toBe(8);
    expect(graphGroundSpeed(source, 1, {...context, simSpeed: 2}, up)).toBe(3);
});

test("first and last frames use a valid interval and the sitch timeline fps", () => {
    expect(graphGroundSpeed(source, 0, context, up)).toBe(6);
    expect(graphGroundSpeed(source, 2, context, up)).toBe(6);
    expect(graphGroundSpeed({...source, fps: 30}, 1, {...context, fps: 60}, up)).toBe(180);
    expect(graphVelocity({...source, frames: 1}, 0, context)).toBeNull();
});

test("slant range uses the observer's position at the same frame", () => {
    const moving = {p: f => new Vector3(f * 3, f * 4, 0)};
    const observer = {p: f => new Vector3(f * 6, f * 8, 0)};
    expect(graphSlantRange(moving, observer, 2)).toBe(10);
    expect(graphSlantRange(moving, null, 2)).toBeNaN();
});

test("a fixed object has zero speed and constant altitude", () => {
    const fixed = {frames: 0, p: () => new Vector3(0, 250, 0)};
    expect(graphGroundSpeed(fixed, 1, context, up)).toBe(0);
    expect(graphVerticalSpeed(fixed, 1, context, altitude)).toBe(0);
    expect(altitude(graphPosition(fixed, 2))).toBe(250);
});

test("missing or invalid samples and invalid timing become data gaps", () => {
    expect(graphPosition({p: () => new Vector3(NaN, 1, 2)}, 0)).toBeNull();
    expect(graphPosition({...source, validPoint: () => false}, 0)).toBeNull();
    expect(graphGroundSpeed({...source, p: () => null}, 1, context, up)).toBeNaN();
    expect(graphVelocity(source, 1, {...context, simSpeed: 0})).toBeNull();
    expect(graphPosition({p: () => {throw new Error("gone");}}, 0)).toBeNull();
});

test("heading uses geographic east and north, including stationary gaps", () => {
    const north = () => new Vector3(0, 0, -1);
    const east = () => new Vector3(1, 0, 0);
    expect(graphHeading(source, 1, context, up, north, east)).toBe(90);
    const westward = {...source, p: f => new Vector3(-f * 3, 100, 0)};
    expect(graphHeading(westward, 1, context, up, north, east)).toBe(-90);
    const fixed = {...source, p: () => new Vector3(0, 100, 0)};
    expect(graphHeading(fixed, 1, context, up, north, east)).toBeNaN();
});

test("acceleration uses timeline seconds and excludes gravity", () => {
    const accelerating = {frames: 3, fps: 30, p: f => new Vector3(f * f * 9.81 / 2, 100, 0)};
    expect(graphAcceleration(accelerating, 1, {...context, fps: 1})).toBeCloseTo(1);
    expect(graphAcceleration(accelerating, 1, {...context, fps: 2})).toBeCloseTo(4);
    expect(graphAcceleration(accelerating, 1, {...context, fps: 2, simSpeed: 2})).toBeCloseTo(1);
});
