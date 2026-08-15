// Guards the traverse-fit test group (scripts/fitTests.js).
//
// The dangerous failure mode here is not "a suite runs twice" — it is a suite that runs
// NOWHERE. `npm run test-nofits` excludes by regex and `npm run test-fits` includes by exact
// path, so if a file is renamed the exclusion silently stops matching while the inclusion
// silently points at nothing, and BOTH commands still exit 0. Nobody notices until the fitting
// code breaks in production. These assertions make a rename fail loudly instead.

import fs from "fs";
import path from "path";
import {FIT_TESTS, FIT_TEST_IGNORE_PATTERN, FIT_SOURCES, touchesFitCode}
    from "../scripts/fitTests";

const repoRoot = path.resolve(__dirname, "..");

describe("traverse-fit test group", () => {
    // FIRST, because everything below loops over these lists and an empty list would make every
    // one of those loops pass while asserting nothing. That is not hypothetical: the first
    // version of this file imported scripts/fitTests.mjs, and the Jest config maps EVERY ".mjs"
    // to the Three.js addons stub, so the lists arrived undefined and three of the four tests
    // below passed vacuously.
    test("the lists are non-empty and actually imported", () => {
        expect(Array.isArray(FIT_TESTS)).toBe(true);
        expect(FIT_TESTS.length).toBeGreaterThan(0);
        expect(FIT_SOURCES.length).toBeGreaterThan(0);
        expect(typeof touchesFitCode).toBe("function");
        expect(typeof FIT_TEST_IGNORE_PATTERN).toBe("string");
    });

    test("every listed fit suite exists", () => {
        for (const p of FIT_TESTS) {
            expect(fs.existsSync(path.join(repoRoot, p))).toBe(true);
        }
    });

    test("every listed source path exists", () => {
        // Sources are prefixes ("src/Traverse" covers TraverseAnalysis.js, TraverseBattery.js,
        // ...), so check that each prefix still matches at least one real file rather than
        // requiring an exact path. A prefix matching nothing is a rename that has quietly
        // stopped triggering the suites it was meant to guard.
        for (const src of FIT_SOURCES) {
            if (FIT_TESTS.includes(src)) continue;          // covered by the test above
            const dir = path.join(repoRoot, path.dirname(src));
            const prefix = path.basename(src);
            const matched = fs.existsSync(path.join(repoRoot, src))
                || (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith(prefix)));
            expect(matched).toBe(true);
        }
    });

    test("the ignore pattern matches exactly the listed suites, and nothing else in tests/", () => {
        const rx = new RegExp(FIT_TEST_IGNORE_PATTERN);
        for (const p of FIT_TESTS) expect(rx.test(`/${p}`)).toBe(true);

        // Walk the real tree: any OTHER test file the pattern catches would be silently dropped
        // from both runs. This is what stops a well-meant broadening of the regex (say
        // "TraverseAnalysis" without the anchor) from swallowing TraverseAnalysisCache.
        const walk = (d) => fs.readdirSync(d, {withFileTypes: true}).flatMap((e) =>
            e.isDirectory() ? walk(path.join(d, e.name))
                : (e.name.endsWith(".test.js") ? [path.join(d, e.name)] : []));
        const stray = walk(path.join(repoRoot, "tests"))
            .map((p) => p.slice(repoRoot.length))
            .filter((p) => rx.test(p) && !FIT_TESTS.includes(p.replace(/^\//, "")));
        expect(stray).toEqual([]);
    });

    test("touchesFitCode recognises the fitting sources and ignores unrelated files", () => {
        expect(touchesFitCode("src/LOSFitting.js")).toBe(true);
        expect(touchesFitCode("src/TraverseBattery.js")).toBe(true);
        expect(touchesFitCode("benchmarks/botbench/lib/verdictRunner.js")).toBe(true);
        expect(touchesFitCode("tests/DroneControlFit.test.js")).toBe(true);

        expect(touchesFitCode("src/CNodeView.js")).toBe(false);
        expect(touchesFitCode("docs/WhatsNew.md")).toBe(false);
        // Globals is imported by the fit suites but excluded on purpose — see fitTests.js.
        expect(touchesFitCode("src/Globals.js")).toBe(false);
    });
});
