/**
 * @jest-environment jsdom
 *
 * Node module-graph smoke test.
 *
 * For every CNode* class file under src/nodes/, require the module and verify:
 *   1. The require itself does not throw (catches broken top-level code such as
 *      a prototype-mixin that references an undefined helper, or an import
 *      that resolves to undefined and is immediately invoked).
 *   2. Every exported name starting with "CNode" is a function (i.e. a class).
 *      Catches cases where a rename/extraction caused a former class symbol to
 *      become undefined — the import on the consumer side would silently
 *      destructure undefined and fail only at runtime.
 *
 * This complements Biome's noUndeclaredVariables (which catches references to
 * identifiers that were never declared) by catching the opposite shape:
 * identifiers that are declared as imports but whose target module has since
 * stopped exporting them. See commit 5a1c8c01 for the 100-bug cleanup that
 * motivated this test.
 *
 * The test deliberately does NOT call `new` on each class. Constructor-time
 * code often needs a live Three.js renderer, a populated NodeMan, or a Sit
 * with specific state — mocking each is expensive and the biome gate already
 * covers the missing-identifier class of bug. This test is scoped to
 * module-load integrity.
 */

const fs = require("node:fs");
const path = require("node:path");

// three's addon subpaths (three/addons/*) resolve to ESM files under
// node_modules/three/examples/jsm/. Jest's CommonJS runtime cannot load those
// as-is, so package.json's transformIgnorePatterns carves out "three/examples"
// and Babel transforms them like project source, letting the REAL addon modules
// load here — which is what a module-load smoke test should be proving.
//
// That replaced a hand-maintained list of jest.mock() stubs, one per addon the
// node graph transitively pulled in. Two things were wrong with it: the list had
// to be extended by hand whenever a node imported a new addon, and a stub whose
// path failed to resolve was a silent no-op that let the raw ESM through. The
// second bit: the mocks resolved on Node 22.13 but not on CI's pinned 22.4, so
// all 84 subtests failed there with "Cannot use import statement outside a
// module" while the same test passed locally. Other suites that supply their own
// three/addons mocks (e.g. ModelLoader.test.js) are unaffected — jest.mock is
// per-file.

// jsdom in the jest-environment-jsdom package doesn't implement matchMedia.
// A handful of node modules read it at top level (responsive-GUI / mobile
// detection). Stub it so those modules load.
if (typeof window !== "undefined" && !window.matchMedia) {
    window.matchMedia = () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
    });
}

// Files that cannot load in Jest because of infrastructure limitations
// (not codebase bugs). These are still covered by the Biome gate for the
// missing-identifier class of bug. When any of these can be test-loaded
// safely, remove from the skip list.
//
// Reasons:
//   export in .mjs path — some dependency is a raw .mjs that our moduleName
//                         mapper didn't catch; not worth chasing for this
//                         test's module-graph-integrity scope.
//   3d-tiles-renderer   — npm package with an "exports" field Jest can't
//                         resolve the same way webpack does.
//
// NOTE: files using `import.meta` (worker bundling) used to be skipped too,
// but babel-plugin-transform-import-meta (wired into the "test" env in
// babel.config.json) now lets Jest parse them, so they are smoke-tested.
const SKIP_FILES = new Set([
    "CNodeBuildings3DTiles.js", // 3d-tiles-renderer resolve
    "CNodeTerrain.js",          // nested ESM path
    "CNodeTerrainUI.js",        // nested ESM path
    "CNodeTrackFromMISB.js",    // nested ESM path
    "CNodeLazyMISBFlightTrack.js", // extends CNodeTrackFromMISB (nested ESM path)
]);

// Mock the absolute minimum so that module top-level code can run without
// complaining about a missing NodeMan or the like. Any node that does more
// than trivial top-level work (e.g. registering a GUI folder, calling a
// Globals method) will hit this and fall through to the real error.
jest.mock("../src/Globals", () => {
    const passthroughObject = new Proxy(
        {},
        {
            get: (_, key) => {
                if (key === "then") return undefined; // avoid thenable confusion
                return passthroughObject;
            },
            set: () => true,
        },
    );
    const passthroughFn = () => passthroughObject;
    return new Proxy(
        {},
        {
            get: () => passthroughFn,
        },
    );
});

// Three.js doesn't need mocking; it's pure JS and imports fine in Node.

const NODES_DIR = path.resolve(__dirname, "..", "src", "nodes");
const nodeFiles = fs
    .readdirSync(NODES_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort();

describe("node module-graph smoke", () => {
    for (const file of nodeFiles) {
        const rel = `../src/nodes/${file}`;

        if (SKIP_FILES.has(file)) {
            test.skip(`loads ${file} without throwing at module init`, () => {});
            continue;
        }

        test(`loads ${file} without throwing at module init`, () => {
            // Any throw at require() time indicates a broken import graph:
            //   - a named import resolves to undefined and gets called
            //   - a prototype-mixin Object.assign errors out
            //   - a top-level side effect throws
            let mod;
            expect(() => {
                mod = require(rel);
            }).not.toThrow();

            // Every CNode* named export should be a function (class).
            // Undefined here means a rename/extraction in a sibling module has
            // left a consumer's named import resolving to nothing.
            if (mod) {
                for (const key of Object.keys(mod)) {
                    if (key.startsWith("CNode")) {
                        expect(typeof mod[key]).toBe("function");
                    }
                }
            }
        });
    }
});
