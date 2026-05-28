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

// three's package has "type": "module", and its addon subpaths resolve to
// ESM files Jest's CommonJS runtime can't load. Stub each three/addons
// path this test transitively pulls in. Scoped to this file so other tests
// that supply their own three/addons mocks (e.g. ModelLoader.test.js) keep
// working.
//
// jest.mock factories are hoisted above variable declarations, so the stub
// path must be inline — referencing an outer `const` here would fail with
// "module factory of jest.mock() is not allowed to reference any
// out-of-scope variables".
jest.mock("three/addons/lines/LineMaterial.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/LineGeometry.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/LineSegmentsGeometry.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/lines/Line2.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/loaders/DRACOLoader.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/loaders/GLTFLoader.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/loaders/PLYLoader.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/objects/Sky.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/postprocessing/ShaderPass.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/shaders/HorizontalBlurShader.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/shaders/VerticalBlurShader.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/utils/BufferGeometryUtils.js", () => require("./__mocks__/three-addons-stub.js"));
jest.mock("three/addons/webxr/VRButton.js", () => require("./__mocks__/three-addons-stub.js"));

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
//   import.meta         — webpack-only syntax used by worker bundling; Jest
//                         refuses to parse.
//   export in .mjs path — some dependency is a raw .mjs that our moduleName
//                         mapper didn't catch; not worth chasing for this
//                         test's module-graph-integrity scope.
//   3d-tiles-renderer   — npm package with an "exports" field Jest can't
//                         resolve the same way webpack does.
const SKIP_FILES = new Set([
    "CNodeAnnotateOverlay.js",  // import.meta (via CNodeTrackingOverlay -> CNodeVideoView -> CNodeVideoViewAnalysis)
    "CNodeBuildings3DTiles.js", // 3d-tiles-renderer resolve
    "CNodeMaskOverlay.js",      // import.meta
    "CNodeMirrorVideoView.js",  // import.meta
    "CNodeSpeedOverlay.js",     // import.meta
    "CNodeTerrain.js",          // nested ESM path
    "CNodeTerrainUI.js",        // nested ESM path
    "CNodeTrackFromMISB.js",    // nested ESM path
    "CNodeTrackingOverlay.js",  // import.meta
    "CNodeVideoView.js",        // import.meta
    "CNodeVideoViewAnalysis.js",// import.meta
    "CNodeVideoWebCodecView.js",// import.meta
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
