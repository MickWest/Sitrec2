const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');
const CopyPlugin = require("copy-webpack-plugin");
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const TerserPlugin = require("terser-webpack-plugin");
const InstallPaths = require('./config/config-install');
const copyPatterns = require('./webpackCopyPatterns');
const Dotenv = require('dotenv-webpack');
const child_process = require('child_process');
const fs = require('fs');
const MarkdownIt = require('markdown-it');
const md = new MarkdownIt();
const CircularDependencyPlugin = require('circular-dependency-plugin')
const WasmPackPlugin = require('@wasm-tool/wasm-pack-plugin');

const dotenv = require('dotenv');
const result = dotenv.config({ path: './config/shared.env' });
if (result.error) {
    throw result.error;
}

// Stop the build when config/shared.env predates config/shared.env.example
// (compares SHARED_ENV_VERSION stamps; prints what changed and how to update).
// Covers every bundling build, which all require this file; webpack.copy-files.js
// does not, so it carries its own copy of this call.
require('./scripts/sharedEnvVersion').checkOrExit();

// Rewrite inter-document links from .md to .html for the generated doc pages.
// Handles a trailing anchor: [x](Foo.md#bar) -> [x](Foo.html#bar). The previous pattern
// required a literal ".md)" and so silently left every anchored link pointing at the raw
// markdown file, which the browser shows as plain text instead of opening the page.
function rewriteMdLinks(text) {
    return text.replace(
        /(\[.*?\]\((?:\.\/)?(?:docs\/)?)([^)#]*?)\.md(#[^)]*)?\)/g,
        (_m, prefix, name, anchor) => `${prefix}${name}.html${anchor || ''})`
    );
}

// Applied until it stops changing the string. A single pass over "<<b>b>" leaves a
// "<b>" the pass itself created, so one replace() is not a reliable way to remove
// markup (CodeQL js/incomplete-multi-character-sanitization). Real markdown-it output
// has no such shape and reaches the fixpoint on the second pass.
function stripTags(s) {
    let prev;
    do {
        prev = s;
        s = s.replace(/<[^>]*>/g, '');
    } while (s !== prev);
    return s;
}

// markdown-it emits bare <h1>..<h6> with no id, so a link like Foo.md#some-heading rewrites
// to a valid page but a fragment with nothing to jump to. Add GitHub-style slug ids after
// rendering, so intra- and inter-document anchors actually land on their section.
function addHeadingIds(html) {
    const used = new Map();
    return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (match, level, inner) => {
        const text = stripTags(inner)
            // Decode the entities markdown-it emits, so "What's New" slugs to
            // "whats-new" (what an author would write) and not "what39s-new".
            .replace(/&#39;|&apos;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
        let slug = text.toLowerCase().trim()
            .replace(/[^\w\s-]/g, '')                          // drop punctuation
            .replace(/\s+/g, '-');
        if (!slug) return match;
        // GitHub disambiguates repeats with -1, -2, ...
        const n = used.get(slug) || 0;
        used.set(slug, n + 1);
        if (n > 0) slug = `${slug}-${n}`;
        return `<h${level} id="${slug}">${inner}</h${level}>`;
    });
}

function getVersionNumber() {
    const gitTag = process.env.VERSION ||
        child_process.execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim();
    return gitTag
}

function getWorktreeName() {
    // Detect if running in a git worktree and return its name
    try {
        const gitDir = child_process.execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
        // Worktrees have a .git file (not directory) pointing to the main repo's worktrees/<name> dir
        if (gitDir.includes('/worktrees/')) {
            return path.basename(gitDir);
        }
    } catch (e) {
        // Not in a git repo or git not available
    }
    return null;
}

// Return the short abbreviation of the build machine's local time zone for the
// given instant (e.g. "PST"/"PDT", "UTC", "EDT"). The hours/minutes elsewhere are
// produced with Date.getHours()/getMinutes(), which are also in local time, so the
// label always matches the digits. We collapse Pacific Standard/Daylight to the
// familiar "PT" since that's what dev builds on Mick's machine have always shown;
// CI runners (typically UTC) now correctly read "UTC" instead of a bogus "PT".
function getTimeZoneAbbreviation(date) {
    try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(date);
        const abbr = parts.find(p => p.type === 'timeZoneName')?.value;
        if (abbr === 'PST' || abbr === 'PDT') return 'PT';
        if (abbr) return abbr;
    } catch (e) {
        // Intl unavailable or failed — fall through to the IANA name below.
    }
    // Fallback: the raw IANA zone id (e.g. "America/Los_Angeles", "UTC").
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
    } catch (e) {
        return 'local';
    }
}

function getFormattedLocalDateTime() {
    const now = new Date();
    const year = String(now.getFullYear()).substring(2);
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');

    const worktreeName = getWorktreeName();
    if (worktreeName) {
        return `${worktreeName} ${hours}:${minutes}`;
    }

    const zone = getTimeZoneAbbreviation(now);
    const gitTag = getVersionNumber();
    return `Sitrec ${gitTag}: ${year}-${month}-${day} ${hours}:${minutes} ${zone}`;
}


const buildVersionString = getFormattedLocalDateTime();
console.log(buildVersionString);

module.exports = (env = {}) => ({

    entry: {
        index: './src/index.js',
    },
    target: 'web',
    externals: {
        'node:fs': 'commonjs2 fs',
    },
    cache: {
        type: 'filesystem', // Enable persistent caching for faster rebuilds
        buildDependencies: {
            config: [__filename], // Invalidate cache when webpack config changes
        },
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                loader: 'esbuild-loader',
                options: {
                    target: 'es2020',
                },
            },
            {
                test: /\.css$/,
                use: [
                    MiniCssExtractPlugin.loader,
                    'css-loader',
                ],
            },
            {
                // The AI assistant's system prompt is shared verbatim between the PHP
                // server (sitrecServer/chatbot.php reads it at runtime) and the browser
                // BYOK path (src/CDirectLLMClient.js imports it, inlined here at build
                // time so serverless/desktop builds work with no server). Deliberately
                // scoped to this one file rather than all *.txt.
                test: /chatbotSystemPrompt\.txt$/,
                type: 'asset/source',
            },
        ],
    },
    resolve: {
        extensions: ['.ts', '.js'],
        alias: {
            'three/src': 'three',
        },
    },
    plugins: [

    //    new webpack.debug.ProfilingPlugin(),

        // {
        //     apply: (compiler) => {
        //         compiler.hooks.beforeRun.tap('CleanOutputDirPlugin', () => {
        //             const outDir = InstallPaths.dev_path;
        //             if (fs.existsSync(outDir)) {
        //                 fs.rmSync(outDir, {recursive: true, force: true});
        //                 fs.mkdirSync(outDir, {recursive: true});
        //                 console.log(`Cleaned ${outDir}`);
        //             }
        //         });
        //     }
        // },

        new Dotenv({
            path: './config/shared.env',
        }),
        new MiniCssExtractPlugin(),
        new HtmlWebpackPlugin({
            title: "Sitrec - Metabunk's Situation Recreation Tool",
            meta: {
                // ── Content-Security-Policy (partial, deliberately) ──────────────────
                // Only the directives that are genuinely safe for Sitrec are enforced.
                // Each was checked against the codebase first:
                //   object-src 'none'  — Sitrec creates no <object>/<embed>; kills a
                //                        legacy script-execution vector outright.
                //   base-uri 'self'    — Sitrec never sets a <base> tag. Without this, an
                //                        injected <base> silently repoints every relative
                //                        URL on the page, which turns a small HTML
                //                        injection into full script control.
                //   form-action 'self' — no form posts off-origin, so an injected form
                //                        cannot be used to POST page data elsewhere.
                //
                // The two directives that would actually stop an exfiltration —
                // script-src and connect-src — are NOT set:
                //   - connect-src cannot be restricted while `?custom=<any URL>` loads a
                //     sitch from an arbitrary origin (src/index.js), and while map tiles
                //     come from a long, growing list of hosts. It would have to be '*'.
                //     Tightening it needs that loader reworked first.
                //   - script-src is closer than it looks. Scripted Video no longer counts
                //     against it: its AsyncFunction is compiled only inside
                //     ScriptRunnerWorker, and the page has no fallback that runs it. Nor is
                //     'unsafe-inline' needed — the emitted index.html carries no inline
                //     <script> and no inline style. What still forces 'unsafe-eval' is
                //     ndarray, which compiles generated code at runtime
                //     (construct_/TrivialArray/CTOR_LIST); it is one direct dependency,
                //     reached only from src/js/get-pixels-mick.js. OpenCV's WASM needs
                //     'wasm-unsafe-eval', a far narrower grant than 'unsafe-eval'.
                //
                // Delivered as a meta tag, which cannot carry frame-ancestors (so there is
                // no clickjacking protection) or a reporting endpoint. Both need this moved
                // to a response header.
                //
                // If default-src is ever added here, add worker-src 'self' EXPLICITLY.
                // worker-src otherwise inherits through child-src, and Scripted Video now
                // depends on that worker absolutely — with the fallback gone, blocking it
                // kills the feature outright instead of degrading it.
                //
                // See docs/APIKeys.md, which tells users this gap exists.
                'Content-Security-Policy': {
                    'http-equiv': 'Content-Security-Policy',
                    content: "object-src 'none'; base-uri 'self'; form-action 'self'",
                },
                'Cache-Control': { 'http-equiv': 'Cache-Control', content: 'no-cache, no-store, must-revalidate' },
                'Pragma': { 'http-equiv': 'Pragma', content: 'no-cache' },
                'Expires': { 'http-equiv': 'Expires', content: '0' },
                // Icon hrefs are relative to the page, not to the server root. The
                // copy patterns emit these four files into the app directory, so a
                // leading "/" pointed at the *host* root instead — wrong for every
                // install that is not served from "/", and a guaranteed 404 on a
                // static host that only publishes a subdirectory (GitHub Pages
                // project sites, ".../<repo>/"). Relative works for both.
                'apple-touch-icon': {
                    rel: 'apple-touch-icon',
                    sizes: '180x180',
                    href: 'apple-touch-icon.png'
                },
                'favicon-32': {
                    rel: 'icon',
                    type: 'image/png',
                    sizes: '32x32',
                    href: 'favicon-32x32.png'
                },
                'favicon-16': {
                    rel: 'icon',
                    type: 'image/png',
                    sizes: '16x16',
                    href: 'favicon-16x16.png'
                },
                'manifest': {
                    rel: 'manifest',
                    href: 'site.webmanifest'
                }
            }
        }),
        new webpack.ProvidePlugin({
            Buffer: ['buffer', 'Buffer'],
        }),
        new CopyPlugin({
            patterns: [
                ...copyPatterns, // Existing patterns
            ],
        }),
        {
            // Custom plugin for converting Markdown to HTML
            apply: (compiler) => {
                compiler.hooks.afterEmit.tapPromise('MarkdownToHtmlPlugin', async () => {
                    const docsDir = path.resolve(__dirname, 'docs');
                    const outputBaseDir = compiler.options.output.path;
                    const outputDir = path.resolve(outputBaseDir, 'docs');
                    const rootReadme = path.resolve(__dirname, 'README.md');
                    const outputRootReadme = path.resolve(outputBaseDir, 'README.html');

                    // docs/temp/ was the home of local-only working notes (now private/notes/,
                    // outside docs/ entirely). The skip stays as a tripwire: this walk emits
                    // three things per file — the rendered .html, the raw .md (for chatbot
                    // access), and any non-markdown file verbatim — so an un-skipped directory
                    // here publishes its whole contents. Kept in step with the /docs/temp/ entry
                    // in .gitignore.
                    const skipDirs = new Set(['temp']);

                    const convertMarkdownFiles = async (dir) => {
                        const files = await fs.promises.readdir(dir, { withFileTypes: true });

                        for (const file of files) {
                            // Never publish dot-entries. Two of these were shipping:
                            // docs/.DS_Store, which encodes the NAMES of everything in the
                            // directory
                            if (file.name.startsWith('.')) continue;

                            const fullPath = path.join(dir, file.name);
                            const relativePath = path.relative(docsDir, fullPath);
                            const outputPath = path.join(outputDir, relativePath.replace(/\.md$/, '.html'));

                            if (file.isDirectory()) {
                                if (skipDirs.has(file.name)) continue;
                                await fs.promises.mkdir(path.join(outputDir, relativePath), { recursive: true });
                                await convertMarkdownFiles(fullPath);
                            } else if (file.name.endsWith('.md')) {
                                let markdownContent = await fs.promises.readFile(fullPath, 'utf-8');
                                // Strip HTML comments repeatedly to handle nested comments
                                let prevContent;
                                do {
                                    prevContent = markdownContent;
                                    markdownContent = markdownContent.replace(/<!--[\s\S]*?-->/g, '');
                                } while (markdownContent !== prevContent);
                                markdownContent = rewriteMdLinks(markdownContent);
                                const bodyContent = addHeadingIds(md.render(markdownContent));
                                
                                // Extract title from first H1 or use filename
                                const titleMatch = markdownContent.match(/^#\s+(.+)$/m);
                                const title = titleMatch ? titleMatch[1] : file.name.replace('.md', '');
                                
                                const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="stylesheet" href="github-markdown.css">
</head>
<body>
${bodyContent}
</body>
</html>`;
                                await fs.promises.writeFile(outputPath, htmlContent, 'utf-8');
                                
                                // Also copy raw .md file for AI chatbot access
                                const mdOutputPath = path.join(outputDir, relativePath);
                                await fs.promises.copyFile(fullPath, mdOutputPath);
                            } else {
                                // Copy non-markdown files (images, CSS, etc.)
                                const outputFilePath = path.join(outputDir, relativePath);
                                await fs.promises.copyFile(fullPath, outputFilePath);
                            }
                        }
                    };

                    // Ensure output directory exists before converting
                    await fs.promises.mkdir(outputDir, { recursive: true });
                    
                    // Convert Markdown files in the `docs` directory
                    await convertMarkdownFiles(docsDir);

                    // Convert the root README.md file
                    if (fs.existsSync(rootReadme)) {
                        let readmeContent = await fs.promises.readFile(rootReadme, 'utf-8');
                        // Remove image links to github.com
                        readmeContent = readmeContent.replace(/!\[.*?\]\(https?:\/\/github\.com\/[^\)]+\)\s*\n?/g, '');
                        readmeContent = rewriteMdLinks(readmeContent);
                        const bodyContent = addHeadingIds(md.render(readmeContent));
                        
                        // Extract title from first H1 or use "README"
                        const titleMatch = readmeContent.match(/^#\s+(.+)$/m);
                        const title = titleMatch ? titleMatch[1] : 'README';
                        
                        const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="stylesheet" href="docs/github-markdown.css">
</head>
<body>
${bodyContent}
</body>
</html>`;
                        await fs.promises.writeFile(outputRootReadme, htmlContent, 'utf-8');
                    }
                });
            },
        },
        new webpack.DefinePlugin({
            'process.env.BUILD_VERSION_STRING': JSON.stringify(buildVersionString),
            'process.env.BUILD_VERSION_NUMBER': JSON.stringify(getVersionNumber()),
            'process.env.DOCKER_BUILD': JSON.stringify(process.env.DOCKER_BUILD === 'true'),
            'CAN_REQUIRE_CONTEXT': JSON.stringify(true),
            'INCLUDE_IWER_EMULATOR': JSON.stringify(env.includeIWER !== false),
            '__SITREC_BUILD_DIR__': JSON.stringify(process.cwd()),
            // Collect all SITREC_CUSTOM_MAP_* and SITREC_CUSTOM_ELEVATION_* vars from shared.env
            // as a JSON blob so serverless builds can iterate them at runtime (dotenv-webpack
            // only replaces literal process.env.X references, not dynamic key access).
            'process.env.SITREC_CUSTOM_SOURCES': JSON.stringify(JSON.stringify(
                Object.fromEntries(
                    Object.entries(result.parsed || {}).filter(([k]) =>
                        k.startsWith('SITREC_CUSTOM_MAP_') || k.startsWith('SITREC_CUSTOM_ELEVATION_')
                    )
                )
            )),
        }),

        // Print build success with version string after webpack's summary line
        {
            apply: (compiler) => {
                compiler.hooks.done.tap('PrintBuildTime', (stats) => {
                    setImmediate(() => {
                        const duration = (stats.endTime - stats.startTime) / 1000;
                        console.log(`SUCCESS: ${buildVersionString} in ${duration.toFixed(1)}s`);
                    });
                });
            }
        },

        // Write build-version.txt so the app can detect stale cached index.html
        {
            apply: (compiler) => {
                compiler.hooks.compilation.tap('WriteBuildVersion', (compilation) => {
                    compilation.hooks.processAssets.tap(
                        { name: 'WriteBuildVersion', stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
                        () => {
                            const version = buildVersionString;
                            compilation.emitAsset('build-version.txt',
                                new webpack.sources.RawSource(version));
                        }
                    );
                });
            }
        },

        {
            apply: (compiler) => {
                // A build file is a *complete, self-contained* copy of the Three.js runtime
                // when it carries the `window.__THREE__ = REVISION` init guard. If more than
                // one such file ends up in a single bundle, the guard fires twice ("Multiple
                // instances of Three.js being imported") and, worse, you get two disjoint sets
                // of class prototypes so `instanceof` and prototype extensions silently break.
                // The classic cause is mixing an ESM `import ... from "three"` (resolves to
                // build/three.core.js via three.module.js) with a CJS `require("three")`
                // (resolves to build/three.cjs through the package's "require" export
                // condition). See CLAUDE.md "Working with Three.js".
                //
                // We detect the guard by *content*, not by filename, so this stays correct
                // across Three versions that move the init between build files (e.g. the
                // three.module.js / three.core.js split). three.module.js itself is only a
                // re-export shim with no guard, so it legitimately coexists with three.core.js.
                const INIT_MARKER = 'window.__THREE__';
                const guardCache = new Map(); // resource path -> bool (contains init guard)
                const hasInitGuard = (resource) => {
                    if (!guardCache.has(resource)) {
                        let found = false;
                        try {
                            found = fs.readFileSync(resource, 'utf-8').includes(INIT_MARKER);
                        } catch (e) { /* unreadable -> treat as non-runtime */ }
                        guardCache.set(resource, found);
                    }
                    return guardCache.get(resource);
                };

                compiler.hooks.emit.tap('DetectDuplicateThreeModules', (compilation) => {
                    const threeModules = new Map();
                    const runtimeBuilds = new Map(); // build path -> Set of importing modules

                    for (const module of compilation.modules) {
                        if (!module.resource) continue;
                        if (!module.resource.includes('node_modules/three/')) continue;

                        const relativePath = module.resource.substring(
                            module.resource.indexOf('node_modules/three/')
                        );

                        if (!threeModules.has(relativePath)) {
                            threeModules.set(relativePath, []);
                        }
                        threeModules.get(relativePath).push(module.identifier());

                        if (hasInitGuard(module.resource)) {
                            if (!runtimeBuilds.has(relativePath)) {
                                runtimeBuilds.set(relativePath, new Set());
                            }
                            // Record which of *our* modules pulled this build in, so the
                            // error message points at the real offender.
                            for (const conn of compilation.moduleGraph.getIncomingConnections(module)) {
                                const origin = conn.originModule && conn.originModule.resource;
                                if (origin && !origin.includes('node_modules/three/')) {
                                    runtimeBuilds.get(relativePath).add(
                                        origin.replace(compiler.context + '/', '')
                                    );
                                }
                            }
                        }
                    }

                    // (1) Same build file pulled in as more than one webpack module.
                    const duplicates = Array.from(threeModules.entries())
                        .filter(([, identifiers]) => identifiers.length > 1);

                    // (2) Two or more *distinct* runtime builds (the ESM/CJS mix). This is the
                    //     case the old path-grouping check missed: three.cjs and three.core.js
                    //     are different paths, so each looked "unique".
                    const variants = Array.from(runtimeBuilds.keys());

                    if (variants.length > 1) {
                        let msg = 'Multiple Three.js runtime builds bundled together — '
                            + 'this produces the runtime "Multiple instances of Three.js" warning '
                            + 'and breaks instanceof / prototype extensions:\n';
                        for (const v of variants) {
                            const importers = Array.from(runtimeBuilds.get(v));
                            msg += `    • ${v}`;
                            if (importers.length) {
                                msg += `  ← imported by: ${importers.slice(0, 5).join(', ')}`
                                    + (importers.length > 5 ? `, +${importers.length - 5} more` : '');
                            }
                            msg += '\n';
                        }
                        msg += '  Use ESM `import ... from "three"` everywhere; never `require("three")` '
                            + '(CJS resolves to three.cjs) or `three/src/*`.';
                        compilation.errors.push(new Error('[DetectDuplicateThreeModules] ' + msg));
                    }

                    if (duplicates.length > 0) {
                        let msg = 'Duplicate Three.js modules detected (same file bundled more than once) — '
                            + 'this may cause prototype extensions to fail:\n';
                        duplicates.forEach(([p, identifiers]) => {
                            msg += `    • ${p}: ${identifiers.length} instances\n`;
                        });
                        msg += '  Ensure all Three.js imports use "three", not "three/src/*".';
                        compilation.errors.push(new Error('[DetectDuplicateThreeModules] ' + msg));
                    }
                });
            },
        },

        // CircularDependencyPlugin moved to individual webpack configs to avoid duplication

        // new WasmPackPlugin({
        //     crateDirectory: path.resolve(__dirname, 'rust'), // your Rust crate directory
        //     outDir: path.resolve(__dirname, 'pkg'),
        //     outName: 'eci_convert',
        //     forceMode: 'production', // or 'development'
        //     watchDirectories: [
        //         path.resolve(__dirname, 'rust/src'),
        //     ],
        // }),
    ],
    experiments: {
        topLevelAwait: true,
        asyncWebAssembly: true,
    },
    optimization: {
        minimizer: [
            new TerserPlugin({
                // Exclude files starting with "Sit" and ending with ".js".
                // Also exclude the standalone SHF (Starlink Horizon Flares) tool:
                // it is copied verbatim as native ES modules (import/export), which
                // Terser's script-mode parser can't minify ("Unexpected token: import").
                exclude: /(Sit.*|tools[\\/]shf[\\/].*)\.js$/,
                terserOptions: {
                    keep_classnames: true,
                    compress: {
                        pure_funcs: ['assert']
                    }
                },
            }),
        ],
    },
    performance: {
        maxAssetSize: 2000000,
        maxEntrypointSize: 5000000,
    },
    output: {
        filename: '[name].[contenthash].bundle.js',
        path: InstallPaths.dev_path,
        clean: {
            // preserve user uploads, cache, video symlink, and the read-only
            // terrain bind mount (used by the sandbox + Apache local dev)
            // across builds
            keep: /sitrec-upload|sitrec-cache|sitrec-videos|sitrec-terrain/,
        },
    },
});
