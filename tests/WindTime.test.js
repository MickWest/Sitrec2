// Wind plan phase 4 (2026-11-03): a grid source is blended between the two grid
// times around a frame's time (decision D5), an installation's grid source can
// set its cadence, GFS levels sit at their real (geopotential) heights where the
// grid gives them, and the sounding load takes the launch nearest the sitch start.

import {setGlobalDateTimeNode, setNodeMan} from "../src/Globals";
import {blendGridSamples, CNodeDisplayWindField} from "../src/nodes/CNodeDisplayWindField";
import {
    fromUVToDirKnots,
    gridCadenceFromSetting,
    gridColumn,
    gridColumnBracket,
    gridTimesAround,
} from "../src/nodes/WindHelpers";
import {nearestLaunches} from "../src/SondeFetch";

const H = 3600000;
const T0 = Date.UTC(2025, 8, 19, 18);   // 2025-09-19 18Z

describe("the grid times around a time", () => {
    test("GFS: the cycles on each side, and the weight of the later one", () => {
        const {c0, c1, w} = gridTimesAround(T0 + 2 * H, 6);
        expect([c0.dateStr, c0.hour, c1.dateStr, c1.hour]).toEqual(["20250919", 18, "20250920", 0]);
        expect(w).toBeCloseTo(1 / 3, 12);
        expect(gridTimesAround(T0, 6).w).toBe(0);
    });

    test("an hourly source", () => {
        const {c0, c1, w} = gridTimesAround(T0 + 90 * 60000, 1);
        expect([c0.hour, c1.hour, w]).toEqual([19, 20, 0.5]);
    });

    test("a cadence is a whole divisor of 24, else 6", () => {
        expect([1, 2, 3, 4, 6, 8, 12, 24].map(n => gridCadenceFromSetting(String(n)))).toEqual([1, 2, 3, 4, 6, 8, 12, 24]);
        expect([undefined, "", "5", "0", "-6", "1.5", "48"].map(v => gridCadenceFromSetting(v))).toEqual([6, 6, 6, 6, 6, 6, 6]);
    });
});

describe("two grid samples blended in time", () => {
    const ok = (u, v) => ({u, v, status: "ok"});
    test("both: by the weight", () => {
        expect(blendGridSamples(ok(0, 10), ok(10, 0), 0.25)).toEqual({u: 2.5, v: 7.5, status: "ok"});
    });
    test("the later one is not published: the earlier one alone", () => {
        expect(blendGridSamples(ok(1, 2), {u: null, v: null, status: "no-data"}, 0.5)).toEqual(ok(1, 2));
    });
    test("the later one is on its way: the earlier one, marked pending", () => {
        expect(blendGridSamples(ok(1, 2), {u: null, v: null, status: "pending"}, 0.5).status).toBe("pending");
    });
    test("a held value keeps its status and height", () => {
        const held = {u: 5, v: 5, status: "held-above", limitM: 30000};
        expect(blendGridSamples(held, ok(5, 5), 0.5)).toMatchObject({status: "held-above", limitM: 30000});
    });
});

describe("GFS levels at their real heights", () => {
    test("a level takes its height where given, else the standard one", () => {
        const column = gridColumn(0, {"1000": 40, "925": 700});
        expect(column.slice(0, 4)).toEqual([
            {level: "surface", altM: 10}, {level: "1000", altM: 40},
            {level: "925", altM: 700}, {level: "850", altM: 4800 * 0.3048}]);
    });

    test("a level under the surface wind (a deep low at sea) is left out", () => {
        const column = gridColumn(0, {"1000": -150});
        expect(column.map(l => l.level).slice(0, 2)).toEqual(["surface", "925"]);
    });

    test("the bracket follows the real heights", () => {
        // 700 hPa at 2,900 m in a low: a point at 2,950 m is above it.
        const b = gridColumnBracket(2950, 0, {"700": 2900, "500": 5500});
        expect([b.lo.level, b.hi.level]).toEqual(["700", "500"]);
        expect(gridColumnBracket(2950, 0).hi.level).toBe("700");   // standard: 700 hPa at 3,018 m
    });
});

describe("a grid source read at a point, between two cycles", () => {
    // A grid with the same wind everywhere: from the west at 10 m/s in the 18Z
    // cycle and from the south at 10 m/s in the 00Z cycle, at every level. The
    // 00Z grids carry heights, near the standard ones.
    const grid = (u, v, hgt) => ({nx: 360, ny: 181, lon0: 0, lat0: 90, dlon: 1, dlat: -1,
        u: new Array(360 * 181).fill(u), v: new Array(360 * 181).fill(v),
        ...(hgt != null ? {hgt: new Array(360 * 181).fill(hgt)} : {}), refTime: "x"});
    const levelCache = {};
    const HEIGHTS = {surface: null, "1000": 100, "925": 750, "850": 1450, "700": 3000, "500": 5550};
    for (const [level, hgt] of Object.entries(HEIGHTS)) {
        levelCache[`gfs:20250919_18_${level}`] = grid(10, 0, null);
        levelCache[`gfs:20250920_0_${level}`] = grid(0, 10, hgt);
    }
    let frameMs = T0;
    function field() {
        return Object.assign(Object.create(CNodeDisplayWindField.prototype), {
            source: "gfs", _levelCache: levelCache, _levelQueue: [], _levelQueueActive: 0,
            _failedLevels: new Map(), _groundMSL: () => 0,
        });
    }
    beforeAll(() => {
        setNodeMan({get: () => undefined, exists: () => false});
        setGlobalDateTimeNode({frameToMS: () => frameMs, dateNow: new Date(frameMs)});
    });
    afterAll(() => {
        setNodeMan(undefined);
        setGlobalDateTimeNode(undefined);
    });

    test("at the cycle time, that cycle; half way, half of each", () => {
        frameMs = T0;
        const atCycle = field().windAt("gfs", 34, 242, 2000, 0);
        expect(Math.round(fromUVToDirKnots(atCycle.u, atCycle.v).from)).toBe(270);
        frameMs = T0 + 3 * H;
        const half = field().windAt("gfs", 34, 242, 2000, 0);
        expect(half.u).toBeCloseTo(5, 9);
        expect(half.v).toBeCloseTo(5, 9);
        expect(half.status).toBe("ok");
    });

    test("heights are used only when every loaded level of that time has them", () => {
        const wf = field();
        expect(wf._columnHeights("gfs", "20250920", 0, 34, 242)).toEqual(
            {"1000": 100, "925": 750, "850": 1450, "700": 3000, "500": 5550});
        expect(wf._columnHeights("gfs", "20250919", 18, 34, 242)).toBeNull();
    });
});

describe("the sounding launch nearest the sitch start", () => {
    const now = Date.UTC(2030, 0, 1);
    const at = (iso) => Date.parse(iso);
    test("before or after the start, whichever is nearer", () => {
        expect(nearestLaunches(at("2025-09-19T10:30:00Z"), now).map(l => [l.date, l.hour]))
            .toEqual([["2025-09-19", 12], ["2025-09-19", 0]]);
        expect(nearestLaunches(at("2025-09-19T03:00:00Z"), now)[0]).toMatchObject({date: "2025-09-19", hour: 0});
        expect(nearestLaunches(at("2025-09-19T20:00:00Z"), now)[0]).toMatchObject({date: "2025-09-20", hour: 0});
    });
    test("a tie goes to the later launch", () => {
        expect(nearestLaunches(at("2025-09-19T18:00:00Z"), now)[0]).toMatchObject({date: "2025-09-20", hour: 0});
    });
    test("a launch that has not happened yet is not offered", () => {
        const start = at("2025-09-19T20:00:00Z");
        expect(nearestLaunches(start, at("2025-09-19T21:00:00Z")).map(l => l.hour)).toEqual([12]);
        expect(nearestLaunches(at("2026-01-01T00:00:00Z"), at("2025-09-19T13:00:00Z")))
            .toEqual([{date: "2025-09-19", hour: 12, ms: at("2025-09-19T12:00:00Z")}]);
    });
});
