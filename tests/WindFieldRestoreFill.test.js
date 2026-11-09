// A wind field restored from its saved grid files fills again once the sitch is restored.
//
// The quick restore draws the lines of one grid time. The displayed lines follow the sitch
// time, which can need the grids on both sides of it, and the path with no saved files
// already fills after the restore. Without a fill here too, a saved sitch showed one of two
// wind fields depending on whether its files loaded before the wind node did. And a level
// asked for while the wind proxy is busy (503 with Retry-After) is asked for again.

import {setFileManager, setNodeMan} from '../src/Globals';
import {CNodeDisplayWindField} from '../src/nodes/CNodeDisplayWindField';
import {LoadingManager} from '../src/CLoadingManager';

const grid = {nx: 360, ny: 181, lon0: 0, lat0: 90, dlon: 1, dlat: -1,
    u: new Array(360 * 181).fill(10), v: new Array(360 * 181).fill(0),
    refTime: "2025-09-19T18:00:00Z", level: "200hPa", source: "GFS"};

const saved = {
    visible: true, source: "gfs", windAltFt: 42580, windLevel: "200", hasWindData: true,
    windFileIds: ["windGrid_GFS_200hPa"],
    loadedWindFiles: [{fileId: "windGrid_GFS_200hPa", level: "200hPa", dateStr: "20250919", hour: "18", source: "GFS"}],
};

function restored() {
    return Object.assign(Object.create(CNodeDisplayWindField.prototype), {
        simpleSerials: [], _object: {visible: true}, visible: true,
        _loadedWindFiles: new Map(), _levelCache: {},
        rebuildStreamlines: jest.fn(), _showProvenance() {}, setStatusMessage() {}, setInspect() {},
    });
}

beforeAll(() => setNodeMan({get: () => undefined, exists: () => false}));
afterAll(() => {
    setNodeMan(undefined);
    setFileManager(undefined);
});

test("the saved files are there: the lines are drawn, and a fill is asked for", async () => {
    setFileManager({list: {windGrid_GFS_200hPa: {data: grid}}});
    const wind = restored();
    await wind.modDeserialize(saved);
    expect(wind.rebuildStreamlines).toHaveBeenCalled();
    expect(wind._needsPostDeserializeFetch).toBe(true);
    expect(wind.getPendingLoadState().hasPending).toBe(true);
});

test("a hidden wind field asks for no fill", async () => {
    setFileManager({list: {windGrid_GFS_200hPa: {data: grid}}});
    const wind = restored();
    // A current save stores linesVisible; without it, `visible` is read as the old
    // lines switch and the field itself stays visible.
    await wind.modDeserialize({...saved, visible: false, linesVisible: true});
    expect(wind._needsPostDeserializeFetch).toBeFalsy();
});

test("the saved files are not there yet: the reload of every level is asked for", async () => {
    setFileManager({list: {}});
    const wind = restored();
    await wind.modDeserialize(saved);
    expect(wind.rebuildStreamlines).not.toHaveBeenCalled();
    expect(wind._needsPostDeserializeReloadGFS).toHaveLength(1);
});

describe("a level fetched while the wind proxy is busy", () => {
    const reply = (status, headers = {}, body = grid) => ({
        status, ok: status === 200, headers: {get: name => headers[name] ?? null},
        json: async () => body,
    });
    const fetcher = () => Object.assign(Object.create(CNodeDisplayWindField.prototype), {
        _levelCache: {}, _loadedWindFiles: new Map(), _sourceDataVersion: 0,
    });
    beforeAll(() => {
        // The corner loading indicator is DOM; it is not what these tests check.
        jest.spyOn(LoadingManager, "registerLoading").mockImplementation(() => {});
        jest.spyOn(LoadingManager, "completeLoading").mockImplementation(() => {});
    });
    afterAll(() => jest.restoreAllMocks());
    afterEach(() => { delete global.fetch; });

    test("a 503 with Retry-After is tried again, and the level arrives", async () => {
        global.fetch = jest.fn()
            .mockResolvedValueOnce(reply(503, {"Retry-After": "0.01"}))
            .mockResolvedValueOnce(reply(200));
        const json = await fetcher()._fetchLevel("200", "20250920", 0, "gfs");
        expect(json.u).toHaveLength(360 * 181);
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test("a 503 without Retry-After fails at once", async () => {
        global.fetch = jest.fn().mockResolvedValue(reply(503));
        await expect(fetcher()._fetchLevel("200", "20250920", 0, "gfs")).rejects.toThrow("HTTP 503");
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test("a proxy that stays busy fails after four tries", async () => {
        global.fetch = jest.fn().mockResolvedValue(reply(503, {"Retry-After": "0.01"}));
        await expect(fetcher()._fetchLevel("200", "20250920", 0, "gfs")).rejects.toThrow("HTTP 503");
        expect(global.fetch).toHaveBeenCalledTimes(4);
    });
});
