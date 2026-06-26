// Babel plugin (TEST ENV ONLY): rewrite dynamic `import(x)` into
//   Promise.resolve().then(() => _interopRequireWildcard(require(x)))
//
// Jest runs our source through @babel/plugin-transform-modules-commonjs, which
// converts STATIC import/export to CommonJS but deliberately leaves dynamic
// `import()` as a native call — and native dynamic import throws under Jest's
// default CJS VM ("A dynamic import callback was invoked without
// --experimental-vm-modules"). Production builds go through webpack, which handles
// `import()` correctly as a code-split boundary; this plugin only affects the
// `test` Babel env so the same source runs under Jest too.
//
// We route through Babel's interopRequireWildcard helper so that both namespace
// access (`(await import('chrono-node')).parse`) and default access
// (`(await import('jszip')).default`) resolve the same way they do for static
// imports of CommonJS modules.

module.exports = function dynamicImportToRequire({ types: t }) {
    return {
        name: "dynamic-import-to-require-test",
        visitor: {
            Import(path) {
                const callExpr = path.parentPath; // the surrounding import(...) CallExpression
                if (!callExpr.isCallExpression()) return;
                const source = callExpr.node.arguments[0];
                const interop = this.addHelper("interopRequireWildcard");
                const requireCall = t.callExpression(t.identifier("require"), [source]);
                const interopCall = t.callExpression(interop, [requireCall]);
                const thenArrow = t.arrowFunctionExpression([], interopCall);
                const promiseResolveThen = t.callExpression(
                    t.memberExpression(
                        t.callExpression(
                            t.memberExpression(t.identifier("Promise"), t.identifier("resolve")),
                            []
                        ),
                        t.identifier("then")
                    ),
                    [thenArrow]
                );
                callExpr.replaceWith(promiseResolveThen);
            },
        },
    };
};
