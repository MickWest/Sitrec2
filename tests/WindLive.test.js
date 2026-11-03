/** @jest-environment jsdom */
// Target and Local Wind read the wind field live (2026-11-03): on each frame, at each
// user's position, height and time. Before, they held one reading taken at a load, and a
// user that read them with v(f) got the frame-0 wind for every frame.
//
// Also the pure rules under that: the GFS column on the terrain, a column read by height,
// and the summary of the wind series that the traverse analysis reports.
jest.mock("three/addons/lines/LineMaterial.js", () => ({LineMaterial: class {}}), {virtual: true});
jest.mock("three/addons/lines/LineGeometry.js", () => ({LineGeometry: class {}}), {virtual: true});
jest.mock("three/addons/lines/Line2.js", () => ({Line2: class {}}), {virtual: true});

import {setNodeMan, setSit} from "../src/Globals";
import {CNodeWind} from "../src/nodes/CNodeWind";
import {
    bracketingLevels,
    columnWindAt,
    fromDirSpeedKnotsToUV,
    fromUVToDirKnots,
    gfsCycleFor,
    gridColumnBracket,
    windSeriesSummary,
} from "../src/nodes/WindHelpers";
import {LLAToECEF} from "../src/LLA-ECEF-ENU";
import {datasetWindSeries, describeWindSeries} from "../src/AnalyzeTraverse";

describe("GFS column on the terrain", () => {
    test("at sea level it brackets as the standard-height table does", () => {
        for (const ft of [100, 1500, 3000, 12000, 31000]) {
            const old = bracketingLevels(ft);
            const now = gridColumnBracket(ft * 0.3048, 0);
            expect([now.lo.level, now.hi.level]).toEqual([old.lo.level, old.hi.level]);
        }
    });

    test("over high ground, levels under the ground are left out", () => {
        // Ground at 1,600 m (Denver). 1000, 925 and 850 hPa are under it at their
        // standard heights (110, 762 and 1,463 m).
        const b = gridColumnBracket(1900, 1600);
        expect(b.lo.level).toBe("surface");
        expect(b.lo.altM).toBe(1610);
        expect(b.hi.level).toBe("700");
        expect(b.status).toBe("ok");
        expect(b.t).toBeCloseTo((1900 - 1610) / (9900 * 0.3048 - 1610), 9);
    });

    test("statuses: below the ground, under the 10 m wind, above the top", () => {
        expect(gridColumnBracket(1500, 1600).status).toBe("below-ground");
        expect(gridColumnBracket(1605, 1600).status).toBe("held-below");
        expect(gridColumnBracket(40000, 0).status).toBe("held-above");
        // No terrain: nothing is "below-ground".
        expect(gridColumnBracket(-20, null).status).toBe("held-below");
    });

    test("the cycle of a date", () => {
        expect(gfsCycleFor(new Date("2025-09-19T20:50:00Z"))).toEqual({dateStr: "20250919", hour: 18});
        expect(gfsCycleFor(new Date("2025-09-20T05:59:00Z"))).toEqual({dateStr: "20250920", hour: 0});
    });
});

describe("a column read by height", () => {
    const column = [{altM: 0, u: 0, v: 10}, {altM: 1000, u: 10, v: 0}];

    test("interpolates by components between levels", () => {
        const w = columnWindAt(column, 500);
        expect(w).toEqual({u: 5, v: 5, status: "ok"});
    });

    test("holds the end levels, and says so, with the height of the level held", () => {
        expect(columnWindAt(column, -5)).toEqual({u: 0, v: 10, status: "held-below", limitM: 0});
        expect(columnWindAt(column, 2000)).toEqual({u: 10, v: 0, status: "held-above", limitM: 1000});
        expect(columnWindAt([], 10)).toBeNull();
    });
});

describe("the wind series of an analysis", () => {
    test("summary: speed range and the direction of the vector mean", () => {
        const s = windSeriesSummary([{from: 350, knots: 10}, {from: 10, knots: 20}, null, {from: 0, knots: 30}]);
        expect(s.count).toBe(3);
        expect([s.minKnots, s.medianKnots, s.maxKnots]).toEqual([10, 20, 30]);
        expect(Math.min(s.meanFrom, 360 - s.meanFrom)).toBeLessThan(5);
        expect(windSeriesSummary([])).toBeNull();
    });

    test("the dataset's per-frame wind gives back the wind that made it", () => {
        // W is ENU metres per frame (x east, y north). 20 kt from 270° blows east.
        const fps = 30, n = 3;
        const W = new Float64Array(n * 3);
        for (let f = 0; f < n; f++) {
            const knots = 20 + 10 * f;
            const {u, v} = fromDirSpeedKnotsToUV(270, knots);
            W[f * 3] = u / fps;
            W[f * 3 + 1] = v / fps;
        }
        const series = datasetWindSeries({n, fps, W});
        expect(series.map(w => Math.round(w.knots))).toEqual([20, 30, 40]);
        expect(series[1].from).toBeCloseTo(270, 6);
        expect(describeWindSeries(series)).toBe(
            "20–30–40 kt per frame (min, median, max of 3 frames), mean direction from 270°");
        expect(describeWindSeries(series.slice(0, 1))).toBe("20 kt from 270° on every frame");
    });
});

describe("a live Target Wind", () => {
    // A wind field whose wind depends on height and frame: 10 kt from 200° near the
    // ground, from 280° at 30 kt at 5,000 m and above, and "held-above" over 9,000 m.
    // It records the frames it was asked for.
    const asked = [];
    const windField = {
        source: "uwyo",
        _sourceDataVersion: 1,
        sourceKeyFor: () => windField.source,
        sondeProfileSignature: () => "1:9000",
        windAt(key, lat, lon, altM, f) {
            asked.push(f);
            const high = altM >= 5000;
            const {u, v} = fromDirSpeedKnotsToUV(high ? 280 : 200, high ? 30 : 10);
            return {u, v, status: altM > 9000 ? "held-above" : "ok"};
        },
    };
    const lockWind = {value: false};
    const nodes = {windField, lockWind};

    function windNode(id, extra = {}) {
        return Object.assign(Object.create(CNodeWind.prototype), {
            id, role: id === "targetWind" ? "target" : "local",
            from: 90, knots: 5, override: false, trackSource: null,
            position: LLAToECEF(34, -117, 0), ...extra,
        });
    }

    beforeAll(() => {
        setSit({fps: 30, simSpeed: 1, frames: 100, lat: 34, lon: -117});
        setNodeMan({
            get: (id) => nodes[id],
            exists: (id) => id in nodes,
        });
    });
    afterAll(() => {
        setNodeMan(undefined);
        setSit(undefined);
    });

    test("it reads the field at the position and height it is asked for", () => {
        const target = windNode("targetWind");
        const low = target.windStateAt(10, LLAToECEF(34, -117, 1000));
        const high = target.windStateAt(10, LLAToECEF(34, -117, 9500));
        expect(Math.round(low.from)).toBe(200);
        expect(Math.round(high.knots)).toBe(30);
        expect(high.status).toBe("held-above");
        expect(high.sourceKey).toBe("uwyo");
    });

    test("v(f) reads frame f, not frame 0", () => {
        const target = windNode("targetWind");
        asked.length = 0;
        target.v(42);
        target.getValueFrame(57, LLAToECEF(34, -117, 1000));
        expect(asked).toEqual([42, 57]);
    });

    test("the vector is the per-frame drift of that wind", () => {
        const target = windNode("targetWind");
        const pos = LLAToECEF(34, -117, 1000);
        const w = target.windVectorAt(0, pos);
        // 10 kt = 5.144 m/s, so 0.1715 m in one frame at 30 fps.
        expect(w.length()).toBeCloseTo(10 * 0.514444 / 30, 4);
    });

    test("Override gives the user's values everywhere", () => {
        const target = windNode("targetWind", {override: true, from: 123, knots: 45});
        const state = target.windStateAt(10, LLAToECEF(34, -117, 9500));
        expect(state).toEqual({from: 123, knots: 45, status: "override", sourceKey: null});
        expect(target.windCacheKey()).toBe("override:123|45");
    });

    test("under Manual it gives its own values", () => {
        windField.source = "manual";
        try {
            const target = windNode("targetWind");
            expect(target.windStateAt(10, LLAToECEF(34, -117, 1000)).status).toBe("manual");
            expect(target.windSignature()).toBe("manual");
        } finally {
            windField.source = "uwyo";
        }
    });

    test("the signature changes with the source data, not with the playhead", () => {
        const target = windNode("targetWind");
        const before = target.windSignature();
        target.from = 17;   // what update() does on each frame
        expect(target.windSignature()).toBe(before);
        windField._sourceDataVersion++;
        expect(target.windSignature()).not.toBe(before);
    });

    test("Lock Target Wind to Local: the target gets Local Wind, at the target", () => {
        const local = windNode("localWind", {override: true, from: 300, knots: 12, lock: "targetWind"});
        const target = windNode("targetWind");
        nodes.localWind = local;
        nodes.targetWind = target;
        lockWind.value = true;
        try {
            const state = target.windStateAt(10, LLAToECEF(34, -117, 1000));
            expect(state).toMatchObject({from: 300, knots: 12, status: "override"});
            expect(target.windCacheKey()).toBe("lock:override:300|12");
        } finally {
            lockWind.value = false;
            delete nodes.localWind;
            delete nodes.targetWind;
        }
    });

    test("with no data at a point it keeps its last values and says so", () => {
        const saved = windField.windAt;
        windField.windAt = () => ({u: null, v: null, status: "pending"});
        try {
            const target = windNode("targetWind", {from: 33, knots: 7});
            expect(target.windStateAt(5, LLAToECEF(34, -117, 1000)))
                .toEqual({from: 33, knots: 7, status: "pending", sourceKey: "uwyo"});
        } finally {
            windField.windAt = saved;
        }
    });

    test("from/knots and u/v agree", () => {
        const {u, v} = fromDirSpeedKnotsToUV(280, 30);
        const back = fromUVToDirKnots(u, v);
        expect(back.from).toBeCloseTo(280, 9);
        expect(back.knots).toBeCloseTo(30, 9);
    });
});

describe("a windblown fixed target", () => {
    // CNodePositionLLA with a wind input ("fixedTarget + Wind"): the drift is the sum of
    // the per-frame wind, read where the target is on each frame.
    const {CNodePositionLLA} = require("../src/nodes/CNodePositionLLA");
    const {Vector3} = require("three");

    function drifting(windAt) {
        return Object.assign(Object.create(CNodePositionLLA.prototype), {
            frames: 5, ecef: new Vector3(1000, 0, 0),
            inputs: {wind: {getValueFrame: (f, pos) => windAt(f, pos)}},
        });
    }

    test("a constant wind drifts the same distance each frame (no Sim Speed factor)", () => {
        const node = drifting(() => new Vector3(0, 2, 0));
        node._bakeWindDrift();
        expect(node._windDriftAt(0).y).toBe(0);
        expect(node._windDriftAt(4).y).toBe(8);
        expect(node._windDriftAt(2.5).y).toBeCloseTo(5, 9);
        expect(node._windDriftAt(6).y).toBeCloseTo(12, 9);   // past the end: the last frame's wind
    });

    test("the wind is read where the target has drifted to", () => {
        // A wind that doubles once the target is 3 m from the start.
        const node = drifting((f, pos) => new Vector3(0, pos.y >= 3 ? 4 : 2, 0));
        node._bakeWindDrift();
        expect([1, 2, 3, 4].map(f => node._windDriftAt(f).y)).toEqual([2, 4, 8, 12]);
    });
});
