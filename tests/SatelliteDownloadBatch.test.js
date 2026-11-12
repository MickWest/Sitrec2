/** @jest-environment jsdom */
import {CSatellite} from "../src/nodes/CSatellite";
import {parseMethods} from "../src/CFileManagerParse";
import {setFileManager, setNodeMan, setSit} from "../src/Globals";

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
