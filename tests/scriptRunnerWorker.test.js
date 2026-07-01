// Guarantees that make the Scripted-Video runner safe to move into a Web Worker
// (finding "B1" durable fix): the parsed model must survive structured clone
// (postMessage), the events↔cameraBeats object identity must be preserved by a
// single clone, no command may smuggle a non-cloneable value into an event, and
// the client wrapper must fall back to an in-process run where no Worker exists.

import {runScriptJS} from "../src/scriptedVideo/ScriptJSRunner";
import {runScriptViaWorker} from "../src/scriptedVideo/ScriptRunnerClient";

const DEMO = [
    "view main",
    "zoom OE-LNC 6",
    '& text "OE-LNC" 4',
    "orbit OE-LNC 9 110",
    "track OE-LNC 4",
    'set "Sun" true',
    "view look",
    "wait 2",
].join("\n");

describe("runner model is structured-clone safe (postMessage-ready)", () => {
    test("the full model round-trips through structuredClone unchanged", async () => {
        const r = await runScriptJS(DEMO);
        expect(r.errors).toEqual([]);
        // structuredClone throws DataCloneError on functions / class instances /
        // DOM nodes — so a clean round-trip proves the model is plain data.
        const clone = structuredClone(r);
        expect(clone.totalDuration).toBe(r.totalDuration);
        expect(clone.events.length).toBe(r.events.length);
        expect(clone.cameraBeats.length).toBe(r.cameraBeats.length);
    });

    test("events↔cameraBeats identity is preserved by a single clone", async () => {
        const r = await runScriptJS(DEMO);
        // Post the whole model in ONE payload — clone must dedupe shared refs so a
        // camera beat is the SAME object as its entry in events (the main thread
        // mutates events in place and reads poses back off cameraBeats).
        const clone = structuredClone({events: r.events, cameraBeats: r.cameraBeats});
        for (const beat of clone.cameraBeats) {
            expect(clone.events).toContain(beat);   // reference identity, not equality
        }
    });
});

describe("set command cannot smuggle a non-cloneable menu", () => {
    test("a function menu is rejected, not stored on the event", async () => {
        const r = await runScriptJS('set(() => {}, "Sun", true)');
        // The bad call errors out instead of producing an event with a function field.
        expect(r.errors.some((m) => /menu must be a string/i.test(m))).toBe(true);
        expect(r.events.some((e) => typeof e.menu === "function")).toBe(false);
        // And whatever model came back is still clone-safe.
        expect(() => structuredClone(r)).not.toThrow();
    });

    test("a normal set still works and is clone-safe", async () => {
        const r = await runScriptJS('set "Sun" true');
        expect(r.errors).toEqual([]);
        const setEvent = r.events.find((e) => e.type === "set");
        expect(setEvent).toBeTruthy();
        expect(setEvent.menu === null || typeof setEvent.menu === "string").toBe(true);
    });
});

describe("ScriptRunnerClient falls back in-process when no Worker exists", () => {
    // Jest's jsdom has no Worker global, so runScriptViaWorker takes the
    // in-process path and must return exactly what runScriptJS returns.
    test("worker client matches direct runScriptJS output", async () => {
        expect(typeof Worker).toBe("undefined");     // sanity: fallback path active
        const viaClient = await runScriptViaWorker(DEMO);
        const direct = await runScriptJS(DEMO);
        expect(viaClient.errors).toEqual(direct.errors);
        expect(viaClient.totalDuration).toBe(direct.totalDuration);
        expect(viaClient.events.map((e) => [e.type, e.start]))
            .toEqual(direct.events.map((e) => [e.type, e.start]));
    });
});
