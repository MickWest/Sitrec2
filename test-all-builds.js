#!/usr/bin/env node

/**
 * Test All Build Configurations
 * 
 * Tests each build configuration by:
 * 1. Running the build
 * 2. Starting the appropriate server
 * 3. Using Playwright to verify the default URL loads successfully
 * 4. Checking for "No pending actions" console message
 * 
 * Usage:
 *   node test-all-builds.js [--quick] [--config=<name>]
 * 
 * Options:
 *   --quick         Skip builds, only test existing builds
 *   --config=<name> Only test specific config (dev, prod, standalone, serverless, secure)
 */

import {exec, spawn} from 'child_process';
import {chromium} from 'playwright';
import {fileURLToPath} from 'url';
import {dirname, resolve} from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BUILD_CONFIGS = [
    {
        name: 'dev',
        buildCmd: 'npm run build',
        distDir: 'dist',
        server: null,
        url: 'https://local.metabunk.org/sitrec/',
        description: 'Development build (requires local Apache/nginx)'
    },
    {
        name: 'prod',
        buildCmd: 'npm run deploy',
        distDir: 'dist',
        server: null,
        url: 'https://local.metabunk.org/sitrec/',
        description: 'Production build (requires local Apache/nginx)'
    },
    {
        name: 'standalone',
        buildCmd: 'npm run build-standalone',
        distDir: 'dist-standalone',
        server: 'node standalone-server.js',
        serverPort: 3000,
        url: 'http://localhost:3000/sitrec/',
        description: 'Standalone build (includes PHP backend)',
        requiresPhp: true
    },
    {
        name: 'serverless',
        buildCmd: 'npm run build-serverless',
        distDir: 'dist-serverless',
        server: 'node standalone-serverless.js',
        serverPort: 3000,
        url: 'http://localhost:3000/sitrec/',
        description: 'Serverless build (no PHP required)'
    },
    {
        name: 'secure',
        buildCmd: 'npm run build-secure',
        distDir: 'dist-secure',
        // standalone-server.js serves dist-standalone only (its DIST_DIR is fixed), so the
        // secure build is served by PHP's built-in server straight from its own directory:
        // sitrecServer/*.php run in place and everything else is served as static files.
        // "localhost:" in its startup line is what startServer() waits for.
        server: 'php -S localhost:3000 -t dist-secure',
        serverPort: 3000,
        url: 'http://localhost:3000/',
        description: 'Secure build (production server build, outbound features removed)',
        requiresPhp: true
    }
];

const COLORS = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

function log(msg, color = 'reset') {
    console.log(`${COLORS[color]}${msg}${COLORS.reset}`);
}

function logHeader(msg) {
    console.log('\n' + '='.repeat(60));
    log(msg, 'cyan');
    console.log('='.repeat(60));
}

function logSuccess(msg) {
    log(`✅ ${msg}`, 'green');
}

function logError(msg) {
    log(`❌ ${msg}`, 'red');
}

function logWarning(msg) {
    log(`⚠️  ${msg}`, 'yellow');
}

function logInfo(msg) {
    log(`ℹ️  ${msg}`, 'blue');
}

function runCommand(cmd, cwd = __dirname) {
    return new Promise((resolve, reject) => {
        log(`Running: ${cmd}`, 'blue');
        const proc = spawn('sh', ['-c', cmd], {
            cwd,
            stdio: 'inherit',
            env: { ...process.env, FORCE_COLOR: '1' }
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command failed with code ${code}: ${cmd}`));
            }
        });

        proc.on('error', reject);
    });
}

function startServer(cmd, port, cwd = __dirname) {
    return new Promise((resolve, reject) => {
        log(`Starting server: ${cmd}`, 'blue');

        const proc = spawn('sh', ['-c', cmd], {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, SITREC_PORT: port.toString() }
        });

        let serverReady = false;
        const timeout = setTimeout(() => {
            if (!serverReady) {
                logWarning('Server startup timeout, assuming ready...');
                resolve(proc);
            }
        }, 15000);

        const checkOutput = (data) => {
            const text = data.toString();
            process.stdout.write(text);
            if (text.includes('localhost:') || text.includes('running') || text.includes('Frontend:')) {
                serverReady = true;
                clearTimeout(timeout);
                setTimeout(() => resolve(proc), 1000);
            }
        };

        proc.stdout.on('data', checkOutput);
        proc.stderr.on('data', checkOutput);

        proc.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });

        proc.on('close', (code) => {
            if (!serverReady) {
                clearTimeout(timeout);
                reject(new Error(`Server exited with code ${code}`));
            }
        });
    });
}

function killServer(proc) {
    return new Promise((resolve) => {
        if (!proc) {
            resolve();
            return;
        }

        log('Stopping server...', 'blue');
        proc.kill('SIGTERM');

        const timeout = setTimeout(() => {
            proc.kill('SIGKILL');
            resolve();
        }, 5000);

        proc.on('close', () => {
            clearTimeout(timeout);
            resolve();
        });
    });
}

function killPortProcesses(port) {
    return new Promise((resolve) => {
        exec(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, () => {
            setTimeout(resolve, 500);
        });
    });
}

async function waitForConsoleText(page, expectedText, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Timed out waiting for console text: "${expectedText}"`));
        }, timeoutMs);

        const handler = (msg) => {
            if (msg.text().includes(expectedText)) {
                clearTimeout(timeout);
                page.off('console', handler);
                resolve();
            }
        };

        page.on('console', handler);
    });
}

async function testPageLoad(url, configName) {
    logInfo(`Testing page load: ${url}`);

    const browser = await chromium.launch({
        headless: true,
        args: [
            '--use-gl=swiftshader',
            '--ignore-gpu-blocklist',
            '--enable-webgl',
            '--ignore-certificate-errors'
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        ignoreHTTPSErrors: true
    });

    const page = await context.newPage();
    let consoleMessages = [];
    let errors = [];

    page.on('console', (msg) => {
        const text = msg.text();
        consoleMessages.push(`[${msg.type()}] ${text}`);
        if (msg.type() === 'log') {
            console.log(`  [PAGE] ${text}`);
        }
    });

    page.on('pageerror', (err) => {
        errors.push(err.message);
        logError(`  Page error: ${err.message}`);
    });

    try {
        const testUrl = url + '?frame=10&ignoreunload=1&regression=1';
        log(`  Loading: ${testUrl}`, 'blue');

        const consolePromise = waitForConsoleText(page, 'No pending actions', 60000);

        const response = await page.goto(testUrl, {
            waitUntil: 'load',
            timeout: 30000
        });

        if (!response.ok()) {
            throw new Error(`Page load failed with status: ${response.status()}`);
        }

        await consolePromise;

        await page.evaluate(() => {
            return new Promise((resolve) => {
                let frameCount = 0;
                function waitForFrames() {
                    frameCount++;
                    if (frameCount < 3) {
                        requestAnimationFrame(waitForFrames);
                    } else {
                        resolve();
                    }
                }
                requestAnimationFrame(waitForFrames);
            });
        });

        await browser.close();

        if (errors.length > 0) {
            logWarning(`  Page loaded with ${errors.length} error(s)`);
            return { success: true, warnings: errors };
        }

        return { success: true };

    } catch (error) {
        await browser.close();
        return { success: false, error: error.message };
    }
}

async function testConfig(config, skipBuild = false) {
    logHeader(`Testing: ${config.name} - ${config.description}`);

    const distPath = resolve(__dirname, config.distDir);
    let serverProc = null;

    try {
        if (!skipBuild) {
            await runCommand(config.buildCmd);
            logSuccess(`Build completed: ${config.buildCmd}`);
        } else {
            if (!fs.existsSync(distPath)) {
                logError(`Build directory not found: ${distPath}`);
                return { config: config.name, success: false, error: 'Build directory not found' };
            }
            logInfo(`Skipping build, using existing: ${distPath}`);
        }

        if (config.server) {
            if (config.requiresPhp) {
                try {
                    await runCommand('php -v > /dev/null 2>&1');
                } catch {
                    logWarning(`PHP not available, skipping ${config.name} test`);
                    return { config: config.name, success: true, skipped: true, reason: 'PHP not available' };
                }
            }

            await killPortProcesses(config.serverPort);
            serverProc = await startServer(config.server, config.serverPort);
            logSuccess('Server started');
        }

        const result = await testPageLoad(config.url, config.name);

        if (result.success) {
            logSuccess(`Page load test passed for ${config.name}`);
            return { config: config.name, success: true, warnings: result.warnings };
        } else {
            logError(`Page load test failed for ${config.name}: ${result.error}`);
            return { config: config.name, success: false, error: result.error };
        }

    } catch (error) {
        logError(`Test failed for ${config.name}: ${error.message}`);
        return { config: config.name, success: false, error: error.message };

    } finally {
        if (serverProc) {
            await killServer(serverProc);
            await killPortProcesses(config.serverPort);
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    const skipBuild = args.includes('--quick');
    const configFilter = args.find(a => a.startsWith('--config='))?.split('=')[1];

    console.log('\n' + '='.repeat(60));
    log('🧪 Sitrec Build Configuration Tester', 'cyan');
    console.log('='.repeat(60));

    if (skipBuild) {
        logWarning('Quick mode: skipping builds');
    }

    let configs = BUILD_CONFIGS;
    if (configFilter) {
        configs = BUILD_CONFIGS.filter(c => c.name === configFilter);
        if (configs.length === 0) {
            logError(`Unknown config: ${configFilter}`);
            logInfo(`Available: ${BUILD_CONFIGS.map(c => c.name).join(', ')}`);
            process.exit(1);
        }
        logInfo(`Testing only: ${configFilter}`);
    }

    const results = [];
    for (const config of configs) {
        const result = await testConfig(config, skipBuild);
        results.push(result);
    }

    console.log('\n' + '='.repeat(60));
    log('📊 Test Results Summary', 'cyan');
    console.log('='.repeat(60) + '\n');

    let passed = 0;
    let failed = 0;
    let skipped = 0;

    for (const result of results) {
        if (result.skipped) {
            logWarning(`${result.config}: SKIPPED (${result.reason})`);
            skipped++;
        } else if (result.success) {
            logSuccess(`${result.config}: PASSED`);
            if (result.warnings) {
                logWarning(`  (with ${result.warnings.length} warning(s))`);
            }
            passed++;
        } else {
            logError(`${result.config}: FAILED - ${result.error}`);
            failed++;
        }
    }

    console.log('\n' + '-'.repeat(40));
    log(`Passed: ${passed}  Failed: ${failed}  Skipped: ${skipped}`, failed > 0 ? 'red' : 'green');

    if (failed > 0) {
        process.exit(1);
    }
}

main().catch((error) => {
    logError(`Unexpected error: ${error.message}`);
    console.error(error);
    process.exit(1);
});
