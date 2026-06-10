import {desugarScript, tokenizeWithPos} from "../src/scriptedVideo/ScriptSugar";

describe("tokenizeWithPos", () => {
    test("splits on whitespace with character spans", () => {
        const t = tokenizeWithPos("zoom OE-LNC 6");
        expect(t.map(x => x.text)).toEqual(["zoom", "OE-LNC", "6"]);
        expect(t[2]).toEqual({text: "6", start: 12, end: 13, quoted: false});
    });

    test("treats quoted strings as one token (span includes the quotes)", () => {
        const t = tokenizeWithPos('text "two words" 3');
        expect(t.map(x => x.text)).toEqual(["text", "two words", "3"]);
        expect(t[1].start).toBe(5);
        expect(t[1].end).toBe(16);
        expect(t[1].quoted).toBe(true);
    });
});

describe("desugarScript — line rewriting", () => {
    test("a plain command line becomes a spine assignment + await", () => {
        const {code} = desugarScript("zoom OE-LNC 6");
        expect(code).toBe('__sp = zoom("OE-LNC", 6); await __sp;');
    });

    test("& and &N lines become atStart calls on the spine handle", () => {
        const {code} = desugarScript(['& text "cap" 4', "&2 wait 1"].join("\n"));
        expect(code.split("\n")).toEqual([
            'atStart(__sp, 0, () => text("cap", 4));',
            "atStart(__sp, 2, () => wait(1));",
        ]);
    });

    test("# comments become // comments; blank lines pass through", () => {
        const {code} = desugarScript(["# hello", ""].join("\n"));
        expect(code.split("\n")).toEqual(["// hello", ""]);
    });

    test("trailing # comments are stripped from sugar lines (not inside quotes)", () => {
        const {code} = desugarScript(['wait 2 # hold', 'text "Flight #2" 4'].join("\n"));
        const lines = code.split("\n");
        expect(lines[0]).toBe("__sp = wait(2); await __sp;");
        expect(lines[1]).toBe('__sp = text("Flight #2", 4); await __sp;');
    });

    test("line count is always preserved", () => {
        const src = ["view main", "", "const x = 1;", "zoom A 6", "# done"].join("\n");
        const {code, lineInfo} = desugarScript(src);
        expect(code.split("\n")).toHaveLength(5);
        expect(lineInfo).toHaveLength(5);
    });

    test("title alias rewrites to the canonical text command", () => {
        const {code} = desugarScript('title "hello" 2');
        expect(code).toBe('__sp = text("hello", 2); await __sp;');
    });

    test("true/false stay boolean literals; on/off alias to show/hide", () => {
        const {code} = desugarScript([
            'set "Constellation Lines" false',
            'on "Satellites"',
            'off "Labels"',
        ].join("\n"));
        expect(code.split("\n")).toEqual([
            '__sp = set("Constellation Lines", false); await __sp;',
            '__sp = show("Satellites"); await __sp;',
            '__sp = hide("Labels"); await __sp;',
        ]);
    });
});

describe("desugarScript — JS lines pass through untouched", () => {
    test("ordinary JS is untouched", () => {
        const src = ['const z = zoom("A", 6);', "await z;", "for (const t of xs) { await orbit(t, 8); }"].join("\n");
        expect(desugarScript(src).code).toBe(src);
    });

    test("a command word used as JS is untouched (operator tokens)", () => {
        const src = "view = 3;";
        expect(desugarScript(src).code).toBe(src);
    });

    test("DSL-looking lines inside a template literal are untouched", () => {
        const src = ["const s = `", "zoom A 6", "`;"].join("\n");
        expect(desugarScript(src).code).toBe(src);
    });

    test("DSL-looking lines inside a block comment are untouched", () => {
        const src = ["/*", "zoom A 6", "*/"].join("\n");
        expect(desugarScript(src).code).toBe(src);
    });

    test("DSL-looking lines inside unclosed brackets are untouched", () => {
        const src = ["all(", '  zoom("A", 5),', '  orbit("A", 8)', ")"].join("\n");
        expect(desugarScript(src).code).toBe(src);
    });
});

describe("desugarScript — wheel-edit spans", () => {
    test("number spans are recorded by role in original-line coordinates", () => {
        const {lineInfo} = desugarScript("zoom OE-LNC 6 250");
        expect(lineInfo[0].spans.dur).toEqual({start: 12, end: 13});
        expect(lineInfo[0].spans.dist).toEqual({start: 14, end: 17});
    });

    test("fov records fov + dur spans", () => {
        const {lineInfo} = desugarScript("fov 500 2");
        expect(lineInfo[0].spans.fov).toEqual({start: 4, end: 7});
        expect(lineInfo[0].spans.dur).toEqual({start: 8, end: 9});
    });

    test("&N records the offset number's span", () => {
        const {lineInfo} = desugarScript("&2 wait 1");
        expect(lineInfo[0].offSpan).toEqual({start: 1, end: 2});
        expect(lineInfo[0].spans.dur).toEqual({start: 8, end: 9});
    });

    test("a malformed number like 4hen gets no span (not wheel-editable)", () => {
        const {lineInfo} = desugarScript("wait 4hen");
        expect(lineInfo[0].spans.dur).toBeUndefined();
    });
});
