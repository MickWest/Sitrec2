import {Globals, NodeMan} from "./Globals";
import {asyncOperationRegistry} from "./AsyncOperationRegistry";

/**
 * Utilities for export-time frame settling.
 *
 * Goal: only capture/export a frame after asynchronous scene work has stopped
 * and 3D tile visibility transitions have stabilized for the current frame.
 */

/**
 * Await exactly one browser animation frame tick.
 * Used as the pacing primitive for settle checks.
 */
function nextAnimationFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
}

/**
 * Detect whether terrain map/elevation quadtree tiles are still loading.
 * @returns {boolean}
 */
function hasPendingTerrainTiles() {
    for (const entry of Object.values(NodeMan.list)) {
        const node = entry.data;

        if (node.elevationMap && node.elevationMap.getTileCount !== undefined) {
            let pendingElevation = false;
            node.elevationMap.forEachTile((tile) => {
                if (tile.isLoading || tile.isLoadingElevation || tile.isRecalculatingCurve) {
                    pendingElevation = true;
                }
            });
            if (pendingElevation) return true;
        }

        if (node.maps !== undefined) {
            for (const mapID in node.maps) {
                const map = node.maps[mapID]?.map;
                if (map && map.forEachTile !== undefined) {
                    let pendingTexture = false;
                    map.forEachTile((tile) => {
                        if (tile.isLoading || tile.isRecalculatingCurve) {
                            pendingTexture = true;
                        }
                    });
                    if (pendingTexture) return true;
                }
            }
        }
    }

    return false;
}

// Terrain refines by at most one quadtree level per render. Cached parent
// imagery can make those passes entirely synchronous, with no pending loads.
// Follow tile-set changes until refinement stops, without waiting out the
// terrain UI's fixed camera grace period on every exported frame.
function detectTerrainRefinement(epochs) {
    let changed = false;
    for (const {data: node} of Object.values(NodeMan.list)) {
        const maps = [node.elevationMap, ...Object.values(node.maps ?? {}).map(entry => entry?.map)];
        for (const map of maps) {
            if (!map || map._tileEpoch === undefined) continue;
            if (epochs.get(map) !== map._tileEpoch) changed = true;
            epochs.set(map, map._tileEpoch);
        }
    }
    return changed;
}

/**
 * Detect whether any video source still lacks the target frame in cache.
 * @param {number} frame
 * @returns {boolean}
 */
function hasPendingVideoFrames(frame) {
    if (frame === undefined || frame === null) return false;

    for (const entry of Object.values(NodeMan.list)) {
        const node = entry.data;
        if (node.videoData && node.videoData.isFrameCached) {
            if (!node.videoData.isFrameCached(frame)) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Collect pending state for any node that exposes getPendingLoadState().
 * This is currently used for 3D tiles/buildings nodes.
 *
 * @param {string[]|null} viewIds - Optional view filter (e.g. ['mainView']).
 * @returns {{hasPending: boolean, byNode: Array}}
 */
function getPending3DTilesState(viewIds = null) {
    const summary = {
        hasPending: false,
        byNode: [],
    };

    for (const entry of Object.values(NodeMan.list)) {
        const node = entry.data;
        if (typeof node.getPendingLoadState !== "function") continue;

        const state = node.getPendingLoadState(viewIds);
        if (!state) continue;

        if (state.hasPending) {
            summary.hasPending = true;
        }
        summary.byNode.push({
            id: node.id,
            hasPending: !!state.hasPending,
            perView: state.perView,
        });
    }

    return summary;
}

/**
 * Build a full snapshot of export-relevant pending state.
 * @param {number} frame
 * @param {string[]|null} viewIds
 * @returns {Object}
 */
function getPendingState(frame, viewIds = null) {
    const pending3DTiles = getPending3DTilesState(viewIds);
    return {
        pendingActions: Globals.pendingActions,
        pendingAsyncOps: asyncOperationRegistry.getCount(),
        pendingTerrainTiles: hasPendingTerrainTiles(),
        pendingTerrainRefinement: false,
        pending3DTiles: pending3DTiles.hasPending,
        pendingVideoFrames: hasPendingVideoFrames(frame),
        pending3DTileChurn: false,
        pending3DTilesDetail: pending3DTiles.byNode,
    };
}

/**
 * True if any tracked subsystem indicates "not settled".
 * @param {Object} state
 * @returns {boolean}
 */
function hasPendingWork(state) {
    return state.pendingActions > 0
        || state.pendingAsyncOps > 0
        || state.pendingTerrainTiles
        || state.pendingTerrainRefinement
        || state.pending3DTiles
        || state.pendingVideoFrames
        || state.pending3DTileChurn;
}

/**
 * Serialize pending state into a compact debug string for timeout logs.
 * @param {Object} state
 * @returns {string}
 */
function formatPendingState(state) {
    const parts = [];

    if (state.pendingActions > 0) {
        parts.push(`pendingActions=${state.pendingActions}`);
    }
    if (state.pendingAsyncOps > 0) {
        parts.push(`asyncOps=${state.pendingAsyncOps}`);
    }
    if (state.pendingTerrainTiles) {
        parts.push("terrainTiles=true");
    }
    if (state.pendingTerrainRefinement) {
        parts.push("terrainRefining=true");
    }
    if (state.pending3DTiles) {
        parts.push("buildings3DTiles=true");
    }
    if (state.pending3DTileChurn) {
        parts.push("buildings3DTilesTransitioning=true");
    }
    if (state.pendingVideoFrames) {
        parts.push("videoFrames=true");
    }
    if (state.pending3DTilesDetail?.length > 0) {
        const detail = state.pending3DTilesDetail
            .map(nodeState => {
                const viewBits = Object.entries(nodeState.perView || {})
                    .map(([viewId, stats]) =>
                        `${viewId}(q=${stats.queued},d=${stats.downloading},p=${stats.parsing},l=${stats.isLoading ? 1 : 0},f=${stats.fadingTiles || 0},v=${stats.visibilityVersion || 0})`
                    )
                    .join(",");
                return `${nodeState.id}:${viewBits}`;
            })
            .join(" | ");
        if (detail) {
            parts.push(`3DTilesDetail=[${detail}]`);
        }
    }

    return parts.length > 0 ? parts.join(", ") : "none";
}

/**
 * Detect 3D tile visibility churn by tracking per-view monotonic
 * visibilityVersion counters.
 *
 * A frame can have no network/parse work pending while still performing
 * LOD visibility swaps (tile add/remove). This catches that case.
 *
 * @param {Object} state
 * @param {Map<string, number>} visibilityVersions
 * @returns {boolean} True when a version changed, appeared, or disappeared.
 */
function detect3DTileVisibilityChurn(state, visibilityVersions) {
    const seenKeys = new Set();
    let changed = false;

    for (const nodeState of state.pending3DTilesDetail || []) {
        for (const [viewId, stats] of Object.entries(nodeState.perView || {})) {
            const key = `${nodeState.id}:${viewId}`;
            const currentVersion = stats.visibilityVersion || 0;
            seenKeys.add(key);

            if (!visibilityVersions.has(key)) {
                changed = true;
            } else if (visibilityVersions.get(key) !== currentVersion) {
                changed = true;
            }

            visibilityVersions.set(key, currentVersion);
        }
    }

    for (const key of Array.from(visibilityVersions.keys())) {
        if (!seenKeys.has(key)) {
            visibilityVersions.delete(key);
            changed = true;
        }
    }

    return changed;
}

/**
 * Wait until the current export frame is stable enough to capture.
 *
 * Stability criteria:
 * 1) No pending async subsystems (terrain, videos, async registry, 3D tile queues/fades/churn)
 * 2) The "no pending" state is observed for `stableChecks` consecutive iterations
 * 3) After settling, render `postSettleRenders` additional frames and verify no pending work reappears
 *
 * @param {Object} options
 * @param {number} options.frame - Fixed export frame being captured.
 * @param {string[]|null} [options.viewIds=null] - Optional view filter for 3D tiles state.
 * @param {Function|null} [options.renderFrame=null] - Callback to force another render pass while waiting.
 * @param {number} [options.maxWaitMs=45000] - Timeout guard to avoid infinite wait.
 * @param {number} [options.stableChecks=2] - Consecutive "quiet" checks required before accepting settled.
 * @param {number} [options.postSettleRenders=1] - Extra renders after settled to ensure on-screen presentation caught up.
 * @param {string} [options.logPrefix='Video export'] - Prefix for timeout/debug logs.
 * @returns {Promise<{timedOut:boolean, elapsedMs:number, checks:number, state:Object}>}
 */
export async function waitForExportFrameSettled({
    frame,
    viewIds = null,
    renderFrame = null,
    maxWaitMs = 45000,
    stableChecks = 2,
    postSettleRenders = 1,
    logPrefix = "Video export",
} = {}) {
    const start = performance.now();
    let stableCount = 0;
    let checks = 0;
    const visibilityVersions = new Map();
    const terrainEpochs = new Map();

    while (true) {
        const state = getPendingState(frame, viewIds);
        state.pendingTerrainRefinement = detectTerrainRefinement(terrainEpochs);
        // Treat visibility flips themselves as pending work even if queue counts are zero.
        state.pending3DTileChurn = detect3DTileVisibilityChurn(state, visibilityVersions);
        const pending = hasPendingWork(state);

        if (!pending) {
            stableCount++;
            if (stableCount >= stableChecks) {
                let postSettleComplete = true;
                for (let i = 0; i < postSettleRenders; i++) {
                    await nextAnimationFrame();
                    if (renderFrame) {
                        await renderFrame();
                    }

                    const postState = getPendingState(frame, viewIds);
                    postState.pendingTerrainRefinement = detectTerrainRefinement(terrainEpochs);
                    // Re-check churn after each post-settle render to ensure no new tile swaps occurred.
                    postState.pending3DTileChurn = detect3DTileVisibilityChurn(postState, visibilityVersions);
                    if (hasPendingWork(postState)) {
                        postSettleComplete = false;
                        stableCount = 0;
                        break;
                    }
                }

                if (postSettleComplete) {
                    return {
                        timedOut: false,
                        elapsedMs: Math.round(performance.now() - start),
                        checks,
                        state,
                    };
                }
            }
        } else {
            stableCount = 0;
        }

        const elapsed = performance.now() - start;
        if (elapsed > maxWaitMs) {
            console.warn(`[${logPrefix}] Frame ${frame} settle timeout after ${Math.round(elapsed)}ms: ${formatPendingState(state)}`);
            return {
                timedOut: true,
                elapsedMs: Math.round(elapsed),
                checks,
                state,
            };
        }

        await nextAnimationFrame();
        // Render during waiting so tile traversal/fades can continue toward a stable state.
        if (renderFrame) {
            await renderFrame();
        }

        checks++;
        if (checks > 0 && checks % 120 === 0) {
            console.warn(`[${logPrefix}] Still waiting on frame ${frame} (${Math.round(elapsed)}ms): ${formatPendingState(state)}`);
        }
    }
}
