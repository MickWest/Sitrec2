// Set the secure build flag FIRST, before any imports.
// webpack.common.js loads webpackCopyPatterns.js, which reads it, and everything that
// decides "is this the secure build" at compile time reads the same variable.
process.env.IS_SECURE_BUILD = 'true';

const { merge } = require('webpack-merge');
const commonFn = require('./webpack.common.js');
const path = require('path');
const fs = require('fs');
const CopyPlugin = require("copy-webpack-plugin");
const webpack = require('webpack');
const { buildSecureClientEnv, buildWebpackDefineEnv } = require('./scripts/secureClientEnv');

const copyPatterns = require('./webpackCopyPatterns');

// The secure build: the production server build (webpack.prod.js) with every outbound
// feature removed at compile time. Same output shape as the production build, written to
// its own directory so it can be audited in isolation. See docs/dev/Secure-Build.md.
const securePath = path.resolve(__dirname, 'dist-secure');

// Per-module stubs. scripts/secureStubs.js (written by the stub task) exports
//   aliases:              { [absolute original path]: absolute stub path }
//   removedMarkers:       strings every stub leaves in the bundle, so the egress audit can
//                         prove the stub is what shipped
//   originalHostLiterals: host names of the originals, which must not survive
// Optional, so this config builds before that file exists - but loudly, so its absence is
// never mistaken for coverage. A map file that exists but fails to load is a build error.
const stubMapPath = path.resolve(__dirname, 'scripts', 'secureStubs.js');

function loadSecureStubs() {
    if (!fs.existsSync(stubMapPath)) {
        console.warn(`[secure build] WARNING: ${path.relative(__dirname, stubMapPath)} not found - no modules are stubbed in this build`);
        return { aliases: {} };
    }
    try {
        const stubs = require(stubMapPath);
        const aliases = stubs.aliases || {};
        console.log(`[secure build] ${Object.keys(aliases).length} module(s) stubbed from ${path.relative(__dirname, stubMapPath)}`);
        return { ...stubs, aliases };
    } catch (e) {
        throw new Error(`[secure build] ${stubMapPath} exists but could not be loaded: ${e.message}`);
    }
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replace each original module with its stub. Done with NormalModuleReplacementPlugin
// in its afterResolve phase rather than resolve.alias: an alias key is matched against
// the import request as written ("./CRehoster", relative to the package root), so an
// absolute-path key would never match a relative import. After resolution the module's
// absolute path is known and the map can be applied exactly. The map may name the
// original with or without its extension.
function secureStubReplacementPlugin(aliases) {
    const lookup = new Map();
    for (const [original, stub] of Object.entries(aliases)) {
        const resolvedOriginal = path.resolve(original);
        const resolvedStub = path.resolve(stub);
        if (!fs.existsSync(resolvedStub)) {
            throw new Error(`[secure build] stub for ${resolvedOriginal} does not exist: ${resolvedStub}`);
        }
        lookup.set(resolvedOriginal, resolvedStub);
        lookup.set(resolvedOriginal.replace(/\.(js|ts|mjs)$/, ''), resolvedStub);
    }

    const stubFor = resource => lookup.get(resource) || lookup.get(resource.replace(/\.(js|ts|mjs)$/, ''));
    const pattern = new RegExp([...lookup.keys()].map(escapeRegExp).join('|'));
    const replaced = new Set();

    const plugin = new webpack.NormalModuleReplacementPlugin(pattern, resource => {
        // beforeResolve calls this with the request as written; only afterResolve
        // (createData present) carries the resolved absolute path.
        const createData = resource.createData;
        if (!createData || !createData.resource) return;
        const stub = stubFor(createData.resource);
        if (!stub) return;
        const original = createData.resource;
        for (const key of ['resource', 'request', 'userRequest']) {
            if (typeof createData[key] === 'string') {
                createData[key] = createData[key].split(original).join(stub);
            }
        }
        // The stub's own relative imports must resolve against the stub's directory, not
        // the original's; without this a stub that imports "./helper" would look for the
        // helper beside the module it replaced.
        createData.context = path.dirname(stub);
        replaced.add(original);
    });

    return {
        apply(compiler) {
            plugin.apply(compiler);
            compiler.hooks.done.tap('SecureStubReplacementReport', () => {
                const unused = Object.keys(aliases)
                    .map(original => path.resolve(original))
                    .filter(original => !replaced.has(original) && !replaced.has(`${original}.js`) && !replaced.has(`${original}.ts`));
                for (const original of unused) {
                    console.warn(`[secure build] WARNING: stub map names ${path.relative(__dirname, original)}, which this build never resolved (wrong path, or not imported)`);
                }
            });
        },
    };
}

module.exports = (env, argv) => {
    // Production unless --mode development is passed: the debug variant is unminified
    // with eval source maps, exactly as the serverless config does it.
    const isDevelopment = argv.mode === 'development';
    const mode = isDevelopment ? 'development' : 'production';
    const commonConfig = commonFn({ includeIWER: false });
    const secureClientEnv = buildSecureClientEnv();
    const stubs = loadSecureStubs();

    // Dotenv is replaced by the sanitized, forced environment below; the common
    // CopyPlugin is replaced by one with the same patterns so there is exactly one.
    const filteredCommonPlugins = commonConfig.plugins.filter(plugin =>
        plugin.constructor.name !== 'CopyPlugin' &&
        plugin.constructor.name !== 'Dotenv'
    );

    const config = merge(commonConfig, {
        mode,
        devtool: isDevelopment ? 'eval-source-map' : false,
        optimization: {
            minimize: !isDevelopment,
        },
        cache: {
            // Own cache: the module graph differs from every other build once the stubs
            // apply, and a change to the stub map must invalidate it.
            name: `secure-${mode}`,
            buildDependencies: {
                config: [__filename, ...(fs.existsSync(stubMapPath) ? [stubMapPath] : [])],
            },
        },
        output: {
            filename: isDevelopment ? '[name].bundle.js' : '[name].[contenthash].bundle.js',
            path: securePath,
            clean: true,
            devtoolModuleFilenameTemplate: isDevelopment ? 'webpack://[namespace]/[resource-path]?[loaders]' : undefined,
        },
    });

    const stubPlugins = Object.keys(stubs.aliases).length > 0
        ? [secureStubReplacementPlugin(stubs.aliases)]
        : [];

    config.plugins = [
        ...filteredCommonPlugins,
        // With Dotenv gone nothing stubs `process`, so provide the same browser shim the
        // serverless build uses; any process.env.X the DefinePlugin below does not name
        // resolves through it to the same sanitized environment.
        new webpack.ProvidePlugin({
            process: path.resolve(__dirname, "src", "shims", "browserProcess.js"),
        }),
        new webpack.DefinePlugin({
            'process.env.IS_SECURE_BUILD': '"true"',
            __SITREC_BROWSER_PROCESS_ENV__: JSON.stringify(secureClientEnv),
            ...buildWebpackDefineEnv(secureClientEnv),
        }),
        ...stubPlugins,
        new CopyPlugin({
            patterns: copyPatterns,  // the server patterns, unchanged (see webpackCopyPatterns.js)
        }),
        // Add CircularDependencyPlugin
        (() => {
            let hasStarted = false;
            let hasEnded = false;

            return new (require('circular-dependency-plugin'))({
                exclude: /node_modules/,
                include: /src/,
                onStart({ compilation }) {
                    if (!hasStarted) {
                        console.log('start detecting webpack modules cycles');
                        hasStarted = true;
                    }
                },
                onDetected({ module: webpackModuleRecord, paths, compilation }) {
                    const ignoreModules = ["mathjs"];
                    if (paths.some(path => ignoreModules.some(ignoreModule => path.includes(ignoreModule)))) {
                        return;
                    }
                    compilation.errors.push(new Error(paths.join(' -> ')));
                },
                onEnd({ compilation }) {
                    if (!hasEnded) {
                        console.log('end detecting webpack modules cycles');
                        hasEnded = true;
                    }
                },
            });
        })(),
    ];

    return config;
};
