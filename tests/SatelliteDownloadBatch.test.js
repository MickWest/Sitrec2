/** @jest-environment jsdom */
import {CSatellite} from "../src/nodes/CSatellite";
import {parseMethods} from "../src/CFileManagerParse";
import {setFileManager, setGlobalDateTimeNode, setNodeMan, setSit} from "../src/Globals";

function setup() {
    const sky = {
        satellites: {TLEData: {satData: [{number: 1}]}},
        mergeTLE: jest.fn(), replaceTLE: jest.fn(),
    };
    setSit({isCustom: true});
    setNodeMan({get: () => sky, suspendRecalculate() {}, unsuspendRecalculate() {}});
    const fm = {
        ...parseMethods,
        list: {"old.tle": {isTLE: true}},
        _tleMergeAll: true, _tleReplacedInBatch: true,
        parseAsset: async () => [
            {filename: "part1.tle", dataType: "tle", parsed: "first"},
            {filename: "part2.tle", dataType: "tle", parsed: "second"},
        ],
        add(id, data, original) { this.list[id] = {data, original}; },
        remove(id) { delete this.list[id]; },
        deleteIf(predicate) { for (const [id, value] of Object.entries(this.list)) if (predicate(value)) delete this.list[id]; },
        showTLEChoiceDialog: jest.fn(async () => "replace"),
    };
    setFileManager(fm);
    return {sky, fm, satellites: Object.create(CSatellite.prototype)};
}

test("a new download asks again instead of inheriting a previous merge-all choice", async () => {
    const {sky, fm, satellites} = setup();
    fm.parseAsset = async () => ({filename: "part1.tle", dataType: "tle", parsed: "first"});
    await satellites.processTLEData("dated", new ArrayBuffer(0));
    expect(fm.showTLEChoiceDialog).toHaveBeenCalledTimes(1);
    expect(sky.replaceTLE).toHaveBeenCalledWith("first", {revealImported: false});
    expect(sky.mergeTLE).not.toHaveBeenCalled();
    expect(fm.list["old.tle"]).toBeUndefined();
});

test("an explicit replacement is not changed into a merge by a previous batch", async () => {
    const {sky, fm, satellites} = setup();
    await satellites.processTLEData("dated", new ArrayBuffer(0), null, "replace");
    expect(fm.showTLEChoiceDialog).not.toHaveBeenCalled();
    expect(sky.replaceTLE).toHaveBeenCalledTimes(1);
    expect(sky.mergeTLE).toHaveBeenCalledTimes(1);
    expect(fm.list["old.tle"]).toBeUndefined();
});

test("an obsolete background download cannot change files or satellites", async () => {
    const {sky, fm, satellites} = setup();
    await satellites.processTLEData("dated", new ArrayBuffer(0), null, "replace", {automaticCatalog: true, canApplyTLE: () => false});
    expect(Object.keys(fm.list)).toEqual(["old.tle"]);
    expect(sky.replaceTLE).not.toHaveBeenCalled();
});

test("invalid background data leaves the previous catalog and its saved file intact", async () => {
    const {sky, fm, satellites} = setup();
    fm.parseAsset = async () => ({filename: "old.tle", dataType: "tle", parsed: "ERROR: No data"});
    await expect(satellites.processTLEData("old.tle", new ArrayBuffer(0), null, "replace", {automaticCatalog: true, canApplyTLE: () => true}))
        .rejects.toThrow("No data");
    expect(fm.list["old.tle"]).toEqual({isTLE: true});
    expect(sky.replaceTLE).not.toHaveBeenCalled();
});

test("manual historical sources follow the playhead and custom sources receive its exact date", () => {
    const satellites = Object.create(CSatellite.prototype);
    satellites.loadDatedTLEWithRetry = jest.fn();
    setGlobalDateTimeNode({dateStart: new Date("2025-01-01T00:00:00Z"), dateNow: new Date("2025-09-19T12:00:00Z")});
    satellites.updateSats("ALL");
    expect(satellites.loadDatedTLEWithRetry.mock.calls[0][0].toISOString().slice(0, 10)).toBe("2025-09-18");
    satellites.updateSats("CUSTOM");
    expect(satellites.loadDatedTLEWithRetry.mock.calls[1][0].toISOString().slice(0, 10)).toBe("2025-09-19");
});
