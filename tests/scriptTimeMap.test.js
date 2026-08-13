// Tests for the compiled screen-time -> world-frame map.
//
// The headline property is INDEPENDENCE: a segment's source range is resolved and stored,
// so editing one shot's screen duration cannot re-time any other shot. That is the defect
// the old global `t / totalDuration * (frames - 1)` mapping had, and it is asserted
// explicitly below.

const {ScriptTimeMap, makeTimeSegment, uniformTimeMap} =
    require("../src/scriptedVideo/ScriptTimeMap");

describe("uniformTimeMap - parity with the old global mapping", () => {
    // The old mapper: clamp(t/totalDuration,0,1) * (frames-1)
    const oldMapping = (t, totalDuration, frames) => {
        if (totalDuration <= 0) return 0;
        const p = Math.max(0, Math.min(1, t / totalDuration));
        return Math.max(0, Math.min(p * (frames - 1), frames - 1));
    };

    test("matches the old mapping exactly when a/bFrame span the whole sitch", () => {
        const frames = 12600, dur = 105;
        const map = uniformTimeMap(dur, frames, 0, frames - 1);
        for (const t of [0, 0.001, 1, 26.25, 41, 52.5, 104.999, 105]) {
            expect(map.frameAt(t)).toBeCloseTo(oldMapping(t, dur, frames), 9);
        }
    });

    test("clamps outside the script, as the old mapping did", () => {
        const map = uniformTimeMap(105, 12600, 0, 12599);
        expect(map.frameAt(-10)).toBe(0);
        expect(map.frameAt(1e6)).toBe(12599);
    });

    test("zero/negative duration yields an empty map at frame 0", () => {
        expect(uniformTimeMap(0, 12600, 0, 12599).frameAt(5)).toBe(0);
        expect(uniformTimeMap(-1, 12600, 0, 12599).isEmpty).toBe(true);
    });

    test("honours aFrame/bFrame - the old mapper ignored them", () => {
        // scope a 10 s video to frames 300..600 of a 12600-frame sitch
        const map = uniformTimeMap(10, 12600, 300, 600);
        expect(map.frameAt(0)).toBeCloseTo(300, 9);
        expect(map.frameAt(5)).toBeCloseTo(450, 9);
        expect(map.frameAt(10)).toBeCloseTo(600, 9);
        // the old mapping would have given 0 and 6299.5 here
        expect(map.frameAt(0)).not.toBeCloseTo(0.0001, 9);
    });

    test("out-of-range a/bFrame are clamped into the sitch", () => {
        const map = uniformTimeMap(10, 100, -50, 999);
        expect(map.frameAt(0)).toBe(0);
        expect(map.frameAt(10)).toBe(99);
    });
});

describe("piecewise segments", () => {
    // 12600 frames @30fps = 420 s of world. Three shots, 10 s of screen time each.
    const build = () => new ScriptTimeMap([
        makeTimeSegment(0, 10, 0, 1200),        // 40 s of world in 10 s -> 4x
        makeTimeSegment(10, 20, 4770, 5070),    // 10 s of world in 10 s -> 1x (dwell)
        makeTimeSegment(20, 30, 4770, 4770),    // frozen
    ], 12600);

    test("each segment interpolates within its own source range", () => {
        const m = build();
        expect(m.frameAt(0)).toBeCloseTo(0, 9);
        expect(m.frameAt(5)).toBeCloseTo(600, 9);
        expect(m.frameAt(10)).toBeCloseTo(4770, 9);
        expect(m.frameAt(15)).toBeCloseTo(4920, 9);
        expect(m.frameAt(20)).toBeCloseTo(4770, 9);
    });

    test("a frozen segment holds one frame for its whole screen span", () => {
        const m = build();
        for (const t of [20, 22.5, 25, 29.999]) {
            expect(m.frameAt(t)).toBeCloseTo(4770, 9);
        }
        expect(m.rateAt(25)).toBe(0);
    });

    test("rateAt reports source frames per screen second", () => {
        const m = build();
        expect(m.rateAt(5)).toBeCloseTo(120, 9);   // 1200 frames / 10 s
        expect(m.rateAt(15)).toBeCloseTo(30, 9);   // 300 frames / 10 s = real time @30fps
        expect(m.rateAt(25)).toBe(0);
    });

    test("REPLAY: a later segment may revisit an earlier source range", () => {
        const m = new ScriptTimeMap([
            makeTimeSegment(0, 4, 4770, 5070),
            makeTimeSegment(4, 8, 4770, 5070),   // same ten seconds again
        ], 12600);
        expect(m.frameAt(2)).toBeCloseTo(m.frameAt(6), 9);
        expect(m.frameAt(0)).toBeCloseTo(m.frameAt(4), 9);
    });

    test("REVERSE: a segment whose source range runs backwards", () => {
        const m = new ScriptTimeMap([makeTimeSegment(0, 10, 600, 300)], 12600);
        expect(m.frameAt(0)).toBeCloseTo(600, 9);
        expect(m.frameAt(5)).toBeCloseTo(450, 9);
        expect(m.frameAt(10)).toBeCloseTo(300, 9);
        expect(m.rateAt(5)).toBeLessThan(0);
    });

    test("INDEPENDENCE: re-timing one shot leaves the others' source ranges alone", () => {
        // This is the whole point of the redesign. Lengthen the FIRST shot's screen
        // duration and the later shots must still cover exactly the same world.
        const before = build();
        const after = new ScriptTimeMap([
            makeTimeSegment(0, 25, 0, 1200),       // was 10 s of screen, now 25
            makeTimeSegment(25, 35, 4770, 5070),   // shifted in screen time only
            makeTimeSegment(35, 45, 4770, 4770),
        ], 12600);

        // same world coverage, at the shots' new screen positions
        expect(after.frameAt(30)).toBeCloseTo(before.frameAt(15), 9);
        expect(after.frameAt(25)).toBeCloseTo(before.frameAt(10), 9);
        expect(after.frameAt(40)).toBeCloseTo(before.frameAt(25), 9);

        // under the OLD global mapping the same edit would have changed everything
        const oldBefore = (t) => (t / 30) * 12599;
        const oldAfter = (t) => (t / 45) * 12599;
        expect(oldAfter(30)).not.toBeCloseTo(oldBefore(15), 3);
    });

    test("segments are found by containment, and clamp at the ends", () => {
        const m = build();
        expect(m.segmentAt(-5)).toBe(m.segments[0]);
        expect(m.segmentAt(15).sourceIn).toBe(4770);
        expect(m.segmentAt(1e6)).toBe(m.segments[2]);
    });

    test("zero-width screen segments are dropped, not divided by", () => {
        const m = new ScriptTimeMap([
            makeTimeSegment(0, 5, 0, 100),
            makeTimeSegment(5, 5, 100, 200),   // degenerate
            makeTimeSegment(5, 10, 200, 300),
        ], 12600);
        expect(m.segments.length).toBe(2);
        expect(Number.isFinite(m.frameAt(5))).toBe(true);
        expect(m.frameAt(5)).toBeCloseTo(200, 9);
    });

    test("frames outside the sitch are clamped", () => {
        const m = new ScriptTimeMap([makeTimeSegment(0, 10, -100, 99999)], 100);
        expect(m.frameAt(0)).toBe(0);
        expect(m.frameAt(10)).toBe(99);
    });

    test("isUniform distinguishes the single-span case", () => {
        expect(uniformTimeMap(105, 12600, 0, 12599).isUniform).toBe(true);
        expect(build().isUniform).toBe(false);
    });

    test("describe() emits plain compiled data for agents and the editor", () => {
        const d = build().describe();
        expect(d).toHaveLength(3);
        expect(d[0]).toMatchObject({index: 0, screenIn: 0, screenOut: 10, sourceIn: 0, sourceOut: 1200});
        expect(d[0].rate).toBeCloseTo(120, 9);
        expect(d[2].rate).toBe(0);
        expect(JSON.parse(JSON.stringify(d))).toEqual(d);   // serialisable
    });
});

const {parseSourceTime, compileTimeMap} = require("../src/scriptedVideo/ScriptTimeMap");

describe("parseSourceTime", () => {
    // the Coyne sitch: 12600 frames @30, starting 1973-10-19T03:02:00Z = 23:02 EDT
    const opts = {fps: 30, frames: 12600,
                  startTimeMS: Date.parse("1973-10-19T03:02:00Z"), tzOffsetMinutes: -240};

    test("seconds, as number or string", () => {
        expect(parseSourceTime(164, opts).frame).toBeCloseTo(4920, 6);
        expect(parseSourceTime("164", opts).frame).toBeCloseTo(4920, 6);
        expect(parseSourceTime("164.5", opts).frame).toBeCloseTo(4935, 6);
    });

    test("explicit frames", () => {
        expect(parseSourceTime("f4920", opts).frame).toBe(4920);
        expect(parseSourceTime("F0", opts).frame).toBe(0);
    });

    test("wall clock resolves against the sitch start date and timezone", () => {
        // 23:02:00 EDT is frame 0; the closest approach 23:04:44 is frame 4920
        expect(parseSourceTime("23:02:00", opts).frame).toBeCloseTo(0, 6);
        expect(parseSourceTime("23:04:44", opts).frame).toBeCloseTo(4920, 6);
        expect(parseSourceTime("23:09:00", opts).frame).toBeCloseTo(12600, 6);
    });

    test("a clock past local midnight rolls to the next day", () => {
        // the sitch starts at 23:02 EDT, so 00:01 must mean the following morning
        const r = parseSourceTime("00:01:00", opts);
        expect(r.frame).toBeCloseTo(((59 * 60) + 0) * 30, 0);
        expect(r.frame).toBeGreaterThan(0);
    });

    test("absolute instants", () => {
        expect(parseSourceTime("1973-10-19T03:04:44Z", opts).frame).toBeCloseTo(4920, 6);
    });

    test("garbage is an error, never a silent fallback", () => {
        expect(parseSourceTime("banana", opts).error).toMatch(/unrecognised/);
        expect(parseSourceTime("", opts).error).toBeTruthy();
        expect(parseSourceTime(NaN, opts).error).toBeTruthy();
        expect(parseSourceTime("99:99:99", opts).error).toMatch(/out of range/);
        expect(parseSourceTime({}, opts).error).toBeTruthy();
    });
});

describe("compileTimeMap - explicit windows required", () => {
    const opts = {fps: 30, frames: 12600,
                  startTimeMS: Date.parse("1973-10-19T03:02:00Z"), tzOffsetMinutes: -240};

    test("compiles beats that declare windows", () => {
        const {map, errors} = compileTimeMap([
            {start: 0, dur: 5, label: "establish", source: {from: "23:02:00", to: "23:02:20"}},
            {start: 5, dur: 4, label: "the stop",  source: {from: "23:04:39", to: "23:04:49"}},
        ], opts);
        expect(errors).toEqual([]);
        expect(map.segments).toHaveLength(2);
        expect(map.frameAt(0)).toBeCloseTo(0, 4);
        expect(map.frameAt(5)).toBeCloseTo(4770, 4);
        expect(map.rateAt(7)).toBeCloseTo(75, 4);   // 300 frames over 4 s
    });

    test("a missing window is an ERROR, not a default", () => {
        const {map, errors} = compileTimeMap([{start: 0, dur: 5, label: "oops"}], opts);
        expect(map).toBeNull();
        expect(errors[0]).toMatch(/no source window/);
        expect(errors[0]).toMatch(/world 23:04:39\.\.23:04:49/);   // tells you the fix
    });

    test("a window outside the sitch is an error, not a clamp", () => {
        const {map, errors} = compileTimeMap(
            [{start: 0, dur: 5, label: "way out", source: {from: 0, to: 9999}}], opts);
        expect(map).toBeNull();
        expect(errors[0]).toMatch(/outside the sitch/);
    });

    test("freeze is just a zero-width window", () => {
        const {map, errors} = compileTimeMap(
            [{start: 0, dur: 3, source: {from: "23:04:44", to: "23:04:44"}}], opts);
        expect(errors).toEqual([]);
        expect(map.frameAt(0)).toBeCloseTo(4920, 4);
        expect(map.frameAt(3)).toBeCloseTo(4920, 4);
        expect(map.rateAt(1.5)).toBe(0);
    });

    test("overlapping shots are reported", () => {
        const {errors} = compileTimeMap([
            {start: 0, dur: 5, source: {from: 0, to: 60}},
            {start: 3, dur: 5, source: {from: 60, to: 120}},
        ], opts);
        expect(errors.join()).toMatch(/overlap/);
    });

    test("beats are sorted by screen time before compiling", () => {
        const {map, errors} = compileTimeMap([
            {start: 5, dur: 5, source: {from: 100, to: 120}},
            {start: 0, dur: 5, source: {from: 0, to: 20}},
        ], opts);
        expect(errors).toEqual([]);
        expect(map.segments[0].screenIn).toBe(0);
        expect(map.frameAt(1)).toBeLessThan(map.frameAt(6));
    });

    test("errors accumulate rather than stopping at the first", () => {
        const {errors} = compileTimeMap([
            {start: 0, dur: 5, label: "a"},
            {start: 5, dur: 5, label: "b", source: {from: "banana", to: 10}},
        ], opts);
        expect(errors.length).toBeGreaterThanOrEqual(2);
    });
});
