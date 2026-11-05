// A debug arrow's head is a cone or a dot (threeExt ARROW_HEAD_*). The V/B measurement uses a
// dot at V and a cone at B. The dot is a sphere on the end point with the line reaching it,
// and it scales uniformly, where the cone stops the line a head length short and scales to
// (width, length, width).
import {expect, jest, test} from "@jest/globals";
import {Group, SphereGeometry, Vector3} from "three";

jest.mock("../src/LocalFrame", () => ({GlobalScene: {add: () => {}, remove: () => {}}}));

import {ARROW_HEAD_CONE, ARROW_HEAD_DOT, DebugArrowAB, DebugArrows, removeDebugArrow} from "../src/threeExt";

test("a dot head is a round sphere on the end point and the line reaches it; a cone stops short", () => {
    const parent = new Group();
    const A = new Vector3(0, 0, 0);
    const B = new Vector3(0, 100, 0);

    const dot = DebugArrowAB("headTestDot", A, B, "#ffffff", true, parent, 20, undefined, ARROW_HEAD_DOT);
    expect(dot.headType).toBe(ARROW_HEAD_DOT);
    expect(dot.cone.geometry).toBeInstanceOf(SphereGeometry);
    expect(dot.line.scale.y).toBeCloseTo(100, 9);
    expect(dot.cone.position.y).toBeCloseTo(100, 9);
    expect(dot.cone.scale.x).toBeGreaterThan(0);
    expect(dot.cone.scale.y).toBe(dot.cone.scale.x);
    expect(dot.cone.scale.z).toBe(dot.cone.scale.x);

    const cone = DebugArrowAB("headTestCone", A, B, "#ffffff", true, parent, 20);
    expect(cone.headType).toBe(ARROW_HEAD_CONE);
    expect(cone.cone.geometry).not.toBeInstanceOf(SphereGeometry);
    expect(cone.line.scale.y).toBeCloseTo(80, 9);
    expect(cone.cone.scale.y).toBeCloseTo(20, 9);

    // scaleArrows re-applies the length each frame with a screen-constant head length, which
    // for a dot is its diameter.
    dot.setLength(100, 10);
    expect(dot.line.scale.y).toBeCloseTo(100, 9);
    expect(dot.cone.scale.x).toBeCloseTo(10, 9);

    // Drawing the same name with another head replaces the arrow rather than mixing the two.
    const replaced = DebugArrowAB("headTestDot", A, B, "#ffffff", true, parent, 20, undefined, ARROW_HEAD_CONE);
    expect(replaced.headType).toBe(ARROW_HEAD_CONE);
    expect(DebugArrows.headTestDot).toBe(replaced);
    expect(replaced.cone.geometry).not.toBeInstanceOf(SphereGeometry);

    removeDebugArrow("headTestDot");
    removeDebugArrow("headTestCone");
});
