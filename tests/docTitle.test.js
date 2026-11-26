// docPageTitle gives the <title> text of each doc page that webpack.common.js renders
// from docs/*.md and README.md. The title comes from the first level-1 heading of the
// Markdown source. It does not go through the Markdown renderer, so it must be escaped:
// before the escape, a heading with markup in it put that markup into the head of the
// published page.

const fs = require("fs");
const path = require("path");
const {docPageTitle, escapeHtml} = require("../scripts/docTitle");

// The same template that webpack.common.js writes.
const head = title => `<head>\n    <title>${title}</title>\n</head>`;

describe("docPageTitle", () => {
    test("uses the first level-1 heading", () => {
        expect(docPageTitle("# Camera Tracks\n\nText.\n\n# A later heading\n", "file")).toBe("Camera Tracks");
        expect(docPageTitle("Intro line.\n\n## Not this one\n\n# This One\n", "file")).toBe("This One");
    });

    test("uses the fallback when there is no level-1 heading", () => {
        expect(docPageTitle("## Only a level-2 heading\n\nText.\n", "AddSitchInCode")).toBe("AddSitchInCode");
        expect(docPageTitle("", "README")).toBe("README");
    });

    test("leaves a plain heading unchanged", () => {
        expect(docPageTitle("# Starlink Horizon Flares — how they work (2026)\n", "x"))
            .toBe("Starlink Horizon Flares — how they work (2026)");
    });

    test.each([
        ["# MISB Timing & Sync", "MISB Timing &amp; Sync"],
        ['# Nimitz "Tic Tac" Encounter', "Nimitz &quot;Tic Tac&quot; Encounter"],
        ["# What's New in Sitrec", "What&#39;s New in Sitrec"],
        ["# The <canvas> element", "The &lt;canvas&gt; element"],
        ["# a < b && b > c", "a &lt; b &amp;&amp; b &gt; c"],
    ])("escapes %s", (markdown, expected) => {
        expect(docPageTitle(markdown + "\n", "x")).toBe(expected);
    });

    test("escapes the fallback too", () => {
        expect(docPageTitle("no heading", "Q&A <draft>")).toBe("Q&amp;A &lt;draft&gt;");
    });

    test("a heading with a script element cannot end the title or add an element", () => {
        const title = docPageTitle("# Notes</title><script>alert(1)</script><title>x\n", "x");
        expect(title).not.toMatch(/[<>]/);
        const html = head(title);
        expect(html.match(/<title>/g)).toHaveLength(1);
        expect(html.match(/<\/title>/g)).toHaveLength(1);
        expect(html).not.toMatch(/<script/i);
        expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    });

    test("an escaped ampersand in the source is not turned back into markup", () => {
        // "&lt;script&gt;" in the source must stay text after a browser decodes the title once.
        expect(docPageTitle("# &lt;script&gt;\n", "x")).toBe("&amp;lt;script&amp;gt;");
    });
});

describe("escapeHtml", () => {
    test("escapes the five characters and nothing else", () => {
        expect(escapeHtml(`<a href="x" title='y'>&</a>`))
            .toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
        expect(escapeHtml("Plain text, 100% — ok.")).toBe("Plain text, 100% — ok.");
    });
});

describe("the doc page templates in webpack.common.js", () => {
    // Jest cannot load webpack.common.js (it reads the environment file and runs the
    // build checks), so this reads its text: each page title must come from docPageTitle.
    const source = fs.readFileSync(path.join(__dirname, "..", "webpack.common.js"), "utf8");

    test("every <title> it writes takes its text from docPageTitle", () => {
        const templates = source.match(/<title>\$\{title\}<\/title>/g) || [];
        expect(templates).toHaveLength(2); // each docs page, and README.html
        expect(source.match(/<title>/g)).toHaveLength(templates.length);
        expect(source.match(/const title = docPageTitle\(/g) || []).toHaveLength(templates.length);
        expect(source.match(/const title\b/g)).toHaveLength(templates.length);
    });
});
