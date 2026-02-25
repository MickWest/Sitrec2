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

    const gitTag = getVersionNumber();
    return `Sitrec ${gitTag}: ${year}-${month}-${day} ${hours}:${minutes} PT`;
}


console.log(getFormattedLocalDateTime());

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
                test: /\.css$/,
                use: [
                    MiniCssExtractPlugin.loader,
                    'css-loader',
                ],
            },
        ],
    },
    resolve: {
        extensions: ['.js'],
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
                'apple-touch-icon': {
                    rel: 'apple-touch-icon',
                    sizes: '180x180',
                    href: '/apple-touch-icon.png'
                },
                'favicon-32': {
                    rel: 'icon',
                    type: 'image/png',
                    sizes: '32x32',
                    href: '/favicon-32x32.png'
                },
                'favicon-16': {
                    rel: 'icon',
                    type: 'image/png',
                    sizes: '16x16',
                    href: '/favicon-16x16.png'
                },
                'manifest': {
                    rel: 'manifest',
                    href: '/site.webmanifest'
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

                    const convertMarkdownFiles = async (dir) => {
                        const files = await fs.promises.readdir(dir, { withFileTypes: true });

                        for (const file of files) {
                            const fullPath = path.join(dir, file.name);
                            const relativePath = path.relative(docsDir, fullPath);
                            const outputPath = path.join(outputDir, relativePath.replace(/\.md$/, '.html'));

                            if (file.isDirectory()) {
                                await fs.promises.mkdir(path.join(outputDir, relativePath), { recursive: true });
                                await convertMarkdownFiles(fullPath);
                            } else if (file.name.endsWith('.md')) {
                                let markdownContent = await fs.promises.readFile(fullPath, 'utf-8');
                                markdownContent = markdownContent.replace(/<!--[\s\S]*?-->/g, '');
                                markdownContent = markdownContent.replace(/(\[.*?\]\((?:\.\/)?(?:docs\/)?)(.*?)(\.md\))/g, '$1$2.html)');
                                const bodyContent = md.render(markdownContent);
                                
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
                        readmeContent = readmeContent.replace(/(\[.*?\]\((?:\.\/)?(?:docs\/)?)(.*?)(\.md\))/g, '$1$2.html)');
                        const bodyContent = md.render(readmeContent);
                        
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
            'process.env.BUILD_VERSION_STRING': JSON.stringify(getFormattedLocalDateTime()),
            'process.env.BUILD_VERSION_NUMBER': JSON.stringify(getVersionNumber()),
            'process.env.DOCKER_BUILD': JSON.stringify(process.env.DOCKER_BUILD === 'true'),
            'CAN_REQUIRE_CONTEXT': JSON.stringify(true),
            'INCLUDE_IWER_EMULATOR': JSON.stringify(env.includeIWER !== false),
        }),

        {
            apply: (compiler) => {
                compiler.hooks.emit.tap('DetectDuplicateThreeModules', (compilation) => {
                    const threeModules = new Map();
                    
                    for (const module of compilation.modules) {
                        if (!module.resource) continue;
                        
                        if (module.resource.includes('node_modules/three/')) {
                            const relativePath = module.resource.substring(
                                module.resource.indexOf('node_modules/three/')
                            );
                            
                            if (!threeModules.has(relativePath)) {
                                threeModules.set(relativePath, []);
                            }
                            threeModules.get(relativePath).push(module.identifier());
                        }
                    }
                    
                    const duplicates = Array.from(threeModules.entries())
                        .filter(([, identifiers]) => identifiers.length > 1);
                    
                    if (duplicates.length > 0) {
                        console.error('\n⚠️  WARNING: Duplicate Three.js modules detected!\n');
                        duplicates.forEach(([path, identifiers]) => {
                            console.error(`  ${path}: ${identifiers.length} instances`);
                        });
                        console.error('\n  This may cause prototype extensions to fail.');
                        console.error('  Ensure all Three.js imports use "three" not "three/src/*"\n');
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
                // exclude files starting with "Sit" and ending with ".js"
                exclude: /Sit.*\.js$/,
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
        clean: true, // this deletes the contents of path (InstallPaths.dev_path)
    },
});
