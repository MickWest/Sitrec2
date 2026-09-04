// Guards the documentation registry against the failure modes that have actually
// happened in this repo:
//
//   - a registry entry naming a file that does not exist (the original bug the registry
//     was created to prevent — the AI's doc list named "SavingLoadingSharing" and
//     "ObjectTracking", neither of which was a real file, so getHelpDoc errored
//     mid-conversation)
//   - a labelKey with no matching string, which renders the raw key in the Help menu
//   - an orphaned menus.help.documentation.* string left behind when a doc is renamed
//   - a user-facing doc on disk that nobody registered, so it is invisible in the Help
//     menu AND to the AI assistant (this had happened to eight docs, including the only
//     one explaining where to get flight data)
//   - an AI-facing doc growing past chatbot.php's truncation limit, which is silent:
//     the model is not told the rest of the document exists.
//
// None of these throw at runtime. All of them degrade the docs invisibly, which is why
// they need a test rather than care.

import fs from "fs";
import path from "path";
import {AI_DOC_CHAR_LIMIT, chatDocName, DOC_SECTIONS, getChatAvailableDocs, helpDocs} from "../src/docsRegistry";
import en from "../src/i18n/en";

const REPO_ROOT = path.resolve(__dirname, "..");
const DOCS_DIR = path.join(REPO_ROOT, "docs");

function lookupKey(key) {
    return key.split(".").reduce((v, part) => (v === undefined ? undefined : v[part]), en);
}

// Path on disk for a registry `file` ("docs/Foo" -> docs/Foo.md, "README" -> README.md).
function docPath(file) {
    return path.join(REPO_ROOT, file + ".md");
}

describe("docsRegistry entries", () => {
    test.each(helpDocs.map(d => [d.file, d]))("%s resolves to a real markdown file", (file, d) => {
        expect(fs.existsSync(docPath(d.file))).toBe(true);
    });

    test.each(helpDocs.map(d => [d.file, d]))("%s has a label key that resolves", (file, d) => {
        expect(typeof lookupKey(d.labelKey)).toBe("string");
    });

    // A doc may deliberately have no section, which keeps it out of the Help menu (the
    // bespoke case studies). It then has to be reachable some other way — README.md
    // plus the AI assistant — or nobody can ever see it, which is the failure this
    // whole file exists to catch.
    test.each(helpDocs.map(d => [d.file, d]))("%s is in a known section, or deliberately out of the menu", (file, d) => {
        if (d.section === undefined) {
            expect(typeof d.chatDesc).toBe("string");
            return;
        }
        expect(DOC_SECTIONS.map(s => s.id)).toContain(d.section);
    });

    test.each(helpDocs.map(d => [d.file, d]))("%s declares a known role", (file, d) => {
        expect(["tutorial", "reference", "methodology", "case-study"]).toContain(d.role);
    });

    test("section labels all resolve", () => {
        for (const s of DOC_SECTIONS) {
            expect(typeof lookupKey(s.labelKey)).toBe("string");
        }
    });

    test("no duplicate files", () => {
        const files = helpDocs.map(d => d.file);
        expect(files.length).toBe(new Set(files).size);
    });

    test("no duplicate label keys", () => {
        const keys = helpDocs.map(d => d.labelKey);
        expect(keys.length).toBe(new Set(keys).size);
    });
});

describe("AI assistant doc list", () => {
    // getHelpDoc validates the name against /^[A-Za-z0-9_-]+$/ and then reads
    // docs/<name>.md. Anything that fails either check is offered to the model and then
    // errors when it asks for it — which is worse than not offering it at all.
    const aiDocs = helpDocs.filter(d => d.chatDesc);

    test.each(aiDocs.map(d => [d.file, d]))("%s produces a name chatbot.php will accept", (file, d) => {
        expect(chatDocName(d.file)).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    test.each(aiDocs.map(d => [d.file, d]))("%s resolves under docs/ as getHelpDoc reads it", (file, d) => {
        expect(fs.existsSync(path.join(DOCS_DIR, chatDocName(d.file) + ".md"))).toBe(true);
    });

    // A doc past the limit is cut off mid-document. chatbot.php appends a notice so the
    // model knows to flag an incomplete answer, but it still cannot see what was removed.
    // Only the changelog is allowed to exceed the limit, and only because it is strictly
    // newest-first (see the note on its registry entry).
    test.each(aiDocs.filter(d => !d.aiTruncationExpected).map(d => [d.file, d]))(
        "%s fits within the truncation limit", (file, d) => {
            const size = fs.statSync(docPath(d.file)).size;
            expect(size).toBeLessThanOrEqual(AI_DOC_CHAR_LIMIT);
        });

    test("only deliberately-newest-first docs are allowed to exceed the limit", () => {
        const exempt = aiDocs.filter(d => d.aiTruncationExpected).map(d => d.file);
        expect(exempt).toEqual(["docs/WhatsNew"]);
    });

    test("every offered doc has a non-trivial description", () => {
        for (const [name, desc] of Object.entries(getChatAvailableDocs())) {
            expect(typeof desc).toBe("string");
            expect(desc.length).toBeGreaterThan(40);   // a bare title is not a description
        }
    });
});

describe("i18n help strings", () => {
    test("no orphaned menus.help.documentation.* doc labels", () => {
        const used = new Set([
            ...helpDocs.map(d => d.labelKey),
            ...DOC_SECTIONS.map(s => s.labelKey),
            // Non-doc strings used directly by src/index.js.
            "menus.help.documentation.title",
            "menus.help.documentation.localTooltip",
            "menus.help.documentation.githubTooltip",
            "menus.help.documentation.githubLinkLabel",
            "menus.help.documentation.thirdPartyNotices",
            "menus.help.documentation.thirdPartyNoticesTooltip",
            "menus.help.documentation.downloadBridge",
            "menus.help.documentation.downloadBridgeTooltip",
            "menus.help.documentation.menuHelpTitle",
            "menus.help.documentation.menuHelpTooltip",
        ]);

        const orphans = [];
        const walk = (obj, prefix) => {
            for (const [k, v] of Object.entries(obj)) {
                const key = `${prefix}.${k}`;
                if (typeof v === "string") {
                    if (!used.has(key)) orphans.push(key);
                } else if (v && typeof v === "object") {
                    walk(v, key);
                }
            }
        };
        walk(en.menus.help.documentation, "menus.help.documentation");

        expect(orphans).toEqual([]);
    });
});

describe("docs on disk", () => {
    // Everything reachable by the docs walk in webpack.common.js is PUBLISHED — as
    // rendered .html, as raw .md (which is what the AI assistant reads), and, for
    // non-markdown files, verbatim. So the question these tests answer is not "is this
    // doc in the Help menu" but "is anyone allowed to see this at all".
    //
    // Plans, roadmaps, review reports and other agent-facing working documents must not
    // be under docs/ AT ALL. They live in private/notes/, in the nested private repo, outside
    // docs/ and gitignored. docs/plans/ used to exist and every file in it shipped, which is the
    // failure these tests are shaped around.

    // Mirrors the walk in webpack.common.js: skip docs/temp, skip dot-entries. If that
    // walk's skip rules change, change these too or the tests stop describing reality.
    const SKIP_DIRS = new Set(["temp"]);

    function publishedDocs(dir = DOCS_DIR, prefix = "") {
        const out = [];
        for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
            if (e.name.startsWith(".")) continue;
            const rel = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue;
                out.push(...publishedDocs(path.join(dir, e.name), rel));
            } else if (e.name.endsWith(".md")) {
                out.push(rel);
            }
        }
        return out;
    }

    // Top-level docs deliberately NOT in the Help menu: engineering references and
    // *-Internals docs linked from their user doc. Not a parking spot for working notes.
    const INTENTIONALLY_UNREGISTERED = new Set([
        "FitPointsAPI",          // API reference for agents driving the MCP bridge
        "TransitionToECEF",      // coordinate-frame reference, cited from CLAUDE.md
        "Wind-Internals",        // internals reference linked from Wind.md
        "UserDataEgressCheck",   // developer reference for the per-push egress check, linked from README
    ]);

    // Docs in subdirectories of docs/. These are never in the Help menu, so the registry
    // cannot vouch for them and the top-level test below cannot see them. This is the
    // complete inventory, listed by path: a NEW nested file fails until someone adds it
    // here, which is the point — that decision is exactly the one that was skipped when
    // docs/plans/ filled up with published plans.
    const NESTED_DOCS = new Set([
        "dev/ADDING_NEW_SETTINGS.md",       // how to add a user setting
        "dev/AddSitchInCode.md",            // legacy in-code sitch authoring
        "dev/Container-Security-Review.md", // the automated container image review
        "dev/SecurityRequirements.md",      // what the project holds itself to, and how each is verified
        "dev/VulnerabilityHandling.md",     // triage, root cause and response times
        "dev/CustomTerrainSources.md",      // map/elevation source configuration
        "dev/Deploying-on-a-VPS.md",        // VPS deployment with Podman and Caddy
        "dev/Deploying-on-GitHub-Pages.md", // the serverless build on GitHub Pages
        "dev/FileRehosting.md",             // rehosting + server auth
        "dev/Installing-and-configuring.md",// install guide
        "dev/Secure-Build.md",              // the secure build: outbound features removed at compile time
        "dev/Installing-Hardened-Sitrec-on-AWS.md", // the secure build on AWS: load balancer, client certificates, private bucket
        "dev/SettingsManager.md",           // settings architecture
        "dev/dynamic-gui-mirroring.md",     // CustomManagerMirror API
        "dev/k8s-example/README.md",        // Kubernetes example manifests
        "dev/misb-timing.md",               // MISB/KLV timing reference
    ]);

    test("every user-facing doc is registered", () => {
        const registered = new Set(helpDocs.map(d => chatDocName(d.file)));
        const unregistered = publishedDocs()
            .filter(p => !p.includes("/"))          // nested docs: see the test below
            .map(f => f.replace(/\.md$/, ""))
            .filter(n => !registered.has(n))
            .filter(n => !INTENTIONALLY_UNREGISTERED.has(n));

        // If this fires, either add the doc to src/docsRegistry.js or, if it is an
        // internal note, add it to INTENTIONALLY_UNREGISTERED above with a reason.
        // If it is a plan, roadmap or review, it belongs in private/notes/ instead.
        expect(unregistered).toEqual([]);
    });

    test("every nested doc is a known developer reference", () => {
        const unlisted = publishedDocs().filter(p => p.includes("/") && !NESTED_DOCS.has(p));

        // If this fires, a file in a docs/ subdirectory is about to be published and
        // nothing has vouched for it. If it is a plan, roadmap, review or working note,
        // move it to private/notes/. If it is a real developer reference, add it to
        // NESTED_DOCS above with a one-line description.
        expect(unlisted).toEqual([]);
    });

    test("NESTED_DOCS has no entries for files that no longer exist", () => {
        const onDisk = new Set(publishedDocs());
        expect([...NESTED_DOCS].filter(p => !onDisk.has(p))).toEqual([]);
    });
});
