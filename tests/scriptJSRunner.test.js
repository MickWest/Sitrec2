// The scheduling kernel: virtual clock, await semantics, sugar parity with the
// old line-based DSL, validation errors, and runaway-loop guards. Every timing
// expectation in the "sugar" tests matches the old ScriptParser behavior.

import {runScriptJS, activeViewAt} from "../src/scriptedVideo/ScriptJSRunner";
import {layoutForViewEvent} from "../src/scriptedVideo/ScriptCommands";

const run = (lines) => runScriptJS(Array.isArray(lines) ? lines.join("\n") : lines);

describe("sugar scripts — old DSL semantics preserved", () => {
    test("spine lines run sequentially, & lines attach to the spine start", async () => {
        const r = await run([
            "zoom A 6",
            '& text "cap" 4',     // starts WITH the zoom
            "&2 wait 1",          // starts 2s after the zoom's start
            "orbit A 9",          // spine: starts when the zoom ends
        ]);
        expect(r.errors).toEqual([]);
        const byType = Object.fromEntries(r.events.map(e => [e.type + e.line, e]));
        expect(byType["zoom1"].start).toBe(0);
        expect(byType["text2"].start).toBe(0);
        expect(byType["wait3"].start).toBe(2);
        expect(byType["orbit4"].start).toBe(6);
        expect(r.totalDuration).toBe(15);
    });

    test("the old default demo script produces the classic timeline", async () => {
        const r = await run([
            "view main",
            "zoom OE-LNC 6",
            '& text "OE-LNC" 4',
            "orbit OE-LNC 9 110",
            '&1 text "tracking inbound" 4',
            "track OE-LNC 4",
            "view look",
            "wait 2",
        ]);
        expect(r.errors).toEqual([]);
        const starts = r.events.map(e => [e.type, e.start]);
        expect(starts).toEqual([
            ["view", 0], ["zoom", 0], ["text", 0], ["orbit", 6],
            ["text", 7], ["track", 15], ["view", 19], ["wait", 19],
        ]);
        expect(r.totalDuration).toBe(21);
    });

    test("a timed text line advances the spine and extends the total", async () => {
        const r = await run(["wait 1", 'text "tail" 10']);
        expect(r.events[1].start).toBe(1);
        expect(r.totalDuration).toBe(11);
    });

    test("camera beats are sorted by start time", async () => {
        const r = await run(["wait 4", "&1 fov 20 1", "wait 1"]);
        expect(r.cameraBeats.map(b => b.start)).toEqual([0, 1, 4]);
    });

    test("overlapping timed events stack into separate lanes", async () => {
        const r = await run(["zoom A 6", '& text "cap" 4']);
        expect(r.numLanes).toBe(2);
        expect(new Set(r.events.map(e => e._lane)).size).toBe(2);
    });

    test("events carry the sugar line's wheel-edit spans and line number", async () => {
        const r = await run(["wait 5", "&2 wait 1"]);
        expect(r.events[0].line).toBe(1);
        expect(r.events[0].spans.dur).toEqual({start: 5, end: 6});
        expect(r.events[1].offSpan).toEqual({start: 1, end: 2});
    });

    test("fov clamps to [1,120]; orbit defaults to 90; title aliases text", async () => {
        const r = await run(["fov 500 2", "orbit A 5", 'title "hello" 2']);
        expect(r.events[0].fov).toBe(120);
        expect(r.events[1].degrees).toBe(90);
        expect(r.events[2].type).toBe("text");
    });
});

describe("JS scripts — await-style concurrency", () => {
    test("await sequences; un-awaited calls run concurrently; sleep offsets", async () => {
        const r = await run([
            'view("main");',
            'const z = zoom("OE-LNC", 6);',
            'text("OE-LNC", 4);',
            "sleep(1);",
            'text("inbound", 4);',
            "await z;",
            'await orbit("OE-LNC", 9, 110);',
        ]);
        expect(r.errors).toEqual([]);
        const starts = r.events.map(e => [e.type, e.start]);
        expect(starts).toEqual([
            ["view", 0], ["zoom", 0], ["text", 0], ["text", 1], ["orbit", 6],
        ]);
        expect(r.totalDuration).toBe(15);
    });

    test("awaiting a handle never moves the clock backward", async () => {
        const r = await run([
            'const z = zoom("A", 2);',
            'await orbit("A", 9);',   // clock → 9
            "await z;",               // z ended at 2; clock stays 9
            "await wait(1);",
        ]);
        expect(r.events[2].start).toBe(9);
        expect(r.totalDuration).toBe(10);
    });

    test("all() joins concurrent handles", async () => {
        const r = await run([
            'const a = zoom("A", 6);',
            'const b = orbit("B", 9);',
            "await all(a, b);",
            "await wait(1);",
        ]);
        expect(r.events[2].start).toBe(9);
        expect(r.totalDuration).toBe(10);
    });

    test("loops produce one event per iteration sharing a call site", async () => {
        const r = await run([
            'for (const t of ["A", "B", "C"]) {',
            "    await zoom(t, 5);",
            "}",
        ]);
        expect(r.errors).toEqual([]);
        expect(r.events.map(e => [e.target, e.start])).toEqual([["A", 0], ["B", 5], ["C", 10]]);
        expect(new Set(r.events.map(e => e.line))).toEqual(new Set([2]));
    });

    test("computed durations work (it's just JS)", async () => {
        const r = await run(["const secs = 2 * 3;", 'await zoom("A", secs);']);
        expect(r.events[0].dur).toBe(6);
    });

    test("at() records relative to the current clock without advancing it", async () => {
        const r = await run([
            "sleep(5);",
            'at(2, () => text("late", 3));',
            "await wait(1);",
        ]);
        expect(r.events[0].start).toBe(7);   // text at 5+2
        expect(r.events[1].start).toBe(5);   // wait at the unmoved clock
    });

    test("sugar and JS lines mix; sugar spine awaits keep JS sequential", async () => {
        const r = await run([
            "view main",
            'const t = "OE-LNC";',
            "zoom OE-LNC 6",
            "await orbit(t, 9);",
        ]);
        expect(r.errors).toEqual([]);
        expect(r.events.map(e => [e.type, e.start])).toEqual([["view", 0], ["zoom", 0], ["orbit", 6]]);
        expect(r.totalDuration).toBe(15);
    });
});

describe("errors", () => {
    test("unknown command word becomes a line-mapped JS error", async () => {
        const r = await run("teleport A 3");
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0]).toMatch(/^line 1: /);
        expect(r.errors[0]).toMatch(/teleport/);
        expect(r.events).toEqual([]);
    });

    test("unknown view is reported with its line; the run continues", async () => {
        const r = await run(["view side", "wait 2"]);
        expect(r.errors).toEqual(['line 1: unknown view or preset "side"']);
        expect(r.events.map(e => e.type)).toEqual(["wait"]);
    });

    test("negative duration is rejected", async () => {
        const r = await run("wait -5");
        expect(r.errors[0]).toMatch(/negative duration/);
        expect(r.cameraBeats).toEqual([]);
        expect(r.totalDuration).toBe(0);
    });

    test("multi-word caption without quotes is rejected with the quotes hint", async () => {
        const r = await run("text hello world 3");
        expect(r.errors[0]).toMatch(/need quotes/);
        expect(r.events).toEqual([]);
    });

    test("single-word caption without quotes is fine", async () => {
        const r = await run("text hello 3");
        expect(r.errors).toEqual([]);
        expect(r.events[0].text).toBe("hello");
    });

    test("missing or non-numeric arguments are rejected per line", async () => {
        const r = await run(["zoom", "track A x"]);
        expect(r.errors).toHaveLength(2);
        expect(r.errors[0]).toMatch(/^line 1: .*target/);
        expect(r.errors[1]).toMatch(/^line 2: .*number/);
    });

    test("a malformed number like 4hen is an error (was silently salvaged by the DSL)", async () => {
        const r = await run("wait 4hen");
        expect(r.errors[0]).toMatch(/number/);
        expect(r.events).toEqual([]);
    });

    test("a JS runtime error is mapped to its source line; earlier events survive", async () => {
        const r = await run(['await zoom("A", 6);', "undefinedFn();"]);
        expect(r.events).toHaveLength(1);
        expect(r.errors[0]).toMatch(/^line 2: /);
        expect(r.errorDetails[0].line).toBe(2);
    });

    test("a syntax error reports without running anything", async () => {
        const r = await run('await zoom("A", 6;');
        expect(r.errors[0]).toMatch(/syntax error/);
        expect(r.events).toEqual([]);
    });

    test("a runaway loop is capped, not hung", async () => {
        const r = await run(["while (true) {", "    await wait(1);", "}"]);
        expect(r.errors[0]).toMatch(/runaway|too long/);
        expect(r.events.length).toBeGreaterThan(0);
        expect(r.events.length).toBeLessThanOrEqual(5000);
    });
});

describe("view presets and custom layouts", () => {
    const PRESETS = {
        ThreeWide: {
            keypress: "4",
            mainView: {visible: true, left: 0, top: 0, width: 0.333, height: 1},
            video: {visible: true, left: 0.333, top: 0, width: 0.333, height: 1},
            lookView: {visible: true, left: 0.666, top: 0, width: 0.333, height: 1},
        },
        SideBySide: {
            mainView: {visible: true, left: 0, top: 0, width: 0.5, height: 1},
            video: {visible: false},
            lookView: {visible: true, left: 0.5, top: 0, width: 0.5, height: 1},
        },
    };

    test("a preset name resolves (case-insensitively) when presets are provided", async () => {
        const r = await runScriptJS(["view threewide", "wait 2"].join("\n"), {viewPresets: PRESETS});
        expect(r.errors).toEqual([]);
        expect(r.events[0].preset).toBe("ThreeWide");
    });

    test("single view names still work alongside presets", async () => {
        const r = await runScriptJS('view("video");', {viewPresets: PRESETS});
        expect(r.errors).toEqual([]);
        expect(r.events[0].view).toBe("video");
    });

    test("an explicit layout object normalizes friendly names to view ids", async () => {
        const r = await runScriptJS('view({main: [0, 0, 0.5, 1], video: [0.5, 0, 0.5, 1]});');
        expect(r.errors).toEqual([]);
        expect(r.events[0].layoutSpec).toEqual({
            mainView: {left: 0, top: 0, width: 0.5, height: 1},
            video: {left: 0.5, top: 0, width: 0.5, height: 1},
        });
    });

    test("a malformed layout rect is rejected with the line", async () => {
        const r = await runScriptJS('view({main: [0, 0, 0.5]});');
        expect(r.errors[0]).toMatch(/^line 1: .*\[left, top, width, height\]/);
        expect(r.events).toEqual([]);
    });

    test("layoutForViewEvent resolves presets, skipping hidden and rect-only entries", async () => {
        const r = await runScriptJS(["view SideBySide", "view main"].join("\n"), {viewPresets: PRESETS});
        expect(layoutForViewEvent(r.events[0], PRESETS)).toEqual({
            mainView: {left: 0, top: 0, width: 0.5, height: 1},
            lookView: {left: 0.5, top: 0, width: 0.5, height: 1},
        });
        expect(layoutForViewEvent(r.events[1], PRESETS)).toEqual({
            mainView: {left: 0, top: 0, width: 1, height: 1},
        });
        expect(layoutForViewEvent(null, PRESETS)).toBeNull();
        // preset vanished (e.g. different sitch) → null, caller falls back
        expect(layoutForViewEvent(r.events[0], {})).toBeNull();
    });
});

describe("assume last target", () => {
    test("sugar lines omitting the target reuse the previous one", async () => {
        const r = await run(["zoom OE-LNC 5", "orbit 6 180", "track 4", "rise 3 800"]);
        expect(r.errors).toEqual([]);
        expect(r.events.map(e => [e.type, e.target])).toEqual([
            ["zoom", "OE-LNC"], ["orbit", "OE-LNC"], ["track", "OE-LNC"], ["rise", "OE-LNC"],
        ]);
        expect(r.events[1].degrees).toBe(180);
        expect(r.events[3].meters).toBe(800);
    });

    test("JS calls omitting the target reuse the previous one", async () => {
        const r = await run(['await zoom("N123AB", 5);', "await orbit(6, 180);"]);
        expect(r.errors).toEqual([]);
        expect(r.events[1].target).toBe("N123AB");
    });

    test("flyto neither uses nor clobbers the remembered target", async () => {
        const r = await run(["zoom A 5", "flyto look 2", "track 4"]);
        expect(r.errors).toEqual([]);
        expect(r.events[2].target).toBe("A");
    });

    test("omitting the target with no previous one is an error", async () => {
        const r = await run("orbit 6");
        expect(r.errors[0]).toMatch(/missing <target>/);
        expect(r.events).toEqual([]);
    });

    test("wheel-edit spans still line up when the target is omitted", async () => {
        const r = await run(["zoom A 5", "orbit 6 180"]);
        expect(r.events[1].spans.dur).toEqual({start: 6, end: 7});
        expect(r.events[1].spans.deg).toEqual({start: 8, end: 11});
    });
});

describe("default durations and defaulted names", () => {
    test("every command works bare or with just a target", async () => {
        const r = await run(["zoom A", "orbit", "track", "rise", "wait", "flyto"]);
        expect(r.errors).toEqual([]);
        expect(r.events.map(e => [e.type, e.target ?? null, e.dur])).toEqual([
            ["zoom", "A", 5],
            ["orbit", "A", 8],
            ["track", "A", 5],
            ["rise", "A", 4],
            ["wait", null, 1],
            ["flyto", "look", 0],
        ]);
        expect(r.totalDuration).toBe(23);
    });

    test("flyto 3 assumes the look target; text 4 is a blank 4s caption slot", async () => {
        const r = await run(["flyto 3", "text 4"]);
        expect(r.errors).toEqual([]);
        expect([r.events[0].target, r.events[0].dur]).toEqual(["look", 3]);
        expect([r.events[1].text, r.events[1].dur]).toEqual(["", 4]);
    });

    test("flyto 3 keeps its duration wheel-editable (span shifts with the omitted name)", async () => {
        const r = await run("flyto 3");
        expect(r.events[0].spans.dur).toEqual({start: 6, end: 7});
    });
});

describe("set / show / hide / on / off", () => {
    test("set with two args is a menu-less scan; value keeps its type", async () => {
        const r = await run('set "Constellation Lines" false');
        expect(r.errors).toEqual([]);
        const e = r.events[0];
        expect([e.type, e.menu, e.path, e.value, e.dur]).toEqual(["set", null, "Constellation Lines", false, 0]);
    });

    test("set with three args targets a specific menu", async () => {
        const r = await run('set showhide "Constellation Lines" true');
        const e = r.events[0];
        expect([e.menu, e.path, e.value]).toEqual(["showhide", "Constellation Lines", true]);
    });

    test("numeric and option-string values work (JS form)", async () => {
        const r = await run(['set("Star Brightness", 2);', 'set("nightsky", "Constellation Style", "dashed");'].join("\n"));
        expect(r.errors).toEqual([]);
        expect(r.events[0].value).toBe(2);
        expect(r.events[1].value).toBe("dashed");
    });

    test("show/hide and the on/off aliases map to boolean sets", async () => {
        const r = await run([
            'show "Constellation Lines"',
            'hide "Stars"',
            'on "Satellites"',
            'off "Labels"',
        ]);
        expect(r.errors).toEqual([]);
        expect(r.events.map(e => [e.type, e.path, e.value])).toEqual([
            ["show", "Constellation Lines", true],
            ["hide", "Stars", false],
            ["show", "Satellites", true],
            ["hide", "Labels", false],
        ]);
        for (const e of r.events) expect(e.menu).toBeNull();
    });

    test("set events take their place on the virtual clock", async () => {
        const r = await run(['await wait(3);', 'hide("Constellation Lines");'].join("\n"));
        expect(r.events[1].start).toBe(3);
    });

    test("a non-scalar value is rejected with the line", async () => {
        const r = await run('set("flag", [1, 2]);');
        expect(r.errors[0]).toMatch(/^line 1: .*true\/false/);
        expect(r.events).toEqual([]);
    });
});

describe("activeViewAt", () => {
    test("returns the last view cut at or before t", async () => {
        const r = await run(["view main", "wait 5", "view look", "wait 5"]);
        expect(activeViewAt(r.events, "main", 0)).toBe("main");
        expect(activeViewAt(r.events, "main", 4.9)).toBe("main");
        expect(activeViewAt(r.events, "main", 5.1)).toBe("look");
    });

    test("falls back to the default view with no cuts", async () => {
        const r = await run("wait 5");
        expect(activeViewAt(r.events, "main", 2)).toBe("main");
    });
});
