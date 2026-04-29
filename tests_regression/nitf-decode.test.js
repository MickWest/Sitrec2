/**
 * NITF Decode Regression Tests
 *
 * End-to-end tests that load NITF files through the full Sitrec UI
 * (browser Image API for JPEG, OpenJPEG WASM for J2K) and verify the
 * file was actually decoded by inspecting FileManager for the decoded
 * image entry. The sitch produced here only registers the NITF in
 * `files:` — nothing renders the decoded pixels — so a screenshot
 * comparison would only assert that Sitrec's chrome is unchanged.
 * Instead we probe `window.FileManager.list` for the virtual image
 * file the parser creates (`<filename>_image_<i>.jpg`) and check that
 * its parsed Image has positive dimensions.
 *
 * Requires test files in ../../nitf-test-files/ (outside repo).
 * A local HTTP server is started on port 9782 to serve the files.
 */
import {test, expect} from '@playwright/test';
import http from 'http';
import fs from 'fs';
import path from 'path';

const NITF_DIR = path.resolve(__dirname, '../../nitf-test-files');
const PORT = 9782;
const hasTestFiles = fs.existsSync(NITF_DIR);

// ── Test case definitions ─────────────────────────────────────
const nitfTests = [
    {
        id: 'nitf-nc',
        name: 'NC uncompressed',
        file: 'JitcNitf21Samples/i_3001a.ntf',
    },
    {
        id: 'nitf-c3',
        name: 'C3 JPEG',
        file: 'i_3008a.ntf', // in root from Wayback download
    },
    {
        id: 'nitf-c8',
        name: 'C8 JPEG 2000',
        file: 'JitcJpeg2000/p0_04b.ntf',
    },
    {
        id: 'nitf-nsif',
        name: 'NSIF file',
        file: 'JitcNitf21Samples/ns3004f.nsf',
    },
];

// ── Static file server with dynamic sitch generation ──────────
function createRequestHandler(port) {
    return (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // Strip query string (Sitrec appends ?v=hash for cache busting)
        const url = decodeURIComponent(req.url).split('?')[0];

        // Dynamic sitch generation: /sitch/<id>.js
        const sitchMatch = url.match(/^\/sitch\/(.+)\.js$/);
        if (sitchMatch) {
            const testId = sitchMatch[1];
            const testCase = nitfTests.find(t => t.id === testId);
            if (testCase) {
                const nitfUrl = `http://localhost:${port}/${testCase.file}`;
                const fileName = path.basename(testCase.file);
                const sitchJs = `sitch = {
    name: "${testCase.id}",
    fps: 30,
    frames: 30,
    files: {
        "${fileName}": "${nitfUrl}"
    }
}`;
                res.writeHead(200, {'Content-Type': 'application/javascript'});
                res.end(sitchJs);
                return;
            }
        }

        // Static file serving from nitf-test-files directory
        const filePath = path.join(NITF_DIR, url);
        if (!filePath.startsWith(NITF_DIR)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            res.writeHead(404);
            res.end('Not found: ' + url);
            return;
        }

        res.writeHead(200, {'Content-Type': 'application/octet-stream'});
        fs.createReadStream(filePath).pipe(res);
    };
}

function startFileServer(port) {
    return new Promise((resolve) => {
        const server = http.createServer(createRequestHandler(port));

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                // Another worker already started the server — that's fine
                console.log(`[NITF] Port ${port} already in use (another worker owns it)`);
                resolve(null);
            } else {
                throw err;
            }
        });
        server.listen(port, () => resolve(server));
    });
}

// ── Scene settle helpers (from regression.test.js) ────────────
async function waitForFrames(page, count = 1, maxWaitMs = 5000) {
    const targetMs = Math.max(1, count) * 16;
    await page.waitForTimeout(Math.min(maxWaitMs, targetMs));
}

async function getSceneSettleState(page) {
    return page.evaluate(() => {
        const globals = window.Globals;
        const nodeMan = window.NodeMan;

        const state = {
            ready: !!globals && !!nodeMan && !!nodeMan.list,
            pendingActions: 0,
            deserializing: false,
            parsing: 0,
            loadingVisible: false,
        };

        if (!state.ready) return state;

        state.pendingActions = globals.pendingActions ?? 0;
        state.deserializing = !!globals.deserializing;
        state.parsing = globals.parsing ?? 0;

        const loadingDiv = document.getElementById("loadingIndicator");
        state.loadingVisible = !!loadingDiv
            && loadingDiv.style.display !== "none"
            && (loadingDiv.textContent || "").includes("Loading");

        return state;
    });
}

function isScenePending(state) {
    if (!state.ready) return true;
    return state.pendingActions > 0
        || state.deserializing
        || state.parsing > 0
        || state.loadingVisible;
}

async function waitForSceneToSettle(page, maxWaitMs = 90000) {
    const startMs = Date.now();
    let stableCount = 0;
    let observedBusy = false;

    while (Date.now() - startMs < maxWaitMs) {
        const state = await getSceneSettleState(page);
        const pending = isScenePending(state);

        if (pending) {
            observedBusy = true;
            stableCount = 0;
        } else {
            stableCount++;
            const elapsedMs = Date.now() - startMs;
            if ((observedBusy || elapsedMs >= 3000) && stableCount >= 20) {
                return;
            }
        }
        await waitForFrames(page, 2);
    }
    console.warn(`[NITF-SETTLE] Timeout after ${maxWaitMs}ms`);
}

async function waitForConsoleText(page, expectedText, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Timed out waiting for console text: "${expectedText}"`));
        }, timeoutMs);

        const handler = (msg) => {
            if (msg.text().includes(expectedText)) {
                clearTimeout(timeout);
                page.removeListener('console', handler);
                resolve();
            }
        };
        page.on('console', handler);
    });
}

// ── Tests ─────────────────────────────────────────────────────
// Allow mixed content: the app is served over HTTPS but our test
// file server runs on http://localhost. Without this flag, the
// browser blocks the fetch as insecure mixed content.
test.use({
    launchOptions: {
        args: [
            '--use-angle=swiftshader',
            '--ignore-gpu-blocklist',
            '--enable-webgl',
            '--enable-unsafe-swiftshader',
            '--allow-running-insecure-content',
        ],
    },
});

test.describe('NITF Decode Visual Regression', () => {
    let server;

    test.beforeAll(async () => {
        if (!hasTestFiles) return;
        server = await startFileServer(PORT);
        console.log(`[NITF] File server started on port ${PORT}`);
    });

    test.afterAll(async () => {
        if (server) {
            await new Promise(resolve => server.close(resolve));
            console.log('[NITF] File server stopped');
        }
    });

    for (const tc of nitfTests) {
        test(`should decode ${tc.name}`, async ({page}, testInfo) => {
            test.skip(!hasTestFiles, 'NITF test files not found at ' + NITF_DIR);

            // Check the specific test file exists
            const filePath = path.join(NITF_DIR, tc.file);
            test.skip(!fs.existsSync(filePath), `Test file not found: ${tc.file}`);

            test.setTimeout(120000);
            await page.setViewportSize({width: 1920, height: 1080});

            // Log console output for debugging
            page.on('console', msg => {
                console.log(`[NITF:${tc.id}] [${msg.type()}] ${msg.text()}`);
            });

            const sitchUrl = `http://localhost:${PORT}/sitch/${tc.id}.js`;
            const fullUrl = `?custom=${encodeURIComponent(sitchUrl)}&ignoreunload=1&regression=1`;

            const consolePromise = waitForConsoleText(page, 'No pending actions', 60000);

            await page.goto(fullUrl, {
                waitUntil: 'load',
                timeout: 30000,
            });

            await consolePromise;
            await waitForSceneToSettle(page);
            await waitForFrames(page, 5);

            // Probe the FileManager for the decoded image. The Sit.files
            // load path goes through CFileManager.loadAsset, which collapses
            // the parser's multi-entry result down to just the first entry
            // and registers it under the original sitch-supplied id (the
            // file's basename). So the parsed Image lives at
            // `FileManager.list[<basename>].data`, with dataType "image".
            // (Drag-drop uses a different path that produces virtual
            // `<name>_image_<i>.jpg` keys — irrelevant here.)
            // Image isn't structured-cloneable, so we project just the
            // fields we'll assert on.
            const sourceFilename = path.basename(tc.file);
            const probe = await page.evaluate((srcName) => {
                const list = window.FileManager && window.FileManager.list;
                if (!list) return {error: 'FileManager not exposed on window'};
                const entry = list[srcName];
                const img = entry && entry.data;
                return {
                    found: !!entry,
                    dataType: entry && entry.dataType,
                    hasImage: !!img,
                    naturalWidth: (img && img.naturalWidth) || 0,
                    naturalHeight: (img && img.naturalHeight) || 0,
                    complete: !!(img && img.complete),
                    allKeys: Object.keys(list),
                };
            }, sourceFilename);

            // Stuff the full probe into each assertion message — when one
            // bursts, the failure tells you exactly what shape the entry
            // actually had (missing entry vs wrong dataType vs zero dims
            // vs decode-not-finished), not just "expected X to equal Y".
            const diag = JSON.stringify(probe, null, 2);
            expect(probe.error, `probe error\n${diag}`).toBeUndefined();
            expect(probe.found, `no FileManager entry for ${sourceFilename}\n${diag}`).toBe(true);
            expect(probe.dataType, `wrong dataType\n${diag}`).toBe('image');
            expect(probe.hasImage, `parsed Image missing\n${diag}`).toBe(true);
            expect(probe.complete, `Image.complete is false (decode never finished)\n${diag}`).toBe(true);
            expect(probe.naturalWidth, `naturalWidth is 0\n${diag}`).toBeGreaterThan(0);
            expect(probe.naturalHeight, `naturalHeight is 0\n${diag}`).toBeGreaterThan(0);

            console.log(`[NITF:${tc.id}] decoded ${sourceFilename}: ${probe.naturalWidth}x${probe.naturalHeight}`);
        });
    }
});
