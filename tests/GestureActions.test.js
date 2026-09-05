import {commandModifier, wheelPixels, wheelZoomFactor, WheelStepAccumulator} from "../src/GestureActions";
import {fitViewSyncWheel} from "../src/FitViewSync";
import {NodeMan} from "../src/Globals";

jest.mock("../src/Globals", () => ({NodeMan: {get: jest.fn()}, setRenderOne: jest.fn()}));
jest.mock("../src/ViewUtils", () => ({mouseToView: (v, x, y) => [x, y], renderedRect: () => ({x: 0, y: 0, w: 400, h: 300})}));

test.each(["video", "graph", "timeline"])("%s zoom is reversible and independent of event subdivision", profile => {
    const single = wheelZoomFactor({deltaY: -100}, profile);
    const divided = Array.from({length: 20}, () => wheelZoomFactor({deltaY: -5}, profile)).reduce((a, b) => a * b, 1);
    expect(divided).toBeCloseTo(single, 12);
    expect(single * wheelZoomFactor({deltaY: 100}, profile)).toBeCloseTo(1, 12);
    expect(wheelZoomFactor({deltaY: 0, deltaX: 100}, profile)).toBe(1);
    expect(wheelZoomFactor({deltaY: -2.5, deltaMode: 1}, profile)).toBeCloseTo(single, 12);
    expect(wheelZoomFactor({deltaY: -.125, deltaMode: 2}, profile)).toBeCloseTo(single, 12);
});

test("horizontal movement is pan unless Shift explicitly maps it to an FOV action", () => {
    const event = {deltaX: 40, deltaY: 0};
    expect(wheelPixels(event)).toBe(0);
    expect(wheelPixels(event, {dominant: true})).toBe(40);
    expect(wheelPixels({...event, shiftKey: true}, {shiftHorizontal: true})).toBe(40);
    expect(wheelPixels({deltaY: NaN})).toBe(0);
});

test("timeline zoom retains its established wheel direction and step size", () => {
    expect(wheelZoomFactor({deltaY: 100}, "timeline")).toBe(1.5);
    expect(wheelZoomFactor({deltaY: -100}, "timeline")).toBeCloseTo(1 / 1.5);
});

test("discrete edits accumulate trackpad movement and reset on field, direction or time changes", () => {
    const wheel = new WheelStepAccumulator();
    const e = (deltaY, timeStamp = 0) => ({deltaY, timeStamp});
    expect(wheel.take(e(40), "duration")).toBe(0);
    expect(wheel.take(e(60), "duration")).toBe(1);
    expect(wheel.take(e(80), "duration")).toBe(0);
    expect(wheel.take(e(-40), "duration")).toBe(0);
    expect(wheel.take(e(-60), "duration")).toBe(-1);
    wheel.take(e(90), "duration");
    expect(wheel.take(e(20), "offset")).toBe(0);
    expect(wheel.take(e(90, 1000), "offset")).toBe(0);
    expect(wheel.take(e(10, 1010), "offset")).toBe(1);
});

test("Ctrl and Command activate the same edit command", () => {
    expect(commandModifier({ctrlKey: true})).toBe(true);
    expect(commandModifier({metaKey: true})).toBe(true);
    expect(commandModifier({altKey: true})).toBe(false);
});

test("fit-synced wheel keeps the pointer anchored and ignores horizontal-only movement", () => {
    const zoom = {v0: 200, setValue(v) { this.v0 = v; }};
    const video = {panOffsetX: .1, panOffsetY: -.1, clampPanOffset: jest.fn()};
    NodeMan.get.mockImplementation(id => ({video, videoZoom: zoom})[id]);
    const view = {widthPx: 400, heightPx: 300};
    const point = () => [.5 + video.panOffsetX + (.75 - .5) / (zoom.v0 / 100),
        .5 + video.panOffsetY + (.25 - .5) / (zoom.v0 / 100)];
    const before = point();
    fitViewSyncWheel(view, {clientX: 300, clientY: 75, deltaY: -100});
    expect(zoom.v0).toBeCloseTo(200 / .9);
    expect(point()[0]).toBeCloseTo(before[0], 12); expect(point()[1]).toBeCloseTo(before[1], 12);
    const after = zoom.v0;
    fitViewSyncWheel(view, {clientX: 300, clientY: 75, deltaY: 0, deltaX: 100});
    expect(zoom.v0).toBe(after);
});
