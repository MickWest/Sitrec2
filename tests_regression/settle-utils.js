// Shared Playwright helpers for Sitrec regression tests.
//
// These functions were originally defined inline in regression.test.js. They
// are extracted here verbatim so additional test files (e.g.
// save-load-roundtrip.test.js) can reuse the exact same scene-settle and
// readiness logic without duplicating ~250 lines. regression.test.js still
// carries its own copies for now; it can be migrated to import from here in a
// follow-up without changing behavior.

import {PNG} from 'pngjs';

// Build the canonical regression URL: append ignoreunload / regression /
// regressionLocalTerrain flags the same way the main suite does, so a sitch
// loads against the pre-cached local tile mirror and skips unload prompts.
export function buildRegressionUrl(url, {localTerrain = true} = {}) {
    const hasParam = (input, key) => new RegExp(`[?&]${key}=`).test(input);
    let fullUrl = url;

    if (!fullUrl.includes("?")) {
        fullUrl += "?";
    }

    const additions = [];
    if (!hasParam(fullUrl, "ignoreunload")) additions.push("ignoreunload=1");
    if (!hasParam(fullUrl, "regression")) additions.push("regression=1");
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

// Hard-fail fast (with a clear message) if the app server isn't reachable,
// instead of letting the first page.goto() burn its full 30s timeout. The dev
// server is expected to always be up, so "not reachable" is an environment
// error, not a test failure to debug. Pass an APIRequestContext (page.request).
export async function assertServerReachable(request, baseURL, {timeoutMs = 8000} = {}) {
    if (!baseURL) {
        throw new Error('No baseURL configured — set PLAYWRIGHT_BASE_URL or playwright.config.js use.baseURL.');
    }
    let response;
    try {
        response = await request.get(baseURL, {timeout: timeoutMs, failOnStatusCode: false});
    } catch (e) {
        throw new Error(
            `Sitrec server not reachable at ${baseURL} (${e?.message || e}). ` +
            `Start it (npm run build + local server, or set PLAYWRIGHT_BASE_URL) and retry.`);
    }
    if (!response.ok()) {
        throw new Error(
            `Sitrec server at ${baseURL} returned HTTP ${response.status()}; expected it to be up and serving the app.`);
    }
}

// Coarse wait by wall-clock, sized to a frame count. Avoids page.evaluate so
// main-thread stalls under heavy GPU/video load can't trip the test timeout.
export async function waitForFrames(page, count = 1, maxWaitMs = 5000) {
    const targetMs = Math.max(1, count) * 16;
    await page.waitForTimeout(Math.min(maxWaitMs, targetMs));
}

// Wait for a render frame to actually complete (not just set a flag).
// Double-rAF: first fires the render, second confirms it completed.
export async function waitForRenderFrame(page, timeoutMs = 5000) {
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
export async function checkWebGLHealth(page) {
    return page.evaluate(() => {
        const results = [];
        const vm = window.ViewMan;
        if (vm && vm.list) {
            Object.entries(vm.list).forEach(([id, entry]) => {
                const view = entry && entry.data;
                if (!view || !view.renderer) return;
                try {
                    const gl = view.renderer.getContext();
                    results.push({id, lost: gl ? gl.isContextLost() : true});
                } catch (e) {
                    results.push({id, lost: true, error: e.message});
                }
            });
        }
        const lostCount = results.filter(r => r.lost).length;
        return {healthy: lostCount === 0, lostCount, details: JSON.stringify(results)};
    });
}

// Check if a screenshot buffer is essentially blank (one dominant color).
// Samples pixels and returns true if > 95% share the same color.
export function isScreenshotBlank(pngBuffer) {
    try {
        const png = PNG.sync.read(pngBuffer);
        const {data, width, height} = png;
        const pixelCount = width * height;
        const step = Math.max(1, Math.floor(pixelCount / 5000));
        const colorCounts = {};
        let samples = 0;
        for (let i = 0; i < pixelCount; i += step) {
            const off = i * 4;
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
        return false;
    }
}

// Snapshot the app's pending-work state: pending actions, deserialization,
// parsing, the loading UI, and per-tile texture/elevation/3D-tile load flags.
export async function getSceneSettleState(page) {
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

export function isScenePending(state) {
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

export function formatSceneSettleState(state) {
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

// Poll until the scene is both not-pending AND visually stable (the visible
// tile signature stops changing for `stableChecks` consecutive reads), or
// until maxWaitMs. Returns { timedOut, state }.
export async function waitForSceneToSettle(page, {
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
                return {timedOut: false, state};
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
    return {timedOut: true, state: finalState};
}

// Attach console / pageerror listeners that reject on a Sitrec ASSERT or a
// genuine console error. Returns { errorPromise, detach }. Mirrors the inline
// wiring in regression.test.js: favicon 404s and (in local-terrain mode)
// /sitrec-terrain/ tile 404s are expected and ignored.
export function attachConsoleErrorRejector(page, {label = "", ignoreTileMisses = true} = {}) {
    let rejectFn;
    const errorPromise = new Promise((_, reject) => {
        rejectFn = reject;
    });

    const consoleHandler = (msg) => {
        const text = msg.text();
        const type = msg.type();
        console.log(`[${label}] PAGE CONSOLE [${type}]: ${text}`);
        if (text.includes('ASSERT:')) {
            rejectFn(new Error(`ASSERTION FAILURE: ${text}`));
        } else if (type === 'error') {
            const errUrl = msg.location()?.url || '';
            if (text.includes('Failed to load resource') && errUrl.endsWith('/favicon.ico')) {
                return;
            }
            if (ignoreTileMisses && text.includes('Failed to load resource') &&
                errUrl.includes('/sitrec-terrain/')) {
                return;
            }
            rejectFn(new Error(`CONSOLE ERROR: ${text}`));
        }
    };

    const pageErrorHandler = (err) => {
        console.log(`[${label}] PAGE ERROR:`, err);
        rejectFn(new Error(`PAGE ERROR: ${err?.message || err}`));
    };

    page.on('console', consoleHandler);
    page.on('pageerror', pageErrorHandler);

    const detach = () => {
        page.off('console', consoleHandler);
        page.off('pageerror', pageErrorHandler);
    };

    return {errorPromise, detach};
}
