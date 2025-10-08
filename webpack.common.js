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

function getFormattedLocalDateTime() {
    const now = new Date();
    const year = String(now.getFullYear()).substring(2);
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');

    const gitTag = getVersionNumber();

    return `Sitrec ${gitTag}: ${year}-${month}-${day} ${hours}:${minutes} PT`;
}


console.log(getFormattedLocalDateTime());

module.exports = {

    entry: {
        index: './src/index.js',
    },
    target: 'web',
    externals: {
        'node:fs': 'commonjs2 fs',
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
        alias: {},
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
        }),
        new webpack.ProvidePlugin({
            Buffer: ['buffer', 'Buffer'],
        }),
        new CopyPlugin({
            patterns: [
                ...copyPatterns, // Existing patterns
                {
                    from: path.resolve(__dirname, 'docs'),
                    to: path.resolve(InstallPaths.dev_path, 'docs'),
                    globOptions: {
                        ignore: ['**/*.md'], // Ignore Markdown files here
                    },
                },
            ],
        }),
        {
            // Custom plugin for converting Markdown to HTML
            apply: (compiler) => {
                compiler.hooks.afterEmit.tapPromise('MarkdownToHtmlPlugin', async () => {
                    const docsDir = path.resolve(__dirname, 'docs');
                    const outputDir = path.resolve(InstallPaths.dev_path, 'docs');
                    const rootReadme = path.resolve(__dirname, 'README.md');
                    const outputRootReadme = path.resolve(InstallPaths.dev_path, 'README.html');

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
                                const markdownContent = await fs.promises.readFile(fullPath, 'utf-8');
                                const htmlContent = md.render(markdownContent);
                                await fs.promises.writeFile(outputPath, htmlContent, 'utf-8');
                            }
                        }
                    };

                    // Ensure output directory exists before converting
                    await fs.promises.mkdir(outputDir, { recursive: true });
                    
                    // Convert Markdown files in the `docs` directory
                    await convertMarkdownFiles(docsDir);

                    // Convert the root README.md file
                    if (fs.existsSync(rootReadme)) {
                        const readmeContent = await fs.promises.readFile(rootReadme, 'utf-8');
                        const htmlContent = md.render(readmeContent);
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
        }),

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
};
