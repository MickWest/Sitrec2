import {parseScript, tokenizeWithPos, activeViewAt} from "../src/scriptedVideo/ScriptParser";

describe("tokenizeWithPos", () => {
    test("splits on whitespace with character spans", () => {
        const t = tokenizeWithPos("zoom OE-LNC 6");
        expect(t.map(x => x.text)).toEqual(["zoom", "OE-LNC", "6"]);
        expect(t[2]).toEqual({text: "6", start: 12, end: 13});
    });

    test("treats quoted strings as one token (span includes the quotes)", () => {
        const t = tokenizeWithPos('text "two words" 3');
        expect(t.map(x => x.text)).toEqual(["text", "two words", "3"]);
        expect(t[1].start).toBe(5);
        expect(t[1].end).toBe(16);
    });
});

describe("parseScript — spine and concurrency", () => {
    test("spine lines run sequentially, & lines attach to the spine start", () => {
        const r = parseScript([
            "zoom A 6",
            '& text "cap" 4',     // starts WITH the zoom
            "&2 wait 1",          // starts 2s after the zoom's start
            "orbit A 9",          // spine: starts when the zoom ends
        ].join("\n"));
        expect(r.errors).toEqual([]);
        const byType = Object.fromEntries(r.events.map(e => [e.type + e.line, e]));
        expect(byType["zoom1"].start).toBe(0);
        expect(byType["text2"].start).toBe(0);
        expect(byType["wait3"].start).toBe(2);
        expect(byType["orbit4"].start).toBe(6);
        expect(r.totalDuration).toBe(15);
    });

    test("text does not advance the spine but extends the total duration", () => {
        const r = parseScript(['wait 1', 'text "tail" 10'].join("\n"));
        expect(r.events[1].start).toBe(1);
        expect(r.totalDuration).toBe(11);
    });

    test("camera beats are sorted by start time", () => {
        const r = parseScript(["wait 4", "&1 fov 20 1", "wait 1"].join("\n"));
        expect(r.cameraBeats.map(b => b.start)).toEqual([0, 1, 4]);
    });

    test("overlapping timed events stack into separate lanes", () => {
        const r = parseScript(["zoom A 6", '& text "cap" 4'].join("\n"));
        expect(r.numLanes).toBe(2);
        const lanes = r.events.map(e => e._lane);
        expect(new Set(lanes).size).toBe(2);
    });
});

describe("parseScript — comments", () => {
    test("strips trailing comments", () => {
        const r = parseScript("wait 2 # hold here");
        expect(r.errors).toEqual([]);
        expect(r.events[0].dur).toBe(2);
    });

    test("a # inside a quoted caption is part of the caption", () => {
        const r = parseScript('text "Flight #2 inbound" 4');
        expect(r.errors).toEqual([]);
        expect(r.events[0].text).toBe("Flight #2 inbound");
        expect(r.events[0].dur).toBe(4);
    });
});

describe("parseScript — validation errors", () => {
    test("unknown command", () => {
        const r = parseScript("teleport A 3");
        expect(r.errors).toEqual(['line 1: unknown command "teleport"']);
        expect(r.events).toEqual([]);
    });

    test("unknown view", () => {
        const r = parseScript("view side");
        expect(r.errors[0]).toMatch(/unknown view "side"/);
    });

    test("negative duration is rejected", () => {
        const r = parseScript("wait -5");
        expect(r.errors[0]).toMatch(/negative duration/);
        expect(r.cameraBeats).toEqual([]);
        expect(r.totalDuration).toBe(0);
    });

    test("multi-word caption without quotes is rejected", () => {
        const r = parseScript("text hello world 3");
        expect(r.errors[0]).toMatch(/need quotes/);
        expect(r.events).toEqual([]);
    });

    test("single-word caption without quotes is fine", () => {
        const r = parseScript("text hello 3");
        expect(r.errors).toEqual([]);
        expect(r.events[0].text).toBe("hello");
    });

    test("zoom/orbit/track need an object and a duration", () => {
        const r = parseScript(["zoom", "orbit A", "track A x"].join("\n"));
        expect(r.errors).toHaveLength(3);
    });
});

describe("parseScript — command fields and spans", () => {
    test("fov clamps to [1,120] and records editable spans", () => {
        const r = parseScript("fov 500 2");
        expect(r.events[0].fov).toBe(120);
        expect(r.events[0].spans.fov).toEqual({start: 4, end: 7});
        expect(r.events[0].spans.dur).toEqual({start: 8, end: 9});
    });

    test("orbit defaults to 90 degrees", () => {
        const r = parseScript("orbit A 5");
        expect(r.events[0].degrees).toBe(90);
    });

    test("title is an alias for text", () => {
        const r = parseScript('title "hello" 2');
        expect(r.events[0].type).toBe("text");
    });

    test("a malformed number like 4hen is not wheel-editable (no span)", () => {
        const r = parseScript("wait 4hen");
        expect(r.events[0].dur).toBe(4);          // parseFloat salvages the value
        expect(r.events[0].spans.dur).toBeNull(); // but it must not be wheel-editable
    });

    test("&N records the offset number's span for wheel editing", () => {
        const r = parseScript(["wait 5", "&2 wait 1"].join("\n"));
        expect(r.events[1].offSpan).toEqual({start: 1, end: 2});
    });
});

describe("activeViewAt", () => {
    test("returns the last view cut at or before t", () => {
        const r = parseScript(["view main", "wait 5", "view look", "wait 5"].join("\n"));
        expect(activeViewAt(r.events, "main", 0)).toBe("main");
        expect(activeViewAt(r.events, "main", 4.9)).toBe("main");
        expect(activeViewAt(r.events, "main", 5.1)).toBe("look");
    });

    test("falls back to the default view with no cuts", () => {
        const r = parseScript("wait 5");
        expect(activeViewAt(r.events, "main", 2)).toBe("main");
    });
});
