// A malformed ?datetime= in a shared link (22/02/2022, 2022-13-01, ...) became an
// Invalid Date that populate() could not serialize: toISOString() threw RangeError at
// the top level of index.js, before windowChanged() and startAnimating(), so the page
// never rendered. The bad value is now refused before any state changes, the user is
// told, and the sitch keeps its own start time.

import fs from "fs";
import path from "path";
import {CNodeDateTime} from "../src/nodes/CNodeDateTime";
import {setSit, Sit} from "../src/Globals";
import {par} from "../src/par";

jest.mock("../src/nodes/CNodeViewUI", () => ({forceUpdateUIText: () => {}}));
jest.mock("../src/JetGUI", () => ({updateGUIFrames: () => {}}));
jest.mock("../src/nodes/CNodeFrameSlider", () => ({updateFrameSlider: () => {}}));
jest.mock("../src/showTimingAnalysis", () => ({showTimingAnalysis: () => {}}));

const SITCH_START = "2021-07-04T18:00:00.000Z";
const BAD_DATETIMES = ["22/02/2022", "2022-13-01", "garbage", ""];

function makeDateTimeNode() {
    const node = Object.create(CNodeDateTime.prototype);
    node.dateTime = {};
    node.populateStartTimeFromUTCString(SITCH_START);
    return node;
}

beforeEach(() => {
    setSit({fps: 30, simSpeed: 1});
    par.frame = 0;
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("populateStartTimeFromUTCString", () => {
    test("accepts a valid time", () => {
        const node = makeDateTimeNode();
        expect(node.populateStartTimeFromUTCString("2022-02-22T12:34:56Z")).toBe(true);
        expect(node.dateStart.toISOString()).toBe("2022-02-22T12:34:56.000Z");
        expect(Sit.startTime).toBe("2022-02-22T12:34:56.000Z");
    });

    test.each(BAD_DATETIMES)("refuses %j without throwing or changing anything", bad => {
        const node = makeDateTimeNode();
        expect(node.populateStartTimeFromUTCString(bad)).toBe(false);
        expect(node.dateStart.toISOString()).toBe(SITCH_START);
        expect(node.originalPopulatedStartTime.toISOString()).toBe(SITCH_START);
        expect(Sit.startTime).toBe(SITCH_START);
    });
});

// The ?datetime= handling is top-level code in src/index.js, which cannot be imported
// under Jest (it runs the whole app at module scope), so the block is lifted from the
// source and run against a real CNodeDateTime.
describe("the ?datetime= URL parameter at startup", () => {
    const indexSource = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf-8");
    const start = indexSource.indexOf('const dateTime = urlParams.get("datetime");');
    const end = indexSource.indexOf("\n}\n", start);
    const block = indexSource.slice(start, end + 2);

    function runDateTimeBlock(search) {
        const node = makeDateTimeNode();
        const env = {
            urlParams: new URLSearchParams(search), GlobalDateTimeNode: node, Globals: {},
            setSitchEstablished: jest.fn(), showError: jest.fn(),
        };
        const names = Object.keys(env);
        new Function(...names, block)(...names.map(name => env[name]));
        return {node, ...env};
    }

    test("the block was found", () => {
        expect(start).toBeGreaterThan(-1);
        expect(block).toMatch(/populateStartTimeFromUTCString\(dateTime\)/);
    });

    test("a valid value overrides the sitch's start time", () => {
        const {node, Globals, setSitchEstablished, showError} = runDateTimeBlock("?datetime=2022-02-22T12:34:56Z");
        expect(node.dateStart.toISOString()).toBe("2022-02-22T12:34:56.000Z");
        expect(Globals.timeOverride).toBe(true);
        expect(setSitchEstablished).toHaveBeenCalledWith(true);
        expect(showError).not.toHaveBeenCalled();
    });

    test("an invalid value is reported, and the sitch keeps its own start time", () => {
        let result;
        expect(() => { result = runDateTimeBlock("?datetime=22/02/2022"); }).not.toThrow();
        const {node, Globals, setSitchEstablished, showError} = result;
        expect(showError).toHaveBeenCalledTimes(1);
        expect(showError.mock.calls[0][0]).toContain("22/02/2022");
        expect(node.dateStart.toISOString()).toBe(SITCH_START);
        // Not an override, so a saved sitch's own date time still deserializes.
        expect(Globals.timeOverride).toBeUndefined();
        expect(setSitchEstablished).not.toHaveBeenCalled();
    });
});
