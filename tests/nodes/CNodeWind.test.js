// Pins the PURE historical track-wind sampler (trackWindAt / TRAV-WIND-001):
// frame-pure interpolation, nearest-row fallback for partial wind coverage
// (no playhead-mutated node state), row-cadence cascades in update(), and the
// wall-clock monotonicity guard. Uses the frame-mapped axis (no timestamps /
// no GlobalDateTimeNode) except where a test installs a fake date-time node.
// CNodeWind imports threeExt (three/addons), which Jest cannot load — stub
// just the helpers this suite never exercises. (Scoped here rather than a
// global three/addons moduleNameMapper: other suites load real addons
// modules through their own paths and must not be stubbed.)
jest.mock("../../src/threeExt", () => ({
    DebugArrowAB: jest.fn(),
}));

import {setNodeMan, setSit, setGlobalDateTimeNode} from "../../src/Globals";
import {CNodeManager} from "../../src/nodes/CNodeManager";
import {CNodeArray} from "../../src/nodes/CNodeArray";
import {CNodeWind} from "../../src/nodes/CNodeWind";
import {MISB} from "../../src/MISBUtils";

const BASE_MS = 1700000000000; // ms-epoch range passes normalizeWindTimestampMs unchanged

function windRow(from, knots, timeMs) {
    const row = [];
    if (from !== null) {
        row[MISB.WindDirection] = from;
        row[MISB.WindSpeed] = knots;
    }
    if (timeMs !== undefined) row[MISB.UnixTimeStamp] = timeMs;
    return row;
}

function makeWind(rows) {
    const track = new CNodeArray({id: "windTrack", array: [0]});
    track.misb = rows;
    const wind = new CNodeWind({id: "testWind", from: 77, knots: 33});
    wind.trackSource = "windTrack";
    return wind;
}

describe("CNodeWind.trackWindAt", () => {
    beforeEach(() => {
        setNodeMan(new CNodeManager());
        setSit({frames: 100, fps: 30, simSpeed: 1});
        setGlobalDateTimeNode(undefined);
    });

    test("interpolates between rows and is frame-pure (node state cannot leak in)", () => {
        const wind = makeWind([windRow(250, 12), windRow(255, 14)]);

        const first = wind.trackWindAt(0);
        expect(first.from).toBeCloseTo(250, 6);
        expect(first.knots).toBeCloseTo(12, 6);
        expect(first.row).toBe(0);

        const last = wind.trackWindAt(99);
        expect(last.from).toBeCloseTo(255, 6);
        expect(last.knots).toBeCloseTo(14, 6);

        const mid = wind.trackWindAt(50);
        expect(mid.from).toBeGreaterThan(250);
        expect(mid.from).toBeLessThan(255);
        expect(mid.knots).toBeGreaterThan(12);
        expect(mid.knots).toBeLessThan(14);

        // Frame purity: mutating the node's live (playhead) values must not
        // change the historical sample.
        wind.from = 111;
        wind.knots = 1;
        const midAgain = wind.trackWindAt(50);
        expect(midAgain.from).toBeCloseTo(mid.from, 12);
        expect(midAgain.knots).toBeCloseTo(mid.knots, 12);
    });

    test("partial wind coverage uses the nearest row with data, never node state", () => {
        const wind = makeWind([
            windRow(250, 12), windRow(null), windRow(null), windRow(255, 14),
        ]);
        // Playhead-style mutation that a fallback to this.from would expose.
        wind.from = 123;
        wind.knots = 45;

        // f=40 brackets the two empty rows; the nearest row with data is row 0.
        const gap = wind.trackWindAt(40);
        expect(gap.from).toBe(250);
        expect(gap.knots).toBe(12);
        expect(gap.row).toBe(0);
    });

    test("a track with no wind columns at all returns null", () => {
        const wind = makeWind([windRow(null), windRow(null)]);
        expect(wind.trackWindAt(0)).toBeNull();
        expect(wind.trackWindAt(99)).toBeNull();
    });

    test("update() cascades on row changes only, not on every interpolated frame", () => {
        const wind = makeWind([
            windRow(250, 12), windRow(260, 14), windRow(270, 16), windRow(280, 18),
        ]);
        wind.recalculateCascade = jest.fn();

        let valueChanges = 0;
        let lastFrom = wind.from;
        for (let f = 0; f < 100; f++) {
            wind.update(f);
            if (wind.from !== lastFrom) valueChanges++;
            lastFrom = wind.from;
        }

        // The interpolated value changes nearly every frame...
        expect(valueChanges).toBeGreaterThan(50);
        // ...but the graph-wide rebake fires once per underlying track ROW
        // (4 rows), not once per rendered frame.
        expect(wind.recalculateCascade).toHaveBeenCalledTimes(4);
        expect(wind.from).toBeCloseTo(280, 6);
        expect(wind.knots).toBeCloseTo(18, 6);
    });

    test("monotonic wall-clock axis is honored; non-monotonic falls back to frame-mapped", () => {
        // frameToMS step function: frames below 50 map to the first row's
        // time, frames from 50 up to the second row's time.
        setGlobalDateTimeNode({frameToMS: f => BASE_MS + (f >= 50 ? 100 : 0)});

        const monotonic = makeWind([
            windRow(250, 12, BASE_MS), windRow(255, 14, BASE_MS + 100),
        ]);
        expect(monotonic.trackWindAt(10).from).toBeCloseTo(250, 6);
        expect(monotonic.trackWindAt(60).from).toBeCloseTo(255, 6);

        // Same rows, timestamps swapped (out of order): the wall axis must be
        // rejected, dropping to the frame-mapped axis, which interpolates —
        // f=10 no longer reads exactly 250.
        setNodeMan(new CNodeManager());
        const swapped = makeWind([
            windRow(250, 12, BASE_MS + 100), windRow(255, 14, BASE_MS),
        ]);
        const v = swapped.trackWindAt(10);
        expect(v.from).toBeGreaterThan(250);
        expect(v.from).toBeLessThan(255);
    });
});
