// Prototype validation for the Scripted Video JS frontend's call-site capture
// (the "gnarly 30%" of wheel-editing/cross-highlighting for JS scripts).
// Node and Chrome are both V8, so what passes here holds in the browser.

import {compileScript, makeCallSiteRecorder, rawUserFrames} from "../src/scriptedVideo/ScriptJSCallSites";

// Minimal record-only run: every API call records {name, args, callSite, chain}
// and returns a thenable so `await` works. No virtual clock — this prototype
// only exercises source mapping, not scheduling.
async function record(text, names = ["zoom", "orbit", "track", "text", "view", "sleep"]) {
    const rec = makeCallSiteRecorder();
    const events = [];
    const api = names.map((name) => (...args) => {
        const {callSite, chain} = rec.capture();
        events.push({name, args, callSite, chain});
        return {then: (resolve) => resolve(undefined)};
    });
    const fn = compileScript(text, names);
    await fn(rec.probe, ...api);
    return events;
}

// what the source at a captured position looks like (1-based line/col)
function sourceAt(text, site) {
    return text.split("\n")[site.line - 1].slice(site.col - 1);
}

describe("rawUserFrames", () => {
    test("extracts <anonymous>:line:col frames, ignores real-file frames", () => {
        const stack = [
            "Error",
            "    at capture (/repo/src/scriptedVideo/ScriptJSCallSites.js:55:30)",
            "    at eval (eval at <anonymous> (/repo/src/x.js:1:2), <anonymous>:5:11)",
            "    at async <anonymous>:7:1",
            "    at Object.<anonymous> (/repo/tests/foo.test.js:10:5)",
        ].join("\n");
        expect(rawUserFrames(stack)).toEqual([{line: 5, col: 11}, {line: 7, col: 1}]);
    });

    test("returns [] for non-V8 (Safari/Firefox) stack formats", () => {
        expect(rawUserFrames("zoom@https://x/y.js:5:11\nglobal code@https://x/y.js:9:1")).toEqual([]);
        expect(rawUserFrames(undefined)).toEqual([]);
    });
});

describe("call-site capture through new AsyncFunction", () => {
    test("top-level calls map to their exact line, column points at the callee", async () => {
        const text = 'view("main");\nconst z = zoom("OE-LNC", 6);';
        const ev = await record(text);
        expect(ev.map((e) => e.name)).toEqual(["view", "zoom"]);
        expect(ev[0].callSite.line).toBe(1);
        expect(sourceAt(text, ev[0].callSite)).toMatch(/^view\(/);
        expect(ev[1].callSite.line).toBe(2);
        expect(sourceAt(text, ev[1].callSite)).toMatch(/^zoom\(/);
    });

    test("calls after await (resumed async frames) still capture", async () => {
        const text = [
            'const z = zoom("A", 6);',
            "await sleep(1);",
            'text("inbound", 4);',
            "await z;",
            'await orbit("A", 9, 110);',
        ].join("\n");
        const ev = await record(text);
        expect(ev.map((e) => e.name)).toEqual(["zoom", "sleep", "text", "orbit"]);
        expect(ev[2].callSite.line).toBe(3);
        expect(sourceAt(text, ev[2].callSite)).toMatch(/^text\(/);
        expect(ev[3].callSite.line).toBe(5);
        expect(sourceAt(text, ev[3].callSite)).toMatch(/^orbit\(/);
    });

    test("a call inside a loop yields one event per iteration, all sharing the call site", async () => {
        const text = ['for (const t of ["A", "B", "C"]) {', "    await zoom(t, 5);", "}"].join("\n");
        const ev = await record(text);
        expect(ev).toHaveLength(3);
        expect(ev.map((e) => e.args[0])).toEqual(["A", "B", "C"]);
        for (const e of ev) {
            expect(e.callSite.line).toBe(2);
            expect(sourceAt(text, e.callSite)).toMatch(/^zoom\(/);
        }
    });

    test("a call inside a user helper carries the invocation site in its chain", async () => {
        const text = [
            "async function shot(t) {",
            "    await zoom(t, 5);",
            "}",
            'await shot("A");',
            'await shot("B");',
        ].join("\n");
        const ev = await record(text);
        expect(ev).toHaveLength(2);
        // nearest frame = the zoom() literal's home, next = the shot() invocation
        expect(ev[0].callSite.line).toBe(2);
        expect(ev[0].chain[1].line).toBe(4);
        expect(ev[1].callSite.line).toBe(2);
        expect(ev[1].chain[1].line).toBe(5);
    });

    test("two calls on one line get distinct columns", async () => {
        const text = 'zoom("A", 5); orbit("A", 8, 120);';
        const ev = await record(text);
        expect(ev[0].callSite.line).toBe(1);
        expect(ev[1].callSite.line).toBe(1);
        expect(ev[1].callSite.col).toBeGreaterThan(ev[0].callSite.col);
        expect(sourceAt(text, ev[1].callSite)).toMatch(/^orbit\(/);
    });

    test("comments and strings mentioning commands don't confuse capture (it's stack-based)", async () => {
        const text = ['// zoom("FAKE", 99)', 'text("call zoom(x, 1) now", 3);', 'zoom("REAL", 6);'].join("\n");
        const ev = await record(text);
        expect(ev.map((e) => e.name)).toEqual(["text", "zoom"]);
        expect(ev[1].callSite.line).toBe(3);
        expect(ev[1].args[0]).toBe("REAL");
    });

    test("syntax errors throw at compile time, before any event is recorded", () => {
        expect(() => compileScript('zoom("A", 6;', ["zoom"])).toThrow(SyntaxError);
    });

    test("calibration failure (non-V8 probe) degrades to null call sites, events still record", async () => {
        // simulate a foreign engine by breaking the recorder's calibration
        const rec = makeCallSiteRecorder();
        const events = [];
        const zoom = (...args) => {
            const {callSite, chain} = rec.capture();
            events.push({name: "zoom", args, callSite, chain});
            return {then: (r) => r(undefined)};
        };
        const fn = compileScript('zoom("A", 6);', ["zoom"]);
        await fn(() => {/* probe never calibrates */}, zoom);
        expect(events).toHaveLength(1);
        expect(events[0].callSite).toBeNull();
        expect(events[0].chain).toEqual([]);
    });
});
