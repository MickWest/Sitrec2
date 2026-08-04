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
import {helpDocs, DOC_SECTIONS, chatDocName, getChatAvailableDocs, AI_DOC_CHAR_LIMIT} from "../src/docsRegistry";
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

    test.each(helpDocs.map(d => [d.file, d]))("%s is in a known section", (file, d) => {
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
    // Anything user-facing must be registered, or it exists but cannot be found. This
    // list is the set of docs deliberately NOT in the Help menu: internal plans, review
    // reports, engineering notes, and *-Internals references linked from their user doc.
    const INTENTIONALLY_UNREGISTERED = new Set([
        "AnomalySurfacingPlan",
        "atmosphere-hillaire-exploration",
        "atmospheric-refraction-plan",
        "colorspace-fix-plan",
        "DroneControlFitReview-R1",
        "localFileSystemPlan",
        "sitrec-MCP-plan-FINAL",
        "StarTracker-PriorWork",
        "synth-objects-refactoring-plan",
        "TransitionToECEF",
        "TraverseAnalysisReview",
        "TraverseReviewResponse-2026-07-19",
        "TraverseSlowObjectReview",
        "undo-redo-plan",
        "Wind-Internals",
    ]);

    test("every user-facing doc is registered", () => {
        const registered = new Set(helpDocs.map(d => chatDocName(d.file)));
        const unregistered = fs.readdirSync(DOCS_DIR)
            .filter(f => f.endsWith(".md"))
            .map(f => f.replace(/\.md$/, ""))
            .filter(n => !registered.has(n))
            .filter(n => !INTENTIONALLY_UNREGISTERED.has(n));

        // If this fires, either add the doc to src/docsRegistry.js or, if it is an
        // internal note, add it to INTENTIONALLY_UNREGISTERED above with a reason.
        expect(unregistered).toEqual([]);
    });
});
