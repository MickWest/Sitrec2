const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const copyPatterns = require('./webpackCopyPatterns');
const InstallPaths = require('./config/config-install'); // Import paths configuration

// This config does NOT go through webpack.common.js, but it still copies
// config/shared.env into shared.env.php — so it needs the same freshness gate,
// or `npm run copy` would quietly deploy a stale config.
require('./scripts/sharedEnvVersion').checkOrExit();

module.exports = {
    mode: 'none', // No optimization needed for copying
    entry: {}, // No entry point required
    output: {
        path: InstallPaths.dev_path, // Output directory
        filename: '[name].js', // Placeholder filename
        clean: false, // Do not clean output directory
    },
    plugins: [
        new CopyPlugin({
            patterns: copyPatterns, // Use shared patterns
        }),
    ],
};