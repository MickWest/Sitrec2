import {
    buildScriptSnippet,
    deleteLine,
    duplicateLine,
    ensureAmpOffsetSpan,
    insertLineAfter,
    replaceNumberSpan,
    scriptToken,
} from "../src/scriptedVideo/ScriptAuthoring";

describe("ScriptAuthoring snippets", () => {
    test("quotes only when a token needs it", () => {
        expect(scriptToken("OE-LNC")).toBe("OE-LNC");
        expect(scriptToken("Side By Side")).toBe('"Side By Side"');
    });

    test("builds readable DSL command lines", () => {
        expect(buildScriptSnippet("text", {caption: "Hello there", duration: 4})).toBe('text "Hello there" 4');
        expect(buildScriptSnippet("zoom", {target: "OE-LNC", duration: 6, distance: 300})).toBe("zoom OE-LNC 6 300");
        expect(buildScriptSnippet("orbit", {target: "A", duration: 3.5, degrees: 180})).toBe("orbit A 3.5 180");
        expect(buildScriptSnippet("set", {control: "Constellation Lines", value: false})).toBe('set "Constellation Lines" false');
    });
});

describe("ScriptAuthoring line edits", () => {
    test("inserts, duplicates, and deletes lines", () => {
        const src = ["view main", "wait 2"].join("\n");
        const inserted = insertLineAfter(src, 0, 'text "cap" 3');
        expect(inserted.split("\n")).toEqual(["view main", 'text "cap" 3', "wait 2"]);
        expect(duplicateLine(inserted, 1).split("\n")).toEqual(["view main", 'text "cap" 3', 'text "cap" 3', "wait 2"]);
        expect(deleteLine(inserted, 1).split("\n")).toEqual(["view main", "wait 2"]);
    });

    test("replaces numeric spans and creates missing amp offsets", () => {
        const src = '& text "cap" 3';
        const ensured = ensureAmpOffsetSpan(src, 0);
        expect(ensured.text).toBe('&0 text "cap" 3');
        const moved = replaceNumberSpan(ensured.text, 0, ensured.span, 2.5);
        expect(moved.text).toBe('&2.5 text "cap" 3');
        const resized = replaceNumberSpan(moved.text, 0, {start: 16, end: 17}, 4.2, {min: 0.1});
        expect(resized.text).toBe('&2.5 text "cap" 4.2');
    });
});
