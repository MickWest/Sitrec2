import {test} from '@playwright/test';
import {takeScreenshotOrCompare} from './snapshot-utils.js';
import {PNG} from 'pngjs';

// Array of test cases: each object contains a name and its corresponding URL.
// URLs are relative to baseURL configured in playwright.config.js
//
// To add a new visual regression test:
//   1. Add an entry here with { id, name, url } (and optional timeout, waitFor)
//   2. Add a matching entry in test-registry.js with { id, name, group, file, grep, snapshot, url }
//      - grep must match the test description: "should match the baseline screenshot for <name>"
//      - snapshot should be "<name>-snapshot" (matching the takeScreenshotOrCompare call below)
//   3. Run `npm run test-ui` (or test-viewer) once to generate the baseline screenshot
//      - Baseline saved to: tests_regression/regression.test.js-snapshots/<name>-snapshot-chromium-darwin.png
//   4. Verify the baseline visually, then commit it alongside the test entries
//
const testDataDefault = [
    { id: "testquick", name: "testquick", url: "?testAll=2", waitFor: "All tests complete"},
    { id: 'default', name: 'default', url: '?action=new&frame=10' },
 //   { id: 'wmts', name: 'WMTS', url: '?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/Regression%20test%20NRL%20WMTS/20251204_001658.js&mapType=WMTS' },
    { id: 'agua', name: 'agua', url: '?sitch=agua&frame=10' },
    // ocean: explicitly tests the OceanSurface map type, so do NOT force the
    // local-terrain mirror — the test would render the wrong tiles otherwise.
    { id: 'ocean', name: 'ocean surface', url: '?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/REGRESSION%20TEST%20_%20Ocean%20Surface/20251114_234141.js&frame=10&mapType=OceanSurface', localTerrain: false },
    { id: 'gimbal', name: 'gimbal', url: '?sitch=gimbal&frame=10', timeout: 120000 },
    { id: 'starlink', name: 'starlink', url: '?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/Stalink%20Names/20250218_060544.js' },
    { id: "potomac", name: "potomac", url: "?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/Potomac/20250204_203812.js&frame=10" },
    { id: "orion", name: "orion", url: "?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/Orion%20in%20Both%20views%20for%20Label%20Check/20251127_200130.js&frame=10" },
    { id: "bledsoe", name: "bledsoe", url: "?custom=https://sitrec.s3.us-west-2.amazonaws.com/15857/BledsoeZoom/20250623_153507.js&frame=10" },
    { id: "mosul", name: "mosul", url: "?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/Mosul%20Orb/20250707_055311.js&frame=62"},
    { id: "nightsky-permalink", name: "nightsky permalink", url: "?sitch=nightsky&data=~(olat~51.48~olon~-3.16~lat~34.376627662040825~lon~-84.00309157040817~alt~36971.33215490772~startTime~%272023-02-28T00*3a45*3a41.276Z~az~-177.37058519694682~el~7.572727018255932~fov~48.170999999999985~roll~0~p~(x~-12526146.672264077~y~95667.1964429412~z~-1873477.710260879)~u~(x~0.05837430502341399~y~0.7414944410493608~z~0.6684148669845169)~q~(x~-0.39473570622715626~y~-0.6187577123399634~z~0.053388772167075584~w~0.6771057928091114)~f~526~pd~true~ssa~true~sfr~false~sfb~true~ssn~true~spd~29.3~rehostedFiles~(~%27https*3a*2f*2fsitrec.s3.us-west-2.amazonaws.com*2f15857*2fG6-1-6a5ed9b876ea212544084f48a933bcae.txt~%27https*3a*2f*2fsitrec.s3.us-west-2.amazonaws.com*2f15857*2fN230FR-track-press_alt_uncorrected*2520*25281*2529-fef762b490d1e988d0811bfb68a42273.kml)~rhs~true)_", timeout: 120000 },
];


// unit tests for trackfile related rendering
const testDataTrackFiles = [
    { id: "multi-csv", name: "multi-CSV", url: "?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/REGRESSION%20_%20MULTI%20TRACK%20CSV%20AIRCRAFT/20251030_044434.js&frame=620"},
    { id: "mosul", name: "mosul", url: "?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/Mosul%20Orb/20250707_055311.js&frame=62"},
]

function buildRegressionUrl(url, { localTerrain = true } = {}) {
    const hasParam = (input, key) => new RegExp(`[?&]${key}=`).test(input);
    let fullUrl = url;

    if (!fullUrl.includes("?")) {
        fullUrl += "?";
    }

    const additions = [];
    if (!hasParam(fullUrl, "ignoreunload")) additions.push("ignoreunload=1");
    if (!hasParam(fullUrl, "regression")) additions.push("regression=1");
    // Local-terrain mode is the default for the regression suite — baselines
    // were rendered against the pre-cached local tile mirror, and external
    // ESRI/AWS tile fetches are non-deterministic (live data) and prone to
    // headless-fetch stalls. Opt out two ways:
    //   - per-test: set localTerrain: false in the testData entry (used by
    //     tests that explicitly exercise a non-Local map type, e.g. ocean
    //     with mapType=OceanSurface).
    //   - per-run: REGRESSION_LOCAL_TERRAIN=0 in the environment.
    const useLocalTerrain = localTerrain && process.env.REGRESSION_LOCAL_TERRAIN !== "0";
    if (useLocalTerrain && !hasParam(fullUrl, "regressionLocalTerrain")) {
        additions.push("regressionLocalTerrain=1");
    }

    if (additions.length > 0) {
        const needsJoin = !fullUrl.endsWith("?") && !fullUrl.endsWith("&");
        fullUrl += `${needsJoin ? "&" : ""}${additions.join("&")}`;
    }

    return fullUrl;
}

async function waitForFrames(page, count = 1, maxWaitMs = 5000) {
    // Avoid page.evaluate here: under heavy GPU/video load, main-thread stalls can make
    // evaluate itself hit the Playwright test timeout.
    const targetMs = Math.max(1, count) * 16;
    await page.waitForTimeout(Math.min(maxWaitMs, targetMs));
}

// Wait for a render frame to actually complete (not just set a flag).
// Uses double-rAF: first rAF fires the render, second confirms it completed.
async function waitForRenderFrame(page, timeoutMs = 5000) {
    await page.evaluate((timeout) => {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('waitForRenderFrame timed out')), timeout);
            if (window.setRenderOne) window.setRenderOne(true);
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        });
    }, timeoutMs);
}

// Check that all WebGL contexts are still alive.
// Returns { healthy, lostCount, details }.
async function checkWebGLHealth(page) {
    return page.evaluate(() => {
        const results = [];
        const vm = window.ViewMan;
        if (vm && vm.list) {
            Object.entries(vm.list).forEach(([id, entry]) => {
                const view = entry && entry.data;
                if (!view || !view.renderer) return;
                try {
                    const gl = view.renderer.getContext();
                    results.push({ id, lost: gl ? gl.isContextLost() : true });
                } catch (e) {
                    results.push({ id, lost: true, error: e.message });
                }
            });
        }
        const lostCount = results.filter(r => r.lost).length;
        return { healthy: lostCount === 0, lostCount, details: JSON.stringify(results) };
    });
}

// Check if a screenshot buffer is essentially blank (one dominant color).
// Samples pixels and returns true if > 95% share the same color.
function isScreenshotBlank(pngBuffer) {
    try {
        const png = PNG.sync.read(pngBuffer);
        const { data, width, height } = png;
        const pixelCount = width * height;
        const step = Math.max(1, Math.floor(pixelCount / 5000)); // sample ~5000 pixels
        const colorCounts = {};
        let samples = 0;
        for (let i = 0; i < pixelCount; i += step) {
            const off = i * 4;
            // quantize to reduce noise: round to nearest 8
            const r = data[off] & 0xF8;
            const g = data[off + 1] & 0xF8;
            const b = data[off + 2] & 0xF8;
            const key = (r << 16) | (g << 8) | b;
            colorCounts[key] = (colorCounts[key] || 0) + 1;
            samples++;
        }
        const maxCount = Math.max(...Object.values(colorCounts));
        return maxCount / samples > 0.95;
    } catch {
        return false; // can't parse → assume not blank
    }
}

async function getSceneSettleState(page) {
    return page.evaluate(() => {
        const globals = window.Globals;
        const nodeMan = window.NodeMan;
        const loadingDiv = document.getElementById("loadingIndicator");
        const terrainUI = (nodeMan?.exists && nodeMan.exists("terrainUI")) ? nodeMan.get("terrainUI") : null;

        const state = {
            ready: !!globals && !!nodeMan && !!nodeMan.list,
            pendingActions: 0,
            deserializing: false,
            parsing: 0,
            loadingVisible: false,
            texturePendingLoads: 0,
            textureLoading: 0,
            textureRecalc: 0,
            textureNeedsHighRes: 0,
            texturePendingAncestor: 0,
            elevationLoading: 0,
            elevationRecalc: 0,
            elevationPendingAncestor: 0,
            pending3DTiles: 0,
            activeVisibleTextureTiles: 0,
            mapType: terrainUI?.mapType || "",
            elevationType: terrainUI?.elevationType || "",
            sitName: window.Sit?.name || "",
            visibleTileHash: 0,
        };

        if (!state.ready) {
            return state;
        }

        state.pendingActions = globals.pendingActions ?? 0;
        state.deserializing = !!globals.deserializing;
        state.parsing = globals.parsing ?? 0;
        state.loadingVisible = !!loadingDiv
            && loadingDiv.style.display !== "none"
            && (loadingDiv.textContent || "").includes("Loading");

        const hashString = (input) => {
            let hash = 2166136261;
            for (let i = 0; i < input.length; i++) {
                hash ^= input.charCodeAt(i);
                hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
            }
            return hash >>> 0;
        };

        for (const entry of Object.values(nodeMan.list)) {
            const node = entry?.data;
            if (!node) continue;

            if (node.elevationMap && node.elevationMap.forEachTile) {
                node.elevationMap.forEachTile((tile) => {
                    const active = (tile.tileLayers ?? 0) !== 0;
                    if (!active) return;
                    if (tile.isLoadingElevation) state.elevationLoading++;
                    if (tile.isRecalculatingCurve) state.elevationRecalc++;
                    if (tile.pendingAncestorLoad) state.elevationPendingAncestor++;
                });
            }

            if (node.maps) {
                for (const mapID in node.maps) {
                    const map = node.maps[mapID]?.map;
                    if (!map || !map.forEachTile) continue;

                    if (map.pendingTileLoads && typeof map.pendingTileLoads.size === "number") {
                        state.texturePendingLoads += map.pendingTileLoads.size;
                    }

                    map.forEachTile((tile) => {
                        const active = (tile.tileLayers ?? 0) !== 0;
                        const visible = !!tile.mesh?.visible;
                        if (!active || !visible) return;

                        state.activeVisibleTextureTiles++;
                        if (tile.isLoading) state.textureLoading++;
                        if (tile.isRecalculatingCurve) state.textureRecalc++;
                        if (tile.needsHighResLoad) state.textureNeedsHighRes++;
                        if (tile.pendingAncestorLoad) state.texturePendingAncestor++;

                        const sig = `${mapID}:${tile.z}/${tile.x}/${tile.y}:${tile.usingParentData ? 1 : 0}:${tile.needsHighResLoad ? 1 : 0}`;
                        state.visibleTileHash = (state.visibleTileHash ^ hashString(sig)) >>> 0;
                    });
                }
            }

            if (typeof node.getPendingLoadState === "function") {
                const pending = node.getPendingLoadState();
                if (pending?.hasPending) {
                    state.pending3DTiles++;
                }
            }
        }

        return state;
    });
}

function isScenePending(state) {
    if (!state.ready) return true;
    return state.pendingActions > 0
        || state.deserializing
        || state.parsing > 0
        || state.loadingVisible
        || state.texturePendingLoads > 0
        || state.textureLoading > 0
        || state.textureRecalc > 0
        || state.texturePendingAncestor > 0
        || state.elevationLoading > 0
        || state.elevationRecalc > 0
        || state.elevationPendingAncestor > 0
        || state.pending3DTiles > 0;
}

function formatSceneSettleState(state) {
    return [
        `sit=${state.sitName || "?"}`,
        `map=${state.mapType || "?"}`,
        `elev=${state.elevationType || "?"}`,
        `pendingActions=${state.pendingActions}`,
        `deserializing=${state.deserializing ? 1 : 0}`,
        `parsing=${state.parsing}`,
        `loadingUI=${state.loadingVisible ? 1 : 0}`,
        `texPendingSet=${state.texturePendingLoads}`,
        `texLoading=${state.textureLoading}`,
        `texRecalc=${state.textureRecalc}`,
        `texNeedsHighRes=${state.textureNeedsHighRes}`,
        `texPendingAncestor=${state.texturePendingAncestor}`,
        `elevLoading=${state.elevationLoading}`,
        `elevRecalc=${state.elevationRecalc}`,
        `elevPendingAncestor=${state.elevationPendingAncestor}`,
        `pending3DTiles=${state.pending3DTiles}`,
        `activeTexVisible=${state.activeVisibleTextureTiles}`,
        `tileHash=${state.visibleTileHash}`,
    ].join(", ");
}

async function waitForSceneToSettle(page, {
    maxWaitMs = 90000,
    stableChecks = 20,
    minWaitMs = 3000,
} = {}) {
    const startMs = Date.now();
    let checks = 0;
    let stableCount = 0;
    let lastSignature = "";
    let observedBusy = false;

    while (Date.now() - startMs < maxWaitMs) {
        const state = await getSceneSettleState(page);
        const pending = isScenePending(state);
        const signature = `${state.activeVisibleTextureTiles}:${state.visibleTileHash}`;

        if (pending) {
            observedBusy = true;
            stableCount = 0;
            lastSignature = "";
        } else {
            if (signature === lastSignature) {
                stableCount++;
            } else {
                stableCount = 1;
                lastSignature = signature;
            }

            const elapsedMs = Date.now() - startMs;
            const canFinish = (observedBusy || elapsedMs >= minWaitMs) && stableCount >= stableChecks;
            if (canFinish) {
                return { timedOut: false, state };
            }
        }

        checks++;
        if (checks % 120 === 0) {
            console.log(`[SETTLE] Waiting... ${formatSceneSettleState(state)}`);
        }
        await waitForFrames(page, 2);
    }

    const finalState = await getSceneSettleState(page);
    console.warn(`[SETTLE] Timeout after ${maxWaitMs}ms: ${formatSceneSettleState(finalState)}`);
    return { timedOut: true, state: finalState };
}


async function waitForConsoleText(page, expectedText, timeoutMs = 30000) {
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

let testData;
if (process.env.TEST_TRACKFILES === 'true') {
    testData = testDataTrackFiles;
} else {
    testData = testDataDefault;
}

test.describe('Visual Regression Testing', () => {
    // SwiftShader occasionally fails WebGL program link under cross-file
    // CPU contention (THREE.WebGLProgram VALIDATE_STATUS false, GL 1282),
    // producing flaky snapshots — orion was the recurring symptom. There's
    // no "shaders ready" signal to poll (SwiftShader doesn't expose
    // KHR_parallel_shader_compile), and trying to reduce contention via
    // serial mode just cascades one flake into skipping the rest of the
    // describe. Extra retries are the least-bad lever: genuine regressions
    // still fail all three attempts, random link failures get absorbed.
    test.describe.configure({ retries: 2 });

    testData.forEach(({ id, name, url, waitFor, timeout, localTerrain }) => {
        test(`should match the baseline screenshot for ${name}`, async ({ page }, testInfo) => {
            console.log(`[TEST:${id}:STARTED]`);
            
            try {
                test.setTimeout(waitFor ? 900000 : 300000);

                await page.setViewportSize({ width: 1920, height: 1080 });

                let assertionReject;
                const assertionPromise = new Promise((_, reject) => {
                    assertionReject = reject;
                });

                // In local-terrain mode (the default — see buildRegressionUrl),
                // tiles beyond the downloaded zoom range 404; Three.js / sitrec
                // handle this by falling back to the parent tile, so these are
                // expected and shouldn't fail the test. Tests that opt out of
                // local terrain (localTerrain: false) hit live tile sources, so
                // a tile miss there is a real problem and shouldn't be ignored.
                const useLocalTerrain = (localTerrain !== false) && process.env.REGRESSION_LOCAL_TERRAIN !== "0";
                const ignoreTileMisses = useLocalTerrain;

                page.on('console', msg => {
                    const text = msg.text();
                    const type = msg.type();
                    console.log(`[WORKER-${testInfo.workerIndex}] PAGE CONSOLE [${type}]: ${text}`);
                    if (text.includes('ASSERT:')) {
                        console.error(`[WORKER-${testInfo.workerIndex}] ASSERTION FAILURE DETECTED: ${text}`);
                        assertionReject(new Error(`ASSERTION FAILURE: ${text}`));
                    } else if (type === 'error') {
                        const errUrl = msg.location()?.url || '';
                        // Browsers auto-request /favicon.ico; sitrec doesn't ship one at
                        // the app root and returns 404. Not a real failure.
                        if (text.includes('Failed to load resource') && errUrl.endsWith('/favicon.ico')) {
                            return;
                        }
                        if (ignoreTileMisses && text.includes('Failed to load resource') &&
                            errUrl.includes('/sitrec-terrain/')) {
                            return;
                        }
                        console.error(`[WORKER-${testInfo.workerIndex}] CONSOLE ERROR DETECTED: ${text}`);
                        assertionReject(new Error(`CONSOLE ERROR: ${text}`));
                    }
                });

                page.on('pageerror', err => {
                    console.log(`[WORKER-${testInfo.workerIndex}] PAGE ERROR:`, err);
                });

                page.on('response', res => {
                    if (res.status() >= 400) {
                        console.log(`[WORKER-${testInfo.workerIndex}] Failed response: ${res.url()} - Status: ${res.status()}`);
                    }
                });

                page.on('requestfailed', req => {
                    console.log(`[WORKER-${testInfo.workerIndex}] Request failed: ${req.url()}`);
                });

                const fullUrl = buildRegressionUrl(url, { localTerrain });

                const runTest = async () => {
                    const expectedText = waitFor || 'No pending actions';
                    // Default "No pending actions" wait needs to survive 4 parallel
                    // workers competing for CPU/GPU on video-heavy sitches (gimbal,
                    // agua). 60s was fine with workers=2; bumped to 180s to absorb
                    // scheduler jitter without inflating individual test entries.
                    const consoleTimeout = waitFor ? 600000 : (timeout || 180000);
                    const consolePromise = waitForConsoleText(page, expectedText, consoleTimeout);
                    console.log(`[WORKER-${testInfo.workerIndex}] Loading URL for ${name}: ${fullUrl}`);

                    const response = await page.goto(fullUrl, {
                        waitUntil: 'load',
                        timeout: 30000
                    });

                    if (!response.ok()) {
                        console.error(`[WORKER-${testInfo.workerIndex}] Page load failed with status: ${response.status()} for URL: ${fullUrl}`);
                    }

                    await consolePromise;

                    const settleMaxWait = waitFor ? 180000 : Math.max(timeout || 60000, 90000);
                    const settleResult = await waitForSceneToSettle(page, {
                        maxWaitMs: settleMaxWait,
                    });
                    console.log(`[SETTLE] Ready (${settleResult.timedOut ? "timed out" : "stable"}): ${formatSceneSettleState(settleResult.state)}`);

                    await waitForFrames(page, 5);

                    // Log resolved terrain settings for debugability across custom sitches.
                    const finalState = await getSceneSettleState(page);
                    console.log(`[SETTLE] Final terrain: map=${finalState.mapType || "?"}, elev=${finalState.elevationType || "?"}`);

                    // Verify WebGL contexts are still alive before taking the screenshot.
                    // Under parallel load, SwiftShader can lose contexts.
                    const webglState = await checkWebGLHealth(page);
                    if (!webglState.healthy) {
                        console.error(`[WORKER-${testInfo.workerIndex}] WebGL context LOST (${webglState.lostCount} renderer(s)): ${webglState.details}`);
                        // Try to recover: wait and re-check
                        await waitForFrames(page, 10);
                        const retry = await checkWebGLHealth(page);
                        if (!retry.healthy) {
                            throw new Error(`WebGL context lost and unrecoverable for ${name}: ${retry.details}`);
                        }
                        console.log(`[WORKER-${testInfo.workerIndex}] WebGL context recovered after wait`);
                    }

                    // Wait for a render frame to actually complete, not just set a flag.
                    await waitForRenderFrame(page);

                    // Take the screenshot (as a buffer first for blank detection).
                    const screenshotBuffer = await page.screenshot({
                        fullPage: true,
                        timeout: 30000,
                    });

                    if (isScreenshotBlank(screenshotBuffer)) {
                        console.error(`[WORKER-${testInfo.workerIndex}] BLANK screenshot detected for ${name}`);
                        // Retry: wait for more frames and try again
                        await waitForRenderFrame(page);
                        await waitForFrames(page, 10);
                        await waitForRenderFrame(page);
                        const retryBuffer = await page.screenshot({ fullPage: true, timeout: 30000 });
                        if (isScreenshotBlank(retryBuffer)) {
                            const retryWebGL = await checkWebGLHealth(page);
                            throw new Error(`Screenshot is blank for ${name} after retry. WebGL: ${retryWebGL.details}`);
                        }
                        console.log(`[WORKER-${testInfo.workerIndex}] Retry screenshot for ${name} is non-blank`);
                    }

                    await takeScreenshotOrCompare(page, `${name}-snapshot`, testInfo);

                    await page.evaluate(() => {
                        if (window.Globals && window.Globals.renderData) {
                            try {
                                window.Globals.renderData.forEach(rd => {
                                    if (rd.renderer) {
                                        rd.renderer.dispose();
                                    }
                                    if (rd._resizeTimeout) {
                                        clearTimeout(rd._resizeTimeout);
                                        rd._resizeTimeout = null;
                                    }
                                });
                            } catch (e) {
                            }
                        }
                    });
                };

                await Promise.race([runTest(), assertionPromise]);

                console.log(`[TEST:${id}:PASSED]`);
            } catch (error) {
                console.log(`[TEST:${id}:FAILED]`);
                throw error;
            }
        });
    });
});
