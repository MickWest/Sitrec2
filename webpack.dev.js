const { merge } = require('webpack-merge');
const common = require('./webpack.common.js');
const InstallPaths = require('./config/config-install');

module.exports = merge(common, {
    mode: 'development',
    devtool: 'inline-source-map',
    devServer: {
        static: {
            directory: InstallPaths.dev_path,
            publicPath: '/sitrec', // Public path to access the static files
        },
        hot: true,
        open: false, // Don't auto-open browser in Docker
        host: '0.0.0.0', // Allow external connections (needed for Docker)
        port: 8080,
        historyApiFallback: {
            rewrites: [
                // Don't rewrite API requests
                { from: /^\/sitrecServer/, to: context => context.parsedUrl.pathname },
                { from: /^\/sitrec-videos/, to: context => context.parsedUrl.pathname },
                { from: /^\/sitrec-cache/, to: context => context.parsedUrl.pathname },
            ]
        },
        allowedHosts: 'all', // Allow connections from any host
        proxy: [
            {
                context: ['/sitrecServer/**'], // paths to proxy - use ** to match all subpaths
                target: 'http://localhost:8081', // Proxy to Apache in Docker
                changeOrigin: true,
                secure: false,
                logLevel: 'debug',
            },
            {
                context: ['/sitrec-videos'],
                target: 'http://localhost:8081',
                changeOrigin: true,
                secure: false,
            },
            {
                context: ['/sitrec-cache'],
                target: 'http://localhost:8081',
                changeOrigin: true,
                secure: false,
            },
        ],
    },
});
