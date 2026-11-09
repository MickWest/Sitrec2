jest.mock("../src/nodes/CNodeViewUI", () => ({forceUpdateUIText: () => {}}));
jest.mock("../src/JetGUI", () => ({updateGUIFrames: () => {}}));
jest.mock("../src/nodes/CNodeFrameSlider", () => ({updateFrameSlider: () => {}}));
jest.mock("../src/showTimingAnalysis", () => ({showTimingAnalysis: () => {}}));
jest.mock("../src/nodes/CNodeDisplaySkyOverlay", () => ({registerLabel3D: () => {}, unregisterLabel3D: () => {}}));
import {CNodeDateTime} from "../src/nodes/CNodeDateTime";
import {Globals, setSit, Sit} from "../src/Globals";
import {par} from "../src/par";

let node;
beforeEach(() => {
    setSit({fps: 30000 / 1001, simSpeed: 5});
    par.frame = 645; par.paused = false;
    Globals.sitchDirty = false; Globals.sitchEstablished = false;
    node = Object.create(CNodeDateTime.prototype);
    node.dateTime = {}; node.useTimeZone = true; node.timeZoneName = "NPT UTC+5.75";
    node.setStartDateTime(new Date("2026-11-08T12:00:00.123Z"));
    node.recalculateCascade = jest.fn();
});

test("Now Time edit shifts Start Time, holding a fractional-FPS video frame and speed", () => {
    const offset = node.frameToMS(par.frame) - +node.dateStart;
    node.liveMode = true;
    const target = new Date("2026-11-09T23:59:59.987Z");
    node.editTime(target);
    expect(node.dateNow).toEqual(target);
    expect(+node.dateStart).toBe(+target - offset);
    expect(node.frameToDate(par.frame)).toEqual(target);
    expect(par.frame).toBe(645); expect(Sit.simSpeed).toBe(5);
    expect(par.paused).toBe(true); expect(node.liveMode).toBe(false);
    expect(Globals.sitchDirty).toBe(true); expect(Globals.sitchEstablished).toBe(true);
    expect(node.recalculateCascade).toHaveBeenCalledTimes(1);
});

test("Start Time edit dates frame zero and updates Now Time", () => {
    const offset = node.frameToMS(par.frame) - +node.dateStart;
    const target = new Date("2020-02-29T00:00:00.456Z");
    node.editTime(target, "start");
    expect(node.dateStart).toEqual(target); expect(+node.dateNow).toBe(+target + offset);
    expect(par.frame).toBe(645);
});

test("a whole scrub undoes once, even after moving the playhead", () => {
    const start = +node.dateStart;
    node.editTime(new Date(+node.dateNow + 60000));
    node.editTime(new Date(+node.dateNow + 60000), "now", false);
    expect(node.timeEditHistory).toHaveLength(1);
    par.frame = 700;
    node.undoTimeEdit();
    expect(+node.dateStart).toBe(start); expect(par.frame).toBe(700);
    expect(node.dateNow).toEqual(node.frameToDate(700));
    expect(node.canUndoTimeEdit()).toBe(false);
});

test("external clock edits invalidate editor undo instead of restoring unrelated time", () => {
    node.editTime(new Date(+node.dateNow + 60000));
    node.setStartDateTime(new Date("2021-01-01T00:00:00Z"));
    expect(node.canUndoTimeEdit()).toBe(false);
    node.undoTimeEdit();
    expect(node.dateStart.toISOString()).toBe("2021-01-01T00:00:00.000Z");
});

test("invalid edits and unchanged values leave time and dirty state untouched", () => {
    const start = +node.dateStart;
    expect(node.editTime(new Date(NaN))).toBe(false);
    node.editTime(node.frameToDate(par.frame));
    expect(+node.dateStart).toBe(start); expect(Globals.sitchDirty).toBe(false);
    expect(node.recalculateCascade).not.toHaveBeenCalled();
});
