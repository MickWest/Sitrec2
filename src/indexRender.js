/**
 * Render loop, pending-operation tracking and GPU-flush helpers extracted
 * from index.js.
 *
 * Owns the renderMain() main-loop function and the pending-ops helpers
 * (waitForAllPendingOperations, hasPendingTiles, hasPendingVideoFrames,
 * flushGPUAndCheckBacklog, logPendingStatus). isTransitioning is declared
 * here (renderMain gates on it) and exported via a setter so newSitch in
 * index.js can flip it without an import cycle.
 */

import {
    CustomManager,
    GlobalDateTimeNode,
    Globals,
    incrementMainLoopCount,
    NodeMan,
    setRenderOne,
    Sit,
} from "./Globals";
import {par} from "./par";
import {arModeManager} from "./ARMode";
import {glareSprite, targetSphere} from "./JetStuffVars";
import {asyncOperationRegistry} from "./AsyncOperationRegistry";
import {VideoLoadingManager} from "./CVideoLoadingManager";
import {ViewMan} from "./CViewManager";
import {LayoutMan} from "./CLayoutManager";
import {globalProfiler} from "./VisualProfiler";
import {GPUMemoryMonitor} from "./GPUMemoryMonitor";
import * as LAYER from "./LayerMasks";
import {CNode} from "./nodes/CNode";
import {CNodeView3D} from "./nodes/CNodeView3D";
import {CNodeTerrainUI} from "./nodes/CNodeTerrainUI";
import {Controller} from "./js/lil-gui.esm";
import {DragDropHandler} from "./DragDropHandler";
import {EventManager} from "./CEventManager";
import {updateFrame} from "./updateFrame";
import {isKeyHeld} from "./KeyBoardHandler";
import {updateLockTrack} from "./updateLockTrack";
import {assert} from "./assert";
import {updateSize} from "./JetStuff";

export function windowChanged() {
    updateSize();
}

// Mutable isTransitioning flag — set by index.js/newSitch, read by renderMain
// below. Exported via setter to avoid index.js → indexRender import cycle.
let isTransitioning = false;
let lastNodeUpdateFrame;
export function setIsTransitioning(v) {
    isTransitioning = v;
    if (v) lastNodeUpdateFrame = undefined;
}
export function getIsTransitioning() { return isTransitioning; }


// A camera's position and orientation are written by its controllers during the per-frame
// update — an imperative mutation of a Three.js object, not a node change — so the node graph
// never learns about it. Anything that BAKES geometry from a camera therefore captures
// whatever the camera happened to hold when its cascade last ran, and if the controllers move
// it afterwards nothing re-bakes.
//
// That is not hypothetical: CNodeDisplayLOS builds its LOS lines in recalculate() (update()
// deliberately does not rebuild them, for cost). During load the camera track resolves and
// cascades, but the controller has not yet copied the new position onto the camera, so the
// LOS baked the PREVIOUS position — measured at 174 m against a true 48 m, which put the
// whole line off screen. Whether you saw it came down to whether any later recalculate
// happened to fire after the controller caught up, so it was intermittent and worse on a warm
// cache.
//
// Once per settle is the right cadence: by the time this runs we are inside the render loop,
// so every controller has applied at least once, and loading has finished so the camera is
// where it will stay. Cascading from the cameras rebuilds only what actually derives from
// them. If more work starts later, wasPending resets and this fires again on the next settle.
function rebakeCameraDerivedNodes() {
    for (const entry of Object.values(NodeMan.list)) {
        const node = entry.data;
        if (node?.isCamera || node?.camera !== undefined) {
            node.recalculateCascade?.();
        }
    }
}

export function hasPendingTiles() {
    let hasPending = false;
    
    for (const entry of Object.values(NodeMan.list)) {
        const node = entry.data;
        // Check for terrain nodes with elevation and texture maps
        if (node.elevationMap !== undefined && node.elevationMap.getTileCount !== undefined) {
            // Check elevation map for pending tiles
            node.elevationMap.forEachTile((tile) => {
                if (tile.isLoading || tile.isLoadingElevation || tile.isRecalculatingCurve) {
                    hasPending = true;
                }
            });
        }
        
        // Check texture maps for pending tiles
        if (node.maps !== undefined) {
            for (const mapID in node.maps) {
                if (node.maps[mapID].map !== undefined && node.maps[mapID].map.forEachTile !== undefined) {
                    node.maps[mapID].map.forEachTile((tile) => {
                        if (tile.isLoading || tile.isRecalculatingCurve) {
                            hasPending = true;
                        }
                    });
                }
            }
        }
    }
    
    return hasPending;
}

/**
 * Check if video frames for fixedFrame are still being decoded
 * @returns {boolean} true if any video view is missing the fixedFrame in cache
 */
export function hasPendingVideoFrames() {
    if (Globals.fixedFrame === undefined) {
        return false;
    }
    
    for (const entry of Object.values(NodeMan.list)) {
        const node = entry.data;
        if (node.videoData && node.videoData.isFrameCached) {
            if (!node.videoData.isFrameCached(Globals.fixedFrame)) {
                return true;
            }
        }
    }
    
    return false;
}

/**
 * Wait for all pending actions and tile loads to complete
 * Used before transitioning to the next test/situation
 * @returns {Promise} - Resolves when all pending actions and tiles are loaded
 */
export async function waitForAllPendingOperations() {
    const maxWaitTime = 120000; // 2 min timeout to prevent infinite waiting
    const startTime = Date.now();
    let timeoutWarningShown = false;
    let lastPendingString = ''; // Track changes to pending ops list
    
    return new Promise((resolve) => {
        const checkPending = () => {
            const elapsedTime = Date.now() - startTime;
            const pendingCount = asyncOperationRegistry.getCount();
            const pendingOpsString = asyncOperationRegistry.getPendingOperationsString();
            
            if (Globals.pendingActions === 0 && !hasPendingTiles() && pendingCount === 0) {
                console.log("All pending operations completed");
                resolve();
            } else if (elapsedTime > maxWaitTime) {
                // CRITICAL: Cancel stuck operations IMMEDIATELY before resolving
                // This prevents orphaned callbacks from the 5 stuck ops
                console.warn(`\n=== ASYNC OPS TIMEOUT (${elapsedTime}ms) ===`);
                if (pendingOpsString) {
                    console.warn(pendingOpsString);
                }
                const cancelSummary = asyncOperationRegistry.cancelAll();
                console.warn(`Force-cancelled ${cancelSummary.count} operations.`);
                console.warn(`=== END TIMEOUT ===\n`);
                resolve(); // Now safe to proceed
            } else {
                // Only log if the pending ops list changed
                if (pendingOpsString !== lastPendingString) {
                    lastPendingString = pendingOpsString;
                    if (pendingOpsString) {
//                        console.log(`\nWaiting for operations (${elapsedTime}ms elapsed):\n${pendingOpsString}\n`);
                    }
                }
                
                if (!timeoutWarningShown && elapsedTime > 10000) {
                    console.warn(`Still waiting for operations after ${elapsedTime}ms: pendingActions=${Globals.pendingActions}, pendingTiles=${hasPendingTiles()}, asyncOps=${pendingCount}`);
                    timeoutWarningShown = true;
                }
                // Check again in the next frame
                requestAnimationFrame(checkPending);
            }
        };
        checkPending();
    });
}

/**
 * Generate a consistent color for a given view key
 * Uses a hash of the view name to pick from a predefined palette
 * @param {string} viewKey - The view identifier
 * @returns {string} - Hex color code
 */
function getViewProfileColor(viewKey) {
    // Define a color palette with good visual distinction
    const colors = [
        '#ff6b6b',  // Red
        '#4ecdc4',  // Teal
        '#45b7d1',  // Blue
        '#ffa502',  // Orange
        '#95e1d3',  // Mint
        '#f38181',  // Pink
        '#aa96da',  // Purple
        '#fcbad3',  // Light Pink
        '#ffffd2',  // Light Yellow
        '#a8d8ea',  // Light Blue
    ];
    
    // Simple hash function for consistent color assignment
    let hash = 0;
    for (let i = 0; i < viewKey.length; i++) {
        hash = ((hash << 5) - hash) + viewKey.charCodeAt(i);
        hash = hash & hash; // Convert to 32bit integer
    }
    
    const colorIndex = Math.abs(hash) % colors.length;
    return colors[colorIndex];
}

/**
 * GPU Queue Backlog Prevention
 * Flushes GPU command buffers and detects saturation
 * This prevents the "goes over a bit, goes over a lot" multi-frame hangs
 * caused by GPU pipeline stalls when terrain + sky rendering operations accumulate
 */
export function flushGPUAndCheckBacklog() {
    let flushCount = 0;
    
    // Iterate through all nodes and flush any WebGL renderers
    for (const entry of Object.values(NodeMan.list)) {
        const node = entry.data;
        if (node.renderer !== undefined && node.renderer.getContext !== undefined) {
            try {
                const gl = node.renderer.getContext();
                if (gl) {
                    gl.flush(); // Force GPU to execute pending commands
                    flushCount++;
                }
            } catch (e) {
                // Silently ignore errors - context might be lost or invalid
            }
        }
    }
    
    if (flushCount > 0 && Globals.debugGPUBacklog) {
        console.log(`[GPU Flush] Flushed ${flushCount} renderer(s)`);
    }
}


// Throttle state for the pending-actions diagnostic.
// Logs on count change or every 2s, showing what's stuck. Keeps the literal
// "Pending actions:" phrase so existing console-text filters in the
// regression tests continue to match; extra diagnostic info is appended.
const _pendingLogState = { count: -1, time: 0, start: 0 };

function logPendingStatus() {
    const now = performance.now();
    if (_pendingLogState.start === 0) _pendingLogState.start = now;
    const changed = _pendingLogState.count !== Globals.pendingActions;
    const overdue = (now - _pendingLogState.time) > 2000;
    if (!changed && !overdue) return;

    const elapsed = ((now - _pendingLogState.start) / 1000).toFixed(1);
    const videoSummary = VideoLoadingManager.getActiveLoadsSummary();
    const extras = [`elapsed=${elapsed}s`];
    if (videoSummary) extras.push(`video=[${videoSummary}]`);
    console.log(`Pending actions: ${Globals.pendingActions} (${extras.join(", ")})`);
    _pendingLogState.count = Globals.pendingActions;
    _pendingLogState.time = now;
}

export function renderMain(elapsed) {
    // Skip rendering during situation transitions to prevent accessing disposed nodes
    if (isTransitioning) {
        return;
    }

    // The Scripted Video offline renderer drives its own render loop and forces the
    // view to the export resolution. If the main loop also ran it would reset the view
    // size (updateWH/adjustSize) and re-pump nodes every tick, making camera.aspect (and
    // the 3D-tile LOD frustum) oscillate frame-to-frame. So it takes exclusive control.
    if (Globals.scriptedVideoRendering) {
        return;
    }

    // Profile overall frame
    if (globalProfiler) globalProfiler.push('#1f77b4', 'Frame');

    // GUI listener update moved below node update loop (see updateListeners call after node updates)

    // Update AR mode if enabled
    if (Globals.arMode) {
        arModeManager.update();
    }

    if (Globals.pendingActions > 0) {
        Globals.wasPending = 5;
        logPendingStatus();
    } else if (Globals.wasPending > 0) {
        // Emit the terminal "Pending actions: 0" on the first frame after
        // the transition to zero (throttle suppresses it on subsequent
        // frames until "No pending actions" fires). Tests that watch for
        // the "Pending actions" phrase rely on seeing this zero line.
        logPendingStatus();
        Globals.wasPending--;
        if (Globals.wasPending === 0) {
            // Check for pending tiles and video frames before declaring all actions complete
            if (!hasPendingTiles() && !hasPendingVideoFrames()) {
                console.log("No pending actions")
                _pendingLogState.start = 0;
                _pendingLogState.count = -1;
                rebakeCameraDerivedNodes();
            } else {
                // If there are pending tiles or video frames, reset the counter to wait for them
                Globals.wasPending = 5;
            }
        }

    }

    incrementMainLoopCount();


    if (Sit.animated) {
        const lastFrame = par.frame
        // upateFrame will update the frame number based on either user
        // input, or the elapsed time since the last frame
        // (unless paused or noLogic is set)
        updateFrame(elapsed)
        if (lastFrame !== par.frame)
            setRenderOne(true);
    }

    // frame number forced by URL parameter. Only (re)arm a render when the frame
    // actually needs pinning — Globals.fixedFrame is set once and never cleared,
    // so re-running par.frame=... (which re-arms renderOne via the par.frame
    // setter) every tick would defeat the paused early-out below and keep the
    // scene full-rendering forever. Arm once, then settle.
    if (Globals.fixedFrame !== undefined && par.frame !== Globals.fixedFrame) {
        par.frame = Globals.fixedFrame;
        GlobalDateTimeNode.update(Globals.fixedFrame);
        par.paused = true;
        setRenderOne(true);
    } else if (Globals.fixedFrame !== undefined) {
        par.paused = true; // keep paused, but do not re-arm renderOne
    }


    DragDropHandler.checkDropQueue();

    // early out if paused, but first check if any nodes are flagged to run their update function
    // even when paused. Example CNodeTerrainUI, which needs to keep subdividing tiles to load them
    if (par.paused && !par.renderOne) {
        for (const entry of Object.values(NodeMan.list)) {
            const node = entry.data;
            if (node.isController) continue;
            if (node.update !== undefined && node.updateWhilePaused) {
                node.update(par.frame)
            }
        }

        return;
    }

    // par.renderOne is a flag set whenever something is done that forces an update.
    // Clear it with a direct write. (Historically setRenderOne(false) was a no-op
    // here: setRenderOne() guards on `if (!par.renderOne)` to coalesce wake-ups on
    // the truthy path, which silently neutralised the clear — so renderOne stayed
    // true forever, renderMain never took the paused early-out above, and a heavy
    // scene full-rendered every tick at ~600% CPU. setRenderOne now honours an
    // explicit clear, but we still write directly here so this is unambiguous.)
    if (par.renderOne === true) {
        par.renderOne = false;
    } else if (typeof par.renderOne === "number") {
        // allow it to be a number if we want to force more than one frame render
        if (par.renderOne > 0) {
            par.renderOne--;
        }
    }

    // Held playback arrow keys (←/→ play, ↑/↓ 10x scrub) are polled every tick
    // in updateFrame(). Under render-on-demand the loop sleeps once renderOne is
    // cleared (just above) unless some node has updateWhilePaused work — which the
    // video viewer typically does NOT — so a held arrow only advanced a single
    // frame. Re-arm renderOne AFTER the clear so the loop keeps ticking and the
    // polling runs continuously while held. Releasing the key stops the re-arm and
    // the loop sleeps again next tick.
    if (isKeyHeld('arrowleft') || isKeyHeld('arrowright') || isKeyHeld('arrowup') || isKeyHeld('arrowdown')) {
        setRenderOne(true);
    }

    // Render-only passes usually reuse node/controller state. Scrubbing can
    // change par.frame between logic ticks, so update once when the rendered
    // frame differs from the frame that last drove the nodes.
    const frameNeedsNodeUpdate = lastNodeUpdateFrame !== par.frame;
    if ((!par.noLogic || frameNeedsNodeUpdate) && !Globals.justVideoAnalysis) {
        if (globalProfiler) globalProfiler.push('#ff7f0e', 'Updates');

        if (Sit.updateFunction) {
            Sit.updateFunction(par.frame)
        }

        if (Sit.update) {
            Sit.update(par.frame)
        }

        if (Sit.isCustom) {
            CustomManager.update()
        }
        if (globalProfiler) globalProfiler.pop();
        if (globalProfiler) globalProfiler.push('#7fff0e', 'Nodes');


        if (0) {
            // Collect timing data for all node updates
            const nodeTimings = [];

            NodeMan.iterate((key, node) => {
                if (node.update !== undefined) {
                    const startTime = performance.now();
                    node.update(par.frame);
                    const duration = performance.now() - startTime;

                    nodeTimings.push({
                        nodeName: key,
                        duration: duration
                    });
                }
            });

            // Sort by duration (descending) and log top 10
            if (nodeTimings.length > 0) {
                nodeTimings.sort((a, b) => b.duration - a.duration);
                console.log(`📊 Top 10 slowest node updates (Frame ${par.frame}):`);
                nodeTimings.slice(0, 10).forEach((item, index) => {
                    console.log(`  ${index + 1}. ${item.nodeName}: ${item.duration.toFixed(3)}ms`);
                });
            }
        } else  {
            if (typeof window !== 'undefined' && window._profileNodes) {
                // Collect per-node timing data
                if (!window._nodeTimings) window._nodeTimings = {};
                for (const entry of Object.values(NodeMan.list)) {
                    const node = entry.data;
                    if (node.isController && !node.allowUpdate) continue;
                    if (node.update !== undefined) {
                        const t0 = performance.now();
                        node.update(par.frame)
                        const dt = performance.now() - t0;
                        const id = node.id;
                        if (!window._nodeTimings[id]) window._nodeTimings[id] = {total: 0, count: 0, max: 0};
                        window._nodeTimings[id].total += dt;
                        window._nodeTimings[id].count++;
                        if (dt > window._nodeTimings[id].max) window._nodeTimings[id].max = dt;
                    }
                }
            } else {
                for (const entry of Object.values(NodeMan.list)) {
                    const node = entry.data;
                    if (node.isController && !node.allowUpdate) {
                        assert(node.update === CNode.prototype.update,
                            `Controller ${node.id} has overridden update() - move logic to apply()`);
                        continue;
                    }
                    if (node.update !== undefined) {
                        node.update(par.frame)
                    }
                }
            }

        }


        // Update GUI .listen() controllers after node updates so they display
        // freshly-computed values (avoids one-frame stale reads, e.g. FOV jump)
        Globals.menuBar.updateListeners();

        windowChanged();
        
        if (globalProfiler) globalProfiler.pop();

        if (Sit.jetStuff && Sit.showGlare) {
            if (glareSprite) {
                glareSprite.position.set(targetSphere.position.x, targetSphere.position.y, targetSphere.position.z)

                if (!glareSprite.visible)
                    targetSphere.layers.enable(LAYER.podsEye)
                else
                    targetSphere.layers.disable(LAYER.podsEye)
            }
        }

        lastNodeUpdateFrame = par.frame;
    } else if (Globals.justVideoAnalysis) {
        const frameSlider = NodeMan.get("FrameSlider", false);
        if (frameSlider && frameSlider.update) {
            frameSlider.update(par.frame);
        }
    }

    // render each viewport
    if (globalProfiler) globalProfiler.push('#2ca02c', 'Viewports');
    
    ViewMan.updateZOrder();
    ViewMan.computeEffectiveVisibility();
    ViewMan.updateDOMVisibility();
    
    // Check if any view is in XR mode - if so, skip normal rendering
    // The XR animation loop will handle rendering for the active view
    let xrActive = false;
    ViewMan.iterate((key, view) => {
        if (view.xrActive && view._effectivelyVisible) {
            xrActive = true;
        }
    });
    
    // Only render viewports if not in XR mode
    // When in XR mode, the XR animation loop handles rendering
    if (!xrActive) {
        ViewMan.iterate((key, view) => {
            // In video analysis mode, only render the video viewport
            if (Globals.justVideoAnalysis && key !== "video") {
                return;
            }

            if (view._effectivelyVisible) {
                if (globalProfiler) globalProfiler.push(getViewProfileColor(key), `${key}`);

                // we set from div, which can be moved or resized by the user, or by screen/window resizing
                view.setFromDiv(view.div)

                view.updateWH()
                // view needs to a 3D view, not just have a camea
                if (view.camera && ( view instanceof CNodeView3D ) ) {
                    view.camera.updateMatrix();
                    view.camera.updateMatrixWorld();

                    if (view.updateIsIR) view.updateIsIR();

                    if (typeof window !== 'undefined' && window._profileNodes) {
                        if (!window._preRenderTimings) window._preRenderTimings = {};
                        for (const node of NodeMan.getPreRenderNodes()) {
                            const t0 = performance.now();
                            node.preRender(view)
                            const dt = performance.now() - t0;
                            const id = node.id + ".preRender[" + key + "]";
                            if (!window._preRenderTimings[id]) window._preRenderTimings[id] = {total: 0, count: 0, max: 0};
                            window._preRenderTimings[id].total += dt;
                            window._preRenderTimings[id].count++;
                            if (dt > window._preRenderTimings[id].max) window._preRenderTimings[id].max = dt;
                        }
                    } else {
                        for (const node of NodeMan.getPreRenderNodes()) {
                            node.preRender(view)
                        }
                    }

                }
                updateLockTrack(view, par.frame)

                if (globalProfiler) globalProfiler.push('#9467bd', 'RenderCanvas');
                if (typeof window !== 'undefined' && window._profileNodes) {
                    if (!window._renderTimings) window._renderTimings = {};
                    const t0 = performance.now();
                    view.renderCanvas(par.frame)
                    const dt = performance.now() - t0;
                    const id = key + ".renderCanvas";
                    if (!window._renderTimings[id]) window._renderTimings[id] = {total: 0, count: 0, max: 0};
                    window._renderTimings[id].total += dt;
                    window._renderTimings[id].count++;
                    if (dt > window._renderTimings[id].max) window._renderTimings[id].max = dt;
                } else {
                    view.renderCanvas(par.frame)
                }
                if (globalProfiler) globalProfiler.pop();

                for (const node of NodeMan.getPostRenderNodes()) {
                    node.postRender(view)
                }
                
                if (globalProfiler) globalProfiler.pop();
            }
        })

        // Adjacency-based shared-edge seams: rebuild the draggable seam overlay from the views'
        // freshly-laid-out pixel rects. Cheap — skips entirely when no rect moved.
        LayoutMan.updateSeams();
    }
    
    if (globalProfiler) globalProfiler.pop();

    // Update GPU Memory Monitor display
    if (Globals.GPUMemoryMonitor && Globals.GPUMemoryMonitor.enabled) {
        Globals.GPUMemoryMonitor.updateGUI();
    }

    // Profile end of frame
    if (globalProfiler) globalProfiler.pop();
}
