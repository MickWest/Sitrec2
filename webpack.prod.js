const { merge } = require('webpack-merge');
const common = require('./webpack.common.js');
const path = require("path");
// prod_path from config/config-install.js, or SITREC_PROD_PATH when building for another
// deployment (see scripts/buildTarget.js).
const prodPath = require("./scripts/buildTarget").prodPath();
if (!prodPath) {
    throw new Error("No production output path: set prod_path in config/config-install.js or SITREC_PROD_PATH");
}

module.exports = merge(common({ includeIWER: false }), {
    mode: 'production',

    output: {
        filename: '[name].[contenthash].bundle.js', // each entry translates into one of these bundles
        path: prodPath,
        clean: true, // this deletes the contents of path (dist)
    },

});