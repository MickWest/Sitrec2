// Keeps the Sitrec > Extra Tools menu in step with the public tools.
//
// A public tool is one with a card on the Tools index page, tools/index.html. The menu is
// built from src/extraTools.js. Nothing at runtime notices when the two disagree: a new
// tool is just missing from the menu, and a removed one leaves a menu link that 404s.
// So this test compares them.
//
// When it fails: add (or remove) the entry in src/extraTools.js AND its label and tooltip
// under menus.main.extraTools.tools in src/i18n/en.js.

import fs from "fs";
import path from "path";
import {EXTRA_TOOLS} from "../src/extraTools";
import en from "../src/i18n/en";

const TOOLS_DIR = path.resolve(__dirname, "..", "tools");

// The main link on each tool card of tools/index.html, relative to tools/. A card's main
// link is its first <a> with an href and nothing else; the secondary links on a card
// (sample files, external sites) carry a class. A directory link ("psf/") becomes the page
// it serves ("psf/index.html"), which is how the menu names it.
function toolPathsOnIndexPage() {
    const html = fs.readFileSync(path.join(TOOLS_DIR, "index.html"), "utf8");
    const cards = html.split('<div class="tool">').slice(1);
    return cards.map((card, i) => {
        const link = card.match(/<a href="([^"]+)">/);
        if (!link) throw new Error(`Tool card ${i + 1} on tools/index.html has no main link`);
        return link[1].endsWith("/") ? link[1] + "index.html" : link[1];
    });
}

describe("Extra Tools menu", () => {
    test("lists exactly the tools that have a card on tools/index.html", () => {
        const onIndexPage = toolPathsOnIndexPage().sort();
        const inMenu = EXTRA_TOOLS.map(tool => tool.path).sort();
        expect(inMenu).toEqual(onIndexPage);
    });

    test("has no duplicate keys or paths", () => {
        expect(new Set(EXTRA_TOOLS.map(tool => tool.key)).size).toBe(EXTRA_TOOLS.length);
        expect(new Set(EXTRA_TOOLS.map(tool => tool.path)).size).toBe(EXTRA_TOOLS.length);
    });

    test.each(EXTRA_TOOLS.map(tool => [tool.key, tool]))("%s links to a page that exists", (key, tool) => {
        expect(fs.existsSync(path.join(TOOLS_DIR, tool.path))).toBe(true);
    });

    test.each(EXTRA_TOOLS.map(tool => [tool.key, tool]))("%s has a label and a tooltip", (key, tool) => {
        const strings = en.menus.main.extraTools.tools[tool.key];
        expect(typeof strings?.label).toBe("string");
        expect(typeof strings?.tooltip).toBe("string");
    });

    // A perBuild tool is served from its build's own directory by docker/frontend_server.py,
    // which serves files only: it has no directory index, so a link to "rate/" or "../" is a
    // 404 there even though the same link works on the main site. Every link between the
    // pages of such a tool must name the page.
    test.each(EXTRA_TOOLS.filter(tool => tool.perBuild).map(tool => [tool.key, tool]))(
        "%s (served per build) has no link to a bare directory", (key, tool) => {
            const toolDir = path.join(TOOLS_DIR, path.dirname(tool.path));
            const bare = [];
            const scan = dir => {
                for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (entry.name !== "lib" && entry.name !== "tools") scan(full);
                        continue;
                    }
                    if (!/\.(html|js)$/.test(entry.name)) continue;
                    const text = fs.readFileSync(full, "utf8");
                    // href="..." in markup, and .href = `...` / "..." / '...' in script. A link
                    // with a scheme, or to another site ("//host/"), is not one of ours.
                    for (const match of text.matchAll(/href\s*=\s*["'`]([^"'`#?]*)/g)) {
                        const target = match[1];
                        if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(target) || target.includes("${")) continue;
                        if (target === "." || target === ".." || target.endsWith("/")) {
                            bare.push(`${path.relative(TOOLS_DIR, full)}: href="${target}"`);
                        }
                    }
                }
            };
            scan(toolDir);
            expect(bare).toEqual([]);
        });

    test("has no strings left over for a removed tool", () => {
        const keys = EXTRA_TOOLS.map(tool => tool.key).sort();
        expect(Object.keys(en.menus.main.extraTools.tools).sort()).toEqual(keys);
    });
});
