/**
 * Stub for three/addons/* and three-adjacent ESM modules that Jest cannot
 * load natively (three's package.json has "type": "module"). Returns a
 * Proxy that synthesizes any requested named export as a trivial class,
 * so `import {LineMaterial, LineGeometry, Line2, ...} from "three/addons/..."`
 * destructures cleanly and the importing file can finish loading.
 *
 * Used by tests/node-smoke.test.js to verify module-graph integrity.
 * Real runtime behavior is covered by Playwright regression tests under
 * a webpack build where three/addons load properly.
 */

// Recursive proxy so any .foo.bar.baz(...) chain from module-init code
// resolves without throwing. Constructors return a new deep proxy so
// `new LineMaterial({...}).resolution.set(w, h)` at module top-level works.
function makeDeepStub() {
    const fn = function DeepStub() {
        return makeDeepStub();
    };
    return new Proxy(fn, {
        get: (_target, key) => {
            if (key === "__esModule") return true;
            if (key === "default") return fn;
            if (key === Symbol.toPrimitive) return () => "";
            if (key === "then") return undefined;
            return makeDeepStub();
        },
        set: () => true,
        construct: () => makeDeepStub(),
        apply: () => makeDeepStub(),
    });
}

module.exports = makeDeepStub();
