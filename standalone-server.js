#!/usr/bin/env node

const express = require('express');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

const app = express();

// Apply rate limiting to all routes
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // generous limit for local dev server
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// Response headers that cannot break anything, set on every response.
//
// Deliberately only two. `nosniff` stops a browser second-guessing a declared
// Content-Type, which matters here because Sitrec serves user-supplied files back
// to the page. The referrer policy is already Chrome's default, so it changes
// nothing there and improves browsers that still send a full URL cross-origin —
// and Sitrec URLs carry the sitch and often a position in their query string.
//
// The headers NOT set here — Content-Security-Policy, Strict-Transport-Security,
// X-Frame-Options/frame-ancestors and Permissions-Policy — each need a decision
// this server cannot make for the operator, and two of them would break features
// outright: Sitrec uses geolocation (src/GeoLocation.js) and device orientation
// (src/ARMode.js), so a restrictive Permissions-Policy disables AR mode and
// "use my location". See docs/dev/SecurityHeaders.md for what to set and why.
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});
const PORT = process.env.SITREC_PORT || process.env.PORT || 3000;
const PHP_PORT = process.env.SITREC_PHP_PORT || process.env.PHP_PORT || 8000;
const DIST_DIR = path.resolve(__dirname, 'dist-standalone');

let phpServer = null;

// Start PHP built-in server for the sitrecServer directory
function startPhpServer() {
    return new Promise((resolve, reject) => {
        console.log(`Starting PHP server on port ${PHP_PORT}...`);
        
        phpServer = spawn('php', ['-S', `localhost:${PHP_PORT}`, '-t', path.resolve(DIST_DIR, 'sitrecServer')], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let serverStarted = false;

        phpServer.stdout.on('data', (data) => {
            const message = data.toString();
            console.log(`PHP Server: ${message.trim()}`);
            
            // Check if server started successfully
            if (message.includes('Development Server') && message.includes('started')) {
                serverStarted = true;
                resolve();
            }
        });

        phpServer.stderr.on('data', (data) => {
            const message = data.toString();
            console.log(`PHP Server: ${message.trim()}`);
            
            // Handle port already in use
            if (message.includes('Address already in use')) {
                console.error(`❌ Port ${PHP_PORT} is already in use. Please:`);
                console.error(`   1. Stop any existing PHP server on port ${PHP_PORT}`);
                console.error(`   2. Or use a different port: SITREC_PHP_PORT=8001 npm run start-standalone`);
                reject(new Error(`Port ${PHP_PORT} is already in use`));
                return;
            }
            
            // Check if server started successfully (some messages go to stderr)
            if (message.includes('Development Server') && message.includes('started')) {
                serverStarted = true;
                resolve();
            }
        });

        phpServer.on('error', (error) => {
            console.error('❌ Failed to start PHP server:', error.message);
            if (error.code === 'ENOENT') {
                console.error('   PHP is not installed or not in PATH');
                console.error('   Please install PHP to run the backend server');
            }
            reject(error);
        });

        phpServer.on('close', (code) => {
            if (code !== 0 && !serverStarted) {
                console.log(`❌ PHP server failed to start (exit code ${code})`);
                reject(new Error(`PHP server exited with code ${code}`));
            } else {
                console.log(`PHP server stopped (exit code ${code})`);
            }
        });

        // Give PHP server a moment to start, then resolve if no errors
        setTimeout(() => {
            if (!serverStarted) {
                console.log('⚠️  PHP server status unclear, continuing anyway...');
                resolve();
            }
        }, 3000);
    });
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down servers...');
    if (phpServer) {
        phpServer.kill();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nShutting down servers...');
    if (phpServer) {
        phpServer.kill();
    }
    process.exit(0);
});

async function startServer() {
    try {
        // Check if dist directory exists
        if (!fs.existsSync(DIST_DIR)) {
            console.error(`Build directory ${DIST_DIR} does not exist. Please run the build first.`);
            process.exit(1);
        }

        // Start PHP server
        await startPhpServer();

        // Proxy PHP requests to the PHP server
        app.use('/sitrec/sitRecServer', createProxyMiddleware({
            target: `http://localhost:${PHP_PORT}`,
            changeOrigin: true,
            pathRewrite: {
                '^/sitrec/sitRecServer': ''
            },
            onError: (err, req, res) => {
                console.error('Proxy error:', err);
                res.status(500).send('PHP server error');
            }
        }));

        // Proxy video and cache directories (these might be served by your local Apache/Nginx)
        app.use('/sitrec-videos', createProxyMiddleware({
            target: 'http://localhost',
            changeOrigin: true,
            onError: (err, req, res) => {
                console.log('Video proxy error (this is normal if you don\'t have a local web server):', err.message);
                res.status(404).send('Video not found');
            }
        }));

        app.use('/sitrec-cache', createProxyMiddleware({
            target: 'http://localhost',
            changeOrigin: true,
            onError: (err, req, res) => {
                console.log('Cache proxy error (this is normal if you don\'t have a local web server):', err.message);
                res.status(404).send('Cache not found');
            }
        }));

        app.use('/sitrec-terrain', createProxyMiddleware({
            target: 'http://localhost',
            changeOrigin: true,
            onError: (err, req, res) => {
                console.log('Terrain proxy error (this is normal if you don\'t have a local web server):', err.message);
                res.status(404).send('Terrain not found');
            }
        }));

        // SAM2 tracking service proxy (local dev only)
        const SAM2_PORT = process.env.SAM2_PORT || 8001;
        app.use('/sam2', createProxyMiddleware({
            target: `http://127.0.0.1:${SAM2_PORT}`,
            changeOrigin: true,
            pathRewrite: { '^/sam2': '' },
            timeout: 300000,        // 5 min timeout for long tracking jobs
            proxyTimeout: 300000,
            onError: (err, req, res) => {
                console.log('SAM2 proxy error (start sam2-service if needed):', err.message);
                res.status(503).json({ error: 'SAM2 service unavailable. Start it with: cd sam2-service && ./start.sh' });
            }
        }));

        // Enable debugging features
        if (process.env.NODE_ENV !== 'production') {
            // Log all requests for debugging
            app.use((req, res, next) => {
                console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
                next();
            });
        }

        // Serve static files from the build directory with proper headers for debugging
        app.use('/sitrec', express.static(DIST_DIR, {
            // Enable source map support
            setHeaders: (res, path) => {
                if (path.endsWith('.js')) {
                    res.setHeader('Cache-Control', 'no-cache'); // Don't cache JS files during development
                }
                if (path.endsWith('.map')) {
                    res.setHeader('Content-Type', 'application/json');
                }
            }
        }));

        // Debug endpoint to list available files
        app.get('/debug/files', (req, res) => {
            const fs = require('fs');
            const path = require('path');
            
            function getFiles(dir, fileList = []) {
                const files = fs.readdirSync(dir);
                files.forEach(file => {
                    const filePath = path.join(dir, file);
                    if (fs.statSync(filePath).isDirectory()) {
                        getFiles(filePath, fileList);
                    } else {
                        fileList.push(path.relative(DIST_DIR, filePath));
                    }
                });
                return fileList;
            }
            
            try {
                const files = getFiles(DIST_DIR);
                res.json({
                    buildDir: DIST_DIR,
                    files: files.sort()
                });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Debug endpoint for server status
        app.get('/debug/status', (req, res) => {
            res.json({
                timestamp: new Date().toISOString(),
                frontend: {
                    port: PORT,
                    buildDir: DIST_DIR,
                    buildExists: fs.existsSync(DIST_DIR)
                },
                backend: {
                    port: PHP_PORT,
                    running: phpServer && !phpServer.killed
                },
                environment: {
                    nodeVersion: process.version,
                    platform: process.platform,
                    cwd: process.cwd()
                }
            });
        });

        // Redirect root to /sitrec
        app.get('/', (req, res) => {
            res.redirect('/sitrec');
        });

        // Start the Express server
        app.listen(PORT, () => {
            console.log(`\n🚀 Sitrec standalone server is running!`);
            console.log(`📱 Frontend: http://localhost:${PORT}/sitrec`);
            console.log(`🐘 PHP Backend: http://localhost:${PHP_PORT}`);
            console.log(`\nPress Ctrl+C to stop the server`);
        });

    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer();