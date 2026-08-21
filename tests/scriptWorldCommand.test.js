// The `world` command: how a shot declares which slice of world time it covers.
//
// Screen duration and world window are independent — that is what buys dwell, slow
// motion, freeze and replay. Every shot must declare a window; there is deliberately no
// implicit default, so one shot's timing can never be derived from another's.

const {resolveCommand, buildEvent, eventLabel} =
    require("../src/scriptedVideo/ScriptCommands");
const {desugarScript} = require("../src/scriptedVideo/ScriptSugar");

const build = (...argv) => {
    const r = resolveCommand("world");
    let err = null;
    const e = buildEvent("world", r.def, argv, (m) => { err = m; return null; }, {});
    return {e, err};
};

describe("world command", () => {
    test("is a resolvable, non-camera command", () => {
        const r = resolveCommand("world");
        expect(r).not.toBeNull();
        expect(r.def.cameraBeat).toBe(false);
    });

    test("one-token range: from..to", () => {
        const {e, err} = build("23:04:39..23:04:49");
        expect(err).toBeNull();
        expect(e).toMatchObject({from: "23:04:39", to: "23:04:49", dur: 0});
    });

    test("two-token range: from to", () => {
        const {e} = build("23:04:39", "23:04:49");
        expect(e).toMatchObject({from: "23:04:39", to: "23:04:49"});
    });

    test("a single instant freezes the world for the shot", () => {
        const {e} = build("23:04:44");
        expect(e.from).toBe("23:04:44");
        expect(e.to).toBe(e.from);       // zero-width window == freeze
    });

    test("accepts seconds and explicit frames as well as clocks", () => {
        expect(build(159, 169).e).toMatchObject({from: "159", to: "169"});
        expect(build("f4770..f5070").e).toMatchObject({from: "f4770", to: "f5070"});
    });

    test("consumes no time of its own", () => {
        expect(build("0..10").e.dur).toBe(0);
    });

    test("malformed ranges are reported, not guessed at", () => {
        expect(build("23:04:39..").err).toMatch(/bad range/);
        expect(build("..23:04:49").err).toMatch(/bad range/);
        expect(build("..").err).toMatch(/bad range/);
        expect(build("a..b..c").err).toMatch(/bad range/);
    });

    test("labels read naturally on the timeline", () => {
        // buildEvent fills the fields; the runner stamps .type, which eventLabel keys on
        const labelOf = (...a) => eventLabel({...build(...a).e, type: "world"});
        expect(labelOf("23:04:39..23:04:49")).toBe("world 23:04:39..23:04:49");
        expect(labelOf("23:04:44")).toBe("hold 23:04:44");
    });
});

describe("world in the flat DSL", () => {
    test("attaches to a shot with & and needs no new sugar syntax", () => {
        const {code} = desugarScript([
            "track UFO 4",
            "& world 23:04:39..23:04:49",
        ].join("\n"));
        const lines = code.split("\n");
        expect(lines[0]).toContain('track("UFO", 4)');
        expect(lines[1]).toContain('world("23:04:39..23:04:49")');
        expect(lines[1]).toContain("atStart(__sp, 0");
    });

    test("the range token survives tokenising intact (dots, colons and all)", () => {
        const {code} = desugarScript("& world 23:04:39..23:04:49");
        expect(code).toContain('"23:04:39..23:04:49"');
    });

    test("frame and seconds forms desugar too", () => {
        expect(desugarScript("& world f4770..f5070").code).toContain('world("f4770..f5070")');
        expect(desugarScript("& world 159 169").code).toContain("world(159, 169)");
    });

    test("line count is preserved, so error line numbers stay correct", () => {
        const src = ["# a shot", "track UFO 4", "& world 0..10", "", "wait 1"].join("\n");
        expect(desugarScript(src).code.split("\n")).toHaveLength(5);
    });
});
