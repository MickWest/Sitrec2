// Worktree-local preview with the full server build and an existing backend.
// Set SITREC_BACKEND_TARGET and, for saved scenes, SITREC_ASSET_TARGET.
// npx webpack serve --config webpack.local.js
const path = require('path');
const {createProxyMiddleware, responseInterceptor} = require('http-proxy-middleware');
const base = require('./webpack.dev.js');
const {buildFolder} = require('./config/config-install');

const prefix = '/' + buildFolder;
const target = process.env.SITREC_BACKEND_TARGET || 'http://localhost:8081';
const outputPath = path.resolve(__dirname, 'dist');
const assetTarget = process.env.SITREC_ASSET_TARGET;
const assetOrigin = assetTarget ? new URL(assetTarget).origin : null;

module.exports = {
    ...base,
    output: {...base.output, path: outputPath, publicPath: prefix + '/'},
    stats: 'errors-warnings',
    watchOptions: {poll: 1000, ignored: ['**/node_modules/**', '**/dist/**', '**/private/**', '**/.git/**']},
    devServer: {
        ...base.devServer,
        host: '127.0.0.1',
        allowedHosts: ['localhost', '127.0.0.1'],
        port: process.env.SITREC_PORT || 3009,
        hot: false,
        liveReload: false,
        static: {directory: outputPath, publicPath: prefix, watch: false},
        devMiddleware: {publicPath: prefix + '/'},
        historyApiFallback: false,
        // Backend routes must precede static serving: never send PHP source.
        setupMiddlewares(middlewares) {
            const backend = createProxyMiddleware({target, changeOrigin: true, secure: false});
            const resolver = assetOrigin && createProxyMiddleware({target, changeOrigin: true, secure: false,
                selfHandleResponse: true,
                on: {proxyRes: responseInterceptor(async buffer => {
                    try {
                        const result = JSON.parse(buffer.toString('utf8'));
                        if (typeof result.url === 'string') {
                            const url = new URL(result.url);
                            if (url.origin === assetOrigin) {
                                result.url = (url.pathname.endsWith('.js') ? '/__preview-sitches' : '/__preview-assets') + url.pathname + url.search;
                                return JSON.stringify(result);
                            }
                        }
                    } catch { /* Preserve backend errors and non-JSON responses. */ }
                    return buffer;
                })},
            });
            const sitches = assetTarget && createProxyMiddleware({target: assetTarget,
            changeOrigin: true, pathRewrite: {'^/__preview-sitches': ''}, selfHandleResponse: true,
            on: {proxyRes: responseInterceptor(async buffer => {
                // Saved scenes can retain absolute URLs from their previous
                // host. Remap exact asset URLs in JSON, not prose or arbitrary hosts.
                try {
                    const scene = JSON.parse(buffer.toString('utf8'), (key, value) => {
                        if (typeof value !== 'string' || !/^https?:\/\/\S+$/.test(value)) return value;
                        const url = new URL(value);
                        if (url.origin === new URL(target).origin) return url.pathname + url.search + url.hash;
                        if (url.origin === assetOrigin) return '/__preview-assets' + url.pathname + url.search + url.hash;
                        return value;
                    });
                    return JSON.stringify(scene);
                } catch { return buffer; }
            })},
        });
            middlewares.unshift({name: 'local-backend', middleware(req, res, next) {
                const pathname = req.url.split('?')[0];
                if (pathname === '/') {
                    res.writeHead(302, {Location: prefix + '/'});
                    return res.end();
                }
                if (sitches && pathname.startsWith('/__preview-sitches/')) return sitches(req, res, next);
                if (resolver && pathname === prefix + '/sitrecServer/object.php')
                    return resolver(req, res, next);
                if (pathname.startsWith(prefix + '/sitrecServer/') || pathname.startsWith('/sitrecServer/'))
                    return backend(req, res, next);
                // PHP outside the supported backend prefix is never static content.
                let decodedPath;
                try { decodedPath = decodeURIComponent(pathname); } catch {
                    res.writeHead(400);
                    return res.end();
                }
                if (/\.php(?:\/|$)/i.test(decodedPath)) {
                    res.writeHead(404);
                    return res.end();
                }
                next();
            }});
            return middlewares;
        },
        proxy: [...(assetTarget ? [{context: ['/__preview-assets'], target: assetTarget,
            changeOrigin: true, pathRewrite: {'^/__preview-assets': ''}}] : []), {context: ['/sitrec-videos', '/sitrec-cache', '/sitrec-terrain', '/sitrec-upload'],
            target, changeOrigin: true, secure: false}],
    },
};
